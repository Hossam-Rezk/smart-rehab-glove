# ============================================================
#  PRJ-020 Smart Rehabilitation Glove  -  main.py  (USB version)
#  MicroPython program for the Raspberry Pi Pico 2 W.
#
#  What it does, over and over:
#    1. Reads the flex sensor (middle finger bend) and the touch
#       pad on the thumb.
#    2. Gives feedback with the buzzer and the RGB LED.
#    3. Sends the readings to the PC through the USB cable,
#       50 times a second, as one JSON line each.
#    4. Listens for commands from the website (calibrate, set the
#       target, beep, change the exercise mode).
#
#  Messages TO the PC (one JSON object per line):
#    {"type":"d","t":12345,"b":57,"r":31020,"k":0}   data
#        t = Pico time in ms, b = bend %, r = raw ADC, k = touch 0/1
#    {"type":"hello", ...}      device info (reply to HELLO)
#    {"type":"calib", "stage": "flat"|"bent"|"done"|"failed", ...}
#    {"type":"ack", "cmd": "..."}
#
#  Commands FROM the PC (one per line):
#    HELLO | CALIBRATE | TARGET <n> | RELEASE <n> | BEEP <n>
#    MODE IDLE | MODE FLEX | MODE THUMB | CUE
#
#  Because this file is named main.py, the Pico runs it every time
#  it gets power. Settings are in config.py.
# ============================================================

import sys
import time
import json
import select
from machine import Pin, ADC, PWM

import config

FIRMWARE_VERSION = "2.0-usb"
ADC_MAX = 65535
ADC_VOLTS = 3.3

OFF = (0, 0, 0)
RED = (255, 0, 0)
YELLOW = (255, 120, 0)
GREEN = (0, 255, 0)
BLUE = (0, 0, 255)
CYAN = (0, 200, 255)
PURPLE = (160, 0, 255)
WHITE = (255, 255, 255)


def send(obj):
    """Write one JSON line to the PC over USB."""
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write("\n")


# ------------------------------------------------------------
# Buzzer: plays beep patterns without stopping the program
# ------------------------------------------------------------
class Buzzer:
    def __init__(self, pin_number, active_low):
        self._on_level = 0 if active_low else 1
        self._pin = Pin(pin_number, Pin.OUT)
        self._steps = []
        self._step_ends_at = 0
        self.is_on = False
        self.off()

    def _write(self, on):
        self.is_on = on
        self._pin.value(self._on_level if on else 1 - self._on_level)

    def off(self):
        self._steps = []
        self._write(False)

    def beep(self, times=1, on_ms=80, gap_ms=80):
        if self._steps:
            return
        for _ in range(times):
            self._steps.append((True, on_ms))
            self._steps.append((False, gap_ms))
        self._start_next_step()

    def _start_next_step(self):
        on, duration = self._steps[0]
        self._write(on)
        self._step_ends_at = time.ticks_add(time.ticks_ms(), duration)

    def update(self):
        if not self._steps:
            return
        if time.ticks_diff(time.ticks_ms(), self._step_ends_at) >= 0:
            self._steps.pop(0)
            if self._steps:
                self._start_next_step()
            else:
                self._write(False)

    def beep_and_wait(self, times=1, on_ms=120, gap_ms=120):
        for _ in range(times):
            self._write(True)
            time.sleep_ms(on_ms)
            self._write(False)
            time.sleep_ms(gap_ms)


# ------------------------------------------------------------
# RGB LED
# ------------------------------------------------------------
class RgbLed:
    def __init__(self, red_pin, green_pin, blue_pin, common_anode, brightness, enabled):
        self._pwms = []
        for number in (red_pin, green_pin, blue_pin):
            pwm = PWM(Pin(number))
            pwm.freq(1000)
            self._pwms.append(pwm)
        self._common_anode = common_anode
        self._scale = max(0, min(100, brightness)) / 100
        self._enabled = enabled
        self._base = OFF
        self._flash_until = None
        self.colour = OFF
        self._apply(OFF)

    def _apply(self, colour):
        self.colour = colour
        for pwm, level in zip(self._pwms, colour):
            duty = int(level / 255 * self._scale * 65535) if self._enabled else 0
            if self._common_anode:
                duty = 65535 - duty
            pwm.duty_u16(duty)

    def show(self, colour):
        self._base = colour
        if self._flash_until is None and colour != self.colour:
            self._apply(colour)

    def flash(self, colour, duration_ms=120):
        self._flash_until = time.ticks_add(time.ticks_ms(), duration_ms)
        self._apply(colour)

    def update(self):
        if self._flash_until is not None:
            if time.ticks_diff(time.ticks_ms(), self._flash_until) >= 0:
                self._flash_until = None
                self._apply(self._base)


# ------------------------------------------------------------
# Flex sensor (voltage divider on an ADC pin)
# ------------------------------------------------------------
class FlexSensor:
    def __init__(self, adc_pin, raw_flat, raw_bent):
        self._adc = ADC(adc_pin)
        self.raw_flat = raw_flat
        self.raw_bent = raw_bent

    def read_raw(self, samples=16):
        total = 0
        for _ in range(samples):
            total += self._adc.read_u16()
        return total // samples

    def average_for(self, seconds):
        total = 0
        count = 0
        end = time.ticks_add(time.ticks_ms(), int(seconds * 1000))
        while time.ticks_diff(end, time.ticks_ms()) > 0:
            total += self.read_raw()
            count += 1
            time.sleep_ms(10)
        return total // max(count, 1)

    def to_percent(self, raw):
        span = self.raw_flat - self.raw_bent
        if span == 0:
            return 0
        percent = (self.raw_flat - raw) * 100 / span
        return max(0, min(100, int(percent + 0.5)))


def calibrate(flex, buzzer, rgb):
    """Learn the flat and fully-bent readings. Reports each stage to the PC."""
    seconds = config.CALIBRATION_SECONDS
    rgb.show(PURPLE)
    send({"type": "calib", "stage": "flat", "seconds": seconds})
    buzzer.beep_and_wait(1)
    time.sleep_ms(300)
    flat = flex.average_for(seconds)

    send({"type": "calib", "stage": "bent", "seconds": seconds, "flat": flat})
    buzzer.beep_and_wait(2)
    time.sleep_ms(300)
    bent = flex.average_for(seconds)

    if abs(flat - bent) < 1500:
        send({"type": "calib", "stage": "failed", "flat": flat, "bent": bent,
              "reason": "Flat and bent readings are almost the same. Check the flex sensor wiring."})
        for _ in range(3):
            rgb.show(RED)
            time.sleep_ms(200)
            rgb.show(OFF)
            time.sleep_ms(200)
        buzzer.beep_and_wait(1, on_ms=800)
        return False

    flex.raw_flat = flat
    flex.raw_bent = bent
    send({"type": "calib", "stage": "done", "flat": flat, "bent": bent})
    buzzer.beep_and_wait(3)
    return True


# ------------------------------------------------------------
# Reading commands from the PC without blocking
# ------------------------------------------------------------
class CommandReader:
    def __init__(self):
        self._poll = select.poll()
        self._poll.register(sys.stdin, select.POLLIN)
        self._buffer = ""

    def read_lines(self):
        lines = []
        while self._poll.poll(0):
            ch = sys.stdin.read(1)
            if not ch:
                break
            if ch in "\r\n":
                if self._buffer:
                    lines.append(self._buffer.strip())
                    self._buffer = ""
            elif len(self._buffer) < 64:
                self._buffer += ch
        return lines


# ------------------------------------------------------------
# Main program
# ------------------------------------------------------------
def main():
    led = Pin("LED", Pin.OUT)
    led.on()                                   # steady LED = program running
    buzzer = Buzzer(config.BUZZER_PIN, config.BUZZER_ACTIVE_LOW)
    rgb = RgbLed(config.RGB_RED_PIN, config.RGB_GREEN_PIN, config.RGB_BLUE_PIN,
                 config.RGB_COMMON_ANODE, config.RGB_BRIGHTNESS, config.RGB_ENABLED)
    flex = FlexSensor(config.FLEX_ADC_PIN, config.FLEX_RAW_FLAT, config.FLEX_RAW_BENT)
    touch_pin = Pin(config.TOUCH_PIN, Pin.IN, Pin.PULL_DOWN)
    reader = CommandReader()

    buzzer.beep_and_wait(1, on_ms=60)          # "I am alive" chirp

    calibrated = False
    target = config.BEND_TARGET_PERCENT
    release = config.BEND_RELEASE_PERCENT
    mode = "IDLE"
    armed = True
    previous_touch = 0
    next_send_at = time.ticks_ms()

    def hello():
        send({"type": "hello", "device_id": config.DEVICE_ID, "firmware": FIRMWARE_VERSION,
              "calibrated": calibrated, "target": target, "release": release, "mode": mode,
              "raw_flat": flex.raw_flat, "raw_bent": flex.raw_bent})

    hello()

    while True:
        now = time.ticks_ms()

        # ---- 1. commands from the website ------------------------
        for line in reader.read_lines():
            parts = line.split()
            cmd = parts[0].upper() if parts else ""
            arg = parts[1].upper() if len(parts) > 1 else ""
            try:
                if cmd == "HELLO":
                    hello()
                elif cmd == "CALIBRATE":
                    calibrated = calibrate(flex, buzzer, rgb) or calibrated
                    next_send_at = time.ticks_ms()
                elif cmd == "TARGET":
                    target = max(5, min(100, int(arg)))
                    send({"type": "ack", "cmd": "TARGET", "value": target})
                elif cmd == "RELEASE":
                    release = max(0, min(95, int(arg)))
                    send({"type": "ack", "cmd": "RELEASE", "value": release})
                elif cmd == "BEEP":
                    buzzer.beep(max(1, min(5, int(arg or "1"))))
                    send({"type": "ack", "cmd": "BEEP"})
                elif cmd == "MODE" and arg in ("IDLE", "FLEX", "THUMB"):
                    mode = arg
                    armed = True
                    send({"type": "ack", "cmd": "MODE", "value": mode})
                elif cmd == "CUE":                 # "touch now!" signal for the thumb test
                    buzzer.beep(1, on_ms=150, gap_ms=50)
                    rgb.flash(CYAN, 300)
                    send({"type": "ack", "cmd": "CUE"})
                else:
                    send({"type": "ack", "cmd": cmd, "error": "unknown command"})
            except ValueError:
                send({"type": "ack", "cmd": cmd, "error": "bad value"})

        # ---- 2. sensors -----------------------------------------
        raw = flex.read_raw()
        bend = flex.to_percent(raw)
        touch = touch_pin.value()

        # ---- 3. feedback ----------------------------------------
        if touch and not previous_touch:
            if config.BEEP_ON_TOUCH and mode != "FLEX":
                buzzer.beep(1, on_ms=60, gap_ms=40)
            if config.FLASH_ON_TOUCH:
                rgb.flash(WHITE)
        previous_touch = touch

        target_reached = bend >= target
        if mode == "FLEX":
            if target_reached and armed:
                armed = False
                if config.BEEP_ON_TARGET:
                    buzzer.beep(2, on_ms=90, gap_ms=70)
            elif bend <= release:
                armed = True
            if target_reached:
                rgb.show(GREEN)
            elif bend > release:
                rgb.show(YELLOW)
            else:
                rgb.show(RED)
        elif mode == "THUMB":
            rgb.show(GREEN if touch else BLUE)
        else:
            rgb.show(GREEN if target_reached else OFF)

        buzzer.update()
        rgb.update()

        # ---- 4. stream to the PC --------------------------------
        if time.ticks_diff(now, next_send_at) >= 0:
            next_send_at = time.ticks_add(next_send_at, config.STREAM_INTERVAL_MS)
            if time.ticks_diff(now, next_send_at) > 200:   # fell behind: resync
                next_send_at = time.ticks_add(now, config.STREAM_INTERVAL_MS)
            send({"type": "d", "t": now, "b": bend, "r": raw, "k": touch})

        time.sleep_ms(2)


try:
    main()
except KeyboardInterrupt:
    pass
finally:
    # Never leave the buzzer sounding or the LED lit when the program ends.
    Pin(config.BUZZER_PIN, Pin.OUT).value(1 if config.BUZZER_ACTIVE_LOW else 0)
    _led_off = 1 if config.RGB_COMMON_ANODE else 0
    for _pin in (config.RGB_RED_PIN, config.RGB_GREEN_PIN, config.RGB_BLUE_PIN):
        Pin(_pin, Pin.OUT).value(_led_off)

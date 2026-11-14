"""
Connection to the glove: the real Pico over USB serial, or a simulator.

Both classes have the same interface:
    connect(), close(), send(command_text), is_open, description
and call on_message(dict) for every JSON line the glove sends.
"""
import json
import math
import random
import threading
import time

import serial
from serial.tools import list_ports

PICO_USB_VENDOR_ID = 0x2E8A      # Raspberry Pi
SIMULATOR_PORT = "SIMULATOR"


def list_glove_ports():
    """All serial ports, the Pico ones first, plus the simulator."""
    ports = []
    for p in list_ports.comports():
        is_pico = p.vid == PICO_USB_VENDOR_ID
        ports.append({
            "port": p.device,
            "label": "{} - {}".format(p.device, "Raspberry Pi Pico" if is_pico else (p.description or "serial port")),
            "is_pico": is_pico,
        })
    ports.sort(key=lambda p: not p["is_pico"])
    ports.append({"port": SIMULATOR_PORT, "label": "Simulator (no glove needed)", "is_pico": False})
    return ports


def find_pico_port():
    for p in list_ports.comports():
        if p.vid == PICO_USB_VENDOR_ID:
            return p.device
    return None


class SerialGlove:
    def __init__(self, port, on_message):
        self.port = port
        self.on_message = on_message
        self._serial = None
        self._thread = None
        self._stop = threading.Event()
        self.description = "Pico on " + port

    @property
    def is_open(self):
        return self._serial is not None and self._serial.is_open and not self._stop.is_set()

    def connect(self):
        try:
            self._serial = serial.Serial(self.port, 115200, timeout=0.2)
        except serial.SerialException as error:
            text = str(error)
            if "PermissionError" in text or "Access is denied" in text:
                raise ConnectionError(
                    "{} is busy. Close Thonny or any other program using the Pico, then try again.".format(self.port))
            raise ConnectionError("Could not open {}: {}".format(self.port, text))
        self._serial.dtr = True          # tells MicroPython a terminal is listening
        self._stop.clear()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()
        time.sleep(0.1)
        self.send("HELLO")

    def _read_loop(self):
        buffer = b""
        while not self._stop.is_set():
            try:
                chunk = self._serial.read(512)
            except (serial.SerialException, OSError):
                self._stop.set()
                self.on_message({"type": "disconnected", "reason": "The USB cable was unplugged or the Pico reset."})
                return
            if not chunk:
                continue
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.strip()
                if not line.startswith(b"{"):
                    continue             # ignore REPL text such as "MicroPython v1.24"
                try:
                    self.on_message(json.loads(line))
                except ValueError:
                    pass

    def send(self, command):
        if self.is_open:
            try:
                self._serial.write((command.strip() + "\n").encode())
            except (serial.SerialException, OSError):
                pass

    def close(self):
        self._stop.set()
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:
                pass
        self._serial = None


class SimulatedGlove:
    """A pretend glove for trying the website without hardware."""

    def __init__(self, on_message):
        self.on_message = on_message
        self._stop = threading.Event()
        self._thread = None
        self._commands = []
        self._lock = threading.Lock()
        self.description = "Simulator"
        self.target = 60
        self.mode = "IDLE"
        self.calibrated = False

    @property
    def is_open(self):
        return self._thread is not None and not self._stop.is_set()

    def connect(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self.send("HELLO")

    def send(self, command):
        with self._lock:
            self._commands.append(command.strip())

    def close(self):
        self._stop.set()

    def _hello(self):
        self.on_message({"type": "hello", "device_id": "SIMULATED-GLOVE", "firmware": "simulator",
                         "calibrated": self.calibrated, "target": self.target, "release": 30,
                         "mode": self.mode, "raw_flat": 42000, "raw_bent": 22000})

    def _run(self):
        start = time.monotonic()
        rep_start = start + 1.0
        rep = self._new_rep()
        touch_until = 0.0
        touch_at = None
        next_tick = start
        while not self._stop.is_set():
            now = time.monotonic()
            with self._lock:
                commands, self._commands = self._commands, []
            for command in commands:
                parts = command.split()
                cmd = parts[0].upper() if parts else ""
                if cmd == "HELLO":
                    self._hello()
                elif cmd == "CALIBRATE":
                    self.on_message({"type": "calib", "stage": "flat", "seconds": 3})
                    time.sleep(3)
                    self.on_message({"type": "calib", "stage": "bent", "seconds": 3, "flat": 42000})
                    time.sleep(3)
                    self.calibrated = True
                    self.on_message({"type": "calib", "stage": "done", "flat": 42010, "bent": 21980})
                    now = time.monotonic()
                    next_tick = now
                elif cmd == "TARGET" and len(parts) > 1:
                    self.target = int(parts[1])
                    self.on_message({"type": "ack", "cmd": "TARGET", "value": self.target})
                elif cmd == "MODE" and len(parts) > 1:
                    self.mode = parts[1].upper()
                    self.on_message({"type": "ack", "cmd": "MODE", "value": self.mode})
                elif cmd == "CUE":
                    # a simulated patient reacts after 0.3 - 0.9 s (sometimes misses)
                    if random.random() < 0.9:
                        touch_at = now + random.uniform(0.3, 0.9)
                    self.on_message({"type": "ack", "cmd": "CUE"})
                else:
                    self.on_message({"type": "ack", "cmd": cmd})

            if touch_at is not None and now >= touch_at:
                touch_until = now + random.uniform(0.4, 1.5)
                touch_at = None

            # bend: repeated bend-and-release movements while in FLEX mode
            bend = 2.0
            if self.mode == "FLEX":
                t = now - rep_start
                total = rep["rise"] + rep["hold"] + rep["fall"]
                if t > total + rep["rest"]:
                    rep_start = now
                    rep = self._new_rep()
                    t = 0.0
                if 0 <= t <= total:
                    if t < rep["rise"]:
                        u = t / rep["rise"]
                        level = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5
                    elif t < rep["rise"] + rep["hold"]:
                        level = 1.0
                    else:
                        u = (t - rep["rise"] - rep["hold"]) / rep["fall"]
                        level = 1 - (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5)
                    bend += (rep["peak"] - 2) * level
                    if rep["shaky"]:
                        bend += 6 * math.sin(2 * math.pi * 7 * t) * level
            bend += random.gauss(0, 0.7)
            bend = int(max(0, min(100, round(bend))))
            touch = 1 if now < touch_until else 0
            raw = int(42000 - bend * 200)
            self.on_message({"type": "d", "t": int((now - start) * 1000), "b": bend, "r": raw, "k": touch})

            next_tick += 0.02
            delay = next_tick - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                next_tick = time.monotonic()

    def _new_rep(self):
        kind = random.choices(["good", "partial", "fast", "shaky"], weights=[5, 2, 1, 1])[0]
        rep = {"peak": random.uniform(72, 98), "rise": random.uniform(0.7, 1.4),
               "hold": random.uniform(0.5, 1.5), "fall": random.uniform(0.7, 1.4),
               "rest": random.uniform(1.0, 2.0), "shaky": False}
        if kind == "partial":
            rep["peak"] = random.uniform(30, 50)
        elif kind == "fast":
            rep.update(rise=0.2, hold=0.1, fall=0.2)
        elif kind == "shaky":
            rep["shaky"] = True
        return rep

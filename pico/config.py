# ============================================================
#  PRJ-020 Smart Rehabilitation Glove  -  config.py
#  Settings for the Raspberry Pi Pico 2 W (USB version).
#
#  You normally do not need to change anything here.
#  The glove talks to the PC through the USB cable, so there
#  is no Wi-Fi setup. Run setup_pico.bat to copy this file
#  and main.py to the Pico.
# ============================================================

DEVICE_ID = "PRJ-020-GLOVE-01"     # name shown on the website

# ------------------------------------------------------------
# Pins  (match the Hardware Wiring Guide)
# ------------------------------------------------------------
FLEX_ADC_PIN = 26                  # flex sensor on the MIDDLE finger: GP26 / ADC0
TOUCH_PIN = 16                     # touch pad on the THUMB (TTP223 OUT): GP16
BUZZER_PIN = 15                    # GP15

# False = buzzer sounds when the pin is HIGH (bare 2-leg buzzer).
# True  = buzzer sounds when the pin is LOW  (many 3-pin buzzer boards).
BUZZER_ACTIVE_LOW = False

RGB_RED_PIN = 13                   # GP13
RGB_GREEN_PIN = 12                 # GP12
RGB_BLUE_PIN = 11                  # GP11
RGB_COMMON_ANODE = False           # True if the long LED leg goes to 3.3 V
RGB_ENABLED = True
RGB_BRIGHTNESS = 50                # 0-100

# ------------------------------------------------------------
# Flex sensor
# ------------------------------------------------------------
FLEX_RESISTOR_OHMS = 47000         # fixed resistor in the voltage divider
CALIBRATION_SECONDS = 3            # how long each pose is held

# Used until the first calibration from the website.
FLEX_RAW_FLAT = 42000              # finger straight
FLEX_RAW_BENT = 22000              # finger fully bent

# ------------------------------------------------------------
# Exercise feedback (the website can change the target)
# ------------------------------------------------------------
BEND_TARGET_PERCENT = 60           # double beep when reached
BEND_RELEASE_PERCENT = 30          # must drop below this to re-arm
BEEP_ON_TOUCH = True
BEEP_ON_TARGET = True
FLASH_ON_TOUCH = True

# ------------------------------------------------------------
# Timing
# ------------------------------------------------------------
STREAM_INTERVAL_MS = 20            # 50 readings per second to the PC

# PRJ-020 Smart Rehabilitation Glove

A glove and a local website that help patients practise two hand movements
after an accident or injury:

1. **Finger Bend.** A flex sensor on the middle finger measures how far the
   finger bends. An AI model checks every repetition.
2. **Thumb Touch.** A touch pad on the thumb measures how fast and how
   reliably the patient can touch the thumb to a fingertip.

Everything runs on your PC. The glove (Raspberry Pi Pico 2 W) connects with a
USB cable. Patients, sessions and tutorials are saved in Supabase.

> This tool supports rehabilitation exercises. It does not replace advice from
> a doctor or physiotherapist. Stop if you feel pain.

---

## Quick start (Windows)

You need **Python 3.11+** ([python.org](https://www.python.org/downloads/), tick
*"Add python.exe to PATH"* when installing) and an internet connection (for the
database).

1. **Set up the Pico (once).** Plug the glove in by USB, close Thonny, and
   double-click **`setup_pico.bat`**. It installs everything and copies the
   glove program to the Pico. You will hear one beep when it's done.
2. **Start the website.** Double-click **`start.bat`**. The website opens at
   <http://localhost:8000>. Keep the black window open.
3. **Connect.** Press **Connect glove** at the top of the website.
4. Choose a patient at the top (or press **+ New**), then follow the steps:
   **1 Calibrate → 2 Finger Bend → 3 Thumb Touch → Summary**. Each step has
   a *How to do it* section with the matching tutorials. The **History** tab
   shows progress charts and past sessions.

No glove at hand? Choose **"Simulator (no glove needed)"** in the port list
next to *Connect glove* to try the whole website.

If the Pico has no MicroPython yet: hold **BOOTSEL**, plug in the USB cable,
release the button, and copy the Pico 2 W `.uf2` file from
<https://micropython.org/download/RPI_PICO2_W/> onto the `RP2350` drive. Then
run `setup_pico.bat`.

---

## Hardware

| Part | Pico pin |
|---|---|
| Flex sensor (middle finger) + 47 kΩ divider | GP26 / ADC0 |
| Touch pad on the thumb (TTP223, one pad) OUT | GP16 |
| Buzzer | GP15 |
| RGB LED (R, G, B through 220 Ω) | GP13, GP12, GP11 |

The original wiring guide is in [`docs/`](docs/). Pins can be changed in
[`pico/config.py`](pico/config.py). Run `setup_pico.bat` again after changing it.

Glove feedback:
- **Finger Bend:** LED red, then yellow, then green as the bend passes the
  target, and a double beep at the target.
- **Thumb Touch:** LED blue while waiting. Beep and cyan flash = "touch now!".
  A white flash means a touch was detected.

---

## How it works

```
Pico 2 W ──USB serial (JSON, 50 Hz)──► backend/server.py (FastAPI)
  flex + touch                           │  • AI repetition analysis
  buzzer + LED  ◄── commands ────────────│  • thumb reaction test
                                         ▼ WebSocket
                                 website (web/, http://localhost:8000)
                                         │
                                 Supabase: patients, sessions, tutorials
```

| Folder | What it contains |
|---|---|
| `pico/` | MicroPython code for the glove (`main.py`, `config.py`) |
| `backend/` | Local server: USB link and simulator (`glove.py`), AI (`ai.py`, `rep_features.py`), API (`server.py`) |
| `web/` | The website (plain HTML, CSS and JS, light theme) |
| `model/` | Trained AI model weights (`rep_quality_model.joblib`) and its report |
| `training/` | The script that trained the model |
| `supabase/` | Database schema and access details |

### The AI model

For every finger-bend repetition the server measures 13 movement features:
peak bend, range, duration, hold time, speeds, number of speed bursts, tremor
size, 4–12 Hz tremor energy and jerk. A **gradient-boosting classifier**
(scikit-learn `HistGradientBoostingClassifier`) then labels the repetition:

| Label | Shown to the patient |
|---|---|
| `good` | "Great repetition!" |
| `partial` | "Try to bend a little further." |
| `too_fast` | "Slow down - bend and release gently." |
| `shaky` | "A bit shaky - move more smoothly." |

The website also adjusts the target bend from session to session:
- If at least 80% of the last session's reps were good, the target goes up 5%.
- If fewer than 40% were good, it goes down 5%.

**Training data:** [Processed DataGlove Hand Movement Data](https://www.kaggle.com/datasets/krishnagarigipati/final-datasets)
(Kaggle, MIT license). The file `dynamic_data.csv` was used: 1.05 M rows from
25 people, 100 Hz, 5 flex sensors. It contains real finger movement but no
rehabilitation labels, so each training repetition combines:
- a bend-and-release movement, and
- the real movement texture (natural irregularity and sensor noise) of a
  person in the dataset.

The four classes come from how the repetition is built: bend depth, speed,
and added tremor. The model was tested on 5 people it never saw during
training: **99.5% accuracy** (see [`model/training_report.txt`](model/training_report.txt)).
Those test repetitions were built the same way as the training ones, so
expect lower accuracy on a real glove. The model weights are final and are
used as they are.

Training ran locally. The dataset is **not** in this repository and was
**not** uploaded anywhere. To retrain:

```
python training/train_model.py path\to\dynamic_data.csv
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "COMx is busy" | Close Thonny (or any other program using the Pico) and press Connect again. |
| "No Pico found" | Check the USB cable (it must be a data cable), then run `setup_pico.bat`. |
| "The glove did not answer" | Run `setup_pico.bat`, then unplug and replug the USB cable. |
| Calibration failed | Check the flex sensor wiring (GP26, 47 kΩ resistor). |
| Buzzer sounds all the time | Set `BUZZER_ACTIVE_LOW = True` in `pico/config.py`, then run `setup_pico.bat`. |
| Tutorials / patients don't load | The PC needs internet for the Supabase database. |

Database details: [`supabase/DATABASE_ACCESS.md`](supabase/DATABASE_ACCESS.md).

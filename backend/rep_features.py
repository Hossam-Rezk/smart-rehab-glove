"""
Features of one finger-bend repetition.

Shared by the training script (training/train_model.py) and the live
backend (backend/ai.py), so the model always sees features computed
exactly the same way.

Input: the bend signal of one repetition, in percent (0 = flat,
100 = fully bent), sampled at FS Hz.
"""
import numpy as np

FS = 50  # samples per second (the Pico streams at 50 Hz)

FEATURE_NAMES = [
    "peak",            # highest bend reached (%)
    "rom",             # range of motion: peak - lowest (%)
    "duration",        # length of the repetition (s)
    "rel_time_to_peak",  # when the peak happens, 0..1 of the duration
    "hold_time",       # time spent at >= 90 % of the peak (s)
    "max_up_speed",    # fastest bending speed (%/s)
    "max_down_speed",  # fastest straightening speed (%/s)
    "mean_abs_speed",  # average speed (%/s)
    "n_speed_peaks",   # number of separate speed bursts (1-2 = smooth)
    "dir_changes_ps",  # direction changes per second (high = shaky)
    "tremor_rms",      # size of the fast wobble on top of the movement (%)
    "tremor_band",     # share of signal energy in the 4-12 Hz tremor band
    "log_jerk",        # log dimensionless jerk (higher = less smooth)
]

QUALITY_LABELS = ["good", "partial", "too_fast", "shaky"]

QUALITY_TEXT = {
    "good": "Great repetition!",
    "partial": "Try to bend a little further.",
    "too_fast": "Slow down - bend and release gently.",
    "shaky": "A bit shaky - move more smoothly.",
}


def _moving_average(x, n):
    if n <= 1 or len(x) < n:
        return x.copy()
    kernel = np.ones(n) / n
    padded = np.pad(x, (n // 2, n - 1 - n // 2), mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def compute_features(bend, fs=FS):
    """Return the feature vector (list of floats) for one repetition."""
    x = np.asarray(bend, dtype=float)
    if len(x) < 5:
        x = np.pad(x, (0, 5 - len(x)), mode="edge")
    n = len(x)
    duration = n / fs

    peak = float(x.max())
    rom = float(peak - x.min())
    rel_tp = float(np.argmax(x) / max(n - 1, 1))
    hold = float(np.sum(x >= 0.9 * peak) / fs) if peak > 0 else 0.0

    slow = _moving_average(x, 9)            # the intended movement (~0.18 s)
    v = np.gradient(slow) * fs               # speed in %/s
    max_up = float(max(v.max(), 0.0))
    max_down = float(max(-v.min(), 0.0))
    mean_abs = float(np.mean(np.abs(v)))

    # separate bursts of speed: local maxima of |v| above 20 % of the max
    av = np.abs(v)
    thr = 0.2 * av.max() if av.max() > 0 else 1.0
    inner = av[1:-1]
    speed_peaks = int(np.sum((inner > av[:-2]) & (inner >= av[2:]) & (inner > thr)))

    raw_v = np.diff(x)
    signs = np.sign(raw_v[np.abs(raw_v) > 0.5])
    dir_changes = float(np.sum(signs[1:] != signs[:-1]) / duration) if len(signs) > 1 else 0.0

    residual = x - slow
    tremor_rms = float(np.std(residual))
    spectrum = np.abs(np.fft.rfft(x - x.mean())) ** 2
    freqs = np.fft.rfftfreq(n, d=1.0 / fs)
    total = spectrum[freqs > 0.2].sum()
    band = spectrum[(freqs >= 4) & (freqs <= 12)].sum()
    tremor_band = float(band / total) if total > 0 else 0.0

    jerk = np.gradient(np.gradient(v)) * fs * fs
    amp = max(rom, 1.0)
    ldj = np.sum(jerk ** 2) / fs * duration ** 5 / (amp ** 2)
    log_jerk = float(np.log(max(ldj, 1e-9)))

    return [peak, rom, duration, rel_tp, hold, max_up, max_down, mean_abs,
            float(speed_peaks), dir_changes, tremor_rms, tremor_band, log_jerk]


def smoothness_score(features):
    """A simple 0..1 score shown to the patient (1 = very smooth)."""
    # Based on the wobble size and the jerk. Normal sensor noise (about 1 %)
    # is not counted as shakiness.
    f = dict(zip(FEATURE_NAMES, features))
    score = 1.0
    score -= min(max(f["tremor_rms"] - 1.0, 0.0) / 4.0, 0.7)
    score -= min(max(f["log_jerk"] - 17.0, 0.0) / 6.0, 0.3)
    return float(max(0.0, min(1.0, score)))

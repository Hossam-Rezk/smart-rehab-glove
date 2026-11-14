"""
Live AI analysis of the flex exercise.

RepDetector cuts the live bend stream into repetitions (bend, then
straighten again). Each finished repetition is turned into features
(rep_features.py) and labelled by the trained model:
    good / partial / too_fast / shaky
"""
import json
import os

import joblib
import numpy as np

from rep_features import (FS, QUALITY_TEXT, compute_features, smoothness_score)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT, "model", "rep_quality_model.joblib")
INFO_PATH = os.path.join(ROOT, "model", "model_info.json")


class RepQualityModel:
    def __init__(self):
        self.model = joblib.load(MODEL_PATH)
        with open(INFO_PATH) as fh:
            self.info = json.load(fh)

    def analyse(self, bend_values, target):
        features = compute_features(bend_values, FS)
        probabilities = self.model.predict_proba([features])[0]
        classes = list(self.model.classes_)
        best = int(np.argmax(probabilities))
        quality = classes[best]
        confidence = float(probabilities[best])
        peak = int(round(features[0]))

        # The model knows "partial" as a bend below ~60 %. The patient's own
        # target can be different, so a smooth rep that misses the target
        # is also reported as partial.
        if quality == "good" and peak < target - 5:
            quality = "partial"
        return {
            "quality": quality,
            "confidence": round(confidence, 3),
            "message": QUALITY_TEXT[quality],
            "peak_percent": peak,
            "reached_target": peak >= target,
            "duration_ms": int(features[2] * 1000),
            "time_to_peak_ms": int(features[3] * features[2] * 1000),
            "hold_ms": int(features[4] * 1000),
            "smoothness": round(smoothness_score(features), 3),
            "tremor": round(features[10], 3),
        }


class RepDetector:
    """Finds repetitions in the live stream (samples arrive at ~50 Hz)."""

    START_PERCENT = 12        # a rep starts when the bend rises above this
    MIN_PEAK = 18             # ignore tiny twitches
    END_HOLD_S = 0.2          # must stay below START for this long to end
    MAX_REP_S = 12            # give up on very long holds
    PRE_ROLL = 10             # samples kept from before the start

    def __init__(self):
        self.reset()

    def reset(self):
        self._history = []
        self._rep = None       # list of (t_ms, bend) while a rep is in progress
        self._below_since = None

    def add(self, t_ms, bend):
        """Feed one sample. Returns the rep samples (bend list) when one finishes."""
        if self._rep is None:
            self._history.append((t_ms, bend))
            self._history = self._history[-self.PRE_ROLL:]
            if bend > self.START_PERCENT:
                self._rep = list(self._history)
                self._below_since = None
            return None

        self._rep.append((t_ms, bend))
        if bend <= self.START_PERCENT:
            if self._below_since is None:
                self._below_since = t_ms
            finished = (t_ms - self._below_since) >= self.END_HOLD_S * 1000
        else:
            self._below_since = None
            finished = False
        too_long = (t_ms - self._rep[0][0]) > self.MAX_REP_S * 1000

        if not (finished or too_long):
            return None
        samples = self._rep
        self._rep = None
        self._history = []
        bends = [b for _, b in samples]
        if max(bends) < self.MIN_PEAK:
            return None
        return self._resample(samples)

    @staticmethod
    def _resample(samples):
        """Put the samples on an exact 50 Hz grid (the Pico timing can jitter)."""
        t = np.array([s[0] for s in samples], dtype=float)
        b = np.array([s[1] for s in samples], dtype=float)
        if t[-1] <= t[0]:
            return b
        grid = np.arange(t[0], t[-1] + 1, 1000.0 / FS)
        return np.interp(grid, t, b)

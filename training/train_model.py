"""
Train the repetition-quality model (runs locally, once).

Dataset: "Processed DataGlove Hand Movement Data" (Kaggle, MIT license)
https://www.kaggle.com/datasets/krishnagarigipati/final-datasets
File used: dynamic_data.csv (1.05 M rows, 25 people, 100 Hz, 5 flex sensors)

The dataset has real finger-flex movement from 25 people but no
rehabilitation labels. So each training repetition is built from:
  * a smooth bend-and-release movement (rise, hold, release), and
  * the REAL movement texture of a person in the dataset (their natural
    small irregularities and sensor noise, taken from the flex channels).
The four classes come from how the repetition is made:
  good      - full bend (70-100 %), normal speed
  partial   - bend only reaches 20-58 %
  too_fast  - the whole bend and release takes well under a second
  shaky     - extra 4-11 Hz tremor and amplified irregular movement
Train/test are split by PERSON: the test people are never seen in training.

Usage (from the project folder):
    python training/train_model.py path/to/dynamic_data.csv
The model is written to model/rep_quality_model.joblib.
"""
import json
import os
import sys
import time

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import classification_report, confusion_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))
from rep_features import FEATURE_NAMES, FS, QUALITY_LABELS, compute_features  # noqa: E402

RNG = np.random.default_rng(42)
FLEX_COLUMNS = ["flex_1", "flex_2", "flex_3", "flex_4", "flex_5"]
SAMPLES_PER_CLASS_PER_PERSON = 400
TEST_PEOPLE = 5


# ------------------------------------------------------------------
# 1. Real movement texture from the dataset
# ------------------------------------------------------------------
def load_textures(csv_path):
    """Return {person: [texture arrays at 50 Hz, in units of 'fraction of range']}."""
    df = pd.read_csv(csv_path, usecols=["timestamp", "subject", "label"] + FLEX_COLUMNS)
    gap = df.timestamp.diff().abs() > 0.5
    rec = ((df.label != df.label.shift()) | (df.subject != df.subject.shift()) | gap).cumsum()
    df["rec"] = rec

    textures = {}
    for person, pdf in df.groupby("subject"):
        items = []
        for col in FLEX_COLUMNS:
            lo, hi = np.percentile(pdf[col], [1, 99])
            span = max(hi - lo, 1.0)
            for _, r in pdf.groupby("rec"):
                s = (r[col].to_numpy(dtype=float) - lo) / span
                s = s[: len(s) // 2 * 2].reshape(-1, 2).mean(axis=1)  # 100 Hz -> 50 Hz
                if len(s) < 20:
                    continue
                k = np.ones(7) / 7
                slow = np.convolve(np.pad(s, 3, mode="edge"), k, mode="valid")
                items.append((s - slow, slow - slow.mean()))
        textures[str(person)] = items
    return textures


def texture_of_length(items, n, rng):
    """Join random real recordings of one person until n samples long."""
    fast, slow = [], []
    total = 0
    while total < n:
        f, s = items[rng.integers(len(items))]
        fast.append(f)
        slow.append(s)
        total += len(f)
    return np.concatenate(fast)[:n], np.concatenate(slow)[:n]


# ------------------------------------------------------------------
# 2. Building one repetition
# ------------------------------------------------------------------
def min_jerk(n):
    t = np.linspace(0, 1, max(n, 2))
    return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5


def make_rep(label, items, rng):
    if label == "good":
        peak = rng.uniform(70, 100)
        rise, hold, fall = rng.uniform(0.5, 1.8), rng.uniform(0.3, 2.5), rng.uniform(0.5, 1.8)
    elif label == "partial":
        peak = rng.uniform(20, 58)
        rise, hold, fall = rng.uniform(0.5, 1.8), rng.uniform(0.3, 2.5), rng.uniform(0.5, 1.8)
    elif label == "too_fast":
        peak = rng.uniform(45, 100)
        rise, hold, fall = rng.uniform(0.12, 0.35), rng.uniform(0.0, 0.3), rng.uniform(0.12, 0.35)
    else:  # shaky
        peak = rng.uniform(35, 100)
        rise, hold, fall = rng.uniform(0.5, 1.8), rng.uniform(0.3, 2.5), rng.uniform(0.5, 1.8)

    base = rng.uniform(0, 12)
    pre, post = int(rng.uniform(0.1, 0.4) * FS), int(rng.uniform(0.1, 0.4) * FS)
    nr, nh, nf = int(rise * FS), int(hold * FS), int(fall * FS)
    env = np.concatenate([
        np.zeros(pre),
        min_jerk(nr),
        np.ones(nh),
        1 - min_jerk(nf),
        np.zeros(post),
    ])
    n = len(env)
    fast, slow = texture_of_length(items, n, rng)
    amp = peak - base

    # Real human texture: small irregular drift + fast detail, in % units.
    x = base + amp * env * (1 + 0.12 * slow) + amp * 0.25 * fast
    if label == "shaky":
        t = np.arange(n) / FS
        freq = rng.uniform(4, 11)
        tremor_amp = rng.uniform(3, 10)
        modulation = 0.6 + 0.4 * np.sin(2 * np.pi * rng.uniform(0.2, 0.8) * t)
        x += tremor_amp * modulation * np.sin(2 * np.pi * freq * t + rng.uniform(0, 6.28))
        x += amp * rng.uniform(0.5, 1.2) * fast
    x += rng.normal(0, 0.7, n)                 # sensor noise
    return np.clip(np.round(x), 0, 100)        # the Pico sends whole percents, 0-100


# ------------------------------------------------------------------
# 3. Train and evaluate
# ------------------------------------------------------------------
def build_dataset(textures, people, rng):
    X, y, groups = [], [], []
    for person in people:
        items = textures[person]
        for label in QUALITY_LABELS:
            for _ in range(SAMPLES_PER_CLASS_PER_PERSON):
                X.append(compute_features(make_rep(label, items, rng)))
                y.append(label)
                groups.append(person)
    return np.array(X), np.array(y), np.array(groups)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    started = time.time()
    print("Loading", sys.argv[1])
    textures = load_textures(sys.argv[1])
    people = sorted(textures)
    print("People:", len(people), " movement recordings:",
          sum(len(v) for v in textures.values()))

    order = RNG.permutation(people)
    test_people = sorted(order[:TEST_PEOPLE].tolist())
    train_people = sorted(order[TEST_PEOPLE:].tolist())

    print("Building repetitions...")
    X_train, y_train, _ = build_dataset(textures, train_people, RNG)
    X_test, y_test, _ = build_dataset(textures, test_people, RNG)
    print("Train reps:", len(y_train), " Test reps:", len(y_test))

    model = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08,
                                           max_leaf_nodes=31, random_state=0)
    model.fit(X_train, y_train)

    pred = model.predict(X_test)
    accuracy = float((pred == y_test).mean())
    report = classification_report(y_test, pred, labels=QUALITY_LABELS, digits=3)
    matrix = confusion_matrix(y_test, pred, labels=QUALITY_LABELS)
    print("\nTest accuracy on unseen people: {:.1%}\n".format(accuracy))
    print(report)
    print("Confusion matrix (rows = true, cols = predicted):", QUALITY_LABELS)
    print(matrix)

    # Final model: train on everyone.
    X_all = np.vstack([X_train, X_test])
    y_all = np.concatenate([y_train, y_test])
    model.fit(X_all, y_all)

    out_dir = os.path.join(ROOT, "model")
    os.makedirs(out_dir, exist_ok=True)
    joblib.dump(model, os.path.join(out_dir, "rep_quality_model.joblib"))
    info = {
        "model": "HistGradientBoostingClassifier",
        "sklearn_version": sklearn.__version__,
        "dataset": "krishnagarigipati/final-datasets (dynamic_data.csv), MIT license",
        "features": FEATURE_NAMES,
        "labels": QUALITY_LABELS,
        "sample_rate_hz": FS,
        "people_total": len(people),
        "test_people": test_people,
        "train_reps": int(len(y_train)),
        "test_reps": int(len(y_test)),
        "test_accuracy_unseen_people": round(accuracy, 4),
        "confusion_matrix": matrix.tolist(),
        "trained_at": time.strftime("%Y-%m-%d %H:%M"),
    }
    with open(os.path.join(out_dir, "model_info.json"), "w") as fh:
        json.dump(info, fh, indent=2)
    with open(os.path.join(out_dir, "training_report.txt"), "w") as fh:
        fh.write("Test accuracy on unseen people: {:.1%}\n\n".format(accuracy))
        fh.write(report)
        fh.write("\nConfusion matrix (rows = true, cols = predicted): {}\n{}\n".format(
            QUALITY_LABELS, matrix))
    print("\nSaved model to", out_dir, " ({:.0f} s)".format(time.time() - started))


if __name__ == "__main__":
    main()

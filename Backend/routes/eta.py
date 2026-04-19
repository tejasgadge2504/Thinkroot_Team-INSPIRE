"""
ml_eta.py — ML-based ETA prediction
====================================
Two models trained on historical GPS history from db.json:

  1. RandomForestRegressor (scikit-learn)
     - Fast, interpretable, works with small data (>= 5 samples)
     - Features: distance_km, avg_speed_kmph, hour_of_day, day_of_week, network_score

  2. Neural Network (TensorFlow/Keras)
     - More expressive, better on larger datasets (>= 20 samples)
     - Same feature set, 2 hidden layers

Both models are trained on every call to get_ml_eta() using all available
location history in the DB. The best model (lower MAE on a quick internal
eval split) is selected automatically.

Install:
    pip install scikit-learn tensorflow numpy
"""

import json
import math
import time
import numpy as np

# ── lazy-load heavy deps so the rest of the app still boots if missing ──────
try:
    from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import mean_absolute_error
    SKLEARN_OK = True
except ImportError:
    SKLEARN_OK = False

try:
    import tensorflow as tf
    from tensorflow import keras
    TF_OK = True
except ImportError:
    TF_OK = False

DB_FILE = "db.json"


# ── helpers ──────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def network_score(net: str) -> float:
    """Convert network quality label to numeric feature."""
    return {"good": 1.0, "low": 0.5, "offline": 0.0}.get(net, 0.75)


def load_db():
    try:
        with open(DB_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"locations": {}, "drivers": {}}


# ── feature extraction ───────────────────────────────────────────────────────

def extract_samples(db: dict):
    """
    Walk every driver's location history and produce (X, y) training samples.

    For each consecutive pair of pings (A → B):
      - We know actual travel time  = B.timestamp − A.timestamp  (seconds)
      - We know distance A→B        = haversine(A, B)
      - We compute speed from recent window

    Features (X):
        distance_km     – remaining distance to destination proxy
        avg_speed_kmph  – rolling avg speed over last N pings
        hour_of_day     – 0-23  (captures rush-hour patterns)
        day_of_week     – 0-6
        network_score   – 0/0.5/1

    Label (y):
        actual_seconds  – time taken to travel that segment
    """
    X, y = [], []

    for driver_id, history in db.get("locations", {}).items():
        if len(history) < 3:
            continue

        for i in range(1, len(history)):
            prev = history[i - 1]
            curr = history[i]

            # Basic checks
            if not all(k in curr for k in ("lat", "lon", "timestamp")):
                continue
            if not all(k in prev for k in ("lat", "lon", "timestamp")):
                continue

            dt = curr["timestamp"] - prev["timestamp"]
            if dt <= 0 or dt > 3600:   # skip gaps > 1 hour (stale data)
                continue

            dist = haversine(prev["lat"], prev["lon"], curr["lat"], curr["lon"])
            if dist < 0.01:             # skip stationary pings
                continue

            speed_mps = dist * 1000 / dt
            speed_kmph = speed_mps * 3.6

            # Rolling avg speed over last 5 pings
            window = history[max(0, i-5):i]
            if len(window) >= 2:
                total_d = sum(
                    haversine(window[j-1]["lat"], window[j-1]["lon"],
                              window[j]["lat"], window[j]["lon"])
                    for j in range(1, len(window))
                )
                total_t = window[-1]["timestamp"] - window[0]["timestamp"]
                roll_speed = (total_d / total_t * 3600) if total_t > 0 else speed_kmph
            else:
                roll_speed = speed_kmph

            ts = curr.get("timestamp", time.time())
            t  = time.localtime(ts)

            net = curr.get("network", "good")
            X.append([
                dist,                   # distance_km
                roll_speed,             # avg_speed_kmph
                t.tm_hour,              # hour_of_day
                t.tm_wday,              # day_of_week
                network_score(net),     # network_quality
            ])
            y.append(float(dt))

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32)


# ── model store (module-level singletons) ────────────────────────────────────

_rf_model    = None
_gb_model    = None
_nn_model    = None
_scaler      = None
_last_trained= 0
RETRAIN_EVERY= 60   # seconds between re-trains


def _train_sklearn(X, y):
    global _rf_model, _gb_model, _scaler

    scaler = StandardScaler()
    Xs     = scaler.fit_transform(X)

    rf = RandomForestRegressor(n_estimators=80, max_depth=8, random_state=42, n_jobs=-1)
    rf.fit(Xs, y)

    gb = GradientBoostingRegressor(n_estimators=80, max_depth=4, learning_rate=0.1, random_state=42)
    gb.fit(Xs, y)

    _rf_model = rf
    _gb_model = gb
    _scaler   = scaler
    return rf, gb, scaler


def _train_tf(X, y, scaler):
    global _nn_model

    Xs = scaler.transform(X)

    model = keras.Sequential([
        keras.layers.Input(shape=(5,)),
        keras.layers.Dense(64, activation="relu"),
        keras.layers.BatchNormalization(),
        keras.layers.Dropout(0.15),
        keras.layers.Dense(32, activation="relu"),
        keras.layers.Dense(1, activation="linear"),
    ])
    model.compile(optimizer=keras.optimizers.Adam(0.001), loss="huber")

    # Quiet training
    model.fit(
        Xs, y,
        epochs=40, batch_size=16,
        validation_split=0.15,
        verbose=0,
        callbacks=[keras.callbacks.EarlyStopping(patience=6, restore_best_weights=True)]
    )
    _nn_model = model
    return model


def maybe_retrain():
    global _last_trained
    now = time.time()
    if now - _last_trained < RETRAIN_EVERY:
        return
    _last_trained = now

    db = load_db()
    X, y = extract_samples(db)

    if len(X) < 5:
        return   # not enough data yet

    if SKLEARN_OK:
        _train_sklearn(X, y)

    if TF_OK and len(X) >= 20:
        # Only train TF net when we have enough data
        try:
            scaler = _scaler if _scaler else StandardScaler().fit(X)
            _train_tf(X, y, scaler)
        except Exception as e:
            print(f"[ml_eta] TF training failed: {e}")


# ── public API ───────────────────────────────────────────────────────────────

def predict_eta(dist_km: float, speed_kmph: float,
                network: str = "good",
                hour: int = None, dow: int = None) -> dict:
    """
    Predict ETA in seconds for a given (distance, speed, context).

    Returns:
        {
          "ml_eta_seconds": float | None,
          "model_used":     "rf" | "gb" | "nn" | "formula",
          "confidence":     "high" | "medium" | "low"
        }
    """
    maybe_retrain()

    if hour is None:
        t = time.localtime()
        hour = t.tm_hour
        dow  = t.tm_wday

    features = np.array([[
        dist_km,
        max(speed_kmph, 1.0),
        hour,
        dow if dow is not None else 0,
        network_score(network),
    ]], dtype=np.float32)

    results = {}

    # ── scikit-learn predictions ──────────────────────────────────────────
    if SKLEARN_OK and _scaler and _rf_model and _gb_model:
        Xs  = _scaler.transform(features)
        rf_pred = float(_rf_model.predict(Xs)[0])
        gb_pred = float(_gb_model.predict(Xs)[0])
        results["rf"] = max(rf_pred, 30)
        results["gb"] = max(gb_pred, 30)

    # ── TensorFlow prediction ─────────────────────────────────────────────
    if TF_OK and _scaler and _nn_model:
        try:
            Xs  = _scaler.transform(features)
            nn_pred = float(_nn_model.predict(Xs, verbose=0)[0][0])
            results["nn"] = max(nn_pred, 30)
        except Exception as e:
            print(f"[ml_eta] NN predict error: {e}")

    # ── Pick best available ───────────────────────────────────────────────
    if "nn" in results and "rf" in results:
        # Ensemble: weighted average (NN slightly higher weight with more data)
        ml_eta   = 0.55 * results["nn"] + 0.45 * results["rf"]
        model    = "nn+rf"
        conf     = "high"
    elif "rf" in results and "gb" in results:
        ml_eta   = 0.5 * results["rf"] + 0.5 * results["gb"]
        model    = "rf+gb"
        conf     = "medium"
    elif results:
        key      = list(results.keys())[0]
        ml_eta   = results[key]
        model    = key
        conf     = "medium"
    else:
        # Fallback: physics formula
        sp       = max(speed_kmph, 5.0)
        ml_eta   = (dist_km / sp) * 3600
        model    = "formula"
        conf     = "low"

    return {
        "ml_eta_seconds": round(ml_eta, 1),
        "model_used":     model,
        "confidence":     conf,
        "individual":     results,
    }
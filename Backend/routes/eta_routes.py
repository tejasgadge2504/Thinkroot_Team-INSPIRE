"""
eta_routes.py — ETA Blueprint (updated with ML model integration)
=================================================================
Drop-in replacement for your existing eta_routes.py.

The /get-eta/<driver_id> endpoint now returns BOTH the classical
formula-based ETA AND the ML model prediction.  The frontend can
display whichever is available, preferring the ML one.

New response shape:
{
  "current_location":      { lat, lon, network, timestamp },
  "destination":           { lat, lon },
  "remaining_distance_km": float,
  "avg_speed_kmph":        float,
  "eta_seconds":           float,   ← classical formula (unchanged)
  "ml_eta_seconds":        float,   ← ML model prediction
  "model_used":            str,     ← "rf+gb" / "nn+rf" / "formula"
  "confidence":            str,     ← "high" / "medium" / "low"
}
"""

from routes.eta import predict_eta
from flask import Blueprint, request, jsonify
import json
import time
from utils import calculate_distance, calculate_avg_speed, estimate_eta


eta_bp = Blueprint("eta", __name__)

DB_FILE = "db.json"


def load_db():
    with open(DB_FILE, "r") as f:
        return json.load(f)


@eta_bp.route("/get-eta/<driver_id>", methods=["POST"])
def get_eta(driver_id):
    db = load_db()

    if driver_id not in db.get("locations", {}):
        return jsonify({"error": "No location data"}), 404

    history = db["locations"][driver_id]

    if len(history) < 2:
        return jsonify({"error": "Not enough data"}), 400

    data     = request.json or {}
    dest_lat = data.get("dest_lat")
    dest_lon = data.get("dest_lon")

    if dest_lat is None or dest_lon is None:
        return jsonify({"error": "Destination required"}), 400

    last = history[-1]

    # ── Classical formula (unchanged from original) ───────────────────────
    remaining_distance = calculate_distance(
        last["lat"], last["lon"],
        dest_lat, dest_lon
    )
    speed_kmph  = calculate_avg_speed(history)
    eta_seconds = estimate_eta(remaining_distance, speed_kmph)

    # ── ML prediction ─────────────────────────────────────────────────────
    ts  = last.get("timestamp", time.time())
    t   = time.localtime(ts)
    net = last.get("network", "good")

    ml_result = predict_eta(
        dist_km    = remaining_distance,
        speed_kmph = speed_kmph,
        network    = net,
        hour       = t.tm_hour,
        dow        = t.tm_wday,
    )

    return jsonify({
        "current_location":      last,
        "destination":           {"lat": dest_lat, "lon": dest_lon},
        "remaining_distance_km": remaining_distance,
        "avg_speed_kmph":        speed_kmph,
        "eta_seconds":           eta_seconds,           # classical
        "ml_eta_seconds":        ml_result["ml_eta_seconds"],
        "model_used":            ml_result["model_used"],
        "confidence":            ml_result["confidence"],
    })


@eta_bp.route("/eta-model-info", methods=["GET"])
def eta_model_info():
    """
    Debug endpoint — returns info about the current ML model state.
    Call GET /eta-model-info to inspect training status.
    """
    from ml_eta import _rf_model, _nn_model, _scaler, _last_trained, SKLEARN_OK, TF_OK

    db = load_db()
    total_pings = sum(len(v) for v in db.get("locations", {}).values())

    info = {
        "sklearn_available": SKLEARN_OK,
        "tensorflow_available": TF_OK,
        "rf_model_trained": _rf_model is not None,
        "nn_model_trained": _nn_model is not None,
        "scaler_fitted":    _scaler is not None,
        "total_pings_in_db": total_pings,
        "last_trained_seconds_ago": round(time.time() - _last_trained, 1) if _last_trained else None,
    }

    if SKLEARN_OK and _rf_model is not None:
        from ml_eta import extract_samples
        X, y = extract_samples(db)
        info["training_samples"] = len(X)

    return jsonify(info)
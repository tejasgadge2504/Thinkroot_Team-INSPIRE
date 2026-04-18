from flask import Blueprint, request, jsonify
import json
from utils import calculate_distance, calculate_avg_speed, estimate_eta

eta_bp = Blueprint("eta", __name__)

DB_FILE = "db.json"

def load_db():
    with open(DB_FILE, "r") as f:
        return json.load(f)

@eta_bp.route("/get-eta/<driver_id>", methods=["POST"])
def get_eta(driver_id):
    db = load_db()

    if driver_id not in db["locations"]:
        return jsonify({"error": "No location data"}), 404

    history = db["locations"][driver_id]

    if len(history) < 2:
        return jsonify({"error": "Not enough data"}), 400

    data = request.json
    dest_lat = data.get("dest_lat")
    dest_lon = data.get("dest_lon")

    if dest_lat is None or dest_lon is None:
        return jsonify({"error": "Destination required"}), 400

    last = history[-1]

    # Remaining distance
    remaining_distance = calculate_distance(
        last["lat"], last["lon"],
        dest_lat, dest_lon
    )

    # Average speed
    speed_kmph = calculate_avg_speed(history)

    # ETA
    eta_seconds = estimate_eta(remaining_distance, speed_kmph)

    return jsonify({
        "current_location": last,
        "destination": {
            "lat": dest_lat,
            "lon": dest_lon
        },
        "remaining_distance_km": remaining_distance,
        "avg_speed_kmph": speed_kmph,
        "eta_seconds": eta_seconds
    })
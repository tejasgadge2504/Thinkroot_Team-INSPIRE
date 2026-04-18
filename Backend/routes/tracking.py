from flask import Blueprint, request, jsonify
import json
import time

tracking_bp = Blueprint("tracking", __name__)

DB_FILE = "db.json"

def load_db():
    with open(DB_FILE, "r") as f:
        return json.load(f)

def save_db(data):
    with open(DB_FILE, "w") as f:
        json.dump(data, f, indent=4)


@tracking_bp.route("/update-location", methods=["POST"])
def update_location():
    data = request.json

    driver_id = data.get("driver_id")
    lat = data.get("lat")
    lon = data.get("lon")
    network = data.get("network")

    db = load_db()

    if driver_id not in db["locations"]:
        db["locations"][driver_id] = []

    db["locations"][driver_id].append({
        "lat": lat,
        "lon": lon,
        "network": network,
        "timestamp": int(time.time())
    })

    save_db(db)

    return jsonify({"message": "Location updated"})


# 🔹 Get last location
@tracking_bp.route("/get-bus-location/<driver_id>", methods=["GET"])
def get_bus_location(driver_id):
    db = load_db()

    if driver_id not in db["locations"]:
        return jsonify({"error": "No data"}), 404

    history = db["locations"][driver_id]

    return jsonify({
        "current": history[-1],
        "history": history[-10:]
    })


# 🔹 Get all buses
@tracking_bp.route("/buses", methods=["GET"])
def get_all_buses():
    db = load_db()

    buses = []

    for driver_id, locations in db["locations"].items():
        if locations:
            last = locations[-1]
            buses.append({
                "driver_id": driver_id,
                "lat": last["lat"],
                "lon": last["lon"]
            })

    return jsonify(buses)


# 🔹 Network status
@tracking_bp.route("/network-status/<driver_id>", methods=["GET"])
def network_status(driver_id):
    db = load_db()

    if driver_id not in db["locations"]:
        return jsonify({"error": "No data"}), 404

    last = db["locations"][driver_id][-1]

    return jsonify({
        "network": last.get("network", "unknown")
    })


# 🔹 Bulk update (buffering support)
@tracking_bp.route("/bulk-update-location", methods=["POST"])
def bulk_update():
    data = request.json
    driver_id = data.get("driver_id")
    points = data.get("points", [])

    db = load_db()

    if driver_id not in db["locations"]:
        db["locations"][driver_id] = []

    for p in points:
        db["locations"][driver_id].append(p)

    save_db(db)

    return jsonify({"message": "Bulk data stored"})
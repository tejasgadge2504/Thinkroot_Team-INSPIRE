from flask import Blueprint, request, jsonify
import json

auth_bp = Blueprint("auth", __name__)

DB_FILE = "db.json"

def load_db():
    with open(DB_FILE, "r") as f:
        return json.load(f)

def save_db(data):
    with open(DB_FILE, "w") as f:
        json.dump(data, f, indent=4)

@auth_bp.route("/driver/login", methods=["POST"])
def driver_login():
    data = request.json

    bus_no = data.get("bus_no")
    driver_no = data.get("driver_no")
    plate_no = data.get("plate_no")

    db = load_db()

    driver_id = f"{bus_no}_{driver_no}"

    db["drivers"][driver_id] = {
        "bus_no": bus_no,
        "driver_no": driver_no,
        "plate_no": plate_no
    }

    save_db(db)

    return jsonify({
        "message": "Driver logged in",
        "driver_id": driver_id
    })
from flask import Blueprint, request, jsonify
import json

route_bp = Blueprint("route", __name__)

DB_FILE = "db.json"

def load_db():
    with open(DB_FILE, "r") as f:
        return json.load(f)

# 🔹 1. Get all stations (dropdown)
@route_bp.route("/stations", methods=["GET"])
def get_stations():
    db = load_db()
    return jsonify(list(db["stations"].keys()))


# 🔹 2. Get all routes
@route_bp.route("/routes", methods=["GET"])
def get_routes():
    db = load_db()
    return jsonify(db["routes"])


# 🔹 3. Get buses between source → destination
@route_bp.route("/buses-by-route", methods=["POST"])
def buses_by_route():
    data = request.json
    source = data.get("source")
    destination = data.get("destination")

    db = load_db()

    result = []

    for bus_no, route_id in db["bus_routes"].items():
        route_stations = db["routes"][route_id]

        # check if route contains both stations in correct order
        if source in route_stations and destination in route_stations:
            if route_stations.index(source) < route_stations.index(destination):

                # find active buses
                for driver_id, locs in db["locations"].items():
                    if bus_no in driver_id and len(locs) > 0:
                        last = locs[-1]

                        result.append({
                            "bus_no": bus_no,
                            "driver_id": driver_id,
                            "route": route_id,
                            "current_location": {
                                "lat": last["lat"],
                                "lon": last["lon"]
                            }
                        })

    return jsonify(result)


# 🔹 4. Track bus by bus number
@route_bp.route("/bus/<bus_no>", methods=["GET"])
def get_bus_by_number(bus_no):
    db = load_db()

    result = []

    for driver_id, locs in db["locations"].items():
        if bus_no in driver_id and len(locs) > 0:
            last = locs[-1]

            result.append({
                "driver_id": driver_id,
                "bus_no": bus_no,
                "current_location": {
                    "lat": last["lat"],
                    "lon": last["lon"]
                }
            })

    return jsonify(result)
from flask import Blueprint, request, jsonify
from pymongo import MongoClient
import bcrypt
import os
from bson.objectid import ObjectId
from dotenv import load_dotenv

# Load env variables
load_dotenv()


auth_bp = Blueprint("auth", __name__)

# MongoDB connection
# MONGO_URI = "YOUR_MONGODB_ATLAS_CONNECTION_STRING"
# MONGO_URI = "mongodb+srv://teaminspire2226:INSPIRE%402226@cluster0.6ahzj5u.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
# MongoDB connection from environment variable
MONGO_URI = os.getenv("MONGO_URI")


client = MongoClient(MONGO_URI)
db = client["backend_app"]
users_collection = db["users"]


# -------------------------
# Register users
# -------------------------
@auth_bp.route("/auth/register", methods=["POST"])
def register():

    data = request.json

    name = data.get("name")
    email = data.get("email")
    pin = data.get("pin")

    if not name or not email or not pin:
        return jsonify({"error": "All fields required"}), 400

    if len(pin) != 4:
        return jsonify({"error": "PIN must be 4 digits"}), 400

    existing = users_collection.find_one({"email": email})

    if existing:
        return jsonify({"error": "user already registered"}), 400

    hashed_pin = bcrypt.hashpw(pin.encode("utf-8"), bcrypt.gensalt())

    user = {
        "name": name,
        "email": email,
        "pin": hashed_pin
    }

    users_collection.insert_one(user)

    return jsonify({
        "message": "user registered successfully"
    })


# -------------------------
# Login
# -------------------------
@auth_bp.route("/auth/login", methods=["POST"])
def login():

    data = request.json

    email = data.get("email")
    pin = data.get("pin")

    user = users_collection.find_one({"email": email})

    if not user:
        return jsonify({"error": "user not found"}), 404

    stored_pin = user["pin"]

    if bcrypt.checkpw(pin.encode("utf-8"), stored_pin):

        return jsonify({
            "message": "Login successful",
            "user_id": str(user["_id"]),
            "name": user["name"]
        })

    else:
        return jsonify({"error": "Invalid PIN"}), 401
    

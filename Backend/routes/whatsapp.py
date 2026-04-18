from flask import Blueprint, request, jsonify
import requests
import os

whatsapp_bp = Blueprint("whatsapp", __name__)

# ENV VARIABLES (set these in your system)
ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN")
PHONE_NUMBER_ID = os.getenv("PHONE_NUMBER_ID")
VERIFY_TOKEN = os.getenv("VERIFY_TOKEN")

# ✅ 1. Webhook verification (GET)
@whatsapp_bp.route("/webhook", methods=["GET"])
def verify_webhook():
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if token == VERIFY_TOKEN:
        return challenge, 200
    return "Verification failed", 403


# ✅ 2. Receive messages (POST)
@whatsapp_bp.route("/webhook", methods=["POST"])
def receive_message():
    data = request.get_json()

    try:
        entry = data["entry"][0]
        changes = entry["changes"][0]
        value = changes["value"]

        if "messages" in value:
            message = value["messages"][0]
            sender = message["from"]   # user phone number
            text = message["text"]["body"]

            print(f"Message from {sender}: {text}")

            # 🔥 Auto-reply example
            send_whatsapp_message(sender, f"You said: {text}")

    except Exception as e:
        print("Error:", e)

    return jsonify({"status": "received"}), 200


# ✅ 3. Send message function
def send_whatsapp_message(to, message):
    url = f"https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages"

    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }

    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {
            "body": message
        }
    }

    response = requests.post(url, headers=headers, json=payload)
    print("Send response:", response.json())

    return response.json()
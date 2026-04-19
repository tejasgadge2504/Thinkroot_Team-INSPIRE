# ============================================================
#  whatsapp.py  —  Chalo Bus WhatsApp Bot Blueprint
#
#  Register in app.py:
#      from whatsapp import whatsapp_bp
#      app.register_blueprint(whatsapp_bp)
#
#  Required .env keys:
#      VERIFY_TOKEN        – any secret string you set in Meta dashboard
#      ACCESS_TOKEN        – WABA permanent / long-lived access token
#      PHONE_NUMBER_ID     – from Meta WABA dashboard
#      FLASK_API_BASE      – base URL of your Flask app (default: http://127.0.0.1:5000)
#
#  Webhook URL to register in Meta:
#      https://<your-domain>/webhook
# ============================================================

from flask import Blueprint, request
import os
import requests
from dotenv import load_dotenv

load_dotenv()

whatsapp_bp = Blueprint("whatsapp", __name__)

# ── ENV ─────────────────────────────────────────────────────────────────────
VERIFY_TOKEN    = os.getenv("VERIFY_TOKEN")
ACCESS_TOKEN    = os.getenv("ACCESS_TOKEN")
PHONE_NUMBER_ID = os.getenv("PHONE_NUMBER_ID")
FLASK_API_BASE  = os.getenv("FLASK_API_BASE", "http://127.0.0.1:5000")

# ── Destination lat/lon used for ETA calls (your college / main destination) ─
DEST_LAT = 10.7606
DEST_LON = 78.8151

# ── In-memory session store ──────────────────────────────────────────────────
sessions: dict = {}

# ── State machine constants ──────────────────────────────────────────────────
STATE_IDLE              = "IDLE"
STATE_SEARCH_AWAIT_FROM = "SEARCH_AWAIT_FROM"
STATE_SEARCH_AWAIT_TO   = "SEARCH_AWAIT_TO"
STATE_TRACK_AWAIT_BUS   = "TRACK_AWAIT_BUS"
STATE_DRV_AWAIT_START   = "DRV_AWAIT_START"
STATE_DRV_AWAIT_BUS_NO  = "DRV_AWAIT_BUS_NO"
STATE_DRV_AWAIT_DRV_ID  = "DRV_AWAIT_DRV_ID"
STATE_DRV_AWAIT_PLATE   = "DRV_AWAIT_PLATE"
STATE_DRV_LOGGED_IN     = "DRV_LOGGED_IN"

# ── Static menus ─────────────────────────────────────────────────────────────
MAIN_MENU = (
    "🚌 *Welcome to CHALO BUS!*\n"
    "Real-time campus bus tracker\n\n"
    "What would you like to do?\n\n"
    "1️⃣  Find a bus by route\n"
    "2️⃣  Track a specific bus\n"
    "3️⃣  See all active buses\n"
    "4️⃣  Driver portal\n\n"
    "Reply with *1, 2, 3 or 4*\n"
    "Type *menu* anytime to come back here."
)

DRIVER_MENU = (
    "🚌 *Driver Portal*\n\n"
    "1️⃣  Login & start sharing location\n"
    "2️⃣  Logout / Stop sharing\n\n"
    "Reply *1* or *2*"
)

DRIVER_COMMANDS_HINT = (
    "Commands while logged in:\n"
    "  • *status* — check your broadcast info\n"
    "  • *stop*   — logout and stop sharing\n"
    "  • *menu*   — go back to main menu"
)


# ============================================================
#  HELPERS
# ============================================================

def send_msg(to: str, body: str) -> None:
    """Send a plain-text WhatsApp Cloud API message."""
    url = f"https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages"
    try:
        requests.post(
            url,
            json={
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": {"body": body},
            },
            headers={
                "Authorization": f"Bearer {ACCESS_TOKEN}",
                "Content-Type": "application/json",
            },
            timeout=10,
        )
    except Exception as exc:
        print(f"[send_msg] Failed to send to {to}: {exc}")


def api_get(path: str) -> dict | list | None:
    """GET against the local Flask/app.py API."""
    try:
        r = requests.get(f"{FLASK_API_BASE}{path}", timeout=8)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        print(f"[api_get] {path} → {exc}")
        return None


def api_post(path: str, payload: dict) -> dict | list | None:
    """POST against the local Flask/app.py API."""
    try:
        r = requests.post(
            f"{FLASK_API_BASE}{path}",
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=8,
        )
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        print(f"[api_post] {path} → {exc}")
        return None


def get_session(mobile: str) -> dict:
    if mobile not in sessions:
        sessions[mobile] = {"state": STATE_IDLE, "data": {}}
    return sessions[mobile]


def reset_session(mobile: str) -> None:
    sessions[mobile] = {"state": STATE_IDLE, "data": {}}


def net_emoji(quality: str) -> str:
    return {"good": "📶", "low": "📉", "offline": "❌"}.get(quality, "❓")


def fmt_station_list(stations: list) -> str:
    """Return a numbered list of station names."""
    return "\n".join(f"{i + 1}. {s}" for i, s in enumerate(stations))


def fmt_eta(seconds) -> str:
    """Convert seconds to a human-readable ETA string."""
    try:
        secs = int(seconds)
        if secs <= 0:
            return "Arriving soon"
        mins = round(secs / 60)
        if mins < 60:
            return f"{mins} min"
        hrs  = mins // 60
        rem  = mins % 60
        return f"{hrs}h {rem}m" if rem else f"{hrs}h"
    except (TypeError, ValueError):
        return "—"


def fetch_eta_for_bus(driver_id: str) -> dict | None:
    """
    Call /get-eta/<driver_id> and return the raw result dict, or None on failure.
    Uses the module-level DEST_LAT / DEST_LON as the destination.
    """
    return api_post(f"/get-eta/{driver_id}", {"dest_lat": DEST_LAT, "dest_lon": DEST_LON})


def fmt_bus_card(bus: dict, eta_data: dict | None = None, idx: int | None = None) -> str:
    """
    Build a single bus card string.
    - No lat/lon shown.
    - Shows ETA, distance remaining, and avg speed if eta_data is available.
    """
    bus_no = bus.get("bus_no") or bus.get("driver_id") or "—"
    route  = bus.get("route") or "—"

    # Header line (optional index for numbered lists)
    prefix = f"*{idx}. " if idx is not None else "*"
    header = f"{prefix}Bus {bus_no}*  |  Route {route}"

    lines = [header]

    if eta_data:
        # Prefer ml_eta_seconds, fall back to eta_seconds
        raw_secs = eta_data.get("ml_eta_seconds") or eta_data.get("eta_seconds")
        dist_km  = eta_data.get("remaining_distance_km")
        speed    = eta_data.get("avg_speed_kmph")
        model    = eta_data.get("model_used", "")

        eta_str  = fmt_eta(raw_secs)
        model_tag = f" _(ML)_" if model and model != "formula" else ""

        lines.append(f"   ⏱ ETA   :  *{eta_str}*{model_tag}")

        if dist_km is not None:
            try:
                lines.append(f"   📏 Dist  :  {float(dist_km):.1f} km remaining")
            except (ValueError, TypeError):
                pass

        if speed and float(speed) > 0:
            try:
                lines.append(f"   🚀 Speed :  {round(float(speed))} km/h avg")
            except (ValueError, TypeError):
                pass
    else:
        lines.append("   ⏱ ETA   :  Calculating…")

    return "\n".join(lines)


# ============================================================
#  WEBHOOK — VERIFY (GET)
# ============================================================

@whatsapp_bp.route("/webhook", methods=["GET"])
def verify_webhook():
    token     = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")
    if token == VERIFY_TOKEN:
        return challenge, 200
    return "Verification failed", 403


# ============================================================
#  WEBHOOK — RECEIVE MESSAGE (POST)
# ============================================================

@whatsapp_bp.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json(silent=True) or {}

    # ── Parse payload ────────────────────────────────────────────────────────
    try:
        message  = data["entry"][0]["changes"][0]["value"]["messages"][0]
        mobile   = message["from"]
        msg_type = message.get("type", "text")
    except (KeyError, IndexError):
        return "OK", 200   # delivery receipts, read receipts, etc.

    if msg_type != "text":
        send_msg(mobile, "⚠️ Please send a text message.\nType *menu* to see options.")
        return "OK", 200

    user_msg  = message["text"]["body"].strip()
    lower_msg = user_msg.lower()

    session = get_session(mobile)
    state   = session["state"]

    # ── Global reset ─────────────────────────────────────────────────────────
    if lower_msg in {"hi", "hello", "start", "menu", "help", "back"}:
        reset_session(mobile)
        send_msg(mobile, MAIN_MENU)
        return "OK", 200

    # =========================================================================
    #  STATE: IDLE
    # =========================================================================
    if state == STATE_IDLE:

        if lower_msg == "1":
            # ── Find bus by route ────────────────────────────────────────────
            stations = api_get("/stations") or [
                "Chatram Bus Stand", "Central Bus Stand",
                "BHEL Township", "Thuvakudi", "NIT Trichy",
            ]
            session["data"]["stations"] = stations
            session["state"] = STATE_SEARCH_AWAIT_FROM
            send_msg(
                mobile,
                "🔍 *Find a Bus — Step 1 of 2*\n\n"
                "Select your *departure* stop:\n\n"
                + fmt_station_list(stations)
                + "\n\nReply with the *number* of your stop.",
            )

        elif lower_msg == "2":
            # ── Track specific bus ───────────────────────────────────────────
            session["state"] = STATE_TRACK_AWAIT_BUS
            send_msg(
                mobile,
                "🔎 *Track a Bus*\n\n"
                "Type the *bus number* you want to track.\n"
                "Example: _TN45B1010_",
            )

        elif lower_msg == "3":
            # ── All active buses ─────────────────────────────────────────────
            send_msg(mobile, "⏳ Fetching all active buses and ETAs…")
            buses = api_get("/buses")
            if not buses:
                send_msg(
                    mobile,
                    "😔 No active buses right now.\n"
                    "Try again in a few minutes.\n\nType *menu* for home.",
                )
            else:
                cards = []
                for b in buses:
                    driver_id = b.get("driver_id")
                    eta_data  = fetch_eta_for_bus(driver_id) if driver_id else None
                    cards.append(fmt_bus_card(b, eta_data))

                reply  = f"🚌 *{len(buses)} Active Bus{'es' if len(buses) != 1 else ''}*\n\n"
                reply += "\n\n".join(cards)
                reply += "\n\nType *2* to track a bus  |  *menu* for home"
                send_msg(mobile, reply)

        elif lower_msg == "4":
            # ── Driver portal ────────────────────────────────────────────────
            session["state"] = STATE_DRV_AWAIT_START
            send_msg(mobile, DRIVER_MENU)

        else:
            send_msg(mobile, "❓ Please reply with *1, 2, 3 or 4*.\nType *menu* to see the options.")

        return "OK", 200

    # =========================================================================
    #  STATE: SEARCH — awaiting FROM stop
    # =========================================================================
    if state == STATE_SEARCH_AWAIT_FROM:
        stations = session["data"].get("stations", [])
        try:
            idx = int(user_msg) - 1
            if not (0 <= idx < len(stations)):
                raise ValueError
        except ValueError:
            send_msg(mobile, f"⚠️ Please reply with a number between *1* and *{len(stations)}*.")
            return "OK", 200

        chosen_from = stations[idx]
        session["data"]["from"] = chosen_from

        dest_stations = [s for s in stations if s != chosen_from]
        session["data"]["dest_stations"] = dest_stations
        session["state"] = STATE_SEARCH_AWAIT_TO

        send_msg(
            mobile,
            f"✅ From: *{chosen_from}*\n\n"
            "🚏 *Step 2 of 2* — Select your *destination* stop:\n\n"
            + fmt_station_list(dest_stations)
            + "\n\nReply with the number.",
        )
        return "OK", 200

    # =========================================================================
    #  STATE: SEARCH — awaiting TO stop → fetch buses + ETAs
    # =========================================================================
    if state == STATE_SEARCH_AWAIT_TO:
        dest_stations = session["data"].get("dest_stations", [])
        try:
            idx = int(user_msg) - 1
            if not (0 <= idx < len(dest_stations)):
                raise ValueError
        except ValueError:
            send_msg(mobile, f"⚠️ Please reply with a number between *1* and *{len(dest_stations)}*.")
            return "OK", 200

        chosen_to   = dest_stations[idx]
        chosen_from = session["data"]["from"]
        reset_session(mobile)

        send_msg(mobile, f"⏳ Searching buses from *{chosen_from}* → *{chosen_to}* and fetching ETAs…")

        buses = api_post("/buses-by-route", {"source": chosen_from, "destination": chosen_to})

        if not buses:
            send_msg(
                mobile,
                f"😔 No buses found for *{chosen_from} → {chosen_to}*.\n\n"
                "Try a different route or check back later.\n"
                "Type *1* to search again  |  *menu* for home.",
            )
            return "OK", 200

        # Fetch ETA for every bus on this route
        cards = []
        for i, bus in enumerate(buses, 1):
            driver_id = bus.get("driver_id")
            eta_data  = fetch_eta_for_bus(driver_id) if driver_id else None
            cards.append(fmt_bus_card(bus, eta_data, idx=i))

        reply  = f"🚌 *{len(buses)} Bus{'es' if len(buses) != 1 else ''} Found*\n"
        reply += f"_{chosen_from}  →  {chosen_to}_\n\n"
        reply += "\n\n".join(cards)
        reply += "\n\nType *2* to track a bus  |  *menu* for home"
        send_msg(mobile, reply)
        return "OK", 200

    # =========================================================================
    #  STATE: TRACK — awaiting bus number → fetch live info + ETA
    # =========================================================================
    if state == STATE_TRACK_AWAIT_BUS:
        bus_no = user_msg.upper()
        reset_session(mobile)

        send_msg(mobile, f"⏳ Looking up bus *{bus_no}*…")

        result = api_get(f"/bus/{bus_no}")
        if not result:
            send_msg(
                mobile,
                f"❌ Bus *{bus_no}* not found.\n\n"
                "Double-check the number and try again.\n"
                "Type *2* to search again  |  *menu* for home.",
            )
            return "OK", 200

        bus       = result[0] if isinstance(result, list) else result
        driver_id = bus.get("driver_id")

        # Network quality
        net_data = api_get(f"/network-status/{driver_id}") if driver_id else {}
        net_q    = (net_data or {}).get("network", "unknown")

        # GPS ping history (for count only — no coords shown)
        loc_data = api_get(f"/get-bus-location/{driver_id}") if driver_id else None
        history  = (loc_data or {}).get("history", [])

        # ETA
        eta_data = fetch_eta_for_bus(driver_id) if driver_id else None
        raw_secs = (eta_data or {}).get("ml_eta_seconds") or (eta_data or {}).get("eta_seconds")
        dist_km  = (eta_data or {}).get("remaining_distance_km")
        speed    = (eta_data or {}).get("avg_speed_kmph")
        model    = (eta_data or {}).get("model_used", "")
        eta_str  = fmt_eta(raw_secs)
        model_tag = " _(ML model)_" if model and model != "formula" else ""

        reply  = f"📍 *Bus {bus.get('bus_no', bus_no)} — Live Status*\n\n"
        reply += f"Route     :  {bus.get('route', '—')}\n"
        reply += f"Driver ID :  {driver_id or '—'}\n"
        reply += f"Network   :  {net_emoji(net_q)} {net_q.capitalize()}\n"
        reply += f"GPS pings :  {len(history)}\n"
        reply += f"\n⏱ *ETA  :  {eta_str}*{model_tag}\n"

        if dist_km is not None:
            try:
                reply += f"📏 Dist   :  {float(dist_km):.1f} km remaining\n"
            except (ValueError, TypeError):
                pass

        if speed and float(speed) > 0:
            try:
                reply += f"🚀 Speed  :  {round(float(speed))} km/h avg\n"
            except (ValueError, TypeError):
                pass

        reply += "\nType *3* to see all buses  |  *menu* for home"
        send_msg(mobile, reply)
        return "OK", 200

    # =========================================================================
    #  STATE: DRIVER — sub-menu
    # =========================================================================
    if state == STATE_DRV_AWAIT_START:
        if lower_msg == "2":
            reset_session(mobile)
            send_msg(mobile, "✅ No active session to end.\nType *menu* for home.")
            return "OK", 200

        if lower_msg == "1":
            session["state"] = STATE_DRV_AWAIT_BUS_NO
            send_msg(
                mobile,
                "🚌 *Driver Login — Step 1 of 3*\n\n"
                "Enter your *bus number*:\n"
                "Example: _TN45B1010_",
            )
            return "OK", 200

        send_msg(mobile, "⚠️ Please reply with *1* (Login) or *2* (Logout).")
        return "OK", 200

    # =========================================================================
    #  STATE: DRIVER — collecting credentials (3 steps)
    # =========================================================================
    if state == STATE_DRV_AWAIT_BUS_NO:
        session["data"]["bus_no"] = user_msg.upper()
        session["state"] = STATE_DRV_AWAIT_DRV_ID
        send_msg(
            mobile,
            "✅ Bus number saved!\n\n"
            "*Step 2 of 3* — Enter your *driver ID*:\n"
            "Example: _D1_",
        )
        return "OK", 200

    if state == STATE_DRV_AWAIT_DRV_ID:
        session["data"]["driver_no"] = user_msg
        session["state"] = STATE_DRV_AWAIT_PLATE
        send_msg(
            mobile,
            "✅ Driver ID saved!\n\n"
            "*Step 3 of 3* — Enter your *plate number*:\n"
            "Example: _TN45B1010_",
        )
        return "OK", 200

    if state == STATE_DRV_AWAIT_PLATE:
        session["data"]["plate_no"] = user_msg.upper()

        bus_no    = session["data"].get("bus_no")
        driver_no = session["data"].get("driver_no")
        plate_no  = session["data"]["plate_no"]

        send_msg(mobile, "⏳ Logging you in…")

        result = api_post("/driver/login", {
            "bus_no":    bus_no,
            "driver_no": driver_no,
            "plate_no":  plate_no,
        })

        if not result or result.get("error"):
            err = (result or {}).get("error", "Unknown error. Check your credentials.")
            reset_session(mobile)
            send_msg(
                mobile,
                f"❌ Login failed: {err}\n\n"
                "Type *4* to try again  |  *menu* for home.",
            )
            return "OK", 200

        driver_id = result.get("driver_id")
        session["data"]["driver_id"] = driver_id
        session["state"] = STATE_DRV_LOGGED_IN

        send_msg(
            mobile,
            f"✅ *Logged in as {driver_id}*\n"
            f"Bus: {bus_no}  |  Plate: {plate_no}\n\n"
            "📡 *Location sharing is now active.*\n"
            "Your position is being broadcast to the system.\n\n"
            + DRIVER_COMMANDS_HINT,
        )
        return "OK", 200

    # =========================================================================
    #  STATE: DRIVER — logged in
    # =========================================================================
    if state == STATE_DRV_LOGGED_IN:
        driver_id = session["data"].get("driver_id", "")

        if lower_msg == "status":
            net_data = api_get(f"/network-status/{driver_id}") or {}
            net_q    = net_data.get("network", "unknown")
            loc_data = api_get(f"/get-bus-location/{driver_id}") or {}
            history  = loc_data.get("history", [])
            eta_data = fetch_eta_for_bus(driver_id)
            raw_secs = (eta_data or {}).get("ml_eta_seconds") or (eta_data or {}).get("eta_seconds")
            eta_str  = fmt_eta(raw_secs)

            send_msg(
                mobile,
                f"📡 *Broadcast Status — {driver_id}*\n\n"
                f"Network   :  {net_emoji(net_q)} {net_q.capitalize()}\n"
                f"GPS pings :  {len(history)}\n"
                f"ETA to dest :  {eta_str}\n\n"
                + DRIVER_COMMANDS_HINT,
            )

        elif lower_msg in {"stop", "logout", "quit"}:
            reset_session(mobile)
            send_msg(
                mobile,
                f"🛑 *{driver_id}* logged out.\n"
                "Location sharing has stopped.\n\n"
                "Type *menu* to go back to the main menu.",
            )

        else:
            send_msg(
                mobile,
                "📡 You are currently sharing your location.\n\n"
                + DRIVER_COMMANDS_HINT,
            )

        return "OK", 200

    # =========================================================================
    #  FALLBACK
    # =========================================================================
    send_msg(mobile, "❓ I didn't understand that.\n\nType *menu* to see the options.")
    return "OK", 200
from flask import Flask
from flask_cors import CORS

from routes.auth import auth_bp
from routes.tracking import tracking_bp
from routes.eta import eta_bp
from routes.route import route_bp

app = Flask(__name__)
CORS(app)

app.register_blueprint(auth_bp)
app.register_blueprint(tracking_bp)
app.register_blueprint(eta_bp)
app.register_blueprint(route_bp)

@app.route("/")
def home():
    return {"message": "Backend running 🚀"}

@app.route("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    app.run(debug=True)
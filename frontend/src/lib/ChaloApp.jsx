import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const API_BASE = "http://127.0.0.1:5000";
const POLL_INTERVAL_MS = 4000; // fetch bus locations every 4 seconds

const C = {
  orange:      "#F97316",
  orangeLight: "#FFF7ED",
  orangeDark:  "#EA580C",
  bg:          "#F5F5F5",
  white:       "#FFFFFF",
  text:        "#111827",
  textSub:     "#6B7280",
  textMuted:   "#9CA3AF",
  border:      "#E5E7EB",
  green:       "#16A34A",
  greenBg:     "#F0FDF4",
  greenBorder: "#BBF7D0",
  blue:        "#2563EB",
  blueBg:      "#EFF6FF",
  yellow:      "#D97706",
  yellowBg:    "#FFFBEB",
  red:         "#DC2626",
  redBg:       "#FEF2F2",
  purple:      "#7C3AED",
  purpleBg:    "#F5F3FF",
};

// ─── FORMAT ETA ─────────────────────────────────────────────────────────────
function fmtETA(seconds) {
  if (!seconds || seconds <= 0) return { value: "—", unit: "" };
  const totalMins = Math.round(seconds / 60);
  if (totalMins < 60) return { value: String(totalMins), unit: "min" };
  const hrs  = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0
    ? { value: `${hrs}h ${mins}m`, unit: "" }
    : { value: `${hrs}h`, unit: "" };
}

// ─── STORE-AND-FORWARD BUFFER ────────────────────────────────────────────────
class LocationBuffer {
  constructor() { this.q = []; this.dId = null; this.busy = false; }
  push(dId, lat, lon, net) {
    this.dId = dId;
    this.q.push({ lat, lon, network: net, timestamp: Math.floor(Date.now() / 1000) });
  }
  async flush() {
    if (this.busy || !this.q.length || !this.dId) return;
    this.busy = true;
    const pts = [...this.q];
    try {
      await fetch(`${API_BASE}/bulk-update-location`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver_id: this.dId, points: pts }),
      });
      this.q = this.q.slice(pts.length);
    } catch {}
    this.busy = false;
  }
  size() { return this.q.length; }
}
const locBuf = new LocationBuffer();

// ─── API ────────────────────────────────────────────────────────────────────
const api = {
  stations:    ()            => fetch(`${API_BASE}/stations`).then(r => r.json()),
  buses:       ()            => fetch(`${API_BASE}/buses`).then(r => r.json()),
  busByRoute:  (s, d)        => fetch(`${API_BASE}/buses-by-route`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: s, destination: d }),
  }).then(r => r.json()),
  busLoc:      id            => fetch(`${API_BASE}/get-bus-location/${id}`).then(r => r.json()),
  netStatus:   id            => fetch(`${API_BASE}/network-status/${id}`).then(r => r.json()),
  eta:         (id, lat, lon)=> fetch(`${API_BASE}/get-eta/${id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest_lat: lat, dest_lon: lon }),
  }).then(r => r.json()),
  trackBus:    no            => fetch(`${API_BASE}/bus/${no}`).then(r => r.json()),
  updateLoc:   (id, lat, lon, net) => fetch(`${API_BASE}/update-location`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ driver_id: id, lat, lon, network: net }),
  }).then(r => r.json()),
  driverLogin: (bus, drv, plate) => fetch(`${API_BASE}/driver/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bus_no: bus, driver_no: drv, plate_no: plate }),
  }).then(r => r.json()),
};

// ═══════════════════════════════════════════════════════════════════════════
//  REALTIME BUS MAP
//  ─────────────────
//  This component owns ALL Leaflet state imperatively.
//  When new bus positions arrive via `buses` prop, it does NOT re-render
//  to move markers. Instead it smoothly animates each marker from its
//  previous position to the new position using requestAnimationFrame + lerp.
//  This produces completely fluid realtime movement with no React overhead.
// ═══════════════════════════════════════════════════════════════════════════
function RealtimeBusMap({ buses = [], routePoints = [], height = 300, followBus = null }) {
  const divRef      = useRef(null);
  const mapRef      = useRef(null);
  const markersRef  = useRef({});   // driver_id → { marker, prevLatLng, targetLatLng, animRaf }
  const routeLineRef= useRef(null);
  const tailsRef    = useRef({});   // driver_id → L.polyline (trail behind bus)
  const trailDataRef= useRef({});   // driver_id → [ [lat,lon], ... ] last 30 positions

  // ── init map once Leaflet is loaded ─────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !window.L || !divRef.current) return;
    const L = window.L;
    mapRef.current = L.map(divRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([10.7905, 78.7047], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    }).addTo(mapRef.current);

    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  // ── animate marker from prev → target position via rAF lerp ─────────────
  const animateMarker = useCallback((driverId, fromLatLng, toLatLng) => {
    const L = window.L;
    const state = markersRef.current[driverId];
    if (!state || !L) return;

    if (state.animRaf) cancelAnimationFrame(state.animRaf);

    const ANIM_DURATION = POLL_INTERVAL_MS * 0.9; // animate over 90% of poll interval
    const startTime = performance.now();
    const [fromLat, fromLng] = fromLatLng;
    const [toLat,   toLng]   = toLatLng;

    const step = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / ANIM_DURATION, 1);
      // Ease-in-out cubic for natural movement
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lat = fromLat + (toLat - fromLat) * ease;
      const lng = fromLng + (toLng - fromLng) * ease;

      if (state.marker) state.marker.setLatLng([lat, lng]);

      // update trail in real time during animation
      const trail = trailDataRef.current[driverId] || [];
      const lastTrailPt = trail[trail.length - 1];
      if (!lastTrailPt || Math.abs(lastTrailPt[0] - lat) > 0.00001 || Math.abs(lastTrailPt[1] - lng) > 0.00001) {
        trail.push([lat, lng]);
        if (trail.length > 40) trail.shift();
        trailDataRef.current[driverId] = trail;
        if (tailsRef.current[driverId] && trail.length > 1) {
          tailsRef.current[driverId].setLatLngs(trail);
        }
      }

      if (t < 1) {
        state.animRaf = requestAnimationFrame(step);
      } else {
        state.animRaf = null;
      }
    };
    state.animRaf = requestAnimationFrame(step);
  }, []);

  // ── update markers whenever buses prop changes ───────────────────────────
  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    if (!L || !map) return;

    const makeBusIcon = (label, isLive) => L.divIcon({
      html: `
        <div style="
          position:relative;
          display:flex;flex-direction:column;align-items:center;
        ">
          ${isLive ? `<span style="
            position:absolute;top:-6px;right:-6px;
            width:8px;height:8px;border-radius:50%;
            background:#22C55E;border:1.5px solid white;
            animation:livePulse 1.4s ease-in-out infinite;
          "></span>` : ""}
          <div style="
            background:${C.orange};color:white;
            border-radius:8px;padding:5px 9px;
            font-size:11px;font-weight:700;font-family:'Inter',sans-serif;
            border:2.5px solid white;
            box-shadow:0 3px 10px rgba(249,115,22,0.45);
            white-space:nowrap;letter-spacing:0.02em;
          ">${label}</div>
          <div style="
            width:0;height:0;
            border-left:5px solid transparent;
            border-right:5px solid transparent;
            border-top:6px solid ${C.orange};
            margin-top:-1px;
          "></div>
        </div>
      `,
      className: "",
      iconAnchor: [28, 32],
      iconSize: [56, 38],
    });

    buses.forEach(bus => {
      const loc = bus.current_location;
      if (!loc?.lat || !loc?.lon) return;

      const label  = bus.bus_no || bus.driver_id || "BUS";
      const latLng = [Number(loc.lat), Number(loc.lon)];
      const dId    = bus.driver_id;

      if (markersRef.current[dId]) {
        // Marker exists — animate to new position
        const prev = markersRef.current[dId].marker.getLatLng();
        animateMarker(dId, [prev.lat, prev.lng], latLng);
      } else {
        // New marker — create it
        const marker = L.marker(latLng, {
          icon: makeBusIcon(label, true),
          zIndexOffset: 1000,
        })
          .addTo(map)
          .bindPopup(`<b>${label}</b><br>Route: ${bus.route || "—"}`);

        // Create trail polyline
        const trail = L.polyline([], {
          color: C.orange,
          weight: 3,
          opacity: 0.4,
          dashArray: "4 6",
        }).addTo(map);

        markersRef.current[dId]  = { marker, animRaf: null };
        tailsRef.current[dId]    = trail;
        trailDataRef.current[dId]= [latLng];
      }
    });

    // Remove stale markers (bus no longer in list)
    const activeIds = new Set(buses.map(b => b.driver_id));
    Object.keys(markersRef.current).forEach(dId => {
      if (!activeIds.has(dId)) {
        if (markersRef.current[dId].animRaf) cancelAnimationFrame(markersRef.current[dId].animRaf);
        markersRef.current[dId].marker.remove();
        if (tailsRef.current[dId]) tailsRef.current[dId].remove();
        delete markersRef.current[dId];
        delete tailsRef.current[dId];
        delete trailDataRef.current[dId];
      }
    });

    // Auto-pan to followed bus
    if (followBus && markersRef.current[followBus]) {
      const pos = markersRef.current[followBus].marker.getLatLng();
      map.panTo(pos, { animate: true, duration: 0.8 });
    }

  }, [buses, animateMarker, followBus]);

  // ── route highlight polyline ─────────────────────────────────────────────
  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    if (!L || !map) return;
    if (routeLineRef.current) routeLineRef.current.remove();
    if (routePoints.length > 1) {
      routeLineRef.current = L.polyline(
        routePoints.map(p => [p.lat, p.lon]),
        { color: C.orange, weight: 5, opacity: 0.7, dashArray: "10 6" }
      ).addTo(map);
      map.fitBounds(routeLineRef.current.getBounds(), { padding: [24, 24] });
    }
  }, [routePoints]);

  return (
    <div style={{ position: "relative", borderRadius: 14, overflow: "hidden",
      border: `1px solid ${C.border}`, boxShadow: "0 2px 12px rgba(0,0,0,0.07)" }}>
      <div ref={divRef} style={{ height, zIndex: 1 }} />

      {/* Live indicator overlay */}
      <div style={{
        position: "absolute", top: 10, left: 10, zIndex: 500,
        background: "white", borderRadius: 8,
        padding: "5px 10px", display: "flex", alignItems: "center", gap: 6,
        border: `1px solid ${C.border}`,
        boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: C.green, display: "inline-block",
          animation: "livePulse 1.4s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>
          LIVE · {buses.filter(b => b.current_location?.lat).length} bus{buses.length !== 1 ? "es" : ""}
        </span>
      </div>

      {/* Last updated timestamp */}
      <LastUpdatedBadge />
    </div>
  );
}

function LastUpdatedBadge() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSec(s => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // reset on prop change would require lifting state; this is a simple local ticker
  return (
    <div style={{
      position: "absolute", bottom: 10, right: 10, zIndex: 500,
      background: "rgba(255,255,255,0.9)", borderRadius: 7,
      padding: "4px 9px", fontSize: 10, color: C.textMuted,
      border: `1px solid ${C.border}`,
    }}>
      {sec}s ago
    </div>
  );
}

// ─── LEAFLET LOADER ─────────────────────────────────────────────────────────
function LeafletLoader({ children }) {
  const [ok, setOk] = useState(!!window.L);
  useEffect(() => {
    if (window.L) { setOk(true); return; }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = () => setOk(true);
    document.head.appendChild(s);
  }, []);
  if (!ok) return (
    <div style={{ height: 300, background: "#F1F5F9", borderRadius: 14,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: C.textMuted, fontSize: 13, border: `1px solid ${C.border}` }}>
      Loading map...
    </div>
  );
  return children;
}

// ─── SHARED UI PRIMITIVES ───────────────────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted,
      letterSpacing: "0.1em", marginBottom: 8, marginTop: 2 }}>
      {children}
    </div>
  );
}
function Card({ children, style = {} }) {
  return (
    <div style={{ background: C.white, borderRadius: 14,
      border: `1px solid ${C.border}`, padding: "16px", ...style }}>
      {children}
    </div>
  );
}
function NetPill({ q, ms }) {
  const map = {
    good:    { color: C.green,  bg: C.greenBg,  label: "Good"    },
    low:     { color: C.yellow, bg: C.yellowBg, label: "Weak"    },
    offline: { color: C.red,    bg: C.redBg,    label: "Offline" },
  };
  const c = map[q] || { color: C.textMuted, bg: "#F3F4F6", label: "—" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5,
      background: c.bg, borderRadius: 20, padding: "3px 10px" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.color,
        animation: q === "good" ? "livePulse 1.4s infinite" : "none" }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: c.color }}>
        {c.label}{ms ? ` · ${Math.round(ms / 1000)}s` : ""}
      </span>
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEARCH PAGE
//  ─ polls /get-bus-location every POLL_INTERVAL_MS
//  ─ feeds live coordinates directly into RealtimeBusMap
//  ─ cards update ETA dynamically
// ═══════════════════════════════════════════════════════════════════════════
function SearchPage() {
  const [stations, setStations]    = useState([]);
  const [from, setFrom]            = useState("");
  const [to, setTo]                = useState("");
  const [results, setResults]      = useState(null);
  const [loading, setLoading]      = useState(false);
  const [netQ, setNetQ]            = useState("good");
  const [etaMap, setEtaMap]        = useState({});
  // mapBuses = what gets fed into RealtimeBusMap, updated every poll cycle
  const [mapBuses, setMapBuses]    = useState([]);
  const [selectedBus, setSelected] = useState(null);
  const [routePts, setRoutePts]    = useState([]);
  const resultsRef                 = useRef(null);
  const pollRef                    = useRef(null);

  useEffect(() => {
    api.stations()
      .then(setStations)
      .catch(() => setStations([
        "Chatram Bus Stand", "Central Bus Stand",
        "BHEL Township", "Thuvakudi", "NIT Trichy",
      ]));
  }, []);

  // ── realtime poll loop ────────────────────────────────────────────────────
  const startPolling = useCallback((busResults) => {
    if (pollRef.current) clearInterval(pollRef.current);

    const fetchAll = async () => {
      if (!busResults?.length) return;
      const updates = await Promise.allSettled(
        busResults.map(bus => api.busLoc(bus.driver_id))
      );
      const nsRes = await Promise.allSettled(
        busResults.map(bus => api.netStatus(bus.driver_id))
      );

      // Derive network quality from first successful response
      const firstNs = nsRes.find(r => r.status === "fulfilled")?.value;
      if (firstNs?.network) setNetQ(firstNs.network);

      // Merge live positions into mapBuses
      setMapBuses(
        busResults.map((bus, i) => {
          const locData = updates[i].status === "fulfilled" ? updates[i].value : null;
          const cur = locData?.current;
          return {
            ...bus,
            current_location: cur
              ? { lat: Number(cur.lat), lon: Number(cur.lon) }
              : bus.current_location,
            _history: locData?.history || [],
          };
        })
      );

      // Fetch ML ETA for each bus (non-blocking)
      busResults.forEach(async (bus) => {
        try {
          const etaRes = await api.eta(bus.driver_id, 10.7606, 78.8151);
          setEtaMap(prev => ({ ...prev, [bus.driver_id]: etaRes }));
        } catch {}
      });
    };

    fetchAll(); // immediate
    pollRef.current = setInterval(fetchAll, POLL_INTERVAL_MS);
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const search = async () => {
    if (!from || !to) return;
    setLoading(true);
    setResults(null);
    setMapBuses([]);
    setEtaMap({});
    setSelected(null);
    setRoutePts([]);
    if (pollRef.current) clearInterval(pollRef.current);

    try {
      const r = await api.busByRoute(from, to);
      const buses = r || [];
      setResults(buses);
      resultsRef.current = buses;
      // Seed map with whatever coordinates came in the search result
      setMapBuses(buses.map(b => ({
        ...b,
        current_location: b.current_location
          ? { lat: Number(b.current_location.lat), lon: Number(b.current_location.lon) }
          : null,
      })));
      startPolling(buses);
    } catch {
      setResults([]);
    }
    setLoading(false);
  };

  const swap = () => { setFrom(to); setTo(from); };

  const selectBus = (bus) => {
    if (selectedBus === bus.driver_id) {
      setSelected(null);
      setRoutePts([]);
    } else {
      setSelected(bus.driver_id);
      const hist = (bus._history || []).map(h => ({ lat: Number(h.lat), lon: Number(h.lon) }));
      setRoutePts(hist);
    }
  };

  const pollMs = netQ === "good" ? POLL_INTERVAL_MS : netQ === "low" ? 15000 : 30000;

  return (
    <div>
      {/* HEADER */}
      <div style={{ background: C.orange, padding: "20px 20px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between",
          alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: "white" }}>Find Your Bus</span>
          <NetPill q={netQ} ms={pollMs} />
        </div>

        {/* FROM / TO selects */}
        <div style={{ background: "white", borderRadius: 14, padding: 14, position: "relative" }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted,
              letterSpacing: "0.1em", marginBottom: 6 }}>FROM</div>
            <div style={{ position: "relative" }}>
              <select
                value={from}
                onChange={e => setFrom(e.target.value)}
                style={{
                  width: "100%", padding: "11px 36px 11px 12px", borderRadius: 9,
                  border: `1.5px solid ${from ? C.orange : C.border}`,
                  fontSize: 14, color: from ? C.text : C.textMuted,
                  background: C.white, appearance: "none", outline: "none",
                  boxSizing: "border-box", fontFamily: "inherit", cursor: "pointer",
                  fontWeight: from ? 500 : 400,
                }}
              >
                <option value="">Select departure stop</option>
                {stations.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span style={{ position: "absolute", right: 12, top: "50%",
                transform: "translateY(-50%)", fontSize: 11, color: C.textMuted,
                pointerEvents: "none" }}>▼</span>
            </div>
          </div>

          {/* SWAP */}
          <button onClick={swap} style={{
            position: "absolute", right: 22, top: "50%", transform: "translateY(-50%)",
            width: 32, height: 32, borderRadius: "50%",
            border: `2px solid ${C.orange}`, background: C.white,
            cursor: "pointer", fontSize: 16, color: C.orange,
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
          }}>⇅</button>

          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted,
              letterSpacing: "0.1em", marginBottom: 6 }}>TO</div>
            <div style={{ position: "relative" }}>
              <select
                value={to}
                onChange={e => setTo(e.target.value)}
                style={{
                  width: "100%", padding: "11px 36px 11px 12px", borderRadius: 9,
                  border: `1.5px solid ${to ? C.orange : C.border}`,
                  fontSize: 14, color: to ? C.text : C.textMuted,
                  background: C.white, appearance: "none", outline: "none",
                  boxSizing: "border-box", fontFamily: "inherit", cursor: "pointer",
                  fontWeight: to ? 500 : 400,
                }}
              >
                <option value="">Select destination stop</option>
                {stations.filter(s => s !== from).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span style={{ position: "absolute", right: 12, top: "50%",
                transform: "translateY(-50%)", fontSize: 11, color: C.textMuted,
                pointerEvents: "none" }}>▼</span>
            </div>
          </div>
        </div>

        <button
          onClick={search}
          disabled={!from || !to || loading}
          style={{
            width: "100%", marginTop: 12, border: "none", borderRadius: 10,
            padding: "12px", fontSize: 15, fontWeight: 700, cursor: "pointer",
            background: (!from || !to) ? "rgba(255,255,255,0.35)" : "white",
            color: (!from || !to) ? "rgba(255,255,255,0.55)" : C.orange,
          }}
        >
          {loading ? "Searching..." : "Search for Bus"}
        </button>
      </div>

      {/* BODY */}
      <div style={{ padding: "16px 16px 24px" }}>

        {/* REALTIME MAP — always visible once we have results */}
        {mapBuses.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>
              {selectedBus ? "LIVE MAP — ROUTE HIGHLIGHTED" : "LIVE MAP — BUS POSITIONS"}
            </SectionLabel>
            <RealtimeBusMap
              buses={mapBuses}
              routePoints={routePts}
              followBus={selectedBus}
              height={300}
            />
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "48px 0",
            color: C.textMuted, fontSize: 14 }}>Searching routes...</div>
        )}

        {results?.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              No buses found on this route
            </div>
            <div style={{ fontSize: 13, color: C.textMuted }}>
              Try a different route or check back later
            </div>
          </div>
        )}

        {results?.length > 0 && (
          <SectionLabel>
            {results.length} BUS{results.length > 1 ? "ES" : ""} FOUND
            {selectedBus ? " — TAP CARD TO DESELECT" : " — TAP CARD TO SHOW ROUTE"}
          </SectionLabel>
        )}

        {/* Bus cards — read live data from mapBuses */}
        {mapBuses.map((bus, i) => {
          const eta   = etaMap[bus.driver_id];
          const isSel = selectedBus === bus.driver_id;
          return (
            <BusCard
              key={bus.driver_id || i}
              bus={bus}
              eta={eta}
              isSelected={isSel}
              onTap={() => selectBus(bus)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── BUS CARD ────────────────────────────────────────────────────────────────
function BusCard({ bus, eta, isSelected, onTap }) {
  const loc       = bus.current_location;
  const etaMl     = eta?.ml_eta_seconds || eta?.eta_seconds;
  const etaFmt    = fmtETA(etaMl);
  const dist      = eta?.remaining_distance_km;
  const speed     = eta?.avg_speed_kmph;
  const modelUsed = eta?.model_used;

  return (
    <div
      onClick={onTap}
      style={{
        background: C.white, borderRadius: 14, marginBottom: 10, cursor: "pointer",
        border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? C.orange : C.border}`,
        boxShadow: isSelected ? `0 0 0 4px ${C.orange}18` : "0 1px 3px rgba(0,0,0,0.04)",
        transition: "box-shadow 0.15s, border 0.15s",
        overflow: "hidden",
      }}
    >
      {/* Orange top accent when selected */}
      {isSelected && (
        <div style={{ height: 3, background: C.orange }} />
      )}

      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          {/* Left info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              <span style={{
                background: C.orange, color: "white",
                fontWeight: 700, fontSize: 13, padding: "3px 10px", borderRadius: 7,
              }}>{bus.bus_no || bus.driver_id}</span>

              {bus.route && (
                <span style={{
                  background: C.bg, border: `1px solid ${C.border}`,
                  color: C.text, fontSize: 12, fontWeight: 600,
                  padding: "3px 9px", borderRadius: 7,
                }}>Route {bus.route}</span>
              )}

              {/* Live dot */}
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                background: C.greenBg, color: C.green,
                fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 7,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%",
                  background: C.green, animation: "livePulse 1.4s infinite" }} />
                LIVE
              </span>
            </div>

            {/* Live coordinates — update on every poll */}
            <div style={{
              fontSize: 12, color: C.textSub, fontFamily: "monospace",
              background: C.bg, borderRadius: 7, padding: "5px 8px", display: "inline-block",
            }}>
              {loc
                ? `${Number(loc.lat).toFixed(5)}, ${Number(loc.lon).toFixed(5)}`
                : "Acquiring..."}
            </div>
          </div>

          {/* ETA badge */}
          {etaMl ? (
            <div style={{
              background: modelUsed && modelUsed !== "formula" ? C.greenBg : C.bg,
              border: `1px solid ${modelUsed && modelUsed !== "formula" ? C.greenBorder : C.border}`,
              borderRadius: 10, padding: "8px 12px", textAlign: "center",
              minWidth: 70, marginLeft: 12, flexShrink: 0,
            }}>
              <div style={{
                fontSize: 22, fontWeight: 800, lineHeight: 1,
                color: modelUsed && modelUsed !== "formula" ? C.green : C.text,
              }}>
                {etaFmt.value}
              </div>
              <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
                {etaFmt.unit || "ETA"}
              </div>
              {modelUsed && modelUsed !== "formula" && (
                <div style={{ fontSize: 9, color: C.green, fontWeight: 700, marginTop: 1 }}>
                  ML {modelUsed}
                </div>
              )}
            </div>
          ) : (
            <div style={{ minWidth: 70, marginLeft: 12, textAlign: "center",
              color: C.textMuted, fontSize: 12 }}>ETA...</div>
          )}
        </div>

        {/* Stats row */}
        {(dist != null || speed > 0) && (
          <div style={{ display: "flex", gap: 20, marginTop: 10,
            paddingTop: 10, borderTop: `1px solid ${C.bg}` }}>
            {/* {dist != null && (
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                  {Number(dist).toFixed(1)}
                </div>
                <div style={{ fontSize: 10, color: C.textMuted }}>km remaining</div>
              </div>
            )} */}
            {speed > 0 && (
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                  {Math.round(speed)}
                </div>
                <div style={{ fontSize: 10, color: C.textMuted }}>km/h avg</div>
              </div>
            )}
            {bus._history?.length > 0 && (
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                  {bus._history.length}
                </div>
                <div style={{ fontSize: 10, color: C.textMuted }}>GPS pings</div>
              </div>
            )}
          </div>
        )}

        {isSelected && (
          <div style={{ marginTop: 10, fontSize: 11, fontWeight: 600, color: C.orange }}>
            Route path highlighted on map
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  TRACK PAGE — all active buses, realtime
// ═══════════════════════════════════════════════════════════════════════════
function TrackPage() {
  const [allBuses, setAll]        = useState([]);
  const [mapBuses, setMapBuses]   = useState([]);
  const [netQ, setNetQ]           = useState("good");
  const [bufCount, setBuf]        = useState(0);
  const [busDetail, setBusDetail] = useState(null);
  const [searchNo, setSearchNo]   = useState("");
  const pollRef                   = useRef(null);

  const fetchAll = useCallback(async () => {
    try {
      const buses = await api.buses();
      setAll(buses || []);
      setMapBuses((buses || []).map(b => ({
        driver_id: b.driver_id,
        bus_no: b.driver_id,
        current_location: { lat: Number(b.lat), lon: Number(b.lon) },
      })));
      if (buses?.[0]) {
        const ns = await api.netStatus(buses[0].driver_id).catch(() => ({}));
        const q  = ns.network || "good";
        setNetQ(q);
        if (q === "good") { await locBuf.flush(); setBuf(locBuf.size()); }
      }
    } catch { setNetQ("offline"); }
  }, []);

  useEffect(() => {
    fetchAll();
    pollRef.current = setInterval(fetchAll, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [fetchAll]);

  const trackBus = async () => {
    if (!searchNo.trim()) return;
    try {
      const d = await api.trackBus(searchNo.trim());
      if (d?.[0]) {
        const loc = await api.busLoc(d[0].driver_id).catch(() => null);
        setBusDetail({ ...d[0], history: loc?.history || [] });
      }
    } catch {}
  };

  const pollMs = netQ === "good" ? POLL_INTERVAL_MS : netQ === "low" ? 15000 : 30000;

  return (
    <div>
      <div style={{ background: C.orange, padding: "20px 20px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between",
          alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: "white" }}>Live Tracker</span>
          <NetPill q={netQ} ms={pollMs} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={searchNo}
            onChange={e => setSearchNo(e.target.value)}
            onKeyDown={e => e.key === "Enter" && trackBus()}
            placeholder="Enter bus number e.g. TN45B1010"
            style={{
              flex: 1, padding: "11px 14px", borderRadius: 10,
              border: "none", fontSize: 14, outline: "none",
              boxSizing: "border-box", fontFamily: "inherit",
            }}
          />
          <button onClick={trackBus} style={{
            background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 10,
            padding: "11px 18px", color: "white", fontWeight: 700, fontSize: 14, cursor: "pointer",
          }}>Track</button>
        </div>
      </div>

      <div style={{ padding: "16px 16px 24px" }}>
        {bufCount > 0 && (
          <div style={{ background: C.yellowBg, border: `1px solid #FCD34D`,
            borderRadius: 12, padding: "12px 14px", marginBottom: 14,
            display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: C.yellow }}>
                {bufCount} location{bufCount > 1 ? "s" : ""} buffered
              </div>
              <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>
                Syncing when signal returns
              </div>
            </div>
            <div style={{ fontWeight: 800, fontSize: 22, color: C.yellow }}>{bufCount}</div>
          </div>
        )}

        {/* Adaptive info */}
        <Card style={{ marginBottom: 14, display: "flex",
          justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
              Adaptive Polling Active
            </div>
            <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>
              Updates every {Math.round(pollMs / 1000)}s based on network
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: C.orange }}>
              {Math.round(pollMs / 1000)}s
            </div>
          </div>
        </Card>

        {/* ALL BUSES MAP */}
        {mapBuses.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <SectionLabel>ALL ACTIVE BUSES — REALTIME</SectionLabel>
            <RealtimeBusMap
              buses={mapBuses}
              routePoints={busDetail?.history?.map(h => ({ lat: h.lat, lon: h.lon })) || []}
              height={280}
            />
          </div>
        )}

        {/* Individual bus cards */}
        {allBuses.length > 0 && (
          <>
            <SectionLabel>ACTIVE BUSES ({allBuses.length})</SectionLabel>
            {allBuses.map((bus, i) => (
              <div key={bus.driver_id || i} style={{
                background: C.white, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: "12px 14px", marginBottom: 8,
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 3 }}>
                    {bus.driver_id}
                  </div>
                  <div style={{ fontSize: 11, color: C.textSub, fontFamily: "monospace" }}>
                    {Number(bus.lat).toFixed(5)}, {Number(bus.lon).toFixed(5)}
                  </div>
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4,
                  background: C.greenBg, color: C.green,
                  fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20 }}>
                  <span style={{ width: 5, height: 5, borderRadius: "50%",
                    background: C.green, animation: "livePulse 1.4s infinite" }} />
                  Active
                </span>
              </div>
            ))}
          </>
        )}

        {/* Tracked bus detail panel */}
        {busDetail && (
          <Card style={{ marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between",
              alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: C.text }}>
                  {busDetail.bus_no}
                </div>
                <div style={{ fontSize: 12, color: C.textSub }}>{busDetail.driver_id}</div>
              </div>
              <button onClick={() => setBusDetail(null)} style={{
                background: "none", border: `1px solid ${C.border}`,
                borderRadius: 8, padding: "5px 10px",
                fontSize: 12, color: C.textSub, cursor: "pointer",
              }}>Clear</button>
            </div>
            <div style={{ background: C.bg, borderRadius: 9, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, marginBottom: 4 }}>
                POSITION
              </div>
              <div style={{ fontSize: 13, color: C.text, fontFamily: "monospace" }}>
                {busDetail.current_location?.lat?.toFixed(6)},&nbsp;
                {busDetail.current_location?.lon?.toFixed(6)}
              </div>
            </div>
          </Card>
        )}

        {mapBuses.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0",
            color: C.textMuted, fontSize: 14 }}>
            No active buses right now
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  DRIVER SCREEN
// ═══════════════════════════════════════════════════════════════════════════
function DriverScreen({ onBack }) {
  const [form, setForm]       = useState({ busNo: "", driverNo: "", plateNo: "" });
  const [loginRes, setLogin]  = useState(null);
  const [err, setErr]         = useState("");
  const [loggedIn, setIn]     = useState(false);
  const [sharing, setSharing] = useState(false);
  const [netQ, setNetQ]       = useState("good");
  const [bufCount, setBuf]    = useState(0);
  const [pings, setPings]     = useState(0);
  const [lastSent, setLast]   = useState(null);
  const loopRef               = useRef(null);
  const posRef                = useRef({ lat: 10.7905, lon: 78.7047 });

  const handleLogin = async () => {
    setErr("");
    try {
      const res = await api.driverLogin(form.busNo, form.driverNo, form.plateNo);
      setLogin(res); setIn(true);
      locBuf.dId = res.driver_id;
    } catch { setErr("Login failed — check credentials."); }
  };

  const startSharing = () => {
    if (loopRef.current) return;
    setSharing(true);
    const id = loginRes.driver_id;

    const send = async () => {
      posRef.current.lat += (Math.random() - 0.5) * 0.0012;
      posRef.current.lon += (Math.random() - 0.5) * 0.0012;
      const { lat, lon } = posRef.current;

      if (netQ === "offline") {
        locBuf.push(id, lat, lon, netQ); setBuf(locBuf.size());
      } else {
        try {
          await api.updateLoc(id, lat, lon, netQ);
          setPings(p => p + 1);
          setLast({ lat, lon, time: new Date().toLocaleTimeString() });
          if (locBuf.size() > 0) { await locBuf.flush(); setBuf(locBuf.size()); }
        } catch {
          locBuf.push(id, lat, lon, "low"); setBuf(locBuf.size());
        }
      }
    };

    send();
    loopRef.current = setInterval(send, 60000); // every 60s
  };

  const stopSharing = () => {
    clearInterval(loopRef.current); loopRef.current = null; setSharing(false);
  };

  const logout = () => {
    stopSharing(); setIn(false); setLogin(null); setPings(0); setLast(null);
  };

  // ── login form ─────────────────────────────────────────────────────────
  if (!loggedIn) return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      <div style={{ background: C.orange, padding: "20px 20px 28px" }}>
        <button onClick={onBack} style={{
          background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 8,
          color: "white", padding: "6px 12px", fontSize: 13, fontWeight: 600,
          cursor: "pointer", marginBottom: 16,
        }}>Back</button>
        <div style={{ fontSize: 22, fontWeight: 800, color: "white" }}>Driver Portal</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 4 }}>
          Login to start sharing your location
        </div>
      </div>
      <div style={{ padding: 20 }}>
        <Card>
          {[
            { key: "busNo",    label: "BUS NUMBER",   ph: "e.g. TN45B1010" },
            { key: "driverNo", label: "DRIVER ID",    ph: "e.g. D1"        },
            { key: "plateNo",  label: "PLATE NUMBER", ph: "e.g. TN45B1010" },
          ].map(f => (
            <div key={f.key} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted,
                letterSpacing: "0.09em", marginBottom: 6 }}>{f.label}</div>
              <input
                value={form[f.key]}
                onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                placeholder={f.ph}
                style={{
                  width: "100%", padding: "11px 12px", borderRadius: 10,
                  border: `1.5px solid ${form[f.key] ? C.orange : C.border}`,
                  fontSize: 14, outline: "none", boxSizing: "border-box",
                  fontFamily: "inherit", color: C.text,
                }}
              />
            </div>
          ))}
          {err && (
            <div style={{ background: C.redBg, border: `1px solid #FCA5A5`,
              borderRadius: 8, padding: "10px 12px", fontSize: 13, color: C.red,
              marginBottom: 14 }}>{err}</div>
          )}
          <button
            onClick={handleLogin}
            disabled={!form.busNo || !form.driverNo || !form.plateNo}
            style={{
              width: "100%", border: "none", borderRadius: 10, padding: 13,
              fontSize: 15, fontWeight: 700, cursor: "pointer",
              background: (!form.busNo || !form.driverNo || !form.plateNo) ? C.border : C.orange,
              color: (!form.busNo || !form.driverNo || !form.plateNo) ? C.textMuted : "white",
            }}
          >Login as Driver</button>
        </Card>
      </div>
    </div>
  );

  // ── driver dashboard ────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      <div style={{ background: sharing ? C.green : C.orange, padding: "20px 20px 24px",
        transition: "background 0.4s" }}>
        <div style={{ display: "flex", justifyContent: "space-between",
          alignItems: "center", marginBottom: 14 }}>
          <button onClick={logout} style={{
            background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 8,
            color: "white", padding: "6px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>Logout</button>
          <NetPill q={netQ} ms={sharing ? 60000 : 0} />
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginBottom: 4 }}>
          {loginRes?.driver_id}
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "white" }}>
          {sharing ? "Sharing Location" : "Ready to Share"}
        </div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 4 }}>
          {sharing ? "Broadcasting every 60 seconds" : "Press Start to broadcast your location"}
        </div>
      </div>

      <div style={{ padding: 20 }}>
        {!sharing
          ? <button onClick={startSharing} style={{
              width: "100%", background: C.orange, border: "none", borderRadius: 14,
              padding: 18, color: "white", fontSize: 17, fontWeight: 800,
              cursor: "pointer", marginBottom: 16,
            }}>Start Sharing Location</button>
          : <button onClick={stopSharing} style={{
              width: "100%", background: C.red, border: "none", borderRadius: 14,
              padding: 18, color: "white", fontSize: 17, fontWeight: 800,
              cursor: "pointer", marginBottom: 16,
            }}>Stop Sharing</button>
        }

        {sharing && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <Card style={{ textAlign: "center" }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.green }}>{pings}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Pings sent</div>
            </Card>
            <Card style={{ textAlign: "center" }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.orange }}>{bufCount}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Buffered</div>
            </Card>
          </div>
        )}

        {lastSent && (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted,
              letterSpacing: "0.09em", marginBottom: 8 }}>LAST BROADCAST</div>
            <div style={{ fontSize: 13, color: C.text, fontFamily: "monospace", marginBottom: 4 }}>
              {lastSent.lat.toFixed(6)}, {lastSent.lon.toFixed(6)}
            </div>
            <div style={{ fontSize: 11, color: C.textSub }}>{lastSent.time}</div>
          </Card>
        )}

        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted,
            letterSpacing: "0.09em", marginBottom: 10 }}>SIMULATE NETWORK</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {["good", "low", "offline"].map(q => (
              <button key={q} onClick={() => setNetQ(q)} style={{
                padding: "10px 4px", border: "none", borderRadius: 9, cursor: "pointer",
                background: netQ === q ? C.orange : C.bg,
                color: netQ === q ? "white" : C.textSub,
                fontSize: 12, fontWeight: 700,
              }}>
                {q === "good" ? "Good" : q === "low" ? "Weak" : "Offline"}
              </button>
            ))}
          </div>
        </Card>

        {bufCount > 0 && (
          <div style={{ background: C.yellowBg, border: `1px solid #FCD34D`,
            borderRadius: 12, padding: "14px 16px",
            display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.yellow }}>
                {bufCount} ping{bufCount > 1 ? "s" : ""} queued
              </div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>
                Will sync when signal returns
              </div>
            </div>
            <div style={{ fontWeight: 800, fontSize: 28, color: C.yellow }}>{bufCount}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  HOME PAGE
// ═══════════════════════════════════════════════════════════════════════════
function HomePage({ setTab }) {
  return (
    <div>
      <div style={{ background: C.orange, padding: "24px 20px 28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between",
          alignItems: "flex-start", marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)",
              fontWeight: 600, letterSpacing: "0.12em", marginBottom: 6 }}>
              COLLEGE TRANSIT
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: "white", lineHeight: 1.1 }}>
              CHALO BUS
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.78)", marginTop: 5 }}>
              Real-time tracking for campus routes
            </div>
          </div>
          <div style={{ background: "rgba(255,255,255,0.18)", borderRadius: 10,
            padding: "6px 12px", fontSize: 12, fontWeight: 600, color: "white" }}>
            Mumbai
          </div>
        </div>
      </div>

      <div style={{ padding: "0 16px 24px", marginTop: -14 }}>
        <Card style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.09)", marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>
            Where are you going?
          </div>
          <button onClick={() => setTab("search")} style={{
            width: "100%", background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 10, padding: "11px 14px", textAlign: "left",
            color: C.textMuted, fontSize: 14, marginBottom: 8,
            cursor: "pointer", display: "block", boxSizing: "border-box",
          }}>From — Select stop</button>
          <button onClick={() => setTab("search")} style={{
            width: "100%", background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 10, padding: "11px 14px", textAlign: "left",
            color: C.textMuted, fontSize: 14, marginBottom: 12,
            cursor: "pointer", display: "block", boxSizing: "border-box",
          }}>To — Select stop</button>
          <button onClick={() => setTab("search")} style={{
            width: "100%", background: C.orange, border: "none", borderRadius: 10,
            padding: "12px", color: "white", fontSize: 15, fontWeight: 700, cursor: "pointer",
          }}>Search for Bus</button>
        </Card>

        <SectionLabel>FEATURES</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {[
            { title: "Realtime Map",        desc: "Animated bus positions",       bg: C.orangeLight, tc: C.orangeDark },
            { title: "ML ETA",              desc: "Learns from route history",    bg: C.greenBg,     tc: C.green      },
            { title: "Adaptive Polling",    desc: "Auto-rates by signal quality", bg: C.blueBg,      tc: C.blue       },
            { title: "Offline Buffer",      desc: "Syncs on reconnect",           bg: C.purpleBg,    tc: C.purple     },
          ].map(f => (
            <div key={f.title} style={{ background: f.bg, borderRadius: 12, padding: "14px 12px" }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: f.tc, marginBottom: 4 }}>{f.title}</div>
              <div style={{ fontSize: 11, color: C.textSub }}>{f.desc}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button onClick={() => setTab("track")} style={{
            background: C.white, border: `1.5px solid ${C.orange}`, borderRadius: 12,
            padding: "14px 10px", color: C.orange, fontWeight: 700, fontSize: 14, cursor: "pointer",
          }}>Live Track</button>
          <button onClick={() => setTab("account")} style={{
            background: C.white, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: "14px 10px", color: C.text, fontWeight: 600, fontSize: 14, cursor: "pointer",
          }}>Driver Portal</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACCOUNT PAGE
// ═══════════════════════════════════════════════════════════════════════════
function AccountPage({ setShowDriver }) {
  return (
    <div>
      <div style={{ background: C.orange, padding: "20px 20px 28px" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "white" }}>My Account</div>
      </div>
      <div style={{ padding: 16 }}>
        <Card style={{ textAlign: "center", padding: "28px 20px", marginBottom: 14 }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: C.bg,
            margin: "0 auto 14px", display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 20, color: C.textMuted, fontWeight: 700 }}>P</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>Passenger</div>
          <div style={{ fontSize: 13, color: C.textSub }}>No tickets booked yet</div>
        </Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {[{ label: "Upcoming", value: "0" }, { label: "Completed", value: "0" }].map(s => (
            <Card key={s.label} style={{ textAlign: "center", padding: "16px 10px" }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>{s.value}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{s.label}</div>
            </Card>
          ))}
        </div>
        <button onClick={() => setShowDriver(true)} style={{
          width: "100%", background: C.white, border: `1.5px solid ${C.orange}`,
          borderRadius: 12, padding: "14px", color: C.orange,
          fontSize: 15, fontWeight: 700, cursor: "pointer",
        }}>Driver Portal</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  NAV BAR
// ═══════════════════════════════════════════════════════════════════════════
function NavBar({ active, setActive }) {
  const tabs = [
    { id: "home",    label: "Home"    },
    { id: "search",  label: "Search"  },
    { id: "track",   label: "Track"   },
    { id: "account", label: "Account" },
  ];
  return (
    <div style={{
      position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
      width: "100%", maxWidth: 430, background: C.white,
      borderTop: `1px solid ${C.border}`, display: "flex",
      zIndex: 200, paddingBottom: "env(safe-area-inset-bottom,0)",
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setActive(t.id)} style={{
          flex: 1, padding: "10px 4px 8px", border: "none", background: "none",
          cursor: "pointer", display: "flex", flexDirection: "column",
          alignItems: "center", gap: 3, position: "relative",
        }}>
          {active === t.id && (
            <div style={{
              position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
              width: 28, height: 3, background: C.orange, borderRadius: "0 0 4px 4px",
            }} />
          )}
          <div style={{
            width: 34, height: 34, borderRadius: 9,
            background: active === t.id ? C.orangeLight : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ fontSize: 13, fontWeight: 700,
              color: active === t.id ? C.orange : C.textMuted }}>
              {t.label[0]}
            </span>
          </div>
          <span style={{ fontSize: 10, fontWeight: 600,
            color: active === t.id ? C.orange : C.textMuted }}>
            {t.label}
          </span>
        </button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROOT
// ═══════════════════════════════════════════════════════════════════════════
export default function ChaloApp() {
  const [tab, setTab]         = useState("home");
  const [showDriver, setDriver] = useState(false);

  if (showDriver) return (
    <div style={{ maxWidth: 430, margin: "0 auto",
      fontFamily: "'Inter','Segoe UI',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <style>{globalStyles}</style>
      <DriverScreen onBack={() => setDriver(false)} />
    </div>
  );

  const screens = {
    home:    <HomePage setTab={setTab} />,
    search:  <LeafletLoader><SearchPage /></LeafletLoader>,
    track:   <LeafletLoader><TrackPage /></LeafletLoader>,
    account: <AccountPage setShowDriver={setDriver} />,
  };

  return (
    <div style={{
      maxWidth: 430, margin: "0 auto", minHeight: "100vh",
      background: C.bg, fontFamily: "'Inter','Segoe UI',sans-serif",
      position: "relative", paddingBottom: 72,
      boxShadow: "0 0 0 1px rgba(0,0,0,0.05)",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <style>{globalStyles}</style>
      {screens[tab]}
      <NavBar active={tab} setActive={setTab} />
    </div>
  );
}

const globalStyles = `
  * { box-sizing: border-box; }
  select option { color: #111827; }
  @keyframes livePulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.4; transform: scale(0.85); }
  }
`;
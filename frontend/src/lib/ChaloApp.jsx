import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONFIG ────────────────────────────────────────────────────────────────
const API_BASE = "http://127.0.0.1:5000";
const ORANGE = "#F97316";
const ORANGE_LIGHT = "#FFF7ED";

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 ─ ADAPTIVE POLLING
// Automatically adjusts the fetch interval based on network quality.
// good → 5s, low → 15s, offline → 30s
// ══════════════════════════════════════════════════════════════════════════════
function useAdaptivePolling(fetchFn, networkQuality) {
  const intervalRef = useRef(null);
  const intervalMs =
    networkQuality === "good" ? 5000
    : networkQuality === "low" ? 15000
    : 30000;

  useEffect(() => {
    fetchFn();
    intervalRef.current = setInterval(fetchFn, intervalMs);
    return () => clearInterval(intervalRef.current);
  }, [fetchFn, intervalMs]);

  return intervalMs;
}

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 ─ STORE-AND-FORWARD BUFFER
// Queues GPS pings when offline and bulk-uploads when signal returns.
// ══════════════════════════════════════════════════════════════════════════════
class LocationBuffer {
  constructor() {
    this.buffer = [];
    this.driverId = null;
    this.flushing = false;
  }
  push(driverId, lat, lon, network) {
    this.driverId = driverId;
    this.buffer.push({ lat, lon, network, timestamp: Math.floor(Date.now() / 1000) });
  }
  async flush() {
    if (this.flushing || this.buffer.length === 0 || !this.driverId) return;
    this.flushing = true;
    const points = [...this.buffer];
    try {
      await fetch(`${API_BASE}/bulk-update-location`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver_id: this.driverId, points }),
      });
      this.buffer = this.buffer.slice(points.length);
    } catch {}
    this.flushing = false;
  }
  size() { return this.buffer.length; }
}
const locationBuffer = new LocationBuffer();

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 3 ─ ML-BASED ETA PREDICTION (client-side linear regression)
// Trains on (distance, speed) → actual_seconds from server responses.
// Falls back to distance/speed formula until enough samples are collected.
// ══════════════════════════════════════════════════════════════════════════════
class ETAPredictor {
  constructor() {
    this.history = [];
    this.weights = { distCoef: 120, speedCoef: -0.5, bias: 60 };
  }
  addSample(distKm, speedKmh, actualSecs) {
    if (!distKm || !speedKmh || !actualSecs) return;
    this.history.push({ distKm, speedKmh, actualSecs });
    if (this.history.length > 20) this.history.shift();
    if (this.history.length >= 3) this._train();
  }
  _train() {
    let { distCoef: wD, speedCoef: wS, bias: b } = this.weights;
    const lr = 0.00005;
    for (let iter = 0; iter < 80; iter++) {
      let dD = 0, dS = 0, dB = 0;
      for (const { distKm, speedKmh, actualSecs } of this.history) {
        const err = (wD * distKm + wS * speedKmh + b) - actualSecs;
        dD += err * distKm; dS += err * speedKmh; dB += err;
      }
      const n = this.history.length;
      wD -= lr * dD / n; wS -= lr * dS / n; b -= lr * dB / n;
    }
    this.weights = { distCoef: wD, speedCoef: wS, bias: b };
  }
  predict(distKm, speedKmh) {
    if (!distKm || distKm <= 0) return null;
    const sp = speedKmh > 0 ? speedKmh : 30;
    if (this.history.length < 3) return Math.round((distKm / sp) * 3600);
    const { distCoef, speedCoef, bias } = this.weights;
    return Math.max(30, Math.round(distCoef * distKm + speedCoef * sp + bias));
  }
}
const etaPredictor = new ETAPredictor();

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 4 ─ PREDICTIVE SMOOTHING / INTERPOLATION
// Animates bus icon smoothly between sparse GPS pings using rAF.
// ══════════════════════════════════════════════════════════════════════════════
function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
function useSmoothPosition(rawPos, intervalMs) {
  const [smoothPos, setSmoothPos] = useState(rawPos);
  const prevRef = useRef(rawPos);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (!rawPos) return;
    prevRef.current = smoothPos || rawPos;
    startRef.current = Date.now();
  }, [rawPos?.lat, rawPos?.lon]);

  useEffect(() => {
    if (!rawPos) return;
    let raf;
    const tick = () => {
      const alpha = Math.min((Date.now() - startRef.current) / Math.max(intervalMs, 1000), 1);
      setSmoothPos(lerp(prevRef.current || rawPos, rawPos, alpha));
      if (alpha < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rawPos?.lat, rawPos?.lon, intervalMs]);

  return smoothPos || rawPos;
}

// ─── API LAYER ────────────────────────────────────────────────────────────
const api = {
  getStations: () => fetch(`${API_BASE}/stations`).then(r => r.json()),
  getBusesByRoute: (src, dst) =>
    fetch(`${API_BASE}/buses-by-route`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: src, destination: dst }),
    }).then(r => r.json()),
  getBusLocation: id => fetch(`${API_BASE}/get-bus-location/${id}`).then(r => r.json()),
  getETA: (id, dLat, dLon) =>
    fetch(`${API_BASE}/get-eta/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dest_lat: dLat, dest_lon: dLon }),
    }).then(r => r.json()),
  getAllBuses: () => fetch(`${API_BASE}/buses`).then(r => r.json()),
  trackBus: no => fetch(`${API_BASE}/bus/${no}`).then(r => r.json()),
  getNetworkStatus: id => fetch(`${API_BASE}/network-status/${id}`).then(r => r.json()),
  updateLocation: (id, lat, lon, net) =>
    fetch(`${API_BASE}/update-location`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ driver_id: id, lat, lon, network: net }),
    }).then(r => r.json()),
  driverLogin: (bus, drv, plate) =>
    fetch(`${API_BASE}/driver/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bus_no: bus, driver_no: drv, plate_no: plate }),
    }).then(r => r.json()),
};

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────
function NetworkBadge({ quality, pollMs }) {
  const map = {
    good:    { bg: "#F0FDF4", color: "#16A34A", dot: "#22C55E", label: "Good" },
    low:     { bg: "#FFFBEB", color: "#D97706", dot: "#F59E0B", label: "Low signal" },
    offline: { bg: "#FEF2F2", color: "#DC2626", dot: "#EF4444", label: "Offline" },
  };
  const c = map[quality] || { bg: "#F3F4F6", color: "#6B7280", dot: "#9CA3AF", label: "—" };
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, background:c.bg, borderRadius:20, padding:"3px 9px" }}>
      <span style={{
        width:7, height:7, borderRadius:"50%", background:c.dot, display:"inline-block",
        animation: quality === "good" ? "pulse 2s infinite" : "none"
      }} />
      <span style={{ fontSize:11, fontWeight:600, color:c.color }}>
        {c.label} · {Math.round((pollMs||5000)/1000)}s
      </span>
    </span>
  );
}

// ─── LEAFLET MAP ──────────────────────────────────────────────────────────
function BusMap({ buses = [], height = 260 }) {
  const mapRef   = useRef(null);
  const mapInst  = useRef(null);
  const markers  = useRef({});
  const pathLine = useRef(null);

  useEffect(() => {
    if (mapInst.current || !window.L) return;
    mapInst.current = window.L.map(mapRef.current, { zoomControl:true })
      .setView([10.7905, 78.7047], 13);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:"© OpenStreetMap", maxZoom:18
    }).addTo(mapInst.current);
  }, []);

  useEffect(() => {
    const L = window.L; const map = mapInst.current;
    if (!L || !map) return;
    const icon = L.divIcon({
      html:`<div style="background:${ORANGE};border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.25);font-size:15px">🚌</div>`,
      className:"", iconSize:[30,30], iconAnchor:[15,15]
    });
    buses.forEach(b => {
      const loc = b.smoothPos || b.current_location;
      if (!loc?.lat) return;
      if (markers.current[b.driver_id]) {
        markers.current[b.driver_id].setLatLng([loc.lat, loc.lon]);
      } else {
        markers.current[b.driver_id] = L.marker([loc.lat,loc.lon],{icon})
          .addTo(map).bindPopup(`<b>${b.bus_no||b.driver_id}</b>`);
      }
    });
    const first = buses[0];
    if (first) {
      const loc = first.smoothPos || first.current_location;
      if (loc?.lat) map.setView([loc.lat,loc.lon],14);
    }
  }, [buses]);

  return (
    <div style={{ position:"relative", borderRadius:14, overflow:"hidden", border:"0.5px solid #E5E7EB" }}>
      <div ref={mapRef} style={{ height, zIndex:1 }} />
      <div style={{ position:"absolute", top:8, right:8, zIndex:10,
        background:"white", borderRadius:8, padding:"3px 8px",
        fontSize:11, color:"#6B7280", border:"0.5px solid #E5E7EB" }}>
        {buses.length} live
      </div>
    </div>
  );
}

function LeafletLoader({ children }) {
  const [ready, setReady] = useState(!!window.L);
  useEffect(() => {
    if (window.L) { setReady(true); return; }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);
  if (!ready) return (
    <div style={{ height:260, background:"#F9FAFB", borderRadius:14,
      display:"flex", alignItems:"center", justifyContent:"center",
      color:"#9CA3AF", fontSize:13 }}>Loading map…</div>
  );
  return children;
}

// ─── SEARCH PAGE ──────────────────────────────────────────────────────────
function SearchPage() {
  const [stations, setStations] = useState([]);
  const [from, setFrom]         = useState("");
  const [to, setTo]             = useState("");
  const [results, setResults]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [netQ, setNetQ]         = useState("good");
  const [etaMap, setEtaMap]     = useState({});
  const [livePos, setLivePos]   = useState({});
  const pollMs = netQ === "good" ? 5000 : netQ === "low" ? 15000 : 30000;

  useEffect(() => {
    api.getStations().then(setStations).catch(() =>
      setStations(["Chatram Bus Stand","Central Bus Stand","BHEL Township","Thuvakudi","NIT Trichy"])
    );
  }, []);

  // FEATURE 1 + 3 + 5 — adaptive polling + ML ETA + sparse-update handling
  const poll = useCallback(async () => {
    if (!results?.length) return;
    for (const bus of results) {
      try {
        const [loc, ns] = await Promise.all([
          api.getBusLocation(bus.driver_id),
          api.getNetworkStatus(bus.driver_id),
        ]);
        const q = ns.network || "unknown";
        setNetQ(q);
        const cur = loc.current;
        if (cur) {
          setLivePos(prev => ({ ...prev, [bus.driver_id]: { current: cur, history: loc.history||[] } }));
        }
        // ETA
        const etaRes = await api.getETA(bus.driver_id, 10.7606, 78.8151).catch(() => null);
        if (etaRes) {
          etaPredictor.addSample(etaRes.remaining_distance_km, etaRes.avg_speed_kmph, etaRes.eta_seconds);
          const mlSecs = etaPredictor.predict(etaRes.remaining_distance_km, etaRes.avg_speed_kmph);
          setEtaMap(prev => ({ ...prev, [bus.driver_id]: { server: etaRes, mlSecs } }));
        }
      } catch { setNetQ("offline"); }
    }
  }, [results]);

  useAdaptivePolling(poll, netQ);

  const search = async () => {
    if (!from || !to) return;
    setLoading(true); setResults(null); setEtaMap({}); setLivePos({});
    try { setResults(await api.getBusesByRoute(from, to) || []); }
    catch { setResults([]); }
    setLoading(false);
  };

  const mapBuses = (results || []).map(b => ({
    ...b,
    current_location: livePos[b.driver_id]?.current || b.current_location,
  }));

  return (
    <div>
      {/* Header */}
      <div style={{ background:ORANGE_LIGHT, padding:"20px 16px 20px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <h2 style={{ margin:0, fontSize:20, fontWeight:700, color:"#111" }}>Find Your Bus</h2>
          <NetworkBadge quality={netQ} pollMs={pollMs} />
        </div>
        <div style={{ background:"white", borderRadius:16, padding:14, border:"0.5px solid #E5E7EB", position:"relative" }}>
          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:11, color:"#9CA3AF", fontWeight:600, marginBottom:4 }}>FROM</div>
            <select value={from} onChange={e=>setFrom(e.target.value)} style={{
              width:"100%", padding:"10px 12px", borderRadius:10,
              border:"0.5px solid #E5E7EB", fontSize:14, background:"#F9FAFB", appearance:"none"
            }}>
              <option value="">Select departure</option>
              {stations.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button onClick={()=>{setFrom(to);setTo(from);}} style={{
            position:"absolute", right:26, top:"50%", transform:"translateY(-50%)",
            background:"white", border:`1.5px solid ${ORANGE}`, borderRadius:"50%",
            width:30, height:30, cursor:"pointer", fontSize:15, zIndex:2,
            display:"flex", alignItems:"center", justifyContent:"center"
          }}>⇅</button>
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:"#9CA3AF", fontWeight:600, marginBottom:4 }}>TO</div>
            <select value={to} onChange={e=>setTo(e.target.value)} style={{
              width:"100%", padding:"10px 12px", borderRadius:10,
              border:"0.5px solid #E5E7EB", fontSize:14, background:"#F9FAFB", appearance:"none"
            }}>
              <option value="">Select destination</option>
              {stations.filter(s=>s!==from).map(s=><option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button onClick={search} disabled={!from||!to||loading} style={{
            width:"100%", background:(!from||!to)?"#E5E7EB":ORANGE, border:"none",
            borderRadius:10, padding:12, color:(!from||!to)?"#9CA3AF":"white",
            fontSize:15, fontWeight:600, cursor:(!from||!to)?"not-allowed":"pointer"
          }}>
            {loading ? "Searching…" : "Search for bus"}
          </button>
        </div>
      </div>

      <div style={{ padding:16 }}>
        {/* Live map */}
        {mapBuses.length > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#6B7280", marginBottom:8 }}>LIVE MAP</div>
            <BusMap buses={mapBuses} />
          </div>
        )}

        {loading && <div style={{ textAlign:"center", padding:"40px 0", color:"#6B7280", fontSize:14 }}>Searching routes…</div>}

        {results?.length === 0 && (
          <div style={{ textAlign:"center", padding:"40px 0", color:"#9CA3AF" }}>
            <div style={{ fontSize:40, marginBottom:12 }}>😔</div>
            <div style={{ fontSize:14 }}>No buses on this route</div>
          </div>
        )}

        {results?.map((bus, i) => {
          const eta    = etaMap[bus.driver_id];
          const loc    = livePos[bus.driver_id]?.current || bus.current_location;
          const mlMins = eta?.mlSecs ? Math.round(eta.mlSecs/60) : null;
          const srvMins= eta?.server?.eta_seconds ? Math.round(eta.server.eta_seconds/60) : null;
          const dist   = eta?.server?.remaining_distance_km;
          const speed  = eta?.server?.avg_speed_kmph;
          return (
            <BusCard key={i}
              bus={bus} loc={loc} hasLive={!!livePos[bus.driver_id]}
              mlMins={mlMins} srvMins={srvMins} dist={dist} speed={speed}
              pollMs={pollMs} histLen={livePos[bus.driver_id]?.history?.length||0}
            />
          );
        })}

        {results?.length > 0 && <MLCard predictor={etaPredictor} />}
      </div>
    </div>
  );
}

// ─── BUS RESULT CARD (with smooth interpolation display) ──────────────────
function BusCard({ bus, loc, hasLive, mlMins, srvMins, dist, speed, pollMs, histLen }) {
  const raw    = loc ? { lat: loc.lat, lon: loc.lon } : null;
  const smooth = useSmoothPosition(raw, pollMs);
  const isInterp = smooth && raw && (Math.abs(smooth.lat - raw.lat) > 0.000001 || Math.abs(smooth.lon - raw.lon) > 0.000001);

  return (
    <div style={{ background:"white", borderRadius:16, padding:16, border:"0.5px solid #E5E7EB", marginBottom:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
        <div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:6 }}>
            <span style={{ background:ORANGE+"20", color:ORANGE, fontWeight:700, fontSize:13, padding:"3px 10px", borderRadius:8 }}>
              {bus.bus_no}
            </span>
            <span style={{ background:"#F0FDF4", color:"#16A34A", fontSize:11, padding:"3px 8px", borderRadius:8 }}>
              Route {bus.route}
            </span>
            {hasLive && <span style={{ background:"#FEF2F2", color:"#DC2626", fontSize:10, padding:"3px 7px", borderRadius:6 }}>● LIVE</span>}
          </div>
          <div style={{ fontSize:12, color:"#6B7280" }}>
            📍 {smooth ? `${smooth.lat.toFixed(5)}, ${smooth.lon.toFixed(5)}` : "—"}
            {isInterp && <span style={{ color:ORANGE, marginLeft:4, fontSize:10 }}>~ smooth</span>}
          </div>
        </div>
        {/* ETA */}
        <div style={{ textAlign:"right", minWidth:60 }}>
          {mlMins !== null ? (
            <>
              <div style={{ fontSize:26, fontWeight:800, color:ORANGE, lineHeight:1 }}>{mlMins}</div>
              <div style={{ fontSize:10, color:"#9CA3AF" }}>min (ML)</div>
            </>
          ) : srvMins !== null ? (
            <>
              <div style={{ fontSize:26, fontWeight:800, color:"#6B7280", lineHeight:1 }}>{srvMins}</div>
              <div style={{ fontSize:10, color:"#9CA3AF" }}>min away</div>
            </>
          ) : (
            <div style={{ fontSize:12, color:"#9CA3AF" }}>ETA…</div>
          )}
        </div>
      </div>

      {/* Stats */}
      {(dist || speed) && (
        <div style={{ display:"flex", gap:16, paddingTop:10, borderTop:"0.5px solid #F3F4F6" }}>
          {dist != null && (
            <div style={{ fontSize:12, color:"#6B7280" }}>
              <b style={{ color:"#111", fontSize:14 }}>{Number(dist).toFixed(1)} km</b> remaining
            </div>
          )}
          {speed > 0 && (
            <div style={{ fontSize:12, color:"#6B7280" }}>
              <b style={{ color:"#111", fontSize:14 }}>{Math.round(speed)} km/h</b> avg
            </div>
          )}
          {histLen > 0 && (
            <div style={{ fontSize:12, color:"#6B7280" }}>
              <b style={{ color:"#111", fontSize:14 }}>{histLen}</b> pings
            </div>
          )}
        </div>
      )}

      {/* ML vs server discrepancy note */}
      {mlMins !== null && srvMins !== null && Math.abs(mlMins - srvMins) > 1 && (
        <div style={{ marginTop:10, background:"#FFF7ED", borderRadius:8, padding:"8px 10px", fontSize:11, color:"#92400E" }}>
          ⚡ ML: <b>{mlMins} min</b> · Server: <b>{srvMins} min</b>
          {mlMins < srvMins ? " — historically faster" : " — may be slower today"}
        </div>
      )}
    </div>
  );
}

// ─── ML MODEL INFO CARD ───────────────────────────────────────────────────
function MLCard({ predictor }) {
  const { distCoef=0, speedCoef=0, bias=0 } = predictor.weights;
  return (
    <div style={{ background:"#F0F9FF", border:"0.5px solid #BAE6FD", borderRadius:14, padding:14, marginTop:4 }}>
      <div style={{ fontSize:12, fontWeight:700, color:"#0369A1", marginBottom:10 }}>
        🤖 On-Device ML ETA Model
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        {[
          { label:"Training samples", value: predictor.history.length },
          { label:"Dist coeff",       value: Number(distCoef).toFixed(2) },
          { label:"Speed coeff",      value: Number(speedCoef).toFixed(2) },
          { label:"Bias (sec)",       value: Math.round(bias) },
        ].map(s => (
          <div key={s.label} style={{ background:"white", borderRadius:8, padding:"8px 10px", border:"0.5px solid #BAE6FD" }}>
            <div style={{ fontSize:10, color:"#6B7280", marginBottom:2 }}>{s.label}</div>
            <div style={{ fontWeight:700, fontSize:16, color:"#0C4A6E" }}>{s.value}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize:10, color:"#6B7280", marginTop:8 }}>
        Trains in-session via gradient descent. Improves with each GPS ping received.
      </div>
    </div>
  );
}

// ─── TRACK PAGE ───────────────────────────────────────────────────────────
function TrackPage() {
  const [busNo, setBusNo]     = useState("");
  const [busData, setBusData] = useState(null);
  const [allBuses, setAll]    = useState([]);
  const [netQ, setNetQ]       = useState("good");
  const [bufCount, setBufCount] = useState(0);
  const [history, setHistory] = useState({});
  const pollMs = netQ === "good" ? 5000 : netQ === "low" ? 15000 : 30000;

  useEffect(() => { api.getAllBuses().then(b => setAll(b||[])).catch(()=>{}); }, []);

  const poll = useCallback(async () => {
    try {
      const buses = await api.getAllBuses();
      setAll(buses||[]);
      if (buses?.[0]) {
        const ns = await api.getNetworkStatus(buses[0].driver_id).catch(()=>({}));
        const q = ns.network || "unknown";
        setNetQ(q);
        if (q === "good") { await locationBuffer.flush(); setBufCount(locationBuffer.size()); }
      }
    } catch { setNetQ("offline"); }
  }, []);

  useAdaptivePolling(poll, netQ);

  const track = async () => {
    if (!busNo.trim()) return;
    try {
      const data = await api.trackBus(busNo.trim());
      setBusData(data||[]);
      for (const b of data||[]) {
        const loc = await api.getBusLocation(b.driver_id).catch(()=>null);
        if (loc?.history) setHistory(prev=>({...prev,[b.driver_id]:loc.history}));
      }
    } catch { setBusData([]); }
  };

  const mapBuses = allBuses.map(b=>({
    driver_id: b.driver_id, bus_no: b.driver_id,
    current_location: { lat:b.lat, lon:b.lon }
  }));

  return (
    <div>
      <div style={{ background:ORANGE_LIGHT, padding:"20px 16px 16px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <h2 style={{ margin:0, fontSize:20, fontWeight:700, color:"#111" }}>Live Tracker</h2>
          <NetworkBadge quality={netQ} pollMs={pollMs} />
        </div>

        {/* FEATURE 2 — buffer banner */}
        {bufCount > 0 && (
          <div style={{ background:"#FFFBEB", border:"0.5px solid #FCD34D", borderRadius:10,
            padding:"10px 12px", marginBottom:12, display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:20 }}>📦</span>
            <div>
              <div style={{ fontWeight:600, fontSize:13, color:"#92400E" }}>
                {bufCount} location{bufCount>1?"s":""} buffered
              </div>
              <div style={{ fontSize:11, color:"#B45309" }}>Will sync when signal returns</div>
            </div>
          </div>
        )}

        <div style={{ display:"flex", gap:8 }}>
          <input value={busNo} onChange={e=>setBusNo(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&track()}
            placeholder="Bus number e.g. TN45B1010"
            style={{ flex:1, padding:"11px 13px", borderRadius:10,
              border:"0.5px solid #E5E7EB", fontSize:14, background:"white" }}
          />
          <button onClick={track} style={{
            background:ORANGE, border:"none", borderRadius:10,
            padding:"11px 18px", color:"white", fontWeight:600, fontSize:14, cursor:"pointer"
          }}>Track</button>
        </div>
      </div>

      <div style={{ padding:16 }}>
        {/* FEATURE 1 — adaptive poll info */}
        <div style={{ background:"white", border:"0.5px solid #E5E7EB", borderRadius:12,
          padding:"12px 14px", marginBottom:14, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:"#374151", marginBottom:2 }}>
              Adaptive Polling Active
            </div>
            <div style={{ fontSize:11, color:"#9CA3AF" }}>Auto-adjusts rate to network quality</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontWeight:800, fontSize:22, color:ORANGE }}>{Math.round(pollMs/1000)}s</div>
            <div style={{ fontSize:10, color:"#9CA3AF" }}>interval</div>
          </div>
        </div>

        {/* Live map — all buses */}
        {mapBuses.length > 0 && (
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#6B7280", marginBottom:8 }}>ALL ACTIVE BUSES</div>
            <BusMap buses={mapBuses} height={220} />
          </div>
        )}

        {/* Tracked bus detail */}
        {busData?.map((bus,i) => {
          const hist = history[bus.driver_id]||[];
          return (
            <div key={i} style={{ background:"white", borderRadius:16, padding:16,
              border:"0.5px solid #E5E7EB", marginBottom:12 }}>
              <div style={{ fontWeight:700, fontSize:17, color:"#111" }}>{bus.bus_no}</div>
              <div style={{ fontSize:12, color:"#6B7280", marginBottom:10 }}>{bus.driver_id}</div>
              <div style={{ background:"#F9FAFB", borderRadius:10, padding:"10px 12px", marginBottom:10 }}>
                <div style={{ fontSize:10, fontWeight:600, color:"#9CA3AF", marginBottom:4 }}>POSITION</div>
                <div style={{ fontSize:14, color:"#111" }}>
                  {bus.current_location?.lat?.toFixed(6)}, {bus.current_location?.lon?.toFixed(6)}
                </div>
              </div>
              {hist.length > 0 && (
                <div>
                  <div style={{ fontSize:10, fontWeight:600, color:"#9CA3AF", marginBottom:6 }}>
                    HISTORY — {hist.length} pings (last 5)
                  </div>
                  {hist.slice(-5).reverse().map((h,j) => (
                    <div key={j} style={{ display:"flex", justifyContent:"space-between",
                      padding:"5px 0", borderBottom:"0.5px solid #F3F4F6", fontSize:11 }}>
                      <span style={{ color:"#6B7280" }}>{h.lat?.toFixed(4)}, {h.lon?.toFixed(4)}</span>
                      <span style={{ color: h.network==="good"?"#16A34A":"#D97706", fontWeight:600 }}>
                        {h.network||"—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {busData?.length===0 && (
          <div style={{ textAlign:"center", padding:"30px 0", color:"#9CA3AF" }}>
            <div style={{ fontSize:36, marginBottom:8 }}>🔍</div>
            <div style={{ fontSize:14 }}>Bus not found</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DRIVER PAGE ──────────────────────────────────────────────────────────
function DriverPage() {
  const [form, setForm]           = useState({ busNo:"", driverNo:"", plateNo:"" });
  const [loginResult, setLogin]   = useState(null);
  const [loginError, setErr]      = useState("");
  const [isLoggedIn, setLoggedIn] = useState(false);
  const [netQ, setNetQ]           = useState("good");
  const [bufCount, setBufCount]   = useState(0);
  const [lastSent, setLastSent]   = useState(null);
  const [sending, setSending]     = useState(false);
  const loopRef = useRef(null);

  const handleLogin = async () => {
    setErr("");
    try {
      const res = await api.driverLogin(form.busNo, form.driverNo, form.plateNo);
      setLogin(res);
      setLoggedIn(true);
      locationBuffer.driverId = res.driver_id;
    } catch { setErr("Login failed. Check your credentials."); }
  };

  // FEATURE 1+2 — adaptive send + store-and-forward
  useEffect(() => {
    if (!isLoggedIn || !loginResult?.driver_id) return;
    const id = loginResult.driver_id;
    let lat = 10.7905, lon = 78.7047;

    const sendInterval = netQ === "good" ? 4000 : netQ === "low" ? 12000 : 20000;
    loopRef.current = setInterval(async () => {
      lat += (Math.random()-.5)*.002;
      lon += (Math.random()-.5)*.002;
      setSending(true);
      if (netQ === "offline") {
        locationBuffer.push(id, lat, lon, netQ);
        setBufCount(locationBuffer.size());
      } else {
        try {
          await api.updateLocation(id, lat, lon, netQ);
          setLastSent({ lat, lon, time: new Date().toLocaleTimeString() });
          if (locationBuffer.size()>0) { await locationBuffer.flush(); setBufCount(locationBuffer.size()); }
        } catch {
          locationBuffer.push(id, lat, lon, "low");
          setBufCount(locationBuffer.size());
          setNetQ("offline");
        }
      }
      setSending(false);
    }, sendInterval);

    return () => clearInterval(loopRef.current);
  }, [isLoggedIn, loginResult, netQ]);

  return !isLoggedIn ? (
    <div style={{ background:"white", borderRadius:16, padding:16, border:"0.5px solid #E5E7EB" }}>
      <h3 style={{ margin:"0 0 14px", fontSize:16, fontWeight:600 }}>Driver Login</h3>
      {[
        { key:"busNo",    label:"BUS NUMBER",   ph:"TN45B1010" },
        { key:"driverNo", label:"DRIVER ID",    ph:"D1" },
        { key:"plateNo",  label:"PLATE NUMBER", ph:"TN45B1010" },
      ].map(f=>(
        <div key={f.key} style={{ marginBottom:12 }}>
          <div style={{ fontSize:11, color:"#6B7280", fontWeight:600, marginBottom:4 }}>{f.label}</div>
          <input value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))}
            placeholder={f.ph}
            style={{ width:"100%", padding:"10px 12px", borderRadius:10,
              border:"0.5px solid #E5E7EB", fontSize:14, boxSizing:"border-box" }}
          />
        </div>
      ))}
      {loginError && <div style={{ color:"#DC2626", fontSize:13, marginBottom:10 }}>{loginError}</div>}
      <button onClick={handleLogin} style={{
        width:"100%", background:ORANGE, border:"none", borderRadius:10,
        padding:12, color:"white", fontSize:15, fontWeight:600, cursor:"pointer"
      }}>Login as Driver</button>
    </div>
  ) : (
    <div>
      <div style={{ background:"#F0FDF4", border:"0.5px solid #BBF7D0", borderRadius:14, padding:14, marginBottom:14 }}>
        <div style={{ fontWeight:700, color:"#16A34A", fontSize:15 }}>✅ {loginResult?.driver_id}</div>
      </div>

      {/* Network simulator */}
      <div style={{ background:"white", border:"0.5px solid #E5E7EB", borderRadius:14, padding:14, marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#374151", marginBottom:10 }}>SIMULATE NETWORK</div>
        <div style={{ display:"flex", gap:8 }}>
          {["good","low","offline"].map(q=>(
            <button key={q} onClick={()=>setNetQ(q)} style={{
              flex:1, padding:"9px 4px", border:"none", borderRadius:8, cursor:"pointer",
              background: netQ===q ? ORANGE : "#F3F4F6",
              color: netQ===q ? "white" : "#374151",
              fontSize:12, fontWeight:600
            }}>
              {q==="good"?"📶 Good":q==="low"?"📉 Low":"❌ Offline"}
            </button>
          ))}
        </div>
      </div>

      {/* Buffer */}
      <div style={{ background: bufCount>0?"#FFFBEB":"#F9FAFB",
        border:`0.5px solid ${bufCount>0?"#FCD34D":"#E5E7EB"}`,
        borderRadius:14, padding:14, marginBottom:14 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:"#374151" }}>📦 Store-and-Forward Buffer</div>
            <div style={{ fontSize:11, color:"#9CA3AF", marginTop:2 }}>
              {bufCount===0 ? "All pings sent" : `${bufCount} ping${bufCount>1?"s":""} queued`}
            </div>
          </div>
          <div style={{ fontWeight:800, fontSize:26, color:bufCount>0?"#D97706":"#16A34A" }}>{bufCount}</div>
        </div>
      </div>

      {/* Status */}
      <div style={{ background:"white", border:"0.5px solid #E5E7EB", borderRadius:14, padding:14, marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#374151", marginBottom:8 }}>BROADCAST STATUS</div>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
          <span style={{ width:8, height:8, borderRadius:"50%", display:"inline-block",
            background: sending ? ORANGE : netQ==="offline" ? "#EF4444" : "#22C55E",
            animation: sending ? "pulse 1s infinite" : "none" }} />
          <span style={{ fontSize:13 }}>
            {sending ? "Sending…" : netQ==="offline" ? "Buffering (no signal)" : "Standby"}
          </span>
          <NetworkBadge quality={netQ} pollMs={netQ==="good"?4000:12000} />
        </div>
        {lastSent && (
          <div style={{ fontSize:11, color:"#9CA3AF" }}>
            Last: {lastSent.lat.toFixed(5)}, {lastSent.lon.toFixed(5)} · {lastSent.time}
          </div>
        )}
      </div>

      <button onClick={()=>{setLoggedIn(false);setLogin(null);clearInterval(loopRef.current);}} style={{
        width:"100%", background:"white", border:`0.5px solid ${ORANGE}`,
        borderRadius:10, padding:12, color:ORANGE, fontSize:14, fontWeight:600, cursor:"pointer"
      }}>Logout</button>
    </div>
  );
}

// ─── TICKETS/ACCOUNT PAGE ─────────────────────────────────────────────────
function TicketsPage() {
  const [view, setView] = useState("user");
  return (
    <div>
      <div style={{ background:ORANGE_LIGHT, padding:"20px 16px 24px" }}>
        <h2 style={{ margin:"0 0 14px", fontSize:20, fontWeight:700, color:"#111" }}>My Account</h2>
        <div style={{ display:"flex", background:"white", borderRadius:12, padding:4, gap:4 }}>
          {["user","driver"].map(v=>(
            <button key={v} onClick={()=>setView(v)} style={{
              flex:1, padding:9, border:"none", borderRadius:9, cursor:"pointer",
              background: view===v ? ORANGE : "transparent",
              color: view===v ? "white" : "#6B7280",
              fontSize:13, fontWeight:600
            }}>
              {v==="user" ? "👤 Passenger" : "🚌 Driver"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding:16 }}>
        {view==="user" ? (
          <div style={{ textAlign:"center", padding:"30px 0" }}>
            <div style={{ fontSize:56, marginBottom:12 }}>🎫</div>
            <div style={{ fontWeight:700, fontSize:17, color:"#111", marginBottom:6 }}>No tickets yet</div>
            <div style={{ fontSize:13, color:"#6B7280" }}>Book a ride to see tickets here</div>
          </div>
        ) : <DriverPage />}
      </div>
    </div>
  );
}

// ─── HOME PAGE ────────────────────────────────────────────────────────────
function HomePage({ setActiveTab }) {
  return (
    <div>
      <div style={{ background:ORANGE_LIGHT, padding:"20px 16px 0" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div>
            <div style={{ display:"flex", gap:4 }}>
              <span style={{ fontWeight:800, fontSize:22, color:"#111" }}>CHALO</span>
              <span style={{ fontWeight:800, fontSize:22, color:ORANGE }}>BUS</span>
            </div>
            <div style={{ fontSize:13, color:"#6B7280" }}>Track & ride smarter</div>
          </div>
          <span style={{ fontSize:22 }}>🔔</span>
        </div>
        <div style={{ background:"white", borderRadius:16, padding:"16px 20px",
          display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div>
            <div style={{ fontSize:13, color:"#6B7280", marginBottom:4 }}>First 2 rides</div>
            <div style={{ fontSize:20, fontWeight:700, color:"#111" }}>at just ₹100 each</div>
          </div>
          <span style={{ fontSize:40 }}>🎁</span>
        </div>
      </div>

      <div style={{ padding:"16px 16px 0" }}>
        {/* Feature pills */}
        {[
          { icon:"🔄", title:"Adaptive Updates",    desc:"Slows on weak signal, speeds up on 5G",     bg:"#EFF6FF", tc:"#1D4ED8" },
          { icon:"🤖", title:"ML ETA Prediction",   desc:"On-device model learns from route history", bg:"#F0FDF4", tc:"#16A34A" },
          { icon:"🗺️", title:"Smooth Interpolation",desc:"Animates bus between sparse GPS pings",     bg:"#FFF7ED", tc:"#C2410C" },
          { icon:"📦", title:"Offline Buffering",   desc:"Syncs location data when signal returns",   bg:"#FDF4FF", tc:"#7E22CE" },
        ].map(f=>(
          <div key={f.title} style={{ background:f.bg, borderRadius:14, padding:"12px 14px",
            marginBottom:10, display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:24 }}>{f.icon}</span>
            <div>
              <div style={{ fontWeight:700, fontSize:14, color:f.tc }}>{f.title}</div>
              <div style={{ fontSize:12, color:"#6B7280" }}>{f.desc}</div>
            </div>
          </div>
        ))}

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginTop:6 }}>
          <button onClick={()=>setActiveTab("search")} style={{
            background:ORANGE, border:"none", borderRadius:14,
            padding:"15px 10px", color:"white", fontWeight:700, fontSize:15, cursor:"pointer"
          }}>🔍 Find Bus</button>
          <button onClick={()=>setActiveTab("track")} style={{
            background:"white", border:`1.5px solid ${ORANGE}`, borderRadius:14,
            padding:"15px 10px", color:ORANGE, fontWeight:700, fontSize:15, cursor:"pointer"
          }}>📍 Live Track</button>
        </div>
      </div>
    </div>
  );
}

// ─── NAV BAR ──────────────────────────────────────────────────────────────
function NavBar({ activeTab, setActiveTab }) {
  const tabs = [
    { id:"home",    label:"Home",    icon:"🏠" },
    { id:"search",  label:"Search",  icon:"🔍" },
    { id:"track",   label:"Track",   icon:"📍" },
    { id:"tickets", label:"Account", icon:"👤" },
  ];
  return (
    <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)",
      width:"100%", maxWidth:420, background:"white", borderTop:"0.5px solid #E5E7EB",
      display:"flex", zIndex:100, paddingBottom:"env(safe-area-inset-bottom,0)" }}>
      {tabs.map(t=>(
        <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{
          flex:1, padding:"10px 4px 8px", border:"none", background:"none",
          cursor:"pointer", display:"flex", flexDirection:"column",
          alignItems:"center", gap:2, position:"relative"
        }}>
          <span style={{ fontSize:20 }}>{t.icon}</span>
          <span style={{ fontSize:11, fontWeight: activeTab===t.id?700:400,
            color: activeTab===t.id ? ORANGE : "#9CA3AF" }}>{t.label}</span>
          {activeTab===t.id && (
            <div style={{ position:"absolute", top:0, left:"50%", transform:"translateX(-50%)",
              width:28, height:3, background:ORANGE, borderRadius:"0 0 4px 4px" }} />
          )}
        </button>
      ))}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────
export default function ChaloApp() {
  const [activeTab, setActiveTab] = useState("home");

  const screens = {
    home:    <HomePage setActiveTab={setActiveTab} />,
    search:  <LeafletLoader><SearchPage /></LeafletLoader>,
    track:   <LeafletLoader><TrackPage /></LeafletLoader>,
    tickets: <TicketsPage />,
  };

  return (
    <div style={{ maxWidth:420, margin:"0 auto", minHeight:"100vh",
      background:"#F9FAFB", fontFamily:"'Nunito','Segoe UI',sans-serif",
      position:"relative", paddingBottom:72 }}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      {screens[activeTab]}
      <NavBar activeTab={activeTab} setActiveTab={setActiveTab} />
    </div>
  );
}
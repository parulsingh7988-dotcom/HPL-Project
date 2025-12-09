/* Improved script (fixed DOM timing + removal typo):
   - Supports multiple vehicles
   - Smooth interpolation animation between points
   - Shows path history (polyline)
   - Handles backend down: falls back to local simulation (toggle)
   - Better error handling and UI updates
*/

const BACKEND_URL = "http://127.0.0.1:5001/status";
const POLL_MS = 2000;

let useSimulation = false; // toggled by button
let map = null;
let vehicleStore = {};
let pollingHandle = null;

// DOM refs (initialized after DOM ready)
let connectionEl = null;
let lastUpdatedEl = null;
let vehicleListEl = null;
let alertsEl = null;
let toggleSimBtn = null;

// ---------- Map init ----------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([28.6139, 77.2090], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}

// ---------- DOM init ----------
function initDOM() {
  connectionEl = document.getElementById("connection");
  lastUpdatedEl = document.getElementById("last-updated");
  vehicleListEl = document.getElementById("vehicle-list");
  alertsEl = document.getElementById("alerts");
  toggleSimBtn = document.getElementById("toggle-sim");

  // defensive: if any required elements are missing, create placeholders to avoid runtime errors
  if (!connectionEl) {
    connectionEl = document.createElement("div");
    connectionEl.id = "connection";
    console.warn("connection element missing from DOM — created placeholder.");
  }
  if (!lastUpdatedEl) {
    lastUpdatedEl = document.createElement("div");
    lastUpdatedEl.id = "last-updated";
  }
  if (!vehicleListEl) {
    vehicleListEl = document.createElement("ul");
    vehicleListEl.id = "vehicle-list";
  }
  if (!alertsEl) {
    alertsEl = document.createElement("ul");
    alertsEl.id = "alerts";
  }
}

// ---------- Utilities ----------
function setConnection(online) {
  if (!connectionEl) return;
  connectionEl.classList.toggle("online", online);
  connectionEl.classList.toggle("offline", !online);
  connectionEl.textContent = online ? "Online" : "Offline";
}

function formatTime(ts = Date.now()) {
  const d = new Date(ts);
  return d.toLocaleString();
}

// Linear interpolation helper for lat/lon
function lerp(a, b, t) { return a + (b - a) * t; }

// Animate marker from old to new position over duration (ms)
function animateMarker(marker, from, to, duration = 900) {
  if (!marker || !from || !to) return;
  const start = performance.now();
  function step(now) {
    const elapsed = now - start;
    const t = Math.min(1, elapsed / duration);
    const lat = lerp(from[0], to[0], t);
    const lon = lerp(from[1], to[1], t);
    marker.setLatLng([lat, lon]);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Create or update vehicle UI entry
function ensureVehicleUI(id) {
  if (!vehicleListEl) return null;
  let el = document.getElementById(`veh-${id}`);
  if (el) return el;
  el = document.createElement("li");
  el.id = `veh-${id}`;
  el.className = "vehicle-item";
  el.innerHTML = `
    <div class="meta">
      <div class="vehicle-tag">${id}</div>
      <div class="small-muted" id="meta-${id}">—</div>
    </div>
    <div style="text-align:right">
      <div id="speed-${id}" class="small-muted">—</div>
      <div id="eta-${id}" class="small-muted">—</div>
    </div>
  `;
  vehicleListEl.appendChild(el);
  return el;
}

// Update alerts (global)
function updateAlerts(alerts) {
  if (!alertsEl) return;
  if (!alerts || alerts.length === 0) {
    alertsEl.innerHTML = "<li class='muted'>No active alerts</li>";
    return;
  }
  alertsEl.innerHTML = alerts.map(a => `<li>${a}</li>`).join("");
}

// ---------- Handling backend data ----------
function handleData(data) {
  const vehicles = Object.keys(data || {});
  const globalAlerts = [];

  vehicles.forEach(id => {
    const v = data[id];
    if (!v || (v.lat == null) || (v.lon == null)) return;

    // create store entry
    if (!vehicleStore[id]) {
      // marker
      const marker = L.marker([v.lat, v.lon]).addTo(map);
      marker.bindPopup(`<b>${id}</b><div id="popup-${id}"></div>`);
      // path
      const poly = L.polyline([[v.lat, v.lon]], { weight: 4, opacity: 0.8 }).addTo(map);
      vehicleStore[id] = {
        marker, poly, last: [v.lat, v.lon], lastRaw: [v.lat, v.lon],
        info: v
      };
      ensureVehicleUI(id);
    }

    const store = vehicleStore[id];
    // defensive: ensure store.last exists and is an array
    const from = Array.isArray(store.last) ? store.last : [v.lat, v.lon];
    const to = [v.lat, v.lon];

    // animate move
    animateMarker(store.marker, from, to, 900);

    // update path
    try {
      store.poly.addLatLng(to);
    } catch (err) {
      console.warn("Failed to add to polyline:", err);
    }

    // update store
    store.last = to.slice();
    store.lastRaw = to.slice();
    store.info = v;

    // update popup and UI
    const popupContent = `<b>${id}</b><br>Speed: ${v.speed ?? "—"} km/h<br>ETA: ${v.eta ?? "—"} mins`;
    if (store.marker.getPopup) store.marker.getPopup().setContent(popupContent);

    // UI entries
    const meta = document.getElementById(`meta-${id}`);
    const speedEl = document.getElementById(`speed-${id}`);
    const etaEl = document.getElementById(`eta-${id}`);
    if (meta) meta.textContent = `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`;
    if (speedEl) speedEl.textContent = `${v.speed ?? "—"} km/h`;
    if (etaEl) etaEl.textContent = `ETA: ${v.eta ?? "—"} min`;

    // entry alerts
    if (v.speed != null && v.speed < 15) globalAlerts.push(`⚠ ${id}: slow (${v.speed} km/h)`);
    if (v.distance != null && v.distance < 0.5) globalAlerts.push(`🎯 ${id}: delivery near destination (${v.distance} km)`);
  });

  // remove vehicles no longer present
  const currentIds = new Set(vehicles);
  Object.keys(vehicleStore).forEach(id => {
    if (!currentIds.has(id)) {
      // remove from map
      try {
        if (vehicleStore[id].marker) map.removeLayer(vehicleStore[id].marker);
        if (vehicleStore[id].poly) map.removeLayer(vehicleStore[id].poly);
      } catch (e) {
        console.warn("Error removing layers:", e);
      }
      delete vehicleStore[id];
      const el = document.getElementById(`veh-${id}`);
      if (el) el.remove();
    }
  });

  updateAlerts(globalAlerts);
  setConnection(true);
  if (lastUpdatedEl) lastUpdatedEl.textContent = "Last: " + formatTime();
}

// ---------- Polling ----------
async function fetchStatus() {
  if (useSimulation) {
    const sim = simulateData();
    handleData(sim);
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(BACKEND_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    handleData(data);
  } catch (err) {
    console.warn("Fetch failed:", err);
    setConnection(false);
    // fallback to simulation if nothing exists yet (so page doesn't look empty)
    if (Object.keys(vehicleStore).length === 0) {
      const sim = simulateData();
      handleData(sim);
    }
  }
}

function startPolling() {
  if (pollingHandle) clearInterval(pollingHandle);
  fetchStatus(); // immediate
  pollingHandle = setInterval(fetchStatus, POLL_MS);
}

// ---------- Simulation (simple) ----------
function simulateData() {
  // If there are existing vehicles, move them slightly; otherwise create 1-2 seeded vehicles
  const data = {};
  if (Object.keys(vehicleStore).length === 0) {
    data["V1"] = { lat: 28.6139, lon: 77.2090, speed: 35, eta: 12, distance: 2.3 };
    data["V2"] = { lat: 28.6239, lon: 77.1990, speed: 18, eta: 7, distance: 0.6 };
  } else {
    Object.keys(vehicleStore).forEach((id) => {
      const prev = (vehicleStore[id] && Array.isArray(vehicleStore[id].last)) ? vehicleStore[id].last : [28.6139, 77.2090];
      const jitter = (Math.random() - 0.5) * 0.0018;
      const jitter2 = (Math.random() - 0.5) * 0.0018;
      const newLat = prev[0] + jitter;
      const newLon = prev[1] + jitter2;
      const speed = Math.max(0, (vehicleStore[id]?.info?.speed ?? 30) + (Math.random() - 0.5) * 6);
      const distance = Math.max(0, (vehicleStore[id]?.info?.distance ?? 2) - Math.random() * 0.05);
      const eta = Math.max(0, Math.round(distance / (Math.max(speed, 1) / 60)));
      data[id] = { lat: newLat, lon: newLon, speed: Math.round(speed), eta, distance: parseFloat(distance.toFixed(2)) };
    });
  }
  return data;
}

// ---------- UI wiring ----------
function wireUI() {
  if (toggleSimBtn) {
    toggleSimBtn.addEventListener("click", () => {
      useSimulation = !useSimulation;
      toggleSimBtn.textContent = useSimulation ? "Using simulation (ON)" : "Use simulation (if backend down)";
      toggleSimBtn.classList.toggle("active", useSimulation);
    });
  }

  const centerBtn = document.getElementById("center-map");
  if (centerBtn) {
    centerBtn.addEventListener("click", () => {
      const keys = Object.keys(vehicleStore);
      if (keys.length === 0) {
        map.setView([28.6139, 77.2090], 12);
        return;
      }
      const group = L.featureGroup(keys.map(k => vehicleStore[k].marker));
      try {
        map.fitBounds(group.getBounds().pad(0.2));
      } catch (e) {
        console.warn("fitBounds failed:", e);
      }
    });
  }
}

// ---------- Boot ----------
window.addEventListener("load", () => {
  initDOM();
  initMap();
  wireUI();
  setConnection(false);
  startPolling();
});

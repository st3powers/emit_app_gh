// frontend/app.js
const map = L.map('map').setView([35, -110], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '&copy; OpenStreetMap' }).addTo(map);

let footprintLayer = L.layerGroup().addTo(map);
let overlay = null, activeGranule = null, clickMarker = null;

const statusEl = document.getElementById('status');
const overlayCtl = document.getElementById('overlayCtl');
const overlayToggle = document.getElementById('overlayToggle');
const opacityCtl = document.getElementById('opacityCtl');
const opacitySlider = document.getElementById('overlayOpacity');
const opacityVal = document.getElementById('opacityVal');

// Second plot's window. EMIT covers 381-2493 nm; this is the VNIR end.
const VNIR_LO = 380, VNIR_HI = 900;
const PLOT_CONFIG = { responsive: true, displaylogo: false };

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : '';
}

// Turns a failed response into the server's own detail message, so a missing
// Earthdata login or a full disk shows up in the panel instead of silently.
async function getJSON(url) {
  const r = await fetch(url);
  let body = null;
  try { body = await r.json(); } catch (e) { /* non-JSON error page */ }
  if (!r.ok) throw new Error((body && body.detail) || `${r.status} ${r.statusText}`);
  return body;
}

/* ---------- overlay visibility ---------- */

function applyOverlayVisibility() {
  if (!overlay) return;
  if (overlayToggle.checked) {
    if (!map.hasLayer(overlay)) overlay.addTo(map);
  } else if (map.hasLayer(overlay)) {
    map.removeLayer(overlay);
  }
}

overlayToggle.onchange = applyOverlayVisibility;

opacitySlider.oninput = () => {
  const pct = Number(opacitySlider.value);
  opacityVal.textContent = pct + '%';
  if (overlay) overlay.setOpacity(pct / 100);
};

/* ---------- spectrum plots ---------- */

function spectrumTrace(x, y) {
  return {
    x: x, y: y, mode: 'lines', line: { width: 1.5 },
    // Masked water-vapor bands arrive as null; show them as real breaks
    // rather than straight lines bridging the gap.
    connectgaps: false,
    hovertemplate: '%{x:.1f} nm<br>%{y:.4f}<extra></extra>'
  };
}

function spectrumLayout(titleText, xRange, xExtra) {
  const xaxis = {
    title: { text: 'Wavelength (nm)', standoff: 8 },
    tick0: 400, dtick: 100,          // tick labels every 100 nm
    ticks: 'outside'
  };
  if (xRange) xaxis.range = xRange;
  Object.assign(xaxis, xExtra || {});
  return {
    title: { text: titleText, font: { size: 13 } },
    xaxis: xaxis,
    yaxis: { title: { text: 'Reflectance', standoff: 6 } },
    margin: { t: 34, l: 56, r: 12, b: 58 },
    showlegend: false
  };
}

function sliceRange(wl, refl, lo, hi) {
  const x = [], y = [];
  for (let i = 0; i < wl.length; i++) {
    if (wl[i] >= lo && wl[i] <= hi) { x.push(wl[i]); y.push(refl[i]); }
  }
  return { x: x, y: y };
}

function plotSpectra(d, latlng) {
  const at = `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;

  // 21 ticks across the full range, so angle them to stay readable.
  Plotly.newPlot('chartFull',
    [spectrumTrace(d.wavelengths, d.reflectance)],
    spectrumLayout(`Full range @ ${at}`, null,
      { tickangle: -45, tickfont: { size: 9 } }),
    PLOT_CONFIG);

  // Sliced, not merely range-limited: a range-limited x axis would leave the
  // y axis autoscaled to the SWIR maximum and flatten the VNIR detail.
  const v = sliceRange(d.wavelengths, d.reflectance, VNIR_LO, VNIR_HI);
  Plotly.newPlot('chartVnir',
    [spectrumTrace(v.x, v.y)],
    spectrumLayout(`${VNIR_LO}–${VNIR_HI} nm @ ${at}`, [VNIR_LO, VNIR_HI]),
    PLOT_CONFIG);
}

function clearSpectra() {
  Plotly.purge('chartFull');
  Plotly.purge('chartVnir');
}

/* ---------- search / load / sample ---------- */

document.getElementById('searchBtn').onclick = async () => {
  const b = map.getBounds();
  setStatus('Searching…');
  let scenes;
  try {
    ({ scenes } = await getJSON(
      `/api/search?west=${b.getWest()}&south=${b.getSouth()}&east=${b.getEast()}&north=${b.getNorth()}`));
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  footprintLayer.clearLayers();
  const list = document.getElementById('sceneList');
  list.innerHTML = '';
  setStatus(`${scenes.length} scene(s) found`);
  scenes.forEach(s => {
    L.polygon(s.footprint, { color: '#3388ff', weight: 1, fillOpacity: 0.05 }).addTo(footprintLayer);
    const div = document.createElement('div');
    div.className = 'scene-item';
    div.textContent = `${s.time.slice(0, 16)} — ${s.id}`;
    div.onclick = () => loadScene(s.id, div);
    list.appendChild(div);
  });
};

async function loadScene(id, el) {
  const label = el.textContent;
  el.textContent = label + ' ⏳';
  // First load of a granule pulls ~3.6 GB from Earthdata, so this is slow.
  setStatus('Downloading granule (first load can take several minutes)…');
  let res;
  try {
    res = await getJSON(`/api/load/${id}`);
  } catch (err) {
    el.textContent = label + ' ✗';
    setStatus(err.message, true);
    return;
  }

  if (overlay) map.removeLayer(overlay);
  overlay = L.imageOverlay(res.overlay_url, res.bounds,
    { opacity: Number(opacitySlider.value) / 100 });
  overlay.addTo(map);
  map.fitBounds(res.bounds);

  overlayToggle.checked = true;       // a freshly loaded scene starts visible
  overlayCtl.hidden = false;
  opacityCtl.hidden = false;

  // Old spectrum belongs to the previous granule.
  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
  clearSpectra();

  activeGranule = id;
  el.textContent = label + ' ✓';
  setStatus('Scene loaded — click the map for a spectrum');
}

map.on('click', async (e) => {
  if (!activeGranule) return;
  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.marker(e.latlng).addTo(map);
  let d;
  try {
    d = await getJSON(
      `/api/spectrum?granule_id=${activeGranule}&lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  if (d.error) { setStatus(d.error, true); return; }
  setStatus('');
  plotSpectra(d, e.latlng);
});

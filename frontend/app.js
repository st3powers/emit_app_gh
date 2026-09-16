// frontend/app.js
const map = L.map('map').setView([35, -110], 6);
// crossOrigin so tile images can be read back into a canvas for the "Download
// map PNG" control below -- OSM's tile server sends Access-Control-Allow-
// Origin: *, but the browser only takes advantage of that if the <img> asked
// for it; without this the exported canvas is cross-origin-tainted and
// toDataURL() throws instead of producing an image.
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '&copy; OpenStreetMap', crossOrigin: true }).addTo(map);

// Footprint outlines (vector paths) and the raster overlay (a plain <img>)
// both default to Leaflet's shared 'overlayPane', so which one ends up on
// top depends on DOM insertion order -- and re-running a search recreates
// the footprints' SVG, which can bump it back above an already-loaded
// raster. A dedicated, higher-z-index pane makes the raster win regardless.
map.createPane('rasterPane');
map.getPane('rasterPane').style.zIndex = 450; // default overlayPane is 400

/* ---------- map screenshot ---------- */

// A Leaflet control (not a plain absolutely-positioned <button>) so it sits
// in the map's own bottom-right corner and follows Leaflet's usual control
// conventions, rather than floating a foreign element over the map.
const mapPngCtl = L.control({ position: 'bottomright' });
mapPngCtl.onAdd = function () {
  const div = L.DomUtil.create('div', 'leaflet-bar map-png-ctl');
  div.innerHTML = '<button id="downloadMapPngBtn" type="button" hidden>Download map PNG</button>';
  // Otherwise a click here also reaches the map's own click handler
  // underneath, which would fire an unwanted spectrum lookup.
  L.DomEvent.disableClickPropagation(div);
  return div;
};
mapPngCtl.addTo(map);
const downloadMapPngBtn = document.getElementById('downloadMapPngBtn');
const mapPngCtlContainer = mapPngCtl.getContainer();

downloadMapPngBtn.onclick = async () => {
  const label = downloadMapPngBtn.textContent;
  downloadMapPngBtn.disabled = true;
  downloadMapPngBtn.textContent = 'Rendering…';
  // Hidden during capture so the "Download map PNG" control doesn't appear
  // inside its own screenshot.
  mapPngCtlContainer.style.visibility = 'hidden';
  try {
    // html2canvas walks the actual rendered DOM (tiles, the EMIT raster
    // <img> overlay, SVG footprint paths, the marker) rather than needing
    // per-Leaflet-layer-type support -- tried leaflet-image first, but that
    // library (unmaintained since the Leaflet 0.7 era) only knows how to
    // draw TileLayer and Marker, silently dropping the raster overlay and
    // footprint outlines, which defeats the point of this feature.
    const canvas = await html2canvas(document.getElementById('map'), { useCORS: true, logging: false });
    // Same lat/lon-in-filename convention as the spectrum PNG downloads,
    // using the point behind the last-plotted spectrum (if it's for the
    // scene currently on screen) so the map, CSV, and spectrum PNGs from
    // the same click all name-match.
    const granuleId = activeGranule || 'emit_map';
    const pt = (lastSpectrum && lastSpectrum.granuleId === activeGranule) ? lastSpectrum : null;
    const suffix = pt ? `${pt.lat.toFixed(5)}_${pt.lon.toFixed(5)}_map_view` : 'map_view';
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${granuleId}_${suffix}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    setStatus(`Could not capture map image (${err.message || err})`, true);
  } finally {
    mapPngCtlContainer.style.visibility = '';
    downloadMapPngBtn.disabled = false;
    downloadMapPngBtn.textContent = label;
  }
};

let footprintLayer = L.layerGroup().addTo(map);
// Scene id -> its L.Polygon, so a specific scene's footprint can be
// highlighted (while its full-resolution raster is loading, or just to mark
// which one is currently selected) independently of the others still shown
// from the same search.
let footprintPolygons = {};
let selectedFootprintId = null;
const FOOTPRINT_STYLE = { color: '#3388ff', weight: 1, fillOpacity: 0.05 };
const FOOTPRINT_SELECTED_STYLE = { color: '#e67e22', weight: 3, fillOpacity: 0.05 };
const FOOTPRINT_LOADING_STYLE = { color: '#f1c40f', weight: 2, fillColor: '#f1c40f', fillOpacity: 0.35 };

function setFootprintSelected(id) {
  if (selectedFootprintId && footprintPolygons[selectedFootprintId]) {
    footprintPolygons[selectedFootprintId].setStyle(FOOTPRINT_STYLE);
  }
  selectedFootprintId = id;
  if (footprintPolygons[id]) footprintPolygons[id].setStyle(FOOTPRINT_SELECTED_STYLE);
}

function setFootprintLoading(id, isLoading) {
  const poly = footprintPolygons[id];
  if (!poly) return;
  // Loading always wins visually; once it's done, fall back to the
  // "selected" outline if this is still the selected scene, else default.
  poly.setStyle(isLoading ? FOOTPRINT_LOADING_STYLE
    : (id === selectedFootprintId ? FOOTPRINT_SELECTED_STYLE : FOOTPRINT_STYLE));
}

// Scene id -> its full search-result record, so scene metadata (time, cloud
// cover) is still available for CSV export after previewScene/activeGranule
// have moved on to something else.
let scenesById = {};

let overlay = null, activeGranule = null, clickMarker = null;
// The scene currently shown as a fast, approximate NASA quicklook -- set
// while browsing, cleared once the real georeferenced overlay (activeGranule)
// has been fetched for it.
let previewScene = null;
// In-flight full-resolution load for previewScene, so repeated clicks while
// it's still loading reuse the same request instead of re-downloading.
let fullLoadPromise = null;
let activeSceneEl = null, activeSceneLabel = '';
// The spectrum currently on the charts, kept around so the CSV button can
// export it without re-fetching.
let lastSpectrum = null;

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const statusSpinner = document.getElementById('statusSpinner');
const downloadCsvBtn = document.getElementById('downloadCsvBtn');
const downloadFullPngBtn = document.getElementById('downloadFullPngBtn');
const downloadVnirPngBtn = document.getElementById('downloadVnirPngBtn');
const overlayCtl = document.getElementById('overlayCtl');
const overlayToggle = document.getElementById('overlayToggle');
const opacityCtl = document.getElementById('opacityCtl');
const opacitySlider = document.getElementById('overlayOpacity');
const opacityVal = document.getElementById('opacityVal');
const browseCtl = document.getElementById('browseCtl');
const browseViewport = document.getElementById('browseViewport');
const browseImg = document.getElementById('browseImg');
const browseZoomIn = document.getElementById('browseZoomIn');
const browseZoomOut = document.getElementById('browseZoomOut');
const browseZoomReset = document.getElementById('browseZoomReset');
const browseZoomLabel = document.getElementById('browseZoomLabel');
// The quicklook is the raw swath (rotation varies scene to scene), so
// draping it on the map with an axis-aligned bounding box misrepresents its
// geometry. Shown as a plain panel thumbnail instead -- no map placement.
browseImg.onerror = () => { browseCtl.hidden = true; };

/* ---------- quicklook zoom ---------- */

const BROWSE_ZOOM_MIN = 1, BROWSE_ZOOM_MAX = 5, BROWSE_ZOOM_STEP = 0.5;
let browseZoom = 1;

function setBrowseZoom(z) {
  browseZoom = Math.min(BROWSE_ZOOM_MAX, Math.max(BROWSE_ZOOM_MIN, z));
  browseImg.style.width = (browseZoom * 100) + '%';
  browseZoomLabel.textContent = Math.round(browseZoom * 100) + '%';
}

function resetBrowseZoom() {
  setBrowseZoom(1);
  browseViewport.scrollLeft = 0;
  browseViewport.scrollTop = 0;
}

browseZoomIn.onclick = () => setBrowseZoom(browseZoom + BROWSE_ZOOM_STEP);
browseZoomOut.onclick = () => setBrowseZoom(browseZoom - BROWSE_ZOOM_STEP);
browseZoomReset.onclick = resetBrowseZoom;

// Scroll-to-zoom over the thumbnail itself, the same convention as the map.
browseViewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  setBrowseZoom(browseZoom + (e.deltaY < 0 ? BROWSE_ZOOM_STEP : -BROWSE_ZOOM_STEP));
}, { passive: false });

// Second plot's window. EMIT covers 381-2493 nm; this is the VNIR end.
const VNIR_LO = 380, VNIR_HI = 900;
const PLOT_CONFIG = { responsive: true, displaylogo: false };

function setStatus(msg, isError) {
  statusTextEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : '';
}

// Spinner visibility tracks actual in-flight requests (see getJSON below),
// not any particular status message -- so it can't be left spinning (or
// hidden) after what it was showing has already finished.
let busyCount = 0;
function setBusy(isBusy) {
  busyCount += isBusy ? 1 : -1;
  statusSpinner.hidden = busyCount <= 0;
}

// Turns a failed response into the server's own detail message, so a missing
// Earthdata login or a full disk shows up in the panel instead of silently.
async function getJSON(url) {
  setBusy(true);
  try {
    const r = await fetch(url);
    let body = null;
    try { body = await r.json(); } catch (e) { /* non-JSON error page */ }
    if (!r.ok) throw new Error((body && body.detail) || `${r.status} ${r.statusText}`);
    return body;
  } finally {
    setBusy(false);
  }
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
  lastSpectrum = null;
  downloadCsvBtn.hidden = true;
  downloadFullPngBtn.hidden = true;
  downloadVnirPngBtn.hidden = true;
}

/* ---------- CSV export ---------- */

function csvField(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

downloadCsvBtn.onclick = () => {
  if (!lastSpectrum) return;
  const { granuleId, sceneTime, cloudCover, source, lat, lon, wavelengths, reflectance } = lastSpectrum;
  const rows = [[
    'granule_id', 'scene_time_utc', 'cloud_cover_pct', 'data_source',
    'lat', 'lon', 'wavelength_nm', 'reflectance',
  ].join(',')];
  for (let i = 0; i < wavelengths.length; i++) {
    rows.push([
      csvField(granuleId), csvField(sceneTime), csvField(cloudCover),
      csvField(source), lat, lon, wavelengths[i], csvField(reflectance[i]),
    ].join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${granuleId}_${lat.toFixed(5)}_${lon.toFixed(5)}_spectrum.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/* ---------- PNG export ---------- */

// Fixed pixel dimensions for the exported image -- deliberately independent
// of the on-screen chart size (which is responsive to the panel/window).
// Width is the original 700 reduced 40%, i.e. 700 * 0.6.
const PNG_EXPORT_WIDTH = 420, PNG_EXPORT_HEIGHT = 280;

async function downloadChartPng(btn, chartId, suffix) {
  if (!lastSpectrum) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    const { granuleId, lat, lon } = lastSpectrum;
    await Plotly.downloadImage(chartId, {
      format: 'png', width: PNG_EXPORT_WIDTH, height: PNG_EXPORT_HEIGHT, scale: 2,
      filename: `${granuleId}_${lat.toFixed(5)}_${lon.toFixed(5)}_${suffix}`,
    });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

downloadFullPngBtn.onclick = () => downloadChartPng(downloadFullPngBtn, 'chartFull', 'full_range_spectrum');
downloadVnirPngBtn.onclick = () => downloadChartPng(downloadVnirPngBtn, 'chartVnir', 'visible_range_spectrum');

/* ---------- search / load / sample ---------- */

const cloudCoverSlider = document.getElementById('cloudCover');
const cloudCoverVal = document.getElementById('cloudCoverVal');
cloudCoverSlider.oninput = () => { cloudCoverVal.textContent = cloudCoverSlider.value + '%'; };

document.getElementById('searchBtn').onclick = async () => {
  const b = map.getBounds();
  const cloudMax = cloudCoverSlider.value;
  setStatus('Searching…');
  let scenes;
  try {
    ({ scenes } = await getJSON(
      `/api/search?west=${b.getWest()}&south=${b.getSouth()}&east=${b.getEast()}&north=${b.getNorth()}` +
      `&cloud_cover_max=${cloudMax}`));
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  footprintLayer.clearLayers();
  footprintPolygons = {};
  scenesById = {};
  const list = document.getElementById('sceneList');
  list.innerHTML = '';
  setStatus(`${scenes.length} scene(s) found (≤${cloudMax}% cloud)`);
  scenes.forEach(s => {
    scenesById[s.id] = s;
    footprintPolygons[s.id] = L.polygon(s.footprint, FOOTPRINT_STYLE).addTo(footprintLayer);
    const div = document.createElement('div');
    div.className = 'scene-item';
    const cloud = s.cloud_cover == null ? '' : ` — ${Math.round(s.cloud_cover)}% cloud`;
    div.textContent = `${s.time.slice(0, 16)} — ${s.id}${cloud}`;
    div.onclick = () => selectScene(s, div);
    list.appendChild(div);
  });
};

// Selecting a scene shows NASA's pre-rendered quicklook immediately (no
// download) instead of the true georeferenced overlay, which needs the full
// granule. The quicklook's rotation varies scene to scene (raw swath, not
// orthorectified), so draping it on the map with an axis-aligned bounding
// box would misrepresent it -- it's shown as a plain panel thumbnail instead,
// just to see roughly what's there before committing to a multi-GB fetch.
function selectScene(scene, el) {
  if (activeSceneEl) activeSceneEl.classList.remove('scene-item-active');
  el.classList.add('scene-item-active');
  activeSceneEl = el;
  activeSceneLabel = el.textContent;

  if (overlay) map.removeLayer(overlay);
  overlay = null;
  activeGranule = null;
  previewScene = scene;
  fullLoadPromise = null;   // any load still running belongs to the old scene
  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
  clearSpectra();
  // No real overlay on the map yet -- these controls apply to it.
  overlayCtl.hidden = true;
  opacityCtl.hidden = true;
  downloadMapPngBtn.hidden = true;
  // Thicker orange outline so it's clear which box on the map this scene is.
  setFootprintSelected(scene.id);

  map.fitBounds(scene.browse_bounds);

  if (scene.browse_url) {
    browseImg.src = scene.browse_url;
    browseCtl.hidden = false;
    resetBrowseZoom();
    setStatus('Quicklook shown in panel — click the map for a full-resolution spectrum');
  } else {
    browseCtl.hidden = true;
    setStatus('No quicklook available for this scene — click the map to fetch full-resolution data');
  }
}

async function loadFullScene(scene) {
  // First load of a granule pulls the full RFL file from Earthdata, so this
  // is slow; later loads reuse the cached download and overlay. Highlight
  // the footprint on the map so it's clear which scene's raster is on its
  // way, since the real overlay itself isn't there to look at yet.
  setStatus('Fetching full-resolution granule (first load can take a while)…');
  setFootprintLoading(scene.id, true);
  try {
    const res = await getJSON(`/api/load/${scene.id}`);

    if (overlay) map.removeLayer(overlay);
    overlay = L.imageOverlay(res.overlay_url, res.bounds,
      { opacity: Number(opacitySlider.value) / 100, pane: 'rasterPane' });
    overlay.addTo(map);
    map.fitBounds(res.bounds);
    overlayToggle.checked = true;
    overlayCtl.hidden = false;
    opacityCtl.hidden = false;
    downloadMapPngBtn.hidden = false;

    activeGranule = scene.id;
    previewScene = null;
    if (activeSceneEl) activeSceneEl.textContent = activeSceneLabel + ' ✓';
    // The "...loading in background" message from the fast-preview click
    // has nothing to update it once this actually finishes, so it was
    // getting stuck on screen looking like the load was still running.
    // Only replace it if it's still showing exactly that (not some newer,
    // unrelated status the user has since triggered).
    if (statusTextEl.textContent.includes('loading in background')) {
      setStatus('Full-resolution raster loaded — click again for a precise spectrum');
    }
  } finally {
    setFootprintLoading(scene.id, false);
  }
}

async function plotSpectrumFrom(endpoint, granuleId, latlng) {
  const d = await getJSON(
    `${endpoint}?granule_id=${granuleId}&lat=${latlng.lat}&lon=${latlng.lng}`);
  // Thrown (not just returned) so every caller's catch block -- which
  // already handles network/server errors -- also covers this uniformly,
  // instead of each needing its own separate "did it work?" check.
  if (d.error) throw new Error(d.error);
  plotSpectra(d, latlng);

  const scene = scenesById[granuleId];
  lastSpectrum = {
    granuleId, lat: latlng.lat, lon: latlng.lng,
    sceneTime: scene ? scene.time : '',
    cloudCover: scene ? scene.cloud_cover : null,
    source: endpoint === '/api/spectrum_remote' ? 'remote_streamed' : 'local_full_resolution',
    wavelengths: d.wavelengths, reflectance: d.reflectance,
  };
  downloadCsvBtn.hidden = false;
  downloadFullPngBtn.hidden = false;
  downloadVnirPngBtn.hidden = false;
}

map.on('click', async (e) => {
  if (!activeGranule && !previewScene) return;
  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.marker(e.latlng).addTo(map);

  if (activeGranule) {
    // Full-resolution raster already local -- straight to the fast local read.
    try {
      await plotSpectrumFrom('/api/spectrum', activeGranule, e.latlng);
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
    }
    return;
  }

  // Still on the quicklook preview: kick off (or reuse) the full-resolution
  // download in the background, but don't make the user wait on it for a
  // spectrum -- stream this one pixel over HTTP range requests instead,
  // which only needs ~1-2s once the granule's remote handle is warm.
  const scene = previewScene;
  if (!fullLoadPromise) {
    fullLoadPromise = loadFullScene(scene)
      .catch(err => {
        setStatus(err.message, true);
        if (activeSceneEl) activeSceneEl.textContent = activeSceneLabel + ' ✗';
      })
      .finally(() => { fullLoadPromise = null; });
  }

  try {
    await plotSpectrumFrom('/api/spectrum_remote', scene.id, e.latlng);
    // The background load can finish before this fetch does (e.g. an
    // already-cached granule) -- check current state rather than assuming
    // it's still running, or this would overwrite a completed message with
    // a stale "still loading" one.
    setStatus(activeGranule === scene.id
      ? 'Full-resolution raster loaded — click again for a precise spectrum'
      : 'Fast preview spectrum (streamed, not downloaded) — full-resolution raster loading in background…');
  } catch (err) {
    setStatus(`Fast preview unavailable (${err.message}) — waiting on the full-resolution raster…`, true);
  }
});

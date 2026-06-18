/* ============================================================
   Nashville ZIP Code Population Map — script.js
   Loads ZIP data, renders Leaflet map + sortable table,
   and keeps both views in sync on selection/filter changes.
   ============================================================ */

'use strict';

// ---- Configuration ----
const NASHVILLE_CENTER = [36.1627, -86.7816]; // downtown Nashville
const DEFAULT_RADIUS   = 30;   // miles
const MAP_ZOOM         = 10;

// ---- Color scale helpers ----
// Interpolate across MyRide blue palette based on population share
// Low → Sky blue → Electric Cobalt → Midnight (most populous)
function colorForPct(pct, maxPct) {
  if (maxPct === 0) return '#3B82F6';
  const t = Math.sqrt(pct / maxPct); // sqrt scale: more visual separation at the low end
  // Stops: 0 → #BFDBFE (sky), 0.5 → #3B82F6 (tide), 1 → #1A4DFF (cobalt)
  if (t < 0.5) {
    const u = t * 2;
    return lerpHex('#93C5FD', '#3B82F6', u);
  } else {
    const u = (t - 0.5) * 2;
    return lerpHex('#3B82F6', '#1A4DFF', u);
  }
}

function lerpHex(a, b, t) {
  const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t).toString(16).padStart(2, '0');
  const g = Math.round(ag + (bg - ag) * t).toString(16).padStart(2, '0');
  const bh = Math.round(ab + (bb - ab) * t).toString(16).padStart(2, '0');
  return `#${r}${g}${bh}`;
}

// Circle radius (px) proportional to population share (sqrt scale)
function markerRadius(pct, maxPct) {
  const MIN = 7, MAX = 34;
  if (maxPct === 0) return MIN;
  return MIN + Math.sqrt(pct / maxPct) * (MAX - MIN);
}

// ---- Number formatting ----
const fmt = n => n.toLocaleString('en-US');

// ---- App state ----
let allZips     = [];   // full dataset loaded from JSON
let filtered    = [];   // current radius-filtered slice
let selectedZip = null; // currently highlighted ZIP string
let sortKey     = 'population';
let sortDir     = -1;   // -1 = descending, 1 = ascending
let searchQuery = '';
let maxRadius   = DEFAULT_RADIUS;

// ---- Leaflet map & layer registry ----
let map;
let radiusCircle;    // the dashed boundary ring on the map
let zipPolygonLayer; // single L.geoJSON for ALL polygon ZIPs (clean shared borders)
const layers = {};   // zip string → individual Leaflet layer (for select/style)

// ---- Multi-select mode ----
let multiSelectMode = false;
let multiSelected   = new Set(); // zip strings currently selected in multi-select mode

// ---- Boot: fetch data, then initialize ----

/**
 * DATA LOADING
 *
 * Tries to fetch ./data/zipcodes.json via HTTP (works on Vercel + local servers).
 * If the browser blocks fetch on a file:// URL, a clear error message is shown.
 *
 * TO REPLACE WITH REAL DATA: Edit data/zipcodes.json.
 * Each entry must include at minimum: zip, city, county, state,
 * population, distanceMiles, lat, lng.
 * Add a "geometry" field (GeoJSON Polygon) to show real boundary polygons.
 */
async function loadData() {
  const [zipRes, boundaryRes] = await Promise.all([
    fetch('./data/zipcodes.json'),
    fetch('./data/zip-boundaries.geojson'),
  ]);
  if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status}`);
  const zips = await zipRes.json();

  // Merge real ZCTA boundaries into zip objects (graceful fallback to circles if unavailable)
  if (boundaryRes.ok) {
    const gj = await boundaryRes.json();
    const geomMap = {};
    gj.features.forEach(f => {
      if (f.properties && f.properties.ZCTA5) geomMap[f.properties.ZCTA5] = f.geometry;
    });
    zips.forEach(z => { if (geomMap[z.zip]) z.geometry = geomMap[z.zip]; });
  }

  return zips;
}

loadData()
  .then(data => {
    // Filter out rows with no population — they don't add to the map story
    // Remove this filter if you want all ZIP codes regardless of population
    allZips = data.filter(z => z.population > 0);
    initMap();
    applyRadius(DEFAULT_RADIUS);
  })
  .catch(err => {
    // This typically happens when opening index.html directly via file://
    // Solution: run a local HTTP server (e.g. VS Code Live Server) or deploy to Vercel
    document.body.innerHTML = `
      <div style="padding:40px; font-family:sans-serif; max-width:600px; margin:0 auto;">
        <h2 style="color:#C99700;">⚠ Data file could not be loaded</h2>
        <p style="margin-top:12px; color:#555;">
          This app fetches <code>data/zipcodes.json</code> via HTTP and cannot run
          when opened directly as a local file (<code>file://</code>).
        </p>
        <p style="margin-top:10px; color:#555;"><strong>Options to fix this:</strong></p>
        <ul style="margin-top:8px; color:#555; line-height:1.8;">
          <li>Use <strong>VS Code Live Server</strong> extension and click "Go Live"</li>
          <li>Run <code>python -m http.server 8080</code> in the project folder, then open <code>http://localhost:8080</code></li>
          <li>Deploy to <strong>Vercel</strong> (see README.md for instructions)</li>
        </ul>
        <p style="margin-top:14px; font-size:12px; color:#999;">Error detail: ${err.message}</p>
      </div>
    `;
  });

// ---- Map initialization ----
function initMap() {
  map = L.map('map', {
    center: NASHVILLE_CENTER,
    zoom:   MAP_ZOOM,
    scrollWheelZoom: true,
  });

  // CartoDB Voyager — clean light basemap, professional for client presentations
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Click on empty map area → deselect (ignored in multi-select mode)
  map.on('click', () => { if (!multiSelectMode) deselectZip(); });

  // "Select Multiple" floating button (top-right of map)
  const msControl = L.control({ position: 'topright' });
  msControl.onAdd = () => {
    const btn = L.DomUtil.create('button', 'multi-select-btn');
    btn.id = 'multi-select-btn';
    btn.textContent = 'Select Multiple';
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.disableScrollPropagation(btn);
    btn.addEventListener('click', toggleMultiSelect);
    return btn;
  };
  msControl.addTo(map);

  // Downtown Nashville pin
  L.marker(NASHVILLE_CENTER, {
    icon: L.divIcon({
      className: '',
      html: '<div style="width:12px;height:12px;border-radius:50%;background:#1A4DFF;border:2px solid #fff;box-shadow:0 0 0 2px #1A4DFF, 0 2px 8px rgba(26,77,255,0.5);"></div>',
      iconSize:   [16, 16],
      iconAnchor: [8, 8],
    }),
  }).addTo(map).bindPopup(
    '<div class="popup-zip">Downtown Nashville</div>' +
    '<div class="popup-city">36.1627°N, 86.7816°W — reference center point</div>'
  );
}

// ---- Radius application: filter data, rebuild map + list ----
function applyRadius(miles) {
  maxRadius = miles;

  // Update active button
  document.querySelectorAll('.radius-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.miles) === miles);
  });

  // Filter ZIP codes to the chosen radius
  filtered = allZips.filter(z => z.distanceMiles <= miles);

  // Recalculate each ZIP's percentage share based only on visible ZIPs
  const totalPop = filtered.reduce((s, z) => s + z.population, 0);
  filtered.forEach(z => {
    z.currentPct = totalPop > 0 ? (z.population / totalPop * 100) : 0;
  });
  const maxPct = filtered.length ? Math.max(...filtered.map(z => z.currentPct)) : 0;

  // Update summary stats
  document.getElementById('stat-radius').textContent = miles;
  document.getElementById('stat-count').textContent  = filtered.length;
  document.getElementById('stat-pop').textContent    = totalPop >= 1000000
    ? (totalPop / 1000000).toFixed(2) + 'M'
    : fmt(totalPop);

  rebuildMapLayers(maxPct);
  renderTable();
}

// ---- Map: remove old layers, draw new ones ----
function rebuildMapLayers(maxPct) {
  // Remove previous polygon group and any circle marker fallbacks
  if (zipPolygonLayer) { map.removeLayer(zipPolygonLayer); zipPolygonLayer = null; }
  Object.values(layers).forEach(layer => map.removeLayer(layer));
  Object.keys(layers).forEach(k => delete layers[k]);

  // Update (or create) the dashed radius boundary ring
  const radiusMeters = maxRadius * 1609.34;
  if (radiusCircle) {
    radiusCircle.setRadius(radiusMeters);
  } else {
    radiusCircle = L.circle(NASHVILLE_CENTER, {
      radius:      radiusMeters,
      color:       '#1A4DFF',
      weight:      1.5,
      dashArray:   '6 5',
      fillOpacity: 0.03,
      fillColor:   '#1A4DFF',
      interactive: false,
    }).addTo(map);
  }

  // ---- All polygon ZIPs in ONE geoJSON layer ----
  // Rendering every feature inside a single layer means adjacent ZIP borders
  // share the same SVG path group — each border line is drawn exactly once,
  // eliminating the double-stroke artifact where ZIPs meet.
  const polyZips = filtered.filter(z => z.geometry);
  if (polyZips.length) {
    const fc = {
      type: 'FeatureCollection',
      features: polyZips.map(z => ({
        type: 'Feature',
        geometry: z.geometry,
        properties: { zip: z.zip },
      })),
    };
    zipPolygonLayer = L.geoJSON(fc, {
      smoothFactor: 0,
      style: f => {
        const z = polyZips.find(d => d.zip === f.properties.zip);
        return { color: '#1A4DFF', weight: 1, fillColor: colorForPct(z.currentPct, maxPct), fillOpacity: 0 };
      },
      onEachFeature: (f, fl) => {
        const zip = f.properties.zip;
        const z   = polyZips.find(d => d.zip === zip);
        layers[zip] = fl;
        fl.on('mouseover', () => { if (selectedZip !== zip) fl.setStyle({ fillOpacity: 0.55 }); });
        fl.on('mouseout',  () => { if (selectedZip !== zip) fl.setStyle({ fillOpacity: 0 }); });
        fl.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (multiSelectMode) toggleMultiSelectedZip(zip);
          else if (selectedZip === zip) deselectZip();
          else selectZip(zip, false);
        });
        fl.bindTooltip(tooltipContent(z), { sticky: true, opacity: 0.95 });
        fl.bindPopup(buildPopup(z));
      },
    }).addTo(map);
  }

  // ---- Circle marker fallback for any ZIP without boundary geometry ----
  filtered.filter(z => !z.geometry).forEach(z => {
    const layer = L.circleMarker([z.lat, z.lng], {
      radius:      markerRadius(z.currentPct, maxPct),
      fillColor:   colorForPct(z.currentPct, maxPct),
      color:       '#FFFFFF',
      weight:      1.5,
      fillOpacity: 0.82,
    }).bindTooltip(tooltipContent(z), { sticky: true, opacity: 0.97 })
      .bindPopup(buildPopup(z));
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (multiSelectMode) toggleMultiSelectedZip(z.zip);
      else if (selectedZip === z.zip) deselectZip();
      else selectZip(z.zip, false);
    });
    layer.addTo(map);
    layers[z.zip] = layer;
  });
}

function tooltipContent(z) {
  return `<strong>${z.zip}</strong> — ${z.city}<br>
          Pop: <strong>${fmt(z.population)}</strong> &nbsp;|&nbsp; ${z.currentPct.toFixed(2)}% of region`;
}

function buildPopup(z) {
  return `<div class="popup-zip">${z.zip}</div>
          <div class="popup-city">${z.city}, ${z.state} &middot; ${z.county} County</div>
          <div class="popup-row"><span>Population</span><b>${fmt(z.population)}</b></div>
          <div class="popup-row"><span>Share of region</span><b>${z.currentPct.toFixed(2)}%</b></div>
          <div class="popup-row"><span>Distance from downtown</span><b>${z.distanceMiles} mi</b></div>`;
}

// ---- Deselect: clear highlight and reset all layer styles ----
function deselectZip() {
  if (!selectedZip) return;
  selectedZip = null;
  map.closePopup();
  Object.entries(layers).forEach(([z, layer]) => {
    if (!layer.setStyle) return;
    const isPolygon = !!(allZips.find(d => d.zip === z) || {}).geometry;
    layer.setStyle(
      isPolygon
        ? { weight: 1,   color: '#1A4DFF', fillOpacity: 0 }
        : { weight: 1.5, color: '#FFFFFF',  fillOpacity: 0.82 }
    );
  });
  document.querySelectorAll('#tbody tr').forEach(tr => tr.classList.remove('active'));
}

// ---- Multi-select mode toggle ----
function toggleMultiSelect() {
  multiSelectMode = !multiSelectMode;
  const btn = document.getElementById('multi-select-btn');
  btn.classList.toggle('active', multiSelectMode);

  if (multiSelectMode) {
    // Entering: clear normal selection first
    deselectZip();
    multiSelected.clear();
  } else {
    // Exiting: reset all layer styles and restore full radius view
    multiSelected.clear();
    applyRadius(maxRadius);
  }
  renderTable();
}

// ---- Toggle one ZIP in/out of the multi-selection ----
function toggleMultiSelectedZip(zip) {
  const layer = layers[zip];
  const isPolygon = !!(allZips.find(d => d.zip === zip) || {}).geometry;

  if (multiSelected.has(zip)) {
    multiSelected.delete(zip);
    if (layer && layer.setStyle) {
      layer.setStyle(isPolygon
        ? { weight: 1,   color: '#1A4DFF', fillOpacity: 0 }
        : { weight: 1.5, color: '#FFFFFF',  fillOpacity: 0.82 });
    }
  } else {
    multiSelected.add(zip);
    if (layer && layer.setStyle) {
      layer.setStyle(isPolygon
        ? { weight: 2.5, color: '#06D6A0', fillOpacity: 0.65 }
        : { weight: 3,   color: '#06D6A0', fillOpacity: 0.92 });
      if (layer.bringToFront) layer.bringToFront();
    }
  }

  // Update stats and table to reflect current selection
  const selZips = filtered.filter(z => multiSelected.has(z.zip));
  const totalPop = selZips.reduce((s, z) => s + z.population, 0);
  document.getElementById('stat-count').textContent = multiSelected.size || '—';
  document.getElementById('stat-count-lbl').textContent = multiSelected.size ? 'Selected' : 'ZIP Codes';
  document.getElementById('stat-pop').textContent = multiSelected.size
    ? (totalPop >= 1_000_000 ? (totalPop / 1_000_000).toFixed(2) + 'M' : fmt(totalPop))
    : '—';
  renderTable();
}

// ---- Selection: sync map highlight + list row ----
function selectZip(zip, flyToMarker) {
  selectedZip = zip;

  // Highlight the map layer — style differs between polygon and circle layers
  Object.entries(layers).forEach(([z, layer]) => {
    const isSelected = z === zip;
    if (!layer.setStyle) return;
    const isPolygon = !!(allZips.find(d => d.zip === z) || {}).geometry;
    layer.setStyle(isSelected
      ? { weight: isPolygon ? 2.5 : 3,   color: '#06D6A0', fillOpacity: isPolygon ? 0.65 : 0.92 }
      : { weight: isPolygon ? 1   : 1.5, color: isPolygon ? '#1A4DFF' : '#FFFFFF', fillOpacity: isPolygon ? 0    : 0.82 }
    );
    if (isSelected && layer.bringToFront) layer.bringToFront();
  });

  // Fly map to the selected ZIP when triggered from the list
  if (flyToMarker && layers[zip]) {
    const layer = layers[zip];
    if (layer.getBounds) {
      map.flyToBounds(layer.getBounds(), { padding: [40, 40], duration: 0.6 });
    } else if (layer.getLatLng) {
      map.flyTo(layer.getLatLng(), 13, { duration: 0.6 });
    }
    layer.openPopup();
  }

  // Highlight the table row and scroll it into view
  document.querySelectorAll('#tbody tr').forEach(tr => {
    tr.classList.toggle('active', tr.dataset.zip === zip);
  });
  const row = document.querySelector(`#tbody tr[data-zip="${zip}"]`);
  if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- Table rendering ----
function renderTable() {
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';

  // In multi-select mode show only selected ZIPs, otherwise apply search filter
  const q = searchQuery.toLowerCase();
  let rows;
  if (multiSelectMode) {
    rows = filtered.filter(z => multiSelected.has(z.zip));
  } else {
    rows = filtered.filter(z => {
      if (!q) return true;
      return z.zip.includes(q) ||
             z.city.toLowerCase().includes(q) ||
             z.county.toLowerCase().includes(q);
    });
  }

  // Recalculate display percentages relative to the selected subset
  let pctMap = null;
  if (multiSelectMode && rows.length) {
    const selPop = rows.reduce((s, z) => s + z.population, 0);
    pctMap = {};
    rows.forEach(z => { pctMap[z.zip] = selPop > 0 ? z.population / selPop * 100 : 0; });
  }

  // Sort
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  // Update search result count
  const countEl = document.getElementById('search-count');
  countEl.textContent = q ? `${rows.length} of ${filtered.length}` : '';

  const maxRowPct = rows.length ? Math.max(...rows.map(r => pctMap ? pctMap[r.zip] : r.currentPct), 0.0001) : 0.0001;

  // Build rows
  rows.forEach(z => {
    const tr = document.createElement('tr');
    tr.dataset.zip = z.zip;
    const displayPct = pctMap ? pctMap[z.zip] : z.currentPct;
    if (multiSelectMode ? multiSelected.has(z.zip) : z.zip === selectedZip) tr.classList.add('active');

    const barPct = ((displayPct / maxRowPct) * 100).toFixed(0);
    tr.innerHTML = `
      <td class="col-zip">${z.zip}</td>
      <td>${z.city}</td>
      <td>${z.county}</td>
      <td class="col-dist">${z.distanceMiles}</td>
      <td class="col-pop">${fmt(z.population)}</td>
      <td class="col-pct">
        <span class="pct-wrap">
          ${displayPct.toFixed(2)}%
          <span class="mini-bar-bg"><span class="mini-bar-fill" style="width:${barPct}%"></span></span>
        </span>
      </td>
    `;

    // Click list row → toggle multi-select, or normal fly/deselect
    tr.addEventListener('click', () => {
      if (multiSelectMode) toggleMultiSelectedZip(z.zip);
      else if (selectedZip === z.zip) deselectZip();
      else selectZip(z.zip, true);
    });
    tbody.appendChild(tr);
  });

  // Update sort arrows on column headers
  document.querySelectorAll('thead th').forEach(th => {
    const key = th.dataset.key;
    th.classList.toggle('sorted', key === sortKey);
    const arrow = th.querySelector('.arrow');
    if (key === sortKey) {
      arrow.textContent = sortDir === 1 ? '▲' : '▼';
    } else {
      arrow.textContent = '';
    }
  });
}

// ---- Event listeners ----

// Radius filter buttons
document.getElementById('radius-btns').addEventListener('click', e => {
  const btn = e.target.closest('.radius-btn');
  if (!btn) return;
  selectedZip = null;
  applyRadius(Number(btn.dataset.miles));
});

// Search input
document.getElementById('search').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  renderTable();
});

// Sortable column headers
document.querySelectorAll('thead th[data-key]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (sortKey === key) {
      sortDir *= -1;
    } else {
      sortKey = key;
      // Numbers default descending; strings default ascending
      sortDir = (key === 'zip' || key === 'city' || key === 'county') ? 1 : -1;
    }
    renderTable();
  });
});

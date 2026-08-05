// Global Map and Layer references
let map = null;
let mapDataGroup = null; // Holds survey stations, vectors, dots & route line
let geofenceLayer = null;
let customOverlayLayer = null;

// Global filter state for individual structural generations
let generationFilters = {
  S1: true,
  S2: true,
  S3: true,
  L1: true,
  L2: true,
  L3: true,
  OTHER: true
};

// ==========================================
// 1. HighPrecisionGPS Class
// ==========================================
class HighPrecisionGPS {
  constructor(onLocationUpdate, onError) {
    this.onLocationUpdate = onLocationUpdate;
    this.onError = onError;
    this.watchId = null;
    this.wakeLock = null;
    this.maxAcceptableAccuracyMeters = 15; 
    this.minMovementMeters = 2.5;          
    this.lastValidCoord = null;
  }

  async startTracking() {
    await this.requestWakeLock();
    const geoOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };

    if ('geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.processPosition(pos),
        (err) => { if (this.onError) this.onError(err); },
        geoOptions
      );
    }
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.releaseWakeLock();
  }

  processPosition(position) {
    const { latitude, longitude, accuracy, altitude } = position.coords;

    if (accuracy > this.maxAcceptableAccuracyMeters) return;

    if (this.lastValidCoord) {
      const dist = this.haversineDistance(
        this.lastValidCoord.lat, this.lastValidCoord.lon,
        latitude, longitude
      );
      if (dist < this.minMovementMeters) return;
    }

    this.lastValidCoord = { lat: latitude, lon: longitude };

    if (this.onLocationUpdate) {
      this.onLocationUpdate({ lat: latitude, lng: longitude, accuracy, altitude });
    }
  }

  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat1 - lat2) * Math.PI / 180;
    const dLon = (lon1 - lon2) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) { this.wakeLock.release().then(() => { this.wakeLock = null; }); }
  }
}

// ==========================================
// 2. Multi-Sample Spot Location Averaging
// ==========================================
async function getHighPrecisionSpotLocation(samplesCount = 5, intervalMs = 1000) {
  return new Promise((resolve) => {
    const samples = [];
    const geoOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 4000 };
    let count = 0;

    const timer = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          samples.push({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            altitude: pos.coords.altitude
          });
          count++;
          if (count >= samplesCount) {
            clearInterval(timer);
            resolve(calculateWeightedAverage(samples));
          }
        },
        (err) => console.warn('[GPS Sample] Failed sample fix:', err),
        geoOptions
      );
    }, intervalMs);
  });
}

function calculateWeightedAverage(samples) {
  let totalWeight = 0;
  let weightedLat = 0;
  let weightedLng = 0;
  let bestAccuracy = Infinity;

  samples.forEach((s) => {
    const weight = 1 / Math.pow(s.accuracy, 2);
    weightedLat += s.lat * weight;
    weightedLng += s.lng * weight;
    totalWeight += weight;
    if (s.accuracy < bestAccuracy) bestAccuracy = s.accuracy;
  });

  return {
    lat: weightedLat / totalWeight,
    lng: weightedLng / totalWeight,
    confidenceMarginMeters: bestAccuracy,
    sampleCount: samples.length
  };
}

// ==========================================
// 3. Map Controls & Structural Vector Logic
// ==========================================

/**
 * Extracts structural generation key (S1, S2, S3, L1, L2, L3, or OTHER)
 */
function getGenerationKey(type) {
  const code = (type || '').toString().trim().toUpperCase();
  if (code.includes('S1')) return 'S1';
  if (code.includes('S2')) return 'S2';
  if (code.includes('S3')) return 'S3';
  if (code.includes('L1')) return 'L1';
  if (code.includes('L2')) return 'L2';
  if (code.includes('L3')) return 'L3';
  return 'OTHER';
}

/**
 * Adds Station Display Dropdown and Generation Filter Checkboxes to top-right map overlay
 */
function initVectorToggleControl(mapInstance) {
  if (!mapInstance || mapInstance._vectorControlAdded) return;

  const VectorControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-control-layers leaflet-control');
      container.style.padding = '10px 12px';
      container.style.marginTop = '6px';
      container.style.background = '#ffffff';
      container.style.borderRadius = '6px';
      container.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
      container.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      container.style.fontSize = '12px';
      container.style.color = '#2c3e50';
      container.style.minWidth = '200px';

      container.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:6px;">
          <!-- Station Display Mode Dropdown -->
          <label for="displayModeSelect" style="font-weight:700; color:#1f3a5f;">Station Display:</label>
          <select id="displayModeSelect" onchange="updateMapDisplay()" style="cursor:pointer; padding:4px 6px; border-radius:4px; border:1px solid #ccc; font-size:12px; outline:none; margin-bottom:4px;">
            <option value="vector" selected>Vector Icons + Dip/Plunge</option>
            <option value="dot">Medium Station Dots</option>
            <option value="both">Both (Dots + Vectors)</option>
          </select>

          <!-- Collapsible Generation Filter Section -->
          <div style="border-top:1px solid #eee; padding-top:6px; margin-top:2px;">
            <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none;" onclick="toggleFilterPanel()">
              <strong style="color:#1f3a5f;">Filter Generations</strong>
              <span id="filterToggleIcon" style="font-size:10px; color:#7f8c8d; font-weight:bold;">[ − ]</span>
            </div>

            <div id="filterCheckboxContainer" style="display:grid; grid-template-columns: 1fr 1fr; gap:4px 8px; margin-top:6px;">
              <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="filter_S1" checked onchange="onGenFilterChange('S1', this.checked)"> <span style="color:#FF0000; font-weight:bold;">S1</span></label>
              <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="filter_L1" checked onchange="onGenFilterChange('L1', this.checked)"> <span style="color:#FF0000; font-weight:bold;">L1</span></label>

              <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="filter_S2" checked onchange="onGenFilterChange('S2', this.checked)"> <span style="color:#008000; font-weight:bold;">S2</span></label>
              <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="filter_L2" checked onchange="onGenFilterChange('L2', this.checked)"> <span style="color:#008000; font-weight:bold;">L2</span></label>

              <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="filter_S3" checked onchange="onGenFilterChange('S3', this.checked)"> <span style="color:#0000FF; font-weight:bold;">S3</span></label>
              <label style="display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="filter_L3" checked onchange="onGenFilterChange('L3', this.checked)"> <span style="color:#0000FF; font-weight:bold;">L3</span></label>

              <label style="display:flex; align-items:center; gap:4px; cursor:pointer; grid-column: span 2;"><input type="checkbox" id="filter_OTHER" checked onchange="onGenFilterChange('OTHER', this.checked)"> <span style="color:#000000; font-weight:bold;">Other Cleavage</span></label>
            </div>
          </div>
        </div>
      `;

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    }
  });

  new VectorControl().addTo(mapInstance);
  mapInstance._vectorControlAdded = true;
}

/**
 * Handles individual generation checkbox changes and triggers map redraw
 */
function onGenFilterChange(genKey, isChecked) {
  generationFilters[genKey] = isChecked;
  updateMapDisplay();
}

/**
 * Expands or collapses the generation filter checkbox panel
 */
function toggleFilterPanel() {
  const container = document.getElementById('filterCheckboxContainer');
  const icon = document.getElementById('filterToggleIcon');
  if (container) {
    if (container.style.display === 'none') {
      container.style.display = 'grid';
      if (icon) icon.textContent = '[ − ]';
    } else {
      container.style.display = 'none';
      if (icon) icon.textContent = '[ + ]';
    }
  }
}

/**
 * Adds an expandable Structural Color Legend to the bottom-right of the map
 */
function initLegendControl(mapInstance) {
  if (!mapInstance || mapInstance._legendControlAdded) return;

  const LegendControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-control-layers leaflet-control');
      container.style.padding = '8px 12px';
      container.style.background = '#ffffff';
      container.style.borderRadius = '6px';
      container.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
      container.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      container.style.fontSize = '12px';
      container.style.color = '#2c3e50';
      container.style.minWidth = '160px';

      container.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none;" onclick="toggleLegendVisibility()">
          <strong style="font-size:12px; color:#1f3a5f;">🗺️ Structural Legend</strong>
          <span id="legendToggleIcon" style="font-size:11px; color:#7f8c8d; font-weight:bold; margin-left:8px;">[ − ]</span>
        </div>
        <div id="legendContent" style="margin-top:8px; display:block;">
          <div style="font-weight:700; font-size:10px; text-transform:uppercase; color:#7f8c8d; margin-bottom:6px; border-bottom:1px solid #eee; padding-bottom:3px;">
            Generations (Planar & Linear)
          </div>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
            <span style="display:inline-block; width:12px; height:12px; background:#FF0000; border-radius:50%; border:1px solid rgba(0,0,0,0.15);"></span>
            <span><strong>S1 / L1</strong> (Red)</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
            <span style="display:inline-block; width:12px; height:12px; background:#008000; border-radius:50%; border:1px solid rgba(0,0,0,0.15);"></span>
            <span><strong>S2 / L2</strong> (Green)</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
            <span style="display:inline-block; width:12px; height:12px; background:#0000FF; border-radius:50%; border:1px solid rgba(0,0,0,0.15);"></span>
            <span><strong>S3 / L3</strong> (Blue)</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="display:inline-block; width:12px; height:12px; background:#000000; border-radius:50%; border:1px solid rgba(0,0,0,0.15);"></span>
            <span><strong>Other</strong> Cleavage/Foliation</span>
          </div>
        </div>
      `;

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    }
  });

  new LegendControl().addTo(mapInstance);
  mapInstance._legendControlAdded = true;
}

/**
 * Toggles the expanded/collapsed state of the Legend box
 */
function toggleLegendVisibility() {
  const content = document.getElementById('legendContent');
  const icon = document.getElementById('legendToggleIcon');
  if (content) {
    if (content.style.display === 'none') {
      content.style.display = 'block';
      if (icon) icon.textContent = '[ − ]';
    } else {
      content.style.display = 'none';
      if (icon) icon.textContent = '[ + ]';
    }
  }
}

/**
 * Assigns strict color codes based on structural feature generation
 */
function getStructureColor(type) {
  const code = (type || '').toString().trim().toUpperCase();

  // Red for S1 / L1
  if (code.includes('S1') || code.includes('L1')) {
    return '#FF0000';
  } 
  // Green for S2 / L2
  else if (code.includes('S2') || code.includes('L2')) {
    return '#008000';
  } 
  // Blue for S3 / L3
  else if (code.includes('S3') || code.includes('L3')) {
    return '#0000FF';
  } 

  // Black default for all other planar, linear, cleavage, or foliation features
  return '#000000';
}

/**
 * Checks if a feature type represents a linear measurement (Lineation / Fold axis)
 */
function isLinearFeature(type) {
  const t = (type || '').toString().toUpperCase();
  return t.startsWith('L') || t.includes('LINEATION') || t.includes('FOLD');
}

/**
 * Constructs a rotated SVG icon with horizontal numerical dip/plunge label
 */
function getStructuralSvgIcon(record) {
  const type = record.type || record.linType || 'Bedding';
  const color = getStructureColor(type);
  const isLinear = isLinearFeature(type);

  // Rotation and angle values
  const rotation = isLinear ? (record.trend || record.linTrend || 0) : (record.strike || 0);
  const angleValue = isLinear ? (record.plunge ?? record.linPlunge) : (record.dip);
  const labelText = (angleValue !== undefined && angleValue !== null && angleValue !== '') ? `${angleValue}°` : '';

  // SVG Symbol Paths: Arrow for Linear, Strike Line + Dip Tick for Planar
  const svgPath = isLinear
    ? `<path d="M12 20 L12 4 M7 9 L12 4 L17 9" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
    : `<path d="M3 12 L21 12 M12 12 L12 19" stroke="${color}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`;

  const html = `
    <div style="display: flex; align-items: center; width: 52px; height: 24px; position: relative;">
      <!-- Rotated Symbol -->
      <svg width="24" height="24" viewBox="0 0 24 24" style="transform: rotate(${rotation}deg); transform-origin: 12px 12px; flex-shrink: 0;">
        ${svgPath}
      </svg>
      <!-- Horizontal Dip/Plunge Numerical Label -->
      <span style="
        font-family: Arial, sans-serif;
        font-size: 11px;
        font-weight: bold;
        color: ${color};
        margin-left: 2px;
        text-shadow: 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;
        pointer-events: none;
        user-select: none;
        white-space: nowrap;
      ">${labelText}</span>
    </div>
  `;

  return L.divIcon({
    className: 'structural-labeled-icon',
    html: html,
    iconSize: [52, 24],
    iconAnchor: [12, 12]
  });
}

/**
 * Main map renderer: supports Vector, Station Dot, Combined Display Modes & Generation Filters
 */
function updateMapDisplay() {
  if (!map || !mapDataGroup) return;

  mapDataGroup.clearLayers();

  if (typeof records === 'undefined' || !Array.isArray(records)) return;

  const currentProj = (typeof activeProjectId !== 'undefined' && activeProjectId) ? activeProjectId : 'PROJ-001';
  
  // Filter records by project, map visibility, valid coordinates, AND generation checkbox states
  const visibleRecords = records.filter(r => {
    const isProjectValid = (r.projectId || 'PROJ-001') === currentProj;
    const isMapEnabled = r.showOnMap !== false;
    const hasValidCoords = r.lat && r.lon && !isNaN(parseFloat(r.lat)) && !isNaN(parseFloat(r.lon));

    // Check if generation type is currently active in filters
    const genKey = getGenerationKey(r.type || r.linType);
    const isGenActive = generationFilters[genKey] !== false;

    return isProjectValid && isMapEnabled && hasValidCoords && isGenActive;
  });

  if (visibleRecords.length === 0) return;

  const displaySelectEl = document.getElementById('displayModeSelect');
  const displayMode = displaySelectEl ? displaySelectEl.value : 'vector'; // Options: 'vector', 'dot', 'both'

  const routeCoordinates = [];

  visibleRecords.forEach((r) => {
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    const latlng = [lat, lon];
    routeCoordinates.push(latlng);

    const color = getStructureColor(r.type || r.linType);
    let marker;

    // Mode 1: Medium Station Dots
    if (displayMode === 'dot') {
      marker = L.circleMarker(latlng, {
        radius: 6,
        fillColor: color,
        color: '#ffffff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.9
      });
    } 
    // Mode 2: Vector Structural Icons with Numerical Angle Labels
    else if (displayMode === 'vector') {
      marker = L.marker(latlng, { icon: getStructuralSvgIcon(r) });
    } 
    // Mode 3: Both (Station Dots with Vector Icons overlay)
    else if (displayMode === 'both') {
      const dotMarker = L.circleMarker(latlng, {
        radius: 5,
        fillColor: color,
        color: '#ffffff',
        weight: 1,
        fillOpacity: 1
      });
      const vectorMarker = L.marker(latlng, { icon: getStructuralSvgIcon(r) });
      marker = L.layerGroup([dotMarker, vectorMarker]);
    }

    const safeEscape = (typeof escapeHTML === 'function') ? escapeHTML : (s => s || '');

    const popupHtml = `
      <div style="font-family: system-ui, -apple-system, sans-serif; font-size: 13px; line-height: 1.4; max-width: 240px;">
        <div style="font-weight: bold; font-size: 14px; color: #2c3e50; border-bottom: 1px solid #dcdfe6; padding-bottom: 4px; margin-bottom: 6px;">
          📍 Station: ${safeEscape(r.locNo || 'N/A')}
        </div>
        <div style="margin-bottom: 4px;"><b>Attitude:</b> ${safeEscape(r.formatted || r.type || r.linType || 'N/A')}</div>
        ${r.unit ? `<div style="margin-bottom: 4px;"><b>Formation/Unit:</b> ${safeEscape(r.unit)}</div>` : ''}
        ${r.lith ? `<div style="margin-bottom: 4px;"><b>Lithology:</b> ${safeEscape(r.lith)}</div>` : ''}
        ${r.sample ? `<div style="margin-bottom: 4px;"><b>Sample ID:</b> <span style="background: #e1f5fe; color: #0288d1; padding: 2px 6px; border-radius: 4px; font-weight: bold;">${safeEscape(r.sample)}</span></div>` : ''}
        ${r.remarks ? `<div style="margin-top: 6px; font-style: italic; background: #f8f9fa; padding: 6px; border-radius: 4px; font-size: 12px; border: 1px solid #e9ecef;">${safeEscape(r.remarks)}</div>` : ''}
        <div style="margin-top: 8px; font-size: 11px; color: #7f8c8d; border-top: 1px dashed #eee; padding-top: 4px;">
          Lat: ${lat.toFixed(5)}, Lon: ${lon.toFixed(5)} ${r.alt ? '| Alt: ' + safeEscape(r.alt) + 'm' : ''}
        </div>
      </div>
    `;

    marker.bindPopup(popupHtml);
    mapDataGroup.addLayer(marker);
  });

  // Traverse Line between stations
  if (routeCoordinates.length > 1) {
    const routeLine = L.polyline(routeCoordinates, {
      color: '#e74c3c',
      weight: 2,
      dashArray: '5, 7',
      opacity: 0.65
    });
    mapDataGroup.addLayer(routeLine);
  }
}

// ==========================================
// 4. Spatial Map Modal & Overlays
// ==========================================

function renderSpatialMapWithGeofence(event) {
  if (event) event.preventDefault();

  if (!map) {
    openSpatialMap();
  }

  const minLat = parseFloat(document.getElementById('gfMinLat')?.value);
  const maxLat = parseFloat(document.getElementById('gfMaxLat')?.value);
  const minLon = parseFloat(document.getElementById('gfMinLon')?.value);
  const maxLon = parseFloat(document.getElementById('gfMaxLon')?.value);

  if (isNaN(minLat) || isNaN(maxLat) || isNaN(minLon) || isNaN(maxLon)) {
    alert("Please enter valid numeric coordinates for all 4 Geofence inputs.");
    return;
  }

  if (geofenceLayer && map) {
    map.removeLayer(geofenceLayer);
  }

  const bounds = [[minLat, minLon], [maxLat, maxLon]];

  geofenceLayer = L.rectangle(bounds, {
    color: '#e63946',
    weight: 2,
    fillOpacity: 0.15
  }).addTo(map);

  map.fitBounds(bounds);
}

function applyCustomMapOverlay() {
  if (!map) {
    openSpatialMap();
  }

  const fileInput = document.getElementById('customMapFile');
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    alert("Please select an image file (PNG/JPG) first.");
    return;
  }

  const minLat = parseFloat(document.getElementById('ovMinLat')?.value);
  const maxLat = parseFloat(document.getElementById('ovMaxLat')?.value);
  const minLon = parseFloat(document.getElementById('ovMinLon')?.value);
  const maxLon = parseFloat(document.getElementById('ovMaxLon')?.value);

  if (isNaN(minLat) || isNaN(maxLat) || isNaN(minLon) || isNaN(maxLon)) {
    alert("Please enter valid SW/NE coordinates (Min Lat, Max Lat, Min Lon, Max Lon) for image georeferencing.");
    return;
  }

  const file = fileInput.files[0];
  const imageUrl = URL.createObjectURL(file);
  const bounds = [[minLat, minLon], [maxLat, maxLon]];

  if (customOverlayLayer && map) {
    map.removeLayer(customOverlayLayer);
  }

  customOverlayLayer = L.imageOverlay(imageUrl, bounds, {
    opacity: 0.8,
    interactive: true
  }).addTo(map);

  map.fitBounds(bounds);
}

function removeCustomMapOverlay() {
  if (customOverlayLayer && map) {
    map.removeLayer(customOverlayLayer);
    customOverlayLayer = null;
  }
}

function openSpatialMap() {
  const modal = document.getElementById('mapModal');
  if (modal) modal.style.display = 'block';

  if (!map) {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    mapDataGroup = L.layerGroup().addTo(map);
    initVectorToggleControl(map);
    initLegendControl(map);
  }

  setTimeout(() => {
    if (map) map.invalidateSize();
    updateMapDisplay();
  }, 200);
}

function closeSpatialMap() {
  const modal = document.getElementById('mapModal');
  if (modal) modal.style.display = 'none';
}

// ==========================================
// 5. App Initialization & Service Worker Registration
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('[PWA] Service Worker Registered'))
      .catch((err) => console.error('[PWA] Service Worker Error:', err));
  }

  // Auto-initialize map instance if #map container exists on page load
  const mapElement = document.getElementById('map');
  if (mapElement && !map) {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    mapDataGroup = L.layerGroup().addTo(map);
    initVectorToggleControl(map);
    initLegendControl(map);
  }

  let userMarker = null;
  let accuracyCircle = null;

  const gpsTracker = new HighPrecisionGPS(
    (coords) => {
      const { lat, lng, accuracy } = coords;

      if (map) {
        if (!userMarker) {
          userMarker = L.marker([lat, lng]).addTo(map);
          accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#1f3a5f', fillOpacity: 0.15 }).addTo(map);
          map.setView([lat, lng], 17);
        } else {
          userMarker.setLatLng([lat, lng]);
          accuracyCircle.setLatLng([lat, lng]);
          accuracyCircle.setRadius(accuracy);
        }
      }
    },
    (err) => console.error('GPS Error:', err.message)
  );

  gpsTracker.startTracking();
});

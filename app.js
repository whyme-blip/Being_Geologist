// Global Map and Layer references
let map = null;
let mapDataGroup = null; // Holds survey stations, vectors, dots & route line
let geofenceLayer = null;
let customOverlayLayer = null;

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
 * Adds the Vector/Dot toggle checkbox directly into the top-right map controls overlay
 */
function initVectorToggleControl(mapInstance) {
  if (!mapInstance || mapInstance._vectorControlAdded) return;

  const VectorControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-control-layers leaflet-control');
      container.style.padding = '8px 10px';
      container.style.marginTop = '6px';

      container.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:12px; font-weight:600; color:#333; margin:0;">
          <input type="checkbox" id="showVectors" checked onchange="updateMapDisplay()" style="cursor:pointer;">
          Structural Vectors (Strike/Dip)
        </label>
      `;

      L.DomEvent.disableClickPropagation(container);
      return container;
    }
  });

  new VectorControl().addTo(mapInstance);
  mapInstance._vectorControlAdded = true;
}

/**
 * Color mapping for structural measurement dots when vectors are toggled off
 */
function getStructureColor(type) {
  const structType = type || '';
  if (structType.includes('Foliation') || structType.includes('S1') || structType.includes('S2')) {
    return '#e67e22'; // Orange
  } else if (structType.includes('Joint')) {
    return '#27ae60'; // Green
  } else if (structType.includes('Fault') || structType.includes('Shear')) {
    return '#c0392b'; // Red
  } else if (structType.includes('Bedding') || structType.includes('S0')) {
    return '#2980b9'; // Blue
  } else if (structType.includes('Lineation') || structType.includes('Fold')) {
    return '#8e44ad'; // Purple
  }
  return '#2c3e50'; // Slate default
}

/**
 * Main map renderer: renders either vector symbols or circle dots based on checkbox status
 */
function updateMapDisplay() {
  if (!map || !mapDataGroup) return;

  mapDataGroup.clearLayers();

  if (typeof records === 'undefined' || !Array.isArray(records)) return;

  const currentProj = (typeof activeProjectId !== 'undefined' && activeProjectId) ? activeProjectId : 'PROJ-001';
  const visibleRecords = records.filter(r => 
    (r.projectId || 'PROJ-001') === currentProj && 
    r.showOnMap !== false &&
    r.lat && r.lon && 
    !isNaN(parseFloat(r.lat)) && !isNaN(parseFloat(r.lon))
  );

  if (visibleRecords.length === 0) return;

  const vectorToggleEl = document.getElementById('showVectors');
  const showVectors = vectorToggleEl ? vectorToggleEl.checked : true;

  const routeCoordinates = [];

  visibleRecords.forEach((r) => {
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    const latlng = [lat, lon];
    routeCoordinates.push(latlng);

    let marker;

    if (showVectors) {
      // 1. Draw SVG Structural Vector Symbols
      let markerIcon;
      const checkLinear = (typeof isLinear === 'function') ? isLinear(r.type) : false;

      if (checkLinear || (r.trend && r.plunge && !r.strike)) {
        markerIcon = (typeof getLinearSvgIcon === 'function') 
          ? getLinearSvgIcon(r.trend || r.linTrend, r.plunge || r.linPlunge, r.type || r.linType)
          : null;
      } else {
        markerIcon = (typeof getPlanarSvgIcon === 'function')
          ? getPlanarSvgIcon(r.strike, r.dip, r.type || 'Bedding')
          : null;
      }

      if (markerIcon) {
        marker = L.marker(latlng, { icon: markerIcon });
      } else {
        // Standard fallback marker if SVG helpers aren't loaded
        marker = L.marker(latlng);
      }
    } else {
      // 2. Draw Simple Color-Coded Dots
      const dotColor = getStructureColor(r.type);
      marker = L.circleMarker(latlng, {
        radius: 6,
        fillColor: dotColor,
        color: '#ffffff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.9
      });
    }

    const safeEscape = (typeof escapeHTML === 'function') ? escapeHTML : (s => s || '');

    const popupHtml = `
      <div style="font-family: system-ui, -apple-system, sans-serif; font-size: 13px; line-height: 1.4; max-width: 240px;">
        <div style="font-weight: bold; font-size: 14px; color: #2c3e50; border-bottom: 1px solid #dcdfe6; padding-bottom: 4px; margin-bottom: 6px;">
          📍 Station: ${safeEscape(r.locNo || 'N/A')}
        </div>
        <div style="margin-bottom: 4px;"><b>Attitude:</b> ${safeEscape(r.formatted || r.type || 'N/A')}</div>
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

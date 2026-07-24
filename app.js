// Global Map and Layer references
let map = null;
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

/**
 * Draws geofence box using Min/Max Lat/Lon inputs
 */
function renderSpatialMapWithGeofence(event) {
  if (event) event.preventDefault();

  if (!map) {
    openSpatialMap(); // Fallback open if map isn't initialized
  }

  const minLat = parseFloat(document.getElementById('gfMinLat')?.value);
  const maxLat = parseFloat(document.getElementById('gfMaxLat')?.value);
  const minLon = parseFloat(document.getElementById('gfMinLon')?.value);
  const maxLon = parseFloat(document.getElementById('gfMaxLon')?.value);

  if (isNaN(minLat) || isNaN(maxLat) || isNaN(minLon) || isNaN(maxLon)) {
    alert("Please enter valid numeric coordinates for all 4 Geofence inputs.");
    return;
  }

  // Remove existing geofence box if present
  if (geofenceLayer && map) {
    map.removeLayer(geofenceLayer);
  }

  const bounds = [[minLat, minLon], [maxLat, maxLon]];
  geofenceLayer = L.rectangle(bounds, { color: '#e63946', weight: 2, fillOpacity: 0.15 }).addTo(map);
  map.fitBounds(bounds);
}
/**
 * Loads uploaded PNG/JPG topo or satellite image onto the map canvas
 */
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

  // Create browser blob URL from selected file
  const file = fileInput.files[0];
  const imageUrl = URL.createObjectURL(file);
  const bounds = [[minLat, minLon], [maxLat, maxLon]];

  // Remove existing image overlay if present
  if (customOverlayLayer && map) {
    map.removeLayer(customOverlayLayer);
  }

  // Add raster image overlay to Leaflet
  customOverlayLayer = L.imageOverlay(imageUrl, bounds, { opacity: 0.8 }).addTo(map);
  map.fitBounds(bounds);
}

function removeCustomMapOverlay() {
  if (customOverlayLayer && map) {
    map.removeLayer(customOverlayLayer);
    customOverlayLayer = null;
    alert("Map overlay removed.");
  }
}

/**
 * Opens the map modal and ensures Leaflet calculates container dimensions properly
 */
function openSpatialMap() {
  const modal = document.getElementById('mapModal');
  if (modal) modal.style.display = 'block';

  // Initialize Leaflet map if it hasn't been created yet
  if (!map) {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);
  }

  // CRITICAL: Force Leaflet to recalculate size after modal becomes visible
  setTimeout(() => {
    if (map) map.invalidateSize();
  }, 200);
}

function closeSpatialMap() {
  const modal = document.getElementById('mapModal');
  if (modal) modal.style.display = 'none';
}
// ==========================================
// 3. App Initialization & Service Worker Registration
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // Register Service Worker for offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('[PWA] Service Worker Registered'))
      .catch((err) => console.error('[PWA] Service Worker Error:', err));
  }

  // Initialize Map & GPS Tracker
  const map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

  let userMarker = null;
  let accuracyCircle = null;

  const gpsTracker = new HighPrecisionGPS(
    (coords) => {
      const { lat, lng, accuracy } = coords;

      if (!userMarker) {
        userMarker = L.marker([lat, lng]).addTo(map);
        accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#1f3a5f', fillOpacity: 0.15 }).addTo(map);
        map.setView([lat, lng], 17);
      } else {
        userMarker.setLatLng([lat, lng]);
        accuracyCircle.setLatLng([lat, lng]);
        accuracyCircle.setRadius(accuracy);
      }
    },
    (err) => console.error('GPS Error:', err.message)
  );

  gpsTracker.startTracking();
});

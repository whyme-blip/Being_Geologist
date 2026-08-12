// ==========================================
// GLOBAL STATE & MAP HANDLES
// ==========================================
let records = JSON.parse(localStorage.getItem('structuralRecords') || '[]');
let activeProjectId = localStorage.getItem('activeProjectId') || 'PROJ-001';

let mapInstance = null;
let mapDataGroup = null;
let osmTileLayer = null;
let layerControl = null;
let kmlMapOverlayLayer = null;
let customOverlayLayer = null;
let currentOverlayUrl = null;
let vectorSymbolsLayer = null;

const ids = ['locNo', 'strike', 'dip', 'type', 'trend', 'plunge', 'lith', 'unit', 'remarks'];

// ==========================================
// 1. CORE GEOLOGICAL HELPERS
// ==========================================
function isLinear(typeStr) {
  const t = (typeStr || '').toLowerCase();
  return t.includes('lineation') || t.includes('fold') || t.includes('axis') || t.includes('striae') || t.includes('slickenside');
}

function getQuadrant(azimuth) {
  const az = (parseFloat(azimuth) % 360 + 360) % 360;
  if (isNaN(az)) return '';
  if (az >= 337.5 || az < 22.5) return 'N';
  if (az >= 22.5 && az < 67.5) return 'NE';
  if (az >= 67.5 && az < 112.5) return 'E';
  if (az >= 112.5 && az < 157.5) return 'SE';
  if (az >= 157.5 && az < 202.5) return 'S';
  if (az >= 202.5 && az < 247.5) return 'SW';
  if (az >= 247.5 && az < 292.5) return 'W';
  if (az >= 292.5 && az < 337.5) return 'NW';
  return '';
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

// ==========================================
// 2. STRUCTURAL PREVIEW & CALCULATION UTILITIES
// ==========================================
function updatePreview() {
  const previewEl = document.getElementById('preview');
  if (!previewEl) return;

  const structType = val('type');
  if (isLinear(structType)) {
    const trend = val('trend');
    const plunge = val('plunge');
    previewEl.value = (trend && plunge) ? `${plunge}° → ${trend.padStart(3, '0')}° (${getQuadrant(trend)})` : '';
  } else {
    const strike = val('strike');
    const dip = val('dip');
    if (strike && dip) {
      const dd = (parseInt(strike, 10) + 90) % 360;
      previewEl.value = `${strike.padStart(3, '0')}°/${dip.padStart(2, '0')}° (Dip Dir: ${dd.toString().padStart(3, '0')}° ${getQuadrant(dd)})`;
    } else {
      previewEl.value = '';
    }
  }
}

function updatePitchFromOptions() {
  // Optional helper to adjust pitch calculations relative to strike inputs
}

function calculateLineationFromPitch() {
  const strike = parseFloat(val('strike'));
  const dip = parseFloat(val('dip'));
  const rake = parseFloat(val('pitchRake'));
  const pitchFrom = val('pitchFrom'); // 'strike' or 'opposite'

  if (isNaN(strike) || isNaN(dip) || isNaN(rake)) return;

  const dipRad = (dip * Math.PI) / 180;
  const rakeRad = (rake * Math.PI) / 180;

  // True plunge calculation: sin(plunge) = sin(dip) * sin(rake)
  const sinPlunge = Math.sin(dipRad) * Math.sin(rakeRad);
  const plungeDeg = Math.round((Math.asin(sinPlunge) * 180) / Math.PI);

  // Apparent angle along strike plane: cos(beta) = cos(rake) / cos(plunge)
  const cosPlunge = Math.cos((plungeDeg * Math.PI) / 180);
  const betaDeg = cosPlunge !== 0 ? (Math.acos(Math.cos(rakeRad) / cosPlunge) * 180) / Math.PI : 0;

  let trendDeg = (pitchFrom === 'opposite')
    ? (strike + 180 - betaDeg + 360) % 360
    : (strike + betaDeg + 360) % 360;

  trendDeg = Math.round(trendDeg);

  const trendEl = document.getElementById('trend');
  const plungeEl = document.getElementById('plunge');
  if (trendEl) trendEl.value = trendDeg.toString().padStart(3, '0');
  if (plungeEl) plungeEl.value = plungeDeg.toString().padStart(2, '0');

  updatePreview();
}

// ==========================================
// 3. COUNTER & LOCATION IDENTIFIER UTILITIES
// ==========================================
function handleLocModeChange() {
  const modeEl = document.getElementById('locCountMode');
  const locNoInput = document.getElementById('locNo');
  if (!modeEl || !locNoInput) return;

  const mode = modeEl.value;

  if (mode === 'manual') {
    if (confirm("Do you really want to manually enter the location number?")) {
      locNoInput.readOnly = false;
      locNoInput.focus();
      locNoInput.select();
    } else {
      modeEl.value = 'continue';
    }
  } else if (mode === 'reset') {
    if (confirm("Do you really want to reset the counter to 0?")) {
      locNoInput.readOnly = true;
      localStorage.setItem('locationCounter', '0');
      updateLocationID();
    } else {
      modeEl.value = 'continue';
    }
  } else {
    locNoInput.readOnly = true;
    if (records.length > 0) {
      const latestRecord = records.reduce((latest, current) => (current.id > latest.id ? current : latest), records[0]);
      const lastLocStr = latestRecord.locNo ? String(latestRecord.locNo) : '';
      const matches = lastLocStr.match(/\d+$/);
      const lastNum = matches ? parseInt(matches[0], 10) : NaN;
      localStorage.setItem('locationCounter', isNaN(lastNum) ? 1 : lastNum + 1);
    } else {
      localStorage.setItem('locationCounter', '1');
    }
    updateLocationID();
  }
}

function updateLocationID() {
  const modeEl = document.getElementById('locCountMode');
  const locNoEl = document.getElementById('locNo');
  if (!modeEl || !locNoEl) return;

  if (modeEl.value !== 'manual') {
    const prefix = document.getElementById('locPrefix')?.value || 'JU';
    const num = parseInt(localStorage.getItem('locationCounter') || '1', 10);
    locNoEl.value = prefix + '-' + String(num).padStart(3, '0');
  }
}

function toggleSampleState() {
  const takeSampleEl = document.getElementById('takeSample');
  if (!takeSampleEl) return;

  const isChecked = takeSampleEl.checked;
  const sampleType = document.getElementById('sampleType');
  const samplePrefix = document.getElementById('samplePrefix');
  const sampleCounterBtn = document.getElementById('sampleCounterBtn');

  if (sampleType) sampleType.disabled = !isChecked;
  if (samplePrefix) samplePrefix.disabled = !isChecked;
  if (sampleCounterBtn) sampleCounterBtn.disabled = !isChecked;
  updateSampleID();
}

function updateSampleID() {
  const takeSampleEl = document.getElementById('takeSample');
  const sampleInput = document.getElementById('sample');
  if (!takeSampleEl || !sampleInput) return;

  if (takeSampleEl.checked) {
    const prefix = document.getElementById('samplePrefix')?.value || 'DD';
    const num = parseInt(localStorage.getItem('sampleCounter') || '1', 10);
    sampleInput.value = prefix + '-' + String(num).padStart(3, '0');
  } else {
    sampleInput.value = 'No Sample Collected';
  }
}

function setSampleCounter() {
  const userInput = prompt("Enter the next starting sample number sequence (e.g., 2 for 002, 5 for 005):");
  if (userInput === null) return;

  const parsedNum = parseInt(userInput.replace(/^\D+/g, ''), 10);
  if (isNaN(parsedNum) || parsedNum < 0) {
    alert("Please enter a valid numeric value (0 or higher).");
    return;
  }

  localStorage.setItem('sampleCounter', parsedNum);
  updateSampleID();
  updatePreview();
  alert(`Sample tracking updated! The next saved entry will use sequence number: ${parsedNum}`);
}

// ==========================================
// 4. DYNAMIC SVG SYMBOL GENERATORS FOR LEAFLET
// ==========================================
function getPlanarSvgIcon(strike, dip, type) {
  const strikeDeg = parseFloat(strike) || 0;
  const dipVal = (dip !== undefined && dip !== '') ? dip : '';
  const structColor = getStructureColor(type);

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <g transform="rotate(${strikeDeg}, 20, 20)">
        <line x1="6" y1="20" x2="34" y2="20" stroke="${structColor}" stroke-width="3" stroke-linecap="round" />
        <line x1="20" y1="20" x2="20" y2="28" stroke="${structColor}" stroke-width="2.5" stroke-linecap="round" />
        <circle cx="20" cy="20" r="2" fill="${structColor}" />
      </g>
      <text x="24" y="14" font-size="11" font-weight="bold" fill="${structColor}" font-family="monospace">${dipVal}</text>
    </svg>
  `;

  return L.divIcon({
    html: svg,
    className: 'geo-svg-marker',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -10]
  });
}

function getLinearSvgIcon(trend, plunge, type) {
  const trendDeg = parseFloat(trend) || 0;
  const plungeVal = (plunge !== undefined && plunge !== '') ? plunge : '';
  const strokeColor = getStructureColor(type || 'Lineation');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <g transform="rotate(${trendDeg}, 20, 20)">
        <line x1="20" y1="32" x2="20" y2="8" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" />
        <path d="M 15 14 L 20 6 L 25 14" fill="none" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="20" cy="20" r="2" fill="${strokeColor}" />
      </g>
      <text x="24" y="34" font-size="11" font-weight="bold" fill="${strokeColor}" font-family="monospace">${plungeVal}°</text>
    </svg>
  `;

  return L.divIcon({
    html: svg,
    className: 'geo-svg-marker',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -10]
  });
}

function getStructureColor(type) {
  const structType = type || '';
  if (structType.includes('Foliation') || structType.includes('S1') || structType.includes('S2')) return '#e67e22'; // Orange
  if (structType.includes('Joint')) return '#27ae60'; // Green
  if (structType.includes('Fault') || structType.includes('Shear')) return '#c0392b'; // Red
  if (structType.includes('Bedding') || structType.includes('S0')) return '#2980b9'; // Blue
  if (structType.includes('Lineation') || structType.includes('Fold')) return '#8e44ad'; // Purple
  return '#2c3e50'; // Slate
}

// ==========================================
// 5. SPATIAL MAP & OVERLAY UTILITIES
// ==========================================
// ==========================================
// SPATIAL MAP & LAYER CONTROL MANAGEMENT
// ==========================================
function openSpatialMap() {
  const modal = document.getElementById('mapModal');
  if (modal) modal.style.display = 'block';

  setTimeout(() => {
    // 1. Coordinates check
    const validPoints = records.filter(r => r.lat && r.lon && !isNaN(parseFloat(r.lat)) && !isNaN(parseFloat(r.lon)));
    const firstLat = validPoints.length > 0 ? parseFloat(validPoints[0].lat) : 30.0;
    const firstLon = validPoints.length > 0 ? parseFloat(validPoints[0].lon) : 78.0;

    // 2. Instantiate Layer Groups if null
    if (!mapDataGroup) mapDataGroup = L.layerGroup();
    if (!vectorSymbolsLayer) vectorSymbolsLayer = L.layerGroup();

    // 3. Initialize Leaflet Map Instance
    if (!mapInstance) {
      mapInstance = L.map('map').setView([firstLat, firstLon], 13);

      osmTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
      }).addTo(mapInstance);

      mapDataGroup.addTo(mapInstance);
      vectorSymbolsLayer.addTo(mapInstance); // Active/Checked by default

      // Listen for toggle events in the Leaflet Layer Control
      mapInstance.on('overlayadd overlayremove', (e) => {
        if (e.layer === vectorSymbolsLayer) {
          updateMapDisplay();
        }
      });
    } else {
      mapInstance.invalidateSize();
    }

    // 4. Clear existing Layer Control panel to prevent duplicate controls
    if (layerControl && mapInstance) {
      try {
        mapInstance.removeControl(layerControl);
      } catch (err) {
        console.warn('[Leaflet] Clearing old layer control instance');
      }
    }

    // 5. Define Layer Options
    const baseMaps = {
      "OpenStreetMap (Standard)": osmTileLayer
    };

    const overlayMaps = {
      "Survey Stations & Route": mapDataGroup,
      "📐 Display Vector Symbols": vectorSymbolsLayer
    };

    if (kmlMapOverlayLayer) {
      overlayMaps["🌍 KML Map Overlay"] = kmlMapOverlayLayer;
    }
    if (customOverlayLayer) {
      overlayMaps["🗺️ Custom Map Image"] = customOverlayLayer;
    }

    // 6. Assign directly to the global `layerControl` variable
    layerControl = L.control.layers(baseMaps, overlayMaps, { 
      position: 'topright', 
      collapsed: false 
    }).addTo(mapInstance);

    mapInstance.locate({ setView: false, enableHighAccuracy: true });
    updateMapDisplay();
  }, 100);
}
function closeSpatialMap() {
  const modal = document.getElementById('mapModal');
  if (modal) modal.style.display = 'none';
}

function updateMapDisplay() {
  if (!mapInstance || !mapDataGroup) return;

  // 1. Clear existing station markers from map
  mapDataGroup.clearLayers();

  // 2. Read state of the UI checkbox
  const vectorCheckbox = document.getElementById('toggleVectorSymbols');
  const showVectors = vectorCheckbox ? vectorCheckbox.checked : true;

  // 3. Filter active records with valid coordinates
  const visibleMapRecords = records.filter(r =>
    (r.projectId || 'PROJ-001') === activeProjectId &&
    r.showOnMap !== false &&
    r.lat && r.lon &&
    !isNaN(parseFloat(r.lat)) && !isNaN(parseFloat(r.lon))
  );

  if (visibleMapRecords.length === 0) return;

  const routeCoordinates = [];

  visibleMapRecords.forEach((r) => {
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    const latlng = [lat, lon];
    routeCoordinates.push(latlng);

    let marker;

    if (showVectors) {
      // 📐 VECTOR SYMBOL MODE (Strike/Dip or Trend/Plunge)
      const checkLinear = (typeof isLinear === 'function') ? isLinear(r.type) : false;
      if (checkLinear || (r.trend && r.plunge && !r.strike)) {
        marker = L.marker(latlng, { 
          icon: getLinearSvgIcon(r.trend || r.linTrend, r.plunge || r.linPlunge, r.type || r.linType) 
        });
      } else {
        marker = L.marker(latlng, { 
          icon: getPlanarSvgIcon(r.strike, r.dip, r.type || 'Bedding') 
        });
      }
    } else {
      // 🔴 STATION DOT MODE (Simple Circle Marker)
      const dotColor = (typeof getStructureColor === 'function') ? getStructureColor(r.type) : '#e74c3c';
      marker = L.circleMarker(latlng, {
        radius: 7,
        fillColor: dotColor,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9
      });
    }

    // Popup information
    const popupHtml = `
      <div style="font-family: system-ui, sans-serif; font-size: 13px; line-height: 1.4; max-width: 220px;">
        <div style="font-weight: bold; font-size: 14px; color: #1f3a5f; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-bottom: 6px;">
          📍 Station: ${escapeHTML(r.locNo || 'N/A')}
        </div>
        <div><b>Attitude:</b> ${escapeHTML(r.formatted || r.type || 'N/A')}</div>
        ${r.unit ? `<div><b>Unit:</b> ${escapeHTML(r.unit)}</div>` : ''}
        ${r.lith ? `<div><b>Lithology:</b> ${escapeHTML(r.lith)}</div>` : ''}
      </div>
    `;

    marker.bindPopup(popupHtml);
    mapDataGroup.addLayer(marker);
  });

  // 4. Draw dashed traverse route line between points
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

function kmlToGeoJson(xmlDoc) {
  const features = [];
  const placemarks = xmlDoc.getElementsByTagName("Placemark");

  for (let i = 0; i < placemarks.length; i++) {
    const pm = placemarks[i];
    const name = pm.getElementsByTagName("name")[0]?.textContent || `KML Feature ${i + 1}`;
    const desc = pm.getElementsByTagName("description")[0]?.textContent || "";

    const point = pm.getElementsByTagName("Point")[0];
    if (point) {
      const coords = point.getElementsByTagName("coordinates")[0]?.textContent.trim().split(',');
      if (coords && coords.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [parseFloat(coords[0]), parseFloat(coords[1])] },
          properties: { name, desc }
        });
      }
    }

    const line = pm.getElementsByTagName("LineString")[0];
    if (line) {
      const coordsText = line.getElementsByTagName("coordinates")[0]?.textContent.trim();
      if (coordsText) {
        const lineCoords = coordsText.split(/\s+/).map(p => {
          const parts = p.split(',');
          return [parseFloat(parts[0]), parseFloat(parts[1])];
        }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));

        if (lineCoords.length > 0) {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: lineCoords },
            properties: { name, desc }
          });
        }
      }
    }

    const poly = pm.getElementsByTagName("Polygon")[0];
    if (poly) {
      const coordsText = poly.getElementsByTagName("coordinates")[0]?.textContent.trim();
      if (coordsText) {
        const ringCoords = coordsText.split(/\s+/).map(p => {
          const parts = p.split(',');
          return [parseFloat(parts[0]), parseFloat(parts[1])];
        }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));

        if (ringCoords.length > 0) {
          features.push({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [ringCoords] },
            properties: { name, desc }
          });
        }
      }
    }
  }
  return { type: "FeatureCollection", features };
}

function applyKMLOverlay() {
  const fileInput = document.getElementById('kmlOverlayFile');
  const file = fileInput ? fileInput.files[0] : null;

  if (!file) {
    alert("Please select a .kml file first.");
    return;
  }
  if (!mapInstance) {
    alert("Please open the Field Map first.");
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(e.target.result, "text/xml");
      const geojson = kmlToGeoJson(xmlDoc);

      if (geojson.features.length === 0) {
        alert("No visible geometries found in KML.");
        return;
      }

      removeKMLOverlay(false);

      kmlMapOverlayLayer = L.geoJSON(geojson, {
        style: { color: '#8e44ad', weight: 3, opacity: 0.85, fillOpacity: 0.25 },
        pointToLayer: function (feature, latlng) {
          return L.circleMarker(latlng, { radius: 6, fillColor: '#8e44ad', color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 0.9 });
        },
        onEachFeature: function (feature, layer) {
          if (feature.properties && feature.properties.name) {
            layer.bindPopup(`<b>${feature.properties.name}</b><br>${feature.properties.desc || ''}`);
          }
        }
      }).addTo(mapInstance);

      if (layerControl) layerControl.addOverlay(kmlMapOverlayLayer, "🌍 KML Map Overlay");
      if (kmlMapOverlayLayer.getBounds().isValid()) mapInstance.fitBounds(kmlMapOverlayLayer.getBounds());

      alert("KML Map Layer overlaid successfully!");
    } catch (err) {
      alert("Error overlaying KML: " + err.message);
    }
  };
  reader.readAsText(file);
}

function removeKMLOverlay(showAlert = true) {
  if (kmlMapOverlayLayer && mapInstance) {
    if (layerControl) layerControl.removeLayer(kmlMapOverlayLayer);
    mapInstance.removeLayer(kmlMapOverlayLayer);
    kmlMapOverlayLayer = null;

    const fileInput = document.getElementById('kmlOverlayFile');
    if (fileInput) fileInput.value = '';

    if (showAlert) alert("KML Map Overlay removed!");
  } else if (showAlert) {
    alert("No active KML overlay to remove.");
  }
}

function applyCustomMapOverlay() {
  const fileInput = document.getElementById('customMapFile');
  const file = fileInput ? fileInput.files[0] : null;

  if (!file) {
    alert('Please select an image file (JPEG/PNG) of your map first.');
    return;
  }

  let minLat = parseFloat(document.getElementById('ovMinLat')?.value);
  let maxLat = parseFloat(document.getElementById('ovMaxLat')?.value);
  let minLon = parseFloat(document.getElementById('ovMinLon')?.value);
  let maxLon = parseFloat(document.getElementById('ovMaxLon')?.value);

  if (isNaN(minLat) || isNaN(maxLat) || isNaN(minLon) || isNaN(maxLon)) {
    alert('Please provide valid bounding coordinates (SW & NE corners) for the image overlay.');
    return;
  }

  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];

  const bounds = [[minLat, minLon], [maxLat, maxLon]];
  removeCustomMapOverlay();

  currentOverlayUrl = URL.createObjectURL(file);
  customOverlayLayer = L.imageOverlay(currentOverlayUrl, bounds, { opacity: 0.85, interactive: true }).addTo(mapInstance);

  if (layerControl) layerControl.addOverlay(customOverlayLayer, "Custom Map Overlay");
  mapInstance.fitBounds(bounds);
  alert('Custom map overlay loaded successfully!');
}

function removeCustomMapOverlay() {
  if (customOverlayLayer && mapInstance) {
    if (layerControl) layerControl.removeLayer(customOverlayLayer);
    mapInstance.removeLayer(customOverlayLayer);
    customOverlayLayer = null;
  }
  if (currentOverlayUrl) {
    URL.revokeObjectURL(currentOverlayUrl);
    currentOverlayUrl = null;
  }
}

function renderSpatialMapWithGeofence(e) {
  if (e && e.preventDefault) e.preventDefault();

  if (!mapInstance) {
    alert("Map instance not found. Please open the spatial map modal first.");
    return;
  }

  const minLat = parseFloat(document.getElementById('gfMinLat')?.value);
  const maxLat = parseFloat(document.getElementById('gfMaxLat')?.value);
  const minLon = parseFloat(document.getElementById('gfMinLon')?.value);
  const maxLon = parseFloat(document.getElementById('gfMaxLon')?.value);

  if (isNaN(minLat) || isNaN(maxLat) || isNaN(minLon) || isNaN(maxLon)) {
    alert("Please enter valid numeric values for all 4 coordinates.");
    return;
  }

  if (minLat >= maxLat || minLon >= maxLon) {
    alert("Min Lat/Lon must be strictly smaller than Max Lat/Lon!");
    return;
  }

  updateMapDisplay();
}

function toggleMapRecord(id, isChecked) {
  const rec = records.find(r => r.id === id);
  if (rec) {
    rec.showOnMap = isChecked;
    localStorage.setItem('structuralRecords', JSON.stringify(records));
    updateMapDisplay();
  }
}

function toggleAllMapRecords(isChecked) {
  records.forEach(r => {
    if ((r.projectId || 'PROJ-001') === activeProjectId) r.showOnMap = isChecked;
  });
  localStorage.setItem('structuralRecords', JSON.stringify(records));
  updateMapDisplay();
}

function toggleSelectAllMap(isChecked) {
  toggleAllMapRecords(isChecked);
}

// ==========================================
// 6. DOM EVENT LISTENERS & SW REGISTRATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  const dateEl = document.getElementById('date');
  if (dateEl && !dateEl.value) dateEl.valueAsDate = new Date();

  // Attach live preview updates across field inputs
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updatePreview);
  });

  const typeEl = document.getElementById('type');
  if (typeEl) {
    typeEl.addEventListener('change', function () {
      const customDiv = document.getElementById('customStructureDiv');
      if (customDiv) customDiv.classList.toggle('hidden', this.value !== 'Other');

      const planar = document.getElementById('planarFields');
      const linear = document.getElementById('linearFields');
      if (isLinear(this.value)) {
        if (planar) planar.classList.add('hidden');
        if (linear) linear.classList.remove('hidden');
      } else {
        if (planar) planar.classList.remove('hidden');
        if (linear) linear.classList.add('hidden');
      }
      updatePreview();
    });
  }

  const strikeEl = document.getElementById('strike');
  if (strikeEl) {
    strikeEl.addEventListener('input', function () {
      const strike = parseInt(this.value, 10);
      const dipdirEl = document.getElementById('dipdir');
      if (!isNaN(strike)) {
        const dipdir = (strike + 90) % 360;
        if (dipdirEl) dipdirEl.value = dipdir.toString().padStart(3, '0') + '° (' + getQuadrant(dipdir) + ')';
      } else {
        if (dipdirEl) dipdirEl.value = '';
      }
      calculateLineationFromPitch();
    });
  }

  const dipEl = document.getElementById('dip');
  if (dipEl) dipEl.addEventListener('input', calculateLineationFromPitch);

  const samplePrefixEl = document.getElementById('samplePrefix');
  if (samplePrefixEl) {
    samplePrefixEl.addEventListener('input', function () {
      this.value = this.value.toUpperCase();
      updateSampleID();
    });
  }

  const locPrefixEl = document.getElementById('locPrefix');
  if (locPrefixEl) {
    locPrefixEl.addEventListener('input', function () {
      this.value = this.value.toUpperCase();
      updateLocationID();
    });
  }

  toggleSampleState();
  updateLocationID();
  updatePreview();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          installingWorker.onstatechange = () => {
            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
              if (confirm('New structural updates available! Reload app to apply?')) {
                window.location.reload();
              }
            }
          };
        };
      })
      .catch(err => console.error('Service Worker registration failed:', err));
  });
}

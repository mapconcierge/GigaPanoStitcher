// =========================================================
// GigaPanoStitcher — Leaflet map + draggable camera marker
// =========================================================
// All coordinates are WGS84 (EPSG:4326); Leaflet renders in
// Web Mercator (EPSG:3857) internally.

import { DEFAULT_LOCATION, DEFAULT_ZOOM, LOCATED_ZOOM } from './config.js';
import { state, setLocation, on } from './state.js';

/* global L */

let map;
let cameraMarker;

const readout = document.getElementById('coords-readout');
const geolocateBtn = document.getElementById('geolocate-btn');

const SOURCE_LABEL = {
  default: 'default: Tokyo Station',
  exif: 'from Exif GPS',
  geolocation: 'from browser Geolocation',
  user: 'set manually',
};

function renderReadout() {
  const { lat, lng } = state.location;
  readout.textContent =
    `${lat.toFixed(6)}, ${lng.toFixed(6)} (${SOURCE_LABEL[state.locationSource]})`;
}

export function initMap() {
  map = L.map('map', { zoomControl: true })
    .setView([DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lng], DEFAULT_ZOOM);

  // OSM standard layer — ODbL, attribution required
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Draggable camera icon
  const cameraIcon = L.divIcon({
    className: 'camera-marker',
    html: '📷',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

  cameraMarker = L.marker([DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lng], {
    icon: cameraIcon,
    draggable: true,
    title: 'Shooting location — drag to adjust',
  }).addTo(map);

  cameraMarker.on('dragend', () => {
    const { lat, lng } = cameraMarker.getLatLng();
    setLocation(lat, lng, 'user');
  });

  // External location changes (Exif in Phase 3, Geolocation below)
  on('location', ({ lat, lng, source }) => {
    cameraMarker.setLatLng([lat, lng]);
    if (source !== 'user') map.setView([lat, lng], LOCATED_ZOOM);
    renderReadout();
  });

  // "My location" button → browser Geolocation
  geolocateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      readout.textContent = 'Geolocation is not available in this browser.';
      return;
    }
    geolocateBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation(pos.coords.latitude, pos.coords.longitude, 'geolocation');
        geolocateBtn.disabled = false;
      },
      () => {
        readout.textContent = 'Could not get your location (permission denied?).';
        geolocateBtn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  renderReadout();
}

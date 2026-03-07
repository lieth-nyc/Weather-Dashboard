const GEO_API     = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

const LS_TABS   = 'wdash_tabs_v1';
const LS_ACTIVE = 'wdash_active_v1';
const LS_UNIT   = 'wdash_unit_v1';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const DEFAULT_TABS = [
  { id: 'default_nyc',        name: 'New York',    admin1: 'New York', country: 'United States', latitude: 40.71427, longitude: -74.00597 },
  { id: 'default_stonybrook', name: 'Stony Brook',  admin1: 'New York', country: 'United States', latitude: 40.9315,  longitude: -73.1409  },
  { id: 'default_chicago',    name: 'Chicago',      admin1: 'Illinois', country: 'United States', latitude: 41.87811, longitude: -87.62980 },
];

const WMO_CODES = {
  0:  { label: 'Clear sky',            icon: '☀️' },
  1:  { label: 'Mainly clear',         icon: '🌤️' },
  2:  { label: 'Partly cloudy',        icon: '⛅' },
  3:  { label: 'Overcast',             icon: '☁️' },
  45: { label: 'Foggy',                icon: '🌫️' },
  48: { label: 'Icy fog',              icon: '🌫️' },
  51: { label: 'Light drizzle',        icon: '🌦️' },
  53: { label: 'Moderate drizzle',     icon: '🌦️' },
  55: { label: 'Dense drizzle',        icon: '🌧️' },
  61: { label: 'Slight rain',          icon: '🌧️' },
  63: { label: 'Moderate rain',        icon: '🌧️' },
  65: { label: 'Heavy rain',           icon: '🌧️' },
  71: { label: 'Slight snow',          icon: '🌨️' },
  73: { label: 'Moderate snow',        icon: '🌨️' },
  75: { label: 'Heavy snow',           icon: '❄️' },
  77: { label: 'Snow grains',          icon: '🌨️' },
  80: { label: 'Slight showers',       icon: '🌦️' },
  81: { label: 'Moderate showers',     icon: '🌧️' },
  82: { label: 'Violent showers',      icon: '⛈️' },
  85: { label: 'Slight snow showers',  icon: '🌨️' },
  86: { label: 'Heavy snow showers',   icon: '❄️' },
  95: { label: 'Thunderstorm',         icon: '⛈️' },
  96: { label: 'Thunderstorm w/ hail', icon: '⛈️' },
  99: { label: 'Thunderstorm w/ hail', icon: '⛈️' },
};

// ── State ─────────────────────────────────────────────────────────────────────

let tabs        = [];
let activeTabId = null;
let currentUnit = 'C';
const weatherCache = {};  // { tabId: { data, timestamp } }
let debounceTimer  = null;
let temperatureChart = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const getWMO = code => WMO_CODES[code] || { label: 'Unknown', icon: '🌡️' };
const toF    = c    => c * 9/5 + 32;
const dispTemp = c  => currentUnit === 'C' ? `${Math.round(c)}°C` : `${Math.round(toF(c))}°F`;

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(dateStr) {
  const d        = new Date(dateStr + 'T12:00:00');
  const today    = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString())    return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long' });
}

function setLocalTime(timezone) {
  const now     = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: timezone });
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone });
  document.getElementById('local-time').textContent = `${dateStr} · ${timeStr}`;
}

function generateId() {
  return 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    const storedTabs = localStorage.getItem(LS_TABS);
    if (storedTabs) {
      const parsed = JSON.parse(storedTabs);
      if (Array.isArray(parsed) && parsed.length > 0) {
        tabs = parsed;
        const storedActive = localStorage.getItem(LS_ACTIVE);
        activeTabId = tabs.find(t => t.id === storedActive) ? storedActive : tabs[0].id;
        currentUnit = localStorage.getItem(LS_UNIT) || 'C';
        return;
      }
    }
  } catch (_) {}
  // Defaults
  tabs        = DEFAULT_TABS.map(t => ({ ...t }));
  activeTabId = tabs[0].id;
  currentUnit = 'C';
}

function saveState() {
  localStorage.setItem(LS_TABS,   JSON.stringify(tabs));
  localStorage.setItem(LS_ACTIVE, activeTabId);
  localStorage.setItem(LS_UNIT,   currentUnit);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showLoading() {
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('main-content').classList.add('hidden');
  document.getElementById('error-msg').classList.add('hidden');
}

function showError(msg) {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('main-content').classList.add('hidden');
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showContent() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('error-msg').classList.add('hidden');
  document.getElementById('main-content').classList.remove('hidden');
}

// ── Render chart ─────────────────────────────────────────────────────────────

function renderChart(hourly) {
  const nowMs = Date.now();

  // Build 48-hour window starting from the current hour
  const labels = [], temps = [], feelsLike = [];
  for (let i = 0; i < hourly.time.length && labels.length < 48; i++) {
    if (new Date(hourly.time[i]).getTime() < nowMs - 3_600_000) continue;
    labels.push(new Date(hourly.time[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    temps.push(currentUnit === 'C' ? hourly.temperature_2m[i] : toF(hourly.temperature_2m[i]));
    feelsLike.push(currentUnit === 'C' ? hourly.apparent_temperature[i] : toF(hourly.apparent_temperature[i]));
  }

  const canvas = document.getElementById('temp-chart');
  const ctx    = canvas.getContext('2d');

  // Gradient fill for temperature line
  const gradFill = ctx.createLinearGradient(0, 0, 0, canvas.offsetHeight || 220);
  gradFill.addColorStop(0, 'rgba(14, 165, 233, 0.25)');
  gradFill.addColorStop(1, 'rgba(14, 165, 233, 0.0)');

  if (temperatureChart) {
    temperatureChart.destroy();
    temperatureChart = null;
  }

  temperatureChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Temperature',
          data: temps,
          borderColor: '#38bdf8',
          backgroundColor: gradFill,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#38bdf8',
          tension: 0.4,
          fill: true,
        },
        {
          label: 'Feels Like',
          data: feelsLike,
          borderColor: '#f472b6',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#f472b6',
          tension: 0.4,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: '#94a3b8',
            font: { size: 12 },
            boxWidth: 14,
            padding: 16,
            usePointStyle: true,
            pointStyleWidth: 14,
          },
        },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: '#334155',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          padding: 10,
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}${currentUnit === 'C' ? '°C' : '°F'}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { size: 11 },
            maxRotation: 0,
            maxTicksLimit: 12,
          },
          grid: { color: 'rgba(51, 65, 85, 0.6)' },
          border: { color: '#334155' },
        },
        y: {
          ticks: {
            color: '#64748b',
            font: { size: 11 },
            callback: v => `${Math.round(v)}${currentUnit === 'C' ? '°C' : '°F'}`,
          },
          grid: { color: 'rgba(51, 65, 85, 0.6)' },
          border: { color: '#334155' },
        },
      },
    },
  });
}

// ── Render weather ────────────────────────────────────────────────────────────

function renderWeather(data, tab) {
  const c      = data.current;
  const daily  = data.daily;
  const hourly = data.hourly;

  // Location header
  const nameParts = [tab.name, tab.admin1, tab.country].filter(Boolean);
  document.getElementById('city-name').textContent = nameParts.join(', ');
  setLocalTime(data.timezone);

  // Current conditions
  const wmo = getWMO(c.weather_code);
  document.getElementById('current-icon').textContent        = wmo.icon;
  document.getElementById('current-temp').textContent        = dispTemp(c.temperature_2m);
  document.getElementById('current-description').textContent = wmo.label;
  document.getElementById('feels-like').textContent          = dispTemp(c.apparent_temperature);
  document.getElementById('humidity').textContent            = `${c.relative_humidity_2m}%`;
  document.getElementById('wind-speed').textContent          = `${c.wind_speed_10m} km/h`;
  document.getElementById('uv-index').textContent            = c.uv_index ?? '—';
  document.getElementById('sunrise').textContent             = daily.sunrise[0] ? formatTime(daily.sunrise[0]) : '—';
  document.getElementById('sunset').textContent              = daily.sunset[0]  ? formatTime(daily.sunset[0])  : '—';

  // Sync unit buttons
  document.querySelectorAll('.unit-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.unit === currentUnit)
  );

  // Hourly (next 24 h)
  const nowMs      = Date.now();
  const hourlyList = document.getElementById('hourly-list');
  hourlyList.innerHTML = '';
  let shown = 0;
  for (let i = 0; i < hourly.time.length && shown < 24; i++) {
    const tMs = new Date(hourly.time[i]).getTime();
    if (tMs < nowMs - 3_600_000) continue;
    const isNow = shown === 0;
    const div   = document.createElement('div');
    div.className = 'hourly-item' + (isNow ? ' now' : '');
    const label  = new Date(hourly.time[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const precip = hourly.precipitation_probability[i];
    div.innerHTML = `
      <span class="hourly-time">${isNow ? 'Now' : label}</span>
      <span class="hourly-icon">${getWMO(hourly.weather_code[i]).icon}</span>
      <span class="hourly-temp">${dispTemp(hourly.temperature_2m[i])}</span>
      ${precip > 0 ? `<span class="hourly-precip">💧 ${precip}%</span>` : ''}
    `;
    hourlyList.appendChild(div);
    shown++;
  }

  // 7-day forecast
  const forecastList = document.getElementById('forecast-list');
  forecastList.innerHTML = '';
  for (let i = 0; i < daily.time.length; i++) {
    const wmoD = getWMO(daily.weather_code[i]);
    const div  = document.createElement('div');
    div.className = 'forecast-item';
    div.innerHTML = `
      <span class="forecast-day">${formatDay(daily.time[i])}</span>
      <div class="forecast-icon-desc">
        <span class="forecast-icon">${wmoD.icon}</span>
        <span class="forecast-desc">${wmoD.label}</span>
      </div>
      <div class="forecast-temps">
        <span class="temp-max">${dispTemp(daily.temperature_2m_max[i])}</span>
        <span class="temp-min">${dispTemp(daily.temperature_2m_min[i])}</span>
      </div>
    `;
    forecastList.appendChild(div);
  }

  renderChart(hourly);
  showContent();
}

// ── Fetch weather ─────────────────────────────────────────────────────────────

async function fetchWeatherForTab(tab) {
  const cached = weatherCache[tab.id];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    renderWeather(cached.data, tab);
    return;
  }
  showLoading();
  const params = new URLSearchParams({
    latitude:     tab.latitude,
    longitude:    tab.longitude,
    current:      'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,uv_index',
    hourly:       'temperature_2m,apparent_temperature,weather_code,precipitation_probability',
    daily:        'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset',
    timezone:     'auto',
    forecast_days: 7,
  });
  try {
    const res  = await fetch(`${WEATHER_API}?${params}`);
    if (!res.ok) throw new Error('Weather data unavailable');
    const data = await res.json();
    weatherCache[tab.id] = { data, timestamp: Date.now() };
    renderWeather(data, tab);
  } catch (e) {
    showError(`Failed to load weather: ${e.message}`);
  }
}

// ── Tab management ────────────────────────────────────────────────────────────

function renderTabs() {
  const bar = document.getElementById('tabs-bar');
  bar.innerHTML = '';
  tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    btn.type = 'button';

    const label = document.createElement('span');
    label.textContent = tab.name;
    btn.appendChild(label);

    if (tabs.length > 1) {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = `Remove ${tab.name}`;
      close.addEventListener('click', e => { e.stopPropagation(); deleteTab(tab.id); });
      btn.appendChild(close);
    }

    btn.addEventListener('click', () => switchTab(tab.id));
    bar.appendChild(btn);
  });
}

function switchTab(id) {
  if (activeTabId === id) return;
  activeTabId = id;
  saveState();
  renderTabs();
  const tab = tabs.find(t => t.id === id);
  if (tab) fetchWeatherForTab(tab);
}

function addTab(locationObj) {
  // Deduplicate by rounded lat/lon
  const dup = tabs.find(t =>
    Math.abs(t.latitude  - locationObj.latitude)  < 0.01 &&
    Math.abs(t.longitude - locationObj.longitude) < 0.01
  );
  if (dup) { switchTab(dup.id); closeAddPanel(); return; }

  const tab = {
    id:        generateId(),
    name:      locationObj.name,
    admin1:    locationObj.admin1   || '',
    country:   locationObj.country  || '',
    latitude:  locationObj.latitude,
    longitude: locationObj.longitude,
  };
  tabs.push(tab);
  saveState();
  renderTabs();
  closeAddPanel();
  switchTab(tab.id);
}

function deleteTab(id) {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex(t => t.id === id);
  tabs.splice(idx, 1);
  delete weatherCache[id];
  if (activeTabId === id) {
    activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
  }
  saveState();
  renderTabs();
  const active = tabs.find(t => t.id === activeTabId);
  if (active) fetchWeatherForTab(active);
}

// ── Add city panel ────────────────────────────────────────────────────────────

function openAddPanel() {
  const panel = document.getElementById('add-city-panel');
  panel.classList.remove('hidden');
  document.getElementById('add-city-input').value = '';
  document.getElementById('add-city-suggestions').classList.add('hidden');
  document.getElementById('add-city-input').focus();
}

function closeAddPanel() {
  document.getElementById('add-city-panel').classList.add('hidden');
  document.getElementById('add-city-suggestions').classList.add('hidden');
}

async function geocode(query) {
  if (!query.trim()) return [];
  const params = new URLSearchParams({ name: query, count: 6, language: 'en', format: 'json' });
  try {
    const res  = await fetch(`${GEO_API}?${params}`);
    const data = await res.json();
    return data.results || [];
  } catch (_) { return []; }
}

function showAddSuggestions(results) {
  const sugEl = document.getElementById('add-city-suggestions');
  sugEl.innerHTML = '';
  if (!results.length) { sugEl.classList.add('hidden'); return; }
  results.forEach(r => {
    const div   = document.createElement('div');
    div.className = 'suggestion-item';
    const parts = [r.name, r.admin1, r.country].filter(Boolean);
    div.innerHTML = `${r.name}<span class="country"> — ${parts.slice(1).join(', ')}</span>`;
    div.addEventListener('click', () => addTab(r));
    sugEl.appendChild(div);
  });
  sugEl.classList.remove('hidden');
}

// ── Events ────────────────────────────────────────────────────────────────────

document.getElementById('add-tab-btn').addEventListener('click', openAddPanel);
document.getElementById('add-city-close-btn').addEventListener('click', closeAddPanel);

document.getElementById('add-city-input').addEventListener('input', e => {
  clearTimeout(debounceTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { document.getElementById('add-city-suggestions').classList.add('hidden'); return; }
  debounceTimer = setTimeout(async () => {
    const results = await geocode(q);
    showAddSuggestions(results);
  }, 300);
});

document.getElementById('add-city-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAddPanel();
});

document.getElementById('add-city-location-btn').addEventListener('click', () => {
  if (!navigator.geolocation) { showError('Geolocation not supported by your browser.'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => addTab({ name: 'My Location', admin1: '', country: '', latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
    err => showError(`Location error: ${err.message}`)
  );
});

// Close panel when clicking outside it
document.addEventListener('click', e => {
  const panel  = document.getElementById('add-city-panel');
  const addBtn = document.getElementById('add-tab-btn');
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== addBtn) {
    closeAddPanel();
  }
});

// Unit toggle
document.querySelectorAll('.unit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const unit = btn.dataset.unit;
    if (currentUnit === unit) return;
    currentUnit = unit;
    saveState();
    document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b.dataset.unit === unit));
    const active = tabs.find(t => t.id === activeTabId);
    if (active) {
      const cached = weatherCache[activeTabId];
      if (cached) renderWeather(cached.data, active);
      else fetchWeatherForTab(active);
    }
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadState();
renderTabs();
const initialTab = tabs.find(t => t.id === activeTabId);
if (initialTab) fetchWeatherForTab(initialTab);

#!/usr/bin/env node
/**
 * DisplayBoard — Self-contained Raspberry Pi server (port 3000).
 *
 * Serves:
 *   - Dashboard UI            (/, /index.html)
 *   - Admin panel             (/admin.html, PIN-gated)
 *   - First-run welcome       (/ when config.location is still the default)
 *   - Static assets           (photos, icons, css, fonts)
 *
 * Caches in background:
 *   - Calendar events via calendar-all.js (every 5 min)
 *   - Weather via open-meteo.com          (every 15 min)
 *
 * Control endpoints cover WiFi (scan/connect/status), display (power,
 * resolution, orientation), system (hostname, logs, reboot), and in-place
 * updates pulled from GitHub Releases.
 *
 * AP-mode fallback: if scripts/ap-fallback.sh cannot bring WiFi up at boot,
 * it writes /tmp/displayboard-ap-mode; this server then treats every hostname
 * as a captive-portal redirect to the admin panel at 192.168.4.1.
 */

// ─── Imports ─────────────────────────────────────────────────────────────────
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { execSync, exec: execAsync } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────
const PORT = 3000;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PHOTOS_DIR = path.join(__dirname, 'photos');
const CALENDAR_CACHE_FILE = path.join(__dirname, '.calendar-cache.json');
const WEATHER_CACHE_FILE = path.join(__dirname, '.weather-cache.json');
const WIFI_PENDING_FILE = path.join(__dirname, 'wifi-pending.json');
const BACKUP_DIR = path.join(__dirname, '.backup');

const AP_MODE_FLAG = '/tmp/displayboard-ap-mode';
const AP_STATUS_FILE = '/tmp/displayboard-ap-status.json';
const AP_SCAN_FILE = '/tmp/displayboard-wifi-networks.json';

// Environment required to reach the Wayland compositor started by labwc under
// the `pi` user. Needed for every wlr-randr invocation.
const WLR_ENV = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';

// The version cached at import time drives the /api/version-info compare; the
// file itself is re-read during checkForUpdates so we also see post-update state.
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '1.0.0'; }
  catch (_) { return '1.0.0'; }
})();

console.log(`📦 DisplayBoard v${VERSION}`);

// ─── Console timestamping ────────────────────────────────────────────────────
// PM2 ships its own timestamps, but the admin-panel log viewer tails raw files
// so we prefix log lines here too. Local time in EST matches the dashboard.
const origLog = console.log, origErr = console.error;
function ts() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
console.log = (...args) => origLog(`[${ts()}]`, ...args);
console.error = (...args) => origErr(`[${ts()}]`, ...args);

// ─── Config load + persistence ───────────────────────────────────────────────
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
let configVersion = 1; // bumped on config/asset change — dashboard polls this to hot-reload

function saveConfigFile() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Default blocks for first boot / fresh config
if (!config.updates) {
  config.updates = { autoUpdate: false, autoUpdateHour: 3, lastCheck: null, lastUpdate: null };
  saveConfigFile();
}
if (!config.adminPin) {
  config.adminPin = '123456';
  saveConfigFile();
  console.log('🔐 Default admin PIN set: 123456 — change it in the admin panel!');
} else {
  console.log('🔐 Admin PIN: ' + config.adminPin);
}

// "Unconfigured" = the sample location from config.example.json is still in place.
function isFirstRun() {
  const loc = config.location || {};
  return !loc.name || loc.name === 'Your City, State' || loc.name === 'Your City, ST';
}

function reloadConfig() {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  configVersion++;
  // Re-arm the night-mode/auto-update scheduler — toggles from the admin panel
  // should take effect without a server restart.
  scheduleNightMode();
  console.log('Configuration reloaded (version ' + configVersion + ')');
}

// Watch config + served assets so browser tabs auto-reload on edit.
function watchForChanges() {
  const files = ['config.json', 'index.html', 'style.css', 'dashboard.js', 'display-enhancements.js'];
  for (const file of files) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) continue;
    fs.watchFile(filePath, { interval: 2000 }, (curr, prev) => {
      if (curr.mtime <= prev.mtime) return;
      console.log(file + ' changed, bumping version');
      if (file === 'config.json') {
        try { reloadConfig(); } catch (e) { console.error('Config reload error:', e.message); }
      } else {
        configVersion++;
      }
    });
  }
}
watchForChanges();

// ─── HTTP helpers ────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Collect a request body into a string. Handlers call JSON.parse themselves so
// they control how to respond on parse failure.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Authorization: Bearer <adminPin>. Writes a 401 on failure and returns false,
// so callers can `if (!requireAuth(req, res)) return;`.
function requireAuth(req, res) {
  const pin = config.adminPin;
  if (!pin) return true;
  if (req.headers.authorization === `Bearer ${pin}`) return true;
  sendJSON(res, 401, { error: 'Unauthorized. PIN required.' });
  return false;
}

function isAuthenticated(req) {
  const pin = config.adminPin;
  return !pin || req.headers.authorization === `Bearer ${pin}`;
}

// ─── Static file serving ─────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : decodeURIComponent(url.parse(req.url).pathname));
  filePath = path.resolve(filePath);
  // Path traversal protection — refuse anything outside the project directory.
  if (!filePath.startsWith(path.resolve(__dirname))) {
    res.writeHead(403); return res.end('Forbidden');
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    // HTML/JS/CSS change on updates — keep them uncached so the browser picks up new assets.
    const noCache = ['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

// ─── Outbound HTTP helpers ───────────────────────────────────────────────────
function httpGet(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const req = lib.get(reqUrl, {
      timeout: options.timeout || 15000,
      headers: options.headers || {}
    }, (res) => {
      if (options.binary) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      } else {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Download to disk, following 301/302 redirects. Used by the in-place updater.
function httpDownload(reqUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const lib = reqUrl.startsWith('https') ? https : http;
    const req = lib.get(reqUrl, { timeout: 60000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(destPath);
        return httpDownload(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', (err) => { try { fs.unlinkSync(destPath); } catch(_) {} reject(err); });
    req.on('timeout', () => { req.destroy(); try { fs.unlinkSync(destPath); } catch(_) {} reject(new Error('timeout')); });
    file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch(_) {} reject(err); });
  });
}

// ─── Weather (open-meteo, cached) ────────────────────────────────────────────
// WMO weather codes → icon filename + human label.
// Reference: https://open-meteo.com/en/docs (weather_code)
function getWeatherIcon(code) {
  const icons = {
    0:'clear-day',1:'partly-cloudy-day',2:'partly-cloudy-day',3:'overcast',
    45:'fog',48:'fog',51:'drizzle',53:'drizzle',55:'rain',
    61:'rain',63:'rain',65:'extreme-rain',71:'snow',73:'snow',75:'heavy-snow',
    77:'sleet',80:'partly-cloudy-day-rain',81:'rain',82:'extreme-rain',
    85:'partly-cloudy-day-snow',86:'snow-wind',95:'thunderstorms-rain',96:'hail',99:'thunderstorms-rain'
  };
  return '/icons/' + (icons[code] || 'cloudy') + '.svg';
}
function getWeatherText(code) {
  const texts = {
    0:'Clear',1:'Mostly Clear',2:'Partly Cloudy',3:'Overcast',
    45:'Fog',48:'Fog',51:'Drizzle',53:'Drizzle',55:'Drizzle',
    61:'Rain',63:'Rain',65:'Heavy Rain',71:'Snow',73:'Snow',75:'Heavy Snow',77:'Snow',
    80:'Showers',81:'Showers',82:'Heavy Showers',85:'Snow',86:'Heavy Snow',
    95:'Storm',96:'Storm',99:'Storm'
  };
  return texts[code] || 'Cloudy';
}

function formatTime(isoTime) {
  const d = new Date(isoTime);
  let h = d.getHours(); const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${d.getMinutes().toString().padStart(2,'0')}${ap}`;
}

// Approximate moon phase (0 = new, 4 = full). Close enough for a home display.
function getMoonPhase(date) {
  let y = date.getFullYear(), m = date.getMonth() + 1;
  const d = date.getDate();
  if (m < 3) { y--; m += 12; } ++m;
  const jd = (365.25*y + 30.6*m + d - 694039.09) / 29.5305882;
  const frac = jd - Math.floor(jd);
  const idx = Math.round(frac * 27) % 28;
  const names = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  return { name: names[Math.round(frac*8)%8], icon: 'wi-moon-'+idx, phase: idx };
}

let weatherCache = null;
let weatherUpdating = false;
try { weatherCache = JSON.parse(fs.readFileSync(WEATHER_CACHE_FILE, 'utf8')); console.log('🌤️  Loaded cached weather'); } catch (_) {}

async function updateWeatherCache() {
  if (weatherUpdating) return;
  weatherUpdating = true;
  try {
    const { latitude: LAT, longitude: LON, timezone: TZ } = config.location;
    const raw = await httpGet(
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=${TZ}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,sunrise,sunset` +
      `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,relativehumidity_2m`
    );
    const data = JSON.parse(raw);
    if (!data.current || !data.daily) throw new Error('Invalid weather response');
    const moon = getMoonPhase(new Date());
    const current = {
      temp: Math.round(data.current.temperature_2m),
      feelsLike: Math.round(data.current.apparent_temperature),
      wind: Math.round(data.current.windspeed_10m) + ' mph',
      humidity: Math.round(data.current.relativehumidity_2m) + '%',
      sunrise: formatTime(data.daily.sunrise[0]),
      sunset: formatTime(data.daily.sunset[0]),
      moonPhase: moon.name,
      moonIcon: moon.icon
    };
    const forecast = [];
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const today = new Date().getDay();
    for (let i = 0; i < 5; i++) {
      forecast.push({
        label: i === 0 ? 'Today' : dayNames[(today + i) % 7],
        icon: getWeatherIcon(data.daily.weathercode[i]),
        text: getWeatherText(data.daily.weathercode[i]),
        precip: data.daily.precipitation_probability_max[i] || 0,
        high: Math.round(data.daily.temperature_2m_max[i]),
        low: Math.round(data.daily.temperature_2m_min[i])
      });
    }
    weatherCache = { current, forecast, lastUpdated: Date.now() };
    console.log('🌤️  Weather cache updated');
    try { fs.writeFileSync(WEATHER_CACHE_FILE, JSON.stringify(weatherCache)); } catch (_) {}
  } catch (err) {
    console.error('Weather cache update error:', err.message);
  } finally {
    weatherUpdating = false;
  }
}

function handleWeatherExtended(req, res) {
  if (weatherCache) return sendJSON(res, 200, weatherCache);
  sendJSON(res, 503, { error: 'Weather data not yet available' });
}

// ─── Calendar cache (background-refreshed via calendar-all.js) ───────────────
let calendarCache = { events: [], lastUpdated: 0 };
let calendarUpdating = false;
try {
  calendarCache = JSON.parse(fs.readFileSync(CALENDAR_CACHE_FILE, 'utf8'));
  console.log('📅 Loaded cached calendar: ' + (calendarCache.events?.length || 0) + ' events');
} catch (_) {}

function updateCalendarCache() {
  if (calendarUpdating) return;
  calendarUpdating = true;
  // +2 days so that filtering past events on the client still leaves N full days.
  const days = (config.display?.calendarDays || 5) + 2;
  const calScript = path.join(__dirname, 'calendar-all.js');
  execAsync(`node "${calScript}" ${days} "${CONFIG_PATH}" --json`, { timeout: 120000 }, (err, stdout) => {
    calendarUpdating = false;
    if (err) return console.error('Calendar cache update error:', err.message);
    try {
      calendarCache = JSON.parse(stdout);
      calendarCache.lastUpdated = Date.now();
      console.log(`📅 Calendar cache updated: ${calendarCache.events?.length || 0} events`);
      try { fs.writeFileSync(CALENDAR_CACHE_FILE, JSON.stringify(calendarCache)); } catch (_) {}
    } catch (e) { console.error('Calendar parse error:', e.message); }
  });
}

function handleCalendar(req, res) {
  sendJSON(res, 200, calendarCache);
}

function handleRefreshCalendar(req, res) {
  if (!requireAuth(req, res)) return;
  updateCalendarCache();
  sendJSON(res, 200, { ok: true, message: 'Calendar refresh started' });
}

function handleClearCache(req, res) {
  if (!requireAuth(req, res)) return;
  try { fs.unlinkSync(CALENDAR_CACHE_FILE); } catch (_) {}
  calendarCache = { events: [], lastUpdated: 0 };
  sendJSON(res, 200, { ok: true });
}

// Kick off initial + periodic cache updates.
setTimeout(updateWeatherCache, 3000);
setInterval(updateWeatherCache, 15 * 60 * 1000);
setTimeout(updateCalendarCache, 2000);
setInterval(updateCalendarCache, 5 * 60 * 1000);

// ─── Photos ──────────────────────────────────────────────────────────────────
function handlePhotos(req, res) {
  let photos = [];
  if (fs.existsSync(PHOTOS_DIR)) {
    photos = fs.readdirSync(PHOTOS_DIR)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .map(f => `/photos/${f}`);
    // Fisher-Yates so the dashboard sees a different starting order each reload.
    for (let i = photos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [photos[i], photos[j]] = [photos[j], photos[i]];
    }
  }
  sendJSON(res, 200, { photos });
}

function handleSyncPhotos(req, res) {
  if (!requireAuth(req, res)) return;
  const syncScript = path.join(__dirname, 'icloud-album-sync.js');
  const token = config.photoAlbumToken || '';
  execAsync(`node "${syncScript}" "${token}" "${PHOTOS_DIR}"`, { timeout: 300000 }, (err, stdout) => {
    if (err) console.error('Photo sync error:', err.message);
    else console.log('📸 Photo sync complete:', stdout.trim());
  });
  sendJSON(res, 200, { ok: true, message: 'Photo sync started' });
}

function handleUploadPhoto(req, res) {
  if (!requireAuth(req, res)) return;

  const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB
  if (parseInt(req.headers['content-length'] || '0') > MAX_UPLOAD) {
    return sendJSON(res, 413, { error: 'File too large (max 10MB)' });
  }

  const boundary = req.headers['content-type']?.split('boundary=')[1];
  if (!boundary) { res.writeHead(400); return res.end('No boundary'); }

  if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    // Extract a single file out of a basic multipart/form-data body.
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) { res.writeHead(400); return res.end('Bad upload'); }
    const headerStr = buf.slice(0, headerEnd).toString();
    let filename = (headerStr.match(/filename="([^"]+)"/) || [])[1] || `upload-${Date.now()}.jpg`;
    // Sanitize: only alphanumerics, dash, dot, underscore; prevent dotfiles.
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (filename.startsWith('.')) filename = 'upload_' + filename;

    const dataStart = headerEnd + 4;
    const endBoundary = buf.indexOf(Buffer.from('--' + boundary), dataStart);
    const fileData = buf.slice(dataStart, endBoundary > 0 ? endBoundary - 2 : buf.length);

    // Validate by magic bytes (don't trust MIME header).
    const magic = fileData.slice(0, 4).toString('hex');
    const validTypes = ['ffd8ffe0', 'ffd8ffe1', 'ffd8ffe2', 'ffd8ffdb', '89504e47']; // JPEG + PNG
    if (!validTypes.some(t => magic.startsWith(t))) {
      return sendJSON(res, 400, { error: 'Invalid file type. Only JPEG and PNG supported.' });
    }

    fs.writeFileSync(path.join(PHOTOS_DIR, filename), fileData);
    sendJSON(res, 200, { ok: true, filename });
  });
}

// ─── Config API ──────────────────────────────────────────────────────────────
// Hide calendar URLs, the iCloud album token, and the admin PIN from
// unauthenticated callers. The dashboard reads config but doesn't need secrets.
function sanitizeConfig(cfg) {
  const safe = JSON.parse(JSON.stringify(cfg));
  if (safe.calendars) {
    safe.calendars = safe.calendars.map(cal => {
      const out = { ...cal };
      if (out.url) {
        try {
          const u = new URL(out.url);
          out.url = `${u.protocol}//${u.hostname}/•••• (configured)`;
        } catch (_) { out.url = '•••• (configured)'; }
      }
      delete out.keychainKey;
      return out;
    });
  }
  if (safe.photoAlbumToken) {
    const t = safe.photoAlbumToken;
    safe.photoAlbumToken = t.length > 4 ? '••••' + t.slice(-4) : '••••';
  }
  delete safe.adminPin;
  return safe;
}

function handleConfigGet(req, res) {
  // Authenticated callers (admin panel) see the full config; the dashboard gets
  // the sanitized view so a stolen-screenshot can't leak calendar/album URLs.
  sendJSON(res, 200, isAuthenticated(req) ? config : sanitizeConfig(config));
}

async function handleConfigPost(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const incoming = JSON.parse(await readBody(req));
    // Deep-merge: missing/empty fields in the payload don't clobber existing
    // values. This lets the admin panel send only the fields for the current
    // tab without wiping the others.
    const merged = JSON.parse(JSON.stringify(config));
    const isEmpty = v => v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
    for (const key of Object.keys(incoming)) {
      // adminPin is only changeable via /api/change-pin.
      if (key === 'adminPin') continue;

      if (key === 'calendars') {
        // Calendars are replaced wholesale, but empty URLs fall back to the
        // existing URL at the same index (admin UI redacts URLs on display).
        if (incoming.calendars && incoming.calendars.length > 0) {
          merged.calendars = incoming.calendars.map((cal, i) => {
            if (!cal.url && merged.calendars?.[i]?.url) cal.url = merged.calendars[i].url;
            if (!cal.keychainKey && merged.calendars?.[i]?.keychainKey) cal.keychainKey = merged.calendars[i].keychainKey;
            return cal;
          });
        }
      } else if (typeof incoming[key] === 'object' && incoming[key] !== null && !Array.isArray(incoming[key])) {
        if (!merged[key]) merged[key] = {};
        for (const subKey of Object.keys(incoming[key])) {
          if (!isEmpty(incoming[key][subKey])) merged[key][subKey] = incoming[key][subKey];
        }
      } else if (!isEmpty(incoming[key])) {
        merged[key] = incoming[key];
      }
    }
    config = merged;
    saveConfigFile();
    configVersion++;
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
}

// ─── Logs / System info / Display power ──────────────────────────────────────
function handleLogs(req, res) {
  if (!requireAuth(req, res)) return;
  // Strip PM2 ANSI colour codes and the `0|name |` line prefix.
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d+\|[^|]+\| ?/gm, '');
  let logs = '';
  try {
    const out = strip(execSync('tail -60 ~/.pm2/logs/pi-dashboard-out.log 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }));
    const err = strip(execSync('tail -30 ~/.pm2/logs/pi-dashboard-error.log 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }));
    logs = '── stdout ──\n' + (out.trim() || '(empty)') + '\n\n── stderr ──\n' + (err.trim() || '(empty)');
  } catch (e) { logs = 'Could not fetch logs: ' + e.message; }
  sendJSON(res, 200, { logs });
}

// Pick the first real (non-headless) output from wlr-randr --json.
// labwc exposes a NOOP-* headless dummy that stays "enabled: true" when the
// physical monitor is asleep — skip it so we report actual HDMI state.
function getRealOutput() {
  const raw = execSync(`${WLR_ENV} wlr-randr --json 2>/dev/null`, { encoding: 'utf8' });
  const data = JSON.parse(raw);
  return data.find(o => !/^NOOP/i.test(o.name)) || data[0] || null;
}

// POST body: { power: "on" | "off" | "status" }. Status is public; control needs auth.
async function handleDisplayPower(req, res) {
  try {
    const { power } = JSON.parse(await readBody(req));
    if (power === 'status') {
      const output = getRealOutput();
      return sendJSON(res, 200, { power: output && output.enabled ? 'on' : 'off' });
    }
    if (!requireAuth(req, res)) return;
    const output = getRealOutput();
    const name = output ? output.name : 'HDMI-A-1';
    const flag = power === 'on' ? '--on' : '--off';
    execSync(`${WLR_ENV} wlr-randr --output ${name} ${flag} 2>/dev/null`, { encoding: 'utf8' });
    sendJSON(res, 200, { ok: true, power });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

function handleSystemInfo(req, res) {
  try {
    const info = {};
    info.hostname = execSync('hostname', { encoding: 'utf8' }).trim();
    info.model = execSync('cat /proc/device-tree/model 2>/dev/null || echo "Unknown"', { encoding: 'utf8' }).trim().replace(/\0/g, '');
    info.uptime = execSync('uptime -p 2>/dev/null || uptime', { encoding: 'utf8' }).trim();
    info.memory = execSync("free -m | awk '/Mem:/ {printf \"%dMB / %dMB (%.0f%%)\", $3, $2, $3/$2*100}'", { encoding: 'utf8' }).trim();
    info.disk = execSync("df -h / | awk 'NR==2 {printf \"%s / %s (%s)\", $3, $2, $5}'", { encoding: 'utf8' }).trim();
    const tempRaw = execSync('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "0"', { encoding: 'utf8' }).trim();
    info.cpu_temp = (parseInt(tempRaw) / 1000).toFixed(1) + '°C';
    info.node = process.version;
    info.ip = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
    info.os = execSync('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"', { encoding: 'utf8' }).trim();
    sendJSON(res, 200, info);
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleChangePin(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { newPin } = JSON.parse(await readBody(req));
    if (!newPin || !/^\d{4,8}$/.test(newPin)) {
      return sendJSON(res, 400, { error: 'PIN must be 4-8 digits' });
    }
    config.adminPin = newPin;
    saveConfigFile();
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
}

function handleReboot(req, res) {
  if (!requireAuth(req, res)) return;
  sendJSON(res, 200, { ok: true });
  // sysrq-trigger is the last-ditch fallback if sudo reboot isn't permitted.
  setTimeout(() => { execAsync('sudo reboot 2>/dev/null || echo b > /proc/sysrq-trigger', () => {}); }, 500);
}

function handleRestart(req, res) {
  if (!requireAuth(req, res)) return;
  sendJSON(res, 200, { ok: true });
  // PM2 restarts us automatically on non-zero-ish exit.
  setTimeout(() => { process.exit(0); }, 500);
}

// ─── Night mode + auto-update scheduler ──────────────────────────────────────
// A single interval handles both features so we only wake once per minute.
// Re-armed by reloadConfig() so admin-panel toggles take effect immediately.
let nightModeTimer = null;
function scheduleNightMode() {
  if (nightModeTimer) clearInterval(nightModeTimer);
  if (!config.display?.nightModeEnabled && !config.updates?.autoUpdate) return;

  nightModeTimer = setInterval(() => {
    const now = new Date();
    const hhmm = now.getHours() * 100 + now.getMinutes();

    // Night-mode display control (the HDMI-off action; "dim" is client-side CSS)
    if (config.display?.nightModeEnabled && config.display.nightModeAction === 'off') {
      const start = parseInt((config.display.nightModeStart || '22:00').replace(':', '')) || 2200;
      const end = parseInt((config.display.nightModeEnd || '06:00').replace(':', '')) || 600;
      const shouldBeOff = start > end
        ? (hhmm >= start || hhmm < end)
        : (hhmm >= start && hhmm < end);
      const flag = shouldBeOff ? '--off' : '--on';
      try { execSync(`${WLR_ENV} wlr-randr --output HDMI-A-1 ${flag} 2>/dev/null`); } catch (_) {}
    }

    // Auto-update, once per day in the configured hour.
    if (config.updates?.autoUpdate) {
      const hour = now.getHours();
      const minute = now.getMinutes();
      const updateHour = config.updates.autoUpdateHour ?? 3;
      if (hour === updateHour && minute < 5) {
        const last = config.updates.lastUpdate ? new Date(config.updates.lastUpdate) : null;
        if (!last || last.toDateString() !== now.toDateString()) {
          console.log('🔄 Auto-update scheduled check...');
          checkForUpdates(true).then(info => {
            if (info.updateAvailable) {
              console.log(`✨ Update available: ${info.latest}. Installing...`);
              performUpdate().catch(err => console.error('Auto-update failed:', err.message));
            } else {
              console.log('✅ Already up to date');
            }
          }).catch(err => console.error('Auto-update check failed:', err.message));
        }
      }
    }
  }, 60000);
}
scheduleNightMode();

// ─── Update system (GitHub Releases → tarball → swap + restart) ──────────────
// Cached version check so every dashboard poll doesn't hit the GitHub API.
let versionCache = { timestamp: 0, data: null };
const VERSION_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

async function checkForUpdates(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && versionCache.data && (now - versionCache.timestamp) < VERSION_CACHE_DURATION) {
    return versionCache.data;
  }

  try {
    const apiUrl = 'https://api.github.com/repos/twitchkiddie/displayboard/releases/latest';
    const raw = await httpGet(apiUrl, { headers: { 'User-Agent': 'DisplayBoard-Pi' }, timeout: 10000 });
    const release = JSON.parse(raw);

    if (!release || !release.tag_name) {
      const result = { version: VERSION, latest: VERSION, updateAvailable: false, changelog: '', error: 'No releases found' };
      versionCache = { timestamp: now, data: result };
      return result;
    }

    const latestVersion = release.tag_name.replace(/^v/, '');
    const result = {
      version: VERSION,
      latest: latestVersion,
      updateAvailable: latestVersion !== VERSION,
      changelog: release.body || '',
      tarballUrl: release.tarball_url,
      publishedAt: release.published_at
    };
    versionCache = { timestamp: now, data: result };

    config.updates.lastCheck = new Date().toISOString();
    try { saveConfigFile(); } catch (_) {}
    return result;
  } catch (err) {
    console.error('Version check error:', err.message);
    const msg = err.message.includes('Not Found') || err.message.includes('No releases')
      ? 'No releases found on GitHub yet' : err.message;
    return { version: VERSION, latest: VERSION, updateAvailable: false, changelog: '', error: msg };
  }
}

// Shared state so the admin panel can poll progress while an update runs.
let updateStatus = { state: 'idle', message: '', progress: 0 };

async function performUpdate() {
  if (updateStatus.state !== 'idle') throw new Error('Update already in progress');
  updateStatus = { state: 'checking', message: 'Checking for updates...', progress: 5 };

  try {
    const info = await checkForUpdates(true);
    if (!info.updateAvailable) {
      updateStatus = { state: 'complete', message: 'Already up to date', progress: 100 };
      return;
    }
    if (!info.latest) throw new Error('No version info found in release');

    // Direct /archive/refs/tags URL avoids multi-hop API → codeload redirects.
    const downloadUrl = `https://github.com/twitchkiddie/displayboard/archive/refs/tags/v${info.latest}.tar.gz`;
    updateStatus = { state: 'downloading', message: 'Downloading update...', progress: 10 };
    console.log('📥 Downloading update from:', downloadUrl);

    const tarballPath = '/tmp/displayboard-update.tar.gz';
    await httpDownload(downloadUrl, tarballPath);

    updateStatus = { state: 'extracting', message: 'Extracting files...', progress: 30 };
    const extractDir = '/tmp/displayboard-update';
    try { execSync(`rm -rf ${extractDir}`); } catch (_) {}
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf ${tarballPath} -C ${extractDir} --strip-components=1`);

    updateStatus = { state: 'backing-up', message: 'Creating backup...', progress: 50 };
    try { execSync(`rm -rf ${BACKUP_DIR}`); } catch (_) {}
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // Preserve user data + the backup folder itself.
    const preserve = ['config.json', 'photos', 'node_modules', '.calendar-cache.json', '.backup'];
    for (const file of fs.readdirSync(__dirname)) {
      if (preserve.includes(file) || file.startsWith('.')) continue;
      try {
        execSync(`cp -r "${path.join(__dirname, file)}" "${path.join(BACKUP_DIR, file)}"`);
      } catch (e) { console.error(`Backup warning: ${file}:`, e.message); }
    }

    updateStatus = { state: 'installing', message: 'Installing files...', progress: 70 };

    // Detect dependency changes so we only run npm install when needed.
    let packageChanged = false;
    try {
      const oldPkg = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
      const newPkg = fs.readFileSync(path.join(extractDir, 'package.json'), 'utf8');
      packageChanged = oldPkg !== newPkg;
    } catch (_) {}

    for (const file of fs.readdirSync(extractDir)) {
      if (preserve.includes(file)) continue;
      try {
        execSync(`cp -r "${path.join(extractDir, file)}" "${path.join(__dirname, file)}"`);
      } catch (e) { console.error(`Install warning: ${file}:`, e.message); }
    }

    if (packageChanged) {
      updateStatus = { state: 'installing', message: 'Installing dependencies...', progress: 85 };
      try { execSync('npm install --production', { cwd: __dirname, timeout: 120000 }); }
      catch (e) { console.error('npm install error:', e.message); }
    }

    config.updates.lastUpdate = new Date().toISOString();
    try { saveConfigFile(); } catch (_) {}

    updateStatus = { state: 'restarting', message: 'Restarting server...', progress: 95 };
    console.log('🔄 Update complete! Restarting in 2 seconds...');
    setTimeout(() => {
      updateStatus = { state: 'complete', message: 'Update complete', progress: 100 };
      process.exit(0); // PM2 restarts us.
    }, 2000);
  } catch (err) {
    console.error('❌ Update failed:', err.message);
    updateStatus = { state: 'failed', message: err.message, progress: 0 };
    throw err;
  }
}

async function performRollback() {
  if (!fs.existsSync(BACKUP_DIR)) throw new Error('No backup found. Cannot rollback.');
  console.log('⏪ Rolling back to previous version...');
  for (const file of fs.readdirSync(BACKUP_DIR)) {
    execSync(`cp -r "${path.join(BACKUP_DIR, file)}" "${path.join(__dirname, file)}"`);
  }
  console.log('✅ Rollback complete. Restarting...');
  setTimeout(() => process.exit(0), 1000);
}

function handleVersionInfo(req, res) {
  const forceRefresh = url.parse(req.url, true).query.force === 'true';
  checkForUpdates(forceRefresh)
    .then(info => sendJSON(res, 200, info))
    .catch(err => sendJSON(res, 500, { error: err.message }));
}

function handleUpdate(req, res) {
  if (!requireAuth(req, res)) return;
  if (updateStatus.state !== 'idle') return sendJSON(res, 409, { error: 'Update already in progress' });
  performUpdate().catch(err => console.error('Update error:', err.message));
  sendJSON(res, 200, { ok: true, message: 'Update started' });
}

function handleUpdateStatus(req, res) {
  sendJSON(res, 200, updateStatus);
}

function handleRollback(req, res) {
  if (!requireAuth(req, res)) return;
  performRollback()
    .then(() => sendJSON(res, 200, { ok: true }))
    .catch(err => sendJSON(res, 500, { error: err.message }));
}

function handleBackupExists(req, res) {
  sendJSON(res, 200, { exists: fs.existsSync(BACKUP_DIR) });
}

// ─── Hostname ────────────────────────────────────────────────────────────────
function handleGetHostname(req, res) {
  try {
    sendJSON(res, 200, { hostname: execSync('hostname', { encoding: 'utf8' }).trim() });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

async function handleSetHostname(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { hostname } = JSON.parse(await readBody(req));
    if (!hostname || !/^[a-z0-9-]+$/.test(hostname)) {
      return sendJSON(res, 400, { error: 'Invalid hostname' });
    }
    const oldHostname = execSync('hostname', { encoding: 'utf8' }).trim();
    execSync(`echo '${hostname}' | sudo tee /etc/hostname`, { encoding: 'utf8' });
    // Regex-escape the old hostname before splicing it into a sed pattern.
    const escaped = oldHostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    execSync(`sudo sed -i 's/127\\.0\\.1\\.1.*${escaped}/127.0.1.1\\t${hostname}/g' /etc/hosts`, { encoding: 'utf8' });
    console.log(`🖥️  Hostname changed: ${oldHostname} → ${hostname}`);
    sendJSON(res, 200, { ok: true, hostname });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

// ─── Version / refresh ──────────────────────────────────────────────────────
// Dashboard polls this to detect config/asset changes and hot-reload.
function handleVersion(req, res) {
  sendJSON(res, 200, { version: configVersion });
}

function handleRefresh(req, res) {
  configVersion++;
  sendJSON(res, 200, { ok: true, version: configVersion });
}

// ─── Display info / settings ────────────────────────────────────────────────
// Reads the current resolution/orientation/scale from the Wayland compositor.
function handleDisplayInfo(req, res) {
  try {
    const output = getRealOutput();
    if (!output) return sendJSON(res, 500, { error: 'no display output found' });

    // Deduplicate modes — keep the highest refresh rate per resolution.
    const resMap = {};
    for (const mode of (output.modes || [])) {
      const key = `${mode.width}x${mode.height}`;
      if (!resMap[key] || mode.refresh > resMap[key]) resMap[key] = mode.refresh;
    }
    const currentMode = (output.modes || []).find(m => m.current);

    sendJSON(res, 200, {
      output: output.name,
      enabled: output.enabled !== false,
      resolution: currentMode ? `${currentMode.width}x${currentMode.height}` : null,
      refresh: currentMode ? Math.round(currentMode.refresh) : null,
      orientation: output.transform || 'normal',
      scale: output.scale || 1.0,
      availableResolutions: Object.keys(resMap),
      availableOrientations: ['normal', '90', '180', '270']
    });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleDisplaySettings(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { resolution, orientation, scale } = JSON.parse(await readBody(req));
    const output = getRealOutput();
    if (!output) throw new Error('no display output found');

    let cmd = `${WLR_ENV} wlr-randr --output ${output.name}`;
    if (resolution) cmd += ` --mode ${resolution}`;
    if (orientation !== undefined && orientation !== null) cmd += ` --transform ${orientation}`;
    if (scale !== undefined && scale !== null) cmd += ` --scale ${scale}`;

    execSync(cmd + ' 2>/dev/null', { encoding: 'utf8' });
    console.log(`🖥️  Display settings applied: resolution=${resolution} orientation=${orientation} scale=${scale}`);

    config.display = config.display || {};
    if (resolution) config.display.resolution = resolution;
    if (orientation !== undefined && orientation !== null) config.display.orientation = orientation;
    if (scale !== undefined && scale !== null) config.display.scale = parseFloat(scale);
    saveConfigFile();

    sendJSON(res, 200, { ok: true });
  } catch (e) {
    console.error('Display settings error:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

// Re-apply saved display settings on startup (labwc forgets them across logout).
function applyDisplaySettings() {
  try {
    const { resolution, orientation, scale } = config.display || {};
    if (!resolution && orientation === undefined && scale === undefined) return;
    const output = getRealOutput();
    if (!output) return;

    let cmd = `${WLR_ENV} wlr-randr --output ${output.name}`;
    if (resolution) cmd += ` --mode ${resolution}`;
    if (orientation !== undefined && orientation !== null) cmd += ` --transform ${orientation}`;
    if (scale !== undefined && scale !== null) cmd += ` --scale ${scale}`;

    execSync(cmd + ' 2>/dev/null', { encoding: 'utf8' });
    console.log(`🖥️  Startup display settings applied: resolution=${resolution} orientation=${orientation} scale=${scale}`);
  } catch (e) {
    console.error('❌ applyDisplaySettings failed:', e.message);
  }
}

// ─── Auth endpoint ───────────────────────────────────────────────────────────
async function handleAuth(req, res) {
  try {
    const { pin } = JSON.parse(await readBody(req));
    if (pin === config.adminPin) return sendJSON(res, 200, { ok: true });
    sendJSON(res, 401, { error: 'Invalid PIN' });
  } catch (_) {
    sendJSON(res, 400, { error: 'Bad request' });
  }
}

// ─── WiFi API ────────────────────────────────────────────────────────────────
// Captive-portal hostnames we short-circuit when in AP fallback mode.
const CAPTIVE_PORTAL_HOSTS = [
  'captive.apple.com', 'www.apple.com', 'connectivitycheck.gstatic.com',
  'connectivitycheck.android.com', 'clients3.google.com',
  'www.msftconnecttest.com', 'www.msftncsi.com', 'detectportal.firefox.com'
];

// ap-fallback.sh writes this flag file while the Pi is in setup-hotspot mode.
function isApMode() {
  return fs.existsSync(AP_MODE_FLAG);
}

function handleWifiStatus(req, res) {
  try {
    if (isApMode()) {
      let status = { mode: 'ap', ssid: 'DisplayBoard-Setup', ip: '192.168.4.1', signal: null };
      try {
        status = JSON.parse(fs.readFileSync(AP_STATUS_FILE, 'utf8'));
        status.signal = null;
      } catch (_) {}
      return sendJSON(res, 200, status);
    }

    // Client mode — query the OS for current association + signal.
    let ssid = '', signal = null, ip = '';
    try { ssid = execSync("iwgetid -r 2>/dev/null || echo ''", { encoding: 'utf8' }).trim(); } catch (_) {}
    try {
      const iw = execSync("iwconfig wlan0 2>/dev/null || echo ''", { encoding: 'utf8' });
      const m = iw.match(/Signal level[=:](-?\d+)/);
      if (m) signal = parseInt(m[1]);
    } catch (_) {}
    try { ip = execSync("hostname -I 2>/dev/null | awk '{print $1}'", { encoding: 'utf8' }).trim(); } catch (_) {}
    sendJSON(res, 200, { mode: 'client', ssid, ip, signal });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

function handleWifiScan(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    // In AP mode hostapd owns the radio; scan was cached pre-hostapd in ap-fallback.sh.
    if (isApMode()) {
      try {
        const cached = JSON.parse(fs.readFileSync(AP_SCAN_FILE, 'utf8'));
        return sendJSON(res, 200, cached);
      } catch (_) {
        return sendJSON(res, 200, []);
      }
    }

    // Prefer nmcli on Bookworm/Trixie; fall back to iwlist on legacy wpa_supplicant.
    let networks = [];
    let usedNmcli = false;
    try {
      execSync('nmcli device wifi rescan ifname wlan0 2>/dev/null || true', { timeout: 8000 });
      const raw = execSync('nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
      const seen = new Set();
      for (const line of raw.split('\n')) {
        const parts = line.split(':');
        if (parts.length < 2) continue;
        const ssid = parts[0].trim();
        const signal = parseInt(parts[1]) || 0;
        const security = parts[2] && parts[2].trim() !== '--' ? parts[2].trim() : 'Open';
        if (!ssid || seen.has(ssid)) continue;
        seen.add(ssid);
        // nmcli reports 0-100 "quality" — approximate dBm: quality/2 - 100.
        const dbm = signal > 0 ? Math.round((signal / 2) - 100) : null;
        networks.push({ ssid, signal: dbm, security });
      }
      usedNmcli = true;
    } catch (_) { /* fall through to iwlist */ }

    if (!usedNmcli || networks.length === 0) {
      const raw = execSync('sudo iwlist wlan0 scan 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 15000 });
      const cells = raw.split(/Cell \d+/);
      const seen = new Set();
      for (const cell of cells) {
        const ssidMatch = cell.match(/ESSID:"([^"]*)"/);
        if (!ssidMatch || !ssidMatch[1]) continue;
        const ssid = ssidMatch[1];
        if (seen.has(ssid)) continue;
        seen.add(ssid);
        const signalMatch = cell.match(/Signal level[=:](-?\d+)/);
        const encMatch = cell.match(/Encryption key:(on|off)/);
        const wpaMatch = cell.match(/WPA/i);
        let security = 'Open';
        if (encMatch && encMatch[1] === 'on') security = wpaMatch ? 'WPA' : 'WEP';
        networks.push({ ssid, signal: signalMatch ? parseInt(signalMatch[1]) : null, security });
      }
    }

    networks.sort((a, b) => (b.signal || -100) - (a.signal || -100));
    sendJSON(res, 200, networks);
  } catch (_) {
    sendJSON(res, 200, []);
  }
}

async function handleWifiConnect(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { ssid, password } = JSON.parse(await readBody(req));
    if (!ssid || typeof ssid !== 'string' || ssid.length > 64) {
      return sendJSON(res, 400, { error: 'Invalid SSID' });
    }

    const hasNmcli = (() => { try { execSync('which nmcli', { timeout: 2000 }); return true; } catch (_) { return false; } })();

    if (hasNmcli) {
      if (isApMode()) {
        // In AP mode sudo isn't available to the pi user here; drop credentials
        // to a local file. ap-fallback.sh picks them up (as root) on teardown
        // and writes the NM connection before the next boot.
        fs.writeFileSync(WIFI_PENDING_FILE, JSON.stringify({ ssid, password: password || '' }), { mode: 0o600 });
      } else {
        // Normal mode — nmcli handles everything.
        // psk-flags=0 stores the PSK system-wide in the connection file so
        // NetworkManager re-authenticates silently on reconnect without asking
        // a session agent (which would otherwise pop a polkit password dialog
        // on top of the kiosk). See https://networkmanager.dev/docs/api/latest/settings-802-11-wireless-security.html
        execSync(`sudo nmcli connection delete "${ssid}" 2>/dev/null; true`, { timeout: 5000 });
        if (password) {
          execSync(`sudo nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${password}" wifi-sec.psk-flags 0 connection.autoconnect yes`, { timeout: 10000 });
        } else {
          execSync(`sudo nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}" connection.autoconnect yes`, { timeout: 10000 });
        }
        execSync(`sudo nmcli connection up "${ssid}" 2>/dev/null || true`, { timeout: 15000 });
      }
    } else {
      // Legacy fallback — write a wpa_supplicant.conf.
      const networkBlock = password
        ? `network={\n    ssid="${ssid}"\n    psk="${password}"\n    key_mgmt=WPA-PSK\n}`
        : `network={\n    ssid="${ssid}"\n    key_mgmt=NONE\n}`;
      const wpaConf = `ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\nupdate_config=1\ncountry=US\n\n${networkBlock}\n`;
      const tmpFile = '/tmp/displayboard-wpa.conf';
      fs.writeFileSync(tmpFile, wpaConf);
      execSync(`sudo cp ${tmpFile} /etc/wpa_supplicant/wpa_supplicant.conf`);
      fs.unlinkSync(tmpFile);
    }

    sendJSON(res, 200, { ok: true, message: 'WiFi credentials saved. Rebooting...' });
    setTimeout(() => { execAsync('sudo reboot', () => {}); }, 2000);
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url, true).pathname;

  // AP-mode captive portal: redirect any non-local hostname back to the admin page.
  if (isApMode()) {
    const host = (req.headers.host || '').split(':')[0];
    const isOwnHost = host === '192.168.4.1' || host === 'localhost';
    if (!isOwnHost && host) {
      res.writeHead(302, { Location: 'http://192.168.4.1:3000/admin.html' });
      return res.end();
    }
  }

  // First-run: if location is still the config.example.json default, show the welcome page.
  if ((pathname === '/' || pathname === '/index.html') && isFirstRun()) {
    const setupPath = path.join(__dirname, 'setup-welcome.html');
    return fs.readFile(setupPath, (err, data) => {
      if (err) { res.writeHead(302, { Location: '/admin.html' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }

  // Authentication
  if (pathname === '/api/auth' && req.method === 'POST') return handleAuth(req, res);

  // Data endpoints
  if (pathname === '/api/weather-extended') return handleWeatherExtended(req, res);
  if (pathname === '/api/calendar') return handleCalendar(req, res);
  if (pathname === '/api/photos') return handlePhotos(req, res);
  if (pathname === '/api/version') return handleVersion(req, res);
  if (pathname === '/api/refresh') return handleRefresh(req, res);

  // Config
  if (pathname === '/api/config' && req.method === 'POST') return handleConfigPost(req, res);
  if (pathname === '/api/config') return handleConfigGet(req, res);

  // Admin actions
  if (pathname === '/api/refresh-calendar' && req.method === 'POST') return handleRefreshCalendar(req, res);
  if (pathname === '/api/clear-cache' && req.method === 'POST') return handleClearCache(req, res);
  if (pathname === '/api/sync-photos' && req.method === 'POST') return handleSyncPhotos(req, res);
  if (pathname === '/api/upload-photo' && req.method === 'POST') return handleUploadPhoto(req, res);
  if (pathname === '/api/logs') return handleLogs(req, res);
  if (pathname === '/api/system-info') return handleSystemInfo(req, res);
  if (pathname === '/api/change-pin' && req.method === 'POST') return handleChangePin(req, res);
  if (pathname === '/api/reboot' && req.method === 'POST') return handleReboot(req, res);
  if (pathname === '/api/restart' && req.method === 'POST') return handleRestart(req, res);

  // Display
  if (pathname === '/api/display-info' && req.method === 'GET') return handleDisplayInfo(req, res);
  if (pathname === '/api/display-settings' && req.method === 'POST') return handleDisplaySettings(req, res);
  if (pathname === '/api/display-power' && req.method === 'POST') return handleDisplayPower(req, res);

  // Hostname
  if (pathname === '/api/hostname' && req.method === 'GET') return handleGetHostname(req, res);
  if (pathname === '/api/hostname' && req.method === 'POST') return handleSetHostname(req, res);

  // Updates
  if (pathname === '/api/version-info') return handleVersionInfo(req, res);
  if (pathname === '/api/update' && req.method === 'POST') return handleUpdate(req, res);
  if (pathname === '/api/update-status') return handleUpdateStatus(req, res);
  if (pathname === '/api/rollback' && req.method === 'POST') return handleRollback(req, res);
  if (pathname === '/api/backup-exists') return handleBackupExists(req, res);

  // WiFi
  if (pathname === '/api/wifi/status' && req.method === 'GET') return handleWifiStatus(req, res);
  if (pathname === '/api/wifi/scan' && req.method === 'GET') return handleWifiScan(req, res);
  if (pathname === '/api/wifi/connect' && req.method === 'POST') return handleWifiConnect(req, res);

  serveStatic(req, res);
});

// Kill any running polkit authentication agent and hide its xdg autostart
// entry, so NetworkManager can never surface a password dialog over the kiosk
// when it wants to request credentials. Kiosk has no human to answer prompts;
// silent failure to reconnect is strictly better than a modal over the
// dashboard. Runs on every startup (idempotent, writes overrides into
// ~/.config/autostart if missing).
function suppressKioskPrompts() {
  try {
    const home = process.env.HOME || '/home/pi';
    const autostartDir = path.join(home, '.config', 'autostart');
    fs.mkdirSync(autostartDir, { recursive: true });

    const agents = [
      'lxpolkit',
      'polkit-gnome-authentication-agent-1',
      'polkit-mate-authentication-agent-1',
      'polkit-kde-authentication-agent-1'
    ];
    for (const name of agents) {
      const target = path.join(autostartDir, `${name}.desktop`);
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target,
          `[Desktop Entry]\nType=Application\nName=${name} (disabled for kiosk)\n` +
          `Exec=true\nHidden=true\nX-GNOME-Autostart-enabled=false\n`
        );
      }
    }
    // Kill anything already running in this session.
    try { execSync("pkill -f 'polkit-.*-authentication-agent|lxpolkit' 2>/dev/null || true", { timeout: 2000 }); } catch (_) {}
  } catch (e) {
    console.error('Polkit suppression skipped:', e.message);
  }
}

// One-time migration: force psk-flags=0 on every saved WiFi connection so
// NetworkManager re-authenticates silently. Connections generated by Pi
// Imager, raspi-config, or netplan can be marked "agent-owned" (psk-flags=1),
// which causes a polkit password dialog to pop over the kiosk whenever NM
// re-auths. Idempotent: runs on every startup, only touches files with a
// non-empty PSK that don't already have psk-flags=0.
function hardenNmConnections() {
  try {
    const NM_DIR = '/etc/NetworkManager/system-connections';
    // Root-owned 0600 — list via sudo.
    const listing = execSync(`sudo ls "${NM_DIR}" 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 });
    const files = listing.split('\n').map(s => s.trim()).filter(f => f.endsWith('.nmconnection'));
    if (files.length === 0) return;

    let fixed = 0;
    for (const name of files) {
      const full = `${NM_DIR}/${name}`;
      // Only touch connections that actually have a PSK stored (8+ chars).
      const hasPsk = (() => {
        try { execSync(`sudo grep -qE '^psk=.{8,}' "${full}"`, { timeout: 2000 }); return true; }
        catch (_) { return false; }
      })();
      if (!hasPsk) continue;
      // Skip if already hardened.
      try { execSync(`sudo grep -qE '^psk-flags=0$' "${full}"`, { timeout: 2000 }); continue; } catch (_) {}

      execSync(`sudo sed -i '/^psk-flags=/d' "${full}"`, { timeout: 2000 });
      execSync(`sudo sed -i '/^\\[wifi-security\\]/a psk-flags=0' "${full}"`, { timeout: 2000 });
      fixed++;
    }

    if (fixed > 0) {
      console.log(`📶 Hardened ${fixed} WiFi connection(s) — psk-flags set to 0`);
      try { execSync('sudo systemctl reload NetworkManager', { timeout: 5000 }); } catch (_) {}
    }
  } catch (e) {
    console.error('NM hardening skipped:', e.message);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🖼️  Pi DisplayBoard running at http://localhost:${PORT}`);
  console.log(`📅 Calendars: ${(config.calendars || []).filter(c => c.enabled).map(c => c.name).join(', ')}`);
  // Wayland needs a moment after labwc startup before wlr-randr will take us.
  setTimeout(applyDisplaySettings, 5000);
  // Retrofit existing NM connections created before v1.1.18 so the kiosk
  // never sees a polkit password dialog on WiFi re-auth.
  setTimeout(hardenNmConnections, 7000);
  // Also suppress any polkit authentication agent that might try to surface
  // such a dialog (belt-and-suspenders — runs regardless of psk-flags state).
  setTimeout(suppressKioskPrompts, 8000);
});

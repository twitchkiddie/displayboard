#!/usr/bin/env node
/**
 * Pi DisplayBoard Server — Self-contained
 * No Mac mini dependency. Calendar, weather, and photos all local.
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { execSync } = require('child_process');

const PORT = 3000;

// Version tracking
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const VERSION = PACKAGE_JSON.version || '1.0.0';
console.log(`📦 DisplayBoard v${VERSION}`);

// Timestamp all console output
const origLog = console.log, origErr = console.error;
function ts() { return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
console.log = (...args) => origLog(`[${ts()}]`, ...args);
console.error = (...args) => origErr(`[${ts()}]`, ...args);

// Load configuration
let config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
let configVersion = 1;

// Initialize update config if not present
if (!config.updates) {
  config.updates = {
    autoUpdate: false,
    autoUpdateHour: 3,
    lastCheck: null,
    lastUpdate: null
  };
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
}

// First-run detection — config is unconfigured if location is still default
function isFirstRun() {
  const loc = config.location || {};
  return !loc.name || loc.name === 'Your City, State' || loc.name === 'Your City, ST';
}

// Generate admin PIN if not set
if (!config.adminPin) {
  config.adminPin = '123456';
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  console.log('🔐 Default admin PIN set: 123456 — change it in the admin panel!');
} else {
  console.log('🔐 Admin PIN: ' + config.adminPin);
}

function reloadConfig() {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  configVersion++;
  console.log('Configuration reloaded (version ' + configVersion + ')');
}

// Watch config and served files for changes
function watchForChanges() {
  const watchFiles = ['config.json', 'index.html', 'style.css', 'dashboard.js', 'display-enhancements.js'];
  watchFiles.forEach(function(file) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      fs.watchFile(filePath, { interval: 2000 }, function(curr, prev) {
        if (curr.mtime > prev.mtime) {
          console.log(file + ' changed, bumping version');
          if (file === 'config.json') {
            try { reloadConfig(); } catch(e) { console.error('Config reload error:', e.message); }
          } else {
            configVersion++;
          }
        }
      });
    }
  });
}
watchForChanges();

// MIME types
const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

// Auth middleware
function requireAuth(req, res) {
  const pin = config.adminPin;
  if (!pin) return true; // No pin set, allow (shouldn't happen)
  const auth = req.headers.authorization;
  if (auth === `Bearer ${pin}`) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized. PIN required.' }));
  return false;
}

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : decodeURIComponent(url.parse(req.url).pathname));
  filePath = path.resolve(filePath);
  // Path traversal protection
  if (!filePath.startsWith(path.resolve(__dirname))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const noCache = ['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600' });
    res.end(data);
  });
}

function httpGet(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const reqOptions = {
      timeout: options.timeout || 15000,
      headers: options.headers || {}
    };
    const req = lib.get(reqUrl, reqOptions, (res) => {
      if (options.binary) {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      } else {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

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
    req.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
    req.on('timeout', () => { req.destroy(); fs.unlinkSync(destPath); reject(new Error('timeout')); });
    file.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
  });
}

// Weather icons
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

function getMoonPhase(date) {
  let y = date.getFullYear(), m = date.getMonth() + 1;
  const d = date.getDate();
  if (m < 3) { y--; m += 12; } ++m;
  let jd = (365.25*y + 30.6*m + d - 694039.09) / 29.5305882;
  const frac = jd - Math.floor(jd);
  const idx = Math.round(frac * 27) % 28;
  const names = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  return { name: names[Math.round(frac*8)%8], icon: 'wi-moon-'+idx, phase: idx };
}

// Weather cache — fetch in background, serve from cache
let weatherCache = null;
let weatherUpdating = false;
const WEATHER_CACHE_FILE = path.join(__dirname, '.weather-cache.json');
try { weatherCache = JSON.parse(fs.readFileSync(WEATHER_CACHE_FILE, 'utf8')); console.log('🌤️  Loaded cached weather'); } catch(e) {}

async function updateWeatherCache() {
  if (weatherUpdating) return;
  weatherUpdating = true;
  try {
    const { latitude: LAT, longitude: LON, timezone: TZ } = config.location;
    const raw = await httpGet(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=${TZ}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,sunrise,sunset&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,relativehumidity_2m`);
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
      forecast.push({ label: i===0?'Today':dayNames[(today+i)%7], icon: getWeatherIcon(data.daily.weathercode[i]), text: getWeatherText(data.daily.weathercode[i]), precip: data.daily.precipitation_probability_max[i]||0, high: Math.round(data.daily.temperature_2m_max[i]), low: Math.round(data.daily.temperature_2m_min[i]) });
    }
    weatherCache = { current, forecast, lastUpdated: Date.now() };
    console.log('🌤️  Weather cache updated');
    try { fs.writeFileSync(WEATHER_CACHE_FILE, JSON.stringify(weatherCache)); } catch(e) {}
  } catch (err) {
    console.error('Weather cache update error:', err.message);
  } finally {
    weatherUpdating = false;
  }
}

// Update weather every 15 minutes, initial load on startup
setTimeout(updateWeatherCache, 3000);
setInterval(updateWeatherCache, 15 * 60 * 1000);

function handleWeatherExtended(req, res) {
  if (weatherCache) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(weatherCache));
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Weather data not yet available' }));
  }
}

// Calendar cache — parse in background, serve from cache
let calendarCache = { events: [], lastUpdated: 0 };
const CACHE_FILE = path.join(__dirname, '.calendar-cache.json');
try { calendarCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); console.log('📅 Loaded cached calendar: ' + (calendarCache.events?.length||0) + ' events'); } catch(e) {}
let calendarUpdating = false;

function updateCalendarCache() {
  if (calendarUpdating) return;
  calendarUpdating = true;
  const days = (config.display?.calendarDays || 5) + 2; // fetch extra days to ensure enough after filtering past dates
  const calScript = path.join(__dirname, 'calendar-all.js');
  const { exec: execAsync } = require('child_process');
  execAsync(`node "${calScript}" ${days} "${path.join(__dirname, 'config.json')}" --json`, { timeout: 120000 }, (err, stdout, stderr) => {
    calendarUpdating = false;
    if (err) { console.error('Calendar cache update error:', err.message); return; }
    try {
      calendarCache = JSON.parse(stdout);
      calendarCache.lastUpdated = Date.now();
      console.log(`📅 Calendar cache updated: ${calendarCache.events?.length || 0} events`);
        try { fs.writeFileSync(CACHE_FILE, JSON.stringify(calendarCache)); } catch(e) {}
    } catch(e) { console.error('Calendar parse error:', e.message); }
  });
}

// Update calendar every 5 minutes, initial load on startup
setTimeout(updateCalendarCache, 2000);
setInterval(updateCalendarCache, 5 * 60 * 1000);

function handleCalendar(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(calendarCache));
}

// API: Photos — served locally, shuffled
function handlePhotos(req, res) {
  const photosDir = path.join(__dirname, 'photos');
  let photos = [];
  if (fs.existsSync(photosDir)) {
    photos = fs.readdirSync(photosDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .map(f => `/photos/${f}`);
    // Fisher-Yates shuffle
    for (let i = photos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [photos[i], photos[j]] = [photos[j], photos[i]];
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ photos }));
}

// Sanitize config for public consumption (redact sensitive fields)
function sanitizeConfig(cfg) {
  const sanitized = JSON.parse(JSON.stringify(cfg)); // deep clone
  
  // Redact calendar URLs
  if (sanitized.calendars) {
    sanitized.calendars = sanitized.calendars.map(cal => {
      const safe = { ...cal };
      if (safe.url) {
        try {
          const urlObj = new URL(safe.url);
          safe.url = `${urlObj.protocol}//${urlObj.hostname}/•••• (configured)`;
        } catch(e) {
          safe.url = '•••• (configured)';
        }
      }
      delete safe.keychainKey; // Never expose keychain keys
      return safe;
    });
  }
  
  // Redact photo album token
  if (sanitized.photoAlbumToken) {
    const token = sanitized.photoAlbumToken;
    sanitized.photoAlbumToken = token.length > 4 ? '••••' + token.slice(-4) : '••••';
  }
  
  // Redact admin PIN
  delete sanitized.adminPin;
  
  return sanitized;
}

function handleConfigGet(req, res) {
  // Check for auth header to return full config (for admin panel)
  const auth = req.headers.authorization;
  const isAuthenticated = auth === `Bearer ${config.adminPin}`;
  
  const responseConfig = isAuthenticated ? config : sanitizeConfig(config);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseConfig));
}

function handleConfigPost(req, res) {
  if (!requireAuth(req, res)) return;
  
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const incoming = JSON.parse(body);
      // Deep merge: incoming overwrites existing, but empty/null values don't clobber
      const merged = JSON.parse(JSON.stringify(config)); // clone current
      function isEmpty(v) { return v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v)); }
      for (const key of Object.keys(incoming)) {
        // adminPin can only be changed via dedicated endpoint
        if (key === 'adminPin') continue;
        
        if (key === 'calendars') {
          if (incoming.calendars && incoming.calendars.length > 0) {
            merged.calendars = incoming.calendars.map((cal, i) => {
              if (!cal.url && merged.calendars?.[i]?.url) cal.url = merged.calendars[i].url;
              if (!cal.keychainKey && merged.calendars?.[i]?.keychainKey) cal.keychainKey = merged.calendars[i].keychainKey;
              return cal;
            });
          }
          // If incoming calendars is empty array, keep existing
        } else if (typeof incoming[key] === 'object' && incoming[key] !== null && !Array.isArray(incoming[key])) {
          if (!merged[key]) merged[key] = {};
          for (const subKey of Object.keys(incoming[key])) {
            if (!isEmpty(incoming[key][subKey])) {
              merged[key][subKey] = incoming[key][subKey];
            }
          }
        } else {
          if (!isEmpty(incoming[key])) {
            merged[key] = incoming[key];
          }
        }
      }
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(merged, null, 2));
      config = merged;
      configVersion++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleRefreshCalendar(req, res) {
  if (!requireAuth(req, res)) return;
  updateCalendarCache();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message: 'Calendar refresh started' }));
}

function handleClearCache(req, res) {
  if (!requireAuth(req, res)) return;
  try { fs.unlinkSync(CACHE_FILE); } catch(e) {}
  calendarCache = { events: [], lastUpdated: 0 };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleSyncPhotos(req, res) {
  if (!requireAuth(req, res)) return;
  const syncScript = path.join(__dirname, 'icloud-album-sync.js');
  const { exec: execAsync } = require('child_process');
  const token = config.photoAlbumToken;
  execAsync(`node "${syncScript}" "${token}" "${path.join(__dirname, 'photos')}"`, { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) console.error('Photo sync error:', err.message);
    else console.log('📸 Photo sync complete:', stdout.trim());
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message: 'Photo sync started' }));
}

function handleUploadPhoto(req, res) {
  if (!requireAuth(req, res)) return;
  
  // Size limit check
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 10 * 1024 * 1024) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File too large (max 10MB)' }));
    return;
  }
  
  const photosDir = path.join(__dirname, 'photos');
  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });

  // Parse multipart form data (simple parser)
  const boundary = req.headers['content-type']?.split('boundary=')[1];
  if (!boundary) { res.writeHead(400); res.end('No boundary'); return; }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const boundaryBuf = Buffer.from('--' + boundary);
    // Find file data between headers and next boundary
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) { res.writeHead(400); res.end('Bad upload'); return; }
    const headerStr = buf.slice(0, headerEnd).toString();
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    let filename = filenameMatch ? filenameMatch[1] : `upload-${Date.now()}.jpg`;
    
    // Sanitize filename - only alphanumeric, dash, dot, underscore
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (filename.startsWith('.')) filename = 'upload_' + filename;
    
    const dataStart = headerEnd + 4;
    const endBoundary = buf.indexOf(boundaryBuf, dataStart);
    const fileData = buf.slice(dataStart, endBoundary > 0 ? endBoundary - 2 : buf.length);
    
    // Validate file type by magic bytes
    const magic = fileData.slice(0, 4).toString('hex');
    const validTypes = ['ffd8ffe0', 'ffd8ffe1', 'ffd8ffe2', 'ffd8ffdb', '89504e47']; // JPEG, PNG
    if (!validTypes.some(t => magic.startsWith(t))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid file type. Only JPEG and PNG supported.' }));
      return;
    }
    
    fs.writeFileSync(path.join(photosDir, filename), fileData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, filename }));
  });
}

function handleLogs(req, res) {
  if (!requireAuth(req, res)) return;
  
  let logs = '';
  try {
    const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d+\|[^|]+\| ?/gm, '');
    const out = strip(execSync('tail -60 ~/.pm2/logs/pi-dashboard-out.log 2>/dev/null || tail -60 ~/.pm2/logs/pi-dashboard-out.log 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }));
    const err = strip(execSync('tail -30 ~/.pm2/logs/pi-dashboard-error.log 2>/dev/null || tail -30 ~/.pm2/logs/pi-dashboard-error.log 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }));
    logs = '── stdout ──\n' + (out.trim() || '(empty)') + '\n\n── stderr ──\n' + (err.trim() || '(empty)');
  } catch(e) { logs = 'Could not fetch logs: ' + e.message; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ logs }));
}

function handleDisplayPower(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { power } = JSON.parse(body); // "on", "off", "status"
      const wlrEnv = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';
      if (power === 'status') {
        // Status check doesn't require auth
        const out = execSync(`${wlrEnv} wlr-randr 2>/dev/null`, { encoding: 'utf8' });
        const isOn = out.includes('Enabled: yes');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ power: isOn ? 'on' : 'off' }));
      } else {
        // Power control requires auth
        if (!requireAuth(req, res)) return;
        const flag = power === 'on' ? '--on' : '--off';
        execSync(`${wlrEnv} wlr-randr --output HDMI-A-1 ${flag} 2>/dev/null`, { encoding: 'utf8' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, power }));
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleSystemInfo(req, res) {
  try {
    const info = {};
    info.hostname = execSync('hostname', { encoding: 'utf8' }).trim();
    info.model = execSync('cat /proc/device-tree/model 2>/dev/null || echo "Unknown"', { encoding: 'utf8' }).trim().replace(/\0/g, '');
    info.uptime = execSync('uptime -p 2>/dev/null || uptime', { encoding: 'utf8' }).trim();
    info.memory = execSync("free -m | awk '/Mem:/ {printf \"%dMB / %dMB (%.0f%%)\", $3, $2, $3/$2*100}'", { encoding: 'utf8' }).trim();
    info.disk = execSync("df -h / | awk 'NR==2 {printf \"%s / %s (%s)\", $3, $2, $5}'", { encoding: 'utf8' }).trim();
    info.cpu_temp = execSync('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "0"', { encoding: 'utf8' }).trim();
    info.cpu_temp = (parseInt(info.cpu_temp) / 1000).toFixed(1) + '°C';
    info.node = process.version;
    info.ip = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
    info.os = execSync('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"', { encoding: 'utf8' }).trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
  } catch(e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function handleChangePin(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { newPin } = JSON.parse(body);
      if (!newPin || !/^\d{4,8}$/.test(newPin)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'PIN must be 4-8 digits' }));
        return;
      }
      config.adminPin = newPin;
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleReboot(req, res) {
  if (!requireAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  const { exec: execAsync } = require('child_process');
  setTimeout(() => { execAsync('sudo reboot 2>/dev/null || echo b > /proc/sysrq-trigger', () => {}); }, 500);
}

function handleRestart(req, res) {
  if (!requireAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  setTimeout(() => { process.exit(0); }, 500); // PM2 will restart
}

// Night mode display scheduler & auto-update
let nightModeTimer = null;
function scheduleNightMode() {
  if (nightModeTimer) clearInterval(nightModeTimer);
  if (!config.display?.nightModeEnabled && !config.updates?.autoUpdate) return;
  
  nightModeTimer = setInterval(() => {
    const now = new Date();
    const hhmm = now.getHours() * 100 + now.getMinutes();
    
    // Night mode display control
    if (config.display?.nightModeEnabled) {
      const start = parseInt((config.display.nightModeStart || '22:00').replace(':', '')) || 2200;
      const end = parseInt((config.display.nightModeEnd || '06:00').replace(':', '')) || 600;
      const shouldBeOff = start > end ? (hhmm >= start || hhmm < end) : (hhmm >= start && hhmm < end);
      if (config.display.nightModeAction === 'off') {
        const wlrEnv = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';
        const flag = shouldBeOff ? '--off' : '--on';
        try { execSync(`${wlrEnv} wlr-randr --output HDMI-A-1 ${flag} 2>/dev/null`); } catch(e) {}
      }
    }
    
    // Auto-update check
    if (config.updates?.autoUpdate) {
      const hour = now.getHours();
      const minute = now.getMinutes();
      const updateHour = config.updates.autoUpdateHour ?? 3;
      
      // Check if it's the right hour and we haven't updated today
      if (hour === updateHour && minute < 5) {
        const lastUpdate = config.updates.lastUpdate ? new Date(config.updates.lastUpdate) : null;
        const today = now.toDateString();
        const lastUpdateDay = lastUpdate ? lastUpdate.toDateString() : null;
        
        if (today !== lastUpdateDay) {
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

// Version check cache
let versionCache = { timestamp: 0, data: null };
const VERSION_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

async function checkForUpdates(forceRefresh = false) {
  const now = Date.now();
  
  // Return cached data if fresh enough
  if (!forceRefresh && versionCache.data && (now - versionCache.timestamp) < VERSION_CACHE_DURATION) {
    return versionCache.data;
  }
  
  try {
    const apiUrl = 'https://api.github.com/repos/twitchkiddie/displayboard/releases/latest';
    const raw = await httpGet(apiUrl, { 
      headers: { 'User-Agent': 'DisplayBoard-Pi' },
      timeout: 10000 
    });
    const release = JSON.parse(raw);
    
    // Check if release has the expected structure
    if (!release || !release.tag_name) {
      const result = { version: VERSION, latest: VERSION, updateAvailable: false, changelog: '', error: 'No releases found' };
      versionCache = { timestamp: now, data: result };
      return result;
    }
    
    const latestVersion = release.tag_name.replace(/^v/, '');
    const updateAvailable = latestVersion !== VERSION;
    
    const result = {
      version: VERSION,
      latest: latestVersion,
      updateAvailable,
      changelog: release.body || '',
      tarballUrl: release.tarball_url,
      publishedAt: release.published_at
    };
    
    versionCache = { timestamp: now, data: result };
    
    // Update lastCheck in config
    config.updates.lastCheck = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
    } catch(e) {}
    
    return result;
  } catch (err) {
    // If GitHub check fails, return current version info
    console.error('Version check error:', err.message);
    const errorMsg = err.message.includes('Not Found') || err.message.includes('No releases') 
      ? 'No releases found on GitHub yet' 
      : err.message;
    
    return {
      version: VERSION,
      latest: VERSION,
      updateAvailable: false,
      changelog: '',
      error: errorMsg
    };
  }
}

// Update status tracking
let updateStatus = { state: 'idle', message: '', progress: 0 };

async function performUpdate() {
  if (updateStatus.state !== 'idle') {
    throw new Error('Update already in progress');
  }
  
  updateStatus = { state: 'checking', message: 'Checking for updates...', progress: 5 };
  
  try {
    // Check for updates
    const versionInfo = await checkForUpdates(true);
    
    if (!versionInfo.updateAvailable) {
      updateStatus = { state: 'complete', message: 'Already up to date', progress: 100 };
      return;
    }
    
    if (!versionInfo.latest) {
      throw new Error('No version info found in release');
    }

    // Use direct GitHub download URL (avoids multi-hop API redirects)
    const downloadUrl = `https://github.com/twitchkiddie/displayboard/archive/refs/tags/v${versionInfo.latest}.tar.gz`;

    updateStatus = { state: 'downloading', message: 'Downloading update...', progress: 10 };
    console.log('📥 Downloading update from:', downloadUrl);

    // Download tarball
    const tarballPath = '/tmp/displayboard-update.tar.gz';
    await httpDownload(downloadUrl, tarballPath);
    
    updateStatus = { state: 'extracting', message: 'Extracting files...', progress: 30 };
    console.log('📦 Extracting tarball...');
    
    // Extract to temp directory
    const extractDir = '/tmp/displayboard-update';
    try { execSync(`rm -rf ${extractDir}`); } catch(e) {}
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf ${tarballPath} -C ${extractDir} --strip-components=1`);
    
    updateStatus = { state: 'backing-up', message: 'Creating backup...', progress: 50 };
    console.log('💾 Creating backup...');
    
    // Create backup (exclude config, photos, node_modules, cache, and .backup itself)
    const backupDir = path.join(__dirname, '.backup');
    try { execSync(`rm -rf ${backupDir}`); } catch(e) {}
    fs.mkdirSync(backupDir, { recursive: true });
    
    const preserveList = ['config.json', 'photos', 'node_modules', '.calendar-cache.json', '.backup'];
    const allFiles = fs.readdirSync(__dirname);
    
    for (const file of allFiles) {
      if (!preserveList.includes(file) && !file.startsWith('.')) {
        try {
          const src = path.join(__dirname, file);
          const dest = path.join(backupDir, file);
          execSync(`cp -r "${src}" "${dest}"`);
        } catch(e) {
          console.error(`Backup warning: ${file}:`, e.message);
        }
      }
    }
    
    updateStatus = { state: 'installing', message: 'Installing files...', progress: 70 };
    console.log('📂 Installing new files...');
    
    // Check if package.json changed
    let packageChanged = false;
    try {
      const oldPkg = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
      const newPkg = fs.readFileSync(path.join(extractDir, 'package.json'), 'utf8');
      packageChanged = oldPkg !== newPkg;
    } catch(e) {}
    
    // Copy new files over (preserving the preserve list)
    const newFiles = fs.readdirSync(extractDir);
    for (const file of newFiles) {
      if (!preserveList.includes(file)) {
        try {
          const src = path.join(extractDir, file);
          const dest = path.join(__dirname, file);
          execSync(`cp -r "${src}" "${dest}"`);
        } catch(e) {
          console.error(`Install warning: ${file}:`, e.message);
        }
      }
    }
    
    // Run npm install if package.json changed
    if (packageChanged) {
      updateStatus = { state: 'installing', message: 'Installing dependencies...', progress: 85 };
      console.log('📦 Running npm install...');
      try {
        execSync('npm install --production', { cwd: __dirname, timeout: 120000 });
      } catch(e) {
        console.error('npm install error:', e.message);
      }
    }
    
    // Update config with last update time
    config.updates.lastUpdate = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
    } catch(e) {}
    
    updateStatus = { state: 'restarting', message: 'Restarting server...', progress: 95 };
    console.log('🔄 Update complete! Restarting in 2 seconds...');
    
    // Schedule restart
    setTimeout(() => {
      updateStatus = { state: 'complete', message: 'Update complete', progress: 100 };
      process.exit(0); // PM2 will restart
    }, 2000);
    
  } catch (err) {
    console.error('❌ Update failed:', err.message);
    updateStatus = { state: 'failed', message: err.message, progress: 0 };
    throw err;
  }
}

async function performRollback() {
  const backupDir = path.join(__dirname, '.backup');
  
  if (!fs.existsSync(backupDir)) {
    throw new Error('No backup found. Cannot rollback.');
  }
  
  console.log('⏪ Rolling back to previous version...');
  
  try {
    // Copy all files from backup back
    const backupFiles = fs.readdirSync(backupDir);
    for (const file of backupFiles) {
      const src = path.join(backupDir, file);
      const dest = path.join(__dirname, file);
      execSync(`cp -r "${src}" "${dest}"`);
    }
    
    console.log('✅ Rollback complete. Restarting...');
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    console.error('❌ Rollback failed:', err.message);
    throw err;
  }
}

function handleVersionInfo(req, res) {
  const query = url.parse(req.url, true).query;
  const forceRefresh = query.force === 'true';
  
  checkForUpdates(forceRefresh)
    .then(info => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    })
    .catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
}

function handleUpdate(req, res) {
  if (!requireAuth(req, res)) return;
  
  if (updateStatus.state !== 'idle') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Update already in progress' }));
    return;
  }
  
  // Start update asynchronously
  performUpdate().catch(err => {
    console.error('Update error:', err.message);
  });
  
  // Return immediately
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message: 'Update started' }));
}

function handleUpdateStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(updateStatus));
}

function handleRollback(req, res) {
  if (!requireAuth(req, res)) return;
  
  performRollback()
    .then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    })
    .catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
}

function handleBackupExists(req, res) {
  const backupDir = path.join(__dirname, '.backup');
  const exists = fs.existsSync(backupDir);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ exists }));
}

function handleGetHostname(req, res) {
  const { execSync } = require('child_process');
  try {
    const hostname = execSync('hostname', { encoding: 'utf8' }).trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hostname }));
  } catch(err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleSetHostname(req, res) {
  if (!requireAuth(req, res)) return;
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { hostname } = JSON.parse(body);
      if (!hostname || !/^[a-z0-9-]+$/.test(hostname)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid hostname' }));
      }
      const { execSync } = require('child_process');
      const oldHostname = execSync('hostname', { encoding: 'utf8' }).trim();
      // Update /etc/hostname
      execSync(`echo '${hostname}' | sudo tee /etc/hostname`, { encoding: 'utf8' });
      // Update /etc/hosts
      execSync(`sudo sed -i 's/127\.0\.1\.1.*${oldHostname}/127.0.1.1\t${hostname}/g' /etc/hosts`, { encoding: 'utf8' });
      console.log("🖥️  Hostname changed: " + oldHostname + " → " + hostname);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hostname }));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleVersion(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ version: configVersion }));
}

// Display info — reads current state from wlr-randr --json
function handleDisplayInfo(req, res) {
  try {
    const wlrEnv = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';
    const raw = execSync(`${wlrEnv} wlr-randr --json 2>/dev/null`, { encoding: 'utf8' });
    const data = JSON.parse(raw);
    const output = data[0];

    // Deduplicate resolutions — keep highest refresh rate per resolution
    const resMap = {};
    for (const mode of (output.modes || [])) {
      const key = `${mode.width}x${mode.height}`;
      if (!resMap[key] || mode.refresh > resMap[key]) {
        resMap[key] = mode.refresh;
      }
    }

    const currentMode = (output.modes || []).find(m => m.current);
    const currentRes = currentMode ? `${currentMode.width}x${currentMode.height}` : null;
    const currentRefresh = currentMode ? Math.round(currentMode.refresh) : null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      output: output.name,
      enabled: output.enabled !== false,
      resolution: currentRes,
      refresh: currentRefresh,
      orientation: output.transform || 'normal',
      scale: output.scale || 1.0,
      availableResolutions: Object.keys(resMap),
      availableOrientations: ['normal', '90', '180', '270']
    }));
  } catch(e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// Display settings — applies resolution/orientation/scale via wlr-randr and persists to config
function handleDisplaySettings(req, res) {
  if (!requireAuth(req, res)) return;
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { resolution, orientation, scale } = JSON.parse(body);
      const wlrEnv = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';

      // Get output name dynamically
      const infoRaw = execSync(`${wlrEnv} wlr-randr --json 2>/dev/null`, { encoding: 'utf8' });
      const infoData = JSON.parse(infoRaw);
      const outputName = infoData[0].name;

      // Build single combined command
      let cmd = `${wlrEnv} wlr-randr --output ${outputName}`;
      if (resolution) cmd += ` --mode ${resolution}`;
      if (orientation !== undefined && orientation !== null) cmd += ` --transform ${orientation}`;
      if (scale !== undefined && scale !== null) cmd += ` --scale ${scale}`;

      execSync(cmd + ' 2>/dev/null', { encoding: 'utf8' });
      console.log(`🖥️  Display settings applied: resolution=${resolution} orientation=${orientation} scale=${scale}`);

      // Persist to config.display
      config.display = config.display || {};
      if (resolution) config.display.resolution = resolution;
      if (orientation !== undefined && orientation !== null) config.display.orientation = orientation;
      if (scale !== undefined && scale !== null) config.display.scale = parseFloat(scale);
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      console.error('Display settings error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// Apply persisted display settings on startup
function applyDisplaySettings() {
  try {
    const { resolution, orientation, scale } = config.display || {};
    if (!resolution && orientation === undefined && scale === undefined) return;
    const wlrEnv = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';
    const infoRaw = execSync(`${wlrEnv} wlr-randr --json 2>/dev/null`, { encoding: 'utf8' });
    const infoData = JSON.parse(infoRaw);
    const outputName = infoData[0].name;
    let cmd = `${wlrEnv} wlr-randr --output ${outputName}`;
    if (resolution) cmd += ` --mode ${resolution}`;
    if (orientation !== undefined && orientation !== null) cmd += ` --transform ${orientation}`;
    if (scale !== undefined && scale !== null) cmd += ` --scale ${scale}`;
    execSync(cmd + ' 2>/dev/null', { encoding: 'utf8' });
    console.log(`🖥️  Startup display settings applied: resolution=${resolution} orientation=${orientation} scale=${scale}`);
  } catch(e) {
    console.error('❌ applyDisplaySettings failed:', e.message);
  }
}

// Auth endpoint for admin panel
function handleAuth(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { pin } = JSON.parse(body);
      if (pin === config.adminPin) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid PIN' }));
      }
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
    }
  });
}

// Router
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url, true).pathname;
  // First-run: redirect to setup page
  if ((pathname === '/' || pathname === '/index.html') && isFirstRun()) {
    const setupPath = path.join(__dirname, 'setup-welcome.html');
    fs.readFile(setupPath, (err, data) => {
      if (err) { res.writeHead(302, { Location: '/admin.html' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (pathname === '/api/auth' && req.method === 'POST') return handleAuth(req, res);
  if (pathname === '/api/display-info' && req.method === 'GET') return handleDisplayInfo(req, res);
  if (pathname === '/api/display-settings' && req.method === 'POST') return handleDisplaySettings(req, res);
  if (pathname === '/api/weather-extended') return handleWeatherExtended(req, res);
  if (pathname === '/api/calendar') return handleCalendar(req, res);
  if (pathname === '/api/photos') return handlePhotos(req, res);
  if (pathname === '/api/config' && req.method === 'POST') return handleConfigPost(req, res);
  if (pathname === '/api/config') return handleConfigGet(req, res);
  if (pathname === '/api/hostname' && req.method === 'GET') return handleGetHostname(req, res);
  if (pathname === '/api/hostname' && req.method === 'POST') return handleSetHostname(req, res);
  if (pathname === '/api/version') return handleVersion(req, res);
  if (pathname === '/api/refresh') { configVersion++; res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,version:configVersion})); return; }
  if (pathname === '/api/refresh-calendar' && req.method === 'POST') return handleRefreshCalendar(req, res);
  if (pathname === '/api/clear-cache' && req.method === 'POST') return handleClearCache(req, res);
  if (pathname === '/api/sync-photos' && req.method === 'POST') return handleSyncPhotos(req, res);
  if (pathname === '/api/upload-photo' && req.method === 'POST') return handleUploadPhoto(req, res);
  if (pathname === '/api/logs') return handleLogs(req, res);
  if (pathname === '/api/system-info') return handleSystemInfo(req, res);
  if (pathname === '/api/display-power' && req.method === 'POST') return handleDisplayPower(req, res);
  if (pathname === '/api/change-pin' && req.method === 'POST') { if (!requireAuth(req, res)) return; return handleChangePin(req, res); }
  if (pathname === '/api/reboot' && req.method === 'POST') return handleReboot(req, res);
  if (pathname === '/api/restart' && req.method === 'POST') return handleRestart(req, res);
  if (pathname === '/api/version-info') return handleVersionInfo(req, res);
  if (pathname === '/api/update' && req.method === 'POST') return handleUpdate(req, res);
  if (pathname === '/api/update-status') return handleUpdateStatus(req, res);
  if (pathname === '/api/rollback' && req.method === 'POST') return handleRollback(req, res);
  if (pathname === '/api/backup-exists') return handleBackupExists(req, res);
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🖼️  Pi DisplayBoard running at http://localhost:${PORT}`);
  console.log(`📅 Calendars: ${(config.calendars||[]).filter(c=>c.enabled).map(c=>c.name).join(', ')}`);
  // Apply persisted display settings after a short delay (Wayland needs to be ready)
  setTimeout(applyDisplaySettings, 5000);
});

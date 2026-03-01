#!/usr/bin/env node
/**
 * DisplayBoard Server
 * Self-contained photo & calendar dashboard for Raspberry Pi
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3000;

// Timestamp all console output
const origLog = console.log, origErr = console.error;
function ts() { 
  return new Date().toLocaleString('en-US', { 
    hour12: false, year: 'numeric', month: '2-digit', 
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' 
  }); 
}
console.log = (...args) => origLog(`[${ts()}]`, ...args);
console.error = (...args) => origErr(`[${ts()}]`, ...args);

// Load configuration (create default if missing)
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {};
let configVersion = 1;

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    // Create default config from example
    const examplePath = path.join(__dirname, 'config.example.json');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, CONFIG_FILE);
      console.log('Created default config.json from example');
    } else {
      // Fallback minimal config
      config = {
        location: { name: '', latitude: 40.7128, longitude: -74.0060, timezone: 'America/New_York' },
        calendars: [],
        display: { calendarDays: 5, photoInterval: 30, calendarRefresh: 5, weatherRefresh: 10 },
        photos: { source: 'local', localPath: './photos', shuffle: true },
        photoAlbumToken: ''
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log('Created minimal config.json');
    }
  }
  
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function reloadConfig() {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  configVersion++;
  console.log('Configuration reloaded (version ' + configVersion + ')');
}

function needsSetup() {
  return !config.location || !config.location.name || 
         !config.calendars || config.calendars.length === 0 ||
         !config.calendars.some(c => c.enabled && c.url);
}

loadConfig();

// Watch config and served files for changes
function watchForChanges() {
  const watchFiles = ['config.json', 'index.html', 'style.css', 'dashboard.js', 'admin.html'];
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
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : decodeURIComponent(req.url));
  
  // Security check: prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, data) => {
    if (err) { 
      res.writeHead(404); 
      res.end('Not Found'); 
      return; 
    }
    res.writeHead(200, { 
      'Content-Type': contentType, 
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' 
    });
    res.end(data);
  });
}

function httpGet(reqUrl) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const req = lib.get(reqUrl, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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
  let h = d.getHours(); 
  const ap = h >= 12 ? 'pm' : 'am';
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
  const names = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous',
                 'Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  return { name: names[Math.round(frac*8)%8], icon: 'wi-moon-'+idx, phase: idx };
}

// API: Weather
async function handleWeatherExtended(req, res) {
  try {
    if (!config.location || !config.location.latitude) {
      throw new Error('Location not configured');
    }
    
    const { latitude: LAT, longitude: LON, timezone: TZ } = config.location;
    const raw = await httpGet(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=${TZ}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,sunrise,sunset&current=temperature_2m,apparent_temperature,weathercode`);
    const data = JSON.parse(raw);
    
    if (!data.current || !data.daily) throw new Error('Invalid weather response');
    
    const moon = getMoonPhase(new Date());
    const current = { 
      temp: Math.round(data.current.temperature_2m), 
      feelsLike: Math.round(data.current.apparent_temperature), 
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
        label: i===0?'Today':dayNames[(today+i)%7], 
        icon: getWeatherIcon(data.daily.weathercode[i]), 
        text: getWeatherText(data.daily.weathercode[i]), 
        precip: data.daily.precipitation_probability_max[i]||0, 
        high: Math.round(data.daily.temperature_2m_max[i]), 
        low: Math.round(data.daily.temperature_2m_min[i]) 
      });
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ current, forecast }));
  } catch (err) {
    console.error('Weather error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Calendar cache — parse in background, serve from cache
let calendarCache = { events: [], lastUpdated: 0 };
const CACHE_FILE = path.join(__dirname, '.calendar-cache.json');

try { 
  calendarCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); 
  console.log('📅 Loaded cached calendar: ' + (calendarCache.events?.length||0) + ' events'); 
} catch(e) {}

let calendarUpdating = false;

function updateCalendarCache() {
  if (calendarUpdating) return;
  if (!config.calendars || config.calendars.filter(c => c.enabled && c.url).length === 0) {
    console.log('📅 No calendars configured, skipping update');
    return;
  }
  
  calendarUpdating = true;
  const days = config.display?.calendarDays || 5;
  const calScript = path.join(__dirname, 'calendar-all.js');
  const { exec: execAsync } = require('child_process');
  
  execAsync(`node "${calScript}" ${days} "${CONFIG_FILE}" --json`, { timeout: 120000 }, (err, stdout, stderr) => {
    calendarUpdating = false;
    if (err) { 
      console.error('Calendar cache update error:', err.message); 
      return; 
    }
    try {
      calendarCache = JSON.parse(stdout);
      calendarCache.lastUpdated = Date.now();
      console.log(`📅 Calendar cache updated: ${calendarCache.events?.length || 0} events`);
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(calendarCache)); } catch(e) {}
    } catch(e) { 
      console.error('Calendar parse error:', e.message); 
    }
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

function handleConfigGet(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(config));
}

function handleConfigPost(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const newConfig = JSON.parse(body);
      
      // Preserve calendar URLs from existing config if not provided
      if (newConfig.calendars && config.calendars) {
        newConfig.calendars.forEach((cal, i) => {
          if (!cal.url && config.calendars[i]?.url) {
            cal.url = config.calendars[i].url;
          }
        });
      }
      
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
      config = newConfig;
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
  updateCalendarCache();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message: 'Calendar refresh started' }));
}

function handleClearCache(req, res) {
  try { fs.unlinkSync(CACHE_FILE); } catch(e) {}
  calendarCache = { events: [], lastUpdated: 0 };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleSyncPhotos(req, res) {
  const syncScript = path.join(__dirname, 'icloud-album-sync.js');
  const { exec: execAsync } = require('child_process');
  const token = config.photoAlbumToken || '';
  
  if (!token) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No photo album token configured' }));
    return;
  }
  
  execAsync(`node "${syncScript}" "${token}" "${path.join(__dirname, 'photos')}"`, 
    { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) console.error('Photo sync error:', err.message);
      else console.log('📸 Photo sync complete:', stdout.trim());
    });
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message: 'Photo sync started' }));
}

function handleUploadPhoto(req, res) {
  const photosDir = path.join(__dirname, 'photos');
  if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });

  // Parse multipart form data (simple parser)
  const boundary = req.headers['content-type']?.split('boundary=')[1];
  if (!boundary) { 
    res.writeHead(400); 
    res.end('No boundary'); 
    return; 
  }
  
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const boundaryBuf = Buffer.from('--' + boundary);
    
    // Find file data between headers and next boundary
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) { 
      res.writeHead(400); 
      res.end('Bad upload'); 
      return; 
    }
    
    const headerStr = buf.slice(0, headerEnd).toString();
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `upload-${Date.now()}.jpg`;
    const dataStart = headerEnd + 4;
    const endBoundary = buf.indexOf(boundaryBuf, dataStart);
    const fileData = buf.slice(dataStart, endBoundary > 0 ? endBoundary - 2 : buf.length);
    
    fs.writeFileSync(path.join(photosDir, filename), fileData);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, filename }));
  });
}

function handleLogs(req, res) {
  let logs = '';
  try {
    const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d+\|[^|]+\| ?/gm, '');
    const out = strip(execSync('tail -60 ~/.pm2/logs/*displayboard*out.log 2>/dev/null || echo ""', 
      { encoding: 'utf8', timeout: 5000 }));
    const err = strip(execSync('tail -30 ~/.pm2/logs/*displayboard*error.log 2>/dev/null || echo ""', 
      { encoding: 'utf8', timeout: 5000 }));
    logs = '── stdout ──\n' + (out.trim() || '(empty)') + '\n\n── stderr ──\n' + (err.trim() || '(empty)');
  } catch(e) { 
    logs = 'Could not fetch logs: ' + e.message; 
  }
  
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
        const out = execSync(`${wlrEnv} wlr-randr 2>/dev/null`, { encoding: 'utf8' });
        const isOn = out.includes('Enabled: yes');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ power: isOn ? 'on' : 'off' }));
      } else {
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
    info.model = execSync('cat /proc/device-tree/model 2>/dev/null || echo "Unknown"', 
      { encoding: 'utf8' }).trim().replace(/\0/g, '');
    info.uptime = execSync('uptime -p 2>/dev/null || uptime', { encoding: 'utf8' }).trim();
    info.memory = execSync("free -m | awk '/Mem:/ {printf \"%dMB / %dMB (%.0f%%)\", $3, $2, $3/$2*100}'", 
      { encoding: 'utf8' }).trim();
    info.disk = execSync("df -h / | awk 'NR==2 {printf \"%s / %s (%s)\", $3, $2, $5}'", 
      { encoding: 'utf8' }).trim();
    info.cpu_temp = execSync('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "0"', 
      { encoding: 'utf8' }).trim();
    info.cpu_temp = (parseInt(info.cpu_temp) / 1000).toFixed(1) + '°C';
    info.node = process.version;
    info.ip = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
    info.os = execSync('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"', 
      { encoding: 'utf8' }).trim();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
  } catch(e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function handleReboot(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  const { exec: execAsync } = require('child_process');
  setTimeout(() => { 
    execAsync('sudo reboot 2>/dev/null || echo b > /proc/sysrq-trigger', () => {}); 
  }, 500);
}

function handleRestart(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  setTimeout(() => { process.exit(0); }, 500); // PM2 will restart
}

// Night mode display scheduler
let nightModeTimer = null;

function scheduleNightMode() {
  if (nightModeTimer) clearInterval(nightModeTimer);
  if (!config.display?.nightModeEnabled) return;
  
  nightModeTimer = setInterval(() => {
    const now = new Date();
    const hhmm = now.getHours() * 100 + now.getMinutes();
    const start = parseInt((config.display.nightModeStart || '22:00').replace(':', '')) || 2200;
    const end = parseInt((config.display.nightModeEnd || '06:00').replace(':', '')) || 600;
    const shouldBeOff = start > end ? (hhmm >= start || hhmm < end) : (hhmm >= start && hhmm < end);
    
    if (config.display.nightModeAction === 'off') {
      const wlrEnv = 'WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000';
      const flag = shouldBeOff ? '--off' : '--on';
      try { 
        execSync(`${wlrEnv} wlr-randr --output HDMI-A-1 ${flag} 2>/dev/null`); 
      } catch(e) {}
    }
  }, 60000);
}

scheduleNightMode();

function handleVersion(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ version: configVersion }));
}

// Router
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url, true).pathname;
  
  // If first-run setup needed, redirect to admin
  if (pathname === '/' && needsSetup()) {
    res.writeHead(302, { 'Location': '/admin.html' });
    res.end();
    return;
  }
  
  // API routes
  if (pathname === '/api/weather-extended') return handleWeatherExtended(req, res);
  if (pathname === '/api/calendar') return handleCalendar(req, res);
  if (pathname === '/api/photos') return handlePhotos(req, res);
  if (pathname === '/api/config' && req.method === 'POST') return handleConfigPost(req, res);
  if (pathname === '/api/config') return handleConfigGet(req, res);
  if (pathname === '/api/version') return handleVersion(req, res);
  if (pathname === '/api/refresh') { 
    configVersion++; 
    res.writeHead(200, {'Content-Type':'application/json'}); 
    res.end(JSON.stringify({ok:true,version:configVersion})); 
    return; 
  }
  if (pathname === '/api/refresh-calendar' && req.method === 'POST') return handleRefreshCalendar(req, res);
  if (pathname === '/api/clear-cache' && req.method === 'POST') return handleClearCache(req, res);
  if (pathname === '/api/sync-photos' && req.method === 'POST') return handleSyncPhotos(req, res);
  if (pathname === '/api/upload-photo' && req.method === 'POST') return handleUploadPhoto(req, res);
  if (pathname === '/api/logs') return handleLogs(req, res);
  if (pathname === '/api/system-info') return handleSystemInfo(req, res);
  if (pathname === '/api/display-power' && req.method === 'POST') return handleDisplayPower(req, res);
  if (pathname === '/api/reboot' && req.method === 'POST') return handleReboot(req, res);
  if (pathname === '/api/restart' && req.method === 'POST') return handleRestart(req, res);
  
  // Static files
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  const getIP = () => {
    try {
      return execSync("hostname -I 2>/dev/null | awk '{print $1}'", { encoding: 'utf8' }).trim() || 'localhost';
    } catch(e) {
      return 'localhost';
    }
  };
  
  const ip = getIP();
  console.log(`🖼️  DisplayBoard running at http://${ip}:${PORT}`);
  console.log(`📅 Calendars: ${(config.calendars||[]).filter(c=>c.enabled).map(c=>c.name).join(', ') || 'None configured'}`);
  
  if (needsSetup()) {
    console.log(`⚙️  First-run setup needed - visit http://${ip}:${PORT}/admin.html`);
  }
});

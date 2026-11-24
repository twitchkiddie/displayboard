/**
 * Pure helpers for input validation, static-file confinement, and auth.
 * No I/O besides DNS lookups in assertFetchableUrl, so unit tests can
 * import this module without starting the server or reading config.json.
 */

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const path = require('path');

const DEFAULT_PIN = '123456';

// Files that hold credentials or private calendar/album data. They live next
// to the server so the Pi can read them, and must never be served over HTTP.
const BLOCKED_BASENAMES = new Set([
  'config.json',
  'wifi-pending.json',
  'package-lock.json',
]);

const DISPLAY_ORIENTATIONS = new Set([
  'normal', '90', '180', '270',
  'flipped', 'flipped-90', 'flipped-180', 'flipped-270',
]);

const UPDATE_HOSTS = new Set([
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
]);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

class AuthRateLimiter {
  constructor({ maxFailures = 8, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.attempts = new Map();
  }

  _prune(now) {
    if (this.attempts.size <= 1000) return;
    const first = this.attempts.keys().next().value;
    this.attempts.delete(first);
    void now;
  }

  check(key, now = Date.now()) {
    const rec = this.attempts.get(key);
    if (!rec) return { ok: true };
    if (rec.lockedUntil && rec.lockedUntil > now) {
      return { ok: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
    }
    if (rec.lockedUntil && rec.lockedUntil <= now) this.attempts.delete(key);
    return { ok: true };
  }

  fail(key, now = Date.now()) {
    this._prune(now);
    let rec = this.attempts.get(key);
    if (!rec || now - rec.windowStart > this.windowMs) {
      rec = { count: 0, windowStart: now, lockedUntil: 0 };
    }
    rec.count += 1;
    if (rec.count >= this.maxFailures) rec.lockedUntil = now + this.lockMs;
    this.attempts.set(key, rec);
    return this.check(key, now);
  }

  success(key) {
    this.attempts.delete(key);
  }
}

function resolveStaticPath(root, requestPath) {
  if (typeof requestPath !== 'string' || requestPath.length === 0) {
    return { ok: false, status: 400 };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0]);
  } catch (_) {
    return { ok: false, status: 400 };
  }
  if (decoded.includes('\0')) return { ok: false, status: 400 };

  const rootResolved = path.resolve(root);
  // Normalize as a URL path first so ".." cannot escape into a sibling
  // directory whose name merely starts with the project directory name.
  const normalized = path.posix.normalize('/' + decoded);
  if (!normalized.startsWith('/')) return { ok: false, status: 403 };

  const filePath = path.resolve(rootResolved, '.' + normalized);
  const rel = path.relative(rootResolved, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, status: 403 };
  }

  for (const seg of rel.split(path.sep)) {
    if (!seg || seg.startsWith('.')) return { ok: false, status: 403 };
    if (BLOCKED_BASENAMES.has(seg)) return { ok: false, status: 403 };
  }
  return { ok: true, filePath };
}

function hasControlChars(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function validateWifiCredentials(ssid, password) {
  if (typeof ssid !== 'string' || ssid.length < 1 || Buffer.byteLength(ssid) > 32) {
    return 'Invalid SSID';
  }
  if (hasControlChars(ssid) || ssid.includes('[') || ssid.includes(']')) {
    return 'Invalid SSID';
  }
  if (password == null || password === '') return null;
  if (typeof password !== 'string' || password.length < 8 || password.length > 63) {
    return 'WiFi password must be 8-63 characters';
  }
  if (hasControlChars(password) || password.includes('[') || password.includes(']')) {
    return 'Invalid WiFi password';
  }
  return null;
}

function wifiConnectionName(ssid) {
  const safe = String(ssid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  return `displayboard-${safe || 'wifi'}`;
}

function buildNmConnection(ssid, password) {
  const error = validateWifiCredentials(ssid, password);
  if (error) throw new Error(error);
  const lines = [
    '[connection]',
    `id=${ssid}`,
    'type=wifi',
    'autoconnect=true',
    '',
    '[wifi]',
    'mode=infrastructure',
    `ssid=${ssid}`,
    '',
  ];
  if (password) {
    lines.push(
      '[wifi-security]',
      'auth-alg=open',
      'key-mgmt=wpa-psk',
      `psk=${password}`,
      'psk-flags=0',
      ''
    );
  }
  lines.push('[ipv4]', 'method=auto', '', '[ipv6]', 'method=auto', '');
  return lines.join('\n') + '\n';
}

function isSafeOutputName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name) && !name.startsWith('.');
}

function validateDisplaySettings({ resolution, orientation, scale } = {}) {
  const value = {};
  if (resolution !== undefined && resolution !== null && resolution !== '') {
    if (typeof resolution !== 'string' || !/^\d{3,5}x\d{3,5}$/.test(resolution)) {
      return { error: 'Invalid resolution' };
    }
    value.resolution = resolution;
  }
  if (orientation !== undefined && orientation !== null && orientation !== '') {
    if (!DISPLAY_ORIENTATIONS.has(String(orientation))) return { error: 'Invalid orientation' };
    value.orientation = String(orientation);
  }
  if (scale !== undefined && scale !== null && scale !== '') {
    const n = Number(scale);
    if (!Number.isFinite(n) || n < 0.1 || n > 4) return { error: 'Invalid scale' };
    value.scale = n;
  }
  return { value };
}

function sanitizeUploadFilename(name) {
  const base = path.basename(String(name || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!base || base === '.' || base === '..' || base.includes('..')) return null;
  if (base.startsWith('.')) return null;
  if (!/\.(jpe?g|png)$/i.test(base)) return null;
  return base.slice(0, 120);
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value);
}

function isAlbumToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(token);
}

function isIcloudHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  return h === 'icloud.com' || h.endsWith('.icloud.com');
}

function isHostname(value) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function parseSemver(value) {
  const match = String(value || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewerVersion(latest, current) {
  const next = parseSemver(latest);
  const have = parseSemver(current);
  if (!next || !have) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] > have[i]) return true;
    if (next[i] < have[i]) return false;
  }
  return false;
}

function splitNmcli(line) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      i += 1;
    } else if (ch === ':') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function integerToIpv4(host) {
  if (!/^\d+$/.test(host)) return null;
  const n = Number(host);
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function isDangerousIp(ip) {
  let value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isDangerousIp(mapped);
  }
  const decimal = integerToIpv4(value);
  if (decimal) value = decimal;
  if (!net.isIP(value)) return false;
  if (net.isIPv4(value)) {
    const p = value.split('.').map(Number);
    if (p[0] === 0 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fe80:') || value.startsWith('fe80')) return true;
  return false;
}

function classifyUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (_) {
    return { ok: false, reason: 'invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported protocol' };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials in url' };
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    return { ok: false, reason: 'blocked host' };
  }
  const asIp = integerToIpv4(host) || (net.isIP(host) ? host : null);
  if (asIp && isDangerousIp(asIp)) return { ok: false, reason: 'blocked address' };
  return { ok: true, url: parsed };
}

function assertFetchableUrl(urlString) {
  const classified = classifyUrl(urlString);
  if (!classified.ok) return Promise.reject(new Error(classified.reason));
  const host = classified.url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) || integerToIpv4(host)) return Promise.resolve(classified.url);
  return dns.promises.lookup(host, { all: true, verbatim: true }).then((records) => {
    if (!records.length) throw new Error('blocked address');
    for (const record of records) {
      if (isDangerousIp(record.address)) throw new Error('blocked address');
    }
    return classified.url;
  });
}

function validateLocation(location) {
  const loc = location || {};
  const latitude = Number(loc.latitude);
  const longitude = Number(loc.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { error: 'Invalid latitude' };
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { error: 'Invalid longitude' };
  const timezone = String(loc.timezone || '');
  if (!/^[A-Za-z0-9_+\/-]{1,64}$/.test(timezone)) return { error: 'Invalid timezone' };
  return { value: { latitude, longitude, timezone } };
}

function clampCalendarDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.min(30, Math.max(1, Math.trunc(n)));
}

module.exports = {
  DEFAULT_PIN,
  UPDATE_HOSTS,
  BLOCKED_BASENAMES,
  safeEqual,
  AuthRateLimiter,
  resolveStaticPath,
  validateWifiCredentials,
  wifiConnectionName,
  buildNmConnection,
  isSafeOutputName,
  validateDisplaySettings,
  sanitizeUploadFilename,
  isHexColor,
  isAlbumToken,
  isIcloudHost,
  isHostname,
  parseSemver,
  isNewerVersion,
  splitNmcli,
  isDangerousIp,
  classifyUrl,
  assertFetchableUrl,
  validateLocation,
  clampCalendarDays,
};

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guards = require('../lib/guards');

test('resolveStaticPath stays inside the root and blocks secret files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'displayboard-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'ok');
  fs.mkdirSync(path.join(root, 'photos'));
  fs.writeFileSync(path.join(root, 'photos', 'pic.jpg'), 'img');
  fs.writeFileSync(path.join(root, 'config.json'), '{"adminPin":"9999"}');
  fs.writeFileSync(path.join(root, 'wifi-pending.json'), '{"password":"hunter2"}');

  const sibling = root + '-evil';
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'secret'), 'nope');

  const ok = guards.resolveStaticPath(root, '/photos/pic.jpg');
  assert.equal(ok.ok, true);
  assert.equal(ok.filePath, path.join(root, 'photos', 'pic.jpg'));

  for (const blocked of [
    '/config.json',
    '/wifi-pending.json',
    '/.calendar-cache.json',
    '/photos/%2e%2e/%2e%2e/config.json',
    '/%00index.html',
  ]) {
    const result = guards.resolveStaticPath(root, blocked);
    assert.equal(result.ok, false, blocked);
    assert.ok(result.status === 400 || result.status === 403, blocked);
  }

  // A sibling directory whose name extends the project directory must not be readable.
  for (const escaped of [
    '/../' + path.basename(sibling) + '/secret',
    '/photos/../../' + path.basename(sibling) + '/secret',
    '/%2e%2e/' + path.basename(sibling) + '/secret',
  ]) {
    const result = guards.resolveStaticPath(root, escaped);
    if (result.ok) {
      const rel = path.relative(root, result.filePath);
      assert.equal(rel.startsWith('..'), false, escaped);
      assert.notEqual(result.filePath, path.join(sibling, 'secret'));
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
});

test('PIN compare is equal only for the same value', () => {
  assert.equal(guards.safeEqual('123456', '123456'), true);
  assert.equal(guards.safeEqual('123456', '123457'), false);
  assert.equal(guards.safeEqual('123456', 123456), true);
});

test('auth rate limiter locks after repeated failures', () => {
  const limiter = new guards.AuthRateLimiter({ maxFailures: 3, windowMs: 1000, lockMs: 5000 });
  const now = 1_000_000;
  assert.equal(limiter.fail('10.0.0.2', now).ok, true);
  assert.equal(limiter.fail('10.0.0.2', now + 1).ok, true);
  const locked = limiter.fail('10.0.0.2', now + 2);
  assert.equal(locked.ok, false);
  assert.ok(locked.retryAfterSec >= 1);
  assert.equal(limiter.check('10.0.0.2', now + 3).ok, false);
  limiter.success('10.0.0.2');
  assert.equal(limiter.check('10.0.0.2', now + 4).ok, true);
});

test('wifi credentials reject control characters and short passphrases', () => {
  assert.equal(guards.validateWifiCredentials('Cafe WiFi', ''), null);
  assert.equal(guards.validateWifiCredentials('Cafe WiFi', 'correct horse'), null);
  assert.ok(guards.validateWifiCredentials('bad\nssid', ''));
  assert.ok(guards.validateWifiCredentials('Cafe', 'short'));
  assert.ok(guards.validateWifiCredentials('a]b', ''));
  const body = guards.buildNmConnection('Cafe WiFi', 'correct horse');
  assert.match(body, /ssid=Cafe WiFi/);
  assert.match(body, /psk=correct horse/);
  assert.equal(body.includes('\n['), true);
  assert.doesNotThrow(() => guards.buildNmConnection('Cafe WiFi', ''));
});

test('display settings and upload names are constrained', () => {
  assert.deepEqual(guards.validateDisplaySettings({
    resolution: '1920x1080',
    orientation: '90',
    scale: '1.5',
  }).value, { resolution: '1920x1080', orientation: '90', scale: 1.5 });
  assert.ok(guards.validateDisplaySettings({ resolution: '1920x1080; rm -rf /' }).error);
  assert.ok(guards.validateDisplaySettings({ orientation: 'normal;id' }).error);
  assert.ok(guards.validateDisplaySettings({ scale: '99' }).error);
  assert.equal(guards.isSafeOutputName('HDMI-A-1'), true);
  assert.equal(guards.isSafeOutputName('HDMI-A-1;id'), false);

  assert.equal(guards.sanitizeUploadFilename('../etc/passwd.jpg'), 'passwd.jpg');
  assert.equal(guards.sanitizeUploadFilename('..'), null);
  assert.equal(guards.sanitizeUploadFilename('photo.png'), 'photo.png');
  assert.equal(guards.sanitizeUploadFilename('my photo.JPG'), 'my_photo.JPG');
  assert.equal(guards.sanitizeUploadFilename('notes.html'), null);
});

test('version compare is numeric, not lexical', () => {
  assert.equal(guards.isNewerVersion('1.1.10', '1.1.9'), true);
  assert.equal(guards.isNewerVersion('1.1.9', '1.1.10'), false);
  assert.equal(guards.isNewerVersion('1.1.21', '1.1.21'), false);
  assert.equal(guards.isNewerVersion('1.2.0', '1.1.21'), true);
  assert.equal(guards.isNewerVersion('not-a-version', '1.1.21'), false);
});

test('nmcli colon escaping keeps colons inside SSIDs', () => {
  assert.deepEqual(guards.splitNmcli('My:Net:80:WPA2'), ['My', 'Net', '80', 'WPA2']);
  assert.deepEqual(guards.splitNmcli('Cafe\\:Guest:75:WPA2'), ['Cafe:Guest', '75', 'WPA2']);
});

test('calendar URLs cannot target loopback, link-local, or non-http schemes', async () => {
  assert.equal(guards.classifyUrl('https://example.com/calendar.ics').ok, true);
  assert.equal(guards.classifyUrl('http://192.168.1.20/cal.ics').ok, true);
  assert.equal(guards.classifyUrl('file:///etc/passwd').ok, false);
  assert.equal(guards.classifyUrl('http://127.0.0.1/admin').ok, false);
  assert.equal(guards.classifyUrl('http://169.254.169.254/latest').ok, false);
  assert.equal(guards.classifyUrl('http://localhost/cal.ics').ok, false);
  assert.equal(guards.classifyUrl('http://calendar.local/cal.ics').ok, false);
  assert.equal(guards.classifyUrl('http://2130706433/').ok, false);
  await assert.rejects(() => guards.assertFetchableUrl('http://127.0.0.1/'), /blocked address/);
  await assert.rejects(() => guards.assertFetchableUrl('file:///etc/passwd'), /unsupported protocol/);
});

test('album tokens and icloud hosts are narrow', () => {
  assert.equal(guards.isAlbumToken('Abcd_12-token'), true);
  assert.equal(guards.isAlbumToken('bad token'), false);
  assert.equal(guards.isAlbumToken('a"b'), false);
  assert.equal(guards.isIcloudHost('p46-sharedstreams.icloud.com'), true);
  assert.equal(guards.isIcloudHost('icloud.com.evil.example'), false);
  assert.equal(guards.isHexColor('#e91e63'), true);
  assert.equal(guards.isHexColor('red; color:url(x)'), false);
  assert.equal(guards.clampCalendarDays('5; id'), 5);
  assert.equal(guards.clampCalendarDays(14), 14);
});

test('server source does not print the admin PIN', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pi-server.js'), 'utf8');
  assert.doesNotMatch(src, /console\.(log|error)\([^;\n]*adminPin/);
  assert.match(src, /resolveStaticPath/);
  assert.match(src, /execFileSync\(/);
  assert.doesNotMatch(src, /wifi-sec\.psk "\$\{password\}"/);
});

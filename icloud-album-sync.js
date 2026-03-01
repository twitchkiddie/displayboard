#!/usr/bin/env node
/**
 * icloud-album-sync.js - Download photos from an iCloud shared album
 * Usage: node icloud-album-sync.js <album-token> <output-dir>
 * 
 * Album token is the hash from the URL: https://www.icloud.com/sharedalbum/#<TOKEN>
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ALBUM_TOKEN = process.argv[2];
const OUTPUT_DIR = process.argv[3] || path.join(__dirname, '..', 'displayboard', 'photos');

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Origin': 'https://www.icloud.com',
        'User-Agent': 'Mozilla/5.0',
      },
    }, res => {
      // Handle redirect via X-Apple-MMe-Host header
      if (res.headers['x-apple-mme-host']) {
        const newHost = res.headers['x-apple-mme-host'];
        const newUrl = `https://${newHost}${parsed.pathname}`;
        // Drain response
        res.resume();
        return httpsPost(newUrl, body).then(resolve).catch(reject);
      }
      let resBody = '';
      res.on('data', c => resBody += c);
      res.on('end', () => {
        try { resolve(JSON.parse(resBody)); }
        catch(e) { reject(new Error(`Parse error (${res.statusCode}): ${resBody.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function getBaseUrl() {
  // First request gets redirected to the correct host
  const base = `https://p46-sharedstreams.icloud.com/${ALBUM_TOKEN}/sharedstreams`;
  try {
    const result = await httpsPost(`${base}/webstream`, { streamCtag: null });
    if (result['X-Apple-MMe-Host']) {
      return `https://${result['X-Apple-MMe-Host']}/${ALBUM_TOKEN}/sharedstreams`;
    }
    return base;
  } catch(e) {
    return base;
  }
}

async function main() {
  console.log(`📸 Fetching iCloud shared album: ${ALBUM_TOKEN}`);
  console.log(`📁 Output: ${OUTPUT_DIR}\n`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Get correct host
  const baseUrl = await getBaseUrl();
  console.log(`🔗 API: ${baseUrl}\n`);

  // Get stream metadata
  const stream = await httpsPost(`${baseUrl}/webstream`, { streamCtag: null });
  
  if (!stream.photos || stream.photos.length === 0) {
    console.log('No photos found in album.');
    console.log('Response:', JSON.stringify(stream, null, 2).substring(0, 500));
    return;
  }

  console.log(`Found ${stream.photos.length} photos in album\n`);

  // Get photo URLs
  const photoGuids = stream.photos.map(p => p.photoGuid);
  const assets = await httpsPost(`${baseUrl}/webasseturls`, { photoGuids });

  if (!assets.items) {
    console.log('No asset URLs returned.');
    console.log('Response:', JSON.stringify(assets, null, 2).substring(0, 500));
    return;
  }

  // Existing files
  const existing = new Set(fs.readdirSync(OUTPUT_DIR));
  let downloaded = 0;
  let skipped = 0;

  // Build URL map
  const urlMap = {};
  for (const [checksum, item] of Object.entries(assets.items)) {
    urlMap[checksum] = `https://${item.url_location}${item.url_path}`;
  }

  // Download each photo
  for (const photo of stream.photos) {
    // Find the best derivative (largest)
    const derivatives = photo.derivatives || {};
    let bestKey = null;
    let bestSize = 0;

    for (const [key, deriv] of Object.entries(derivatives)) {
      const size = parseInt(deriv.fileSize) || 0;
      if (size > bestSize) {
        bestSize = size;
        bestKey = key;
      }
    }

    if (!bestKey) continue;

    const deriv = derivatives[bestKey];
    const checksum = deriv.checksum;
    const ext = (deriv.contentType || 'image/jpeg').includes('png') ? '.png' : 
                (deriv.contentType || '').includes('heic') ? '.heic' : '.jpg';
    const filename = `${photo.photoGuid}${ext}`;

    if (existing.has(filename)) {
      skipped++;
      continue;
    }

    const url = urlMap[checksum];
    if (!url) {
      console.log(`  ⚠️  No URL for ${photo.photoGuid}`);
      continue;
    }

    try {
      process.stdout.write(`  ⬇️  ${filename} (${(bestSize / 1024 / 1024).toFixed(1)}MB)...`);
      const data = await httpsGet(url);
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), data);
      downloaded++;
      console.log(' ✅');
    } catch(e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  console.log(`\n📊 Done: ${downloaded} downloaded, ${skipped} already existed, ${stream.photos.length} total in album`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

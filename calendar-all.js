#!/usr/bin/env node
/**
 * calendar-all.js - Self-contained Pi version
 * Reads calendar URLs from config.json instead of macOS Keychain
 * Usage: node calendar-all.js [days] [config-path]
 */

const ICAL = require('ical.js');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.argv[3] || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const CALENDARS = (config.calendars || [])
  .filter(c => c.enabled && c.url)
  .map(c => ({ name: c.name, url: c.url }));

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'calendar-agent/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function isAllDay(vevent) {
  const dtstart = vevent.getFirstProperty('dtstart');
  return dtstart ? dtstart.type === 'date' : false;
}

function toJSDate(icalTime) {
  if (!icalTime) return null;
  return icalTime.toJSDate();
}

async function fetchCalendar(cal, rangeStart, rangeEnd) {
  let raw;
  try {
    raw = await fetchURL(cal.url);
  } catch (err) {
    console.error(`⚠️  Failed to fetch ${cal.name}: ${err.message}`);
    return [];
  }

  raw = raw.replace(/\r\n?/g, '\n');
  raw = raw.replace(/\n([^\s])/g, '\r\n$1').replace(/\n([\s])/g, '\r\n$1');

  let jcal;
  try {
    jcal = ICAL.parse(raw);
  } catch (parseErr) {
    const lines = raw.split(/\r?\n/);
    const cleaned = lines.filter(line => {
      if (line.startsWith(' ') || line.startsWith('\t')) return true;
      if (line.includes(':') || line.includes(';') || line.trim() === '') return true;
      return false;
    }).join('\r\n');
    try {
      jcal = ICAL.parse(cleaned);
    } catch (e2) {
      console.error(`⚠️  Failed to parse ${cal.name}: ${e2.message}`);
      return [];
    }
  }

  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  const upcoming = [];
  const handledExceptions = new Set();

  const eventsByUID = new Map();
  for (const vevent of vevents) {
    const ev = new ICAL.Event(vevent);
    if (!eventsByUID.has(ev.uid)) eventsByUID.set(ev.uid, []);
    eventsByUID.get(ev.uid).push(vevent);
  }

  const processedUIDs = new Set();

  for (const vevent of vevents) {
    const ev = new ICAL.Event(vevent);
    const uid = ev.uid;
    if (processedUIDs.has(uid)) continue;
    if (ev.isRecurrenceException()) continue;
    processedUIDs.add(uid);

    if (ev.isRecurring()) {
      const exceptions = eventsByUID.get(uid) || [];
      for (const exc of exceptions) {
        const excEvent = new ICAL.Event(exc);
        if (excEvent.isRecurrenceException()) {
          try { ev.relateException(excEvent); } catch (e) {}
        }
      }

      const iter = ev.iterator();
      let next;
      let safety = 0;
      while ((next = iter.next()) && safety++ < 500) {
        const occStart = next.toJSDate();
        if (occStart > rangeEnd) break;
        const duration = ev.duration;
        const occEndTime = next.clone();
        occEndTime.addDuration(duration);
        const occEnd = occEndTime.toJSDate();
        if (occEnd < rangeStart) continue;

        let summary = ev.summary, location = ev.location;
        let startDate = occStart, endDate = occEnd;
        let allDay = isAllDay(vevent), skip = false;

        try {
          const details = ev.getOccurrenceDetails(next);
          if (details.item !== ev) {
            handledExceptions.add(`${uid}|${next.toString()}`);
            const excVevent = details.item.component;
            const excStatus = excVevent.getFirstPropertyValue('status');
            if (excStatus && excStatus.toUpperCase() === 'CANCELLED') {
              skip = true;
            } else {
              summary = details.item.summary || summary;
              location = details.item.location || location;
              startDate = details.startDate.toJSDate();
              endDate = details.endDate.toJSDate();
              allDay = isAllDay(excVevent);
            }
          }
        } catch (e) {}

        if (skip) continue;
        upcoming.push({ calendar: cal.name, summary: summary || '(no title)', start: startDate, end: endDate, location: location || null, allDay });
      }
    } else {
      const status = vevent.getFirstPropertyValue('status');
      if (status && status.toUpperCase() === 'CANCELLED') continue;
      const start = toJSDate(ev.startDate);
      const end = toJSDate(ev.endDate) || start;
      if (!start || start > rangeEnd || end < rangeStart) continue;
      upcoming.push({ calendar: cal.name, summary: ev.summary || '(no title)', start, end, location: ev.location || null, allDay: isAllDay(vevent) });
    }
  }

  // Second pass: orphaned exceptions
  for (const vevent of vevents) {
    const ev = new ICAL.Event(vevent);
    if (!ev.isRecurrenceException()) continue;
    const status = vevent.getFirstPropertyValue('status');
    if (status && status.toUpperCase() === 'CANCELLED') continue;
    const start = ev.startDate?.toJSDate();
    const end = ev.endDate?.toJSDate() || start;
    if (!start || start > rangeEnd || end < rangeStart) continue;
    const recId = vevent.getFirstPropertyValue('recurrence-id');
    if (handledExceptions.has(`${ev.uid}|${recId?.toString()}`)) continue;
    const dupKey = `${ev.summary}|${start.toISOString()}`;
    if (upcoming.some(u => `${u.summary}|${u.start.toISOString()}` === dupKey)) continue;
    upcoming.push({ calendar: cal.name, summary: ev.summary || '(no title)', start, end, location: ev.location || null, allDay: isAllDay(vevent) });
  }

  return upcoming;
}

async function main() {
  const days = parseInt(process.argv[2]) || 7;
  const nowReal = new Date();
  // Start of today in EST — so we don't miss today's events
  const nowStr = nowReal.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const now = new Date(nowStr);
  const rangeEnd = new Date(now.getTime() + days * 86400000);

  // If --json flag, output JSON for the server
  const jsonMode = process.argv.includes('--json');

  if (!jsonMode) {
    const fmtOpts = { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' };
    console.log(`📅 ${now.toLocaleDateString('en-US', fmtOpts)} → ${rangeEnd.toLocaleDateString('en-US', fmtOpts)} (${days} days)`);
    console.log(`📂 Calendars: ${CALENDARS.map(c => c.name).join(', ')}\n`);
  }

  const results = await Promise.all(CALENDARS.map(cal => fetchCalendar(cal, now, rangeEnd)));
  const all = results.flat();
  all.sort((a, b) => a.start - b.start);

  const seen = new Set();
  const deduped = all.filter(ev => {
    const key = `${ev.summary}|${ev.start.toISOString()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Expand multi-day all-day events into one entry per day
  // Use start of today in EST for comparison (not current time)
  const todayStart = new Date(now.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
  const expanded = [];
  for (const ev of deduped) {
    if (ev.allDay && ev.end && ev.end - ev.start > 24 * 60 * 60 * 1000) {
      const d = new Date(ev.start);
      const endDate = new Date(ev.end);
      while (d < endDate) {
        // Compare dates only (not times) — normalize to date strings in EST
        const dStr = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
        const dDate = new Date(dStr);
        if (dDate >= todayStart && d <= rangeEnd) {
          expanded.push({ ...ev, start: new Date(d), end: new Date(d.getTime() + 24 * 60 * 60 * 1000) });
        }
        d.setDate(d.getDate() + 1);
      }
    } else {
      expanded.push(ev);
    }
  }
  expanded.sort((a, b) => a.start - b.start);

  if (jsonMode) {
    // Output structured JSON for the server to consume directly
    const events = expanded.map(ev => {
      const obj = {
        date: ev.start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
        title: ev.summary,
        calendar: ev.calendar,
        allDay: ev.allDay || false,
      };
      if (!ev.allDay) {
        obj.startTime = ev.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
        obj.endTime = ev.end ? ev.end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : null;
      }
      if (ev.location) {
        const loc = ev.location.replace(/\r?\n/g, ', ').replace(/\\n/g, ', ').replace(/\\\\/g, '').replace(/\\,/g, ',').replace(/,\s*,/g, ',').trim();
        obj.location = loc.split(',').slice(0, 2).join(',').trim();
      }
      return obj;
    });
    console.log(JSON.stringify({ events }));
    return;
  }

  if (expanded.length === 0) { console.log('Nothing on the calendar.'); return; }

  let currentDate = '';
  for (const ev of expanded) {
    const dateStr = ev.start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    if (dateStr !== currentDate) { if (currentDate) console.log(''); console.log(`── ${dateStr} ──`); currentDate = dateStr; }
    const tag = `[${ev.calendar}]`;
    if (ev.allDay) { console.log(`  📌 ${ev.summary}  ${tag}`); }
    else {
      const t = ev.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
      const e = ev.end ? ev.end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '';
      console.log(`  🕐 ${t}${e ? ' – ' + e : ''}  ${ev.summary}  ${tag}`);
    }
    if (ev.location) {
      const loc = ev.location.replace(/\r?\n/g, ', ').replace(/\\n/g, ', ').replace(/\\\\/g, '').replace(/\\,/g, ',').replace(/,\s*,/g, ',').trim();
      console.log(`     📍 ${loc.split(',').slice(0, 2).join(',').trim()}`);
    }
  }
  console.log(`\n${expanded.length} event(s) found.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });

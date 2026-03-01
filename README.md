# Pi Dashboard — Self-Contained Family Display

A self-contained Raspberry Pi dashboard displaying calendar, weather, photos, and clock. No external server dependencies.

## Location

- **Pi:** `/home/pi/pi-dashboard/`
- **Mac mini backup:** `/Users/jarvisbot/.openclaw/workspace/pi-dashboard/`
- **GitHub:** `twitchkiddie/jarvisbot-workspace` (under `pi-dashboard/`)

## Key Files

| File | Purpose |
|---|---|
| `pi-server.js` | Main server (Node.js, port 3000) |
| `calendar-all.js` | ICAL.js calendar parser (reads from config.json) |
| `icloud-album-sync.js` | Downloads photos from iCloud shared album |
| `config.json` | All settings: calendar URLs, location, display prefs |
| `index.html` | Dashboard layout |
| `style.css` | Styling (transparency, colors, layout) |
| `dashboard.js` | Frontend logic (clock, weather, calendar, slideshow) |
| `display-enhancements.js` | Night mode, brightness, extras |
| `icons/` | Bas Milius SVG weather icons |
| `photos/` | Family photos (synced from iCloud shared album) |

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/calendar?days=5` | GET | Cached calendar events (JSON). Cache refreshes every 5 min in background. |
| `/api/weather-extended` | GET | Current temp + 5-day forecast from open-meteo.com |
| `/api/photos` | GET | List of photo filenames in `/photos/` |
| `/api/config` | GET | Returns current config.json |
| `/api/version` | GET | Config version number (dashboard polls to detect changes) |
| `/api/refresh` | GET | Bumps version to force dashboard reload |
| `/photos/<filename>` | GET | Static file serving for photo images |
| `/icons/<name>.svg` | GET | Static weather icon serving |
| `/` | GET | Serves `index.html` |

## Cron Jobs (on Pi)

- **Hourly photo sync:** `0 * * * *` — runs `icloud-album-sync.js`, downloads new photos from the shared album

## How It Works

1. **Boot** → labwc (Wayland) → Chrome kiosk → `http://localhost:3000`
2. **Server starts** → immediately begins caching calendar in background (~60-90s on Pi 3)
3. **Dashboard loads** → fetches weather, calendar, photos via API → renders
4. **Ongoing** → clock every 1s, weather every 10min, calendar every 5min, photos rotate every 30min
5. **Photo sync** → cron pulls new photos hourly from iCloud shared album

## Config Structure (`config.json`)

```json
{
  "location": {
    "name": "Fairport, NY",
    "latitude": 43.09867,
    "longitude": -77.44194,
    "timezone": "America/New_York"
  },
  "calendars": [
    { "name": "Family", "enabled": true, "url": "https://..." },
    { "name": "Elise Swim", "enabled": true, "url": "https://..." },
    { "name": "Corinne Crew", "enabled": true, "url": "https://..." },
    { "name": "Work", "enabled": false, "url": "https://..." }
  ],
  "display": { "calendarDays": 5 },
  "photoAlbumToken": "B0vG4TcsmGKfUcj"
}
```

## Process Management

- **PM2** manages the server: `pm2 start/stop/restart pi-dashboard`
- **PM2 startup** configured to auto-start on boot
- **Unclutter** hides mouse cursor

## Pi Kiosk Setup

- **OS:** Debian 13 (Trixie), aarch64
- **Compositor:** labwc (Wayland)
- **Browser:** Chromium 142 in kiosk mode
- **Autostart:** `~/.config/labwc/autostart`
- **Autologin:** LightDM → labwc session
- **No desktop environment** — Chrome is the only thing that runs

## Calendar Parser

Uses Mozilla's **ICAL.js** for proper handling of:
- EXDATE (excluded dates from recurring series)
- RECURRENCE-ID (moved/cancelled individual occurrences)
- STATUS:CANCELLED
- Outlook/Exchange recurring event exceptions

This was a critical fix — `node-ical` did not handle Outlook cancellations, causing ghost events to appear.

## Photo Sync

`icloud-album-sync.js` pulls from an iCloud shared album using Apple's public API:
- Reads album token from `config.json`
- Downloads largest available derivative
- Skips existing files (incremental sync)
- Runs hourly via cron

**iCloud shared album URL:** `https://www.icloud.com/sharedalbum/#<token>`

## Useful Commands

```bash
# SSH into Pi
ssh pi@192.168.2.15

# Check server status
pm2 status

# View logs
pm2 logs pi-dashboard

# Restart server
pm2 restart pi-dashboard

# Force dashboard refresh
curl http://localhost:3000/api/refresh

# Manual photo sync
cd /home/pi/pi-dashboard && node icloud-album-sync.js B0vG4TcsmGKfUcj photos

# Manual calendar test
cd /home/pi/pi-dashboard && node calendar-all.js 1 config.json --json
```

# DisplayBoard

Self-contained family dashboard for a Raspberry Pi — calendar, weather, photos, and a clock, controlled from a web-based admin panel. No cloud backend, no external service to run, nothing on your Mac. Point a Pi at a TV, run one command, configure from your phone.

![screenshot](screenshots/dashboard.png)

## Install

On a fresh Raspberry Pi OS install (Bookworm or Trixie, 64-bit recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/twitchkiddie/displayboard/main/install.sh | bash
```

That script clones the repo to `~/displayboard`, installs Node.js 20 + PM2 + hostapd/dnsmasq, sets up a Chromium kiosk autostart, and registers a systemd service for WiFi AP fallback. Reboot when prompted and the dashboard comes up on the attached HDMI display.

The very first boot shows a welcome page pointing you at `http://<pi-ip>:3000/admin.html` with the default PIN **123456** — change it right away under the System tab.

## What it shows

- **Clock** — top-left, ticks every second.
- **5-day calendar grid** — one column per day, color-coded per source. Supports any iCal (.ics) URL from Google Calendar, Apple iCloud, Outlook, Teamup, etc. Handles recurring events, exceptions, and cancellations via ICAL.js.
- **Weather** — current temp + feels-like, wind, humidity, sunrise/sunset, moon phase, and a 5-day forecast with precipitation probability. Data from [open-meteo.com](https://open-meteo.com) (no API key required).
- **Photo slideshow** — fills the background, configurable transition interval and style (fill, fit, stretch, zoom, Ken Burns). Photos come from `./photos/` (uploaded directly) and/or an iCloud shared album (synced hourly).

## The admin panel

Browse to `http://<pi-ip>:3000/admin.html` from any device on the network. A PIN modal gates the panel; sessions are kept in `sessionStorage` so a single unlock lasts the tab.

Tabs:

| Tab | What you can change |
|---|---|
| Overview | Quick actions (refresh dashboard, refresh calendar, sync photos, view dashboard), status cards, today's calendar + weather preview |
| Calendars | Add/remove iCal sources, toggle enabled, recolor, change number of days shown, choose how past events render (show / dim / hide) |
| Weather | Location name, lat/long, timezone |
| Photos | iCloud shared album token, rotation interval, photo style, dimming overlay, shuffle, direct upload (JPG/PNG, 10 MB max) |
| Display | Resolution / orientation / scale (via `wlr-randr`), night mode (dim or full HDMI off, with start/end times), HDMI power on/off, advanced screen-protection / burn-in settings, daily auto-refresh hour |
| WiFi | Scan for networks, connect (reboots into new network). If the Pi can't reach WiFi at boot it falls into AP mode and this tab becomes the captive portal. |
| System | Hostname, system actions (refresh / restart / clear cache / reboot), version info, one-click update from GitHub, rollback to previous version, auto-update toggle, log viewer, admin PIN change, system info (model / uptime / temp / memory / disk / IP / OS) |

## Architecture

```
pi-server.js            Node HTTP server on :3000 — serves both UIs, the API, and static assets
├── index.html          Dashboard (kiosk-facing)
├── admin.html          Admin panel (browser-facing, PIN-gated)
├── setup-welcome.html  First-run welcome (shown until location is configured)
├── dashboard.js        Clock, weather, calendar, slideshow (runs in index.html)
├── display-enhancements.js  Burn-in shift, past-event dimming, stale-data watchdog, daily reload
├── calendar-all.js     Standalone iCal fetcher/parser — spawned every 5 min, emits JSON
├── icloud-album-sync.js  Standalone iCloud-shared-album downloader — spawned on demand
├── config.json         All user-editable settings (written by admin panel)
├── photos/             Photo library (populated by upload + iCloud sync)
├── icons/              Bas Milius SVG weather icons
├── fonts/              Weather Icons font (used for moon phases + forecast row)
├── scripts/
│   ├── ap-fallback.sh  Boot-time: waits 45s for WiFi; on failure brings up hostapd/dnsmasq
│   └── wifi-setup.sh   One-time installer — invoked by setup.sh
├── config/
│   ├── hostapd.conf    AP SSID "DisplayBoard-Setup" (open, channel 6)
│   ├── dnsmasq-ap.conf DHCP 192.168.4.2–20 + catch-all DNS → 192.168.4.1
│   └── displayboard-wifi.service   systemd unit for ap-fallback.sh
├── setup.sh            Interactive installer (Node, PM2, config, kiosk autostart, cron, AP fallback)
└── install.sh          One-line bootstrap that clones + runs setup.sh
```

All caches (`.calendar-cache.json`, `.weather-cache.json`) and backups (`.backup/`) are written next to the code and survive restarts but not a fresh clone.

## API

The dashboard and admin panel share one JSON API, all under `/api/`. Unauthenticated endpoints are read-only; every mutation and every secret-bearing read wants `Authorization: Bearer <adminPin>`.

### Public

| Endpoint | Method | Returns |
|---|---|---|
| `/api/calendar` | GET | `{ events, lastUpdated }` — cached calendar events |
| `/api/weather-extended` | GET | `{ current, forecast, lastUpdated }` — open-meteo snapshot |
| `/api/photos` | GET | `{ photos: string[] }` — shuffled list of `/photos/*` URLs |
| `/api/config` | GET | Full config when authenticated; sanitized (calendar URLs + iCloud token + adminPin redacted) otherwise |
| `/api/version` | GET | `{ version: number }` — internal config/asset version (bumped on edits; dashboard polls to hot-reload) |
| `/api/refresh` | GET | Bumps `/api/version` so open dashboards reload |
| `/api/system-info` | GET | hostname / model / uptime / memory / disk / CPU temp / Node version / IP / OS |
| `/api/hostname` | GET | `{ hostname }` |
| `/api/display-info` | GET | Current `wlr-randr` output (enabled, resolution, refresh, orientation, scale + available options) |
| `/api/display-power` | POST `{ power: "status" }` | `{ power: "on" \| "off" }` — status is public; set-state requires auth |
| `/api/wifi/status` | GET | Client-mode `{ mode, ssid, ip, signal }` or AP-mode `{ mode: "ap", ssid, ip }` |
| `/api/version-info` | GET | `{ version, latest, updateAvailable, changelog, tarballUrl, publishedAt }` from GitHub releases (cached 1h; `?force=true` refreshes) |
| `/api/update-status` | GET | `{ state, message, progress }` — live update progress |
| `/api/backup-exists` | GET | `{ exists: boolean }` |
| `/api/auth` | POST `{ pin }` | 200 on match, 401 otherwise |

### Authenticated

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/config` | POST | Deep-merge a config patch. `adminPin` is ignored here (use `/api/change-pin`). |
| `/api/change-pin` | POST `{ newPin }` | Change admin PIN (4–8 digits) |
| `/api/display-power` | POST `{ power: "on"\|"off" }` | HDMI on/off via `wlr-randr` |
| `/api/display-settings` | POST `{ resolution, orientation, scale }` | Apply + persist to config |
| `/api/hostname` | POST `{ hostname }` | Rewrite `/etc/hostname` + `/etc/hosts` (takes effect after reboot) |
| `/api/refresh-calendar` | POST | Re-fetch all calendars now |
| `/api/clear-cache` | POST | Delete calendar cache file |
| `/api/sync-photos` | POST | Fire off an iCloud shared-album sync |
| `/api/upload-photo` | POST (multipart) | Upload one JPG/PNG (≤10 MB) into `/photos/` |
| `/api/logs` | GET | Last 60 stdout / 30 stderr lines from PM2 logs |
| `/api/reboot` | POST | `sudo reboot` |
| `/api/restart` | POST | `process.exit(0)` — PM2 restarts us |
| `/api/update` | POST | Pull the latest GitHub release, back up, install, restart |
| `/api/rollback` | POST | Restore from `.backup/` and restart |
| `/api/wifi/scan` | GET | Nearby SSIDs via `nmcli` (with `iwlist` fallback) — cached scan served in AP mode |
| `/api/wifi/connect` | POST `{ ssid, password }` | Save credentials via `nmcli connection add`, reboot. In AP mode, writes to `wifi-pending.json`; `ap-fallback.sh` picks it up on teardown. |

## Configuration

Settings live in `config.json` at the project root. The admin panel writes it for you, but you can edit directly and the server auto-reloads (via `fs.watchFile`).

```jsonc
{
  "location": {
    "name": "Your City, State",
    "latitude": 40.7128,
    "longitude": -74.0060,
    "timezone": "America/New_York"
  },
  "calendars": [
    { "name": "Family", "enabled": true, "color": "#e91e63", "url": "https://..." },
    { "name": "Work",   "enabled": false, "color": "#9c27b0", "url": "https://..." }
  ],
  "display": {
    "calendarDays": 5,             // 1–7
    "photoInterval": 30,           // minutes between slides
    "calendarRefresh": 5,          // frontend poll interval, minutes
    "weatherRefresh": 10,          // frontend poll interval, minutes
    "nightModeEnabled": true,
    "nightModeStart": "22:00",
    "nightModeEnd": "06:00",
    "nightModeAction": "off",      // "off" = HDMI off; "dim" = CSS overlay
    "pastEventsMode": "hide",      // "show" | "dim" | "hide"
    "highlightToday": true,
    "panelOpacity": 20,            // 0–80, photo dimming
    "photoStyle": "fill",          // fill | fit | stretch | zoom | kenburns
    "crossfadeDuration": 2,        // seconds
    "burnInEnabled": true,
    "burnInInterval": 30,          // minutes
    "autoRefreshHour": 3,          // 0–23, daily full reload hour
    "staleTimeout": 30,            // minutes without data → reload
    "resolution": "1920x1080",     // set via admin panel
    "orientation": "normal",       // "normal" | "90" | "180" | "270"
    "scale": 1                     // 1, 1.25, 1.5, 1.75, 2
  },
  "photos": { "shuffle": true },
  "photoAlbumToken": "YOUR_ICLOUD_SHARED_ALBUM_TOKEN",
  "updates": {
    "autoUpdate": false,
    "autoUpdateHour": 3,
    "lastCheck": null,
    "lastUpdate": null
  },
  "adminPin": "123456"
}
```

The iCloud shared album token is the fragment of the album URL: `icloud.com/sharedalbum/#<TOKEN>`. The album must be public (shared with anyone who has the link).

## Updates

The admin panel's System tab shows installed + latest (from GitHub Releases). Clicking **Update Now** runs this entirely on the Pi:

1. Download tarball for the tag (direct `archive/refs/tags` URL — no API redirect hops).
2. Extract to `/tmp/displayboard-update`.
3. Copy the current tree to `.backup/` (preserving `config.json`, `photos/`, `node_modules/`, `.calendar-cache.json`).
4. Copy new files over (same preserve list).
5. If `package.json` changed, run `npm install --production`.
6. `process.exit(0)` — PM2 restarts us on the new code.

**Rollback:** if something goes wrong, the panel shows a Rollback button that copies `.backup/` back over the tree and restarts. The backup survives until the next update.

**Auto-update:** off by default. Enable on the System tab and pick an hour (default 03:00); the server wakes once per minute, checks at the top of that hour once a day.

## WiFi AP fallback

`ap-fallback.sh` runs once at boot from `displayboard-wifi.service`, *before* PM2 starts the server:

1. Wait up to 45 s for `wlan0` to get an IP. If ethernet is up, exit early.
2. If not, pre-scan SSIDs (hostapd will seize the radio next) and cache them to `/tmp/displayboard-wifi-networks.json`.
3. Hand `wlan0` to `hostapd` (SSID "DisplayBoard-Setup", open, 192.168.4.1) and `dnsmasq` (DHCP + catch-all DNS).
4. Redirect port 80 → 3000 via iptables so the captive portal lands on the admin panel.
5. Write `/tmp/displayboard-ap-mode` — the server reads this and switches every hostname to a 302 to `/admin.html`.
6. On teardown, read `wifi-pending.json` (written by the admin panel), create an NM connection file from it as root, then reboot.

Client mode configures through `nmcli connection add … connection.autoconnect yes`, so subsequent boots come up normally.

## Kiosk / browser

setup.sh detects labwc (Wayland, default on Bookworm+) or LXDE (X11) and writes the appropriate autostart. Chromium launches with `--kiosk --incognito --noerrdialogs` and waits up to 30 s for the server to respond on `localhost:3000` before starting. The dashboard self-reloads daily at `autoRefreshHour` and whenever the server bumps `configVersion`.

The cursor auto-hides after 30 s of inactivity; a one-time admin URL hint appears on the dashboard at boot for 60 s.

## Useful commands

```bash
pm2 status                      # is it running?
pm2 logs pi-dashboard           # live logs
pm2 restart pi-dashboard        # kick the server

# Manually run a calendar fetch:
node calendar-all.js 5 config.json --json

# Manually sync the photo album:
node icloud-album-sync.js "$(node -e 'console.log(require(\"./config.json\").photoAlbumToken)')" photos

# Tail AP-fallback logs:
journalctl -u displayboard-wifi.service -f

# Force update check (bypass 1-hour cache):
curl http://localhost:3000/api/version-info?force=true
```

## Uninstall

```bash
bash uninstall.sh
```

Removes the PM2 process + startup entry, the kiosk autostart, the WiFi AP fallback service, and (if confirmed) the project files themselves.

## Platform

- Raspberry Pi 3B+, 4, 5 (tested on 3B+)
- Raspberry Pi OS Bookworm or Trixie, 64-bit
- Node.js 20+ (installed by setup.sh)
- Chromium (ships with Raspberry Pi OS)
- labwc (Wayland) preferred; LXDE supported

## License

MIT — see `LICENSE`.

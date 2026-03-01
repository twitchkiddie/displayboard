# 🎛️ Admin Panel Guide

Your dashboard now has a **local web-based admin panel** for easy configuration!

## 🚀 Access the Admin Panel

**URL:** `http://<PI_IP>:3000/admin.html`

Or from the Mac mini:
```bash
open http://localhost:3000/admin.html
```

**No passwords needed** - it's on your local network only (secure by isolation).

---

## 📋 What You Can Configure

### 1. 📍 **Location & Weather**

Change where weather data comes from:

- **Location Name:** Display name (e.g., "New York, NY")
- **Latitude/Longitude:** For accurate weather
- **Timezone:** IANA timezone (America/New_York, America/Los_Angeles, etc.)

**Find coordinates:**
1. Go to https://www.latlong.net/
2. Search for your location
3. Copy latitude and longitude
4. Paste into admin panel

**Example locations:**
- Your City, ST: `40.7128, -74.0060`
- Los Angeles, CA: `34.0522, -118.2437`
- Chicago, IL: `41.8781, -87.6298`

---

### 2. 📅 **Calendars**

Enable/disable calendar sources and change their colors:

- **Toggle calendars on/off** - Checkboxes enable/disable
- **Change colors** - Click color picker to customize
- **See keychain reference** - Shows where calendar URL is stored

**Current calendars:**
- ✅ Family (Magenta #e91e63)
- ✅ Kids Sports (Cyan #00bcd4)  
- ✅ Another Calendar (Orange #ff9800)
- ❌ Work (Purple #9c27b0) - Disabled

**Add a new calendar:**
```bash
# Store calendar URL in macOS Keychain
security add-generic-password -a displayboard -s "cal-mycalendar" -w "https://calendar-url-here"

# Then edit config.json and add:
{
  "name": "My Calendar",
  "enabled": true,
  "color": "#4caf50",
  "keychainKey": "cal-mycalendar"
}
```

---

### 3. 🖥️ **Display Settings**

Fine-tune how the dashboard behaves:

**Timing:**
- **Calendar Days to Show:** 1-7 days (currently: 5)
- **Photo Change Interval:** Seconds between photos (currently: 30)
- **Calendar Refresh:** How often to update calendar (minutes)
- **Weather Refresh:** How often to update weather (minutes)

**Visual Options:**
- **Night Mode:** Auto-dim between specified hours
  - Start time: 22:00 (10 PM)
  - End time: 06:00 (6 AM)
- **Dim Past Events:** Fade out completed events (currently: ON)
- **Highlight Today:** Make current day stand out (currently: ON)

**Recommended settings:**
- High-traffic display: 3-5 days, 30s photos
- Bedroom display: Enable night mode
- Kitchen display: 5-7 days, faster photo rotation

---

### 4. 📸 **Photos**

Configure photo source:

- **Source Type:**
  - `local` - Use `./photos` folder
  - `icloud` - Symlinked to iCloud Drive
  - `dropbox` - Symlinked to Dropbox

- **Local Path:** Where photos are stored
- **Shuffle:** Randomize photo order

**Set up iCloud Drive photos:**
```bash
# Create folder in iCloud Drive
mkdir ~/Library/Mobile\ Documents/com~apple~CloudDocs/DashboardPhotos

# Remove default photos folder
rm -rf /home/pi/displayboard/photos

# Symlink iCloud folder
ln -s ~/Library/Mobile\ Documents/com~apple~CloudDocs/DashboardPhotos \
  /home/pi/displayboard/photos
```

Now photos added to iCloud Drive automatically appear on dashboard!

---

## 💾 Saving Changes

1. Make your changes in the admin panel
2. Click **"💾 Save Settings"**
3. You'll see: "✅ Settings saved! Changes will take effect on next refresh."
4. **Refresh your dashboard** (Cmd+R) to see changes

**Note:** Some changes (like calendar refresh intervals) take effect on the next scheduled refresh.

---

## 🔄 Quick Actions

Three quick links at the bottom:

### 🖼️ **View Dashboard**
Opens the main dashboard display

### 📸 **Upload Photos**
Opens the photo upload interface

### 🔄 **Restart Server**
Restarts the Node.js server (applies all config changes immediately)

**When to restart:**
- After adding new calendars
- After changing refresh intervals
- If something seems stuck

---

## 🔧 Behind the Scenes

### Configuration File

All settings are stored in:
```
/home/pi/displayboard/config.json
```

**You can edit this directly** if you prefer:
```json
{
  "location": {
    "name": "Your City, ST",
    "latitude": 40.7128,
    "longitude": -74.0060,
    "timezone": "America/New_York"
  },
  "calendars": [
    {
      "name": "Family",
      "enabled": true,
      "color": "#e91e63",
      "keychainKey": "cal-family"
    }
  ],
  "display": {
    "calendarDays": 5,
    "photoInterval": 30,
    "calendarRefresh": 5,
    "weatherRefresh": 10,
    "nightModeEnabled": true,
    "nightModeStart": "22:00",
    "nightModeEnd": "06:00",
    "dimPastEvents": true,
    "highlightToday": true
  },
  "photos": {
    "source": "local",
    "localPath": "./photos",
    "shuffle": true
  }
}
```

After manual edits:
```bash
# Restart server to apply
pkill -f "displayboard/server.js"
cd /home/pi/displayboard
./start.sh
```

---

## 🌐 Calendar URLs (Keychain Storage)

Calendar URLs are stored in **macOS Keychain** for security (not in config.json).

### View stored calendar URL:
```bash
security find-generic-password -a displayboard -s "cal-family" -w
```

### Add new calendar URL:
```bash
security add-generic-password -a displayboard -s "cal-newcal" -w "https://calendar-url"
```

### Update existing calendar URL:
```bash
# Delete old
security delete-generic-password -a displayboard -s "cal-family"

# Add new
security add-generic-password -a displayboard -s "cal-family" -w "https://new-url"
```

### List all dashboard calendar keys:
```bash
security find-generic-password -a displayboard | grep "svce.*cal-"
```

---

## 🍓 Raspberry Pi Setup

The admin panel works perfectly on Raspberry Pi!

### Initial Setup on Pi:

1. **Copy dashboard folder to Pi:**
```bash
scp -r displayboard pi@raspberrypi.local:/home/pi/
```

2. **Install Node.js on Pi:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

3. **Install dependencies:**
```bash
cd /home/pi/displayboard
npm install
```

4. **Copy config and credentials:**
```bash
# Export keychain entries from Mac
security find-generic-password -a displayboard -s "cal-family" -w > family-cal-url.txt

# On Pi, store in environment or config file
# (Pi doesn't have macOS Keychain, so store URLs directly in config or .env file)
```

5. **Start dashboard:**
```bash
./start.sh
```

### Pi-Specific Configuration:

Since Raspberry Pi doesn't have macOS Keychain, you can:

**Option A: Environment variables**
```bash
export CAL_FAMILY_URL="https://calendar-url"
export CAL_SWIM_URL="https://swim-calendar-url"
node server.js
```

**Option B: Direct URLs in config** (Less secure but simpler)
```json
{
  "calendars": [
    {
      "name": "Family",
      "enabled": true,
      "color": "#e91e63",
      "url": "https://your-calendar-url-here"
    }
  ]
}
```

Then modify `calendar-all.js` to read from config URLs instead of keychain.

---

## 🔒 Security

### Local Network Only

The admin panel has **no authentication** because it's designed for local network access only.

**Security through network isolation:**
- Only accessible on your local network (<YOUR_NETWORK>)
- Not exposed to the internet
- Firewall protects from external access

### If you need authentication:

Add basic auth to `server.js`:
```javascript
const basicAuth = require('express-basic-auth');

app.use('/admin.html', basicAuth({
  users: { 'admin': 'yourpassword' },
  challenge: true
}));
```

---

## 📝 Common Tasks

### Change Location:
1. Open admin panel
2. Location & Weather tab
3. Enter new coordinates
4. Save

### Disable a calendar:
1. Open admin panel
2. Calendars tab
3. Uncheck calendar
4. Save

### Change photo rotation speed:
1. Open admin panel
2. Display tab
3. Adjust "Photo Change Interval"
4. Save
5. Refresh dashboard

### Enable night mode:
1. Open admin panel
2. Display tab
3. Check "Enable Night Mode"
4. Set start/end times
5. Save

---

## 🆘 Troubleshooting

**Admin panel won't load:**
```bash
# Check if server is running
ps aux | grep "node.*server.js"

# Restart server
./start.sh

# Check logs
tail -f /tmp/displayboard.log
```

**Settings not applying:**
1. Check config.json was updated
2. Restart server: Click "🔄 Restart Server" in admin panel
3. Hard refresh dashboard: Cmd+Shift+R

**Calendar not showing after enabling:**
1. Verify keychain URL exists
2. Test URL manually in browser
3. Check calendar script: `node scripts/calendar-all.js 5`

---

## 🎉 Summary

✅ **Web-based admin panel** - No SSH or file editing needed  
✅ **Configure everything locally** - Location, calendars, display, photos  
✅ **Real-time preview** - See changes by refreshing dashboard  
✅ **Raspberry Pi compatible** - Works on any platform  
✅ **Keychain integration** - Secure calendar URL storage  
✅ **No cloud dependencies** - Completely local configuration  

**Access:** `http://<PI_IP>:3000/admin.html`

Now you can configure your dashboard from any device on your network! 🎛️✨

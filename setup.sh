#!/bin/bash
#
# DisplayBoard Setup Script
# Installs and configures DisplayBoard on Raspberry Pi
#

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DisplayBoard Setup"
echo "  Family Photo & Calendar Dashboard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Don't run as root
if [ "$EUID" -eq 0 ]; then
  echo "❌ Please don't run as root. Run as your normal user (e.g. pi)."
  exit 1
fi

# Warn if not Pi (but allow)
if [ ! -f /proc/device-tree/model ]; then
  echo "⚠️  This doesn't appear to be a Raspberry Pi — continuing anyway."
  echo ""
fi

echo "📂 Working directory: $SCRIPT_DIR"
echo ""

# ── Step 1: Node.js ──────────────────────────────────────────────────────────
echo "📦 Checking Node.js..."
if command -v node &>/dev/null; then
  echo "   ✓ Node.js $(node --version) already installed"
else
  echo "   Installing Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "   ✓ Node.js $(node --version) installed"
fi
echo ""

# ── Step 2: PM2 ──────────────────────────────────────────────────────────────
echo "📦 Checking PM2..."
if command -v pm2 &>/dev/null; then
  echo "   ✓ PM2 already installed"
else
  echo "   Installing PM2..."
  sudo npm install -g pm2
  echo "   ✓ PM2 installed"
fi
echo ""

# ── Step 3: npm dependencies ─────────────────────────────────────────────────
echo "📦 Installing dependencies..."
npm install --omit=dev 2>/dev/null || npm install
echo "   ✓ Dependencies installed"
echo ""

# ── Step 4: config.json ──────────────────────────────────────────────────────
if [ ! -f config.json ]; then
  echo "⚙️  Creating config from example..."
  cp config.example.json config.json
  echo "   ✓ config.json created (default PIN: 123456)"
else
  echo "⚙️  config.json already exists — keeping it"
fi
echo ""

# ── Step 5: Photos directory ─────────────────────────────────────────────────
mkdir -p photos
echo "📸 photos/ directory ready"
echo ""

# ── Step 6: PM2 process ──────────────────────────────────────────────────────
echo "🚀 Starting DisplayBoard with PM2..."
pm2 delete displayboard 2>/dev/null || true
pm2 start server.js --name displayboard --time
pm2 save
echo "   ✓ PM2 process running"
echo ""

# ── Step 7: PM2 boot startup ─────────────────────────────────────────────────
echo "🔧 Configuring PM2 startup on boot..."
PM2_CMD=$(pm2 startup 2>&1 | grep "sudo env" | tail -1)
if [ -n "$PM2_CMD" ]; then
  eval "$PM2_CMD"
else
  PM2_BIN=$(which pm2 2>/dev/null || echo /usr/lib/node_modules/pm2/bin/pm2)
  sudo env PATH="$PATH:/usr/bin" "$PM2_BIN" startup systemd -u "$USER" --hp "$HOME"
fi
pm2 save
echo "   ✓ PM2 will start on boot"
echo ""

# ── Step 8: Kiosk mode ───────────────────────────────────────────────────────
echo "🖥️  Kiosk mode setup..."
read -p "   Configure fullscreen kiosk display? (Y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then

  # Detect chromium binary
  if command -v chromium &>/dev/null; then
    CHROMIUM_BIN="chromium"
  elif command -v chromium-browser &>/dev/null; then
    CHROMIUM_BIN="chromium-browser"
  else
    echo "   ⚠️  Chromium not found. Install it: sudo apt-get install -y chromium"
    CHROMIUM_BIN="chromium"
  fi
  echo "   Using browser: $CHROMIUM_BIN"

  KIOSK_CMD="$CHROMIUM_BIN --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble --disable-translate --password-store=basic --use-mock-keychain --check-for-update-interval=31536000 http://localhost:3000"

  if command -v labwc &>/dev/null || [ -f /usr/bin/labwc ]; then
    # Wayland / labwc
    echo "   Detected: labwc (Wayland)"
    mkdir -p "$HOME/.config/labwc"
    cat > "$HOME/.config/labwc/autostart" << AUTOEOF
# DisplayBoard Kiosk
$KIOSK_CMD &
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true
AUTOEOF
    echo "   ✓ labwc autostart configured"

  else
    # X11 / LXDE
    echo "   Detected: X11/LXDE"
    mkdir -p "$HOME/.config/lxsession/LXDE-pi"
    AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"
    if [ -f "$AUTOSTART" ] && grep -q "localhost:3000" "$AUTOSTART" 2>/dev/null; then
      echo "   ℹ️  Kiosk already in autostart"
    else
      cat >> "$AUTOSTART" << AUTOEOF

# DisplayBoard Kiosk
@xset s off
@xset -dpms
@xset s noblank
@$KIOSK_CMD
AUTOEOF
      echo "   ✓ LXDE autostart configured"
    fi
  fi
else
  echo "   Skipped"
fi
echo ""

# ── Step 9: iCloud photo sync cron (optional) ────────────────────────────────
echo "📸 iCloud photo sync..."
read -p "   Set up hourly iCloud photo sync? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  CRON_CMD="0 * * * * cd $SCRIPT_DIR && /usr/bin/node icloud-album-sync.js \"\$(node -e \"console.log(require('./config.json').photoAlbumToken||'')\" 2>/dev/null)\" photos >> /tmp/photo-sync.log 2>&1"
  if crontab -l 2>/dev/null | grep -q "icloud-album-sync"; then
    echo "   ℹ️  Cron already exists"
  else
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "   ✓ Hourly photo sync cron added"
  fi
else
  echo "   Skipped"
fi
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Setup Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Dashboard:   http://$LOCAL_IP:3000"
echo "  Admin panel: http://$LOCAL_IP:3000/admin.html"
echo "  Default PIN: 123456"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔧 Useful commands:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  pm2 status                  Check if running"
echo "  pm2 logs displayboard       View live logs"
echo "  pm2 restart displayboard    Restart server"
echo "  pm2 stop displayboard       Stop server"
echo "  sudo reboot                 Reboot Pi"
echo "  sudo shutdown -h now        Shutdown"
echo ""
echo "📖 https://github.com/twitchkiddie/displayboard"
echo ""

read -p "🔄 Reboot now to apply all changes? (Y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  echo "Rebooting in 3 seconds..."
  sleep 3
  sudo reboot
else
  echo "⚠️  Remember to reboot before kiosk mode will work."
fi

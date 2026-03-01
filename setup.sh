#!/bin/bash
#
# DisplayBoard Setup Script
# One-line installer for Raspberry Pi photo & calendar dashboard
#

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DisplayBoard Setup"
echo "  Family Photo & Calendar Dashboard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Detect if running as root
if [ "$EUID" -eq 0 ]; then
  echo "⚠️  Please don't run this script as root/sudo"
  echo "   The script will prompt for sudo when needed"
  exit 1
fi

# Check for Raspberry Pi
if [ ! -f /proc/device-tree/model ]; then
  echo "⚠️  Warning: This doesn't appear to be a Raspberry Pi"
  echo "   The script may still work, but is untested on other systems"
  read -p "   Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "📂 Working directory: $SCRIPT_DIR"
echo ""

# Step 1: Install Node.js if not present
echo "📦 Checking Node.js..."
if command -v node &> /dev/null; then
  NODE_VERSION=$(node --version)
  echo "   ✓ Node.js $NODE_VERSION already installed"
else
  echo "   Installing Node.js via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "   ✓ Node.js installed: $(node --version)"
fi
echo ""

# Step 2: Install PM2 globally if not present
echo "📦 Checking PM2..."
if command -v pm2 &> /dev/null; then
  echo "   ✓ PM2 already installed"
else
  echo "   Installing PM2..."
  sudo npm install -g pm2
  echo "   ✓ PM2 installed"
fi
echo ""

# Step 3: Install npm dependencies
echo "📦 Installing dependencies..."
npm install
echo "   ✓ Dependencies installed"
echo ""

# Step 4: Create config.json if it doesn't exist
if [ ! -f config.json ]; then
  echo "⚙️  Creating default config..."
  if [ -f config.example.json ]; then
    cp config.example.json config.json
    echo "   ✓ config.json created from example"
  else
    echo "   ⚠️  config.example.json not found, you'll need to configure manually"
  fi
else
  echo "⚙️  config.json already exists, keeping it"
fi
echo ""

# Step 5: Create photos directory
if [ ! -d photos ]; then
  echo "📸 Creating photos directory..."
  mkdir -p photos
  echo "   ✓ photos/ directory created"
else
  echo "📸 photos/ directory already exists"
fi
echo ""

# Step 6: Configure PM2
echo "🚀 Configuring PM2..."
pm2 delete displayboard 2>/dev/null || true
pm2 start server.js --name displayboard --time
pm2 save
echo "   ✓ PM2 process configured"
echo ""

# Step 7: Configure PM2 startup (requires sudo)
echo "🔧 Configuring PM2 startup..."
PM2_STARTUP=$(pm2 startup 2>&1 | grep "sudo env" | tail -1)
if [ -n "$PM2_STARTUP" ]; then
  echo "   Running: $PM2_STARTUP"
  eval "$PM2_STARTUP"
  pm2 save
  echo "   ✓ PM2 startup configured"
else
  # Try direct method
  PM2_BIN=$(which pm2 || echo /usr/lib/node_modules/pm2/bin/pm2)
  sudo env PATH=$PATH:/usr/bin $PM2_BIN startup systemd -u $USER --hp $HOME
  pm2 save
  echo "   ✓ PM2 startup configured"
fi
echo ""

# Step 8: Configure kiosk mode (optional)
echo "🖥️  Kiosk mode setup..."
read -p "   Configure Chromium fullscreen kiosk mode? (Y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  # Check if labwc (Wayland compositor) is being used
  if command -v labwc &> /dev/null || [ -f /usr/bin/labwc ]; then
    echo "   Detected labwc (Wayland) compositor"
    AUTOSTART_DIR="$HOME/.config/labwc"
    mkdir -p "$AUTOSTART_DIR"
    
    cat > "$AUTOSTART_DIR/autostart" << 'EOF'
# DisplayBoard Kiosk Mode
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-translate \
  --check-for-update-interval=31536000 \
  http://localhost:3000 &

# Disable screen blanking
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true
EOF
    echo "   ✓ labwc autostart configured: $AUTOSTART_DIR/autostart"
  else
    # Fallback to X11 autostart
    AUTOSTART_DIR="$HOME/.config/lxsession/LXDE-pi"
    mkdir -p "$AUTOSTART_DIR"
    
    if [ -f "$AUTOSTART_DIR/autostart" ]; then
      # Append if file exists
      if ! grep -q "chromium.*kiosk.*localhost:3000" "$AUTOSTART_DIR/autostart"; then
        echo "" >> "$AUTOSTART_DIR/autostart"
        echo "# DisplayBoard Kiosk Mode" >> "$AUTOSTART_DIR/autostart"
        echo "@chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run http://localhost:3000" >> "$AUTOSTART_DIR/autostart"
        echo "   ✓ Added to existing autostart"
      else
        echo "   ℹ️  Kiosk mode already in autostart"
      fi
    else
      # Create new autostart file
      cat > "$AUTOSTART_DIR/autostart" << 'EOF'
@lxpanel --profile LXDE-pi
@pcmanfm --desktop --profile LXDE-pi
@xscreensaver -no-splash

# DisplayBoard Kiosk Mode
@xset s off
@xset -dpms
@xset s noblank
@chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run http://localhost:3000
EOF
      echo "   ✓ autostart configured: $AUTOSTART_DIR/autostart"
    fi
  fi
else
  echo "   Skipped kiosk mode setup"
fi
echo ""

# Step 9: Set up photo sync cron (optional)
echo "📸 Photo sync cron setup..."
read -p "   Set up automatic iCloud photo sync? (hourly) (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  CRON_CMD="0 * * * * cd $SCRIPT_DIR && /usr/bin/node icloud-album-sync.js \"\$(grep photoAlbumToken config.json | cut -d'\"' -f4)\" photos >> /tmp/photo-sync.log 2>&1"
  
  # Check if cron job already exists
  if crontab -l 2>/dev/null | grep -q "icloud-album-sync.js"; then
    echo "   ℹ️  Photo sync cron already exists"
  else
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "   ✓ Hourly photo sync cron configured"
  fi
else
  echo "   Skipped photo sync cron"
fi
echo ""

# Step 10: Get local IP
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
HOSTNAME=$(hostname)

# Final summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ DisplayBoard Setup Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🌐 Dashboard:  http://$LOCAL_IP:3000"
echo "⚙️  Admin panel: http://$LOCAL_IP:3000/admin.html"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📋 NEXT STEPS — run these now:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. Configure PM2 to start on boot (run this once):"
echo ""
pm2 startup | grep "sudo env" || echo "     sudo env PATH=\$PATH:/usr/bin pm2 startup systemd -u $USER --hp \$HOME"
echo ""
echo "  2. Save the current PM2 process list:"
echo "     pm2 save"
echo ""
echo "  3. Reboot to apply all changes (kiosk mode, hostname, startup):"
echo "     sudo reboot"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔧 Day-to-day commands:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  pm2 status                  Check if running"
echo "  pm2 logs displayboard       View live logs"
echo "  pm2 restart displayboard    Restart server"
echo "  pm2 stop displayboard       Stop server"
echo "  pm2 start displayboard      Start server"
echo "  sudo reboot                 Full reboot"
echo "  sudo shutdown -h now        Shutdown"
echo ""
echo "📖 Docs: https://github.com/twitchkiddie/displayboard"
echo ""

# Ask to reboot now
read -p "🔄 Reboot now to apply all changes? (Y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  echo "Rebooting in 3 seconds..."
  sleep 3
  sudo reboot
else
  echo "Remember to reboot before using kiosk mode!"
fi

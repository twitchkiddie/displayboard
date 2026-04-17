#!/bin/bash
#
# DisplayBoard Uninstall Script
#

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DisplayBoard Uninstall"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "⚠️  This will remove DisplayBoard, PM2 process, and kiosk autostart. Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi
echo ""

# Stop and remove PM2 process (handle both current and legacy names).
echo "🛑 Stopping PM2 process..."
for NAME in pi-dashboard displayboard; do
  pm2 stop "$NAME" 2>/dev/null && echo "   ✓ Stopped $NAME" || true
  pm2 delete "$NAME" 2>/dev/null && echo "   ✓ Removed $NAME from PM2" || true
done
pm2 save 2>/dev/null || true

# Remove PM2 startup
echo "🔧 Removing PM2 startup..."
pm2 unstartup systemd 2>/dev/null | grep "sudo" | bash 2>/dev/null || true
echo "   ✓ Done"

# Disable and remove the WiFi AP fallback service (installed by scripts/wifi-setup.sh).
echo "📶 Removing WiFi AP fallback service..."
sudo systemctl disable displayboard-wifi.service 2>/dev/null || true
sudo systemctl stop displayboard-wifi.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/displayboard-wifi.service
sudo rm -f /etc/sudoers.d/displayboard-wifi
sudo rm -f /etc/hostapd/displayboard-ap.conf /etc/dnsmasq-displayboard.conf
sudo systemctl daemon-reload 2>/dev/null || true
echo "   ✓ Done"

# Remove kiosk autostart
echo "🖥️  Removing kiosk autostart..."
LABWC_AUTOSTART="$HOME/.config/labwc/autostart"
LXDE_AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"

if [ -f "$LABWC_AUTOSTART" ] && grep -q "localhost:3000" "$LABWC_AUTOSTART" 2>/dev/null; then
  rm -f "$LABWC_AUTOSTART"
  echo "   ✓ Removed labwc autostart"
fi

if [ -f "$LXDE_AUTOSTART" ] && grep -q "localhost:3000" "$LXDE_AUTOSTART" 2>/dev/null; then
  # Remove just the DisplayBoard lines
  sed -i '/DisplayBoard Kiosk/d' "$LXDE_AUTOSTART"
  sed -i '/localhost:3000/d' "$LXDE_AUTOSTART"
  sed -i '/xset s off/d' "$LXDE_AUTOSTART"
  sed -i '/xset -dpms/d' "$LXDE_AUTOSTART"
  sed -i '/xset s noblank/d' "$LXDE_AUTOSTART"
  echo "   ✓ Removed from LXDE autostart"
fi

# Remove photo sync cron
echo "📸 Removing photo sync cron..."
crontab -l 2>/dev/null | grep -v "icloud-album-sync" | crontab - 2>/dev/null || true
echo "   ✓ Done"

# Remove install directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"

echo ""
read -p "🗑️  Delete the DisplayBoard files at $SCRIPT_DIR? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  cd "$PARENT_DIR"
  rm -rf "$SCRIPT_DIR"
  echo "   ✓ Files deleted"
else
  echo "   Files kept at $SCRIPT_DIR"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ DisplayBoard uninstalled"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Reboot to fully clear all changes: sudo reboot"
echo ""

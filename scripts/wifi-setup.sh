#!/bin/bash
# DisplayBoard WiFi AP Fallback — Install Script
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "📶 Installing WiFi AP fallback..."

# Install packages
sudo apt-get install -y hostapd dnsmasq iptables

# Unmask hostapd (Raspbian masks it by default)
sudo systemctl unmask hostapd

# Disable — we manage them manually from ap-fallback.sh
sudo systemctl disable hostapd 2>/dev/null || true
sudo systemctl disable dnsmasq 2>/dev/null || true
sudo systemctl stop hostapd 2>/dev/null || true
sudo systemctl stop dnsmasq 2>/dev/null || true

# Copy config files
sudo cp "$PROJECT_DIR/config/hostapd.conf" /etc/hostapd/displayboard-ap.conf
sudo cp "$PROJECT_DIR/config/dnsmasq-ap.conf" /etc/dnsmasq-displayboard.conf
sudo cp "$PROJECT_DIR/config/displayboard-wifi.service" /etc/systemd/system/displayboard-wifi.service
# Patch service file to use actual install path (not hardcoded dakboard-local)
sudo sed -i "s|/home/pi/dakboard-local|$PROJECT_DIR|g" /etc/systemd/system/displayboard-wifi.service

# Reload systemd and enable our service
sudo systemctl daemon-reload
sudo systemctl enable displayboard-wifi.service

# Make script executable
chmod +x "$SCRIPT_DIR/ap-fallback.sh"

# Sudoers entries for pi user
sudo tee /etc/sudoers.d/displayboard-wifi > /dev/null << 'EOF'
pi ALL=(ALL) NOPASSWD: /usr/sbin/hostapd
pi ALL=(ALL) NOPASSWD: /usr/sbin/dnsmasq
pi ALL=(ALL) NOPASSWD: /sbin/ip
pi ALL=(ALL) NOPASSWD: /usr/sbin/iptables
pi ALL=(ALL) NOPASSWD: /sbin/wpa_supplicant
pi ALL=(ALL) NOPASSWD: /usr/bin/killall hostapd
pi ALL=(ALL) NOPASSWD: /usr/bin/killall dnsmasq
pi ALL=(ALL) NOPASSWD: /usr/bin/killall wpa_supplicant
pi ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/wpa_supplicant/wpa_supplicant.conf
pi ALL=(ALL) NOPASSWD: /sbin/reboot
pi ALL=(ALL) NOPASSWD: /usr/sbin/iwlist wlan0 scan
pi ALL=(ALL) NOPASSWD: /bin/systemctl start hostapd
pi ALL=(ALL) NOPASSWD: /bin/systemctl stop hostapd
pi ALL=(ALL) NOPASSWD: /bin/systemctl start dnsmasq
pi ALL=(ALL) NOPASSWD: /bin/systemctl stop dnsmasq
EOF
sudo chmod 440 /etc/sudoers.d/displayboard-wifi

echo "   ✓ WiFi AP fallback installed"

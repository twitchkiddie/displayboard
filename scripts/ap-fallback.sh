#!/bin/bash
# DisplayBoard WiFi AP Fallback
# Waits for WiFi, falls back to AP mode if no connection

AP_SSID="DisplayBoard-Setup"
AP_IP="192.168.4.1"
AP_CONF="/etc/hostapd/displayboard-ap.conf"
DNS_CONF="/etc/dnsmasq-displayboard.conf"
FLAG_FILE="/tmp/displayboard-ap-mode"
STATUS_FILE="/tmp/displayboard-ap-status.json"
WAIT_SECS=45

cleanup() {
    echo "Tearing down AP mode..."
    sudo iptables -t nat -D PREROUTING -i wlan0 -p tcp --dport 80 -j REDIRECT --to-port 3000 2>/dev/null
    sudo killall hostapd 2>/dev/null
    sudo killall dnsmasq 2>/dev/null
    rm -f "$FLAG_FILE" "$STATUS_FILE"
    echo "AP mode disabled."
}

trap cleanup EXIT SIGTERM SIGINT

# Wait for WiFi connection
echo "Waiting up to ${WAIT_SECS}s for WiFi..."
for i in $(seq 1 $WAIT_SECS); do
    if ip addr show wlan0 2>/dev/null | grep -q "inet "; then
        echo "WiFi connected after ${i}s"
        # Stay running but do nothing — systemd RemainAfterExit keeps us alive
        trap - EXIT SIGTERM SIGINT
        exit 0
    fi
    sleep 1
done

echo "No WiFi after ${WAIT_SECS}s — enabling AP mode"

# Kill wpa_supplicant
sudo killall wpa_supplicant 2>/dev/null || true
sleep 1

# Set static IP
sudo ip addr flush dev wlan0
sudo ip addr add ${AP_IP}/24 dev wlan0
sudo ip link set wlan0 up

# Start hostapd
sudo hostapd -B "$AP_CONF"

# Start dnsmasq
sudo dnsmasq --conf-file="$DNS_CONF"

# Redirect HTTP to our server
sudo iptables -t nat -A PREROUTING -i wlan0 -p tcp --dport 80 -j REDIRECT --to-port 3000

# Create flag and status files
touch "$FLAG_FILE"
cat > "$STATUS_FILE" << EOF
{"mode":"ap","ssid":"${AP_SSID}","ip":"${AP_IP}"}
EOF

echo "AP mode active: SSID=${AP_SSID} IP=${AP_IP}"

# Keep running (forking service — backgrounded by hostapd -B)
# The trap will clean up on SIGTERM
wait

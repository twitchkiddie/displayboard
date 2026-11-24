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
    iptables -t nat -D PREROUTING -i wlan0 -p tcp --dport 80 -j REDIRECT --to-port 3000 2>/dev/null || true
    killall hostapd 2>/dev/null || true
    killall dnsmasq 2>/dev/null || true
    rm -f "$FLAG_FILE" "$STATUS_FILE"

    # Apply any pending WiFi credentials saved by the admin panel.
    # Python writes the keyfile so a newline in the SSID or passphrase cannot
    # inject extra NetworkManager settings. The passphrase is not echoed.
    PENDING_FILE="$(dirname "$0")/../wifi-pending.json"
    if [ -f "$PENDING_FILE" ]; then
        echo "Applying pending WiFi credentials..."
        if python3 - "$PENDING_FILE" << 'PY'
import json, os, re, sys
path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)
ssid = data.get("ssid") or ""
password = data.get("password") or ""

def bad(value):
    return any(ord(ch) < 32 or ord(ch) == 127 or ch in "[]" for ch in value)

if not ssid or len(ssid.encode()) > 32 or bad(ssid):
    sys.exit("invalid ssid")
if password and (len(password) < 8 or len(password) > 63 or bad(password)):
    sys.exit("invalid password")
safe = re.sub(r"[^A-Za-z0-9_-]", "_", ssid)[:32] or "wifi"
dest = f"/etc/NetworkManager/system-connections/displayboard-{safe}.nmconnection"
lines = [
    "[connection]",
    f"id={ssid}",
    "type=wifi",
    "autoconnect=true",
    "",
    "[wifi]",
    "mode=infrastructure",
    f"ssid={ssid}",
    "",
]
if password:
    lines += [
        "[wifi-security]",
        "auth-alg=open",
        "key-mgmt=wpa-psk",
        f"psk={password}",
        "psk-flags=0",
        "",
    ]
lines += ["[ipv4]", "method=auto", "", "[ipv6]", "method=auto", ""]
fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as out:
    out.write("\n".join(lines) + "\n")
PY
        then
            echo "WiFi credentials saved"
            rm -f "$PENDING_FILE"
        else
            echo "Pending WiFi credentials were rejected"
            rm -f "$PENDING_FILE"
        fi
    fi

    # Tell NetworkManager to reclaim wlan0
    nmcli device set wlan0 managed yes 2>/dev/null || true
    echo "AP mode disabled."
}

trap cleanup EXIT SIGTERM SIGINT

# Wait for WiFi connection
echo "Waiting up to ${WAIT_SECS}s for WiFi..."
for i in $(seq 1 $WAIT_SECS); do
    # If WiFi comes up, we're done
    if ip addr show wlan0 2>/dev/null | grep -q "inet "; then
        echo "WiFi connected after ${i}s"
        trap - EXIT SIGTERM SIGINT
        exit 0
    fi
    # If ethernet is up, no need for AP mode — user can configure via wired admin panel
    if ip addr show eth0 2>/dev/null | grep -q "inet "; then
        echo "Ethernet connected — skipping AP mode (configure WiFi via admin panel)"
        trap - EXIT SIGTERM SIGINT
        exit 0
    fi
    sleep 1
done

echo "No WiFi or ethernet after ${WAIT_SECS}s — enabling AP mode"

# Scan for networks NOW before hostapd takes wlan0
echo "Scanning for networks before starting AP..."
nmcli device wifi rescan ifname wlan0 2>/dev/null || true
sleep 3
nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 2>/dev/null | \
  awk -F: 'NF>=2 && $1!="" {printf "{\"ssid\":\"%s\",\"signal\":%s,\"security\":\"%s\"}\n",$1,$2,$3}' | \
  python3 -c "
import sys, json
lines = [l.strip() for l in sys.stdin if l.strip()]
seen = set()
nets = []
for l in lines:
    try:
        o = json.loads(l)
        if o['ssid'] and o['ssid'] not in seen:
            seen.add(o['ssid'])
            sig = int(o['signal']) if o['signal'] else 0
            dbm = round((sig/2)-100) if sig else -90
            nets.append({'ssid':o['ssid'],'signal':dbm,'security':o['security'] or 'Open'})
    except: pass
nets.sort(key=lambda x: x['signal'], reverse=True)
print(json.dumps(nets))
" > /tmp/displayboard-wifi-networks.json 2>/dev/null || echo "[]" > /tmp/displayboard-wifi-networks.json
echo "Cached $(python3 -c "import json;d=json.load(open('/tmp/displayboard-wifi-networks.json'));print(len(d))" 2>/dev/null || echo 0) networks"

# Tell NetworkManager to stop managing wlan0 so hostapd can take it
nmcli device set wlan0 managed no 2>/dev/null || true
sleep 1

# Kill anything holding wlan0
killall wpa_supplicant 2>/dev/null || true
sleep 1

# Set static IP
ip addr flush dev wlan0
ip addr add ${AP_IP}/24 dev wlan0
ip link set wlan0 up

# Start hostapd
hostapd -B "$AP_CONF"
sleep 1

# Start dnsmasq
dnsmasq --conf-file="$DNS_CONF"

# Redirect port 80 → 3000 for captive portal (best-effort, needs iptables)
if command -v iptables &>/dev/null; then
    iptables -t nat -A PREROUTING -i wlan0 -p tcp --dport 80 -j REDIRECT --to-port 3000 || true
    echo "Port 80 redirect active"
else
    echo "iptables not found — port 80 redirect skipped (install iptables for captive portal)"
fi

# Create flag and status files
touch "$FLAG_FILE"
printf '{"mode":"ap","ssid":"%s","ip":"%s"}\n' "$AP_SSID" "$AP_IP" > "$STATUS_FILE"

echo "AP mode active: SSID=${AP_SSID} IP=${AP_IP}"

# Keep running so systemd doesn't consider us exited
# hostapd runs in background (-B), we just sleep
while true; do
    sleep 30
    # Check hostapd still running; restart if died
    if ! pgrep hostapd > /dev/null; then
        echo "hostapd died — restarting"
        hostapd -B "$AP_CONF" || true
    fi
done

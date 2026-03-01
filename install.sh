#!/bin/bash
# DisplayBoard One-Line Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/twitchkiddie/displayboard/main/install.sh | bash

set -e

REPO="https://github.com/twitchkiddie/displayboard.git"
INSTALL_DIR="$HOME/displayboard"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DisplayBoard Installer"
echo "  Family Photo & Calendar Dashboard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Don't run as root
if [ "$EUID" -eq 0 ]; then
  echo "❌ Please don't run as root. Run as your normal user (e.g. pi)."
  exit 1
fi

# Check for git
if ! command -v git &>/dev/null; then
  echo "📦 Installing git..."
  sudo apt-get update -qq && sudo apt-get install -y git
fi

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📂 DisplayBoard already cloned — pulling latest..."
  git -C "$INSTALL_DIR" pull
else
  echo "📥 Cloning DisplayBoard to $INSTALL_DIR..."
  git clone "$REPO" "$INSTALL_DIR"
fi

echo ""
echo "🚀 Running setup..."
echo ""

cd "$INSTALL_DIR"
bash setup.sh

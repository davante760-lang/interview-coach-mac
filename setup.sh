#!/bin/bash
# Interview Coach Desktop — one-command setup & run
# Works on any Mac with Xcode Command Line Tools installed
# Usage: bash setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Interview Coach Desktop Setup ==="
echo ""

# 1. Check prerequisites
if ! command -v swiftc &>/dev/null; then
  echo "ERROR: Swift compiler not found. Install Xcode Command Line Tools:"
  echo "  xcode-select --install"
  exit 1
fi

if ! command -v node &>/dev/null && ! command -v npm &>/dev/null; then
  # Check common node locations
  for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$p" ]; then
      export PATH="$(dirname "$p"):$PATH"
      break
    fi
  done
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install it from https://nodejs.org/"
  exit 1
fi

echo "[1/4] Prerequisites OK (node $(node -v), swiftc)"

# 2. Install npm dependencies if needed
if [ ! -d "node_modules/electron" ]; then
  echo "[2/4] Installing dependencies..."
  npm install --no-audit --no-fund 2>&1 | tail -3
else
  echo "[2/4] Dependencies already installed"
fi

# 3. Compile Swift binary
echo "[3/4] Compiling AudioCapture..."
swiftc AudioCapture.swift \
  -o AudioCapture \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework Foundation \
  -target arm64-apple-macos13.0

# Copy into Electron bundle
ELECTRON_APP="node_modules/electron/dist/Electron.app/Contents/MacOS"
cp AudioCapture "$ELECTRON_APP/AudioCapture"
echo "       Binary installed into Electron.app bundle"

# 4. Launch
echo "[4/4] Launching Interview Coach..."
echo ""
echo "  TIP: If you get a Screen Recording permission prompt,"
echo "  grant it in System Settings > Privacy > Screen Recording"
echo "  then restart the app."
echo ""
exec "$ELECTRON_APP/Electron" "$SCRIPT_DIR"

#!/bin/bash
# Release script for Interview Coach Desktop
# Usage: ./release.sh [version]
# Example: ./release.sh 2.1.0
#
# Prerequisites:
#   1. gh auth login (one-time GitHub CLI auth)
#   2. export GH_TOKEN=$(gh auth token)
#   3. GitHub repo: davante760-lang/interview-coach-mac

set -e

VERSION=${1:-$(node -p "require('./package.json').version")}
APP_NAME="Interview Coach Audio"

echo "=== Building Interview Coach v${VERSION} ==="

# Step 1: Compile Swift binary
echo "→ Compiling AudioCapture..."
swiftc -O \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework AVFAudio \
  -framework AudioToolbox \
  -framework CoreAudio \
  AudioCapture.swift -o AudioCapture

# Step 2: Update version in package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '${VERSION}';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "→ Version set to ${VERSION}"

# Step 3: Build, sign, notarize, and publish to GitHub Releases (single pass)
echo "→ Building Electron app + publishing to GitHub Releases..."
export GH_TOKEN=${GH_TOKEN:-$(gh auth token)}
npx electron-builder --mac --publish always

echo ""
echo "=== Release v${VERSION} published ==="
echo "  DMG: dist/${APP_NAME}-${VERSION}-arm64.dmg"
echo "  ZIP: dist/${APP_NAME}-${VERSION}-arm64-mac.zip"
echo "All running apps will auto-update on next launch."

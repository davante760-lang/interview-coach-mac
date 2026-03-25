#!/bin/bash
# build.sh — compile the Swift audio capture binary
# Run this from the audio-capture/ directory on your Mac.
# Requires Xcode Command Line Tools: xcode-select --install

set -e
cd "$(dirname "$0")"

echo "Building AudioCapture..."

swiftc AudioCapture.swift \
  -o AudioCapture \
  -framework ScreenCaptureKit \
  -framework CoreAudio \
  -framework AVFoundation \
  -framework Foundation \
  -target arm64-apple-macos12.3

echo "Done. Binary: ./AudioCapture"
echo ""
echo "Test it manually:"
echo "  ./AudioCapture wss://interview-coach-production-9c63.up.railway.app"
echo "  # You'll see 'READY' when capture starts"
echo "  # Type STOP and press Enter to quit"

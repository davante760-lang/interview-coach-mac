#!/bin/bash
# build.sh — compile AudioCapture (Swift + Objective-C++ AEC wrapper)
# Requires Xcode Command Line Tools: xcode-select --install
# Requires WebRTC audio processing built at third_party/webrtc-audio-processing/_install/

set -e
cd "$(dirname "$0")/.."

PROJ_ROOT="$(pwd)"
AEC_PREFIX="$PROJ_ROOT/third_party/webrtc-audio-processing/_install"
AEC_INC="$AEC_PREFIX/include/webrtc-audio-processing-2"
AEC_LIB="$AEC_PREFIX/lib"
SRC_DIR="$PROJ_ROOT/audio-capture"
BUILD_DIR="$PROJ_ROOT/build_native"
OUT="$PROJ_ROOT/AudioCapture"

if [ ! -d "$AEC_INC" ] || [ ! -d "$AEC_LIB" ]; then
  echo "ERROR: webrtc-audio-processing not built."
  echo "Expected install prefix: $AEC_PREFIX"
  echo "Run: cd third_party/webrtc-audio-processing && meson setup build --prefix=\$(pwd)/_install --buildtype=release && ninja -C build install"
  exit 1
fi

mkdir -p "$BUILD_DIR"

echo "==> Compiling ICEchoCanceller.mm (Objective-C++)"
clang++ -c "$SRC_DIR/ICEchoCanceller.mm" \
  -o "$BUILD_DIR/ICEchoCanceller.o" \
  -std=c++17 \
  -fobjc-arc \
  -fvisibility=default \
  -I"$AEC_INC" \
  -I"/opt/homebrew/include" \
  -DWEBRTC_POSIX \
  -target arm64-apple-macos12.3

echo "==> Compiling AudioCapture.swift"
swiftc "$PROJ_ROOT/AudioCapture.swift" \
  "$BUILD_DIR/ICEchoCanceller.o" \
  -o "$OUT" \
  -import-objc-header "$SRC_DIR/BridgingHeader.h" \
  -I"$AEC_INC" \
  -framework ScreenCaptureKit \
  -framework CoreAudio \
  -framework AVFoundation \
  -framework Foundation \
  -L"$AEC_LIB" \
  -lwebrtc-audio-processing-2 \
  -L/opt/homebrew/lib \
  -labsl_base \
  -labsl_raw_logging_internal \
  -labsl_log_severity \
  -labsl_spinlock_wait \
  -lc++ \
  -Xlinker -rpath -Xlinker "@executable_path" \
  -Xlinker -rpath -Xlinker "@executable_path/../Frameworks" \
  -Xlinker -rpath -Xlinker "$AEC_LIB" \
  -Xlinker -rpath -Xlinker "/opt/homebrew/lib" \
  -target arm64-apple-macos12.3

echo "==> Done. Binary: $OUT"
echo ""
echo "Linked dylibs (first few):"
otool -L "$OUT" | head -15

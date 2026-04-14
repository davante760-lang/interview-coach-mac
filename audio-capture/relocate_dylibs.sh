#!/bin/bash
# relocate_dylibs.sh — bundle webrtc-audio-processing + absl dylibs
# next to the AudioCapture binary so it's relocatable.
#
# After running, AudioCapture loads its deps from @loader_path/aec_libs/
# which resolves correctly whether it's sitting at repo root (dev) or
# at Contents/MacOS/ (packaged Electron).

set -e
cd "$(dirname "$0")/.."
PROJ_ROOT="$(pwd)"

BIN="$PROJ_ROOT/AudioCapture"
DEST="$PROJ_ROOT/aec_libs"
AEC_PREFIX="$PROJ_ROOT/third_party/webrtc-audio-processing/_install"
BREW_LIB="/opt/homebrew/opt/abseil/lib"

if [ ! -f "$BIN" ]; then
  echo "ERROR: $BIN not found. Run build.sh first."
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"

echo "==> Copying dylibs into $DEST"
cp -p "$AEC_PREFIX/lib/libwebrtc-audio-processing-2.1.dylib" "$DEST/"
cp -p "$BREW_LIB/libabsl_base.2601.0.0.dylib" "$DEST/"
cp -p "$BREW_LIB/libabsl_raw_logging_internal.2601.0.0.dylib" "$DEST/"
cp -p "$BREW_LIB/libabsl_log_severity.2601.0.0.dylib" "$DEST/"
cp -p "$BREW_LIB/libabsl_spinlock_wait.2601.0.0.dylib" "$DEST/"

# webrtc-audio-processing pulls in more absl symbols at load time; copy all
# absl dylibs that come up as dependencies.
echo "==> Scanning for transitive absl deps"
scan() {
  otool -L "$1" | awk 'NR>1 {print $1}' | grep -E "libabsl_" | grep -v "^@" || true
}

added=1
while [ $added -gt 0 ]; do
  added=0
  for f in "$DEST"/*.dylib; do
    deps=$(scan "$f")
    for d in $deps; do
      name=$(basename "$d")
      if [ ! -f "$DEST/$name" ]; then
        # d is the path recorded in install_names; resolve via brew
        src=""
        if [ -f "$BREW_LIB/$name" ]; then
          src="$BREW_LIB/$name"
        elif [ -f "$d" ]; then
          src="$d"
        fi
        if [ -n "$src" ]; then
          cp -p "$src" "$DEST/"
          echo "   + $name"
          added=$((added+1))
        fi
      fi
    done
  done
done

# Homebrew ships its dylibs as 444 (read-only). `cp -p` preserves that mode,
# and Squirrel.Mac (electron-updater) then fails to strip `com.apple.quarantine`
# from the extracted update ZIP with "Permission denied" → every auto-update
# aborts. Force them writable so xattr removal works on the user's machine.
chmod u+w "$DEST"/*.dylib

echo "==> Rewriting install names in bundled dylibs"
for f in "$DEST"/*.dylib; do
  # Self-id → @rpath/<basename>
  install_name_tool -id "@rpath/$(basename "$f")" "$f"
  # Rewrite any absolute path to a sibling dylib → @loader_path/<basename>
  while read -r dep; do
    base=$(basename "$dep")
    if [ -f "$DEST/$base" ] && [ "$dep" != "@rpath/$base" ]; then
      install_name_tool -change "$dep" "@loader_path/$base" "$f" 2>/dev/null || true
    fi
  done < <(otool -L "$f" | awk 'NR>1 {print $1}' | grep -E "(libabsl_|libwebrtc-audio-processing)")
  # Strip signature since we changed the binary
  codesign --remove-signature "$f" 2>/dev/null || true
done

echo "==> Rewriting install names in AudioCapture binary"
# Change references to the original absolute paths → @loader_path/aec_libs/*
for dep in $(otool -L "$BIN" | awk 'NR>1 {print $1}' | grep -E "(libabsl_|libwebrtc-audio-processing)"); do
  base=$(basename "$dep")
  install_name_tool -change "$dep" "@loader_path/aec_libs/$base" "$BIN"
done

# Add rpath pointing at the sibling aec_libs folder (for @rpath lookups).
install_name_tool -add_rpath "@loader_path/aec_libs" "$BIN" 2>/dev/null || true
install_name_tool -add_rpath "@executable_path/aec_libs" "$BIN" 2>/dev/null || true

echo "==> Strip old sig so codesign picks up the rewrites cleanly"
codesign --remove-signature "$BIN" 2>/dev/null || true

echo ""
echo "==> AudioCapture linked dylibs:"
otool -L "$BIN" | head -15

echo ""
echo "==> Contents of aec_libs/:"
ls -la "$DEST"

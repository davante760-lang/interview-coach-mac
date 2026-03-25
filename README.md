# Interview Coach Desktop — System Audio Capture v2

Captures **all system audio** (Google Meet, Zoom, YouTube, anything) via macOS
ScreenCaptureKit and streams int16 PCM to the Interview Coach server in real time.

**No bots. No virtual cables. No BlackHole. No browser permissions.**

---

## Architecture

```
Electron UI  ──IPC──▶  main.js  ──spawn──▶  AudioCapture (Swift binary)
                                                  │
                                                  │  ScreenCaptureKit
                                                  │  (system audio tap)
                                                  │
                                                  └──WebSocket──▶  Railway server
                                                                    (Deepgram → transcripts)
```

The Swift binary does all the heavy lifting:
- Uses `SCStreamConfiguration.capturesAudio = true` (ScreenCaptureKit)
- Resamples to 48kHz mono int16 via `AVAudioConverter`
- Streams 4096-sample PCM chunks over WebSocket
- No Chromium involved — no browser audio bugs

---

## Setup

### 1. Build the Swift binary (one time)

```bash
cd audio-capture
bash build.sh
```

This produces `audio-capture/AudioCapture`. Requires Xcode CLI tools:
```bash
xcode-select --install
```

### 2. Install Electron

```bash
npm install
```

### 3. Run

```bash
npm start
```

### 4. Grant permissions (first run)

macOS will prompt for **Screen & System Audio Recording** when the Swift binary
first calls `SCShareableContent`. Grant it in:

> System Settings → Privacy & Security → Screen & System Audio Recording

Then click **Stop** and **Start** again in the app.

---

## Usage

1. Open your Google Meet / Zoom call
2. Click **Start Capturing System Audio**
3. macOS prompts for Screen Recording → grant it
4. The Swift binary streams audio to the server
5. Transcripts and coaching cards appear in Interview Coach

---

## Troubleshooting

### "AudioCapture binary not found"
Run `cd audio-capture && bash build.sh` first.

### No audio chunks after starting
- Open System Settings → Privacy & Security → Screen & System Audio Recording
- Make sure **Interview Coach Audio** (or `electron`) is in the list and enabled
- Restart the app

### "Timeout — grant Screen Recording permission and try again"
The 10s timeout fired before ScreenCaptureKit got permission. Grant it in System
Settings, then click Start again.

### WS: connected but 0 chunks
Check the server URL. The Railway server must be running. Test:
```bash
./audio-capture/AudioCapture wss://interview-coach-production-9c63.up.railway.app
# Should print READY and then "[Audio] 100 chunks sent" every few seconds
```

---

## Building a DMG

```bash
# Build Swift binary first
cd audio-capture && bash build.sh && cd ..

# Package with electron-builder
npm run build
```

DMG will be in `dist/`.

---

## Audio format

| Property    | Value           |
|-------------|-----------------|
| Encoding    | linear16 (int16)|
| Sample rate | 48000 Hz        |
| Channels    | 1 (mono)        |
| Chunk size  | 4096 samples    |
| Byte order  | little-endian   |

---

## Requirements

- macOS 12.3+ (ScreenCaptureKit minimum)
- Xcode Command Line Tools (to build Swift binary)
- Node.js 18+

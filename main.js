const { app, BrowserWindow, systemPreferences, ipcMain, Menu, Tray, nativeImage, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs   = require('fs');
const http = require('http');

let mainWindow;
let tray = null;
let audioProcess = null;

// ── Settings (persisted to userData/settings.json) ──────────────────────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return { autoStart: false }; }
}

function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s)); } catch {}
}

// ── Meeting Detection ────────────────────────────────────────────────────────
// Uses macOS's avconferenced daemon (runs ONLY when camera is active — any
// app or browser tab using the camera) + known audio-only app processes.

let _meetingDetectInterval = null;
let _meetingActive         = false;
let _meetingStartedCapture = false;  // true if we auto-started because of a meeting
let _meetingEndGraceTimer  = null;
let _dismissedUntil        = 0;      // epoch ms — cooldown after dismiss

// Two categories of detection:
//
// 1. CAMERA CHECK — avconferenced/VDCAssistant runs ONLY when camera is active
//    Catches: Zoom (camera on), Meet (camera on), Teams (camera on), FaceTime, etc.
//
// 2. IN-CALL PROCESS CHECK — processes that only exist DURING an active call,
//    even with camera off:
//    - CptHost: Zoom's conference host — spawned on join, killed on leave (camera-agnostic)
//    - ZoomAudioService: Zoom audio, only during calls
//    - webexmeetingapp: Webex in-meeting binary
//    - FaceTime: Apple calls (camera usually on but checked here too)
//
// 3. MIC-IN-USE CHECK — catches browser meetings (Meet, Teams web, Webex web)
//    with camera off. Uses lsof to see if a browser has CoreAudio input open.
//    Browsers (Chrome/Firefox/Safari) only open audio input when actively
//    using the microphone in a WebRTC call.

function detectVideoMeeting() {
  return new Promise((resolve) => {

    // --- Check 1: Dedicated in-call native processes (zero false positives) ---
    const nativeProcs = [
      'CptHost',         // Zoom — only spawns during an active call
      'webexmeetingapp', // Webex — only spawns during an active call
    ];
    const nativeCheck = nativeProcs.map(p => `pgrep -f "${p}" > /dev/null 2>&1`).join(' || ');

    exec(nativeCheck, (err) => {
      if (err === null || err.code === 0) return resolve(true);

      // --- Check 2: Browser tab URL check via osascript ---
      // Reads active tab URLs from Chrome, Edge, and Safari.
      // Fires for Google Meet, Teams web, Webex web, Zoom web.
      // Only triggers when a meeting tab is actually open — not on any audio playback.
      const meetDomains = ['meet.google.com', 'teams.microsoft.com', 'zoom.us/wc', 'webex.com/meet'];

      const chromeScript = [
        'try', 'tell application "Google Chrome"',
        '  repeat with w in windows', '    repeat with t in tabs of w',
        '      set u to URL of t',
        ...meetDomains.map(d => `      if u contains "${d}" then return "yes"`),
        '    end repeat', '  end repeat', 'end tell', 'end try',
      ];
      const edgeScript = [
        'try', 'tell application "Microsoft Edge"',
        '  repeat with w in windows', '    repeat with t in tabs of w',
        '      set u to URL of t',
        ...meetDomains.map(d => `      if u contains "${d}" then return "yes"`),
        '    end repeat', '  end repeat', 'end tell', 'end try',
      ];
      const safariScript = [
        'try', 'tell application "Safari"',
        '  repeat with w in windows', '    repeat with t in tabs of w',
        '      set u to URL of t',
        ...meetDomains.map(d => `      if u contains "${d}" then return "yes"`),
        '    end repeat', '  end repeat', 'end tell', 'end try',
      ];

      const fullScript = [...chromeScript, ...edgeScript, ...safariScript, 'return "no"'];
      const args = [];
      fullScript.forEach(line => { args.push('-e'); args.push(line); });

      const { execFile } = require('child_process');
      execFile('osascript', args, { timeout: 3000 }, (err2, stdout) => {
        resolve((stdout || '').trim() === 'yes');
      });
    });
  });
}

function startMeetingDetection() {
  if (_meetingDetectInterval) return;
  _meetingDetectInterval = setInterval(async () => {
    const inMeeting = await detectVideoMeeting();
    const settings  = loadSettings();
    const now       = Date.now();

    if (inMeeting && !_meetingActive) {
      // Meeting just started
      _meetingActive = true;
      console.log('[Meeting] Video meeting detected');

      if (now < _dismissedUntil) {
        console.log('[Meeting] Suppressed — cooldown active');
        return;
      }

      if (settings.autoStart && !audioProcess) {
        // Auto-start: tell renderer to kick off capture
        console.log('[Meeting] Auto-starting capture');
        _meetingStartedCapture = true;
        mainWindow?.webContents.send('meeting-auto-start');
        _showMeetingNotification(true);
      } else if (!audioProcess) {
        // Manual: prompt user
        console.log('[Meeting] Prompting user to start capture');
        mainWindow?.webContents.send('meeting-detected');
        _showMeetingNotification(false);
      }

    } else if (!inMeeting && _meetingActive) {
      // Meeting seems to have ended — wait grace period before acting
      if (!_meetingEndGraceTimer) {
        console.log('[Meeting] Meeting may have ended — starting 10s grace period');
        _meetingEndGraceTimer = setTimeout(() => {
          _meetingEndGraceTimer = null;
          detectVideoMeeting().then((stillActive) => {
            if (!stillActive) {
              _meetingActive = false;
              console.log('[Meeting] Meeting ended');
              if (_meetingStartedCapture && audioProcess) {
                _meetingStartedCapture = false;
                mainWindow?.webContents.send('meeting-ended');
              }
            }
          });
        }, 10000);
      }
    } else if (inMeeting && _meetingEndGraceTimer) {
      // Camera came back during grace period — cancel end timer
      clearTimeout(_meetingEndGraceTimer);
      _meetingEndGraceTimer = null;
    }
  }, 5000);
}

function _showMeetingNotification(autoStarted) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: 'Interview Coach',
    body: autoStarted
      ? 'Meeting detected — recording started automatically.'
      : 'Meeting detected — open Interview Coach to start recording.',
    silent: false,
  });
  n.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  n.show();
}

// Binary is inside the Electron app bundle — inherits Screen Recording permission
const BINARY_PATH = path.join(path.dirname(process.execPath), 'AudioCapture');

// ── Auto-Updater Setup ─────────────────────────────────────────────────────

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// For unsigned builds — allow updates without code signing verification
autoUpdater.allowDowngrade = false;

autoUpdater.on('checking-for-update', () => {
  console.log('[Updater] Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  console.log('[Updater] Update available:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-status', 'Downloading update v' + info.version + '...');
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] App is up to date');
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`[Updater] Download: ${Math.round(progress.percent)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] Update downloaded:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-downloaded', info.version);
  }
});

autoUpdater.on('error', (err) => {
  console.log('[Updater] Error (non-fatal):', err.message);
  // Non-blocking — app works normally if update check fails
});

// ── Menu Bar ────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { label: 'About Interview Coach', role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => {
            autoUpdater.checkForUpdates().catch(err => {
              console.log('[Updater] Manual check failed:', err.message);
            });
          }
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Interview Coach');
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  updateTrayMenu();
}

function updateTrayMenu(isRecording = false) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: isRecording ? '● Recording…' : 'Ready',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => { mainWindow.show(); mainWindow.focus(); }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); }
    }
  ]);
  tray.setContextMenu(menu);
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420, height: 600, resizable: true,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  // Hide to tray instead of quitting when window is closed
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    if (mic !== 'granted') await systemPreferences.askForMediaAccess('microphone');
    const screen = systemPreferences.getMediaAccessStatus('screen');
    console.log('[Main] Screen:', screen, '| Mic:', mic);
  }
  buildMenu();
  createWindow();
  createTray();
  startLocalServer();
  startMeetingDetection();

  // Silent background update check on launch (non-blocking)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.log('[Updater] Background check failed (non-fatal):', err.message);
    });
  }, 5000);
});

app.on('window-all-closed', () => { /* stay alive in tray */ });
app.on('before-quit', () => { app.isQuitting = true; stopAudioProcess(); });

// ── Shared capture logic (used by IPC + local HTTP server) ──────────────────

const SERVER_URL = 'wss://interview-coach-production-9c63.up.railway.app';
const DG_KEY     = '54d546fe79b59f0f372e78e6cc3e77673649b611';

function startAudioCapture(prospectName, prospectCompany) {
  if (audioProcess) return Promise.resolve({ ok: true, already: true });
  console.log('[Main] Spawning:', BINARY_PATH);

  // Ensure binary is executable (may lose permissions after install/xattr)
  try { fs.chmodSync(BINARY_PATH, 0o755); } catch (e) { console.warn('[Main] chmod failed:', e.message); }

  audioProcess = spawn(BINARY_PATH, [SERVER_URL, DG_KEY, prospectName || '', prospectCompany || ''], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  audioProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    console.log('[Swift]', line);
    mainWindow?.webContents.send('audio-log', line);
  });

  audioProcess.stdout.on('data', (data) => {
    data.toString().split('\n').forEach(l => {
      if (l.trim() === 'READY') mainWindow?.webContents.send('audio-log', 'READY');
    });
  });

  audioProcess.on('exit', (code, signal) => {
    console.log('[Main] Swift exited:', code, signal);
    audioProcess = null;
    updateTrayMenu(false);
    mainWindow?.webContents.send('audio-stopped', { code, signal });
  });

  audioProcess.on('error', (err) => {
    console.error('[Main] Spawn error:', err.message);
    audioProcess = null;
    mainWindow?.webContents.send('audio-stopped', { code: -1 });
  });

  updateTrayMenu(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    audioProcess?.stderr.on('data', (d) => {
      if (d.toString().includes('capture started')) finish({ ok: true });
      if (d.toString().includes('-3801') || d.toString().includes('-3805')) {
        finish({ error: 'Screen Recording permission denied. Enable it in System Settings.' });
      }
    });
    audioProcess?.on('exit', (code) => finish({ error: 'Process exited: ' + code }));
    audioProcess?.on('error', (err) => finish({ error: err.message }));
    setTimeout(() => finish({ ok: true }), 15000);
  });
}

ipcMain.handle('start-capture', async (event, { prospectName, prospectCompany }) => {
  return startAudioCapture(prospectName, prospectCompany);
});

// ── Local HTTP server (web app → Electron trigger) ──────────────────────────
// Listens on localhost:59842 so the web app can start/stop capture
// without needing a meeting bot.

function startLocalServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, recording: audioProcess !== null }));
      return;
    }

    if (req.method === 'POST' && req.url === '/start') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body || '{}');
        // Route through renderer so it updates its UI state (same path as meeting auto-start)
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send('web-start-capture', {
          prospectName: data.prospectName || '',
          prospectCompany: data.prospectCompany || ''
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      stopAudioProcess();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(59842, '127.0.0.1', () => {
    console.log('[LocalServer] Listening on http://localhost:59842');
  });
  server.on('error', (err) => {
    console.log('[LocalServer] Error (non-fatal):', err.message);
  });
}

ipcMain.handle('stop-capture', async () => { stopAudioProcess(); return { ok: true }; });
ipcMain.handle('open-releases-page', () => {
  require('electron').shell.openExternal('https://github.com/davante760-lang/interview-coach-mac/releases/latest');
});
ipcMain.handle('check-binary', async () => {
  return { exists: fs.existsSync(BINARY_PATH), path: BINARY_PATH };
});

// Settings IPC
ipcMain.handle('get-settings', async () => loadSettings());
ipcMain.handle('save-settings', async (event, settings) => {
  saveSettings(settings);
  return { ok: true };
});

// Dismiss meeting prompt — suppress for 45 min (rest of typical interview)
ipcMain.handle('dismiss-meeting-prompt', async () => {
  _dismissedUntil = Date.now() + 45 * 60 * 1000;
  _meetingStartedCapture = false;
  return { ok: true };
});

function stopAudioProcess() {
  if (audioProcess) {
    try { audioProcess.stdin.write('STOP\n'); } catch (e) {}
    setTimeout(() => { if (audioProcess) { audioProcess.kill('SIGTERM'); audioProcess = null; } }, 1000);
  }
}

const { app, BrowserWindow, systemPreferences, ipcMain, Menu, Tray, nativeImage, Notification, safeStorage, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// Small helper: POST JSON to a URL using native https/http, returns {status, body}
function postJson(targetUrl, bodyObj) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(targetUrl);
      const lib = u.protocol === 'https:' ? https : http;
      const data = JSON.stringify(bodyObj);
      const req = lib.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => chunks += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
          catch (e) { resolve({ status: res.statusCode, body: chunks }); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    } catch (e) { reject(e); }
  });
}

let mainWindow;
let overlayWindow = null;
let tray = null;
let audioProcess = null;
let _preparedLaunch = null;  // { launchId, userId, role, callType, preparedAt }
let _activeLaunchId = null;
let _needsRestart = false;

// ── OVERLAY FEATURE FLAG ─────────────────────────────────────────────────────
// The floating overlay window is disabled until it is redesigned properly
// (was un-movable and interrupting users on every session start). Every
// createOverlayWindow() / overlayWindow.show() call short-circuits while
// this flag is false. Re-enable by flipping to true once the overlay UX
// has been rebuilt. All overlay endpoints (/overlay/test, /overlay/hide,
// /overlay/coaching) and IPC handlers remain wired — they just no-op.
const OVERLAY_ENABLED = false;

// ── Website API Base URL ─────────────────────────────────────────────────────
const WEBSITE_API_BASE = 'https://noruma.ai';
const IC_SERVER = process.env.IC_SERVER_URL || 'https://app.noruma.ai';

// ── Dev: --reset flag clears all auth data for clean testing ─────────────────
if (process.argv.includes('--reset')) {
  const userDataPath = app.getPath('userData');
  const filesToClear = ['session.enc', 'user-profile.json', 'companion-token.enc', 'active-launch.json'];
  filesToClear.forEach(f => {
    try { fs.unlinkSync(path.join(userDataPath, f)); } catch {}
  });
  // Clear auth keys from settings but keep window/overlay prefs
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8'));
    delete s.userId; delete s.desktopToken; delete s.desktopApiKey; delete s._sessionTokenFallback; delete s._companionTokenFallback;
    fs.writeFileSync(path.join(userDataPath, 'settings.json'), JSON.stringify(s));
  } catch {}
  console.log('[Dev] Auth data cleared via --reset flag');
}

// ── Settings (persisted to userData/settings.json) ──────────────────────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return { autoStart: false }; }
}

function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s)); } catch {}
}

// ── Secure Session Storage (macOS Keychain / Windows Credential Manager) ────
// Uses Electron's safeStorage API to encrypt/decrypt session tokens at rest.
// The encrypted blob is stored in a file — the key lives in the OS keychain.

const SESSION_PATH = path.join(app.getPath('userData'), 'session.enc');

function storeSessionToken(token) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: store in settings (not ideal but functional)
      const s = loadSettings();
      s._sessionTokenFallback = token;
      saveSettings(s);
      return;
    }
    const encrypted = safeStorage.encryptString(token);
    fs.writeFileSync(SESSION_PATH, encrypted);
  } catch (e) {
    console.warn('[Session] Failed to store token:', e.message);
  }
}

function loadSessionToken() {
  try {
    if (fs.existsSync(SESSION_PATH) && safeStorage.isEncryptionAvailable()) {
      const encrypted = fs.readFileSync(SESSION_PATH);
      return safeStorage.decryptString(encrypted);
    }
    // Fallback check
    const s = loadSettings();
    return s._sessionTokenFallback || null;
  } catch (e) {
    console.warn('[Session] Failed to load token:', e.message);
    return null;
  }
}

function clearSessionToken() {
  try { fs.unlinkSync(SESSION_PATH); } catch {}
  const s = loadSettings();
  delete s._sessionTokenFallback;
  saveSettings(s);
}

// ── Companion Token Storage (secure, for browser-companion auth) ───────────

const COMPANION_TOKEN_PATH = path.join(app.getPath('userData'), 'companion-token.enc');

function storeCompanionToken(token) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      const s = loadSettings();
      s._companionTokenFallback = token;
      saveSettings(s);
      return;
    }
    const encrypted = safeStorage.encryptString(token);
    fs.writeFileSync(COMPANION_TOKEN_PATH, encrypted);
  } catch (e) {
    console.warn('[Companion] Failed to store token:', e.message);
  }
}

function loadCompanionToken() {
  try {
    if (fs.existsSync(COMPANION_TOKEN_PATH) && safeStorage.isEncryptionAvailable()) {
      const encrypted = fs.readFileSync(COMPANION_TOKEN_PATH);
      return safeStorage.decryptString(encrypted);
    }
    const s = loadSettings();
    return s._companionTokenFallback || null;
  } catch (e) {
    return null;
  }
}

function clearCompanionToken() {
  try { fs.unlinkSync(COMPANION_TOKEN_PATH); } catch {}
  const s = loadSettings();
  delete s._companionTokenFallback;
  saveSettings(s);
}

// ── User Profile (stored locally after auth) ────────────────────────────────

const PROFILE_PATH = path.join(app.getPath('userData'), 'user-profile.json');

function storeUserProfile(profile) {
  try { fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile)); } catch {}
}

function loadUserProfile() {
  try { return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')); }
  catch { return null; }
}

function clearUserProfile() {
  try { fs.unlinkSync(PROFILE_PATH); } catch {}
}

// ── Website API Client ──────────────────────────────────────────────────────

function apiRequest(method, endpoint, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = `${WEBSITE_API_BASE}${endpoint}`;
    const request = net.request({ method, url });
    for (const [k, v] of Object.entries(headers)) request.setHeader(k, v);
    request.setHeader('Content-Type', 'application/json');

    let responseBody = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseBody += chunk.toString(); });
      response.on('end', () => {
        try {
          const data = JSON.parse(responseBody);
          resolve({ status: response.statusCode, data });
        } catch {
          resolve({ status: response.statusCode, data: { raw: responseBody } });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

async function validateActivationToken(token) {
  try {
    console.log('[Auth] Calling validate-token at:', `${WEBSITE_API_BASE}/api/auth/validate-token`);
    console.log('[Auth] Token (first 16 chars):', token.substring(0, 16) + '...');
    const { status, data } = await apiRequest('POST', '/api/auth/validate-token', { token });
    console.log('[Auth] Response status:', status, 'body:', JSON.stringify(data));
    if (status === 200 && data.success) return data;
    return { success: false, error: data.error || 'token_invalid', message: data.message || 'Invalid token' };
  } catch (e) {
    console.error('[Auth] validate-token network error:', e.message);
    return { success: false, error: 'network_error', message: e.message };
  }
}

async function validateSession(sessionToken) {
  try {
    const { status, data } = await apiRequest('GET', '/api/auth/me', null, {
      'Authorization': `Bearer ${sessionToken}`
    });
    if (status === 200 && data.user_id) return { valid: true, ...data };
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

async function sendMagicLink(email) {
  try {
    const { data } = await apiRequest('POST', '/api/auth/send-magic-link', { email });
    return data;
  } catch {
    return { success: true }; // Fail silently per spec
  }
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
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('meeting-auto-start'); } catch (_) {}
        _showMeetingNotification(true);
      } else if (!audioProcess) {
        // Manual: prompt user
        console.log('[Meeting] Prompting user to start capture');
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('meeting-detected'); } catch (_) {}
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
                try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('meeting-ended'); } catch (_) {}
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

// Track whether an update is downloaded and waiting to install. We deliberately
// NEVER auto-restart mid-session or between back-to-back interviews. When an
// update finishes downloading, the tray menu gains an "Install Update & Restart"
// entry so the user triggers install on their own terms. On a clean quit,
// autoInstallOnAppQuit = true handles the install transparently.
let _updateReady = false;
let _updateVersion = null;

function _installUpdateAndRestart() {
  if (!_updateReady) return;
  console.log(`[Updater] User-triggered install of v${_updateVersion}`);
  showNotification('Interview Coach updating', `Installing v${_updateVersion}. The app will restart momentarily.`);
  setTimeout(() => {
    try {
      // isSilent=true, isForceRunAfter=true → quit, install, relaunch without dialog
      autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      console.log('[Updater] quitAndInstall failed (will fall back to quit-install on next quit):', err.message);
    }
  }, 1500);
}

autoUpdater.on('checking-for-update', () => {
  console.log('[Updater] Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  console.log('[Updater] Update available:', info.version);
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', 'Downloading update v' + info.version + '...'); } catch (_) {}
});

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] App is up to date');
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`[Updater] Download: ${Math.round(progress.percent)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] Update downloaded:', info.version);
  _updateReady = true;
  _updateVersion = info.version;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-downloaded', info.version); } catch (_) {}
  // Surface a non-blocking notification + rebuild tray so the user can click
  // "Install Update & Restart" whenever they're between sessions and actually
  // ready to restart. Never auto-restart — that risks interrupting an active
  // session or a user who is about to start their next interview.
  showNotification(
    `Update v${info.version} ready`,
    'Click the Interview Coach tray icon → Install Update & Restart when you are ready.'
  );
  try { updateTrayMenu(!!audioProcess); } catch (_) {}
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
  const companionToken = loadCompanionToken();
  const status = isRecording ? '🔴 Recording' : (companionToken ? '✓ Ready' : '⚠ Not signed in');

  const template = [
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Open in Browser', click: () => {
      require('electron').shell.openExternal('https://app.noruma.ai');
    }},
    { label: 'Check for Updates', click: () => autoUpdater.checkForUpdates() }
  ];

  if (_updateReady) {
    template.push({ type: 'separator' });
    template.push({
      label: `Install Update v${_updateVersion || ''} & Restart`,
      click: _installUpdateAndRestart
    });
  }

  template.push(
    { type: 'separator' },
    { label: 'Settings', click: () => { mainWindow?.show(); } },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  );

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420, height: 600, resizable: true,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f172a',
    show: false,  // START HIDDEN
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createOverlayWindow() {
  if (!OVERLAY_ENABLED) {
    console.log('[Overlay] Disabled — skipping window creation (see OVERLAY_ENABLED flag)');
    return;
  }
  const settings = loadSettings();
  const x = settings.overlayX ?? 40;
  const y = settings.overlayY ?? 40;
  const w = settings.overlayW ?? 420;
  const h = settings.overlayH ?? 300;

  overlayWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 320,
    minHeight: 200,
    x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setAlwaysOnTop(true, 'screen-saver'); // highest level — floats over everything
  overlayWindow.setVisibleOnAllWorkspaces(true);
  overlayWindow.setIgnoreMouseEvents(true, { forward: true }); // click-through by default (ghost state)

  // Save position and size whenever user moves or resizes
  const saveOverlayBounds = () => {
    const [wx, wy] = overlayWindow.getPosition();
    const [ww, wh] = overlayWindow.getSize();
    const s = loadSettings();
    s.overlayX = wx; s.overlayY = wy;
    s.overlayW = ww; s.overlayH = wh;
    saveSettings(s);
  };
  overlayWindow.on('moved', saveOverlayBounds);
  overlayWindow.on('resized', saveOverlayBounds);

  overlayWindow.on('closed', () => { overlayWindow = null; });
}

// ── URL Scheme: interviewcoach://start ───────────────────────────────────────
// Allows the web UI to launch and start recording even if the app is closed.
// Register as default handler for interviewcoach:// protocol.
// In dev mode (electron .), pass the app path so macOS launches the app correctly.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('interviewcoach', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('interviewcoach');
}

// Handle deep link on macOS — works for both cold launch and already-running cases.
// On cold launch, open-url may fire before whenReady — queue it for later.
let _queuedDeepLink = null;

app.on('open-url', (event, url) => {
  event.preventDefault();
  console.log('[DeepLink] Received:', url);

  if (!app.isReady() || !mainWindow) {
    console.log('[DeepLink] Queued for cold launch');
    _queuedDeepLink = url;
    return;
  }

  if (url.startsWith('interviewcoach://activate')) {
    // First-launch activation flow — validate token with website API
    handleActivateDeepLink(url);
  } else if (url.startsWith('interviewcoach://start')) {
    // Existing flow: web app starts capture
    storeAuthFromURL(url);
    mainWindow?.show();
    setTimeout(() => {
      startAudioCapture('', '').then(() => {
        console.log('[DeepLink] Audio capture started via URL scheme');
      }).catch(e => console.error('[DeepLink] Start failed:', e.message));
    }, 500);
  }
});

async function handleActivateDeepLink(url) {
  const urlObj = new URL(url);
  const token = urlObj.searchParams.get('token');
  if (!token) {
    console.error('[DeepLink] No token in activate URL');
    return;
  }

  console.log('[DeepLink] Activating via auth bridge...');

  // Hit the auth bridge on the Interview Coach server

  try {
    const response = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({ token, client: 'electron' });
      const reqUrl = new URL('/auth/bridge', IC_SERVER);
      const req = net.request({
        method: 'POST',
        url: reqUrl.toString(),
      });
      req.setHeader('Content-Type', 'application/json');

      let data = '';
      req.on('response', (res) => {
        res.on('data', chunk => data += chunk.toString());
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { reject(new Error('Invalid response')); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    if (response.status !== 200 || !response.body.success) {
      console.error('[DeepLink] Bridge failed:', response.body);
      showNotification('Activation Failed', 'Please try the link again or sign in from the browser.');
      return;
    }

    const { companionToken, userId, email, role, stage } = response.body;

    // Store companion token securely
    storeCompanionToken(companionToken);

    // Store user profile
    storeUserProfile({ userId, email, role, stage });

    console.log(`[DeepLink] Activated: ${email} (${role})`);

    // Request mic permission if needed
    if (process.platform === 'darwin') {
      const mic = systemPreferences.getMediaAccessStatus('microphone');
      if (mic !== 'granted') {
        await systemPreferences.askForMediaAccess('microphone');
      }
    }

    // Show notification and retreat to tray
    showNotification('Interview Coach Ready', 'Head back to your browser to start your practice.');

    // Open browser to practice/first page
    const { shell } = require('electron');
    shell.openExternal(`${IC_SERVER}/practice/first`);

    // Hide the window — tray only
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  } catch (err) {
    console.error('[DeepLink] Activation error:', err.message);
    showNotification('Connection Error', 'Check your internet and try again.');
  }
}

function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// Overlay is created on demand (when user clicks the Overlay button or a coaching card fires)
// Do NOT auto-create on startup.

app.whenReady().then(async () => {
  const isPreview = process.argv.includes('--preview');

  buildMenu();
  createWindow();
  createTray();

  // Preview mode — show specific screen with mock data
  if (isPreview) {
    const screen = process.argv[process.argv.indexOf('--preview') + 1] || 'first-practice';
    const mockProfile = {
      user_id: 'preview-user',
      email: 'alex@techsales.com',
      role: 'enterprise_ae',
      stage: 'actively_interviewing',
      first_launch: true
    };
    const roleArg = process.argv[process.argv.indexOf('--preview') + 2];
    if (roleArg && ['sdr_bdr','mid_market_ae','enterprise_ae','se_csm_am','sales_manager_director','vp_plus'].includes(roleArg)) {
      mockProfile.role = roleArg;
    }
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('preview-mode', { screen, profile: mockProfile });
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => mainWindow.setAlwaysOnTop(false), 2000);
    console.log(`[Preview] Showing "${screen}" screen with role: ${mockProfile.role}`);
    return;
  }

  // Always start local server — browser needs it
  startLocalServer();

  // Handle deep link on cold launch
  const coldLaunchUrl = _queuedDeepLink || process.argv.find(a => a.startsWith('interviewcoach://'));
  _queuedDeepLink = null;
  if (coldLaunchUrl && coldLaunchUrl.startsWith('interviewcoach://activate')) {
    handleActivateDeepLink(coldLaunchUrl);
    return;
  }

  // Normal launch — check if we have a companion token
  const companionToken = loadCompanionToken();
  if (companionToken) {
    // Authenticated — stay hidden, just tray + server
    console.log('[Main] Companion token found — running as background companion');

    // Check permissions silently
    if (process.platform === 'darwin') {
      const mic = systemPreferences.getMediaAccessStatus('microphone');
      const screen = systemPreferences.getMediaAccessStatus('screen');
      if (mic !== 'granted' || screen !== 'granted') {
        // Show permission window
        mainWindow.show();
        mainWindow.webContents.on('did-finish-load', () => {
          mainWindow.webContents.send('show-permissions', { mic, screen });
        });
      }
    }
  } else {
    // No companion token — show login prompt
    mainWindow.show();
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('show-login');
    });
  }

  startMeetingDetection();

  // Silent background update check on launch (non-blocking)
  const runUpdateCheck = (reason) => {
    autoUpdater.checkForUpdates()
      .then(res => { if (res) console.log(`[Updater] Check (${reason}) ok`); })
      .catch(err => console.log(`[Updater] Check (${reason}) failed (non-fatal):`, err.message));
  };
  setTimeout(() => runUpdateCheck('launch'), 5000);
  // Recheck every 30 min so long-running tray instances actually pick up
  // releases published after the app started.
  setInterval(() => runUpdateCheck('interval'), 30 * 60 * 1000);
});

app.on('window-all-closed', () => { /* stay alive in tray */ });
app.on('before-quit', () => { app.isQuitting = true; stopAudioProcess(); });

// ── Shared capture logic (used by IPC + local HTTP server) ──────────────────

const _BASE_SERVER_URL = 'wss://app.noruma.ai';
const DG_KEY     = '54d546fe79b59f0f372e78e6cc3e77673649b611';

// Auth credentials — stored in settings.json, auto-provisioned by web app
// Priority: Clerk session token (from web app launch) > Desktop API key (manual fallback)
let _sessionToken = null;  // Short-lived Clerk JWT passed from web app per-session
let _sessionUserId = null;

function getServerURL() {
  const settings = loadSettings();

  // Priority 1: Fresh Clerk token from web app (passed via URL scheme or /start endpoint)
  if (_sessionToken && _sessionUserId) {
    return `${_BASE_SERVER_URL}?token=${encodeURIComponent(_sessionToken)}&user_id=${encodeURIComponent(_sessionUserId)}`;
  }
  // Priority 2: Per-user desktop token (auto-provisioned by web app, never expires)
  const dt = settings.desktopToken || '';
  if (dt) {
    return `${_BASE_SERVER_URL}?desktop_token=${encodeURIComponent(dt)}`;
  }
  // Priority 3: Owner desktop API key (admin-only manual fallback)
  const key = settings.desktopApiKey || '';
  const uid = settings.userId || '';
  if (key && uid) {
    return `${_BASE_SERVER_URL}?desktop_key=${encodeURIComponent(key)}&user_id=${encodeURIComponent(uid)}`;
  }
  return _BASE_SERVER_URL;
}

// Extract and store auth credentials from a deep link URL
// e.g. interviewcoach://start?token=eyJ...&user_id=user_xxx
function storeAuthFromURL(url) {
  try {
    // URL class can't parse custom schemes — extract query string manually
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return;
    const params = new URLSearchParams(url.substring(qIdx));
    const token = params.get('token');
    const userId = params.get('user_id');
    const desktopToken = params.get('desktop_token');
    if (token) _sessionToken = token;
    if (userId) _sessionUserId = userId;

    // Persist to settings
    const s = loadSettings();
    if (userId) s.userId = userId;
    if (desktopToken) s.desktopToken = desktopToken;
    if (userId || desktopToken) saveSettings(s);

    if (token && userId) console.log('[Auth] Clerk credentials received for user:', userId);
    if (desktopToken) console.log('[Auth] Desktop token stored for auto-detect');
  } catch (e) {
    console.warn('[Auth] Failed to parse auth from URL:', e.message);
  }
}

// Store auth credentials from local HTTP /start request body
function storeAuthFromPayload(payload) {
  if (payload.authToken) _sessionToken = payload.authToken;
  if (payload.userId) _sessionUserId = payload.userId;

  // Persist to settings
  const s = loadSettings();
  if (payload.userId) s.userId = payload.userId;
  if (payload.desktopToken) s.desktopToken = payload.desktopToken;
  if (payload.userId || payload.desktopToken) saveSettings(s);

  if (payload.authToken && payload.userId) {
    console.log('[Auth] Clerk credentials received (HTTP) for user:', payload.userId);
  }
  if (payload.desktopToken) console.log('[Auth] Desktop token stored for auto-detect');
}

// Bring the main window to the foreground and route the renderer to view-main
// so the user sees live transcripts + connection status while capturing.
// Idempotent — safe to call from every capture entry point.
function showMainWindowForCapture() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const send = () => { try { mainWindow.webContents.send('show-main'); } catch (_) {} };
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', send);
    } else {
      send();
    }
    mainWindow.show();
    mainWindow.focus();
  } catch (e) {
    console.warn('[Main] showMainWindowForCapture failed:', e.message);
  }
}

function startAudioCapture(prospectName, prospectCompany) {
  // Always pop the troubleshooting window — live transcripts + WS status give
  // the user instant feedback on whether capture is healthy before they start
  // speaking. Idempotent on re-entry.
  showMainWindowForCapture();

  if (audioProcess) return Promise.resolve({ ok: true, already: true });
  console.log('[Main] Spawning:', BINARY_PATH);

  // Ensure binary is executable (may lose permissions after install/xattr)
  try { fs.chmodSync(BINARY_PATH, 0o755); } catch (e) { console.warn('[Main] chmod failed:', e.message); }

  const SERVER_URL = getServerURL();
  audioProcess = spawn(BINARY_PATH, [SERVER_URL, DG_KEY, prospectName || '', prospectCompany || ''], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Write Swift stderr to a rotating debug log under ~/Library/Logs so we can
  // inspect AEC diagnostics after a session. Gated by env for zero overhead
  // when the user isn't actively debugging.
  const IC_LOG_DIR = path.join(app.getPath('logs'));
  try { fs.mkdirSync(IC_LOG_DIR, { recursive: true }); } catch (_) {}
  const swiftLogPath = path.join(IC_LOG_DIR, 'audio-capture.log');
  const swiftLogStream = fs.createWriteStream(swiftLogPath, { flags: 'a' });
  swiftLogStream.write(`\n\n=== session start ${new Date().toISOString()} ===\n`);

  audioProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    console.log('[Swift]', line);
    try { swiftLogStream.write(line + '\n'); } catch (_) {}
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-log', line); } catch (_) {}
  });

  audioProcess.stdout.on('data', (data) => {
    data.toString().split('\n').forEach(l => {
      if (l.trim() === 'READY') {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-log', 'READY'); } catch (_) {}
      }
    });
  });

  audioProcess.on('exit', (code, signal) => {
    console.log('[Main] Swift exited:', code, signal);
    audioProcess = null;
    updateTrayMenu(false);
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-stopped', { code, signal }); } catch (_) {}
  });

  audioProcess.on('error', (err) => {
    console.error('[Main] Spawn error:', err.message);
    audioProcess = null;
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-stopped', { code: -1 }); } catch (_) {}
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
  const ALLOWED_ORIGINS = [
    'https://app.noruma.ai',
    'http://localhost:3000',
    'http://localhost:4173',
    'http://localhost:5173'
  ];

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const isAllowed = ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost:');

    res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : ALLOWED_ORIGINS[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Companion-Token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const sendJson = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch { resolve({}); }
      });
    });

    // GET /status — companion state for browser detection
    if (req.method === 'GET' && req.url === '/status') {
      const pkg = require('./package.json');
      const token = loadCompanionToken();
      const mic = process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('microphone')
        : 'granted';
      const screen = process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'granted';

      let state = 'ready';
      if (!token) state = 'needsLogin';
      else if (mic !== 'granted' || screen !== 'granted') state = 'needsPermissions';
      else if (audioProcess) state = _activeLaunchId ? 'session_bound' : 'capturing';

      sendJson(200, {
        ok: true,
        version: pkg.version,
        state,
        authenticated: !!token,
        recording: audioProcess !== null,
        needsRestart: _needsRestart || false,
        activeLaunchId: _activeLaunchId || null,
        permissions: {
          microphone: mic,
          screenRecording: screen
        }
      });
      return;
    }

    // GET /permissions — detailed permission state
    if (req.method === 'GET' && req.url === '/permissions') {
      const mic = process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('microphone')
        : 'granted';
      const screen = process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'granted';
      sendJson(200, { microphone: mic, screenRecording: screen });
      return;
    }

    // POST /prepare — validate launch token, arm for capture
    if (req.method === 'POST' && req.url === '/prepare') {
      readBody().then(async (data) => {
        if (!data.launchToken) return sendJson(400, { error: 'missing_launch_token' });

        // Validate launch token by calling back to IC server
        // (avoids shipping BRIDGE_JWT_SECRET to the client)
        try {
          const { status, body } = await postJson(
            `${IC_SERVER}/api/launch-token/validate`,
            { launchToken: data.launchToken }
          );

          if (status !== 200) {
            console.warn(`[LocalServer] Launch validation failed: status=${status} body=${JSON.stringify(body)}`);
            return sendJson(401, { error: (body && body.error) || 'invalid_launch_token' });
          }

          _preparedLaunch = {
            launchId: body.launchId,
            userId: body.userId,
            role: body.role,
            callType: body.callType,
            preparedAt: Date.now()
          };

          console.log(`[LocalServer] Prepared launch=${body.launchId} role=${body.role}`);
          sendJson(200, { status: 'prepared', launchId: body.launchId });
        } catch (e) {
          console.error('[LocalServer] Launch validation error:', e.message, e.stack);
          sendJson(500, { error: 'validation_failed', message: e.message });
        }
      });
      return;
    }

    // POST /commit-start — actually start capture + overlay
    if (req.method === 'POST' && req.url === '/commit-start') {
      readBody().then(async (data) => {
        if (!data.launchId) return sendJson(400, { error: 'missing_launch_id' });
        if (!_preparedLaunch || _preparedLaunch.launchId !== data.launchId) {
          return sendJson(400, { error: 'not_prepared', message: 'Call /prepare first' });
        }

        // Check prepare didn't expire (30 seconds)
        if (Date.now() - _preparedLaunch.preparedAt > 30000) {
          _preparedLaunch = null;
          return sendJson(400, { error: 'prepare_expired' });
        }

        _activeLaunchId = data.launchId;

        // Start audio capture
        try {
          await startAudioCapture(data.prospectName || 'Practice Interview', data.prospectCompany || '');
        } catch (e) {
          _activeLaunchId = null;
          return sendJson(500, { error: 'capture_failed', message: e.message });
        }

        // Show overlay
        if (!overlayWindow) createOverlayWindow();
        overlayWindow?.show();

        // Persist launchId for recovery
        try {
          fs.writeFileSync(path.join(app.getPath('userData'), 'active-launch.json'),
            JSON.stringify({ launchId: _activeLaunchId, startedAt: Date.now() }));
        } catch {}

        console.log(`[LocalServer] Committed launch=${data.launchId} — capture started`);
        sendJson(200, { status: 'capturing', launchId: data.launchId });

        _preparedLaunch = null; // consumed
      });
      return;
    }

    // POST /start — legacy compatibility for main app's /#practice flow
    // Accepts { authToken, userId, desktopToken, prospectName, prospectCompany }
    if (req.method === 'POST' && req.url === '/start') {
      readBody().then(async (data) => {
        // Store auth for getServerURL()
        if (data.authToken) _sessionToken = data.authToken;
        if (data.userId) _sessionUserId = data.userId;
        if (data.desktopToken) {
          try {
            const settings = loadSettings ? loadSettings() : {};
            settings.desktopToken = data.desktopToken;
            fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2));
          } catch (e) { console.warn('[/start] Could not persist desktopToken:', e.message); }
        }

        // If already recording, stop first so we restart with the new auth
        if (audioProcess) {
          console.log('[/start] Already recording — stopping to restart with fresh auth');
          stopAudioProcess();
          await new Promise(r => setTimeout(r, 800));
        }

        try {
          await startAudioCapture(data.prospectName || '', data.prospectCompany || '');
          console.log('[/start] Legacy start succeeded');
          sendJson(200, { status: 'started' });
        } catch (e) {
          console.error('[/start] Failed:', e.message);
          sendJson(500, { error: 'capture_failed', message: e.message });
        }
      });
      return;
    }

    // POST /stop — stop capture
    if (req.method === 'POST' && req.url === '/stop') {
      stopAudioProcess();
      _activeLaunchId = null;
      _preparedLaunch = null;
      overlayWindow?.hide();
      try { fs.unlinkSync(path.join(app.getPath('userData'), 'active-launch.json')); } catch {}
      sendJson(200, { status: 'stopped' });
      return;
    }

    // POST /restart — self-restart for permission refresh
    if (req.method === 'POST' && req.url === '/restart') {
      app.relaunch();
      app.quit();
      return;
    }

    // Legacy overlay endpoints (keep for now)
    if (req.method === 'POST' && req.url === '/overlay/test') {
      if (!overlayWindow) createOverlayWindow();
      overlayWindow?.show();
      overlayWindow?.webContents.send('overlay-test-mode');
      sendJson(200, { ok: true, disabled: !OVERLAY_ENABLED });
      return;
    }

    if (req.method === 'POST' && req.url === '/overlay/hide') {
      overlayWindow?.hide();
      sendJson(200, { ok: true });
      return;
    }

    sendJson(404, { error: 'not_found' });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('[LocalServer] Port 59842 in use — killing stale process and retrying...');
      exec("lsof -ti:59842 | xargs kill -9", () => {
        setTimeout(() => {
          server.listen(59842, '127.0.0.1', () => {
            console.log('[LocalServer] Listening on http://localhost:59842 (after port reclaim)');
          });
        }, 500);
      });
    } else {
      console.log('[LocalServer] Error (non-fatal):', err.message);
    }
  });
  server.listen(59842, '127.0.0.1', () => {
    console.log('[LocalServer] Listening on http://localhost:59842');
  });
}

ipcMain.handle('stop-capture', async () => { stopAudioProcess(); return { ok: true }; });

// Overlay IPC — all show paths are guarded via createOverlayWindow() early-return
// while OVERLAY_ENABLED is false. `.show()` calls use optional chaining so they
// no-op when the window was never created. Re-enabling the feature is a
// single-flag flip at the top of this file.
ipcMain.handle('overlay-show', () => {
  if (!overlayWindow) createOverlayWindow();
  overlayWindow?.show();
});
ipcMain.handle('overlay-hide', () => {
  overlayWindow?.hide();
});

// Click-through: pass mouse events through when in ghost state, intercept when hovered
ipcMain.on('overlay-mouse-enter', () => {
  overlayWindow?.setIgnoreMouseEvents(false);
});
ipcMain.on('overlay-mouse-leave', () => {
  // Forward: true means mouse events still reach the overlay for hover detection
  overlayWindow?.setIgnoreMouseEvents(true, { forward: true });
});
ipcMain.handle('overlay-test', () => {
  if (!overlayWindow) createOverlayWindow();
  overlayWindow?.show();
  overlayWindow?.webContents.send('overlay-test-mode');
});
ipcMain.handle('overlay-coaching', (event, data) => {
  if (!overlayWindow) createOverlayWindow();
  overlayWindow?.show();
  overlayWindow?.webContents.send('overlay-coaching', data);
});
ipcMain.handle('overlay-dismiss', () => {
  overlayWindow?.webContents.send('overlay-dismiss');
});
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

// ── Auth IPC (first-launch flow) ────────────────────────────────────────────

ipcMain.handle('send-magic-link', async (event, email) => {
  return sendMagicLink(email);
});

ipcMain.handle('get-user-profile', async () => {
  return loadUserProfile();
});

ipcMain.handle('logout', async () => {
  clearSessionToken();
  clearUserProfile();
  return { ok: true };
});

ipcMain.handle('mark-onboarded', async () => {
  const profile = loadUserProfile();
  if (profile) {
    profile.first_launch = false;
    storeUserProfile(profile);
  }
  return { ok: true };
});

// Dismiss meeting prompt — suppress for 45 min (rest of typical interview)
ipcMain.handle('dismiss-meeting-prompt', async () => {
  _dismissedUntil = Date.now() + 45 * 60 * 1000;
  _meetingStartedCapture = false;
  return { ok: true };
});

// ── Permission + Window IPC (companion mode) ───────────────────────────────

ipcMain.handle('request-mic-permission', async () => {
  if (process.platform === 'darwin') {
    const result = await systemPreferences.askForMediaAccess('microphone');
    return { granted: result };
  }
  return { granted: true };
});

ipcMain.on('recheck-permissions', (event) => {
  if (process.platform === 'darwin') {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    const screen = systemPreferences.getMediaAccessStatus('screen');
    event.sender.send('show-permissions', { mic, screen });
  }
});

ipcMain.on('hide-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

function stopAudioProcess() {
  if (audioProcess) {
    try { audioProcess.stdin.write('STOP\n'); } catch (e) {}
    setTimeout(() => { if (audioProcess) { audioProcess.kill('SIGTERM'); audioProcess = null; } }, 1000);
  }
}

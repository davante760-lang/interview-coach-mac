const { app, BrowserWindow, systemPreferences, ipcMain, Menu, Tray, nativeImage, Notification, safeStorage, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs   = require('fs');
const http = require('http');

let mainWindow;
let overlayWindow = null;
let tray = null;
let audioProcess = null;

// ── Website API Base URL ─────────────────────────────────────────────────────
const WEBSITE_API_BASE = 'https://interviewwebsite-production.up.railway.app';

// ── Dev: --reset flag clears all auth data for clean testing ─────────────────
if (process.argv.includes('--reset')) {
  const userDataPath = app.getPath('userData');
  const filesToClear = ['session.enc', 'user-profile.json'];
  filesToClear.forEach(f => {
    try { fs.unlinkSync(path.join(userDataPath, f)); } catch {}
  });
  // Clear auth keys from settings but keep window/overlay prefs
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8'));
    delete s.userId; delete s.desktopToken; delete s.desktopApiKey; delete s._sessionTokenFallback;
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
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-downloaded', info.version); } catch (_) {}
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

function createOverlayWindow() {
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
  try {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return;
    const params = new URLSearchParams(url.substring(qIdx));
    const token = params.get('token');
    if (!token) {
      console.warn('[DeepLink] No token in activate URL');
      mainWindow?.show();
      mainWindow?.webContents.send('auth-result', { success: false, error: 'missing_token' });
      return;
    }

    mainWindow?.show();
    mainWindow?.webContents.send('auth-loading');

    const result = await validateActivationToken(token);
    if (result.success) {
      console.log('[DeepLink] Activation successful for:', result.email);
      // Store session securely
      storeSessionToken(result.session_token);
      // Store profile locally
      storeUserProfile({
        user_id: result.user_id,
        email: result.email,
        role: result.role,
        stage: result.stage,
        first_launch: true
      });
      // Also store userId for existing audio capture auth
      const s = loadSettings();
      s.userId = result.user_id;
      saveSettings(s);
      // Tell renderer to show first-practice screen
      mainWindow?.webContents.send('auth-result', {
        success: true,
        user_id: result.user_id,
        email: result.email,
        role: result.role,
        stage: result.stage,
        first_launch: true
      });
    } else {
      console.warn('[DeepLink] Activation failed:', result.error);
      mainWindow?.webContents.send('auth-result', {
        success: false,
        error: result.error,
        message: result.message
      });
    }
  } catch (e) {
    console.error('[DeepLink] Activation error:', e.message);
    mainWindow?.webContents.send('auth-result', { success: false, error: 'unexpected', message: e.message });
  }
}

// Overlay is created on demand (when user clicks the Overlay button or a coaching card fires)
// Do NOT auto-create on startup.

app.whenReady().then(async () => {
  const isPreview = process.argv.includes('--preview');

  // Skip permission prompts in preview mode
  if (!isPreview && process.platform === 'darwin') {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    if (mic !== 'granted') await systemPreferences.askForMediaAccess('microphone');
    const screen = systemPreferences.getMediaAccessStatus('screen');
    console.log('[Main] Screen:', screen, '| Mic:', mic);
  }
  buildMenu();
  createWindow();
  if (!isPreview) createTray();

  // ── Preview mode: show a specific screen with mock data, skip all auth ──
  const previewScreen = isPreview ? '--preview' : null;
  if (previewScreen) {
    const screen = process.argv[process.argv.indexOf(previewScreen) + 1] || 'first-practice';
    const mockProfile = {
      user_id: 'preview-user',
      email: 'alex@techsales.com',
      role: 'enterprise_ae',
      stage: 'actively_interviewing',
      first_launch: true
    };
    // Override role if passed: --preview first-practice mid_market_ae
    const roleArg = process.argv[process.argv.indexOf(previewScreen) + 2];
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
    return; // Skip all auth, meeting detection, deep link handling
  }

  // Overlay created on demand — not on startup
  startLocalServer();
  startMeetingDetection();

  // Handle deep link when app was cold-launched via URL scheme.
  const coldLaunchUrl = _queuedDeepLink || process.argv.find(a => a.startsWith('interviewcoach://'));
  _queuedDeepLink = null;
  if (coldLaunchUrl) {
    console.log('[DeepLink] Cold launch via URL scheme:', coldLaunchUrl);
    if (coldLaunchUrl.startsWith('interviewcoach://activate')) {
      // First-launch activation — handle via website API
      handleActivateDeepLink(coldLaunchUrl);
    } else {
      // Existing start-capture flow
      storeAuthFromURL(coldLaunchUrl);
      setTimeout(() => {
        startAudioCapture('', '').then(() => {
          console.log('[DeepLink] Audio capture started (cold launch)');
        }).catch(e => console.error('[DeepLink] Cold start failed:', e.message));
      }, 1500);
    }
  } else {
    // open-url may fire AFTER whenReady on macOS — wait briefly and check
    setTimeout(() => {
      if (_queuedDeepLink) {
        const url = _queuedDeepLink;
        _queuedDeepLink = null;
        console.log('[DeepLink] Late cold-launch URL:', url);
        if (url.startsWith('interviewcoach://activate')) {
          handleActivateDeepLink(url);
        } else {
          storeAuthFromURL(url);
          startAudioCapture('', '').then(() => {
            console.log('[DeepLink] Audio capture started (late cold launch)');
          }).catch(e => console.error('[DeepLink] Late cold start failed:', e.message));
        }
      } else {
        // No deep link — check for existing session or show login
        checkSessionOnLaunch();
      }
    }, 2000);
  }

  async function checkSessionOnLaunch() {
    const sessionToken = loadSessionToken();
    if (sessionToken) {
      // Returning user — validate session
      console.log('[Auth] Found stored session, validating...');
      mainWindow?.webContents.send('auth-loading');
      const result = await validateSession(sessionToken);
      if (result.valid) {
        console.log('[Auth] Session valid for:', result.email);
        storeUserProfile({
          user_id: result.user_id,
          email: result.email,
          role: result.role,
          stage: result.stage,
          first_launch: false
        });
        mainWindow?.webContents.send('auth-result', {
          success: true,
          user_id: result.user_id,
          email: result.email,
          role: result.role,
          stage: result.stage,
          first_launch: false
        });
      } else {
        console.log('[Auth] Session expired, showing login');
        clearSessionToken();
        clearUserProfile();
        mainWindow?.webContents.send('show-login', { reason: 'session_expired' });
      }
    } else {
      // No session — show login screen
      const profile = loadUserProfile();
      if (!profile) {
        mainWindow?.webContents.send('show-login', {});
      } else {
        mainWindow?.webContents.send('show-login', { email: profile.email });
      }
    }
  }

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

const _BASE_SERVER_URL = 'wss://interview-coach-production-9c63.up.railway.app';
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

function startAudioCapture(prospectName, prospectCompany) {
  if (audioProcess) return Promise.resolve({ ok: true, already: true });
  console.log('[Main] Spawning:', BINARY_PATH);

  // Ensure binary is executable (may lose permissions after install/xattr)
  try { fs.chmodSync(BINARY_PATH, 0o755); } catch (e) { console.warn('[Main] chmod failed:', e.message); }

  const SERVER_URL = getServerURL();
  audioProcess = spawn(BINARY_PATH, [SERVER_URL, DG_KEY, prospectName || '', prospectCompany || ''], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  audioProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    console.log('[Swift]', line);
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
      req.on('end', async () => {
        const data = JSON.parse(body || '{}');
        const hadAuth = !!_sessionToken;
        // Store auth credentials from web app (Clerk token + userId)
        storeAuthFromPayload(data);
        const hasAuthNow = !!_sessionToken;

        // If Swift is already running WITH auth, just ack — don't restart
        if (audioProcess && hadAuth) {
          console.log('[HTTP] Capture already running with auth — skipping restart');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, already: true }));
          return;
        }

        // If Swift is running but WITHOUT auth, restart it with credentials
        if (audioProcess && !hadAuth && hasAuthNow) {
          console.log('[HTTP] Restarting capture with fresh auth credentials');
          stopAudioProcess();
          await new Promise(r => setTimeout(r, 1500));
        }

        // Route through renderer so it updates its UI state (same path as meeting auto-start)
        mainWindow?.show();
        mainWindow?.focus();
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('web-start-capture', {
          prospectName: data.prospectName || '',
          prospectCompany: data.prospectCompany || ''
        }); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      stopAudioProcess();
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('web-stop-capture'); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/overlay/coaching') {
      // DISABLED per user request — overlay no longer auto-shows on coaching events.
      // Drain the body and ack without showing the window.
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, suppressed: true }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/overlay/test') {
      if (!overlayWindow) createOverlayWindow();
      overlayWindow.show();
      overlayWindow.webContents.send('overlay-test-mode');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/overlay/hide') {
      overlayWindow?.hide();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404); res.end();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('[LocalServer] Port 59842 in use — killing stale process and retrying...');
      // Kill whatever is holding the port, then retry after 500ms
      const { exec } = require('child_process');
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

// Overlay IPC
ipcMain.handle('overlay-show', () => {
  if (!overlayWindow) createOverlayWindow();
  overlayWindow.show();
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
  overlayWindow.show();
  overlayWindow.webContents.send('overlay-test-mode');
});
ipcMain.handle('overlay-coaching', (event, data) => {
  if (!overlayWindow) createOverlayWindow();
  overlayWindow.show();
  overlayWindow.webContents.send('overlay-coaching', data);
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

function stopAudioProcess() {
  if (audioProcess) {
    try { audioProcess.stdin.write('STOP\n'); } catch (e) {}
    setTimeout(() => { if (audioProcess) { audioProcess.kill('SIGTERM'); audioProcess = null; } }, 1000);
  }
}

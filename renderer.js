// renderer.js
// UI logic — drives the Swift audio capture binary via Electron IPC.
// NO getUserMedia, NO AudioContext, NO WebSocket here.
// All audio happens in the Swift process.

const { ipcRenderer, shell } = require('electron');

let isCapturing = false;
let startTime   = null;
let timerHandle = null;

// Show app version
try {
  const pkg = require('./package.json');
  const el = document.getElementById('app-version');
  if (el) el.textContent = 'v' + pkg.version;
} catch (e) {}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW ROUTING — manages login → first-practice → main transitions
// ═══════════════════════════════════════════════════════════════════════════════

const VIEWS = ['view-loading', 'view-permissions', 'view-setup', 'view-main'];
let _currentView = null;
let _userProfile = null; // { user_id, email, role, stage, first_launch }

function switchView(viewId) {
  // Normalize: allow passing 'setup' or 'view-setup'
  if (!viewId.startsWith('view-')) viewId = 'view-' + viewId;
  VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === viewId);
  });
  _currentView = viewId;
}

// ── Preview Mode (--preview flag) — shows screens without auth ───────────────

ipcRenderer.on('preview-mode', (event, { screen, profile }) => {
  console.log('[Preview] Renderer received preview-mode:', screen, profile);
  _userProfile = profile;
  if (screen === 'permissions') {
    switchView('permissions');
    updatePermissionUI('not-determined', 'not-determined');
  } else if (screen === 'setup') {
    switchView('setup');
  } else if (screen === 'main') {
    showMainView(profile);
  }
});

// ── Auth Events from Main Process ────────────────────────────────────────────

ipcRenderer.on('auth-loading', () => {
  switchView('loading');
});

ipcRenderer.on('show-permissions', (event, { mic, screen }) => {
  switchView('permissions');
  updatePermissionUI(mic, screen);
});

ipcRenderer.on('show-login', () => {
  switchView('setup');
});

// Main process is about to start (or has started) an audio capture session —
// make sure we're on the capture view so the user can see live transcripts
// and connection status flowing in. Fired from main.js startAudioCapture(),
// which covers both user-driven and web-app-driven (/commit-start) paths.
ipcRenderer.on('show-main', () => {
  showMainView(_userProfile);
  // Flip the capture UI so the transcripts panel + stats are visible.
  // Harmless if already capturing (idempotent).
  if (!isCapturing) {
    isCapturing = true;
    startTime = Date.now();
    startTimer();
  }
  updateUI('capturing');
});

function updatePermissionUI(mic, screen) {
  const micEl = document.getElementById('perm-mic');
  const screenEl = document.getElementById('perm-screen');
  if (micEl) {
    const icon = micEl.querySelector('.perm-icon');
    const btn = micEl.querySelector('.perm-btn');
    if (mic === 'granted') {
      icon.textContent = '\u2713';
      icon.style.color = '#3DDC84';
      btn.style.display = 'none';
    }
  }
  if (screenEl) {
    const icon = screenEl.querySelector('.perm-icon');
    const btn = screenEl.querySelector('.perm-btn');
    if (screen === 'granted') {
      icon.textContent = '\u2713';
      icon.style.color = '#3DDC84';
      btn.style.display = 'none';
    }
  }

  if (mic === 'granted' && screen === 'granted') {
    const doneEl = document.getElementById('perm-done');
    if (doneEl) doneEl.style.display = 'block';
    // Auto-hide after 3 seconds
    setTimeout(() => {
      ipcRenderer.send('hide-window');
    }, 3000);
  }
}

// Re-check permissions when window gains focus (user returning from System Settings)
window.addEventListener('focus', () => {
  if (document.getElementById('view-permissions')?.classList.contains('active')) {
    ipcRenderer.send('recheck-permissions');
  }
});

async function requestMicPermission() {
  await ipcRenderer.invoke('request-mic-permission');
}

function openScreenRecordingSettings() {
  require('electron').shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
}

function showMainView(profile) {
  switchView('main');
  if (profile) {
    const statusEl = document.getElementById('auth-status');
    if (statusEl) {
      statusEl.textContent = profile.email || 'Authenticated';
      statusEl.style.color = '#4ade80';
    }
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  return await ipcRenderer.invoke('get-settings');
}

async function saveSettings(s) {
  await ipcRenderer.invoke('save-settings', s);
}

// Load settings and apply to UI on startup
window.addEventListener('DOMContentLoaded', async () => {
  const s = await loadSettings();
  const toggle = document.getElementById('auto-start-toggle');
  if (toggle) toggle.checked = !!s.autoStart;

  // Populate auth fields if present
  const keyInput = document.getElementById('desktop-api-key');
  const userInput = document.getElementById('desktop-user-id');
  if (keyInput && s.desktopApiKey) keyInput.value = s.desktopApiKey;
  if (userInput && s.userId) userInput.value = s.userId;

  // Show auth status
  updateAuthStatus(s);

  // Always start on loading — main process determines which screen via IPC.
  // The main process will send 'show-permissions', 'show-login', or handle
  // a deep link. If nothing arrives within 5s, fall back to setup.
  if (!_currentView) {
    switchView('loading');
    setTimeout(() => {
      if (_currentView === 'view-loading') {
        // Main process didn't respond — show setup as safe default
        switchView('setup');
      }
    }, 5000);
  }
});

async function onAutoStartToggle() {
  const toggle = document.getElementById('auto-start-toggle');
  const val = toggle ? toggle.checked : false;
  await saveSettings({ autoStart: val });
  showSettingsSaved();
}

function showSettingsSaved() {
  const el = document.getElementById('settings-saved');
  if (!el) return;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1200);
}

// ── Auth Settings (Desktop API Key + User ID) ────────────────────────────────

async function saveAuthSettings() {
  const keyInput = document.getElementById('desktop-api-key');
  const userInput = document.getElementById('desktop-user-id');
  const key = keyInput ? keyInput.value.trim() : '';
  const uid = userInput ? userInput.value.trim() : '';

  const s = await loadSettings();
  s.desktopApiKey = key;
  s.userId = uid;
  await saveSettings(s);
  updateAuthStatus(s);
  showSettingsSaved();
}

function updateAuthStatus(s) {
  const statusEl = document.getElementById('auth-status');
  if (!statusEl) return;
  if (s.userId) {
    statusEl.textContent = s.desktopApiKey ? 'Authenticated' : 'User linked';
    statusEl.style.color = '#4ade80';
  } else {
    statusEl.textContent = 'Start a call from the web app to connect';
    statusEl.style.color = '#94a3b8';
  }
}

// ── Meeting Detection Events from Main Process ────────────────────────────────

// Main detected meeting + auto-start is ON → start immediately
ipcRenderer.on('meeting-auto-start', async () => {
  console.log('[Renderer] Auto-starting capture from meeting detection');
  showMeetingBanner('auto');
  if (!isCapturing) await startCapture();
});

// Web app End Session button stopped capture
ipcRenderer.on('web-stop-capture', async () => {
  console.log('[Renderer] Web UI stopped capture');
  if (isCapturing) await stopCapture();
});

// Web app Start Session button triggered capture via local HTTP server
ipcRenderer.on('web-start-capture', async (event, { prospectName, prospectCompany }) => {
  console.log('[Renderer] Web UI triggered capture');
  if (prospectName) {
    const el = document.getElementById('prospect-name');
    if (el) el.value = prospectName;
  }
  if (prospectCompany) {
    const el = document.getElementById('prospect-company');
    if (el) el.value = prospectCompany;
  }
  if (!isCapturing) await startCapture();
});

// Main detected meeting + auto-start is OFF → show prompt
ipcRenderer.on('meeting-detected', () => {
  console.log('[Renderer] Meeting detected — showing prompt');
  showMeetingBanner('prompt');
});

// Meeting ended — stop if we're capturing
ipcRenderer.on('meeting-ended', async () => {
  console.log('[Renderer] Meeting ended');
  hideMeetingBanner();
  if (isCapturing) {
    await stopCapture();
    updateUI('idle');
  }
});

function showMeetingBanner(mode) {
  const banner = document.getElementById('meeting-banner');
  const msg    = document.getElementById('meeting-banner-msg');
  const actions = document.getElementById('meeting-banner-actions');
  if (!banner) return;

  if (mode === 'auto') {
    msg.textContent = 'Meeting detected — recording started';
    if (actions) actions.style.display = 'none';
  } else {
    msg.textContent = 'Meeting detected';
    if (actions) actions.style.display = 'flex';
  }
  banner.style.display = 'flex';
}

function hideMeetingBanner() {
  const banner = document.getElementById('meeting-banner');
  if (banner) banner.style.display = 'none';
}

async function onMeetingStartClick() {
  hideMeetingBanner();
  if (!isCapturing) await startCapture();
}

async function onMeetingDismissClick() {
  hideMeetingBanner();
  await ipcRenderer.invoke('dismiss-meeting-prompt');
}

// ── Listen for events from main process ───────────────────────────────────────

ipcRenderer.on('audio-log', (event, line) => {
  console.log('[Swift]', line);

  // Parse chunk count from "[Audio] N chunks sent"
  const chunkMatch = line.match(/(\d+) chunks sent/);
  if (chunkMatch && isCapturing) {
    document.getElementById('chunks').textContent = chunkMatch[1] + ' chunks';
  }

  // Parse audio format confirmation
  if (line.includes('Hz') && line.includes('int16')) {
    document.getElementById('format').textContent = line.replace('[Audio]', '').trim();
  }

  // Connection status
  if (line.includes('[Railway] Connected')) {
    document.getElementById('ws-status').textContent = 'Railway: connected';
  }
  if (line.includes('[Deepgram-System] Connected')) {
    document.getElementById('ws-status').textContent = 'Deepgram + Railway';
  }
  if (line.includes('[Deepgram-Mic] Connected')) {
    document.getElementById('ws-status').textContent = 'Deepgram + Railway + Mic';
  }

  // Parse system audio final transcripts: [Transcript] text
  const transcriptMatch = line.match(/\[Transcript\]\s*(.+)/);
  if (transcriptMatch) {
    addTranscript(transcriptMatch[1], true, 'interviewer');
  }

  // Parse system audio interim transcripts: [Interim] text
  const interimMatch = line.match(/\[Interim\]\s*(.+)/);
  if (interimMatch) {
    addTranscript(interimMatch[1], false, 'interviewer');
  }

  // Parse mic final transcripts: [Mic-Transcript] text
  const micTranscriptMatch = line.match(/\[Mic-Transcript\]\s*(.+)/);
  if (micTranscriptMatch) {
    addTranscript(micTranscriptMatch[1], true, 'candidate');
  }

  // Parse mic interim transcripts: [Mic-Interim] text
  const micInterimMatch = line.match(/\[Mic-Interim\]\s*(.+)/);
  if (micInterimMatch) {
    addTranscript(micInterimMatch[1], false, 'candidate');
  }
});

ipcRenderer.on('update-downloaded', (event, version) => {
  // Only show the banner when not actively recording — don't interrupt interviews
  if (!isCapturing) {
    const banner = document.getElementById('update-banner');
    const text = document.getElementById('update-banner-text');
    if (banner && text) {
      text.textContent = `v${version} ready to install`;
      banner.style.display = 'flex';
    }
  } else {
    // Store so we can show banner when recording stops
    window._pendingUpdateVersion = version;
  }
});

function restartToUpdate() {
  ipcRenderer.invoke('open-releases-page');
}

ipcRenderer.on('audio-stopped', (event, { code, signal }) => {
  console.log('[Renderer] Swift stopped:', code, signal);
  if (isCapturing) {
    isCapturing = false;
    stopTimer();
    updateUI('error', 'Audio process stopped unexpectedly (code ' + code + ')');
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function startCapture() {
  const serverUrl       = document.getElementById('server-url').value.trim();
  const prospectName    = document.getElementById('prospect-name').value.trim();
  const prospectCompany = document.getElementById('prospect-company').value.trim();

  if (!serverUrl) return alert('Enter server URL');

  // Check binary exists first
  const { exists, path: binPath } = await ipcRenderer.invoke('check-binary');
  if (!exists) {
    updateUI('error',
      'AudioCapture binary not found.\n' +
      'Build it first:\n' +
      '  cd audio-capture && bash build.sh\n' +
      'Expected at: ' + binPath
    );
    return;
  }

  updateUI('connecting');

  const result = await ipcRenderer.invoke('start-capture', {
    serverUrl,
    prospectName,
    prospectCompany
  });

  if (result.error) {
    updateUI('error', result.error);
    return;
  }

  isCapturing = true;
  startTime   = Date.now();
  startTimer();
  updateUI('capturing');
}

// ── Stop ──────────────────────────────────────────────────────────────────────

async function stopCapture() {
  isCapturing = false;
  stopTimer();
  await ipcRenderer.invoke('stop-capture');
  updateUI('idle');
  // Show deferred update banner now that we're no longer recording
  if (window._pendingUpdateVersion) {
    const banner = document.getElementById('update-banner');
    const text = document.getElementById('update-banner-text');
    if (banner && text) {
      text.textContent = `v${window._pendingUpdateVersion} ready to install`;
      banner.style.display = 'flex';
    }
    window._pendingUpdateVersion = null;
  }
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startTimer() {
  timerHandle = setInterval(() => {
    if (!startTime) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    document.getElementById('timer').textContent =
      m + ':' + (s < 10 ? '0' : '') + s;
  }, 500);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
}

// ── Transcripts ──────────────────────────────────────────────────────────

let interimElSystem = null;
let interimElMic = null;

function addTranscript(text, isFinal, speaker) {
  const container = document.getElementById('transcript-content');
  // Remove "Waiting for audio..." placeholder
  const empty = container.querySelector('.transcript-empty');
  if (empty) empty.remove();

  const isCandidate = speaker === 'candidate';
  const prefix = isCandidate ? 'You: ' : '';
  const cls = isCandidate ? 'transcript-line candidate' : 'transcript-line';

  // Reverse-chronological: newest at top, older entries scroll down off-screen.
  // Each new line is prepended to the container; interim elements (per speaker)
  // also live at the top and get replaced in place as Deepgram refines them.
  if (isFinal) {
    // Remove the matching interim element
    if (isCandidate) {
      if (interimElMic) { interimElMic.remove(); interimElMic = null; }
    } else {
      if (interimElSystem) { interimElSystem.remove(); interimElSystem = null; }
    }
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = prefix + text;
    container.insertBefore(el, container.firstChild);
  } else {
    // Update or create interim element per speaker. Interim elements stay at
    // top (firstChild) and get their text updated as new partials arrive.
    if (isCandidate) {
      if (!interimElMic) {
        interimElMic = document.createElement('div');
        interimElMic.className = cls + ' interim';
        container.insertBefore(interimElMic, container.firstChild);
      } else if (interimElMic !== container.firstChild) {
        container.insertBefore(interimElMic, container.firstChild);
      }
      interimElMic.textContent = prefix + text;
    } else {
      if (!interimElSystem) {
        interimElSystem = document.createElement('div');
        interimElSystem.className = cls + ' interim';
        container.insertBefore(interimElSystem, container.firstChild);
      } else if (interimElSystem !== container.firstChild) {
        container.insertBefore(interimElSystem, container.firstChild);
      }
      interimElSystem.textContent = prefix + text;
    }
  }

  // Auto-scroll to TOP so newest content is always visible.
  const panel = document.getElementById('transcripts');
  panel.scrollTop = 0;
}

// ── UI ────────────────────────────────────────────────────────────────────────

function updateUI(state, errorMsg) {
  const dot       = document.getElementById('dot');
  const statusTxt = document.getElementById('status-text');
  const btnStart  = document.getElementById('btn-start');
  const btnStop   = document.getElementById('btn-stop');
  const statsEl   = document.getElementById('stats');
  const errEl     = document.getElementById('error-msg');

  errEl.style.display = 'none';
  errEl.textContent   = '';

  const transcriptsEl = document.getElementById('transcripts');

  if (state === 'idle') {
    dot.className         = 'dot dot-idle';
    statusTxt.textContent = 'Ready';
    statusTxt.style.color = '';
    btnStart.style.display = 'block';
    btnStop.style.display  = 'none';
    statsEl.style.display  = 'none';
    transcriptsEl.style.display = 'none';
    document.getElementById('timer').textContent    = '0:00';
    document.getElementById('chunks').textContent   = '0 chunks';
    document.getElementById('ws-status').textContent = 'WS: -';
    document.getElementById('format').textContent   = '-';
    // Reset transcript content
    document.getElementById('transcript-content').innerHTML =
      '<div class="transcript-empty">Waiting for audio...</div>';
    interimEl = null;

  } else if (state === 'connecting') {
    dot.className         = 'dot dot-idle';
    statusTxt.textContent = 'Starting...';
    btnStart.style.display = 'none';
    btnStop.style.display  = 'none';

  } else if (state === 'capturing') {
    dot.className         = 'dot dot-live';
    statusTxt.textContent = 'Capturing audio';
    statusTxt.style.color = '';
    btnStart.style.display = 'none';
    btnStop.style.display  = 'block';
    statsEl.style.display  = 'block';
    transcriptsEl.style.display = 'block';

  } else if (state === 'error') {
    dot.className         = 'dot dot-idle';
    statusTxt.textContent = 'Error';
    statusTxt.style.color = '#ef4444';
    btnStart.style.display = 'block';
    btnStop.style.display  = 'none';
    if (errorMsg) {
      errEl.style.display = 'block';
      errEl.textContent   = errorMsg;
    }
  }
}

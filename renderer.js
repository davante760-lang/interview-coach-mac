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

const VIEWS = ['view-loading', 'view-login', 'view-waiting', 'view-first-practice', 'view-main'];
let _currentView = null;
let _userProfile = null; // { user_id, email, role, stage, first_launch }

function switchView(viewId) {
  // Normalize: allow passing 'login' or 'view-login'
  if (!viewId.startsWith('view-')) viewId = 'view-' + viewId;
  VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === viewId);
  });
  _currentView = viewId;
}

// ── Role → Practice Config Mapping ──────────────────────────────────────────

const ROLE_CONFIG = {
  sdr_bdr: {
    display: 'SDR / BDR',
    round: 'SDR-to-AE Transition Interview',
    firstQuestion: "You're transitioning from setting meetings to running full-cycle deals. Walk me through a qualified opportunity you sourced and tell me what happened after you handed it off."
  },
  mid_market_ae: {
    display: 'Mid-Market AE',
    round: 'Hiring Manager Round — Enterprise Role',
    firstQuestion: "You're interviewing for an enterprise role with $1.5M annual targets. Your current average deal is $85K. How do you convince me you're ready to sell a $300K deal?"
  },
  enterprise_ae: {
    display: 'Enterprise AE',
    round: 'Hiring Manager Round',
    firstQuestion: "Walk me through how you displaced an incumbent vendor in an account that had been with them for four years."
  },
  se_csm_am: {
    display: 'SE / CSM / AM',
    round: 'Career Transition Interview',
    firstQuestion: "You're moving into a closing role. Tell me about a time you identified expansion revenue in an existing account and drove it to close."
  },
  sales_manager_director: {
    display: 'Sales Manager / Director',
    round: 'Leadership Interview',
    firstQuestion: "You're inheriting a team of 8 reps. Three are below 60% attainment. Walk me through your first 90 days."
  },
  vp_plus: {
    display: 'VP+',
    round: 'Executive Round',
    firstQuestion: "The board wants to see a path to $50M ARR in 18 months. You have 12 reps today. Walk me through your hiring plan, territory design, and ramp assumptions."
  }
};

// ── Preview Mode (--preview flag) — shows screens without auth ───────────────

ipcRenderer.on('preview-mode', (event, { screen, profile }) => {
  console.log('[Preview] Renderer received preview-mode:', screen, profile);
  _userProfile = profile;
  if (screen === 'login') {
    switchView('login');
  } else if (screen === 'first-practice') {
    showFirstPractice(profile);
  } else if (screen === 'waiting') {
    document.getElementById('waiting-email').textContent = profile.email;
    switchView('waiting');
  } else if (screen === 'main') {
    showMainView(profile);
  }
});

// ── Auth Events from Main Process ────────────────────────────────────────────

ipcRenderer.on('auth-loading', () => {
  switchView('loading');
});

ipcRenderer.on('auth-result', (event, result) => {
  if (result.success) {
    _userProfile = result;
    if (result.first_launch) {
      showFirstPractice(result);
    } else {
      showMainView(result);
    }
  } else {
    // Auth failed — show login with appropriate message
    switchView('login');
    if (result.error === 'token_invalid' || result.error === 'missing_token') {
      showLoginNotice('That link has expired. Enter your email to get a new one.');
    } else if (result.error === 'network_error') {
      showLoginNotice('Couldn\'t connect. Check your internet and try again.');
    }
  }
});

ipcRenderer.on('show-login', (event, data) => {
  switchView('login');
  if (data.reason === 'session_expired') {
    showLoginNotice('Your session expired. Enter your email to sign in again.');
  }
  if (data.email) {
    const emailInput = document.getElementById('login-email');
    if (emailInput) emailInput.value = data.email;
  }
});

function showLoginNotice(text) {
  const notice = document.getElementById('login-notice');
  if (notice) {
    notice.textContent = text;
    notice.style.display = 'block';
  }
}

function showFirstPractice(profile) {
  const config = ROLE_CONFIG[profile.role] || ROLE_CONFIG.enterprise_ae;
  const roleEl = document.getElementById('fp-role');
  const roundEl = document.getElementById('fp-round');
  const emailEl = document.getElementById('fp-email');
  if (roleEl) roleEl.textContent = config.display;
  if (roundEl) roundEl.textContent = config.round;
  if (emailEl) emailEl.textContent = profile.email;
  switchView('first-practice');
}

function showMainView(profile) {
  switchView('main');
  // Update auth status in main view
  if (profile) {
    const statusEl = document.getElementById('auth-status');
    if (statusEl) {
      statusEl.textContent = profile.email || 'Authenticated';
      statusEl.style.color = '#4ade80';
    }
  }
}

// ── Magic Link Flow ─────────────────────────────────────────────────────────

let _magicLinkEmail = '';
let _resendTimer = null;
let _fallbackTimer = null;

async function onSendMagicLink() {
  const emailInput = document.getElementById('login-email');
  const email = emailInput ? emailInput.value.trim() : '';
  if (!email || !email.includes('@')) {
    emailInput?.focus();
    return;
  }

  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

  await ipcRenderer.invoke('send-magic-link', email);

  if (btn) { btn.disabled = false; btn.textContent = 'Send Login Link'; }

  _magicLinkEmail = email;
  const waitingEmail = document.getElementById('waiting-email');
  if (waitingEmail) waitingEmail.textContent = email;

  // Reset timers
  clearTimeout(_resendTimer);
  clearTimeout(_fallbackTimer);
  const resendBtn = document.getElementById('btn-resend');
  const fallbackEl = document.getElementById('waiting-fallback');
  if (resendBtn) resendBtn.style.display = 'none';
  if (fallbackEl) fallbackEl.style.display = 'none';

  switchView('waiting');

  // Show resend after 30s
  _resendTimer = setTimeout(() => {
    if (resendBtn) resendBtn.style.display = 'block';
  }, 30000);

  // Show signup fallback after 60s
  _fallbackTimer = setTimeout(() => {
    if (fallbackEl) fallbackEl.style.display = 'block';
  }, 60000);
}

async function onResendMagicLink() {
  if (_magicLinkEmail) {
    const resendBtn = document.getElementById('btn-resend');
    if (resendBtn) resendBtn.textContent = 'Sending...';
    await ipcRenderer.invoke('send-magic-link', _magicLinkEmail);
    if (resendBtn) { resendBtn.textContent = 'Resend link'; resendBtn.style.display = 'none'; }
    // Reset the 30s timer
    clearTimeout(_resendTimer);
    _resendTimer = setTimeout(() => {
      if (resendBtn) resendBtn.style.display = 'block';
    }, 30000);
  }
}

// Allow Enter key to submit login
window.addEventListener('DOMContentLoaded', () => {
  const emailInput = document.getElementById('login-email');
  if (emailInput) {
    emailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onSendMagicLink();
    });
  }
});

// ── First Practice Launch ───────────────────────────────────────────────────

async function onStartFirstPractice() {
  if (!_userProfile) return;

  // Mark as onboarded so next launch goes to main
  await ipcRenderer.invoke('mark-onboarded');

  // Open the Interview Coach web app in the default browser
  const appUrl = 'https://interviewcoach-production.up.railway.app';
  shell.openExternal(appUrl);

  // Auto-start audio capture so the user is ready to practice
  try {
    await ipcRenderer.invoke('start-capture', { prospectName: '', prospectCompany: '' });
  } catch (e) {
    console.warn('[Practice] Audio capture start failed:', e.message);
  }

  // Move Electron to main view (tray/capture controls)
  showMainView(_userProfile);
}

async function onSkipToMain() {
  await ipcRenderer.invoke('mark-onboarded');
  showMainView(_userProfile);
  shell.openExternal('https://interviewcoach-production.up.railway.app');
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
  // The main process will send either 'auth-result', 'show-login', or handle
  // a deep link. If nothing arrives within 5s, fall back to login.
  if (!_currentView) {
    switchView('loading');
    setTimeout(() => {
      if (_currentView === 'view-loading') {
        // Main process didn't respond — show login as safe default
        switchView('login');
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
    container.appendChild(el);
  } else {
    // Update or create interim element per speaker
    if (isCandidate) {
      if (!interimElMic) {
        interimElMic = document.createElement('div');
        interimElMic.className = cls + ' interim';
        container.appendChild(interimElMic);
      }
      interimElMic.textContent = prefix + text;
    } else {
      if (!interimElSystem) {
        interimElSystem = document.createElement('div');
        interimElSystem.className = cls + ' interim';
        container.appendChild(interimElSystem);
      }
      interimElSystem.textContent = prefix + text;
    }
  }

  // Auto-scroll to bottom
  const panel = document.getElementById('transcripts');
  panel.scrollTop = panel.scrollHeight;
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

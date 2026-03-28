// renderer.js
// UI logic — drives the Swift audio capture binary via Electron IPC.
// NO getUserMedia, NO AudioContext, NO WebSocket here.
// All audio happens in the Swift process.

const { ipcRenderer } = require('electron');

let isCapturing = false;
let startTime   = null;
let timerHandle = null;

// Show app version
try {
  const pkg = require('./package.json');
  const el = document.getElementById('app-version');
  if (el) el.textContent = 'v' + pkg.version;
} catch (e) {}

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

// ── Meeting Detection Events from Main Process ────────────────────────────────

// Main detected meeting + auto-start is ON → start immediately
ipcRenderer.on('meeting-auto-start', async () => {
  console.log('[Renderer] Auto-starting capture from meeting detection');
  showMeetingBanner('auto');
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

ipcRenderer.on('update-status', (event, msg) => {
  const el = document.getElementById('update-status');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
});

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

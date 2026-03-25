const { app, BrowserWindow, systemPreferences, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');

let mainWindow;
let audioProcess = null;

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
    mainWindow.webContents.send('update-status', 'Update v' + info.version + ' ready — will install on restart');
  }
  // Auto-install on quit (already set via autoInstallOnAppQuit)
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

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420, height: 600, resizable: true,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
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

  // Silent background update check on launch (non-blocking)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.log('[Updater] Background check failed (non-fatal):', err.message);
    });
  }, 5000);
});

app.on('window-all-closed', () => { stopAudioProcess(); app.quit(); });

ipcMain.handle('start-capture', async (event, { serverUrl, prospectName, prospectCompany }) => {
  if (audioProcess) return { error: 'Already running' };
  console.log('[Main] Spawning:', BINARY_PATH);

  const DG_KEY = '54d546fe79b59f0f372e78e6cc3e77673649b611';
  audioProcess = spawn(BINARY_PATH, [serverUrl, DG_KEY, prospectName || '', prospectCompany || ''], {
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
    mainWindow?.webContents.send('audio-stopped', { code, signal });
  });

  audioProcess.on('error', (err) => {
    console.error('[Main] Spawn error:', err.message);
    audioProcess = null;
    mainWindow?.webContents.send('audio-stopped', { code: -1 });
  });

  return await new Promise((resolve) => {
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
});

ipcMain.handle('stop-capture', async () => { stopAudioProcess(); return { ok: true }; });
ipcMain.handle('check-binary', async () => {
  const fs = require('fs');
  return { exists: fs.existsSync(BINARY_PATH), path: BINARY_PATH };
});

function stopAudioProcess() {
  if (audioProcess) {
    try { audioProcess.stdin.write('STOP\n'); } catch (e) {}
    setTimeout(() => { if (audioProcess) { audioProcess.kill('SIGTERM'); audioProcess = null; } }, 1000);
  }
}

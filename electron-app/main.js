'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { spawn, execSync } = require('child_process');

const PROJECT_DIR = 'C:\\Users\\HP OMEN\\Desktop\\mass-email-sender';
const APP_PORT    = 3003;

// ── Allowed editable files ──────────────────────────────────────────────────
const EDITABLE = {
  emails:   path.join(PROJECT_DIR, 'emails.txt'),
  body:     path.join(PROJECT_DIR, 'email_body.html'),
  cert:     path.join(PROJECT_DIR, 'cert.b64'),
};

let mainWindow = null;
let senderProc = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1200,
    height: 820,
    title:  'MASS_SENDER',
    icon:   path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload:           path.join(__dirname, 'preload.js'),
      contextIsolation:  true,
      nodeIntegration:   false,
      sandbox:           false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (senderProc) senderProc.kill();
  app.quit();
});

// ── IPC: read file ───────────────────────────────────────────────────────────
ipcMain.handle('read-file', (_e, key) => {
  const filePath = EDITABLE[key];
  if (!filePath) return { ok: false, error: 'Unknown file key' };
  try {
    const content = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8')
      : '';
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: write file ──────────────────────────────────────────────────────────
ipcMain.handle('write-file', (_e, key, content) => {
  const filePath = EDITABLE[key];
  if (!filePath) return { ok: false, error: 'Unknown file key' };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: start sender ────────────────────────────────────────────────────────
ipcMain.handle('start-sender', (_e) => {
  if (senderProc) return { ok: false, error: 'Already running' };
  try {
    senderProc = spawn('node', ['send_mass.js'], {
      cwd:   PROJECT_DIR,
      shell: true,
      env:   { ...process.env },
    });
    senderProc.stdout.on('data', (d) => {
      if (mainWindow) mainWindow.webContents.send('log', d.toString());
    });
    senderProc.stderr.on('data', (d) => {
      if (mainWindow) mainWindow.webContents.send('log', '[ERR] ' + d.toString());
    });
    senderProc.on('exit', (code) => {
      senderProc = null;
      if (mainWindow) mainWindow.webContents.send('sender-stopped', code);
    });
    return { ok: true };
  } catch (err) {
    senderProc = null;
    return { ok: false, error: err.message };
  }
});

// ── IPC: stop sender ─────────────────────────────────────────────────────────
ipcMain.handle('stop-sender', (_e) => {
  if (!senderProc) return { ok: false, error: 'Not running' };
  try {
    // Kill process tree on Windows
    execSync('taskkill /PID ' + senderProc.pid + ' /T /F', { stdio: 'ignore' });
    senderProc = null;
    return { ok: true };
  } catch (err) {
    senderProc = null;
    return { ok: false, error: err.message };
  }
});

// ── IPC: get running state ────────────────────────────────────────────────────
ipcMain.handle('is-running', () => ({ running: senderProc !== null }));

// ── IPC: read report ──────────────────────────────────────────────────────────
ipcMain.handle('read-report', () => {
  const reportPath = path.join(PROJECT_DIR, 'report.json');
  try {
    const content = fs.existsSync(reportPath)
      ? fs.readFileSync(reportPath, 'utf8')
      : '{}';
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: open dashboard in default browser ────────────────────────────────────
ipcMain.handle('open-dashboard', () => {
  const { shell } = require('electron');
  shell.openExternal('http://localhost:3003/dashboard');
  return { ok: true };
});

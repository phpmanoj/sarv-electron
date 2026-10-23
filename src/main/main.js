'use strict';
const path = require('path');
const { app, BrowserWindow, Menu, shell } = require('electron');
const registerIpc = require('./ipc');

// Packaged builds get icon.png copied into Contents/Resources (extraResources).
const ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '..', '..', 'build', 'icon.png');

let win = null;
let ipc = null;

const isDev = process.argv.includes('--dev');

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'Sarv Electron',
    icon: ICON,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

function send(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', action);
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
        label: app.name,
        submenu: [
          { label: 'Settings...', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
      : []),
    {
      label: '&File',
      submenu: [
        { label: 'Site Manager...', accelerator: 'CmdOrCtrl+S', click: () => send('site-manager') },
        { type: 'separator' },
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { label: 'Copy current connection to Site Manager...', click: () => send('copy-connection') },
        { type: 'separator' },
        { label: 'Show files currently being edited...', accelerator: 'CmdOrCtrl+E', click: () => send('being-edited') },
        { type: 'separator' },
        { label: 'Disconnect', accelerator: 'CmdOrCtrl+D', click: () => send('disconnect') },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Settings...', click: () => send('settings') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Refresh', accelerator: 'F5', click: () => send('refresh') },
        { type: 'separator' },
        { label: 'Directory comparison', accelerator: 'CmdOrCtrl+O', click: () => send('toggle-compare') },
        { label: 'Synchronized browsing', accelerator: 'CmdOrCtrl+Y', click: () => send('toggle-sync') },
        { type: 'separator' },
        { label: 'Show hidden files', click: () => send('toggle-hidden') },
        { label: 'Swap local and remote panes', click: () => send('swap-panes') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Transfer',
      submenu: [
        { label: 'Process queue', click: () => send('process-queue') },
        { label: 'Cancel queued transfers', click: () => send('cancel-queue') },
        { label: 'Clear finished transfers', click: () => send('clear-queue') },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Reverse-engineered spec', click: () => send('show-spec') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('Sarv Electron');

app.whenReady().then(() => {
  // Dock icon for `npm start`; a packaged build uses build/icon.icns.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(ICON); } catch (err) { /* icon is optional */ }
  }
  ipc = registerIpc(() => win);
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!ipc) return;
  const pending = ipc;
  ipc = null;
  event.preventDefault();
  await pending.shutdown();
  app.quit();
});

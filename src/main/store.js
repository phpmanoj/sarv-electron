'use strict';
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * Persistence for saved sites and settings.
 * Files live in the Electron userData folder. Passwords/passphrases are
 * encrypted with the OS keychain (safeStorage) when it is available.
 */

const DEFAULT_SETTINGS = {
  /* ---- editor (FileZilla: "Default editor", "Filetype associations") ---- */
  // 'app'     -> open -a "<editorApp>" <file>   (most reliable on macOS)
  // 'command' -> <editorCommand> <file>         (e.g. "code", "subl -w")
  // 'system'  -> OS default application
  editorMode: 'app',
  editorApp: 'Visual Studio Code',
  editorCommand: 'code',
  // "&Always use default editor" - ignore per-extension associations
  alwaysUseDefaultEditor: false,
  // "U&se filetype associations if available"
  useFiletypeAssociations: true,
  // [{ ext: 'php', mode: 'app', value: 'PhpStorm' }]
  associations: [],
  // "&Watch locally edited files and prompt to upload modifications"
  watchEditedFiles: true,
  // 'auto' uploads silently on save, 'prompt' asks first
  uploadOnSave: 'auto',
  // Where edit sessions download to (empty -> OS temp dir)
  editTempDir: '',

  /* ---- appearance ---- */
  // 'system' follows macOS; anything else is a data-theme in styles.css
  theme: 'system',
  themeDark: false,
  // User-made themes: [{ id, label, dark, colors: { bg, panel, border, text, muted, accent } }]
  customThemes: [],
  // Background image: '' = off. bgFit: cover | contain | tile | center
  bgImage: '',
  bgFit: 'cover',
  // how opaque the panels sit on top of the image (50-100 %)
  bgVeil: 86,
  // how much the image is dimmed towards the theme background (0-80 %)
  bgDim: 25,

  /* ---- panes ---- */
  showHiddenLocal: true,
  showHiddenRemote: true,
  swapPanes: false,
  showTimestamps: true,
  defaultLocalPath: '',

  /* ---- concurrency (FileZilla: "Concurrent transfers") ---- */
  // "Maximum simultaneous transfers" - 1..10
  maxTransfers: 2,
  // "Limit for concurrent downloads/uploads" - 0 means no separate limit
  maxDownloads: 0,
  maxUploads: 0,
  // seconds; 0 keeps the library default
  connectTimeout: 20,

  /* ---- speed limits (FileZilla: "Speed limits") ---- */
  // "&Enable speed limits" - the master toggle shown in the status bar
  speedLimitEnabled: false,
  // kilobytes per second; 0 means no limit for that direction
  speedLimitDown: 0,
  speedLimitUp: 0,

  /* ---- transfer mode (FileZilla: "&Transfer mode:") ---- */
  // 'auto' decides per extension, 'ascii' and 'binary' force one
  transferMode: 'auto',
  // "Allow &fall back to other transfer mode on failure"
  transferModeFallback: true,
  // empty uses DEFAULT_ASCII_EXTENSIONS from transfer-stream.js
  asciiExtensions: [],

  /* ---- transfers ("Default file exists action") ---- */
  // 'overwrite' | 'overwrite-different-size' | 'overwrite-size-or-newer' | 'rename' | 'skip'
  transferExisting: 'overwrite',
  confirmDelete: true,
  autoRemoveSuccessful: false,

  /* ---- directory comparison / synchronized browsing ---- */
  compareBySize: true,
  compareByTime: false,
  compareThreshold: 0,
  hideIdentical: false,
  syncBrowsing: false,
};

let dir = null;

function baseDir() {
  if (!dir) {
    dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function filePath(name) {
  return path.join(baseDir(), name);
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    const data = JSON.parse(raw);
    return data == null ? fallback : data;
  } catch (err) {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf8');
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (err) {
    return false;
  }
}

function encrypt(plain) {
  if (!plain) return '';
  if (!canEncrypt()) return 'plain:' + Buffer.from(String(plain), 'utf8').toString('base64');
  return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
}

function decrypt(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    }
    return stored;
  } catch (err) {
    return '';
  }
}

/* ---------------------------------------------------------------- settings */

function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, readJson('settings.json', {}));
}

function setSettings(patch) {
  const next = Object.assign(getSettings(), patch || {});
  writeJson('settings.json', next);
  return next;
}

/* ------------------------------------------------------------------- sites */

function rawSites() {
  const list = readJson('sites.json', []);
  return Array.isArray(list) ? list : [];
}

// Sites handed to the renderer never carry the secrets.
function publicSite(site) {
  return {
    id: site.id,
    name: site.name,
    protocol: site.protocol,
    host: site.host,
    port: site.port,
    user: site.user,
    authType: site.authType,
    keyPath: site.keyPath || '',
    remotePath: site.remotePath || '',
    localPath: site.localPath || '',
    folder: site.folder || '',
    comments: site.comments || '',
    syncBrowsing: Boolean(site.syncBrowsing),
    hasPassword: Boolean(site.password),
    hasPassphrase: Boolean(site.passphrase),
  };
}

function listSites() {
  return rawSites().map(publicSite);
}

function newId() {
  return 'site_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function buildRecord(site, existing) {
  const id = site.id || newId();
  const prev = existing || {};
  // undefined means "leave what is stored"; an empty string means "clear it".
  const pick = (value, fallback) => {
    if (value !== undefined && value !== null) return value;
    if (prev[fallback.key] !== undefined && prev[fallback.key] !== null) return prev[fallback.key];
    return fallback.dflt;
  };
  const protocol = pick(site.protocol, { key: 'protocol', dflt: 'sftp' });
  const record = {
    id,
    name: pick(site.name, { key: 'name', dflt: '' }) || site.host || prev.host || 'New site',
    protocol,
    host: pick(site.host, { key: 'host', dflt: '' }),
    port: Number(site.port) || Number(prev.port) || (protocol === 'sftp' ? 22 : 21),
    user: pick(site.user, { key: 'user', dflt: '' }),
    authType: pick(site.authType, { key: 'authType', dflt: 'password' }),
    keyPath: pick(site.keyPath, { key: 'keyPath', dflt: '' }),
    remotePath: pick(site.remotePath, { key: 'remotePath', dflt: '' }),
    localPath: pick(site.localPath, { key: 'localPath', dflt: '' }),
    folder: pick(site.folder, { key: 'folder', dflt: '' }),
    comments: pick(site.comments, { key: 'comments', dflt: '' }),
    syncBrowsing: Boolean(pick(site.syncBrowsing, { key: 'syncBrowsing', dflt: false })),
    password: prev.password || '',
    passphrase: prev.passphrase || '',
  };
  // Only overwrite a stored secret when a new value was actually typed.
  if (site.password !== undefined && site.password !== null && site.password !== '') {
    record.password = encrypt(site.password);
  } else if (site.clearPassword) {
    record.password = '';
  }
  if (site.passphrase !== undefined && site.passphrase !== null && site.passphrase !== '') {
    record.passphrase = encrypt(site.passphrase);
  } else if (site.clearPassphrase) {
    record.passphrase = '';
  }

  return record;
}

function saveSite(site) {
  const sites = rawSites();
  const existing = site.id ? sites.find((s) => s.id === site.id) : null;
  const record = buildRecord(site, existing);
  if (existing) {
    sites[sites.indexOf(existing)] = record;
  } else {
    sites.push(record);
  }
  writeJson('sites.json', sites);
  return publicSite(record);
}

/**
 * Add or update many sites at once (used by the FileZilla import).
 * A site is considered the same one when host, port, user and name all match.
 */
function importSites(incoming, options) {
  const opts = options || {};
  const sites = rawSites();
  const keyOf = (s) => [s.host, s.port, s.user, s.name].join('\u0000').toLowerCase();
  const index = new Map(sites.map((s) => [keyOf(s), s]));

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const raw of incoming) {
    const site = Object.assign({}, raw);
    site.port = Number(site.port) || (site.protocol === 'sftp' ? 22 : 21);
    const existing = index.get(keyOf(site));

    if (!existing) {
      site.id = newId();
      const record = buildRecord(site, null);
      sites.push(record);
      index.set(keyOf(record), record);
      added += 1;
      continue;
    }

    if (opts.skipExisting) { unchanged += 1; continue; }
    const record = buildRecord(Object.assign({}, site, { id: existing.id }), existing);
    sites[sites.indexOf(existing)] = record;
    index.set(keyOf(record), record);
    updated += 1;
  }

  writeJson('sites.json', sites);
  return { added, updated, unchanged, total: sites.length };
}

/* ----------------------------------------------------------------- folders

   Sites carry their folder as a path string ("Prod" or "Prod/EU"), exactly
   like FileZilla. Empty folders are remembered separately so a folder you
   just created does not disappear before you put a site in it.            */

function storedFolders() {
  const list = readJson('folders.json', []);
  return Array.isArray(list) ? list.filter((f) => typeof f === 'string' && f) : [];
}

function writeFolders(list) {
  writeJson('folders.json', Array.from(new Set(list)).filter(Boolean).sort());
}

/** Every folder that exists, whether it holds sites or not, parents included. */
function listFolders() {
  const all = new Set(storedFolders());
  for (const site of rawSites()) {
    if (site.folder) all.add(site.folder);
  }
  // a nested folder implies its parents
  for (const folder of Array.from(all)) {
    const parts = folder.split('/');
    for (let i = 1; i < parts.length; i += 1) all.add(parts.slice(0, i).join('/'));
  }
  return Array.from(all).sort();
}

function addFolder(name) {
  const clean = String(name || '').trim().replace(/^\/+|\/+$/g, '');
  if (!clean) throw new Error('Folder name cannot be empty');
  if (listFolders().includes(clean)) throw new Error('A folder with that name already exists');
  writeFolders(storedFolders().concat([clean]));
  return listFolders();
}

function renameFolder(from, to) {
  const oldPath = String(from || '').trim();
  const newPath = String(to || '').trim().replace(/^\/+|\/+$/g, '');
  if (!oldPath || !newPath) throw new Error('Folder name cannot be empty');
  if (oldPath === newPath) return listFolders();
  if (listFolders().includes(newPath)) throw new Error('A folder with that name already exists');

  const move = (value) => {
    if (value === oldPath) return newPath;
    if (value.startsWith(oldPath + '/')) return newPath + value.slice(oldPath.length);
    return value;
  };

  const sites = rawSites();
  let touched = 0;
  for (const site of sites) {
    if (!site.folder) continue;
    const next = move(site.folder);
    if (next !== site.folder) { site.folder = next; touched += 1; }
  }
  if (touched) writeJson('sites.json', sites);
  writeFolders(storedFolders().map(move));
  return listFolders();
}

/** Delete a folder. Its sites move to the top level; nothing is lost. */
function removeFolder(name) {
  const target = String(name || '').trim();
  if (!target) return listFolders();
  const sites = rawSites();
  let touched = 0;
  for (const site of sites) {
    if (site.folder === target || (site.folder || '').startsWith(target + '/')) {
      site.folder = '';
      touched += 1;
    }
  }
  if (touched) writeJson('sites.json', sites);
  writeFolders(storedFolders().filter((f) => f !== target && !f.startsWith(target + '/')));
  return { folders: listFolders(), movedToTop: touched };
}

/** Drag-and-drop a site into a folder (empty string = top level). */
function setSiteFolder(id, folder) {
  const sites = rawSites();
  const site = sites.find((s) => s.id === id);
  if (!site) throw new Error('Site not found');
  site.folder = String(folder || '').trim();
  writeJson('sites.json', sites);
  return publicSite(site);
}

function removeSite(id) {
  const sites = rawSites().filter((s) => s.id !== id);
  writeJson('sites.json', sites);
  return true;
}

// Full credentials - main process only, never sent to the renderer.
function getSiteSecrets(id) {
  const site = rawSites().find((s) => s.id === id);
  if (!site) return null;
  return Object.assign({}, site, {
    password: decrypt(site.password),
    passphrase: decrypt(site.passphrase),
  });
}

/* --------------------------------------------------------------- last used */

function getLastSession() {
  return readJson('last-session.json', {});
}

function setLastSession(data) {
  writeJson('last-session.json', data || {});
}

module.exports = {
  DEFAULT_SETTINGS,
  listFolders,
  addFolder,
  renameFolder,
  removeFolder,
  setSiteFolder,
  importSites,
  allSitesWithSecrets: () => rawSites().map((s) => Object.assign({}, s, {
    password: decrypt(s.password),
    passphrase: decrypt(s.passphrase),
  })),
  getSettings,
  setSettings,
  listSites,
  saveSite,
  removeSite,
  getSiteSecrets,
  getLastSession,
  setLastSession,
  encryptionAvailable: canEncrypt,
};

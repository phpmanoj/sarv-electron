'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const rpath = require('path').posix;
const { ipcMain, dialog, clipboard, shell, nativeTheme, app } = require('electron');

const store = require('./store');
const localfs = require('./localfs');
const filezilla = require('./filezilla');
const SessionManager = require('./session-manager');
const { detectEditors } = require('./editor');

/**
 * Every renderer call lands here. Handlers always resolve with
 * { ok: true, data } or { ok: false, error } so the UI never sees a rejection.
 *
 * Anything that talks to a server takes a `sessionId` (a tab). Leaving it out
 * uses the active tab.
 */
function register(getWindow) {
  const emit = (msg) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('app:event', msg);
  };

  // Keep the native chrome (title bar, menus, dialogs) in step with the theme.
  const applyNativeTheme = (settings) => {
    try {
      if (settings.theme === 'system') nativeTheme.themeSource = 'system';
      else nativeTheme.themeSource = settings.themeDark ? 'dark' : 'light';
    } catch (err) {
      /* themeSource is best-effort */
    }
  };
  applyNativeTheme(store.getSettings());

  const manager = new SessionManager(emit, () => store.getSettings());
  manager.ensureDefault();

  const pick = (payload) => manager.get(payload.sessionId);
  const sessionOf = (payload) => pick(payload).session;
  const editsOf = (payload) => pick(payload).edits;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, data: await fn(payload || {}) };
      } catch (err) {
        return {
          ok: false,
          error: err && err.message ? err.message : String(err),
          code: (err && err.code) || '',
          localPath: (err && err.localPath) || '',
        };
      }
    });
  };

  /* ------------------------------------------------------------- settings */

  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => {
    const next = store.setSettings(patch);
    manager.applySettings(next);
    applyNativeTheme(next);
    emit({ type: 'settings', settings: next });
    return next;
  });
  handle('settings:editors', () => detectEditors());
  handle('settings:encryption', () => store.encryptionAvailable());

  /* ----------------------------------------------------------------- tabs */

  handle('tabs:list', () => manager.list());
  handle('tabs:create', () => {
    const id = manager.create();
    return { id, tabs: manager.list() };
  });
  handle('tabs:activate', ({ sessionId }) => manager.activate(sessionId));
  handle('tabs:close', ({ sessionId, force }) => manager.close(sessionId, force));
  handle('tabs:busy', ({ sessionId }) => manager.busy(sessionId));

  /* ---------------------------------------------------------------- sites */

  handle('sites:list', () => store.listSites());
  handle('sites:save', (site) => store.saveSite(site));
  handle('sites:remove', ({ id }) => store.removeSite(id));
  handle('sites:folders', () => store.listFolders());
  handle('sites:addFolder', ({ name }) => store.addFolder(name));
  handle('sites:renameFolder', ({ from, to }) => store.renameFolder(from, to));
  handle('sites:removeFolder', ({ name }) => store.removeFolder(name));
  handle('sites:setFolder', ({ id, folder }) => store.setSiteFolder(id, folder));

  /* ------------------------------------------- FileZilla import / export */

  handle('fz:detect', () => {
    const found = filezilla.detect();
    if (!found) return { found: false, candidates: filezilla.configCandidates() };
    const parsed = filezilla.readSites(found.path);
    return {
      found: true,
      path: found.path,
      version: parsed.version,
      count: parsed.sites.length,
      folders: Array.from(new Set(parsed.sites.map((s) => s.folder).filter(Boolean))).sort(),
      withRemotePath: parsed.sites.filter((s) => s.remotePath).length,
      withPassword: parsed.sites.filter((s) => s.password).length,
      skipped: parsed.skipped,
    };
  });

  handle('fz:pickFile', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Import FileZilla sites',
      properties: ['openFile'],
      filters: [{ name: 'FileZilla site manager', extensions: ['xml'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('fz:import', ({ path: filePath, skipExisting, withPasswords }) => {
    const target = filePath || (filezilla.detect() || {}).path;
    if (!target) throw new Error('No FileZilla sitemanager.xml found');
    const parsed = filezilla.readSites(target);
    const sites = parsed.sites.map((site) => (
      withPasswords === false ? Object.assign({}, site, { password: '' }) : site
    ));
    const result = store.importSites(sites, { skipExisting: Boolean(skipExisting) });
    emit({ type: 'log', level: 'ok', time: Date.now(),
      message: `Imported ${result.added} new and updated ${result.updated} site(s) from ${target}` });
    if (parsed.skipped.length) {
      emit({ type: 'log', level: 'warn', time: Date.now(),
        message: `${parsed.skipped.length} entr(y/ies) skipped: `
          + parsed.skipped.slice(0, 5).map((s) => `${s.name} (${s.reason})`).join('; ') });
    }
    return Object.assign({}, result, { source: target, skipped: parsed.skipped });
  });

  handle('fz:export', async ({ withPasswords }) => {
    const res = await dialog.showSaveDialog(getWindow(), {
      title: 'Export Site Manager entries',
      defaultPath: 'sitemanager.xml',
      filters: [{ name: 'FileZilla site manager', extensions: ['xml'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const sites = store.allSitesWithSecrets();
    const xml = filezilla.writeSites(sites, { includePasswords: withPasswords !== false });
    fs.writeFileSync(res.filePath, xml, 'utf8');
    emit({ type: 'log', level: 'ok', time: Date.now(),
      message: `Exported ${sites.length} site(s) to ${res.filePath}`
        + (withPasswords === false ? ' (without passwords)' : '') });
    return { path: res.filePath, count: sites.length, withPasswords: withPasswords !== false };
  });

  /* ----------------------------------------------------------- connection */

  handle('conn:connect', async (payload) => {
    const entry = pick(payload);
    let config = payload;
    if (payload.siteId) {
      const secrets = store.getSiteSecrets(payload.siteId);
      if (!secrets) throw new Error('Site not found');
      config = secrets;
    }
    const settings = store.getSettings();
    const status = await entry.session.connect(Object.assign({}, config, {
      connectTimeout: settings.connectTimeout,
    }));
    store.setLastSession({ siteId: payload.siteId || null, host: config.host, user: config.user });
    manager.announce();
    return status;
  });

  handle('conn:disconnect', async (payload) => {
    const status = await sessionOf(payload).disconnect();
    manager.announce();
    return status;
  });
  handle('conn:status', (payload) => sessionOf(payload).status());

  /* ---------------------------------------------------------------- local */

  handle('local:home', () => {
    const settings = store.getSettings();
    return settings.defaultLocalPath && fs.existsSync(settings.defaultLocalPath)
      ? settings.defaultLocalPath
      : localfs.home();
  });
  handle('local:list', ({ path: p }) => localfs.list(p));
  handle('local:mkdir', ({ path: p, name }) => localfs.mkdir(p, name));
  handle('local:createFile', async ({ path: p, name }) => {
    const full = path.join(p, name);
    if (fs.existsSync(full)) throw new Error('A file with that name already exists');
    await fsp.writeFile(full, '');
    return full;
  });
  handle('local:rename', ({ from, to }) => localfs.rename(from, to));
  handle('local:delete', ({ targets, useTrash }) => localfs.remove(targets, useTrash !== false));
  handle('local:reveal', ({ path: p }) => {
    localfs.reveal(p);
    return true;
  });
  handle('local:open', async ({ path: p }) => {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });
  handle('local:pickDir', async () => {
    const res = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('local:pickImage', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose a background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('local:pickFile', async () => {
    const res = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'] });
    return res.canceled ? null : res.filePaths[0];
  });

  /* --------------------------------------------------------------- remote */

  handle('remote:list', (payload) => sessionOf(payload).list(payload.path));
  handle('remote:mkdir', async (payload) => {
    const full = rpath.join(payload.path, payload.name);
    await sessionOf(payload).mkdir(full);
    return full;
  });
  handle('remote:createFile', async (payload) => {
    const session = sessionOf(payload);
    const full = rpath.join(payload.path, payload.name);
    const tmp = path.join(app.getPath('temp'), `sarv-electron-empty-${Date.now()}`);
    await fsp.writeFile(tmp, '');
    try {
      await session.transferNow('up', tmp, full, 0);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return full;
  });
  handle('remote:rename', (payload) => sessionOf(payload).rename(payload.from, payload.to));
  handle('remote:delete', (payload) => sessionOf(payload).remove(payload.entries));
  handle('remote:chmod', (payload) => sessionOf(payload).chmod(payload.path, payload.mode));

  /* ---------------------------------------------------------------- queue */

  handle('queue:download', (payload) => sessionOf(payload).enqueueDownload(payload.entries, payload.localDir));
  handle('queue:upload', (payload) => sessionOf(payload).enqueueUpload(payload.entries, payload.remoteDir));
  handle('queue:cancel', (payload) => {
    sessionOf(payload).cancel(payload.id);
    return true;
  });
  handle('queue:cancelAll', (payload) => {
    sessionOf(payload).cancelQueued();
    return true;
  });
  handle('queue:clear', (payload) => {
    sessionOf(payload).clearFinished();
    return true;
  });

  /* ------------------------------------------------------------ view/edit */

  handle('edit:open', (payload) => editsOf(payload).open(payload.remotePath, payload.size, {
    isDir: payload.isDir, force: payload.force, reopen: payload.reopen,
  }));
  handle('edit:list', (payload) => editsOf(payload).list());
  handle('edit:upload', (payload) => editsOf(payload).uploadNow(payload.localPath, payload.unedit));
  handle('edit:stop', (payload) => editsOf(payload).stop(payload.localPath, payload.deleteLocal));
  handle('edit:redownload', (payload) => editsOf(payload).redownload(payload.localPath));
  handle('edit:reopen', (payload) => editsOf(payload).reopen(payload.localPath));
  handle('edit:editedPaths', (payload) => editsOf(payload).editedRemotePaths());

  /* ----------------------------------------------------------------- misc */

  handle('misc:copy', ({ text }) => {
    clipboard.writeText(text || '');
    return true;
  });
  handle('misc:paths', () => ({ home: os.homedir(), temp: app.getPath('temp'), userData: app.getPath('userData') }));

  return {
    manager,
    shutdown: () => manager.shutdown(),
  };
}

module.exports = register;

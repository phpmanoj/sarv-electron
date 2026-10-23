'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const rpath = require('path').posix;
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { app, shell } = require('electron');

/**
 * "View/Edit" - the FileZilla behaviour, reproduced from the observed
 * feature surface (see docs/REVERSE-ENGINEERED-SPEC.md):
 *
 *   download to a temp file -> open it in the configured editor ->
 *   watch the temp file -> upload it back when the editor saves.
 *
 * Files stay "being edited" until the user unedits / finishes editing.
 */

const KNOWN_APPS = [
  'Visual Studio Code',
  'Cursor',
  'Windsurf',
  'Zed',
  'Sublime Text',
  'TextMate',
  'BBEdit',
  'Nova',
  'PhpStorm',
  'WebStorm',
  'IntelliJ IDEA',
  'PyCharm',
  'Atom',
  'Xcode',
  'TextEdit',
];

/** Editors actually installed on this machine, for the settings dropdown. */
function detectEditors() {
  const found = [];
  if (process.platform === 'darwin') {
    const roots = ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications'];
    for (const name of KNOWN_APPS) {
      for (const root of roots) {
        if (fs.existsSync(path.join(root, name + '.app'))) {
          found.push({ label: name, mode: 'app', value: name });
          break;
        }
      }
    }
  }
  return found;
}

function splitCommand(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function resolveBinary(bin) {
  if (bin.includes('/')) return bin;
  for (const dir of EXTRA_PATH) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  return bin;
}

/** 'dotfile' | 'extensionless' | the lowercase extension without the dot. */
function fileKind(name) {
  const base = rpath.basename(name);
  const dot = base.lastIndexOf('.');
  if (base.startsWith('.') && dot === 0) return 'dotfile';
  if (dot < 1 || dot === base.length - 1) return 'extensionless';
  return base.slice(dot + 1).toLowerCase();
}

function normaliseExt(ext) {
  return String(ext || '').trim().replace(/^\*?\./, '').toLowerCase();
}

/** Does the configured default editor have enough information to launch? */
function hasDefaultEditor(cfg) {
  if (cfg.mode === 'system') return true;
  if (cfg.mode === 'app') return Boolean(cfg.app);
  return Boolean(cfg.command);
}

/**
 * Pick the editor for one remote file.
 * Mirrors "Always use default editor" / "Use filetype associations if available".
 * Returns { mode, app, command, source } or throws the FileZilla-equivalent error.
 */
function resolveEditorConfig(remotePath, settings) {
  const def = {
    mode: settings.editorMode || 'app',
    app: settings.editorApp || '',
    command: settings.editorCommand || '',
    source: 'default editor',
  };
  const kind = fileKind(remotePath);

  if (!settings.alwaysUseDefaultEditor && settings.useFiletypeAssociations) {
    const list = Array.isArray(settings.associations) ? settings.associations : [];
    const hit = list.find((a) => normaliseExt(a.ext) === kind);
    if (hit) {
      const cfg = {
        mode: hit.mode || 'app',
        app: hit.mode === 'app' ? hit.value : '',
        command: hit.mode === 'command' ? hit.value : '',
        source: `association for "${normaliseExt(hit.ext)}"`,
      };
      if (!hasDefaultEditor(cfg)) throw new Error('Improperly configured association for ' + normaliseExt(hit.ext));
      return cfg;
    }
  }

  if (hasDefaultEditor(def)) return def;

  // Same wording FileZilla uses when nothing can open the file.
  if (kind === 'dotfile') throw new Error('No program has been associated to edit dotfiles.');
  if (kind === 'extensionless') throw new Error('No program has been associated to edit extensionless files.');
  throw new Error(`No program has been associated to edit files with the extension '${kind}'. A default editor needs to be set.`);
}

/** Launch one editor for a local file. */
function launchEditor(filePath, cfg) {
  return new Promise((resolve, reject) => {
    if (cfg.mode === 'system') {
      shell.openPath(filePath).then((err) => (err ? reject(new Error(err)) : resolve("system's default editor")));
      return;
    }

    if (cfg.mode === 'app' && process.platform === 'darwin') {
      const appName = cfg.app;
      execFile('/usr/bin/open', ['-a', appName, filePath], (err, _out, stderr) => {
        if (err) {
          reject(new Error(`The associated program (${appName}) could not be found: ${(stderr || err.message).trim()}`));
        } else {
          resolve(appName);
        }
      });
      return;
    }

    const parts = splitCommand(cfg.command || cfg.app);
    if (!parts.length) {
      reject(new Error('A default editor needs to be set.'));
      return;
    }
    const bin = resolveBinary(parts[0]);
    const args = parts.slice(1).concat([filePath]);
    try {
      const child = spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, {
          PATH: EXTRA_PATH.join(':') + ':' + (process.env.PATH || ''),
        }),
      });
      child.on('error', (err) => reject(new Error(`The associated program could not be found: ${bin} (${err.message})`)));
      child.unref();
      setTimeout(() => resolve(parts.join(' ')), 250);
    } catch (err) {
      reject(err);
    }
  });
}

class EditManager {
  constructor(session, emit, getSettings) {
    this.session = session;
    this.emit = emit;
    this.getSettings = getSettings;
    this.sessions = new Map(); // localPath -> record
  }

  log(level, message) {
    this.emit({ type: 'log', level, message, time: Date.now() });
  }

  tempRoot() {
    const custom = (this.getSettings().editTempDir || '').trim();
    const root = custom || path.join(app.getPath('temp'), 'sarv-electron-edits');
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  /** Stable temp location so re-opening the same remote file reuses one file. */
  localPathFor(remotePath) {
    const info = this.session.info || {};
    const tag = `${info.host || 'host'}_${info.user || 'user'}${rpath.dirname(remotePath)}`;
    const hash = crypto.createHash('sha1').update(tag).digest('hex').slice(0, 10);
    const dir = path.join(this.tempRoot(), `${(info.host || 'host').replace(/[^\w.-]/g, '_')}-${hash}`);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, rpath.basename(remotePath));
  }

  list() {
    return Array.from(this.sessions.values()).map((r) => ({
      localPath: r.localPath,
      remotePath: r.remotePath,
      name: rpath.basename(r.remotePath),
      host: r.host,
      editor: r.editor,
      uploads: r.uploads,
      lastUpload: r.lastUpload,
      status: r.status,
    }));
  }

  /** Remote paths currently being edited - the remote pane shows a badge for these. */
  editedRemotePaths() {
    return Array.from(this.sessions.values()).map((r) => r.remotePath);
  }

  /**
   * View/Edit a remote file: download, open in the resolved editor, watch.
   * `force` re-downloads a file that is already being edited.
   */
  async open(remotePath, size, opts) {
    const options = opts || {};
    const settings = this.getSettings();

    // Guards, same as FileZilla's.
    if (!this.session.isConnected()) throw new Error('Cannot edit file, not connected to any server.');
    if (options.isDir) throw new Error('Editing directories is not supported');

    const localPath = this.localPathFor(remotePath);
    const existing = this.sessions.get(localPath);
    if (existing && !options.force && !options.reopen) {
      const err = new Error('The selected file is already being edited: ' + remotePath);
      err.code = 'ALREADY_EDITING';
      err.localPath = localPath;
      throw err;
    }

    const cfg = resolveEditorConfig(remotePath, settings);

    // "Reopen local file" skips the download and just launches the editor again.
    if (!options.reopen || !fs.existsSync(localPath)) {
      this.log('info', `Opening ${remotePath} for editing...`);
      await this.session.transferNow('down', localPath, remotePath, size || 0);
    }

    const editor = await launchEditor(localPath, cfg);
    const stat = await fsp.stat(localPath);

    if (existing) {
      existing.mtime = stat.mtimeMs;
      existing.size = stat.size;
      existing.editor = editor;
      existing.status = 'watching';
      this.log('ok', `Re-opened in ${editor}: ${rpath.basename(remotePath)}`);
      this.emit({ type: 'edit', action: 'opened', localPath, remotePath, editor });
      this.emitSessions();
      return { localPath, editor, watching: Boolean(existing.watcherOn) };
    }

    const record = {
      localPath,
      remotePath,
      host: (this.session.info || {}).host || '',
      editor,
      mtime: stat.mtimeMs,
      size: stat.size,
      uploads: 0,
      lastUpload: 0,
      status: 'watching',
      busy: false,
      timer: null,
      watcherOn: false,
    };
    this.sessions.set(localPath, record);

    if (settings.watchEditedFiles) {
      fs.watchFile(localPath, { interval: 700 }, (curr) => {
        if (curr.mtimeMs === 0) return; // file removed
        if (curr.mtimeMs === record.mtime && curr.size === record.size) return;
        record.mtime = curr.mtimeMs;
        record.size = curr.size;
        // Editors can write in more than one step - debounce.
        clearTimeout(record.timer);
        record.timer = setTimeout(() => this.handleSave(record), 400);
      });
      record.watcherOn = true;
    } else {
      record.status = 'not watched';
    }

    this.log('ok', `Editing ${rpath.basename(remotePath)} in ${editor} (${cfg.source})`);
    this.emit({ type: 'edit', action: 'opened', localPath, remotePath, editor });
    this.emitSessions();
    return { localPath, editor, watching: record.watcherOn };
  }

  /** The editor saved the temp file. */
  async handleSave(record) {
    const settings = this.getSettings();

    if (settings.uploadOnSave === 'prompt') {
      record.status = 'changed';
      this.emitSessions();
      this.emit({
        type: 'edit-prompt',
        localPath: record.localPath,
        remotePath: record.remotePath,
        name: rpath.basename(record.remotePath),
      });
      return;
    }
    await this.upload(record);
  }

  async upload(record) {
    if (record.busy) return;
    if (!this.session.isConnected()) {
      record.status = 'offline';
      this.log('error', `Cannot upload ${rpath.basename(record.remotePath)}: not connected to any server.`);
      this.emitSessions();
      return;
    }

    record.busy = true;
    record.status = 'uploading';
    this.emitSessions();
    try {
      const st = await fsp.stat(record.localPath);
      record.size = st.size;
      record.mtime = st.mtimeMs;
      await this.session.transferNow('up', record.localPath, record.remotePath, st.size);
      record.uploads += 1;
      record.lastUpload = Date.now();
      record.status = 'watching';
      this.emit({ type: 'edit', action: 'saved', localPath: record.localPath, remotePath: record.remotePath });
      this.log('ok', `Uploaded changes: ${record.remotePath}`);
    } catch (err) {
      record.status = 'error';
      this.log('error', `Upload after save failed (${rpath.basename(record.remotePath)}): ${err.message}`);
    } finally {
      record.busy = false;
      this.emitSessions();
    }
  }

  /** "Upload and unedit" / explicit upload from the Being-edited dialog. */
  async uploadNow(localPath, alsoUnedit) {
    const record = this.sessions.get(localPath);
    if (!record) throw new Error('No files are currently being edited.');
    await this.upload(record);
    if (alsoUnedit && record.status === 'watching') this.stop(localPath, false);
    return true;
  }

  /** "Unedit" / "Finish editing" (+ optionally delete the local copy). */
  stop(localPath, deleteLocal) {
    const record = this.sessions.get(localPath);
    if (!record) return false;
    clearTimeout(record.timer);
    if (record.watcherOn) fs.unwatchFile(record.localPath);
    this.sessions.delete(localPath);
    if (deleteLocal) {
      try {
        fs.rmSync(record.localPath, { force: true });
      } catch (err) {
        this.log('warn', 'Could not delete local file: ' + err.message);
      }
    }
    this.log('info', `Finished editing ${rpath.basename(record.remotePath)}`);
    this.emit({ type: 'edit', action: 'closed', localPath });
    this.emitSessions();
    return true;
  }

  /** "Discard local file then download and edit file anew". */
  async redownload(localPath) {
    const record = this.sessions.get(localPath);
    if (!record) throw new Error('No files are currently being edited.');
    const { remotePath } = record;
    this.stop(localPath, true);
    return this.open(remotePath, 0, { force: true });
  }

  /** "Reopen local file" - launch the editor again without downloading. */
  async reopen(localPath) {
    const record = this.sessions.get(localPath);
    if (!record) throw new Error('No files are currently being edited.');
    return this.open(record.remotePath, 0, { reopen: true });
  }

  stopAll() {
    for (const key of Array.from(this.sessions.keys())) this.stop(key, false);
  }

  emitSessions() {
    this.emit({ type: 'edit-sessions', sessions: this.list() });
  }
}

module.exports = { EditManager, detectEditors, launchEditor, resolveEditorConfig, fileKind };

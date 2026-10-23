'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const nodePath = require('path');
const rpath = require('path').posix;

const SftpAdapter = require('./remote/sftp');
const FtpAdapter = require('./remote/ftp');
const localfs = require('./localfs');
const { isAsciiTransfer } = require('./transfer-stream');

let seq = 0;
const nextId = () => 'tx' + (seq += 1);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * One server connection, plus the transfer queue for it.
 *
 * Connections (mirrors what FileZilla does - see docs/REVERSE-ENGINEERED-SPEC.md):
 *   - one *control* connection used only for browsing and metadata, so the
 *     file lists stay responsive while files are moving;
 *   - up to "Maximum simultaneous transfers" *transfer* connections, opened
 *     lazily on first use and reused afterwards.
 *
 * Operations on the control connection are serialised: the underlying SFTP
 * client is not safe to drive from two places at once.
 */
class Session {
  constructor(emit, id) {
    this.id = id || 'main';
    this.emit = emit;
    this.control = null;
    this.workers = [];        // [{ adapter, index }] - one per transfer slot
    this.cfg = null;
    this.info = null;
    this.queue = [];
    this.running = false;
    this.settings = {};
    this._controlChain = Promise.resolve();
  }

  /* ------------------------------------------------------------- limits */

  concurrency() {
    return clamp(Number(this.settings.maxTransfers) || 2, 1, 10);
  }

  limitFor(direction) {
    const raw = direction === 'down' ? this.settings.maxDownloads : this.settings.maxUploads;
    const value = clamp(Number(raw) || 0, 0, 10);
    return value === 0 ? Infinity : value;   // 0 means "no separate limit"
  }

  /**
   * Throttle budget and ASCII decision for one item.
   *
   * A speed limit caps the session, not each transfer, so it is split across
   * the transfers already running in that direction: two concurrent downloads
   * under a 100 KB/s cap get 50 KB/s each. The item is already marked active
   * by the scheduler before this runs, so it counts itself.
   */
  transferOptions(item, forceBinary) {
    const settings = this.settings || {};
    const ascii = forceBinary
      ? false
      : isAsciiTransfer(item.name, settings.transferMode || 'auto', settings.asciiExtensions);

    let bytesPerSecond = 0;
    if (settings.speedLimitEnabled) {
      const kb = item.direction === 'down' ? settings.speedLimitDown : settings.speedLimitUp;
      const limit = Number(kb) > 0 ? Number(kb) * 1024 : 0;
      if (limit) {
        const sharing = this.queue.filter(
          (q) => q.status === 'active' && q.direction === item.direction,
        ).length || 1;
        // Never starve a transfer down to nothing when many share a small cap.
        bytesPerSecond = Math.max(1024, Math.floor(limit / sharing));
      }
    }

    return { ascii, bytesPerSecond };
  }

  /* ----------------------------------------------------------- plumbing */

  log(level, message) {
    this.emit({ type: 'log', level, message, time: Date.now() });
  }

  pushQueue() {
    this.emit({
      type: 'queue',
      items: this.queue.map((it) => ({
        id: it.id,
        direction: it.direction,
        name: it.name,
        localPath: it.localPath,
        remotePath: it.remotePath,
        size: it.size,
        transferred: it.transferred,
        status: it.status,
        error: it.error || '',
        connection: it.connection || 0,
      })),
    });
  }

  isConnected() {
    return Boolean(this.control && this.control.connected);
  }

  require() {
    if (!this.isConnected()) throw new Error('Not connected');
    return this.control;
  }

  /** Run one operation on the control connection, never two at once. */
  withControl(fn) {
    const result = this._controlChain.then(() => fn(this.require()));
    this._controlChain = result.then(() => {}, () => {});
    return result;
  }

  status() {
    return {
      connected: this.isConnected(),
      info: this.info,
      supportsChmod: this.control ? this.control.supportsChmod : false,
      connections: this.isConnected() ? 1 + this.workers.length : 0,
      maxTransfers: this.concurrency(),
    };
  }

  /* --------------------------------------------------------- connecting */

  createAdapter(protocol) {
    const onLog = (lvl, msg) => this.log(lvl, msg);
    if (protocol === 'sftp') return new SftpAdapter(onLog);
    return new FtpAdapter(onLog, protocol === 'ftps');
  }

  async openAdapter(label) {
    const protocol = (this.cfg && this.cfg.protocol) || 'sftp';
    const adapter = this.createAdapter(protocol);
    const res = await adapter.connect(this.cfg);
    return { adapter, res };
  }

  async connect(cfg) {
    await this.disconnect();
    this.cfg = cfg;
    const protocol = cfg.protocol || 'sftp';
    const port = Number(cfg.port) || (protocol === 'sftp' ? 22 : 21);

    this.log('info', `Connecting to ${cfg.user}@${cfg.host}:${port} (${protocol.toUpperCase()})`);
    const started = Date.now();
    try {
      const { adapter, res } = await this.openAdapter('control');
      this.control = adapter;
      const connectMs = Date.now() - started;
      const serverHome = res.home || '/';

      // A site can pin the directory to open on connect. If it is gone,
      // fall back to the server's own home instead of showing an error.
      let home = serverHome;
      if (cfg.remotePath) {
        const kind = await adapter.exists(cfg.remotePath).catch(() => false);
        if (kind === 'd' || kind === true) {
          home = cfg.remotePath;
        } else {
          this.log('warn', `Configured remote directory "${cfg.remotePath}" not found - opening ${serverHome} instead`);
        }
      }

      this.info = {
        protocol,
        host: cfg.host,
        port,
        user: cfg.user,
        home,
        serverHome,
        configuredPath: cfg.remotePath || '',
        localPath: cfg.localPath || '',
        syncBrowsing: Boolean(cfg.syncBrowsing),
        siteName: cfg.name || cfg.host,
        siteId: cfg.siteId || null,
      };

      const breakdown = adapter.describeTimings ? adapter.describeTimings() : '';
      this.log('ok', `Connected in ${connectMs} ms${breakdown ? ' (' + breakdown + ')' : ''}. Remote directory: ${home}`);
      this.emit({ type: 'connection', state: 'connected', status: this.status() });
      return this.status();
    } catch (err) {
      this.control = null;
      this.info = null;
      this.log('error', 'Connection failed: ' + err.message);
      this.emit({ type: 'connection', state: 'disconnected', status: this.status() });
      throw err;
    }
  }

  async disconnect() {
    const closing = this.workers.map((w) => w.adapter.disconnect().catch(() => {}));
    this.workers = [];
    if (this.control) {
      closing.push(this.control.disconnect().catch(() => {}));
    }
    await Promise.all(closing);
    if (this.control) this.log('info', 'Disconnected');
    this.control = null;
    this.info = null;
    this.emit({ type: 'connection', state: 'disconnected', status: this.status() });
    return this.status();
  }

  /** The connection a transfer slot uses; opened on first use, then reused. */
  async transferConnection(index) {
    const existing = this.workers.find((w) => w.index === index);
    if (existing && existing.adapter.connected) return existing.adapter;
    if (existing) this.workers = this.workers.filter((w) => w !== existing);

    const { adapter } = await this.openAdapter('transfer');
    this.workers.push({ adapter, index });
    const breakdown = adapter.describeTimings ? adapter.describeTimings() : '';
    this.log('info', `Opened transfer connection ${index + 1}${breakdown ? ' (' + breakdown + ')' : ''}`);
    this.emit({ type: 'connection', state: 'connected', status: this.status() });
    return adapter;
  }

  /* ------------------------------------------------------- remote access */

  list(remotePath) {
    return this.withControl(async (a) => {
      const started = Date.now();
      const result = await a.list(remotePath);
      const ms = Date.now() - started;
      if (ms > 1500) {
        this.log('warn', `Listing ${remotePath} took ${ms} ms (${result.items.length} entries` +
          (result.links ? `, ${result.links} symlinks resolved` : '') + ')');
      }
      return result;
    });
  }

  async mkdir(remotePath) {
    await this.withControl((a) => a.mkdir(remotePath));
    this.log('ok', 'Created directory ' + remotePath);
  }

  async rename(from, to) {
    await this.withControl((a) => a.rename(from, to));
    this.log('ok', `Renamed ${from} -> ${to}`);
  }

  async chmod(remotePath, mode) {
    await this.withControl((a) => a.chmod(remotePath, mode));
    this.log('ok', `chmod ${(mode & 0o777).toString(8)} ${remotePath}`);
  }

  async remove(entries) {
    for (const e of entries) {
      await this.withControl((a) => (e.isDir ? a.removeDir(e.path) : a.removeFile(e.path)));
      this.log('ok', 'Deleted ' + e.path);
    }
  }

  /* ------------------------------------------------------- queue building */

  /** Expand a remote directory into files plus the directories to create. */
  async walkRemote(root) {
    const out = [];
    const rec = async (dir, rel) => {
      const { items } = await this.list(dir);
      for (const it of items) {
        const full = rpath.join(dir, it.name);
        const r = rel ? rel + '/' + it.name : it.name;
        if (it.isDir) {
          out.push({ type: 'dir', rel: r });
          await rec(full, r);
        } else {
          out.push({ type: 'file', path: full, rel: r, size: it.size, mtime: it.mtime });
        }
      }
    };
    await rec(root, '');
    return out;
  }

  async enqueueDownload(entries, localDir) {
    this.require();
    for (const e of entries) {
      if (e.isDir) {
        const base = nodePath.join(localDir, e.name);
        await fsp.mkdir(base, { recursive: true });
        const tree = await this.walkRemote(e.remotePath);
        for (const node of tree) {
          const target = nodePath.join(base, ...node.rel.split('/'));
          if (node.type === 'dir') await fsp.mkdir(target, { recursive: true });
          else this.addItem('down', target, node.path, node.size, node.mtime);
        }
      } else {
        this.addItem('down', nodePath.join(localDir, e.name), e.remotePath, e.size || 0, e.mtime || 0);
      }
    }
    this.pushQueue();
    this.run();
  }

  async enqueueUpload(entries, remoteDir) {
    this.require();
    for (const e of entries) {
      if (e.isDir) {
        const base = rpath.join(remoteDir, e.name);
        await this.withControl((a) => a.mkdir(base));
        const tree = await localfs.walk(e.localPath);
        for (const node of tree) {
          const target = rpath.join(base, node.rel);
          if (node.type === 'dir') await this.withControl((a) => a.mkdir(target));
          else this.addItem('up', node.path, target, node.size);
        }
      } else {
        this.addItem('up', e.localPath, rpath.join(remoteDir, e.name), e.size || 0);
      }
    }
    this.pushQueue();
    this.run();
  }

  addItem(direction, localPath, remotePath, size, mtime) {
    this.queue.push({
      id: nextId(),
      direction,
      name: direction === 'down' ? rpath.basename(remotePath) : nodePath.basename(localPath),
      localPath,
      remotePath,
      size: size || 0,
      remoteMtime: mtime || 0,
      transferred: 0,
      status: 'queued',
      error: '',
      connection: 0,
      lastEmit: 0,
    });
  }

  /**
   * Run one transfer through the queue and resolve when it is done.
   * Used by the edit-in-editor flow.
   */
  transferNow(direction, localPath, remotePath, size) {
    this.require();
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: nextId(),
        direction,
        name: direction === 'down' ? rpath.basename(remotePath) : nodePath.basename(localPath),
        localPath,
        remotePath,
        size: size || 0,
        transferred: 0,
        status: 'queued',
        error: '',
        overwrite: true,
        connection: 0,
        lastEmit: 0,
        onDone: (err) => (err ? reject(err) : resolve()),
      });
      this.pushQueue();
      this.run();
    });
  }

  cancel(id) {
    const it = this.queue.find((q) => q.id === id);
    if (!it) return;
    if (it.status === 'queued') {
      it.status = 'cancelled';
      this.settle(it, new Error('cancelled'));
      this.pushQueue();
    } else if (it.status === 'active') {
      it.cancelRequested = true;
      this.log('warn', 'Cancel requested for ' + it.name + ' (finishes the current file)');
    }
  }

  cancelQueued() {
    for (const it of this.queue) {
      if (it.status === 'queued') {
        it.status = 'cancelled';
        this.settle(it, new Error('cancelled'));
      }
    }
    this.pushQueue();
  }

  clearFinished() {
    this.queue = this.queue.filter((it) => it.status === 'queued' || it.status === 'active');
    this.pushQueue();
  }

  settle(item, err) {
    if (!item.onDone) return;
    const cb = item.onDone;
    item.onDone = null;
    cb(err || null);
  }

  /* ---------------------------------------------------------- queue runner */

  /** Next queued item that does not break the per-direction limits. */
  takeNext() {
    const active = this.queue.filter((q) => q.status === 'active');
    const running = { down: 0, up: 0 };
    for (const it of active) running[it.direction] += 1;

    const item = this.queue.find((q) => q.status === 'queued'
      && running[q.direction] < this.limitFor(q.direction));
    if (!item) return null;
    item.status = 'active';
    item.transferred = 0;
    return item;
  }

  run() {
    if (this.running) return;
    this.running = true;
    const slots = this.concurrency();
    const workers = [];
    for (let i = 0; i < slots; i += 1) workers.push(this.worker(i));
    Promise.all(workers)
      .catch((err) => this.log('error', 'Queue: ' + err.message))
      .then(() => {
        this.running = false;
        // A per-direction limit can leave work behind when a slot frees up.
        if (this.queue.some((q) => q.status === 'queued') && this.isConnected()) this.run();
        else this.emit({ type: 'queue-idle' });
      });
  }

  async worker(index) {
    let adapter = null;
    for (;;) {
      const item = this.takeNext();
      if (!item) return;

      if (!this.isConnected()) {
        item.status = 'error';
        item.error = 'Not connected';
        this.settle(item, new Error('Not connected'));
        this.pushQueue();
        continue;
      }

      if (!adapter) {
        try {
          adapter = await this.transferConnection(index);
        } catch (err) {
          // The server may refuse extra sessions; this slot just stops.
          item.status = 'queued';
          this.log('warn', `Could not open transfer connection ${index + 1}: ${err.message}`);
          this.pushQueue();
          return;
        }
      }

      item.connection = index + 1;
      this.pushQueue();
      await this.runItem(item, adapter);
      this.pushQueue();
      if (item.cancelRequested) this.cancelQueued();
    }
  }

  async runItem(item, adapter) {
    const onProgress = (transferred, total) => {
      item.transferred = transferred;
      if (total && !item.size) item.size = total;
      const now = Date.now();
      if (now - item.lastEmit > 150) {
        item.lastEmit = now;
        this.emit({ type: 'progress', id: item.id, transferred, size: item.size });
      }
    };

    // "Allow fall back to other transfer mode on failure": one ASCII transfer
    // that fails is retried as binary before the item is reported as failed.
    const attempt = async (forceBinary) => {
      const opts = this.transferOptions(item, forceBinary);
      if (opts.ascii) this.log('info', `ASCII mode: ${item.name}`);
      if (item.direction === 'down') {
        await adapter.download(item.remotePath, item.localPath, onProgress, item.size, opts);
      } else {
        await adapter.upload(item.localPath, item.remotePath, onProgress, item.size, opts);
      }
      return opts.ascii;
    };

    try {
      if (item.direction === 'down') {
        await fsp.mkdir(nodePath.dirname(item.localPath), { recursive: true });
        const target = item.overwrite ? item.localPath : this.resolveLocalTarget(item);
        if (target === null) {
          item.status = 'skipped';
          this.log('warn', 'Skipped (exists): ' + item.localPath);
          this.settle(item, new Error('skipped'));
          return;
        }
        item.localPath = target;
      }

      try {
        await attempt(false);
      } catch (err) {
        const usedAscii = isAsciiTransfer(
          item.name, (this.settings || {}).transferMode || 'auto', (this.settings || {}).asciiExtensions,
        );
        if (!usedAscii || this.settings.transferModeFallback === false) throw err;
        this.log('warn', `ASCII transfer failed (${item.name}), retrying as binary: ${err.message}`);
        item.transferred = 0;
        await attempt(true);
      }

      if (item.direction === 'down') {
        this.log('ok', `Downloaded ${item.remotePath} -> ${item.localPath}`);
      } else {
        this.log('ok', `Uploaded ${item.localPath} -> ${item.remotePath}`);
      }
      item.transferred = item.size;
      item.status = 'done';
      this.settle(item, null);
    } catch (err) {
      item.status = 'error';
      item.error = err.message;
      this.log('error', `${item.direction === 'down' ? 'Download' : 'Upload'} failed (${item.name}): ${err.message}`);
      this.settle(item, err);
    }
  }

  /**
   * "Default file exists action" for downloads, matching the options observed
   * in FileZilla. Returns the path to write, or null to skip the file.
   */
  resolveLocalTarget(item) {
    const localPath = item.localPath;
    if (!fs.existsSync(localPath)) return localPath;

    const policy = this.settings.transferExisting || 'overwrite';
    if (policy === 'skip') return null;
    if (policy === 'rename') return localfs.uniquePath(localPath);

    let local;
    try {
      local = fs.statSync(localPath);
    } catch (err) {
      return localPath;
    }

    if (policy === 'overwrite-different-size') {
      return item.size && local.size === item.size ? null : localPath;
    }
    if (policy === 'overwrite-size-or-newer') {
      if (item.size && local.size !== item.size) return localPath;
      if (item.remoteMtime && item.remoteMtime > local.mtimeMs) return localPath;
      return null;
    }
    return localPath; // 'overwrite'
  }
}

module.exports = Session;

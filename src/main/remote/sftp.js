'use strict';
const fs = require('fs');
const path = require('path').posix;
const { pipeline } = require('stream/promises');
const Client = require('ssh2-sftp-client');
const { Throttle, AsciiLineEndings } = require('../transfer-stream');

/** Convert "rwxr-xr--" into 0o754. */
function permsToMode(perms) {
  if (!perms || perms.length < 9) return null;
  let mode = 0;
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  for (let i = 0; i < 9; i += 1) {
    if (perms[i] !== '-') mode |= bits[i];
  }
  return mode;
}

/**
 * SFTP (SSH) backend. Thin normalising layer over ssh2-sftp-client so the
 * renderer sees the same item shape for every protocol.
 */
class SftpAdapter {
  constructor(onLog) {
    this.onLog = onLog || (() => {});
    this.client = new Client('sarv-electron');
    this.connected = false;
  }

  async connect(cfg) {
    const opts = {
      host: cfg.host,
      port: Number(cfg.port) || 22,
      username: cfg.user,
      readyTimeout: Number(cfg.connectTimeout) > 0 ? Number(cfg.connectTimeout) * 1000 : 20000,
      keepaliveInterval: 10000,
    };

    if (cfg.authType === 'key') {
      if (!cfg.keyPath) throw new Error('Private key file not selected');
      opts.privateKey = fs.readFileSync(cfg.keyPath);
      if (cfg.passphrase) opts.passphrase = cfg.passphrase;
    } else if (cfg.authType === 'agent') {
      if (!process.env.SSH_AUTH_SOCK) throw new Error('SSH agent not found (SSH_AUTH_SOCK is unset)');
      opts.agent = process.env.SSH_AUTH_SOCK;
    } else {
      opts.password = cfg.password;
    }

    this.client.on('error', (err) => this.onLog('error', 'SFTP: ' + err.message));

    // Phase timings, so a slow connect can be blamed on the right step
    // (DNS/TCP, key exchange, authentication, SFTP subsystem, first realpath).
    const t0 = Date.now();
    const timings = {};
    this.client.on('handshake', () => { timings.handshake = Date.now() - t0; });
    this.client.on('ready', () => { timings.auth = Date.now() - t0; });

    await this.client.connect(opts);
    timings.sftp = Date.now() - t0;
    this.connected = true;

    const home = await this.client.cwd().catch(() => '/');
    timings.realpath = Date.now() - t0;
    timings.total = Date.now() - t0;
    this.timings = timings;

    return { home: home || '/', timings };
  }

  /** Human-readable breakdown for the message log. */
  describeTimings() {
    const t = this.timings;
    if (!t) return '';
    const parts = [];
    if (t.handshake !== undefined) parts.push(`tcp+kex ${t.handshake}ms`);
    if (t.auth !== undefined) parts.push(`auth +${t.auth - (t.handshake || 0)}ms`);
    if (t.sftp !== undefined) parts.push(`sftp +${t.sftp - (t.auth || t.handshake || 0)}ms`);
    if (t.realpath !== undefined) parts.push(`realpath +${t.realpath - t.sftp}ms`);
    return parts.join(', ');
  }

  async disconnect() {
    this.connected = false;
    try {
      await this.client.end();
    } catch (err) {
      /* already gone */
    }
  }

  async list(remotePath) {
    const target = remotePath || '/';
    const raw = await this.client.list(target);
    const items = raw
      .filter((it) => it.name !== '.' && it.name !== '..')
      .map((it) => {
        const perms = it.longname ? it.longname.slice(1, 10) : '';
        return {
          name: it.name,
          isDir: it.type === 'd',
          isLink: it.type === 'l',
          size: it.size,
          mtime: it.modifyTime,
          permissions: perms,
          mode: permsToMode(perms),
          owner: it.owner,
          group: it.group,
        };
      });

    // A symlink may point at a directory - resolve so navigation works.
    // One stat per link is a full round trip, so run a bounded number at once;
    // serially this is what made listing a link-heavy directory feel slow.
    const links = items.filter((it) => it.isLink);
    if (links.length) {
      const CONCURRENCY = 12;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= links.length) return;
          const it = links[index];
          try {
            const st = await this.client.stat(path.join(target, it.name));
            it.isDir = Boolean(st.isDirectory);
          } catch (err) {
            /* dangling link - leave it as a file */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, links.length) }, worker));
    }

    return {
      path: target,
      parent: target === '/' ? '/' : path.dirname(target),
      items,
      links: links.length,
    };
  }

  async download(remotePath, localPath, onProgress, expectedTotal, options) {
    const opts = options || {};
    const limit = Number(opts.bytesPerSecond) > 0 ? Number(opts.bytesPerSecond) : 0;

    // fastGet issues parallel reads and is markedly quicker, but it hands back
    // no stream to throttle or convert - so it stays the path for plain
    // binary transfers at full speed.
    if (!limit && !opts.ascii) {
      await this.client.fastGet(remotePath, localPath, {
        step: (transferred, _chunk, total) => onProgress && onProgress(transferred, total),
      });
      return;
    }

    const total = Number(expectedTotal) || 0;
    // Throttle first so progress counts bytes off the wire, then convert.
    const stages = [new Throttle(limit, (n) => onProgress && onProgress(n, total))];
    if (opts.ascii) stages.push(new AsciiLineEndings('to-local'));

    await pipeline(
      this.client.createReadStream(remotePath),
      ...stages,
      fs.createWriteStream(localPath),
    );
  }

  async upload(localPath, remotePath, onProgress, expectedTotal, options) {
    const opts = options || {};
    const limit = Number(opts.bytesPerSecond) > 0 ? Number(opts.bytesPerSecond) : 0;

    if (!limit && !opts.ascii) {
      await this.client.fastPut(localPath, remotePath, {
        step: (transferred, _chunk, total) => onProgress && onProgress(transferred, total),
      });
      return;
    }

    const total = Number(expectedTotal) || 0;
    // Convert first, then throttle, so the rate applies to what actually goes
    // out - an ASCII upload grows by one byte per line ending.
    const stages = [];
    if (opts.ascii) stages.push(new AsciiLineEndings('to-remote'));
    stages.push(new Throttle(limit, (n) => onProgress && onProgress(n, total)));

    await pipeline(
      fs.createReadStream(localPath),
      ...stages,
      this.client.createWriteStream(remotePath),
    );
  }

  async mkdir(remotePath) {
    await this.client.mkdir(remotePath, true);
  }

  async removeFile(remotePath) {
    await this.client.delete(remotePath, true);
  }

  async removeDir(remotePath) {
    await this.client.rmdir(remotePath, true);
  }

  async rename(from, to) {
    await this.client.rename(from, to);
  }

  async chmod(remotePath, mode) {
    await this.client.chmod(remotePath, mode);
  }

  async exists(remotePath) {
    return this.client.exists(remotePath);
  }

  async stat(remotePath) {
    const st = await this.client.stat(remotePath);
    return { isDir: Boolean(st.isDirectory), size: st.size, mtime: st.modifyTime, mode: st.mode & 0o777 };
  }

  get supportsChmod() {
    return true;
  }
}

module.exports = SftpAdapter;

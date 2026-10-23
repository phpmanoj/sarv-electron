'use strict';
const path = require('path').posix;
const ftp = require('basic-ftp');

function permsToString(p) {
  if (!p) return '';
  const R = ftp.FileInfo.UnixPermission.Read;
  const W = ftp.FileInfo.UnixPermission.Write;
  const X = ftp.FileInfo.UnixPermission.Execute;
  const trio = (v) => (v & R ? 'r' : '-') + (v & W ? 'w' : '-') + (v & X ? 'x' : '-');
  return trio(p.user) + trio(p.group) + trio(p.world);
}

function permsToMode(p) {
  if (!p) return null;
  return (p.user << 6) | (p.group << 3) | p.world;
}

/** FTP / FTPS backend, same shape as the SFTP adapter. */
class FtpAdapter {
  constructor(onLog, secure) {
    this.onLog = onLog || (() => {});
    this.secure = secure;
    this.client = new ftp.Client(30000);
    this.client.ftp.verbose = false;
    this.connected = false;
  }

  async connect(cfg) {
    const t0 = Date.now();
    await this.client.access({
      host: cfg.host,
      port: Number(cfg.port) || 21,
      user: cfg.user || 'anonymous',
      password: cfg.password || '',
      secure: this.secure ? true : false,
      // Many self-hosted servers use a self-signed certificate.
      secureOptions: { rejectUnauthorized: false },
    });
    this.connected = true;
    const timings = { auth: Date.now() - t0 };
    const home = await this.client.pwd().catch(() => '/');
    timings.realpath = Date.now() - t0;
    timings.total = timings.realpath;
    this.timings = timings;
    return { home: home || '/', timings };
  }

  describeTimings() {
    const t = this.timings;
    return t ? `login ${t.auth}ms, pwd +${t.realpath - t.auth}ms` : '';
  }

  async disconnect() {
    this.connected = false;
    try {
      this.client.close();
    } catch (err) {
      /* already closed */
    }
  }

  async list(remotePath) {
    const target = remotePath || '/';
    const raw = await this.client.list(target);
    const items = raw
      .filter((it) => it.name !== '.' && it.name !== '..')
      .map((it) => ({
        name: it.name,
        isDir: it.isDirectory,
        isLink: it.isSymbolicLink,
        size: it.size,
        mtime: it.modifiedAt ? it.modifiedAt.getTime() : Date.parse(it.rawModifiedAt) || 0,
        permissions: permsToString(it.permissions),
        mode: permsToMode(it.permissions),
        owner: it.user,
        group: it.group,
      }));
    return { path: target, parent: target === '/' ? '/' : path.dirname(target), items };
  }

  _withProgress(onProgress, expectedTotal, fn) {
    if (onProgress) {
      this.client.trackProgress((info) => onProgress(info.bytes, expectedTotal || 0));
    }
    return fn().finally(() => {
      this.client.trackProgress();
    });
  }

  async download(remotePath, localPath, onProgress, expectedTotal) {
    await this._withProgress(onProgress, expectedTotal, () =>
      this.client.downloadTo(localPath, remotePath));
  }

  async upload(localPath, remotePath, onProgress, expectedTotal) {
    await this._withProgress(onProgress, expectedTotal, () =>
      this.client.uploadFrom(localPath, remotePath));
  }

  async mkdir(remotePath) {
    const back = await this.client.pwd().catch(() => '/');
    await this.client.ensureDir(remotePath);
    await this.client.cd(back).catch(() => {});
  }

  async removeFile(remotePath) {
    await this.client.remove(remotePath);
  }

  async removeDir(remotePath) {
    await this.client.removeDir(remotePath);
  }

  async rename(from, to) {
    await this.client.rename(from, to);
  }

  async chmod(remotePath, mode) {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    await this.client.send(`SITE CHMOD ${octal} ${remotePath}`);
  }

  async exists(remotePath) {
    try {
      const dir = path.dirname(remotePath);
      const base = path.basename(remotePath);
      const items = await this.client.list(dir);
      const hit = items.find((i) => i.name === base);
      if (!hit) return false;
      return hit.isDirectory ? 'd' : '-';
    } catch (err) {
      return false;
    }
  }

  async stat(remotePath) {
    const dir = path.dirname(remotePath);
    const base = path.basename(remotePath);
    const items = await this.client.list(dir);
    const hit = items.find((i) => i.name === base);
    if (!hit) throw new Error('No such file: ' + remotePath);
    return {
      isDir: hit.isDirectory,
      size: hit.size,
      mtime: hit.modifiedAt ? hit.modifiedAt.getTime() : 0,
      mode: permsToMode(hit.permissions),
    };
  }

  get supportsChmod() {
    return true;
  }
}

module.exports = FtpAdapter;

// Minimal in-process SFTP server for end-to-end testing. Serves one directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server, utils } = require('ssh2');
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

function modeString(stat) {
  const m = stat.mode;
  const type = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : '-';
  const bit = (b, c) => (m & b ? c : '-');
  return type
    + bit(0o400, 'r') + bit(0o200, 'w') + bit(0o100, 'x')
    + bit(0o040, 'r') + bit(0o020, 'w') + bit(0o010, 'x')
    + bit(0o004, 'r') + bit(0o002, 'w') + bit(0o001, 'x');
}

function attrs(stat) {
  return {
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function start(root, user, pass) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  // Everything the client asks for is resolved inside `root`.
  const real = (p) => {
    const clean = path.posix.normalize('/' + String(p || '/')).replace(/^\/+/, '');
    return path.join(root, clean);
  };

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === pass) ctx.accept();
      else ctx.reject(['password']);
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          let next = 0;
          const handles = new Map();
          const mk = (data) => {
            const id = next++;
            handles.set(id, data);
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(id, 0);
            return buf;
          };
          const get = (handle) => handles.get(handle.readUInt32BE(0));

          sftp.on('REALPATH', (reqid, p) => {
            const resolved = p === '.' || p === '' ? '/' : path.posix.normalize(p);
            sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }]);
          });

          sftp.on('OPENDIR', (reqid, p) => {
            try {
              const target = real(p);
              if (!fs.statSync(target).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
              return sftp.handle(reqid, mk({ dir: target, names: fs.readdirSync(target), sent: false }));
            } catch (err) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
          });

          sftp.on('READDIR', (reqid, handle) => {
            const h = get(handle);
            if (!h || h.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            h.sent = true;
            const list = h.names.map((name) => {
              const st = fs.lstatSync(path.join(h.dir, name));
              return { filename: name, longname: `${modeString(st)} 1 u g ${st.size} Jan 1 00:00 ${name}`, attrs: attrs(st) };
            });
            return sftp.name(reqid, list);
          });

          const statHandler = (reqid, p, useLstat) => {
            try {
              const st = useLstat ? fs.lstatSync(real(p)) : fs.statSync(real(p));
              return sftp.attrs(reqid, attrs(st));
            } catch (err) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
          };
          sftp.on('STAT', (reqid, p) => statHandler(reqid, p, false));
          sftp.on('LSTAT', (reqid, p) => statHandler(reqid, p, true));
          sftp.on('FSTAT', (reqid, handle) => {
            const h = get(handle);
            if (!h || h.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
            return sftp.attrs(reqid, attrs(fs.fstatSync(h.fd)));
          });

          sftp.on('OPEN', (reqid, p, flags) => {
            const mode = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.APPEND ? 'a' : 'w') : 'r';
            try {
              const fd = fs.openSync(real(p), mode);
              return sftp.handle(reqid, mk({ fd }));
            } catch (err) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
          });

          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = get(handle);
            if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const buf = Buffer.alloc(length);
            const read = fs.readSync(h.fd, buf, 0, length, offset);
            if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            return sftp.data(reqid, buf.slice(0, read));
          });

          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = get(handle);
            if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.writeSync(h.fd, data, 0, data.length, offset);
            return sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('CLOSE', (reqid, handle) => {
            const id = handle.readUInt32BE(0);
            const h = handles.get(id);
            if (h && h.fd !== undefined) fs.closeSync(h.fd);
            handles.delete(id);
            return sftp.status(reqid, STATUS_CODE.OK);
          });

          const simple = (fn) => (reqid, ...args) => {
            try { fn(...args); return sftp.status(reqid, STATUS_CODE.OK); }
            catch (err) { return sftp.status(reqid, STATUS_CODE.FAILURE); }
          };
          sftp.on('MKDIR', simple((p) => fs.mkdirSync(real(p))));
          sftp.on('RMDIR', simple((p) => fs.rmdirSync(real(p))));
          sftp.on('REMOVE', simple((p) => fs.unlinkSync(real(p))));
          sftp.on('RENAME', simple((from, to) => fs.renameSync(real(from), real(to))));
          sftp.on('SETSTAT', simple((p, at) => { if (at.mode !== undefined) fs.chmodSync(real(p), at.mode & 0o777); }));
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
        });
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

module.exports = { start };

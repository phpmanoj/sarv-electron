'use strict';
const { Transform } = require('stream');

/**
 * Caps throughput at `bytesPerSecond`. A limit of 0 disables throttling.
 *
 * Pacing is cumulative: after N bytes the stream is held back until at least
 * N / limit seconds have passed since it started, so the average rate holds no
 * matter what size the source delivers. Oversized chunks are split into
 * tenth-of-a-second slices first - forwarding a whole 200 KB read at once and
 * then sleeping would both overshoot a short window and arrive in bursts.
 *
 * Credit is capped at one second so a stalled source cannot bank unlimited
 * allowance and then release it in one go.
 *
 * `onBytes` receives the running total, which is how transfers report progress
 * when they run through this stream instead of fastGet/fastPut.
 */
class Throttle extends Transform {
  constructor(bytesPerSecond, onBytes) {
    super();
    this.limit = Number(bytesPerSecond) > 0 ? Math.floor(Number(bytesPerSecond)) : 0;
    this.onBytes = typeof onBytes === 'function' ? onBytes : null;
    this.total = 0;
    this.startedAt = null;
    this.slice = this.limit ? Math.max(4096, Math.floor(this.limit / 10)) : 0;
  }

  _transform(chunk, _encoding, callback) {
    if (!this.limit) {
      this.total += chunk.length;
      if (this.onBytes) this.onBytes(this.total);
      callback(null, chunk);
      return;
    }
    if (this.startedAt === null) this.startedAt = Date.now();
    this._pace(chunk, 0, callback);
  }

  /** Emit `chunk` from `offset` one slice at a time, waiting between slices. */
  _pace(chunk, offset, callback) {
    if (offset >= chunk.length) {
      callback();
      return;
    }
    const end = Math.min(offset + this.slice, chunk.length);
    this.push(chunk.subarray(offset, end));
    this.total += end - offset;
    if (this.onBytes) this.onBytes(this.total);

    const targetMs = (this.total / this.limit) * 1000;
    const elapsed = Date.now() - this.startedAt;
    // A source that went quiet must not bank more than a second of allowance.
    if (elapsed - targetMs > 1000) this.startedAt = Date.now() - targetMs - 1000;

    const wait = targetMs - (Date.now() - this.startedAt);
    if (wait <= 0) {
      setImmediate(() => this._pace(chunk, end, callback));
      return;
    }
    setTimeout(() => this._pace(chunk, end, callback), wait);
  }
}

/**
 * ASCII transfer mode. SFTP has no protocol-level ASCII type, so the line
 * ending conversion FileZilla performs is done here for both backends.
 *
 *   direction 'to-remote' : LF  -> CRLF  (upload)
 *   direction 'to-local'  : CRLF -> LF   (download)
 *
 * Both directions carry state across chunk boundaries, so a CRLF split between
 * two reads is still converted correctly.
 */
class AsciiLineEndings extends Transform {
  constructor(direction) {
    super();
    this.toRemote = direction === 'to-remote';
    this.prevByte = -1;
    this.pendingCR = false;
  }

  _transform(chunk, _encoding, callback) {
    callback(null, this.toRemote ? this._encode(chunk) : this._decode(chunk));
  }

  _flush(callback) {
    // A trailing CR was held back waiting to see whether an LF followed.
    if (!this.toRemote && this.pendingCR) {
      this.pendingCR = false;
      callback(null, Buffer.from([13]));
      return;
    }
    callback();
  }

  /** LF -> CRLF, leaving existing CRLF alone. */
  _encode(chunk) {
    const out = Buffer.allocUnsafe(chunk.length * 2);
    let o = 0;
    let prev = this.prevByte;
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (b === 10 && prev !== 13) out[o++] = 13;
      out[o++] = b;
      prev = b;
    }
    this.prevByte = prev;
    return out.subarray(0, o);
  }

  /** CRLF -> LF, leaving a lone CR alone. */
  _decode(chunk) {
    const out = Buffer.allocUnsafe(chunk.length + 1);
    let o = 0;
    if (this.pendingCR) {
      this.pendingCR = false;
      if (chunk.length === 0 || chunk[0] !== 10) out[o++] = 13;
    }
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (b !== 13) {
        out[o++] = b;
        continue;
      }
      if (i + 1 < chunk.length) {
        if (chunk[i + 1] !== 10) out[o++] = 13;
      } else {
        this.pendingCR = true;
      }
    }
    return out.subarray(0, o);
  }
}

/**
 * Extensions FileZilla treats as text by default. Used when the transfer mode
 * is 'auto'; anything not listed here transfers as binary.
 */
const DEFAULT_ASCII_EXTENSIONS = [
  'am', 'asp', 'bat', 'c', 'cfm', 'cgi', 'conf', 'cpp', 'css', 'dhtml', 'diz',
  'h', 'hpp', 'htm', 'html', 'in', 'inc', 'js', 'json', 'jsp', 'log', 'm4',
  'md', 'mak', 'md5', 'nfo', 'nsi', 'pas', 'patch', 'php', 'phtml', 'pl',
  'po', 'py', 'qmail', 'rb', 'rdf', 'rss', 'sh', 'shtml', 'sql', 'svg', 'tcl',
  'tpl', 'ts', 'txt', 'vbs', 'xhtml', 'xml', 'xrc', 'yaml', 'yml',
];

/**
 * Decide whether one file transfers as ASCII.
 * mode: 'binary' (never) | 'ascii' (always) | 'auto' (by extension).
 */
function isAsciiTransfer(fileName, mode, extensions) {
  if (mode === 'ascii') return true;
  if (mode !== 'auto') return false;
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  // A file with no extension is text in FileZilla's default rule set.
  if (dot <= 0 || dot === name.length - 1) return true;
  const ext = name.slice(dot + 1).toLowerCase();
  const list = Array.isArray(extensions) && extensions.length ? extensions : DEFAULT_ASCII_EXTENSIONS;
  return list.includes(ext);
}

module.exports = { Throttle, AsciiLineEndings, DEFAULT_ASCII_EXTENSIONS, isAsciiTransfer };

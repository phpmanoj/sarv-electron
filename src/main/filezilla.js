'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * FileZilla sitemanager.xml import / export.
 *
 * Format observed in FileZilla Client 3.71.1 on this machine:
 *
 *   <FileZilla3 version="3.71.1" platform="mac">
 *     <Servers>
 *       <Folder expanded="0">GroupName<Server>...</Server><Server>...</Server></Folder>
 *       <Server>
 *         <Host>..</Host><Port>22</Port><Protocol>1</Protocol>
 *         <User>..</User><Pass encoding="base64">..</Pass><Logontype>1</Logontype>
 *         <Keyfile>..</Keyfile><Name>..</Name><Comments>..</Comments>
 *         <RemoteDir>1 0 3 usr 3 lib</RemoteDir><LocalDir>..</LocalDir>
 *         <SyncBrowsing>0</SyncBrowsing>
 *       </Server>
 *     </Servers>
 *   </FileZilla3>
 *
 * The folder name is the Folder element's own text, mixed in with its children.
 */

/* --------------------------------------------------------------- tiny XML */

/** Parse well-formed XML into { name, attrs, text, children }. */
function parseXml(source) {
  const text = String(source);
  const root = { name: '#root', attrs: {}, text: '', children: [] };
  const stack = [root];
  const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([A-Za-z_][\w.:-]*)\s*>|<\s*([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  let m;

  const addText = (chunk) => {
    if (!chunk) return;
    const node = stack[stack.length - 1];
    node.text += decodeEntities(chunk);
  };

  while ((m = tagRe.exec(text)) !== null) {
    addText(text.slice(last, m.index));
    last = tagRe.lastIndex;

    if (m[1] !== undefined) { addText(m[1]); continue; }      // CDATA
    if (m[0].startsWith('<!--') || m[0].startsWith('<?')) continue;

    if (m[2]) {                                                // closing tag
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === m[2]) { stack.length = i; break; }
      }
      continue;
    }

    const node = { name: m[3], attrs: parseAttrs(m[4] || ''), text: '', children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[5]) stack.push(node);                               // not self-closing
  }
  addText(text.slice(last));
  return root;
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const child = (node, name) => node.children.find((c) => c.name === name);
const childText = (node, name) => {
  const c = child(node, name);
  return c ? c.text.trim() : '';
};

/* ------------------------------------------------------- CServerPath codec */

/**
 * Decode FileZilla's safe path, e.g. "1 0 3 usr 3 lib 12 sarv_modules"
 * -> "/usr/lib/sarv_modules".  Layout: <type> <prefixLen> [prefix] (<len> <segment>)*
 */
function decodeServerPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let i = 0;
  const readInt = () => {
    const start = i;
    while (i < s.length && s[i] !== ' ') i += 1;
    const value = parseInt(s.slice(start, i), 10);
    i += 1; // skip the separating space
    return value;
  };

  const type = readInt();
  if (!isFinite(type)) return '';
  const prefixLen = readInt();
  if (!isFinite(prefixLen)) return '';
  let prefix = '';
  if (prefixLen > 0) {
    prefix = s.substr(i, prefixLen);
    i += prefixLen + 1;
  }

  const segments = [];
  while (i < s.length) {
    const len = readInt();
    if (!isFinite(len) || len < 0) break;
    segments.push(s.substr(i, len));
    i += len + 1;
  }

  const joined = '/' + segments.join('/');
  return prefix ? prefix + joined : joined;
}

/** "/usr/lib" -> "1 0 3 usr 3 lib" (type 1 = unix). */
function encodeServerPath(p) {
  const clean = String(p || '').trim();
  if (!clean || clean === '/') return '';
  const segments = clean.split('/').filter(Boolean);
  return ['1', '0'].concat(segments.map((seg) => seg.length + ' ' + seg)).join(' ');
}

/* ---------------------------------------------------------------- mapping */

// FileZilla ServerProtocol values we can actually speak.
const PROTOCOL_IN = { 0: 'ftp', 1: 'sftp', 3: 'ftps', 4: 'ftps', 6: 'ftp' };
const PROTOCOL_OUT = { sftp: 1, ftp: 0, ftps: 4 };
const PROTOCOL_NAMES = {
  2: 'HTTP', 5: 'HTTPS', 7: 'S3', 8: 'Storj', 9: 'WebDAV', 10: 'Azure File',
  11: 'Azure Blob', 12: 'Swift', 13: 'Google Cloud', 14: 'OneDrive',
  15: 'Google Drive', 16: 'Backblaze B2', 17: 'Box', 18: 'Dropbox',
};

// FileZilla LogonType: 0 anonymous, 1 normal, 2 ask, 3 interactive, 4 account, 5 key, 6 agent
const LOGON_IN = { 0: 'password', 1: 'password', 2: 'password', 3: 'password', 4: 'password', 5: 'key', 6: 'agent' };
const LOGON_OUT = { password: 1, key: 5, agent: 6 };

function defaultPort(protocol) {
  return protocol === 'sftp' ? 22 : 21;
}

/** Where FileZilla keeps its configuration on this platform. */
function configCandidates() {
  const home = os.homedir();
  return [
    path.join(home, '.config', 'filezilla', 'sitemanager.xml'),
    path.join(home, 'Library', 'Application Support', 'FileZilla', 'sitemanager.xml'),
    path.join(home, '.filezilla', 'sitemanager.xml'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'FileZilla', 'sitemanager.xml'),
  ];
}

function detect() {
  for (const candidate of configCandidates()) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return { path: candidate, size: stat.size, mtime: stat.mtimeMs };
    } catch (err) {
      /* not there */
    }
  }
  return null;
}

/** Read a sitemanager.xml and return our own site shape. */
function readSites(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const root = parseXml(xml);
  const fz = child(root, 'FileZilla3');
  const servers = fz ? child(fz, 'Servers') : child(root, 'Servers');
  if (!servers) throw new Error('Not a FileZilla sitemanager.xml (no <Servers> element)');

  const sites = [];
  const skipped = [];

  const walk = (node, folderPath) => {
    for (const c of node.children) {
      if (c.name === 'Server') {
        const site = mapServer(c, folderPath, skipped);
        if (site) sites.push(site);
      } else if (c.name === 'Folder') {
        // The folder's own text is its name; nested Servers are its children.
        const label = c.text.trim() || 'Folder';
        walk(c, folderPath ? folderPath + '/' + label : label);
      }
    }
  };
  walk(servers, '');

  return { sites, skipped, source: filePath, version: fz ? fz.attrs.version || '' : '' };
}

function mapServer(node, folderPath, skipped) {
  const protocolRaw = Number(childText(node, 'Protocol'));
  const protocol = PROTOCOL_IN[protocolRaw];
  const name = childText(node, 'Name') || childText(node, 'Host');

  if (!protocol) {
    skipped.push({ name, reason: (PROTOCOL_NAMES[protocolRaw] || 'protocol ' + protocolRaw) + ' is not supported' });
    return null;
  }

  const logonRaw = Number(childText(node, 'Logontype'));
  const authType = LOGON_IN[logonRaw] || 'password';

  const passNode = child(node, 'Pass');
  let password = '';
  if (passNode) {
    const encoding = (passNode.attrs.encoding || '').toLowerCase();
    if (encoding === 'base64') {
      password = Buffer.from(passNode.text.trim(), 'base64').toString('utf8');
    } else if (encoding === 'crypt' || encoding === 'crypted') {
      skipped.push({ name, reason: 'password is protected by a FileZilla master password - site imported without it' });
    } else {
      password = passNode.text.trim();
    }
  }

  return {
    name,
    folder: folderPath,
    protocol,
    host: childText(node, 'Host'),
    port: Number(childText(node, 'Port')) || defaultPort(protocol),
    user: childText(node, 'User'),
    authType,
    password,
    keyPath: childText(node, 'Keyfile'),
    remotePath: decodeServerPath(childText(node, 'RemoteDir')),
    localPath: childText(node, 'LocalDir'),
    comments: childText(node, 'Comments'),
    syncBrowsing: childText(node, 'SyncBrowsing') === '1',
  };
}

/* ----------------------------------------------------------------- export */

/**
 * Serialize our sites back to FileZilla's format so they can be imported
 * into FileZilla (or into another copy of this app).
 * `includePasswords: false` writes the entries without any secret.
 */
function writeSites(sites, options) {
  const opts = options || {};
  const includePasswords = opts.includePasswords !== false;

  const serverXml = (site, indent) => {
    const pad = '\t'.repeat(indent);
    const lines = [`${pad}<Server>`];
    const put = (tag, value) => lines.push(`${pad}\t<${tag}>${escapeXml(value)}</${tag}>`);
    put('Host', site.host);
    put('Port', site.port || defaultPort(site.protocol));
    put('Protocol', PROTOCOL_OUT[site.protocol] !== undefined ? PROTOCOL_OUT[site.protocol] : 1);
    put('Type', 0);
    put('User', site.user);
    if (includePasswords && site.password) {
      lines.push(`${pad}\t<Pass encoding="base64">${Buffer.from(site.password, 'utf8').toString('base64')}</Pass>`);
    }
    put('Logontype', LOGON_OUT[site.authType] !== undefined ? LOGON_OUT[site.authType] : 1);
    if (site.keyPath) put('Keyfile', site.keyPath);
    put('TimezoneOffset', 0);
    put('PasvMode', 'MODE_DEFAULT');
    put('EncodingType', 'Auto');
    put('BypassProxy', 0);
    put('Name', site.name || site.host);
    if (site.comments) put('Comments', site.comments);
    if (site.remotePath) put('RemoteDir', encodeServerPath(site.remotePath));
    if (site.localPath) put('LocalDir', site.localPath);
    put('SyncBrowsing', site.syncBrowsing ? 1 : 0);
    put('DirectoryComparison', 0);
    lines.push(`${pad}</Server>`);
    return lines.join('\n');
  };

  const out = [
    '<?xml version="1.0"?>',
    `<FileZilla3 version="3.71.1" platform="${process.platform === 'darwin' ? 'mac' : process.platform}">`,
    '\t<Servers>',
  ];

  // Walk the sites in their own order and open/close <Folder> as it changes,
  // so an exported file mirrors the layout it was imported from.
  let openFolder = null;
  for (const site of sites) {
    const folder = site.folder || '';
    if (folder !== openFolder) {
      if (openFolder) out.push('\t\t</Folder>');
      openFolder = folder || null;
      if (openFolder) out.push(`\t\t<Folder expanded="0">${escapeXml(openFolder)}`);
    }
    out.push(serverXml(site, openFolder ? 3 : 2));
  }
  if (openFolder) out.push('\t\t</Folder>');

  out.push('\t</Servers>', '</FileZilla3>', '');
  return out.join('\n');
}

module.exports = {
  parseXml,
  escapeXml,
  decodeServerPath,
  encodeServerPath,
  detect,
  configCandidates,
  readSites,
  writeSites,
};

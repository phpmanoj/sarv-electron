'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { shell } = require('electron');

/** Local filesystem side of the two panes. */

function entry(name, stat, isLink) {
  return {
    name,
    isDir: stat ? stat.isDirectory() : false,
    isLink: Boolean(isLink),
    size: stat ? stat.size : 0,
    mtime: stat ? stat.mtimeMs : 0,
    mode: stat ? stat.mode & 0o777 : null,
    permissions: stat ? modeToString(stat.mode & 0o777) : '',
  };
}

function modeToString(mode) {
  const bit = (m, c) => (mode & m ? c : '-');
  return (
    bit(0o400, 'r') + bit(0o200, 'w') + bit(0o100, 'x') +
    bit(0o040, 'r') + bit(0o020, 'w') + bit(0o010, 'x') +
    bit(0o004, 'r') + bit(0o002, 'w') + bit(0o001, 'x')
  );
}

async function list(dirPath) {
  const target = dirPath && dirPath !== '' ? path.resolve(dirPath) : os.homedir();
  const names = await fsp.readdir(target);
  const items = [];
  for (const name of names) {
    const full = path.join(target, name);
    let stat = null;
    let isLink = false;
    try {
      const l = await fsp.lstat(full);
      isLink = l.isSymbolicLink();
      stat = isLink ? await fsp.stat(full).catch(() => l) : l;
    } catch (err) {
      stat = null;
    }
    items.push(entry(name, stat, isLink));
  }
  return { path: target, parent: path.dirname(target), items };
}

async function mkdir(dirPath, name) {
  const full = path.join(dirPath, name);
  await fsp.mkdir(full, { recursive: false });
  return full;
}

async function rename(oldPath, newPath) {
  await fsp.rename(oldPath, newPath);
  return newPath;
}

async function remove(targets, useTrash) {
  for (const t of targets) {
    if (useTrash) {
      await shell.trashItem(t);
    } else {
      await fsp.rm(t, { recursive: true, force: true });
    }
  }
  return true;
}

async function stat(target) {
  const s = await fsp.stat(target);
  return entry(path.basename(target), s, false);
}

function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch (err) {
    return false;
  }
}

/** Walk a local directory and return every file inside it, relative paths included. */
async function walk(root) {
  const out = [];
  async function rec(dir, rel) {
    const names = await fsp.readdir(dir, { withFileTypes: true });
    for (const d of names) {
      const full = path.join(dir, d.name);
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        out.push({ type: 'dir', path: full, rel: r });
        await rec(full, r);
      } else if (d.isFile()) {
        const s = await fsp.stat(full).catch(() => null);
        out.push({ type: 'file', path: full, rel: r, size: s ? s.size : 0 });
      }
    }
  }
  await rec(root, '');
  return out;
}

/** Pick a non-colliding name, e.g. notes.txt -> notes (1).txt */
function uniquePath(target) {
  if (!exists(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return target;
}

module.exports = {
  list,
  mkdir,
  rename,
  remove,
  stat,
  exists,
  walk,
  uniquePath,
  modeToString,
  home: () => os.homedir(),
  reveal: (target) => shell.showItemInFolder(target),
};

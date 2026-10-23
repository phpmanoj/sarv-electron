'use strict';
/* Sarv Electron - UI wiring.
   Feature set mirrors the FileZilla surface recorded in
   docs/REVERSE-ENGINEERED-SPEC.md. */

const { el, $, $$ } = L;

const app = {
  settings: {},
  status: { connected: false, info: null, supportsChmod: false },
  queue: [],
  editSessions: [],
  editedPaths: [],
  detectedEditors: [],
  sites: [],
  compareOn: false,
  syncOn: false,
  syncRoots: null,
  queueTab: 'queued',
  activePane: 'local',
  activeSessionId: null,
  tabs: [],
  queues: new Map(),        // sessionId -> queue items
  remoteCache: new Map(),   // sessionId -> last listing, so tab switches are instant
  tabStatus: new Map(),     // sessionId -> connection status
  tabThemes: new Map(),     // sessionId -> theme id, overriding the global one
  siteFolderExpanded: new Set(),
  lastSiteId: null,         // keeps your place in the Site Manager
  localPane: null,
  remotePane: null,
};

/** The tab (session) every remote call goes to. */
function sid() {
  return app.activeSessionId;
}

/** Payload helper: adds the active tab id. */
function on(payload) {
  return Object.assign({ sessionId: sid() }, payload || {});
}

/* ============================================================== themes */

const THEMES = [
  { id: 'system', label: 'System (follow macOS)', dark: null, group: 'Auto' },

  { id: 'light', label: 'Light · neutral', dark: false, group: 'Light' },
  { id: 'sarv', label: 'Light · Sarv orange', dark: false, group: 'Light' },
  { id: 'sky', label: 'Light · Sky blue', dark: false, group: 'Light' },
  { id: 'mint', label: 'Light · Mint green', dark: false, group: 'Light' },
  { id: 'emerald', label: 'Light · Emerald green', dark: false, group: 'Light' },
  { id: 'olive', label: 'Light · Olive green', dark: false, group: 'Light' },
  { id: 'lavender', label: 'Light · Lavender', dark: false, group: 'Light' },
  { id: 'rose', label: 'Light · Rose', dark: false, group: 'Light' },
  { id: 'sand', label: 'Light · Sand', dark: false, group: 'Light' },
  { id: 'paper', label: 'Light · Paper (sepia)', dark: false, group: 'Light' },
  { id: 'solarized-light', label: 'Light · Solarized', dark: false, group: 'Light' },
  { id: 'contrast-light', label: 'Light · High contrast', dark: false, group: 'Light' },

  { id: 'dark', label: 'Dark · neutral', dark: true, group: 'Dark' },
  { id: 'sarv-dark', label: 'Dark · Sarv orange', dark: true, group: 'Dark' },
  { id: 'midnight', label: 'Dark · Midnight blue', dark: true, group: 'Dark' },
  { id: 'ocean', label: 'Dark · Ocean teal', dark: true, group: 'Dark' },
  { id: 'forest', label: 'Dark · Forest green', dark: true, group: 'Dark' },
  { id: 'emerald-dark', label: 'Dark · Emerald green', dark: true, group: 'Dark' },
  { id: 'matrix', label: 'Dark · Matrix green', dark: true, group: 'Dark' },
  { id: 'nord', label: 'Dark · Nord', dark: true, group: 'Dark' },
  { id: 'dracula', label: 'Dark · Dracula', dark: true, group: 'Dark' },
  { id: 'plum', label: 'Dark · Plum', dark: true, group: 'Dark' },
  { id: 'carbon', label: 'Dark · Carbon', dark: true, group: 'Dark' },
  { id: 'solarized', label: 'Dark · Solarized', dark: true, group: 'Dark' },
  { id: 'contrast', label: 'Dark · High contrast', dark: true, group: 'Dark' },
];

/* ------------------------------------------------------- custom themes */

const CUSTOM_PREFIX = 'custom-';

/** The six colours a user picks; everything else is derived from them. */
const CUSTOM_FIELDS = [
  ['bg', 'Window background'],
  ['panel', 'Panels / lists'],
  ['border', 'Lines and borders'],
  ['text', 'Text'],
  ['muted', 'Dim text'],
  ['accent', 'Accent / selection'],
];

function customThemeCss(theme) {
  const c = theme.colors || {};
  const dark = Boolean(theme.dark);
  const state = dark
    ? { ok: '#4ec16f', warn: '#e0b341', err: '#ff6b6b' }
    : { ok: '#1a7f37', warn: '#9a6700', err: '#c01c28' };
  const cmp = dark
    ? { 'cmp-only': '#3d3517', 'cmp-diff': '#46211f', 'cmp-newer': '#1e3522' }
    : { 'cmp-only': '#fff6d6', 'cmp-diff': '#ffe3e0', 'cmp-newer': '#e2f6e4' };

  return `:root[data-theme="${CUSTOM_PREFIX}${theme.id}"] {
  --theme-label: "${String(theme.label).replace(/"/g, '')}";
  --theme-dark: ${dark ? 1 : 0};
  --bg: ${c.bg};
  --panel: ${c.panel};
  --border: ${c.border};
  --text: ${c.text};
  --muted: ${c.muted};
  --accent: ${c.accent};
  --accent-soft: color-mix(in srgb, ${c.accent} 22%, ${c.panel});
  --row-alt: color-mix(in srgb, ${c.panel} 93%, ${c.text});
  --hover: color-mix(in srgb, ${c.panel} 87%, ${c.text});
  --sel: color-mix(in srgb, ${c.accent} 34%, ${c.panel});
  --head: color-mix(in srgb, ${c.panel} 94%, ${c.text});
  --ok: ${state.ok};
  --warn: ${state.warn};
  --err: ${state.err};
  --cmp-only: ${cmp['cmp-only']};
  --cmp-diff: ${cmp['cmp-diff']};
  --cmp-newer: ${cmp['cmp-newer']};
  color-scheme: ${dark ? 'dark' : 'light'};
}`;
}

/** Put every custom theme into one <style> block the page can use. */
function applyCustomThemes(list) {
  const themes = Array.isArray(list) ? list : [];
  let style = document.getElementById('custom-themes');
  if (!style) {
    style = el('style', { id: 'custom-themes' });
    document.head.append(style);
  }
  style.textContent = themes.filter((t) => t && t.id && t.colors).map(customThemeCss).join('\n\n');
}

/** Built-in themes plus the user's own. */
function allThemes() {
  const custom = (app.settings.customThemes || []).map((t) => ({
    id: CUSTOM_PREFIX + t.id,
    label: t.label || 'My theme',
    dark: Boolean(t.dark),
    group: 'My themes',
    custom: true,
    source: t,
  }));
  return THEMES.concat(custom);
}

/** Options for a theme <select>, grouped the way the picker shows them. */
function themeOptionNodes() {
  const nodes = [];
  const groups = ['Auto', 'My themes', 'Light', 'Dark'];
  const catalogue = allThemes();
  for (const group of groups) {
    const items = catalogue.filter((t) => t.group === group);
    if (!items.length) continue;
    const options = items.map((t) => el('option', { value: t.id, text: t.label }));
    if (group === 'Auto') nodes.push(...options);
    else nodes.push(el('optgroup', { label: group + ` (${items.length})` }, options));
  }
  return nodes;
}

function themeIsDark(id) {
  const theme = allThemes().find((t) => t.id === id);
  if (!theme || theme.dark === null) {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return theme.dark;
}

/** Turn a local file path into a CSS url() the page may load. */
function fileUrl(p) {
  const encoded = String(p).split('/').map(encodeURIComponent).join('/');
  return 'file://' + encoded.replace(/%2F/g, '/');
}

function applyBackground(s) {
  const root = document.documentElement;
  if (!s || !s.bgImage) {
    root.classList.remove('has-bg');
    return;
  }
  const fit = s.bgFit || 'cover';
  root.style.setProperty('--bg-image', `url("${fileUrl(s.bgImage)}")`);
  root.style.setProperty('--bg-size', fit === 'tile' || fit === 'center' ? 'auto' : fit);
  root.style.setProperty('--bg-repeat', fit === 'tile' ? 'repeat' : 'no-repeat');
  root.style.setProperty('--bg-veil', (s.bgVeil === undefined ? 86 : s.bgVeil) + '%');
  root.style.setProperty('--bg-dim', (s.bgDim === undefined ? 25 : s.bgDim) + '%');
  root.classList.add('has-bg');
}

/** The theme a tab should show: its own, else the global one. */
function themeForTab(id) {
  return app.tabThemes.get(id) || app.settings.theme || 'system';
}

function applyTheme(id) {
  const theme = allThemes().find((t) => t.id === id) || THEMES[0];
  if (theme.id === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.id;
}

/* ========================================================== message log */

function log(level, message, time) {
  const box = $('#log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  const line = el('div', {}, [
    app.settings.showTimestamps ? el('span', { class: 't', text: L.fmtTime(time) + ' ' }) : null,
    el('span', { class: level || 'info', text: message }),
  ]);
  box.append(line);
  while (box.childElementCount > 500) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* =============================================================== tabs */

function renderTabs() {
  const bar = $('#remote-tabs');
  bar.innerHTML = '';

  for (const tab of app.tabs) {
    const active = tab.id === app.activeSessionId;
    const cls = ['server-tab', active ? 'active' : '', tab.connected ? 'connected' : '', tab.busy ? 'busy' : '']
      .filter(Boolean).join(' ');
    const label = tab.connected ? tab.title : 'Not connected';
    const suffix = tab.queued ? ` (${tab.queued})` : '';

    bar.append(el('button', {
      class: cls,
      title: (tab.connected
        ? `${tab.title} - ${tab.path}\n${tab.connections} connection(s)` + (tab.editing ? `, ${tab.editing} file(s) being edited` : '')
        : 'Empty tab')
        + (app.tabThemes.get(tab.id) ? `\ntheme: ${app.tabThemes.get(tab.id)}` : '')
        + '\nRight-click for tab options',
      onclick: () => activateTab(tab.id),
      oncontextmenu: (e) => {
        e.preventDefault();
        L.ctx(e.clientX, e.clientY, [
          { label: 'Theme for this tab...', action: () => chooseTabTheme(tab.id) },
          'sep',
          { label: 'New tab', action: newTab },
          { label: 'Close tab', disabled: app.tabs.length < 2 && !tab.connected, action: () => closeTab(tab.id) },
          { label: 'Close all other tabs', disabled: app.tabs.length < 2, action: () => closeOtherTabs(tab.id) },
        ]);
      },
    }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'label', text: label + suffix }),
      app.tabs.length > 1
        ? el('span', {
          class: 'close', text: '×', title: 'Close tab',
          onclick: (e) => { e.stopPropagation(); closeTab(tab.id); },
        })
        : null,
    ]));
  }

  bar.append(el('button', { class: 'new-tab', text: '+', title: 'New tab (connect to another server)', onclick: newTab }));
}

/** Give one tab its own theme, so two servers never look alike. */
async function chooseTabTheme(id) {
  const current = app.tabThemes.get(id) || '';
  const select = el('select', { style: 'width:100%' }, [
    el('option', { value: '', text: 'Use the default theme' }),
    ...themeOptionNodes(),
  ]);
  select.value = current;

  const preview = () => {
    if (id === app.activeSessionId) applyTheme(select.value || app.settings.theme || 'system');
  };
  select.onchange = preview;

  const tab = app.tabs.find((t) => t.id === id);
  const res = await L.modal({
    title: 'Theme for this tab',
    narrow: true,
    body: el('div', {}, [
      el('p', { style: 'margin:0 0 8px', text: tab && tab.connected ? tab.title : 'This tab' }),
      select,
      el('p', { class: 'hint', text: 'Har SFTP tab ki apni theme ho sakti hai - tab badalte hi theme bhi badal jayegi.' }),
    ]),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }],
  });

  if (res !== 'ok') {
    applyTheme(themeForTab(app.activeSessionId));   // undo the preview
    return;
  }
  if (select.value) app.tabThemes.set(id, select.value);
  else app.tabThemes.delete(id);
  applyTheme(themeForTab(app.activeSessionId));
  renderTabs();
}

async function refreshTabs() {
  const data = L.unwrap(await window.api.tabs.list());
  if (!data) return;
  app.tabs = data.tabs;
  if (!app.activeSessionId || !app.tabs.some((t) => t.id === app.activeSessionId)) {
    app.activeSessionId = data.activeId || (app.tabs[0] && app.tabs[0].id) || null;
  }
  renderTabs();
}

async function activateTab(id) {
  if (!id || id === app.activeSessionId) return;
  if (L.unwrap(await window.api.tabs.activate({ sessionId: id })) === null) return;
  app.activeSessionId = id;
  applyTheme(themeForTab(id));

  const status = app.tabStatus.get(id) || { connected: false, info: null, supportsChmod: false, connections: 0 };
  setStatus(status, true);

  const cached = app.remoteCache.get(id);
  if (status.connected && cached) {
    app.remotePane.setData(cached);
    applyCompare();
    refreshEditedPaths();
  } else if (status.connected) {
    await navigateRemote(status.info.home, true);
  } else {
    app.remotePane.clear();
  }
  renderTabs();
  renderQueue();
}

async function newTab() {
  const res = L.unwrap(await window.api.tabs.create(), 'New tab');
  if (!res) return null;
  app.tabs = res.tabs.tabs;
  app.activeSessionId = res.id;
  applyTheme(themeForTab(res.id));
  app.remotePane.clear();
  setStatus({ connected: false, info: null, supportsChmod: false, connections: 0 }, true);
  renderTabs();
  return res.id;
}

async function closeTab(id) {
  const res = await window.api.tabs.close({ sessionId: id });
  if (!res.ok && res.code === 'TAB_BUSY') {
    const ok = await L.confirm({
      title: 'Cannot close tab while busy.',
      message: 'Is tab me transfers chal rahe hain.\n\nCancel current operation and close tab?',
      ok: 'Cancel transfers and close',
      danger: true,
    });
    if (!ok) return;
    if (L.unwrap(await window.api.tabs.close({ sessionId: id, force: true }), 'Close tab') === null) return;
  } else if (!res.ok) {
    L.toast(res.error, 'error');
    return;
  }
  app.queues.delete(id);
  app.remoteCache.delete(id);
  app.tabStatus.delete(id);
  app.tabThemes.delete(id);
  await refreshTabs();
  const status = app.tabStatus.get(app.activeSessionId) || { connected: false, info: null, supportsChmod: false, connections: 0 };
  setStatus(status, true);
  const cached = app.remoteCache.get(app.activeSessionId);
  if (cached) app.remotePane.setData(cached); else app.remotePane.clear();
  renderQueue();
}

async function closeOtherTabs(keepId) {
  for (const tab of app.tabs.slice()) {
    if (tab.id !== keepId) await closeTab(tab.id);
  }
  await activateTab(keepId);
}

/* ====================================================== theme editor */

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLORS = { bg: '#f6f7f9', panel: '#ffffff', border: '#d6d9de', text: '#1d2127', muted: '#6b7280', accent: '#2f6feb' };

/** Read the colours a theme is currently painting with. */
function readThemeColors(id) {
  const root = document.documentElement;
  const previous = root.dataset.theme;
  applyTheme(id);
  const cs = getComputedStyle(root);
  const get = (name, fallback) => {
    const value = cs.getPropertyValue('--' + name).trim();
    return HEX.test(value) ? value.toLowerCase() : fallback;
  };
  const colors = {};
  for (const [key] of CUSTOM_FIELDS) colors[key] = get(key, FALLBACK_COLORS[key]);
  const dark = cs.getPropertyValue('--theme-dark').trim() === '1'
    || (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (previous) root.dataset.theme = previous;
  else delete root.dataset.theme;
  return { colors, dark };
}

/**
 * Make or edit your own theme: pick six colours, everything else is derived.
 * `editId` is a custom theme id (without the prefix) when editing.
 */
async function showThemeEditor(editId) {
  const existing = (app.settings.customThemes || []).find((t) => t.id === editId);
  const startFromId = existing ? CUSTOM_PREFIX + existing.id : themeForTab(app.activeSessionId);
  const base = existing
    ? { colors: Object.assign({}, FALLBACK_COLORS, existing.colors), dark: Boolean(existing.dark) }
    : readThemeColors(startFromId);

  const draft = {
    id: existing ? existing.id : 't' + Date.now().toString(36),
    label: existing ? existing.label : 'My theme',
    dark: base.dark,
    colors: Object.assign({}, base.colors),
  };

  const nameInput = el('input', { value: draft.label, style: 'width:100%' });
  const darkBox = el('input', { type: 'checkbox', checked: draft.dark });
  const startFrom = el('select', {}, themeOptionNodes());
  startFrom.value = startFromId;

  const swatches = {};
  const hexes = {};

  const preview = () => {
    draft.label = nameInput.value.trim() || 'My theme';
    draft.dark = darkBox.checked;
    applyCustomThemes((app.settings.customThemes || [])
      .filter((t) => t.id !== draft.id)
      .concat([draft]));
    applyTheme(CUSTOM_PREFIX + draft.id);
  };

  const rows = [];
  for (const [key, label] of CUSTOM_FIELDS) {
    const swatch = el('input', { type: 'color', value: draft.colors[key], style: 'width:46px; height:26px; padding:1px' });
    const hex = el('input', { value: draft.colors[key], size: 9, style: 'font-family:var(--mono)' });
    swatches[key] = swatch;
    hexes[key] = hex;
    swatch.oninput = () => { draft.colors[key] = swatch.value; hex.value = swatch.value; preview(); };
    hex.oninput = () => {
      if (!HEX.test(hex.value.trim())) return;
      draft.colors[key] = hex.value.trim();
      swatch.value = draft.colors[key];
      preview();
    };
    rows.push(el('label', { text: label + ':' }), el('div', { class: 'row' }, [swatch, hex]));
  }

  startFrom.onchange = () => {
    const picked = readThemeColors(startFrom.value);
    draft.colors = Object.assign({}, picked.colors);
    draft.dark = picked.dark;
    darkBox.checked = picked.dark;
    for (const [key] of CUSTOM_FIELDS) {
      swatches[key].value = draft.colors[key];
      hexes[key].value = draft.colors[key];
    }
    preview();
  };
  nameInput.oninput = preview;
  darkBox.onchange = preview;

  preview();

  const buttons = [];
  if (existing) {
    buttons.push({
      label: 'Delete',
      danger: true,
      keep: true,
      onClick: async () => {
        const ok = await L.confirm({ title: 'Delete theme', message: `"${existing.label}" delete karein?`, ok: 'Delete', danger: true });
        if (!ok) return false;
        L.closeModal({ action: 'delete' });
        return false;
      },
    });
  }
  buttons.push('spacer', { label: 'Cancel', value: null }, { label: 'Save', value: { action: 'save' }, primary: true });

  const res = await L.modal({
    title: existing ? 'Edit theme' : 'Create your own theme',
    narrow: true,
    body: el('div', {}, [
      el('div', { class: 'grid' }, [
        el('label', { text: 'Name:' }), nameInput,
        el('label', { text: 'Start from:' }), startFrom,
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [darkBox, 'This is a dark theme'])]),
        ...rows,
      ]),
      el('p', { class: 'hint', text: 'Baki colours (hover, selection, header, row stripes) inhi se nikal aate hain. Changes live dikh rahe hain.' }),
    ]),
    buttons,
  });

  // cancelled: put everything back the way it was
  if (!res) {
    applyCustomThemes(app.settings.customThemes);
    applyTheme(themeForTab(app.activeSessionId));
    return null;
  }

  let list = (app.settings.customThemes || []).filter((t) => t.id !== draft.id);
  let nextTheme = app.settings.theme;
  let nextDark = app.settings.themeDark;

  if (res.action === 'save') {
    list = list.concat([draft]);
    nextTheme = CUSTOM_PREFIX + draft.id;
    nextDark = draft.dark;
  } else {
    // deleted: fall back to the default theme
    if (app.settings.theme === CUSTOM_PREFIX + draft.id) {
      nextTheme = 'system';
      nextDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    app.tabThemes.forEach((value, key) => {
      if (value === CUSTOM_PREFIX + draft.id) app.tabThemes.delete(key);
    });
  }

  const saved = L.unwrap(await window.api.settings.set({
    customThemes: list,
    theme: nextTheme,
    themeDark: nextDark,
  }), 'Theme');
  if (saved) {
    app.tabThemes.delete(app.activeSessionId);
    applySettings(saved);
    const picker = $('#theme-picker');
    if (picker) {
      picker.innerHTML = '';
      picker.append(...themeOptionNodes());
      picker.value = saved.theme;
    }
    L.toast(res.action === 'save' ? `Theme "${draft.label}" saved` : 'Theme deleted', 'ok');
  }
  return saved;
}

/* ============================================================ panes */

async function navigateLocal(target, fromSync) {
  const data = L.unwrap(await window.api.local.list({ path: target }), 'Local');
  if (!data) return;
  app.localPane.setData(data);
  applyCompare();
  if (app.syncOn && !fromSync) await syncFrom('local');
}

async function navigateRemote(target, fromSync) {
  if (!app.status.connected) { L.toast('Not connected to any server.', 'warn'); return; }
  const data = L.unwrap(await window.api.remote.list(on({ path: target })), 'Remote');
  if (!data) return;
  app.remotePane.setData(data);
  app.remoteCache.set(sid(), data);
  log('info', 'Directory listing of "' + data.path + '" successful');
  refreshEditedPaths();
  applyCompare();
  if (app.syncOn && !fromSync) await syncFrom('remote');
}

/* ------------------------------------------------- synchronized browsing */

function relativeTo(root, p) {
  if (p === root) return '';
  const r = root.endsWith('/') ? root : root + '/';
  return p.startsWith(r) ? p.slice(r.length) : null;
}

function joinUnder(root, rel) {
  if (!rel) return root;
  return (root.endsWith('/') ? root.slice(0, -1) : root) + '/' + rel;
}

async function syncFrom(side) {
  if (!app.syncRoots) return;
  const from = side === 'local' ? app.localPane.path : app.remotePane.path;
  const root = side === 'local' ? app.syncRoots.local : app.syncRoots.remote;
  const otherRoot = side === 'local' ? app.syncRoots.remote : app.syncRoots.local;
  const rel = relativeTo(root, from);
  if (rel === null) {
    app.syncOn = false;
    app.syncRoots = null;
    $('#btn-sync').classList.remove('active');
    log('warn', 'Synchronized browsing has been disabled.');
    L.toast('Current directory is not below the synchronization root.\nSynchronized browsing has been disabled.', 'warn');
    return;
  }
  const target = joinUnder(otherRoot, rel);
  if (side === 'local') {
    if (target !== app.remotePane.path) await navigateRemote(target, true);
  } else if (target !== app.localPane.path) {
    await navigateLocal(target, true);
  }
}

function toggleSync() {
  if (app.syncOn) {
    app.syncOn = false;
    app.syncRoots = null;
    $('#btn-sync').classList.remove('active');
    log('info', 'Synchronized browsing has been disabled.');
    return;
  }
  if (!app.status.connected) { L.toast('Not connected to any server.', 'warn'); return; }
  app.syncOn = true;
  app.syncRoots = { local: app.localPane.path, remote: app.remotePane.path };
  $('#btn-sync').classList.add('active');
  log('info', `Synchronized browsing enabled (${app.syncRoots.local} <-> ${app.syncRoots.remote})`);
}

/* -------------------------------------------------- directory comparison */

function applyCompare() {
  if (!app.compareOn || !app.localPane.path || !app.remotePane.path) {
    app.localPane.setCompare(null, false);
    app.remotePane.setCompare(null, false);
    return;
  }
  const left = new Map(app.localPane.items().map((i) => [i.name, i]));
  const right = new Map(app.remotePane.items().map((i) => [i.name, i]));
  const threshold = (Number(app.settings.compareThreshold) || 0) * 60000;

  const build = (mine, other) => {
    const map = new Map();
    for (const [name, item] of mine) {
      const o = other.get(name);
      if (!o) { map.set(name, 'only'); continue; }
      if (item.isDir || o.isDir) { map.set(name, 'same'); continue; }
      let diff = false;
      let newer = false;
      if (app.settings.compareBySize && Number(item.size) !== Number(o.size)) diff = true;
      if (app.settings.compareByTime && item.mtime && o.mtime && Math.abs(item.mtime - o.mtime) > threshold) {
        diff = true;
        if (item.mtime > o.mtime) newer = true;
      }
      map.set(name, diff ? (newer ? 'newer' : 'diff') : 'same');
    }
    return map;
  };

  app.localPane.setCompare(build(left, right), app.settings.hideIdentical);
  app.remotePane.setCompare(build(right, left), app.settings.hideIdentical);
}

function toggleCompare() {
  app.compareOn = !app.compareOn;
  $('#btn-compare').classList.toggle('active', app.compareOn);
  log('info', 'Directory comparison ' + (app.compareOn ? 'enabled' : 'disabled'));
  applyCompare();
}

/* =========================================================== transfers */

async function download(entries) {
  if (!entries.length) return;
  if (!app.status.connected) { L.toast('Not connected to any server.', 'warn'); return; }
  const res = await window.api.queue.download(on({ entries, localDir: app.localPane.path }));
  if (L.unwrap(res, 'Download') !== null) setTimeout(() => navigateLocal(app.localPane.path, true), 400);
}

async function upload(entries) {
  if (!entries.length) return;
  if (!app.status.connected) { L.toast('Not connected to any server.', 'warn'); return; }
  const res = await window.api.queue.upload(on({ entries, remoteDir: app.remotePane.path }));
  if (L.unwrap(res, 'Upload') !== null) setTimeout(() => navigateRemote(app.remotePane.path, true), 400);
}

/* ============================================================ view/edit */

async function viewEdit(entry, opts) {
  const options = opts || {};
  const res = await window.api.edit.open(on({
    remotePath: entry.remotePath,
    size: entry.size,
    isDir: entry.isDir,
    force: options.force,
    reopen: options.reopen,
  }));

  if (res.ok) {
    L.toast(`Opened in ${res.data.editor}.\nSave karte hi server par upload ho jayega.`, 'ok');
    refreshEditedPaths();
    return;
  }

  if (res.code === 'ALREADY_EDITING') {
    const choice = await L.modal({
      title: 'Selected file already being edited',
      narrow: true,
      body: el('div', {}, [
        el('p', { text: 'The selected file is already being edited:', style: 'margin:0 0 4px' }),
        el('p', { style: 'margin:0 0 10px; font-family:var(--mono); font-size:12px', text: entry.remotePath }),
        el('p', { class: 'hint', text: 'What do you want to do?' }),
      ]),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Discard local file and download anew', value: 'fresh' },
        { label: 'Reopen local file', value: 'reopen', primary: true },
      ],
    });
    if (choice === 'reopen') await viewEdit(entry, { reopen: true });
    if (choice === 'fresh') await viewEdit(entry, { force: true });
    return;
  }

  L.toast(res.error, 'error');
}

async function refreshEditedPaths() {
  const paths = L.unwrap(await window.api.edit.editedPaths(on()));
  if (paths) {
    app.editedPaths = paths;
    app.remotePane.setEditing(paths);
    updateEditedCount();
  }
}

function updateEditedCount() {
  const badge = $('#edited-count');
  const n = app.editSessions.length || app.editedPaths.length;
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

/** "Files currently being edited" dialog. */
async function showBeingEdited() {
  const sessions = L.unwrap(await window.api.edit.list(on())) || [];
  const body = el('div');

  if (!sessions.length) {
    body.append(el('p', { text: 'No files are currently being edited.', style: 'margin:0' }));
  } else {
    body.append(el('p', { class: 'hint', text: 'The following files are currently being edited:', style: 'margin:0 0 8px' }));
    const table = el('table', { class: 'plain' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Remote file' }),
        el('th', { text: 'Editor' }),
        el('th', { text: 'Uploads' }),
        el('th', { text: 'Status' }),
        el('th', { text: '' }),
      ])]),
    ]);
    const tb = el('tbody');
    for (const s of sessions) {
      const act = (label, fn) => el('button', {
        class: 'link', text: label,
        onclick: async () => { await fn(); L.closeModal('refresh'); },
      });
      tb.append(el('tr', {}, [
        el('td', { title: s.remotePath }, [s.name]),
        el('td', { text: s.editor || '' }),
        el('td', { text: String(s.uploads) }),
        el('td', { text: s.status }),
        el('td', {}, [
          act('Upload and unedit', () => window.api.edit.upload(on({ localPath: s.localPath, unedit: true }))),
          act('Reopen', () => window.api.edit.reopen(on({ localPath: s.localPath }))),
          act('Finish editing', () => window.api.edit.stop(on({ localPath: s.localPath, deleteLocal: false }))),
          act('Finish + delete local', () => window.api.edit.stop(on({ localPath: s.localPath, deleteLocal: true }))),
          act('Re-download', () => window.api.edit.redownload(on({ localPath: s.localPath }))),
        ]),
      ]));
    }
    table.append(tb);
    body.append(table);
  }

  const res = await L.modal({
    title: 'Files currently being edited',
    body,
    buttons: [{ label: 'Close', value: null }],
  });
  refreshEditedPaths();
  if (res === 'refresh') showBeingEdited();
}

/* ====================================================== file operations */

async function doMkdir(side, enter) {
  const pane = side === 'local' ? app.localPane : app.remotePane;
  const name = await L.promptText({ title: 'Create directory', label: 'Please enter the name of the directory:', value: 'New directory' });
  if (!name) return;
  const api = side === 'local' ? window.api.local : window.api.remote;
  const res = await api.mkdir(side === 'local' ? { path: pane.path, name } : on({ path: pane.path, name }));
  const full = L.unwrap(res, 'Create directory');
  if (full === null) return;
  if (enter) {
    if (side === 'local') await navigateLocal(full); else await navigateRemote(full);
  } else if (side === 'local') await navigateLocal(pane.path, true);
  else await navigateRemote(pane.path, true);
}

async function doCreateFile(side) {
  const pane = side === 'local' ? app.localPane : app.remotePane;
  const name = await L.promptText({ title: 'Create empty file', label: 'Please enter the name of the file:', value: 'new.txt' });
  if (!name) return;
  const api = side === 'local' ? window.api.local : window.api.remote;
  const createPayload = side === 'local' ? { path: pane.path, name } : on({ path: pane.path, name });
  if (L.unwrap(await api.createFile(createPayload), 'Create file') === null) return;
  if (side === 'local') await navigateLocal(pane.path, true); else await navigateRemote(pane.path, true);
}

async function doRename(side, entry) {
  const pane = side === 'local' ? app.localPane : app.remotePane;
  const name = await L.promptText({ title: 'Rename', label: 'Please enter the new name:', value: entry.name });
  if (!name || name === entry.name) return;
  const from = side === 'local' ? entry.localPath : entry.remotePath;
  const to = pane.joinPath(pane.path, name);
  const api = side === 'local' ? window.api.local : window.api.remote;
  const renamePayload = side === 'local' ? { from, to } : on({ from, to });
  if (L.unwrap(await api.rename(renamePayload), 'Rename') === null) return;
  if (side === 'local') await navigateLocal(pane.path, true); else await navigateRemote(pane.path, true);
}

async function doDelete(side, entries) {
  if (!entries.length) return;
  if (app.settings.confirmDelete) {
    const names = entries.slice(0, 8).map((e) => e.name).join('\n');
    const more = entries.length > 8 ? `\n... and ${entries.length - 8} more` : '';
    const ok = await L.confirm({
      title: 'Delete selected files and directories',
      message: `Really delete ${entries.length} item${entries.length > 1 ? 's' : ''}?\n\n${names}${more}`,
      ok: 'Delete',
      danger: true,
    });
    if (!ok) return;
  }
  if (side === 'local') {
    const targets = entries.map((e) => e.localPath);
    if (L.unwrap(await window.api.local.remove({ targets, useTrash: true }), 'Delete') === null) return;
    log('ok', `Moved ${targets.length} item(s) to Trash`);
    await navigateLocal(app.localPane.path, true);
  } else {
    const payload = entries.map((e) => ({ path: e.remotePath, isDir: e.isDir }));
    if (L.unwrap(await window.api.remote.remove(on({ entries: payload })), 'Delete') === null) return;
    await navigateRemote(app.remotePane.path, true);
  }
}

async function doChmod(entries) {
  if (!entries.length) return;
  const first = app.remotePane.items().find((i) => i.name === entries[0].name);
  const current = first && first.mode !== null && first.mode !== undefined ? L.modeToOctal(first.mode) : '644';

  const input = el('input', { value: current, size: 6, style: 'font-family:var(--mono)' });
  const boxes = {};
  const mk = (key, label) => {
    boxes[key] = el('input', { type: 'checkbox' });
    return el('label', { class: 'inline' }, [boxes[key], label]);
  };
  const grid = el('div', { class: 'grid' }, [
    el('label', { text: 'Numeric value:' }), input,
    el('label', { text: 'Owner permissions:' }), el('div', { class: 'row' }, [mk('ur', 'Read'), mk('uw', 'Write'), mk('ux', 'Execute')]),
    el('label', { text: 'Group permissions:' }), el('div', { class: 'row' }, [mk('gr', 'Read'), mk('gw', 'Write'), mk('gx', 'Execute')]),
    el('label', { text: 'Public permissions:' }), el('div', { class: 'row' }, [mk('or', 'Read'), mk('ow', 'Write'), mk('ox', 'Execute')]),
  ]);

  const order = ['ur', 'uw', 'ux', 'gr', 'gw', 'gx', 'or', 'ow', 'ox'];
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const fromInput = () => {
    const mode = L.octalToMode(input.value);
    if (mode === null) return;
    order.forEach((k, i) => { boxes[k].checked = Boolean(mode & bits[i]); });
  };
  const toInput = () => {
    let mode = 0;
    order.forEach((k, i) => { if (boxes[k].checked) mode |= bits[i]; });
    input.value = L.modeToOctal(mode);
  };
  input.oninput = fromInput;
  order.forEach((k) => { boxes[k].onchange = toInput; });
  fromInput();

  const body = el('div', {}, [
    el('p', { class: 'hint', text: entries.length === 1 ? entries[0].name : `${entries.length} items selected`, style: 'margin:0 0 10px' }),
    grid,
  ]);
  const res = await L.modal({
    title: 'File permissions',
    body,
    narrow: true,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }],
  });
  if (res !== 'ok') return;
  const mode = L.octalToMode(input.value);
  if (mode === null) { L.toast('Numeric value must be 3 octal digits, e.g. 644', 'error'); return; }
  for (const e of entries) {
    if (L.unwrap(await window.api.remote.chmod(on({ path: e.remotePath, mode })), 'chmod') === null) break;
  }
  await navigateRemote(app.remotePane.path, true);
}

function remoteUrl(entry, withPassword) {
  const info = app.status.info;
  if (!info) return entry.remotePath;
  const auth = withPassword
    ? `${encodeURIComponent(info.user || '')}@`
    : info.user ? `${encodeURIComponent(info.user)}@` : '';
  const scheme = info.protocol === 'sftp' ? 'sftp' : info.protocol === 'ftps' ? 'ftps' : 'ftp';
  return `${scheme}://${auth}${info.host}:${info.port}${entry.remotePath}`;
}

/* ========================================================= context menus */

function localMenu(event, entries) {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);
  L.ctx(event.clientX, event.clientY, [
    entries.length && { label: 'Upload', action: () => upload(entries) },
    files.length === 1 && { label: 'Open', action: () => window.api.local.open({ path: files[0].localPath }) },
    entries.length === 1 && { label: 'Show in Finder', action: () => window.api.local.reveal({ path: entries[0].localPath }) },
    entries.length && 'sep',
    { label: 'Create directory', action: () => doMkdir('local', false) },
    { label: 'Create directory and enter it', action: () => doMkdir('local', true) },
    { label: 'Create empty file', action: () => doCreateFile('local') },
    'sep',
    entries.length === 1 && { label: 'Rename', accel: 'F2', action: () => doRename('local', entries[0]) },
    entries.length && { label: 'Delete', accel: '⌫', action: () => doDelete('local', entries) },
    entries.length && 'sep',
    { label: 'Open directory in Finder', action: () => window.api.local.reveal({ path: app.localPane.path }) },
    { label: 'Refresh', accel: 'F5', action: () => navigateLocal(app.localPane.path, true) },
    dirs.length || files.length ? null : null,
  ].filter(Boolean));
}

function remoteMenu(event, entries) {
  const files = entries.filter((e) => !e.isDir);
  const connected = app.status.connected;
  L.ctx(event.clientX, event.clientY, [
    files.length === 1 && { label: 'View / Edit', accel: '⏎', action: () => viewEdit(files[0]) },
    entries.length && { label: 'Download', action: () => download(entries) },
    entries.length && 'sep',
    { label: 'Create directory', disabled: !connected, action: () => doMkdir('remote', false) },
    { label: 'Create directory and enter it', disabled: !connected, action: () => doMkdir('remote', true) },
    { label: 'Create empty file', disabled: !connected, action: () => doCreateFile('remote') },
    'sep',
    entries.length === 1 && { label: 'Rename', accel: 'F2', action: () => doRename('remote', entries[0]) },
    entries.length && { label: 'Delete', accel: '⌫', action: () => doDelete('remote', entries) },
    entries.length && { label: 'File permissions...', disabled: !app.status.supportsChmod, action: () => doChmod(entries) },
    entries.length && 'sep',
    entries.length && { label: 'Copy URL(s) to clipboard', action: () => window.api.misc.copy({ text: entries.map((e) => remoteUrl(e, false)).join('\n') }) },
    { label: 'Refresh', accel: 'F5', action: () => navigateRemote(app.remotePane.path, true) },
  ].filter(Boolean));
}

/* ============================================================== the queue */

/** Transfers from every tab, tagged with the server they belong to. */
function allQueueItems() {
  const out = [];
  for (const [sessionId, items] of app.queues) {
    const tab = app.tabs.find((t) => t.id === sessionId);
    for (const item of items) {
      out.push(Object.assign({ sessionId, server: tab && tab.connected ? tab.title : '' }, item));
    }
  }
  return out;
}

function queueBuckets() {
  const all = allQueueItems();
  return {
    queued: all.filter((q) => q.status === 'queued' || q.status === 'active'),
    failed: all.filter((q) => q.status === 'error' || q.status === 'cancelled'),
    done: all.filter((q) => q.status === 'done' || q.status === 'skipped'),
  };
}

function renderQueue() {
  const buckets = queueBuckets();
  $$('#queue .tab').forEach((t) => {
    t.querySelector('.count').textContent = buckets[t.dataset.tab].length;
    t.classList.toggle('active', t.dataset.tab === app.queueTab);
  });

  const tbody = $('#queue-table tbody');
  tbody.innerHTML = '';
  const rows = buckets[app.queueTab];

  if (!rows.length) {
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: 7, text: 'Queue is empty' })]));
  }

  for (const item of rows) {
    const pct = item.size ? Math.min(100, Math.round((item.transferred / item.size) * 100)) : 0;
    const statusCell = el('td', { class: 'status' });
    if (item.status === 'active') {
      statusCell.append(el('div', { class: 'progress', dataset: { id: item.id } }, [
        el('i', { style: 'width:' + pct + '%' }),
        el('span', { text: pct + '%' }),
      ]));
    } else {
      statusCell.append(el('span', {
        class: 'st-' + item.status,
        text: item.status === 'error' ? 'Error: ' + item.error : item.status,
        title: item.error || '',
      }));
    }

    tbody.append(el('tr', { dataset: { id: item.id } }, [
      el('td', { title: `${item.server ? item.server + ' — ' : ''}${item.localPath}` }, [
        item.server && app.tabs.length > 1 ? el('span', { class: 'server-tag', text: item.server }) : null,
        item.localPath,
      ]),
      el('td', { class: 'dir', text: item.direction === 'down' ? '<<--' : '-->>' }),
      el('td', { title: item.remotePath, text: item.remotePath }),
      el('td', { class: 'num', text: L.fmtSize(item.size) }),
      el('td', { text: 'Normal' }),
      statusCell,
      el('td', {}, [
        item.status === 'queued' || item.status === 'active'
          ? el('button', { class: 'link', text: 'cancel', onclick: () => window.api.queue.cancel({ sessionId: item.sessionId, id: item.id }) })
          : null,
      ]),
    ]));
  }

  const active = buckets.queued.length;
  $('#status-queue').textContent = active
    ? `${active} transfer${active > 1 ? 's' : ''} in queue`
    : (buckets.done.length ? `${buckets.done.length} successful transfer${buckets.done.length > 1 ? 's' : ''}` : '');
}

function patchProgress(sessionId, id, transferred, size) {
  const items = app.queues.get(sessionId) || [];
  const item = items.find((q) => q.id === id);
  if (item) { item.transferred = transferred; if (size) item.size = size; }
  const bar = $(`#queue-table .progress[data-id="${id}"]`);
  if (!bar || !size) return;
  const pct = Math.min(100, Math.round((transferred / size) * 100));
  bar.querySelector('i').style.width = pct + '%';
  bar.querySelector('span').textContent = pct + '%';
}

/* ======================================================== site manager */

async function showSiteManager(prefill) {
  app.sites = L.unwrap(await window.api.sites.list()) || [];
  let folders = L.unwrap(await window.api.sites.folders()) || [];
  let selectedId = app.lastSiteId && app.sites.some((x) => x.id === app.lastSiteId)
    ? app.lastSiteId
    : (app.sites[0] && app.sites[0].id) || null;
  let draft = null;              // unsaved "New site" / prefilled entry
  let filter = '';
  let revealSelected = true;     // open the selected site's folder once, not on every repaint
  let scrollTo = 'selected';     // 'selected' | 'top' | null (keep where the user is)

  const filterInput = el('input', {
    placeholder: 'filter sites...', style: 'flex:1; min-width:0',
    oninput: () => {
      filter = filterInput.value.trim().toLowerCase();
      scrollTo = 'top';
      renderList();
    },
  });
  const expandAllBtn = el('button', {
    class: 'icon', text: '⊞', title: 'Expand all folders',
    onclick: () => {
      for (const f of folders) app.siteFolderExpanded.add(f);
      scrollTo = 'selected';
      renderList();
    },
  });
  const collapseAllBtn = el('button', {
    class: 'icon', text: '⊟', title: 'Collapse all folders',
    onclick: () => {
      app.siteFolderExpanded.clear();
      scrollTo = 'top';
      renderList();
    },
  });
  const filterRow = el('div', { class: 'row' }, [filterInput, expandAllBtn, collapseAllBtn]);
  const counter = el('div', { class: 'site-count' });
  const list = el('div', { class: 'list tree' });
  list.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/plain')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (id) moveSiteTo(id, '');
  });
  const detail = el('div', { class: 'detail' });
  const body = el('div', { class: 'cols' }, [
    el('div', { class: 'sites-col' }, [filterRow, list, counter]),
    detail,
  ]);

  const fields = {};

  function currentSite() {
    if (draft) return draft;
    return app.sites.find((s) => s.id === selectedId) || null;
  }

  /* ------------------------------------------------- the folder tree */

  function buildTree() {
    const root = { name: '', path: '', folders: new Map(), sites: [] };
    const ensure = (folderPath) => {
      if (!folderPath) return root;
      let node = root;
      let acc = '';
      for (const part of folderPath.split('/')) {
        acc = acc ? acc + '/' + part : part;
        if (!node.folders.has(part)) {
          node.folders.set(part, { name: part, path: acc, folders: new Map(), sites: [] });
        }
        node = node.folders.get(part);
      }
      return node;
    };
    for (const f of folders) ensure(f);
    for (const site of visibleSites()) ensure(site.folder || '').sites.push(site);
    return root;
  }

  function visibleSites() {
    if (!filter) return app.sites;
    return app.sites.filter((s) => [s.name, s.host, s.user, s.folder, s.remotePath]
      .some((v) => String(v || '').toLowerCase().includes(filter)));
  }

  function countSites(node) {
    let n = node.sites.length;
    for (const child of node.folders.values()) n += countSites(child);
    return n;
  }

  const isExpanded = (path) => Boolean(filter) || app.siteFolderExpanded.has(path);

  async function moveSiteTo(siteId, folderPath) {
    const site = app.sites.find((s) => s.id === siteId);
    if (!site || (site.folder || '') === folderPath) return;
    if (L.unwrap(await window.api.sites.setFolder({ id: siteId, folder: folderPath }), 'Move site') === null) return;
    app.sites = L.unwrap(await window.api.sites.list()) || [];
    if (folderPath) app.siteFolderExpanded.add(folderPath);
    renderList();
    renderDetail();
    L.toast(`"${site.name}" ${folderPath ? 'moved to ' + folderPath : 'moved to top level'}`, 'ok');
  }

  async function newFolder(parentPath) {
    const name = await L.promptText({
      title: parentPath ? 'New folder inside ' + parentPath : 'New folder',
      label: 'Folder name:',
      value: 'New folder',
    });
    if (!name) return;
    const full = parentPath ? parentPath + '/' + name : name;
    if (L.unwrap(await window.api.sites.addFolder({ name: full }), 'New folder') === null) return;
    folders = L.unwrap(await window.api.sites.folders()) || [];
    app.siteFolderExpanded.add(full);
    if (parentPath) app.siteFolderExpanded.add(parentPath);
    renderList();
  }

  async function renameFolder(folderPath) {
    const parts = folderPath.split('/');
    const name = await L.promptText({ title: 'Rename folder', label: 'New name:', value: parts[parts.length - 1] });
    if (!name) return;
    parts[parts.length - 1] = name;
    const target = parts.join('/');
    if (L.unwrap(await window.api.sites.renameFolder({ from: folderPath, to: target }), 'Rename folder') === null) return;
    folders = L.unwrap(await window.api.sites.folders()) || [];
    app.sites = L.unwrap(await window.api.sites.list()) || [];
    app.siteFolderExpanded.delete(folderPath);
    app.siteFolderExpanded.add(target);
    renderList();
    renderDetail();
  }

  async function deleteFolder(folderPath, siteCount) {
    const ok = await L.confirm({
      title: 'Delete folder',
      message: siteCount
        ? `"${folderPath}" delete karein?\n\n${siteCount} site(s) delete nahi hongi - wo top level par chali jayengi.`
        : `"${folderPath}" delete karein?`,
      ok: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    const res = L.unwrap(await window.api.sites.removeFolder({ name: folderPath }), 'Delete folder');
    if (!res) return;
    folders = res.folders;
    app.sites = L.unwrap(await window.api.sites.list()) || [];
    renderList();
    renderDetail();
    if (res.movedToTop) L.toast(`${res.movedToTop} site(s) moved to top level`, 'ok');
  }

  function folderRow(node, depth) {
    const open = isExpanded(node.path);
    const total = countSites(node);
    const row = el('button', {
      class: 'folder-row' + (open ? ' open' : ''),
      style: `padding-left:${8 + depth * 14}px`,
      title: node.path,
      onclick: () => {
        if (app.siteFolderExpanded.has(node.path)) app.siteFolderExpanded.delete(node.path);
        else app.siteFolderExpanded.add(node.path);
        renderList();
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        L.ctx(e.clientX, e.clientY, [
          { label: 'New subfolder...', action: () => newFolder(node.path) },
          { label: 'Rename folder...', action: () => renameFolder(node.path) },
          'sep',
          { label: 'Delete folder', action: () => deleteFolder(node.path, total) },
        ]);
      },
    }, [
      el('span', { class: 'caret', text: open ? '\u2212' : '+', title: open ? 'Collapse' : 'Expand' }),
      el('span', { class: 'folder-icon', text: open ? '📂' : '📁' }),
      el('span', { class: 'folder-name', text: node.name }),
      el('span', { class: 'folder-count', text: String(total) }),
    ]);

    // drop a site here to move it into this folder
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drop-target');
      const id = e.dataTransfer.getData('text/plain');
      if (id) moveSiteTo(id, node.path);
    });
    return row;
  }

  function siteRow(site, depth) {
    const row = el('button', {
      class: 'site-row' + (site.id === selectedId && !draft ? ' active' : ''),
      style: `padding-left:${8 + depth * 14}px`,
      draggable: true,
      title: `${site.user}@${site.host}:${site.port}${site.remotePath ? ' -> ' + site.remotePath : ''}`,
      onclick: () => {
        draft = null;
        selectedId = site.id;
        app.lastSiteId = site.id;
        renderList();
        renderDetail();
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        L.ctx(e.clientX, e.clientY, [
          { label: 'Connect', action: () => L.closeModal({ connect: site.id }) },
          'sep',
          { label: 'Move to top level', disabled: !site.folder, action: () => moveSiteTo(site.id, '') },
          ...folders.map((f) => ({
            label: 'Move to ' + f,
            disabled: (site.folder || '') === f,
            action: () => moveSiteTo(site.id, f),
          })).slice(0, 12),
        ]);
      },
    }, [
      el('span', { class: 'site-name', text: site.name || site.host }),
      el('small', { text: `${site.host}${site.remotePath ? '  ' + site.remotePath : ''}` }),
    ]);
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', site.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    return row;
  }

  function renderNode(node, depth) {
    const folderNames = Array.from(node.folders.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of folderNames) {
      const child = node.folders.get(name);
      if (filter && countSites(child) === 0) continue;
      list.append(folderRow(child, depth));
      if (isExpanded(child.path)) renderNode(child, depth + 1);
    }
    const sorted = node.sites.slice().sort((a, b) => String(a.name || a.host).localeCompare(String(b.name || b.host)));
    for (const site of sorted) list.append(siteRow(site, depth));
  }

  function renderList() {
    // Rebuilding the tree must not throw the user back to the top of the list.
    const keepScroll = list.scrollTop;
    list.innerHTML = '';
    const tree = buildTree();

    // Reveal the selected site when the dialog opens or the list reloads,
    // but never fight the user's own expand/collapse clicks afterwards.
    const selected = app.sites.find((s) => s.id === selectedId);
    if (revealSelected && selected && selected.folder) {
      const parts = selected.folder.split('/');
      for (let i = 1; i <= parts.length; i += 1) app.siteFolderExpanded.add(parts.slice(0, i).join('/'));
    }
    revealSelected = false;

    renderNode(tree, 0);

    // Put the scroll back where it was, or bring the selected site into view.
    const activeRow = list.querySelector('.site-row.active');
    if (scrollTo === 'top') {
      list.scrollTop = 0;
    } else if (scrollTo === 'selected' && activeRow) {
      activeRow.scrollIntoView({ block: 'center' });
    } else {
      list.scrollTop = keepScroll;
    }
    scrollTo = null;

    const shown = visibleSites().length;
    if (!shown && !folders.length) {
      list.append(el('p', { class: 'hint', style: 'padding:8px', text: app.sites.length ? 'No match.' : 'No sites yet. Import from FileZilla, or press "New site".' }));
    }
    counter.textContent = filter
      ? `${shown} of ${app.sites.length} sites`
      : `${app.sites.length} site${app.sites.length === 1 ? '' : 's'} in ${folders.length} folder${folders.length === 1 ? '' : 's'}`;
  }

  /* --------------------------------------------------------- the detail */

  function renderDetail() {
    const site = currentSite();
    detail.innerHTML = '';
    if (!site) {
      detail.append(el('p', { class: 'hint', text: 'Select a site on the left, press "New site", or import your FileZilla entries.' }));
      return;
    }

    const put = (key, node) => { fields[key] = node; return node; };

    const protocol = put('protocol', el('select', {}, [
      el('option', { value: 'sftp', text: 'SFTP - SSH File Transfer Protocol' }),
      el('option', { value: 'ftp', text: 'FTP - File Transfer Protocol' }),
      el('option', { value: 'ftps', text: 'FTPS - FTP over TLS' }),
    ]));
    protocol.value = site.protocol || 'sftp';

    const authType = put('authType', el('select', {}, [
      el('option', { value: 'password', text: 'Normal (password)' }),
      el('option', { value: 'key', text: 'Key file' }),
      el('option', { value: 'agent', text: 'SSH agent' }),
    ]));
    authType.value = site.authType || 'password';

    const keyInput = put('keyPath', el('input', { value: site.keyPath || '', style: 'flex:1' }));
    const localInput = put('localPath', el('input', { value: site.localPath || '', style: 'flex:1' }));
    const remoteInput = put('remotePath', el('input', { value: site.remotePath || '', placeholder: '/var/www/html', style: 'font-family:var(--mono)' }));
    const syncBox = put('syncBrowsing', el('input', { type: 'checkbox', checked: Boolean(site.syncBrowsing) }));

    detail.append(
      el('fieldset', {}, [
        el('legend', { text: 'General' }),
        el('div', { class: 'grid' }, [
          el('label', { text: 'Name:' }), put('name', el('input', { value: site.name || '' })),
          el('label', { text: 'Folder:' }), put('folder', el('input', { value: site.folder || '', placeholder: 'optional group' })),
          el('label', { text: 'Protocol:' }), protocol,
          el('label', { text: 'Host:' }), put('host', el('input', { value: site.host || '' })),
          el('label', { text: 'Port:' }), put('port', el('input', { value: site.port || '', size: 6, placeholder: 'default' })),
          el('label', { text: 'Logon Type:' }), authType,
          el('label', { text: 'User:' }), put('user', el('input', { value: site.user || '' })),
          el('label', { text: 'Password:' }), put('password', el('input', {
            type: 'password',
            placeholder: site.hasPassword ? '(saved in keychain - leave blank to keep)' : '',
          })),
          el('label', { text: 'Key file:' }), el('div', { class: 'row' }, [keyInput, el('button', {
            text: 'Browse...',
            onclick: async () => { const f = L.unwrap(await window.api.local.pickFile()); if (f) keyInput.value = f; },
          })]),
        ]),
      ]),
      el('fieldset', {}, [
        el('legend', { text: 'Advanced' }),
        el('div', { class: 'grid' }, [
          el('label', { text: 'Default remote directory:' }), remoteInput,
          el('div', { class: 'full' }, [el('p', { class: 'hint', style: 'margin:0', text: 'Connect hote hi seedha isi path par khul jayega. Path na mile to server ka home khulega aur log me warning aayegi.' })]),
          el('label', { text: 'Default local directory:' }), el('div', { class: 'row' }, [localInput, el('button', {
            text: 'Browse...',
            onclick: async () => { const d = L.unwrap(await window.api.local.pickDir()); if (d) localInput.value = d; },
          })]),
          el('div', { class: 'full' }, [el('label', { class: 'inline' }, [syncBox, 'Use synchronized browsing on connect'])]),
          el('label', { text: 'Comments:' }), put('comments', el('textarea', { rows: 2, style: 'width:100%', value: site.comments || '' })),
        ]),
      ]),
    );
  }

  function collect() {
    const site = currentSite() || {};
    return {
      id: draft ? null : site.id || null,
      name: fields.name.value.trim() || fields.host.value.trim(),
      folder: fields.folder.value.trim(),
      protocol: fields.protocol.value,
      host: fields.host.value.trim(),
      port: fields.port.value.trim(),
      user: fields.user.value.trim(),
      authType: fields.authType.value,
      password: fields.password.value,
      keyPath: fields.keyPath.value.trim(),
      remotePath: fields.remotePath.value.trim(),
      localPath: fields.localPath.value.trim(),
      syncBrowsing: fields.syncBrowsing.checked,
      comments: fields.comments.value.trim(),
    };
  }

  async function save() {
    if (!currentSite()) { L.toast('Select or create a site first', 'warn'); return null; }
    const data = collect();
    if (!data.host) { L.toast('Host is required', 'error'); return null; }
    const saved = L.unwrap(await window.api.sites.save(data), 'Save site');
    if (!saved) return null;
    app.sites = L.unwrap(await window.api.sites.list()) || [];
    draft = null;
    selectedId = saved.id;
    app.lastSiteId = saved.id;
    renderList();
    renderDetail();
    return saved;
  }

  async function reload(keepId) {
    app.sites = L.unwrap(await window.api.sites.list()) || [];
    folders = L.unwrap(await window.api.sites.folders()) || [];
    draft = null;
    revealSelected = true;
    scrollTo = 'selected';
    selectedId = keepId || (app.sites[0] && app.sites[0].id) || null;
    app.lastSiteId = selectedId;
    renderList();
    renderDetail();
  }

  /* ------------------------------------------------- import from FileZilla */

  async function importFromFileZilla() {
    const info = L.unwrap(await window.api.filezilla.detect(), 'FileZilla');
    if (!info) return;

    let sourcePath = info.found ? info.path : null;
    const summary = el('div');

    if (info.found) {
      summary.append(
        el('p', { style: 'margin:0 0 8px', text: `${info.count} sites mile FileZilla ${info.version} me.` }),
        el('p', { class: 'hint', style: 'margin:0 0 4px; font-family:var(--mono); font-size:11.5px', text: info.path }),
        el('p', { class: 'hint', style: 'margin:0 0 10px', text: `${info.folders.length} folders - ${info.withRemotePath} sites me remote path set hai - ${info.withPassword} me password hai.` }),
      );
    } else {
      summary.append(el('p', { style: 'margin:0 0 10px', text: 'FileZilla ki sitemanager.xml automatically nahi mili. File khud choose kar lein.' }));
    }

    const withPasswords = el('input', { type: 'checkbox', checked: true });
    const skipExisting = el('input', { type: 'checkbox' });
    summary.append(
      el('div', {}, [el('label', { class: 'inline' }, [withPasswords, 'Passwords bhi import karo (Keychain me encrypted rahenge)'])]),
      el('div', {}, [el('label', { class: 'inline' }, [skipExisting, 'Pehle se maujood sites ko chhod do (overwrite na karo)'])]),
    );

    const choice = await L.modal({
      title: 'Import FileZilla site entries',
      body: summary,
      narrow: true,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Choose file...', value: 'pick' },
        info.found ? { label: 'Import', value: 'go', primary: true } : null,
      ].filter(Boolean),
    });

    if (!choice) return;
    if (choice === 'pick') {
      sourcePath = L.unwrap(await window.api.filezilla.pickFile());
      if (!sourcePath) return;
    }

    const res = L.unwrap(await window.api.filezilla.import({
      path: sourcePath,
      withPasswords: withPasswords.checked,
      skipExisting: skipExisting.checked,
    }), 'Import');
    if (!res) return;

    await reload(selectedId);
    const skippedNote = res.skipped && res.skipped.length ? `\n${res.skipped.length} entries skip hui (dekho message log).` : '';
    L.toast(`Import done: ${res.added} naye, ${res.updated} update, ${res.unchanged} unchanged.${skippedNote}`, 'ok', 6000);
  }

  async function exportSites() {
    if (!app.sites.length) { L.toast('Export karne ke liye koi site nahi hai', 'warn'); return; }
    const withPasswords = el('input', { type: 'checkbox', checked: true });
    const choice = await L.modal({
      title: 'Export Site Manager entries',
      narrow: true,
      body: el('div', {}, [
        el('p', { style: 'margin:0 0 10px', text: `${app.sites.length} sites FileZilla ke format (sitemanager.xml) me save hongi — FileZilla ya kisi dusre machine par import ho jayengi.` }),
        el('div', {}, [el('label', { class: 'inline' }, [withPasswords, 'Passwords bhi include karo'])]),
        el('p', { class: 'hint', text: 'Dhyan rakhein: FileZilla format me password base64 me hota hai, encrypted nahi. File ko sambhal kar rakhein.' }),
      ]),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Export...', value: 'go', primary: true }],
    });
    if (choice !== 'go') return;

    const res = L.unwrap(await window.api.filezilla.export({ withPasswords: withPasswords.checked }), 'Export');
    if (res) L.toast(`${res.count} sites export ho gayi:\n${res.path}`, 'ok', 6000);
  }

  /* ---------------------------------------------------------------- open */

  renderList();
  if (prefill) {
    draft = Object.assign({ protocol: 'sftp', authType: 'password', port: 22 }, prefill);
  }
  renderDetail();

  // The list is only in the DOM once the dialog is shown, so reveal then.
  setTimeout(() => {
    revealSelected = true;
    scrollTo = 'selected';
    renderList();
  }, 30);

  const res = await L.modal({
    title: 'Site Manager',
    body,
    buttons: [
      {
        label: 'New site',
        keep: true,
        onClick: () => {
          draft = { name: '', protocol: 'sftp', authType: 'password', port: 22, folder: '' };
          renderList();
          renderDetail();
        },
      },
      { label: 'New folder', keep: true, onClick: () => { newFolder(''); return false; } },
      { label: 'Import...', keep: true, onClick: () => { importFromFileZilla(); return false; } },
      { label: 'Export...', keep: true, onClick: () => { exportSites(); return false; } },
      {
        label: 'Delete',
        keep: true,
        danger: true,
        onClick: async () => {
          const site = currentSite();
          if (!site || !site.id) return false;
          if (!(await L.confirm({ title: 'Delete Site Manager entry', message: `Delete "${site.name}"?`, ok: 'Delete', danger: true }))) return false;
          await window.api.sites.remove({ id: site.id });
          await reload();
          return false;
        },
      },
      'spacer',
      { label: 'Cancel', value: null },
      { label: 'Save', keep: true, onClick: async () => { if (await save()) L.toast('Site saved', 'ok'); return false; } },
      {
        label: 'Connect',
        primary: true,
        keep: true,
        onClick: async () => {
          const saved = await save();
          if (saved) L.closeModal({ connect: saved.id });
          return false;
        },
      },
    ],
  });

  if (res && res.connect) await connectSite(res.connect);
}

/* ============================================================= settings */

async function showSettings() {
  const s = Object.assign({}, app.settings);
  app.detectedEditors = L.unwrap(await window.api.settings.editors()) || [];

  const editorMode = el('select', {}, [
    el('option', { value: 'app', text: 'Use a custom program (installed app)' }),
    el('option', { value: 'command', text: 'Use a custom command' }),
    el('option', { value: 'system', text: "Use system's default editor for text files" }),
  ]);
  editorMode.value = s.editorMode;

  const editorApp = el('select', {},
    (app.detectedEditors.length ? app.detectedEditors : [{ label: s.editorApp || 'TextEdit', value: s.editorApp || 'TextEdit' }])
      .map((e) => el('option', { value: e.value, text: e.label })));
  if (s.editorApp) editorApp.value = s.editorApp;

  const editorCommand = el('input', { value: s.editorCommand || '', placeholder: 'code   /   subl -w   /   /usr/local/bin/code' });
  const alwaysDefault = el('input', { type: 'checkbox', checked: s.alwaysUseDefaultEditor });
  const useAssoc = el('input', { type: 'checkbox', checked: s.useFiletypeAssociations });
  const watchFiles = el('input', { type: 'checkbox', checked: s.watchEditedFiles });
  const uploadMode = el('select', {}, [
    el('option', { value: 'auto', text: 'Upload automatically when saved' }),
    el('option', { value: 'prompt', text: 'Ask me before uploading' }),
  ]);
  uploadMode.value = s.uploadOnSave;

  /* per-extension associations */
  const assocBox = el('div');
  let assocList = Array.isArray(s.associations) ? s.associations.slice() : [];
  function renderAssoc() {
    assocBox.innerHTML = '';
    assocList.forEach((a, idx) => {
      const ext = el('input', { value: a.ext || '', placeholder: 'php' });
      const mode = el('select', {}, [
        el('option', { value: 'app', text: 'App' }),
        el('option', { value: 'command', text: 'Command' }),
        el('option', { value: 'system', text: 'System' }),
      ]);
      mode.value = a.mode || 'app';
      const value = el('input', { value: a.value || '', placeholder: 'Visual Studio Code' });
      ext.oninput = () => { assocList[idx].ext = ext.value; };
      mode.onchange = () => { assocList[idx].mode = mode.value; };
      value.oninput = () => { assocList[idx].value = value.value; };
      assocBox.append(el('div', { class: 'assoc-row' }, [
        ext, mode, value,
        el('button', { class: 'link', text: 'remove', onclick: () => { assocList.splice(idx, 1); renderAssoc(); } }),
      ]));
    });
    assocBox.append(el('button', {
      class: 'link', text: '+ add association',
      onclick: () => { assocList.push({ ext: '', mode: 'app', value: '' }); renderAssoc(); },
    }));
    assocBox.append(el('p', { class: 'hint', text: 'Extension without the dot. Use "dotfile" for .env style files and "extensionless" for files without an extension.' }));
  }
  renderAssoc();

  const existing = el('select', {}, [
    el('option', { value: 'overwrite', text: 'Overwrite' }),
    el('option', { value: 'overwrite-different-size', text: 'Overwrite if different size' }),
    el('option', { value: 'overwrite-size-or-newer', text: 'Overwrite if different size or source newer' }),
    el('option', { value: 'rename', text: 'Rename' }),
    el('option', { value: 'skip', text: 'Skip' }),
  ]);
  existing.value = s.transferExisting;

  const maxTransfers = el('input', { value: String(s.maxTransfers || 2), size: 4 });
  const maxDownloads = el('input', { value: String(s.maxDownloads || 0), size: 4 });
  const maxUploads = el('input', { value: String(s.maxUploads || 0), size: 4 });

  const speedLimitEnabled = el('input', { type: 'checkbox', checked: s.speedLimitEnabled });
  const speedLimitDown = el('input', { value: String(s.speedLimitDown || 0), size: 6 });
  const speedLimitUp = el('input', { value: String(s.speedLimitUp || 0), size: 6 });

  const transferMode = el('select', {}, [
    el('option', { value: 'auto', text: 'Auto' }),
    el('option', { value: 'ascii', text: 'ASCII' }),
    el('option', { value: 'binary', text: 'Binary' }),
  ]);
  transferMode.value = s.transferMode || 'auto';
  const transferModeFallback = el('input', {
    type: 'checkbox', checked: s.transferModeFallback !== false,
  });
  const asciiExtensions = el('input', {
    value: (s.asciiExtensions || []).join(' '), style: 'flex:1',
    placeholder: 'leave empty for the built-in list',
  });
  const connectTimeout = el('input', { value: String(s.connectTimeout || 20), size: 4 });
  const confirmDelete = el('input', { type: 'checkbox', checked: s.confirmDelete });
  const showHidden = el('input', { type: 'checkbox', checked: s.showHiddenLocal });
  const timestamps = el('input', { type: 'checkbox', checked: s.showTimestamps });
  const compareSize = el('input', { type: 'checkbox', checked: s.compareBySize });
  const compareTime = el('input', { type: 'checkbox', checked: s.compareByTime });
  const threshold = el('input', { value: String(s.compareThreshold || 0), size: 5 });
  const hideIdentical = el('input', { type: 'checkbox', checked: s.hideIdentical });
  const defaultLocal = el('input', { value: s.defaultLocalPath || '', style: 'flex:1' });
  const tempDir = el('input', { value: s.editTempDir || '', placeholder: '(system temp folder)', style: 'flex:1' });

  const theme = el('select', {}, themeOptionNodes());
  theme.value = s.theme || 'system';
  theme.onchange = () => applyTheme(theme.value);   // live preview

  /* ---- background image ---- */
  const bgPath = el('input', { value: s.bgImage || '', placeholder: '(no background image)', readOnly: true, style: 'flex:1' });
  const bgFit = el('select', {}, [
    el('option', { value: 'cover', text: 'Fill the window (cover)' }),
    el('option', { value: 'contain', text: 'Fit inside (contain)' }),
    el('option', { value: 'center', text: 'Centre, original size' }),
    el('option', { value: 'tile', text: 'Tile' }),
  ]);
  bgFit.value = s.bgFit || 'cover';
  const bgVeil = el('input', { type: 'range', min: '50', max: '100', step: '1', value: String(s.bgVeil === undefined ? 86 : s.bgVeil), style: 'flex:1' });
  const bgDim = el('input', { type: 'range', min: '0', max: '80', step: '1', value: String(s.bgDim === undefined ? 25 : s.bgDim), style: 'flex:1' });
  const veilOut = el('span', { class: 'hint', text: bgVeil.value + '%' });
  const dimOut = el('span', { class: 'hint', text: bgDim.value + '%' });

  const previewBg = () => {
    veilOut.textContent = bgVeil.value + '%';
    dimOut.textContent = bgDim.value + '%';
    applyBackground({
      bgImage: bgPath.value,
      bgFit: bgFit.value,
      bgVeil: Number(bgVeil.value),
      bgDim: Number(bgDim.value),
    });
  };
  bgFit.onchange = previewBg;
  bgVeil.oninput = previewBg;
  bgDim.oninput = previewBg;

  const body = el('div', {}, [
    el('fieldset', {}, [
      el('legend', { text: 'Appearance' }),
      el('div', { class: 'grid' }, [
        el('label', { text: 'Theme:' }), theme,
        el('div', { class: 'full' }, [el('p', { class: 'hint', style: 'margin:0', text: 'Theme turant apply hoti hai. Cancel karoge to purani wapas aa jayegi. Kisi ek tab ki alag theme chahiye to us tab par right-click karein.' })]),

        el('label', { text: 'Your own theme:' }), el('div', { class: 'row' }, [
          el('button', {
            text: 'Create new theme...',
            onclick: async () => {
              const saved = await showThemeEditor();
              if (!saved) return;
              theme.innerHTML = '';
              theme.append(...themeOptionNodes());
              theme.value = saved.theme;
            },
          }),
          el('button', {
            text: 'Edit this theme...',
            onclick: async () => {
              if (!theme.value.startsWith(CUSTOM_PREFIX)) {
                L.toast('Pehle koi apni banayi hui theme choose karein, ya "Create new theme..." dabayein.', 'warn');
                return;
              }
              const saved = await showThemeEditor(theme.value.slice(CUSTOM_PREFIX.length));
              if (!saved) return;
              theme.innerHTML = '';
              theme.append(...themeOptionNodes());
              theme.value = saved.theme;
            },
          }),
        ]),

        el('label', { text: 'Background image:' }), el('div', { class: 'row' }, [bgPath,
          el('button', {
            text: 'Browse...',
            onclick: async () => {
              const file = L.unwrap(await window.api.local.pickImage());
              if (file) { bgPath.value = file; previewBg(); }
            },
          }),
          el('button', { text: 'Clear', onclick: () => { bgPath.value = ''; previewBg(); } }),
        ]),
        el('label', { text: 'Image fit:' }), bgFit,
        el('label', { text: 'Panel opacity:' }), el('div', { class: 'row' }, [bgVeil, veilOut]),
        el('label', { text: 'Dim the image:' }), el('div', { class: 'row' }, [bgDim, dimOut]),
        el('div', { class: 'full' }, [el('p', { class: 'hint', style: 'margin:0', text: 'Apni koi bhi image background bana sakte hain. Panel opacity kam karoge to image zyada dikhegi; dim badhane se text zyada saaf padhega.' })]),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: 'File editing' }),
      el('div', { class: 'grid' }, [
        el('label', { text: 'Default editor:' }), editorMode,
        el('label', { text: 'Application:' }), editorApp,
        el('label', { text: 'Custom command:' }), editorCommand,
        el('label', { text: 'When the editor saves:' }), uploadMode,
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [watchFiles, 'Watch locally edited files and upload modifications'])]),
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [alwaysDefault, 'Always use default editor'])]),
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [useAssoc, 'Use filetype associations if available'])]),
        el('label', { text: 'Custom filetype associations:' }), assocBox,
        el('label', { text: 'Edit temp folder:' }), el('div', { class: 'row' }, [tempDir, el('button', {
          text: 'Browse...',
          onclick: async () => { const p = L.unwrap(await window.api.local.pickDir()); if (p) tempDir.value = p; },
        })]),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: 'Concurrent transfers' }),
      el('div', { class: 'grid' }, [
        el('label', { text: 'Maximum simultaneous transfers:' }), maxTransfers,
        el('label', { text: 'Limit for concurrent downloads:' }), maxDownloads,
        el('label', { text: 'Limit for concurrent uploads:' }), maxUploads,
        el('div', { class: 'full' }, [el('p', { class: 'hint', style: 'margin:0', text: 'Transfers 1-10. Downloads/uploads 0-10, where 0 means no separate limit. Each transfer slot opens its own connection; a separate control connection stays free for browsing.' })]),
        el('label', { text: 'Connection timeout (seconds):' }), connectTimeout,
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: 'Speed limits' }),
      el('div', { class: 'grid' }, [
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [speedLimitEnabled, 'Enable speed limits'])]),
        el('label', { text: 'Download limit (KB/s):' }), speedLimitDown,
        el('label', { text: 'Upload limit (KB/s):' }), speedLimitUp,
        el('div', { class: 'full' }, [el('p', { class: 'hint', style: 'margin:0', text: '0 means no limit for that direction. A limit applies to the whole session, so concurrent transfers in the same direction share it.' })]),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: 'Transfers' }),
      el('div', { class: 'grid' }, [
        el('label', { text: 'Default file exists action:' }), existing,
        el('label', { text: 'Transfer mode:' }), transferMode,
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [transferModeFallback, 'Allow fall back to other transfer mode on failure'])]),
        el('label', { text: 'ASCII extensions:' }), asciiExtensions,
        el('div', { class: 'full' }, [el('p', { class: 'hint', style: 'margin:0', text: 'Auto picks ASCII for text files by extension and binary for everything else. ASCII converts line endings (CRLF on the server, LF locally). Separate extensions with spaces.' })]),
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [confirmDelete, 'Confirm before deleting files'])]),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: 'Interface' }),
      el('div', { class: 'grid' }, [
        el('label', { text: 'Default local directory:' }), el('div', { class: 'row' }, [defaultLocal, el('button', {
          text: 'Browse...',
          onclick: async () => { const p = L.unwrap(await window.api.local.pickDir()); if (p) defaultLocal.value = p; },
        })]),
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [showHidden, 'Show hidden files'])]),
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [timestamps, 'Show timestamps in message log'])]),
      ]),
    ]),
    el('fieldset', {}, [
      el('legend', { text: 'Directory comparison' }),
      el('div', { class: 'grid' }, [
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [compareSize, 'Compare filesize'])]),
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [compareTime, 'Compare modification time'])]),
        el('label', { text: 'Comparison threshold (minutes):' }), threshold,
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [hideIdentical, 'Hide identical files'])]),
      ]),
    ]),
  ]);

  const res = await L.modal({
    title: 'Settings',
    body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }],
  });
  if (res !== 'ok') {
    applyTheme(themeForTab(app.activeSessionId));   // undo the live preview
    applyBackground(app.settings);
    return;
  }

  const thresholdValue = Math.max(0, Math.min(1440, Number(threshold.value) || 0));
  const clampNum = (value, min, max, dflt) => {
    const n = Number(String(value).trim());
    if (!isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  const patch = {
    bgImage: bgPath.value.trim(),
    bgFit: bgFit.value,
    bgVeil: clampNum(bgVeil.value, 50, 100, 86),
    bgDim: clampNum(bgDim.value, 0, 80, 25),
    maxTransfers: clampNum(maxTransfers.value, 1, 10, 2),
    maxDownloads: clampNum(maxDownloads.value, 0, 10, 0),
    maxUploads: clampNum(maxUploads.value, 0, 10, 0),
    connectTimeout: clampNum(connectTimeout.value, 0, 9999, 20),
    theme: theme.value,
    themeDark: themeIsDark(theme.value),
    editorMode: editorMode.value,
    editorApp: editorApp.value,
    editorCommand: editorCommand.value.trim(),
    alwaysUseDefaultEditor: alwaysDefault.checked,
    useFiletypeAssociations: useAssoc.checked,
    watchEditedFiles: watchFiles.checked,
    uploadOnSave: uploadMode.value,
    associations: assocList.filter((a) => a.ext && (a.value || a.mode === 'system')),
    editTempDir: tempDir.value.trim(),
    transferExisting: existing.value,
    speedLimitEnabled: speedLimitEnabled.checked,
    speedLimitDown: clampNum(speedLimitDown.value, 0, 1048576, 0),
    speedLimitUp: clampNum(speedLimitUp.value, 0, 1048576, 0),
    transferMode: transferMode.value,
    transferModeFallback: transferModeFallback.checked,
    asciiExtensions: asciiExtensions.value
      .split(/[\s,]+/).map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean),
    confirmDelete: confirmDelete.checked,
    showHiddenLocal: showHidden.checked,
    showHiddenRemote: showHidden.checked,
    showTimestamps: timestamps.checked,
    compareBySize: compareSize.checked,
    compareByTime: compareTime.checked,
    compareThreshold: thresholdValue,
    hideIdentical: hideIdentical.checked,
    defaultLocalPath: defaultLocal.value.trim(),
  };
  const next = L.unwrap(await window.api.settings.set(patch), 'Settings');
  if (next) applySettings(next);
}

function applySettings(next) {
  app.settings = next;
  applyCustomThemes(next.customThemes);
  applyTheme(themeForTab(app.activeSessionId));
  applyBackground(next);
  const picker = $('#theme-picker');
  if (picker) {
    const wanted = next.theme || 'system';
    picker.innerHTML = '';
    picker.append(...themeOptionNodes());
    picker.value = wanted;
  }
  $('#log-timestamps').checked = Boolean(next.showTimestamps);
  app.localPane.setShowHidden(next.showHiddenLocal);
  app.remotePane.setShowHidden(next.showHiddenRemote);
  applyCompare();
}

/* =========================================================== connection */

function setStatus(status, quiet) {
  app.status = status;
  if (app.activeSessionId) app.tabStatus.set(app.activeSessionId, status);
  const connected = status.connected;
  $('#btn-disconnect').disabled = !connected;
  $('#status-conn').textContent = connected
    ? `${status.info.user}@${status.info.host}:${status.info.port} - ${status.info.protocol.toUpperCase()}`
      + ` · ${status.connections} connection${status.connections === 1 ? '' : 's'}`
    : 'Not connected';
  if (!connected && !quiet) {
    app.remotePane.clear();
    app.remoteCache.delete(app.activeSessionId);
    app.syncOn = false;
    app.syncRoots = null;
    $('#btn-sync').classList.remove('active');
  }
  renderTabs();
}

async function connectSite(id, opts) {
  const options = opts || {};
  // FileZilla asks this too: reuse this tab, or open another one?
  if (!options.sameTab && app.status.connected) {
    const where = await L.modal({
      title: 'Already connected in this tab',
      narrow: true,
      body: el('div', {}, [
        el('p', { style: 'margin:0 0 6px', text: `Ye tab abhi ${app.status.info.host} se juda hua hai.` }),
        el('p', { class: 'hint', style: 'margin:0', text: 'Naye tab me connect karein to dono server ek saath khule rahenge.' }),
      ]),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Connect in current tab', value: 'current' },
        { label: 'Connect in new tab', value: 'new', primary: true },
      ],
    });
    if (!where) return;
    if (where === 'new') {
      const created = await newTab();
      if (!created) return;
    }
  }

  const status = L.unwrap(await window.api.conn.connect(on({ siteId: id })), 'Connect');
  if (!status) return;
  setStatus(status);

  // The site's own default directories decide where both panes land.
  if (status.info.localPath) await navigateLocal(status.info.localPath, true);
  await navigateRemote(status.info.home, true);
  if (status.info.configuredPath && status.info.configuredPath === status.info.home) {
    log('ok', 'Opened configured remote directory: ' + status.info.configuredPath);
  }
  if (status.info.syncBrowsing && !app.syncOn) toggleSync();
}

async function quickconnect() {
  const cfg = {
    protocol: $('#qc-protocol').value,
    host: $('#qc-host').value.trim(),
    user: $('#qc-user').value.trim(),
    password: $('#qc-pass').value,
    port: $('#qc-port').value.trim(),
    authType: 'password',
  };
  if (!cfg.host) { L.toast('Host is required', 'error'); return; }
  const status = L.unwrap(await window.api.conn.connect(on(cfg)), 'Connect');
  if (!status) return;
  setStatus(status);
  await navigateRemote(status.info.home, true);
}

/* ================================================================= init */

async function init() {
  app.settings = L.unwrap(await window.api.settings.get()) || {};

  app.localPane = FilePane({
    root: $('#pane-local'),
    side: 'local',
    onNavigate: (p) => navigateLocal(p),
    onActivate: (entry) => window.api.local.open({ path: entry.localPath }),
    onMenu: localMenu,
    onFocus: (side) => { app.activePane = side; },
    onDrop: () => download(app.remotePane.selectedEntries()),
  });

  app.remotePane = FilePane({
    root: $('#pane-remote'),
    side: 'remote',
    onNavigate: (p) => navigateRemote(p),
    onActivate: (entry) => viewEdit(entry),
    onMenu: remoteMenu,
    onFocus: (side) => { app.activePane = side; },
    onDrop: () => upload(app.localPane.selectedEntries()),
  });

  applySettings(app.settings);
  await refreshTabs();
  renderQueue();

  const home = L.unwrap(await window.api.local.home());
  if (home) await navigateLocal(home, true);

  $('#qc-protocol').onchange = () => {
    const p = $('#qc-protocol').value;
    $('#qc-port').placeholder = p === 'sftp' ? '22' : '21';
  };
  $('#qc-protocol').onchange();

  $('#qc-connect').onclick = quickconnect;
  $$('#quickconnect input').forEach((input) => {
    input.onkeydown = (e) => { if (e.key === 'Enter') quickconnect(); };
  });

  const themePicker = $('#theme-picker');
  themePicker.append(...themeOptionNodes());
  themePicker.value = app.settings.theme || 'system';
  themePicker.onchange = async () => {
    // The toolbar picker sets the default; a tab with its own theme keeps it.
    app.tabThemes.delete(app.activeSessionId);
    applyTheme(themePicker.value);
    const next = L.unwrap(await window.api.settings.set({
      theme: themePicker.value,
      themeDark: themeIsDark(themePicker.value),
    }), 'Theme');
    if (next) app.settings = next;
  };

  $('#btn-sites').onclick = () => showSiteManager();
  $('#btn-refresh').onclick = () => {
    navigateLocal(app.localPane.path, true);
    if (app.status.connected) navigateRemote(app.remotePane.path, true);
  };
  $('#btn-compare').onclick = toggleCompare;
  $('#btn-sync').onclick = toggleSync;
  $('#btn-edited').onclick = showBeingEdited;
  $('#btn-settings').onclick = showSettings;
  $('#btn-disconnect').onclick = async () => {
    const status = L.unwrap(await window.api.conn.disconnect(on()));
    if (status) setStatus(status);
  };

  $('#log-clear').onclick = () => { $('#log').innerHTML = ''; };
  $('#log-timestamps').onchange = async (e) => {
    const next = L.unwrap(await window.api.settings.set({ showTimestamps: e.target.checked }));
    if (next) app.settings = next;
  };

  $$('#queue .tab').forEach((tab) => {
    tab.onclick = () => { app.queueTab = tab.dataset.tab; renderQueue(); };
  });
  $('#q-cancel').onclick = () => window.api.queue.cancelAll(on());
  $('#q-clear').onclick = () => window.api.queue.clear(on());

  // pane splitter
  (function splitter() {
    const divider = $('#pane-divider');
    const left = $('#pane-local');
    let dragging = false;
    divider.onmousedown = () => { dragging = true; document.body.style.cursor = 'col-resize'; };
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const total = $('#panes').clientWidth;
      const pct = Math.min(80, Math.max(20, (e.clientX / total) * 100));
      left.style.flex = `0 0 ${pct}%`;
    });
    window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
  })();

  /* -------------------------------------------------- events from main */

  window.api.onEvent((msg) => {
    const fromActive = !msg.sessionId || msg.sessionId === app.activeSessionId;
    const tabOf = (id) => app.tabs.find((t) => t.id === id);

    switch (msg.type) {
      case 'log': {
        // Say which tab a message came from once more than one is open.
        const tab = tabOf(msg.sessionId);
        const prefix = !fromActive && tab && tab.connected ? `[${tab.title}] ` : '';
        log(msg.level, prefix + msg.message, msg.time);
        if (msg.level === 'error') L.toast(prefix + msg.message, 'error');
        break;
      }
      case 'queue':
        app.queues.set(msg.sessionId, msg.items);
        renderQueue();
        break;
      case 'progress':
        patchProgress(msg.sessionId, msg.id, msg.transferred, msg.size);
        break;
      case 'queue-idle':
        if (app.settings.autoRemoveSuccessful) window.api.queue.clear({ sessionId: msg.sessionId });
        if (app.localPane.path) navigateLocal(app.localPane.path, true);
        if (fromActive && app.status.connected && app.remotePane.path) navigateRemote(app.remotePane.path, true);
        refreshTabs();
        break;
      case 'tabs':
        app.tabs = msg.tabs.tabs;
        if (!app.activeSessionId) app.activeSessionId = msg.tabs.activeId;
        renderTabs();
        renderQueue();
        break;
      case 'connection':
        app.tabStatus.set(msg.sessionId, msg.status);
        if (fromActive) setStatus(msg.status);
        refreshTabs();
        break;
      case 'settings':
        applySettings(msg.settings);
        break;
      case 'edit-sessions':
        if (fromActive) {
          app.editSessions = msg.sessions;
          refreshEditedPaths();
        }
        refreshTabs();
        break;
      case 'edit':
        if (msg.action === 'saved') {
          L.toast('Uploaded changes to the server.', 'ok');
          if (fromActive && app.remotePane.path) navigateRemote(app.remotePane.path, true);
        }
        if (fromActive) refreshEditedPaths();
        break;
      case 'edit-prompt':
        L.confirm({
          title: 'File has been modified',
          message: `"${msg.name}" edit kiya gaya hai.\n\nServer par upload karna hai?`,
          ok: 'Upload',
        }).then((yes) => {
          if (yes) window.api.edit.upload({ sessionId: msg.sessionId, localPath: msg.localPath, unedit: false });
        });
        break;
      default:
        break;
    }
  });

  /* ------------------------------------------------------- menu actions */

  /* ---------------------------------------------------------- bookmarks */

  /** Jump both panes to a bookmark's paths, honouring its sync flag. */
  async function openBookmark(bookmark) {
    if (bookmark.remotePath) {
      if (!app.status.connected) { L.toast('Not connected to any server.', 'warn'); return; }
      await navigateRemote(bookmark.remotePath, true);
    }
    if (bookmark.localPath) await navigateLocal(bookmark.localPath, true);
    if (bookmark.syncBrowsing && !app.syncOn) toggleSync();
    log('info', 'Bookmark: ' + bookmark.name);
  }

  /** "Add bookmark..." - seeded with wherever the panes are sitting now. */
  async function showAddBookmark(existing) {
    const bookmark = existing || {};
    const siteId = app.status.connected ? (app.status.info.siteId || null) : null;
    const siteName = app.status.connected ? app.status.info.siteName : '';

    const name = el('input', { value: bookmark.name || '', style: 'flex:1' });
    const localPath = el('input', {
      value: bookmark.localPath !== undefined ? bookmark.localPath : (app.localPane.path || ''),
      style: 'flex:1',
    });
    const remotePath = el('input', {
      value: bookmark.remotePath !== undefined ? bookmark.remotePath : (app.remotePane.path || ''),
      style: 'flex:1',
    });
    const sync = el('input', { type: 'checkbox', checked: Boolean(bookmark.syncBrowsing) });

    // FileZilla offers "Global bookmark" / "Site-specific bookmark"; the second
    // is only meaningful while connected to a saved site.
    const scope = el('select', {}, [
      el('option', { value: 'global', text: 'Global bookmark' }),
      el('option', {
        value: 'site',
        text: siteId ? `Site-specific bookmark (${siteName})` : 'Site-specific bookmark (connect to a saved site first)',
        disabled: !siteId,
      }),
    ]);
    scope.value = (existing ? existing.siteId : siteId) ? 'site' : 'global';

    const result = await L.modal({
      title: existing && existing.id ? 'Edit bookmark' : 'Add bookmark',
      narrow: true,
      body: el('div', { class: 'grid' }, [
        el('label', { text: 'Name:' }), name,
        el('label', { text: 'Type:' }), scope,
        el('label', { text: 'Local directory:' }), el('div', { class: 'row' }, [localPath, el('button', {
          text: 'Browse...',
          onclick: async () => { const p = L.unwrap(await window.api.local.pickDir()); if (p) localPath.value = p; },
        })]),
        el('label', { text: 'Remote directory:' }), remotePath,
        el('div', { class: 'full' }, [el('label', { class: 'inline' }, [sync, 'Use synchronized browsing'])]),
        el('div', { class: 'full' }, [el('p', {
          class: 'hint', style: 'margin:0',
          text: 'Leave a directory empty to leave that pane where it is.',
        })]),
      ]),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save', primary: true },
      ],
    });
    if (result !== 'save') return;

    const payload = {
      id: existing ? existing.id : undefined,
      name: name.value.trim(),
      siteId: scope.value === 'site' ? (existing ? existing.siteId : siteId) : null,
      localPath: localPath.value.trim(),
      remotePath: remotePath.value.trim(),
      syncBrowsing: sync.checked,
    };
    const saved = L.unwrap(await window.api.bookmarks.save(payload), 'Bookmark');
    if (saved) L.toast('Bookmark saved: ' + saved.name, 'ok');
  }

  /** "Manage bookmarks..." - list, open, edit and delete. */
  async function showManageBookmarks() {
    const siteId = app.status.connected ? (app.status.info.siteId || null) : null;
    const list = L.unwrap(await window.api.bookmarks.list({ siteId }), 'Bookmarks') || [];

    if (!list.length) {
      L.modal({
        title: 'Manage bookmarks',
        narrow: true,
        body: el('p', { class: 'hint', style: 'margin:0', text: 'No bookmarks yet. Use Bookmarks -> Add bookmark to store the current directories.' }),
        buttons: [{ label: 'Close', value: null, primary: true }],
      });
      return;
    }

    const rows = list.map((bookmark) => el('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { text: bookmark.name }),
        el('div', {
          class: 'hint',
          style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
          text: [bookmark.siteId ? 'site' : 'global', bookmark.remotePath, bookmark.localPath]
            .filter(Boolean).join('  ·  '),
        }),
      ]),
      el('button', { text: 'Open', onclick: () => { L.closeModal(); openBookmark(bookmark); } }),
      el('button', { text: 'Edit', onclick: () => { L.closeModal(); showAddBookmark(bookmark); } }),
      el('button', {
        text: 'Delete',
        onclick: async () => {
          L.closeModal();
          const yes = await L.confirm({
            title: 'Delete bookmark',
            message: `Delete "${bookmark.name}"?`,
            ok: 'Delete',
            danger: true,
          });
          if (!yes) { showManageBookmarks(); return; }
          L.unwrap(await window.api.bookmarks.remove({ id: bookmark.id }), 'Bookmark');
          showManageBookmarks();
        },
      }),
    ]));

    L.modal({
      title: 'Manage bookmarks',
      narrow: true,
      body: el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, rows),
      buttons: [{ label: 'Close', value: null, primary: true }],
    });
  }

  window.api.onMenu((action) => {
    switch (action) {
      case 'site-manager': showSiteManager(); break;
      case 'copy-connection':
        if (!app.status.connected) { L.toast('Not connected to any server.', 'warn'); break; }
        showSiteManager({
          name: app.status.info.host,
          protocol: app.status.info.protocol,
          host: app.status.info.host,
          port: app.status.info.port,
          user: app.status.info.user,
          authType: 'password',
          remotePath: app.remotePane.path,
          localPath: app.localPane.path,
        });
        break;
      case 'being-edited': showBeingEdited(); break;
      case 'new-tab': newTab(); break;
      case 'close-tab': closeTab(app.activeSessionId); break;
      case 'settings': showSettings(); break;
      case 'refresh': $('#btn-refresh').click(); break;
      case 'toggle-compare': toggleCompare(); break;
      case 'toggle-sync': toggleSync(); break;
      case 'disconnect': $('#btn-disconnect').click(); break;
      case 'process-queue': break;
      case 'cancel-queue': window.api.queue.cancelAll(on()); break;
      case 'clear-queue': window.api.queue.clear(on()); break;
      case 'swap-panes': {
        const panes = $('#panes');
        panes.style.flexDirection = panes.style.flexDirection === 'row-reverse' ? 'row' : 'row-reverse';
        break;
      }
      case 'toggle-hidden':
        window.api.settings.set({
          showHiddenLocal: !app.settings.showHiddenLocal,
          showHiddenRemote: !app.settings.showHiddenRemote,
        }).then((res) => { const n = L.unwrap(res); if (n) applySettings(n); });
        break;
      case 'add-bookmark': showAddBookmark(); break;
      case 'manage-bookmarks': showManageBookmarks(); break;
      default: break;
    }
  });

  /* ---------------------------------------------------------- shortcuts */

  window.addEventListener('keydown', (e) => {
    if (L.isModalOpen()) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    const target = app.activePane === 'remote' ? app.remotePane : app.localPane;
    const sel = target.selectedEntries();

    if (e.key === 'F5') { e.preventDefault(); $('#btn-refresh').click(); }
    if (e.key === 'F2' && sel.length === 1) { e.preventDefault(); doRename(target.side, sel[0]); }
    if ((e.key === 'Backspace' || e.key === 'Delete') && sel.length) {
      e.preventDefault();
      doDelete(target.side, sel);
    }
    if (e.key === 'Enter' && sel.length === 1) {
      e.preventDefault();
      const entry = sel[0];
      if (entry.isDir) {
        const dir = target.side === 'remote' ? entry.remotePath : entry.localPath;
        if (target.side === 'remote') navigateRemote(dir); else navigateLocal(dir);
      } else if (target.side === 'remote') {
        viewEdit(entry);
      } else {
        window.api.local.open({ path: entry.localPath });
      }
    }
  });

  log('info', 'Sarv Electron ready. Quickconnect ya Site Manager se connect karein.');
}

init();

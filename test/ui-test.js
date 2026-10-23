// Loads the real renderer in a hidden Electron window and inspects the DOM.
// Runs against a throwaway userData directory so it never touches real sites.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const PROJ = path.join(__dirname, '..');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sarv-uitest-'));
app.setPath('userData', USERDATA);

const registerIpc = require(path.join(PROJ, 'src', 'main', 'ipc'));
const store = require(path.join(PROJ, 'src', 'main', 'store'));

const problems = [];
let currentStep = 'startup';

const WATCHDOG_MS = Number(process.env.UI_TEST_TIMEOUT || 60000);
const watchdog = setTimeout(() => {
  console.error('TIMED OUT during step: ' + currentStep);
  process.exit(3);
}, WATCHDOG_MS);

let results = {};
let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

const run = async () => {
  // --- seed a known set of sites and folders
  currentStep = 'seed';
  store.importSites([
    { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', protocol: 'sftp', folder: 'Prod', remotePath: '/srv/app' },
    { name: 'beta', host: '10.0.0.2', port: 22, user: 'root', protocol: 'sftp', folder: 'Prod' },
    { name: 'gamma', host: '10.0.0.3', port: 22, user: 'deploy', protocol: 'sftp', folder: 'Prod/EU' },
    { name: 'delta', host: '10.0.0.4', port: 21, user: 'ftp', protocol: 'ftp', folder: 'Staging' },
    { name: 'loose', host: '10.0.0.5', port: 22, user: 'root', protocol: 'sftp', folder: '' },
  ]);
  store.addFolder('Empty folder');

  const win = new BrowserWindow({
    show: false,
    width: 1340,
    height: 860,
    webPreferences: {
      preload: path.join(PROJ, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (event) => {
    const level = event && event.level;
    const message = event && event.message;
    if (level === 'error' || level === 3) problems.push('console: ' + message);
  });
  win.webContents.on('preload-error', (_e, p, err) => problems.push('preload: ' + err.message));
  win.webContents.on('render-process-gone', (_e, d) => problems.push('renderer gone: ' + JSON.stringify(d)));

  registerIpc(() => win);
  currentStep = 'load';
  await win.loadFile(path.join(PROJ, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));

  const exec = async (name, script) => {
    currentStep = name;
    if (process.env.UI_TEST_VERBOSE) console.error('-> ' + name);
    return win.webContents.executeJavaScript(script);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await exec('install error hook', `
    window.__errors = [];
    window.addEventListener('error', (e) => window.__errors.push(String((e.error && e.error.stack) || e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String((e.reason && e.reason.stack) || e.reason)));
    0`);

  /* ------------------------------------------------------------- layout */

  console.log('\n[layout]');
  const snapshot = await exec('snapshot', `(() => ({
    title: document.title,
    bridge: typeof window.api === 'object' && typeof window.api.edit.open === 'function'
      && typeof window.api.sites.setFolder === 'function' && typeof window.api.filezilla.import === 'function',
    panes: document.querySelectorAll('#panes .pane').length,
    localHeaders: Array.from(document.querySelectorAll('#pane-local thead th')).map(t => t.textContent),
    remoteHeaders: Array.from(document.querySelectorAll('#pane-remote thead th')).map(t => t.textContent),
    localRows: document.querySelectorAll('#pane-local tbody tr').length,
    localCells: (document.querySelector('#pane-local tbody tr') || { children: [] }).children.length,
    remoteEmptyText: (document.querySelector('#pane-remote tbody td.empty') || {}).textContent || '',
    queueHeaders: Array.from(document.querySelectorAll('#queue-table thead th')).map(t => t.textContent).filter(Boolean),
    queueTabs: Array.from(document.querySelectorAll('#queue .tab')).map(t => t.dataset.tab),
    statusConn: document.getElementById('status-conn').textContent,
    filterWidth: getComputedStyle(document.querySelector('#pane-local .filter')).width,
    settingsKeys: Object.keys(app.settings || {}).length
  }))()`);
  results.snapshot = snapshot;
  check('window title', snapshot.title === 'Sarv Electron', snapshot.title);
  check('preload bridge complete', snapshot.bridge === true);
  check('two panes', snapshot.panes === 2);
  check('local pane has no Permissions column',
    snapshot.localHeaders.join(',') === 'Filename,Filesize,Filetype,Last modified', snapshot.localHeaders);
  check('local rows have the same number of cells as headers',
    snapshot.localCells === snapshot.localHeaders.length, snapshot);
  check('remote columns match FileZilla', snapshot.remoteHeaders.join(',') === 'Filename,Filesize,Filetype,Last modified,Permissions,Owner/Group', snapshot.remoteHeaders);
  check('queue columns match FileZilla', snapshot.queueHeaders.join(',') === 'Server/Local file,Direction,Remote file,Size,Priority,Status', snapshot.queueHeaders);
  check('queue tabs', snapshot.queueTabs.join(',') === 'queued,failed,done');
  check('local pane listed files', snapshot.localRows > 0);
  check('not connected yet', snapshot.statusConn === 'Not connected');
  check('filter box widened', snapshot.filterWidth === '160px', snapshot.filterWidth);

  /* ------------------------------------------------------------- themes */

  console.log('\n[themes]');
  const themes = await exec('themes', `(() => {
    const read = () => getComputedStyle(document.body).backgroundColor;
    const label = () => getComputedStyle(document.documentElement).getPropertyValue('--theme-label').trim();
    const out = { count: THEMES.length, ids: THEMES.map(t => t.id), colours: {}, missingInCss: [],
                  light: THEMES.filter(t => t.dark === false).length,
                  dark: THEMES.filter(t => t.dark === true).length,
                  greens: THEMES.filter(t => /green|forest|mint|emerald|olive|matrix/i.test(t.label + t.id)).length };
    for (const t of THEMES) {
      applyTheme(t.id);
      out.colours[t.id] = read();
      // every non-system theme must have a matching block in themes.css
      if (t.id !== 'system' && !label()) out.missingInCss.push(t.id);
    }
    applyTheme('system');
    out.systemClears = document.documentElement.dataset.theme === undefined;
    return out;
  })()`);
  results.themes = themes;
  check('at least 10 light themes', themes.light >= 10, themes.light);
  check('at least 10 dark themes', themes.dark >= 10, themes.dark);
  check('green themes are offered', themes.greens >= 4, themes.greens);
  check('css and js agree on the theme list', themes.missingInCss.length === 0, themes.missingInCss);
  check('themes paint distinct backgrounds',
    new Set(Object.values(themes.colours)).size >= 18, Object.keys(themes.colours).length);
  check('dark differs from light', themes.colours.dark !== themes.colours.light);
  check('ocean differs from midnight', themes.colours.ocean !== themes.colours.midnight);
  check('high contrast is black', themes.colours.contrast === 'rgb(0, 0, 0)', themes.colours.contrast);
  check('system clears the attribute', themes.systemClears === true);

  const picker = await exec('toolbar theme picker', `(() => {
    const sel = document.getElementById('theme-picker');
    const before = getComputedStyle(document.body).backgroundColor;
    sel.value = 'ocean'; sel.dispatchEvent(new Event('change'));
    const after = getComputedStyle(document.body).backgroundColor;
    sel.value = 'system'; sel.dispatchEvent(new Event('change'));
    return { exists: Boolean(sel), options: sel.options.length, before, after,
             restored: getComputedStyle(document.body).backgroundColor };
  })()`);
  results.picker = picker;
  check('theme picker sits in the toolbar', picker.exists === true);
  check('every theme in the toolbar picker', picker.options >= 21, picker.options);
  check('picking a theme repaints immediately', picker.after !== picker.before, picker);
  check('switching back restores it', picker.restored === picker.before);

  console.log('\n[your own theme]');
  await exec('open theme editor', 'showThemeEditor(); 0');
  await wait(600);
  const editor = await exec('editor fields', `(() => {
    const boxes = document.querySelectorAll('#modal-host .modal');
    const top = boxes[boxes.length - 1];
    return {
      title: top.querySelector('h2').textContent,
      colorInputs: top.querySelectorAll('input[type="color"]').length,
      hasStartFrom: Array.from(top.querySelectorAll('label')).some(l => l.textContent.trim() === 'Start from:'),
      buttons: Array.from(top.querySelectorAll('.foot button')).map(b => b.textContent)
    };
  })()`);
  results.editor = editor;
  check('theme editor opens', editor.title === 'Create your own theme', editor.title);
  check('six colours can be picked', editor.colorInputs === 6, editor.colorInputs);
  check('it can start from an existing theme', editor.hasStartFrom === true);
  check('it can be saved', editor.buttons.includes('Save'), editor.buttons);
  await exec('close theme editor', 'L.closeModal(null); 0');
  await wait(300);

  const custom = await exec('save and use a custom theme', `(async () => {
    const theme = { id: 'uitest', label: 'My test theme', dark: true,
      colors: { bg: '#101820', panel: '#16212b', border: '#2a3a48', text: '#e8f1f8', muted: '#8ea6b8', accent: '#ff9f1c' } };
    const saved = await window.api.settings.set({ customThemes: [theme], theme: 'custom-uitest', themeDark: true });
    applySettings(saved.data);
    const root = getComputedStyle(document.documentElement);
    const out = {
      bg: getComputedStyle(document.body).backgroundColor,
      label: root.getPropertyValue('--theme-label').trim().replace(/^"|"$/g, ''),
      derivedSel: root.getPropertyValue('--sel').trim(),
      inToolbar: Array.from(document.getElementById('theme-picker').options).some(o => o.value === 'custom-uitest'),
      groups: Array.from(document.getElementById('theme-picker').querySelectorAll('optgroup')).map(g => g.label)
    };
    const cleared = await window.api.settings.set({ customThemes: [], theme: 'system', themeDark: false });
    applySettings(cleared.data);
    out.afterDelete = document.documentElement.dataset.theme;
    out.goneFromToolbar = !Array.from(document.getElementById('theme-picker').options).some(o => o.value === 'custom-uitest');
    return out;
  })()`);
  results.custom = custom;
  check('a custom theme paints the chosen background', custom.bg === 'rgb(16, 24, 32)', custom.bg);
  check('its name is used', custom.label === 'My test theme', custom.label);
  check('the rest of the palette is derived from it', custom.derivedSel.length > 0, custom.derivedSel);
  check('it shows up in the toolbar picker', custom.inToolbar === true);
  check('custom themes get their own group', custom.groups.some((g) => g.startsWith('My themes')), custom.groups);
  check('deleting it falls back to the default', custom.afterDelete === undefined, custom.afterDelete);
  check('and it leaves the picker', custom.goneFromToolbar === true);

  /* ---------------------------------------------------------- server tabs */

  console.log('\n[server tabs]');
  const tabsBefore = await exec('tab bar', `(() => {
    const bar = document.getElementById('remote-tabs');
    return { exists: Boolean(bar), tabs: bar.querySelectorAll('.server-tab').length,
             hasNewButton: Boolean(bar.querySelector('.new-tab')),
             label: (bar.querySelector('.server-tab .label') || {}).textContent };
  })()`);
  results.tabsBefore = tabsBefore;
  check('tab bar sits above the remote pane', tabsBefore.exists === true);
  check('one tab to start with', tabsBefore.tabs === 1, tabsBefore);
  check('a new-tab button is offered', tabsBefore.hasNewButton === true);
  check('an unconnected tab says so', tabsBefore.label === 'Not connected', tabsBefore.label);

  await exec('click new tab', `document.querySelector('#remote-tabs .new-tab').click(); 0`);
  await wait(700);
  const tabsAfter = await exec('after new tab', `(() => {
    const bar = document.getElementById('remote-tabs');
    const tabs = Array.from(bar.querySelectorAll('.server-tab'));
    return { count: tabs.length, activeIndex: tabs.findIndex(t => t.classList.contains('active')),
             closeButtons: bar.querySelectorAll('.server-tab .close').length, activeId: app.activeSessionId };
  })()`);
  results.tabsAfter = tabsAfter;
  check('the + button opens another tab', tabsAfter.count === 2, tabsAfter);
  check('the new tab becomes active', tabsAfter.activeIndex === 1, tabsAfter);
  check('close buttons appear once there are two', tabsAfter.closeButtons === 2, tabsAfter);

  const switched = await exec('switch back to the first tab', `(async () => {
    document.querySelectorAll('#remote-tabs .server-tab')[0].click();
    await new Promise(r => setTimeout(r, 500));
    const tabs = Array.from(document.querySelectorAll('#remote-tabs .server-tab'));
    return { activeIndex: tabs.findIndex(t => t.classList.contains('active')), activeId: app.activeSessionId };
  })()`);
  results.switched = switched;
  check('clicking a tab switches to it', switched.activeIndex === 0, switched);
  check('the active session id followed', switched.activeId !== tabsAfter.activeId);

  const perTab = await exec('per-tab theme', `(async () => {
    const ids = app.tabs.map(t => t.id);
    app.tabThemes.set(ids[1], 'matrix');
    await activateTab(ids[1]);
    const onTab2 = document.documentElement.dataset.theme;
    await activateTab(ids[0]);
    const onTab1 = document.documentElement.dataset.theme;
    await activateTab(ids[1]);
    const backOnTab2 = document.documentElement.dataset.theme;
    app.tabThemes.delete(ids[1]);
    await activateTab(ids[0]);
    return { onTab2, onTab1, backOnTab2, afterClear: document.documentElement.dataset.theme };
  })()`);
  results.perTab = perTab;
  check('a tab can carry its own theme', perTab.onTab2 === 'matrix', perTab);
  check('the other tab keeps the default', perTab.onTab1 !== 'matrix', perTab);
  check('switching back restores the tab theme', perTab.backOnTab2 === 'matrix', perTab);
  check('clearing a tab theme falls back to the default', perTab.afterClear !== 'matrix', perTab);

  console.log('\n[background image]');
  const bgFile = path.join(USERDATA, 'test-bg.png');
  fs.writeFileSync(bgFile, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
    'base64'));
  const bg = await exec('background image', `(() => {
    const root = document.documentElement;
    const toolbarBefore = getComputedStyle(document.getElementById('toolbar')).backgroundColor;
    applyBackground({ bgImage: ${JSON.stringify(bgFile)}, bgFit: 'cover', bgVeil: 70, bgDim: 30 });
    const layer = getComputedStyle(document.body, '::before');
    const out = {
      hasClass: root.classList.contains('has-bg'),
      image: layer.backgroundImage,
      size: layer.backgroundSize,
      repeat: layer.backgroundRepeat,
      toolbarBefore,
      toolbarAfter: getComputedStyle(document.getElementById('toolbar')).backgroundColor
    };
    applyBackground({ bgImage: ${JSON.stringify(bgFile)}, bgFit: 'tile', bgVeil: 70, bgDim: 30 });
    out.tileRepeat = getComputedStyle(document.body, '::before').backgroundRepeat;
    applyBackground({ bgImage: '' });
    out.cleared = !root.classList.contains('has-bg');
    out.toolbarRestored = getComputedStyle(document.getElementById('toolbar')).backgroundColor;
    return out;
  })()`);
  results.bg = bg;
  check('the image becomes the page background', bg.image.includes('test-bg.png'), bg.image);
  check('fit mode is applied', bg.size === 'cover', bg.size);
  check('tile mode repeats', bg.tileRepeat === 'repeat', bg.tileRepeat);
  check('panels turn translucent over it', bg.toolbarAfter !== bg.toolbarBefore, bg);
  check('clearing removes it', bg.cleared === true);
  check('panels go solid again', bg.toolbarRestored === bg.toolbarBefore, bg);

  const closed = await exec('close the second tab', `(async () => {
    document.querySelectorAll('#remote-tabs .server-tab')[1].querySelector('.close').click();
    await new Promise(r => setTimeout(r, 700));
    return { count: document.querySelectorAll('#remote-tabs .server-tab').length };
  })()`);
  results.closed = closed;
  check('a tab can be closed again', closed.count === 1, closed);

  /* -------------------------------------------------- site manager tree */

  console.log('\n[site manager tree]');
  await exec('open site manager', 'showSiteManager(); 0');
  await wait(700);

  const collapsed = await exec('tree collapsed', `(() => {
    const list = document.querySelector('#modal-host .list.tree');
    const folders = Array.from(list.querySelectorAll('.folder-row'));
    return {
      folderNames: folders.map(f => f.querySelector('.folder-name').textContent),
      counts: folders.map(f => f.querySelector('.folder-count').textContent),
      carets: folders.map(f => f.querySelector('.caret').textContent),
      siteRows: Array.from(list.querySelectorAll('.site-row .site-name')).map(n => n.textContent)
    };
  })()`);
  results.collapsed = collapsed;
  check('folders are rows in the tree', collapsed.folderNames.includes('Prod') && collapsed.folderNames.includes('Staging'), collapsed.folderNames);
  check('empty folder still listed', collapsed.folderNames.includes('Empty folder'), collapsed.folderNames);
  check('folder shows its site count', collapsed.counts[collapsed.folderNames.indexOf('Prod')] === '3', collapsed.counts);
  // Only the selected site's folder opens; everything else stays shut.
  check('exactly one folder starts open (the selected site)',
    collapsed.carets.filter((c) => c === '−').length === 1, collapsed.carets);
  check('top-level site always visible', collapsed.siteRows.includes('loose'), collapsed.siteRows);
  check('sites of other folders stay hidden', !collapsed.siteRows.includes('delta'), collapsed.siteRows);
  check('selected site is revealed', collapsed.siteRows.includes('alpha'), collapsed.siteRows);

  const allToggles = await exec('expand / collapse all', `(() => {
    const host = document.getElementById('modal-host');
    const list = host.querySelector('.list.tree');
    const btn = (title) => Array.from(host.querySelectorAll('button')).find(b => b.title === title);
    btn('Expand all folders').click();
    const openCount = list.querySelectorAll('.site-row').length;
    btn('Collapse all folders').click();
    const shut = Array.from(list.querySelectorAll('.site-row .site-name')).map(n => n.textContent);
    return { openCount, shut };
  })()`);
  results.allToggles = allToggles;
  check('expand all reveals every site', allToggles.openCount === 5, allToggles);
  check('collapse all leaves only the top-level site', allToggles.shut.join(',') === 'loose', allToggles);

  const expanded = await exec('expand Prod', `(() => {
    const list = document.querySelector('#modal-host .list.tree');
    const find = (name) => Array.from(list.querySelectorAll('.folder-row'))
      .find(f => f.querySelector('.folder-name').textContent === name);
    find('Prod').click();
    const rows = Array.from(list.querySelectorAll('.site-row .site-name')).map(n => n.textContent);
    const folders = Array.from(list.querySelectorAll('.folder-row')).map(f => f.querySelector('.folder-name').textContent);
    return { rows, folders, caret: find('Prod').querySelector('.caret').textContent };
  })()`);
  results.expanded = expanded;
  check("expanding shows the folder's sites", expanded.rows.includes('alpha') && expanded.rows.includes('beta'), expanded.rows);
  check('toggle flips to collapse', expanded.caret === '\u2212', expanded.caret);
  check('nested subfolder appears', expanded.folders.includes('EU'), expanded.folders);
  check('other folders stay collapsed', !expanded.rows.includes('delta'), expanded.rows);

  const moved = await exec('drag site into folder', `(async () => {
    const list = document.querySelector('#modal-host .list.tree');
    const loose = Array.from(list.querySelectorAll('.site-row')).find(r => r.querySelector('.site-name').textContent === 'loose');
    const staging = Array.from(list.querySelectorAll('.folder-row')).find(f => f.querySelector('.folder-name').textContent === 'Staging');
    const dt = new DataTransfer();
    loose.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    staging.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 600));
    const res = await window.api.sites.list();
    return { folderOf: (res.data.find(s => s.name === 'loose') || {}).folder };
  })()`);
  results.moved = moved;
  check('dropping a site on a folder moves it', moved.folderOf === 'Staging', moved);

  await exec('close site manager', 'L.closeModal(null); 0');
  await wait(300);

  console.log('\n[long site list: scrolling]');
  await exec('seed many sites', `(async () => {
    for (let i = 0; i < 40; i += 1) {
      await window.api.sites.save({ name: 'bulk-' + String(i).padStart(2, '0'), host: '10.1.0.' + i,
        port: 22, user: 'u', protocol: 'sftp', folder: 'Bulk' });
    }
    return 0;
  })()`);

  await exec('close any open dialog', 'while (L.isModalOpen()) L.closeModal(null); 0');
  await wait(300);
  await exec('reopen site manager', 'showSiteManager(); 0');
  await wait(900);
  const dialogCount = await exec('dialog count', `document.querySelectorAll('#modal-host .modal').length`);
  check('exactly one dialog is open for this test', dialogCount === 1, dialogCount);

  const scrollKept = await exec('click a site far down the list', `(async () => {
    const boxes = document.querySelectorAll('#modal-host .modal');
    const top = boxes[boxes.length - 1];                 // the dialog actually on screen
    const list = top.querySelector('.list.tree');
    const bulk = Array.from(list.querySelectorAll('.folder-row'))
      .find(f => f.querySelector('.folder-name').textContent === 'Bulk');
    bulk.click();
    await new Promise(r => setTimeout(r, 300));

    list.scrollTop = list.scrollHeight;          // jump to the bottom
    await new Promise(r => setTimeout(r, 100));
    const before = list.scrollTop;
    const scrollable = list.scrollHeight > list.clientHeight + 20;

    const rows = Array.from(list.querySelectorAll('.site-row'));
    const target = rows[rows.length - 1];
    const targetName = target.querySelector('.site-name').textContent;
    target.click();
    await new Promise(r => setTimeout(r, 300));

    const after = list.scrollTop;
    const activeName = (list.querySelector('.site-row.active .site-name') || {}).textContent;
    const activeRow = list.querySelector('.site-row.active');
    const listBox = list.getBoundingClientRect();
    const rowBox = activeRow ? activeRow.getBoundingClientRect() : null;
    const visible = rowBox ? rowBox.top >= listBox.top - 2 && rowBox.bottom <= listBox.bottom + 2 : false;
    const detailName = (top.querySelector('.detail input') || {}).value;

    return { scrollable, before, after, targetName, activeName, visible, detailName };
  })()`);
  results.scrollKept = scrollKept;
  check('the list is long enough to scroll', scrollKept.scrollable === true, scrollKept);
  check('clicking a site does not jump back to the top', scrollKept.after > 0, scrollKept);
  check('the scroll position is kept', Math.abs(scrollKept.after - scrollKept.before) < 30, scrollKept);
  check('the clicked site stays selected', scrollKept.activeName === scrollKept.targetName, scrollKept);
  check('the selected site stays visible', scrollKept.visible === true, scrollKept);
  check('the details belong to the clicked site', scrollKept.detailName === scrollKept.targetName, scrollKept);

  await exec('close site manager 3', 'L.closeModal(null); 0');
  await wait(300);
  await exec('open site manager again for reveal', 'showSiteManager(); 0');
  await wait(900);
  const revealed = await exec('selected site is revealed on open', `(() => {
    const boxes = document.querySelectorAll('#modal-host .modal');
    const list = boxes[boxes.length - 1].querySelector('.list.tree');
    const activeRow = list.querySelector('.site-row.active');
    if (!activeRow) return { found: false };
    const listBox = list.getBoundingClientRect();
    const rowBox = activeRow.getBoundingClientRect();
    return { found: true, name: activeRow.querySelector('.site-name').textContent,
             visible: rowBox.top >= listBox.top - 2 && rowBox.bottom <= listBox.bottom + 2,
             scrollTop: list.scrollTop };
  })()`);
  results.revealed = revealed;
  check('reopening scrolls the selected site into view', revealed.found && revealed.visible, revealed);
  await exec('close site manager 4', 'L.closeModal(null); 0');
  await wait(300);

  /* ---------------------------------------------------- stacked dialogs */

  console.log('\n[dialogs]');
  await exec('open site manager again', 'showSiteManager(); 0');
  await wait(500);
  await exec('click Import', `(() => {
    Array.from(document.querySelectorAll('#modal-host .foot button')).find(b => b.textContent === 'Import...').click();
    return 0;
  })()`);
  await wait(1200);
  const stacked = await exec('read stack', `(() => {
    const boxes = Array.from(document.querySelectorAll('#modal-host .modal'));
    return { count: boxes.length, titles: boxes.map(b => b.querySelector('h2').textContent),
             underneathHidden: boxes.length > 1 ? boxes[0].style.display === 'none' : null };
  })()`);
  results.stacked = stacked;
  check('import opens on top of the site manager', stacked.count === 2, stacked.titles);
  check('the one underneath is kept, just hidden', stacked.underneathHidden === true);

  await exec('close import', 'L.closeModal(null); 0');
  await wait(400);
  const afterClose = await exec('read stack after close', `(() => {
    const boxes = Array.from(document.querySelectorAll('#modal-host .modal'));
    return { count: boxes.length, title: boxes.length ? boxes[0].querySelector('h2').textContent : null,
             visible: boxes.length ? boxes[0].style.display !== 'none' : null };
  })()`);
  results.afterClose = afterClose;
  check('site manager comes back', afterClose.count === 1 && afterClose.title === 'Site Manager', afterClose);
  check('and is visible again', afterClose.visible === true);
  await exec('close site manager 2', 'L.closeModal(null); 0');
  await wait(300);

  /* --------------------------------------------------------- settings */

  await exec('open settings', 'showSettings(); 0');
  await wait(600);
  const settingsDialog = await exec('read settings', `(() => {
    const host = document.getElementById('modal-host');
    const labels = Array.from(host.querySelectorAll('label')).map(l => l.textContent.trim());
    return {
      legends: Array.from(host.querySelectorAll('legend')).map(l => l.textContent),
      hasTheme: labels.includes('Theme:'),
      themeOptions: Array.from(host.querySelectorAll('select')).map(s => s.options.length)[0],
      hasEditorRow: labels.includes('Default editor:'),
      hasAssocRow: labels.includes('Custom filetype associations:'),
      hasExistsRow: labels.includes('Default file exists action:')
    };
  })()`);
  results.settingsDialog = settingsDialog;
  check('settings has an Appearance section', settingsDialog.legends.includes('Appearance'), settingsDialog.legends);
  check('theme picker present', settingsDialog.hasTheme === true);
  check('settings offers every theme', settingsDialog.themeOptions >= 21, settingsDialog.themeOptions);
  check('editor settings present', settingsDialog.hasEditorRow && settingsDialog.hasAssocRow);
  check('file exists action present', settingsDialog.hasExistsRow === true);
  await exec('close settings', 'L.closeModal(null); 0');

  /* ------------------------------------------------- FileZilla detection */

  console.log('\n[filezilla]');
  const fz = await exec('detect filezilla', 'window.api.filezilla.detect()');
  results.fz = fz.ok ? { found: fz.data.found, count: fz.data.count, folders: (fz.data.folders || []).length } : { error: fz.error };
  if (fz.ok && fz.data.found) {
    check('config detected', fz.data.count > 0, results.fz);
    check('folders reported', Array.isArray(fz.data.folders));
  } else {
    console.log('  skip (no FileZilla config on this machine)');
  }

  /* ----------------------------------------------------- context menu */

  console.log('\n[context menu]');
  const ctx = await exec('local context menu', `(() => {
    const row = document.querySelector('#pane-local tbody tr[data-name]');
    if (!row) return { items: [] };
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    const items = Array.from(document.querySelectorAll('#ctxmenu button')).map(b => b.textContent.replace(/\\s*(F2|F5|⌫|⏎)$/, ''));
    L.closeCtx();
    return { items };
  })()`);
  results.ctx = ctx;
  check('local menu has the FileZilla actions',
    ['Upload', 'Create directory', 'Create empty file', 'Rename', 'Delete', 'Refresh'].every((i) => ctx.items.includes(i)), ctx.items);

  const rendererErrors = await exec('read renderer errors', 'window.__errors || []');
  check('no renderer errors', rendererErrors.length === 0, rendererErrors);
  check('no console errors', problems.length === 0, problems);

  clearTimeout(watchdog);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (process.env.UI_TEST_JSON) console.log(JSON.stringify(results, null, 1));
  fs.rmSync(USERDATA, { recursive: true, force: true });
  app.exit(fail || problems.length ? 1 : 0);
};

app.whenReady().then(() => run().catch(async (err) => {
  clearTimeout(watchdog);
  console.error('FAILED during step: ' + currentStep);
  console.error(err && err.stack ? err.stack : String(err));
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      const rendererErrors = await win.webContents.executeJavaScript('window.__errors || []');
      console.error('RENDERER ERRORS:\n' + (rendererErrors.join('\n---\n') || '(none captured)'));
    }
  } catch (e) { console.error('could not read renderer errors: ' + e.message); }
  if (problems.length) console.error('CONSOLE: ' + JSON.stringify(problems, null, 1));
  fs.rmSync(USERDATA, { recursive: true, force: true });
  process.exit(2);
}));

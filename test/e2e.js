// End-to-end: real SFTP server <-> Session + EditManager.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-e2e-'));
const serverRoot = path.join(tmp, 'server');
const localDir = path.join(tmp, 'local');
const editTemp = path.join(tmp, 'edits');
fs.mkdirSync(serverRoot); fs.mkdirSync(localDir); fs.mkdirSync(editTemp);

let settings = {
  transferExisting: 'overwrite',
  editorMode: 'command',
  editorCommand: '/usr/bin/true',      // harmless stand-in for a real editor
  editorApp: '',
  useFiletypeAssociations: false,
  alwaysUseDefaultEditor: true,
  associations: [],
  watchEditedFiles: true,
  uploadOnSave: 'auto',
  editTempDir: editTemp,
};

const stub = {
  app: { getPath: () => tmp },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '' },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return stub;
  return origLoad.apply(this, arguments);
};

const ROOT = path.join(__dirname, '..', 'src', 'main');
const Session = require(ROOT + '/session');
const { EditManager } = require(ROOT + '/editor');
const sftpServer = require(path.join(__dirname, 'sftp-server'));

let pass = 0; let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // server side fixtures
  fs.writeFileSync(path.join(serverRoot, 'config.php'), '<?php $x = 1;');
  fs.mkdirSync(path.join(serverRoot, 'logs'));
  fs.writeFileSync(path.join(serverRoot, 'logs', 'app.log'), 'line one\n');

  const srv = await sftpServer.start(serverRoot, 'deploy', 's3cret');
  console.log('SFTP test server on 127.0.0.1:' + srv.port + '\n');

  const events = [];
  const session = new Session((msg) => events.push(msg));
  session.settings = settings;
  const edits = new EditManager(session, (msg) => events.push(msg), () => settings);

  const idle = async (ms) => {
    for (let i = 0; i < 60; i += 1) {
      if (!session.running && !session.queue.some((q) => q.status === 'queued' || q.status === 'active')) return;
      await sleep(ms || 100);
    }
  };

  console.log('[connect]');
  const status = await session.connect({ protocol: 'sftp', host: '127.0.0.1', port: srv.port, user: 'deploy', password: 's3cret', authType: 'password' });
  check('connected', status.connected === true);
  check('home resolved', status.info.home === '/', status.info.home);
  check('chmod supported', status.supportsChmod === true);

  console.log('\n[list]');
  const listing = await session.list('/');
  const names = listing.items.map((i) => i.name).sort();
  check('entries found', JSON.stringify(names) === JSON.stringify(['config.php', 'logs']), names);
  const cfg = listing.items.find((i) => i.name === 'config.php');
  check('size read', cfg.size === 13, cfg.size);
  check('permissions parsed from longname', /^[rwx-]{9}$/.test(cfg.permissions), cfg.permissions);
  check('mode octal derived', typeof cfg.mode === 'number' && cfg.mode > 0, cfg.mode);
  check('directory flagged', listing.items.find((i) => i.name === 'logs').isDir === true);
  check('parent of / is /', listing.parent === '/');

  console.log('\n[download: file + recursive directory]');
  await session.enqueueDownload([
    { name: 'config.php', isDir: false, remotePath: '/config.php', size: 13 },
    { name: 'logs', isDir: true, remotePath: '/logs' },
  ], localDir);
  await idle();
  check('file downloaded', fs.readFileSync(path.join(localDir, 'config.php'), 'utf8') === '<?php $x = 1;');
  check('nested file downloaded', fs.existsSync(path.join(localDir, 'logs', 'app.log')));
  check('nested content intact', fs.readFileSync(path.join(localDir, 'logs', 'app.log'), 'utf8') === 'line one\n');
  check('queue marked done', session.queue.every((q) => q.status === 'done'), session.queue.map((q) => q.status));
  check('progress events emitted', events.some((e) => e.type === 'progress'));

  console.log('\n[upload: file + recursive directory]');
  fs.writeFileSync(path.join(localDir, 'deploy.sh'), '#!/bin/sh\necho hi\n');
  fs.mkdirSync(path.join(localDir, 'assets', 'css'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'assets', 'css', 'main.css'), 'body{margin:0}');
  await session.enqueueUpload([
    { name: 'deploy.sh', isDir: false, localPath: path.join(localDir, 'deploy.sh'), size: 18 },
    { name: 'assets', isDir: true, localPath: path.join(localDir, 'assets') },
  ], '/');
  await idle();
  check('file uploaded', fs.readFileSync(path.join(serverRoot, 'deploy.sh'), 'utf8') === '#!/bin/sh\necho hi\n');
  check('nested dir created on server', fs.existsSync(path.join(serverRoot, 'assets', 'css', 'main.css')));
  check('nested content intact', fs.readFileSync(path.join(serverRoot, 'assets', 'css', 'main.css'), 'utf8') === 'body{margin:0}');

  console.log('\n[mkdir / rename / chmod / delete]');
  await session.mkdir('/releases');
  check('mkdir', fs.statSync(path.join(serverRoot, 'releases')).isDirectory());
  await session.rename('/releases', '/releases-v2');
  check('rename', fs.existsSync(path.join(serverRoot, 'releases-v2')));
  await session.chmod('/deploy.sh', 0o750);
  check('chmod applied', (fs.statSync(path.join(serverRoot, 'deploy.sh')).mode & 0o777) === 0o750,
    (fs.statSync(path.join(serverRoot, 'deploy.sh')).mode & 0o777).toString(8));
  await session.remove([{ path: '/releases-v2', isDir: true }]);
  check('rmdir', !fs.existsSync(path.join(serverRoot, 'releases-v2')));
  await session.remove([{ path: '/deploy.sh', isDir: false }]);
  check('unlink', !fs.existsSync(path.join(serverRoot, 'deploy.sh')));

  console.log('\n[VIEW/EDIT: download -> editor -> save -> auto upload]');
  const opened = await edits.open('/config.php', 13, {});
  check('temp copy created', fs.existsSync(opened.localPath), opened.localPath);
  check('temp copy matches server', fs.readFileSync(opened.localPath, 'utf8') === '<?php $x = 1;');
  check('editor launched', opened.editor.includes('true'), opened.editor);
  check('watching', opened.watching === true);
  check('listed as being edited', edits.editedRemotePaths().includes('/config.php'));

  // the editor saves the file
  fs.writeFileSync(opened.localPath, '<?php $x = 42; // edited');
  for (let i = 0; i < 40; i += 1) {
    if (fs.readFileSync(path.join(serverRoot, 'config.php'), 'utf8').includes('42')) break;
    await sleep(250);
  }
  check('SAVE -> server file updated automatically',
    fs.readFileSync(path.join(serverRoot, 'config.php'), 'utf8') === '<?php $x = 42; // edited',
    fs.readFileSync(path.join(serverRoot, 'config.php'), 'utf8'));
  check('saved event emitted', events.some((e) => e.type === 'edit' && e.action === 'saved'));
  const sess1 = edits.list()[0];
  check('upload counted', sess1 && sess1.uploads === 1, sess1);

  console.log('\n[VIEW/EDIT: second save, already-editing guard, unedit]');
  fs.writeFileSync(opened.localPath, '<?php $x = 43;');
  for (let i = 0; i < 40; i += 1) {
    if (fs.readFileSync(path.join(serverRoot, 'config.php'), 'utf8').includes('43')) break;
    await sleep(250);
  }
  check('second save uploaded too', fs.readFileSync(path.join(serverRoot, 'config.php'), 'utf8') === '<?php $x = 43;');

  let guard = '';
  try { await edits.open('/config.php', 13, {}); } catch (e) { guard = e.code || e.message; }
  check('already-editing guard fires', guard === 'ALREADY_EDITING', guard);

  let dirGuard = '';
  try { await edits.open('/logs', 0, { isDir: true }); } catch (e) { dirGuard = e.message; }
  check('directories rejected', /Editing directories is not supported/.test(dirGuard), dirGuard);

  edits.stop(opened.localPath, true);
  check('unedit clears session', edits.list().length === 0);
  check('finish+delete removed temp file', !fs.existsSync(opened.localPath));

  console.log('\n[prompt mode]');
  settings = Object.assign({}, settings, { uploadOnSave: 'prompt' });
  const opened2 = await edits.open('/logs/app.log', 9, {});
  fs.writeFileSync(opened2.localPath, 'line two\n');
  await sleep(1600);
  check('prompt emitted instead of auto upload', events.some((e) => e.type === 'edit-prompt'));
  check('server untouched until approved', fs.readFileSync(path.join(serverRoot, 'logs', 'app.log'), 'utf8') === 'line one\n');
  await edits.uploadNow(opened2.localPath, true);
  check('explicit upload works', fs.readFileSync(path.join(serverRoot, 'logs', 'app.log'), 'utf8') === 'line two\n');
  check('upload+unedit cleared session', edits.list().length === 0);

  console.log('\n[concurrent transfers]');
  const bigNames = [];
  for (let i = 0; i < 8; i += 1) {
    const name = `big${i}.bin`;
    bigNames.push(name);
    fs.writeFileSync(path.join(serverRoot, name), Buffer.alloc(1536 * 1024, i));
  }
  const entriesFor = (names) => names.map((name) => ({ name, isDir: false, remotePath: '/' + name, size: 1536 * 1024 }));
  const peakActive = (from, direction) => {
    let peak = 0;
    for (const e of events.slice(from)) {
      if (e.type !== 'queue') continue;
      const n = e.items.filter((i) => i.status === 'active' && (!direction || i.direction === direction)).length;
      if (n > peak) peak = n;
    }
    return peak;
  };

  settings.maxTransfers = 3;
  settings.maxDownloads = 0;
  settings.maxUploads = 0;
  session.settings = settings;

  const parallelDir = path.join(localDir, 'parallel');
  fs.mkdirSync(parallelDir, { recursive: true });
  const mark1 = events.length;
  await session.enqueueDownload(entriesFor(bigNames), parallelDir);
  await idle();

  check('more than one transfer runs at once', peakActive(mark1) >= 2, peakActive(mark1));
  check('extra transfer connections were opened', session.workers.length >= 2, session.workers.length);
  check('status reports every open connection',
    session.status().connections === 1 + session.workers.length, session.status());
  check('every file arrived intact',
    bigNames.every((n) => fs.statSync(path.join(parallelDir, n)).size === 1536 * 1024));
  check('queue items record which connection carried them',
    session.queue.filter((q) => q.status === 'done').every((q) => q.connection >= 1));

  console.log('\n[per-direction limits]');
  settings.maxDownloads = 1;
  session.settings = settings;
  const limitDir = path.join(localDir, 'limited');
  fs.mkdirSync(limitDir, { recursive: true });
  const mark2 = events.length;
  await session.enqueueDownload(entriesFor(bigNames.slice(0, 5)), limitDir);
  await idle();
  check('"limit for concurrent downloads" is honoured', peakActive(mark2, 'down') === 1, peakActive(mark2, 'down'));
  check('all of them still completed', bigNames.slice(0, 5).every((n) => fs.existsSync(path.join(limitDir, n))));
  settings.maxDownloads = 0;
  session.settings = settings;

  console.log('\n[browsing stays responsive during transfers]');
  const duringDir = path.join(localDir, 'during');
  fs.mkdirSync(duringDir, { recursive: true });
  await session.enqueueDownload(entriesFor(bigNames), duringDir);
  const listedDuring = await session.list('/');
  const activeWhileListing = session.queue.filter((q) => q.status === 'active').length;
  check('directory listing works while files are moving', listedDuring.items.length > 0);
  check('transfers were actually in flight at that moment', activeWhileListing > 0, activeWhileListing);
  const mkdirDuring = '/while-busy';
  await session.mkdir(mkdirDuring);
  check('control connection can still create directories', fs.existsSync(path.join(serverRoot, 'while-busy')));
  await idle();
  await session.remove([{ path: mkdirDuring, isDir: true }]);

  console.log('\n[advanced: open directly at the configured path]');
  const base = { protocol: 'sftp', host: '127.0.0.1', port: srv.port, user: 'deploy', password: 's3cret', authType: 'password' };

  const pinned = await session.connect(Object.assign({}, base, {
    remotePath: '/logs', localPath: localDir, syncBrowsing: true, name: 'pinned site',
  }));
  check('opens at the configured remote path', pinned.info.home === '/logs', pinned.info.home);
  check('configured path reported back', pinned.info.configuredPath === '/logs');
  check('server home still known', pinned.info.serverHome === '/', pinned.info.serverHome);
  check('local path passed to the UI', pinned.info.localPath === localDir);
  check('sync browsing flag passed to the UI', pinned.info.syncBrowsing === true);
  const pinnedListing = await session.list(pinned.info.home);
  check('configured path actually lists', pinnedListing.items.some((i) => i.name === 'app.log'), pinnedListing.items.map((i) => i.name));

  const missingBefore = events.length;
  const fallback = await session.connect(Object.assign({}, base, { remotePath: '/does/not/exist' }));
  check('missing configured path falls back to server home', fallback.info.home === '/', fallback.info.home);
  check('fallback is logged as a warning',
    events.slice(missingBefore).some((e) => e.type === 'log' && e.level === 'warn' && /not found/.test(e.message)),
    events.slice(missingBefore).filter((e) => e.type === 'log').map((e) => e.message));

  const fileAsPath = await session.connect(Object.assign({}, base, { remotePath: '/config.php' }));
  check('a file as configured path also falls back', fileAsPath.info.home === '/', fileAsPath.info.home);

  console.log('\n[disconnect]');
  const after = await session.disconnect();
  check('disconnected', after.connected === false);

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nTEST CRASHED:', err);
  process.exit(2);
});

// Several servers connected at the same time (FileZilla's tabs).
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarv-tabs-'));
const settings = { maxTransfers: 2, maxDownloads: 0, maxUploads: 0, transferExisting: 'overwrite' };
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

const SessionManager = require(path.join(__dirname, '..', 'src', 'main', 'session-manager'));
const sftpServer = require(path.join(__dirname, 'sftp-server'));

let pass = 0; let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // two independent servers, so a mix-up between tabs is impossible to miss
  const rootA = path.join(tmp, 'serverA');
  const rootB = path.join(tmp, 'serverB');
  fs.mkdirSync(rootA); fs.mkdirSync(rootB);
  fs.writeFileSync(path.join(rootA, 'only-on-a.txt'), 'A');
  fs.writeFileSync(path.join(rootB, 'only-on-b.txt'), 'B');
  for (let i = 0; i < 4; i += 1) {
    fs.writeFileSync(path.join(rootA, `a${i}.bin`), Buffer.alloc(900 * 1024, 1));
    fs.writeFileSync(path.join(rootB, `b${i}.bin`), Buffer.alloc(900 * 1024, 2));
  }

  const srvA = await sftpServer.start(rootA, 'ua', 'pa');
  const srvB = await sftpServer.start(rootB, 'ub', 'pb');
  console.log(`servers on 127.0.0.1:${srvA.port} and :${srvB.port}\n`);

  const events = [];
  const manager = new SessionManager((msg) => events.push(msg), () => settings);

  console.log('[tabs]');
  const idA = manager.ensureDefault();
  check('a default tab exists', Boolean(idA));
  const idB = manager.create();
  check('a second tab can be created', idB !== idA);
  check('both are listed', manager.list().tabs.length === 2, manager.list().tabs.map((t) => t.id));
  manager.activate(idB);
  check('activating switches the active tab', manager.list().activeId === idB);

  console.log('\n[two servers at once]');
  const cfgA = { protocol: 'sftp', host: '127.0.0.1', port: srvA.port, user: 'ua', password: 'pa', authType: 'password', name: 'Server A' };
  const cfgB = { protocol: 'sftp', host: '127.0.0.1', port: srvB.port, user: 'ub', password: 'pb', authType: 'password', name: 'Server B' };

  const [stA, stB] = await Promise.all([
    manager.get(idA).session.connect(cfgA),
    manager.get(idB).session.connect(cfgB),
  ]);
  check('both tabs connected', stA.connected && stB.connected);
  check('neither connection replaced the other',
    manager.get(idA).session.info.port === srvA.port && manager.get(idB).session.info.port === srvB.port);

  const [listA, listB] = await Promise.all([
    manager.get(idA).session.list('/'),
    manager.get(idB).session.list('/'),
  ]);
  check('tab A sees only its own files', listA.items.some((i) => i.name === 'only-on-a.txt') && !listA.items.some((i) => i.name === 'only-on-b.txt'));
  check('tab B sees only its own files', listB.items.some((i) => i.name === 'only-on-b.txt') && !listB.items.some((i) => i.name === 'only-on-a.txt'));
  check('tab list reports both as connected', manager.list().tabs.every((t) => t.connected));
  check('tab titles come from the site name',
    manager.list().tabs.map((t) => t.title).sort().join(',') === 'Server A,Server B', manager.list().tabs.map((t) => t.title));

  console.log('\n[transfers run in both tabs together]');
  const outA = path.join(tmp, 'outA'); const outB = path.join(tmp, 'outB');
  fs.mkdirSync(outA); fs.mkdirSync(outB);
  const entries = (prefix) => [0, 1, 2, 3].map((i) => ({ name: `${prefix}${i}.bin`, isDir: false, remotePath: `/${prefix}${i}.bin`, size: 900 * 1024 }));

  await Promise.all([
    manager.get(idA).session.enqueueDownload(entries('a'), outA),
    manager.get(idB).session.enqueueDownload(entries('b'), outB),
  ]);

  // both tabs should be moving files at the same moment
  let sawBothBusy = false;
  for (let i = 0; i < 100; i += 1) {
    const busyA = manager.get(idA).session.queue.some((q) => q.status === 'active');
    const busyB = manager.get(idB).session.queue.some((q) => q.status === 'active');
    if (busyA && busyB) { sawBothBusy = true; break; }
    await sleep(25);
  }
  check('both tabs transfer at the same time', sawBothBusy);

  for (let i = 0; i < 200; i += 1) {
    const done = [idA, idB].every((id) => !manager.get(id).session.queue.some((q) => q.status === 'queued' || q.status === 'active'));
    if (done) break;
    await sleep(50);
  }
  check('tab A files all arrived', [0, 1, 2, 3].every((i) => fs.statSync(path.join(outA, `a${i}.bin`)).size === 900 * 1024));
  check('tab B files all arrived', [0, 1, 2, 3].every((i) => fs.statSync(path.join(outB, `b${i}.bin`)).size === 900 * 1024));
  check('queues stayed separate',
    manager.get(idA).session.queue.every((q) => q.remotePath.startsWith('/a'))
    && manager.get(idB).session.queue.every((q) => q.remotePath.startsWith('/b')));
  // 'tabs' is the only global event; everything else must say which tab it came from.
  const perTab = events.filter((e) => e.type !== 'tabs');
  check('every per-tab event carries its tab id',
    perTab.every((e) => e.sessionId === idA || e.sessionId === idB),
    perTab.filter((e) => !e.sessionId).map((e) => e.type).slice(0, 5));
  check('tab events are global', events.some((e) => e.type === 'tabs' && !e.sessionId));

  console.log('\n[closing tabs]');
  // queue something and try to close while it is still running
  const closeDir = path.join(tmp, 'outA2');
  fs.mkdirSync(closeDir);
  await manager.get(idA).session.enqueueDownload(entries('a'), closeDir);
  let busyNow = false;
  for (let i = 0; i < 100; i += 1) {
    if (manager.busy(idA)) { busyNow = true; break; }
    await sleep(10);
  }
  check('the tab reports itself busy during a transfer', busyNow);

  let busyErr = '';
  try { await manager.close(idA); } catch (e) { busyErr = e.code || e.message; }
  check('a busy tab refuses to close', busyErr === 'TAB_BUSY', busyErr);
  await manager.close(idA, true);
  check('force close works', !manager.has(idA));
  check('the other tab is untouched and still connected', manager.get(idB).session.isConnected());
  check('closing switched the active tab', manager.list().activeId === idB);

  await manager.close(idB, true);
  check('closing the last tab opens a fresh one', manager.list().tabs.length === 1);
  check('the fresh tab is not connected', manager.list().tabs[0].connected === false);

  await manager.shutdown();
  srvA.close(); srvB.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nTEST CRASHED:', err);
  process.exit(2);
});

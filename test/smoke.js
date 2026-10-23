// Smoke test for the main-process modules, with electron stubbed out.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-smoke-'));
const stub = {
  app: { getPath: (k) => (k === 'userData' ? path.join(tmp, 'userData') : tmp) },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '' },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return stub;
  return origLoad.apply(this, arguments);
};

const ROOT = path.join(__dirname, '..', 'src', 'main');
const store = require(ROOT + '/store');
const localfs = require(ROOT + '/localfs');
const { fileKind, resolveEditorConfig } = require(ROOT + '/editor');
const Session = require(ROOT + '/session');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

console.log('\n[store] settings + sites');
const s0 = store.getSettings();
check('defaults present', s0.editorMode === 'app' && s0.uploadOnSave === 'auto' && s0.transferExisting === 'overwrite');
const s1 = store.setSettings({ uploadOnSave: 'prompt', compareThreshold: 5 });
check('setSettings merges', s1.uploadOnSave === 'prompt' && s1.compareThreshold === 5 && s1.editorMode === 'app');
const site = store.saveSite({ name: 'box', protocol: 'sftp', host: '10.0.0.5', user: 'root', password: 'hunter2' });
check('site saved with id', Boolean(site.id) && site.hasPassword === true);
check('public site hides password', !('password' in site));
const listed = store.listSites();
check('site listed', listed.length === 1 && listed[0].host === '10.0.0.5');
const secrets = store.getSiteSecrets(site.id);
check('secret round-trips', secrets.password === 'hunter2', secrets.password);
const resaved = store.saveSite({ id: site.id, name: 'box2', host: '10.0.0.5', user: 'root', password: '' });
check('empty password keeps stored one', store.getSiteSecrets(site.id).password === 'hunter2');
check('rename applied', resaved.name === 'box2');
store.removeSite(site.id);
check('site removed', store.listSites().length === 0);

console.log('\n[store] folders');
store.importSites([
  { name: 'p1', host: 'h1', port: 22, user: 'u', protocol: 'sftp', folder: 'Prod' },
  { name: 'p2', host: 'h2', port: 22, user: 'u', protocol: 'sftp', folder: 'Prod/EU' },
  { name: 'free', host: 'h3', port: 22, user: 'u', protocol: 'sftp', folder: '' },
]);
check('folders derived from sites', JSON.stringify(store.listFolders()) === JSON.stringify(['Prod', 'Prod/EU']), store.listFolders());
store.addFolder('Staging');
check('empty folder is remembered', store.listFolders().includes('Staging'));
let dupErr = '';
try { store.addFolder('Staging'); } catch (e) { dupErr = e.message; }
check('duplicate folder rejected', /already exists/.test(dupErr), dupErr);
store.renameFolder('Prod', 'Production');
check('rename moves the folder', store.listFolders().includes('Production'));
check('rename moves nested folders too', store.listFolders().includes('Production/EU'));
check('rename moves the sites', store.listSites().find((s) => s.name === 'p2').folder === 'Production/EU');
const freeSite = store.listSites().find((s) => s.name === 'free');
store.setSiteFolder(freeSite.id, 'Staging');
check('site moved into a folder', store.listSites().find((s) => s.name === 'free').folder === 'Staging');
store.setSiteFolder(freeSite.id, '');
check('site moved back to top level', store.listSites().find((s) => s.name === 'free').folder === '');
const removed = store.removeFolder('Production');
check('folder removed', !removed.folders.includes('Production'));
check('nested folder removed too', !removed.folders.includes('Production/EU'));
check('its sites survived at top level', removed.movedToTop === 2
  && store.listSites().filter((s) => s.folder === '').length === 3, store.listSites().map((s) => s.folder));
check('other folders untouched', removed.folders.includes('Staging'));
for (const site of store.listSites()) store.removeSite(site.id);

console.log('\n[localfs] listing + walk + uniquePath');
const tree = path.join(tmp, 'tree');
fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
fs.writeFileSync(path.join(tree, 'a.txt'), 'hello');
fs.writeFileSync(path.join(tree, 'sub', 'b.sql'), 'select 1');
(async () => {
  const listing = await localfs.list(tree);
  check('list returns both entries', listing.items.length === 2, listing.items.map((i) => i.name));
  const file = listing.items.find((i) => i.name === 'a.txt');
  check('file size + perms', file.size === 5 && /^[rwx-]{9}$/.test(file.permissions), file);
  const dir = listing.items.find((i) => i.name === 'sub');
  check('directory flagged', dir.isDir === true);
  const walked = await localfs.walk(tree);
  check('walk finds nested file', walked.some((n) => n.rel === 'sub/b.sql' && n.type === 'file'), walked);
  check('walk includes dir node', walked.some((n) => n.rel === 'sub' && n.type === 'dir'));
  const uniq = localfs.uniquePath(path.join(tree, 'a.txt'));
  check('uniquePath avoids collision', path.basename(uniq) === 'a (1).txt', uniq);

  console.log('\n[editor] file kind + association resolution');
  check('ext', fileKind('/srv/app/index.php') === 'php');
  check('dotfile', fileKind('/srv/app/.env') === 'dotfile');
  check('extensionless', fileKind('/srv/app/Makefile') === 'extensionless');
  check('multi-dot', fileKind('/srv/a.tar.gz') === 'gz');

  const base = { editorMode: 'app', editorApp: 'Visual Studio Code', editorCommand: 'code', useFiletypeAssociations: true, alwaysUseDefaultEditor: false, associations: [{ ext: '.php', mode: 'app', value: 'PhpStorm' }] };
  check('association wins', resolveEditorConfig('/a/x.php', base).app === 'PhpStorm');
  check('default for other ext', resolveEditorConfig('/a/x.js', base).app === 'Visual Studio Code');
  check('alwaysUseDefaultEditor overrides assoc',
    resolveEditorConfig('/a/x.php', Object.assign({}, base, { alwaysUseDefaultEditor: true })).app === 'Visual Studio Code');
  check('assoc ignored when disabled',
    resolveEditorConfig('/a/x.php', Object.assign({}, base, { useFiletypeAssociations: false })).app === 'Visual Studio Code');
  let threw = '';
  try {
    resolveEditorConfig('/a/x.php', { editorMode: 'app', editorApp: '', useFiletypeAssociations: true, associations: [] });
  } catch (e) { threw = e.message; }
  check('no editor -> FileZilla-style error', /No program has been associated to edit files with the extension 'php'/.test(threw), threw);
  let threw2 = '';
  try {
    resolveEditorConfig('/a/.env', { editorMode: 'command', editorCommand: '', useFiletypeAssociations: true, associations: [] });
  } catch (e) { threw2 = e.message; }
  check('dotfile error wording', /dotfiles/.test(threw2), threw2);

  console.log('\n[session] "default file exists action"');
  const sess = new Session(() => {});
  const target = path.join(tree, 'a.txt'); // exists, 5 bytes
  const mt = fs.statSync(target).mtimeMs;
  const run = (policy, item) => { sess.settings = { transferExisting: policy }; return sess.resolveLocalTarget(Object.assign({ localPath: target }, item)); };
  check('overwrite -> same path', run('overwrite', { size: 99 }) === target);
  check('skip -> null', run('skip', { size: 99 }) === null);
  check('rename -> new name', path.basename(run('rename', { size: 99 })) === 'a (1).txt');
  check('different-size: same size skips', run('overwrite-different-size', { size: 5 }) === null);
  check('different-size: other size writes', run('overwrite-different-size', { size: 7 }) === target);
  check('size-or-newer: same size + older remote skips', run('overwrite-size-or-newer', { size: 5, remoteMtime: mt - 60000 }) === null);
  check('size-or-newer: newer remote writes', run('overwrite-size-or-newer', { size: 5, remoteMtime: mt + 60000 }) === target);
  check('missing local always writes', sess.resolveLocalTarget({ localPath: path.join(tree, 'nope.txt'), size: 1 }) === path.join(tree, 'nope.txt'));

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();

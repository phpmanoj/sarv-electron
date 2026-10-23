// FileZilla sitemanager.xml import / export.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarv-fz-'));
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

const fz = require(path.join(__dirname, '..', 'src', 'main', 'filezilla'));

let pass = 0; let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

console.log('\n[CServerPath codec]');
check('decode real sample', fz.decodeServerPath('1 0 3 usr 3 lib 12 sarv_modules') === '/usr/lib/sarv_modules',
  fz.decodeServerPath('1 0 3 usr 3 lib 12 sarv_modules'));
check('decode single segment', fz.decodeServerPath('1 0 4 logs') === '/logs');
check('decode deep path', fz.decodeServerPath('1 0 3 usr 5 share 5 nginx 4 html') === '/usr/share/nginx/html');
check('decode empty', fz.decodeServerPath('') === '');
check('decode root only', fz.decodeServerPath('1 0') === '/');
check('segment with space', fz.decodeServerPath('1 0 8 my files 3 www') === '/my files/www',
  fz.decodeServerPath('1 0 8 my files 3 www'));
check('encode matches FileZilla shape', fz.encodeServerPath('/usr/lib/sarv_modules') === '1 0 3 usr 3 lib 12 sarv_modules',
  fz.encodeServerPath('/usr/lib/sarv_modules'));
check('encode root -> empty', fz.encodeServerPath('/') === '');
const roundTrips = ['/usr/lib/sarv_modules', '/app/telephony', '/my files/www', '/a'];
check('encode -> decode round-trip', roundTrips.every((p) => fz.decodeServerPath(fz.encodeServerPath(p)) === p));

console.log('\n[XML parser]');
const parsed = fz.parseXml('<a x="1"><b>hi</b><c/><b>there &amp; more</b></a>');
const a = parsed.children[0];
check('root element', a.name === 'a' && a.attrs.x === '1');
check('children counted', a.children.length === 3);
check('text decoded', a.children[2].text === 'there & more', a.children[2].text);
check('self-closing not nested', a.children[1].name === 'c' && a.children[1].children.length === 0);
const mixed = fz.parseXml('<Folder expanded="0">Group A<Server><Host>h</Host></Server></Folder>').children[0];
check('folder keeps its own text', mixed.text.trim() === 'Group A', mixed.text);
check('folder keeps its children', mixed.children.length === 1 && mixed.children[0].name === 'Server');

console.log('\n[readSites]');
const sample = `<?xml version="1.0"?>
<FileZilla3 version="3.71.1" platform="mac">
	<Servers>
		<Server>
			<Host>plain.example.com</Host><Port>2222</Port><Protocol>1</Protocol>
			<User>root</User><Pass encoding="base64">${Buffer.from('p@ss word', 'utf8').toString('base64')}</Pass>
			<Logontype>1</Logontype><Name>Plain &amp; simple</Name>
			<RemoteDir>1 0 3 srv 3 app</RemoteDir><LocalDir>/Users/me/dev</LocalDir>
			<SyncBrowsing>1</SyncBrowsing>
		</Server>
		<Folder expanded="0">Prod<Server>
				<Host>key.example.com</Host><Port>22</Port><Protocol>1</Protocol>
				<User>deploy</User><Logontype>5</Logontype><Keyfile>/Users/me/.ssh/id_ed25519</Keyfile>
				<Name>Key site</Name>
			</Server><Server>
				<Host>ftp.example.com</Host><Port>21</Port><Protocol>0</Protocol>
				<User>anonymous</User><Logontype>0</Logontype><Name>Old FTP</Name>
			</Server></Folder>
		<Folder expanded="1">Cloud<Server>
				<Host>bucket</Host><Port>443</Port><Protocol>7</Protocol><User>k</User>
				<Logontype>1</Logontype><Name>S3 bucket</Name>
			</Server><Server>
				<Host>locked.example.com</Host><Port>22</Port><Protocol>1</Protocol><User>u</User>
				<Pass encoding="crypt">zzz</Pass><Logontype>1</Logontype><Name>Master pw site</Name>
			</Server></Folder>
	</Servers>
</FileZilla3>`;
const samplePath = path.join(tmp, 'sitemanager.xml');
fs.writeFileSync(samplePath, sample);
const read = fz.readSites(samplePath);

check('version read', read.version === '3.71.1');
check('supported sites imported', read.sites.length === 4, read.sites.map((s) => s.name));
const plain = read.sites.find((s) => s.name === 'Plain & simple');
check('entity-decoded name', Boolean(plain));
check('port read', plain.port === 2222);
check('protocol mapped to sftp', plain.protocol === 'sftp');
check('base64 password decoded', plain.password === 'p@ss word', plain.password);
check('remote dir decoded', plain.remotePath === '/srv/app', plain.remotePath);
check('local dir read', plain.localPath === '/Users/me/dev');
check('sync browsing read', plain.syncBrowsing === true);
check('top-level site has no folder', plain.folder === '');

const keySite = read.sites.find((s) => s.name === 'Key site');
check('folder captured', keySite.folder === 'Prod', keySite.folder);
check('logontype 5 -> key', keySite.authType === 'key');
check('keyfile read', keySite.keyPath === '/Users/me/.ssh/id_ed25519');

const ftpSite = read.sites.find((s) => s.name === 'Old FTP');
check('protocol 0 -> ftp', ftpSite.protocol === 'ftp');
check('anonymous -> password auth', ftpSite.authType === 'password');

check('unsupported protocol skipped', !read.sites.some((s) => s.name === 'S3 bucket'));
check('skip reason names S3', read.skipped.some((s) => s.name === 'S3 bucket' && /S3/.test(s.reason)), read.skipped);
const locked = read.sites.find((s) => s.name === 'Master pw site');
check('master-password site still imported', Boolean(locked));
check('master-password left empty', locked.password === '');
check('master-password reason recorded', read.skipped.some((s) => /master password/.test(s.reason)));

console.log('\n[writeSites]');
const outPath = path.join(tmp, 'exported.xml');
fs.writeFileSync(outPath, fz.writeSites(read.sites, { includePasswords: true }));
const back = fz.readSites(outPath);
check('round-trip count', back.sites.length === read.sites.length, back.sites.length);
const bPlain = back.sites.find((s) => s.name === 'Plain & simple');
check('round-trip host/port/user', bPlain.host === 'plain.example.com' && bPlain.port === 2222 && bPlain.user === 'root');
check('round-trip password', bPlain.password === 'p@ss word');
check('round-trip remote path', bPlain.remotePath === '/srv/app');
check('round-trip local path', bPlain.localPath === '/Users/me/dev');
check('round-trip sync flag', bPlain.syncBrowsing === true);
check('round-trip folder', back.sites.find((s) => s.name === 'Key site').folder === 'Prod');
check('round-trip keyfile', back.sites.find((s) => s.name === 'Key site').keyPath === '/Users/me/.ssh/id_ed25519');
check('round-trip ftp protocol', back.sites.find((s) => s.name === 'Old FTP').protocol === 'ftp');

const noPass = fz.writeSites(read.sites, { includePasswords: false });
check('includePasswords:false omits <Pass>', !/<Pass/.test(noPass));
check('name is XML-escaped', /<Name>Plain &amp; simple<\/Name>/.test(noPass));

console.log('\n[real FileZilla config on this machine]');
const found = fz.detect();
if (!found) {
  console.log('  skip (no sitemanager.xml found)');
} else {
  const real = fz.readSites(found.path);
  check('parses without throwing', Array.isArray(real.sites));
  check('every site has a host', real.sites.every((s) => s.host));
  check('every site has a known protocol', real.sites.every((s) => ['sftp', 'ftp', 'ftps'].includes(s.protocol)));
  check('every port is a number', real.sites.every((s) => Number.isFinite(s.port) && s.port > 0));
  check('decoded remote paths are absolute', real.sites.filter((s) => s.remotePath).every((s) => s.remotePath.startsWith('/')));
  check('re-export round-trips every site', (() => {
    const p2 = path.join(tmp, 'real-round.xml');
    fs.writeFileSync(p2, fz.writeSites(real.sites, { includePasswords: true }));
    const r2 = fz.readSites(p2);
    if (r2.sites.length !== real.sites.length) return false;
    return real.sites.every((s, i) => r2.sites[i].host === s.host && r2.sites[i].remotePath === s.remotePath
      && r2.sites[i].password === s.password && r2.sites[i].folder === s.folder);
  })());
  console.log(`  (${real.sites.length} real sites checked, ${real.skipped.length} skipped)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

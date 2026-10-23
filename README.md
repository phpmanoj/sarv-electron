# Sarv Electron

FileZilla-style SFTP / FTP / FTPS client — simple design, aur iski asli khaasiyat:
**remote file ko aapke chune hue editor me kholta hai aur save karte hi server par
wapas upload kar deta hai.**

Feature set guess nahi kiya gaya — asli FileZilla 3.71.1 ko REA se reverse engineer
karke nikala gaya hai. Poori evidence: [`docs/REVERSE-ENGINEERED-SPEC.md`](docs/REVERSE-ENGINEERED-SPEC.md).

## Chalane ke liye

```bash
npm install
npm start      # npm run dev  -> DevTools ke saath
```

## Install karne layak app banana (packaging)

`electron-builder` se real installer banta hai. Sab kuch `dist/` me jaata hai.

```bash
npm run pack        # sirf .app folder (bina installer) - fastest check
npm run dist:mac    # macOS: arm64 + Intel ki .dmg aur .zip
npm run dist:win    # Windows: NSIS .exe installer
npm run dist:linux  # Linux: AppImage + .deb
```

macOS par banne wali files:

| File | Kiske liye |
|---|---|
| `dist/Sarv Electron-1.0.0-arm64.dmg` | Apple Silicon - drag to Applications |
| `dist/Sarv Electron-1.0.0.dmg` | Intel Mac |
| `dist/*-mac.zip` | auto-update / manual distribution |
| `dist/mac-arm64/Sarv Electron.app` | unpacked app, direct chal jaata hai |

**Install:** `.dmg` kholo, app ko **Applications** folder par drag kar do. Bas.

### Gatekeeper (zaroori)

Build **unsigned** hai (koi Apple Developer certificate nahi). Apne Mac par
seedha chalta hai, lekin kisi aur ko bhejne par macOS "damaged" bolega kyunki
download par quarantine flag lagta hai. Receiver ye chala de:

```bash
xattr -cr "/Applications/Sarv Electron.app"
```

Ya `.app` par right-click -> **Open** -> **Open**.

Isko permanently theek karna ho to Apple Developer Program ($99/yr) chahiye —
phir `CSC_LINK` / `CSC_KEY_PASSWORD` env vars set karke `notarize` on kar dena.

### Windows / Linux build

Dono config me ready hain, par Mac se cross-build karne ke liye Docker chahiye:

```bash
docker run --rm -v "$PWD":/project -w /project \
  electronuserland/builder:wine npm run dist:win
```

Sabse aasan tareeka: us OS par ja kar `npm install && npm run dist:win` chala do.

## Icon

Icon SVG se banta hai, raster nahi — kabhi bhi badal sakte hain:

```bash
npm run icon                                   # build/icon.svg  -> icon.png + icon.icns
electron build/make-icon.js icon-chevron.svg   # kisi aur variant se banane ke liye
```

| File | Kya hai |
|---|---|
| `build/icon.svg` | **live icon** — bead ring ke beech "E" |
| `build/icon-chevron.svg` | sirf chevron wala version |
| `build/icon-chevron-e.svg` | chevron + E |

Koi dusra variant chahiye to us file ka content `build/icon.svg` me daal kar
`npm run icon` chala dein. Colors ek jagah hain: `#EE7B30` (orange),
`#1D4F91` (blue). Dev me dock icon `app.dock.setIcon()` se lagta hai,
packaged build `build/icon.icns` use karega.

## Tests

```bash
npm test        # 179 checks: logic, folders, FileZilla import/export, multi-tab, SFTP end-to-end
npm run test:ui # 91 checks: asli Electron window - layout, 21 themes, tabs, folder tree, dialogs
```

`npm test` ek asli SFTP server in-process chalata hai (`test/sftp-server.js`) aur
verify karta hai: connect, list, recursive download/upload, mkdir, rename, chmod,
delete, **View/Edit ka poora flow** (save karte hi server par upload, prompt mode,
already-being-edited guard, unedit), aur **configured path par connect hona** +
path galat ho to fallback. Koi external server ki zarurat nahi.

`test/filezilla.js` import/export ko aapki asli `sitemanager.xml` ke against bhi
chalata hai (read-only) — 173 sites parse hoti hain aur re-export karke har site
field-by-field match hoti hai.

## Jo kaam karta hai

**Connection**
- Quickconnect bar: protocol (SFTP / FTP / FTPS), host, user, password, port
- Site Manager: saved sites folder-wise grouped, filter box, logon type
  (password / key file / SSH agent). Password macOS Keychain me encrypted
  (Electron `safeStorage`), plain text me kahin nahi.

**Multiple servers at once (tabs)**
- Remote pane ke upar tab bar — har tab apna server, apna remote path, apni queue
- `+` ya Cmd+T se naya tab; Site Manager se connect karte waqt poochta hai
  "Connect in new tab" ya "Connect in current tab"
- Tab par right-click → New tab / Close tab / Close all other tabs
- Transfer chal raha ho to tab band nahi hota ("Cannot close tab while busy") —
  confirm karo to transfers cancel karke band ho jata hai
- Queue sab tabs ki transfers ek saath dikhati hai, har row par server ka tag

**Concurrent transfers (ek hi server par)**
- Settings → Concurrent transfers: Maximum simultaneous transfers (1–10, default 2),
  Limit for concurrent downloads / uploads (0–10, 0 = alag limit nahi)
- Har transfer slot apna connection kholta hai (pehli baar use hone par), aur
  browsing ke liye alag **control connection** rehta hai — isi liye bade transfer
  ke dauraan bhi folder listing turant aati hai
- Status bar batata hai kitne connections khule hain
- Connect par phase-wise timing log hoti hai (`tcp+kex`, `auth`, `sftp`, `realpath`)
  taaki slow connection ki asli wajah pata chale

**Themes — 25 + System**
- Toolbar me seedha dropdown, Light/Dark groups me bata hua
- **Light (12):** neutral, Sarv orange, Sky blue, Mint green, Emerald green,
  Olive green, Lavender, Rose, Sand, Paper (sepia), Solarized, High contrast
- **Dark (13):** neutral, Sarv orange, Midnight blue, Ocean teal, Forest green,
  Emerald green, Matrix green, Nord, Dracula, Plum, Carbon, Solarized, High contrast
- **Har SFTP tab ki apni theme** ho sakti hai — tab par right-click → "Theme for
  this tab...". Tab badalte hi theme bhi badal jati hai, taaki prod aur dev server
  dekh kar hi alag pehchan aayein
- Turant apply hoti hai aur save ho jati hai; native title bar bhi match karta hai
- Nayi theme add karni ho to `src/renderer/themes.css` me ek
  `:root[data-theme="name"]` block aur `app.js` ke `THEMES` array me ek line — bas
  (test dono ko sync me rakhta hai)

**Apni theme khud banao**
- Settings → Appearance → **Create new theme...**
- Sirf 6 rang chunne hain: window background, panels, borders, text, dim text, accent.
  Baki sab (hover, selection, header, row stripes, status colours) inhi se derive hote hain
- **Start from** se kisi bhi maujooda theme ke rang uthakar usme badlaav kar sakte hain
- Dark theme ka checkbox, live preview, aur Save — theme picker me "My themes" group me aa jati hai
- Edit this theme... / Delete bhi wahin se

**Apni image ka background**
- Settings → Appearance → Background image → Browse... se koi bhi image chunein
- **Image fit:** cover / contain / centre / tile
- **Panel opacity:** panels kitne see-through ho (image zyada ya kam dikhe)
- **Dim the image:** image ke upar theme colour ka halka parda, taaki text saaf padhe
- Clear dabate hi wapas normal

**Site Manager folders (FileZilla jaisa tree)**
- Folders expand/collapse hote hain, har folder par site count
- Expand all / Collapse all buttons
- **New folder** button, subfolder bhi ban sakta hai (right-click → New subfolder)
- Site ko drag karke folder me daal sakte hain; list ke khali hisse par chhodo to top level
- Right-click folder → Rename / Delete (delete karne par sites top level par chali jati hain, delete nahi hoti)
- Filter type karte hi matching folders apne aap khul jate hain

**FileZilla import / export**
- Site Manager → **Import...** aapki asli FileZilla config utha leta hai
  (`~/.config/filezilla/sitemanager.xml` khud detect hoti hai, ya file choose karo)
- Folders, host/port/user, passwords (base64 se decode hokar Keychain me encrypted),
  key files, remote path, local path, sync-browsing flag — sab aata hai
- Options: passwords import karein ya nahi, pehle se maujood sites skip karein ya update
- Jo protocols ye app abhi nahi bolta (S3, Storj, WebDAV, Dropbox...) wo skip hote hain
  aur message log me reason ke saath dikhte hain
- **Export...** sab sites wapas FileZilla ke format me likhta hai — FileZilla me ya
  dusre machine par import ho jayegi. Passwords optional hain (FileZilla format me
  base64 hota hai, encryption nahi — file sambhal kar rakhein)

**Advanced: path se redirect**
- Har site ke Advanced section me **Default remote directory** aur
  **Default local directory** set kar sakte hain
- Connect karte hi dono panes seedha wahi path kholte hain — har baar navigate
  karne ki zarurat nahi
- Path mojood na ho to server ka home khulta hai aur log me warning aati hai
  (connect fail nahi hota)
- Per-site **synchronized browsing** bhi connect par apne aap on ho jati hai

**Dono panes (Local site / Remote site)**
- Local columns: Filename, Filesize, Filetype, Last modified
- Remote columns: wahi + Permissions, Owner/Group (chmod ke liye kaam ke hain)
- Sort (column header click), quick filter, path bar, up/refresh
- Multi-select (Cmd / Shift), drag & drop se dusre pane me transfer
- Directory comparison (size / modification time / threshold / hide identical)
- Synchronized browsing
- Pane splitter, swap panes, hidden files toggle

**File operations**
- Download / Upload (folders recursive), transfer queue with progress
- Queue tabs: Queued files / Failed transfers / Successful transfers
- Create directory, create directory and enter it, create empty file
- Rename (F2), Delete (local = Trash, remote = recursive), Refresh (F5)
- File permissions (chmod) — numeric + checkboxes
- Copy URL(s) to clipboard, Open directory in Finder
- "Default file exists action": overwrite / overwrite if different size /
  overwrite if different size or source newer / rename / skip

**View / Edit (main feature)**
- Remote file par double-click ya right-click → **View / Edit**
- File temp folder me download hoti hai, aapka editor khulta hai, aur file watch hoti hai
- Save karte hi auto upload (ya "Ask me before uploading" setting)
- Editor choose karne ke 3 tareeke:
  - **App** — installed app ka naam (VS Code, Cursor, Sublime, PhpStorm... auto-detect hote hain)
  - **Command** — `code`, `subl -w`, `/usr/local/bin/code` jaisa koi command
  - **System** — OS ka default editor
- Per-extension associations: `php` → PhpStorm, `sql` → VS Code, etc.
  (`dotfile` aur `extensionless` special keys hain)
- "Always use default editor" / "Use filetype associations if available" toggles
- **Being edited** dialog: Upload and unedit, Reopen, Finish editing,
  Finish + delete local, Re-download
- Remote pane me under-edit files par `being edited` badge

## Keyboard

| Key | Action |
|---|---|
| F5 | Refresh both panes |
| F2 | Rename selection |
| Delete / Backspace | Delete selection |
| Cmd+S | Site Manager |
| Cmd+E | Files currently being edited |
| Cmd+O | Directory comparison |
| Cmd+Y | Synchronized browsing |
| Cmd+D | Disconnect |
| Cmd+, | Settings |

## Code kahan hai (modify karne ke liye)

```
src/main/
  main.js            Electron window + application menu
  ipc.js             saare IPC handlers — naya feature yahan register hota hai
  session-manager.js tabs - kai servers ek saath
  session.js         ek server: control connection + transfer connection pool + queue
  editor.js          View/Edit: download -> editor -> watch -> upload
  store.js           settings + sites (Keychain-encrypted passwords)
  filezilla.js       FileZilla sitemanager.xml parse + write (CServerPath codec included)
  localfs.js         local filesystem side
  remote/sftp.js     SFTP backend  (ssh2-sftp-client)
  remote/ftp.js      FTP/FTPS backend (basic-ftp)
src/preload/preload.js   contextBridge API — renderer ko yahi dikhta hai
src/renderer/
  index.html         layout
  styles.css         CSS variables (light + dark), ek jagah se theme badal jayega
  lib.js             DOM helpers, modals, toasts, context menu
  panes.js           file list pane component (dono panes ke liye)
  app.js             wiring: connection, queue, dialogs, settings, menus
```

Naya remote backend add karna ho (S3, WebDAV, Storj) to `src/main/remote/` me
wahi interface implement karo jo `sftp.js` karta hai — `connect / list / download /
upload / mkdir / removeFile / removeDir / rename / chmod / stat` — aur `session.js`
ke `connect()` me register kar do.

## Abhi nahi hai (FileZilla me hai)

Multiple simultaneous transfers, resume, speed limits, ASCII/binary transfer mode,
bookmarks, directory tree view, remote search, filters/filter sets, tabs,
proxy support, master password. In sab ke liye hooks aur jagah code me maujood hai.

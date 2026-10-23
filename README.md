# Sarv Electron

A FileZilla-style SFTP / FTP / FTPS client with a deliberately simple design. Its
defining feature: **it opens a remote file in your own editor and uploads it back
to the server the moment you save.**

## Running it

```bash
npm install
npm start      # npm run dev  -> with DevTools
```

## Packaging an installable app

`electron-builder` produces real installers. Everything lands in `dist/`.

```bash
npm run pack        # .app folder only (no installer) - fastest check
npm run dist:mac    # macOS: Apple Silicon .dmg
npm run dist:win    # Windows: NSIS .exe installer
npm run dist:linux  # Linux: AppImage + .deb
```

Files produced on macOS:

| File | For |
|---|---|
| `dist/Sarv Electron-1.0.0-arm64.dmg` | Apple Silicon - drag to Applications |
| `dist/mac-arm64/Sarv Electron.app` | unpacked app, runs directly |

Only Apple Silicon is built. To also produce an Intel `.dmg`, add `"x64"` to
`build.mac.target[0].arch` in `package.json`.

**Install:** open the `.dmg`, drag the app into your **Applications** folder. Done.

### Automated builds (GitHub Actions)

Pushing a version tag builds macOS and Windows installers on GitHub's own runners
and attaches them to a draft Release — no Windows machine required:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Then open the repository's **Releases** page and press **Publish release**.

To build without publishing anything, trigger the workflow manually; the installers
are kept as workflow artifacts for 7 days.

### Gatekeeper (important)

Builds are **unsigned** (no Apple Developer certificate). They run fine on the
machine that built them, but anyone who downloads one will see macOS report it as
"damaged", because downloads get a quarantine flag.

The safest fix is to right-click the `.app` -> **Open** -> **Open**. Failing that,
remove the quarantine attribute by name:

```bash
xattr -dr com.apple.quarantine "/Applications/Sarv Electron.app"
```

Do **not** use `xattr -cr`. It strips every extended attribute, which invalidates
the app's ad-hoc code signature; macOS then re-verifies the binary constantly and
the whole app becomes noticeably slow. If that has already happened, repair it
with `codesign --force --deep --sign - "/Applications/Sarv Electron.app"`.

Fixing this permanently requires the Apple Developer Program ($99/yr); then set the
`CSC_LINK` / `CSC_KEY_PASSWORD` env vars and enable notarization.

On Windows, unsigned installers trigger SmartScreen — choose **More info** ->
**Run anyway**. A code signing certificate removes that warning.

## Icon

The icon is generated from SVG rather than raster, so it can be changed at any time:

```bash
npm run icon                                   # build/icon.svg  -> icon.png + icon.icns
electron build/make-icon.js icon-chevron.svg   # build from another variant
```

| File | What it is |
|---|---|
| `build/icon.svg` | **live icon** — an "E" on a light disc inside a navy squircle |
| `build/icon-navy-e.svg` | same design, kept as the named variant |
| `build/icon-chevron.svg` | chevron on a white squircle |
| `build/icon-chevron-e.svg` | chevron + E |

To use a different variant, copy its contents into `build/icon.svg` and run
`npm run icon`. The colours live in one place: `#EE7B30` (orange) and `#1D4F91`
(blue). In development the dock icon is set via `app.dock.setIcon()`; packaged
builds use `build/icon.icns`.

## What works

**Connection**
- Quickconnect bar: protocol (SFTP / FTP / FTPS), host, user, password, port
- Site Manager: saved sites grouped into folders, filter box, logon type
  (password / key file / SSH agent). Passwords are encrypted in the macOS Keychain
  (Electron `safeStorage`) and never stored in plain text.

**Multiple servers at once (tabs)**
- A tab bar above the remote pane — each tab has its own server, remote path and queue
- `+` or Cmd+T opens a new tab; connecting from the Site Manager asks whether to
  "Connect in new tab" or "Connect in current tab"
- Right-click a tab -> New tab / Close tab / Close all other tabs
- A tab will not close while a transfer is running ("Cannot close tab while busy") —
  confirm and it cancels the transfers before closing
- The queue shows transfers from every tab together, each row tagged with its server

**Concurrent transfers (on a single server)**
- Settings -> Concurrent transfers: maximum simultaneous transfers (1–10, default 2),
  plus separate limits for concurrent downloads / uploads (0–10, 0 = no separate limit)
- Each transfer slot opens its own connection on first use, while a separate
  **control connection** stays free for browsing — so directory listings stay
  responsive even during a large transfer
- The status bar reports how many connections are open
- Connecting logs phase-by-phase timings (`tcp+kex`, `auth`, `sftp`, `realpath`) so
  the real cause of a slow connection is visible

**Speed limits**
- Settings -> Speed limits: a master toggle plus separate download and upload
  caps in KB/s, where 0 means no limit for that direction
- A limit caps the whole session rather than each transfer, so concurrent
  transfers in the same direction share it — two downloads under a 100 KB/s cap
  get 50 KB/s each
- Unlimited transfers keep the fast parallel-read path; the throttled path is
  only used when a limit is actually set

**ASCII / binary transfer mode**
- Settings -> Transfers -> Transfer mode: **Auto**, **ASCII** or **Binary**
- Auto picks ASCII for text files by extension (and for extensionless files)
  and binary for everything else; the extension list is editable
- ASCII converts line endings — CRLF on the server, LF locally — and the
  conversion is applied client-side for both SFTP and FTP, so the two protocols
  behave identically
- "Allow fall back to other transfer mode on failure" retries a failed ASCII
  transfer once as binary

**Bookmarks**
- **Bookmarks -> Add bookmark...** (Cmd+B) stores the directories both panes are
  currently showing
- **Global bookmark** works everywhere; **Site-specific bookmark** only appears
  while connected to that saved site, and is deleted along with it
- Each bookmark holds a local path, a remote path and an optional
  "use synchronized browsing" flag; leaving a path empty leaves that pane alone
- **Manage bookmarks...** lists them with Open / Edit / Delete
- Names must be unique within their scope

**Themes — 25 + System**
- A dropdown directly in the toolbar, split into Light and Dark groups
- **Light (12):** neutral, Sarv orange, Sky blue, Mint green, Emerald green,
  Olive green, Lavender, Rose, Sand, Paper (sepia), Solarized, High contrast
- **Dark (13):** neutral, Sarv orange, Midnight blue, Ocean teal, Forest green,
  Emerald green, Matrix green, Nord, Dracula, Plum, Carbon, Solarized, High contrast
- **Each SFTP tab can have its own theme** — right-click a tab -> "Theme for this
  tab...". Switching tabs switches the theme, so production and development servers
  are distinguishable at a glance
- Applies instantly and persists; the native title bar matches too
- To add a theme: one `:root[data-theme="name"]` block in
  `src/renderer/themes.css` and one line in the `THEMES` array in `app.js`

**Build your own theme**
- Settings -> Appearance -> **Create new theme...**
- Pick just 6 colours: window background, panels, borders, text, dim text, accent.
  Everything else (hover, selection, header, row stripes, status colours) is derived
- **Start from** lets you take any existing theme's colours and adjust them
- Dark-theme checkbox, live preview, and Save — the theme then appears under
  "My themes" in the picker
- Edit this theme... / Delete are available from the same place

**Your own background image**
- Settings -> Appearance -> Background image -> Browse... to pick any image
- **Image fit:** cover / contain / centre / tile
- **Panel opacity:** how see-through the panels are (more or less of the image shows)
- **Dim the image:** a light wash of the theme colour over the image so text stays readable
- Clear restores the normal look

**Site Manager folders (FileZilla-style tree)**
- Folders expand and collapse, each showing a site count
- Expand all / Collapse all buttons
- **New folder** button; subfolders are supported (right-click -> New subfolder)
- Drag a site into a folder; drop it on empty space to move it to the top level
- Right-click a folder -> Rename / Delete (deleting moves its sites to the top level
  rather than deleting them)
- Typing in the filter box automatically expands matching folders

**FileZilla import / export**
- Site Manager -> **Import...** reads your real FileZilla config
  (`~/.config/filezilla/sitemanager.xml` is detected automatically, or choose a file)
- Folders, host/port/user, passwords (base64-decoded, then encrypted into the
  Keychain), key files, remote path, local path and the sync-browsing flag all come across
- Options: import passwords or not, skip or update sites that already exist
- Protocols this app does not speak yet (S3, Storj, WebDAV, Dropbox...) are skipped
  and listed in the message log with a reason
- **Export...** writes every site back in FileZilla's format, ready to import into
  FileZilla or onto another machine. Passwords are optional (FileZilla's format uses
  base64, not encryption — keep the file safe)

**Advanced: redirect by path**
- Each site's Advanced section can set a **Default remote directory** and a
  **Default local directory**
- On connect both panes open straight at those paths, with no manual navigation
- If a path does not exist the server's home directory opens instead and a warning
  appears in the log (the connection still succeeds)
- Per-site **synchronized browsing** can also switch on automatically at connect

**Both panes (Local site / Remote site)**
- Local columns: Filename, Filesize, Filetype, Last modified
- Remote columns: the same plus Permissions and Owner/Group (useful for chmod)
- Sort (click a column header), quick filter, path bar, up/refresh
- Multi-select (Cmd / Shift), drag and drop to transfer to the other pane
- Directory comparison (size / modification time / threshold / hide identical)
- Synchronized browsing
- Pane splitter, swap panes, hidden-files toggle

**File operations**
- Download / Upload (folders handled recursively), transfer queue with progress
- Queue tabs: Queued files / Failed transfers / Successful transfers
- Create directory, create directory and enter it, create empty file
- Rename (F2), Delete (local = Trash, remote = recursive), Refresh (F5)
- File permissions (chmod) — numeric and checkboxes
- Copy URL(s) to clipboard, Open directory in Finder
- "Default file exists action": overwrite / overwrite if different size /
  overwrite if different size or source newer / rename / skip

**View / Edit (the main feature)**
- Double-click a remote file, or right-click -> **View / Edit**
- The file downloads to a temp folder, your editor opens, and the file is watched
- Saving uploads automatically (or respects the "Ask me before uploading" setting)
- Three ways to choose an editor:
  - **App** — the name of an installed app (VS Code, Cursor, Sublime, PhpStorm...
    are auto-detected)
  - **Command** — something like `code`, `subl -w`, `/usr/local/bin/code`
  - **System** — the OS default editor
- Per-extension associations: `php` -> PhpStorm, `sql` -> VS Code, and so on
  (`dotfile` and `extensionless` are special keys)
- "Always use default editor" / "Use filetype associations if available" toggles
- **Being edited** dialog: Upload and unedit, Reopen, Finish editing,
  Finish + delete local, Re-download
- Files currently under edit carry a `being edited` badge in the remote pane

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

## Where the code lives

```
src/main/
  main.js            Electron window + application menu
  ipc.js             every IPC handler — new features register here
  session-manager.js tabs - several servers at once
  session.js         one server: control connection + transfer connection pool + queue
  editor.js          View/Edit: download -> editor -> watch -> upload
  store.js           settings + sites (Keychain-encrypted passwords)
  filezilla.js       FileZilla sitemanager.xml parse + write (CServerPath codec included)
  localfs.js         the local filesystem side
  remote/sftp.js     SFTP backend  (ssh2-sftp-client)
  remote/ftp.js      FTP/FTPS backend (basic-ftp)
src/preload/preload.js   contextBridge API — all the renderer can see
src/renderer/
  index.html         layout
  styles.css         CSS variables (light + dark); themes change from one place
  lib.js             DOM helpers, modals, toasts, context menu
  panes.js           file list pane component (used by both panes)
  app.js             wiring: connection, queue, dialogs, settings, menus
```

To add a new remote backend (S3, WebDAV, Storj), implement the same interface in
`src/main/remote/` that `sftp.js` does — `connect / list / download / upload /
mkdir / removeFile / removeDir / rename / chmod / stat` — and register it in
`connect()` in `session.js`.

## Not implemented yet

These exist in FileZilla but not here. None of them has groundwork in the codebase
yet, so each is a from-scratch feature:

| Feature | Notes |
|---|---|
| Resume interrupted transfers | Needs restart-offset support in both the SFTP and FTP backends |
| Directory tree view | A collapsible tree alongside each pane, toggled independently |
| Remote search | Recursive server-side file search with downloadable results |
| Filters / filter sets | Named, reusable include/exclude rule sets for both panes |
| Proxy support | SOCKS5 / HTTP for SFTP, plus FTP proxy |
| Master password | One passphrase encrypting every stored credential |

Already implemented, despite being FileZilla headline features: **tabs** (multiple
servers at once), **multiple simultaneous transfers** (see *Concurrent transfers*),
**speed limits**, **ASCII/binary transfer mode** and **bookmarks**.

## License

MIT — see [LICENSE](LICENSE).

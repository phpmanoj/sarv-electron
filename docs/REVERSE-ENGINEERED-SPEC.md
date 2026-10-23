# Sarv Electron — feature spec reverse-engineered from FileZilla

Ye spec guess nahi hai. REA (Reverse Engineer Anything) se asli shipped
FileZilla app ko analyze karke nikala gaya hai, phir usi ke hisaab se
Sarv Electron banaya gaya hai.

## Analysis target (observed)

| Field | Value |
|---|---|
| Artifact | `/Applications/FileZilla.app` |
| Bundle SHA-256 | `abaa0a61db16a40d5d22cf9d6b6333c2052839fa09c92bcbeaf9a42751164989` |
| Executable | `Contents/MacOS/filezilla`, Mach-O arm64 |
| Executable SHA-256 | `bc7d2ab031f7c3f407d7954f61183a91f8f8f7a9fbc347322bbc6b356d8fc518` |
| Version | FileZilla Client 3.71.1 (`CFBundleShortVersionString`) |
| Bundle ID | `org.filezilla-project.filezilla` |
| Content graph | 715 nodes / 790 occurrences / 789 edges, all hashes verified |
| Toolkit (observed from `Contents/Frameworks`) | wxWidgets 3.2 (`libwx_osx_cocoau_*`), libfilezilla 59, GnuTLS 30, libfzssh 14, SQLite 3 |

REA operations used: `open_binary`, `inspect_plist`, `inspect_artifact`,
`inspect_analysis_view` (occurrences inventory), `close_binary`.

**Limitation (honest):** is machine par deep native providers (Ghidra / Hopper /
IDA / Kuna) installed nahi hain, is liye `search_strings` aur decompilation
available nahi thi. Iski jagah UI inventory FileZilla ke apne packaged gettext
catalog se li gayi — ye bundle ke verified content graph ka hissa hai:

- `Contents/SharedSupport/locales/de/filezilla.mo`
- SHA-256 `371d899ffaab2fecc76d4884f6a53e3c6196d082a6e08a605b41155afa51f2f2`
- 1792 msgids = FileZilla ki poori UI string inventory (menus, dialogs, options, errors)

Ye static evidence hai. Isse ye sabit hota hai ki app me kaunse UI elements aur
options **maujood** hain; isse runtime behaviour observe nahi hua.

## Observed: View/Edit feature (aapki main requirement)

FileZilla ke exact strings, aur Sarv Electron me inka status:

| Observed string (FileZilla) | Sarv Electron |
|---|---|
| `&View/Edit` | ✅ context menu + double-click |
| `Edit the file with the configured editor and upload changes to the server.` | ✅ core flow |
| `&Watch locally edited files and prompt to upload modifications` | ✅ settings: Auto upload / Prompt |
| `&Default editor:` | ✅ settings |
| `&Use system's default editor for text files` | ✅ editor mode `system` |
| `&Use custom program` / `Use &custom editor:` | ✅ editor mode `app` / `command` |
| `&Always use default editor` | ✅ settings toggle |
| `U&se filetype associations if available` | ✅ settings toggle |
| `C&ustom filetype associations:` | ✅ per-extension editor map |
| `S&how files currently being edited...` | ✅ "Being edited" dialog |
| `Up&load and unedit` | ✅ |
| `&Unedit` | ✅ |
| `&Finish editing` | ✅ |
| `&Finish editing and delete local file` | ✅ |
| `&Discard local file then download and edit file anew` | ✅ (Re-download) |
| `&Reopen local file` | ✅ |
| `Being edited` (status) | ✅ remote pane me badge |
| `Cannot edit file, not connected to any server.` | ✅ same guard |
| `Editing directories is not supported` | ✅ same guard |
| `Selected file already being edited` | ✅ same guard |
| `No program has been associated to edit files with the extension '%s'.` | ✅ same error |
| `A default editor needs to be set.` | ✅ same error |

## Observed: main window layout

- `&Quickconnect bar` — `&Host:`, `&Username:`, `&Password:`, `&Port:`, `&Connect`
- `&Site Manager...` — `&New site`, `&Logon Type:`, `&Rename`, `&Duplicate`, `&Delete`, `&Advanced`, `Transfer Settings`, `Charset`
- `&Message log` + `&Show timestamps in message log`
- Local pane / Remote pane, columns: `Filename`, `Filesize`, `Filetype`, `Last modified`, `Permissions`, `Owner/Group`
- `&Transfer queue` tabs: `Queued files`, `Failed transfers`, `Successful transfers`
- Queue columns: `Server/Local file`, `Direction`, `Remote file`, `Size`, `Priority`, `Status`
- `&Swap local and remote panes`, `&Layout of file and directory panes:`
- Status: `Not connected`, `Directory listing successful`, `Empty directory listing`

## Observed: file operations

`Download`, `Upload`, `Add to queue`, `&Open`, `&View/Edit`, `Create directory`,
`Create director&y and enter it`, `Create empty file`, `D&elete`, `&Rename`,
`&File permissions...`, `&Directory access permissions...`,
`C&opy URL(s) to clipboard`, `C&opy URL(s) with password to clipboard`,
`&Enter custom command...`, `&Refresh`, `Open directory in system's file manager`,
`Delete selected files and directories`, `Download selected directory`

## Observed: connections and tabs (2026-10-23 REA pass)

Ye strings usi verified catalog se nikle hain, aur inhi ke hisaab se
Sarv Electron ka connection model banaya gaya hai.

**Concurrency**

| Observed string (FileZilla) | Sarv Electron |
|---|---|
| `Concurrent transfers` (settings page) | ✅ Settings → "Concurrent transfers" |
| `Maximum simultaneous &transfers:` | ✅ `maxTransfers`, default 2 |
| `Please enter a number between 1 and 10 for the number of concurrent transfers.` | ✅ same 1–10 clamp |
| `Limit for concurrent &downloads:` | ✅ `maxDownloads` |
| `Limit for concurrent &uploads:` | ✅ `maxUploads` |
| `Please enter a number between 0 and 10 for the number of concurrent downloads.` | ✅ same 0–10 clamp, 0 = no separate limit |
| `&Limit number of simultaneous connections` / `&Maximum number of connections:` | ⚠️ global setting only, per-site limit abhi nahi |
| `Please enter a timeout between 10 and 9999 seconds or 0 to disable timeouts.` | ✅ `connectTimeout` |
| `&Maximum number of retries:` / `Number of retries has to be between 0 and 99.` | ❌ abhi nahi |

**Tabs**

| Observed string | Sarv Electron |
|---|---|
| `&Create new tab` / `New &tab` / `Opens a new tab` | ✅ `+` button, Cmd+T |
| `Connect in new tab` / `Connect in current tab` | ✅ Site Manager se connect karte waqt poocha jata hai |
| `Establish connection in a new tab` | ✅ |
| `Cl&ose tab` / `Closes current tab` | ✅ tab ka × , Cmd+W |
| `Close &all other tabs` | ✅ tab par right-click |
| `Cannot close tab while busy.` | ✅ wahi guard, wahi wording |
| `Cancel current operation and close tab?` | ✅ confirm dialog |
| `&Abort previous connection and connect in current tab` | ✅ "Connect in current tab" |

**Design choice (NOT observed):** har tab ek *control* connection rakhta hai jo
sirf browsing/metadata ke liye hai, aur transfers ke liye alag connections
kholta hai (max = "Maximum simultaneous transfers"). Isi liye transfer chalte
hue bhi directory listing turant aati hai. FileZilla ka internal split alag ho
sakta hai — ye humara decision hai, uska observed behaviour nahi.

## Observed: transfer behaviour options

- `&Transfer mode:` (+ `Allow fallback to other transfer mode on failure`)
- `Default file exists action`: `&Overwrite`, `Overwrite if &different size`,
  `Overwrite if different si&ze or source newer`, `&Resume`, `&Rename`, `&Skip`,
  `Al&ways perform this action`
- `&Preserve timestamps of transferred files`
- `&Speed limits` — `Download &limit:`, `Upload limit`, `&Burst tolerance:`
- `Maximum simultaneous &transfers:`, `&Limit number of simultaneous connections`
- `A&utomatically remove successful transfers`
- `Action after queue &completion`

## Observed: browsing extras

- `&Directory comparison` — `Compare &modification time`, `Compare file&size`,
  `Comparison &threshold (in minutes):`, `&Hide identical files`
- `&Use synchronized browsing` (+ disable prompts when paths diverge)
- `Directory listing &filters...`, `&Edit filter rules...`, `&Filter sets:`
- `&Search remote files...`, `&Local search`, `C&omparative search`
- `&Add bookmark...`, `&Manage bookmarks...`, `&Global bookmark`, `&Site-specific bookmark`
- `&Local directory tree`, `&Double-click action on files:`

## Design choices (NOT observed — hamare decisions)

- Electron + plain HTML/CSS/JS, kyunki local editor launch karna aur file watch
  karna desktop app se hi ho sakta hai. FileZilla wxWidgets/C++ use karta hai.
- SFTP: `ssh2-sftp-client`; FTP/FTPS: `basic-ftp`. FileZilla apni libfzssh/GnuTLS
  use karta hai.
- Passwords macOS Keychain (Electron `safeStorage`) me encrypted. FileZilla ka
  `sitemanager.xml` + master password scheme alag hai.
- Transfer queue serial (ek connection). FileZilla multiple simultaneous
  transfers karta hai — ye extend karne ki jagah hai.
- Koi bhi FileZilla code copy nahi kiya gaya. Ye independent implementation hai
  jo observed feature surface ko match karti hai.

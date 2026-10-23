First public release of Sarv Electron — a FileZilla-style SFTP / FTP / FTPS
client that opens remote files in your own editor and uploads them back the
moment you save.

## Which file do I download?

| Your machine | File |
|---|---|
| Mac with Apple Silicon (M1-M4) | `Sarv.Electron-1.0.0-arm64.dmg` |
| Mac with Intel | `Sarv.Electron-1.0.0.dmg` |
| Windows 64-bit | `Sarv.Electron.Setup.1.0.0.exe` |

## Installing

**macOS** — open the `.dmg` and drag the app into your Applications folder.

These builds are **not code-signed**, so macOS will say the app is "damaged".
It is not; downloaded apps get a quarantine flag. Clear it with:

```bash
xattr -cr "/Applications/Sarv Electron.app"
```

Or right-click the app -> **Open** -> **Open**.

**Windows** — run the installer. SmartScreen will warn about an unknown
publisher: choose **More info** -> **Run anyway**. You can pick the install
directory; no administrator rights are needed.

## What's in it

- SFTP, FTP and FTPS, with a site manager, folders and Keychain-encrypted passwords
- **View / Edit** — open a remote file in your editor; saving uploads it back
- Multiple servers at once in tabs, each with its own queue and theme
- Concurrent transfers with a free control connection, so browsing stays responsive
- **Speed limits** — separate download/upload caps, shared across concurrent transfers
- **ASCII / binary transfer mode** with auto-detection and fallback
- **Bookmarks** — global or site-specific, storing both panes' directories
- Import and export your real FileZilla site manager
- 25 themes plus custom themes and background images

## Known limitations

Not implemented yet: resume, directory tree view, remote search, filters,
proxy support and master password. Builds are unsigned on both platforms.

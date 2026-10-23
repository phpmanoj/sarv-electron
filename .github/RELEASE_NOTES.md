First public release of Sarv Electron — a FileZilla-style SFTP / FTP / FTPS
client that opens remote files in your own editor and uploads them back the
moment you save.

## Which file do I download?

| Your machine | File |
|---|---|
| Mac with Apple Silicon (M1-M4) | `Sarv.Electron-1.0.1-arm64.dmg` |
| Windows 64-bit | `Sarv.Electron.Setup.1.0.1.exe` |

Intel Macs are not built at the moment.

## Installing

**macOS** — open the `.dmg` and drag the app into your Applications folder.

These builds are **not code-signed**, so macOS will say the app is "damaged".
It is not; downloaded apps simply get a quarantine flag.

Easiest fix: right-click the app -> **Open** -> **Open**. Otherwise remove the
quarantine attribute by name:

```bash
xattr -dr com.apple.quarantine "/Applications/Sarv Electron.app"
```

Prefer `-dr com.apple.quarantine` over `xattr -cr`, which strips every extended
attribute rather than just the one in the way.

This build has no bundle code signature, so `codesign --verify` will complain
about it. You can apply an ad-hoc one yourself after installing:
`codesign --force --deep --sign - "/Applications/Sarv Electron.app"`

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

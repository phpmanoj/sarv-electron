// Renders build/icon.svg to PNGs and builds build/icon.icns (macOS).
// Uses Electron for rasterising and the system sips/iconutil for packaging.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const BUILD = __dirname;
// `electron build/make-icon.js [source.svg] [outputBaseName]`
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const SVG = path.isAbsolute(args[0] || '') ? args[0] : path.join(BUILD, args[0] || 'icon.svg');
const OUT_BASE = args[1] || 'icon';
const PNG = path.join(BUILD, OUT_BASE + '.png');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf8');
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });

  const page = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;width:1024px;height:1024px;overflow:hidden}
    svg{display:block}
  </style></head><body>${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise((r) => setTimeout(r, 400));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(PNG, image.toPNG());
  console.log('wrote ' + PNG);

  if (process.platform === 'darwin') {
    const iconset = path.join(os.tmpdir(), 'sarv-electron-' + Date.now() + '.iconset');
    fs.mkdirSync(iconset, { recursive: true });
    const sizes = [16, 32, 64, 128, 256, 512, 1024];
    for (const size of sizes) {
      const name = size === 1024 ? 'icon_512x512@2x.png' : `icon_${size}x${size}.png`;
      execFileSync('/usr/bin/sips', ['-z', String(size), String(size), PNG, '--out', path.join(iconset, name)], { stdio: 'ignore' });
      if (size <= 512 && size >= 16) {
        const retina = `icon_${size / 2}x${size / 2}@2x.png`;
        if (size >= 32) {
          execFileSync('/usr/bin/sips', ['-z', String(size), String(size), PNG, '--out', path.join(iconset, retina)], { stdio: 'ignore' });
        }
      }
    }
    const icns = path.join(BUILD, OUT_BASE + '.icns');
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns]);
    fs.rmSync(iconset, { recursive: true, force: true });
    console.log('wrote ' + icns);
  }

  app.exit(0);
});

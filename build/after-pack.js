'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * electron-builder runs with CSC_IDENTITY_AUTO_DISCOVERY=false (there is no
 * Apple Developer certificate), which makes it skip signing altogether: the
 * packaged bundle ships without Contents/_CodeSignature, so `codesign --verify`
 * reports "code has no resources but signature indicates they must be present"
 * and macOS treats the app as unsigned.
 *
 * Applying an ad-hoc signature here - after the .app is packed but before the
 * .dmg is assembled - gives the shipped bundle a valid self-contained seal.
 * It is not a substitute for a real certificate: Gatekeeper still warns on a
 * downloaded copy, because ad-hoc signatures carry no identity.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • ad-hoc signed   ' + appPath);
};

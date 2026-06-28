/**
 * afterPack hook — embeds app.manifest into the main Electron exe BEFORE signing.
 *
 * Without a <compatibility> section in the manifest, Windows PCA triggers
 * CompatTelRunner.exe on every first-run of the app on a new machine.
 * Declaring the Windows 10/11 OS GUID suppresses that entirely.
 *
 * Electron security fuses (including ASAR integrity) are now configured via
 * the `electronFuses` option in electron-builder.config.js.  electron-builder v26
 * handles fuse application natively, including computing and embedding the ASAR
 * hash before flipping EnableEmbeddedAsarIntegrityValidation.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('builder-util');
const { getRceditBundle } = require('app-builder-lib/out/toolsets/windows');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const productFilename = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);

  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] exe not found at ${exePath}, skipping`);
    return;
  }

  const manifestPath = path.resolve(__dirname, '..', 'app.manifest');
  if (fs.existsSync(manifestPath)) {
    const rceditBundle = await getRceditBundle();
    const rceditPath = process.arch === 'x64' ? rceditBundle.x64 : rceditBundle.x86;
    await exec(rceditPath, [exePath, '--application-manifest', manifestPath]);
    console.log(`[after-pack] Embedded compatibility manifest into ${productFilename}.exe`);
  } else {
    console.warn('[after-pack] app.manifest not found, skipping manifest embed');
  }
};

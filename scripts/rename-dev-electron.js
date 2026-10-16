#!/usr/bin/env node

// macOS shows the running bundle's CFBundleName as the bold app-menu title.
// Packaged builds get "Acabox" from packagerConfig, but `npm start` runs the
// stock dev binary at node_modules/electron/dist/Electron.app, whose
// Info.plist says "Electron". Rewrite it (and re-sign: the dev bundle is
// ad-hoc linker-signed, and an edited Info.plist invalidates that signature,
// which arm64 macOS refuses to launch). Idempotent; npm install restores the
// stock plist, and the next prestart re-applies this.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const PRODUCT_NAME = require('../product.json').productName;
const appDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(appDir, 'Contents', 'Info.plist');

if (!fs.existsSync(plist)) process.exit(0);

try {
  const current = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleName', 'raw', plist])
    .toString()
    .trim();
  if (current === PRODUCT_NAME) {
    try {
      // Only skip when the signature is also intact — a previous partially
      // failed run (plist edited, re-sign missed) must fall through and heal.
      execFileSync('/usr/bin/codesign', ['--verify', appDir], { stdio: 'ignore' });
      process.exit(0);
    } catch {
      // fall through to re-write + re-sign
    }
  }

  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', PRODUCT_NAME, plist]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', PRODUCT_NAME, plist]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', appDir]);
  console.log(`Renamed dev Electron.app to "${PRODUCT_NAME}" (menu bar/dock name).`);
} catch (err) {
  // Non-fatal: the app still runs, just titled "Electron" in the menu bar.
  console.warn('Could not rename dev Electron bundle:', err.message);
}

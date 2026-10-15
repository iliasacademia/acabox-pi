#!/usr/bin/env node

/**
 * Build Acabox PI and publish a GitHub Release that electron-updater consumes.
 *
 * Pipeline:
 *   1. electron-forge make  (signs during packaging — see the note at step 1)
 *   2. generate electron-updater metadata (latest-mac.yml / latest.yml) via
 *      scripts/generate-update-manifest.js
 *   3. create (or update) a GitHub Release tagged v<version> with the built
 *      artifacts + metadata, using the `gh` CLI.
 *
 * The release REPO must be PUBLIC so the installed app can download update
 * assets without an embedded token. Create it once:
 *     gh repo create iliasacademia/acabox-pi-releases --public
 *
 * Usage:
 *   npm run release                       # build + publish package.json version
 *   node scripts/release.mjs --dry-run    # print the plan, change nothing
 *   node scripts/release.mjs --skip-make  # reuse an existing out/make build
 *   node scripts/release.mjs --repo owner/name
 *
 * Bump "version" in package.json before releasing — electron-updater compares
 * the release version against the installed app's version. Tags must be unique.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = hasFlag('--dry-run');
const skipMake = hasFlag('--skip-make');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const product = JSON.parse(readFileSync('product.json', 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const repo =
  getOpt('--repo') || process.env[`${product.envPrefix}_RELEASE_REPO`] || `${product.releaseOwner}/${product.releaseRepo}`;
const arch = process.arch; // arm64 | x64
const platform = process.platform; // darwin | win32 | linux
const channel = 'latest'; // electron-updater default channel → latest-mac.yml / latest.yml

console.log(
  `${product.productName} release ${tag}  →  ${repo}  (${platform}/${arch})${dryRun ? '  [dry run]' : ''}`,
);

function sh(cmd) {
  console.log(`$ ${cmd}`);
  if (dryRun) return;
  execSync(cmd, { stdio: 'inherit' });
}

// 1. Build ------------------------------------------------------------------
if (!skipMake) {
  if (!process.env.APPLE_IDENTITY && platform === 'darwin') {
    // Auto-update is unaffected: main/selfUpdater.ts does the install itself
    // (verify sha512 → ditto extract → validate → swap the bundle), precisely
    // so that a Developer ID isn't required. The only remaining consequence is
    // Gatekeeper on a fresh download.
    console.log(
      '\nBuilding ad-hoc signed (APPLE_IDENTITY not set).\n' +
        '  Auto-update: works — the in-app self-updater performs the install.\n' +
        '  Fresh downloads: quarantined, so first launch needs right-click → Open.\n',
    );
  }
  // electron-forge make does not clean out/make, so stale artifacts from a
  // prior version would linger — they'd get uploaded to this release and could
  // make the generated metadata reference the wrong (older) payload. Clear it.
  console.log('$ rm -rf out/make');
  if (!dryRun) rmSync('out/make', { recursive: true, force: true });
  // Plain `make` is correct either way, and is the only correct option: with
  // APPLE_IDENTITY set it signs + notarizes during packaging
  // (packagerConfig.osxSign/osxNotarize); without it, forge.config's
  // postPackage hook ad-hoc signs the bundle. Both happen BEFORE the dmg/zip
  // makers run, which is what makes them reach the distributed artifact.
  sh('npm run make');
}

// 2. Generate electron-updater metadata (reuses the existing generator) ------
{
  const cmd = ['scripts/generate-update-manifest.js', version, channel, arch, platform];
  console.log(`$ node ${cmd.join(' ')}`);
  if (!dryRun) execFileSync('node', cmd, { stdio: 'inherit' });
}

// 3. Collect artifacts + metadata -------------------------------------------
const makeDir = 'out/make';
const payloadDir =
  platform === 'darwin'
    ? path.join(makeDir, 'zip', platform, arch)
    : path.join(makeDir, 'squirrel.windows', arch);
const ymlName = platform === 'darwin' ? `${channel}-mac.yml` : `${channel}.yml`;

const assets = new Set();

// updater metadata + payload (zip on macOS; nupkg/exe/RELEASES on Windows)
const ymlPath = path.join(payloadDir, ymlName);
if (existsSync(ymlPath)) assets.add(ymlPath);
if (existsSync(payloadDir)) {
  for (const f of readdirSync(payloadDir)) {
    if (/\.(zip|nupkg|exe)$/.test(f) || f === 'RELEASES') assets.add(path.join(payloadDir, f));
  }
}
// human-download installers live at the top of out/make (dmg on macOS)
if (existsSync(makeDir)) {
  for (const f of readdirSync(makeDir)) {
    if (/\.(dmg|deb|rpm)$/.test(f)) assets.add(path.join(makeDir, f));
  }
}

const files = [...assets];
if (!dryRun && files.length === 0) {
  console.error('No artifacts found under out/make — did the build run? (try without --skip-make)');
  process.exit(1);
}
console.log('Assets:');
files.forEach((f) => console.log('  •', f));
if (!files.some((f) => f.endsWith(ymlName)) && !dryRun) {
  console.error(`Missing ${ymlName} — electron-updater cannot detect updates without it.`);
  process.exit(1);
}

// 4. Create or update the GitHub Release ------------------------------------
const releaseExists = (() => {
  try {
    execSync(`gh release view ${tag} --repo ${repo}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const quoted = files.map((f) => `'${f}'`).join(' ');
if (releaseExists) {
  sh(`gh release upload ${tag} ${quoted} --repo ${repo} --clobber`);
} else {
  sh(`gh release create ${tag} ${quoted} --repo ${repo} --title '${product.productName} ${tag}' --notes '${product.productName} ${version}'`);
}

console.log(dryRun ? '\nDry run complete — nothing was built or published.' : `\nPublished ${tag} to ${repo}.`);

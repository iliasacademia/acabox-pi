// Release-asset naming, shared by release.mjs and generate-update-manifest.js.
//
// Forge names artifacts after productName ("Acabox PI-darwin-arm64-<v>.zip"),
// and GitHub rewrites spaces in uploaded asset names, so the name written into
// latest-mac.yml would no longer resolve. Every artifact is renamed to its
// hyphenated form before the manifest is generated and before upload.

const fs = require('fs');
const path = require('path');

/** "Acabox PI-darwin-arm64-0.1.0.zip" -> "Acabox-PI-darwin-arm64-0.1.0.zip" */
function hyphenate(fileName) {
  return fileName.replace(/\s+/g, '-');
}

/** Renames every file in `dir` whose name has whitespace; returns [from, to] pairs. */
function hyphenateDir(dir, { dryRun = false } = {}) {
  const renamed = [];
  if (!fs.existsSync(dir)) return renamed;
  for (const f of fs.readdirSync(dir)) {
    const to = hyphenate(f);
    if (to === f) continue;
    if (!dryRun) fs.renameSync(path.join(dir, f), path.join(dir, to));
    renamed.push([f, to]);
  }
  return renamed;
}

/** What forge will produce for a darwin build, after hyphenation (used by --dry-run). */
function expectedDarwinNames({ productName, version, arch, channel }) {
  return {
    zip: hyphenate(`${productName}-darwin-${arch}-${version}.zip`),
    dmg: hyphenate(`${productName}-${version}-${arch}.dmg`),
    yml: `${channel}-mac.yml`,
  };
}

module.exports = { hyphenate, hyphenateDir, expectedDarwinNames };

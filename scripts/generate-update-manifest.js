#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Get arguments
const args = process.argv.slice(2);
const version = args[0];
const channel = args[1] || 'stable';
const arch = args[2] || 'arm64';
const platform = args[3] || 'darwin';
const outputDir = platform === 'darwin'
  ? `out/make/zip/${platform}/${arch}`
  : `out/make/squirrel.windows/${arch}`;

if (!version) {
  console.error('Usage: node generate-update-manifest.js <version> <channel> [arch] [platform]');
  process.exit(1);
}

// Find the update file based on platform
let updateFile, updatePath;
if (platform === 'darwin') {
  // macOS uses .zip files
  const zipFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.zip'));
  if (zipFiles.length === 0) {
    console.error(`No .zip file found in ${outputDir}`);
    process.exit(1);
  }
  updateFile = zipFiles[0];
  updatePath = path.join(outputDir, updateFile);
} else {
  // Windows uses .nupkg files (typically -full.nupkg for initial releases)
  const nupkgFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.nupkg'));
  if (nupkgFiles.length === 0) {
    console.error(`No .nupkg file found in ${outputDir}`);
    process.exit(1);
  }
  // Prefer -full.nupkg if available, otherwise use any .nupkg
  updateFile = nupkgFiles.find(f => f.includes('-full.nupkg')) || nupkgFiles[0];
  updatePath = path.join(outputDir, updateFile);
}

// The url must equal the final GitHub asset name, which has no spaces (see
// release-names.js). release.mjs renames first; this guards a direct run.
if (/\s/.test(updateFile)) {
  console.error(`Update file "${updateFile}" contains whitespace; run release.mjs, which hyphenates artifact names first.`);
  process.exit(1);
}

console.log(`Generating manifest for ${updateFile}...`);

// Calculate SHA512
const fileBuffer = fs.readFileSync(updatePath);
const hash = crypto.createHash('sha512');
hash.update(fileBuffer);
const sha512 = hash.digest('base64');

// Get file size
const stats = fs.statSync(updatePath);
const size = stats.size;

// Get release date (current time)
const releaseDate = new Date().toISOString();

// Generate manifest
const manifest = {
  version: version,
  releaseDate: releaseDate,
  files: [
    {
      url: updateFile,
      sha512: sha512,
      size: size
    }
  ],
  path: updateFile,
  sha512: sha512,
  releaseNotes: `Release version ${version}`
};

// Convert to YAML format
const yaml = `version: ${manifest.version}
releaseDate: '${manifest.releaseDate}'
files:
  - url: ${manifest.files[0].url}
    sha512: ${manifest.files[0].sha512}
    size: ${manifest.files[0].size}
path: ${manifest.path}
sha512: ${manifest.sha512}
releaseNotes: ${manifest.releaseNotes}
`;

// Write manifest file with platform-specific name
const manifestName = platform === 'darwin' ? `${channel}-mac.yml` : `${channel}.yml`;
const manifestPath = path.join(outputDir, manifestName);
fs.writeFileSync(manifestPath, yaml, 'utf8');

console.log(`Manifest generated at ${manifestPath}`);
console.log(`Platform: ${platform}`);
console.log(`Channel: ${channel}`);
console.log(`Version: ${version}`);
console.log(`File: ${updateFile}`);
console.log(`Size: ${size} bytes`);
console.log(`SHA512: ${sha512.substring(0, 32)}...`);

#!/usr/bin/env node
// Assembles build/pi/ for the agent server (plan D2): PI's self-contained
// esbuild bundle plus the three runtime packages it loads from disk, and a
// hand-written package.json. Shipped via forge extraResource and loaded by file
// URL with a webpackIgnore dynamic import, never bundled by webpack (F8).
//
//   node scripts/build-pi-bundle.mjs
//
// piConfig is deliberately NOT written to package.json: rebranding it renames
// the agent-dir variable (PI_CODING_AGENT_DIR becomes <NAME>_CODING_AGENT_DIR).
// Then runs verify-pi-runtime.mjs under Electron's Node.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
const OUT = join(ROOT, 'build', 'pi');
const PI = join(NM, '@earendil-works', 'pi-coding-agent');

if (!existsSync(join(PI, 'dist', 'bundle', 'index.js'))) {
  console.error('build-pi-bundle: @earendil-works/pi-coding-agent is not installed (run npm ci).');
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(PI, 'package.json'), 'utf8')).version;
const pinned = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies['@earendil-works/pi-coding-agent'];
if (pinned !== version) {
  console.error(`build-pi-bundle: installed PI is ${version} but package.json pins ${pinned}.`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'dist'), { recursive: true });
mkdirSync(join(OUT, 'node_modules', '@silvia-odwyer'), { recursive: true });

// dereference: the shipped tree must hold no symlinks.
const copy = (from, to) => cpSync(from, to, { recursive: true, dereference: true });
copy(join(PI, 'dist', 'bundle'), join(OUT, 'dist', 'bundle'));
copy(join(NM, '@silvia-odwyer', 'photon-node'), join(OUT, 'node_modules', '@silvia-odwyer', 'photon-node'));
copy(join(NM, 'jiti'), join(OUT, 'node_modules', 'jiti'));
copy(join(NM, 'quickjs-wasi'), join(OUT, 'node_modules', 'quickjs-wasi'));

writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, type: 'module' }, null, 2) + '\n',
);
console.log(`build-pi-bundle: build/pi assembled (PI ${version})`);

// The probe runs under Electron's own Node (the runtime the agent server uses).
const require = createRequire(import.meta.url);
const electron = require('electron');
execFileSync(electron, [join(ROOT, 'scripts', 'verify-pi-runtime.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

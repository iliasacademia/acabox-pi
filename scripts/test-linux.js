#!/usr/bin/env node
// `npm run test:linux`: the usual Electron-run jest (same as `npm test`), then
// a list of the tests skipped as mac-only / root-only (see src/test/platform.ts).
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.join(os.tmpdir(), `jest-linux-${process.pid}.json`);
const electron = require('electron');
const res = spawnSync(
  electron,
  ['node_modules/.bin/jest', '--json', `--outputFile=${out}`, ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
);

try {
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  const skipped = [];
  for (const f of report.testResults) {
    for (const t of f.assertionResults) {
      if (t.status === 'pending' && /\[(mac-only|skipped as root)/.test(t.fullName)) {
        skipped.push(`${path.relative(process.cwd(), f.name)}: ${t.fullName}`);
      }
    }
  }
  const files = new Set(skipped.map((s) => s.split(':')[0]));
  console.log(`\nSkipped for platform reasons: ${skipped.length} tests in ${files.size} files`);
  for (const s of skipped) console.log(`  ${s}`);
  fs.unlinkSync(out);
} catch (e) {
  console.error('could not read jest report:', e.message);
}
process.exit(res.status ?? 1);

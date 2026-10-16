#!/usr/bin/env node
// Generates the Acabox PI macOS icon + tray asset set from the source-of-truth
// SVGs in src/assets/brand/. Reproducible: re-run whenever the mark changes.
//
//   node scripts/gen-icons.mjs
//
// Toolchain: @resvg/resvg-js (SVG -> PNG, dev-only) + macOS `iconutil`
// (.iconset -> .icns). Every raster is rendered DIRECTLY from SVG at its
// target pixel size — never downscaled from a larger bitmap — and small icon
// classes use the optically-corrected small master, per the design handoff.
//
// Outputs (all into src/assets/icons/):
//   dock-icon.icns        — the macOS app icon (all size classes)
//   dock-icon.png         — 1024px master, consumed by the dock/tray compositor
//   trayTemplate.png      — 18px menu-bar template image (glyph, alpha-only)
//   trayTemplate@2x.png   — 36px @2x companion for the above

import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(ROOT, 'src/assets/brand');
const OUT = join(ROOT, 'src/assets/icons');

const masterSvg = readFileSync(join(BRAND, 'acabox-mark-master.svg'), 'utf8');
const smallSvg = readFileSync(join(BRAND, 'acabox-mark-small.svg'), 'utf8');
const glyphSvg = readFileSync(join(BRAND, 'acabox-glyph-template.svg'), 'utf8');

/** Render an SVG string to a PNG buffer at exactly `px` × `px`. */
function renderPng(svg, px) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng();
}

/** Source selector: <=32px uses the small master, >=64px uses the large master. */
function markFor(px) {
  return px <= 32 ? smallSvg : masterSvg;
}

// ── App icon: build a .iconset, then iconutil -> .icns ──────────────────────
// Apple's canonical iconset entries. Each maps to a rendered pixel size; the
// 32px @1x uses the small master and the 64px @2x crosses over to the master
// (the 32pt row's "crossover point" in the handoff table).
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'acabox-iconset-'));
const iconset = join(tmp, 'AppIcon.iconset');
mkdirSync(iconset);

for (const [name, px] of ICONSET) {
  writeFileSync(join(iconset, name), renderPng(markFor(px), px));
}

// Acabox PI's tile is violet (#6d28d9, set in the brand SVGs) so it reads
// differently from Acabox's blue in the Dock and menu bar. `iconutil` exists
// only on macOS; elsewhere the PNGs are regenerated and dock-icon.icns is left
// as is (regenerate it on a Mac).
if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', '-o', join(OUT, 'dock-icon.icns'), iconset], {
    stdio: 'inherit',
  });
} else {
  console.warn('iconutil unavailable: dock-icon.icns NOT regenerated (run this on a Mac)');
}
rmSync(tmp, { recursive: true, force: true });

// ── dock-icon.png: 1024 master, used by tray.ts's dock/tray compositor ──────
writeFileSync(join(OUT, 'dock-icon.png'), renderPng(masterSvg, 1024));

// ── Menu-bar template image (isTemplate) ────────────────────────────────────
// The glyph-only mark, reframed to a tight square so the stroke fills ~89% of
// the canvas (16pt glyph in an 18pt tile), and flattened to opaque black on
// transparent — macOS template images key off alpha and recolor per menu-bar
// appearance (light/dark/tint), so the fill colour itself is irrelevant.
const trayGlyph = glyphSvg
  .replace('viewBox="0 0 128 128"', 'viewBox="14 14 100 100"')
  .replaceAll('currentColor', '#000000');

writeFileSync(join(OUT, 'trayTemplate.png'), renderPng(trayGlyph, 18));
writeFileSync(join(OUT, 'trayTemplate@2x.png'), renderPng(trayGlyph, 36));

console.log(`Wrote ${process.platform === 'darwin' ? 'dock-icon.icns, ' : ''}dock-icon.png, trayTemplate.png, trayTemplate@2x.png to src/assets/icons/`);

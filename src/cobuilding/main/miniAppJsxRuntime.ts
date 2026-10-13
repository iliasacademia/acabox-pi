/**
 * Source stamps for "Edit text" (POC): every host element a tool writes in JSX
 * ends up in the DOM carrying `data-acabox-src="<file>:<line>:<column>"`, the
 * place in the tool's source where that element was written. Design:
 * docs/design/mini-app-text-edit-poc.md; the attribute and its format are
 * `MINI_APP_SRC_ATTR` in shared/miniAppTextEdit.ts.
 *
 * How, with no change to the tool's code. esbuild's `--jsx-dev` compiles each
 * element to `jsxDEV(type, props, key, isStatic, { fileName, lineNumber,
 * columnNumber })`, and `--jsx-import-source` says where `jsxDEV` comes from.
 * We point that at the tiny runtime below, which writes the location into
 * `props` for host elements and then calls React's ordinary `jsx` / `jsxs`.
 *
 * Measured with esbuild 0.25.12 (2026-10-13):
 *   - `fileName` is relative to esbuild's cwd, which is the workspace root, but
 *     ONLY when the absolute path handed to esbuild is spelled exactly like the
 *     cwd the OS reports. macOS's filesystem is case-insensitive and getcwd()
 *     returns the on-disk case, so they can differ: here userData is
 *     `Application Support/Acabox/…` on disk and `…/acabox/…` in the path
 *     Acabox builds, and `fileName` came out as
 *     `../../../acabox/production/workspace-data/.applications/carsWorld/src/App.tsx`.
 *     The runtime therefore keeps only the part from `.applications/` on, which
 *     is what the stamp contract promises (workspace-relative) whatever the cwd.
 *   - Line and column are 1-based; the column counts UTF-16 code units and
 *     points at the `<`.
 *   - A `key` written AFTER a spread (`<li {...p} key={k}>`) cannot use the
 *     automatic runtime, so esbuild emits `createElement` and imports it from
 *     the BARE import source, not from `/jsx-dev-runtime`. With only
 *     `jsx-dev-runtime.js` in the directory that build fails with `Could not
 *     resolve "@acabox/jsx-edit"`, which would turn a pure addition into a
 *     broken tool. So the directory also holds an `index.js` that re-exports
 *     React's `createElement`. Those elements go unstamped (`createElement`
 *     carries no source), which the editor handles like any unstamped parent.
 *
 * The runtime lives in userData, not the workspace: it is host code the agent
 * must not be able to edit. It imports `react/jsx-runtime`, and esbuild resolves
 * an import from the importing file's own directory, so this one is looked up
 * from userData and NOT from the tool's directory: a `node_modules` beside or
 * above the tool is never searched for it. What gets it onto the tool's single
 * React is the `react` alias (`reactAliasFlags`), which applies to every
 * importer in the bundle. NODE_PATH is searched for every importer too, but it
 * is the very npm-site that alias is made from, so it never finds React where
 * the alias does not. Measured 2026-10-13: a tool whose React sits only in its
 * own `node_modules` builds without these flags and fails with them, `Could not
 * resolve "react/jsx-runtime"` located in this file, a host file the agent is
 * then pointed at. So `buildMiniApp` turns the stamps on only when the `react`
 * alias exists; without it the build is exactly what it was before stamps.
 *
 * No `electron` import: this module loads under jest.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MINI_APP_SRC_ATTR } from '../shared/miniAppTextEdit';
import { APPLICATIONS_DIR } from '../shared/paths';

/** esbuild imports `${JSX_EDIT_IMPORT_SOURCE}/jsx-dev-runtime`. */
export const JSX_EDIT_IMPORT_SOURCE = '@acabox/jsx-edit';

const HEADER = '// Written by Acabox (main/miniAppJsxRuntime.ts); rewritten on every build — do not edit.';

/**
 * ESM source of `jsx-dev-runtime.js`.
 *
 * - Mutating `props` is deliberate and safe: esbuild passes a fresh object
 *   literal at every call site, and React only adopts or freezes it inside
 *   `jsx()`, after our write.
 * - It does NOT delegate to React's `jsxDEV`. That export is `undefined` in
 *   React's production build; `jsx` / `jsxs` exist in both, so this works under
 *   either.
 * - Only host elements (`typeof type === 'string'`) are stamped, so a component
 *   never receives the prop.
 * - A `data-acabox-src` the tool wrote itself wins.
 * - The file part of the stamp starts at `.applications/` (see the header): a
 *   `fileName` that already does is kept as it is, one that reaches it through
 *   `../` or an absolute path is cut there, and one with no such segment is
 *   left alone.
 * - The finished stamp is kept per call site. jsxDEV runs for every host
 *   element on every render, and the source object it is handed is new each
 *   time, so building the string there cost real time: re-rendering a
 *   13,500-element table in JSDOM (2026-10-13) was 13-21% slower than without
 *   stamps, and is 2-9% slower with the cache.
 */
export const JSX_EDIT_RUNTIME_SOURCE: string = [
  HEADER,
  "import { jsx, jsxs, Fragment } from 'react/jsx-runtime';",
  'export { Fragment };',
  'function stampFile(fileName) {',
  '  var name = String(fileName);',
  `  if (name.indexOf(${JSON.stringify(`${APPLICATIONS_DIR}/`)}) === 0) return name;`,
  `  var at = name.indexOf(${JSON.stringify(`/${APPLICATIONS_DIR}/`)});`,
  '  return at >= 0 ? name.slice(at + 1) : name;',
  '}',
  '// jsxDEV runs for every host element on every render and is handed a new',
  '// source object each time, so the finished stamp is kept per call site.',
  'var sites = new Map();',
  'function stampOf(source) {',
  '  var site = sites.get(source.fileName);',
  '  if (site === undefined) {',
  '    site = { file: stampFile(source.fileName), lines: [] };',
  '    sites.set(source.fileName, site);',
  '  }',
  '  var cols = site.lines[source.lineNumber] || (site.lines[source.lineNumber] = []);',
  "  return cols[source.columnNumber] || (cols[source.columnNumber] = site.file + ':' + source.lineNumber + ':' + source.columnNumber);",
  '}',
  'export function jsxDEV(type, props, key, isStaticChildren, source) {',
  `  if (typeof type === 'string' && source && props && props[${JSON.stringify(MINI_APP_SRC_ATTR)}] === undefined) {`,
  `    props[${JSON.stringify(MINI_APP_SRC_ATTR)}] = stampOf(source);`,
  '  }',
  '  return isStaticChildren ? jsxs(type, props, key) : jsx(type, props, key);',
  '}',
  '',
].join('\n');

/**
 * ESM source of `index.js`, the target of the bare `@acabox/jsx-edit` import
 * esbuild emits for `createElement` (see the header).
 */
export const JSX_EDIT_INDEX_SOURCE: string = [
  HEADER,
  "export { createElement } from 'react';",
  '',
].join('\n');

const RUNTIME_FILES: ReadonlyArray<{ name: string; source: string }> = [
  { name: 'jsx-dev-runtime.js', source: JSX_EDIT_RUNTIME_SOURCE },
  { name: 'index.js', source: JSX_EDIT_INDEX_SOURCE },
];

/**
 * Write `file` unless it already holds exactly `source`. The write is a temp
 * file plus rename, so a build reading the file while another build replaces it
 * (builds are not serialized) sees the old or the new text whole, never half.
 * rename also replaces a symlink planted at `file` instead of writing through it.
 */
function writeIfDifferent(file: string, source: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === source) return;
  } catch {
    // Missing or unreadable: write it.
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, source, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Make `dir` hold the runtime exactly as shipped: create it, then write each
 * file that is missing or differs (a tampered or stale one is restored).
 * Returns `dir`, or null when it could not be written — the caller then builds
 * without stamps. Never throws.
 */
export function ensureJsxEditRuntime(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const { name, source } of RUNTIME_FILES) {
      writeIfDifferent(path.join(dir, name), source);
    }
    return dir;
  } catch {
    return null;
  }
}

/** The esbuild flags that turn the stamps on, or none when there is no runtime. */
export function jsxEditFlags(runtimeDir: string | null): string[] {
  if (!runtimeDir) return [];
  return [
    '--jsx-dev',
    `--jsx-import-source=${JSX_EDIT_IMPORT_SOURCE}`,
    `--alias:${JSX_EDIT_IMPORT_SOURCE}=${runtimeDir}`,
  ];
}

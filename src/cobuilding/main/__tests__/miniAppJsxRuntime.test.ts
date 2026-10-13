/**
 * @jest-environment node
 *
 * "Edit text" T1 — every host element a tool writes in JSX is stamped with
 * where it was written (`data-acabox-src="<file>:<line>:<col>"`).
 *
 * The unit half pins the esbuild flags and the runtime directory. The end-to-end
 * half runs the REAL esbuild CLI over a fixture workspace with the argv
 * `buildMiniApp` uses and evaluates the REAL bundle in a DOM: a reimplementation
 * of the runtime here would keep passing while the shipped one was broken.
 *
 * Node environment, because nothing here needs the jest DOM; JSDOM is built by
 * hand for the bundle.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  JSX_EDIT_INDEX_SOURCE,
  JSX_EDIT_RUNTIME_SOURCE,
  ensureJsxEditRuntime,
  jsxEditFlags,
} from '../miniAppJsxRuntime';
import { miniAppEsbuildArgs } from '../miniAppBuildArgs';
import { MINI_APP_SRC_ATTR } from '../../shared/miniAppTextEdit';

/** <repo>/node_modules is reachable from a worktree through its symlink. */
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const ESBUILD = path.join(REPO, 'node_modules', '.bin', 'esbuild');

/** A real directory with a space in its name, like `~/Library/Application Support`. */
function makeTmpRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acabox jsx stamps ')));
}

// ───────────────────────── unit: flags ─────────────────────────

describe('jsxEditFlags', () => {
  it('is nothing without a runtime directory', () => {
    expect(jsxEditFlags(null)).toEqual([]);
  });

  it('is exactly the three flags that route jsxDEV through the runtime', () => {
    expect(jsxEditFlags('/x')).toEqual([
      '--jsx-dev',
      '--jsx-import-source=@acabox/jsx-edit',
      '--alias:@acabox/jsx-edit=/x',
    ]);
  });

  it('keeps a directory with spaces as one argument', () => {
    const dir = '/Users/x/Library/Application Support/acabox/development/mini-app-jsx-runtime';
    expect(jsxEditFlags(dir)).toEqual([
      '--jsx-dev',
      '--jsx-import-source=@acabox/jsx-edit',
      `--alias:@acabox/jsx-edit=${dir}`,
    ]);
  });
});

// ───────────────────────── unit: the runtime directory ─────────────────────────

describe('ensureJsxEditRuntime', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpRoot();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const runtimeFile = (dir: string) => path.join(dir, 'jsx-dev-runtime.js');
  const indexFile = (dir: string) => path.join(dir, 'index.js');

  it('names the attribute from the shared constant', () => {
    expect(MINI_APP_SRC_ATTR).toBe('data-acabox-src');
    expect(JSX_EDIT_RUNTIME_SOURCE).toContain(JSON.stringify(MINI_APP_SRC_ATTR));
  });

  it('writes the runtime, creating the directory, and returns it', () => {
    const dir = path.join(tmp, 'user data', 'mini-app-jsx-runtime');
    expect(ensureJsxEditRuntime(dir)).toBe(dir);
    expect(fs.readFileSync(runtimeFile(dir), 'utf8')).toBe(JSX_EDIT_RUNTIME_SOURCE);
    // The bare import esbuild emits for a `key` after a spread (see the module header).
    expect(fs.readFileSync(indexFile(dir), 'utf8')).toBe(JSX_EDIT_INDEX_SOURCE);
    // No temp file left behind by the atomic write.
    expect(fs.readdirSync(dir).sort()).toEqual(['index.js', 'jsx-dev-runtime.js']);
  });

  it('is idempotent: a file that already holds the source is not rewritten', () => {
    const dir = path.join(tmp, 'rt');
    ensureJsxEditRuntime(dir);
    // Pin both files to a time in the past; a rewrite would move it to now.
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(runtimeFile(dir), past, past);
    fs.utimesSync(indexFile(dir), past, past);

    expect(ensureJsxEditRuntime(dir)).toBe(dir);

    expect(fs.statSync(runtimeFile(dir)).mtime.getTime()).toBe(past.getTime());
    expect(fs.statSync(indexFile(dir)).mtime.getTime()).toBe(past.getTime());
    expect(fs.readdirSync(dir).sort()).toEqual(['index.js', 'jsx-dev-runtime.js']);
  });

  it('restores a tampered or deleted file', () => {
    const dir = path.join(tmp, 'rt');
    ensureJsxEditRuntime(dir);
    fs.writeFileSync(runtimeFile(dir), 'export const jsxDEV = () => "the agent was here";\n');
    fs.rmSync(indexFile(dir));

    expect(ensureJsxEditRuntime(dir)).toBe(dir);

    expect(fs.readFileSync(runtimeFile(dir), 'utf8')).toBe(JSX_EDIT_RUNTIME_SOURCE);
    expect(fs.readFileSync(indexFile(dir), 'utf8')).toBe(JSX_EDIT_INDEX_SOURCE);
  });

  it('replaces a symlink planted at the runtime path instead of writing through it', () => {
    const dir = path.join(tmp, 'rt');
    fs.mkdirSync(dir);
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'not ours');
    fs.symlinkSync(victim, runtimeFile(dir));

    expect(ensureJsxEditRuntime(dir)).toBe(dir);

    expect(fs.readFileSync(victim, 'utf8')).toBe('not ours');
    expect(fs.lstatSync(runtimeFile(dir)).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(runtimeFile(dir), 'utf8')).toBe(JSX_EDIT_RUNTIME_SOURCE);
  });

  it('returns null, without throwing, for a path it cannot write: under a regular file', () => {
    const plainFile = path.join(tmp, 'plain-file');
    fs.writeFileSync(plainFile, 'x');

    expect(ensureJsxEditRuntime(path.join(plainFile, 'sub', 'mini-app-jsx-runtime'))).toBeNull();
    expect(fs.readFileSync(plainFile, 'utf8')).toBe('x');
  });

  it('returns null, without throwing, when a directory squats on a runtime file', () => {
    const dir = path.join(tmp, 'rt');
    fs.mkdirSync(path.join(dir, 'jsx-dev-runtime.js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jsx-dev-runtime.js', 'keep'), 'x');

    expect(ensureJsxEditRuntime(dir)).toBeNull();
    // And it cleaned up its temp file.
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

// ───────────────────────── end to end: real esbuild, real bundle, real DOM ─────────────────────────

const HEADER_TSX = [
  'export function Header({ title }: { title: string }) {',
  '  return <header><h1>{title}</h1></header>;',
  '}',
  '',
].join('\n');

const INDEX_TSX = [
  'import React from "react";',
  'import { createRoot } from "react-dom/client";',
  'import App from "./App";',
  '',
  'createRoot(document.getElementById("root")!).render(',
  '  <>',
  '    <App />',
  '  </>',
  ');',
  '',
].join('\n');

// Line numbers matter: the assertions below are written against them.
const APP_TSX = [
  /*  1 */ 'import { Header } from "@reusable/Header";',
  /*  2 */ '',
  /*  3 */ 'function Probe(props: Record<string, unknown>) {',
  /*  4 */ '  return <pre id="probe">{JSON.stringify(Object.keys(props))}</pre>;',
  /*  5 */ '}',
  /*  6 */ '',
  /*  7 */ 'const GENES = ["TP53", "BRCA1", "EGFR"];',
  /*  8 */ '',
  /*  9 */ 'export default function App() {',
  /* 10 */ '  const rest = { title: "spread" };',
  /* 11 */ '  return (',
  /* 12 */ '    <main id="app">',
  /* 13 */ '      <Header title="Gene explorer" />',
  /* 14 */ '      <p id="unicode">é—🧬 <b id="bold">bold</b> tail</p>',
  /* 15 */ '      <Probe a={1} b="two" />',
  /* 16 */ '      <ul id="list">',
  /* 17 */ '        {GENES.map((g) => (',
  /* 18 */ '          <li key={g}>{g}</li>',
  /* 19 */ '        ))}',
  /* 20 */ '      </ul>',
  /* 21 */ '      <>',
  /* 22 */ '        <span id="in-fragment">fragment child</span>',
  /* 23 */ '      </>',
  /* 24 */ '      <i id="explicit" data-acabox-src="keep">kept</i>',
  /* 25 */ '      <section id="late-key" {...rest} key="k">key after spread</section>',
  /* 26 */ '    </main>',
  /* 27 */ '  );',
  /* 28 */ '}',
  '',
].join('\n');

/** A list written without keys: React must complain, which proves the spy below can see it. */
const KEYLESS_APP_TSX = [
  'export default function App() {',
  '  return <ul>{["a", "b"].map((x) => <li>{x}</li>)}</ul>;',
  '}',
  '',
].join('\n');

/**
 * Calls the runtime directly with the `fileName`s esbuild can hand it, so the
 * file part of the stamp is pinned for each shape. Every element is at 3:4.
 */
const ANCHOR_CASES: Array<{ id: string; fileName: string; expected: string }> = [
  // Spelled like the cwd: kept as it is. The normal case.
  { id: 'clean', fileName: '.applications/tool/src/App.tsx', expected: '.applications/tool/src/App.tsx' },
  // What esbuild printed on a machine where the cwd's case differs from the path we pass.
  {
    id: 'dotdot',
    fileName: '../../../acabox/production/workspace-data/.applications/tool/src/App.tsx',
    expected: '.applications/tool/src/App.tsx',
  },
  {
    id: 'absolute',
    fileName: '/Users/x/Library/Application Support/Acabox/development/workspace-data/.applications/tool/src/App.tsx',
    expected: '.applications/tool/src/App.tsx',
  },
  { id: 'shared', fileName: '../../a/b/.applications/_reusable/Header.tsx', expected: '.applications/_reusable/Header.tsx' },
  // A folder inside the tool that happens to be called .applications must not cut a clean path.
  {
    id: 'inner',
    fileName: '.applications/tool/src/.applications/inner.tsx',
    expected: '.applications/tool/src/.applications/inner.tsx',
  },
  // Only a whole path segment counts.
  { id: 'lookalike', fileName: '../x/my.applications/tool/App.tsx', expected: '../x/my.applications/tool/App.tsx' },
  { id: 'none', fileName: '../../elsewhere/App.tsx', expected: '../../elsewhere/App.tsx' },
];

const ANCHOR_APP_TSX = [
  'import { jsxDEV } from "@acabox/jsx-edit/jsx-dev-runtime";',
  '',
  `const cases: Array<[string, string]> = ${JSON.stringify(ANCHOR_CASES.map((c) => [c.id, c.fileName]))};`,
  '',
  'export default function App() {',
  '  return jsxDEV("div", {',
  '    children: cases.map(([id, fileName]) => jsxDEV("i", { id, children: id }, id, false, { fileName, lineNumber: 3, columnNumber: 4 })),',
  '  }, undefined, true, { fileName: "x/.applications/anchor/src/App.tsx", lineNumber: 1, columnNumber: 1 });',
  '}',
  '',
].join('\n');

/** The sandbox filesystem is case-insensitive, as macOS's is by default. */
const FS_IS_CASE_INSENSITIVE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-case-'));
  try {
    fs.mkdirSync(path.join(dir, 'Probe'));
    return fs.existsSync(path.join(dir, 'probe'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

interface Rendered {
  window: any;
  root: Element;
  /** console.error / console.warn / uncaught errors seen inside the page. */
  errors: string[];
  /** The bundle that was evaluated. */
  bundle: string;
}

async function render(bundle: string): Promise<Rendered> {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => errors.push(`jsdomError: ${e.message}`));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const win = dom.window as any;
  const record = (level: string) => (...args: unknown[]) => {
    errors.push(`${level}: ${args.map(String).join(' ')}`);
  };
  win.console.error = record('console.error');
  win.console.warn = record('console.warn');

  win.eval(bundle);

  // React commits on a timer; wait for the first commit.
  const root = win.document.getElementById('root') as Element;
  const deadline = Date.now() + 5000;
  while (!root.firstChild && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!root.firstChild) {
    win.close();
    throw new Error(`The bundle never rendered. Errors seen: ${JSON.stringify(errors)}`);
  }
  return { window: win, root, errors, bundle };
}

/** `file:line:col`, split on the LAST two colons as the contract says. */
function parseStamp(stamp: string): { file: string; line: number; col: number } {
  const c2 = stamp.lastIndexOf(':');
  const c1 = stamp.lastIndexOf(':', c2 - 1);
  return { file: stamp.slice(0, c1), line: Number(stamp.slice(c1 + 1, c2)), col: Number(stamp.slice(c2 + 1)) };
}

describe('stamps, end to end with the real esbuild CLI', () => {
  jest.setTimeout(60_000);

  let tmp: string;
  let ws: string;
  let runtimeDir: string;
  const windows: Rendered[] = [];
  let builds = 0;

  const REACT_ALIASES = ['react', 'react-dom'].map((n) => `--alias:${n}=${path.join(REPO, 'node_modules', n)}`);

  function write(rel: string, text: string): void {
    const file = path.join(ws, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  /**
   * Build `.applications/<dir>` with the argv `buildMiniApp` uses; cwd is the
   * workspace root. `typedWorkspace` spells the absolute paths in the argv
   * differently from the cwd (same directory, other case), as on a Mac whose
   * userData folder is `Acabox` on disk and `acabox` in the path we build.
   */
  function build(dir: string, opts: { jsxRuntimeDir: string | null; extraFlags?: string[]; typedWorkspace?: string }): string {
    const root = opts.typedWorkspace ?? ws;
    const outfile = path.join(root, '.applications', dir, 'dist', `bundle-${++builds}.js`);
    const args = miniAppEsbuildArgs({
      entry: path.join(root, '.applications', dir, 'src', 'index.tsx'),
      outfile,
      reusableAlias: path.join(root, '.applications', '_reusable'),
      extraFlags: [...REACT_ALIASES, ...(opts.extraFlags ?? [])],
      jsxRuntimeDir: opts.jsxRuntimeDir,
    });
    const r = spawnSync(ESBUILD, args, { cwd: ws, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`esbuild exited ${r.status} for ${dir}:\n${r.stderr}${r.stdout}`);
    }
    return fs.readFileSync(outfile, 'utf8');
  }

  /** Build and render a variant the first time a test asks for it, so one broken variant fails only its own tests. */
  function variant(make: () => string): () => Promise<Rendered> {
    let pending: Promise<Rendered> | undefined;
    return () => {
      if (!pending) {
        pending = render(make()).then((r) => { windows.push(r); return r; });
      }
      return pending;
    };
  }

  // Dev React, stamps on: the shipped configuration.
  const stamped = variant(() => build('demo', { jsxRuntimeDir: runtimeDir }));
  // React's PRODUCTION build exports no `jsxDEV`, so a runtime that delegated to it would break here.
  const stampedProduction = variant(() => build('demo', {
    jsxRuntimeDir: runtimeDir,
    extraFlags: ['--define:process.env.NODE_ENV="production"'],
  }));
  // The fallback when the runtime could not be written.
  const unstamped = variant(() => build('demo', { jsxRuntimeDir: null }));
  const keyless = variant(() => build('keyless', { jsxRuntimeDir: runtimeDir }));
  const anchors = variant(() => build('anchor', { jsxRuntimeDir: runtimeDir }));
  // The same tool, built with the workspace spelled in another case than the cwd.
  const mismatched = variant(() => build('demo', {
    jsxRuntimeDir: runtimeDir,
    typedWorkspace: path.join(tmp, 'WORK SPACE'),
  }));

  beforeAll(() => {
    tmp = makeTmpRoot();
    ws = path.join(tmp, 'work space');
    write('.applications/_reusable/Header.tsx', HEADER_TSX);
    write('.applications/demo/src/index.tsx', INDEX_TSX);
    write('.applications/demo/src/App.tsx', APP_TSX);
    write('.applications/keyless/src/index.tsx', INDEX_TSX);
    write('.applications/keyless/src/App.tsx', KEYLESS_APP_TSX);
    write('.applications/anchor/src/index.tsx', INDEX_TSX);
    write('.applications/anchor/src/App.tsx', ANCHOR_APP_TSX);

    // Like production, the runtime sits outside the workspace, under a path with a space.
    const dir = ensureJsxEditRuntime(path.join(tmp, 'user data', 'mini-app-jsx-runtime'));
    if (!dir) throw new Error('could not write the runtime into the tmp dir');
    runtimeDir = dir;
  });

  afterAll(() => {
    for (const r of windows) {
      try { r.window.close(); } catch { /* already closed */ }
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const APP = '.applications/demo/src/App.tsx';
  const HEADER = '.applications/_reusable/Header.tsx';
  const stampOf = (r: Rendered, selector: string): string | null | undefined =>
    r.root.querySelector(selector)?.getAttribute(MINI_APP_SRC_ATTR);

  it('stamps host elements with the exact file:line:column of their opening <', async () => {
    const r = await stamped();
    expect(stampOf(r, '#app')).toBe(`${APP}:12:5`);
    expect(stampOf(r, '#probe')).toBe(`${APP}:4:10`);
    expect(stampOf(r, '#unicode')).toBe(`${APP}:14:7`);
    expect(stampOf(r, '#list')).toBe(`${APP}:16:7`);
    expect(stampOf(r, '#in-fragment')).toBe(`${APP}:22:9`);
  });

  it('stamps elements of a shared _reusable component, relative to the workspace', async () => {
    const r = await stamped();
    expect(stampOf(r, 'header')).toBe(`${HEADER}:2:10`);
    expect(stampOf(r, 'h1')).toBe(`${HEADER}:2:18`);
  });

  it('counts the column in UTF-16 code units after non-ASCII text on the same line', async () => {
    // `      <p id="unicode">é—🧬 <b` — the 🧬 is two UTF-16 units. Code points
    // would give 27 and UTF-8 bytes 33.
    expect(stampOf(await stamped(), '#bold')).toBe(`${APP}:14:28`);
  });

  it('every stamp points at the `<` of its own element, in the workspace file it names', async () => {
    const r = await stamped();
    const stampedEls = Array.from(r.root.querySelectorAll(`[${MINI_APP_SRC_ATTR}]`));
    expect(stampedEls.length).toBeGreaterThan(8);
    for (const el of stampedEls) {
      const stamp = el.getAttribute(MINI_APP_SRC_ATTR) as string;
      if (stamp === 'keep') continue; // the tool's own value, covered below
      const { file, line, col } = parseStamp(stamp);
      const lines = fs.readFileSync(path.join(ws, file), 'utf8').split('\n');
      expect(lines[line - 1].slice(col - 1).startsWith(`<${el.tagName.toLowerCase()}`)).toBe(true);
    }
  });

  it('stamps nothing but host elements: no key reaches a component\'s props', async () => {
    // Probe prints the keys of the props it was given.
    expect((await stamped()).root.querySelector('#probe')?.textContent).toBe('["a","b"]');
  });

  it('keeps a data-acabox-src the tool wrote itself', async () => {
    expect(stampOf(await stamped(), '#explicit')).toBe('keep');
  });

  it('renders the mapped list, the fragment and a key written after a spread', async () => {
    const r = await stamped();
    const items = Array.from(r.root.querySelectorAll('#list li'));
    expect(items.map((li) => li.textContent)).toEqual(['TP53', 'BRCA1', 'EGFR']);
    // Every item comes from the one `<li>` in the source.
    expect(items.map((li) => li.getAttribute(MINI_APP_SRC_ATTR))).toEqual([
      `${APP}:18:11`, `${APP}:18:11`, `${APP}:18:11`,
    ]);
    // A fragment adds no element of its own.
    expect(r.root.querySelector('#in-fragment')?.parentElement?.id).toBe('app');
    // esbuild compiles `<x {...p} key=…>` to createElement, imported from the
    // bare import source. Without the runtime's index.js this BUILD fails.
    expect(r.root.querySelector('#late-key')?.textContent).toBe('key after spread');
    expect(r.root.querySelector('#late-key')?.getAttribute('title')).toBe('spread');
  });

  it('stamps exactly the host elements written in JSX, and nothing else', async () => {
    // main, header, h1, p, b, pre, ul, 3x li, span, and the tool's own `i`;
    // the createElement-built <section> is the one host element left out.
    expect((await stamped()).root.querySelectorAll(`[${MINI_APP_SRC_ATTR}]`).length).toBe(12);
  });

  it('gives React no warnings: static children go through jsxs, lists through jsx, fragments get no prop', async () => {
    expect((await stamped()).errors).toEqual([]);
  });

  it('proves the warning spy can see React complain (control)', async () => {
    expect((await keyless()).errors.join('\n')).toMatch(/key/i);
  });

  it('works under React\'s production build too, where jsxDEV does not exist', async () => {
    const r = await stampedProduction();
    expect(r.errors).toEqual([]);
    expect(stampOf(r, '#bold')).toBe(`${APP}:14:28`);
    expect(stampOf(r, 'header')).toBe(`${HEADER}:2:10`);
    expect(r.root.querySelector('#probe')?.textContent).toBe('["a","b"]');
  });

  it('without a runtime the same tool builds and renders with no stamps of ours', async () => {
    const r = await unstamped();
    expect(r.errors).toEqual([]);
    expect(r.root.querySelector('#list')?.textContent).toBe('TP53BRCA1EGFR');
    // Only the value the tool wrote itself is there.
    expect(Array.from(r.root.querySelectorAll(`[${MINI_APP_SRC_ATTR}]`)).map((e) => e.id)).toEqual(['explicit']);
  });

  it('keeps the file part of the stamp workspace-relative whatever path esbuild reports', async () => {
    const r = await anchors();
    expect(r.errors).toEqual([]);
    for (const c of ANCHOR_CASES) {
      expect({ id: c.id, stamp: stampOf(r, `#${c.id}`) }).toEqual({ id: c.id, stamp: `${c.expected}:3:4` });
    }
    // The wrapper element, reported as x/.applications/anchor/src/App.tsx.
    expect(r.root.querySelector('div')?.getAttribute(MINI_APP_SRC_ATTR)).toBe('.applications/anchor/src/App.tsx:1:1');
  });

  // On macOS the cwd esbuild sees has the on-disk case (`Acabox`) while the path
  // Acabox builds says `acabox`; esbuild then prints `../../../acabox/…`. Without
  // the anchoring above every stamp would name a file no tool has.
  const itOnCaseInsensitiveFs = FS_IS_CASE_INSENSITIVE ? it : it.skip;
  itOnCaseInsensitiveFs('stamps stay workspace-relative when the workspace path is spelled in another case than the cwd', async () => {
    const r = await mismatched();
    // The control: esbuild really did print the roundabout path into the bundle.
    // (If a future esbuild stops doing that, this test no longer tests anything.)
    // Compared as a list, because a failing assertion on the bundle text would
    // print a megabyte of React.
    const fileNames = Array.from(new Set(Array.from(r.bundle.matchAll(/fileName: "([^"]*)"/g), (m) => m[1])));
    expect(fileNames).toContain('../WORK SPACE/.applications/demo/src/App.tsx');
    expect(r.errors).toEqual([]);
    expect(stampOf(r, '#app')).toBe(`${APP}:12:5`);
    expect(stampOf(r, '#bold')).toBe(`${APP}:14:28`);
    expect(stampOf(r, 'header')).toBe(`${HEADER}:2:10`);
    for (const el of Array.from(r.root.querySelectorAll(`[${MINI_APP_SRC_ATTR}]`))) {
      expect(el.getAttribute(MINI_APP_SRC_ATTR)).toMatch(/^(\.applications\/|keep$)/);
    }
  });
});

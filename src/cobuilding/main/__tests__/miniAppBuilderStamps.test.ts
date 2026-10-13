/**
 * @jest-environment node
 *
 * "Edit text" T1 — `buildMiniApp` stamps every build it can. It hands esbuild
 * the stamp flags with the runtime in userData (never the workspace); when the
 * runtime can't be written it warns once and builds without stamps instead of
 * failing; and a real esbuild run through it yields a stamped bundle.
 *
 * "It can" means the npm-site has React. The runtime imports `react/jsx-runtime`
 * from userData, where only the `react` alias (made from the npm-site) reaches
 * the tool's React, so with no alias the build gets no stamp flags and no runtime
 * is written: otherwise a tool whose React sits in its own node_modules, which
 * builds today, would fail on a host file the agent is then pointed at.
 *
 * Mocking recipe as in miniAppBuilderHooks.test.ts, except `userData` is a real
 * tmp directory so the runtime can actually be written there.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockPaths = { userData: '' };
jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => mockPaths.userData },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../containerService', () => ({
  containerService: { execLogged: jest.fn() },
}));
jest.mock('../buildHealth', () => ({
  recordBuildResult: jest.fn(),
}));

import log from 'electron-log';
import { containerService } from '../containerService';
import { buildMiniApp } from '../miniAppBuilder';
import { JSX_EDIT_RUNTIME_SOURCE } from '../miniAppJsxRuntime';

const execLogged = containerService.execLogged as jest.Mock;
const warn = log.warn as jest.Mock;
const info = log.info as jest.Mock;

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const DIR = 'demo';

describe('buildMiniApp — source stamps', () => {
  let tmp: string;
  let workspace: string;
  let userData: string;

  const toolFile = (...parts: string[]) => path.join(workspace, '.applications', DIR, ...parts);
  const runtimeDir = () => path.join(userData, 'mini-app-jsx-runtime');
  const npmModules = () => path.join(userData, 'npm-site', 'lib', 'node_modules');
  /** The argv after the esbuild binary, from the n-th build. */
  const argvOf = (n = 0): string[] => (execLogged.mock.calls[n][0] as string[]).slice(1);
  /** What every build has always been given, before the React aliases and the stamp flags. */
  const baseArgv = (): string[] => [
    toolFile('src', 'index.tsx'),
    '--bundle',
    `--outfile=${toolFile('dist', 'bundle.js')}`,
    '--jsx=automatic',
    '--loader:.tsx=tsx',
    '--loader:.ts=ts',
    '--format=iife',
    `--alias:@reusable=${path.join(workspace, '.applications', '_reusable')}`,
  ];
  /** React in the npm-site the way production has it: the directories `reactAliasFlags` looks for. */
  const installReact = (names: string[] = ['react', 'react-dom']): string => {
    for (const name of names) fs.mkdirSync(path.join(npmModules(), name), { recursive: true });
    return npmModules();
  };
  /** A real React (the repo's) reachable under `modules`, found by plain node resolution. */
  const linkRepoReact = (modules: string): void => {
    fs.mkdirSync(modules, { recursive: true });
    for (const name of ['react', 'react-dom']) {
      fs.symlinkSync(path.join(REPO, 'node_modules', name), path.join(modules, name));
    }
  };
  /**
   * Make `buildMiniApp` run the real esbuild, the way containerService does: cwd
   * is the workspace root and NODE_PATH is the npm-site's node_modules (set here
   * rather than inherited, so a developer's shell cannot change the result).
   */
  const runRealEsbuild = (): void => {
    execLogged.mockImplementation(async (argv: string[]) => {
      const r = spawnSync(argv[0], argv.slice(1), {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: npmModules() },
      });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    });
  };

  beforeEach(() => {
    execLogged.mockReset();
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    warn.mockReset();
    info.mockReset();
    // A path with a space, like ~/Library/Application Support.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acabox build stamps ')));
    workspace = path.join(tmp, 'work space');
    userData = path.join(tmp, 'user data');
    mockPaths.userData = userData;
    fs.mkdirSync(toolFile('src'), { recursive: true });
    fs.writeFileSync(toolFile('src', 'index.tsx'), [
      'import App from "./App";',
      'import { createRoot } from "react-dom/client";',
      'createRoot(document.getElementById("root")!).render(<App />);',
      '',
    ].join('\n'));
    fs.writeFileSync(toolFile('src', 'App.tsx'), 'export default function App() {\n  return <h1>Hello</h1>;\n}\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('with React in the npm-site: the React aliases, then the stamp flags last, pointing at a runtime written under userData', async () => {
    const modules = installReact();

    const result = await buildMiniApp(workspace, DIR);

    expect(result.ok).toBe(true);
    expect(path.basename((execLogged.mock.calls[0][0] as string[])[0])).toBe('esbuild');
    expect(argvOf()).toEqual([
      toolFile('src', 'index.tsx'),
      '--bundle',
      `--outfile=${toolFile('dist', 'bundle.js')}`,
      '--jsx=automatic',
      '--loader:.tsx=tsx',
      '--loader:.ts=ts',
      '--format=iife',
      `--alias:@reusable=${path.join(workspace, '.applications', '_reusable')}`,
      `--alias:react=${path.join(modules, 'react')}`,
      `--alias:react-dom=${path.join(modules, 'react-dom')}`,
      '--jsx-dev',
      '--jsx-import-source=@acabox/jsx-edit',
      `--alias:@acabox/jsx-edit=${runtimeDir()}`,
    ]);
    expect(fs.readFileSync(path.join(runtimeDir(), 'jsx-dev-runtime.js'), 'utf8')).toBe(JSX_EDIT_RUNTIME_SOURCE);
    expect(warn).not.toHaveBeenCalled();
  });

  // The runtime imports react/jsx-runtime from userData, so only the `react`
  // alias can show it the tool's React (see the header). With no alias, stamps
  // would turn a build that works today into one that fails on a host file.
  it('with no React in the npm-site there is no `react` alias: no stamp flags, no runtime written, and the build still runs', async () => {
    // userData exists but its npm-site is empty, as before React is first installed.
    fs.mkdirSync(userData, { recursive: true });

    const result = await buildMiniApp(workspace, DIR);

    expect(result.ok).toBe(true);
    expect(execLogged).toHaveBeenCalledTimes(1);
    expect(argvOf()).toEqual(baseArgv());
    expect(fs.existsSync(runtimeDir())).toBe(false);
    // An expected state, not a host fault: said once, at info, and not as a warning.
    expect(warn).not.toHaveBeenCalled();
    const said = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('stamp'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(DIR);
  });

  it('react-dom alone is not enough: the runtime needs the `react` alias', async () => {
    const modules = installReact(['react-dom']);

    await buildMiniApp(workspace, DIR);

    expect(argvOf()).toEqual([...baseArgv(), `--alias:react-dom=${path.join(modules, 'react-dom')}`]);
    expect(fs.existsSync(runtimeDir())).toBe(false);
  });

  it('never writes the runtime into the workspace, where the agent could edit it', async () => {
    installReact();

    await buildMiniApp(workspace, DIR);

    // It was written, just not there (so the walk below is not vacuous).
    expect(fs.existsSync(path.join(runtimeDir(), 'jsx-dev-runtime.js'))).toBe(true);
    const found: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === 'jsx-dev-runtime.js' || entry.name === 'index.js') found.push(p);
      }
    };
    walk(workspace);
    expect(found).toEqual([]);
  });

  it('restores a tampered runtime on the next build', async () => {
    installReact();
    await buildMiniApp(workspace, DIR);
    fs.writeFileSync(path.join(runtimeDir(), 'jsx-dev-runtime.js'), 'export const jsxDEV = () => null;\n');

    await buildMiniApp(workspace, DIR);

    expect(fs.readFileSync(path.join(runtimeDir(), 'jsx-dev-runtime.js'), 'utf8')).toBe(JSX_EDIT_RUNTIME_SOURCE);
  });

  it('when the runtime cannot be written: one warning, no stamp flags, and the build still runs', async () => {
    const modules = installReact();
    // A regular file sits where the runtime directory would go, so nothing can be created there.
    fs.writeFileSync(runtimeDir(), 'x');

    const result = await buildMiniApp(workspace, DIR);

    expect(result.ok).toBe(true);
    expect(execLogged).toHaveBeenCalledTimes(1);
    expect(argvOf()).toEqual([
      ...baseArgv(),
      `--alias:react=${path.join(modules, 'react')}`,
      `--alias:react-dom=${path.join(modules, 'react-dom')}`,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('stamp');
    expect(String(warn.mock.calls[0][0])).toContain(DIR);
  });

  it('a build that fails for its own reasons still reports them, stamps or not', async () => {
    execLogged.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '✘ [ERROR] Expected ";"' });

    const result = await buildMiniApp(workspace, DIR);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Expected ";"');
  });

  it('a real esbuild run through it yields a bundle whose elements are stamped', async () => {
    // The npm-site holds the React the repo has, found the way production finds it.
    linkRepoReact(npmModules());
    runRealEsbuild();

    const result = await buildMiniApp(workspace, DIR);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const bundle = fs.readFileSync(toolFile('dist', 'bundle.js'), 'utf8');
    // The tool's own element, with the position of its `<` (line 2, column 10).
    expect(excerpt(bundle, '// .applications/demo/src/App.tsx', 400)).toMatch(
      /jsxDEV\("h1", \{ children: "Hello" \}, void 0, false, \{\s*fileName: "\.applications\/demo\/src\/App\.tsx",\s*lineNumber: 2,\s*columnNumber: 10\s*\}/,
    );
    // And our runtime, bundled in beside the single React.
    const runtime = excerpt(bundle, 'function jsxDEV(', 500);
    expect(runtime).toContain('function jsxDEV(type, props, key, isStaticChildren, source)');
    expect(runtime).toContain('props["data-acabox-src"] = ');
  });

  // The regression the stamps introduced: with the flags on, esbuild resolves the
  // runtime's `react/jsx-runtime` from userData, never from the tool's directory.
  // This tool's React sits in its own node_modules and the npm-site has none (so no
  // alias, and NODE_PATH is empty too). It built before stamps; with them it died on
  // `Could not resolve "react/jsx-runtime"` in ../user data/mini-app-jsx-runtime/.
  it('a tool whose React is only in its own node_modules still builds, just without stamps', async () => {
    linkRepoReact(toolFile('node_modules'));
    runRealEsbuild();

    const result = await buildMiniApp(workspace, DIR);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(argvOf()).not.toContain('--jsx-dev');
    const bundle = fs.readFileSync(toolFile('dist', 'bundle.js'), 'utf8');
    expect(bundle).toContain('Hello');
    expect(bundle).not.toContain('data-acabox-src');
    expect(bundle).not.toContain('@acabox/jsx-edit');
  });

  // What "Ask Claude to fix it" sends the agent is this error text, so where it
  // points matters: at the tool's own JSX line, not at a host file outside the workspace.
  it('with no React anywhere the build error points at the tool\'s own files, never at the stamp runtime', async () => {
    runRealEsbuild();

    const result = await buildMiniApp(workspace, DIR);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not resolve "react/jsx-runtime"');
    expect(result.error).toContain('.applications/demo/src/');
    expect(result.error).not.toContain('mini-app-jsx-runtime');
    expect(fs.existsSync(runtimeDir())).toBe(false);
  });
});

/**
 * A few hundred characters of `text` from the first `needle`, or '' when it is
 * absent: a failing assertion on the whole bundle would print a megabyte of React.
 */
function excerpt(text: string, needle: string, length: number): string {
  const at = text.indexOf(needle);
  return at < 0 ? '' : text.slice(at, at + length);
}

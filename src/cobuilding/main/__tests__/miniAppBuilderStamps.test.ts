/**
 * @jest-environment node
 *
 * "Edit text" T1 — `buildMiniApp` stamps every build. It hands esbuild the
 * stamp flags with the runtime in userData (never the workspace); when the
 * runtime can't be written it warns once and builds without stamps instead of
 * failing; and a real esbuild run through it yields a stamped bundle.
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

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const DIR = 'demo';

describe('buildMiniApp — source stamps', () => {
  let tmp: string;
  let workspace: string;
  let userData: string;

  const toolFile = (...parts: string[]) => path.join(workspace, '.applications', DIR, ...parts);
  const runtimeDir = () => path.join(userData, 'mini-app-jsx-runtime');
  /** The argv after the esbuild binary, from the n-th build. */
  const argvOf = (n = 0): string[] => (execLogged.mock.calls[n][0] as string[]).slice(1);

  beforeEach(() => {
    execLogged.mockReset();
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    warn.mockReset();
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

  it('passes the stamp flags last, pointing at a runtime written under userData', async () => {
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
      '--jsx-dev',
      '--jsx-import-source=@acabox/jsx-edit',
      `--alias:@acabox/jsx-edit=${runtimeDir()}`,
    ]);
    expect(fs.readFileSync(path.join(runtimeDir(), 'jsx-dev-runtime.js'), 'utf8')).toBe(JSX_EDIT_RUNTIME_SOURCE);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the React aliases ahead of the stamp flags', async () => {
    const modules = path.join(userData, 'npm-site', 'lib', 'node_modules');
    fs.mkdirSync(path.join(modules, 'react'), { recursive: true });
    fs.mkdirSync(path.join(modules, 'react-dom'), { recursive: true });

    await buildMiniApp(workspace, DIR);

    expect(argvOf().slice(7)).toEqual([
      `--alias:@reusable=${path.join(workspace, '.applications', '_reusable')}`,
      `--alias:react=${path.join(modules, 'react')}`,
      `--alias:react-dom=${path.join(modules, 'react-dom')}`,
      '--jsx-dev',
      '--jsx-import-source=@acabox/jsx-edit',
      `--alias:@acabox/jsx-edit=${runtimeDir()}`,
    ]);
  });

  it('never writes the runtime into the workspace, where the agent could edit it', async () => {
    await buildMiniApp(workspace, DIR);

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
    await buildMiniApp(workspace, DIR);
    fs.writeFileSync(path.join(runtimeDir(), 'jsx-dev-runtime.js'), 'export const jsxDEV = () => null;\n');

    await buildMiniApp(workspace, DIR);

    expect(fs.readFileSync(path.join(runtimeDir(), 'jsx-dev-runtime.js'), 'utf8')).toBe(JSX_EDIT_RUNTIME_SOURCE);
  });

  it('when the runtime cannot be written: one warning, no stamp flags, and the build still runs', async () => {
    // userData sits under a regular file, so nothing can be created there.
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'x');
    mockPaths.userData = path.join(blocker, 'user data');

    const result = await buildMiniApp(workspace, DIR);

    expect(result.ok).toBe(true);
    expect(execLogged).toHaveBeenCalledTimes(1);
    expect(argvOf()).toEqual([
      toolFile('src', 'index.tsx'),
      '--bundle',
      `--outfile=${toolFile('dist', 'bundle.js')}`,
      '--jsx=automatic',
      '--loader:.tsx=tsx',
      '--loader:.ts=ts',
      '--format=iife',
      `--alias:@reusable=${path.join(workspace, '.applications', '_reusable')}`,
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
    const modules = path.join(userData, 'npm-site', 'lib', 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(path.join(REPO, 'node_modules', 'react'), path.join(modules, 'react'));
    fs.symlinkSync(path.join(REPO, 'node_modules', 'react-dom'), path.join(modules, 'react-dom'));
    // Run what the builder asks for, the way containerService does: cwd is the workspace root.
    execLogged.mockImplementation(async (argv: string[]) => {
      const r = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    });

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
});

/**
 * A few hundred characters of `text` from the first `needle`, or '' when it is
 * absent: a failing assertion on the whole bundle would print a megabyte of React.
 */
function excerpt(text: string, needle: string, length: number): string {
  const at = text.indexOf(needle);
  return at < 0 ? '' : text.slice(at, at + length);
}

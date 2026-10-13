/**
 * @jest-environment node
 *
 * T2 — a tool whose `src/App.tsx` does not exist yet is "not written yet",
 * not "broken". The scaffold writes `src/index.tsx` (which does
 * `import App from "./App"`) before Claude has written `src/App.tsx`; if the
 * viewer builds in that window, esbuild fails with "Could not resolve
 * ./App", which used to be recorded as a real build failure
 * (`recordBuildResult(dirName, false, …)`) and lit BUILD FAILED on the home
 * card. `buildMiniApp` now detects this case ahead of esbuild and returns
 * `reason: 'source-missing'` without running esbuild or recording health.
 *
 * Mocking recipe copied verbatim from `miniAppBuilderHooks.test.ts`: mock
 * `electron`, `electron-log`, `../containerService` and `../buildHealth`, and
 * point `app.getAppPath()` at the real repo root so `resolveEsbuildBin()`'s
 * dev-mode candidate (`<appPath>/node_modules/.bin/esbuild`) resolves against
 * the real, already-installed binary — no fake binary needed, and the mocked
 * `containerService.execLogged` means it is never actually invoked.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A real, per-suite tmp directory: nothing here may create directories at the filesystem root.
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

import { containerService } from '../containerService';
import { recordBuildResult } from '../buildHealth';
import { buildMiniApp } from '../miniAppBuilder';

const execLogged = containerService.execLogged as jest.Mock;
const recordBuildResultMock = recordBuildResult as jest.Mock;

describe('miniAppBuilder — source-missing pre-check (T2)', () => {
  beforeAll(() => {
    mockPaths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-userdata-'));
  });
  afterAll(() => {
    fs.rmSync(mockPaths.userData, { recursive: true, force: true });
  });

  const dirName = 'testApp';
  let workspaceRoot: string;
  let srcDir: string;

  beforeEach(() => {
    execLogged.mockReset();
    recordBuildResultMock.mockReset();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-build-source-missing-'));
    srcDir = path.join(workspaceRoot, '.applications', dirName, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('index.tsx exists, no App file → source-missing, esbuild and buildHealth never touched', async () => {
    fs.writeFileSync(path.join(srcDir, 'index.tsx'), 'import App from "./App";');

    const result = await buildMiniApp(workspaceRoot, dirName);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source-missing');
    expect(result.error).toEqual(expect.stringContaining('src/App.tsx'));
    expect(execLogged).not.toHaveBeenCalled();
    expect(recordBuildResultMock).not.toHaveBeenCalled();
  });

  it('src/App.tsx present → normal build proceeds and succeeds', async () => {
    fs.writeFileSync(path.join(srcDir, 'index.tsx'), 'import App from "./App";');
    fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'export default function App() { return null; }');
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await buildMiniApp(workspaceRoot, dirName);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(execLogged).toHaveBeenCalledTimes(1);
    expect(recordBuildResultMock).toHaveBeenCalledWith(dirName, true);
  });

  it('src/App.tsx present but esbuild fails on something else → real failure, no reason set', async () => {
    fs.writeFileSync(path.join(srcDir, 'index.tsx'), 'import App from "./App";');
    fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'export default function App() { return null; }');
    execLogged.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '✘ [ERROR] Something else' });

    const result = await buildMiniApp(workspaceRoot, dirName);

    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(execLogged).toHaveBeenCalledTimes(1);
    expect(recordBuildResultMock).toHaveBeenCalledWith(
      dirName,
      false,
      expect.stringContaining('Something else'),
    );
  });

  it('src/App.jsx present (no .tsx) → esbuild path is taken, not the source-missing branch', async () => {
    fs.writeFileSync(path.join(srcDir, 'index.tsx'), 'import App from "./App";');
    fs.writeFileSync(path.join(srcDir, 'App.jsx'), 'export default function App() { return null; }');
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await buildMiniApp(workspaceRoot, dirName);

    expect(result.reason).toBeUndefined();
    expect(execLogged).toHaveBeenCalledTimes(1);
  });

  it('no src/index.tsx at all → not the source-missing branch, falls through to esbuild', async () => {
    // srcDir exists (created in beforeEach) but is empty — no index.tsx, no App file.
    execLogged.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Could not resolve entry' });

    const result = await buildMiniApp(workspaceRoot, dirName);

    expect(result.reason).toBeUndefined();
    expect(execLogged).toHaveBeenCalledTimes(1);
  });
});

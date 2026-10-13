/**
 * @jest-environment node
 *
 * M10 — `setBuildSucceededHandler`: the build side of "recompute 'behind'
 * after a build or a run" (`docs/design/sharing-tickets.md`). The run side
 * (`setRunCompletedHandler`) already has its own registry test; this file
 * covers the new build hook in `miniAppBuilder.ts`.
 *
 * `buildMiniApp` itself is not re-tested end to end here — `containerService`
 * (which would otherwise spawn a real esbuild) and `buildHealth` (which
 * writes to `app.getPath('userData')`) are mocked so the test controls the
 * exit code directly, per the ticket's guidance to stub what the builder
 * calls rather than run a real build. `electron`'s `app.getAppPath()` is
 * pointed at the real repo root so `resolveEsbuildBin()`'s dev-mode candidate
 * (`<appPath>/node_modules/.bin/esbuild`) resolves against the real,
 * already-installed binary — no fake binary needed, and the mocked
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
import { buildMiniApp, setBuildSucceededHandler } from '../miniAppBuilder';

const execLogged = containerService.execLogged as jest.Mock;

describe('miniAppBuilder — setBuildSucceededHandler', () => {
  beforeAll(() => {
    mockPaths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-userdata-'));
  });
  afterAll(() => {
    fs.rmSync(mockPaths.userData, { recursive: true, force: true });
  });

  const dirName = 'testApp';
  let workspaceRoot: string;

  beforeEach(() => {
    execLogged.mockReset();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-build-hook-'));
    fs.mkdirSync(path.join(workspaceRoot, '.applications', dirName), { recursive: true });
  });

  afterEach(() => {
    setBuildSucceededHandler(null);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('fires exactly once with the dirName on a successful build', async () => {
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const handler = jest.fn();
    setBuildSucceededHandler(handler);

    const result = await buildMiniApp(workspaceRoot, dirName);

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(dirName);
  });

  it('does not fire when the build fails', async () => {
    execLogged.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' });
    const handler = jest.fn();
    setBuildSucceededHandler(handler);

    const result = await buildMiniApp(workspaceRoot, dirName);

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a throwing handler does not make buildMiniApp reject, and the build still reports success', async () => {
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const handler = jest.fn(() => {
      throw new Error('handler exploded');
    });
    setBuildSucceededHandler(handler);

    await expect(buildMiniApp(workspaceRoot, dirName)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a successful build with no handler registered does not throw', async () => {
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    setBuildSucceededHandler(null);

    await expect(buildMiniApp(workspaceRoot, dirName)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it('setBuildSucceededHandler(null) unregisters a previously set handler', async () => {
    execLogged.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const handler = jest.fn();
    setBuildSucceededHandler(handler);
    setBuildSucceededHandler(null);

    await buildMiniApp(workspaceRoot, dirName);

    expect(handler).not.toHaveBeenCalled();
  });
});

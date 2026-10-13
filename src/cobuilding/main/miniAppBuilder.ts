/**
 * Shared mini-app esbuild entry point. Used by:
 *   - the renderer's "Rebuild" button (via the miniApps:build IPC)
 *   - the agent's mcp__mini-apps__build_and_open_mini_application tool
 *
 * Centralising this here means there's one place that knows how to resolve
 * the bundled esbuild binary and run it. The command line itself is
 * `miniAppEsbuildArgs` (miniAppBuildArgs.ts), a pure function so a test can pin
 * the exact argv.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { recordBuildResult } from './buildHealth';
import log from 'electron-log';
import { containerService } from './containerService';
import { getNpmPrefix } from './nodeSetup';
import { miniAppEsbuildArgs } from './miniAppBuildArgs';
import { ensureJsxEditRuntime } from './miniAppJsxRuntime';

export interface MiniAppBuildResult {
  ok: boolean;
  outfile?: string;
  /** esbuild stderr (or stdout) when the build fails. */
  error?: string;
  exitCode: number;
  /**
   * Set only for a build that was never attempted because its source isn't
   * there yet (T2) — e.g. the scaffold wrote `src/index.tsx` but Claude
   * hasn't written `src/App.tsx` yet. Distinguishes "not written yet" from a
   * real compile failure: esbuild never ran, and `recordBuildResult` was
   * never called, so this must not light up BUILD FAILED. Absent on every
   * other result, including genuine failures.
   */
  reason?: 'source-missing';
}

let buildSucceededHandler: ((dirName: string) => void) | null = null;

/**
 * Registered by `main/index.ts` (ticket M10) so a successful build can
 * trigger a "behind" recompute for an app that is published for sharing.
 * A setter rather than importing `share/shareHandlers` directly here: that
 * module reaches back into workspace/manifest state owned by main, and
 * importing it from this shared builder risks a cycle. This is the seam.
 */
export function setBuildSucceededHandler(fn: ((dirName: string) => void) | null): void {
  buildSucceededHandler = fn;
}

/**
 * Locate the esbuild executable.
 *
 * In dev, `node_modules/.bin/esbuild` under the app path is correct. In a
 * PACKAGED build it is not: the forge webpack plugin ships only `.webpack/`
 * output plus the handful of native modules `packageAfterCopy` copies, so
 * `app.getAppPath()` (= `…/Resources/app.asar`) contains no esbuild at all.
 * The old unconditional path therefore pointed inside the archive and every
 * build in every packaged install died with a spawn ENOENT that surfaced as a
 * bare "esbuild exited with code 1" — as if the user's code hadn't compiled.
 *
 * Packaged builds get the real binary from `extraResource` (forge.config.js),
 * with the per-user npm-site as a secondary candidate for installs that
 * predate the shipped copy or run on a mismatched arch.
 */
function resolveEsbuildBin(): { bin: string } | { error: string } {
  const binName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, binName),
        path.join(getNpmPrefix(), 'bin', binName),
      ]
    : [path.resolve(app.getAppPath(), 'node_modules', '.bin', binName)];

  const bin = candidates.find((candidate) => fs.existsSync(candidate));
  if (bin) return { bin };
  return {
    error: `esbuild executable not found. Looked in:\n  ${candidates.join('\n  ')}`,
  };
}

/**
 * Pin every tool bundle to ONE React, the npm-site's.
 *
 * A package that carries its own nested React copy (seen with `lucide-react`
 * and `react-plotly.js` in the dev npm-site) otherwise gets a second React
 * bundled beside the tool's, and the tool crashes with "Invalid hook call …
 * useContext of null". Aliasing makes every import resolve to the same
 * directory. Absolute paths, as with `@reusable`: esbuild does not resolve a
 * relative alias against cwd. Only emitted for a directory that exists, so a
 * prefix without React (or a fresh machine) keeps the old resolution.
 */
export function reactAliasFlags(npmPrefix: string): string[] {
  const modules = path.join(npmPrefix, 'lib', 'node_modules');
  return ['react', 'react-dom']
    .map((name) => [name, path.join(modules, name)] as const)
    .filter(([, dir]) => fs.existsSync(dir))
    .map(([name, dir]) => `--alias:${name}=${dir}`);
}

export async function buildMiniApp(workspacePath: string, dirName: string): Promise<MiniAppBuildResult> {
  const appDir = path.join(workspacePath, '.applications', dirName);
  if (!fs.existsSync(appDir)) {
    return { ok: false, error: `Mini-application directory not found: .applications/${dirName}`, exitCode: 1 };
  }

  const entry = path.join(appDir, 'src', 'index.tsx');
  const outfile = path.join(appDir, 'dist', 'bundle.js');
  const reusableAlias = path.join(workspacePath, '.applications', '_reusable');

  // T2: `src/index.tsx` (written at scaffold time) does `import App from
  // "./App"`, but Claude writes `src/App.tsx` in a later, sometimes slow,
  // tool call. If the entry exists but none of the extensions esbuild would
  // resolve "./App" to exist yet, the tool simply hasn't been written yet —
  // that is not a build failure, so skip esbuild entirely and don't record
  // it in tool-build-health.json. Only checked when index.tsx itself is
  // present; a missing index.tsx is a genuinely broken tool and falls
  // through to esbuild's own (real) error below.
  if (fs.existsSync(entry)) {
    const appCandidates = ['App.tsx', 'App.ts', 'App.jsx', 'App.js']
      .map((name) => path.join(appDir, 'src', name));
    const appExists = appCandidates.some((candidate) => fs.existsSync(candidate));
    if (!appExists) {
      log.info(`[MiniAppBuilder] ${dirName}: no src/App.tsx yet — not built, not recorded as a failure`);
      return {
        ok: false,
        reason: 'source-missing',
        exitCode: 1,
        error: "This tool's code (src/App.tsx) hasn't been written yet. If I'm still building it, it will build once the file exists.",
      };
    }
  }

  const resolved = resolveEsbuildBin();
  if ('error' in resolved) {
    log.error(`[MiniAppBuilder] ${dirName}: ${resolved.error}`);
    return { ok: false, error: resolved.error, exitCode: 127 };
  }

  // Every host element in the bundle is stamped with where it was written (the
  // runtime behind that is miniAppJsxRuntime.ts), which is what lets "Edit
  // text" trace a clicked word back to its source. The runtime is host code,
  // so it lives in userData, where the agent's workspace edits cannot reach it.
  // It is only an addition: if it cannot be written the tool still builds,
  // just without stamps.
  const wantedRuntimeDir = path.join(app.getPath('userData'), 'mini-app-jsx-runtime');
  const jsxRuntimeDir = ensureJsxEditRuntime(wantedRuntimeDir);
  if (!jsxRuntimeDir) {
    log.warn(`[MiniAppBuilder] ${dirName}: couldn't write the JSX stamp runtime to ${wantedRuntimeDir} — building without source stamps, so "Edit text" won't work on this build`);
  }

  // execLogged (not exec) so the invocation lands in the command log / Debug
  // tab. Build failures used to leave no trace anywhere.
  const result = await containerService.execLogged([
    resolved.bin,
    ...miniAppEsbuildArgs({
      entry,
      outfile,
      reusableAlias,
      extraFlags: reactAliasFlags(getNpmPrefix()),
      jsxRuntimeDir,
    }),
  ], { source: 'build', appDirName: dirName });

  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
      || `esbuild exited with code ${result.exitCode} without output — the process may not have started.`;
    log.error(`[MiniAppBuilder] ${dirName}: build failed (exit ${result.exitCode}) via ${resolved.bin}: ${detail}`);
    // Recorded here rather than by the caller so every build path — the
    // Rebuild button and the agent's build tool — reports health identically.
    recordBuildResult(dirName, false, detail);
    return { ok: false, error: detail, exitCode: result.exitCode };
  }
  recordBuildResult(dirName, true);
  // Guarded: a handler bug must never fail a build that already succeeded.
  try {
    buildSucceededHandler?.(dirName);
  } catch (err) {
    log.warn(`[MiniAppBuilder] ${dirName}: build-succeeded handler threw: ${(err as Error).message}`);
  }
  return { ok: true, outfile, exitCode: 0 };
}

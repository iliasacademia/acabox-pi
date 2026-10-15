/**
 * Directory of the search tools (`rg`, `fd`) Acabox PI ships under
 * `resources/bin`. PI's grep/find tools look on PATH before downloading, so the
 * agent server gets this directory prepended to PATH. The binaries are
 * Mach-O arm64, so the directory is offered on Apple Silicon only.
 */
import * as fs from 'fs';
import * as path from 'path';

interface Env {
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export function resolveBundledBinDir(env: Env, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (env.platform !== 'darwin' || env.arch !== 'arm64') return null;
  const dir = env.isPackaged ? path.join(env.resourcesPath, 'bin') : path.join(env.appPath, 'resources', 'bin');
  return exists(path.join(dir, 'rg')) && exists(path.join(dir, 'fd')) ? dir : null;
}

export function getBundledBinDir(): string | null {
  // Lazy: `electron` is unavailable under plain jest imports of this module's tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron');
  return resolveBundledBinDir({
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

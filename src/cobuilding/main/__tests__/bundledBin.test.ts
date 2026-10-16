import * as path from 'path';
import { resolveBundledBinDir } from '../bundledBin';

const base = { platform: 'darwin' as const, arch: 'arm64', isPackaged: false, resourcesPath: '/R', appPath: '/app' };
const present = () => true;

describe('resolveBundledBinDir', () => {
  it('uses resources/bin in dev and <Resources>/bin when packaged', () => {
    expect(resolveBundledBinDir(base, present)).toBe(path.join('/app', 'resources', 'bin'));
    expect(resolveBundledBinDir({ ...base, isPackaged: true }, present)).toBe(path.join('/R', 'bin'));
  });

  it('offers nothing off Apple Silicon, since the binaries are Mach-O arm64', () => {
    expect(resolveBundledBinDir({ ...base, arch: 'x64' }, present)).toBeNull();
    expect(resolveBundledBinDir({ ...base, platform: 'linux' }, present)).toBeNull();
  });

  it('offers nothing when either tool is missing', () => {
    expect(resolveBundledBinDir(base, (p) => p.endsWith('rg'))).toBeNull();
  });
});

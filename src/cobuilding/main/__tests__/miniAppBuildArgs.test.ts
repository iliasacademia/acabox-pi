/**
 * "Edit text" T1 — the exact esbuild argv `buildMiniApp` runs. This is the
 * regression net for the builder: the first half of the list is what every
 * tool bundle has always been built with, and a change to it changes every
 * tool; the stamp flags are appended after it and only when there is a runtime.
 */
import { miniAppEsbuildArgs } from '../miniAppBuildArgs';

const base = {
  entry: '/ws/.applications/demo/src/index.tsx',
  outfile: '/ws/.applications/demo/dist/bundle.js',
  reusableAlias: '/ws/.applications/_reusable',
  extraFlags: ['--alias:react=/npm/lib/node_modules/react', '--alias:react-dom=/npm/lib/node_modules/react-dom'],
};

// The argv from before stamps existed, written out.
const TODAYS_ARGV = [
  '/ws/.applications/demo/src/index.tsx',
  '--bundle',
  '--outfile=/ws/.applications/demo/dist/bundle.js',
  '--jsx=automatic',
  '--loader:.tsx=tsx',
  '--loader:.ts=ts',
  '--format=iife',
  '--alias:@reusable=/ws/.applications/_reusable',
  '--alias:react=/npm/lib/node_modules/react',
  '--alias:react-dom=/npm/lib/node_modules/react-dom',
];

describe('miniAppEsbuildArgs', () => {
  it('without a runtime directory: exactly the argv builds have always had', () => {
    expect(miniAppEsbuildArgs({ ...base, jsxRuntimeDir: null })).toEqual(TODAYS_ARGV);
  });

  it('with a runtime directory: that argv, then the three stamp flags, last', () => {
    expect(miniAppEsbuildArgs({ ...base, jsxRuntimeDir: '/userData/mini-app-jsx-runtime' })).toEqual([
      ...TODAYS_ARGV,
      '--jsx-dev',
      '--jsx-import-source=@acabox/jsx-edit',
      '--alias:@acabox/jsx-edit=/userData/mini-app-jsx-runtime',
    ]);
  });

  // This function only composes what it is given. Whether a build with no `react`
  // alias should carry stamps at all is buildMiniApp's call, and it says no
  // (miniAppBuilderStamps.test.ts), so a real build never reaches this shape.
  it('with no extra flags: nothing between the reusable alias and the stamps', () => {
    expect(miniAppEsbuildArgs({ ...base, extraFlags: [], jsxRuntimeDir: '/rt' })).toEqual([
      '/ws/.applications/demo/src/index.tsx',
      '--bundle',
      '--outfile=/ws/.applications/demo/dist/bundle.js',
      '--jsx=automatic',
      '--loader:.tsx=tsx',
      '--loader:.ts=ts',
      '--format=iife',
      '--alias:@reusable=/ws/.applications/_reusable',
      '--jsx-dev',
      '--jsx-import-source=@acabox/jsx-edit',
      '--alias:@acabox/jsx-edit=/rt',
    ]);
  });

  it('keeps every path as one argument, spaces included', () => {
    const args = miniAppEsbuildArgs({
      entry: '/Users/x/Library/Application Support/acabox/ws/.applications/demo/src/index.tsx',
      outfile: '/Users/x/Library/Application Support/acabox/ws/.applications/demo/dist/bundle.js',
      reusableAlias: '/Users/x/Library/Application Support/acabox/ws/.applications/_reusable',
      extraFlags: [],
      jsxRuntimeDir: '/Users/x/Library/Application Support/acabox/mini-app-jsx-runtime',
    });
    expect(args).toContain('/Users/x/Library/Application Support/acabox/ws/.applications/demo/src/index.tsx');
    expect(args).toContain('--outfile=/Users/x/Library/Application Support/acabox/ws/.applications/demo/dist/bundle.js');
    expect(args).toContain('--alias:@reusable=/Users/x/Library/Application Support/acabox/ws/.applications/_reusable');
    expect(args).toContain('--alias:@acabox/jsx-edit=/Users/x/Library/Application Support/acabox/mini-app-jsx-runtime');
  });

  it('does not change the extra flags it was given', () => {
    const extraFlags = [...base.extraFlags];
    miniAppEsbuildArgs({ ...base, extraFlags, jsxRuntimeDir: '/rt' });
    expect(extraFlags).toEqual(base.extraFlags);
  });
});

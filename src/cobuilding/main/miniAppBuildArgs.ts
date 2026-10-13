/**
 * The esbuild command line for a mini-app bundle, as a pure function so the
 * exact argv can be pinned by a test. `buildMiniApp` (miniAppBuilder.ts) runs
 * this and nothing else; it lives apart from the builder because the builder
 * imports `electron` and this must load under jest.
 */

import { jsxEditFlags } from './miniAppJsxRuntime';

export interface MiniAppEsbuildArgsInput {
  /** Absolute path of `src/index.tsx`. */
  entry: string;
  /** Absolute path of `dist/bundle.js`. */
  outfile: string;
  /** Absolute path of `.applications/_reusable` (esbuild does not resolve a relative alias). */
  reusableAlias: string;
  /** e.g. reactAliasFlags(npmPrefix) — passed in so this module stays electron-free. */
  extraFlags: string[];
  /** From ensureJsxEditRuntime; null = build without stamps. */
  jsxRuntimeDir: string | null;
}

/** The esbuild argv after the binary, exactly as buildMiniApp runs it. */
export function miniAppEsbuildArgs(input: MiniAppEsbuildArgsInput): string[] {
  return [
    input.entry,
    '--bundle',
    `--outfile=${input.outfile}`,
    '--jsx=automatic',
    '--loader:.tsx=tsx',
    '--loader:.ts=ts',
    '--format=iife',
    `--alias:@reusable=${input.reusableAlias}`,
    ...input.extraFlags,
    ...jsxEditFlags(input.jsxRuntimeDir),
  ];
}

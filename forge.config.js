const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const product = require('./product.json');

function isPortInUse(port) {
  try {
    if (os.platform() === 'win32') {
      execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: 'ignore' });
    } else {
      execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function findAvailablePort(startPort) {
  let port = startPort;
  while (isPortInUse(port)) {
    port++;
  }
  return port;
}

const devServerPort = findAvailablePort(3000);
const loggerPort = findAvailablePort(devServerPort + 1000);

// Root native modules that need to be copied outside the asar archive.
// Transitive runtime dependencies are resolved automatically.
const nativeModuleRoots = ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'];

const installTimeOnly = new Set([
  'prebuild-install', 'node-addon-api', 'node-gyp', 'node-gyp-build',
]);

function resolveRuntimeDeps(roots) {
  const resolved = new Set();
  const queue = [...roots];

  while (queue.length > 0) {
    const mod = queue.shift();
    if (resolved.has(mod) || installTimeOnly.has(mod)) continue;

    const pkgPath = path.join(__dirname, 'node_modules', mod, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    resolved.add(mod);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    for (const depField of ['dependencies', 'optionalDependencies']) {
      if (pkg[depField]) {
        for (const dep of Object.keys(pkg[depField])) {
          if (!resolved.has(dep) && !installTimeOnly.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }
  }

  return [...resolved];
}

const codeSignIdentity = process.env.APPLE_IDENTITY || undefined;
const platform = os.platform();

/**
 * Path to the REAL esbuild executable for the build host's platform/arch.
 *
 * esbuild ships its binary in a per-platform optional dependency
 * (`@esbuild/darwin-arm64`, `@esbuild/win32-x64`, …); `node_modules/esbuild/bin/esbuild`
 * is a hardlink to it on POSIX and a JS shim on Windows, and
 * `node_modules/.bin/esbuild` is a symlink that must never be shipped. Prefer
 * the platform package, fall back to esbuild/bin.
 *
 * NOTE: this binds the artifact to the build host's architecture. A universal
 * or cross-arch build needs both slices (lipo, or a per-arch make).
 */
function resolveEsbuildBinary() {
  const pkg = `@esbuild/${platform}-${os.arch()}`;
  const candidates = platform === 'win32'
    ? [path.join('node_modules', pkg, 'esbuild.exe')]
    : [
        path.join('node_modules', pkg, 'bin', 'esbuild'),
        path.join('node_modules', 'esbuild', 'bin', 'esbuild'),
      ];
  const found = candidates.find((c) => fs.existsSync(path.join(__dirname, c)));
  if (!found) {
    throw new Error(
      `Cannot package: esbuild binary not found for ${platform}-${arch}. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Mini-app builds would be dead in the packaged app. Run `npm install` and retry.',
    );
  }
  return found;
}

const esbuildBinary = resolveEsbuildBinary();

const packagerConfig = {
  name: product.productName,
  icon: './src/assets/icons/dock-icon',
  appBundleId: product.bundleId,
  derefSymlinks: true,
  prune: false,
  // No custom URL scheme: the only deep link was the academia QR-auth callback,
  // which was removed along with login.
  asar: {
    unpack: '{**/node_modules/better-sqlite3/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*}',
  },
  extraResource: [
    'dist/agent-server.js',
    // PI harness (plan D2): assembled by scripts/build-pi-bundle.mjs into build/pi,
    // loaded by file URL from <Resources>/pi, never bundled by webpack.
    'build/pi',
    // Mini-app bundler. MUST be the real binary under esbuild/bin, not the
    // node_modules/.bin symlink (extraResource copies it verbatim, and a
    // dangling symlink in Resources/ is worse than nothing). Lands at
    // <Resources>/esbuild; miniAppBuilder.resolveEsbuildBin() looks there when
    // app.isPackaged. Without this every mini-app build fails in packaged
    // builds — the webpack plugin never puts node_modules/esbuild in the asar.
    esbuildBinary,
    'src/cobuilding/prebuilt-apps',
    'src/assets/icons',
    'app-update.yml',
    'src/cobuilding/skills',
    'src/cobuilding/CLAUDE.md',
    'src/cobuilding/settings.json',
    'src/cobuilding/hooks',
    ...(platform === 'darwin' && fs.existsSync('src/cobuilding/rust/file-monitor-mac/target/release/file-monitor-mac')
      ? ['src/cobuilding/rust/file-monitor-mac/target/release/file-monitor-mac']
      : []),
    // On-device dictation helper. Built by `premake`/`prepackage` via
    // scripts/build-dictation-helper.js, which is deliberately non-fatal — so
    // guard on existence rather than assuming it. Lands at
    // <Resources>/dictation-mac; main/dictationService.ts looks there when
    // app.isPackaged, and reports the feature unavailable if it's absent.
    ...(platform === 'darwin' && fs.existsSync('src/cobuilding/swift/dictation-mac/build/dictation-mac')
      ? ['src/cobuilding/swift/dictation-mac/build/dictation-mac']
      : []),
  ],
  ...(platform === 'darwin' ? {
    extendInfo: {
      NSDesktopFolderUsageDescription: `${product.productName} needs access to your Desktop to manage workspace files.`,
      NSDocumentsFolderUsageDescription: `${product.productName} needs access to your Documents to manage workspace files.`,
      NSDownloadsFolderUsageDescription: `${product.productName} needs access to your Downloads to manage workspace files.`,
      // Required for voice dictation. The helper binary is not itself bundled,
      // so TCC resolves both strings against ${product.productName}.app as the responsible
      // process — omit either one and the helper is killed on first use rather
      // than being denied gracefully.
      NSMicrophoneUsageDescription: `${product.productName} uses your microphone to dictate messages into the chat composer. Audio is transcribed on this Mac and never leaves it.`,
      NSSpeechRecognitionUsageDescription: `${product.productName} transcribes your dictation using macOS on-device speech recognition. Audio is not sent to Apple or to any AI provider.`,
    },
  } : {}),
};

if (codeSignIdentity) {
  packagerConfig.osxSign = {
    identity: codeSignIdentity,
    hardenedRuntime: true,
    entitlements: 'entitlements.plist',
    'entitlements-inherit': 'entitlements.plist',
  };

  if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
    packagerConfig.osxNotarize = {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }
}

module.exports = {
  packagerConfig,
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      const modulesToCopy = resolveRuntimeDeps(nativeModuleRoots);
      for (const mod of modulesToCopy) {
        const src = path.join(__dirname, 'node_modules', mod);
        const dest = path.join(buildPath, 'node_modules', mod);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
          console.log(`Copied ${mod} to package`);
        }
      }
    },
    // Without a Developer ID, electron-packager + the fuses flip leave an
    // INVALID ad-hoc signature (Info.plist not bound), which macOS reports as
    // "…is damaged and can't be opened" on any downloaded copy. Re-sign the
    // whole bundle ad-hoc here — after packaging/fuses, before the dmg/zip
    // makers run — so the distributed app has a VALID signature (downloaders
    // get "unidentified developer" → right-click Open, not "damaged").
    // Developer ID + notarization (set APPLE_IDENTITY / APPLE_ID / …) is still
    // required for a clean download experience and for macOS auto-update, so
    // skip ad-hoc re-signing when a real signing identity is configured.
    postPackage: async (_config, options) => {
      if (codeSignIdentity || platform !== 'darwin') return;
      for (const outPath of options.outputPaths || []) {
        const appPath = path.join(outPath, `${packagerConfig.name}.app`);
        if (!fs.existsSync(appPath)) continue;
        console.log(`Ad-hoc signing (no Developer ID): ${appPath}`);
        execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: product.productName.replace(/\s+/g, ''),
        authors: 'Academia.edu',
        description: product.productName,
        certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
        certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        port: devServerPort,
        loggerPort: loggerPort,
        devContentSecurityPolicy: "default-src 'self' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: local-file:; frame-src local-file: http://localhost:* http://127.0.0.1:*; connect-src 'self' ws: http://localhost:*;",
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/cobuilding/renderer/index.html',
              js: './src/cobuilding/renderer/index.tsx',
              name: 'cobuilding_window',
              preload: {
                js: './src/cobuilding/main/preload.ts',
              },
            },
            {
              html: './src/cobuilding/renderer/update.html',
              js: './src/cobuilding/renderer/update.tsx',
              name: 'cobuild_update_window',
              preload: {
                js: './src/cobuilding/main/preload.ts',
              },
            },
            {
              html: './src/cobuilding/renderer/find-bar.html',
              js: './src/cobuilding/renderer/find-bar-entry.tsx',
              name: 'find_bar_window',
              preload: {
                js: './src/cobuilding/main/findBarPreload.ts',
              },
            },
            {
              html: './src/cobuilding/renderer/screenshot-overlay.html',
              js: './src/cobuilding/renderer/screenshot-overlay-entry.ts',
              name: 'screenshot_overlay_window',
              preload: {
                js: './src/cobuilding/main/screenshotOverlayPreload.ts',
              },
            },
          ],
        },
      },
    },
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

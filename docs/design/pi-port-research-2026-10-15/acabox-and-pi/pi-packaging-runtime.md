# PI 1.2.0 inside an Electron Forge app: packaging + runtime report

All measurements were run with `ELECTRON_RUN_AS_NODE=1 "/Users/iliasbeshimov/Documents/Dev Folders/Acabox/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"` (Electron 37.2.0 / Node 22.17.0 / V8 13.8), stdin = `/dev/null`, the PI agent dir pointed at a scratch dir, `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0` unless stated. Scripts and raw outputs: `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/work-pi-packaging-runtime/` (`scripts/a-offline-init.mjs`, `b-custom-tools.mjs`, `d-ship-bundle.mjs`, `d2-clean-env.mjs`, `f-file-extension.mjs`, `g-context-files.mjs`, `g2-trust.mjs`, `g3-project-dir-trust.mjs`, `h-rpc-entry.mjs`, `j2-untrusted-context.mjs`, `k-listener-timing.mjs`, `c-webpack/`, `c3-webpack-ignore/`, `e-main/main.cjs`, `ship/pi/` = the relocated bundle layout, `run*/` = per-run scratch agent dirs, `run1.stdout` etc.).

Paths used below: `PKG` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-pkg/node_modules`; `SRC` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-src/pi/packages`; `ACABOX` = `/Users/iliasbeshimov/Documents/Dev Folders/Acabox`.

**One caveat that applies to several runs:** this shell exports `GEMINI_API_KEY` (and `DEVIN_API_KEY`), and pi-ai reads `GEMINI_API_KEY` from the environment (`PKG/@earendil-works/pi-ai/dist/env-api-keys.js`). Runs 1–4, D and E inherited it, so their `session.model = google/gemini-3.1-pro-preview` and "22 available models" lines are NOT credential-less. Runs D2, E2, F1/F2, G, G2, G3, H, J1/J2, K and C3 were run under `env -i` (only HOME/PATH/USER/TMPDIR + the PI vars) and are the true no-credential measurements. Timing, file-creation, listener and network findings were identical across both families.

---

## 1. How Acabox ships its Claude SDK today (READ)

`ACABOX/forge.config.js`:
- line 34: `const nativeModuleRoots = ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'];` → `packageAfterCopy` hook (lines 178–188) copies those packages and their resolved runtime deps into `<buildPath>/node_modules/<mod>` with `fs.cpSync(src, dest, { recursive: true })`.
- lines 111–113: `asar: { unpack: '{**/node_modules/better-sqlite3/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*}' }`.
- lines 114–141: `extraResource: ['dist/agent-server.js', esbuildBinary, 'src/cobuilding/prebuilt-apps', 'src/assets/icons', 'app-update.yml', 'src/cobuilding/skills', 'src/cobuilding/CLAUDE.md', 'src/cobuilding/settings.json', 'src/cobuilding/hooks', ...file-monitor-mac, ...dictation-mac]` — whole directories are already shipped this way, so a prepared `pi/` directory fits the existing pattern.
- line 107–108: `derefSymlinks: true, prune: false`.
- lines 286–298: `@electron-forge/plugin-auto-unpack-natives` and fuses `RunAsNode: true`, `EnableNodeOptionsEnvironmentVariable: false`, `EnableNodeCliInspectArguments: false`, `EnableEmbeddedAsarIntegrityValidation: true`, `OnlyLoadAppFromAsar: true`.

`ACABOX/webpack.agent-server.config.js` (whole file, 31 lines): `entry: './src/cobuilding/agent-server/index.ts', target: 'node', mode: 'production', output: { path: dist, filename: 'agent-server.js' }, resolve.extensions ['.ts','.js','.mjs'], ts-loader transpileOnly, externals: {}, optimization.minimize: false`. The output is CommonJS (webpack default); `dist/agent-server.js` is 2,018,494 B today.

`ACABOX/package.json`: `"build:agent-server": "webpack --config webpack.agent-server.config.js"`, `prestart` builds it via `scripts/build-cobuilding-prestart.js`, `prepackage`/`premake` = `npm run build:agent-server && npm run build:dictation`, `"test": "ELECTRON_RUN_AS_NODE=1 electron node_modules/.bin/jest"`, `electron ^37.2.0`, `@electron-forge/cli ^7.8.1`, `@electron-forge/plugin-webpack ^7.10.2`, `webpack ^5.102.1`, `ts-loader ^9.5.4`.

CLAUDE.md (project): the agent server is spawned "via `process.execPath` with `ELECTRON_RUN_AS_NODE=1`", bundled by webpack into `dist/agent-server.js`, shipped by `extraResource`. That child-process shape is exactly what was measured here.

## 2. PI package anatomy (READ, sizes MEASURED)

`PKG/@earendil-works/pi-coding-agent/package.json` (verbatim, relevant keys):
```json
"type": "module",
"piConfig": { "configDir": ".pi" },
"bin": { "pi": "dist/bundle/cli.js" },
"main": "./dist/index.js",
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./rpc-entry": { "import": "./dist/bundle/rpc-entry.js" }
},
"files": ["dist","docs","examples","schemas","containerization.md","CHANGELOG.md"],
"engines": { "node": ">=22.19.0" }
```
Dependencies (exact pins): `@earendil-works/pi-agent-core ^1.2.0, pi-ai ^1.2.0, pi-codemode ^1.2.0, pi-mcp ^1.2.0, pi-tui ^1.2.0, @silvia-odwyer/photon-node 0.3.4, brace-expansion 5.0.12, chalk 6.0.0, cross-spawn 7.0.6, diff 8.0.4, grok-mermaid 0.2.3, highlight.js 10.7.3, hosted-git-info 9.0.3, ignore 7.0.8, jiti 2.7.0, minimatch 10.2.6, proper-lockfile 4.1.2, quickjs-wasi 3.6.2, semver 7.8.5, typebox 1.3.27, undici 8.10.2, yaml 2.9.0`; `overrides.protobufjs 7.6.6`.

**Two SDK entries exist and they differ:**
- `exports["."]` → `dist/index.js` (5,126 B) is the **unbundled** tsc output: it re-exports from `./cli/args.js`, `./config.js`, `./core/sdk.js`, … and `./modes/interactive/components/index.js` (line 42, so **pi-tui is loaded at import time**), and those files import `@earendil-works/pi-ai`, `pi-agent-core`, `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/*` … from node_modules. It needs the whole 148 MB tree.
- `dist/bundle/index.js` (6,921 B) + `dist/bundle/chunks/` (76 files, 8.9 MB) is the **self-contained esbuild bundle** PI's own CLI runs from (`cli.js` → `cli-runtime.js`, `rpc-entry.js`). It is NOT in the exports map: `import("@earendil-works/pi-coding-agent/dist/bundle/index.js")` → `ERR_PACKAGE_PATH_NOT_EXPORTED` (measured, script `i-exports.mjs`); it loads fine through a `file://` URL (measured, runs 4/D/D2/E2/…).

`dist/bundle` composition (ls -laS): `chunk-TJXZSVTD.js` 3,510,500 B (main: SDK + undici + pi-ai + pi-tui…), `lib-TEDK3E5I.js` 966,765, `chunk-CQ3XTLTY.js` 949,857, `bedrock-converse-stream.js` 882,211, `chunk-H3QXYIF7.js` 458,410, `chunk-6MWTY2OB.js` 453,934 (TUI/theme), `chunk-F5ZABL6Z.js` 293,583, `chunk-D7PHKNBM.js` 233,822, `jiti-loader-C3NU2SDH.js` 201,917, `codemode-worker.js` 78,598, `image-resize-worker.js` 8,298, 11 OAuth lazy entries (`anthropic.js`, `openai-codex.js`, `openai-chatgpt.js`, `openrouter.js`, `github-copilot.js`, `kimi-coding.js`, `meta.js`, `radius.js`, `xai.js`…), provider API chunks (`openai-completions-*.js`, `openai-responses-*.js`, `openai-codex-responses-*.js`, `anthropic-messages-*.js`, `google-generative-ai-*.js`, `google-vertex-*.js`, `mistral-conversations-*.js`, `azure-openai-responses-*.js`, `llama-cpp-classify-*.js`), `virtual-modules-GI6FRNLG.js`, `jiti-static-loader-E6ANQD5T.js`.

How the bundle is built (`SRC/../scripts/build-coding-agent-bundle.mjs`):
- lines 15–17 banner: `import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);`
- lines 18–28 `allowedExternalPackages`: `@silvia-odwyer/photon-node`, `jiti`, `bufferutil`, `utf-8-validate`, `kerberos`, `supports-color` (the last four optional).
- lines 78–104: `define: { PI_BUNDLED_NODE: "true" }, external: ["@silvia-odwyer/photon-node"], format: "esm", platform: "node", target: "node22.19", splitting: true`, `lazyJitiPlugin` (jiti is `require`d lazily, only when a file extension loads).
- lines 178–210: the 11 OAuth flows, `bedrock-converse-stream`, `image-resize-worker` are emitted as separate self-contained files "beside the code that resolves it" because they are reached "through variable-specifier imports or a worker URL, so the main bundle cannot follow them".
- lines 212–234: `codemode-worker.js` is built without the banner and without `import.meta` so it can be spawned from an in-memory `data:` URL (`dist/config.js` lines 418–433 `getCodemodeWorkerSpecifier()`), surviving an update that deletes the install.
- lines 247–252: `cli.js` launcher = `enableCompileCache(); createRequire(import.meta.url)("./cli-runtime.js");` — i.e. **`require(esm)`**.

Externals the bundle really touches at runtime (grep of `dist/bundle/**`): `__require("supports-color")`, `__require("utf-8-validate")`, `__require("bufferutil")`, `require("@aws-sdk/signature-v4-crt")` (all optional, callers fall back), `createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")` (2×), `.resolve("typebox")`, `"typebox/compile"`, `"typebox/value"` (only inside `getAliases()`, which the bundled build skips — see §7), `import("@silvia-odwyer/photon-node")` (via `utils/photon.js`), `require("jiti")` (lazy). No `.node` native modules are needed: pi-tui's `native/<platform>/prebuilds/*.node` (clipboard helper) are resolved lazily in `pi-tui/dist/native-platform.js:11` and are not part of the bundle set.

Sibling packages (installed): `pi-ai` 6.4 MB (deps: `@anthropic-ai/sdk 0.129.0, @aws-sdk/client-bedrock-runtime 3.1127.0, @google/genai 2.21.0, @smithy/node-http-handler 4.12.1, http-proxy-agent 9.1.0, https-proxy-agent 9.1.0, openai 7.19.0, partial-json 0.1.7, typebox 1.3.27, pi-telemetry`), `pi-agent-core` 332 KB, `pi-codemode` 520 KB (dep `quickjs-wasi 3.6.2`), `pi-mcp` 564 KB (dep `cross-spawn`), `pi-tui` 2.8 MB (deps `get-east-asian-width`, `marked`), `pi-telemetry` 200 KB (no deps). All declare `engines.node >=22.19.0`.

WASM files: `PKG/quickjs-wasi/quickjs.wasm` 637,405 B (loaded via `WebAssembly.compile` of bytes read from the path resolved by `createRequire(...).resolve("quickjs-wasi/quickjs.wasm")`, `pi-codemode/dist/wasm.js:10`, `dist/config.js:404`); `PKG/@silvia-odwyer/photon-node/photon_rs_bg.wasm` 1,881,634 B (CJS `photon_rs.js` reads it with `fs.readFileSync(__dirname + '/photon_rs_bg.wasm')`; `dist/utils/photon.js` lines 41–93 temporarily monkey-patches `fs.readFileSync` while importing it to add fallback paths next to `process.execPath`/cwd); `examples/extensions/doom-overlay/doom/build/doom.wasm` 380,169 B (examples only).

`pi-telemetry` (`SRC/telemetry/src/index.ts`, README): a vendor-neutral `TelemetryContext`/`TelemetrySpan` contract with `NOOP_TELEMETRY_CONTEXT` and an in-memory reference; "no exporter, global current-span state, or dependency on a telemetry backend"; "does not use AsyncLocalStorage". It sends nothing anywhere. The thing the docs call "install/update telemetry" lives in coding-agent (§4).

## 3. Isolating PI's config under Acabox's userData (READ + MEASURED)

`PKG/@earendil-works/pi-coding-agent/dist/config.js`:
```js
// 469-477
const piConfigName = pkg.piConfig?.name;
export const PACKAGE_NAME = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME = piConfigName || "pi";
export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi";
export const VERSION = pkg.version || "0.0.0";
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
// 491-497
export function getAgentDir() {
    const envDir = process.env[ENV_AGENT_DIR];
    if (envDir) { return expandTildePath(envDir); }
    return join(homedir(), CONFIG_DIR_NAME, "agent");
}
// 315-326
export function getPackageDir() {
    const envDir = process.env.PI_PACKAGE_DIR;
    if (envDir) { return normalizePath(envDir); }
    if (isBunBinary) { return dirname(process.execPath); }
    return findNodePackageDir(__dirname);   // walks up from import.meta.url looking for package.json (dist-aware)
}
```
`pkg` is the nearest `package.json` above the running file (lines 456–468; a missing file is tolerated → `VERSION "0.0.0"`, `APP_NAME "pi"`).

- **The env var name is derived from `piConfig.name`.** `docs/environment-variables.md:81` documents `PI_CODING_AGENT_DIR`; the code (config.ts:585) renames it when a shipped `package.json` sets `piConfig.name`. Measured: with `{"piConfig":{"name":"acabox","configDir":".acabox-pi"}}` the SDK honoured `ACABOX_CODING_AGENT_DIR` and `CONFIG_DIR_NAME` became `.acabox-pi` (runs D/D2/E2/G3). Code wins over the doc.
- **`createAgentSession({ agentDir })`** (`SRC/coding-agent/src/core/sdk.ts` 191–202):
```ts
const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));
const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
```
  The option covers auth.json, models.json, settings, sessions, resource discovery. **It does not cover every `getAgentDir()` call site.** Direct callers that ignore the option (grep of `SRC/coding-agent/src`, non-test): `core/model-runtime.ts:220` (models.json default when `modelsPath` undefined), `core/models-store.ts:52` (`models-store.json`), `core/auth-storage.ts:64,208,348,499`, `core/settings-manager.ts:312`, `core/keybindings.ts:337`, `core/crash-log.ts:21`, `core/skills.ts:419`, `core/extensions/loader.ts:831`, `extensions/mcp/oauth.ts:147-148` (`mcp-auth.json` + lock dir), `extensions/mcp/index.ts:370` (`mcp.log`), `:805`, `:1019`, `:1344` (`mcp.json`), `migrations.ts:22,85,158,178,258`, `main.ts:595`, `package-manager-cli.ts:850,942,952`, interactive-mode (TUI only). Measured: the option-only run (run2) still reported `getAgentDir() = /Users/iliasbeshimov/.pi/agent` while writing nothing there in that path; the MCP extension (which would) was not loaded. **Recommendation: set the env var (`PI_CODING_AGENT_DIR`, or `<NAME>_CODING_AGENT_DIR` after a rebrand) in the agent-server's env AND pass `agentDir`.**
- **Sessions:** `PI_CODING_AGENT_SESSION_DIR` is read only by the CLI (`main.ts:691`), never by `createAgentSession`. The SDK default is `getDefaultSessionDir(cwd, agentDir)` = `<agentDir>/sessions/--<cwd with every / \ : replaced by ->--/` (`dist/core/session-manager.js` 290–302, `mkdirSync` at 298–300). Measured: `<agentDir>/sessions/--private-tmp-…-rund-cwd--/2026-10-15T17-18-02-502Z_01a14092-….jsonl` (8,280 B after one failed turn). To put sessions elsewhere pass `sessionManager: SessionManager.create(cwd, sessionDir)` (d.ts: `static create(cwd: string, sessionDir?: string, options?: NewSessionOptions)`, `static open(path, sessionDir?, cwdOverride?)`, `static continueRecent(cwd, sessionDir?)`, `static inMemory(cwd?, options?, entries?)`).
- **Files PI writes at `createAgentSession` (measured in every run, including clean env):** `<agentDir>/auth.json` = `{}` and `<agentDir>/models-store.json` = `{}`, both `-rw-------` (0600) in a `drwx------` dir (auth-storage.ts:71 `mkdirSync(dir, { recursive: true, mode: 0o700 })`, :77 `writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS)`); plus the empty `sessions/<encoded cwd>/` dir when the session manager is persistent. Nothing is written into `cwd` (no `.pi/` created). `settings.json`, `trust.json` (`dist/core/trust-manager.js:174 join(agentDir, "trust.json")`), `keybindings.json`, `mcp.json`, `models.json` are only created on explicit writes. `~/.pi` mtime unchanged and `~/.pi/agent` absent after every run.
- Other disk side effects: loading a `.ts` extension file made jiti write its transform cache to `$TMPDIR/jiti/<name>.<hash>.mjs` (measured, run F1: `/var/folders/…/T/jiti/extensions-hello.2d1cac51.mjs`); jiti exposes `JITI_CACHE` (string in `PKG/jiti/dist/jiti.cjs`; semantics INFERRED, not measured). `dist/bundle/cli.js` calls `enableCompileCache()` which uses Node's default `os.tmpdir()/node-compile-cache` — that dir already existed on this machine (28 MB) so attribution was not possible; the SDK entry never calls it.
- `PI_PACKAGE_DIR` can pin `getPackageDir()` to `<Resources>/pi` explicitly instead of relying on the walk-up (READ; the walk-up itself was measured to work from the relocated copy).
- Full list of process-config env vars (`docs/environment-variables.md` 79–98, verified in code): `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` (CLI only), `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `PI_SHARE_VIEWER_URL`, `PI_RADIUS_GATEWAY`, `PI_HARDWARE_CURSOR`, `PI_CLIPBOARD_OSC52`, `PI_HYPERLINKS`, `PI_PROGRAM_STATUS`, `PI_IMAGE_PROTOCOL`, `PI_TRUE_COLOR`, `PI_TUI_ESC_TIMEOUT`, `VISUAL`/`EDITOR`, `HTTP_PROXY`/`HTTPS_PROXY`. Process markers `AI_AGENT=pi` / `PI_CODING_AGENT=true` are set by `cli-runtime.js`/`rpc-entry.js` only — measured `env keys added by SDK: []`.
- Provider credentials are read from the environment automatically; names in `pi-ai/dist/env-api-keys.js`: `AI_GATEWAY_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_OAUTH_TOKEN ANT_LING_API_KEY AWS_SECRET_ACCESS_KEY AZURE_OPENAI_API_KEY BASETEN_API_KEY CEREBRAS_API_KEY CLOUDFLARE_API_KEY COPILOT_GITHUB_TOKEN DEEPSEEK_API_KEY FIREWORKS_API_KEY GCLOUD_PROJECT GEMINI_API_KEY GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CLOUD_API_KEY GOOGLE_CLOUD_LOCATION GOOGLE_CLOUD_PROJECT GROQ_API_KEY HF_TOKEN KIMI_API_KEY META_API_KEY MINIMAX_API_KEY MINIMAX_CN_API_KEY MISTRAL_API_KEY MOONSHOT_API_KEY NVIDIA_API_KEY OPENAI_API_KEY OPENCODE_API_KEY OPENROUTER_API_KEY QWEN_TOKEN_PLAN_API_KEY QWEN_TOKEN_PLAN_CN_API_KEY RADIUS_API_KEY TOGETHER_API_KEY TYPESAFE_API_KEY XAI_API_KEY XIAOMI_API_KEY XIAOMI_TOKEN_PLAN_AMS_API_KEY XIAOMI_TOKEN_PLAN_CN_API_KEY XIAOMI_TOKEN_PLAN_SGP_API_KEY ZAI_API_KEY ZAI_CODING_CN_API_KEY`. Acabox's `buildSubprocessEnv()` should therefore scrub these (Acabox holds keys in its proxy by design) or deliberately pass them.

## 4. Network endpoints PI contacts on its own (READ; SDK path MEASURED silent)

Measured with `net.Socket.prototype.connect`, `tls.connect`, `dns.lookup` and `globalThis.fetch` wrapped before the SDK loaded: **0 network calls** during import + `createAgentSession` + `dispose` with `PI_OFFLINE=1` (run1) AND with `PI_OFFLINE` unset (run3), and 0 during a credential-less `prompt()` (run D2, which rejected locally with `No API key found for the selected model.`).

Endpoints in source, with gating:
| Endpoint | Where | When | Off switch |
|---|---|---|---|
| `https://pi.dev/api/latest-version` | `utils/version-check.ts:5`, `checkForNewPiVersion` | interactive TUI only (`modes/interactive/interactive-mode.ts:1159`) | `PI_SKIP_VERSION_CHECK` (:98) or `PI_OFFLINE` (:55) |
| `https://pi.dev/api/report-install?version=<v>` | `interactive-mode.ts:1359-1375` `reportInstallTelemetry` | interactive TUI only, when the changelog for a new version is first shown (:1350-1353) | `PI_OFFLINE`, or `isInstallTelemetryEnabled()` false: `PI_TELEMETRY=0` overrides setting `enableInstallTelemetry` whose default is **`true`** (`core/settings-defaults.ts:32`; `core/telemetry.ts:8-13`) |
| `https://pi.dev/api/models/providers/<providerId>?types=chat,image,classifier` | `core/remote-catalog-provider.ts:14,77-99` (`withRemoteCatalog`), refresh interval 4 h (:16), 4 s per attempt (:15) | only when `modelRuntime.refresh({ allowNetwork: true })` runs; `ModelRuntime.create` passes `allowNetwork = modelNetworkEnabled && options.allowModelNetwork === true` (`core/model-runtime.ts:252`), default false; the TUI calls `refreshModelCatalogs` at startup (`interactive-mode.ts:1149-1156`) and `pi config` (`package-manager-cli.ts:942`) | `PI_OFFLINE` → `modelNetworkEnabled = process.env.PI_OFFLINE === undefined` (`model-runtime.ts:247`) |
| OpenRouter personalisation (`openrouter.ai/api/v1/...`) | `model-runtime.ts:226-234` `withPersonalizedCatalog(provider, personalizeOpenRouterCatalog, …)` | same network refresh, only for provider `openrouter` | same |
| `https://pi.dev/api/installer/releases`, `pi.dev/install.sh` | `package-manager-cli.ts:50,1123-1124` | CLI self-update only | n/a in SDK |
| `https://pi.dev/oauth/client.json` (Client ID Metadata Document) | `extensions/mcp/oauth.ts:42` | only if an MCP server is configured with `clientRegistration: "cimd"` (`core/mcp-servers.ts:116-119`) | don't configure it |
| `https://radius.pi.dev` | `pi-ai/src/providers/radius-config.ts:4`, `core/radius.ts` (`PI_RADIUS_GATEWAY`) | only for the `radius` provider / `/bug` uploads | don't use provider |
| `https://pi.dev/session/#<gist>` | `config.ts:592` | `/share` command (TUI) | n/a |
| Provider attribution headers (to the provider, not pi.dev): OpenRouter `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi`, `X-OpenRouter-Categories: cli-agent`; NVIDIA `X-BILLING-INVOKE-ORIGIN: Pi`; Cloudflare `User-Agent: pi-coding-agent` | `core/provider-attribution.ts:36-65`, merged at `sdk.ts:354 transformHeaders` | every request to those providers | `PI_TELEMETRY=0` / `enableInstallTelemetry:false` (an Acabox-branded OpenRouter attribution would need its own headers) |
| opencode session headers `x-opencode-session`, `x-opencode-client: pi` | `provider-attribution.ts:67-77` | opencode provider only | n/a |
| OAuth sign-in flows (user-initiated): `auth.openai.com`, `chatgpt.com/backend-api`, `api.openai.com/auth`, `claude.ai/oauth/authorize` + `platform.claude.com/v1/oauth/token`, `openrouter.ai/auth`, `auth.x.ai`, `auth.meta.com`, `auth.kimi.com`, GitHub Copilot device flow | `pi-ai/src/auth/oauth/*.ts` | only via `modelRuntime.login(...)` | n/a |
User-Agent for pi.dev calls: `pi/<version> (<platform>; node/<version>; <arch>)` (`utils/pi-user-agent.ts`).

**`PI_OFFLINE` does not block model-provider traffic**: run D (shell `GEMINI_API_KEY` leaked, `PI_OFFLINE=1`) still sent the prompt to Google and received `401 API key not valid`, retrying 3× (events `message_start/message_end` ×3) before `stopReason: "error"`. The CLI's `--offline` also sets `PI_SKIP_VERSION_CHECK` (`main.ts:579-583`); the SDK path does not, so set both.

Also note: `docs/sdk.md:116` — "SDK sessions do not [load] codemode, tool_search, and MCP"; measured default tools are exactly `["read","bash","edit","write"]`.

## 5. Measurements

### (a) Offline init, no credentials
Script `scripts/a-offline-init.mjs` (import via `file://` URL, `createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) })`).

| run | entry | env | import | createAgentSession | files created in scratch agent dir | ~/.pi | network |
|---|---|---|---|---|---|---|---|
| 1 | unbundled `dist/index.js` | `PI_CODING_AGENT_DIR` env, OFFLINE | 251 ms, 156 exports | 14 ms | `auth.json` (2 B), `models-store.json` (2 B) | mtime unchanged, `agent/` absent | 0 |
| 2 | unbundled | `agentDir` **option only** | 224 ms | 15 ms | same two files | unchanged (but `getAgentDir()` = `~/.pi/agent`) | 0 |
| 3 | unbundled | env, **PI_OFFLINE unset** | 224 ms | 10 ms | same | unchanged | **0** |
| 4 | `dist/bundle/index.js` | env, OFFLINE | **100 ms** | 12 ms | same | unchanged | 0 |
| D2 | relocated bundle copy, `env -i` | rebranded env | 121 ms | 13 ms (persistent SessionManager → also `sessions/<encoded cwd>/`) | | unchanged | 0 |

Clean-env result (D2, the real "no credentials" case): `session.model` = `unknown/unknown`, `modelFallbackMessage` = `"No models available. Use /login to log into a provider via OAuth or API key. See:\n  <packageDir>/docs/providers.md\n  <packageDir>/docs/models.md"`, `await modelRuntime.getAvailable()` → 0 models, `hasConfiguredAuth("anthropic"|"openai"|"openai-codex"|"openrouter")` all false, `getActiveToolNames()` = `["read","bash","edit","write"]`, `extensionsResult.extensions` = 0, `prompt("Reply with OK")` **rejects** with `No API key found for the selected model.\n\nUse /login …` and emits no events. (In runs 1–4/D/E the leaked `GEMINI_API_KEY` made the default model `google/gemini-3.1-pro-preview` and `getAvailable()` 22 models — not a credential-less result.) `modelRuntime.getProviders()` lists 42 built-in provider ids: `amazon-bedrock, ant-ling, anthropic, azure, baseten, cerebras, cloudflare-ai-gateway, cloudflare-workers-ai, deepseek, fireworks, github-copilot, google, google-vertex, groq, huggingface, kimi-coding, meta, minimax, minimax-cn, mistral, moonshotai, moonshotai-cn, nvidia, openai, openai-codex, opencode, opencode-go, openrouter, qwen-token-plan, qwen-token-plan-cn, qwen-token-plan-individual, radius, together, typesafe, vercel-ai-gateway, xai, xiaomi, xiaomi-token-plan-ams, xiaomi-token-plan-cn, xiaomi-token-plan-sgp, zai, zai-coding-cn`.

`session.systemPrompt` length 3,185; first 1,500 chars (run1):
```
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- You can inspect PI_* environment variables for current model and session details.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>

<docs>
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /private
```
The `<docs>` block points at `getDocsPath()` = `<packageDir>/docs/...` and the prompt ends with `<project_context>…<cwd>…</cwd>`. Ship `docs/` (2.8 MB) or replace the prompt (`DefaultResourceLoader({ systemPrompt })`, measured in run G: the override becomes the preamble, `<addendum>` + context files are still appended).

`dispose()` took 0 ms; the process exited by itself (only a transient `FSReqPromise` in `process.getActiveResourcesInfo()`).

### (b) Custom tools (run B, `scripts/b-custom-tools.mjs`)
Both registration paths work and both appear in `getActiveToolNames()`:
- extension factory: `new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [{ name: "acabox-host-tools", factory: (pi) => pi.registerTool({...}) }, (pi) => …] }); await loader.reload(); createAgentSession({ resourceLoader: loader, … })` → `extensionsResult.extensions = [{"path":"<inline:acabox-host-tools>","tools":["acabox_ext_tool"]},{"path":"<inline:2>","tools":["acabox_anon_ext_tool"]}]`.
- `customTools: [toolDef]` option.
- Result: `["read","bash","edit","write","acabox_ext_tool","acabox_anon_ext_tool","acabox_custom_tool"]` in 15 ms; `promptSnippet` lines land in the system prompt (`- acabox_custom_tool: acabox_custom_tool: echoes input`).
- `tools: ["read", "acabox_*"]` (glob allowlist) → `["read","acabox_ext_tool","acabox_anon_ext_tool","acabox_custom_tool"]`; `noTools: "builtin"` → only the three custom tools.
- The registered tool object (`session.agent.state.tools`) has keys `name,label,description,parameters,outputSchema,constrainedSampling,prepareArguments,executionMode,execute`; direct `execute("call-1", {input:"hi"}, signal, onUpdate)` returned `{"content":[{"type":"text","text":"echo:hi"}],"details":{}}`.

Contracts (`SRC/coding-agent/src/core/extensions/types.ts`):
```ts
// 579-609
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	name: string; label: string; description: string;
	promptSnippet?: string; promptGuidelines?: string[];
	parameters: TParams;                       // TypeBox schema (Type from "typebox"; re-exported by @earendil-works/pi-ai: `export { Type } from "typebox"`)
	constrainedSampling?: false | ConstrainedSamplingConfig;
	renderShell?: "default" | "self";
	prepareArguments?: (args: unknown) => Static<TParams>;
	outputSchema?: TSchema;
	exposure?: ToolExposure;
	// execute(toolCallId, params, signal, onUpdate, ctx) => { content: [...], details }   (measured call shape)
}
// 2045-2057
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
export type InlineExtension = ExtensionFactory | { name: string; factory: ExtensionFactory; hidden?: boolean; /* replaceable?, builtin? per docs/sdk.md:112 */ };
// 1671-1673
registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;
```
`CreateAgentSessionOptions` (`sdk.ts` 48–107): `cwd?, agentDir?, modelRuntime?: ModelRuntime, model?: Model<any>, thinkingLevel?: ThinkingLevel, scopedModels?, noTools?: "all" | "builtin", tools?: string[] (allowlist with `*`, or a list of only `+name`/`-name` modifiers), excludeTools?: string[], customTools?: ToolDefinition[], resourceLoader?: ResourceLoader, sessionManager?: SessionManager, settingsManager?: SettingsManager, sessionStartEvent?`. Result `{ session: AgentSession; extensionsResult: LoadExtensionsResult; modelFallbackMessage?: string }`. `DefaultResourceLoaderOptions` (`resource-loader.ts` 276–312): `cwd, agentDir, settingsManager?, eventBus?, additionalExtensionPaths?, additionalSkillPaths?, additionalPromptTemplatePaths?, additionalThemePaths?, extensionFactories?: InlineExtension[], noExtensions?, disabledBuiltinExtensions?, noSkills?, noPromptTemplates?, noThemes?, noContextFiles?, systemPrompt?, appendSystemPrompt?: string[], extensionsOverride?, skillsOverride?, promptsOverride?, themesOverride?, agentsFilesOverride?, systemPromptOverride?, appendSystemPromptOverride?`. `AgentSession` (d.ts): `subscribe(listener): () => void`, `dispose()`, `get model(): Model|undefined`, `get thinkingLevel()`, `get isStreaming()`, `get systemPrompt(): string`, `getActiveToolNames(): string[]`, `get messages()`, `prompt(text, options?)`, `abort()`, `waitForIdle()`, `setModel(model, options?)`, `bindExtensions(bindings)`, `get modelRuntime()`, `sessionManager`, `settingsManager`. `ModelRuntime` (d.ts): `static create(options?: CreateModelRuntimeOptions)`, `getProviders()`, `getModel(providerId, modelId)`, `getAvailable(providerId?, options?): Promise<readonly Model[]>` (async!), `hasConfiguredAuth(providerId)`, `login(providerId, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>`, `logout(providerId, options?)`, `refresh(options?: ModelsRefreshOptions)`, `setRuntimeApiKey(providerId, apiKey, options?)`. `CreateModelRuntimeOptions`: `credentials?: CredentialStore, authPath?, modelsPath?: string|null, modelsStore?, modelsStorePath?, allowModelNetwork? (default false), modelRefreshTimeoutMs?, catalogBaseUrl?, signal?, refreshOnCreate?`. `ModelsRefreshOptions`: `allowNetwork?, providers?: readonly string[], force?, signal?`. `AuthInteraction` (`pi-ai/dist/auth/types.d.ts:157-161`): `{ signal?: AbortSignal; prompt(prompt: AuthPrompt): Promise<string>; notify(event: AuthEvent): void }`. The ChatGPT/Codex OAuth flow uses a loopback callback `localhost:1455/auth/callback` (`pi-ai/src/auth/oauth/openai-codex.ts:26`, `port: 1455` at :368).

### (c) Bundling with webpack — FAILS; alternatives measured
Config shape = Acabox's (`target: 'node'`, production, `minimize:false`, `resolve.modules` pointing at `PKG`), entry imports `createAgentSession, SessionManager` by bare specifier. Build "succeeds" (8.1 MB main + 36 async chunks; single-file variant via `LimitChunkCountPlugin({maxChunks:1})` = 16,073,232 B) with 13 warnings: `Can't resolve 'kerberos'|'bufferutil'|'utf-8-validate'|'supports-color'` (optional), 8× `Critical dependency: the request of a dependency is an expression` at `pi-ai/dist/env-api-keys.js:13`, `pi-ai/dist/auth/context.js:10`, `pi-ai/dist/auth/oauth/load.js:17`, `pi-ai/dist/api/bedrock-converse-stream.lazy.js:18`, `pi-coding-agent/dist/core/extensions/loader.js:51`, `pi-codemode/dist/runtime/host.js:6`, `jiti/lib/jiti*.mjs`, `ws`, `debug`, plus `'import.meta' cannot be used as a standalone expression` at `pi-coding-agent/dist/utils/image-resize.js:68`.

Running either output under Electron node dies immediately:
```
Error: Cannot find module 'node:fs'   (webpackEmptyAsyncContext, pi-bundle.js:138211 / :185169)
```
Root cause (READ): `pi-ai/dist/env-api-keys.js:13-16`
```js
const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));
const NODE_FS_SPECIFIER = "node:" + "fs";
```
— PI deliberately hides Node builtins behind variable `import()` "so browser bundlers do not try to resolve node builtins" (`auth/context.js:9`); webpack turns every such import into an empty async context. The same mechanism is used by **all 11 OAuth flows** (`auth/oauth/load.js:15-18` `importOAuthModule`), the Bedrock and Google lazy loaders, `import.meta.resolve` in the extension loader, and the worker URLs. Fixing it means re-implementing PI's own build (`build-coding-agent-bundle.mjs` lazy entry points and plugins). Second, independent problem: webpack replaced `import.meta.url` with 17 baked `"file:///private/tmp/…/pi-pkg/node_modules/@earendil-works/pi-…"` strings, so `getPackageDir()`, `createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")`, `new URL("./image-resize-worker.js", import.meta.url)` and `new URL("./worker.js", import.meta.url)` (codemode) would all point at the build machine. **Verdict: do not webpack-bundle the SDK.**

**Alternative A (recommended, measured end to end): ship PI's own esbuild bundle, relocated.** Layout built at `ship/pi/`:
```
pi/package.json                 {"name":"@earendil-works/pi-coding-agent","version":"1.2.0","type":"module","piConfig":{"name":"acabox","configDir":".acabox-pi"}}
pi/dist/bundle/**               8.9 MB (index.js, cli.js, cli-runtime.js, rpc-entry.js, chunks/)
pi/node_modules/@silvia-odwyer/photon-node   2.2 MB (incl. photon_rs_bg.wasm)
pi/node_modules/jiti            1.7 MB
pi/node_modules/quickjs-wasi    1.5 MB (incl. quickjs.wasm)
= 14 MB total (du -sh)
```
Measured from that copy: import 115–130 ms, `createAgentSession` 12–20 ms, `createRequire(bundleUrl).resolve("quickjs-wasi/quickjs.wasm" | "@silvia-odwyer/photon-node" | "jiti")` all resolve inside `<ship>/node_modules`, `image-resize-worker.js` and `codemode-worker.js` present next to the chunks, `VERSION`/`CONFIG_DIR_NAME`/`APP_NAME` read from the shipped `package.json`, `cli.js --version` → `1.2.0`, `rpc-entry.js` works (§5h). `typebox` is NOT needed: a `.ts` extension that `import { Type } from "typebox"` loaded fine without it (run F1) because the bundled build takes the `usesEmbeddedModules = isBunBinary || isNodeSeaBinary || isBundledNode` branch (`chunk-TJXZSVTD.js`, `core/extensions/loader.js`) which serves `@earendil-works/*`/`typebox` from `virtual-modules-GI6FRNLG.js`; the unguarded `require.resolve("typebox")` lives only in `getAliases()`, the unbundled branch. Dropping `"type":"module"` from the shipped `package.json` still works but prints `[MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of …/dist/bundle/index.js is not specified and it doesn't parse as CommonJS` (run J1) — keep it. Integration pattern from a webpack-built CJS agent server, measured (run C3): `const sdk = await import(/* webpackIgnore: true */ pathToFileURL(join(piDir, "dist/bundle/index.js")).href);` compiled to a native `import()` and loaded PI 1.2.0.

**Alternative B: ship `node_modules/@earendil-works/*` unbundled** (extraResource or `asar.unpack`, same shape as Acabox's `nativeModuleRoots` copy): `du -sh PKG` = **148 MB** (top: `@earendil-works` 36 M, `openai` 27 M, `@anthropic-ai` 14 M, `@google` 11 M, `web-streams-polyfill` 8.7 M, `@smithy` 7.4 M, `@aws-sdk` 6.7 M, `typebox` 5.8 M, `lru-cache` 3.5 M, `protobufjs` 3.1 M, `highlight.js` 2.6 M, `@types` 2.6 M, `undici` 2.3 M). Prunable without touching code paths: `*.map` 12 MB, `*.d.ts` 2.7 MB, `@types` 2.6 MB, `pi-coding-agent/docs` 2.8 MB, `examples` 1.3 MB, `CHANGELOG.md` 624 KB, `schemas` 92 KB, `dist/bun` 64 KB, `dist/bundle` 8.9 MB (if not used) → ≈117 MB. **Not prunable: `pi-tui`** (2.8 MB; `dist/index.js:42` exports the TUI components, so it loads at import) and the provider SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime` are statically imported by `pi-ai/dist/api/*.js`, which `pi-ai/dist/compat.js` loads lazily per provider — missing packages would only fail when that provider is selected; INFERRED, not measured). Import of this entry is 2.2× slower (224–251 ms vs 100–130 ms).

**Alternative C: PI's RPC subprocess** (`exports["./rpc-entry"]` → `dist/bundle/rpc-entry.js`, `docs/rpc.md`): JSONL commands on stdin, `response`/event records on stdout, stderr for diagnostics. Measured from the relocated copy under Electron node (`rpc-entry.js --offline --no-session`, run H): first `{"id":"1","type":"get_state"}` answered after 212 ms with `data` keys `model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionId, autoCompactionEnabled, messageCount, pendingMessageCount`; nothing on stderr; closing stdin → exit code 0 within the 8 s window; wrote only `auth.json`/`models-store.json`. Note `rpc-entry.js` sets `process.title = "<APP_NAME>-rpc"`, `process.env.PI_CODING_AGENT="true"`, `AI_AGENT="pi"`, replaces `process.emitWarning` with a no-op and calls `configureHttpDispatcher()` (undici global dispatcher) in that child.

### (d) TTY / stdin
No. Every run used `stdin=/dev/null` and piped stdout; `process.stdin.isTTY` and `process.stdout.isTTY` were `undefined`; stdin listener count stayed 0 (`data`/`readable`); `isTTY` is referenced only in `package-manager-cli.js`, `main.js`, `modes/interactive/interactive-mode.js`, `extensions/mcp/cli.js` (CLI paths) and `setRawMode` only in the TUI chunk; `process.stdin` is read by `modes/rpc/rpc-mode.js`, `modes/interactive`, `main.js`, `migrations.js`, `package-manager-cli.js`, `extensions/mcp/cli.js` — none on the SDK path.

### (e) Node 22.17 (Electron) vs engines >=22.19
- The bump: `CHANGELOG.md:2063-2067` "## [0.75.0] - 2026-05-17 / Breaking Changes / Raised the minimum supported Node.js version to 22.19.0." — no reason recorded; the clone is a single squashed commit, so git history gives none. No PI issue/commit found that names a 22.18/22.19 API.
- Probe on Electron's Node (`process.versions.node 22.17.0`, V8 `13.8.500258-electron.0`): `Promise.try` function, `Error.isError` function, `fs.globSync` function, `process.features.require_module` true, `process.features.typescript` false, `module.enableCompileCache` function, `module.findPackageJSON` function, `util.diff` function, `zlib.zstdCompressSync` function, `process.execve` function; **`require('node:sqlite')` → `ERR_INVALID_MODULE: No such binding: sqlite`** (Electron builds without it).
- Greps of `dist/` (unbundled + bundle): `node:sqlite` appears once, in undici's `runtime-features.js` lazy probe (`detectRuntimeFeatureByNodeModule`), which rethrows any error other than `ERR_UNKNOWN_BUILTIN_MODULE`/`ERR_NO_CRYPTO` — so in Electron it would throw, but `runtimeFeatures.has("sqlite")` has **0 callers** in the bundle (only `has("crypto")` is used); `Error.isError` 0, `Promise.try` 0, `fs.glob`/`globSync` 0, `import.meta.dirname/filename` 0; `require(esm)` is used once, by the `cli.js` launcher (`createRequire(import.meta.url)("./cli-runtime.js")`) and works on 22.17 (`cli.js --version` → `1.2.0`); esbuild `target: node22.19` only affects syntax lowering. `.ts` extensions do not rely on Node's native type stripping (jiti transforms them; run F1).
- Every script in this report ran on 22.17.0 without error. Conclusion: no measured incompatibility for the SDK/RPC paths; the gate is declarative.

## 6. Process-level side effects (MEASURED unless marked)
- **Signal handlers are installed at import time**, not at session creation: `SIGINT/SIGTERM/SIGHUP` listener counts went 0→1 on `import()` and stayed at 1 after `createAgentSession` and `dispose` (run K). Listener source contains `processOk(global.process)…listeners.length===emitter.count&&(unload(),emit("exit",null,sig),…process.kill(…)` = `signal-exit` 3.0.7, pulled by `proper-lockfile` 4.1.2 (`lib/lockfile.js:331 onExit(() => {…})` at module scope) which `dist/core/auth-storage.js:7` imports. Behaviour (signal-exit v3, READ): if its listener is the only one, on a signal it runs lock cleanup, removes itself and re-raises the same signal, so the default disposition is preserved; if the host has its own listener it defers. Same count observed inside a real Electron main process (run E2).
- `process.exit(` exists only in CLI/mode files (`main.js`, `modes/*`, `cli/*`, `package-manager-cli.js`, `core/output-guard.js`, `core/model-resolver.js`); none fired in any SDK run. `process.on("exit")` is installed only by pi-mcp's stdio transport when the first MCP server is spawned (`pi-mcp/dist/transports/stdio.js:12-46,82-88`: children spawned `detached: USE_PROCESS_GROUPS` where `USE_PROCESS_GROUPS = process.platform !== "win32"`, and on exit `process.kill(-pid, "SIGTERM")` per tracked group — scoped to those groups, not Acabox's).
- `process.chdir`: never called in the SDK path (`cwd changed=false`); the two occurrences in the bundle are cross-spawn's command resolution (temporary chdir to `options.cwd` while running `which`, `chunk-WJUNYZC5.js`) and graceful-fs's `process.cwd` memoisation/`process.chdir` wrapper installed at load (`chunk-5GTPJSRI.js`, via proper-lockfile) — INFERRED from the bundled source that importing the SDK therefore wraps `process.cwd`/`process.chdir` globally.
- `fs.readFileSync` is monkey-patched only while `@silvia-odwyer/photon-node` is first imported, then restored (`dist/utils/photon.js:41-93,105-118`); photon runs in a `worker_threads` Worker normally (`utils/image-resize.js:11-12,67-80`, falls back in-process).
- `setDefaultStreamFn(streamSimple)` (pi-agent-core global) runs at module load (`sdk.ts:46`).
- NOT done on the SDK path (measured): `process.title` unchanged, no env keys added, `process.emitWarning` untouched, `globalThis.fetch` untouched, no undici global dispatcher (`configureHttpDispatcher()` is only called by `cli/setup.ts:12`, `main.ts:598`, `rpc-entry.js`), nothing printed to stdout/stderr (stderr empty in every run), event loop drains after `dispose()`.
- Inside a real Electron main process (run E2, `env -i`, `--no-sandbox --use-mock-keychain`, dock hidden): import 130 ms, `createAgentSession` 14 ms, same listeners, same two files, `~/.acabox-pi` not created. But there `globalThis.fetch` is Electron's main-process fetch (`function fetch(input, init = undefined) { // eslint-disable-line func-name-match`, i.e. the `net`-backed implementation), so PI's providers would run through Chromium's network stack and PI's undici idle-timeout/proxy configuration would not apply. Together with the signal handlers and the global fs/cwd wrappers, this argues for keeping PI in the existing child-process agent server rather than in main.
- Memory: RSS 120 MB after import + session (heapUsed 19 MB) vs 61 MB for a bare Electron-as-node process → ≈59 MB attributable to PI (run G vs baseline).

## 7. Project resources, trust and context files (MEASURED)
- `SettingsManager.create(cwd, agentDir, options)` defaults `projectTrusted = options.projectTrusted ?? true` (`dist/core/settings-manager.js:223-248`); `createAgentSession` calls it without options (`sdk.ts:200`), so **the SDK treats the cwd as trusted by default** (`docs/configuration.md:3` says project config "loads after project trust is granted" — in the SDK it is granted implicitly; code wins). Measured (run G3, project dir `<cwd>/<CONFIG_DIR_NAME>` = `.acabox-pi` after the rebrand; with the stock package it is `.pi`): default/`projectTrusted:true` → `.acabox-pi/extensions/proj.ts` executed in-process (`tools = ["read","bash","project_ext_tool"]`), `.acabox-pi/settings.json {"defaultTools":["read","bash"]}` applied, `.acabox-pi/APPEND_SYSTEM.md` and `.acabox-pi/skills/demo/SKILL.md` in the prompt, `hasTrustRequiringProjectResources(cwd) = true`; `SettingsManager.create(cwd, agentDir, { projectTrusted: false })` → none of those, tools back to the four builtins, no `trust.json` written. Since the Acabox workspace is agent-writable, the default would let an agent plant `<workspace>/.pi/extensions/x.ts` and have it run in the host process on the next session — pass `projectTrusted: false` (or `noExtensions`/host-only `additionalExtensionPaths`).
- Context files load **without** trust: `<cwd>/CLAUDE.md` appeared in the prompt as `<project_context><project_instructions path="…/CLAUDE.md">…` with `projectTrusted:false` (run J2); `<cwd>/sub/AGENTS.md` (below cwd) did not; `<agentDir>/AGENTS.md` and `<agentDir>/APPEND_SYSTEM.md` are loaded (run G). So Acabox's existing workspace `CLAUDE.md` reaches the agent automatically; `DefaultResourceLoader({ noContextFiles: true })` disables it.
- `DefaultResourceLoader.reload({ resolveProjectTrust })` exists (`resource-loader.js:362-365`) for an explicit decision; persisted trust goes through `ProjectTrustStore` (`get/getEntry/set/setMany`) at `<agentDir>/trust.json`.
- File extension cost: one `.ts` extension via jiti raised `createAgentSession` from 13 ms to 64–65 ms (runs F1/F2).

## 8. Packaging recommendation
1. Add a build step (like `scripts/build-cobuilding-prestart.js`) that assembles `build/pi/` from `node_modules`: `@earendil-works/pi-coding-agent/dist/bundle/**`, `node_modules/{@silvia-odwyer/photon-node,jiti,quickjs-wasi}` (copy, no symlinks), optional `docs/` (2.8 MB, referenced by the default prompt), and a hand-written `package.json` with `"type":"module"`, `name`, `version` (= the installed `pi-coding-agent` version, drives `VERSION` and the install-change detector `detectInstallChange` at `config.js:441-455`) and, if wanted, `piConfig: { name, configDir }` to rebrand the env var (`<NAME>_CODING_AGENT_DIR`) and the project dir name. Ship it with `extraResource: ['build/pi', …]` next to `dist/agent-server.js` (forge.config.js:114). Footprint 14 MB (17 MB with docs). Keep it outside asar (workers, wasm and jiti use real fs paths; loading from inside `app.asar` was not measured); `plugin-auto-unpack-natives`/`asar.unpack` need no change because the set contains no `.node` files. `codesign --deep` will sign the `.js`/`.wasm` payload like any Resources file (INFERRED, not measured).
2. In the agent server (webpack CJS, spawned with `ELECTRON_RUN_AS_NODE=1`): `const sdk = await import(/* webpackIgnore: true */ pathToFileURL(join(process.resourcesPath, 'pi/dist/bundle/index.js')).href)` (dev: point at `node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js`). Measured working (run C3).
3. Child env (`buildSubprocessEnv()` / `AgentInfrastructureController`): set `PI_CODING_AGENT_DIR=<userData>/<channel>/pi-agent` (rebranded name if `piConfig.name` is set), `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, optionally `PI_PACKAGE_DIR=<Resources>/pi`, `JITI_CACHE=<userData>/…` (INFERRED knob), and strip the 43 provider key variables unless deliberately forwarded; also pass `agentDir` and `SettingsManager.create(cwd, agentDir, { projectTrusted: false })` plus `sessionManager: SessionManager.create(cwd, <userData>/…/pi-sessions)` to `createAgentSession`. Pass credentials through `ModelRuntime.create({ authPath, modelsPath })` + `setRuntimeApiKey(providerId, key)` or `login(providerId, "oauth", interaction)` (ChatGPT/Codex flow needs loopback port 1455 reachable and a browser hand-off through `interaction.prompt/notify`).
4. Model catalog refreshes (`pi.dev/api/models/providers/<id>`) are opt-in via `modelRuntime.refresh({ allowNetwork: true })` — this is the mechanism for a "wider roster without an app update", and it is off unless called.
5. Alternative worth keeping in view: drive `dist/bundle/rpc-entry.js` as the child instead of writing an SSE wrapper around the SDK (§5c-C) — but it sets process markers, `process.title`, swallows warnings and installs the undici dispatcher in that child, and its tool/extension registration is file-based rather than in-process factories.

## 9. Docs vs code discrepancies found
- `docs/environment-variables.md:81` names the override `PI_CODING_AGENT_DIR`; the real name is `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` (`config.ts:585`) and changes with `piConfig.name` (measured).
- `docs/environment-variables.md:82` `PI_CODING_AGENT_SESSION_DIR` "Override session storage" — honoured by the CLI only (`main.ts:691`); `createAgentSession` ignores it.
- `docs/configuration.md:3` "project configuration … loads after project trust is granted" — the SDK grants it by default (`settings-manager.js:238`).
- `docs/environment-variables.md:86` describes `PI_TELEMETRY` as "install/update telemetry and provider attribution headers" — accurate; the default of the underlying setting is `true` (`settings-defaults.ts:32`), which the docs do not say.
- `docs/environment-variables.md:18` "[markers] are not set automatically when Pi is embedded through the SDK" — measured true.

## KEY FACTS
- The package's public SDK entry is the UNBUNDLED tsc output, while the self-contained esbuild bundle (dist/bundle/index.js) is not exported and must be imported by file URL.
  - evidence: /private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-pkg/node_modules/@earendil-works/pi-coding-agent/package.json: "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }, "./rpc-entry": { "import": "./dist/bundle/rpc-entry.js" } }; measured: import("@earendil-works/pi-coding-agent/dist/bundle/index.js") -> ERR_PACKAGE_PATH_NOT_EXPORTED, file:// import of the same file -> 156 exports
- The relocated dist/bundle + photon-node + jiti + quickjs-wasi + package.json layout is 14 MB and runs end to end under Electron's Node (import 115-130 ms, createAgentSession 12-20 ms, cli.js --version 1.2.0, rpc-entry answers get_state in 212 ms).
  - evidence: work-pi-packaging-runtime/ship/pi: " 14M .../ship/pi", "8.9M .../ship/pi/dist/bundle", "2.2M .../@silvia-odwyer", "1.7M .../jiti", "1.5M .../quickjs-wasi"; run D2: "[d2] import relocated bundle: 121 ms; VERSION=1.2.0 CONFIG_DIR_NAME=.acabox-pi" and "[d2] createAgentSession (persistent SessionManager): 13 ms"; run H: "[h] get_state response after 212 ms: true"
- Webpack-bundling the SDK compiles but fails at runtime because pi-ai hides Node builtins and OAuth flows behind variable import() specifiers, and webpack bakes build-machine file:// paths for import.meta.url.
  - evidence: run C1/C2 output: "Error: Cannot find module 'node:fs'" from webpackEmptyAsyncContext; source pi-ai/dist/env-api-keys.js:13-14 "const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier)); const NODE_FS_SPECIFIER = \"node:\" + \"fs\";"; bundle residue: 17 occurrences of "file:///private/tmp/claude-501/.../pi-pkg/node_modules/@earendil-works/pi-"
- createAgentSession offline with no credentials makes zero network calls, writes only auth.json and models-store.json (0600) into the agent dir, never touches ~/.pi, and prompt() rejects locally.
  - evidence: run1/run3/run D2 outputs: "[a] network calls observed (0): []", "scratch agent dir tree: auth.json (2B) models-store.json (2B)", "~/.pi mtime ... unchanged=true; ~/.pi/agent existed before=false after=false"; run D2: "[d2] prompt() rejected: No API key found for the selected model." and "[d2] network calls observed (0): []"; ls -l: "-rw-------  auth.json"
- The agent-dir env var name is derived from piConfig.name in the shipped package.json, and PI_CODING_AGENT_SESSION_DIR is honoured only by the CLI, not by createAgentSession.
  - evidence: dist/config.js:476-477 "export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`; export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;" with config.js:491-497 getAgentDir(); grep: ENV_SESSION_DIR used at src/main.ts:691 only; measured run D2: "[d2] getAgentDir() with ACABOX_CODING_AGENT_DIR set = .../rund2/agent-dir"
- Importing the SDK installs SIGINT/SIGTERM/SIGHUP listeners (signal-exit via proper-lockfile) before any session exists; no process.title/env/emitWarning/fetch mutation on the SDK path.
  - evidence: run K: "[k] before import: SIGINT=0 SIGTERM=0 SIGHUP=0" / "[k] after import:  SIGINT=1 SIGTERM=1 SIGHUP=1"; dist/core/auth-storage.js:7 "import lockfile from \"proper-lockfile\";", proper-lockfile/lib/lockfile.js:331 "onExit(() => {"; run1: "process.title before=... after=...; emitWarning replaced=false; globalThis.fetch replaced=false; cwd changed=false" and "env keys added by SDK: []"
- The SDK trusts the project directory by default, executing <cwd>/<configDir>/extensions/*.ts in-process and applying project settings.json; projectTrusted:false disables that while cwd CLAUDE.md context still loads.
  - evidence: dist/core/settings-manager.js:238 "const projectTrusted = options.projectTrusted ?? true;"; run G3: "[g3] projectTrusted=true: tools=[\"read\",\"bash\",\"project_ext_tool\"] APPEND_SYSTEM=true skill=true" vs "[g3] projectTrusted=false: tools=[\"read\",\"bash\",\"edit\",\"write\"] APPEND_SYSTEM=false"; run J2: "[j2] untrusted: CLAUDE.md in cwd loaded=true ... isProjectTrusted=false"
- All PI phone-home endpoints are pi.dev (latest-version, report-install, models catalog, oauth CIMD, installer) and are gated by PI_OFFLINE / PI_SKIP_VERSION_CHECK / PI_TELEMETRY or allowNetwork; install telemetry defaults to enabled in settings.
  - evidence: src/utils/version-check.ts:5 "const LATEST_VERSION_URL = \"https://pi.dev/api/latest-version\";"; src/modes/interactive/interactive-mode.ts:1368 "void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`"; src/core/remote-catalog-provider.ts:14 "const DEFAULT_CATALOG_BASE_URL = \"https://pi.dev\";" and :81 "/api/models/providers/"; src/core/settings-defaults.ts:32 "enableInstallTelemetry: true,"; src/core/model-runtime.ts:247 "process.env.PI_OFFLINE === undefined,"
- PI_OFFLINE does not block provider traffic: with a leaked GEMINI_API_KEY and PI_OFFLINE=1 a prompt still reached Google and got 401 with 3 attempts.
  - evidence: run D output: "[d] last message role=assistant stopReason=error errorMessage=\"{\\\"error\\\":{\\\"message\\\":\\\"{\\n  \\\"error\\\": {\\n    \\\"code\\\": 401,\\n    \\\"message\\\": \\\"API key not valid." and events "message_start","message_end" x3; shell env check: GEMINI_API_KEY present
- Electron 37's Node 22.17 lacks node:sqlite but has Promise.try/Error.isError/fs.globSync/require(esm); PI's only node:sqlite reference is undici's unreached lazy probe, and every measured path ran.
  - evidence: probe output: "22.17.0 37.2.0 13.8.500258-electron.0", "Promise.try function Error.isError function fs.globSync function require(esm) feature true", "node:sqlite ERR_INVALID_MODULE No such binding: sqlite"; grep: has(\"sqlite\") callers = 0 in dist/bundle/chunks; CHANGELOG.md:2063-2067 "## [0.75.0] - 2026-05-17 ... Raised the minimum supported Node.js version to 22.19.0."
- Custom tools register through both DefaultResourceLoader.extensionFactories and the customTools option and appear in getActiveToolNames(); tools glob allowlists and noTools:'builtin' keep them.
  - evidence: run B: "[b] getActiveToolNames() = [\"read\",\"bash\",\"edit\",\"write\",\"acabox_ext_tool\",\"acabox_anon_ext_tool\",\"acabox_custom_tool\"]", "[b2] tools:[\"read\",\"acabox_*\"] -> [\"read\",\"acabox_ext_tool\",\"acabox_anon_ext_tool\",\"acabox_custom_tool\"]", "[b3] noTools:\"builtin\" -> [\"acabox_ext_tool\",\"acabox_anon_ext_tool\",\"acabox_custom_tool\"]"
- A webpack-built CJS agent server can load the shipped bundle at runtime with a webpackIgnore dynamic import.
  - evidence: run C3: "[c3] loaded PI 1.2.0 from a webpack CJS bundle; tools=[\"read\",\"bash\",\"edit\",\"write\"]; agentDir=<run>/agent-dir"; compiled output contains "await import(/* webpackIgnore: true */ (0,node_url__WEBPACK_IMPORTED_MODULE_0__.pathToFileURL)"
- Inside a real Electron main process the bundle imports and creates a session, but globalThis.fetch there is Electron's net-backed fetch, not Node's undici.
  - evidence: run E2 main.log: "[e] import bundle in main: 130 ms, exports=156", "[e] createAgentSession in main: 14 ms ... model=unknown/unknown", "[e] globalThis.fetch is electron net.fetch? function fetch(input, init = undefined) { // eslint-disable-line func-name-match"
- Unbundled node_modules tree is 148 MB; pruning maps/d.ts/@types/docs/examples/CHANGELOG/bun/bundle saves about 31 MB; pi-tui cannot be pruned for the unbundled entry.
  - evidence: du: "148M .../pi-pkg/node_modules"; ".map files ... 12M total", ".d.ts files: 2.7M total", "2.6M @types", "2.8M docs", "1.3M examples", "624K CHANGELOG.md", "64K dist/bun", "8.9M dist/bundle"; dist/index.js:42 exports from "./modes/interactive/components/index.js"

## RISKS
- Runs 1-4, D and E inherited GEMINI_API_KEY from this shell (pi-ai reads it automatically), so their model/availability lines are not credential-less; only the env -i runs (D2, E2, F, G, G2, G3, H, J, K, C3) are. Acabox's child env must scrub the 43 provider variables or PI will silently pick them up.
- PI_OFFLINE gates only pi.dev traffic; provider requests still go out (measured 401 round-trips to Google with PI_OFFLINE=1). The planner must ensure a session never starts on an unusable default model.
- The SDK trusts the cwd by default (settings-manager.js:238): an agent with Write/Bash on the workspace could drop <workspace>/.pi/extensions/x.ts and have it executed in the host process on the next session unless projectTrusted:false is passed.
- Importing the SDK installs signal-exit SIGINT/SIGTERM/SIGHUP listeners and graceful-fs wrappers on process.cwd/process.chdir (the latter INFERRED from bundled source); harmless in a dedicated child, intrusive inside Electron main, where global fetch is also Electron's net stack rather than undici.
- Only createAgentSession's own services honour the agentDir option; MCP OAuth/log/config and keybindings call getAgentDir() directly, so the env var must be set too or those land in ~/.pi/agent (or ~/<configDir>/agent after a rebrand).
- Install telemetry setting defaults to true (settings-defaults.ts:32); without PI_TELEMETRY=0 OpenRouter/NVIDIA/Cloudflare requests carry pi attribution headers (only the TUI sends report-install).
- undici's node:sqlite feature probe would rethrow ERR_INVALID_MODULE under Electron if any code ever called runtimeFeatures.has('sqlite'); today nothing does (0 callers), but a future undici/PI upgrade could change that.
- My first main-process test (run E) set the un-rebranded env var and PI created ~/.acabox-pi/agent/{auth.json,models-store.json} (two 2-byte '{}' files); I verified the contents and removed that directory. ~/.pi was never touched. Any Acabox code that rebrands via piConfig.name must use the derived env var name or it will write to the home directory.
- Loading from inside app.asar was not measured; the recommendation keeps PI under extraResource (outside asar) like dist/agent-server.js. Codesigning of the shipped wasm/js under --deep is inferred, not measured.
- Shipping without docs/ leaves the default system prompt pointing at non-existent <packageDir>/docs paths and the 'No models available' message citing them; replace the prompt or ship docs (2.8 MB).
- jiti writes a transform cache to $TMPDIR/jiti when file-based .ts extensions load; the JITI_CACHE knob is inferred from strings in jiti.cjs, not measured.
- The 0.75.0 engines bump to >=22.19.0 has no recorded rationale; all SDK/RPC paths measured fine on 22.17, but untested paths (e.g. codemode worker, image resize worker, provider streams) were not exercised with real credentials.

## UNKNOWNS
- Why PI 0.75.0 raised engines to >=22.19.0 (CHANGELOG gives no reason; the clone is a single squashed commit, so no history).
- Whether the bundle loads correctly from inside an asar archive (not measured; extraResource recommended).
- Behaviour of a real model turn, codemode worker (quickjs wasm) execution and image-resize worker (photon wasm) under Electron's Node — no credentials were available and these paths were not exercised beyond resolving their files.
- Exact semantics of jiti's JITI_CACHE environment variable for relocating the $TMPDIR/jiti cache (only the string was found in jiti/dist/jiti.cjs).
- Whether Electron's codesign --deep handles the .wasm payload without extra entitlements (inferred from Acabox's existing esbuild/wasm-free Resources; not tested).
- Whether an Acabox-branded OpenRouter attribution (replacing the HTTP-Referer https://pi.dev headers) is possible through the public SDK surface without PI_TELEMETRY=0 (transformHeaders at sdk.ts:354 merges them; an override path was not traced).
- How the SDK behaves when PI_PACKAGE_DIR points at a dir whose package.json lacks piConfig but Acabox wants the project dir renamed (only the combination name+configDir was measured).
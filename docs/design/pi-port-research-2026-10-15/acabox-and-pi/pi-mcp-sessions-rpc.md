# PI 1.2.0 — MCP, sessions, compaction, RPC/JSON modes (reader report for the Acabox PI planner)

Conventions: `CA/` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-src/pi/packages/coding-agent`, `MCP/` = `…/pi/packages/mcp`, `AGENT/` = `…/pi/packages/agent`, `PKG/` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-pkg/node_modules/@earendil-works`. Everything is marked READ (seen in source/docs) unless flagged **INFERRED**. Where a doc and code disagree I say so. No files outside the scratchpad were written; `~/.pi` was not read.

Package facts (READ `PKG/pi-coding-agent/package.json`): `"type": "module"`, `"engines": {"node": ">=22.19.0"}`, `"bin": {"pi": "dist/bundle/cli.js"}`, `"exports": { ".": {...}, "./rpc-entry": {"import": "./dist/bundle/rpc-entry.js"} }` — **only two subpaths are exported**; any deep import such as `@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js` is refused by Node's exports map (standard Node behaviour, **INFERRED** consequence; importing by absolute `file://` path bypasses the map). `pi-mcp` exports `.`, `./oauth`, `./testing`. Installed sizes: pi-coding-agent 25 MB (dist 20 MB, of which `dist/bundle` 8.9 MB in 76 chunks), pi-ai 6.4 MB, pi-mcp 564 KB, pi-tui 2.8 MB, whole `node_modules` 148 MB / 77 packages.

Environment variables (READ `CA/docs/environment-variables.md:79-82`, `CA/src/config.ts:584-611`): `PI_CODING_AGENT_DIR` overrides the agent dir (default `~/.pi/agent`); `PI_CODING_AGENT_SESSION_DIR` overrides session storage (beaten by `--session-dir`); names are derived as `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` (config.ts:585), so a rebranded fork (`piConfig.name`) changes them. The planner's assumption `PI_CODING_AGENT_DIR` is confirmed. Files under the agent dir: `mcp.json`, `mcp-auth.json`, `mcp.log`, `auth.json`, `models.json`, `settings.json`, `sessions/`, lock files `mcp-auth-refresh-<hash>`.

---

## 1. MCP

### 1.1 Config schema (verbatim, `CA/src/core/mcp-servers.ts`)

```ts
// :52
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
// :59-78
interface McpServerConfigBase {
	exposure?: McpExposure;                      // Default: `codemode`
	description?: string;
	toolExposure?: Record<string, McpExposure>;  // exact names win over `*` patterns; first pattern wins
	enabled?: boolean;                           // Default: true
	timeout?: number;                            // per-request seconds, progress resets it, Default: 60
}
// :80-88
export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;   // values may be `${NAME}` or `!cmd`
	cwd?: string;                   // relative resolves against the session working directory
}
// :91-126
export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;          // may be `${NAME}` or `!cmd`
	callbackPort?: number;          // redirect URI http://127.0.0.1:<port>/callback
	callbackUrl?: string;           // http on localhost|127.0.0.1|[::1]; port added if absent (RFC 8252)
	scope?: string;
	clientName?: string;            // DCR client_name, default `pi`
	clientRegistration?: "dcr" | "cimd";
	authServerMetadataUrl?: string; // https (or loopback http), trusted as configured
}
// :137-150
export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
	auth?: { provider: string };    // send a pi provider's (/login) token; not allowed in project mcp.json
}
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
```

Validation (`validateMcpServerConfig`, :248-305): server name `/^[A-Za-z0-9_-]+$/` (:152); `type === "sse"` → `legacy SSE transport is not supported; use the streamable HTTP URL` (:270); `url` must be http/https (:273); `type` may be `stdio`, `http`, `streamable-http` (:272,292); alias `codemode-deferred` → `codemode` (:57). `mcpNamespace(server) = "mcp__" + server.replace(/-/g,"_")` (:155-157); names differing only in `-`/`_` collide (`config.ts:127-132`).

Files (`CA/src/extensions/mcp/config.ts:145-156`): global `<agentDir>/mcp.json`, project `<cwd>/.pi/mcp.json` only when the project is trusted; top-level `{ "mcpServers": {...}, "autoEnableCodemode"?: boolean }`. A project entry with none of `command|url|type` is an override of only `enabled|exposure|toolExposure` (:74-79,108-120). Project `auth` is rejected (:133-136). Entry shape after loading:

```ts
// config.ts:51-72
export interface McpServerEntry { name: string; config: McpServerConfig; source: string; scope?: "global" | "project" | "extension"; override?: string; }
export interface LoadedMcpConfig { servers: McpServerEntry[]; autoEnableCodemode?: boolean; errors: string[]; projectConfig?: string; }
```

### 1.2 Programmatic registration (three routes)

**(a) Extension API** (`CA/src/core/extensions/types.ts:1894-1900`): `registerMcpServer(name: string, config: McpServerConfig): void;` `unregisterMcpServer(name: string): void;` `getMcpServers(): RegisteredMcpServer[];`. Registry `McpServerRegistry` (`mcp-servers.ts:316-346`) with `register/unregister/get/list/setChangeListener`; a change after binding fires the `mcp_servers_change` event (`types.ts:744-748`) which the built-in MCP extension handles (index.ts:1217-1250): removed/re-registered servers are closed and their tools hidden, new ones connect immediately. Registrations are not persisted (doc `extensions.md:204`); an `mcp.json` server of the same namespace overrides a registration (index.ts:345-362). Over **RPC there is no command** to register a server or tool (the `RpcCommand` union, §4.2, has none).

**(b) `createMcpExtension(options)`** (`CA/src/extensions/mcp/index.ts:69-91,279`) — exported from the package root (`CA/src/index.ts:413`):

```ts
export interface McpExtensionOptions {
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;   // default: mcp.json global + trusted project
	createTransport?: McpTransportFactory;                     // default: stdio / streamable HTTP from config
	credentials?: McpOAuthCredentialStore;                     // default: <agentDir>/mcp-auth.json
	logPath?: string;                                          // default <agentDir>/mcp.log
	openUrl?: (url: string) => void;                           // default platform browser
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;  // where /mcp saves enabled/exposure
	startupWaitMs?: number;                                    // default 10000
}
// runtime.ts:59-63
export type McpTransportFactory = (entry: McpServerEntry, cwd: string, authProvider: AuthProvider | undefined) => McpTransport;
```

`loadConfig` lets a host supply connectors from its own store (no `mcp.json`); the test harness does exactly that (`CA/test/suite/agent-session-mcp.test.ts:186-194`): `createMcpExtension({ loadConfig: () => ({ servers: [entry], errors: [] }), createTransport: () => { const pair = createFakeServer(...); void pair.server.start(); return pair.client; } })`. SDK wiring (`CA/docs/sdk.md:116`, `CA/examples/sdk/14-codemode-mcp.ts:26-50`): add `createCodemodeExtension()`, `createToolSearchExtension()`, `createMcpExtension()` to `DefaultResourceLoader({ extensionFactories })`, then `await session.bindExtensions({})` — "The MCP extension connects its servers on `session_start`, so call `session.bindExtensions()`".

**(c) The `pi mcp` CLI** (`CA/src/extensions/mcp/cli.ts:33-73,185-260`): `add <server> [--local] [--url …|-- cmd args] [--env K=V] [--cwd] [--header K=V] [--bearer-token-env-var NAME] [--oauth-client-id|--oauth-client-secret|--oauth-callback-port|--oauth-client-name] [--exposure] [--description]`, `remove <server> [-l]`, `list [--json]` (connects every enabled server; exit 1 on any failure), `login <server> [--timeout <s>]` (default 300 s, :77), `logout <server>`. Shell commands do not load extensions (`mcp.md:92`).

### 1.3 Transports (`MCP/src/transports/`)

```ts
// transport.ts:18-26
export interface McpTransport {
	start(): Promise<void>;
	send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void>;
	close(): Promise<void>;
	onMessage(listener: McpTransportMessageListener): () => void;
	onError(listener: McpTransportErrorListener): () => void;
	onClose(listener: McpTransportCloseListener): () => void;
	setProtocolVersion?(version: string): void;
}
```

- **StdioTransport** (`stdio.ts:55-67` options: `command, args?, cwd?, env?, inheritEnv?, stderr?: "pipe"|"inherit", onStderr?, maxMessageBytes?, maxStderrBytes?, closeTimeoutMs?`). Spawn (:94-102): `const env = this.options.inheritEnv === false ? { ...this.options.env } : { ...process.env, ...this.options.env };` via `cross-spawn`, `detached: true` on non-Windows (own process group). **The default factory never sets `inheritEnv`** (`runtime.ts:115-121`: `new StdioTransport({ command: expandHome(config.command), args, cwd: resolve(cwd, expandHome(config.cwd ?? ".")), env, stderr: "pipe" })`), so a PI-spawned stdio server inherits PI's whole environment plus the configured `env`. `cwd` defaults to the session cwd. Close (:152-179): stdin end → 500 ms grace → SIGTERM to the process group → +2000 ms → SIGKILL; an `exit` hook SIGTERMs live groups (:43-53). Stderr tail kept (64 KB, :7); last 2000 chars shown on failure (`runtime.ts:49,401`). Messages > 16 MiB rejected (`transport.ts:3`).
- **StreamableHttpTransport** (`streamable-http.ts:120-130` options: `url, headers?, fetch?, openGetStream? (default true), maxMessageBytes?, authProvider?, reconnect?: {initialDelayMs 1000, maxDelayMs 30000, maxRetries 5}`). POST per message with `Mcp-Session-Id`, `MCP-Protocol-Version`, `Authorization: Bearer <token>` from `authProvider.token()` (:319-332); 401, or 403 with `insufficient_scope`, is handed once to `authProvider.onUnauthorized` and retried (:295-317); 404 with a session id → `McpSessionExpiredError` (:343); GET SSE stream after `notifications/initialized` with `Last-Event-ID` resumption; `DELETE` on close (:272-283). Legacy SSE is not implemented anywhere (doc `mcp.md:64,79` and code agree).
- **InMemoryTransport / `createInMemoryTransportPair()`** (`in-memory.ts:4-51`, exported from `@earendil-works/pi-mcp/testing`): two peers delivering structured-cloned JSON-RPC via `queueMicrotask`. pi-mcp ships **no MCP server class** (only a client; `MCP/src/` has `client.ts`, `auth-provider.ts`, `oauth/`, `protocol/`, `transports/`, `testing/`). An in-process host server must therefore implement the JSON-RPC handling itself on the `server` peer, as the tests do (`agent-session-mcp.test.ts:53-118`: answer `initialize`, `tools/list`, `tools/call`, `resources/*`), or bridge `@modelcontextprotocol/sdk`'s `Server` to a custom `McpTransport` (**INFERRED** design option).
- `McpClient` (`client.ts:47-52,204-250`): `new McpClient({ name, version, requestTimeoutMs, roots })`; PI passes `roots: [{ uri: pathToFileURL(cwd).href, name: basename(cwd) }]` (`runtime.ts:360-365`) and `name: "pi"`. Default request timeout 30 s (:38); pi overrides with `config.timeout*1000` (`runtime.ts:210-212`).

### 1.4 Connection lifecycle, status, waiting

`McpServerConnection` (`runtime.ts:139-454`): `state: "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed"` (:57), `error`, `tools: McpTool[]`, `hasResources`, `instructions`, `challenge`. Connect retries transient HTTP errors (408/429/5xx except 501, or `TypeError`) with delays `[250, 1000]` ms for HTTP only (:51,343). `notifications/tools/list_changed` re-lists tools (:380-382). Transport drop → `disconnected`, next call reconnects (`getClient`, :237-244); `McpSessionExpiredError` retries once on a new session (:288-294). Read-only requests retried once on transient error; `tools/call` never retried (:274-301, matches `mcp.md:248`).

Extension lifecycle (`index.ts`): `session_start` (:1114-1151) loads config, starts all enabled servers in the background after one `setImmediate` (runtime is lazy-loaded so sessions without servers pay nothing), then `reportProblems` once via `ctx.ui.notify(..., "warning")` (:643-655). `before_agent_start` (:1178-1184) waits up to `startupWaitMs` only for servers that have `direct` tools and injects the `mcp_servers` system-prompt section (:195-221; max 4096 chars, 250 per description). `tool_call` (:1191-1209) waits for the servers a call reaches (`reachesTools`) — codemode for named namespaces or all, tool_search and resource tools for all, direct MCP calls for their own server. `turn_start` (:1212-1214) reconnects servers in `needs-auth` whose stored tokens changed since (picks up `pi mcp login` done by another process). `mcp_servers_change` (:1217-1250). `session_shutdown` (:1252-1258) **closes every connection** — and `session_start` fires again on every `new_session`/`switch_session`/`fork` (`agent-session-runtime.ts:167-178,212-222`), so **stdio servers are killed and respawned on every session switch**.

**Status surfaces.** There is **no structured MCP status event** on the SDK event stream or over RPC: `onChange` only feeds closure-local `listeners` used by the TUI manager (:330-339,547-551). What a host can observe: (1) the one-shot warning notify after startup (RPC: `extension_ui_request` `method:"notify"`); (2) `/mcp` with no args in a non-TUI mode → `ctx.ui.notify(formatStatus(), "info")` (:1285-1291) whose lines are `` `${name}: ${state}${tools} (${exposure})${error}` `` with states `disabled` / `disconnected, reconnects on next call` / `needs sign-in, run /mcp login <name> (<exposure>)` / `connected, N tools` (:1017-1042); (3) `/mcp login|logout|reconnect <server>` notifies success/failure (:1299-1337); (4) `pi mcp list --json` out of session (`cli.ts:434-514`, report fields `name, scope, source, override?, enabled, exposure, transport, state, tools[], toolExposure?, resources?, error?`); (5) in-process, an inline extension can poll `pi.getAllTools()` for `mcp__*` tools and their `exposure` (withdrawn tools are re-registered `hidden`, index.ts:447-452) — **INFERRED** as the only in-process programmatic signal. Server log notifications go to `<agentDir>/mcp.log`, `<ISO time> [<server>] <level> <logger>: <text>`, rotated to `mcp.log.1` at 5 MB (`log.ts:10,26-32,50-55`).

### 1.5 Tool naming, results, errors as the model sees them

Name (`tools.ts:84-93`): `` `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_") ``, max 64 chars, else/or on collision `<prefix>_<8-hex sha256(server\0tool)>`. Label `server/tool`; description = tool description, else title, else `MCP tool ${tool.name} from server ${server}` (:326-330); `parameters` = inputSchema with `type:"object"` and `properties:{}` defaulted (:292-298); `outputSchema` = `{content: ContentBlock[], structuredContent: <tool outputSchema or any>, isError?: boolean}` (:159-174); namespace `{ name: mcpNamespace(server), aliases: [server], description, instructions }` (`index.ts:391-397`); annotations `readOnlyHint/destructiveHint/idempotentHint/openWorldHint` copied when boolean (:300-310). MCP `codemode` exposure maps to PI `ToolExposure` `"deferred"` (:44-46); PI's full `ToolExposure` is `"direct" | "model-only" | "codemode" | "deferred" | "hidden"` (`extensions/types.ts:516`).

Results (`convertMcpResult`, `tools.ts:266-286`): text and image blocks become model content; `resource_link` → `[Resource <uri> "<name>" (mime, size): desc. Read it with read_mcp_resource (server "x")]`; binary `resource` blobs → saved to a temp file (`writeOutputFile("pi-mcp", ext)`) and referenced; text over `MCP_OUTPUT_MAX_BYTES = 20*1024` is middle-truncated as `Warning: truncated output (original token count: N)…[Full output: <path> (read it with offset/limit)]` (:180-201); `isError` → `{ isError: true }` on the AgentToolResult, with text `MCP tool ${server}/${tool} returned an error` if the content was empty (:275-277); scripts get the whole `CallToolResult` minus `_meta` as `structuredContent` (:279-283). Progress notifications → `onUpdate` partial results (:342-346), i.e. `tool_execution_update` events. Thrown errors (timeout `McpTimeoutError`, `McpConnectionClosedError`, `McpError` from a JSON-RPC error response, `MCP server "x" requires sign-in…`, `is disabled`, `is still starting`, `is no longer available` — `index.ts:426-440`, `runtime.ts:77-80,295-299`) surface as error tool results through the normal pipeline (**INFERRED** from pi-agent-core's standard handling; aborted/blocked calls explicitly produce `createErrorToolResult("Operation aborted")`, `AGENT/src/agent-loop.ts:619-628,738-762`). Every MCP call runs through `tool_call`/`tool_result` extension hooks (doc `mcp.md:252`), so a host extension can block with `{ block: true, reason }` and ask via `ctx.ui.select` (pattern in `CA/examples/extensions/rpc-demo.ts:46-66`).

### 1.6 Exposure and discovery activation
`ensureDiscoveryActive` (`index.ts:501-536`): if any enabled server has `codemode` exposure and `autoEnableCodemode` (default true) → activates the `codemode` tool; any `deferred` → activates `tool_search`; only tools of those names that declare `reachesTools` count; otherwise a one-time warning "MCP tools are only reachable from the codemode or tool_search tool, but neither is active". Doc table `mcp.md:191-200`. Codemode caveats (`codemode.md:224-230`): 256 MB VM; **at most two codemode workers alive across all sessions in one pi process**; QuickJS WASM (`quickjs-wasi` dependency).

### 1.7 OAuth for remote servers (`CA/src/extensions/mcp/oauth.ts`, `MCP/src/oauth/*`)

- Applies to HTTP servers with no `Authorization` header and no `auth` (`runtime.ts:82-87`). Connections **never start a browser flow by themselves** (oauth.ts:4-8): the auth provider sends the stored access token, refreshes 30 s before expiry (`REFRESH_SKEW_MS = 30_000`, :46,353-362) or after a 401 (:363-369); if no refresh token or refresh fails → `McpOAuthAuthorizationRequiredError` → state `needs-auth` and tool calls fail with `MCP server "x" requires sign-in. Run /mcp to sign in.` (`runtime.ts:77-80,295-299`). `insufficient_scope` always forces a new sign-in (:366-367).
- Sign-in (`signInMcpServer`, :473-558): `{ serverUrl, store, settings, challenge?, prompt: McpSignInPrompt, signal? }` where `McpSignInPrompt = { showAuthorizationUrl(url: URL): void; promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> }` (:376-385). It listens on **`127.0.0.1`, path `/callback`** (`CALLBACK_HOST`/`CALLBACK_PATH`, :39-40), on `oauth.callbackPort`/`callbackUrl` or the port of the previously registered redirect URI or a free port (:443-466,485-498); for `cimd` also `/callback/<12-char id>` (:238-243,494). Flow: refresh first unless step-up; else `authorizeMcp` returns `"REDIRECT"` with the authorization URL (PKCE S256, `state` 32 random bytes hex, DCR with `client_name` = `settings.clientName ?? APP_NAME`, or configured `clientId`, or CIMD `https://pi.dev/oauth/client.json`), the prompt shows/opens it, then `Promise.race(callback.waitForCallback(state, path), prompt.promptForRedirectUrl(...))` (:419-441) — so **headless paste works**: the user pastes the full redirected URL (origin+path must match, `state` must match, :396-413). Callback server timeout 5 min (`callback.ts:83`); CLI `--timeout` default 300 s. Discovery: protected-resource metadata (RFC 9728) → authorization server metadata (RFC 8414/OIDC) with issuer check, or `authServerMetadataUrl` (`discovery.ts`). Requests to the AS are capped at 15 s each (:51,226-232).
- Headless/driver mapping: in RPC mode `/mcp login <server>` takes the non-TUI branch (`index.ts:1086-1103`): `ctx.ui.notify("Sign in to MCP server \"x\" in your browser:\n<url>", "info")` + `openUrl(url)` (browser opened **inside the pi process** unless `createMcpExtension({openUrl})` was supplied by an inline extension), then `ctx.ui.input("Waiting for sign-in to \"x\". If the browser cannot reach this machine, paste the URL it was redirected to.", "http://127.0.0.1:.../callback?code=...", { signal })` → over RPC an `extension_ui_request` `method:"input"` the host answers with `value` (pasted URL) or `cancelled:true`; the loopback callback resolves it otherwise. In JSON/print mode `ctx.hasUI` is false (`runner.ts:628-630`, `noOpUIContext` :331-362 — `notify` is a no-op) and `loginCommand` refuses: "requires interactive mode" (:1080-1083). Out-of-session: `pi mcp login <server>` (cli.ts:516-573) — when stdin is not a TTY it only waits for the browser callback (:579-594); a running session reconnects on its next `turn_start` (:1212-1214).
- **Token storage**: `<agentDir>/mcp-auth.json` (oauth.ts:10,147), written through `FileAuthStorageBackend` with mode 0600 (`auth-storage.ts:37,61-115`) under a `proper-lockfile` lock; JSON object keyed `` `${mcpNamespace(name)}|${String(new URL(serverUrl))}` `` (legacy key = URL alone, migrated on load, :126-169). Value = `McpOAuthState` (`provider.ts:10-19`): `{ serverUrl, clientInformation?, tokens?: { access_token, token_type, expires_in?, scope?, refresh_token?, id_token? }, tokensExpireAt?, codeVerifier?, oauthState?, discovery? }` — i.e. **plaintext** access/refresh tokens, PKCE verifier and DCR client secret on disk. Refresh serialization across processes: lock file `<agentDir>/mcp-auth-refresh-<sha256(key).slice(0,16)>` (stale 20 s, wait 25 s, :52-56,175-196). `McpOAuthCredentialStore(backend?: AuthStorageBackend, lockDir?)` (:146-149) accepts a custom backend (`AuthStorageBackend = { withLock(fn), withLockAsync(fn, options) }`, `auth-storage.ts:53-59`) — a host could keep tokens in an encrypted store — **but `McpOAuthCredentialStore`, `signInMcpServer`, `McpServerConnection`, `createDefaultTransport`, `loadMcpConfig`, `runMcpCommand` are not exported from the package root** (verified: absent from `CA/src/index.ts` and `PKG/pi-coding-agent/dist/index.d.ts`; only `createMcpExtension`, `McpExtensionOptions`, `McpTransportFactory` and the config types are, `index.ts:412-413`). Sign-out deletes the entry (`remove`, :205-215). Credentials are per `(name, URL)` (doc `mcp.md:131`).
- Alternative without OAuth-to-MCP: `auth: { provider: "<pi provider>" }` sends that provider's current `/login` token (`runtime.ts:186-199`, via `modelRegistry.getApiKeyForProvider`), global `mcp.json` only.

### 1.8 Add / remove / reconnect mid-session
Within a session: `/mcp` actions `enable|disable|enable-project|disable-project` (`setEnabled`, :738-766 — disable closes the connection and hides its tools; `saveConfig` writes `enabled`/`exposure` to the defining `mcp.json` via `updateMcpServerConfig`, `config.ts:169-193`, or only in memory for extension-registered servers), `reconnect` (:720-735), `signin`, `signout`, `exposure` (:768-784). Extension-registered servers can be added/removed live (§1.2a). **Changing `mcp.json` itself requires `/reload`** (doc `mcp.md:28,262`); `ctx.reload()` exists for extensions in RPC mode (`rpc-mode.ts:341-343`), but whether a `/reload` slash command is dispatchable through the RPC `prompt` command was not verified (see unknowns). Note `/mcp` is an extension command, so `{"type":"prompt","message":"/mcp reconnect x"}` works over RPC (`disposition: "handled"`).

### 1.9 Resources, permissions, limits
Resource tools `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` (`mcp-servers.ts:28-30`) are registered with the widest exposure among servers that have resources (`index.ts:480-493`). `ui://` resources omitted (doc `mcp.md:246`).

---

## 2. Sessions

### 2.1 Entry types (verbatim, `CA/src/core/session-manager.ts`)

```ts
export const CURRENT_SESSION_VERSION = 3;                                   // :41
export interface SessionHeader { type: "session"; version?: number; id: string; timestamp: string; cwd: string; parentSession?: string; }  // :43-50
export interface SessionEntryBase { type: string; id: string; parentId: string | null; timestamp: string; }  // :57-62
export interface SessionMessageEntry extends SessionEntryBase { type: "message"; message: AgentMessage; }     // :64-67
export interface ThinkingLevelChangeEntry extends SessionEntryBase { type: "thinking_level_change"; thinkingLevel: string; }  // :69-72
export interface ModelChangeEntry extends SessionEntryBase { type: "model_change"; provider: string; modelId: string; }  // :74-78
export interface UsageEntry extends SessionEntryBase { type: "usage"; kind: string; provider: string; model: string; usage: Usage; note?: string; }  // :80-89
export interface CompactionEntry<T = unknown> extends SessionEntryBase { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number; details?: T; usage?: Usage; fromHook?: boolean; systemMessage?: SystemMessage; }  // :91-104
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase { type: "branch_summary"; fromId: string; summary: string; details?: T; usage?: Usage; fromHook?: boolean; }  // :106-116
export interface CustomEntry<T = unknown> extends SessionEntryBase { type: "custom"; customType: string; data?: T; }  // :128-132
export interface LabelEntry extends SessionEntryBase { type: "label"; targetId: string; label: string | undefined; }  // :135-139
export interface SessionInfoEntry extends SessionEntryBase { type: "session_info"; name?: string; }  // :142-145
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase { type: "custom_message"; customType: string; content: string | (TextContent | ImageContent)[]; details?: T; display: boolean; }  // :159-165
export interface ContextEditEntry extends SessionEntryBase { type: "context_edit"; targetId: string; replacement: { content: ContextEditableContent } | null; }  // :175-180
export type SessionEntry = SessionMessageEntry | ThinkingLevelChangeEntry | ModelChangeEntry | UsageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry | CustomMessageEntry | ContextEditEntry | LabelEntry | SessionInfoEntry;  // :183-194
export type FileEntry = SessionHeader | SessionEntry;  // :197
```

Entry ids are 8 hex chars (`randomUUID().slice(0,8)`, collision-checked, :277-284); session ids are `uuidv7()` (:264-266) or a caller id matching `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/` (:268-274). Message entries hold the full `AgentMessage` (assistant content incl. thinking blocks, `api`, `provider`, `model`, `usage`, `stopReason`, `timestamp`; `toolResult` with `toolCallId`, `toolName`, `content`, `isError`; system messages carry `sections`/`toolsAdded`/`toolsRemoved`). v1/v2 files are migrated on load and rewritten (:286-347,1092-1094).

### 2.2 File location, naming, creation
- Directory: `` join(agentDir, "sessions", `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`) `` (:589-594), e.g. cwd `/Users/x/Library/Application Support/acabox/development/cobuilding-workspace` → `~/.pi/agent/sessions/--Users-x-Library-Application Support-acabox-development-cobuilding-workspace--/` (spaces kept). Custom dir: `SessionManager.create(cwd, sessionDir)`, `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, `sessionDir` setting (`main.ts:691-695`; precedence CLI > env > setting).
- File: `` `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl` `` (:1079-1080), one JSON object per line, header first.
- **Lazy creation**: the file is written (`openSync(..., "wx")`, all entries) only once a user or assistant message exists; setup entries (model_change, thinking_level_change, system) stay in memory (:1160-1189). Afterwards every entry is `appendFileSync`'d synchronously (:1187). The file is never truncated except for migration rewrites.
- `getSessionFile()` is defined before the file exists (`newSession` computes the path, :1078-1082); `get_state.sessionFile` therefore names a not-yet-created file for an empty session.

### 2.3 Opening, listing, resuming
- `SessionManager.open(path, sessionDir?, cwdOverride?)` (:1766-1786): reads the header (bounded 1 MiB scan) for `cwd`; a non-empty file that is not a pi session throws (:1036-1040). `findById(cwd, id, sessionDir?)` (:1874-1892), `continueRecent(cwd, sessionDir?)` (:1793-1801, newest `.jsonl` by mtime whose header cwd matches when a custom dir is used), `list(cwd, sessionDir?, onProgress?, signal?)` (:1900-1915), `listAll(sessionDir?|onProgress?, …)` (:1921-2012) across all `--cwd--` dirs, `inMemory(cwd, options?, entries?: FileEntry[])` (:1804-1806, **accepts preloaded entries** — a route for injecting host-held history), `forkFrom(sourcePath, targetCwd, sessionDir?, {id})` (:1815-1866, copies all entries into a new file with `parentSession`), `createBranchedSession(leafId)` (:1632-1748, new file with only the root→leaf path, labels re-chained).
- `SessionInfo` (:229-243): `{ path, id, cwd, name?, parentSessionPath?, created, modified, messageCount, firstMessage, allMessagesText }`. **Listing reads every session file line by line** (`buildSessionInfo`, :799-882) and concatenates all user/assistant text into `allMessagesText` — cost is O(total bytes of all sessions in the dir); 10 files loaded concurrently (:891).
- CLI resume: `--session <path|id>` (exact or partial id, searches the current project then all projects and offers a fork, `cli.md:90-91`, `main.ts:252-275`), `--session-id <id>` opens the exact id or creates it (`cli.md:92-93`; combinable with `--fork`), `--continue`, `--fork`, `--no-session`, `--name`. A session whose stored cwd no longer exists is refused in non-interactive modes (`main.ts:697-708`, `session-cwd.ts:54-59`) unless a `cwdOverride` is given (`AgentSessionRuntime.switchSession(sessionPath, { cwdOverride })`, `agent-session-runtime.ts:196-224`). `switchSession` **recreates all services for the session's cwd** (:210-222) — resources, settings, extensions, MCP.
- Resume semantics: `createAgentSession` restores the model from the branch (`model_change` entries / last assistant message; virtual selections only from `model_change`) if auth for its provider is configured, else `modelFallbackMessage = "Could not restore model …"` and falls back to settings/first available (`sdk.ts:209-251`); thinking level from the branch (:253-278); `agent.state.messages` = projected messages (:417). Resumed system prompt/tool loadout replay from persisted system messages (`session-format.md:80-87`). "`SessionManager` is authoritative for finalized model context … Assigning `session.agent.state.messages` does not replace persisted context" (`sdk.md:40`). `AgentSessionRuntime.importFromJsonl(path, cwdOverride?)` copies a foreign JSONL into the session dir and switches to it (:359-402).

### 2.4 Context rebuild
`buildContextEntries` (:476-512): walk leaf→root; if a compaction is on the path, context = `[compaction, entries from firstKeptEntryId (non-system) up to the compaction, everything after]`. `buildSessionProjection` (:543-573) applies the latest `context_edit` per target; only the newest compaction contributes its checkpoint+summary; `sessionEntryToContextMessages` (:439-466) emits `[systemMessage, compactionSummary]` for a compaction entry. Model/thinking come from the full path (:418-433).

### 2.5 Persistence timing, crashes, aborts
- Messages are persisted on `message_end` (`agent-session.ts:1148-1169`): `custom` → `appendCustomMessageEntry`; `system|user|assistant|toolResult` → `appendMessage`. So the user prompt is on disk when its `message_end` fires at run start, the assistant message when its stream ends (any `stopReason`, incl. `aborted`/`error`), each tool result when it completes. Bash execution messages (`rpc bash` command) are persisted via `appendMessage(bashMessage)` (:3927,3959).
- **Host process dies mid-turn**: nothing special is written. The file holds every message that reached `message_end` (synchronous append), the in-flight assistant stream is lost, and if the crash falls between an assistant `message_end` with tool calls and its tool results, the file ends with dangling tool calls. How PI treats such a tail on resume was **not read** (see unknowns). PI-spawned stdio servers are in their own process groups; the `exit` hook (`stdio.ts:43-53`) does not run on SIGKILL, so they can be orphaned (**INFERRED** from Node semantics).
- **Aborted turn** (`abort()` → `agent.abort()` + wait idle, `agent-session.ts:2464-2474`; RPC `abort` waits for idle too): pi-agent-core ends the run on an assistant message with `stopReason: "aborted"` (partial content) — `turn_end` with `toolResults: []` then `agent_end` (`AGENT/src/agent-loop.ts:245-256`); tool calls not yet executed when the signal fires get synthetic error results `"Operation aborted"` (`:619-628, 738-762`). The assistant message is persisted like any other; `agent_settled { aborted: true }` follows (:1079-1086); `_lastActivityOutcome = "aborted"` (:851-852); compaction checks skip aborted messages (:2986); `getLastAssistantText` skips aborted messages with empty content (:4377-4387). `AgentSessionRuntime.teardownCurrent` aborts first "so the aborted turn (including tool results) is persisted to the outgoing session before it is replaced" (:167-178).
- `dispose()` (:1397-1418) aborts retry/compaction/branch-summary/bash and the agent, invalidates extension contexts, disconnects listeners, cancels the cache warmer, `cleanupSessionResources(sessionId)`.

### 2.6 Size
Everything the model saw is stored verbatim, never pruned: bash/read/grep output is truncated for the model at `DEFAULT_MAX_LINES = 2000` / `DEFAULT_MAX_BYTES = 50*1024` per call (`tools/truncate.ts:11-12`; full output goes to a temp file, `bash.ts:255`), MCP text at 20 KB (§1.5), codemode output at 10 000 tokens default (`codemode.md:15`); assistant thinking text is stored (only the summarization serializer drops it, `compaction/utils.ts:114-118`); images arrive as base64 content blocks in user/toolResult messages (`read.ts:96` "Images are sent as attachments") and are stored inline (**INFERRED** from the entry shape). Compaction appends; nothing is deleted. Opening a session loads the whole file into memory (`loadEntriesFromFile`, :627-670) and listing streams whole files (§2.3). I did not measure real session files.

### 2.7 Branching, forking, labels, names
`branch(id)`, `resetLeaf()`, `branchWithSummary(id|null, summary, details?, fromHook?, usage?)` (:1579-1625); `appendLabelChange` (:1441-1462), `appendSessionInfo(name)` (:1304-1315, `set_session_name` / `--name` / `pi.setSessionName`), `appendContextEdit(targetId, replacement|null)` (:1360-1398, append-only omission/replacement of user/assistant/toolResult/custom_message content on the active branch), `appendCompaction` stores `systemMessage` = current system checkpoint (:1261-1287), `getTree()` (:1529-1567), `getEntries()` copy (:1520-1522), `getEntryCount()`.

---

## 3. Compaction (`CA/src/core/compaction/compaction.ts`, `agent-session.ts`)

- Settings (`DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`, :126-130); keys `compaction.enabled|reserveTokens|keepRecentTokens|modelOverrides["provider/modelId"]` in `<agentDir>/settings.json` or `<project>/.pi/settings.json` (`settings.md:73-76`), `branchSummary.reserveTokens` 16384 (:88). `SettingsManager.inMemory({...})`/`applyOverrides` for hosts (`examples/sdk/12-full-control.ts:29-32`, `14-codemode-mcp.ts:38-40`). RPC `set_auto_compaction {enabled}` persists via `settingsManager.setCompactionEnabled` (:3280).
- Trigger: `shouldCompact(contextTokens, contextWindow, settings) = settings.enabled && contextTokens > contextWindow - settings.reserveTokens` (:267-270). Checked in `_checkCompaction` (:2977-3115) after an assistant message: skipped for `stopReason === "aborted"`, for a message from a different model than the current one, and for a message older than the latest compaction; **overflow** = provider error matching `isContextOverflow` (`pi-ai/src/utils/overflow.ts:137-171`: Anthropic "prompt is too long"/"request_too_large", OpenAI "exceeds the context window", etc., or silent overflow `usage.input+cacheRead > contextWindow`, or `length` with zero output at ≥99 % of the window) or a recoverable `length` stop → one compact-and-retry attempt (`_overflowRecoveryAttempted`), the failed attempt omitted via `context_edit` (:1241-1257,3071-3076); **threshold** uses provider usage (`usage.totalTokens || input+output+cacheRead+cacheWrite`, :140-142) or char/4 estimates. Between turns the check runs in `prepareNextTurn` before the next assistant call (:840-842). A prompt during compaction throws "Cannot submit a prompt while compaction is in progress" (:2076-2080). Manual `compact()` first `abort()`s the run (:2794-2795).
- Cut point (:802-870): walk newest→oldest accumulating estimated tokens until `keepRecentTokens`; cut only at user/assistant/bashExecution/custom/branchSummary/compactionSummary messages, never tool results; split-turn handling with a second "turn prefix" summary (:942-955,994-1033).
- **Which model summarizes**: the session's current model — `compact()` is called with `this.model` (`agent-session.ts:2802-2810`, `_runDefaultCompaction(preparation, model, …)` :2749-2772 resolving auth/headers for that same model). No cheaper model by default; a host extension can take over with `session_before_compact` returning `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }` or `{ cancel: true }` (`types.ts:785-795`, doc `compaction.md:297-368`, `examples/extensions/custom-compaction.ts`).
- Cost shape: prompt = serialized conversation (`[User]: … [Assistant]: … [Assistant tool calls]: … [Tool result]: …`, tool results cut to 2000 chars, thinking omitted, `utils.ts:93-155`) + previous summary + `SUMMARIZATION_PROMPT` (:507-538) or `UPDATE_SUMMARIZATION_PROMPT`; `maxTokens = min(floor(0.8 * reserveTokens), model.maxTokens)` (:712-715; turn prefix 0.5×, :1090-1093); `cacheRetention: "none"` and a fresh routing id (:627-632); retried via `settings.retry`; a `length` stop is rejected ("summary is incomplete", :585-593). Resulting `usage` is stored on the `CompactionEntry` and counted in `get_session_stats.tokens/cost` (`rpc-commands.md:565`).
- What survives: the structured summary (Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context + `<read-files>`/`<modified-files>` lists cumulated across pi-generated compactions, :51-88,1056-1058), the kept recent entries from `firstKeptEntryId`, the system/tool checkpoint stored in the entry (`session-manager.ts:1270,1283`), and all raw entries on disk.
- Events: SDK/RPC `compaction_start {reason}`, `compaction_end {reason, result?, aborted, willRetry, errorMessage?}`, `summarization_retry_scheduled|attempt_start|finished` (`agent-session.ts:209-236`); extension `session_before_compact`, `session_compact`, `session_compact_failed` (`types.ts:785-821`); `get_session_stats.contextUsage.tokens/percent` are `null` right after compaction until a post-compaction assistant response (:4274-4299).

---

## 4. RPC mode (`CA/src/modes/rpc/`)

### 4.1 Launch and framing
`pi --mode rpc [--no-session|--session …|--session-dir …|--session-id …|--model …|--provider …|--thinking …|--tools …|--no-mcp|-e <ext>|--no-extensions|--name …]` (`cli.md`), or the published `./rpc-entry` export: `dist/bundle/rpc-entry.js` sets `process.title = "pi-rpc"`, `PI_CODING_AGENT=true`, `AI_AGENT=pi`, silences `process.emitWarning`, `configureHttpDispatcher()`, then `main(["--mode","rpc", ...argv])` (`src/rpc-entry.ts:6-13`). `@file` args are rejected (`main.ts:660-663`); piped stdin is not read in RPC mode (:894-901); the model catalog is refreshed in the background with a 15 s cap unless offline (:940-947); no model configured → exits 1 (:928-931). Strict JSONL: one object per LF line, CR stripped, never split on U+2028/2029 (`jsonl.ts`, `rpc.md:50-56`); stdout is reserved (`takeOverStdout()`, `rpc-mode.ts:55`), diagnostics go to stderr; backpressure honoured both ways.

### 4.2 Commands (verbatim union, `rpc-types.ts:20-74`)

```ts
export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" };
```

Responses are `{ id?, type: "response", command, success: true, data? }` or `{ id?, type: "response", command, success: false, error }` (`rpc-types.ts:116-245`); `get_state` returns `RpcSessionState = { model?: Model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile?, sessionId, sessionName?, autoCompactionEnabled, messageCount, pendingMessageCount }` (:96-109). `prompt` answers only after preflight with `data.disposition: "started" | "queued" | "handled"` (`rpc-mode.ts:394-414`; rejection before acceptance → `success:false`, e.g. no model auth: `formatNoApiKeyFoundMessage`, `agent-session.ts:2123-2136`); during streaming `streamingBehavior` is mandatory (:2103-2108). `set_model` looks the model up in `modelRuntime.getAvailableSnapshot()` and `session.setModel` throws `No API key for <provider>/<id>` without auth (:2507-2510). `switch_session` → `runtimeHost.switchSession(path)` (no cwdOverride exposed over RPC), `fork` → `runtimeHost.fork(entryId)` (position "before", returns the user text), `clone` → fork at the leaf; each rebinds the new session (`rpc-mode.ts:435-442,603-629`). `get_entries {since}` is a durable cursor over the append-only file (`rpc-commands.md:689-717`). `bash` runs a host-side shell command and records a `BashExecutionMessage` that becomes a user message on the next prompt (`rpc-commands.md:493-509`). Parse errors → `{command:"parse", success:false}`.

### 4.3 Events
Everything `session.subscribe` emits, transformed by `toJsonEvent` (`json-event.ts:46-61`: `message_update` loses `partial`, gains `usage` and, for `toolcall_start`, `id`/`toolName`): pi-agent-core `agent_start`, `turn_start`, `message_start/message_update/message_end` (roles user, assistant, **toolResult**, custom), `tool_execution_start/update/end` (`+ parentToolCallId` for codemode-nested calls, `agent-session.ts:189-193`), `turn_end {message, toolResults}`, `agent_end {messages, willRetry}`; session-level (`agent-session.ts:196-237`): `agent_settled {aborted}`, `queue_update {steering, followUp}`, `compaction_start/end`, `entry_appended {entry}` (**only** for extension `pi.appendEntry()` and recovery `context_edit`s, :1254 — model changes, compactions, labels do **not** emit it), `session_info_changed {name}`, `thinking_level_changed {level}`, `auto_retry_start/end`, `summarization_retry_*`, `bash_execution_update {id?, delta}`; RPC-only `extension_error {extensionPath, event, error}` (`rpc-mode.ts:348-350`) and the extension-UI subprotocol. Wait for `agent_settled`, not `agent_end` (`rpc.md:67-71`).

### 4.4 Extension UI relay (`rpc-mode.ts:91-311`, `rpc-types.ts:252-297`)
Dialogs `select|confirm|input|editor` emit `{type:"extension_ui_request", id, method, …, timeout?}` and block until `{type:"extension_ui_response", id, value|confirmed|cancelled:true}`; a `timeout` auto-resolves with the default (`undefined`/`false`) and an aborted signal does too (:97-131). Fire-and-forget `notify {message, notifyType}`, `setStatus {statusKey, statusText}`, `setWidget {widgetKey, widgetLines, widgetPlacement}`, `setTitle`, `set_editor_text`. No-ops: `setWorkingMessage/Visible/Indicator`, `setHiddenThinkingLabel`, `setFooter/Header`, `custom()` → undefined, `getEditorText()` → "", `setTheme` fails (`rpc-extension-ui.md:14-25`). `ctx.mode === "rpc"`, `ctx.hasUI === true`. Extension `shutdownHandler` sets a flag; shutdown happens after the current command or after `agent_settled` (:345-347,357-359,745-748).

### 4.5 Lifecycle / shutdown
Closing stdin → `shutdown()` → `runtimeHost.dispose()` (emits `session_shutdown reason:"quit"`, disposes the session — which closes MCP connections) → `process.exit(0)` (:726-748,802-805). SIGTERM → exit 143, SIGHUP → 129, after `killTrackedDetachedChildren()` (:366-380). `RpcClient.stop()` sends SIGTERM and SIGKILLs after 1 s (`rpc-client.ts:145-167`).

### 4.6 Sessions per process; extensions and tools in RPC mode
- **Exactly one active `AgentSession` per RPC process**: all commands act on `runtimeHost.session`; `new_session`/`switch_session`/`fork`/`clone` tear the current session down (abort → `session_shutdown` → dispose) and create a replacement (`agent-session-runtime.ts:167-350`, `rpc-mode.ts:313-364`). No multiplexing of concurrent chats. `newSession` keeps the current cwd (:226-260); `switchSession` adopts the target session's cwd (:210-222). Every replacement re-runs extension loading and `session_start`, i.e. reconnects/respawns MCP servers (§1.4).
- Tools/extensions are loaded from: built-ins (`codemode`, `tool_search`, `mcp`; `main.ts:578`, `sdk.md:116`), discovered extension/skill/prompt dirs (per `configuration.md`, not read), `-e <path>` (`additionalExtensionPaths`, `main.ts:783`), `--no-extensions`, `--no-mcp` (`disabledBuiltinExtensions: ["mcp"]`, :788), `--tools/--exclude-tools/--no-tools`. Extensions are TS/JS files (loaded with `jiti`, a declared dependency) exporting `(pi: ExtensionAPI) => void` and may `pi.registerTool({ name, label, description, parameters (TypeBox), execute(toolCallId, params, signal, onUpdate), exposure?, namespace?, annotations?, … })` (`types.ts:579-640,1671-1673`). **The host cannot register tools over the wire**; it can only (i) write an extension file whose `execute` talks back to the host (**INFERRED** design: HTTP/IPC from the extension to Electron), or (ii) write its **own child entry** using public exports — `createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: { extensionFactories, additionalExtensionPaths, … } })` → `createAgentSessionFromServices({ services, sessionManager, customTools, tools, model, … })` → `createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager })` → `runRpcMode(runtime)` (all exported: `CA/src/index.ts:251-264,433`; shapes seen in `main.ts:733-870`, `examples/sdk/13-session-runtime.ts`), which keeps the stock stdio protocol while embedding inline extensions (host tools, `createMcpExtension({ loadConfig, createTransport, credentials, openUrl, updateConfig })`). `main(args, { extensionFactories })` also accepts inline extensions (`main.ts:570-578`) but `main` is not exported from the root (only via `./rpc-entry`'s bundle chunk) — **INFERRED**: reachable only by absolute-path import of `dist/main.js`.
- `RpcClient` (`rpc-client.ts:56-617`): spawns **`"node"`** with `[cliPath ?? "dist/cli.js", "--mode", "rpc", …]` (:81-98), 100 ms startup wait, 30 s per-command timeout (:580), `waitForIdle`/`collectEvents` 60 s default, stderr mirrored to the parent's stderr (:102-105). Under a packaged Electron app there is no `node` on PATH and no option to change the executable, so Acabox would spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1` itself (the measured-working route) and reuse only the framing helpers/typing — `RpcClient` as shipped is unusable as-is there (**INFERRED** from :94).

### 4.7 In-process SDK vs child RPC process for Acabox (reasoned)
Facts that bear on the choice:
1. **Crash isolation.** Child: a crash in PI, a tool, QuickJS/WASM (codemode, 256 MB VM) or an extension cannot take down Electron main; stdout/stderr are the protocol. In-process: PI's `takeOverStdout()` is only called by the RPC/print modes (not by `createAgentSession`), but module-level globals still apply — `setDefaultStreamFn(streamSimple)` at `sdk.ts:46`, `configureHttpDispatcher()` (undici global dispatcher; called by the CLI entries, `main.ts:598`; whether `createAgentSession` alone calls it was not read), the shared `auth.json` read-state singleton (`auth-storage.ts:51`), `process.once("exit")` hooks for stdio servers (`stdio.ts:43-53`).
2. **Sessions per process.** Child RPC = one session per process (§4.6): N concurrent chats = N processes (each loads the ~9 MB bundle, its own MCP connections and stdio children) or one process switching sessions sequentially (every switch respawns MCP servers). In-process SDK: any number of `AgentSession`s side by side, each with its own extension runtime and MCP connections — but the codemode worker cap is **two per process across all sessions** (`codemode.md:228`), and each session's MCP extension spawns its own stdio servers (per-session, not shared).
3. **MCP integration surface.** Only in-process (or a host-written child entry, §4.6-ii) can pass `loadConfig`/`createTransport`/`credentials`/`openUrl`/`updateConfig`; with the stock `pi --mode rpc` binary the only inputs are `mcp.json` files in the agent dir / project and `-e` extension files, and OAuth tokens land in `mcp-auth.json` in plaintext. Host-owned stdio servers can either be spawned by PI (PI owns the child, full env inherited, respawned on every session switch) or reached through a custom `McpTransport` bridging to a host-owned process/in-memory server (in-process or custom child entry only).
4. **Memory/size.** Not measured. Package footprint: bundle 8.9 MB, full package 25 MB, deps 148 MB; whether the bundle still needs `node_modules` at runtime was not verified.
5. **Upgrade path.** Child via `./rpc-entry` keeps PI's ESM graph out of the Electron webpack bundle and lets the app vendor/replace the PI version independently (the published `engines` says node ≥22.19.0 while Electron 37 ships 22.17.0 — measured to run, but it is outside the declared support window). In-process ties the ESM-only package (`"type": "module"`) into the main-process bundle (dynamic `import()` from a CJS webpack bundle — **INFERRED** feasible on Node 22, not measured) and couples Electron upgrades to PI's Node requirements.
6. **Parity with today's Acabox.** Today's agent server is already a child with an HTTP/SSE host protocol and MCP relays. The closest structural analogue is a **host-written child entry** (public SDK exports + `runRpcMode`) rather than either pure in-process or the stock CLI: it preserves crash isolation and a line protocol, and still allows inline extensions for host tools and connector/credential ownership. Pure in-process gives the richest API (no protocol gap, direct `session.subscribe`, direct `SessionManager`) at the cost of isolation.

---

## 5. JSON (print) mode (`CA/src/modes/print-mode.ts`, `docs/json.md`)
`pi --mode json "prompt" [more prompts]`: writes the session header line first (`print-mode.ts:122-127`, `{"type":"session","version":3,"id","timestamp","cwd"}`), then the same event shapes as RPC via `toJsonEvent` (:108-112), runs `initialMessage` then each extra message through `session.prompt()` sequentially (:131-137), disposes and exits. Exit code: 0 unless the invocation throws; a failed/aborted assistant response does **not** change the exit code in JSON mode (text mode: `error|aborted` → 1, `length` prints partial text and exits 1, :139-159). No stdin commands, no extension UI (`bindExtensions({ mode: "json" })` without `uiContext` → `noOpUIContext`, `hasUI` false: `notify` dropped, `select` → undefined, `confirm` → false; MCP sign-in impossible, `index.ts:1080-1083`). Non-TTY stdin/stdout without `--mode` selects print mode automatically (`main.ts:112-123`). Sessions persist unless `--no-session`.

---

## 6. Mapping notes for the planner (summary of what the sources support)
- **Connectors (remote HTTP + OAuth)** → `McpHttpServerConfig { url, headers?, oauth?, exposure, description }`; OAuth needs a UI path for the authorization URL and the optional pasted redirect (RPC: `extension_ui_request` notify+input; in-process: host `uiContext`); tokens in `<agentDir>/mcp-auth.json` (plaintext, 0600) unless a custom `AuthStorageBackend` is injected through a deep import; `auth: { provider }` reuses a pi provider login instead.
- **Host-owned stdio servers** → `McpStdioServerConfig` (PI spawns; env inherited wholesale; respawned per session switch) or a custom `McpTransport` to an existing host process / in-memory server (`createTransport` factory; `InMemoryTransport` from `@earendil-works/pi-mcp/testing`; no server class shipped).
- **Chat history** → one JSONL per chat under `<agentDir>/sessions/--<cwd>--/`; the session id can be Acabox's own id (`--session-id` / `SessionManager.create(cwd, dir, { id })`); mirror into SQLite via `message_end` events or `get_entries { since }`; resume via `switch_session { sessionPath }` / `--session <id>`; PI's file remains the authoritative model context.
- **Compaction** → automatic at `contextWindow − 16384` tokens, keeps ~20 000 recent tokens, summarized by the chat's own model; configurable per model; observable via `compaction_start/end`; overridable per host via `session_before_compact`.

## KEY FACTS
- The published package exports only the root and ./rpc-entry subpaths; deep imports of MCP OAuth/runtime modules are blocked by the exports map.
  - evidence: PKG/pi-coding-agent/package.json:14-21 — "exports": { ".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}, "./rpc-entry": {"import": "./dist/bundle/rpc-entry.js"} }
- McpOAuthCredentialStore, signInMcpServer, McpServerConnection, loadMcpConfig, runMcpCommand are not exported from the package root; only createMcpExtension and config types are.
  - evidence: CA/src/index.ts:412-413 — export type { LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry } … export { createMcpExtension, type McpExtensionOptions, type McpTransportFactory }; grep of dist/index.d.ts for the other names returned nothing
- MCP server config union is McpStdioServerConfig | McpHttpServerConfig with exposure codemode|deferred|direct|hidden, timeout default 60 s, and an optional auth: { provider } on HTTP servers.
  - evidence: CA/src/core/mcp-servers.ts:52,59-78,80-88,137-150 — export type McpExposure = "codemode" | "deferred" | "direct" | "hidden"; … auth?: { provider: string }; export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
- Legacy SSE transport is rejected at validation time.
  - evidence: CA/src/core/mcp-servers.ts:270 — if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
- createMcpExtension accepts loadConfig, createTransport, credentials, logPath, openUrl, updateConfig and startupWaitMs (default 10000).
  - evidence: CA/src/extensions/mcp/index.ts:69-93 — export interface McpExtensionOptions { loadConfig?: …; createTransport?: McpTransportFactory; credentials?: McpOAuthCredentialStore; logPath?: string; openUrl?: (url: string) => void; updateConfig?: …; startupWaitMs?: number; } const DEFAULT_STARTUP_WAIT_MS = 10_000;
- The default stdio transport factory does not set inheritEnv, so PI-spawned stdio servers inherit PI's entire process environment plus the configured env, with cwd defaulting to the session cwd.
  - evidence: CA/src/extensions/mcp/runtime.ts:115-121 — return new StdioTransport({ command: expandHome(config.command), args: config.args?.map(expandHome), cwd: resolve(cwd, expandHome(config.cwd ?? ".")), env, stderr: "pipe" }); and MCP/src/transports/stdio.ts:94 — const env = this.options.inheritEnv === false ? { ...this.options.env } : { ...process.env, ...this.options.env };
- Stdio servers are closed by ending stdin, SIGTERM to the process group after 500 ms, then SIGKILL after a further 2000 ms.
  - evidence: MCP/src/transports/stdio.ts:8-10,164-178 — const DEFAULT_CLOSE_TIMEOUT_MS = 2_000; const STDIN_CLOSE_GRACE_MS = 500; … timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace)); timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
- pi-mcp ships an in-memory transport pair under the ./testing subpath but no MCP server class.
  - evidence: MCP/src/testing/index.ts:1 — export { createInMemoryTransportPair, InMemoryTransport } from "../transports/in-memory.ts"; PKG/pi-mcp/package.json exports ".", "./oauth", "./testing"; MCP/src contains only auth-provider.ts, client.ts, index.ts, oauth, protocol, testing, transports
- The test harness wires an in-process MCP server through createMcpExtension({ loadConfig, createTransport }) returning the client side of an in-memory pair.
  - evidence: CA/test/suite/agent-session-mcp.test.ts:186-194 — createMcpExtension({ loadConfig: () => ({ servers: [entry], errors: [], ...configOptions }), createTransport: () => { const pair = createFakeServer(calls, …); servers.push(pair.server); void pair.server.start(); return pair.client; } })
- MCP connections are closed on session_shutdown and started on session_start, and every new_session/switch_session/fork tears down and recreates the session, so stdio servers are respawned on each switch.
  - evidence: CA/src/extensions/mcp/index.ts:1252-1258 — pi.on("session_shutdown", async () => { session.abort(); const closing = connections(); servers = []; … closing.map((connection) => connection.close()) }); and CA/src/core/agent-session-runtime.ts:167-178 — await this.session.abort(); await emitSessionShutdownEvent(…{ type: "session_shutdown", reason, targetSessionFile }); … this.session.dispose();
- MCP tool names are mcp__<server>__<tool> with every non-[A-Za-z0-9_] char replaced by _, max 64 chars, hash-suffixed on collision; the namespace is mcp__<server with - → _>.
  - evidence: CA/src/extensions/mcp/tools.ts:84-93 — const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_"); if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name; … `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`; and mcp-servers.ts:155-157 — return `mcp__${server.replace(/-/g, "_")}`;
- MCP text results over 20 KB are middle-truncated and the full text saved to a temp file; isError results become error tool results.
  - evidence: CA/src/extensions/mcp/tools.ts:51,275-285 — export const MCP_OUTPUT_MAX_BYTES = 20 * 1024; … if (result.isError && textOf(converted) === "") converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` }); … ...(result.isError ? { isError: true } : {})
- OAuth tokens for MCP servers are stored in <agentDir>/mcp-auth.json keyed by namespace|URL, as McpOAuthState with plaintext access/refresh tokens, PKCE verifier and client registration.
  - evidence: CA/src/extensions/mcp/oauth.ts:10,130-133,147 — Credentials live in `<agent-dir>/mcp-auth.json`, keyed by server name and URL. … return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey }; … new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json")); and MCP/src/oauth/provider.ts:10-19 — export interface McpOAuthState { serverUrl; clientInformation?; tokens?: OAuthTokens; tokensExpireAt?; codeVerifier?; oauthState?; discovery? }
- The OAuth callback server listens on 127.0.0.1 at /callback (port from config, prior registration, or a free port) and a pasted redirect URL is accepted as an alternative to the browser callback.
  - evidence: CA/src/extensions/mcp/oauth.ts:39-40,428-434 — const CALLBACK_HOST = "127.0.0.1"; const CALLBACK_PATH = "/callback"; … const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname); const fromUser = prompt.promptForRedirectUrl(promptSignal).then(…responseFromRedirectUrl(input, state, redirectUrl)); … return await Promise.race([fromBrowser, fromUser]);
- Access tokens are refreshed 30 s before expiry or after a 401; insufficient_scope always requires a new sign-in; connections never open a browser on their own.
  - evidence: CA/src/extensions/mcp/oauth.ts:4-6,46,357-367 — Connections never start a browser flow on their own. … const REFRESH_SKEW_MS = 30_000; … const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now(); … if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
- In RPC mode /mcp login notifies the authorization URL, opens the browser inside the pi process, and asks for the pasted redirect via ctx.ui.input; without a UI (JSON/print mode) sign-in is refused.
  - evidence: CA/src/extensions/mcp/index.ts:1080-1102 — if (!ctx.hasUI) { ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error"); return; } … ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info"); openUrl(url.href); … promptForRedirectUrl: (signal) => ctx.ui.input(`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`, "http://127.0.0.1:.../callback?code=...", { signal })
- A running session picks up a sign-in completed by another process (e.g. pi mcp login) by reconnecting at the next turn_start when stored tokens changed.
  - evidence: CA/src/extensions/mcp/index.ts:1211-1214 — // Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent. pi.on("turn_start", async (_event, ctx) => { if (tokensAtSignIn.size > 0) await reconnectSignedIn(ctx); });
- There is no structured MCP status event; connection changes only feed closure-local listeners, and the only non-TUI status output is a notify with formatStatus() text.
  - evidence: CA/src/extensions/mcp/index.ts:330-339,1283-1291 — const listeners = new Set<() => void>(); const emitChange = () => { for (const listener of listeners) listener(); }; … if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx)); else { await pending; ctx.ui.notify(formatStatus(), "info"); }
- Extensions can register MCP servers at runtime; registrations are not saved and are overridden by an mcp.json server of the same name; RPC offers no command to register servers or tools.
  - evidence: CA/src/core/extensions/types.ts:1880-1897 — registerMcpServer(name: string, config: McpServerConfig): void; unregisterMcpServer(name: string): void; … "The registration is not saved; register again on every load. A server of the same name in `mcp.json` takes precedence."; CA/src/modes/rpc/rpc-types.ts:20-74 RpcCommand union contains no register command
- Session files live at <agentDir>/sessions/--<cwd with leading separator stripped and / \ : replaced by -->--/<ISO timestamp with : . → ->_<sessionId>.jsonl.
  - evidence: CA/src/core/session-manager.ts:589-594,1079-1080 — const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`; return join(resolvedAgentDir, "sessions", safePath); … const fileTimestamp = timestamp.replace(/[:.]/g, "-"); this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
- A session file is created only once a user or assistant message exists and every later entry is appended synchronously.
  - evidence: CA/src/core/session-manager.ts:1160-1189 — "A new session file is created only once the session contains a user or assistant message." … if (!this.flushed) { if (!this._hasConversation()) return; const fd = openSync(this.sessionFile, "wx"); … } else { appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`); }
- Messages are persisted on message_end: system/user/assistant/toolResult via appendMessage, custom via appendCustomMessageEntry.
  - evidence: CA/src/core/agent-session.ts:1148-1167 — if (event.type === "message_end") { … if (event.message.role === "custom") { entryId = this.sessionManager.appendCustomMessageEntry(…) } else if (event.message.role === "system" || … "user" || … "assistant" || … "toolResult") { entryId = this.sessionManager.appendMessage(event.message); }
- An abort ends the run with an assistant message of stopReason aborted and tool calls not yet executed receive synthetic error results "Operation aborted".
  - evidence: AGENT/src/agent-loop.ts:245-256,619-628 — if (message.stopReason === "error" || message.stopReason === "aborted") { … await emit({ type: "turn_end", message, toolResults: [] }); await emit({ type: "agent_end", messages: newMessages }); return; } … if (signal?.aborted) { const finalized = { toolCall, result: createErrorToolResult("Operation aborted"), isError: true }
- Session id may be supplied by the caller and must match /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/; otherwise ids are uuidv7.
  - evidence: CA/src/core/session-manager.ts:264-274 — function createSessionId(): string { return uuidv7(); } export function assertValidSessionId(id: string): void { if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) { throw new Error(…) } }
- SessionManager.inMemory accepts preloaded FileEntry[] and AgentSessionRuntime.importFromJsonl copies a JSONL into the session dir and switches to it.
  - evidence: CA/src/core/session-manager.ts:1804-1806 — static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager; CA/src/core/agent-session-runtime.ts:359-402 — async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>
- Compaction triggers when contextTokens > contextWindow − reserveTokens with defaults reserveTokens 16384 and keepRecentTokens 20000.
  - evidence: CA/src/core/compaction/compaction.ts:126-130,267-270 — export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }; … return contextTokens > contextWindow - settings.reserveTokens;
- Compaction summaries are generated by the session's current model with maxTokens = min(0.8·reserveTokens, model.maxTokens), cache writes disabled.
  - evidence: CA/src/core/agent-session.ts:2802-2810 — const model = this.model; … const settings = this.settingsManager.getCompactionSettings(model); and CA/src/core/compaction/compaction.ts:712-715,629-632 — const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY); … cacheRetention: "none", sessionId: options.sessionId ?? uuidv7()
- Compaction serialization truncates tool results to 2000 chars and omits thinking.
  - evidence: CA/src/core/compaction/utils.ts:94,114-118,149 — const TOOL_RESULT_MAX_CHARS = 2000; … Thinking is omitted. … parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
- A compaction entry stores the complete system/tool checkpoint at the boundary.
  - evidence: CA/src/core/session-manager.ts:1270,1283 — const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages); … ...(systemMessage ? { systemMessage: { ...systemMessage, timestamp: new Date(timestamp).getTime() } } : {})
- The RPC process holds exactly one active AgentSession; new_session, switch_session, fork and clone replace it and rebind.
  - evidence: CA/src/modes/rpc/rpc-mode.ts:56,435-442,603-629 — let session = runtimeHost.session; … case "new_session": { … const result = await runtimeHost.newSession(options); if (!result.cancelled) { await rebindSession(); } … case "switch_session": { const result = await runtimeHost.switchSession(command.sessionPath); if (!result.cancelled) { await rebindSession(); }
- The prompt command responds after preflight with disposition started|queued|handled; later failures appear only in the event stream.
  - evidence: CA/src/modes/rpc/rpc-mode.ts:394-414 — void session.prompt(command.message, { images, streamingBehavior, source: "rpc", preflightResult: (disposition) => { preflightSucceeded = true; output(success(id, "prompt", { disposition })); } }).catch((e) => { if (!preflightSucceeded) { output(error(id, "prompt", e.message)); } });
- RpcClient spawns the literal executable "node" and has no option to change it.
  - evidence: CA/src/modes/rpc/rpc-client.ts:94-98 — const childProcess = spawn("node", [cliPath, ...args], { cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: ["pipe", "pipe", "pipe"] });
- A host-written child entry can embed inline extensions and still speak the stock RPC protocol because createAgentSessionServices/createAgentSessionFromServices/createAgentSessionRuntime/runRpcMode are public exports.
  - evidence: CA/src/index.ts:251-264,433 — AgentSessionRuntime, … createAgentSession, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, … runRpcMode; CA/src/main.ts:752-797 — createAgentSessionServices({ cwd, agentDir, settingsManager, …, resourceLoaderOptions: { additionalExtensionPaths, …, extensionFactories } })
- The ./rpc-entry bundle sets process markers and calls main(["--mode","rpc", ...argv]).
  - evidence: CA/src/rpc-entry.ts:6-13 — process.title = `${APP_NAME}-rpc`; process.env.PI_CODING_AGENT = "true"; process.env.AI_AGENT = "pi"; process.emitWarning = (() => {}) …; configureHttpDispatcher(); main(["--mode", "rpc", ...process.argv.slice(2)]);
- JSON mode writes the session header first, streams events, and a failed/aborted assistant response does not change the exit code (text mode does).
  - evidence: CA/src/modes/print-mode.ts:122-127,139-159 — if (mode === "json") { const header = session.sessionManager.getHeader(); if (header) writeRawStdout(`${JSON.stringify(header)}\n`); } … if (mode === "text") { … if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") { … exitCode = 1; }
- Without a bound UI context ctx.hasUI is false and ctx.ui.notify is a no-op.
  - evidence: CA/src/core/extensions/runner.ts:331-335,628-630 — const noOpUIContext: ExtensionUIContext = { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {}, … }; hasUI(): boolean { return this.uiContext !== noOpUIContext; }
- At most two codemode workers may be alive across all sessions in one pi process, each with a 256 MB VM.
  - evidence: CA/docs/codemode.md:226,228 — A script's VM has 256 MB of memory. … At most two codemode workers may be alive across all sessions in one pi process.
- PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR are the agent-dir and session-dir overrides, derived from the app name.
  - evidence: CA/src/config.ts:585-586,605-611 — export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`; export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`; … const envDir = process.env[ENV_AGENT_DIR]; … return join(homedir(), CONFIG_DIR_NAME, "agent");
- entry_appended is emitted only for extension appendEntry() and recovery context edits, so a host mirroring the session cannot rely on it for every entry.
  - evidence: CA/docs/json.md:122 — `entry_appended` | `entry` | An extension appended a custom session entry through `pi.appendEntry()`.; CA/src/core/agent-session.ts:1252-1254 — const editId = this.sessionManager.appendContextEdit(targetId, null); … this._emit({ type: "entry_appended", entry });

## RISKS
- PI-spawned stdio MCP servers inherit PI's entire environment ({...process.env, ...env}); Acabox today uses an allowlist (hostedEnv.ts) so provider API keys never reach a hosted server — mapping host-owned servers onto McpStdioServerConfig without a custom transport or a scrubbed child environment regresses that boundary.
- OAuth tokens for remote MCP connectors are written in plaintext to <agentDir>/mcp-auth.json (mode 0600) by the stock extension; the custom-backend hook (McpOAuthCredentialStore(backend)) is not reachable through the package's exports map, so an encrypted-at-rest store needs an absolute-path deep import or a fork.
- Every new_session/switch_session/fork in an RPC process emits session_shutdown then session_start, closing and respawning all MCP connections (stdio children included); a one-process-per-app design that switches sessions per chat will churn host servers on every chat switch.
- RpcClient hard-codes spawn("node", …); in a packaged Electron app Acabox must write its own spawner using process.execPath with ELECTRON_RUN_AS_NODE=1 (the measured-working route) — the shipped client cannot be used as-is.
- PI declares engines node >=22.19.0 while Electron 37 bundles 22.17.0; it was measured to run, but any PI update may start using a 22.19+ API with no warning.
- There is no structured MCP status/health event on the SDK stream or RPC; a host UI like Acabox's Connectors page can only parse notify text, run `pi mcp list --json` out of session, or (in-process) poll pi.getAllTools() for mcp__ tools — all weaker than today's observed-status model.
- In JSON/print mode and in any session without a bound uiContext, ctx.ui.notify is silently dropped and MCP sign-in is refused; MCP problems reported at startup would vanish unnoticed if Acabox drove PI that way.
- Compaction uses the chat's current model (e.g. Opus-class) for summarization with up to 0.8×reserveTokens output; a cheaper summarizer requires a host extension implementing session_before_compact.
- If the host process dies between an assistant message_end with tool calls and the tool results, the JSONL ends with dangling tool calls; how PI repairs that on resume was not read, so a crash-mid-tool-call could leave a chat that providers reject until repaired.
- A session whose stored cwd no longer exists is refused in RPC/JSON mode (MissingSessionCwdError) unless the host passes cwdOverride, which the RPC switch_session command does not expose — moving/renaming the Acabox workspace directory would strand sessions unless opened through the SDK or importFromJsonl.
- Session listing reads every JSONL in the directory in full and concatenates all message text into allMessagesText; with hundreds of megabyte-scale chats this is a heavy operation each time the host lists sessions.
- Codemode (the default exposure for MCP servers) is capped at two live QuickJS workers per process; an in-process design hosting many concurrent AgentSessions will queue or fail scripts beyond that.
- Only the first prompt waits (10 s) for servers with direct exposure; codemode/deferred servers are waited for lazily, so tools from slow or OAuth-pending servers may be absent from a turn without any error surfacing to the host.
- The mcp.json file format and the config dir are shared with any stand-alone pi install on the same machine unless PI_CODING_AGENT_DIR is pointed at Acabox's userData — otherwise Acabox would read/write the user's personal ~/.pi/agent/mcp.json and mcp-auth.json.

## UNKNOWNS
- How PI treats a resumed transcript whose last entry is an assistant message with tool calls but no tool results (crash between message_end and tool results) — not read; pi-ai's normalizeContext may or may not synthesize missing tool results.
- Whether a `/reload` slash command (needed after editing mcp.json) is dispatchable through the RPC `prompt` command; get_commands excludes built-in TUI commands and I did not find where /reload is registered.
- Whether createAgentSession (SDK, in-process) itself calls configureHttpDispatcher()/sets undici's global dispatcher; only the CLI entries (main.ts:598, rpc-entry.ts:11) were seen doing so — relevant to side effects on Electron main's global fetch.
- Whether dist/bundle/rpc-entry.js is fully self-contained or still resolves packages from node_modules at runtime (the 148 MB dependency tree vs the 8.9 MB bundle) — not measured.
- Memory footprint of one `pi --mode rpc` process and of one in-process AgentSession — not measured.
- Exact composition of `builtInExtensions` in main.ts (I relied on sdk.md:116 stating codemode, tool_search and MCP are the built-ins) and the discovered extension/skill directory layout (configuration.md was not read).
- Whether a CJS webpack main bundle can dynamic-import the ESM-only pi-coding-agent in Electron's Node 22.17 without bundler changes — inferred feasible, not measured.
- How openBrowser (utils/open-browser.ts) opens URLs on macOS when running under Electron with ELECTRON_RUN_AS_NODE=1 (likely the `open` command) — not read.
- Typical real-world session file sizes (I did not read ~/.pi); only the per-call truncation limits (50 KB bash/read, 20 KB MCP text) are known.
- Whether StreamableHttpTransport's 401 handling interacts correctly with servers that require OAuth on the initial GET stream before initialize (openGetStream true by default) — not traced end to end.
# PI 1.2.0 authentication, credential storage, provider & model registry — reader report for Acabox PI

Path prefixes used below:
- `PI` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-src/pi` (monorepo clone)
- `PKG` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-pkg/node_modules/@earendil-works` (published 1.2.0)
- My scratch probes: `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/work-auth-reader/{probe.mjs,probe2.mjs,probe3.mjs}` (run with `ELECTRON_RUN_AS_NODE=1` Electron 37 / Node 22.17.0, `env -i`, `PI_CODING_AGENT_DIR` pointed at an empty scratch dir that stayed empty).

Everything marked **MEASURED** was executed; everything else is READ from the files cited; **INFERRED** is flagged.

---

## 0. The actual architecture (differs from the task's assumptions — code wins)

The task text named `auth/index.ts` and `auth/load.ts`. The real layout is:

- `PI/packages/ai/src/auth/types.ts` — all auth contracts
- `PI/packages/ai/src/auth/resolve.ts` — resolution + locked OAuth refresh
- `PI/packages/ai/src/auth/credential-store.ts` — `InMemoryCredentialStore`
- `PI/packages/ai/src/auth/context.ts` — `defaultProviderAuthContext()` (env + file lookup)
- `PI/packages/ai/src/auth/helpers.ts` — `envApiKeyAuth()`, `lazyOAuth()`
- `PI/packages/ai/src/auth/oauth/{anthropic,openai-chatgpt,openai-codex,openrouter,github-copilot,kimi-coding,meta,xai,radius,callback-server,device-code,pkce,load}.ts`

**Core model.** A `Provider` (`PI/packages/ai/src/models.ts:155-244`) owns `auth: ProviderAuth` plus its models and stream implementation. A `Models` collection (`createModels()` `models.ts:998`) holds providers and resolves auth per request through a pluggable `CredentialStore`. The coding-agent's `ModelRuntime` (`PI/packages/coding-agent/src/core/model-runtime.ts:174`) is a `Models` implementation that registers all built-ins, overlays `models.json`, pi.dev catalogs, OpenRouter personalization, extensions and virtual models. `ModelRegistry` (`core/model-registry.ts:48`) is only a synchronous facade over `ModelRuntime` for extensions (`"Synchronous compatibility facade exposed to extensions. Coding-agent internals use ModelRuntime directly."` line 45-46). **Plan against `ModelRuntime` (or raw `createModels`), not `ModelRegistry`.**

`ProviderAuth` (`auth/types.ts:252-255`):
```ts
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
```
`OAuthAuth` (`auth/types.ts:221-245`):
```ts
export interface OAuthAuth {
	name: string;
	isSubscription?: boolean;
	loginLabel?: string;
	login(interaction: ProviderAuthInteraction, options?: LoginOptions): Promise<OAuthCredential>;
	refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}
```
`ApiKeyAuth` (`auth/types.ts:170-199`): `name`, optional `login(interaction)` (prompts `{type:"secret"}`), optional side-effect-free `check({ctx, credential, signal})`, and `resolve({ctx, credential, signal}) => AuthResult|undefined`.

Package subpath exports (`PKG/pi-ai/package.json`, MEASURED via probe3): `.`, `./models`, `./compat`, `./providers/*`, `./api/*`, `./utils/*`, `./oauth`, `./bedrock-provider`, `./bun-oauth`. `./auth/*` is **not** exported: `import("@earendil-works/pi-ai/auth/oauth/openai-chatgpt")` → `ERR_PACKAGE_PATH_NOT_EXPORTED`. The flows are reached through `provider.auth.oauth` (lazy wrappers), which is what you want anyway. The main index re-exports the auth types/helpers (`PI/packages/ai/src/index.ts:21-24`: `export * from "./auth/context.ts"; "./auth/credential-store.ts"; "./auth/helpers.ts"; "./auth/types.ts"`) and `models.ts`.

`@earendil-works/pi-coding-agent` exports only `.` and `./rpc-entry` (`PKG/pi-coding-agent/package.json`). From `.` (MEASURED, `PKG/pi-coding-agent/dist/index.d.ts:2,4,13,15,28`): `getAgentDir`, `readStoredCredential`, `ModelRegistry`, `ModelRuntime`, `CreateModelRuntimeOptions`, `CredentialSynchronizationError`, `VirtualModelDefinition`, `createAgentSession`, `SettingsManager`. **`AuthStorage`, `ReadOnlyAuthStorage`, `FileAuthStorageBackend`, `InMemoryAuthStorageBackend` are NOT exported** (`typeof ca.AuthStorage === "undefined"`), and `import("@earendil-works/pi-coding-agent/dist/core/auth-storage.js")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Acabox therefore implements the pi-ai `CredentialStore` interface itself (measured to work, §4).

**Bundling hazard.** OAuth flow modules are loaded through a variable-specifier dynamic import so bundlers cannot follow it (`auth/oauth/load.ts:9-12`):
```ts
const importOAuthModule = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};
```
MEASURED: under Electron's Node with the unbundled package, `openai.auth.oauth.toAuth(...)` lazily loaded `openai-chatgpt.js` fine. If Acabox webpack-bundles pi-ai into an agent-server bundle (as it does the Claude SDK today), the dynamic import will not resolve. The escape hatch is `registerBunOAuthFlows()` from `@earendil-works/pi-ai/bun-oauth` (`PI/packages/ai/src/bun-oauth.ts:13-25`), which statically imports every flow and calls `registerBundledOAuthFlowLoaders({anthropic, openaiCodex, openaiChatGPT, githubCopilot, openrouter, kimiCoding, meta, xai, radius})` (`load.ts:29-31`); pi's own bundled binary does exactly this (`PI/packages/coding-agent/src/bun/runtime-setup.ts:2,10`; coding-agent CHANGELOG.md:342 "Fixed `/login` with OpenAI failing in the bundled release with a missing `openai-chatgpt.js` module error"). MEASURED: `import("@earendil-works/pi-ai/bun-oauth")` exports `registerBunOAuthFlows` under Electron.

---

## 1. Running OAuth logins headlessly from Electron main (no TUI)

### 1.1 The one entry point

`Models.login` / `ModelRuntime.login` (`PI/packages/ai/src/models.ts:316`, `core/model-runtime.ts:826-838`):
```ts
login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;
```
`AuthType = "api_key" | "oauth"` (`auth/types.ts:117`). `Models.login` (`models.ts:768-823`): looks up `provider.auth.oauth` or `provider.auth.apiKey`, throws `ModelsError("auth", "<name> does not support <type> login")` if absent, runs `method.login({ ...interaction, signal }, options)` raced against the signal, then persists with `this.credentials.modify(providerId, async () => credential, { signal })` and returns the credential. `ModelRuntime.login` additionally serializes per provider (`enqueueCredentialOperation`) and then `synchronizeCredentialState` (recompose provider, `models.refresh({allowNetwork:false, providers:[id]})`, availability refresh); a failure there throws `CredentialSynchronizationError` whose `.credential` holds the already-committed credential (`model-runtime.ts:138-154`).

### 1.2 The interaction callbacks you implement

`auth/types.ts:125-164` (verbatim):
```ts
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);
export interface AuthInfoLink { url: string; label?: string; }
export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "progress"; message: string };
export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };
```
Contract notes from the doc comments: `prompt()` returns the entered/selected string (`select` returns the option **id**), rejects on cancel; `interaction.signal` aborts the whole flow; `AuthPrompt.signal` is per-prompt and is aborted when the callback server wins the race (`"a manual_code prompt raced against a callback server, aborted when the callback wins"`, lines 119-124).

How the TUI implements it, for parity (`PI/packages/coding-agent/src/modes/interactive/interactive-mode.ts:6319-6350`): `notify` → `auth_url` opens/display URL, `device_code` shows code, `info`, else progress; `prompt` → `select` renders a selector, `manual_code` a text input, otherwise a text/secret prompt; passes `{ getDeviceId: () => this.settingsManager.getOrCreateDeviceId() }` as `LoginOptions` (line 6347). It never passes `agentName`.

**Headless driver shape for Electron main (MEASURED working in probe2):**
```ts
const ac = new AbortController();
const credential = await runtime.login("openai", "oauth", {
  signal: ac.signal,
  notify: (ev) => { if (ev.type === "auth_url") shell.openExternal(ev.url); /* progress/info → UI */ },
  prompt: async (p) => {
    if (p.type === "manual_code") return await waitForUserPaste(p);     // reject when p.signal aborts
    if (p.type === "select") return p.options[0].id;                       // or ask the user
    if (p.type === "secret" || p.type === "text") return await askUser(p);
    throw new Error("unsupported prompt");
  },
}, { getDeviceId: () => acaboxDeviceUuid, agentName: "Acabox" });
```
The `manual_code` promise **must stay pending** until the user pastes or `p.signal` fires: the flow races it against the loopback callback (`openai-chatgpt.ts:272-283`, generic `waitForCallbackOrManualInput` `callback-server.ts:155-183`). If you resolve it immediately with "", the flow fails with "Paste the full callback URL from the browser" / "Missing authorization code".

**Cancellation (MEASURED):** aborting `interaction.signal` after `auth_url` made `ModelRuntime.login` reject with a `DOMException` ("This operation was aborted"), not `Error("Login cancelled")` — `Models.login` races the flow against the signal (`models.ts:782-783 raceWithAbortSignal(loginOperation, signal)`) and the signal's reason wins. Treat both an AbortError and `message === "Login cancelled"` as user cancel. The callback server is closed in the flow's `finally` (`openai-chatgpt.ts:288-297`).

### 1.3 Sign in with ChatGPT — `PI/packages/ai/src/auth/oauth/openai-chatgpt.ts`

Constants (lines 16-29, verbatim):
```ts
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME_HINT = "Pi";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh this long before the real expiry so a request never starts with a token about to expire.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;
```
Flow `loginOpenAIChatGPT(interaction, options)` (lines 233-298):
1. `agentHostId(options?.getDeviceId?.())` (226-231): requires a UUID, returns `urn:uuid:<lowercased>`; otherwise throws `"Sign in with ChatGPT requires a device ID (UUID) for this installation"` — **MEASURED: thrown before any server bind or network call** when `getDeviceId` is omitted.
2. PKCE (`pkce.ts:21-34`, Web Crypto S256), `state` and `nonce` = 32 random bytes base64url.
3. `startCallbackServer(state)` (85-132) binds `127.0.0.1:1455` **before** showing the URL; `EADDRINUSE` is rewritten to `"Port 1455 is in use, probably by an unfinished login in another pi session or by the Codex CLI. Cancel that login and try again."` (243-248). No port fallback: the redirect URI is fixed. The server answers only `/auth/callback`; `?error=` → HTTP 400 + reject; success → 200 page "ChatGPT authentication completed. You can close this window."; the callback query must carry `code`, `state` (must equal ours) **and `client_id`** (the dynamically issued client id — "every login registers a new client with this ID; OpenAI returns the issued client ID in the callback", line 15; `authorizationResultFromCallback` 53-62).
4. Authorization URL (251-263). **MEASURED** with `agentName: "Acabox"` and a device id:
   `https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&agent_name_hint=Acabox&ext_agent_host_id=urn:uuid:123e4567-e89b-12d3-a456-426614174000&response_type=code&redirect_uri=http://127.0.0.1:1455/auth/callback&resource=https://api.openai.com/v1&scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct&state=…&code_challenge=…&code_challenge_method=S256&nonce=…`
   `notify({type:"auth_url", url, instructions:"Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here."})` (265-270).
5. Races the callback against `prompt({type:"manual_code", message:"Complete login in your browser, or paste the final redirect URL here:", placeholder: REDIRECT_URI, signal: AbortSignal.any([manualAbort.signal, interaction.signal])})` (272-283). A pasted value must be the full callback URL with same origin+path (`authorizationResultFromManualInput` 64-78).
6. `notify({type:"progress", message:"Exchanging authorization code for tokens..."})`, then `exchangeAuthorizationCode(code, verifier, clientId, signal)` (183-206): `POST TOKEN_URL` form `grant_type=authorization_code&client_id=<issued>&code&code_verifier&redirect_uri=<REDIRECT_URI>&resource=https://api.openai.com/v1`; requires `id_token` present ("Pi does not use the ID token to identify the user", 201-204).
7. `credentialFromTokenResponse` (162-181) → stored credential:
```ts
return { type: "oauth", access, refresh, expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS, clientId, scopes };
```
   It throws if `scope` lacks `chatgpt.tokens.use.direct`.
8. `finally`: `manualAbort.abort(); callback.server.close(); callback.server.closeAllConnections();` (288-297).

Refresh `refreshAccessToken(credential, signal)` (208-223): needs `credential.clientId` (else `"Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT"`), `POST TOKEN_URL` form `grant_type=refresh_token&client_id=<clientId>&refresh_token&resource`; returns a whole new credential (new access **and refresh**, same clientId). MEASURED: an expired credential with a bogus `clientId` triggered a real request to `auth.openai.com` → `400 {"error":"invalid_client"}` surfaced as `ModelsError` `code === "oauth"`, message `"OAuth refresh failed for openai: OpenAI OAuth token request failed (400): …"`. Note this happened with `PI_OFFLINE=1` set — that flag only gates catalog refreshes (`model-runtime.ts:247`), not token refresh.

`toAuth` → `{ apiKey: credential.access }` (306-308). Exported object (300-310): `name: "OpenAI (ChatGPT subscription)", isSubscription: true, loginLabel: "Sign in with ChatGPT"`.

**Where the credential is used.** Provider `openai` (`PI/packages/ai/src/providers/openai.ts:9-35`): `baseUrl: "https://api.openai.com/v1"`, `auth.apiKey = envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"])`, `auth.oauth = lazyOAuth({ name:"OpenAI (ChatGPT subscription)", isSubscription:true, loginLabel:"Sign in with ChatGPT", load: loadOpenAIChatGPTOAuth })`, `api: openAIResponsesApi()` — i.e. the **normal Responses API** at `api.openai.com/v1/responses`, access token sent as the OpenAI SDK's bearer `apiKey`. `filterAllModels` (27-29): with an oauth credential, classifier models are removed ("Sign in with ChatGPT tokens only reach the Responses API; the Decisions API rejects them"). MEASURED: `getAllAvailable("openai")` with an oauth credential = 44 chat models, 0 classifiers.

ChatGPT-specific request handling in `PI/packages/ai/src/api/openai-responses.ts`:
```ts
function isChatGPTSignIn(model, apiKey) {  // lines 42-49
	return model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" && apiKey !== undefined && !apiKey.startsWith("sk-");
}
```
- `getConfigurationUpdateEffort` returns undefined for ChatGPT sign-in: "Sign in with ChatGPT rejects configuration_update items" (102-113) → reasoning effort is sent as `reasoning.effort` instead.
- `buildParams` (355-371): `store: false` always; `prompt_cache_key` kept; `prompt_cache_retention`, `prompt_cache_options`, `max_output_tokens`, `temperature` are **omitted** for ChatGPT sign-in ("Sign in with ChatGPT rejects these request fields").
- Headers (`createClient` 288-330): `"User-Agent": getPiUserAgent()`, `...model.headers`, `session_id`/`x-client-request-id` when `sessionId` is set, caller `options.headers` last; auth header is set by `new OpenAI({ apiKey, baseURL: model.baseUrl, defaultHeaders })`. **No `originator`, no `ChatGPT-Account-Id` header on this path.**
- Subscription errors: `"subscription_sharing_usage_limit_exceeded"` → message appends `Check your ChatGPT usage: https://chatgpt.com/settings/usage` (255-258; ai CHANGELOG:179 "Subscription usage-limit errors are not retried … temporary usage errors are retried").

**Models through ChatGPT sign-in.** The catalog is the full `openai` chat list (`PKG/pi-ai/dist/providers/data/openai.json`, 44 `openai-responses` entries + 1 classifier); pi only filters by type, so **which of these OpenAI actually serves to a subscription token is unknown to pi (INFERRED: expect refusals on some)**. Default for `openai` is `gpt-5.5` (`core/model-resolver.ts:24`); `gpt-6.1-sol` is the default for `openai-codex` (line 26; coding-agent CHANGELOG:338). Catalog highlights (id · ctx · maxTok · $/M in/out/cacheRead/cacheWrite · thinking levels as produced by `getSupportedThinkingLevels`, MEASURED for two):
- `gpt-5.5` 272000 / 128000 · 5/30/0.5/0 (+tier >272K: 10/45/1/0) · MEASURED `["off","low","medium","high","xhigh"]`
- `gpt-6.1-sol` 272000 / 128000 · 2/10/0.1/2.5 (+tier 4/15/0.2/5) · MEASURED `["low","medium","high","xhigh","max"]` (no "off")
- `gpt-6-sol` 2/10/0.2/2.5; `gpt-6-astra` 10/50/1/12.5 (no "off"); `gpt-6-luna` 0.1/0.5/0.01/0.125; `gpt-5.6-luna` 0.2/1.2; `gpt-5.6-sol` 4/20; `gpt-5.6-terra` 2/12; `gpt-5.4` 2.5/15; `gpt-5.4-mini` 0.75/4.5 (400K ctx); `gpt-5.4-nano` 0.2/1.25; `gpt-5.4-pro` 30/180 (1.05M ctx); `gpt-5.5-pro` 30/180; `gpt-5`, `gpt-5-mini`, `gpt-5-nano` (400K, minimal..high); `gpt-4.1*` (1,047,576 ctx); `gpt-4o*`; `o1`, `o3`, `o3-mini`, `o3-pro`, `o4-mini`; `gpt-daybreak-*-latest`; `gpt-realtime-2.1`; plus classifier `gpt-6-luna` (openai-decisions, API key only).
Catalog generation stamp: `.manifest.json generatedAt 2026-10-12T22:50:30.032Z`.

### 1.4 `openai` (new) vs `openai-codex (legacy)`

| | `openai` + Sign in with ChatGPT | `openai-codex` (legacy) |
|---|---|---|
| Provider file | `providers/openai.ts:9-35` | `providers/openai-codex.ts:7-22` |
| Name | "OpenAI" | "OpenAI Codex (legacy)" |
| Base URL | `https://api.openai.com/v1` | `https://chatgpt.com/backend-api` (requests go to `<base>/codex/responses`, `api/openai-codex-responses.ts:642-648`) |
| API family | `openai-responses` | `openai-codex-responses` (SSE or WebSocket; `OpenAI-Beta: responses_websockets=2026-02-06`, line 866; `transport` option sse/websocket/websocket-cached/auto) |
| Auth methods | API key (`OPENAI_API_KEY`) **and** OAuth | OAuth only (MEASURED `hasApiKeyAuth: false`) |
| OAuth flow | `auth/oauth/openai-chatgpt.ts`; dynamic client `dynamic_agent_client`; scopes incl. `chatgpt.tokens.use.direct`; redirect `http://127.0.0.1:1455/auth/callback`; fails hard on port in use | `auth/oauth/openai-codex.ts`; fixed `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` (line 22); `https://auth.openai.com/oauth/authorize` + `/oauth/token`; scope `openid profile email offline_access`; extra params `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<agentName ?? "pi">` (289-308); redirect `http://localhost:1455/auth/callback`; **first prompts a `select`** between `browser` and `device_code` (413-431); device flow via `/api/accounts/deviceauth/usercode` + `/deviceauth/token`, verification `https://auth.openai.com/codex/device`, 15 min timeout (27-31); falls back to manual paste if port taken (364-373) |
| Credential extras | `clientId`, `scopes`; `expires` = server − 3 min | `accountId` from JWT claim `https://api.openai.com/auth`.`chatgpt_account_id` (310-330); `expires` = server, no margin |
| Request headers | SDK bearer + `User-Agent`; **no** originator/account id | `originator: "pi"` (overridable by model/caller headers), `User-Agent`, `Authorization: Bearer <access>`, `chatgpt-account-id: <accountId re-extracted from the JWT>` (`buildBaseCodexHeaders` 1641-1662) |
| Models | 44 (openai.json) | 9 (openai-codex.json): `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.6-luna/sol/terra`, `gpt-6-astra/luna/sol`, `gpt-6.1-sol`; MEASURED codex `gpt-6.1-sol` levels `["minimal","low","medium","high","xhigh","max"]` |
| Status | current (ai CHANGELOG:179) | "Renamed … (legacy); Sign in with ChatGPT on the `openai` provider supersedes it." (ai CHANGELOG:185, coding-agent CHANGELOG:384) |

Note (INFERRED): because `isChatGPTSignIn` keys on `!apiKey.startsWith("sk-")`, any non-`sk-` value routed to `api.openai.com/v1` is treated as a ChatGPT token (fields omitted); a proxy or project key not starting with `sk-` would get the reduced request shape.

### 1.5 `LoginOptions` and device-id persistence

`auth/types.ts:202-214`:
```ts
export interface LoginOptions {
	/** Returns the stable ID of this app installation, e.g. sent to OpenAI as its agent host ID. Called only by login flows that need it, so apps can create the ID on first use and must return the same ID on every later call. */
	getDeviceId?: () => string;
	/** Name this app introduces itself with during login, e.g. OpenAI's agent name hint and Codex originator. Defaults to pi's own name. */
	agentName?: string;
}
```
pi persists it in global `settings.json` (`core/settings-schema.ts:310-314`: `deviceId: "Stable installation UUID, generated when authentication first needs it. Global only."`), created by `SettingsManager.getOrCreateDeviceId()` (`core/settings-manager.ts:1082-1089`: `randomUUID()`, `markModified("deviceId")`, `save()`; "Project settings are ignored so a committed project settings file cannot give every clone the same ID"), stripped from bug reports (`core/bug-report.ts:62`). Acabox should mint one UUID per install, keep it in its own settings store, and pass `{ getDeviceId, agentName: "Acabox" }`.

### 1.6 Shared loopback callback helper (other flows)

`auth/oauth/callback-server.ts:12-43` `startOAuthCallbackServer({ providerName, host, port, path, redirectHost?, state?, complete, signal?, timeoutMs? })` → `{ redirectUri, wait(), cancel(), close() }`; `port: 0` picks a free port; `complete(code)` runs **before** the browser page is sent so exchange errors show in the browser; `timeoutMs` → "`<provider> sign-in timed out`". Used by anthropic/openai-codex/openrouter/… The ChatGPT flow has its **own** server (no timeout) in `openai-chatgpt.ts`.

Device-code polling helper `auth/oauth/device-code.ts:46-98` (`pollOAuthDeviceCodeFlow`, RFC 8628 slow_down handling). `PI_OAUTH_CALLBACK_HOST` env changes the bind host for all flows (redirect URIs stay `127.0.0.1`/`localhost`).

---

## 2. Anthropic

### 2.1 OAuth flow (`auth/oauth/anthropic.ts`) — document only, do NOT expose
- `CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")` (line 14) = `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (base64-decoded by me; this is the Claude Code client id).
- `AUTHORIZE_URL = "https://claude.ai/oauth/authorize"`, `TOKEN_URL = "https://platform.claude.com/v1/oauth/token"` (15-16); preferred `CALLBACK_PORT = 53692`, path `/callback`, redirect `http://localhost:53692/callback`, falls back to a free port then to manual paste (142-158); copy-code variant redirects to `https://platform.claude.com/oauth/code/callback` (23, 200-235); `SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"` (26-27); authorize params include `code: "true"`, `state: verifier` (160-170); `login` first prompts `select` browser/copy_code (282-300); `expires = now + expires_in*1000 − 5 min` (137, 275); `toAuth` → `{ apiKey: access }`.
- Request side (`api/anthropic-messages.ts`): `isOAuthToken(apiKey) = apiKey.includes("sk-ant-oat")` (1014-1016) → `authToken` bearer client with headers `"user-agent": claude-cli/<claudeCodeVersion>`, `"x-app": "cli"` (1050-1069), betas `"claude-code-20250219", "oauth-2025-04-20"` (1142), and the system prompt is forced to begin with `"You are Claude Code, Anthropic's official CLI for Claude."` (1227-1241), tool names remapped via `toClaudeCodeName` (1392, 1481, 1654). This impersonates Claude Code; the planner's decision to not expose it stands.

### 2.2 API-key path (what Acabox exposes)
`providers/anthropic.ts:19-72` `anthropicApiKeyAuth()`:
```ts
resolve: async ({ ctx, credential, signal }) => {
	if (credential?.key) return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
	const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
	if (authToken) return { auth: { headers: { Authorization: `Bearer ${authToken}` } }, source: ANTHROPIC_AUTH_TOKEN_ENV };
	for (const envVar of [ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]) { const apiKey = await ctx.env(envVar); if (apiKey) return { auth: { apiKey }, source: envVar }; }
	// workload identity federation: ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID + ANTHROPIC_IDENTITY_TOKEN_FILE (all required), optional ANTHROPIC_SERVICE_ACCOUNT_ID, ANTHROPIC_WORKSPACE_ID → { auth: {}, env: federation, source: "workload identity federation" }
```
Meaning of the env vars (`env-api-keys.ts:29-36, 79-82, 156`; docs `providers.md:67-69`):
- `ANTHROPIC_API_KEY` — ordinary key, sent as `x-api-key`.
- `ANTHROPIC_OAUTH_TOKEN` — "recognized as an API credential": handed to the messages API as `apiKey`; if its value contains `sk-ant-oat` the client switches to the bearer/Claude-Code-identity path above.
- `ANTHROPIC_AUTH_TOKEN` — "bearer authentication": becomes an `Authorization: Bearer` header (header-owned auth, no `x-api-key`); `getEnvApiKey()` deliberately skips it (`env-api-keys.ts:79-80, 156`).
Provider: `id "anthropic"`, `baseUrl "https://api.anthropic.com"`, `api: anthropicMessagesApi()` (`providers/anthropic.ts:74-90`). Default model `claude-opus-4-8` (`model-resolver.ts:23`).

Catalog (`anthropic.json`, 17 chat models; $/M in/out/cacheRead/cacheWrite): `claude-opus-5-5` 1M/128K 4/20/0.2/5 (levels low..max); `claude-sonnet-5-5` 1M/128K 2/10/0.1/2.5 (MEASURED `["low","medium","high","xhigh","max"]`); `claude-haiku-5-5` 1M/128K 0.1/0.5/0.01/0.125 (+tier >100K: 0.5/2.5); `claude-fable-5-1` 1M 10/50/0.25/12.5; `claude-fable-5` 10/50/1/12.5; `claude-opus-5` 5/25; `claude-opus-4-8`, `-4-7`, `-4-6` 1M 5/25; `claude-opus-4-5(-20251101)` 200K 5/25; `claude-sonnet-5` 1M 2/10/0.2/2.5; `claude-sonnet-4-6` 1M 3/15; `claude-sonnet-4-5(-20250929)` 200K 3/15; `claude-haiku-4-5(-20251001)` 200K 1/5.

---

## 3. OpenRouter

- Provider (`providers/openrouter.ts:62-88`): `id "openrouter"`, `baseUrl "https://openrouter.ai/api/v1"`, `auth.apiKey = envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"])`, `auth.oauth = lazyOAuth({ name:"OpenRouter OAuth", loginLabel:"Sign in with OpenRouter", load: loadOpenRouterOAuth })` (not `isSubscription`); APIs `{"anthropic-messages", "openai-completions"}` keyed by model, images `"openrouter-images"`, classifiers `"typesafe-system-one"`. MEASURED: 393 chat models (16 anthropic-messages + 377 openai-completions), plus 61 image and 21 classifier models in the shipped catalog.
- **OAuth/PKCE exists** (`auth/oauth/openrouter.ts`): `AUTHORIZE_URL = "https://openrouter.ai/auth"`, `TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys"` (19-20), `LOGIN_TIMEOUT_MS = 5 min`, ephemeral port (`port: 0`) and random path `/oauth/callback/<uuid>` because "OpenRouter sends no `state`" (115-124); authorize params `callback_url`, `code_challenge`, `code_challenge_method=S256`; exchange `POST {code, code_verifier, code_challenge_method:"S256"}` returns a **permanent API key**, stored as `{ type:"oauth", access: body.key, refresh: "", expires: Number.MAX_SAFE_INTEGER }` (105-110); `refresh` returns the credential unchanged (163-165). So the "oauth" credential is just a key; `toAuth` → `{ apiKey: access }`.
- **`/models/user`** (`personalizeOpenRouterCatalog`, `providers/openrouter.ts:24-60`): `GET <baseUrl>/models/user` with `authorization: Bearer <key>` (key from `credential.access` for oauth or `credential.key`), 15 s timeout; `401/403/404` → catalog unchanged; otherwise chat models are filtered to the ids returned, with `contextWindow = top_provider.context_length || context_length || catalog`, `maxTokens = top_provider.max_completion_tokens || catalog`, `cost = openRouterCost(pricing)` ($/token → $/M, prompt-length overrides become tiers; `openrouter-api.ts:50-77`). Wired by `ModelRuntime.create` via `withPersonalizedCatalog` (`model-runtime.ts:230-239`; `remote-catalog-provider.ts:195-240`), persisted to the models store; runs only on a network refresh (`ModelRuntime.create({ allowModelNetwork: true })` or `runtime.refresh({ allowNetwork: true, providers: ["openrouter"] })`); docs `providers.md:120-134` (regional base URLs, proxy fallback to the full list).
- **Provider routing**: `compat.openRouterRouting` on a model or provider in `models.json` (`providers/compat-schema.ts` ~lines 50-135; `OpenRouterRouting` type exported from `types.ts:40`): `require_parameters`, `data_collection: "allow"|"deny"`, `zdr`, `enforce_distillable_text`, `order[]`, `only[]`, `ignore[]`, `quantizations[]`, `sort` (string or `{by, partition}`), `max_price {prompt, completion, image, audio, request}`, `preferred_min_throughput`, … Also `compat.sessionAffinityFormat` auto-detects `"openrouter"` → `x-session-id` header (`openai-responses.ts:66-68, 306-308`).
- Default model `moonshotai/kimi-k2.6` (`model-resolver.ts:33`).

---

## 4. Credential storage

### 4.1 `CredentialStore` — the interface Acabox implements (`auth/types.ts:50-94`, verbatim)
```ts
export interface CredentialStore {
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;
	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined>;
	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}
```
Doc contract (lines 50-63): "`modify` is the only write path, so every mutation is a serialized read-modify-write; `Models.getAuth()` runs OAuth refresh inside `modify` so concurrent requests cannot double-refresh a rotated token. The app persists a credential after login via `modify(provider.id, async () => credential)`. Login/logout orchestration is app-owned. … `read` resolves `undefined` for missing entries. Methods reject only on storage failure." `list` "must not execute configured API-key commands". `modify` needs "Mutual exclusion per provider id, cross-process too where the backing store supports it".

Credential shapes (`auth/types.ts:17-37`):
```ts
export interface ApiKeyCredential { type: "api_key"; key?: string; env?: ProviderEnv; }
export interface OAuthCredentials { refresh: string; access: string; expires: number; [key: string]: unknown; }
export interface OAuthCredential extends OAuthCredentials { type: "oauth"; }
export type Credential = ApiKeyCredential | OAuthCredential;
export interface CredentialInfo { providerId: string; type: Credential["type"]; }
```
Injection points: `createModels({ credentials, modelsStore, authContext })` (`models.ts:373-377, 404-408`) and `ModelRuntime.create({ credentials, authPath, modelsPath, modelsStore, modelsStorePath, allowModelNetwork, modelRefreshTimeoutMs, catalogBaseUrl, signal, refreshOnCreate })` (`model-runtime.ts:110-126`; `credentials` "Credential storage. Defaults to the file at authPath."). `ModelRuntime` wraps your store in `RuntimeCredentials` (`core/runtime-credentials.ts:13-52`), an in-memory overlay for `setRuntimeApiKey(providerId, key)` that is never persisted (`read` returns `{type:"api_key", key: override}` first; `modify` passes through to your store; `delete` clears both). `ModelRuntime` constructs `createModels({ credentials, modelsStore })` **without** an `authContext` (`model-runtime.ts:213`), so env-var fallback always reads `process.env` (`auth/context.ts:23-45`); to forbid env keys use `createModels({ authContext })` directly or scrub the env.

MEASURED (probe2): `ModelRuntime.create({ credentials: <subclass of InMemoryCredentialStore>, modelsPath: null, refreshOnCreate: true })` under Electron → 42 providers, `hasConfiguredAuth("anthropic") === true` from a stored key, `getProviderAuthStatus` `{configured:true, source:"stored"}`, `listCredentials()` lists it; `login("anthropic","api_key",…)` prompted `{type:"secret", message:"Enter Anthropic API key"}` and called `store.modify("anthropic")`; `logout` called `store.delete("anthropic")`; `setRuntimeApiKey("openrouter", …)` → status `{configured:true, source:"runtime"}` and 393 available models without touching the store; nothing was written to the scratch agent dir.

### 4.2 pi's file store (`core/auth-storage.ts`) — reference behaviour
- Path: `join(getAgentDir(), "auth.json")` (lines 64, 208, 348, 499; `config.ts:623-626 getAuthPath()`). Agent dir `getAgentDir()` (`config.ts:605-611`): env `ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\`` (`config.ts:585`) → **`PI_CODING_AGENT_DIR`** (confirmed in `docs/environment-variables.md:81`), else `~/<CONFIG_DIR_NAME>/agent` = `~/.pi/agent` (`CONFIG_DIR_NAME` from `package.json piConfig.configDir`, default `.pi`, line 581; `APP_NAME` from `piConfig.name`, default "pi", line 579 — a rebranded fork changes the env var name). `createAgentSession({ agentDir })` derives `authPath`/`modelsPath` only when `agentDir` is given (`core/sdk.ts:193-198`), but many modules call `getAgentDir()` directly (sessions, settings, models-store defaults), so **set `PI_CODING_AGENT_DIR` in the child process env** to relocate everything.
- Format: `Record<providerId, Credential>` JSON, pretty-printed, written with `mode: 0o600` (line 37) in a `0o700` dir (71), locked with `proper-lockfile` (sync `lockSync`, async with 30 s stale/deadline, EPERM retries on Windows; 81-156). Validation of an entry (`ReadOnlyAuthStorage.load` 229-253): `api_key` needs optional string `key` and optional string-map `env`; `oauth` needs string `access`, string `refresh`, finite number `expires`. Examples (docs `providers.md:75-81, 92-102`):
```json
{ "anthropic": { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" } }
{ "cloudflare-workers-ai": { "type": "api_key", "key": "...", "env": { "CLOUDFLARE_ACCOUNT_ID": "account-id" } } }
```
- `!command` resolver (`core/resolve-config-value.ts`): `isCommandConfigValue` (130-132) = leading `!`; `resolveConfigValue` (145-151) runs the rest via `execSync`/configured shell with a 10 s timeout and **caches stdout for the process lifetime** (`commandResultCache`, line 10; `executeCommand` 208-216); `$VAR`/`${VAR}` interpolation, `$$` → `$`, `$!` → `!` (138-144). `AuthStorage.read` applies it to `api_key.key` (443-448); `list()` does not (486-491). `models.json` values use the same syntax but uncached (`resolveConfigValueUncached` 221-227; docs `models.md:65`).
- Change detection: every `read` re-checks the file revision (`getFileRevision`) and reloads when another process changed it (402-441); `reload()` is manual (378-391).
- Source-only constructors: `AuthStorage.create(authPath?)`, `AuthStorage.fromStorage(backend)`, `AuthStorage.inMemory(data)` (348-361) — **not reachable from the published package** (see §0). `readStoredCredential(providerId, authPath?)` (497-507) **is** exported: a one-off sync raw read without `!command` resolution.

### 4.3 Precedence
Code (`auth/resolve.ts:27-32, 46-93`): request `overrides.apiKey` (from `options.apiKey`) → stored credential (`credentials.read`) → ambient (`apiKey.resolve` with no credential: env vars / AWS / ADC). "A stored credential owns the provider: ambient/env is consulted only when nothing is stored. No silent env fallback after a failed refresh or for a credential type without a matching handler." With `ModelRuntime`: runtime key overlay → stored → `models.json` `apiKey`/`!command` (`composeApiKeyAuth`, `provider-composer.ts:417-481`) → env/ambient. Docs `models.md:23` agree. `AuthStatus.source` values: `"stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command"` (`provider-composer.ts:110-114`).

### 4.4 "Events" when a credential changes or refreshes — there are none; `modify` is the hook
No emitter exists in `auth-storage.ts`, `model-runtime.ts` or `runtime-credentials.ts` (grep for emit/listener/onChange returned nothing). Persistence happens through your store:
- Login: `Models.login` → `credentials.modify(providerId, async () => credential)` (`models.ts:789-797`).
- Refresh: `refreshStoredOAuthCredential` (`auth/resolve.ts:119-155`) → `credentials.modify(providerId, async (current) => { if (current?.type !== "oauth") return undefined; if (!needsRefresh(current)) return undefined; return await oauth.refresh(current, AbortSignal.timeout(15_000)); })`. Triggered from `getAuth`/every request when `Date.now() + 5min >= expires` (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5*60*1000`, line 102; `resolveStoredOAuth` 161-191) and from `refresh()` when `Date.now() >= expires` (`models.ts:625-638`). "Once a refresh starts … the refresh and its persistence ignore `signal` and are bounded only by a timeout" (105-114). `minOAuthValidityMs` override: `AuthResolutionOverrides` (`resolve.ts:19-25`), `ModelRuntimeAuthOverrides` (`model-runtime.ts:128-133`).
- Logout: `credentials.delete`.
MEASURED: my store logged `[store.modify] openai -> oauth` and `[store.delete] anthropic` from `login`/`logout`; the refresh attempt also went through `modify` (it rejected inside, so nothing was stored — "the stored credential is preserved for retry; re-login fixes it", `models.ts:306-310`). **Every `modify` result must be persisted** — the ChatGPT refresh rotates the refresh token (`credentialFromTokenResponse` requires `refresh_token`), and coding-agent CHANGELOG:182 records `refresh_token_invalidated` failures when a refresh result was lost.
- `synchronizeCredentialState` (`model-runtime.ts:600-620`) runs after login/logout/runtime-key changes; its failure is `CredentialSynchronizationError` (`model-runtime.ts:138-154`) carrying `providerId`, `operation: "login"|"logout"|"setRuntimeApiKey"|"removeRuntimeApiKey"`, `credential`.

### 4.5 CLI/RPC
No login command outside the TUI: `pi auth check|print-api-key|print-bearer-token` are read-only (`cli/auth-command.ts:18-22`; docs `cli.md:296-316`; `--min-expiry` maps to `minOAuthValidityMs`); RPC mode has no login/auth command (grep of `modes/rpc` and `docs/rpc*.md` empty). Headless login = `ModelRuntime.login` from your own process.

---

## 5. ModelRuntime / ModelRegistry

### 5.1 Enumeration & availability (`core/model-runtime.ts`)
- `getProviders()` 441, `getProvider(id)` 445, `getModels(providerId?)` 449 (sync, last-known chat models), `getModel(provider, id)` 453, `getModelsOfType(type, provider?)` 457, `getAllModels(provider?)` 469.
- Credential-filtered: `getAvailable(providerId?)` 489 (async; `checkAuth` per provider + `provider.filterModels`), `getAvailableSnapshot()` 507 (sync, from the last availability pass), `getAvailableOfType(type, provider?)` 473, `getAllAvailable` 481, `hasConfiguredAuth(providerId)` 551, `checkAuth(providerId)` 485, `getProviderAuthStatus(providerId)` 646, `isUsingOAuth` 543, `isUsingSubscription` 547 (oauth && `auth.oauth.isSubscription`), `listCredentials()` 642, `getAuth(providerOrModel, overrides)` 555-577 (merges models.json/model headers).
- Mutations: `login` 826, `logout` 840, `setRuntimeApiKey` 621, `removeRuntimeApiKey` 634, `refresh(options)` 848 (reloads models.json, recomposes, catalog refresh, availability pass), `registerNativeProvider(Provider)` 891, `registerProvider(id, ProviderConfigInput)` 928, `unregisterProvider` 951, `registerVirtualModel` 964, `unregisterVirtualModel` 985, `resolveModel` 1003 (virtual → physical), `getPhysicalModel` 1037, `getError()` 511.
- `ModelRegistry` facade (`core/model-registry.ts`): `refresh`, `getError`, `getAll()`, `getAvailable()` (sync snapshot), `find(provider, id)`, `findOfType`, `hasConfiguredAuth(model)`, `getApiKeyAndHeaders(model) → ResolvedRequestAuth`, `getProviderAuthStatus`, `getProvider`, `stream/streamSimple/complete`, `classify`, `generateImages`, `getProviderDisplayName`, `getProviderAuth`, `getApiKeyForProvider`, `isUsingOAuth`, `registerProvider`, `unregisterProvider`, `registerVirtualModel`, `unregisterVirtualModel`.
- Built-in composition: `ModelRuntime.create` wraps every builtin except `radius` with `withRemoteCatalog` (pi.dev overlay: `GET https://pi.dev/api/models/providers/<id>?types=chat,image,classifier`, 4 h interval, ETag revalidation, persisted to `models-store.json`; `core/remote-catalog-provider.ts:14-16, 75-95, 104-185`) and `openrouter` with `withPersonalizedCatalog` (`model-runtime.ts:228-240`). Network only when `allowModelNetwork: true` and `PI_OFFLINE` unset (`model-runtime.ts:247, 252`).
- Default model per provider: `defaultModelPerProvider` (`core/model-resolver.ts:20-62`), e.g. `anthropic: "claude-opus-4-8"`, `openai: "gpt-5.5"`, `"openai-codex": "gpt-6.1-sol"`, `openrouter: "moonshotai/kimi-k2.6"`, `google: "gemini-3.1-pro-preview"`, `xai: "grok-4.7"`, `azure: "gpt-5.4"`. `findInitialModel` (543-610) and `resolveModelReference` (144-171, `provider/id[:thinking]` parsing) are exported.

### 5.2 The `Model` type (`PI/packages/ai/src/types.ts:825-872`, verbatim subset)
```ts
export interface BaseModel<TApi extends string> {
	id: string; name: string; api: TApi; provider: ProviderId; baseUrl: string;
	input: ModelInputModality[];            // ("text" | "image")[]
	inputLimits?: ModelInputLimits; cost: ModelCost; headers?: Record<string, string>;
}
export interface Model<TApi extends Api> extends BaseModel<TApi> {
	type?: "chat"; reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;    // Partial<Record<"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", string | null>>; null = unsupported
	promptCache?: ModelPromptCache; contextWindow: number; maxTokens: number;
	samplingParams?: SamplingParams; samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
	compat?: …;                              // OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | BedrockCompat | MistralConversationsCompat
}
```
Cost (`providers/model-schema.ts:25-46`): `{ input, output, cacheRead, cacheWrite }` in **USD per million tokens**, optional `tiers: [{ inputTokensAbove, input, output, cacheRead, cacheWrite }]` ("The highest matching input threshold applies to the full request"). `calculateCost(model, usage)` (`models.ts:1206-1226`; 1h Anthropic cache writes billed at 2× input). MEASURED model object keys: `id,name,api,provider,baseUrl,reasoning,input,cost,contextWindow,maxTokens,thinkingLevelMap,compat,promptCache,inputLimits,type`.
Thinking levels: `MODEL_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]` (`model-schema.ts:3-4`); `getSupportedThinkingLevels(model)` (`models.ts:1230-1239`: `off` only when `!reasoning`; a level is dropped when mapped to `null`; `xhigh`/`max` only when explicitly mapped) and `clampThinkingLevel(model, level)` (1241-1260). Anthropic token budgets per level: `DEFAULT_THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }` (`api/simple-options.ts:70-75`), `xhigh`/`max` clamp to `high` for budget-based providers (77-79).
`Api` union (`types.ts:61-73`): `"openai-completions" | "mistral-conversations" | "openai-responses" | "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-vertex" | "pi-messages" | (string & {})`. Image api `"openrouter-images"`; classifier apis `"typesafe-system-one" | "cloudflare-workers-ai-system-one" | "llama-cpp-classify" | "openai-decisions"` (75-85).

### 5.3 `models.json` (custom providers / overrides)
Schema (`core/model-config.ts:32-88`): `providers: Record<id, { name?, baseUrl?, apiKey?, api?, oauth?: "radius", headers?, compat?, authHeader?, models?: ModelDefinition[], modelOverrides?: Record<id, ModelOverride> }>`; `ModelDefinition = { id, name?, api?, baseUrl?, reasoning?, thinkingLevelMap?, input?, inputLimits?, cost?, promptCache?, contextWindow?, maxTokens?, samplingParams?, samplingParamsByThinkingLevel?, headers?, compat? }`. Defaults when omitted: `reasoning false`, `input ["text"]`, `cost 0`, `contextWindow 128000`, `maxTokens 16384` (`provider-composer.ts:230-248`); `api` must come from the model, provider or an inherited builtin; `baseUrl` is required for custom models; `authHeader: true` adds `Authorization: Bearer <resolved key>` (`withConfiguredAuth` 374-386). `apiKey`/`headers` values accept literal, `$ENV`, `${ENV}`, `!command` (docs `models.md:65`, `custom-provider.md:76-82`). Example (docs `models.md:50-62`): `{ "providers": { "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama", "models": [{ "id": "qwen2.5-coder:7b" }] } } }`. Loaded by `ModelRuntime.create({ modelsPath })` / `refresh()`; `modelsPath: null` disables it (MEASURED). The same shape is accepted programmatically via `ModelRuntime.registerProvider(id, ProviderConfigInput)` (`provider-composer.ts:91-108`: `name, baseUrl, apiKey, api, streamSimple, images, classifiers, headers, authHeader, oauth: ExtensionOAuthConfig, models, refreshModels`) or `registerNativeProvider(Provider)` built with pi-ai `createProvider()` (`models.ts:1002-1047`).

### 5.4 Virtual models (`core/virtual-models.ts`)
`VIRTUAL_MODEL_API = "pi-virtual"` (29). `VirtualModelDefinition` (84-102): `{ provider, id, name, thinkingLevels?, contextWindow?, maxTokens?, input?, route(request) }`; `route` receives `{ model, thinkingLevel, reason: "user"|"continuation"|"retry"|"direct", previous?, failed?, state?, messages, signal? }` and returns `{ model, thinkingLevel, state? }` (52-82). `createVirtualModel` makes a zero-cost catalog entry (170-187); `withVirtualModels` merges into a provider's catalog (201-238). `ModelRuntime.registerVirtualModel` / `resolveModel` (1003-1034): the routed target must be a physical model whose provider `hasConfiguredAuth`, level is clamped. `ModelRuntime.streamSimple` routes virtual models with `reason: "direct"` (724-743). Router state is persisted on the session branch as custom entry `"pi.virtual-model-state"` (32). Docs `virtual-models.md` match.

---

## 6. Provider-agnostic calls without the agent loop

Three layers, all returning `AssistantMessageEventStream` with `.result(): Promise<AssistantMessage>`:

**(a) Through `Models`/`ModelRuntime` (recommended; auth comes from the credential store):** `stream<TApi>(model, context, options?: ModelsApiStreamOptions<TApi>)`, `complete(...) → Promise<AssistantMessage>` (= `stream().result()`), `streamSimple(model, context, options?: ModelsSimpleStreamOptions)`, `completeSimple(...)`; plus `streamDeferred/fetchDeferred/cancelDeferred`, `generateImages`, `classify` (`models.ts:321-363`; `model-runtime.ts:699-824`). `applyAuth`/`prepareRequest` resolves auth per call and **`options.apiKey` wins per field** (`models.ts:871`, `model-runtime.ts:692`), so a per-mini-app key can be passed per request; `options.headers` merge over provider headers; `transformHeaders` hook. Virtual models are routed in `streamSimple` only.

**(b) The old global API `@earendil-works/pi-ai/compat` (MEASURED exported):** `stream(model, context, options?)`, `complete(...)`, `streamSimple(...)`, `completeSimple(...)` (`compat.ts:253-303`) with env-var key injection via `getEnvApiKey(model.provider, options.env)` when `options.apiKey` is absent (224-232), plus `getModel/getModels/getProviders` static catalog reads. Marked "Temporary compatibility entrypoint … deleted with the coding-agent ModelManager migration" (1-11) — do not build on it.

**(c) Direct API modules:** `openAIResponsesApi()`, `anthropicMessagesApi()`, `openAICompletionsApi()`, … from `@earendil-works/pi-ai/api/<name>.lazy` (each `lazyApi(() => import("./<name>.ts"))`, e.g. `api/openai-responses.lazy.ts:4`) return `ProviderStreams { stream(model, TranscriptContext, StreamOptions), streamSimple(model, TranscriptContext, SimpleStreamOptions) }` (`types.ts:311-324`). Here you must pass `apiKey` (or an `Authorization` header) in options (`openai-responses.ts:267-272` throws `No API key for provider: …` synchronously) and a `TranscriptContext` from `normalizeContext(context)` (`@earendil-works/pi-ai` `utils/transcript.ts:30`).

Inputs: `Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] }` (`types.ts:771-775`); `UserMessage = { role:"user", content: string | (TextContent|ImageContent)[], timestamp }` (564-568); `Tool = { name, description, parameters: TSchema (typebox), constrainedSampling? }` (754-759). Options (`types.ts:157-262, 369-377`): `signal`, `apiKey`, `headers`, `env`, `fetch`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `temperature`, `maxTokens`, `samplingParams`, `transport`, `cacheRetention`, `sessionId`, `metadata`, `onPayload`, `onResponse`, `onProviderStreamEvent`; `SimpleStreamOptions` adds `reasoning?: ThinkingLevel`, `toolChoice?: "auto"|"none"`, `thinkingBudgets?`, `deferred?`. Output `AssistantMessage` (570-601): `content: (TextContent|ThinkingContent|ToolCall)[]`, `usage: { input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost: {input, output, cacheRead, cacheWrite, total} }`, `stopReason: "stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"`, `errorMessage?`, `responseModel?`, `durationMs?`. Errors never throw from `complete()` on `Models`: setup failures become a stream `error` event / `stopReason:"error"` (`api/lazy.ts:46-62`).

**Structured / JSON output:** there is **no JSON-mode / `response_format` / `text.format` request option anywhere in pi-ai** (grep over `api/*.ts`: the only `format:` fields are OpenAI *grammar custom tools*, `openai-completions.ts:1496`, `openai-responses-shared.ts:397`; Mistral only remaps a passthrough `response_format`). Structured output is done as a **tool call with a strict JSON schema**: `Tool.constrainedSampling = { type: "json_schema", strict: "prefer" | "require" }` (`types.ts:744-759`), resolved per provider by `resolveJsonSchemaStrictSampling` (`api/constrained-sampling.ts:225-245`: with `"prefer"` an unsupported schema falls back to non-strict, with `"require"` it throws). Provider support: OpenAI Responses & Completions (`strict: true` function tools when `compat.supportsStrictMode`; `openai-responses-shared.ts:406-418`, `openai-completions.ts:1507-1516`), Anthropic strict tools (`compat.supportsStrictTools`, "Generated Anthropic models enable it explicitly", `compat-schema.ts:466-471`; `anthropic-messages.ts:1635-1638`), Google (`parametersJsonSchema`, `google-shared.ts:391-398`), Bedrock (1156-1161), Mistral (779-785). `toolChoice` is only `"auto" | "none"` (`types.ts:132`) — there is **no "force this tool"**, so JSON extraction = one tool + instruction, then read `message.content.find(c => c.type==="toolCall").arguments` (parse failures set `argumentsError`, 436-449). Alternative for YES/NO-style background classification: `classify(model, { state, questions })` with `"choice"|"score"|"bool"` questions returning probabilities (`types.ts:667-728`), but OpenAI's `gpt-6-luna` classifier needs an API key (not ChatGPT sign-in).

Model objects for standalone calls: `runtime.getModel("openai", "gpt-5.5")` or typed `getBuiltinModel("openai", "gpt-5.5")` from `@earendil-works/pi-ai/providers/all` (`all.ts:62-69`; MEASURED exported).

---

## 7. Full provider list (built-in, `providers/all.ts:136-181`, 42 providers) with API family and credentials

Env map source: `env-api-keys.ts:73-127` + each provider file; docs table `providers.md:31-69`.

| id | name | baseUrl | API family | auth |
|---|---|---|---|---|
| anthropic | Anthropic | api.anthropic.com | anthropic-messages | `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` (bearer) / federation env; OAuth (Claude Pro/Max, not to be exposed) |
| openai | OpenAI | api.openai.com/v1 | openai-responses (+ openai-decisions classifier) | `OPENAI_API_KEY`; OAuth "Sign in with ChatGPT" |
| openai-codex | OpenAI Codex (legacy) | chatgpt.com/backend-api | openai-codex-responses | OAuth only (ChatGPT Plus/Pro; browser or device code) |
| openrouter | OpenRouter | openrouter.ai/api/v1 | anthropic-messages + openai-completions (+ openrouter-images, typesafe-system-one) | `OPENROUTER_API_KEY`; OAuth/PKCE → permanent key |
| azure | Azure | (from env) | azure-openai-responses + openai-completions | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME` (+ `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`) |
| google | Google | generativelanguage.googleapis.com/v1beta | google-generative-ai | `GEMINI_API_KEY` |
| google-vertex | Google Vertex AI | — | google-vertex | `GOOGLE_CLOUD_API_KEY` or ADC (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`/`GCLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`); prompts api-key/adc/service-account |
| amazon-bedrock | Amazon Bedrock | — | bedrock-converse-stream | `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY` (+`AWS_SESSION_TOKEN`) / `AWS_BEARER_TOKEN_BEDROCK` / container+IRSA; `AWS_REGION` |
| github-copilot | GitHub Copilot | api.individual.githubcopilot.com | anthropic-messages + openai-completions + openai-responses | `COPILOT_GITHUB_TOKEN`; OAuth (device flow) |
| xai | xAI | api.x.ai/v1 | openai-responses | `XAI_API_KEY`; OAuth (Grok/X subscription) |
| meta | Meta | api.meta.ai/v1 | openai-responses | `META_API_KEY`; OAuth (Muse) |
| kimi-coding | Kimi For Coding | api.kimi.com/coding/v1 | openai-completions | `KIMI_API_KEY`; OAuth |
| radius | Radius (Earendil gateway, dynamic catalog) | radius.pi.dev (configurable) | pi-messages | `RADIUS_API_KEY`; OAuth |
| mistral | Mistral | api.mistral.ai | mistral-conversations | `MISTRAL_API_KEY` |
| deepseek | DeepSeek | api.deepseek.com | openai-completions | `DEEPSEEK_API_KEY` |
| groq | Groq | api.groq.com/openai/v1 | openai-completions | `GROQ_API_KEY` |
| cerebras | Cerebras | api.cerebras.ai/v1 | openai-completions | `CEREBRAS_API_KEY` |
| nvidia | NVIDIA | integrate.api.nvidia.com/v1 | openai-completions | `NVIDIA_API_KEY` |
| huggingface | Hugging Face | router.huggingface.co/v1 | openai-completions | `HF_TOKEN` |
| fireworks | Fireworks | api.fireworks.ai/inference | anthropic-messages + openai-completions | `FIREWORKS_API_KEY` |
| together | Together | api.together.ai/v1 | openai-completions | `TOGETHER_API_KEY` |
| baseten | Baseten | inference.baseten.co/v1 | openai-completions | `BASETEN_API_KEY` |
| vercel-ai-gateway | Vercel AI Gateway | ai-gateway.vercel.sh | anthropic-messages (+ typesafe-system-one) | `AI_GATEWAY_API_KEY` |
| cloudflare-ai-gateway | Cloudflare AI Gateway | gateway.ai.cloudflare.com/… | anthropic-messages + openai-completions + openai-responses | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` (or credential `env`) |
| cloudflare-workers-ai | Cloudflare Workers AI | api.cloudflare.com/…/ai/v1 | openai-completions (+ cloudflare-workers-ai-system-one) | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| opencode / opencode-go | OpenCode Zen / Go | — | anthropic-messages + google-generative-ai + openai-completions + openai-responses (+ typesafe-system-one) | `OPENCODE_API_KEY` |
| zai / zai-coding-cn | Z.AI / Z.AI Coding CN | api.z.ai… / open.bigmodel.cn… | openai-completions | `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` |
| minimax / minimax-cn | MiniMax (CN) | api.minimax.io/anthropic / api.minimaxi.com/anthropic | anthropic-messages | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` |
| moonshotai / moonshotai-cn | Moonshot AI (CN) | api.moonshot.ai/v1 / api.moonshot.cn/v1 | openai-completions | `MOONSHOT_API_KEY` (both) |
| qwen-token-plan / -cn / -individual | Qwen Token Plan | token-plan.*.maas.aliyuncs.com/compatible-mode/v1 | openai-completions | `QWEN_TOKEN_PLAN_API_KEY` (plan & individual) / `QWEN_TOKEN_PLAN_CN_API_KEY` |
| xiaomi / xiaomi-token-plan-cn/-ams/-sgp | Xiaomi (MiMo) | api.xiaomimimo.com/v1 / token-plan-*.xiaomimimo.com/v1 | openai-completions | `XIAOMI_API_KEY` / `XIAOMI_TOKEN_PLAN_{CN,AMS,SGP}_API_KEY` |
| ant-ling | Ant Ling | api.ant-ling.com/v1 | openai-completions | `ANT_LING_API_KEY` |
| typesafe | TypeSafe (classifier only) | — | typesafe-system-one | `TYPESAFE_API_KEY` |

OAuth-capable providers (from `auth/oauth/load.ts:14-24`): anthropic, openaiCodex, openaiChatGPT (on `openai`), githubCopilot, openrouter, kimiCoding, meta, xai, radius.
Other PI process env vars that matter for an embedder (`docs/environment-variables.md:79-98`): `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `HTTP_PROXY`/`HTTPS_PROXY`; plus `PI_OAUTH_CALLBACK_HOST` (code only).

---

## 8. Docs vs code disagreements found
1. `docs/environment-variables.md:81` says `PI_OFFLINE` disables "automatic network activity, including model catalog refreshes"; MEASURED: OAuth token refresh still makes network calls with `PI_OFFLINE=1` (it only gates catalog refresh, `model-runtime.ts:247`).
2. `docs/custom-provider.md:85` says OAuth credentials land in `~/.pi/agent/auth.json`; true only for the default store — with a custom `CredentialStore` nothing touches disk (MEASURED).
3. `docs/providers.md` never documents Sign in with ChatGPT, the 1455 port, the device-id requirement or `agentName`; CHANGELOG points at `providers.md#authenticate-interactively`, which is generic.
4. Same port, different policy: `openai-codex.ts:364` comment "Port 1455 is shared with the Codex CLI; when it is taken, fall back to the pasted redirect URL" vs `openai-chatgpt.ts:241-248` which fails hard on EADDRINUSE (the redirect URI is fixed, so no fallback is possible).
5. The task description's file names (`auth/index.ts`, `auth/load.ts`) do not exist; `ModelRegistry` is a facade, `ModelRuntime` is the real API (`09-api-keys-and-oauth.ts` example uses `ModelRuntime.create({ authPath, modelsPath })` and `setRuntimeApiKey`).
6. `docs/sdk.md` has no section on `ModelRuntime`/login at all (only the example link); everything above is from source.

## KEY FACTS
- Sign in with ChatGPT registers a dynamic client, requires a UUID device id and uses a fixed redirect on port 1455
  - evidence: packages/ai/src/auth/oauth/openai-chatgpt.ts:16-25 `const DYNAMIC_CLIENT_ID = "dynamic_agent_client"; … const CALLBACK_PORT = 1455; const CALLBACK_PATH = "/auth/callback"; const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;` and :226-231 `if (!deviceId || !UUID_PATTERN.test(deviceId)) throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation"); return `urn:uuid:${deviceId.toLowerCase()}`;`
- MEASURED under Electron 37 (Node 22.17): ModelRuntime.login('openai','oauth',…,{getDeviceId, agentName:'Acabox'}) emitted the authorize URL with agent_name_hint=Acabox and ext_agent_host_id=urn:uuid:…, then prompted manual_code with placeholder http://127.0.0.1:1455/auth/callback
  - evidence: probe2.mjs output: `authorize params: {"client_id":"dynamic_agent_client","agent_name_hint":"Acabox","ext_agent_host_id":"urn:uuid:123e4567-e89b-12d3-a456-426614174000","response_type":"code","redirect_uri":"http://127.0.0.1:1455/auth/callback","resource":"https://api.openai.com/v1","scope":"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",…}`
- The ChatGPT credential stores clientId and scopes and expires 3 minutes early; refresh needs the issued clientId and rotates the refresh token
  - evidence: packages/ai/src/auth/oauth/openai-chatgpt.ts:173-180 `return { type: "oauth", access, refresh, expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS, clientId, scopes };` and :210-212 `if (typeof clientId !== "string" …) throw new Error("Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT");`
- The ChatGPT access token is used as the plain bearer apiKey on the normal Responses API (api.openai.com/v1), with store:false and several fields omitted; no originator/account-id headers
  - evidence: packages/ai/src/api/openai-responses.ts:42-49 `function isChatGPTSignIn(model, apiKey) { return model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" && apiKey !== undefined && !apiKey.startsWith("sk-"); }` and :356-371 `// Sign in with ChatGPT rejects these request fields. const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey); … store: false,`
- openai-codex (legacy) is OAuth-only against chatgpt.com/backend-api/codex/responses with originator and chatgpt-account-id headers
  - evidence: packages/ai/src/providers/openai-codex.ts:9-11 `id: "openai-codex", name: "OpenAI Codex (legacy)", baseUrl: "https://chatgpt.com/backend-api",`; packages/ai/src/api/openai-codex-responses.ts:1648,1659-1660 `const headers = new Headers({ originator: "pi", "User-Agent": getPiUserAgent() }); … headers.set("Authorization", `Bearer ${token}`); headers.set("chatgpt-account-id", accountId);`
- Classifier models are hidden for ChatGPT sign-in; MEASURED 44 chat models available with an oauth credential, 0 classifiers
  - evidence: packages/ai/src/providers/openai.ts:27-29 `// Sign in with ChatGPT tokens only reach the Responses API; the Decisions API rejects them. filterAllModels: (models, credential) => credential?.type === "oauth" ? models.filter((model) => !isModelType(model, "classifier")) : models,`; probe2 output `openai with oauth cred: allAvailable 44 classifiers 0 chat 44`
- pi persists the device id as deviceId in global settings.json, created with randomUUID on first login need
  - evidence: packages/coding-agent/src/core/settings-manager.ts:1082-1089 `getOrCreateDeviceId(): string { if (!this.globalSettings.deviceId) { this.globalSettings.deviceId = randomUUID(); this.markModified("deviceId"); this.save(); } return this.globalSettings.deviceId; }`; interactive-mode.ts:6347 `{ getDeviceId: () => this.settingsManager.getOrCreateDeviceId() },`
- CredentialStore is the pluggable storage interface; modify is the only write path and OAuth refresh runs inside it
  - evidence: packages/ai/src/auth/types.ts:65-94 `export interface CredentialStore { read(providerId…): Promise<Credential | undefined>; list(…): Promise<readonly CredentialInfo[]>; modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, …): Promise<Credential | undefined>; delete(providerId…): Promise<void>; }`; auth/resolve.ts:132-146 `post = await credentials.modify(providerId, async (current) => { … return await oauth.refresh(current, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS)); …`
- OAuth tokens are refreshed when less than 5 minutes remain, with a 15 s refresh timeout
  - evidence: packages/ai/src/auth/resolve.ts:102-103 `const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000; const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;` and :169-170 `const expiresSoon = (credential) => Date.now() + minimumValidityMs >= credential.expires;`
- AuthStorage is NOT exported from the published @earendil-works/pi-coding-agent and deep imports are blocked; ModelRuntime, readStoredCredential, ModelRegistry are exported
  - evidence: probe.mjs output `coding-agent exports: ModelRuntime=function AuthStorage=undefined ReadOnlyAuthStorage=undefined … readStoredCredential=function ModelRegistry=function`; probe3 output `deep import FAILED: ERR_PACKAGE_PATH_NOT_EXPORTED | Package subpath './dist/core/auth-storage.js' is not defined by "exports"`; PKG/pi-coding-agent/package.json exports keys ['.', './rpc-entry']
- ModelRuntime.create accepts a custom credentials store and a null modelsPath; MEASURED it then uses no disk and reports configured providers from the store
  - evidence: packages/coding-agent/src/core/model-runtime.ts:110-114 `export interface CreateModelRuntimeOptions { /** Credential storage. Defaults to the file at authPath. */ credentials?: CredentialStore; authPath?: string; modelsPath?: string | null; …`; probe2 output `ModelRuntime: providers 42 | available snapshot 17 | anthropic configured true | status {"configured":true,"source":"stored"}` with the scratch agent dir left empty
- Stored credential beats env; env is consulted only when nothing is stored
  - evidence: packages/ai/src/auth/resolve.ts:27-32 `* A stored credential owns the provider: ambient/env is consulted only when nothing is stored. No silent env fallback after a failed refresh or for a credential type without a matching handler.`; docs/models.md:23 `Pi uses a runtime --api-key first, then a stored auth.json credential, an apiKey from models.json, and finally the provider's environment variables or ambient cloud credentials.`
- The agent directory (auth.json, models.json, settings.json) is relocated with PI_CODING_AGENT_DIR, whose name derives from the package's piConfig.name
  - evidence: packages/coding-agent/src/config.ts:585 `export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;` and :605-611 `export function getAgentDir(): string { const envDir = process.env[ENV_AGENT_DIR]; if (envDir) return expandTildePath(envDir); return join(homedir(), CONFIG_DIR_NAME, "agent"); }`; docs/environment-variables.md:81 `PI_CODING_AGENT_DIR | Override the config directory; default is ~/.pi/agent`
- auth.json keys may be `!command` values resolved by a shell command and cached for the process lifetime
  - evidence: packages/coding-agent/src/core/resolve-config-value.ts:138-151 `* - If starts with "!", executes the rest as a shell command and uses stdout (cached) … export function resolveConfigValue(config: string, env?): string | undefined { const reference = parseConfigValueReference(config); if (reference.type === "command") return executeCommand(reference.config); …`; docs/providers.md:84 `Pi runs the command when the key is first needed and caches its standard output for the process lifetime.`
- Anthropic: ANTHROPIC_AUTH_TOKEN becomes an Authorization: Bearer header; ANTHROPIC_OAUTH_TOKEN and ANTHROPIC_API_KEY become apiKey; sk-ant-oat tokens switch to the Claude Code identity path
  - evidence: packages/ai/src/providers/anthropic.ts:34-47 `const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV); … return { auth: { headers: { Authorization: `Bearer ${authToken}` } }, source: ANTHROPIC_AUTH_TOKEN_ENV }; … for (const envVar of [ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]) { … if (apiKey) return { auth: { apiKey }, source: envVar }; }`; packages/ai/src/api/anthropic-messages.ts:1014-1016 `function isOAuthToken(apiKey: string): boolean { return apiKey.includes("sk-ant-oat"); }` and :1227-1232 `// For OAuth tokens, we MUST include Claude Code identity … text: "You are Claude Code, Anthropic's official CLI for Claude."`
- Anthropic OAuth uses the Claude Code client id and claude.ai/platform.claude.com endpoints with Claude Code scopes
  - evidence: packages/ai/src/auth/oauth/anthropic.ts:14-27 `const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"); const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"; const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"; … const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";`
- OpenRouter has a PKCE login that yields a permanent key stored as a never-expiring oauth credential; /models/user personalizes the catalog
  - evidence: packages/ai/src/auth/oauth/openrouter.ts:19-20,105-110 `const AUTHORIZE_URL = "https://openrouter.ai/auth"; const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys"; … return { type: "oauth", access: body.key, refresh: "", expires: Number.MAX_SAFE_INTEGER };`; packages/ai/src/providers/openrouter.ts:30-34 `const response = await fetch(`${(context.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/models/user`, { headers: { accept: "application/json", authorization: `Bearer ${key}` }, … }); if (response.status === 401 || response.status === 403 || response.status === 404) return catalog;`
- Model cost is USD per million tokens with optional request-wide tiers
  - evidence: packages/ai/src/providers/model-schema.ts:25-46 `input: Type.Number({ description: "Input cost in USD per million tokens." }), … tiers: Type.Optional(Type.Array(ModelCostTierSchema, { description: "Request-wide pricing tiers. The highest matching input threshold applies to the full request." }))`
- pi-ai has no JSON-mode request option; structured output is a strict-schema tool call via Tool.constrainedSampling, and toolChoice is only auto|none
  - evidence: packages/ai/src/types.ts:744-759 `export type ConstrainedSamplingConfig = | { type: "json_schema"; strict: "prefer" | "require"; } | { type: "grammar"; variants: GrammarVariants; }; export interface Tool<…> { name; description; parameters; constrainedSampling?: false | ConstrainedSamplingConfig; }`; types.ts:132 `export type ToolChoice = "auto" | "none";`; grep of api/*.ts for response_format/text.format/json_object found no request option
- OAuth flow modules load through a variable-specifier dynamic import; the bundled build registers them statically via registerBunOAuthFlows
  - evidence: packages/ai/src/auth/oauth/load.ts:9-12 `const importOAuthModule = (specifier: string): Promise<unknown> => { const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier; return import(runtimeSpecifier); };`; packages/coding-agent/src/bun/runtime-setup.ts:2,10 `import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"; … registerBunOAuthFlows();`; coding-agent CHANGELOG.md:342 `Fixed /login with OpenAI failing in the bundled release with a missing openai-chatgpt.js module error.`
- PI_OFFLINE does not stop OAuth refresh network calls (MEASURED), it only gates catalog refresh
  - evidence: probe2 output with PI_OFFLINE=1: `expired oauth getAuth -> ModelsError code= oauth | OAuth refresh failed for openai: OpenAI OAuth token request failed (400): { "error": "invalid_client" }`; packages/coding-agent/src/core/model-runtime.ts:247 `process.env.PI_OFFLINE === undefined,` passed as modelNetworkEnabled
- Cancelling a login through interaction.signal rejects with the abort reason (DOMException), not necessarily Error('Login cancelled')
  - evidence: packages/ai/src/models.ts:782-783 `const loginOperation: Promise<Credential> = method.login({ ...interaction, signal }, options); const credential = await raceWithAbortSignal(loginOperation, signal);`; probe2 output `login ended: DOMException | This operation was aborted`
- The default Codex model is gpt-6.1-sol; the openai default is gpt-5.5
  - evidence: packages/coding-agent/src/core/model-resolver.ts:24,26 `openai: "gpt-5.5", … "openai-codex": "gpt-6.1-sol",`
- Supported thinking levels come from reasoning + thinkingLevelMap; MEASURED gpt-5.5 = off,low,medium,high,xhigh and claude-sonnet-5-5 = low,medium,high,xhigh,max
  - evidence: packages/ai/src/models.ts:1230-1239 `export function getSupportedThinkingLevels(model) { if (!model.reasoning) return ["off"]; return EXTENDED_THINKING_LEVELS.filter((level) => { const mapped = model.thinkingLevelMap?.[level]; if (mapped === null) return false; if (level === "xhigh" || level === "max") return mapped !== undefined; return true; }); }`; probe2 output `thinking levels claude-sonnet-5-5: ["low","medium","high","xhigh","max"] | gpt-5.5: ["off","low","medium","high","xhigh"]`
- There is no CLI or RPC login command; headless login must go through the SDK
  - evidence: packages/coding-agent/src/cli/auth-command.ts:5 `export type AuthCommandKind = "check" | "api_key" | "bearer_token";`; docs/cli.md:303-305 list only `pi auth check`, `pi auth print-api-key`, `pi auth print-bearer-token`; grep of src/modes/rpc for login returned nothing

## RISKS
- Port 1455 is hard-coded for Sign in with ChatGPT (redirect URI fixed, no fallback): a dev Acabox and a packaged Acabox running side by side, or the Codex CLI, will make the second login fail with 'Port 1455 is in use…'. The flow binds the port BEFORE showing the URL, so the UI must surface that error and offer retry; a manual-paste path cannot rescue it because the server did not start.
- Refresh-token rotation: every ChatGPT refresh returns a new refresh token; if Acabox's CredentialStore.modify does not persist the returned credential (or two processes refresh independently), the old refresh token is invalidated (coding-agent CHANGELOG:182 refresh_token_invalidated). Acabox's host process and any agent-server child must share ONE store with cross-process mutual exclusion (pi's file store uses proper-lockfile; a safeStorage-backed store needs an equivalent lock or a single owning process).
- The ChatGPT access token travels as `options.apiKey` and `AuthResult.auth.apiKey` through every request path and through ModelRegistry.getApiKeyAndHeaders(); any debug logging of request options will leak it. Acabox's existing 'never print the key' discipline must cover these objects.
- AuthStorage (file store with locking, `!command`, revision reload) is not reachable from the published package, so Acabox must write and test its own CredentialStore; subtle contracts (list() must not execute commands, modify() must be serialized per provider and return the post-write credential, read() must return possibly-expired credentials) are easy to get wrong.
- If pi-ai is webpack-bundled into an agent-server bundle, the variable-specifier dynamic import in auth/oauth/load.ts will not be followed and every OAuth login/refresh/toAuth will fail at runtime; call registerBunOAuthFlows() from @earendil-works/pi-ai/bun-oauth (or keep pi unbundled under node_modules). The package is ESM-only and declares engines node>=22.19.0 while Electron ships 22.17.0 (measured to work, but unsupported upstream).
- ModelRuntime resolves env vars from process.env with no authContext injection point; an inherited OPENAI_API_KEY/ANTHROPIC_API_KEY in the Electron process silently makes a provider 'configured' and would be billed instead of the user's chosen credential. Scrub the subprocess env or build the runtime from createModels({authContext}) directly.
- Which OpenAI models a ChatGPT subscription token can actually call is not known to pi: the catalog filter is type-based only, so the picker will list models that may 400 at request time; also any non-'sk-' key routed to api.openai.com/v1 is treated as a ChatGPT token and loses max_output_tokens/temperature/prompt_cache_retention.
- PI_OFFLINE does not block OAuth refresh network calls; an 'offline' mode in Acabox cannot rely on it.
- Cancellation semantics are mixed (DOMException AbortError vs Error('Login cancelled')); UI code must treat both as cancel, and the callback server for ChatGPT has no timeout — an abandoned login holds port 1455 until the AbortController fires.
- Anthropic OAuth (Claude Pro/Max) impersonates Claude Code (client id, 'You are Claude Code…' system prompt, claude-cli user agent); exposing it would violate Anthropic's terms — keep it out of the UI, and note that an env ANTHROPIC_OAUTH_TOKEN containing sk-ant-oat triggers the same path implicitly.
- The 5-minute minimum validity and 3-minute client-side margin depend on a correct system clock (expires is an absolute epoch computed client-side); clock skew causes refresh storms or expired-token requests.
- models-store.json / remote pi.dev catalog refresh is on by default once allowModelNetwork is true: Acabox PI would make background requests to pi.dev every 4 h and to openrouter.ai /models/user on refresh — decide whether that is acceptable for a research app (privacy/egress).

## UNKNOWNS
- Actual expires_in of ChatGPT (dynamic_agent_client) access tokens and whether OpenAI gates agent_name_hint / dynamic client registration by policy or allowlist; only the request shape is known from code.
- Which models OpenAI serves to a ChatGPT subscription token on the normal Responses API (pi lists all 44 catalog models); the only hint is ai CHANGELOG:276 removing GPT-5.4 from the codex catalog after it became unavailable to ChatGPT accounts.
- OpenAI's terms for 'Sign in with ChatGPT' use in third-party apps (not in the repo); the planner should verify before shipping.
- The OpenRouter PKCE login and the Anthropic/API-key logins were not run against the real services end to end (only cancelled/offline paths were measured); the ChatGPT code exchange and a real refresh were not performed.
- Whether Electron's main-process fetch (undici) honours HTTPS_PROXY for the OAuth token endpoints as pi's docs claim for the CLI.
- Behaviour of a custom CredentialStore across two OS processes (host + agent-server child) was not measured; pi's own cross-process locking lives only in the unexported AuthStorage.
- Exact pi.dev remote-catalog payload shape beyond parseCatalog (array, {models:[]} or object) and how often it diverges from the shipped data files.
- The radius provider / pi-messages API and the llama.cpp router were not examined in depth (out of scope for OpenAI/Anthropic/OpenRouter).
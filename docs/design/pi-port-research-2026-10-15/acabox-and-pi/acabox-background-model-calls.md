# Acabox: non-harness model calls, roster/catalog/pricing plumbing, and API-key plumbing

Read-only inventory. Everything below is READ from the files named unless marked INFERRED. All paths are under `/Users/iliasbeshimov/Documents/Dev Folders/Acabox/src/cobuilding/` unless absolute. Versions (package.json:88-89): `@anthropic-ai/claude-agent-sdk ^0.3.296`, `@anthropic-ai/sdk ^0.126.0`; Electron `^37.2.0` (package.json:67).

PI env var confirmed: `/private/tmp/.../scratchpad/pi-src/pi/packages/coding-agent/docs/environment-variables.md:81` — `| PI_CODING_AGENT_DIR | Override the config directory; default is ~/.pi/agent |`.

---

## 1. Every model call that does NOT go through the agent-server harness

### 1a. Direct `@anthropic-ai/sdk` calls (`new Anthropic` + `messages.create` / `messages.stream`)

Only five files construct `new Anthropic(...)` (grep across src, excluding tests): `main/index.ts` (3 sites), `main/controllers/AgentInfrastructureController.ts` (1), `main/directoryScanner/agents/fileTagging.ts` (4 client constructions, 3 distinct prompts), `main/calendarAgentSession.ts` (1 + retry). Every one reads credentials from the in-memory store `getCredentials()` (`main/cobuildingTokenManager.ts:18-20`) or receives `ctx.apiKey/ctx.baseURL` copied from it.

| # | Purpose | File:line | Model | Request shape | How the reply is read | Trigger / cost sensitivity |
|---|---|---|---|---|---|---|
| A | Chat title generation | `main/index.ts:2196-2228` `generateSessionTitle(sessionId, firstMessage)` | `BACKGROUND_MODEL` (`claude-haiku-5-5`) via `...BACKGROUND_REQUEST` | `client.messages.create({ ...BACKGROUND_REQUEST, max_tokens: 40, messages: [{ role: 'user', content: \`Give a short title (5 words or less) that summarizes this message. Reply with ONLY the title, no quotes or punctuation.\n\nMessage: ${firstMessage}\` }] })` — no `system`; `thinking: {type:'disabled'}`, `output_config: {effort:'low'}` from BACKGROUND_REQUEST | `messageText(response).trim()` → `updateSessionTitle` + `sessions:titleUpdated` + `notifySessionsChanged()` | Fired from `chat:send` at `index.ts:2365-2367` when `isFirstMessage && !isCalendarSession` (`isFirstMessage` = 0 messages AND placeholder title, :2290-2292). One tiny call per new chat. Fails silently (log only). |
| B | Mini-app manifest metadata (legacy migration) | `main/controllers/AgentInfrastructureController.ts:590-645` `generateManifestForApp(agentDir, dirName)` | `BACKGROUND_MODEL` via `...BACKGROUND_REQUEST` | `max_tokens: 400`; single user message: "You are generating manifest.json metadata for a mini-app. Return only JSON with these fields: name (≤40 chars), description (≤80), icon (Lucide PascalCase)… Directory name: … App source (truncated): <first 8000 chars of src/App.tsx> … Output JSON only." | `messageText(message)` → `text.match(/\{[\s\S]*\}/)` → `JSON.parse` → `{name, description, icon}` with fallbacks → `updateManifest(manifestPath, m => ({...manifest, ...m}))` | `migrateMissingManifests(workspacePath)` is fire-and-forget at `AgentInfrastructureController.ts:397` inside `start()`; runs only for `.applications/*` dirs with no `manifest.json` (:557-588). Marked "TODO: Remove … Safe to remove after ~2026-08-05" (:547-549). Rare. |
| C | Auto-tag untagged PDFs as references (YES/NO) | `main/directoryScanner/agents/fileTagging.ts:94-161` `autoTagReferencePdfs` | `BACKGROUND_MODEL` via `...BACKGROUND_REQUEST` | `max_tokens: 10`; user message: "Is this a published academic research paper, journal article, or preprint? Answer only YES or NO. … Filename: … Text excerpt: <first 1500 chars>" | `messageText(message).trim().toUpperCase()`; `answer?.startsWith("YES")` | ONE CALL PER UNTAGGED PDF across all scan dirs, sequential, no cap on count (`findAllPdfs` walks everything, :71-92). Skips PDFs whose extracted text < 500 chars (`MIN_TEXT_LENGTH_FOR_REFERENCE`, :69). This is the only unbounded-by-count background loop. |
| D | Reference title extraction (PDF → markdown) | `fileTagging.ts:410-462` `convertSingleReference(filePath, absolutePath, refsDir, client)` | `BACKGROUND_MODEL` via `...BACKGROUND_REQUEST` | `max_tokens: 100`; "Extract the title of this academic paper from the excerpt below. Return ONLY the title… If you cannot determine the title, return the text "UNKNOWN". Filename: … Excerpt: <first 2000 chars>" | `messageText(message).trim()`; if not `"UNKNOWN"` → `sanitizeFilename` → `<title>.md` written to `<.academia>/references/`, index updated | Called per tagged reference not already in the index by `enrichReferences` (:464-505, inside the scan) AND by exported `convertReferenceFile` (:511-540) from IPC `scannedFiles:updateTag` (`index.ts:1353-1377`) when the user manually tags a file as `reference` in the UI. Failure falls back to the filename (:449-453). |
| E | Manuscript briefing card | `fileTagging.ts:542-657` `enrichManuscripts` | `BACKGROUND_MODEL` via `...BACKGROUND_REQUEST` | `max_tokens: 400`; prompt asks for JSON `{"title": "Review the intro of your … paper", "description": "…"}` from the first 2000 chars of a `.docx` tagged `manuscript`; "Output JSON only. No prose, no code fences." | `messageText(message)` → `/\{[\s\S]*\}/` → `JSON.parse` → `createBriefing({type:'writing_agent', …})`; on any failure creates the briefing with defaults | One call per manuscript the tagging agent found. Note the `writing_agent` briefing targets the dropped Word overlay (CLAUDE.md "Known hazards"). |
| H | Mini-app proxy, non-streaming | `main/index.ts:2646-2664` `ipcMain.handle('anthropic:complete', …)` | Caller's `model` if in `anthropicAllowedModels()`, else `BACKGROUND_MODEL` (+ `thinking:{type:'disabled'}` only on fallback) — `validateAnthropicParams` :2629-2644 | `client.messages.create({ model, max_tokens, messages, ...(system ? {system} : {}), ...(thinking ? {thinking} : {}) })` | The FULL SDK `Message` object is returned as the IPC result (not a projection) | Per mini-app call; `max_tokens` clamped to `ANTHROPIC_MAX_TOKENS_LIMIT = 4096`, default 1024 (:2466, :2637-2639). Logged `[anthropic:complete] workspace=%s model=%s max_tokens=%d messages=%d`. |
| I | Mini-app proxy, streaming | `main/index.ts:2673-2727` `ipcMain.on('anthropic:stream', (event, { streamKey, params }) …)` | same as H | `client.messages.stream({...same fields...})`; `stream.on('text', text => sender.send('anthropic:stream:event', {streamKey, type:'chunk', payload:text}))`; `await stream.finalMessage()` → `{type:'done', payload: finalMsg}`; errors → `{type:'error', payload: message}`; `event.sender.once('destroyed', () => stream.abort())` | chunk = text deltas only; done = full `Message` | `streamKey` must match `UUID_RE` (:2666) — minted by the renderer, never the iframe. |
| J | Calendar assistant (tool-use loop) | `main/calendarAgentSession.ts:622-700` inside `runAgentLoop` | `'claude-sonnet-4-6'` hardcoded (:631) — a SUPERSEDED roster id | `client.messages.stream({ model: 'claude-sonnet-4-6', max_tokens: 8192, system: systemPrompt, tools: CALENDAR_TOOLS, messages: history }, { signal })`; loops while `finalMessage.stop_reason === 'tool_use'`, executing `CALENDAR_TOOLS` (list_groups/list_events/create_group/… `:27+`) and appending `tool_result` blocks; own 401/403 retry via `refreshCredentials` (:641-652) | streamed `text_delta` / `input_json_delta` events re-emitted as `ChatStreamMessage`; `insertMessage(sessionId,'assistant', JSON.stringify(finalMessage.content))` | REACHABILITY: live branch in main (`index.ts:2282` `const isCalendarSession = threadId === 'calendar-assistant'`, :2305-2328 `createCalendarAgentSession`). The only renderer producers of that thread id are `renderer/components/calendar/calendarChatAdapter.ts:6` and `calendarHistoryAdapter.ts:9`, and NOTHING outside `renderer/components/calendar/` imports from that directory (grep: zero importers; zero "calendar" matches in `renderer/index.tsx`). → unreachable from the UI. INFERRED: dead code; delete `main/calendarAgentSession.ts`, the `chat:send` branch, and `renderer/components/calendar/*` in Acabox PI. |

Shared pieces every background call uses (`shared/models.ts`):
```ts
export const BACKGROUND_MODEL = 'claude-haiku-5-5';                 // :181
export const BACKGROUND_REQUEST = {                                 // :194-198
  model: BACKGROUND_MODEL,
  thinking: { type: 'disabled' },
  output_config: { effort: 'low' },
} as const;
export function messageText(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {  // :208-213
  return message.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}
```
The comment at :183-193 records WHY thinking is disabled: Haiku 5.5 thinks by default and thinking counts toward `max_tokens`, so a 10-token cap would be spent before any text; `disabled` is only accepted at effort low/medium/high, hence `output_config.effort: 'low'`. These caps (10/40/100/400) are therefore load-bearing assumptions that the model emits NO reasoning tokens.

### 1b. Separate Agent-SDK `query()` agents run from MAIN (harness, but not the agent server)

Both use `buildCommonQueryOptions(ctx)` from `main/directoryScanner/shared.ts:185-224`:
```ts
return {
  abortController,
  ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),   // never set: ScanContext built at index.ts:46-58 without it
  tools: ["Read", "Glob", "Grep", docReaderTool],            // docReaderTool = "mcp__document-reader__read_document"
  allowedTools: ["Read", "Glob", "Grep", docReaderTool],
  cwd: ctx.cwd,
  env: { ...process.env, ANTHROPIC_API_KEY: apiKey, ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
         CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), 'scanner-claude-config') },
  mcpServers: { "document-reader": createDocumentReaderMcpServer(directoryPaths, hasDriveItems) },
  persistSession: false as const,
  thinking: { type: "disabled" as const },
  effort: "low" as const,
  settingSources: [] as any[],
  hooks: createHooks(directoryPaths),      // PreToolUse deny: hidden paths, paths outside scan roots (:226-278)
  stderr: …,
};
```
Preceded by `ensureApiKeyApproved(scannerConfigDir, apiKey)` (:190-193, Claude-Code-only approval file, see §5). Results are consumed by `consumeAgentStream<T>` (:161-183): iterates SDK messages, returns `(msg as any).structured_output as T` on `result`/`success`, throws on other result subtypes.

| # | Purpose | File:line | Model | Options | Output |
|---|---|---|---|---|---|
| F | File tagging agent | `agents/fileTagging.ts:36-53` | `BACKGROUND_MODEL` | `maxTurns: 15, maxBudgetUsd: 1, outputFormat: { type: "json_schema", schema: FILE_TAGGING_SCHEMA }` (schema :234-264: `tagged_files[] {file_path, file_name, file_type ∈ manuscript|grant|presentation|reference}`), `systemPrompt: buildSystemPrompt()` (:266-286) | `structured_output.tagged_files` → then C, D, E above; persisted by `upsertScannedFiles` |
| G | Research profile agent | `agents/researchProfile.ts:31-44` | `"claude-sonnet-4-6"` HARDCODED (:35) — superseded roster id | `maxTurns: 10, maxBudgetUsd: 2, outputFormat: { type: "json_schema", schema: RESEARCH_PROFILE_SCHEMA }` (:58-73: `{about_you, working_on}` strings), `systemPrompt: buildSystemPrompt()` (:75-102, asks for 3-6 word progress lines) | `structured_output` → writes `<memoryDir>/<MEMORY_FILE_ABOUT_YOU>` and `<MEMORY_FILE_WORKING_ON>` (:195-213); progress forwarded from assistant text/tool_use blocks (:133-193) |

`documentReaderMcpServer.ts:9-37` is an in-process `createSdkMcpServer` with one tool `read_document(file_path, max_chars=10000)` using `mammoth` (.docx) and `pdf-parse` (.pdf) (:63-75) — host-side text extraction already exists and is reusable.

Trigger: `scanWorkspaceDirectory` (`directoryScanner/index.ts:17-105`) runs F and G in parallel; it is called only by `BriefingsController.runInitialWorkspaceScan()` (`controllers/BriefingsController.ts:39-55`), which is called only by IPC `scanner:start` (`index.ts:1387`), which is called only by the Settings "Rescan workspace" button (`renderer/components/DirectoryPermissions.tsx:244`). Scans are MANUAL only; `buildScanParams` (:56-100) skips with no directories or no key.

### 1c. Anthropic endpoint calls that are not completions
| # | Purpose | File:line | Request |
|---|---|---|---|
| K | Model discovery | `main/modelCatalog.ts:96-143` `fetchModels` | `GET ${base}/v1/models?limit=100[&after_id=…]`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `AbortSignal.timeout(10_000)`, ≤5 pages; maps to `DiscoveredModel {id, display_name?, created_at?}`. `refreshModels(creds, force)` (:63-94): 6 h TTL, single-flight, never throws, never replaces a non-empty cache with an empty one. Called at boot `index.ts:936`, on key save `:2776` (force), on every `models:list` `:2905`. |
| L | API-key check | `main/apiKeyCheck.ts:12-30` `checkAnthropicKey(apiKey, baseURL?, fetchImpl)` | `GET ${base}/v1/models?limit=1`, same headers, 8 s timeout → `interpretKeyCheck` (`shared/apiKeyCheck.ts:18-25`): 2xx `accepted`, 401/403 `rejected`, 429/other/error `unconfirmed` with `detail`. |

### 1d. For reference: the Claude-specific knobs INSIDE the harness path (agent server)
`agent-server/index.ts:610-660` `startQuery`: refuses an empty `sessionConfig.anthropicApiKey` with the literal `'No Anthropic API key configured. Add one in Settings.'` (:611, duplicated from main because the bundles cannot share an import); `ensureApiKeyApproved(getClaudeConfigDir(), sessionConfig.anthropicApiKey)` (:620); `query({ options: { model: sessionConfig.model, thinking: { type: 'adaptive' }, ...(sessionConfig.effort ? { effort } : {}), systemPrompt: buildSystemPrompt(sessionConfig), includePartialMessages: true, cwd, env: { ...process.env, ANTHROPIC_API_KEY: sessionConfig.anthropicApiKey, ...(anthropicBaseURL ? { ANTHROPIC_BASE_URL } : {}), MINI_APP_WORKSPACE_DIR, CLAUDE_CONFIG_DIR: getClaudeConfigDir() }, settingSources, skills, settings: { autoMemoryEnabled: true, … } } })`. `POST /credentials` (:906-921) accepts `{anthropicApiKey?, anthropicBaseURL?}` (`sessionConfig.ts:117-120` `CredentialsPush`), patches `currentConfig` and every live session via `applyCredentialsToSessions`. `POST /sessions` (:1072-1088) takes `model`/`effort` overrides; `mergeSessionConfig` (`sessionConfig.ts:98-114`) does `model: overrides?.model ?? config.model, effort: overrides?.effort ?? config.effort`. `AgentConfig` (`sessionConfig.ts:3-72`) fields: `anthropicApiKey: string; anthropicBaseURL?: string; model: string; effort?: string; …`.

### 1e. Unattended path that silently uses the most expensive default
`main/scheduledTasks/runner.ts:25-46` calls `createAgentSession(sessionId, cbs, workspace, undefined, task.session_source ?? undefined, onNotificationClick, undefined, undefined, undefined, refreshAndPushCredentials)` — model and effort are `undefined`, so the agent server's boot config applies: `model: DEFAULT_MODEL` (Opus 5.5) and `effort: 'high'` (`AgentInfrastructureController.ts:493-496`). Only the two `createAgentSession` call sites exist: `index.ts:2332` (chat) and `runner.ts:25` (scheduler).

---

## 2. The mini-app model proxy contract (what shipped apps depend on)

Wire path: iframe `window.anthropicAPI` → `postMessage` → `MiniAppViewer.tsx` → `window.anthropicAPI` (preload, renderer world) → IPC → `main/index.ts` → Anthropic.

### 2a. Iframe side — `skills/manage-mini-application/assets/bridge/bridge.ts` (copied to `<workspace>/.applications/_bridge/` on every boot by `main/skills.ts:255-268` `syncMiniAppAssets`, and bundled INTO each app by esbuild — a change here reaches an existing app only on its next rebuild)
```ts
export interface AnthropicMessage {                                   // :66-76
  id: string;
  /** Models that think put thinking blocks first — find the text by `type`. */
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
  >;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}
export type ContentBlock =                                            // :78-81
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'file'; path: string } | { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'file'; path: string } | { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };
export interface AnthropicParams {                                    // :83-88
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
  model?: string;
  max_tokens?: number;
  system?: string;
}
interface BridgeAnthropicAPI {                                        // :116-119
  complete(params: AnthropicParams): Promise<AnthropicMessage>;
  stream(params: AnthropicParams, onChunk: (text: string) => void): Promise<AnthropicMessage>;
}
```
- `complete(params)` → `request('anthropic:complete', params)` → `window.parent.postMessage({ type: 'anthropic:complete', id: 'req-N', ...params }, '*')`; resolved by a `{ type: 'response', id, result, error }` message (:127-147, :229-231).
- `stream(params, onChunk)` → posts `{ type: 'anthropic:stream', id, ...params }` and listens for `{ type: 'anthropic:chunk', requestId, text }`, `{ type: 'anthropic:done', requestId, message }`, `{ type: 'anthropic:error', requestId, error }` (:238-257).
- Exposed as `window.anthropicAPI` alongside `filesAPI, kernel, hostAPI, containerAPI, errorAPI, academiaAPI, getWorkspacePath, isReadOnly` (:281-291).

### 2b. Renderer relay — `renderer/components/MiniAppViewer.tsx`
- `:60-65` `JOB_BRIDGE_KINDS = { executeCode: {kind:'kernel', label:'Running a step'}, 'anthropic:complete': { kind: 'claude', label: 'Writing with Acabox' }, 'anthropic:stream': { kind: 'claude', label: 'Writing with Acabox' } }` — these calls are reported to the host job registry as kind `'claude'` and drive the tool's WORKING chip.
- `:1681-1683` `case 'anthropic:complete': result = await (window as any).anthropicAPI.complete(args);`
- `:1685-1716` `case 'anthropic:stream'`: `const streamKey = crypto.randomUUID();` then `(window as any).anthropicAPI.stream(streamKey, args, text => iframe.contentWindow?.postMessage({type:'anthropic:chunk', requestId:id, text},'*'), message => postMessage({type:'anthropic:done', requestId:id, message}), err => postMessage({type:'anthropic:error', requestId:id, error: err}))`; `skipResponse = true` so no `response` envelope is sent.

### 2c. Preload — `main/preload.ts`
- `:879-882` one persistent listener: `ipcRenderer.on('anthropic:stream:event', (_e, msg: { streamKey; type; payload }) => anthropicStreamHandlers.get(msg.streamKey)?.(msg))`.
- `:926-947` `contextBridge.exposeInMainWorld('anthropicAPI', { complete: (params) => ipcRenderer.invoke('anthropic:complete', params), stream: (streamKey, params, onChunk, onDone, onError) => { …handlers.set(streamKey, ({type, payload}) => type==='chunk' ? onChunk(payload) : type==='done' ? (cleanup(), onDone(payload)) : type==='error' ? (cleanup(), onError(payload)) …); ipcRenderer.send('anthropic:stream', { streamKey, params }); return cleanup; } })`. (Not declared in `renderer/types.d.ts`; MiniAppViewer uses `(window as any)`.)

### 2d. Main-side validation — `main/index.ts:2443-2644`
- Allowed models: `function anthropicAllowedModels(): Set<string> { return allowedModelIds(discoveredModels()); }` (:2455-2458) = `new Set([...KNOWN_MODEL_IDS, ...discovered.map(m => m.id)])` (`shared/models.ts:279-281`). There is no longer an `ANTHROPIC_ALLOWED_MODELS` const; the comment at :2444-2446 still says "Unrecognised values silently fall back to BACKGROUND_MODEL".
- Limits (:2466-2480): `ANTHROPIC_MAX_TOKENS_LIMIT = 4096; ANTHROPIC_MAX_TEXT_CHARS = 100_000; ANTHROPIC_MAX_MESSAGES = 50; ANTHROPIC_MAX_SYSTEM_CHARS = 10_000; ANTHROPIC_MAX_CONTENT_BLOCKS = 20; ANTHROPIC_MAX_FILE_SIZE = 10_000_000; ANTHROPIC_MAX_BASE64_CHARS = 20_000_000; ANTHROPIC_ALLOWED_IMAGE_TYPES = {image/jpeg, image/png, image/gif, image/webp}`; `EXT_TO_MEDIA_TYPE` adds `pdf: 'application/pdf'`.
- `resolveContentBlock` (:2497-2600): `text`; `image` with `source.type === 'file'` (path checked by `assertWithinAllowedDirs(path, allowedDirs)` where `allowedDirs = workspaceController.allAllowedPaths`, read + base64) or `'base64'`; `document` only PDF (file or base64), optional `title` ≤1000 chars. Output type `ValidatedContentBlock` (:2491-2494) is Anthropic-shaped.
- `validateAnthropicParams` (:2602-2644) returns `{ messages, model, max_tokens, system?, thinking?: {type:'disabled'} }`; model rule verbatim:
```ts
const requested = typeof p.model === 'string' && anthropicAllowedModels().has(p.model) ? p.model : null;
const model = requested ?? BACKGROUND_MODEL;
…
return { messages, model, max_tokens, system, ...(requested ? {} : { thinking: { type: 'disabled' as const } }) };
```
- Response shape delivered to the iframe is the raw SDK `Message` (so it also carries `type:'message'`, `role`, `stop_reason`, `stop_sequence`, `usage.cache_*` fields beyond the bridge's declared subset).

### 2e. Consumers and docs
- Shipped template `skills/manage-mini-application/assets/templates/westernBlotAnnotator/src/App.tsx:87-101` `llmWithImage`: `window.anthropicAPI.complete({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }, { type: "text", text: prompt }] }], system: "You are an expert western blot analyst. Respond with ONLY valid JSON…", model: "claude-opus-4-20250514", max_tokens: 1024 })` then `return response.content[0].text.trim();` — reads POSITION 0 (contrary to the docs) and names a model NOT in `KNOWN_MODEL_IDS`, so it is honoured only while discovery lists it; otherwise it falls to `BACKGROUND_MODEL` with thinking disabled (which is why `content[0]` still works). `template.md:44-52` documents the call and says "the kernel has no Anthropic credentials, and the key must not be handed to it."
- `prebuilt-apps/grantFinder`: zero matches for anthropic/claude/hostAPI — does not use the model proxy.
- Docs that promise the contract: `bridge-api.md:92-146` ("`model` (optional) — defaults to `"claude-haiku-5-5"`, with thinking off … always read the answer by block type … never as `content[0]`"; "Only `file` and `base64` source types are supported. URL sources are not allowed."), `SKILL.md:701-748` ("Use `window.anthropicAPI` — do NOT read `ANTHROPIC_API_KEY` from env…"; `// model: omit for claude-haiku-5-5 with thinking off`).
- Test pinning the bridge: `main/__tests__/bridge.test.ts` (builds the real bridge with esbuild and executes it in JSDOM per CLAUDE.md).

---

## 3. Model roster plumbing end to end

### 3a. `shared/models.ts` (single source of truth)
```ts
export interface PickerModel { id: string; label: string; description: string; discovered?: boolean }   // :28-34
export interface DiscoveredModel { id: string; display_name?: string; created_at?: string }            // :37-42
export const CURATED_MODELS: readonly PickerModel[] = [                                                 // :48-55
  { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'Highest intelligence, premium cost' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Newest Opus, most capable for ambitious work' },
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Previous-generation Opus' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Older Opus' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Most efficient for everyday tasks' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fastest for quick answers' },
] as const;
const SUPERSEDED_MODELS = [ {id:'claude-fable-5',label:'Fable 5'}, {id:'claude-opus-4-7',label:'Opus 4.7'}, {id:'claude-opus-4-6',label:'Opus 4.6'}, {id:'claude-sonnet-4-6',label:'Sonnet 4.6'}, {id:'claude-sonnet-5',label:'Sonnet 5'}, {id:'claude-haiku-4-5',label:'Haiku 4.5'}, {id:'claude-haiku-4-5-20251001',label:'Haiku 4.5'} ];  // :65-73
export const SUPERSEDED_MODEL_IDS = SUPERSEDED_MODELS.map(m => m.id);                                   // :75
export function supersededModelLabel(id: string): string | undefined { return SUPERSEDED_MODELS.find(m => m.id === id)?.label; }  // :86-88 (exact ids only)
export const UNSUPPORTED_MODEL_IDS: readonly string[] = [] as const;                                    // :118-119 (CLI-version gate; empty)
export const KNOWN_MODEL_IDS = [...CURATED_MODELS.map(m => m.id), ...SUPERSEDED_MODEL_IDS, ...UNSUPPORTED_MODEL_IDS];  // :145-149
export const DEFAULT_MODEL = 'claude-opus-5-5';                                                          // :160 (pinned; "$4/$20 per MTok against Opus 5's $5/$25" in comment :155-158)
export const MAX_AUTO_ADDED_MODELS = 6;                                                                  // :170
export const BACKGROUND_MODEL = 'claude-haiku-5-5';                                                      // :181 (comment: "$0.10/$0.50 per MTok against $1/$5")
export const BACKGROUND_REQUEST = { model: BACKGROUND_MODEL, thinking: { type: 'disabled' }, output_config: { effort: 'low' } } as const;  // :194-198
const DISCOVERED_DESCRIPTION = 'New from Anthropic — may need an Acabox update';                         // :216
```
`mergeModels(discovered)` (:238-269), the rule verbatim from the comment: "a discovered model is shown when we have never heard of its id **and** it is newer than every model we *have* heard of"; `newestKnown` = max `created_at` among discovered ids in `KNOWN_MODEL_IDS`; if none, returns `[...CURATED_MODELS]`; newcomers filtered (`!known.has(id) && created_at > newestKnown`, deduped), sorted newest-first, `.slice(0, MAX_AUTO_ADDED_MODELS)`, labelled `m.display_name?.trim() || m.id`, `discovered: true`, PREPENDED: `return [...newcomers, ...CURATED_MODELS]`. `allowedModelIds(discovered)` (:279-281) is the union used by the mini-app proxy. Prices exist ONLY in comments — there is no price table anywhere in Acabox (grep for price/pricing/`$`-amounts: only `models.ts:156-157,176-177` comments and `turnCost.ts` formatting).

Tests: `shared/__tests__/models.test.ts`, `main/__tests__/modelCatalog.test.ts`.

### 3b. Main: discovery + IPC
- `main/modelCatalog.ts` (§1c K). `discoveredModels()` (:48-50) returns the cache; `discoveryError()` (:53-55).
- `ipcMain.handle('models:list', …)` `main/index.ts:2904-2911`: `void refreshModels(resolveApiKey()); return { models: mergeModels(discoveredModels()), defaultModel: DEFAULT_MODEL, discoveredCount: discoveredModels().length, error: discoveryError() };`
- preload `main/preload.ts:82-87` `contextBridge.exposeInMainWorld('modelsAPI', { list: () => ipcRenderer.invoke('models:list') })`; type `renderer/types.d.ts:1313-1320` `modelsAPI: { list(): Promise<{ models: { id; label; description; discovered? }[]; defaultModel: string; discoveredCount: number; error: string | null }> }`.

### 3c. Renderer picker — `renderer/components/ModelSelector.tsx`
- `let MODELS: PickerModel[] = [...CURATED_MODELS];` (:17) module state; `refreshModelRoster()` (:27-36) replaces it from `window.modelsAPI.list()` and dispatches `'cd:models-changed'` (:20).
- Effort dial (:41-50): `export type EffortId = 'low' | 'medium' | 'high' | 'xhigh' | 'max'; const EFFORTS = [{id:'low',label:'Low'},{id:'medium',label:'Medium'},{id:'high',label:'High'},{id:'xhigh',label:'Extra'},{id:'max',label:'Max',note:'Best on the most capable models'}]` — comment says these are "the Claude Agent SDK `effort` levels (query() option)".
- localStorage keys `MODEL_KEY = 'selectedModel'`, `EFFORT_KEY = 'selectedEffort'` (:52-53); `DEFAULT_MODEL = SHARED_DEFAULT_MODEL`, `DEFAULT_EFFORT = 'high'` (:54-55).
- `readModel()` (:57-66) validates the stored id against the CURRENT roster, else `DEFAULT_MODEL`; `readEffort()` (:68-71).
- `formatModelLabel(id)` (:79-81) `MODELS.find(...)?.label ?? supersededModelLabel(id) ?? id`; `formatEffortLabel` (:84-86); `getSelectedModelLabel/getSelectedModel/getSelectedEffort/getSelectedEffortLabel` (:89-107).
- `usePinnedSelection()` (:123-142): reads `s.threadListItem?.remoteId` and `thread.isRunning` from assistant-ui, then `window.sessionsAPI.get(remoteId)` → `session.model` / `session.effort`.
- Model context provider (:162-168): `runtime.registerModelContextProvider({ getModelContext: () => ({ config: { modelName: model } }) })`; `changeModel` writes localStorage and dispatches `'cd:model-changed'`; `changeEffort` → `'cd:effort-changed'` (:172-183).
- Pinned chat renders a disabled chip (:195-214): title `This chat runs on ${pinnedModel}${' · '+pinnedEffort}, fixed when it started. Start a new chat to use a different model.`
- Menu: current model label+description (:228-234), Effort submenu with blurb "Higher effort means more thorough responses, but takes longer and uses your limits faster." (:249-251), "More models" submenu listing `MODELS` with label + description (:284-300).
- Test: `renderer/components/__tests__/ModelSelector.pin.test.tsx`.

### 3d. Send path → pin
- `renderer/chatAdapter.ts:92-95`: `const model = context?.config?.modelName ?? getSelectedModel(); const effort = getSelectedEffort();` → `:166-168` `window.chatAPI.sendMessage(threadId, userText, attachments, model, pendingDocPath, messageId, effort, quote)`; telemetry `model: modelForTelemetry` (:116, :131).
- `main/index.ts:2230` `ipcMain.handle('chat:send', (event, { threadId, text, attachments, model, documentPath, messageId, effort, quote }) …)`; key guard :2252-2257; pin rule :2294-2301:
```ts
const pinnedModel = existingDbSession?.model ?? undefined;
const pinnedEffort = existingDbSession?.effort ?? undefined;
const effectiveModel = pinnedModel ?? model;
const effectiveEffort = pinnedEffort ?? effort;
```
→ `createAgentSession(threadId, cbs, activeWorkspace!, existingDbSession?.sdk_session_id ?? undefined, undefined, handleNotificationNavigation, effectiveModel, undefined, documentPath, refreshAndPushCredentials, effectiveEffort)` (:2332-2345) → `setSessionModelInfo(threadId, { effort: effectiveEffort })` (:2355).
- `main/agentSession.ts:835-845` `createBody = JSON.stringify({ sessionId, resumeSessionId: resumeId, model: model || undefined, effort: effort || undefined, soulMd, hostGuidance, workspaceDirectoriesGuidance, permissionDeny, apiGuidance })` → `POST ${agentBaseUrl}/sessions`; log `[AgentSession] Session created: … model=… effort=…` (:855-857).
- Pin from the SDK init event `agentSession.ts:1404-1410`: `const resolvedModel = (message as any).model; if (subtype === 'init' && typeof resolvedModel === 'string') setSessionModelInfo(sessionId, { model: resolvedModel });`
- `main/db/chatRepository.ts:81-91` `setSessionModelInfo(id, info)`: `UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL` / `UPDATE sessions SET effort = ? WHERE id = ? AND effort IS NULL` (write-once). Columns from `main/db/database.ts:506-507` (`ALTER TABLE sessions ADD COLUMN model TEXT DEFAULT NULL; … effort TEXT DEFAULT NULL;` — migration 31 per CLAUDE.md). `Session` type :8-28 has `model: string | null; effort: string | null`.

### 3e. Header chip and every place a model id/label is rendered
- `renderer/components/command-desk/useSessionMeta.ts:26-50` reads `sessionsAPI.get(remoteId)` → `{model, effort, appDirName}`; `formatSessionModelMeta(meta, isEmptyChat)` (:60-67): pinned → `${formatModelLabel(model)} · ${formatEffortLabel(effort)}`; empty chat → picker's current selection; pre-pin chat → `null`.
- `renderer/components/command-desk/ChatHeader.tsx:30` `useSessionMeta(remoteId, isRunning)`; `:111` `modelMeta = formatSessionModelMeta(meta, isEmpty)`; `:136-138` renders `[modelMeta, isNewChat ? 'TITLE COMES AFTER THE FIRST REPLY' : null].join(' · ')`; re-renders on `'cd:model-changed'` (:51-54).
- Tool side-panel header: per CLAUDE.md (2026-09-23) the picker/locked chip is mounted in the panel header (`.cdSidePanel__meta .modelSelectorTrigger`) — `ToolWorkspace.tsx` was NOT read in this pass (INFERRED from CLAUDE.md).
- ModelSelector trigger/menus (:209-221, :230-231, :285-294); logs `[AgentSession] Session created … model=` and `[AgentServer] Starting query() with model=` (`agent-server/index.ts:615`), `[anthropic:complete]`/`[anthropic:stream] … model=` (`index.ts:2652, :2696`), `[Models] Discovered N model(s): <ids>` (`modelCatalog.ts:82`).
- Doc strings naming models: `bridge-api.md:101`, `SKILL.md:710` (`claude-haiku-5-5`), `DISCOVERED_DESCRIPTION` ("New from Anthropic"), `skills/acabox/SKILL.md:42` ("Acabox, built on Claude by Anthropic"), `:281` ("Requires an Anthropic API key (Settings → Account)").
- Context-window assumption: `shared/skills.ts:631-633` `ROSTER_CONTEXT_TOKENS_DEFAULT = 200_000` ("Context window of the models Acabox sends") feeding `ACABOX_ROSTER_BUDGET_FRACTION = 0.05` (:629) — a Claude Code `skillListingBudgetFraction` knob.

### 3f. Cost/pricing plumbing (no price table; dollars come only from the SDK)
- Capture: `main/agentSession.ts:1489-1503` result row `insertMessage(sessionId, 'result', JSON.stringify({ subtype, result, is_error, run_id: agentSessionId, ...(total_cost_usd), ...(duration_api_ms), ...(modelUsage), ...(stopped_by) }))`. `modelUsage` is STORED and never read anywhere (grep: only this write).
- Live per-turn: `:1534-1545` `turnCosts(listResultCostRows(sessionId))` → last value → `emitEvent({ type: 'turn-complete', messageId, ...(costUsd) })`; `shared/types.ts:40` `| { type: 'turn-complete'; messageId?: string; costUsd?: number }`; `renderer/chatAdapter.ts:280-290` puts `metadata.custom.costUsd` (+ `workedMs`) on the assistant message.
- Reload: `renderer/historyMessageConverter.ts:92-150` `turnCosts(dbMessages.filter(type==='result').map(parseCostRow))` → `metadata.custom.costUsd`.
- Chat total: `ipcMain.handle('sessions:cost', (_e, id) => chatTotalCost(listResultCostRows(id)))` (`index.ts:1862`); `chatRepository.ts:155-163` `SELECT content FROM messages WHERE session_id = ? AND type = 'result' ORDER BY id`; preload `sessionsAPI.cost` (:548).
- Rules `shared/turnCost.ts`: `parseCostRow` (:34-42, `total_cost_usd > 0` else null), `turnCosts` (:53-68: per-turn = delta from previous cumulative; a DROP means restart → own value; first costed row after uncosted rows → null), `chatTotalCost` (:74-84: sum of segment maxima), `formatCost` (:87-91: `<$0.01` or `$x.xx`, null → render nothing). Header comment :5-13: SDK `total_cost_usd` is cumulative across resumes. Test `shared/__tests__/turnCost.test.ts`.
- Rendering: `ChatHeader.tsx:33-44,139-143` `<span title="Estimated at list price.">… {costLabel} so far</span>`; fold line `renderer/components/assistant-ui/turnSteps.ts:280-296` `turnFoldLabel(stepCount, workedMs, stopped, costUsd)` → `Worked for 4m 12s · 26 steps · $0.14`; `turn-steps.tsx:229-231,258` reads `metadata.custom.costUsd`.
- Background calls (A–E) and mini-app calls (H, I) record NO cost anywhere.

---

## 4. API-key plumbing end to end

1. **Settings UI** `renderer/components/ApiKeySettings.tsx` (mounted in Settings at `DirectoryPermissions.tsx:420`, and in the dev Debug tab at `debug/AuthDebug.tsx:8`). On mount `window.authAPI.getApiKeyStatus()` → `setMaskedKey(status.maskedKey); setSource(status.source); setBaseURL(status.baseURL)` (:17-25). Heading "Anthropic API key"; status line `Key set by your system (ANTHROPIC_API_KEY)` / `Key saved: <masked> · <baseURL>` / `No API key set. Paste one below to use Acabox.`; env-managed → read-only notice (:60-64); password input placeholder `sk-ant-...` (:67-73); "Advanced" base-URL input (:74-83); Save → `window.authAPI.setApiKey(key, newBaseURL || undefined)` (:33); link to `https://console.anthropic.com/settings/keys` and "A Claude.ai Pro or Max subscription is not an API key. Usage is billed to your Anthropic API account." (:95-99); renders `result.warning`, `result.error`, and `check.verdict` accepted/rejected/unconfirmed (:101-122).
2. **Preload/types** `main/preload.ts:16-21` `authAPI = { getApiKeyStatus: () => invoke('auth:getApiKeyStatus'), setApiKey: (key, baseURL?) => invoke('auth:setApiKey', key, baseURL), isDev, setEndpoint: (endpoint) => invoke('auth:setEndpoint', endpoint) }`; `renderer/types.d.ts:125-131` `interface AuthAPI { getApiKeyStatus(): Promise<{ hasKey: boolean; source: 'env' | 'settings' | null; baseURL: string | null; maskedKey: string | null }>; setApiKey(key, baseURL?): Promise<{ success: boolean; error?: string; warning?: string; check?: { verdict: 'accepted'|'rejected'|'unconfirmed'; detail?: string } }>; isDev; setEndpoint… }`. (`auth:setEndpoint`, `index.ts:3415-3430`, toggles the legacy academia backend URL in dev only — unrelated to the model key.)
3. **IPC handlers** `main/index.ts:2743-2751` `auth:getApiKeyStatus` → `buildApiKeyStatus({ apiKey, baseURL, source: envKey ? 'env' : (getCustomAnthropicKey() ? 'settings' : null) })`; `shared/apiKeyCheck.ts:28-32` `maskApiKey`: `${key.slice(0,10)}…${key.slice(-4)}` (≤14 chars → `…xxxx`); `:35-46` `buildApiKeyStatus` returns `{hasKey, source, baseURL, maskedKey}` — the key itself never crosses IPC. `:2753-2795` `auth:setApiKey`: refuses when `process.env.ANTHROPIC_API_KEY` is set ("ANTHROPIC_API_KEY is set in the environment and takes precedence…"); `setCustomAnthropicKey(trimmed, url)`; `setCredentials(trimmed, url)`; `await refreshAndPushCredentials({ force: true })`; `void refreshModels({apiKey, baseURL}, true)`; `const check = await checkAnthropicKey(trimmed, url)`; returns `{success:true, check}` or `{success:true, warning:'Saved. The assistant was not reachable just now, so restart Acabox if the next message still reports a key problem.', check}`.
4. **On-disk store** `<userData>/cobuilding-settings.json`: `getCustomAnthropicKey()` (`index.ts:255-264`) → `decryptSecret(data.customAnthropicApiKey)`; `setCustomAnthropicKey(key, baseURL?)` (:266-275) writes `data.customAnthropicApiKey = encryptSecret(key); data.customAnthropicBaseURL = baseURL || null`; `getCustomAnthropicBaseURL()` (:297-304); `migratePlaintextApiKey()` (:281-295) re-encrypts at boot (:912). `main/secretStore.ts`: envelope `enc:v1:<base64>` (`PREFIX` :24), `encryptSecret` (:51-64, falls back to plaintext with a warning when `safeStorage.isEncryptionAvailable()` is false), `decryptSecret` (:74-83, returns `''` on a failed decrypt), `encryptRecord/decryptRecord/maskRecord` (:86-108).
5. **Resolution + in-memory store** `index.ts:310-316` `resolveApiKey()`: env `ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL`) wins, else settings. `:323-327` `loadCredentialsIntoStore()` → `setCredentials`. Boot `:921-931` (`bootCreds`, `lastPushedApiKey = bootCreds.apiKey`, log `[Auth] Loaded Anthropic API key from env|settings` / `[Auth] No Anthropic API key configured — user must add one in Settings`). `main/cobuildingTokenManager.ts:15-25` holds `currentApiKey/currentBaseURL`. `NO_API_KEY_MESSAGE = 'No Anthropic API key configured. Add one in Settings.'` (`index.ts:488`), guarded at `chat:send` (:2252-2257), `anthropic:complete` (:2649), `anthropic:stream` (:2679-2682).
6. **Into the harness** `AgentInfrastructureController.ts:453` `const { apiKey: agentApiKey, baseURL: agentBaseURL } = getCredentials();` → `agentConfig = { port: 8080, mcpServers, hostedServers, anthropicApiKey: agentApiKey ?? '', ...(agentBaseURL ? { anthropicBaseURL } : {}), model: DEFAULT_MODEL, effort: 'high', systemPrompt: { type: 'preset', preset: 'claude_code' }, allowedTools, skills, settingSources: ['project'] }` (:488-510) → `containerService.startAgentServer(JSON.stringify(agentConfig), workspacePath)` → written to `<userData>/agent.json` mode 0600 (`containerService.ts:505-508`, path from :50) and passed as env `COSCIENTIST_AGENT_CONFIG` (:522) → agent-server `sessionConfig.anthropicApiKey` → `query()` env `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` (§1d). Live update: `refreshAndPushCredentials({force})` (`index.ts:513-532`, short-circuits on `apiKey === lastPushedApiKey` unless forced) → `containerService.updateAgentCredentials(apiKey, baseURL)` (:663-689, `POST /credentials` body `{ anthropicApiKey, anthropicBaseURL: baseURL ?? null }`, 2 s timeout).
7. **Into the scanner** `BriefingsController` gets `getCredentials` + `ensureCredentials: () => { loadCredentialsIntoStore(); … }` (`index.ts:535-538`) → `ScanParams.apiKey/baseURL` (`BriefingsController.ts:81-99`) → `ScanContext` → env in `buildCommonQueryOptions` + `new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseURL })`.
8. **401 retry** `agentSession.ts:37-41` `isAuthError(msg)` = contains `401` AND (`authenticat`|`token`|`unauthorized`); `:1583` → `AuthRetryError` → `refreshAndPushCredentials` (no force) → same key ⇒ `false` ⇒ surfaced as key rejected. Calendar has its own 401/403 retry (§1a J).
9. **Guardrail hook** `hooks/block-secret-reads.sh` (PreToolUse on Bash/Read/Edit/Write) denies the agent reading `cobuilding-settings.json` and `claude-config/.claude.json`; parses with `/usr/bin/plutil`, jq fallback, fails closed. Claude-Code hook mechanism.
10. Tests: `shared/__tests__/apiKeyCheck.test.ts`, `main/__tests__/apiKeyCheck.test.ts`.

---

## 5. Claude-only features (note for removal / replacement)
- **Claude Design sign-in**: `main/claudeDesignLogin.ts` (spawns the bundled CLI `claude design-login --json [--status]`, :57-64; `claudeBinaryCandidates` finds `node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`), `shared/claudeDesign.ts` (protocol, `DESIGN_LOGIN_ENV_STRIP`, `DESIGN_LOGIN_TIMEOUT_MS = 6*60*1000`, parsers), `renderer/components/ClaudeDesignSettings.tsx` (mounted `DirectoryPermissions.tsx:372`), preload `claudeDesignAPI` (`preload.ts:40-50`: `claudeDesign:getStatus|signIn|submitCode|reopenPage|cancel`, event `claudeDesign:event`), `renderer/types.d.ts:133-135, 1312` (`ClaudeDesignAPI`). Relies on the SDK's `DesignSync` tool and `CLAUDE_CONFIG_DIR`. No PI equivalent → delete wholesale.
- **Key approval shim** `shared/claudeConfigApproval.ts:19-48` `ensureApiKeyApproved(configDir, apiKey)` writes `customApiKeyResponses.approved` (last 20 chars) into `<configDir>/.claude.json`; called from `agent-server/index.ts:620` and `directoryScanner/shared.ts:193`. Claude Code CLI quirk only.
- **`CLAUDE_CONFIG_DIR` plumbing** `main/claudeConfigDir.ts` (+ `scanner-claude-config` under userData, `shared.ts:190,208`), `COSCIENTIST_CLAUDE_CONFIG_DIR` env (`containerService.ts:529`). PI's analogue is `PI_CODING_AGENT_DIR` (confirmed above).
- **`UNSUPPORTED_MODEL_IDS`** (`models.ts:118-119`) exists only for the CLI-version gate ("Claude Code X does not support this model") — PI has no such gate.
- **Thinking/effort knobs**: `thinking: {type:'adaptive'}` + `effort` (agent server), `thinking: {type:'disabled'}` + `output_config.effort` (background), the `EffortId` union and the ModelSelector note "'max' is only honored on the most capable models".
- **Dead code regardless of harness**: `main/calendarAgentSession.ts` + `renderer/components/calendar/*` (§1a J); `migrateMissingManifests` is a dated migration (§1a B).
- Strings: `NO_API_KEY_MESSAGE`, ApiKeySettings copy, `DISCOVERED_DESCRIPTION`, `skills/acabox/SKILL.md:42,281`, `manage-mcp-server/SKILL.md:211` ("Notably absent: `ANTHROPIC_API_KEY`").

---

## 6. How the generic "APIs" proxy differs from the model proxy (summary only)
`main/apiProxy.ts` is a loopback HTTP server (port `23500..23599`, :51-52; binds the `127.0.0.1` literal, :528-530) that holds user-configured HTTP API credentials (`main/apiStore.ts`: `apis[]` in the same `cobuilding-settings.json`, secrets `encryptSecret`-ed, `listApis()` masked vs `listApisWithSecrets()`/`getApiWithSecret()` main-only, :119-140). `performApiRequest()` (:296) is "the only code in Acabox that ever sees a decrypted API secret"; callers reach it through identity-establishing doors: the agent over HTTP with `ACABOX_API_BASE`/`ACABOX_API_TOKEN` (per-run bearer tokens, `API_PROXY_TOKEN_HEADER`), mini-apps over postMessage `api:request` → `window.apisAPI.request(dirName, …)` (`MiniAppViewer.tsx:1643`) with the per-tool grant read from the manifest in main. Policy: host allowlist (`resolveTargetUrl`, `hostIsAllowed`), read-only gate (`READ_ONLY_METHODS`, 405 on writes unless `allowWrites`), auth injection by style `'none'|'bearer'|'header'|'query'|'basic'` (`shared/apis.ts:28`, `basicCredential` :411), manual redirect following with same-origin-only auth re-attach (:21-29 measured undici behaviour), buffered 100 MB request bodies, streamed responses, audit counters (`recordApiCall`). Differences from the model proxy: (1) generic HTTP passthrough vs a typed Messages-API call; (2) per-API, per-tool grants vs a single global key with no grant; (3) its own listener/port vs pure IPC (mini-apps deliberately get NO loopback URL because a `local-file://` frame has an opaque origin, `apiProxy.ts` header); (4) nothing is pushed to the agent server on change (reads the store per request) vs `POST /credentials`; (5) the Anthropic key is NOT an entry in this store. The Anthropic key is a separate, singular credential (`customAnthropicApiKey`). INFERRED: Acabox PI's multi-provider keys fit the apiStore pattern (per-provider encrypted entries, masked `hasSecret` over IPC) better than the single-key pattern.

---

## 7. Recommendations: what can move to a provider-agnostic cheap model, what must stay Anthropic-shaped

pi-ai 1.2.0 surfaces relevant to this (READ from `/private/tmp/.../scratchpad/pi-pkg/node_modules/@earendil-works/pi-ai/dist`): `complete/stream/completeSimple/streamSimple(model: Model<TApi>, context: Context, options?)` are declared in `compat.d.ts:63-66` (exported via the `"./compat"` subpath; NOT found in `index.d.ts` — INFERRED that the root entry does not export them in 1.2.0); `Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] }` (`types.d.ts:532`); `UserMessage.content: string | (TextContent | ImageContent)[]` with `ImageContent = { type: "image"; data: string; mimeType: string }` (:260, :352) — NO document/PDF content type; `AssistantMessage { content: (TextContent|ThinkingContent|ToolCall)[]; model; provider; usage: Usage; stopReason; durationMs? … }` (:357); `Usage.cost = { input, output, cacheRead, cacheWrite, total }` (:274); `BaseModel { id, name, api, provider, baseUrl, input: ModelInputModality[], cost: ModelCost, headers? }` + `Model { reasoning: boolean; thinkingLevelMap?; contextWindow: number; maxTokens: number; … }` (:632); `ModelCost` rates are `input/output/cacheRead/cacheWrite` in "USD per million tokens" (`providers/model-schema.js:16-21`); `calculateCost(model, usage)`, `getSupportedThinkingLevels`, `clampThinkingLevel`, `createModels()` (`models.d.ts:210-273`); `ThinkingLevel = minimal|low|medium|high|xhigh|max`, `ModelThinkingLevel` adds `off` (`providers/model-schema.d.ts:7-8`); `SimpleStreamOptions.reasoning?: ThinkingLevel` (`types.d.ts:227`); OAuth loaders `loadOpenAIChatGPTOAuth / loadOpenAICodexOAuth / loadAnthropicOAuth / loadOpenRouterOAuth` (`auth/oauth/load.d.ts:18-25`), `findEnvKeys(provider)` (`env-api-keys.d.ts:17`); pi-coding-agent `ModelRegistry` (`dist/core/model-registry.d.ts`: `refresh`, `getAll`, `getAvailable`, `find(provider, modelId)`, `getApiKeyAndHeaders(model)`, `getProviderAuthStatus(provider)`, `getProviderDisplayName`, `getApiKeyForProvider`) and `AuthStorage` (`dist/core/auth-storage.d.ts`: `create(authPath?)`, `inMemory`, `fromStorage`, `list`).

**(a) Switch to a provider-agnostic "background model" setting (text-in/text-out, read by block type, tiny caps):** A title generation, B manifest metadata, C YES/NO PDF classifier, D title extraction, E manuscript card. All are single user-message prompts with no tools, no system prompt except B/E-style instructions inside the user text, and all parse the reply with `messageText()` or a `/\{[\s\S]*\}/` regex — both provider-neutral. Replace `BACKGROUND_REQUEST` with a `backgroundModel()` resolver returning a pi `Model` and call `completeSimple(model, { messages: [{ role: 'user', content, timestamp }] }, { maxTokens, reasoning: <off> })`, then read text blocks (`contentText` is exported from pi-ai `utils/text`). Two cautions that are measured facts in Acabox: the caps 10/40/100/400 assume zero reasoning tokens (`models.ts:183-193`), so either pick models where reasoning can be turned off (`Model.reasoning === false` or `thinkingLevelMap` with `off`) or raise the caps; and C is one call per PDF with no count cap — the first candidate for a per-scan budget now that `Usage.cost.total` gives a real per-call dollar figure (Acabox never had one for these). Each of these calls should also record `usage.cost.total` somewhere (today they record nothing).

**(b) Scanner agents F and G need re-implementation, not re-pointing:** they are Agent-SDK `query()` runs with read-only tools + an in-process MCP document reader + PreToolUse hooks + `outputFormat: json_schema` + `maxTurns`/`maxBudgetUsd`. pi-coding-agent exports `createAgentSession`, `createReadOnlyTools`, `createReadTool`, `createFindTool`, `createGrepTool` (`dist/index.d.ts:20`), so the tool side maps; the JSON-schema structured output, the path-deny hooks, and the dollar budget have no equivalents I verified (UNKNOWN) — plan on prompt-level JSON + validation, a custom document-reader tool reusing `documentReaderMcpServer.ts:63-75`'s mammoth/pdf-parse code, and a `Usage.cost.total` accumulator for the budget. G's hardcoded `"claude-sonnet-4-6"` (`researchProfile.ts:35`) is a superseded id even today and should become a "scanner model" setting (default = chat default or a mid-tier model).

**(c) The mini-app bridge must stay Anthropic-SHAPED on the wire, with the translation behind the same IPC names:** shipped apps and docs depend on `AnthropicParams`/`AnthropicMessage` (`content[].type === 'text'`, `usage.input_tokens/output_tokens`, `model`), on the IPC names `anthropic:complete` / `anthropic:stream` / `anthropic:stream:event` and the postMessage names `anthropic:chunk|done|error`, and at least one template reads `content[0].text`. Keep `validateAnthropicParams` as the input contract and map: `system` → `Context.systemPrompt`; `messages[].content` text → `TextContent`; image base64/file → `ImageContent { data, mimeType }`; `model` string → `ModelRegistry.find(provider, id)` (accept `provider/id` and bare ids; keep the fallback-to-background-model behaviour and the "fallback means no thinking" rule); response → `{ id, type: 'message', role: 'assistant', model, content: [{type:'text', text}] (+ `{type:'thinking', thinking, signature: ''}` for ThinkingContent), stop_reason, usage: { input_tokens: usage.input, output_tokens: usage.output } }`; stream `TextContent` deltas → `chunk`. The one hard gap: `document` (PDF) blocks — pi-ai's `UserMessage` has no document type, so either keep a native Anthropic path for Anthropic-provider models (whether pi-ai's `anthropic-messages` adapter accepts PDF documents is UNKNOWN), or extract PDF text host-side (code exists) and send it as text, and say so in `bridge-api.md`. Also fix `westernBlotAnnotator/src/App.tsx:98-100` (model id + `content[0]`) while touching templates.

**(d) Roster:** replace `CURATED_MODELS` + Anthropic `/v1/models` discovery + `mergeModels` with `ModelRegistry.getAvailable()` grouped by provider (labels from `Model.name`, provider names from `getProviderDisplayName`), keep `DEFAULT_MODEL` as a deliberate pinned setting but as `{provider, id}`, keep the per-chat pin (store provider alongside `sessions.model`, or a `provider/id` composite — `setSessionModelInfo`'s write-once semantics and the `init`-event source both need a PI analogue), keep `formatModelLabel`'s "verbatim id when unknown" rule, drop `supersededModelLabel`/`UNSUPPORTED_MODEL_IDS`/`MAX_AUTO_ADDED_MODELS`/`discovered`. Effort: Acabox `EffortId` (`low|medium|high|xhigh|max`) maps 1:1 onto pi `ThinkingLevel` (which adds `minimal`); use `clampThinkingLevel(model, level)` instead of the "'max' only on capable models" note. Cost: `Model.cost` + `calculateCost` give per-call dollars for background AND mini-app calls; the chat header/fold can be fed per-turn sums of `AssistantMessage.usage.cost.total` instead of the SDK's cumulative `total_cost_usd`, which lets `turnCost.ts`'s cumulative-delta/restart rules go away (keep `formatCost`). The `modelUsage` column write at `agentSession.ts:1500` is dead and can be dropped.

**(e) Keys/auth:** generalise the singular `customAnthropicApiKey` into per-provider encrypted entries (apiStore pattern), keep `maskApiKey` + "never cross IPC", keep env precedence via `findEnvKeys(provider)`, replace `checkAnthropicKey` (Anthropic `/v1/models`) with a per-provider check (`ModelRegistry.refresh()` + `getProviderAuthStatus`, or a 1-token completion), replace `POST /credentials` with whatever the PI agent process reads (`AuthStorage` file under `PI_CODING_AGENT_DIR`, or in-memory via `AuthStorage.inMemory`/`fromStorage` — decide whether secretStore wraps it), add "Sign in with ChatGPT" via `loadOpenAIChatGPTOAuth`/`loadOpenAICodexOAuth` (callback-server + device-code helpers exist in `auth/oauth/`), and reword `NO_API_KEY_MESSAGE` to "No model provider configured".

**(f) Delete:** Claude Design (§5), `claudeConfigApproval.ts`, `claudeConfigDir.ts` + `scanner-claude-config`, the two PreToolUse hook scripts (need PI-side equivalents for install blocking and secret-read blocking — out of this report's scope), `calendarAgentSession.ts` + `renderer/components/calendar/*`, `migrateMissingManifests` (dated migration), `auth:setEndpoint` (academia backend toggle).


## KEY FACTS
- Direct Anthropic SDK clients are constructed in exactly five files: main/index.ts (title gen + two mini-app proxy handlers), AgentInfrastructureController.ts (manifest metadata), directoryScanner/agents/fileTagging.ts (three background prompts), calendarAgentSession.ts.
  - evidence: grep over src for `new Anthropic` excluding tests: index.ts:2201, :2654, :2698; AgentInfrastructureController.ts:611; fileTagging.ts:116, :475, :526, :548; calendarAgentSession.ts:622, :647
- Every background call sends BACKGROUND_REQUEST = { model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'low' } } and reads the reply by block type via messageText().
  - evidence: shared/models.ts:194-198 `export const BACKGROUND_REQUEST = { model: BACKGROUND_MODEL, thinking: { type: 'disabled' }, output_config: { effort: 'low' }, } as const;` and :208-213 messageText
- Title generation uses max_tokens 40 with a single user message and no system prompt.
  - evidence: main/index.ts:2202-2211 `client.messages.create({ ...BACKGROUND_REQUEST, max_tokens: 40, messages: [{ role: 'user', content: \`Give a short title (5 words or less)...` and :2212 `const title = messageText(response).trim();`
- The PDF reference classifier is one 10-token YES/NO call per untagged PDF with no cap on the number of PDFs.
  - evidence: fileTagging.ts:125-127 `const message = await client.messages.create({ ...BACKGROUND_REQUEST, max_tokens: 10,` inside `for (const relPath of untagged)` (:118), untagged from `findAllPdfs` walk (:71-92)
- The research-profile scanner agent hardcodes claude-sonnet-4-6, a superseded roster id, with maxTurns 10, maxBudgetUsd 2 and json_schema output.
  - evidence: researchProfile.ts:33-43 `model: "claude-sonnet-4-6", systemPrompt: buildSystemPrompt(), maxTurns: 10, maxBudgetUsd: 2, outputFormat: { type: "json_schema", schema: RESEARCH_PROFILE_SCHEMA }`
- The file-tagging scanner agent runs on BACKGROUND_MODEL with maxTurns 15, maxBudgetUsd 1 and json_schema output; both scanner agents share buildCommonQueryOptions (tools Read/Glob/Grep + document-reader MCP, thinking disabled, effort low, deny hooks).
  - evidence: fileTagging.ts:36-49 `model: BACKGROUND_MODEL, ... maxTurns: 15, maxBudgetUsd: 1, outputFormat: { type: "json_schema"`; shared.ts:194-223 `tools: ["Read", "Glob", "Grep", docReaderTool], ... thinking: { type: "disabled" as const }, effort: "low" as const`
- The mini-app proxy clamps the requested model to KNOWN_MODEL_IDS ∪ discovered ids and falls back to BACKGROUND_MODEL with thinking disabled only on fallback; max_tokens is clamped to 4096 with default 1024.
  - evidence: main/index.ts:2629-2644 `const requested = typeof p.model === 'string' && anthropicAllowedModels().has(p.model) ? p.model : null; const model = requested ?? BACKGROUND_MODEL; ... return { messages, model, max_tokens, system, ...(requested ? {} : { thinking: { type: 'disabled' as const } }) };` and :2466 `const ANTHROPIC_MAX_TOKENS_LIMIT = 4096;`
- The iframe bridge contract is window.anthropicAPI.complete(params)/stream(params,onChunk) with postMessage types anthropic:complete, anthropic:stream, anthropic:chunk, anthropic:done, anthropic:error, and an AnthropicMessage type of {id, content[], model, usage:{input_tokens, output_tokens}}.
  - evidence: skills/manage-mini-application/assets/bridge/bridge.ts:66-76 `export interface AnthropicMessage { id: string; content: Array<...>; model: string; usage: { input_tokens: number; output_tokens: number }; }` and :226-258 anthropicAPI; :255 `window.parent.postMessage({ type: 'anthropic:stream', id, ...params }, '*');`
- The streaming IPC is one channel 'anthropic:stream:event' demultiplexed by a renderer-minted UUID streamKey; events are {streamKey, type:'chunk'|'done'|'error', payload}.
  - evidence: main/preload.ts:879-882 `ipcRenderer.on('anthropic:stream:event', (_event, msg: { streamKey: string; type: string; payload: unknown }) => { anthropicStreamHandlers.get(msg.streamKey)?.(msg); });` and MiniAppViewer.tsx:1691 `const streamKey = crypto.randomUUID();`
- The shipped westernBlotAnnotator template names claude-opus-4-20250514 and reads response.content[0].text, contrary to the bridge docs.
  - evidence: westernBlotAnnotator/src/App.tsx:98-100 `model: "claude-opus-4-20250514", max_tokens: 1024, }); return response.content[0].text.trim();`
- The roster is a curated six-model table plus a superseded list, DEFAULT_MODEL is claude-opus-5-5, and discovery only prepends models newer than every known id (capped at 6).
  - evidence: shared/models.ts:48-55 CURATED_MODELS, :65-73 SUPERSEDED_MODELS, :160 `export const DEFAULT_MODEL = 'claude-opus-5-5';`, :170 `MAX_AUTO_ADDED_MODELS = 6`, :238-269 mergeModels `return [...newcomers, ...CURATED_MODELS];`
- Model discovery is GET /v1/models with x-api-key + anthropic-version 2023-06-01, cached 6 h, single-flight, never throws.
  - evidence: main/modelCatalog.ts:21-23, :39 `const CACHE_TTL_MS = 6 * 60 * 60 * 1000;`, :110-116 `fetch(url.toString(), { headers: { 'x-api-key': creds.apiKey, 'anthropic-version': ANTHROPIC_VERSION }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })`
- The picker persists selection in localStorage keys 'selectedModel' and 'selectedEffort', effort levels are low|medium|high|xhigh|max (default high), and the model rides to the chat adapter through assistant-ui's model context as config.modelName.
  - evidence: ModelSelector.tsx:41 `export type EffortId = 'low' | 'medium' | 'high' | 'xhigh' | 'max';`, :52-55 `const MODEL_KEY = 'selectedModel'; const EFFORT_KEY = 'selectedEffort'; ... DEFAULT_EFFORT: EffortId = 'high';`, :162-168 `registerModelContextProvider({ getModelContext: () => ({ config: { modelName: model } }) })`; chatAdapter.ts:92-95
- A chat's model is pinned write-once from the SDK init event's resolved model and effort from the first send; the pin beats the picker on later turns.
  - evidence: main/index.ts:2298-2301 `const effectiveModel = pinnedModel ?? model; const effectiveEffort = pinnedEffort ?? effort;`; agentSession.ts:1407-1410 `if ((message as any).subtype === 'init' && typeof resolvedModel === 'string' && resolvedModel) { setSessionModelInfo(sessionId, { model: resolvedModel }); }`; chatRepository.ts:87 `UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL`
- Acabox has no price table; chat dollars come only from the SDK's cumulative total_cost_usd on result rows, turned into per-turn deltas by shared/turnCost.ts; modelUsage is stored but never read.
  - evidence: agentSession.ts:1498-1500 stores `total_cost_usd`, `duration_api_ms`, `modelUsage`; shared/turnCost.ts:53-68 turnCosts; grep for modelUsage readers returns only the write at agentSession.ts:1500; ChatHeader.tsx:140 `<span title="Estimated at list price.">`
- The API key is stored encrypted as customAnthropicApiKey (enc:v1: envelope via safeStorage) in cobuilding-settings.json, env ANTHROPIC_API_KEY takes precedence, and only a masked form crosses IPC.
  - evidence: main/index.ts:266-275 `data.customAnthropicApiKey = encryptSecret(key); data.customAnthropicBaseURL = baseURL || null;`, :310-316 resolveApiKey, secretStore.ts:24 `const PREFIX = 'enc:v1:';`, shared/apiKeyCheck.ts:28-32 maskApiKey, :44 `maskedKey: maskApiKey(args.apiKey)`
- Saving a key pushes it live to the agent server via POST /credentials {anthropicApiKey, anthropicBaseURL}, force-refreshes discovery, and verifies with GET /v1/models?limit=1 (2xx accepted, 401/403 rejected, else unconfirmed).
  - evidence: main/index.ts:2766-2779; containerService.ts:671 `const body = JSON.stringify({ anthropicApiKey: apiKey, anthropicBaseURL: baseURL ?? null });`; main/apiKeyCheck.ts:19-21; shared/apiKeyCheck.ts:21-24
- The key reaches the harness through <userData>/agent.json (mode 0600) via COSCIENTIST_AGENT_CONFIG and is handed to query() as env ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL after a Claude-Code-only approval write.
  - evidence: containerService.ts:505-508, :522; agent-server/index.ts:620 `ensureApiKeyApproved(getClaudeConfigDir(), sessionConfig.anthropicApiKey);` and :645-647 `ANTHROPIC_API_KEY: sessionConfig.anthropicApiKey, ...(sessionConfig.anthropicBaseURL ? { ANTHROPIC_BASE_URL: sessionConfig.anthropicBaseURL } : {})`
- The calendar assistant (hardcoded claude-sonnet-4-6, max_tokens 8192, tool loop) is unreachable from the renderer: nothing outside renderer/components/calendar/ imports from it and index.tsx has no calendar reference.
  - evidence: calendarAgentSession.ts:630-635 `model: 'claude-sonnet-4-6' as const, max_tokens: 8192, system: systemPrompt, tools: CALENDAR_TOOLS`; grep for importers of components/calendar returned nothing; `grep -n -i calendar renderer/index.tsx` returned nothing; main branch at index.ts:2282
- Scheduled task runs pass no model/effort and therefore run on the boot default (Opus 5.5, effort high).
  - evidence: scheduledTasks/runner.ts:42-44 `undefined, undefined, undefined, refreshAndPushCredentials,`; AgentInfrastructureController.ts:493-496 `model: DEFAULT_MODEL, ... effort: 'high',`
- PI relocates its agent directory through PI_CODING_AGENT_DIR.
  - evidence: pi/packages/coding-agent/docs/environment-variables.md:81 `| PI_CODING_AGENT_DIR | Override the config directory; default is ~/.pi/agent |`
- pi-ai's UserMessage content admits only text and image blocks (no PDF/document type), while Acabox's mini-app bridge and chat attachments carry document blocks.
  - evidence: pi-ai/dist/types.d.ts:352-356 `content: string | (TextContent | ImageContent)[];`, :260-264 `ImageContent { type: "image"; data: string; mimeType: string; }`; bridge.ts:81 document ContentBlock; shared/types.ts:56 `| { type: 'document'; data: string; mediaType: string; ... }`
- pi-ai exposes per-call cost (Usage.cost.total) and per-model USD-per-million rates, and thinking levels minimal|low|medium|high|xhigh|max (plus off at model level).
  - evidence: pi-ai/dist/types.d.ts:274-296 `cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }`; providers/model-schema.js:16-21 `input: Type.Number({ description: "Input cost in USD per million tokens." })`; providers/model-schema.d.ts:7-8 ThinkingLevelSchema / ModelThinkingLevelSchema

## RISKS
- Background-call token caps (10/40/100/400) assume zero reasoning tokens (models.ts:183-193). Re-pointing them at a provider/model whose reasoning cannot be disabled (e.g. OpenAI reasoning-only models) will return empty replies exactly as Haiku 5.5 did before BACKGROUND_REQUEST was introduced.
- The PDF classifier (fileTagging.ts:94-161) is one model call per untagged PDF with no count cap; on a multi-provider roster a mis-set background model could make a single Rescan expensive. A per-scan dollar budget using pi-ai Usage.cost is the natural guard.
- Changing the mini-app bridge wire shape (IPC names anthropic:complete/anthropic:stream/anthropic:stream:event, postMessage anthropic:chunk|done|error, AnthropicMessage/AnthropicParams) breaks shipped and exported apps; westernBlotAnnotator reads content[0].text and names a model not in the roster. Keep the shape and translate behind it.
- pi-ai's UserMessage has no document/PDF content type (types.d.ts:352-356), but the mini-app bridge (bridge.ts:81) and chat attachments (shared/types.ts:56) both carry PDF document blocks. Either keep an Anthropic-native path for Anthropic models or extract text host-side; whether pi-ai's anthropic-messages adapter accepts documents was not checked.
- Session pinning stores only a bare model string (sessions.model); a multi-provider roster needs the provider recorded too (new column or provider/id composite), and the 'resolved model from the SDK init event' source has no verified PI analogue.
- The chat cost pipeline (turnCost.ts) encodes the Claude Agent SDK's cumulative-across-resumes total_cost_usd semantics; feeding it per-turn pi-ai usage without changing the rules would mis-compute (a per-turn value read as cumulative would make every turn after the first look like a restart).
- Two scanner agents rely on Agent-SDK-only features (outputFormat json_schema, maxBudgetUsd, PreToolUse deny hooks, in-process createSdkMcpServer); their PI replacements must re-create structured output, path containment and budget by hand.
- The calendar assistant code path in main (chat:send threadId === 'calendar-assistant') is live even though no UI reaches it; leaving it means a second hardcoded Claude model id survives the migration.
- Scheduled tasks run unattended on the boot default model with effort high; on a multi-provider roster the default should be an explicit setting the scheduler reads, not the agent-server fallback.
- ROSTER_CONTEXT_TOKENS_DEFAULT = 200_000 (skills.ts:633) and the skill roster budget are Claude Code CLI concepts; PI's context handling may make them moot, but any port must not carry the constant forward blindly.

## UNKNOWNS
- Whether pi-ai 1.2.0's anthropic-messages adapter supports PDF document blocks through provider-specific options (only the generic UserMessage type was read).
- Whether complete/stream/completeSimple/streamSimple are reachable from the root '@earendil-works/pi-ai' entry in 1.2.0 or only from the './compat' subpath (declarations were found only in dist/compat.d.ts; dist/index.d.ts re-exports api/lazy, models, utils but no stream module was found).
- pi-coding-agent equivalents for the Agent SDK's outputFormat json_schema, maxBudgetUsd, maxTurns and PreToolUse hooks were not investigated.
- Where pi-coding-agent persists AuthStorage credentials under PI_CODING_AGENT_DIR and in what format (encrypted or plaintext) — needed before deciding whether Acabox's secretStore should wrap it.
- The tool side-panel header's model chip (ToolWorkspace.tsx) was not read; its existence and selector are taken from CLAUDE.md (2026-09-23 entry).
- Whether any exported/user-authored mini-app outside the repo calls window.anthropicAPI with a named model or reads content[0] (only the shipped template and prebuilt grantFinder were checked).
- The exact ModelCost tier semantics (ModelCostTierSchema 'inputTokensAbove') and how calculateCost applies cache rates per provider were not read in detail.
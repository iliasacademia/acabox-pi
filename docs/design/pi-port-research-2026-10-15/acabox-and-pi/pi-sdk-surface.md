# PI 1.2.0 TypeScript SDK surface — host-adapter reference

Legend: **READ** = taken verbatim/line-referenced from source; **MEASURED** = observed by running the published package under Electron 37.2.0 (`ELECTRON_RUN_AS_NODE=1`, bundled Node 22.17.0, `PI_OFFLINE=1`, agent dir redirected to scratch, no provider network calls, no prompt sent); **INFERRED** = my reading of consequences, not executed.

Path roots (absolute; every pointer below is relative to one of these):
- `SRC` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-src/pi/packages`
- `CA` = `SRC/coding-agent/src`, `AG` = `SRC/agent/src`, `AI` = `SRC/ai/src`
- `DOCS` = `SRC/coding-agent/docs`, `EX` = `SRC/coding-agent/examples/sdk`
- Published package: `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-pkg/node_modules/@earendil-works/pi-coding-agent` (ESM-only, `"type":"module"`, `exports["."] = ./dist/index.js` + `.d.ts`; `engines.node >=22.19.0` — MEASURED to load and run on 22.17.0)
- Probe scripts I ran: `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/work-sdk-surface/probe2.mjs` and `probe3.mjs` (`node_modules` symlinked from pi-pkg).

---

## 0. Doc vs code disagreements found (code wins)

| Claim in docs/examples | Code |
|---|---|
| `EX/README.md:113` thinkingLevel default `"off"`, options "off, low, medium, high" | `CA/core/sdk.ts:59` says `'medium'`; `CA/core/defaults.ts:3` `DEFAULT_THINKING_LEVEL = "medium"`; full union is `"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"` (`AG/types.ts:349`) |
| `CA/core/sdk.ts:172-174` JSDoc example `createAgentSession({ continueSession: true })` | No such option in `CreateAgentSessionOptions` (`sdk.ts:48-106`); use `SessionManager.continueRecent(cwd)` (`EX/11-sessions.ts:24-26`) |
| `EX/README.md:36` `import { getModel } from "@earendil-works/pi-ai"` | MEASURED: `SyntaxError: ... does not provide an export named 'getModel'`. It lives in `@earendil-works/pi-ai/compat` (`AI/compat.ts:64-65`, deprecated alias of `getBuiltinModel`); `EX/12-full-control.ts:7` imports from `/compat`. Prefer `modelRuntime.getModel(provider, id)` (`EX/02-custom-model.ts:12`). |
| `EX/README.md:114` `tools` default `["read","bash","edit","write"]` | True (`CA/core/settings-manager.ts:85`), but `tools` is an ALLOWLIST that also filters `customTools` — MEASURED: `tools:["read","bash"]` + `customTools:[probe_A]` → `getAllTools()` = `read, bash` only; `probe_A` never registered. Name custom tools in the list (`EX/12-full-control.ts:58`) or use `+name` modifiers. |
| `DOCS/environment-variables.md:82` `PI_CODING_AGENT_SESSION_DIR` overrides session storage | Defined as `ENV_SESSION_DIR` (`CA/config.ts:586`); I did not find the SDK path reading it (only CLI); SDK callers pass `sessionDir` to `SessionManager.create(cwd, sessionDir)` (`CA/core/session-manager.ts:1755-1758`). UNKNOWN whether SDK honours the env var. |

---

## 1. `createAgentSession` options (READ, verbatim `CA/core/sdk.ts:48-106`)

```ts
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;
	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;
	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	noTools?: "all" | "builtin";
	tools?: string[];          // allowlist of names/patterns (`*`), OR a list of only `+name`/`-name` modifiers; mixing throws
	excludeTools?: string[];   // denylist, applied after `tools`, MCP tools included
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];
	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;
	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;
	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}
export interface CreateAgentSessionResult { session: AgentSession; extensionsResult: LoadExtensionsResult; modelFallbackMessage?: string; }  // sdk.ts:109-116
```
Resolution order inside the factory (`sdk.ts:191-294`):
- `cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd())` (192); `agentDir = options.agentDir ? resolvePath(...) : getAgentDir()` (193).
- `modelRuntime ?? await ModelRuntime.create({ authPath, modelsPath })` where both paths are `undefined` unless `options.agentDir` was given (196-198) → then `ModelRuntime.create` itself defaults `modelsPath` to `join(getAgentDir(),"models.json")` (`CA/core/model-runtime.ts:219-220`) and auth to `AuthStorage.create(authPath)` (218).
- `settingsManager ?? SettingsManager.create(cwd, agentDir)` (200); `sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))` (201) — **persistent by default**.
- `resourceLoader ?? new DefaultResourceLoader({cwd, agentDir, settingsManager}); await reload()` (203-207).
- Model: explicit → else restored from the session's `model_change` entries if auth is configured (219-232) → else `findInitialModel` (235-251: settings `defaultProvider/defaultModel`, then per-provider defaults among available, then first available; `CA/core/model-resolver.ts:543-610`); none → `modelFallbackMessage = formatNoModelsAvailableMessage()`.
- Thinking: explicit → session's `thinking_level_change` → per-model setting → `settings.defaultThinkingLevel` → `"medium"`; then `clampThinkingLevel(model, level)` (277); no model → `"off"`.
- Tools (280-294): `getToolListError` validates; `defaultToolNames = noTools ? [] : settings.defaultTools ?? ["read","bash","edit","write"]`; modifiers (`+x`/`-x`) are applied to the defaults; plain list = allowlist.
- Agent construction (411-446): `new Agent({ initialState:{ systemPrompt:"", model, thinkingLevel, tools:[], messages: existingSession.messages }, convertToLlm (image-blocking aware), streamFn: modelRuntime.streamSimple(+cache warmer), sessionId: sessionManager.getSessionId(), steeringMode/followUpMode/transport/thinkingBudgets/maxRetryDelayMs from settings })`.
- New session: appends `model_change` + `thinking_level_change` entries immediately (453-459) — MEASURED: `sessionManager.getEntries()` = `model_change,thinking_level_change` before any prompt.
- Module side effect at import: `setDefaultStreamFn(streamSimple)` (`sdk.ts:46`).

MEASURED: two sessions created in 5 ms; `tools:["read","bash","host_echo"], excludeTools:["bash"]` → active `read,host_echo`; `noTools:"builtin"` → active `host_echo`, all 8 built-ins still registered; `tools:["+host_echo","-bash"]` → active `read,edit,write,host_echo`; `thinkingLevel:"high"` on `openai/gpt-4.1` (reasoning:false) → clamped to `off`.

Lower-level factories (`CA/core/agent-session-services.ts:135-233`): `createAgentSessionServices({cwd, agentDir?, settingsManager?, modelRuntime?, modelRuntimeSignal?, extensionFlagValues?, resourceLoaderOptions?, resourceLoaderReloadOptions?})` → `{cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics}`; `createAgentSessionFromServices({services, sessionManager, sessionStartEvent?, model?, thinkingLevel?, scopedModels?, tools?, excludeTools?, noTools?, customTools?})` → same result type. Note it also applies extension-registered providers/virtual models and runs `modelRuntime.refresh({allowNetwork:false})` (158-194).

---

## 2. `AgentSession` public surface (READ `CA/core/agent-session.ts`)

Fields: `readonly agent: Agent; readonly sessionManager: SessionManager; readonly settingsManager: SettingsManager` (380-382); `get modelRuntime(): ModelRuntime` (529).

Lifecycle / events:
- `subscribe(listener: AgentSessionEventListener): () => void` (1373) — listener is **synchronous** `(event)=>void` (240); `_emit` iterates synchronously (1040-1044). Extensions get the event first, then public listeners (1143-1145); SessionManager persistence of `message_end` happens AFTER listeners (1148-1168).
- `dispose(): void` (1397-1418): abortRetry/abortCompaction/abortBranchSummary/abortBash, `agent.abort()`, invalidates extension contexts, disconnects, clears listeners, cancels cache warmer, `cleanupSessionResources(sessionId)`.
- `refreshContext()` (1425); `get state(): AgentState` (1430); `get messages(): AgentMessage[]` (1637); `get isStreaming` (1464, = a session run is active); `get isIdle` (1469, = no run and not compacting); `get isCompacting` (1628); `get isRetrying` (3842); `get retryAttempt` (1479).

Prompting:
- `prompt(text: string, options?: PromptOptions): Promise<void>` (2058-2141). `PromptOptions` (315-326): `expandPromptTemplates?: boolean` (default **true**: a leading `/` dispatches extension commands and expands `/skill:` + prompt templates — 2067-2074, 2096-2101), `images?: ImageContent[]`, `streamingBehavior?: "steer"|"followUp"` (**required** while streaming, else throws 2104-2108), `source?: "interactive"|"rpc"|"extension"`, `preflightResult?: (d: "handled"|"queued"|"started") => void`. Pre-flight: throws if compaction in progress (2077-2080), if no model (`formatNoModelSelectedMessage`, 2120), if provider has no auth (2123-2136; MEASURED `"No API key found for openai."`, thrown before any network, `messages.length` stays 0). Resolves after `agent_settled` (1874-1882 → `_emitAgentSettled`).
- `sendUserMessage(content: string | (TextContent|ImageContent)[], options?: { deliverAs?: "steer"|"followUp"; expandPromptTemplates?: boolean })` (2395-2425) — `expandPromptTemplates` defaults **false**, `source:"extension"`. Use this (or `prompt(..., {expandPromptTemplates:false})`) for relaying raw user text.
- `steer(text, images?, options?: {source?}): Promise<"handled"|"queued">` (2241-2247); `followUp(...)` (2257-2263). MEASURED: `steer()` while idle returns `"queued"` and stays queued (delivered by the next run's initial steering poll, `AG/agent-loop.ts:176`). Throws if text is an extension command (2298-2308).
- `sendCustomMessage(message: Pick<CustomMessage,"customType"|"content"|"display"|"details">, options?: { triggerTurn?: boolean; deliverAs?: "steer"|"followUp"|"nextTurn" })` (2323-2359). MEASURED idle + `triggerTurn:false` → appended, `message_start`/`message_end` emitted, entry type `custom_message`.
- `clearQueue(): {steering: string[]; followUp: string[]}` (2432); `pendingMessageCount` (2443); `getSteeringMessages()`/`getFollowUpMessages()` (2448/2453).
- `abort(): Promise<void>` (2464-2474); `waitForIdle(): Promise<void>` (2476). MEASURED: both resolve immediately when idle, no events.

Model / thinking:
- `get model(): Model<any>|undefined` (1446); `get thinkingLevel()` (1451); `get routedModel()` (1456, virtual models only).
- `setModel(model, {persist?}): Promise<void>` (2507-2527): throws `No API key for ${provider}/${id}` unless `modelRuntime.checkAuth(provider)`; writes `model_change` entry; recomputes thinking level via `_getThinkingLevelForModelSwitch` (2699-2711); emits extension `model_select`. `persist:true` writes settings `defaultProvider/defaultModel`.
- `setThinkingLevel(level, {persist?}): void` (2642-2665): clamps; on change appends `thinking_level_change` and emits `{type:"thinking_level_changed", level}`. `cycleModel`, `cycleThinkingLevel`, `getAvailableThinkingLevels()` (2687, MEASURED claude-sonnet-4-5 → `off,minimal,low,medium,high`; gpt-4.1 → `off`), `supportsThinking()`, `scopedModels`/`setScopedModels`.
- Mid-run effect: `_installAgentRequestProjection` (788-845) returns `model: this.agent.state.model, thinkingLevel: this.agent.state.thinkingLevel` on EVERY provider request (805-806, 813-815), so a `setModel`/`setThinkingLevel` during a run applies to the next request of that run (READ).

Tools:
- `getActiveToolNames(): string[]` (1487); `getCallableToolNames()` (1492); `getAllTools(): ToolInfo[]` (1499; `ToolInfo` = name/description/parameters/promptGuidelines/reachesTools + exposure/namespace/annotations/sourceInfo, `CA/core/extensions/types.ts:2122-2130`); `getToolDefinition(name)` (1513); `setActiveToolsByName(names: string[]): void` (1523-1530: unknown/hidden ignored; rebuilds prompt; takes effect next turn).
- `get systemPrompt(): string` (1474) — effective prompt incl. unsent changes.

Session / misc: `sessionFile` (1652, `undefined` for in-memory), `sessionId` (1657, uuidv7), `sessionName`/`setSessionName` (1662/3972), `promptTemplates` (1677), `resourceLoader` (2457), `steeringMode`/`followUpMode` + setters (1642-1647, 2730-2741), `compact(customInstructions?): Promise<CompactionResult>` (2794, aborts the run first), `abortCompaction`/`abortBranchSummary` (2944/2952), `autoCompactionEnabled`/`setAutoCompactionEnabled` (3279-3286), `autoRetryEnabled`/`setAutoRetryEnabled`/`abortRetry` (3837-3856), `bindExtensions(bindings: ExtensionBindings): Promise<void>` (3288-3312; `ExtensionBindings = { uiContext?, mode?: "tui"|"rpc"|"json"|"print", commandContextActions?, abortHandler?, shutdownHandler?, onError? }` 302-309; emits `session_start` to extensions — required for MCP/extension startup, `EX/14-codemode-mcp.ts:50`), `reload()` (3690; calls global `resetApiProviders()` 3705), `executeBash(command, onChunk?, {excludeFromContext?, id?, operations?}): Promise<BashResult>` (3871; emits `bash_execution_update`), `recordBashResult`, `abortBash`, `isBashRunning`, `navigateTree(targetId, {summarize?, customInstructions?, replaceInstructions?, label?})` (3994), `getUserMessagesForForking()` (4191), `getSessionStats(): SessionStats` (4213), `getContextUsage(): {tokens: number|null, contextWindow, percent}|undefined` (4267), `exportToHtml`, `exportToJsonl(outputPath?)` (4344), `summarizeForBugReport`, `getLastAssistantText()` (4377, skips empty aborted), `createReplacedSessionContext()`, `hasExtensionHandlers(type)`, `get extensionRunner` (4425).

`AgentSessionRuntime` (`CA/core/agent-session-runtime.ts:74-412`): `session`, `services`, `cwd`, `diagnostics`, `modelFallbackMessage`, `setRebindSession(fn)`, `setBeforeSessionInvalidate(fn)`, `switchSession(sessionPath, {cwdOverride?, withSession?, projectTrustContextFactory?}): Promise<{cancelled}>` (196), `newSession({parentSession?, setup?, withSession?})` (226; in-memory manager stays in-memory 238-240), `fork(entryId, {position?: "before"|"at", withSession?})` (262), `importFromJsonl(path, cwdOverride?)` (359), `dispose()` (404). Each replacement calls `session.abort()` then `session.dispose()` (167-178) — **subscriptions must be rebound** (`EX/13-session-runtime.ts:40-50`). `createAgentSessionRuntime(factory, {cwd, agentDir, sessionManager, sessionStartEvent?})` (420).

---

## 3. Complete event union via `session.subscribe` (READ)

`CA/core/agent-session.ts:196-237`:
```ts
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>   // adds `parentToolCallId?: string` to tool_execution_* (188-193)
	| { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean; }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[]; }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string; }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| { type: "summarization_retry_attempt_start"; source: "compaction"; reason: "manual" | "threshold" | "overflow"; }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };
```
Core `AgentEvent` (`AG/types.ts:516-539`):
```ts
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }           // system, user, assistant, toolResult
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }   // assistant only
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean; durationMs?: number; };
```
`AssistantMessageEvent` (`AI/types.ts:806-822`): `start | text_start | text_delta{contentIndex, delta} | text_end{content} | thinking_start | thinking_delta | thinking_end | toolcall_start | toolcall_delta{delta} | toolcall_end{toolCall} | done{reason: "stop"|"length"|"toolUse"|"deferred", message} | error{reason: "aborted"|"error", error: AssistantMessage}`, each (except done/error) carrying `partial: AssistantMessage` (the live response-so-far). `event.message` on `message_update` is a shallow copy of `partial` (`AG/agent-loop.ts:435-439`). The CLI's wire format drops `partial` and adds `usage` + tool-call `id`/`toolName` on `toolcall_start` (`CA/modes/json-event.ts:46-61`, exported type `JsonAgentSessionEvent`) — a host SSE relay should copy that.

Ordering for one run (READ `AG/agent-loop.ts:102-321, 381-469, 530-660`): `agent_start` → `turn_start` → `message_start`+`message_end` for each prompt message (a `system` patch message precedes the user message on the first turn and whenever the prompt/tool loadout changed, `CA/core/agent-session.ts:1937-1940`, `AG/agent-loop.ts:333-363`) → `message_start`(assistant, `stopReason:"pending"`) → `message_update`* → `message_end`(assistant, terminal stopReason) → per tool call: `tool_execution_start` → `tool_execution_update`* → `tool_execution_end` → `message_start`/`message_end`(toolResult; in parallel mode `tool_execution_end` is emitted in completion order and toolResult messages later in source order, `AG/types.ts:43-46`) → `turn_end{message, toolResults}` → loop (next `turn_start`) or `agent_end{messages, willRetry}` → (host-level retry/compaction/continuation may start another `agent_start`) → `agent_settled{aborted}`. `queue_update` fires when a steer/followUp is enqueued and again when it is consumed (1121-1141). Only `agent_settled` means "Pi will not continue automatically" (`DOCS/sdk.md:69-73`). `agent_end.willRetry` is computed from retry settings + `isRetryableAssistantError` (1202-1216).

Extension-side events (for permission gating etc., `CA/core/extensions/types.ts:1405-1437`): `tool_call` (blockable, `ToolCallEventResult {block?, reason?, terminate?}` 1454-1463; `event.input` mutable), `tool_result` (1483-1489), `before_agent_start`, `turn_start/turn_end` (1058-1072, with `turnIndex`, `messageEntryId`, `toolResultEntryIds`), `message_end` (replaceable), `session_start`, `context`, `before_provider_request`, `input`, `model_select`, `thinking_level_select`, … Registered via `DefaultResourceLoader({ extensionFactories: [(pi) => pi.on("tool_call", …)] })` (`EX/06-extensions.ts:26-37`). NOTE `AgentSession` overwrites `agent.beforeToolCall`/`afterToolCall` (653-656), so a host must gate tools through the `tool_call` extension event, not the Agent hook.

---

## 4. Message shapes (READ, verbatim)

`AI/types.ts:370-405` content blocks:
```ts
export interface TextContent { type: "text"; text: string; textSignature?: string; }
export interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean; }
export interface ImageContent { type: "image"; data: string /* base64 */; mimeType: string; }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: JsonObject; thoughtSignature?: string; namespace?: string; argumentsError?: string; }
```
`AI/types.ts:407-472`:
```ts
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning?: number /* subset of output */; totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }; }
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";   // :474
```
`AI/types.ts:570-601`:
```ts
export interface AssistantMessage { role: "assistant"; content: (TextContent | ThinkingContent | ToolCall)[]; api: Api; provider: ProviderId; model: string;
	responseModel?: string; responseId?: string; providerThinkingLevel?: string; thinkingLevel?: ModelThinkingLevel; diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage; stopReason: StopReason; deferred?: DeferredHandle; errorMessage?: string; rawStopReason?: string; endTurn?: boolean; timestamp: number; durationMs?: number; }
```
`AI/types.ts:625-642` (conditional type; the shape):
```ts
{ role: "toolResult"; toolCallId: string; toolName: string; content: (TextContent | ImageContent)[]; details?: JsonRepresentation<TDetails>; usage?: Usage; nestedCalls?: NestedToolCalls; isError: boolean; timestamp: number; durationMs?: number; }
```
`AI/types.ts:564-568`: `UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number; }`. `SystemMessage` (546-562): `{ role:"system"; content: string|TextContent[]; sections?: Record<string,string|null>; toolsAdded?: Tool[]; toolsRemoved?: ToolReference[]; timestamp }` — the transcript's leading system message carries prompt + tool declarations; later ones patch sections/tools.
Coding-agent extra roles (`CA/core/messages.ts:29-67`): `BashExecutionMessage{role:"bashExecution", command, output, exitCode, cancelled, truncated, fullOutputPath?, timestamp, excludeFromContext?}`, `CustomMessage{role:"custom", customType, content, display, details?, timestamp}`, `BranchSummaryMessage`, `CompactionSummaryMessage`; `convertToLlm` (148-196) turns them into user messages. `AgentMessage = Message | CustomAgentMessages[...]` (`AG/types.ts:374`). `AgentState` (`AG/types.ts:382-421`): `systemPrompt`(readonly, replayed), `model`, `thinkingLevel`, `tools`, `messages`, `isStreaming`, `streamingMessage?`, `pendingToolCalls`, `errorMessage?`.

---

## 5. System prompt injection (READ + MEASURED)

- `DefaultResourceLoaderOptions` (`CA/core/resource-loader.ts:276-313`): `systemPromptOverride?: (base: string|undefined) => string|undefined`, `appendSystemPromptOverride?: (base: string[]) => string[]`, `systemPrompt?: string`, `appendSystemPrompt?: string[]`, `agentsFilesOverride?`, `noContextFiles?`, `noSkills?`, `noPromptTemplates?`, `noThemes?`, `noExtensions?`, `extensionFactories?: InlineExtension[]`, `additionalExtensionPaths/SkillPaths/PromptTemplatePaths/ThemePaths`, `skillsOverride`, `promptsOverride`, `themesOverride`, `extensionsOverride`, `disabledBuiltinExtensions`. Must `await loader.reload()` before use. Custom `ResourceLoader` interface (153-165) for full control (`EX/12-full-control.ts:36-49`).
- Discovery: `<cwd>/.pi/SYSTEM.md` (if project trusted) else `<agentDir>/SYSTEM.md` replaces the preamble; `APPEND_SYSTEM.md` same locations appended (1213-1239). Context files (`loadProjectContextFiles` 232-274): first match of `AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD` in `<agentDir>` plus **every ancestor directory of cwd up to filesystem root** (ancestors first). INFERRED consequence: a cwd under `~/Library/...` picks up `~/CLAUDE.md`/`~/AGENTS.md` if present — pass `noContextFiles: true` or `agentsFilesOverride` to control.
- Build (`CA/core/system-prompt.ts:128-193`), sections in order: `preamble` (customPrompt, else default text at 155-156 "You are an expert coding assistant operating inside pi…"), then ONLY when no customPrompt: `tools` (one line per active tool having `promptSnippet`), `rules` (`buildRules` 88-125 incl. tool `promptGuidelines` + "Be concise…"), `docs` (paths into the package README/docs/examples); then `addendum` (appendSystemPrompt), `project_context` (`<project_instructions path=…>` per context file), `skills`, `cwd`, custom `sections`. Each non-preamble section is wrapped `<name>…</name>` (188-191). MEASURED with `systemPromptOverride: () => "PROBE PROMPT A"` + `appendSystemPromptOverride: () => []`: `session.systemPrompt` = `PROBE PROMPT A\n\n<cwd>\n<path>\n</cwd>` — i.e. the tools/rules/docs sections are omitted entirely with a custom prompt; a host that replaces the prompt must describe tools itself. MEASURED full default prompt (no override) printed in probe3 output; it names the active tools with snippets, the edit/write guidelines, the `<docs>` block pointing at the package's own README/docs, and `<cwd>`.
- Application: `_rebuildSystemPrompt` (1705-1731) → `NormalizedBuildSystemPromptOptions`; at run start `_prepareRun` (1890-1941) emits `before_agent_start` (handlers may mutate `systemPromptOptions` or return `systemPrompt` = forced full replacement, `extensions/types.ts:1496-1500`) and `_preparePromptAndToolLoadout` (1743-1755) diffs sections against the transcript's replayed system message and prepends a `{role:"system", content:"", sections: <patch>}` message. MEASURED: `session.messages.length === 0` before the first prompt — the system message exists only in the transcript after the first run (persisted as a `message` entry with `sections` + `toolsAdded`, `DOCS/session-format.md:80-84`).
- `session.systemPrompt` getter renders `_runSystemPromptOptions ?? _baseSystemPromptOptions` (1474-1476).

---

## 6. Custom tools (READ + MEASURED)

`ToolDefinition` (`CA/core/extensions/types.ts:579-668`), relevant fields verbatim:
```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	name: string; label: string; description: string;
	promptSnippet?: string;        // one-liner in the default prompt's <tools> section; omitted from that section if absent
	promptGuidelines?: string[];   // bullets added to <rules> while active
	parameters: TParams;           // TypeBox TSchema
	constrainedSampling?: false | ConstrainedSamplingConfig;
	renderShell?: "default" | "self";
	prepareArguments?: (args: unknown) => Static<TParams>;
	outputSchema?: TSchema;
	exposure?: ToolExposure;       // "direct" | "model-only" | "codemode" | "deferred" | "hidden" (:516)
	namespace?: ToolNamespace; reachesTools?: (input) => "all" | readonly string[]; annotations?: ToolAnnotations; defaultActive?: boolean;
	prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
	executionMode?: ToolExecutionMode;   // "sequential" | "parallel" (default parallel across a batch, AG/agent.ts:253)
	execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;
	renderCall?; renderResult?;   // TUI only
}
```
`AgentToolResult` (`AG/types.ts:424-446`): `{ content: (TextContent|ImageContent)[]; details: T; structuredContent?: JsonValue; usage?: Usage; isError?: boolean; terminate?: boolean }`. Throwing from `execute` → error result with the error message (`AG/agent-loop.ts:845-853`); `onUpdate(partial)` → `tool_execution_update` (779-788, ignored after settle 836-839). `defineTool(tool)` (`types.ts:690-694`) preserves TypeBox inference; `Type` is re-exported by `@earendil-works/pi-ai` (`AI/index.ts:2`). MEASURED: a plain JSON-schema object as `parameters` registered without error (argument validation at call time not exercised — UNKNOWN).
`ctx: ExtensionToolContext` (383-395 + runner `createContext` `CA/core/extensions/runner.ts:884-962`): `ui` (no-op `noOpUIContext` in headless hosts, runner.ts:331-362: `select→undefined, confirm→false, notify→{}`…), `mode`, `hasUI`, `cwd`, `sessionManager` (read-only), `modelRegistry`, `model`, `thinkingLevel`, `isIdle()`, `signal`, `abort()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`, plus `tools` and `executeTool(name, args, {signal?, onUpdate?})` (nested calls get id `<parent>/<n>` and `parentToolCallId` on events; recorded as `nestedCalls` on the parent's result, not as transcript messages).
Registration: `customTools` are wrapped with sourceInfo `<sdk:name>` (`agent-session.ts:3535-3541`) and **filtered by the `tools` allowlist/`excludeTools`** (3541, MEASURED above). They are inserted AFTER built-ins into both the definition and tool registries (3553-3558, 3591-3593), so a custom tool named `bash` replaces built-in bash (INFERRED from the `Map.set` order; not executed). `exposure:"direct"` tools are active on registration unless `defaultActive:false` (3632-3634).
Truncation: built-in tools truncate via `CA/core/tools/truncate.ts` (`DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 KiB`, `truncateHead/truncateTail/truncateMiddle`, exported from the package index `CA/index.ts:353-387`). **No automatic truncation is applied to custom tool results** (READ: `wrapToolDefinition` `CA/core/tools/tool-definition-wrapper.ts:8-30` and `executePreparedToolCall` do not truncate); the only automatic post-processing is image normalization in `_afterToolCall` (705-711). Hosts must truncate themselves.
Add/remove after creation: active set via `setActiveToolsByName` (any registered tool; takes effect next turn, declared to the model by a system `toolsAdded/toolsRemoved` delta, `AG/agent-loop.ts:323-363`). New definitions after construction: through the extension runtime (`pi.registerTool`, then `refreshTools`/`session.reload()`), or by registering an inline extension factory up front that registers tools later (e.g. MCP extension does this at `session_start`). `customTools` is captured as `this._customTools` (492) and re-read on `reload()` (3534-3541) — INFERRED that mutating the same array and calling `reload()` registers new tools; not measured.
Built-in tool factories exported (`CA/index.ts:261-274, 336-392`): `createBashToolDefinition(cwd, {operations?, commandPrefix?, shellPath?, exposeSessionEnvironment?, spawnHook?: (ctx:{command,cwd,env}) => ctx})` (`CA/core/tools/bash.ts:178-225`), `createReadToolDefinition(cwd, {autoResizeImages?, resizeOptions?, operations?})`, edit/write/grep/find/ls/powershell. `createAgentSession` builds built-ins with only `{read:{autoResizeImages}, bash:{commandPrefix: settings.shellCommandPrefix, shellPath: settings.shellPath}}` (3651-3655) — there is no `spawnHook` path through `createAgentSession`; env injection options are (a) `shellCommandPrefix` setting, (b) process env of the host process, (c) a custom `bash` definition (INFERRED above), (d) `new AgentSession({... baseToolsOverride})` (`AgentSessionConfig.baseToolsOverride` 290-295, not reachable via the factory).

---

## 7. Model and thinking level — see §2 (`setModel`/`setThinkingLevel`). Model objects: `Model<Api>` (`AI/types.ts:839-872`): `id, name, api, provider, baseUrl, input: ("text"|"image")[], inputLimits?, cost: ModelCost, headers?, reasoning: boolean, thinkingLevelMap?, promptCache?, contextWindow, maxTokens, samplingParams?, compat?`. `ModelCost` (`AI/providers/model-schema.ts:25-46`): USD per million `{input, output, cacheRead, cacheWrite, tiers?: [{inputTokensAbove, …rates}]}`. Lookup: `modelRuntime.getModel(provider, id)`, `getModels(provider?)`, `getAvailableSnapshot()` (sync, providers with configured auth), `await getAvailable()` (re-checks auth). MEASURED catalog: 42 providers, 1554 models; anthropic ids incl. `claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1`; openai 44 ids (`gpt-5.5`, `gpt-5.3-codex`, `o3`…); openrouter 393 (`anthropic/claude-fable-5.1`…); openai-codex 8. Model id strings in settings are `"provider/modelId"` for per-model thinking (`settings-schema.ts:213-215`). `resolveCliModel({cliModel:"provider/pattern[:thinking]"})` (`CA/core/model-resolver.ts:445`) parses user-typed references. Custom endpoints via `models.json` (`DOCS/models.md:45-67`, schema `CA/core/model-config.ts:84`) or `pi.registerProvider(name, {baseUrl, apiKey, api, models})` (`extensions/types.ts:1858-1859`) / `modelRuntime.registerProvider` (`model-runtime.ts:928`).

---

## 8. Usage and cost (READ)

- Per message: each provider API module calls `calculateCost(model, usage)` (`AI/models.ts:1206-1226`; call sites `AI/api/anthropic-messages.ts:724,893`, `openai-responses-shared.ts:602`, `openai-completions.ts:1560`, …) → `AssistantMessage.usage.cost.{input,output,cacheRead,cacheWrite,total}` in USD from `model.cost` (per-million rates, tiers, Anthropic 1h cache write = 2× input). A model with zero rates (custom endpoint) yields `cost.total = 0` (INFERRED). OpenRouter prices/limits are personalized from `GET /models/user` when a key is configured and network allowed (`AI/providers/openrouter.ts:24-60`).
- Cumulative: `session.getSessionStats()` (`agent-session.ts:4213-4265`) → `SessionStats { sessionFile, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens:{input,output,cacheRead,cacheWrite,total}, cost: number, contextUsage? }` summed over **all** session entries (assistant usage, toolResult `usage`, `usage` entries such as cache warming, compaction/branch-summary usage). Per-model breakdown: `getUsageCostBreakdown(entries)` (`CA/core/usage-totals.ts:61-97`; not exported from the index — copy or import from dist path). Context: `getContextUsage()` returns `tokens: null` right after a compaction until a new assistant usage lands (4281-4300).
- Cost-relevant default: `cacheWarming` defaults to `"streaming"` (`CA/core/settings-defaults.ts:61`) — the `CacheWarmer` replays requests to keep provider cache entries warm when expected savings ≥ $0.05 (`CA/core/cache-warmer.ts:15-26`) and records them as `usage` entries kind `"cache_warm"` (`DOCS/session-format.md:113-121`). Set `cacheWarming: "off"` in the settings manager if unwanted.

---

## 9. One process, many sessions (MEASURED + READ)

- MEASURED: two `AgentSession`s (different cwds, shared `ModelRuntime`, in-memory settings/sessions) created in 5 ms; system prompts, thinking levels and tool sets isolated; `setThinkingLevel` on A did not touch B; `dispose()` both → remaining handles only stdio pipes.
- READ: no `process.chdir` anywhere in coding-agent/agent/ai/mcp (grep empty). `process.on/once` only in `CA/modes/print-mode.ts:63`, `rpc-mode.ts:377`, `interactive-mode.ts:4418-4467`, and `SRC/mcp/src/transports/stdio.ts:46` (`process.once("exit")`, only if an MCP stdio transport is created). `process.exit` only in `CA/core/output-guard.ts:91` (used by print/rpc modes) and `AI/cli.ts`.
- Module-level singletons that matter: `setDefaultStreamFn` global (`AG/stream-fn.ts:3`, set at `sdk.ts:46`); `sharedAuthFileReadState` (`CA/core/auth-storage.ts:51`, shared only for the same `authPath`); `sharedModelsFileReadState` (`CA/core/models-store.ts:24`); `extensionCacheCwd`/`extensionCacheGeneration` (`CA/core/extensions/loader.ts:129-130`, per-cwd file-extension cache — INFERRED: loaders for different cwds invalidate each other's cache, harmless); `registerBuiltInApiProviders()` runs at `@earendil-works/pi-ai/compat` import (`AI/compat.ts:215`) and `session.reload()` calls global `resetApiProviders()` (3705); `installedGlobalFetch`/`configureHttpDispatcher` (`CA/core/http-dispatcher.ts:17,81`) is NOT called by the SDK path (only `main.ts`, `rpc-entry.ts`, interactive mode) and is not exported, so SDK sessions use `globalThis.fetch` as-is; openai-codex keeps a WebSocket cache keyed by session id + account id (`AI/api/openai-codex-responses.ts:994-1246`), cleaned by `cleanupSessionResources(sessionId)` in `dispose()`. `ModelRuntime` holds no process state and is designed to be shared (`EX/README.md:45-48`).
- Per-session guards: `Agent.prompt` throws `"Agent is already processing a prompt…"` if that agent has an active run (`AG/agent.ts:374-378`); `session.prompt` while streaming requires `streamingBehavior` (2104-2108). `Agent.subscribe` listeners are awaited and part of run settlement (`AG/agent.ts:256-269`) — session listeners are sync, so a slow listener does not block the loop unless it is registered on `session.agent` directly.

---

## 10. Abort semantics and the transcript (READ)

`session.abort()` (2464-2474): marks `_agentRunAbortRequested`, aborts retry/compaction/branch-summary controllers, `agent.abort()` (one `AbortController` per run, `AG/agent.ts:341-343`), awaits idle. The provider stream receives `signal` (`AG/agent-loop.ts:403-407`) and must end with an `error` event `reason:"aborted"` → `message_end` with `stopReason:"aborted"` (+`errorMessage`) → `turn_end{toolResults:[]}` → `agent_end` → return (245-256; "Error and aborted responses remain hard exits", `AG/types.ts:153`). If the loop throws, `Agent.handleRunFailure` synthesizes `{role:"assistant", content:[{type:"text",text:""}], usage: EMPTY, stopReason: aborted|error, errorMessage}` and emits message_start/end, turn_end, agent_end (`AG/agent.ts:532-548`). Tool calls: a call not yet executed when the signal fires gets an immediate error result `"Operation aborted"` (`prepareToolCall` 738-744, 757-763; parallel pending entries 619-628); a running tool receives the signal and its return/throw is recorded as-is (821-857); in sequential mode the batch stops after the current tool (575-577), so remaining `toolCall` blocks in that assistant message get **no** toolResult message (INFERRED consequence: providers that validate pairing will see the next request repaired only because the aborted assistant message is kept — `_checkCompaction` skips aborted messages 2986, and Pi's next prompt simply appends a user message). The aborted assistant message IS persisted (`message_end` → `appendMessage` 1166) and `getLastAssistantText` skips it only when its content is empty (4385-4386). After the run: `_finishCancelledRetry` (3776), `agent_settled{aborted:true}` (1084-1086), `_lastActivityOutcome = "aborted"` (851-852). `agent.state.errorMessage` holds the last failure/abort message (`AG/agent.ts:594-597`). MEASURED: `abort()` while idle resolves immediately with no events.

---

## 11. Images / attachments (READ + MEASURED)

- Input: `prompt(text, { images: [{type:"image", data:<base64>, mimeType}] })` → user message `content: [{type:"text", text}, ...images]` (1917-1922); `steer`/`followUp`/`sendUserMessage` accept images too. Before send (`_normalizePromptImages` 2028-2047 → `processImage` `CA/utils/image-process.ts:72-119`): mime normalized; `image/png|jpeg|jpg|gif|webp` pass through, anything else is converted to PNG via `convertImageBytesToPng` (`CA/utils/image-convert.ts`) or dropped with hint text `"[Image omitted: could not be converted to a supported inline image format.]"`; if `settings.images.autoResize` (default true, `settings-defaults.ts:42`) the image is resized in a worker thread running Photon WASM (`CA/utils/image-resize.ts:84-109`, falls back in-process if the worker fails) to `maxWidth 2000, maxHeight 2000, maxBytes 4.5 MiB base64, jpegQuality 80` (`CA/utils/image-resize-core.ts:32-38`) or the model's `inputLimits.images.resize` (MEASURED claude-sonnet-4-5: `{maxWidth:2000,maxHeight:2000,maxBytes:4718592,jpegQuality:80}`, `maxRequestBytes: 33554432`, `images.maxPerRequest: 100`); hints such as `"[Image: original WxH, displayed at WxH. Multiply coordinates by …]"` are appended to the user text (2035-2046). Unresizable → `"[Image omitted: could not be resized below the inline image size limit.]"`. `settings.images.blockImages` replaces all images with `"Image reading is disabled."` at `convertToLlm` (`sdk.ts:296-331`). Tool-result images are normalized the same way in `_afterToolCall` (705-711, `CA/utils/tool-result-images.ts`). File attachments otherwise go through the `read` tool (sniffs jpeg/png(non-animated)/gif/webp/bmp, `CA/utils/mime.ts:6-23`). Exported helpers: `resizeImage`, `formatDimensionNote`, `convertToPng`, `detectSupportedImageMimeTypeFromFile` (`CA/index.ts:493-495`).

---

## 12. Retries and error surfacing (READ)

- Provider failures never throw out of the loop; they become an `AssistantMessage{stopReason:"error", errorMessage, diagnostics?}` delivered by `message_end` → `turn_end` → `agent_end{willRetry}` (`AG/types.ts:27-31`, `AI/types.ts:344-345`). `diagnostics` carries redacted provider error info (`AI/utils/diagnostics.ts:10-15`).
- Session auto-retry (`_handlePostAgentRun` 1943-1981 → `_prepareRetry` 3792-3832): condition `_isRetryableError` (3739-3743) = NOT `isContextOverflow(message, contextWindow)` AND `isRetryableAssistantError(message)` (`AI/utils/retry.ts:257-262`): errorMessage must match the retryable pattern (overloaded, server_busy, rate.?limit, too many requests, 429, 500, 502, 503, 504, 520, 524, service unavailable, server/internal error, provider returned error, network/connection errors, fetch failed, ENOTFOUND, …; lines 30-70) and not the non-retryable one (`insufficient_quota`, `quota exceeded`, `billing`, `out of budget`, `subscription_sharing_usage_limit_exceeded`, OpenCode limits; lines 7-28). **401/403/unauthorized are not in the retryable list** → surfaced once as an error message and `agent_settled`. Settings default `retry: {enabled:true, maxRetries:3, baseDelayMs:2000, maxAgentDelayMs:60000}` (`settings-defaults.ts:18-26`); delay `base·2^(attempt−1)` capped (`retry.ts:133-137`); the failed attempt is omitted from model context by a `context_edit` entry (3818) and kept in raw history. Events: `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage}`, `auto_retry_end{success,attempt,finalError?}`; `abortRetry()` cancels the sleep. Provider-SDK-level retries: `maxRetries`/`timeoutMs`/`maxRetryDelayMs` from `settings.retry.provider` (`sdk.ts:344-353`; undefined → provider defaults, e.g. OpenAI/Anthropic SDK 2, codex 0 `AI/api/openai-codex-responses.ts:54`).
- Context overflow (`AI/utils/overflow.ts:137-171`: error-pattern match, silent overflow `input+cacheRead > contextWindow`, or length-stop with 0 output) → `compaction_start{reason:"overflow"}` … `compaction_end{willRetry}`; one compact-and-retry attempt (`_overflowRecoveryAttempted` 3049-3076), else `compaction_end.errorMessage = "Context overflow recovery failed after one compact-and-retry attempt…"`. Threshold compaction when `shouldCompact(tokens, contextWindow, {reserveTokens:16384, keepRecentTokens:20000})`.
- Auth before a run: `prompt()` throws (`formatNoApiKeyFoundMessage`, `CA/core/auth-guidance.ts:22-25`, or the OAuth variant 2128-2135) — a rejection, not an event. Auth failure mid-run (expired OAuth refresh failing) throws `ModelsError("oauth"|"auth")` inside `modelRuntime.streamSimple` (`model-runtime.ts:658-697`, `AI/auth/resolve.ts:140-150`); INFERRED (lazyStream not read) that it is encoded as an error assistant message.

---

## 13. Disk / home-dir writes and how to redirect (READ + MEASURED)

- Agent dir: `getAgentDir()` = `process.env[PI_CODING_AGENT_DIR]` (expanded) else `~/.pi/agent` (`CA/config.ts:584-611`; `ENV_AGENT_DIR` is `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` = `PI_CODING_AGENT_DIR`, confirmed by `DOCS/environment-variables.md:81`). MEASURED: setting it redirected everything; nothing was written under `~`. `createAgentSession({agentDir})` is equivalent (derives `auth.json`/`models.json`/`settings.json`/sessions from it).
- Files written: `<agentDir>/auth.json` (created as `{}` with mode 0600, parent 0700, on any `AuthStorage` lock — MEASURED created at `ModelRuntime.create` even with `refreshOnCreate:false`; `CA/core/auth-storage.ts:36-37,68-79`), `<agentDir>/models-store.json` (next to `models.json`; MEASURED), `<agentDir>/settings.json` only when a setter runs (`SettingsManager.save`, e.g. `setModel(…,{persist:true})`, `getOrCreateDeviceId()` `settings-manager.ts:1082-1089`), `<agentDir>/sessions/--<cwd with leading sep removed and / \ : → ->--/<ISO ts>_<uuidv7>.jsonl` (`session-manager.ts:589-602`; directory created at `SessionManager.create`, MEASURED; the file is created lazily only once a user or assistant message exists, 1160-1189, MEASURED absent after creation), `<agentDir>/mcp-auth.json` + `mcp.log` only when `createMcpExtension` is used (`CA/extensions/mcp/index.ts:75-77`), `<agentDir>/pi-debug.log` path exists (`config.ts:654`; writer not checked). `importFromJsonl` copies into the session dir (`agent-session-runtime.ts:365-387`).
- Zero-write configuration MEASURED: `ModelRuntime.create({ credentials: <host CredentialStore>, modelsPath: null, refreshOnCreate: false })` + `SettingsManager.inMemory({...})` + `SessionManager.inMemory(cwd)` → agent dir untouched (`InMemoryCredentialStore` is exported by pi-ai, `AI/auth/credential-store.ts:9`; the `CredentialStore` contract is `read/list/modify/delete`, `AI/auth/types.ts:65-94` — a host can back it with Electron `safeStorage`). Note `hasConfiguredAuth` is false until `await modelRuntime.refresh({allowNetwork:false})` or a credential operation (MEASURED).
- Reads from home/ancestors: context files (see §5), `~/.pi/...` only via `getAgentDir()`; ambient env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, … `AI/env-api-keys.ts:73-120`) are consulted only when no stored credential exists for that provider (`AI/auth/resolve.ts:27-31, 70-93`). Precedence (`DOCS/models.md:23`): runtime `setRuntimeApiKey` (in-memory overlay, `CA/core/runtime-credentials.ts`) > stored `auth.json` > `models.json` apiKey > env.

---

## 14. Auth: "Sign in with ChatGPT", API keys, OpenRouter (READ + MEASURED)

- Provider `openai` (`AI/providers/openai.ts:9-35`): `auth.apiKey = envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"])` AND `auth.oauth = { name: "OpenAI (ChatGPT subscription)", isSubscription: true, loginLabel: "Sign in with ChatGPT" }` (`AI/auth/oauth/openai-chatgpt.ts:300-309`); tokens go to `https://api.openai.com/v1` Responses API (`toAuth → {apiKey: credential.access}`); classifier models are hidden under OAuth. MEASURED provider list with OAuth: `anthropic, github-copilot, kimi-coding, meta, openai, openai-codex, openrouter, radius, xai`. `openai-codex` is the legacy ChatGPT-backend provider (`AI/providers/openai-codex.ts`, baseUrl `https://chatgpt.com/backend-api`, OAuth "OpenAI (ChatGPT Plus/Pro)", browser or device-code login, `AI/auth/oauth/openai-codex.ts:409-430`).
- Login API: `modelRuntime.login(providerId, "oauth"|"api_key", interaction, options)` (`CA/core/model-runtime.ts:826-838` → `AI/models.ts:768-823`, persists via `credentials.modify`). `AuthInteraction` (`AI/auth/types.ts:156-161`): `{ signal?, prompt(p: AuthPrompt): Promise<string>, notify(e: AuthEvent): void }`; `AuthPrompt` kinds `text | secret | select{options} | manual_code` (125-130); `AuthEvent` kinds `info | auth_url{url, instructions} | device_code{userCode, verificationUri} | progress` (137-147). `LoginOptions { getDeviceId?: () => string; agentName?: string }` (202-214). The CLI call site to mirror: `interactive-mode.ts:6339-6348` (`{ getDeviceId: () => settingsManager.getOrCreateDeviceId() }`).
- ChatGPT flow specifics (`openai-chatgpt.ts`): `ext_agent_host_id = urn:uuid:<deviceId>` is **required** — throws `"Sign in with ChatGPT requires a device ID (UUID) for this installation"` without a UUID (225-231, 237); `agent_name_hint` defaults `"Pi"` (17, 253); dynamic client registration `client_id=dynamic_agent_client` (16, 252), the issued `clientId` is stored on the credential and needed for refresh (162-181, 208-223); PKCE + state; callback server bound to **fixed** `127.0.0.1:1455` `/auth/callback` (22-25, 126) with a clear `EADDRINUSE` error (243-248); the SDK only `notify({type:"auth_url", url, instructions})` — **it does not open the browser**; the host must open the URL and may answer the `manual_code` prompt with the pasted redirect URL (264-279). Scope includes `chatgpt.tokens.use.direct` (26-27, 170); credential `expires = now + expires_in − 3 min` (177); refresh when < 5 min validity under the store lock with a 15 s timeout (`AI/auth/resolve.ts:102-191`); non-retryable usage-limit error string `subscription_sharing_usage_limit_exceeded` (`retry.ts:25-27`).
- API keys at runtime without disk: `await modelRuntime.setRuntimeApiKey("anthropic", key)` (`model-runtime.ts:621-632`; MEASURED → `getProviderAuthStatus` `{configured:true, source:"runtime"}`); `removeRuntimeApiKey`; `listCredentials()` returns `{providerId,type}` only. `getProviderAuthStatus(id)` → `{configured, source: "runtime"|"stored"|"environment"|…}` (646-656); `isUsingOAuth`, `isUsingSubscription` (543-549).
- OpenRouter: `OPENROUTER_API_KEY` or OAuth (`AI/providers/openrouter.ts:62-70`); catalog personalized from `/models/user` when network allowed (`DOCS/providers.md:116-134`).

---

## 15. MCP in SDK sessions (READ, for completeness)
`createMcpExtension({ loadConfig?, createTransport?, credentials?, logPath?, openUrl?, updateConfig?, startupWaitMs? (10 s) })` (`CA/extensions/mcp/index.ts:69-91`), added to `DefaultResourceLoader.extensionFactories` with `createCodemodeExtension`/`createToolSearchExtension`, then `await session.bindExtensions({})` (which emits `session_start`, connecting servers) — `EX/14-codemode-mcp.ts`. Tool names `mcp__<server>__<tool>` (`CA/core/mcp-servers.ts:39,155`); `McpServerConfig = McpStdioServerConfig | McpHttpServerConfig` (80-150); `pi.registerMcpServer(name, config)` from an extension (`extensions/types.ts:1894`). File extensions load through `jiti` (`CA/core/extensions/loader.ts:567-581`); inline factories need no transpiler.

---

## 16. Settings a host will care about (`CA/core/settings-defaults.ts`, schema keys `CA/core/settings-schema.ts:206-420`)
`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels` (keyed `"provider/modelId"`), `transport` ("auto"), `steeringMode`/`followUpMode` ("one-at-a-time"), `compaction{enabled:true, reserveTokens:16384, keepRecentTokens:20000}`, `retry{enabled:true, maxRetries:3, baseDelayMs:2000, maxAgentDelayMs:60000, provider:{maxRetryDelayMs:60000}}`, `images{autoResize:true, blockImages:false}`, `cacheWarming` ("streaming"), `httpIdleTimeoutMs` (300000 default `CA/core/http-dispatcher.ts:4`), `defaultTools`, `enabledModels`, `shellPath`, `shellCommandPrefix`, `sessionDir`, `extensions`, `skills`, `prompts`, `packages`, `deviceId`, `defaultProjectTrust` ("ask"; `SettingsManager.create(cwd, agentDir, {projectTrusted})` gates project `.pi/` resources). `SettingsManager.inMemory(partial)` / `.create(cwd, agentDir)` / `applyOverrides()` / `flush()` / `drainErrors()` (`EX/10-settings.ts`).

---

## 17. Minimal headless host pattern (READ `CA/modes/print-mode.ts:70-137`, `EX/01`, `EX/12`)
```ts
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false }); await modelRuntime.refresh({ allowNetwork: false });
const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", retry: {...}, compaction: {...} });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, systemPromptOverride: () => prompt, appendSystemPromptOverride: () => [], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [permissionExtension] }); await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, model, thinkingLevel, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessionDir) /* or inMemory */, tools: ["read","bash","edit","write","host_tool_a"], customTools });
await session.bindExtensions({ mode: "print", onError: ... });
const unsub = session.subscribe(ev => relay(toJsonEvent(ev)));   // toJsonEvent is not exported; reimplement (json-event.ts:46-61)
await session.prompt(text, { images, expandPromptTemplates: false });  // resolves after agent_settled
```

## KEY FACTS
- createAgentSession options are exactly cwd, agentDir, modelRuntime, model, thinkingLevel, scopedModels, noTools, tools, excludeTools, customTools, resourceLoader, sessionManager, settingsManager, sessionStartEvent; no continueSession option exists despite the JSDoc example
  - evidence: /private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-src/pi/packages/coding-agent/src/core/sdk.ts:48-106 `export interface CreateAgentSessionOptions {` … `sessionStartEvent?: SessionStartEvent; }`; JSDoc at :172-174 `continueSession: true` has no matching field
- Default thinking level is 'medium', not 'off' as the examples README states; the union has seven levels
  - evidence: coding-agent/src/core/defaults.ts:3 `export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";` vs examples/sdk/README.md:113 `| thinkingLevel | From settings/"off" |`; agent/src/types.ts:349 `export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";`
- A `tools` allowlist also filters customTools: a custom tool not named in the list is never registered
  - evidence: MEASURED probe2 under Electron: `tools:["read","bash"]` + customTools probe_A → `A getAllTools: read[direct,builtin] bash[direct,builtin]`; code: coding-agent/src/core/agent-session.ts:3535-3541 `].filter((tool) => this._isAllowedTool(tool.definition.name));`
- AgentSessionEvent = core AgentEvent (with parentToolCallId on tool_execution_*) plus agent_end{willRetry}, agent_settled{aborted}, queue_update, compaction_start/end, entry_appended, session_info_changed, thinking_level_changed, auto_retry_start/end, summarization_retry_*, bash_execution_update
  - evidence: coding-agent/src/core/agent-session.ts:196-237 `export type AgentSessionEvent = | WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>> | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean; } | { type: "agent_settled"; aborted: boolean } …`
- Core events are agent_start, agent_end, turn_start, turn_end{message,toolResults}, message_start/update/end, tool_execution_start{toolCallId,toolName,args}, tool_execution_update{partialResult}, tool_execution_end{result,isError,durationMs?}
  - evidence: agent/src/types.ts:516-539 `export type AgentEvent = | { type: "agent_start" } | { type: "agent_end"; messages: AgentMessage[] } | { type: "turn_start" } | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] } …`
- AssistantMessage carries usage.cost {input,output,cacheRead,cacheWrite,total}, stopReason in pending|stop|length|toolUse|error|aborted|deferred, provider/model/api, errorMessage, durationMs
  - evidence: ai/src/types.ts:407-474 `export interface Usage { … cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }; }` / `export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";` and :570-601 AssistantMessage
- Per-message cost is computed by pi-ai calculateCost inside each provider adapter from model.cost per-million rates; session cost is summed by getSessionStats over all entries
  - evidence: ai/src/models.ts:1206-1226 `export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] { … usage.cost.total = …` called at ai/src/api/anthropic-messages.ts:724; coding-agent/src/core/agent-session.ts:4213-4265 `getSessionStats(): SessionStats { … cost: usageTotals.cost,`
- With a custom system prompt the default tools/rules/docs sections are omitted; the effective prompt is custom text plus <cwd>
  - evidence: MEASURED probe2: `A systemPrompt: PROBE PROMPT A\n\n<cwd>\n…/cwdA\n</cwd>`; code coding-agent/src/core/system-prompt.ts:152-170 `if (customPrompt) { promptSections.preamble = customPrompt; } else { … promptSections.tools = … promptSections.rules = … promptSections.docs = …`
- Context files AGENTS.override.md/AGENTS.md/AGENTS.MD/CLAUDE.md/CLAUDE.MD are read from the agent dir and from every ancestor of cwd up to the filesystem root
  - evidence: coding-agent/src/core/resource-loader.ts:185 `const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];` and :253-269 `while (true) { const contextFile = loadContextFileFromDir(currentDir); … const parentDir = dirname(currentDir); if (parentDir === currentDir) break;`
- ToolDefinition.execute signature is (toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) returning AgentToolResult {content, details, structuredContent?, usage?, isError?, terminate?}
  - evidence: coding-agent/src/core/extensions/types.ts:650-656 `execute( toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext, ): Promise<AgentToolResult<TDetails>>;`; agent/src/types.ts:424-446
- No automatic truncation is applied to custom tool results; built-ins use truncate.ts with 2000 lines / 50 KiB defaults
  - evidence: coding-agent/src/core/tools/truncate.ts:11-12 `export const DEFAULT_MAX_LINES = 2000; export const DEFAULT_MAX_BYTES = 50 * 1024;`; coding-agent/src/core/tools/tool-definition-wrapper.ts:8-30 wraps execute without truncation
- setModel throws without configured auth, records a model_change entry and re-derives the thinking level; mid-run changes apply at the next provider request
  - evidence: coding-agent/src/core/agent-session.ts:2507-2527 `if (!(await this._modelRuntime.checkAuth(model.provider))) { throw new Error(`No API key for ${model.provider}/${model.id}`); } … this.sessionManager.appendModelChange(…)`; :805-815 `model: this.agent.state.model, thinkingLevel: this.agent.state.thinkingLevel`
- Several AgentSessions coexist in one process: two created in 5 ms, state isolated; no process.chdir and no SDK-installed signal handlers
  - evidence: MEASURED probe2 `two sessions created in 5 ms` / `A after setThinkingLevel(low): low | B still high`; grep over coding-agent/src agent/src ai/src mcp/src: `=== process.chdir (non-test) ===` empty; process.on only in modes/print-mode.ts:63, modes/rpc/rpc-mode.ts:377, modes/interactive/interactive-mode.ts:4418-4467, mcp/src/transports/stdio.ts:46
- Abort yields an assistant message with stopReason 'aborted' that is persisted; unexecuted tool calls get an 'Operation aborted' error result; the run ends with agent_end then agent_settled{aborted:true}
  - evidence: agent/src/agent-loop.ts:245-256 `if (message.stopReason === "error" || message.stopReason === "aborted") { … await emit({ type: "turn_end", message, toolResults: [] }); await emit({ type: "agent_end", messages: newMessages }); return; }`; :738-744 `result: createErrorToolResult("Operation aborted")`; agent-session.ts:1084-1086
- Images are normalized to png/jpeg/gif/webp, resized to 2000x2000 / 4.5 MiB base64 / JPEG q80 by default (or the model's inputLimits.images.resize), with hint text appended to the user prompt
  - evidence: coding-agent/src/utils/image-resize-core.ts:32-38 `const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024; … maxWidth: 2000, maxHeight: 2000, … jpegQuality: 80`; agent-session.ts:2035-2046; MEASURED claude-sonnet-4-5 inputLimits `{"maxRequestBytes":33554432,"images":{"maxPerRequest":100,"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}`
- Auto-retry applies only to transient provider errors (overloaded/429/5xx/network); 401/403 and quota/billing errors are not retried; defaults 3 retries, 2 s base, 60 s cap
  - evidence: ai/src/utils/retry.ts:257-262 `export function isRetryableAssistantError(message) { if (message.stopReason !== "error" || !message.errorMessage) return false; … if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false; return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage); }`; coding-agent/src/core/settings-defaults.ts:18-26 `retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, …`
- prompt() on a provider with no credentials rejects before any network call with 'No API key found for <provider>.'
  - evidence: MEASURED probe2 `C.prompt threw: "No API key found for openai."` / `C messages after failed prompt: 0`; coding-agent/src/core/agent-session.ts:2123-2136 and core/auth-guidance.ts:22-25
- The agent directory is redirected with PI_CODING_AGENT_DIR (or the agentDir option); ModelRuntime.create writes auth.json and models-store.json there, SessionManager.create creates sessions/--<encoded cwd>--/ and writes the JSONL only once a user/assistant message exists
  - evidence: coding-agent/src/config.ts:605-611 `export function getAgentDir(): string { const envDir = process.env[ENV_AGENT_DIR]; …`; MEASURED probe2 agentDir tree `auth.json (2B) models-store.json (2B)`; session-manager.ts:1160-1176 `A new session file is created only once the session contains a user or assistant message.`; MEASURED probe3 `session file not on disk yet (lazy): ENOENT`
- A host CredentialStore plus modelsPath:null plus in-memory settings/sessions produces zero disk writes
  - evidence: MEASURED probe3 with `ModelRuntime.create({ credentials: credentialStore, modelsPath: null, refreshOnCreate: false })`: `agentDir2 tree after:` contains only `sessions/…/` from SessionManager.create; ai/src/auth/types.ts:65-94 CredentialStore `read/list/modify/delete`
- "Sign in with ChatGPT" is the `openai` provider's OAuth option; it requires a UUID device id via LoginOptions.getDeviceId, binds a callback server on fixed 127.0.0.1:1455, and only notifies the auth URL (the host must open the browser)
  - evidence: ai/src/providers/openai.ts:16-21 `oauth: lazyOAuth({ name: "OpenAI (ChatGPT subscription)", isSubscription: true, loginLabel: "Sign in with ChatGPT", …`; ai/src/auth/oauth/openai-chatgpt.ts:23-25 `const CALLBACK_PORT = 1455; … REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}``; :226-231 `throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation")`; :264-269 `interaction.notify({ type: "auth_url", url: …`
- Login API is modelRuntime.login(providerId, 'oauth'|'api_key', {signal, prompt, notify}, {getDeviceId, agentName}); the CLI passes settingsManager.getOrCreateDeviceId()
  - evidence: coding-agent/src/modes/interactive/interactive-mode.ts:6339-6348 `await this.session.modelRuntime.login( providerId, method, { signal: dialog.signal, prompt: …, notify: … }, { getDeviceId: () => this.settingsManager.getOrCreateDeviceId() }, );`; core/model-runtime.ts:826-838
- getModel is not exported from @earendil-works/pi-ai root; it is a deprecated alias in /compat; use modelRuntime.getModel
  - evidence: MEASURED: `SyntaxError: The requested module '@earendil-works/pi-ai' does not provide an export named 'getModel'`; ai/src/compat.ts:64-65 `/** @deprecated Static catalog read. … */ export const getModel = getBuiltinModel;`
- Cache warming defaults to 'streaming' and sends extra provider requests recorded as usage entries kind cache_warm
  - evidence: coding-agent/src/core/settings-defaults.ts:61 `cacheWarming: "streaming",`; docs/session-format.md:115 `for example, cache warming uses "cache_warm"`; core/cache-warmer.ts:20 `const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;`
- prompt() dispatches slash commands and expands templates by default; sendUserMessage defaults expandPromptTemplates to false
  - evidence: coding-agent/src/core/agent-session.ts:2063 `const expandPromptTemplates = options?.expandPromptTemplates ?? true;` and :2068 `if (expandPromptTemplates && text.startsWith("/"))`; :2419-2424 `expandPromptTemplates: options?.expandPromptTemplates ?? false,`
- The SDK loads and runs under Electron 37.2.0's Node 22.17.0 despite engines >=22.19.0; the package is ESM-only
  - evidence: MEASURED probe output `node v22.17.0 electron 37.2.0`; published package.json `"type": "module"`, `"engines": { "node": ">=22.19.0" }`, `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`

## RISKS
- `tools` allowlist silently drops any `customTools` entry not named in it (MEASURED): a host that enables built-ins by list must also list every host tool, or use `+name` modifiers.
- A custom system prompt removes the default <tools>/<rules>/<docs> sections entirely (MEASURED); the host prompt must describe its tools and conventions itself, and `promptSnippet`/`promptGuidelines` on custom tools have no effect under a custom prompt.
- Context files are read from every ancestor of cwd up to `/` plus the agent dir (READ); a workspace under the user's home will ingest `~/CLAUDE.md`/`~/AGENTS.md` unless `noContextFiles: true` or `agentsFilesOverride` is set.
- `ModelRuntime.create` with default options writes `auth.json` (0600) and `models-store.json` into the agent dir even when nothing else is persisted (MEASURED); redirect the agent dir or inject a `CredentialStore` + `modelsPath: null`.
- Sign in with ChatGPT binds a fixed localhost port 1455; a concurrent Codex CLI login or a second pending login fails with EADDRINUSE. It also requires a stable UUID device id and the host must open the browser itself.
- OAuth refresh failures and 401/403 are not auto-retried (READ retry patterns); the host must surface them and offer re-login. `subscription_sharing_usage_limit_exceeded` (ChatGPT usage cap) is deliberately non-retryable.
- `cacheWarming` defaults to 'streaming' and spends tokens on background warm requests (READ); set it to 'off' in the SettingsManager unless the product wants it.
- `prompt()` interprets leading `/` as extension commands and expands `/skill:` and templates by default; relaying raw user text needs `expandPromptTemplates: false` (or `sendUserMessage`).
- Custom tool results are not truncated by the SDK; a host tool returning megabytes will put them straight into the transcript and every later request.
- No automatic truncation or pairing repair for sequential-mode aborts: tool calls after the aborted one in the same assistant message get no toolResult (READ); provider-side validation of call/result pairing on resume is unverified.
- `session.reload()` calls the process-global `resetApiProviders()`; reloading one session while another streams in the same process is unverified.
- `engines.node >=22.19.0` vs Electron's 22.17.0: it ran in the probe, but a future 1.x patch could rely on a 22.19 API; pin the SDK version and keep the probe as a boot check.
- The image resize path spawns a worker thread loading Photon WASM via `new URL('./image-resize-worker.js', import.meta.url)`; under asar/webpack bundling this URL may not resolve (it falls back in-process, which blocks the event loop). Not measured.
- File-based extensions load through `jiti` (Babel transform of .ts); inline `extensionFactories` avoid this. MCP servers connect only after `session.bindExtensions()`.
- SessionManager default dir is keyed by an encoded absolute cwd under `<agentDir>/sessions/`; the directory is created eagerly at `SessionManager.create` even if no message is ever sent.

## UNKNOWNS
- No real provider turn was executed under Electron (no network, no key): streaming events, tool execution through `execute(..., ctx)`, abort mid-stream, retries and compaction were read from source, not observed.
- Whether `validateToolArguments` accepts a plain JSON-schema object (as opposed to a TypeBox schema) at call time; registration accepted it, execution was not exercised.
- Whether `session.reload()` picks up tools appended to the same `customTools` array after construction (inferred from `this._customTools` being re-read; not measured).
- Whether the SDK path honours `PI_CODING_AGENT_SESSION_DIR` (defined in config.ts:586; only CLI usage found).
- How an auth failure thrown inside `modelRuntime.streamSimple` mid-run is encoded (expected: error AssistantMessage via lazyStream; `AI/api/lazy.ts` not read).
- Behaviour of the Photon worker (`image-resize-worker.js`) when the SDK is bundled into an asar/webpack bundle; only the in-process fallback path is certain from source.
- Exact per-cwd invalidation semantics of the file-extension cache (`extensionCacheCwd`, loader.ts:129-130) when several loaders for different cwds coexist.
- `docs/session-format.md` lines 150-293 (branch_summary/custom/label/session_info entry details) were not read; entry TypeScript shapes were taken from session-manager.ts:60-194 instead.
- Which component writes `<agentDir>/pi-debug.log` (`getDebugLogPath`, config.ts:654) and whether SDK sessions ever write it.
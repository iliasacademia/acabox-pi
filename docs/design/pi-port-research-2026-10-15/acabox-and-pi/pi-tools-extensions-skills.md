# PI 1.2.0 (`@earendil-works/pi-coding-agent`) — tools, extension API, skills, context files, for Acabox PI

Path aliases used below (all absolute paths quoted here resolve under these):
- `CA/` = `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-src/pi/packages/coding-agent/src/`
- `AGENT/` = `.../scratchpad/pi-src/pi/packages/agent/src/` (package `@earendil-works/pi-agent-core`)
- `DOCS/` = `.../scratchpad/pi-src/pi/packages/coding-agent/docs/`
- `EX/` = `.../scratchpad/pi-src/pi/packages/coding-agent/examples/extensions/`
- `SDKEX/` = `.../scratchpad/pi-src/pi/packages/coding-agent/examples/sdk/`
- `PKG/` = `.../scratchpad/pi-pkg/node_modules/@earendil-works/pi-coding-agent/` (the installed 1.2.0 package; `dist/index.js` is the SDK entry, `dist/index.d.ts` the export surface)
- `ACABOX/` = `/Users/iliasbeshimov/Documents/Dev Folders/Acabox/src/cobuilding/`

Everything marked **MEASURED** was run under `ELECTRON_RUN_AS_NODE=1 .../Acabox/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` (reported `process.versions.node = 22.17.0`, `electron = 37.2.0`) with the script `.../scratchpad/work-tools-extensions/measure.mjs`, `PI_CODING_AGENT_DIR` pointed at a scratch dir. `~/.pi` was not written (no file under it had an mtime in the previous 10 minutes after the run). Everything else is READ from the sources unless marked INFERRED.

---

## 0. Confirmed premises

- Agent directory relocation: env var **`PI_CODING_AGENT_DIR`** (`DOCS/environment-variables.md:81`: "`PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent`"; `DOCS/configuration.md:9`: "Set its location with the `PI_CODING_AGENT_DIR` environment variable or the SDK's `agentDir` option"). Code: `CA/config.ts:605-611` `getAgentDir()` reads `process.env[ENV_AGENT_DIR]` then falls back to `join(homedir(), CONFIG_DIR_NAME, "agent")`. **Set BOTH the env var (process-wide, before importing the package) and pass `agentDir`**, because several code paths call `getAgentDir()` directly regardless of the SDK option: `getBinDir()` (`CA/config.ts:639-641`, where `rg`/`fd` are downloaded), `tools-manager.ts:10`, `skills.ts:419` fallback, the MCP extension defaults (`mcp-auth.json`, `mcp.log` in agent dir, `CA/extensions/mcp/index.ts:75-77`), `ProjectTrustStore` (`trust-manager.ts:214`).
- MEASURED: with `agentDir` passed and the env set, the only files PI created were `<agentDir>/auth.json` (`{}`, mode 0600) and `<agentDir>/models-store.json` (`{}`) — written by `ModelRuntime.create` → `AuthStorage` (`CA/core/auth-storage.ts:76-77` writes `{}` when missing) and `FileModelsStore` (`CA/core/model-runtime.ts:224-225`).
- The package is ESM-only (`PKG/package.json` `"type": "module"`), `engines.node >= 22.19.0` (ran fine on 22.17.0). Dependencies that matter: `jiti 2.7.0` (only for file-based extensions), `typebox 1.3.27` (ESM, entry `build/index.mjs`), `undici 8.10.2`, `@earendil-works/pi-mcp`, `@earendil-works/pi-codemode`.
- Public SDK surface actually exported from `PKG/dist/index.d.ts` (verified by grep): `createAgentSession`, `AgentSession`, `AgentSessionRuntime`, `DefaultResourceLoader`, `loadProjectContextFiles`, `SettingsManager`, `SessionManager`, `ModelRuntime`, `ModelRegistry`, `createExtensionRuntime`, `defineTool`, `createToolSearchExtension`, `createCodemodeExtension`, `createMcpExtension`, `createBashTool`/`create*Tool`/`create*ToolDefinition`, `withFileMutationQueue`, `loadSkills`, `loadSkillsFromDir`, `formatSkillsForPrompt`, `createSyntheticSourceInfo`, `parseFrontmatter`/`stripFrontmatter`, `getAgentDir`, `CONFIG_DIR_NAME`, `getShellConfig`, `hasTrustRequiringProjectResources`, `ProjectTrustStore`, `convertToLlm`, `RpcClient`, `runRpcMode`, `runPrintMode`, `InteractiveMode`, plus every extension type listed in `CA/core/extensions/index.ts:22-211`. NOT exported: `buildSystemPrompt`/`buildSystemPromptSections`, `wrapToolDefinition`, `ExtensionRunner` is exported but `createToolContext` is an instance method you reach via `session.extensionRunner` (`CA/core/agent-session.ts:4425`).

---

## 1. Built-in tool table

Source: `CA/core/tools/index.ts:95` `export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";`. Default active set: `["read", "bash", "edit", "write"]` (`CA/core/settings-manager.ts:85` `DEFAULT_TOOL_NAMES`; `CA/core/agent-session.ts:3682`). Every tool is created per session by `createAllToolDefinitions(this._cwd, { read: { autoResizeImages }, bash: { commandPrefix: shellCommandPrefix, shellPath } })` (`CA/core/agent-session.ts:3651-3654`). Shared truncation constants (`CA/core/tools/truncate.ts:11-13`): `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024`, `GREP_MAX_LINE_LENGTH = 500`.

| Name (exact) | Parameters (TypeBox) | Output to model | Limits / notes |
|---|---|---|---|
| `read` (`read.ts:94`) | `{ path: string, offset?: number (1-indexed line), limit?: number (max lines) }` (`read.ts:14-18`) | Text content, or for images `[{type:"text", text:"Read image file [mime]…"}, {type:"image", data, mimeType}]` (`read.ts:145-151`). `outputSchema` = string \| `{type:"image",data,mimeType,note}` (`read.ts:33-36`) | head-truncated to 2000 lines / 50KB whichever first (`truncateHead`, `read.ts:177`); continuation notice `[Showing lines A-B of N. Use offset=K to continue.]` (`read.ts:190,192,199`); a single line > 50KB yields `[Line N is X, exceeds 50.0KB limit. Use bash: sed -n 'Np' path \| head -c 51200]` (`read.ts:182`). Images auto-resized (`autoResizeImages`, model `inputLimits.images.resize`), non-vision model gets a note (`read.ts:79-84`). Path resolved with `resolveReadPathAsync(path, ctx?.cwd \|\| cwd)` which also tries macOS screenshot-name variants (NFD, curly quote, narrow NBSP) (`path-utils.ts:86-118`). Description string: `read.ts:96`. Prompt snippet "Read file contents", guideline "Use read to examine files instead of cat or sed." (`read.ts:20-23`). |
| `write` (`write.ts:50`) | `{ path: string, content: string }` (`write.ts:11-14`) | `Successfully wrote to ${path}` (`write.ts:86`), `details: undefined` | `mkdir -p` of parent (`write.ts:36,78`); serialized per real path through `withFileMutationQueue` (`write.ts:67`); abort checked between awaits. Snippet "Create or overwrite files"; guideline "Use write only for new files or complete rewrites." (`write.ts:16-19`). |
| `edit` (`edit.ts:149`) | `{ path: string, edits: [{ oldText: string, newText: string }, …] }` (`edit.ts:21-41`); legacy top-level `oldText`/`newText` and stringified `edits` accepted by `prepareArguments` (`edit.ts:103-134`) | `Successfully replaced ${n} block(s) in ${path}.` (`edit.ts:207`), `details: { diff, patch, firstChangedLine }` (`edit.ts:70-77,210`) | Each `oldText` must be unique and non-overlapping against the ORIGINAL file; file must be R\|W accessible (`edit.ts:95`) else `Could not edit file: ${path}. Error code: ENOENT.` (`edit.ts:181`); BOM stripped before matching, line endings preserved (`edit.ts:191-197`); mutation queue (`edit.ts:163`). Guidelines at `edit.ts:43-51`. |
| `bash` (`bash.ts:418`) | `{ command: string, timeout?: number (seconds, "no default timeout") }` (`bash.ts:40-43`) | combined stdout+stderr, tail-truncated; non-zero exit appends `\n\nCommand exited with code N` and sets `isError: true` (`bash.ts:400-406`); `(no output)` when empty; `structuredContent = { output (≤1 MiB, middle-omitted), truncated, full_output_path?, exit_code, wall_time_seconds }` (`bash.ts:56-62,391-399`) | **Spawn** (`bash.ts:112-118`): `spawn(shellConfig.shell, [...shellConfig.args, command], { cwd, detached: process.platform !== "win32", env: env ?? getShellEnv(), stdio: ["ignore","pipe","pipe"], windowsHide: true })`. Shell = `/bin/bash -c` if it exists, else `bash` on PATH, else `sh -c` (`utils/shell.ts:109-119`); `settings.shellPath` overrides (`shell.ts:69-74`). Env = `process.env` with `<agentDir>/bin` prepended to PATH (`shell.ts:138-150`), minus/plus `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` (`bash.ts:186-212`), then optional `spawnHook(ctx)` can rewrite `{command, cwd, env}` (`bash.ts:178-184`). `commandPrefix` is prepended as `${prefix}\n${command}` (`bash.ts:268`; from `settings.shellCommandPrefix`). **cwd** = `ctx?.cwd \|\| cwd` = the session cwd as given, NOT realpath'd (MEASURED: `$PWD` printed the symlinked workspace path). **Timeout**: optional, seconds, max 2147483.647 s; on expiry `killProcessTree(pid)` then throws → model sees `…\n\nCommand timed out after N seconds` (`bash.ts:133-136,377-380`; MEASURED). **Abort** (ctx.signal) → `killProcessTree` → `Command aborted` (`bash.ts:126-128,374-376`). **Kill** = `process.kill(-pid, "SIGKILL")` on the detached process group, fallback `kill(pid)` (`shell.ts:187-218`); detached children are tracked and killed on SIGHUP/SIGTERM (`shell.ts:167-182`). **No background mode**: nothing like `run_in_background`; a command runs to completion/timeout/abort. Output: tail truncation 2000 lines / 50KB, with full output streamed to a temp file `os.tmpdir()/pi-bash-<16hex>.log` mode 0600 (`output-files.ts:15-20,33`; `output-accumulator.ts:245-256`) and a notice `[Showing lines A-B of N. Full output: /tmp/pi-bash-….log]` (`bash.ts:348-352`). Streams partial output via `onUpdate` throttled (`bash.ts:282-316`). Signal-killed shell → exit `128+signal` (`bash.ts:157-158`). Snippet "Execute bash commands (ls, grep, find, etc.)", guideline "You can inspect PI_* environment variables for current model and session details." (`bash.ts:45-48`). |
| `powershell` (`powershell.ts:40`) | same as bash | same as bash | Windows only — `getPowerShellConfig()` throws on non-win32 (`shell.ts:125-128`). Irrelevant on macOS. |
| `grep` (`grep.ts:76`) | `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? (default 100) }` (`grep.ts:21-33`) | lines `relpath:LINE: text` (context lines `relpath-LINE- text`), `No matches found`; notices `[100 matches limit reached. Use limit=200 …]`, `[50.0KB limit reached]`, `[Some lines truncated to 500 chars. Use read tool to see full lines]` (`grep.ts:287-303`) | Runs **ripgrep** found via `ensureTool("rg")` — system `rg` or a download into `<agentDir>/bin` from GitHub (`utils/tools-manager.ts:29-69`); honoured `PI_OFFLINE`. Args `--json --line-number --color=never --hidden [--ignore-case] [--fixed-strings] [--glob G] -- pattern path` (`grep.ts:162-166`); respects .gitignore (rg default). Match line cap 500 chars. |
| `find` (`find.ts:76`) | `{ pattern (glob), path?, limit? (default 1000) }` (`find.ts:26-32`) | relative paths one per line; `No files found matching pattern`; notices for limit / 50KB | Runs **fd** via `ensureTool("fd")` (`find.ts:172`); args `--glob --color=never --hidden [--no-require-git outside git repos] --max-results N [--full-path when pattern has "/"] -- pattern path` (`find.ts:182-214`). |
| `ls` (`ls.ts:60`) | `{ path? (default "."), limit? (default 500) }` (`ls.ts:11-14`) | names sorted case-insensitively, `/` suffix for dirs, dotfiles included, `(empty directory)`; notices `[500 entries limit reached. Use limit=1000 for more]`, `[50.0KB limit reached]` (`ls.ts:146-156`) | Pure Node fs. MEASURED on the scratch workspace: `.academia/\n.claude/\nCLAUDE.md\nLockedData/\nOpenData/`. |

**Path resolution and symlinks (all file tools):** `resolveToCwd(filePath, cwd)` (`path-utils.ts:48-50`) → `resolvePath` (`utils/paths.ts:103-107`): normalizes unicode spaces, strips a leading `@`, expands `~`, converts `file://`, then `isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(baseDir, normalized)`. **No `realpath` anywhere in the tool path** — a symlinked directory is simply followed by the OS. MEASURED: `edit` on `OpenData/notes.txt` (workspace symlink → `real/OpenData`) rewrote the real file; `write` to `OpenData/sub/new.txt` created `real/OpenData/sub/new.txt`; `read` via the link returned the new content. Only `withFileMutationQueue` keys its lock on `realpath` (`file-mutation-queue.ts:16-26`). Consequence for Acabox's locked folders: a guard must compare BOTH the typed/resolved path and its realpath (see §3).

**No web tool:** grep over `CA/` for `webfetch|web_fetch|web_search|websearch|fetch_url` finds only `core/package-manager.ts` (npm fetching). There is no built-in web fetch or web search tool (see §8).

Other tool-related exports useful to a host: `createBashTool(cwd, { operations?, commandPrefix?, shellPath?, exposeSessionEnvironment?, spawnHook? })` (`bash.ts:214-225`), `BashOperations.exec(command, cwd, {onData, signal, timeout, env}) => {exitCode}` (`bash.ts:75-94`) for a sandboxed replacement (see `EX/sandbox/index.ts:132-199` which spawns `bash -c` under `@anthropic-ai/sandbox-runtime`), `ReadOperations`/`EditOperations`/`WriteOperations` (`read.ts:48-55`, `edit.ts:83-90`, `write.ts:27-32`) to redirect I/O, and `AgentSessionConfig.baseToolsOverride?: Record<string, AgentTool>` (`agent-session.ts:289-295`).

---

## 2. Extension API reference

### 2.1 How extensions load; in-process factories need no jiti

- `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>` (`CA/core/extensions/types.ts:2045`).
- `InlineExtension = ExtensionFactory | { name: string; factory: ExtensionFactory; hidden?: boolean; replaceable?: boolean; builtin?: boolean }` (`types.ts:2047-2075`). `replaceable: true` means the extension is dropped if another registers a tool/command/flag of the same name (`resource-loader.ts:120-151`); `builtin: true` makes it a `builtin:<name>` resource that loads after project trust.
- Passed through `new DefaultResourceLoader({ cwd, agentDir, settingsManager?, extensionFactories?: InlineExtension[], additionalExtensionPaths?, additionalSkillPaths?, additionalPromptTemplatePaths?, additionalThemePaths?, noExtensions?, disabledBuiltinExtensions?, noSkills?, noPromptTemplates?, noThemes?, noContextFiles?, systemPrompt?, appendSystemPrompt?: string[], extensionsOverride?, skillsOverride?, promptsOverride?, themesOverride?, agentsFilesOverride?, systemPromptOverride?, appendSystemPromptOverride?, eventBus? })` (`CA/core/resource-loader.ts:276-313`), then `await loader.reload()` (`resource-loader.ts:513-678`), then `createAgentSession({ resourceLoader: loader, … })`.
- Inline factories are loaded by `loadExtensionFactories` (`resource-loader.ts:1135-1158`) → `loadExtensionFromFactory` (`CA/core/extensions/loader.ts:662-671`) → `initializeExtension` (`loader.ts:613-632`): `const extension = createExtension(extensionPath, resolvedPath); const load = createExtensionAPI(extension, runtime, cwd, eventBus); await factory(load.api); load.commit();`. **jiti is referenced only in `loadExtensionModule` (`loader.ts:559-590`), which is reached only for file paths.** Path label for inline factories: `<inline:${name}>` or `<inline:${index+1}>` (`resource-loader.ts:1145`).
- **MEASURED**: `extensionFactories: [{ name: "acabox-guards", factory }, createToolSearchExtension()]` loaded in 6 ms with `errors: []`, paths `['<inline:acabox-guards>', '<inline:2>']`, under Electron's Node 22.17.0. So yes: **plain in-process functions, no TS loading, no jiti.**
- Registration-time rules (`loader.ts:244-549`): `registerTool` requires an object parameter schema (`loader.ts:291-295`) and calls `runtime.refreshTools()` (no-op during load, live refresh after bind: `agent-session.ts:3456`); `registerCommand` needs a non-empty name and a handler; action methods (`sendMessage`, `setActiveTools`, …) throw during factory execution ("Extension runtime not initialized", `loader.ts:157-160`) — call them from `session_start` or later. Factories must not start timers/processes (`DOCS/extensions.md:58-60`).
- Handler order = extension load order, then registration order; `pi.on()` returns an unsubscribe (`loader.ts:272-287`).

### 2.2 `ExtensionAPI` (verbatim from `types.ts:1592-1918`, condensed to signatures)

```ts
export interface ExtensionAPI {
  on(event: "project_trust", handler: ProjectTrustHandler): () => void;
  on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): () => void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
  on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): () => void;
  on(event: "session_before_switch", handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): () => void;
  on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): () => void;
  on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): () => void;
  on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): () => void;
  on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): () => void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
  on(event: "mcp_servers_change", handler: ExtensionHandler<McpServersChangeEvent>): () => void;
  on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): () => void;
  on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): () => void;
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
  on(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>): () => void;
  on(event: "cache_warming_decision", handler: ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>): () => void;
  on(event: "before_provider_request", handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>): () => void;
  on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
  on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
  on(event: "provider_stream_event", handler: ExtensionHandler<ProviderStreamEvent>): () => void;
  on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): () => void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
  on(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>): () => void;
  on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
  on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): () => void;
  on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): () => void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>): () => void;
  on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
  on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
  on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): () => void;
  on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
  on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
  on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): () => void;
  on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): () => void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
  on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;
  registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
  registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }): void;
  registerFlag(name: string, options: { description?: string; type: "boolean"; default?: boolean } | { description?: string; type: "string"; default?: string }): void;
  getFlag(name: string): boolean | string | undefined;
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
  registerMarkdownTransformer(transformer: MarkdownTransformer): void;
  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
  registerToolRenderer(resolver: ToolRendererResolver): void;
  sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
  sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  setSessionName(name: string): void;  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;   // shell:false spawn, CA/core/exec.ts:34-107
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  getSettings(): Settings;
  setActiveTools(toolNames: string[]): void;
  getCommands(): SlashCommandInfo[];
  setModel(model: Model<any>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  registerProvider(provider: Provider): void;
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  registerMcpServer(name: string, config: McpServerConfig): void;
  unregisterMcpServer(name: string): void;
  getMcpServers(): RegisteredMcpServer[];
  registerVirtualModel<TState = unknown>(model: ExtensionVirtualModel<TState>): void;
  unregisterVirtualModel(provider: string, id: string): void;
  events: EventBus;
}
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;  // types.ts:1587
```
`CustomMessage` (`CA/core/messages.ts:46-53`): `{ role: "custom"; customType: string; content: string | (TextContent|ImageContent)[]; display: boolean; details?: T; timestamp: number }`.

### 2.3 `ExtensionContext`, `ExtensionToolContext`, `ExtensionCommandContext` (verbatim, `types.ts:325-435`)

```ts
export type ExtensionMode = "tui" | "rpc" | "json" | "print";
export interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: ExtensionMode;
  hasUI: boolean;                       // true in TUI and RPC modes
  cwd: string;
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model<any> | undefined;
  scopedModels: readonly ScopedModel[];
  thinkingLevel?: ThinkingLevel;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;      // current run's abort signal, undefined when idle
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;   // { tokens: number|null; contextWindow: number; percent: number|null }
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}
export interface ExtensionToolContext extends ExtensionContext {
  readonly tools: readonly AgentTool[];
  executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>;  // nested call, id `<caller>/<n>`, goes through tool_call/tool_result hooks; never rejects for tool failures
}
export interface ExtensionCommandContext extends ExtensionContext {
  getSystemPromptOptions(): BuildSystemPromptOptions;
  waitForIdle(): Promise<void>;
  newSession(options?: {...}): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: {...}): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string, options?: {...}): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string, options?: {...}): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}
```
`ReadonlySessionManager` = `Pick<SessionManager, "getCwd"|"getSessionDir"|"getSessionId"|"getSessionFile"|"getLeafId"|"getLeafEntry"|"getEntry"|"getLabel"|"getBranch"|"buildContextEntries"|"buildSessionProjection"|"getHeader"|"getEntries"|"getTree"|"getSessionName">` (`CA/core/session-manager.ts:245-262`).

`ctx` values are resolved lazily per access and throw after reload/session replacement (`runner.ts:884-962`, `assertActive`). `ExtensionToolContext` is what every tool's `execute` receives (`runner.ts:968-995`; tools registered by extensions are wrapped with `runner.createToolContext` in `CA/core/extensions/wrapper.ts:17-21`; built-ins get the same wrapper at `agent-session.ts:3578-3588`).

`ExtensionUIContext` (`types.ts:149-300`): `select(title, options, opts?) → string|undefined`, `confirm(title, message, opts?) → boolean`, `input(title, placeholder?, opts?) → string|undefined`, `notify(message, type?)`, `onTerminalInput`, `setStatus(key, text)`, `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `setWidget(key, lines|factory, {placement})`, `setFooter`, `setHeader`, `setTitle`, `custom(factory, options) → T` (TUI only), `pasteToEditor`, `setEditorText`, `getEditorText`, `editor(title, prefill?) → string|undefined`, `addAutocompleteProvider`, `setEditorComponent`, `getEditorComponent`, `theme`, `getAllThemes`, `getTheme`, `setTheme`, `getToolsExpanded`, `setToolsExpanded`. `ExtensionUIDialogOptions = { signal?: AbortSignal; timeout?: number }` (`types.ts:114-119`). Without a bound UI the runner uses `noOpUIContext` where `select → undefined`, `confirm → false`, `input → undefined`, `custom → undefined` (`runner.ts:331-362`), and `hasUI` is `uiContext !== noOpUIContext` (`runner.ts:628-630`). Dialog calls are wrapped to emit `ui_prompt_start`/`ui_prompt_end` (`runner.ts:577-622`).

### 2.4 `ToolDefinition` (verbatim, `types.ts:579-668`)

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string;                 // used in LLM tool calls
  label: string;                // UI label
  description: string;          // for the LLM
  promptSnippet?: string;       // one-line entry in the <tools> section; tool is omitted from that list without it
  promptGuidelines?: string[];  // bullets appended to <rules> while active
  parameters: TParams;          // TypeBox object schema (registerTool throws otherwise)
  constrainedSampling?: false | ConstrainedSamplingConfig;
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;
  outputSchema?: TSchema;       // declares structuredContent for programmatic callers (codemode)
  exposure?: ToolExposure;      // "direct" | "model-only" | "codemode" | "deferred" | "hidden"; default "direct"
  namespace?: ToolNamespace;    // { name; aliases?; description?; instructions? }
  reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[];
  annotations?: ToolAnnotations;// { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }
  defaultActive?: boolean;      // default true for direct/model-only
  prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
  executionMode?: ToolExecutionMode;   // "sequential" | "parallel"
  execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;
  renderCall?: (args, theme, context) => Component;      // TUI only
  renderResult?: (result, options, theme, context) => Component;
}
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>) // types.ts:690 — keeps param inference
```
`AgentToolResult<T>` (`AGENT/types.ts:424-446`): `{ content: (TextContent|ImageContent)[]; details: T; structuredContent?: JsonValue; usage?: Usage; isError?: boolean; terminate?: boolean }`. Throwing from `execute` → error result; returning `{ isError: true }` → error result that keeps `details`/`structuredContent` (`DOCS/extensions.md:139-147`). TypeBox is imported as `import { Type } from "typebox"` (`EX/dynamic-tools.ts:11`) or `from "@earendil-works/pi-ai"` (`EX/hello.ts:5`); in the installed package the ESM entry is `PKG/../typebox/build/index.mjs` (MEASURED import).

### 2.5 Event payloads (verbatim type bodies, `types.ts`)

- `ToolCallEvent` (`1193-1265`): base `{ type: "tool_call"; toolCallId: string; parentToolCallId?: string }` plus per tool: `{ toolName: "bash"; input: BashToolInput }`, `"powershell"`, `"read" (ReadToolInput)`, `"edit" (EditToolInput)`, `"write" (WriteToolInput)`, `"grep"`, `"find"`, `"ls"`, and `CustomToolCallEvent { toolName: string; input: Record<string, unknown> }`. **`event.input` is mutable; mutate in place to patch arguments; no re-validation after mutation** (`1250-1255`). Result `ToolCallEventResult = { block?: boolean; reason?: string; terminate?: boolean }` (`1454-1463`). Narrowing helper `isToolCallEventType("bash", event)` (`1388-1402`).
  - Dispatch: `runner.emitToolCall` (`runner.ts:1249-1267`) runs handlers in order; the **first handler returning `{block:true}` stops dispatch and wins**; non-blocking returns are overwritten by later ones. Handler exceptions propagate (not caught there) → `AgentSession._beforeToolCall` rethrows (`agent-session.ts:668-681`) → "A `tool_call` handler failure blocks the tool as a fail-safe" (`DOCS/extensions.md:263`; INFERRED that agent-loop's try/catch at `AGENT/agent-loop.ts:725` converts it to an error result).
  - A blocked call becomes an error tool result for the model: `createErrorToolResult(beforeResult.reason || "Tool execution was blocked")` with `isError: true` (`AGENT/agent-loop.ts:745-755`, `912-917`): content `[{type:"text", text: reason}]`, `details: {}`. MEASURED via `session.extensionRunner.emitToolCall(...)`: `{"block":true,"reason":"…"}` returned for locked-folder `edit`/`write`, `pip install`, secret-file `read`/`bash`.
  - Applies to every tool: built-ins, extension tools, MCP tools (`DOCS/mcp.md:252`), and nested `ctx.executeTool` calls (carry `parentToolCallId`, `agent-session.ts:731-765`).
- `ToolResultEvent` (`1267-1340`): `{ type: "tool_result"; toolCallId; parentToolCallId?; toolName; input: Record<string, unknown>; content: (TextContent|ImageContent)[]; structuredContent?: JsonValue; isError: boolean; usage?: Usage; details }`. Result `ToolResultEventResult = { content?; details?; structuredContent?; isError?; usage? }` (`1483-1489`); handlers compose (`runner.ts:1190-1247`); replacing `content` without `structuredContent` drops it.
- `BeforeAgentStartEvent` (`932-957`): `{ type: "before_agent_start"; readonly systemPrompt: string; systemPromptOptions: NormalizedBuildSystemPromptOptions; messageType: "user"; prompt: string; images?: ImageContent[] }` or `{ messageType: "custom"; message: CustomMessage }`. Result `{ message?: Pick<CustomMessage,"customType"|"content"|"display"|"details">; systemPrompt?: string }` (`1496-1500`). `systemPromptOptions` is mutable and shared across handlers (`runner.ts:1427-1477`); returning `systemPrompt` sets `forceSystemPrompt` for that run only (`runner.ts:1459-1461`; projection `agent-session.ts:1792-1807`). Returned messages are appended as `role: "custom"` messages after the user message (`agent-session.ts:1926-1936`).
- `AgentStartEvent { type: "agent_start" }` (`960`), `AgentEndEvent { type: "agent_end"; messages: AgentMessage[] }` (`965`), `AgentSettledEvent { type: "agent_settled"; aborted: boolean }` (`1033-1037`) — settled is the only "nothing more will happen automatically" signal (`DOCS/extensions.md:67-68`).
- `TurnStartEvent { type: "turn_start"; turnIndex; timestamp }` (`1058`), `TurnEndEvent extends BoundaryState { type: "turn_end"; turnIndex; message: AgentMessage; toolResults: ToolResultMessage[]; messageEntryId; toolResultEntryIds }` (`1065-1072`); `BoundaryState = { entries: SessionBoundaryDraft[]; continue: boolean; context: BoundaryContextPreview; outcome: "completed"|"aborted"|"error" }` (`1015-1020`); result `BoundaryResult = { entries?; continue? }` (`1022-1025`).
- `AgentBeforeSettleEvent extends BoundaryState { type: "agent_before_settle" }` (`1028`).
- `SessionStartEvent { type: "session_start"; reason: "startup"|"reload"|"new"|"resume"|"fork"; previousSessionFile? }` (`755-761`); `SessionShutdownEvent { type: "session_shutdown"; reason: "quit"|"reload"|"new"|"resume"|"fork"; targetSessionFile? }` (`824-829`); `SessionBeforeCompactEvent { preparation: CompactionPreparation; branchEntries; customInstructions?; reason: "manual"|"threshold"|"overflow"; willRetry; signal }` (`785-795`, result `{ cancel?; compaction?: CompactionResult }` `1511-1514`); `SessionCompactEvent` (`798-806`), `SessionCompactFailedEvent` (`809-821`), `SessionInfoChangedEvent { name }` (`764`), `SessionBeforeSwitchEvent { reason: "new"|"resume"; targetSessionFile? }` (`771`, result `{cancel?}`), `SessionBeforeForkEvent { entryId; position }` (`778`, result `{cancel?; skipConversationRestore?}`), `SessionBeforeTreeEvent { preparation: TreePreparation; signal }` (`847`), `SessionTreeEvent` (`854`).
- `ContextEvent { type: "context"; messages: AgentMessage[] }` (`885-888`) — conversation WITHOUT system messages; return `{ messages }`; Pi restores prompt/tool state afterwards (`runner.ts:292-300`). `ContextWithSystemEvent` (`895-898`) — full transcript, returned as-is; keep a system message at index 0.
- `InputEvent { type: "input"; text; images?; source: "interactive"|"rpc"|"extension"; streamingBehavior?: "steer"|"followUp" }` (`1171-1181`); result `{ action: "continue" } | { action: "transform"; text; images? } | { action: "handled" }` (`1184-1187`); transforms chain, `handled` short-circuits (`runner.ts:1525-1564`). Fires before skill/template expansion (`agent-session.ts:2082-2092`).
- `UserBashEvent { type: "user_bash"; command; excludeFromContext; cwd }` (`1153-1161`), result `{ operations: BashOperations } | { result: BashResult }` (`1466-1476`) — for the host's own `!` commands via `session.executeBash` (`agent-session.ts:3871-3903`), not model calls.
- `ResourcesDiscoverEvent { type: "resources_discover"; cwd; reason: "startup"|"reload" }` → `{ skillPaths?; promptPaths?; themePaths? }` (`725-736`); emitted from `bindExtensions` (`agent-session.ts:3311-3335`).
- `McpServersChangeEvent { servers: RegisteredMcpServer[] }` (`744-748`); `ProjectTrustEvent { cwd }` → `{ trusted: "yes"|"no"|"undecided"; remember? }` (`700-722`), only for user/CLI extensions.
- `MessageStartEvent/MessageUpdateEvent/MessageEndEvent` (`1075-1091`; `message_update` carries `assistantMessageEvent: AssistantMessageEvent` with `text_delta` etc.; `message_end` result `{ message? }` same role); `ToolExecutionStartEvent { toolCallId; toolName; args; parentToolCallId? }`, `…UpdateEvent { partialResult }`, `…EndEvent { result; isError; durationMs?; parentToolCallId? }` (`1094-1125`).
- `ModelSelectEvent { model; previousModel; source: "set"|"cycle"|"restore" }` (`1134`), `ThinkingLevelSelectEvent { level; previousLevel }` (`1142`), `UIPromptStartEvent/EndEvent { reason: "ui_prompt"; kind: "select"|"confirm"|"input"|"editor"|"custom"; title? }` (`1042-1055`), provider events (`901-930`), `CacheWarmingDecisionEvent`.

### 2.6 The `Extension` object and runtime (for the planner)

`Extension` (`types.ts:2268-2284`): `{ path; resolvedPath; hidden?; replaceable?; sourceInfo; handlers: Map<string, HandlerFn[]>; tools: Map<string, RegisteredTool>; messageRenderers; toolRenderers?; markdownTransformer?; entryRenderers?; commands: Map<string, RegisteredCommand>; flags; shortcuts }`. `LoadExtensionsResult = { extensions; errors: {path,error}[]; warnings?; runtime: ExtensionRuntime }` (`2287-2293`). `ExtensionRunner` is built per `AgentSession` in `_buildRuntime` (`agent-session.ts:3667-3678`) and bound in `_bindExtensionCore` (`3390-3523`) — this is where `pi.sendMessage/sendUserMessage/appendEntry/setActiveTools/setModel/...` are wired to session methods, and `executeTool`/`getCallableTools` to `_executeNestedToolCall`/`_getCallableTools`. `session.bindExtensions({ uiContext?, mode?, commandContextActions?, abortHandler?, shutdownHandler?, onError? })` (`ExtensionBindings`, `agent-session.ts:302-309`; method `3288-3312`) sets the UI context and mode, emits `session_start`, then `resources_discover`. **Call it** — `session_start` is what lets extensions do late registration and what connects MCP servers (`DOCS/sdk.md:116`).

---

## 3. Implementing Acabox's guards as a `tool_call` handler

### 3.1 What Acabox enforces today (READ)

- `ACABOX/hooks/settings.json:3-26`: PreToolUse matcher `"Bash"` → `bash .claude/hooks/block-host-installs.sh` and `bash .claude/hooks/block-secret-reads.sh`; matcher `"Read|Edit|Write"` → `block-secret-reads.sh`. Provisioned to `<workspace>/.claude/settings.json` + `.claude/hooks/*.sh` (`ACABOX/main/skills.ts:214-234`).
- `block-host-installs.sh:73-81` patterns (ERE, scanned over the whole command): `(^|[^[:alnum:]_/.-])pip3?[[:space:]]+install([[:space:]]|$)`, `…pipx[[:space:]]+install…`, `…python3?[[:space:]]+-m[[:space:]]+pip[[:space:]]+install…`, `…(npm|pnpm|yarn)[[:space:]]+(install|i|add)…`, `…apt(-get)?[[:space:]]+install…`, `…(conda|mamba)[[:space:]]+(install|create)…`, `install\.packages[[:space:]]*\(`. Exit 2 with the long explanatory message at `:92-118`.
- `block-secret-reads.sh:66` scans `tool_input.command` + `tool_input.file_path`; patterns `:76-84`: `cobuilding-settings\.json`, `claude-config`, `\.claude\.json`, `agent\.json`; message `:95-118`.
- `ACABOX/shared/readOnlyRules.ts`: `READ_ONLY_RULE_TOOLS = ['Edit','Write','NotebookEdit']` (`:35`); `mountNames()` (`:49-57`) computes the workspace link name per shared folder; `buildReadOnlyDenyRules(workspacePath, dirs)` (`:81-101`) emits `Tool(//abs/path/**)` for BOTH the real path and `<workspace>/<name>`; applied as SDK `settings.permissions.deny` (`ACABOX/agent-server/index.ts:676-678`), built in `ACABOX/main/agentSession.ts:658-667`. Bash writes are NOT blocked today ("Shell writes (`Bash`) are NOT blocked by any of this; the prompt tells the agent not to do them", `readOnlyRules.ts:27-28`).

### 3.2 PI equivalent (MEASURED working, from `measure.mjs`)

Tool names map: Claude `Edit`→`edit`, `Write`→`write`, `Read`→`read`, `Bash`→`bash`; the field is `event.input.path` (not `file_path`) and `event.input.command`. `NotebookEdit` has no PI counterpart.

```ts
import { realpathSync } from "node:fs"; import { resolve, dirname } from "node:path";
const isUnder = (t: string, r: string) => { t = resolve(t); r = resolve(r); return t === r || t.startsWith(r + "/"); };
const canon = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
export function acaboxGuards(locked: Array<{ real: string; link: string }>, secretPatterns: RegExp[], installPatterns: RegExp[]) {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "edit" || event.toolName === "write") {
        const abs = resolve(ctx.cwd, String(event.input.path));            // typed form (workspace symlink)
        for (const { real, link } of locked)
          if (isUnder(abs, link) || isUnder(canon(abs), real) || isUnder(canon(dirname(abs)), real))   // real form, incl. not-yet-existing file in a locked dir
            return { block: true, reason: `${link} is locked by the user; ${event.toolName} refused for ${event.input.path}` };
      }
      if (event.toolName === "bash" && installPatterns.some(re => re.test(String(event.input.command))))
        return { block: true, reason: "Direct package installation is not allowed. Use .applications/install …" };
      const hay = [event.input.command, event.input.path].filter(Boolean).join(" ");
      if (secretPatterns.some(re => re.test(hay))) return { block: true, reason: "That file holds Acabox's own credentials and is off limits. …" };
      return undefined;
    });
  };
}
```
MEASURED results: `edit LockedData/notes.txt` → blocked; `write <real locked path>/x.txt` → blocked; `write OpenData/x.txt` → allowed; `bash "cd foo && pip install pandas"`, `"python3 -m pip install numpy"`, `"npm i lodash"` → blocked; `"zipper install"` → allowed (boundary anchoring preserved); `bash cat …cobuilding-settings.json` and `read …cobuilding-settings.json` → blocked; `read OpenData/notes.txt` and the custom `open_mini_application` → allowed. The handler saw every call, including custom tools.

Notes for tickets:
- Return value `reason` is the exact text the model sees (as an error tool result). Keep Acabox's full hook messages.
- Deny both path forms: PI does not realpath, so the model may address a locked folder by the workspace symlink (`LockedData/x`) or by the absolute real path, and `canon()` covers a workspace symlink whose target is the locked real dir. Also block **creating** files under a locked dir (`canon(dirname(abs))`).
- Bash parity: Acabox does not block shell writes to locked folders today; if wanted, add heuristic patterns on `event.input.command` (`>`, `tee`, `rm`, `mv`, `cp` targeting the locked path) — a `bash` `tool_call` handler is the only place; `BashOperations.exec` replacement or `spawnHook` (`bash.ts:178-184`) cannot inspect intent. The OS-level alternative is the sandbox example (`EX/sandbox/index.ts`, `@anthropic-ai/sandbox-runtime` `denyWrite`).
- Nested/MCP calls hit the same hook (`parentToolCallId` set). `user_bash` (host-initiated `!` commands) is a separate event.
- Locked-folder list can be refreshed per run from `before_agent_start` (closure over a mutable array) since folders can be locked mid-session; Acabox's current SDK deny rules are fixed at session create.
- Deliberate exclusion: the PI `read` tool was NOT in the Acabox deny rules (locks are write-only); the secret-file patterns do apply to `read`.

---

## 4. Registering ~40 host tools in-process (no MCP relay)

- Call `pi.registerTool(defineTool({...}))` inside the inline factory for each host tool; `execute(_id, params, signal, onUpdate, ctx)` is an ordinary async function that can call into Electron main directly (it runs in the same process as the session). It receives `ctx.cwd`, `ctx.sessionManager.getSessionId()`, `ctx.signal`, `ctx.ui`, `ctx.executeTool`. Return `{ content: [{type:"text", text}], details }` (`details: undefined` when none). MEASURED: `open_mini_application` registered this way appears as `direct`, active, listed in `<tools>` because it set `promptSnippet`, and its `promptGuidelines` bullet landed in `<rules>`.
- All tools registered during loading are collected in `extension.tools` and installed by `_refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true })` at session construction (`agent-session.ts:522-525`, `3525-3623`): `direct`/`model-only` tools are activated on registration unless `defaultActive: false` (`3632-3634`); `codemode`/`deferred`/`hidden` are registered but not declared. Late registration (from `session_start`, a command, or any handler) works — `EX/dynamic-tools.ts:51-54` registers in `session_start`; `pi.registerTool` → `runtime.refreshTools()` → `_refreshToolRegistry()` live (`loader.ts:300`, `agent-session.ts:3456`). Tools cannot be unregistered; re-register with `exposure: "hidden"` (`DOCS/extensions.md:161`).
- **Deferred/lazy to save context**: set `exposure: "deferred"` and add `createToolSearchExtension()` to `extensionFactories` plus `settingsManager` with `defaultTools: ["+tool_search"]` (or `pi.setActiveTools([...active, "tool_search"])`). `tool_search` is registered `defaultActive: false`, exposure `model-only`, `reachesTools: () => "all"` (`CA/extensions/tool-search/index.ts:12-16`, `tool.ts:217-243`); it BM25-ranks tools whose exposure is `codemode` or `deferred` and not active, activates the matches with `setActiveTools([...active, ...matches])`, and tells the model "Loaded N tools. They are available from your next call:" (`tool.ts:187-209, 235-241`). Search text = name, name with `_`→space, description, schema descriptions/property names, namespace name/description/instructions (`tool.ts:108-116`). Loaded tools are recorded in the transcript's tool declarations and stay declared on that branch (`DOCS/mcp.md:226`). MEASURED: `list_chats` (`exposure: "deferred"`) was registered, callable (`getCallableToolNames()` includes it), not active, not in the prompt; `tool_search` was active with the `+tool_search` setting.
- Alternative lazy mechanism: `exposure: "codemode"` + `createCodemodeExtension({ mode: "on" })` (`CA/extensions/codemode/index.ts:32-47`) — tools become callable from scripts only.
- Grouping: `namespace: { name: "mini-apps", description, instructions, aliases }` groups tools in codemode listings; `annotations` (`readOnlyHint` etc.) let a permission handler decide what to confirm (`DOCS/extensions.md:167-178`).
- Naming: any string; `registerTool` only requires an object schema. Names starting with `mcp__` are treated as MCP tools by `isMcpToolName` (`CA/core/mcp-servers.ts:39-41`), which only matters when `createAgentSession({ tools })`/`excludeTools` allowlists are used (`agent-session.ts:1542-1557`) — with no allowlist (the default) a host tool named `mcp__mini-apps__open_mini_application` behaves like any other tool (INFERRED from those two functions). Keeping the old `mcp__…` names would keep Acabox's existing CLAUDE.md/skill text valid; a cleaner roster would rename and rewrite the text.
- `executionMode: "sequential"` for tools that must not run concurrently with others (question.ts uses it, `EX/question.ts:50`); `prepareLoadout` for orchestrating tools; `outputSchema` + `structuredContent` for data tools.
- Tool call visibility for the UI: `session.subscribe` events `tool_execution_start`/`tool_execution_update`/`tool_execution_end` (`agent-session.ts:1340-1360`, with `parentToolCallId`), plus `message_update` deltas.
- `pi.exec(command, args, { cwd?, timeout?, signal? })` (`loader.ts:411-414` → `CA/core/exec.ts:34-107`, `shell: false`) exists for extensions that need subprocesses.

---

## 5. Skills: Acabox SKILL.md compatibility and pointing PI at a custom directory

### 5.1 Loader facts (READ, `CA/core/skills.ts`)
- Discovery (`loadSkillsFromDirInternal`, `:173-275`): a directory containing `SKILL.md` is a skill root and recursion stops there (`:194-221`); otherwise direct `.md` children of the ROOT dir are standalone skills (`:262-270`) and subdirectories are recursed; `.`-prefixed entries and `node_modules` skipped (`:224-231`); `.gitignore`/`.ignore`/`.fdignore` honoured (`:16, 47-65`); **symlinks are followed** (`statSync` on symlink entries, `:202-206`, `:238-247`); duplicates deduped by `realpath` (`:429-435`); name collisions keep the first and emit a `collision` diagnostic (`:437-453`).
- Frontmatter (`SkillFrontmatter`, `:67-72`): `name?`, `description?`, `disable-model-invocation?`, `[key: string]: unknown` (unknown keys ignored). Rules: `name` falls back to the parent dir name (`:321`); name must be `^[a-z0-9-]+$`, ≤64 chars, no leading/trailing/double hyphen — violations are **warnings only** (`:92-112`, `:323-327`); description required (`:120-124`), ≤1024 chars warning (`:122-123`); malformed frontmatter or missing description → not loaded (`:293-308`, `:329-332`).
- Prompt form (`formatSkillsForPrompt`, `:358-388`): the `<skills>` section says "Use the read tool to load a skill's file when the task matches its description." and lists `<available_skills><skill><name/><description/><location>/abs/path/SKILL.md</location></skill>…` — the `<location>` is the path as discovered (the symlink path, MEASURED). **No listing budget** — the only limits are per-skill name/description lengths; there is no equivalent of Acabox's `skillListingBudgetFraction`.
- Invocation: the model `read`s SKILL.md (no skill tool); or the user types `/skill:<name> args` which `AgentSession._expandSkillCommand` (`agent-session.ts:2177-2201`) expands to `<skill name="…" location="…">\nReferences are relative to <baseDir>.\n\n<body>\n</skill>\n\n<args>`; `enableSkillCommands` only affects command listing. `disable-model-invocation: true` hides a skill from the prompt (`:359`).
- Default locations (`loadSkills` with `includeDefaults`, `:457-460`: `<agentDir>/skills`, `<cwd>/.pi/skills`; and the package manager adds `<cwd>/.agents/skills` and ancestors up to the git root — trusted projects only — plus `~/.agents/skills` (`CA/core/package-manager.ts:2452-2467, 2494-2518, 2546-2567`, `collectAncestorAgentsSkillDirs :474-493`). **`.claude/skills` is not scanned by default** (no `.claude` string anywhere in `CA/` except a context-file name list).
- `DefaultResourceLoader` actually loads skills with `includeDefaults: false` and the explicit path set resolved by the package manager plus `additionalSkillPaths` (`resource-loader.ts:599-604, 840-861`).

### 5.2 Pointing PI at Acabox's render without touching `~/.pi`
Three working routes, all host-side:
1. `new DefaultResourceLoader({ ..., additionalSkillPaths: ["<workspace>/.claude/skills"] })` — MEASURED: both symlinked Acabox skills (`acabox`, `database-lookup`) loaded with `sourceInfo.scope: "temporary"`, `diagnostics: []`, prompt entries pointing at `<workspace>/.claude/skills/<id>/SKILL.md`.
2. `settingsManager` in-memory `{ skills: [ "<abs path>" ] }` (settings `skills: string[]`, `settings-schema.ts:315`, resolved from the agent dir for user-level settings, `DOCS/settings.md:150`).
3. `skillsOverride: (base) => ({ skills: [...], diagnostics })` to inject `Skill` objects directly (`SDKEX/04-skills.ts:17-37`: `{ name, description, filePath, baseDir, sourceInfo: createSyntheticSourceInfo(path, {source:"sdk"}), disableModelInvocation }`) — lets the host build the roster from its skill store (enabled flags, budget) without a filesystem render at all; also `resources_discover` from an extension returning `skillPaths` (`agent-session.ts:3314-3336`).

### 5.3 Acabox's 19 skills vs the loader (READ + measured)
- Dirs: `acabox, academic-writing-agent, alphafold-database-access, database-lookup, docx, ensembl-database, flow-cytometry, geo-database, gnomad-database, manage-mcp-server, manage-mini-application, opentargets-database, pdb-database, pdf, pptx, react-plotly, reactome-database, string-database-ppi, xlsx` (`ACABOX/skills/`). Frontmatter keys across all: `name` (19), `description` (19), `license` (14, spec field), `source` (8, non-spec → ignored). Every `name` equals its dir name; all names are valid `[a-z0-9-]`. Description lengths measured 301–950 chars — all ≤1024, so no warnings. Folded YAML (`description: >`) parses; the description keeps a trailing newline (visible in the measured `<description>` block; harmless). Supporting files (scripts/, references/, up to 59 files in pptx) are untouched; `.md` files inside a skill dir are not loaded as separate skills because `SKILL.md` stops recursion.
- Text that assumes Claude Code and needs rewriting (or shim tools under the same names): `database-lookup`, `gnomad-database`, `opentargets-database` say "use WebFetch (Claude Code native)" (`ACABOX/skills/database-lookup/SKILL.md:36`); `database-lookup/SKILL.md:30` says "a PreToolUse hook blocks it"; CLAUDE.md references `TodoWrite` (`ACABOX/CLAUDE.md:105`), `mcp__mini-apps__…`, `mcp__workspace__…` (`:81-89`), and `.claude/skills/...` script paths (`:71-75`, which still work since cwd = workspace).

---

## 6. Context files and the exact prompt order

### 6.1 Discovery (READ, `CA/core/resource-loader.ts`)
- `loadContextFileFromDir(dir)` (`:184-203`): first existing of `["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]` in that directory (one per dir).
- `loadProjectContextFiles({cwd, agentDir})` (`:232-274`): `<agentDir>/<candidate>` first, then every ancestor of `cwd` from the filesystem root DOWN to `cwd` (collected with `unshift`, so the farthest ancestor comes first and `cwd`'s file last), deduped by path, with a git-worktree shadowing rule (`:214-230`). Loaded regardless of project trust (`DOCS/configuration.md:47`, `DOCS/security.md:57`). Disable with `noContextFiles: true` (`:647-653`) or filter/append with `agentsFilesOverride` (`SDKEX/07-context-files.ts:15-32`).
- **Hazard for Acabox**: the agent cwd is `~/Library/Application Support/acabox/<channel>/cobuilding-workspace`, so PI would also load any `AGENTS.md`/`CLAUDE.md` found in `~/Library/Application Support/acabox/<channel>`, `…/acabox`, `~/Library/Application Support`, `~/Library`, `~` and `/`. Use `noContextFiles: true` + `agentsFilesOverride` (or filter `base.agentsFiles` by prefix) so only host-chosen files reach the prompt.
- **Acabox renders its workspace rules to `<workspace>/.claude/CLAUDE.md`** (`ACABOX/main/skills.ts:214`); PI looks for `<cwd>/CLAUDE.md`, not `<cwd>/.claude/CLAUDE.md`, so either render to the workspace root or inject the content through `agentsFilesOverride` (MEASURED: a root `CLAUDE.md` and an injected virtual `.academia/SOUL.md` both rendered as `<project_instructions path="…">` blocks).

### 6.2 System prompt assembly (READ `CA/core/system-prompt.ts`, MEASURED output)
`AgentSession._rebuildSystemPrompt` (`agent-session.ts:1705-1731`) builds `normalizeBuildSystemPromptOptions({ cwd, skills: loader.getSkills().skills, contextFiles: loader.getAgentsFiles().agentsFiles, customPrompt: loader.getSystemPrompt(), appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"), selectedTools, hiddenTools, toolSnippets, toolGuidelines })`. `buildSystemPromptSections` (`system-prompt.ts:128-193`) emits, in this order, each (except `preamble`) wrapped as `<name>\n…\n</name>`:
1. `preamble` — default: `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.` (`:155-156`) **or** `customPrompt` verbatim (from `<agentDir>/SYSTEM.md`, `.pi/SYSTEM.md` in a trusted project, `DefaultResourceLoader({ systemPrompt })` — a path or literal text, `resource-loader.ts:167-182, 657-661`, or `systemPromptOverride`).
2. `tools` — `- name: promptSnippet` per declared tool with a snippet + "In addition to the tools above, you may have access to other custom tools depending on the project." (`:157-160`). **Omitted when `customPrompt` is set.**
3. `rules` — bash/grep heuristics + each active tool's `promptGuidelines` + "Be concise in your responses" + "Show file paths clearly when working with files" (`:88-125`). **Omitted with `customPrompt`.**
4. `docs` — pointers to the pi README/docs/examples paths of the installed package (`:162-169`; MEASURED to point at `PKG/README.md`, `PKG/docs`, `PKG/examples`). **Omitted with `customPrompt`.**
5. `addendum` — `appendSystemPrompt` (from `<agentDir>/APPEND_SYSTEM.md` / `.pi/APPEND_SYSTEM.md` / `DefaultResourceLoader({ appendSystemPrompt: [...] })` / `appendSystemPromptOverride`) (`:172`).
6. `project_context` — `Project-specific instructions and guidelines:` + `<project_instructions path="…">content</project_instructions>` per context file (`:79-86, 173`).
7. `skills` — the `<available_skills>` block, only if a reader tool (`read` or `bash`) is declared (`:174-182`).
8. `cwd` — the cwd path (`:183`).
9. any custom `sections` (`:184-186`; name must match `/^[a-z][a-z0-9_-]*$/`, not `preamble`) — only settable by extensions mutating `event.systemPromptOptions.sections` in `before_agent_start` (AgentSession never sets them).
Then `buildSystemPrompt` renders via `getSystemMessageText` (`:208-210`); sections are diffed per request and only changed sections are re-sent as a mid-conversation system patch (`diffSystemPromptSections`, `:217-229`; `agent-session.ts:1743-1755`), which preserves prompt caching.

MEASURED exact rendering with a context file, an injected SOUL file, an `appendSystemPromptOverride` string and two skills: `preamble`, `<tools>` (read, bash, edit, write, tool_search, open_mini_application), `<rules>`, `<docs>`, `<addendum>IDENTITY_MARKER…</addendum>`, `<project_context>` with `CLAUDE.md` then `.academia/SOUL.md`, `<skills>`, `<cwd>`.

### 6.3 Mapping Acabox's current composition
Today (`ACABOX/agent-server/index.ts:510-522`): Claude Code preset `claude_code` + `append` = `[soulMd, docxGuidance, workspaceDirectoriesGuidance, apiGuidance, KNOWLEDGE_ROUTING_GUIDANCE]`, with `IDENTITY_PREAMBLE` (`ACABOX/main/identityPreamble.ts:8`) as host guidance and SOUL.md read from `<agentDir>/.academia/SOUL.md` (`ACABOX/main/agentSession.ts:639-649`). In PI:
- Identity + host guidance: `customPrompt` (replace the "operating inside pi" preamble and drop the `<docs>` section — then the host must write its own tool list/rules, since `tools`/`rules` sections disappear too) **or** keep the default preamble and put identity in `appendSystemPrompt` (`<addendum>`). A third option: `before_agent_start` handler mutating `event.systemPromptOptions.customPrompt`/`promptGuidelines`/`sections` per run.
- SOUL.md and workspace-directories guidance: `agentsFilesOverride` entries (rendered as `<project_instructions>`), or `appendSystemPrompt` items, or a per-run `before_agent_start` `message` (custom message, `display:false`, `EX/plan-mode/index.ts:203-251` pattern).
- Dynamic per-turn host context (e.g. the "Referenced chats" block): `session.sendCustomMessage(msg, { deliverAs: "nextTurn" })` (`agent-session.ts:2336-2337`, consumed at `:1923-1925`) or `before_agent_start` → `{ message }`.
- `settingSources: ['project']` has no PI analogue; `.pi/*` project resources require trust; context files load without trust.

---

## 7. Settings that matter for an embedded host; in-memory settings

- Create: `SettingsManager.inMemory(settings: Partial<Settings>, options?)` (`CA/core/settings-manager.ts:359-364`) — `InMemorySettingsStorage`, global scope only, **no project `.pi/settings.json` is read**; `SettingsManager.create(cwd, agentDir)` (`:310-322`) reads `<agentDir>/settings.json` + `<cwd>/.pi/settings.json` (trusted); `settingsManager.applyOverrides(partial)` (`:529`), `getSettings()` (`:459`), `flush()`, `drainErrors()` (`SDKEX/10-settings.ts`). Pass the same instance to `DefaultResourceLoader({ settingsManager })` and `createAgentSession({ settingsManager })`.
- `Settings` type = `Static<typeof SettingsSchema>` (`CA/core/settings-schema.ts:206-454, 479-482`). Keys relevant to a host (defaults from `settings-defaults.ts` / `DOCS/settings.md`):
  - `defaultProvider`, `defaultModel`, `defaultThinkingLevel` (`"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"`, default `medium`), `modelThinkingLevels` (per `provider/modelId`), `thinkingBudgets {minimal,low,medium,high}`, `enabledModels` (patterns).
  - `defaultTools: string[]` — plain names replace `["read","bash","edit","write"]`; `+name`/`-name` modify (`:85-140`; `getDefaultTools :1344-1348`); can name `tool_search`/`codemode`/extension tools registered inactive.
  - `steeringMode`, `followUpMode`: `"one-at-a-time"` (default) | `"all"` (passed into `Agent` at `sdk.ts:441-442`; `session.setSteeringMode/setFollowUpMode` at `agent-session.ts:2730-2748`).
  - `compaction: { enabled (true), reserveTokens (16384), keepRecentTokens (20000), modelOverrides }` (`DOCS/compaction.md` for the algorithm; `session.setAutoCompactionEnabled`, `session.compact()`).
  - `retry: { enabled (true), maxRetries (3), baseDelayMs (2000), maxAgentDelayMs, provider: { timeoutMs, maxRetries (0), maxRetryDelayMs (60000) } }`, `httpIdleTimeoutMs` (300000), `websocketConnectTimeoutMs` (15000), `transport`, `httpProxy`.
  - `hideThinkingBlock` (TUI rendering only; INFERRED irrelevant to SDK event streams), `images: { autoResize (true), blockImages (false) }` (`blockImages` is enforced in `convertToLlm`, `sdk.ts:296-331`), `shellPath`, `shellCommandPrefix`, `npmCommand`, `enableSkillCommands`, `defaultProjectTrust`, `cacheWarming ("streaming")`, `sessionDir`, `packages/extensions/skills/prompts/themes` resource lists, `codemode { mode, inlineBudget }`, `quietStartup`, `enableInstallTelemetry`, `enableAnalytics`.
- Session-level overrides outside settings: `createAgentSession({ model, thinkingLevel, scopedModels, tools, excludeTools, noTools, customTools, cwd, agentDir, modelRuntime, sessionManager, resourceLoader, sessionStartEvent })` (`sdk.ts:48-106`); `session.setModel(model, { persist? })`, `session.setThinkingLevel(level)` (`agent-session.ts:2507, 2642`).
- **Model selection gotcha (MEASURED)**: with no `model` option and `auth.json` empty, `findInitialModel` (`CA/core/model-resolver.ts:543-610`) step 3 "first available model with valid API key" selected `google/gemini-3.1-pro-preview` because this shell exports `GEMINI_API_KEY` — pi-ai discovers provider keys from the environment (`packages/ai/src/env-api-keys.ts:93` `google: "GEMINI_API_KEY"`; `providers/google.ts:11`). An Electron host spreading the user's env will inherit such keys. Always pass `model` explicitly; `prompt()` validates auth per provider and throws `formatNoApiKeyFoundMessage(provider)` otherwise (`agent-session.ts:2119-2136`).
- Process env knobs: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE` (also stops `rg`/`fd` downloads), `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY` (`DOCS/environment-variables.md:79-99`); `AI_AGENT=pi`/`PI_CODING_AGENT=true` markers are set only by the CLI/RPC entry points, not by the SDK (`:18`).

---

## 8. Web fetch / web search

- **None built in.** `allToolNames` is exactly `read, bash, powershell, edit, write, grep, find, ls` (`tools/index.ts:96-105`); no `fetch`/`web` tool exists in `CA/core/tools` or `CA/extensions` (grep). Pi's own examples point the model at a `brave-search` skill run via bash (`EX/plan-mode/index.ts:219`) and the pi-skills collection (`DOCS/skills.md:93`).
- Acabox skills call `WebFetch` (`BASE_AGENT_ALLOWED_TOOLS` includes `'WebSearch', 'WebFetch'` with the comment "The database-lookup skill instructs the agent to call WebFetch directly", `ACABOX/shared/agentAllowedTools.ts:45-48`).
- Provide it as an extension tool: `pi.registerTool(defineTool({ name: "WebFetch" /* or web_fetch */, label, description, promptSnippet: "Fetch a URL and return its text", parameters: Type.Object({ url: Type.String(), prompt: Type.Optional(Type.String()) }), annotations: { readOnlyHint: true, openWorldHint: true }, async execute(_id, { url }, signal) { const res = await fetch(url, { signal }); … return { content:[{type:"text", text: truncateHead(text).content }], details: { status: res.status } }; } }))`. Node 22 has global `fetch` (undici); `undici 8.10.2` is also a direct dependency; in Electron main `net.fetch` is available. Apply the same truncation discipline (`truncateHead` is exported) and write full output to a temp file like bash does. Search would need a provider API (Brave, etc.) — Acabox already has the API proxy for keys.
- Keeping the name `WebFetch` leaves the three skills' text valid; otherwise rewrite `database-lookup`, `gnomad-database`, `opentargets-database`.

---

## 9. Steering and follow-up semantics (chat UI)

- Sending while idle: `await session.prompt(text, { images?, source?, expandPromptTemplates? })` resolves when the whole run (incl. retries, compaction, continuations) is finished (`agent-session.ts:2058-2141`, `_startRun :1837-1882`). Preconditions: throws during compaction (`:2076-2080`), throws with no model or no auth (`:2119-2136`); `/`-prefixed extension commands execute immediately even while streaming (`:2067-2074`).
- Sending while streaming: `prompt()` **throws** `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.` unless `streamingBehavior` is given (`:2103-2108`); use `session.steer(text, images?) → "queued"|"handled"` or `session.followUp(text, images?)` (`:2241-2263`). "Pi counts as busy while a run starts, including the compaction check and `before_agent_start`" (`DOCS/extensions.md:63`).
- Delivery: steering messages are picked up at run start and after each turn's tool results complete, and injected as `user` messages before the next LLM request (`AGENT/agent-loop.ts:175-217, 295-298`); follow-ups are drained only when the agent would otherwise stop and start a new inner loop (`:301-308`). `one-at-a-time` delivers one queued message per turn; `all` delivers the whole queue (`PendingMessageQueue.peek/drain`, `AGENT/agent.ts:143-174`). Queue stats: `queue_update` session event `{ steering: string[]; followUp: string[] }` (`agent-session.ts:204-208`), `pendingMessageCount`, `getSteeringMessages()`, `getFollowUpMessages()`, `clearQueue() → { steering, followUp }` (`:2432-2455`).
- Stop: `await session.abort()` sets the abort flag, cancels retry/compaction/branch summary, calls `agent.abort()` and waits for idle (`:2464-2474`); queued messages are NOT cleared by abort — the TUI returns them to the editor (`DOCS/how-pi-works.md:13`), so a chat UI should call `clearQueue()` after abort and re-show the texts. Aborted runs end with `agent_settled { aborted: true }`.
- Run lifecycle events for the UI (`AgentSessionEvent`, `agent-session.ts:196-237`): `agent_start`, `turn_start`, `message_start/update/end` (assistant text via `assistantMessageEvent.type === "text_delta"`, `DOCS/sdk.md:77-81`), `tool_execution_start/update/end`, `turn_end`, `agent_end { messages, willRetry }`, `auto_retry_start/end`, `compaction_start/end`, `agent_settled { aborted }` (the one to use for "done"), `entry_appended`, `bash_execution_update`.
- Host-injected messages: `session.sendCustomMessage({ customType, content, display, details }, { triggerTurn?, deliverAs?: "steer"|"followUp"|"nextTurn" })` (`:2323-2359`): while streaming it queues as steer (default) or followUp; `triggerTurn:false` while streaming defers the append to turn end; `nextTurn` rides with the next user prompt; `triggerTurn:true` while idle starts a run from a custom message (then `before_agent_start.messageType === "custom"`). `session.sendUserMessage(content, { deliverAs?, expandPromptTemplates? })` is `prompt()` with `source: "extension"` (`:2395-2425`).
- Extensions can intercept typed input via the `input` event (transform/handle) before expansion (`:2083-2092`, `EX/input-transform.ts`) — the place for `acabox://chat/<id>` link handling.

---

## 10. Ask-the-user pattern (no permission UI today)

- `EX/question.ts` registers a `question` tool (`:45-285`) with `executionMode: "sequential"` (`:50`), params `{ question: string; options: [{label, description?}] }` (`:34-42`). In TUI it renders a custom component via `ctx.ui.custom(...)` (`:73-218`); in any other mode it returns `"Error: UI not available (running in non-interactive mode)"` (`:53-62`), so the example as written is TUI-only.
- For Acabox PI (Electron): bind a host `ExtensionUIContext` with `await session.bindExtensions({ uiContext, mode: "rpc", onError })`. With any uiContext bound, `ctx.hasUI` is true (`runner.ts:628-630`) and `ctx.mode === "rpc"`. Implement `select/confirm/input/editor` exactly like PI's RPC mode (`CA/modes/rpc/rpc-mode.ts:100-131, 136-311`): assign an id, send `{ type: "extension_ui_request", id, method, title, options|message|placeholder|prefill, timeout? }` to the renderer, keep a pending map, resolve with the renderer's answer; honour `opts.timeout` (resolve the default: `undefined` for select/input, `false` for confirm) and `opts.signal` (abort → default). Fire-and-forget `notify/setStatus/setWidget/setTitle/setEditorText` can be forwarded or ignored; `custom()` returns `undefined`. MEASURED: a stub uiContext with these methods bound without errors (`ui log` empty because no handler asked).
- Then the tool: `pi.registerTool(defineTool({ name: "ask_user", exposure: "model-only", executionMode: "sequential", annotations: { readOnlyHint: true }, parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }), async execute(_id, { question, options }, signal, _u, ctx) { if (!ctx.hasUI) return { content:[{type:"text",text:"User input is not available"}], details: undefined }; const answer = await ctx.ui.select(question, options, { signal }); return { content:[{type:"text", text: answer === undefined ? "User cancelled" : `User selected: ${answer}` }], details: { question, options, answer } }; } }))` — free text via `ctx.ui.input`, yes/no via `ctx.ui.confirm`. `model-only` is what the docs recommend for "tools that orchestrate other tools or ask the user" (`DOCS/extensions.md:158`).
- Permission prompts use the same channel from a `tool_call` handler: `if (!(await ctx.ui.confirm("Allow tool call?", event.toolName))) return { block: true, reason: … }` (`DOCS/extensions.md:170-178`, `EX/permission-gate.ts:13-33` which blocks by default when `!ctx.hasUI`). The runner emits `ui_prompt_start`/`ui_prompt_end` around every dialog (`runner.ts:589-616`) — subscribe to show a "waiting for you" state. The in-progress run stays busy while the dialog is open (the tool call awaits).
- Confirm dialogs for session actions (`confirm-destructive.ts`) use `session_before_switch`/`session_before_fork` `{cancel:true}`.

---

## 11. Other measured/structural facts the planner needs

- `createAgentSession` returns `{ session, extensionsResult, modelFallbackMessage }` (`sdk.ts:109-116`); `session.dispose()` ends it; `AgentSessionRuntime` (`newSession/switchSession/fork`) exists for multi-session hosts (`DOCS/sdk.md:58-60`).
- Sessions: `SessionManager.inMemory(cwd)` for no files; `SessionManager.create(cwd, sessionDir)` persists JSONL under `<agentDir>/sessions` by default (`sdk.ts:201`). Resume = construct the manager on the file.
- `session.getActiveToolNames()`, `getCallableToolNames()`, `getAllTools()` (`ToolInfo = { name, description, parameters, promptGuidelines, reachesTools, exposure, namespace?, annotations?, sourceInfo }`, `types.ts:2122-2130`), `getToolDefinition(name)`, `setActiveToolsByName(names)` (`agent-session.ts:1487-1530`); `session.systemPrompt` is the effective prompt text (`:1474`).
- MCP: `createMcpExtension({ loadConfig?, createTransport?, credentials?, logPath?, openUrl?, updateConfig?, startupWaitMs? })` (`CA/extensions/mcp/index.ts:69-91`) reads `<agentDir>/mcp.json` + trusted `.pi/mcp.json` by default; `loadConfig` lets the host supply Acabox's connectors programmatically; tools are `mcp__<server>__<tool>` with `exposure` `codemode` (default) | `deferred` | `direct` | `hidden` and per-tool `toolExposure` (`DOCS/mcp.md:191-222`); extension `tool_call` hooks apply (`:252`). Extensions can also `pi.registerMcpServer(name, config)` (`types.ts:1894`).
- Project trust: `hasTrustRequiringProjectResources(cwd)` is true only when `<cwd>/.pi/{settings.json,mcp.json,extensions,skills,prompts,themes,SYSTEM.md,APPEND_SYSTEM.md}` or a `.agents/skills` in cwd/ancestors exists (`CA/core/trust-manager.ts:30-39, 186-208`); `SettingsManager.inMemory` defaults `projectTrusted = true` (`settings-manager.ts:335`), and `createAgentSession` resolves trust only if `DefaultResourceLoader.reload({ resolveProjectTrust })` is used. The Acabox workspace has no `.pi`, so trust is moot unless the agent creates one — note the agent can `write` `.pi/extensions/*.ts` into its own cwd, which PI would load on the next `reload()` if trusted; keep `projectTrusted` false or `noExtensions` + explicit factories only (the same self-modification concern as Acabox's B24).
- Context window / compaction use `model.contextWindow`; `ctx.getContextUsage()` and `session.getContextUsage()` report `{ tokens, contextWindow, percent }`.
- Tool results with images: `tool_result` normalizes/resizes images (`agent-session.ts:706-711`).


## KEY FACTS
- PI built-in tool names are exactly read, bash, powershell, edit, write, grep, find, ls; the default active set is read, bash, edit, write.
  - evidence: CA/core/tools/index.ts:95 `export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";` and CA/core/settings-manager.ts:85 `export const DEFAULT_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];`
- bash spawns `/bin/bash -c <command>` detached, in the session cwd, with process.env plus `<agentDir>/bin` on PATH and PI_* session vars; abort/timeout SIGKILL the process group; there is no background mode.
  - evidence: CA/core/tools/bash.ts:112-118 `spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], { cwd, detached: process.platform !== "win32", env: env ?? getShellEnv(), stdio: [...], windowsHide: true })`; utils/shell.ts:109-111 `if (existsSync("/bin/bash")) return getBashShellConfig("/bin/bash")`; shell.ts:208 `process.kill(-pid, "SIGKILL")`; bash.ts:42 timeout described as "(optional, no default timeout)"
- Tool output truncation is 2000 lines / 50KB (bash keeps the tail and writes full output to a 0600 temp file in os.tmpdir()).
  - evidence: CA/core/tools/truncate.ts:11-12 `export const DEFAULT_MAX_LINES = 2000; export const DEFAULT_MAX_BYTES = 50 * 1024;`; utils/output-files.ts:19 `join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`)`, :15 `const OUTPUT_FILE_MODE = 0o600;`
- File tools resolve paths relative to the session cwd without realpath, so symlinked workspace directories are followed by the OS (MEASURED: edit/write/read through a symlink changed the real files).
  - evidence: CA/utils/paths.ts:103-107 `return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);` ; measure.mjs output: `edit via symlink -> Successfully replaced 1 block(s) in OpenData/notes.txt. | real file now: HELLO OPEN`
- A tool_call handler can block a call; the first handler returning block wins and the model receives the reason as an error tool result.
  - evidence: CA/core/extensions/types.ts:1454-1463 `export interface ToolCallEventResult { block?: boolean; reason?: string; terminate?: boolean; }`; runner.ts:1259-1261 `if (result.block) { return result; }`; AGENT/agent-loop.ts:745-746 `if (beforeResult?.block) { const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");`
- Inline extension factories load in-process with no jiti/TypeScript loading (jiti is only used for file paths).
  - evidence: CA/core/extensions/loader.ts:662-671 `export async function loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath = "<inline>") { ... return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime); }` while createJiti is called only inside loadExtensionModule (loader.ts:559-590); MEASURED under Electron 37.2.0/Node 22.17.0: `loader.reload ms: 6`, `extension errors: []`, `extensions: [ '<inline:acabox-guards>', '<inline:2>' ]`
- The system prompt section order is preamble, tools, rules, docs, addendum, project_context, skills, cwd, then custom sections; tools/rules/docs are omitted when customPrompt (SYSTEM.md) is set.
  - evidence: CA/core/system-prompt.ts:152-186: `if (customPrompt) { promptSections.preamble = customPrompt; } else { ...preamble...; promptSections.tools = ...; promptSections.rules = ...; promptSections.docs = ... }` then `if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt; if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles); ... promptSections.skills ...; promptSections.cwd = cwd...; for (const [name, content] of Object.entries(customSections)) ...`; MEASURED rendered prompt shows that exact order.
- Context files are the first of AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD per directory, loaded from the agent dir and every ancestor of cwd (root first, cwd last); `.claude/CLAUDE.md` (Acabox's render location) is not read.
  - evidence: CA/core/resource-loader.ts:185 `const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];` and :253-269 ancestor walk with `ancestorContextFiles.unshift(contextFile)`; ACABOX/main/skills.ts:214 `{ src: 'CLAUDE.md', dest: path.join('.claude', 'CLAUDE.md'), policy: 'keep-local' }`
- PI does not scan `.claude/skills`; a custom skills directory is supplied with DefaultResourceLoader.additionalSkillPaths (MEASURED: Acabox skill symlinks loaded with no diagnostics) and symlinked skill dirs are followed.
  - evidence: CA/core/package-manager.ts:2452-2467 default dirs are `<agentDir>/skills`, `<project>/.pi/skills`, `.agents/skills` ancestors, `~/.agents/skills`; CA/core/skills.ts:238-247 `if (entry.isSymbolicLink()) { try { const stats = statSync(fullPath); isDirectory = stats.isDirectory(); ...`; measure.mjs output `skills: [ { "name": "acabox", "filePath": ".../ws/.claude/skills/acabox/SKILL.md", ... }, { "name": "database-lookup", ... } ]`, `skill diagnostics: []`
- Skills are advertised by name/description/location in the prompt and loaded by the model with the read tool; there is no listing budget, only per-skill limits of 64-char names and 1024-char descriptions (warnings only).
  - evidence: CA/core/skills.ts:11 `const MAX_NAME_LENGTH = 64;` :14 `const MAX_DESCRIPTION_LENGTH = 1024;` :367-369 `"Use the read tool to load a skill's file when the task matches its description."`; DOCS/skills.md:43 "At startup, Pi scans configured skill locations and adds each skill's name, description, and path to the system prompt. It does not add the full instructions."
- All 19 Acabox skills parse under PI's rules: name equals dir name, descriptions 301–950 chars, extra keys license/source tolerated.
  - evidence: measured in ACABOX/skills: `xlsx 950 chars`, `react-plotly 301 chars`, no name/dir mismatches; CA/core/skills.ts:67-72 `export interface SkillFrontmatter { name?: string; description?: string; "disable-model-invocation"?: boolean; [key: string]: unknown; }`
- Lazy tool exposure exists: exposure "deferred" tools are callable but undeclared until tool_search (registered inactive, model-only) loads them via setActiveTools.
  - evidence: CA/extensions/tool-search/index.ts:14 `pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false });`; tool.ts:187-189 `function isSearchable(exposure) { return exposure === "codemode" || exposure === "deferred"; }` and :204 `tools.setActiveTools([...active, ...matches.map((match) => match.name)]);`; MEASURED `callable tools:` includes `list_chats` while `active tools:` does not.
- There is no built-in web fetch or web search tool in PI 1.2.0.
  - evidence: grep -rniE 'webfetch|web_fetch|web_search|websearch|fetch_url|fetchUrl' over CA/ matched only src/core/package-manager.ts; CA/core/tools/index.ts:96-105 allToolNames contains no such tool; Acabox relies on it: ACABOX/shared/agentAllowedTools.ts:45-48 `'WebSearch', 'WebFetch'` "The database-lookup skill instructs the agent to call WebFetch directly"
- prompt() while streaming throws unless streamingBehavior is given; steer() enters after the current turn's tool calls, followUp() after the run would stop; one-at-a-time is the default queue mode.
  - evidence: CA/core/agent-session.ts:2103-2108 `if (this.isStreaming) { if (!options?.streamingBehavior) { throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."); }`; AGENT/agent-loop.ts:295 `pendingMessages = (await config.getSteeringMessages?.()) || [];` and :301-308 follow-up drain; settings-defaults.ts:7-8 `steeringMode: "one-at-a-time", followUpMode: "one-at-a-time"`
- An embedding host provides dialogs by binding its own ExtensionUIContext with mode "rpc"; select/confirm/input then resolve from the host's answer, with timeout/abort defaults, exactly as PI's RPC mode does.
  - evidence: CA/core/agent-session.ts:302-309 `export interface ExtensionBindings { uiContext?: ExtensionUIContext; mode?: ExtensionMode; ... }`; CA/modes/rpc/rpc-mode.ts:319-321 `await session.bindExtensions({ uiContext: createExtensionUIContext(), mode: "rpc",`; rpc-mode.ts:115-120 `if (opts?.timeout) { timeoutId = setTimeout(() => { cleanup(); resolve(defaultValue); }, opts.timeout); }`; runner.ts:628-630 `hasUI(): boolean { return this.uiContext !== noOpUIContext; }`
- Settings can be supplied in memory with SettingsManager.inMemory(partial); in-memory managers read no project .pi/settings.json.
  - evidence: CA/core/settings-manager.ts:359-364 `static inMemory(settings: Partial<Settings> = {}, options = {}): SettingsManager { const storage = new InMemorySettingsStorage(); ... storage.withLock("global", () => JSON.stringify(initialSettings, null, 2)); return SettingsManager.fromStorage(storage, options); }`
- With no explicit model, PI picks the first model whose provider has a key, including keys discovered from environment variables (MEASURED: google/gemini-3.1-pro-preview chosen because GEMINI_API_KEY was in the shell env).
  - evidence: CA/core/model-resolver.ts:591-606 "// 3. Try first available model with valid API key ... return { model: availableModels[0], ...}"; packages/ai/src/env-api-keys.ts:93 `google: "GEMINI_API_KEY",`; measure.mjs bash output `MODEL=gemini-3.1-pro-preview PROVIDER=google` with scratch auth.json `{}`
- The agent directory is relocated with PI_CODING_AGENT_DIR (and the SDK agentDir option); several paths (bin dir for rg/fd, trust.json, mcp-auth.json) use getAgentDir() directly, so both must be set.
  - evidence: DOCS/environment-variables.md:81 `| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |`; CA/config.ts:605-611 `export function getAgentDir(): string { const envDir = process.env[ENV_AGENT_DIR]; if (envDir) { return expandTildePath(envDir); } return join(homedir(), CONFIG_DIR_NAME, "agent"); }`; config.ts:639-641 `export function getBinDir(): string { return join(getAgentDir(), "bin"); }`
- Acabox's current guards: PreToolUse hooks on Bash (install + secret patterns) and Read|Edit|Write (secret patterns), plus SDK permissions.deny rules for Edit/Write/NotebookEdit on both the real path and the workspace symlink of each locked folder; Bash writes are not blocked.
  - evidence: ACABOX/hooks/settings.json:5 `"matcher": "Bash"` and :18 `"matcher": "Read|Edit|Write"`; ACABOX/shared/readOnlyRules.ts:35 `export const READ_ONLY_RULE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;` :92 `const paths = [real, `${stripTrailingSlashes(workspacePath)}/${names[i]}`];` :27-28 "Shell writes (`Bash`) are NOT blocked by any of this"

## RISKS
- PI loads context files from EVERY ancestor of the cwd regardless of trust; the Acabox workspace sits under ~/Library/Application Support/acabox/<channel>/, so a user's ~/AGENTS.md or ~/CLAUDE.md (or one in any parent) would silently enter the prompt — use `noContextFiles: true` plus `agentsFilesOverride` (resource-loader.ts:232-274, 647-653).
- Acabox renders workspace rules to `<workspace>/.claude/CLAUDE.md`, which PI never reads (it looks for `<cwd>/CLAUDE.md`); without moving the file or injecting it via agentsFilesOverride, the workspace rules would not reach the model (resource-loader.ts:184-203; main/skills.ts:214).
- The default preamble says the model is 'operating inside pi, a coding agent harness' and the <docs> section points at the pi package's README/docs; replacing it with `customPrompt` drops the generated <tools> and <rules> sections too (system-prompt.ts:152-170), so the host must then describe tools itself or keep the preamble and use appendSystemPrompt.
- Locked-folder enforcement moves from the harness to a host-written tool_call handler: PI tools do not realpath, so the guard must compare both the typed/resolved path and its realpath against both the workspace symlink and the real directory, including file creation under a locked dir; a bug there silently unlocks folders.
- PI resolves provider API keys from environment variables (e.g. GEMINI_API_KEY, ANTHROPIC_API_KEY) and, with no explicit `model`, auto-selects the first provider with a key; an Electron host that spreads the user's shell env may run turns on an unintended provider unless `model` is always passed (model-resolver.ts:591-606, ai/env-api-keys.ts).
- Several code paths call getAgentDir() directly (rg/fd download dir, trust.json, mcp-auth.json, mcp.log), so forgetting `PI_CODING_AGENT_DIR` while passing `agentDir` would write under ~/.pi/agent; `ModelRuntime.create` also writes auth.json/models-store.json into the agent dir on first use (measured).
- grep/find depend on ripgrep/fd binaries that PI downloads from GitHub into `<agentDir>/bin` when not on PATH (tools-manager.ts); a packaged offline app must ship them or accept the download (PI_OFFLINE disables it and the tools then error).
- A project `.pi/` directory created by the agent inside its own cwd (it has `write` and `bash`) would be loaded as project extensions/skills on the next reload if project trust is true (SettingsManager.inMemory defaults projectTrusted=true; trust-manager.ts:30-39) — keep project trust false or `noExtensions` and inline factories only (same self-modification concern as Acabox's B24).
- Three Acabox skills instruct the agent to call `WebFetch` and CLAUDE.md names `TodoWrite` and `mcp__…` tools; PI has none of these built in, so either register tools under the same names or rewrite the texts, or the model will emit calls to nonexistent tools (error results).
- Tool-level blocking only covers edit/write/read/bash as tool calls; `bash` can still write into a locked folder (parity with today's Acabox, which also leaves shell writes to the prompt); OS-level enforcement would need a BashOperations replacement such as the sandbox example.
- `tool_call` handler exceptions block the tool (fail-safe) — a bug in the guard blocks every call; keep the handler defensive.
- No listing budget exists for skills in PI: all enabled skill descriptions go into the prompt every turn (19 Acabox skills ≈ 10 KB of descriptions), unlike Acabox's budgeted roster; the host must trim via skillsOverride if cost matters.

## UNKNOWNS
- Behaviour on a real model turn (streaming, steer/followUp timing as observed by a chat UI, tool_search activation mid-conversation) was not exercised — the measurement deliberately made no model call; everything about run lifecycle is read from code.
- Whether a `tool_call` handler throwing an Error is converted to an error tool result by agent-loop's try/catch at AGENT/agent-loop.ts:725 was not read past the `try` line; the docs say a handler failure blocks the tool (extensions.md:263), so this is inferred.
- `hideThinkingBlock` is assumed to affect only TUI rendering; whether thinking deltas still arrive in SDK `message_update` events regardless of the setting was not verified.
- Exact remaining export list differences between src/index.ts and dist/index.d.ts beyond the names grepped (e.g. `buildSystemPrompt` and `wrapToolDefinition` are not exported from dist) were not exhaustively diffed.
- How `createMcpExtension({ loadConfig })` must shape `LoadedMcpConfig` to feed Acabox connectors programmatically (type in CA/extensions/mcp/config.ts) was not read.
- Compaction internals (docs/compaction.md, core/compaction) were not read; only the settings keys and the session_before_compact hook contract are documented here.
- The question/ask-user pattern via a host-bound ExtensionUIContext was verified only to bind without errors; an end-to-end select() round trip through a renderer was not run.
- Whether `isMcpToolName` (name starts with `mcp__`) has any effect beyond the `tools`/`excludeTools` allowlist paths (e.g. in codemode listings or the MCP extension's own bookkeeping) was not checked.
- Packaging questions (shipping rg/fd, Electron asar unpacking of the ESM package, jiti exclusion) are out of scope and untested.
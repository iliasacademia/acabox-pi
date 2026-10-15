# Acabox → Claude Agent SDK / agent-server protocol inventory (for PI mapping)

Sources read in full (all under `/Users/iliasbeshimov/Documents/Dev Folders/Acabox/src/cobuilding/` unless noted): `agent-server/index.ts` (1288 lines), `agent-server/sessionConfig.ts`, `agent-server/dynamicMcp.ts`, `agent-server/jsonSchemaToZod.ts`, `main/controllers/AgentInfrastructureController.ts`, `shared/agentAllowedTools.ts`, `shared/readOnlyRules.ts`, `shared/claudeConfigApproval.ts`, `main/claudeConfigDir.ts`, `main/transcriptStore.ts`, `main/freePort.ts`, `main/containerService.ts` (1-1072), `main/apiProxy.ts` (440-600), `main/agentSession.ts` (all 1787 lines), `main/sessionRegistry.ts`, `shared/connectors.ts`, `shared/hostedMcp.ts`, `shared/oauthWindow.ts`, `shared/paths.ts`, `shared/models.ts`, `shared/skills.ts` (parts), `shared/apis.ts` (parts), `shared/types.ts` (parts), `shared/claudeDesign.ts`, `main/claudeDesignLogin.ts`, `main/identityPreamble.ts`, `main/skills.ts` (1-260), `settings.json`, `hooks/*.sh`, `CLAUDE.md` (workspace agent rules), `main/directoryScanner/shared.ts`, `.../agents/fileTagging.ts` (1-120), `.../agents/researchProfile.ts` (1-110), `main/index.ts` (selected ranges), `main/scheduledTasks/runner.ts`, `main/calendarAgentSession.ts` (596-700), `shared/turnCost.ts`, `main/db/chatRepository.ts` (parts), `main/connectorsStore.ts` (270-340), `webpack.agent-server.config.js`, `forge.config.js` (grep), `package.json`, and `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.296) for the type contracts. PI side: only `packages/coding-agent/docs/environment-variables.md` (to confirm the env var name).

Everything below is READ unless marked **INFERRED**. Where a code comment and code disagree I note it; code wins.

Versions (package.json): `"@anthropic-ai/claude-agent-sdk": "^0.3.296"` (line 88; installed `0.3.296`), `"@anthropic-ai/sdk": "^0.126.0"` (89), `"@modelcontextprotocol/sdk": "1.29.0"` (99, exact pin), `"zod": "^4.3.6"` (85), `"electron": "^37.2.0"` (67).

---

## 0. Topology in one paragraph

Electron main spawns `dist/agent-server.js` (a webpack `target:'node'` bundle of `agent-server/index.ts`, `externals: {}`, i.e. the ESM-only SDK is bundled in — `webpack.agent-server.config.js`) as a child of `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (`containerService.ts:514-540`). The agent server is a plain `http.createServer` on `127.0.0.1:<port>` (`agent-server/index.ts:1214-1219`) that holds a `Map<string, SessionState>`; each session wraps exactly one SDK `query()` in streaming-input mode. Host-side tools live in main as plain async functions on `globalThis.__hostMcpServers` (`AgentInfrastructureController.ts:383`) and are reached by in-process `createSdkMcpServer` relays whose handlers broadcast an SSE `mcp-call` and await a `POST /sessions/:id/mcp-result`. The host (`main/agentSession.ts`) creates sessions, POSTs messages, consumes the SSE stream, converts `SDKMessage`s into `ChatStreamMessage`s for the renderer (IPC `chat:event`), and persists rows to SQLite.

---

## 1. EVERY option passed to `query()`

### 1a. The chat path — `agent-server/index.ts:624-688` (inside `startQuery(resume?)` of `createSession`)

Verbatim:

```ts
const queryInstance = query({
  prompt: userMessageGenerator(messageQueue),
  options: {
    ...(sessionConfig.claudeBinaryPath ? { pathToClaudeCodeExecutable: sessionConfig.claudeBinaryPath } : {}),
    stderr: (data: string) => { for (const line of data.split('\n').filter(Boolean)) { console.log(`[AgentServer:stderr] ${line}`); } },
    model: sessionConfig.model,
    thinking: { type: 'adaptive' },
    ...(sessionConfig.effort ? { effort: sessionConfig.effort as any } : {}),
    systemPrompt: buildSystemPrompt(sessionConfig) as any,
    ...(resume && { resume }),
    includePartialMessages: true,
    cwd: getWorkspaceRoot(),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: sessionConfig.anthropicApiKey,
      ...(sessionConfig.anthropicBaseURL ? { ANTHROPIC_BASE_URL: sessionConfig.anthropicBaseURL } : {}),
      MINI_APP_WORKSPACE_DIR: getWorkspaceRoot(),
      CLAUDE_CONFIG_DIR: getClaudeConfigDir(),
    },
    settingSources: sessionConfig.settingSources as any[],
    ...(sessionConfig.skills !== undefined ? { skills: sessionConfig.skills } : {}),
    settings: {
      autoMemoryEnabled: true,
      autoMemoryDirectory: `${getWorkspaceRoot()}/${AGENT_MEMORY_SUBDIR}`,
      autoDreamEnabled: false,
      skillListingBudgetFraction: 0.05,
      ...(sessionConfig.permissionDeny?.length ? { permissions: { deny: sessionConfig.permissionDeny } } : {}),
    },
    mcpServers: mergeDynamicMcpServers(state) as any,
    allowedTools: sessionConfig.allowedTools,
  },
});
```

Option-by-option, with value and source:

| Option | Value | Source / notes |
|---|---|---|
| `prompt` | `userMessageGenerator(messageQueue)` — an `AsyncGenerator<SDKUserMessage>` (`index.ts:524-529`) yielding `{ type: 'user', message: { role: 'user', content } }` per queued payload | Streaming-input mode: one `query()` serves many turns; `messageQueue.done()` ends it. `content` is built by `buildContentBlocks` (`index.ts:531-552`): plain string when no attachments; otherwise blocks: `image` → `{type:'image', source:{type:'base64', media_type, data}}`; `document` with `mediaType==='application/pdf'` → `{type:'document', source:{type:'base64', media_type:'application/pdf', data}, title}`; other `document` → base64-decoded text as `{type:'document', source:{type:'text', media_type:'text/plain', data}, title}`; `file_reference` → `{type:'text', text:'[Attached file: <filePath>]\nThis file has been placed in the workspace. You may need to preprocess it before use.'}`; then the text block last. |
| `pathToClaudeCodeExecutable` | only if `sessionConfig.claudeBinaryPath` | `AgentConfig.claudeBinaryPath?: string` (`sessionConfig.ts:5`) is **never set** by the host (`agentConfig` literal at `AgentInfrastructureController.ts:487-512` has no such key) → SDK auto-resolves the platform package binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, see `shared/claudeDesign.ts:84-95`). |
| `stderr` | logs each line as `[AgentServer:stderr] …` (`index.ts:630-634`) | main re-logs the child's stdout/stderr as `[AgentServer] …` (`containerService.ts:545-554`). |
| `model` | `sessionConfig.model` = `POST /sessions` body `model` if present (`index.ts:1083`, `mergeSessionConfig` `sessionConfig.ts:106`) else boot config `DEFAULT_MODEL` | `DEFAULT_MODEL = 'claude-opus-5-5'` (`shared/models.ts:160`); boot config `model: DEFAULT_MODEL` (`AgentInfrastructureController.ts:493`). The host passes the chat's **pinned** model (`main/index.ts:2300-2302`, `2343`). |
| `thinking` | `{ type: 'adaptive' }` literal (`index.ts:636`) | SDK `ThinkingAdaptive = { type: 'adaptive'; display?: 'summarized' \| 'omitted' }` (`sdk.d.ts:9796-9799`). |
| `effort` | `sessionConfig.effort` — session override `body.effort` else boot `'high'` (`AgentInfrastructureController.ts:496`) | Vocabulary `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` (`sdk.d.ts:695 export declare type EffortLevel`; renderer `ModelSelector.tsx:41 export type EffortId = 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`, label for xhigh is "Extra"). |
| `systemPrompt` | `buildSystemPrompt(sessionConfig)` (`index.ts:510-522`): if `config.systemPrompt` is an object → `{ ...config.systemPrompt, append: appendParts }` where `appendParts = [config.soulMd, config.docxGuidance, config.workspaceDirectoriesGuidance, config.apiGuidance, KNOWLEDGE_ROUTING_GUIDANCE].filter(Boolean).join('\n\n')` | Boot config: `systemPrompt: { type: 'preset', preset: 'claude_code' }` (`AgentInfrastructureController.ts:497`). So the effective value is `{type:'preset', preset:'claude_code', append: <soulMd ⏎⏎ IDENTITY_PREAMBLE ⏎⏎ workspaceDirectoriesGuidance ⏎⏎ apiGuidance ⏎⏎ KNOWLEDGE_ROUTING_GUIDANCE>}`. SDK shape: `{ type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean; snapshot?: boolean }` (`sdk.d.ts:2422-2432`). Per-session parts come from `POST /sessions` overrides: `soulMd` (user's Settings instructions, read from `<agentDir>/.academia/SOUL.md`, `agentSession.ts:644-649`), `hostGuidance` → `docxGuidance` (`sessionConfig.ts:109`) = `IDENTITY_PREAMBLE` (`main/identityPreamble.ts:8-14`, begins `You are Acabox, a local research workbench … built on Claude by Anthropic. If asked what you are, say so plainly — "I'm Acabox, built on Claude".`), `workspaceDirectoriesGuidance` (`agentSession.ts:657-682`, `## Workspace Directories` list with `(locked by you)` / `(read & write)` lines), `apiGuidance` (`shared/apis.ts:451-481`, `## APIs` block with `curl -sH "x-acabox-api-token: $ACABOX_API_TOKEN" "$ACABOX_API_BASE/…"`; only when `apiProxy.isRunning()`, `agentSession.ts:829-831`). `KNOWLEDGE_ROUTING_GUIDANCE` is a constant (`index.ts:495-508`) routing durable facts to `mcp__knowledge__record_finding`. **The workspace `CLAUDE.md` is NOT in `systemPrompt`** — it reaches the model through `settingSources: ['project']` (below). |
| `resume` | `resume` arg of `startQuery` = `validResume` = `resumeSessionId` from `POST /sessions` body, after an existence check (`index.ts:715-736`): looks for `${CLAUDE_CONFIG_DIR}/projects/*/${id}.jsonl`; if not found logs `Session … not found in config dir, starting fresh` and resumes nothing. | Host passes `resumeSessionId: resumeId` = `sessions.sdk_session_id` from SQLite unless `turnState.resumeDisabled` (`agentSession.ts:815-818`, `836-846`). |
| `includePartialMessages` | `true` (`index.ts:642`) | Emits `stream_event` messages (`SDKPartialAssistantMessage`, `sdk.d.ts:5537-5546`: `event: BetaRawMessageStreamEvent`). The host's token-level streaming depends on it (§2d). |
| `cwd` | `getWorkspaceRoot()` = `process.env.COSCIENTIST_WORKSPACE \|\| '/data'` (`index.ts:167-169`) | `/data` is a container-era fallback; the host always sets `COSCIENTIST_WORKSPACE: agentDir` (`containerService.ts:523`). User folders are symlinked into this dir (`containerService.ts:226-294`). |
| `env` | `{...process.env, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL?, MINI_APP_WORKSPACE_DIR: <workspace>, CLAUDE_CONFIG_DIR: getClaudeConfigDir()}` (`index.ts:644-650`) | `process.env` here is the agent-server process env built by `buildSubprocessEnv()` + the `COSCIENTIST_*` vars (§4). `getClaudeConfigDir()` = `COSCIENTIST_CLAUDE_CONFIG_DIR \|\| <workspace>/.academia/claude-config` (`index.ts:178-181`). Also set at process level: `process.env.CLAUDE_CONFIG_DIR = getClaudeConfigDir()` before `startServer` (`index.ts:1285`). |
| `settingSources` | `['project']` (`AgentInfrastructureController.ts:511`) | Comment at 507-510: `'project' loads CLAUDE.md — required. It also makes the SDK read a project .mcp.json, which the agent can write, so Settings surfaces any such file via detectUnmanagedMcpJson`. SDK type `SettingSource = 'user' \| 'project' \| 'local'` (`sdk.d.ts:9416`). Measured note in `shared/connectors.ts:19-21`: with `['project']` a project `.mcp.json` IS loaded while `claude mcp add` local/user writes are ignored. |
| `skills` | `sessionConfig.skills` when `!== undefined` (`index.ts:658`) | Built by `buildSkillRuntimeConfig(await readSkillsState())` (`AgentInfrastructureController.ts:469`; `shared/skills.ts:571-580`): enabled, non-removed store ids sorted + `BUNDLED_ALLOW = ['claude-api']` (`skills.ts:154`). Comment `skills.ts:555-564`: the SDK unions `Skill(<id>)` into `allowedTools` itself; `[]` would mean "load none". Replaceable via `POST /skills` (next session only). SDK: `skills?: string[] \| 'all'` (`sdk.d.ts:2294`). |
| `settings.autoMemoryEnabled` | `true` | `sdk.d.ts:9227`. |
| `settings.autoMemoryDirectory` | `` `${workspace}/.academia/agent-memory` `` (`AGENT_MEMORY_SUBDIR`, `shared/paths.ts:26`) | `MEMORY.md` index is loaded unconditionally every turn (`paths.ts:31-36`); `about_you.md` / `working_on.md` are written there by the scanner. |
| `settings.autoDreamEnabled` | `false` | comment `index.ts:662-667`. |
| `settings.skillListingBudgetFraction` | `0.05` | comment `index.ts:668-672` (default 0.01 = 8,000 chars; 21 shipped skills need ~10,575). CLI constants recorded in `shared/skills.ts:596-611` (`ROSTER_CHARS_PER_TOKEN=4`, default fraction 0.01, fallback 8000 chars, `skillListingMaxDescChars` default 1536). |
| `settings.permissions.deny` | `sessionConfig.permissionDeny` when non-empty (`index.ts:674-678`) | Rules from `buildReadOnlyDenyRules(workspaceRoot, dirs)` (`shared/readOnlyRules.ts:81-101`): for each locked dir, for each tool in `READ_ONLY_RULE_TOOLS = ['Edit', 'Write', 'NotebookEdit']` (line 35), for both the real path and the workspace symlink → `` `${tool}(/${escapeForRule(clean)}/**)` `` (line 77) i.e. `Edit(//abs/path/**)` (the `//` prefix is the CLI's filesystem-absolute form, comment lines 9-17). Passed from host as `permissionDeny: readOnlyDenyRules` (`agentSession.ts:844`). |
| `mcpServers` | `mergeDynamicMcpServers(state)` = `{...state.mcpRelayServers, ...state.mcpConnectors, ...state.mcpHosted}` with `assertDynamicMcpComplete` (`dynamicMcp.ts:100-108`) | Three halves: (a) relays — `createSdkMcpServer` instances from `createMcpRelayServers(state)` (`index.ts:230-394`) filtered by `filterMcpServers(servers, allowedTools)` which keeps a server only if some allowed tool starts with `mcp__<serverName>__` (`sessionConfig.ts:87-96`); (b) connectors — `config.mcpServers` from `buildMcpServers(listConnectorsWithSecrets())` (`AgentInfrastructureController.ts:459-460`), shapes in §1c; (c) hosted — `buildHostedMcpServers(state, config.hostedServers)` (`index.ts:417-436`), one `createSdkMcpServer` per hosted id with tools from `tools/list` converted by `jsonSchemaToZod`. |
| `allowedTools` | `sessionConfig.allowedTools` = boot list + `additionalAllowedTools` (unused now) | Boot: `buildAgentAllowedTools([...connectorTools, ...hostedIds.map((id) => `mcp__${id}`)])` (`AgentInfrastructureController.ts:505`). Full list in §1d. |

**Options deliberately or implicitly ABSENT on the chat path** (verified by reading 624-688): `canUseTool` (none anywhere — `agentAllowedTools.ts:12-16` "there is no `canUseTool` handler anywhere in Acabox"), `permissionMode` (default), `tools` (never set; so the model has the full `claude_code` preset toolset — `allowedTools` is auto-approve, not restriction), `maxTurns`, `maxBudgetUsd`, `maxThinkingTokens`, `hooks` (in-process; command hooks arrive via the workspace `.claude/settings.json` instead), `abortController`, `outputFormat`, `persistSession` (default `true` — transcripts ARE persisted; resume depends on it), `title`, `agents`, `plugins`, `forkSession`, `sessionId` (the SDK mints its own; the host learns it from `system/init`).

**Prerequisite side effect before every `query()`:** `ensureApiKeyApproved(getClaudeConfigDir(), sessionConfig.anthropicApiKey)` (`index.ts:620`; §5a). And a guard: empty key → `throw new Error('No Anthropic API key configured. Add one in Settings.')` (`index.ts:610-612`; wording must stay free of `401`/`token`/`unauthorized` because `agentSession.ts:37-41 isAuthError` would otherwise retry).

**Auth retry inside the loop** (`index.ts:692-705`): on `msg.type === 'system' && msg.subtype === 'api_retry' && (msg.error_status === 401 || msg.error_status === 403)` a second occurrence calls `queryInstance.close()` and throws `Failed to authenticate. API Error: <status>` → broadcast as SSE `error` → host `isAuthError` → credential refresh → loop restart (§3).

### 1b. The scanner path — two one-shot `query()` calls (main process, not the agent server)

`main/directoryScanner/shared.ts:185-224 buildCommonQueryOptions(ctx)` (verbatim core):

```ts
return {
  abortController,
  ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),   // never set (grep: only shared.ts references it)
  tools: ["Read", "Glob", "Grep", docReaderTool],          // docReaderTool = "mcp__document-reader__read_document"
  allowedTools: ["Read", "Glob", "Grep", docReaderTool],
  cwd: ctx.cwd,
  env: { ...process.env, ANTHROPIC_API_KEY: apiKey, ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
         CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), 'scanner-claude-config') },
  mcpServers: { "document-reader": createDocumentReaderMcpServer(directoryPaths, hasDriveItems) },
  persistSession: false as const,
  thinking: { type: "disabled" as const },
  effort: "low" as const,
  settingSources: [] as any[],
  hooks: createHooks(directoryPaths),
  stderr: (data: string) => { … log.debug(`[DirectoryScanner:stderr] ${line}`) },
};
```

`createHooks` (`shared.ts:226-278`) returns `{ PreToolUse: [{ matcher: "Read|Glob|Grep|mcp__document-reader__read_document", hooks: [blockHiddenPaths, blockOutsideCwd] }] }` — **in-process `HookCallback`s** (SDK types `HookCallback`, `PreToolUseHookInput`) returning `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } }` to deny hidden paths (`.`-segments) and paths outside the scan roots; reads `tool_input.file_path | path | pattern`. Before building: `ensureApiKeyApproved(scannerConfigDir, apiKey)` (`shared.ts:193`).

Per-agent additions: `fileTagging.ts:36-49`: `model: BACKGROUND_MODEL` (`'claude-haiku-5-5'`, `models.ts:181`), `systemPrompt: buildSystemPrompt()` (a plain string), `maxTurns: 15`, `maxBudgetUsd: 1`, `outputFormat: { type: "json_schema", schema: FILE_TAGGING_SCHEMA }`. `researchProfile.ts:31-44`: `model: "claude-sonnet-4-6"`, string `systemPrompt`, `maxTurns: 10`, `maxBudgetUsd: 2`, `outputFormat: { type: "json_schema", schema: RESEARCH_PROFILE_SCHEMA }`. Result consumption `consumeAgentStream` (`shared.ts:161-183`): non-`result` messages → progress callback; `result.subtype === "success"` → `(msg as any).structured_output`; else `throw new Error(msg.error || msg.subtype)`. The document-reader is an in-process `createSdkMcpServer` (`documentReaderMcpServer.ts:9-37`) with `tool('read_document', …, { file_path: z.string(), max_chars: z.number().optional() }, handler)`.

### 1c. MCP server config shapes handed to `query()` / `setMcpServers`

- Relay / hosted: `createSdkMcpServer({ name, tools: [tool(name, description, zodRawShape, handler)] })` → `McpSdkServerConfigWithInstance = { type: 'sdk'; name; timeout?; instance: McpServer }` (`sdk.d.ts:1199-1215`). `tool()` signature (`sdk.d.ts:9821`): `tool<Schema extends AnyZodRawShape>(_name, _description, _inputSchema: Schema, _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>, _extras?: { annotations?; searchHint?; alwaysLoad? })`. Handlers return `{ content: [{ type: 'text', text }], isError?: boolean }` (`index.ts:218-221`).
- Connectors (`shared/connectors.ts:253-270 toMcpServerConfig`): stdio → `{ type: 'stdio', command, args?, env?, alwaysLoad? }`; http/sse → `{ type: 'http'|'sse', url, headers?, alwaysLoad? }`. Matches SDK `McpStdioServerConfig = { type?: 'stdio'; command; args?; env?; timeout?; alwaysLoad? }` (`sdk.d.ts:1339-1353`), `McpHttpServerConfig = { type: 'http'; url; headers?; tools?; timeout?; alwaysLoad? }` (1182-1196), `McpSSEServerConfig` (1322-1336). Ids validated by `CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/` (line 151) and `RESERVED_CONNECTOR_IDS = ['activity','notification','mini-apps','workspace','knowledge','apis','chats']` (157-172); http on non-loopback refused (224-229). Catalog (92-144): hex, sentry, notion, linear, github — all `transport:'http'`, `auth:'oauth'` (the CLI's built-in MCP OAuth does the sign-in; §3d).
- Hosted push (`shared/hostedMcp.ts:74-83`): `HostedMcpPushPayload = { hosted: Record<string, HostedServerPush> }`, `HostedServerPush = { label?: string; tools: HostedToolDescriptor[] }`, `HostedToolDescriptor = { name: string; description?: string; inputSchema?: unknown }`. `jsonSchemaToZod(inputSchema)` (`jsonSchemaToZod.ts:164-177`) returns a raw shape; degrades to `{}` / `z.unknown()`; refuses `$ref`/`anyOf`/`oneOf` (line 72-74); `MAX_DEPTH = 10` (40); `.optional()` before `.describe()` is load-bearing in zod 4.3.6 (comment 13-18).

### 1d. The full `allowedTools` list (`shared/agentAllowedTools.ts:43-80`, verbatim order)

`'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'mcp__activity__query_activity', 'mcp__knowledge__record_finding', 'mcp__apis__list_apis', 'mcp__mini-apps__open_mini_application', 'mcp__mini-apps__build_and_open_mini_application', 'mcp__mini-apps__list_published_servers', 'mcp__mini-apps__call_published_tool', 'mcp__notification__show_notification', 'mcp__workspace__get_scanned_files', 'mcp__workspace__get_research_profile', 'mcp__chats__list_chats', 'mcp__chats__read_chat'` + one `mcp__<id>` per enabled connector (`connectors.ts:298-300`) + one `mcp__<id>` per ready hosted server (`AgentInfrastructureController.ts:505`). `buildAgentAllowedTools` throws if `mcp__knowledge__record_finding` is missing (`assertKnowledgeToolAllowed`, lines 109-117; also asserted at agent-server boot `index.ts:884`), because `filterMcpServers` would silently drop the `knowledge` relay. Bare `Skill` is deliberately absent (lines 18-25: the SDK adds `Skill(<id>)` itself). `DesignSync` is NOT listed (CLAUDE.md status entry; writes may be refused). Connector/hosted mutations at runtime go through `replaceConnectorAllowedTools(allowedTools, priorIds, nextIds)` (`connectors.ts:324-338`) on both the agent server and the host's restart config.

Semantics note (code comments, `agentAllowedTools.ts:12-16`, `connectors.ts:291-296`): this is auto-approve, not restriction; the SDK's restriction option `tools` is never set on the chat path, and with no `canUseTool` an unlisted tool still runs.

### 1e. Relay tool schemas (what the model sees) — `agent-server/index.ts:230-394`

- `activity.query_activity { period?: enum('today','last_2h','last_24h','this_week'), since?, until?, search?, source? }` (237-247)
- `notification.show_notification { title, body, navigation?: { type: enum('thread','sidebar'), threadId?, sidebarTab?: enum(SIDEBAR_TAB_IDS) } }` (254-266); `SIDEBAR_TAB_IDS = ['home','chats','tools','knowledge','servers','files','activity','debug','settings']` (`shared/types.ts:190-192`)
- `mini-apps.open_mini_application { dir_name }`, `build_and_open_mini_application { dir_name }`, `list_published_servers {}`, `call_published_tool { server_name, tool_name, arguments?: record }` (273-296)
- `knowledge.record_finding { skill, title, rule, evidence, cost_if_unknown?, scope?: string[], supersedes?: string[], confirms?: string[], blast_radius?: string[] }` (310-324)
- `workspace.get_scanned_files { file_type?: enum('manuscript','grant','presentation','reference') }`, `get_research_profile {}` (331-343)
- `apis.list_apis {}` (355-359)
- `chats.list_chats { query?, limit?: int }`, `read_chat { chat, detail?: enum('conversation','full'), from_message_id?: int, max_chars?: int, include_tool_results?: boolean }` (372-390)

Host handlers for all of these: `AgentInfrastructureController.ts:127-381` (`registerHostMcpServers`), keyed `handlers[serverName][toolName](args) → {content:[{type:'text',text}], isError?}`.

---

## 2. Agent-server HTTP + SSE protocol

### 2a. Routes (`agent-server/index.ts:858-873 parseRoute`, handlers 888-1212). All JSON; `sendJSON` sets `Content-Type: application/json`.

| Route | Request body | Response | Lines / behaviour |
|---|---|---|---|
| `GET /health` | — | `200 { status: 'ok', sessions: <number>, instance: process.env.COSCIENTIST_AGENT_INSTANCE ?? null, workspace: <root> }` | 892-904. Host adopts a server only if `body.instance === this.instanceToken` (`containerService.ts:625-661`). |
| `POST /credentials` | `{ anthropicApiKey?: string, anthropicBaseURL?: string \| null }` (`CredentialsPush`, `sessionConfig.ts:117-120`) | `200 { ok: true }` | 906-922. Updates `currentConfig` AND patches every live session's `sessionConfig` in place (`applyCredentialsToSessions`, `sessionConfig.ts:149-167`); `'anthropicBaseURL' in body` presence semantics; host sends `{ anthropicApiKey: apiKey, anthropicBaseURL: baseURL ?? null }` (`containerService.ts:671`). |
| `POST /connectors` | `{ mcpServers: Record<id, McpServerConfig-shaped> }` | `200 { ok: true, applied: Array<{ sessionId, added: string[], removed: string[], errors: Record<string,string> }> }` | 927-971. Replaces `currentConfig.mcpServers`; recomputes `allowedTools` via `replaceConnectorAllowedTools`; per live session `applyDynamicMcpToSession(state, { connectors })`. Host timeout 15 s (`containerService.ts:699-733`), then `rememberAgentConnectors`. |
| `POST /hosted` | `{ hosted: Record<id, HostedServerPush> }` (full replacement) | `200 { ok: true, applied }` | 988-1031. Rebuilds per-session relays (`buildHostedMcpServers`) and pushes `{ hosted: nextHosted }`. Host timeout 5 s (`containerService.ts:827-863`); debounced 200 ms from `mcpHost.onInventoryChanged` and re-pushed after a crash-restart (`AgentInfrastructureController.ts:49-117`). |
| `POST /skills` | `{ skills: string[] }` | `200 { ok: true, skills }` / `400 { error: 'skills must be an array of strings' }` | 1038-1051. Next session only (`skills` is a `query()` option). |
| `GET /connectors/status` | — | `200 { live: true, sessionId, servers: McpServerStatus[] }` from the first live session's `queryInstance.mcpServerStatus()`, else `{ live: false, servers: [] }` | 1056-1070. `McpServerStatus = { name, status: 'connected'\|'failed'\|'needs-auth'\|'pending'\|'disabled', serverInfo? … }` (`sdk.d.ts:1238-1252`). |
| `POST /sessions` | `{ sessionId?, resumeSessionId?, additionalAllowedTools?, soulMd?, hostGuidance?, workspaceDirectoriesGuidance?, permissionDeny?: string[], apiGuidance?, model?, effort? }` (`SessionOverrides`, `sessionConfig.ts:74-85`) | `201 { sessionId }` | 1072-1089. Calls `createSession(sessionId, currentConfig, resumeSessionId, overrides)` which starts `query()` immediately (712-749) — the query is alive before any message. |
| `POST /sessions/:id/messages` | `{ text: string, attachments?: UserMessagePayload['attachments'], messageId?: string }` where attachments items are `{ type: string; data?: string; mediaType?: string; filePath?: string; name?: string; title?: string }` (`index.ts:145-155`) | `200 { ok: true }`; `404 { error: 'Session not found' }` after eviction | 1099-1109. Pushes onto the message queue consumed by the generator; `messageId` only logged. |
| `GET /sessions/:id/events` | header `Last-Event-Id?: <n>` | `text/event-stream`; first write `:ok\n\n`; replays buffered events with id > cursor | 1112-1145. Ring buffer 500 events (`SSE_RING_BUFFER_SIZE`, 756). A replayed `done`/`error` ends the response. |
| `POST /sessions/:id/mcp-result` | `{ callId: string, result?: unknown, error?: string }` | `200 { ok: true }` | 1148-1162. Resolves/rejects `pendingMcpCalls.get(callId)`; unknown callId is a silent no-op (idempotent retries). |
| `POST /sessions/:id/interrupt` | `{}` | `200 { ok: true }` / `409 { error: 'No active query' }` / `500 { error }` | 1168-1181. `await q.interrupt()` only; session stays. |
| `POST /sessions/:id/stop` | `{}` | `200 { ok: true }` | 1184-1203. `stopped=true`, clear idle timer, `queryInstance.close()`, `messageQueue.done()`, reject all pending MCP calls with `'Session stopped'`, `sessions.delete`. |
| anything else | — | `404 { error: 'Not found' }`; handler exceptions → `500 { error }` | 1206-1211 |

Process: `server.listen(port, '127.0.0.1')` with `port = COSCIENTIST_AGENT_PORT ?? currentConfig.port` (1214-1219; boot config `port: 8080` is the unused fallback). `SIGTERM` → close every query, reject pending calls, `process.exit(0)` (1221-1234).

### 2b. SSE events (`broadcastSSE` 802-834; wire format `formatSSEEvent` 836-838: `` `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n` ``)

| event | data | emitted at |
|---|---|---|
| `message` | the raw `SDKMessage` object, every one the `for await (const message of queryInstance)` loop yields | 693-694 |
| `mcp-call` | `{ callId: string (randomUUID), serverName: string, toolName: string, args: Record<string, unknown> }` | 209-214 inside the relay handler |
| `done` | `{}` | 707 (loop ended normally), 740 (error after `stopped`) |
| `error` | `{ error: string }` | 743 |

`done`/`error` end every attached client response and clear the client set (826-833). Every broadcast also `bumpActivity` (810).

### 2c. The MCP relay round trip

1. Model calls an `mcp__<server>__<tool>`; the SDK invokes the in-process `tool()` handler created by `createMcpRelayHandler(state, serverName, toolName)` (`index.ts:187-224`).
2. Handler mints `callId = randomUUID()`, registers `{resolve, reject}` in `state.pendingMcpCalls` with a **120 s timeout** (`'MCP call ${serverName}/${toolName} timed out after 120s'`, 197-200), broadcasts `mcp-call`.
3. Host SSE reader (`agentSession.ts:1558-1574`) parses `{ callId, serverName, toolName, args }`, calls `handleMcpRelay(serverName, toolName, args)` (`agentSession.ts:323-399`), dispatch order: (i) `(globalThis as any).__hostMcpServers[serverName][toolName](args)` (built-in relays; errors → `MCP call failed: <msg>`, isError); (ii) `miniAppMcpRegistry.hasServer(serverName)` → `invoke(serverName, toolName, args)` (mini-app published tools over postMessage, `main/miniAppMcpRegistry.ts`, 60 s invocation timeout per CLAUDE.md); (iii) hosted: `mcpHost.isHosted(id) || (await mcpHost.list()).some(...)` → `mcpHost.isToolEnabled(id, tool)` gate (refusal text `hostedToolRefusalMessage`, 299-302) → `mcpHost.invoke(id, tool, args)` → `hostedResultToRelayResult` (non-text blocks become `[<kind> content omitted — this relay only carries text]`, 304-321); (iv) else `{ content:[{type:'text', text:'Unknown MCP server: <name>'}], isError:true }`.
4. Host POSTs `{ callId, result }` or `{ callId, error }` to `/sessions/:id/mcp-result` with retries `[250, 500, 1000]` ms (`postMcpResultWithRetry`, 1251-1279); fire-and-forget.
5. Handler resolves and returns `result` to the SDK as the tool's `CallToolResult`; on rejection returns `{ content:[{type:'text', text:'MCP relay error: <msg>'}], isError:true }` (219-222).

Tool schemas: built-in relays are hand-written zod shapes (`index.ts:230-394`); hosted relays come from `HostedServerPush.tools[].inputSchema` via `jsonSchemaToZod`; mini-app published tools are NOT registered with the CLI as MCP servers at all — they are reached through the two generic relay tools `mcp__mini-apps__list_published_servers` / `call_published_tool`.

Idle-eviction interplay: an in-flight relay call (`pendingMcpCalls.size > 0`) defers eviction with `BUSY_RECHECK_MS = 30 s` rechecks (779-786).

### 2d. Host consumption of `message` events and persistence (`agentSession.ts:1383-1557`, `processQueryMessage` 1626-1776)

Converted to `ChatStreamMessage` (`shared/types.ts:2-48`, verbatim union):

```ts
export type ChatStreamMessage =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; argsText: string; }
  | { type: 'tool-result'; toolCallId: string; result: unknown; isError?: boolean; }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; toolCallId: string; toolName: string }
  | { type: 'tool-call-args-delta'; toolCallId: string; argsText: string }
  | { type: 'tool-call-end'; toolCallId: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-end' }
  | { type: 'tool-progress'; toolCallId: string; toolName: string; elapsedSeconds: number }
  | { type: 'subagent-started'; taskId: string; parentToolCallId: string; description: string }
  | { type: 'subagent-progress'; taskId: string; parentToolCallId: string; summary?: string; lastToolName?: string; toolUseCount: number; durationMs: number }
  | { type: 'subagent-done'; taskId: string; parentToolCallId: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  | { type: 'heartbeat' }
  | { type: 'status'; status: string }
  | { type: 'turn-complete'; messageId?: string; costUsd?: number }
  | { type: 'user-message'; text: string; messageId?: string };
```

Mapping from SDK messages:
- `stream_event` (`message.event` = raw Anthropic streaming event): `content_block_start` with `content_block.type === 'tool_use'` → `tool-call-start {id, name}`; `'thinking'` → marks thinking; `content_block_delta` `text_delta` → `text-delta`; `input_json_delta` → `tool-call-args-delta` (`partial_json`); `thinking_delta` → `thinking-delta`; `content_block_stop` → `thinking-end` or `tool-call-end` (1631-1669).
- `tool_progress` → `tool-progress { tool_use_id, tool_name, elapsed_time_seconds }` (1671-1678; SDK type `sdk.d.ts:6206-6220`).
- `system` subtypes `task_started` / `task_progress` / `task_notification` (when `tool_use_id` set) → `subagent-started/progress/done` (1680-1708; SDK `sdk.d.ts:6057-6136`, `task_notification.status: 'completed'|'failed'|'stopped'`).
- `assistant` (`message.content` blocks) → `text` per text block, `tool-call` per `tool_use` (`args: block.input`, `argsText: JSON.stringify(input, null, 2)`); Bash calls remembered in `pendingBashCalls` for command logging (1710-1738); row `insertMessage(sessionId, 'assistant', JSON.stringify(content), messageId)` (1427) + knowledge signals (tool names, `Read.file_path`) (1294-1317).
- `user` with `tool_result` blocks → `tool-result { tool_use_id, content, is_error }`; row `'tool_result'` (1430-1438, 1740-1775); Bash results feed `commandLogger` and scaffold detection (`extractScaffoldedDirName`).
- `system` (any subtype) → `setSdkSessionId(sessionId, message.session_id)` (1403); `init` → `setSessionModelInfo({ model: message.model })` write-once (1407-1410) and `recordConnectorStatus(message.mcp_servers.map(s => ({ name, status, error, toolCount: s.tools?.length, scope })))` (1415-1424). SDK init fields (`sdk.d.ts:5973-6005`): `session_id`, `model`, `mcp_servers: {name, status, source?}[]`, `tools`, `skills`, `claude_code_version`, `apiKeySource`, `permissionMode`, `effort?` …
- `result` → unless `isSwallowedResumeTurn` (§3e) → overflow check (§3f) → row `'result'` `{ subtype, result (success only), is_error, run_id: agentSessionId, total_cost_usd?, duration_api_ms?, modelUsage?, stopped_by? }` (1489-1504) → `noteTurn` omission watch → `turnInProgress=false` → `turn-complete { messageId, costUsd }` where `costUsd` is the delta of cumulative `total_cost_usd` across the chat's result rows (`shared/turnCost.ts:53-68`) → `onTurnEnded` for a pending Stop.

Renderer delivery: `sender.send('chat:event', threadId, msg)`, `'chat:done'`, `'chat:error'` (`main/index.ts:614-642`); inbound IPC `chat:send` (2227), `chat:subscribe` (2372), `chat:isTurnInProgress` (2379), `chat:turnStatus` (2390), `chat:unsubscribe` (2400), `chat:stop` (2407). Host heartbeat every 15 s (`agentSession.ts:523-528`), `status` events while waiting for the agent (`'Starting Acabox…'`, `'Almost ready…'`, 586-635; host polls `http://localhost:${port}/health` — note `localhost`, not the loopback literal, at 611/616).

---

## 3. Session lifecycle

### 3a. One `query()` per agent-server session; the host destroys sessions aggressively
- `createSession` starts `query()` at once (`index.ts:710-749`); `state.running` stays true while the streaming-input loop idles between turns (comment 764-768). `broadcastSSE('done')` fires only after the `for await` ends (close/eviction/crash) — never between turns.
- Host `sessionRegistry.ts`: `'ui'` sessions are destroyed when the last subscriber detaches and no turn is in progress, else `pendingDestroy` fires on `turn-complete` (`removeSubscriber` 252-288, listener 149-173). `destroy()` (`agentSession.ts:1096-1131`) writes a host-authored `stopped` row if a turn is open, severs SSE, `POST /stop`. Comment `sessionRegistry.ts:389-390`: "one turn = one query = one CLI subprocess in practice" (the renderer detaches at turn end — **INFERRED from comments**, renderer not read here).
- Chat creation: `main/index.ts:2332-2358` `createAgentSession(threadId, callbacks, workspace, sdk_session_id, source, onNotificationClick, model, preprocessor, documentPath, refreshAndPushCredentials, effort)`; model/effort pinned per chat on first turn (`setSessionModelInfo`, write-once SQL `WHERE model IS NULL`, `chatRepository.ts:81-92`). Scheduled tasks create `'background'` sessions (`scheduledTasks/runner.ts:25-55`); the calendar assistant is a separate raw-API agent (§5h).

### 3b. Resume
`resumeSessionId` = `sessions.sdk_session_id` (set from every `system` message's `session_id`, cleared by `clearSdkSessionId` on overflow). Agent server checks `<CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl` exists before passing `resume` (`index.ts:712-736`). Transcript facts (`transcriptStore.ts:15-20`): one chat = one transcript (resume appends, same id); unreferenced transcripts are unreachable → swept at boot `sweepOrphanTranscripts(listSdkSessionIds())` (`main/index.ts:1003`) and on `sessions:delete` `deleteTranscript(sdkSessionId)` read before the row is dropped (`main/index.ts:1873-1884`); debug hard reset sweeps with `[]` (`ipc/debug.ts:112`).

### 3c. Idle eviction (agent server)
`IDLE_EVICTION_MS = 10 * 60 * 1000` (`index.ts:126`) with boot assertion `IDLE_EVICTION_MS > OAUTH_FLOW_WINDOW_MS` (127-133); `BUMP_THROTTLE_MS = 30 s`, `BUSY_RECHECK_MS = 30 s`. Eviction: `stopped=true`, `queryInstance.close()`, `messageQueue.done()`, `sessions.delete` (787-798) → SSE `done` → host `emitDone`; next `sendMessage` restarts the loop with resume (`agentSession.ts:941-959`, `1089-1093`); a `404` on message POST re-queues and restarts (1076-1088).

### 3d. OAuth pin window (host)
`OAUTH_FLOW_WINDOW_MS = 300_000` matched to the CLI's own `setTimeout(…,300000)` auth ceiling (`shared/oauthWindow.ts:27-39`); triggers `MCP_AUTHENTICATE_TOOL = /^mcp__[a-z0-9-]+__authenticate$/`, early unpin on `MCP_COMPLETE_AUTH_TOOL = /^mcp__[a-z0-9-]+__complete_authentication$/` (50, 57). `pinSession/unpinSession` (`sessionRegistry.ts:311-361`); a pin defers, never cancels, eviction. The PKCE verifier + loopback callback listener live only in the CLI subprocess memory; tokens land in the macOS keychain / `<CLAUDE_CONFIG_DIR>/.credentials.json` (CLAUDE.md, corrected 2026-07-29). This whole feature rides on the CLI's built-in remote-MCP OAuth.

### 3e. Swallowed-resume-turn ladder (CLI quirk handled by the host)
`isSwallowedResumeTurn` (`agentSession.ts:197-206`): `result.subtype==='success' && !is_error && result.trim()===''` AND zero `assistant` messages AND zero `stream_event`s AND ≥1 `system/task_notification` with `status:'stopped'` this turn → not the end of the turn. Ladder `wait (15 s watchdog) → redeliver once → surface SWALLOWED_TURN_MESSAGE` (238-262, 730-799). Cause: orphaned `run_in_background` Bash from the previous turn; the CLI replays a `<\task-notification>` as a turn on resume (comment 171-195). Agent is told in `CLAUDE.md:91-101` never to start background commands.

### 3f. Context overflow
`isContextOverflowResult` (`agentSession.ts:52-57`): `type==='result' && is_error && /prompt is too long|context (window|length) exceeded|too many (input )?tokens/i.test(result)` → `clearSdkSessionId`, `resumeDisabled=true`, inserts `CONTEXT_OVERFLOW_MESSAGE` before the result row (1474-1488).

### 3g. Stop vs interrupt
`chat:stop` → `stopSession(id,'user')` → `session.stop()` → `runStop` (`agentSession.ts:139-160`): `POST /interrupt` → wait `INTERRUPT_WAIT_MS = 4_000` for the CLI's own result (tagged `stopped_by`) → `destroy()` → `POST /stop`. The CLI answers an interrupt with an error-ish result (`terminal_reason: 'aborted_tools'`, CLAUDE.md); `TerminalReason` union at `sdk.d.ts:9790`.

### 3h. Crash-restart config replay + health instance token (host, `containerService.ts`)
- Spawn (`469-608`): port `findFreePort(23200, 23299)` (475), re-pick if no longer bindable (488-492), `migrateClaudeConfigDir(agentDir)` + mkdir config dir (497-498), write `<userData>/agent.json` mode `0o600` (505-507), delete legacy `<workspace>/.academia/agent.json` (508), bundle copied to `<workspace>/.academia/agent-server.js` (`ensureAgentFilesInWorkspace` 456-467) and spawned as `spawn(process.execPath, ['--max-old-space-size=1536', bundlePath], { env, stdio: ['ignore','pipe','pipe'], windowsHide: true })` (533-540); stdin ended; health poll up to 15 s at 500 ms (593-607).
- Unexpected exit (not `code === 0 || signal === 'SIGTERM'`) → restart with `lastAgentServerConfig` throttled `MAX_RESTARTS_IN_WINDOW = 3` per `RESTART_WINDOW_MS = 60_000`, then `agentGaveUp = true` (555-591); `notifyAgentServerRestarted` after the new process is healthy → hosted inventory re-push.
- `lastAgentServerConfig` is kept current by `rememberAgentConnectors/Skills/Hosted` after each successful push (879-931), recomputing `mcp__<id>` entries with the same `replaceConnectorAllowedTools` the agent server uses.
- Health adoption requires `/health.instance === this.instanceToken` (`randomUUID()` per app run, 166; 625-661).

### 3i. Boot ordering (host)
`AgentInfrastructureController.start()` (`387-537`): `refreshCredentials` → `provisionWorkspace` (skills store reconcile + `.claude/` files) → `ensureAgentFilesInWorkspace` → `apiProxy.start()` (**must precede the spawn**, comment 411-421) → `mcpHost.startAll()` (not awaited) → `registerHostMcpServers` → build `agentConfig` → `startAgentServer(JSON.stringify(agentConfig))` → `updateAgentSkills` → `updateAgentHosted` → background `ensurePythonVenv`. Called from `container:start` (`main/index.ts:1391-1399`) and `container:ensureSetup` (1636-1647), both renderer-triggered.

### 3j. The `agent.json` shape (boot config, `AgentInfrastructureController.ts:487-512`; interface `AgentConfig`, `sessionConfig.ts:3-72`)
```ts
{ port: 8080, mcpServers: connectorServers, hostedServers: hostedInventory, anthropicApiKey: agentApiKey ?? '',
  ...(agentBaseURL ? { anthropicBaseURL: agentBaseURL } : {}), model: DEFAULT_MODEL, effort: 'high',
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  allowedTools: buildAgentAllowedTools([...connectorTools, ...hostedIds.map((id) => `mcp__${id}`)]),
  skills, settingSources: ['project'] }
```
Read by the agent server from `COSCIENTIST_AGENT_CONFIG` (`index.ts:161-165`; fallback `/data/.academia/agent.json`). Holds the raw key and decrypted connector headers (comment `containerService.ts:41-48`), hence userData + 0600 + the `block-secret-reads.sh` pattern `agent\.json`.

---

## 4. Env the agent subprocess (and its Bash tool) inherits, and why

`buildSubprocessEnv(caller)` (`containerService.ts:104-140`), verbatim core:
```ts
return {
  ...process.env,
  COSCIENTIST_VENV_DIR: venvDir,
  COSCIENTIST_NPM_PREFIX: npmPrefix,
  NODE_PATH: getNpmNodeModulesPath(),
  PATH: [venvBinDir, npmBinDir, existingPath].filter(Boolean).join(binSep),
  ...(apiProxy.isRunning() ? { [API_BASE_ENV]: apiProxy.baseUrl()!, [API_TOKEN_ENV]: apiProxy.tokenFor(caller)! } : {}),
};
```
- `COSCIENTIST_VENV_DIR` / `COSCIENTIST_NPM_PREFIX`: read by the install wrapper (`skills/manage-mini-application/assets/install:45-46`) so `.applications/install pip|npm` targets Acabox's own venv (`<userData>/python-venv`) and npm prefix (`<userData>/npm-site`).
- `NODE_PATH`: so esbuild bundles of mini-apps resolve `npm -g --prefix` installs (comment 95-96).
- `PATH`: venv `bin/` + npm `bin/` + the resolved login-shell PATH (`getLoginShellPath`, so Finder launches find Homebrew/nvm node).
- `API_BASE_ENV = 'ACABOX_API_BASE'`, `API_TOKEN_ENV = 'ACABOX_API_TOKEN'` (`shared/apis.ts:129-130`), header `API_PROXY_TOKEN_HEADER = 'x-acabox-api-token'` (126). The token is per caller (`apiProxy.tokenFor`, `apiProxy.ts:496-505`); the chat agent's token reaches every enabled API, a mini-app's `hostAPI.exec()` child gets a tool-scoped token (comment 120-134). Absent when the proxy is down; `buildApiGuidance` is skipped in the same condition.

Agent-server-specific additions (`containerService.ts:514-531`): `ELECTRON_RUN_AS_NODE: '1'`, `COSCIENTIST_AGENT_PORT`, `COSCIENTIST_AGENT_CONFIG` (abs path of agent.json), `COSCIENTIST_WORKSPACE`, `COSCIENTIST_AGENT_INSTANCE`, `COSCIENTIST_CLAUDE_CONFIG_DIR`. The agent server then adds to the CLI subprocess env (`index.ts:644-650`): `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL?`, `MINI_APP_WORKSPACE_DIR` (read by `manage_mini_app.mjs:18`), `CLAUDE_CONFIG_DIR`. **INFERRED:** the Bash tool's children inherit the CLI process env, so `ANTHROPIC_API_KEY` and `ELECTRON_RUN_AS_NODE=1` are visible to agent shell commands (the CLI's scrubbing behaviour was not verified here). The same `buildSubprocessEnv()` feeds the kernel gateway (`containerService.ts:1031`, port `findFreePort(23400, 23499)` at 1015), `exec/execStreaming/execLogged` (341-441), and esbuild.

---

## 5. Claude-specific artefacts (each is a thing PI will not have, or will have differently)

**a. API-key approval in `.claude.json`** — `shared/claudeConfigApproval.ts:19-48 ensureApiKeyApproved(configDir, apiKey)`: writes `customApiKeyResponses.approved` += `apiKey.slice(-20)` (and strips it from `rejected`) into `<configDir>/.claude.json`, because headless Claude Code refuses an unapproved env key with "Not logged in · Please run /login". Called before every chat `query()` (`index.ts:620`) and every scanner query (`shared.ts:193`).

**b. `CLAUDE_CONFIG_DIR` layout and relocation** — chat: `<userData>/claude-config` (`main/claudeConfigDir.ts:24-29`, migrated from `<workspace>/.academia/claude-config`, 45-69); scanner: `<userData>/scanner-claude-config` (`shared.ts:190, 208`). Contents (`claudeConfigDir.ts:4-8`): `.claude.json` (approval list; the comment also says `mcpOAuth` but CLAUDE.md 2026-07-29 corrects this — tokens go to the keychain / `.credentials.json`), `projects/<key>/<sdkSessionId>.jsonl` transcripts (key derived from `cwd`). Exported to the agent server as `COSCIENTIST_CLAUDE_CONFIG_DIR` and set both at process level and in `query().env`.

**c. Workspace `.claude/` provisioning (`main/skills.ts:210-236 provisionedFiles`)** — `CLAUDE.md` → `<workspace>/.claude/CLAUDE.md` (policy `keep-local`); `settings.json` → `<workspace>/.claude/settings.json` (policy `restore`); every `hooks/*.sh` → `<workspace>/.claude/hooks/<name>` (`restore`, mode `0o755`). Baseline hashes in `<userData>/workspace-provisioning.json`; divergent restored copies backed up under `<userData>/workspace-file-backups/<stamp>/`. Shipped `settings.json` (verbatim): `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash .claude/hooks/block-host-installs.sh"},{"type":"command","command":"bash .claude/hooks/block-secret-reads.sh"}]},{"matcher":"Read|Edit|Write","hooks":[{"type":"command","command":"bash .claude/hooks/block-secret-reads.sh"}]}]}}`. Hooks read the CLI's PreToolUse stdin JSON (`tool_input.command`, `tool_input.file_path`) via `plutil -extract tool_input.<key> raw` with jq fallback, fail closed with exit 2 (`block-host-installs.sh:33-57`, `block-secret-reads.sh:38-71`); patterns: pip/pipx/python -m pip/npm|pnpm|yarn install|i|add/apt(-get) install/conda|mamba install|create/install.packages( (`block-host-installs.sh:73-81`); secret patterns `cobuilding-settings\.json`, `claude-config`, `\.claude\.json`, `agent\.json` (`block-secret-reads.sh:76-84`). Skills render as symlinks `<workspace>/.claude/skills/<id>` → `<userData>/skills/<id>` (`shared/skills.ts:63-71`); the CLI keys skill identity on the dirent name (`skills.ts:19-25`).

**d. Workspace `CLAUDE.md` content** (`src/cobuilding/CLAUDE.md`, 7,478 bytes, 103 lines) — sections: File Access (relative paths, never `cd`), Installing packages (`.applications/install`, hook-blocked direct installs, `input/`/`output/` symlinks into `tool-data/`), Calling APIs (`$ACABOX_API_BASE`, `$ACABOX_API_TOKEN`, `mcp__apis__list_apis`, 405/403 semantics, `window.hostAPI.api.fetch`), Running skill scripts, Opening mini-applications (`mcp__mini-apps__open_mini_application`, `build_and_open_mini_application`), Workspace Files and Research Profile (`mcp__workspace__get_scanned_files`, `get_research_profile`), Background commands (die with the turn), Progress Tracking (`TodoWrite`). It names Claude Code tool/`mcp__` ids directly.

**e. DesignSync / `claude design-login`** — `shared/claudeDesign.ts:1-36` and `main/claudeDesignLogin.ts`: spawns the SDK's platform binary with `['design-login', '--json', ...]`, `CLAUDE_CONFIG_DIR = getClaudeConfigDir()`, stripping `DESIGN_LOGIN_ENV_STRIP` (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, …); parses `{"available","signed_in","can_sign_in_here"}` and `{"event":"pages"|"done"}` lines; IPC `claudeDesign:getStatus` / `claudeDesign:signIn` (…). Entirely CLI-specific; no auto-approve entry for `DesignSync`.

**f. Model roster + discovery + CLI gate** — `shared/models.ts`: `CURATED_MODELS` (fable-5-1, opus-5-5, opus-5, opus-4-8, sonnet-5-5, haiku-5-5), `SUPERSEDED_MODELS`, `UNSUPPORTED_MODEL_IDS` (empty; records the CLI-version gate "Claude Code 2.1.273 does not support this model; version 2.1.280 or newer is required", 121-134), `DEFAULT_MODEL = 'claude-opus-5-5'`, `BACKGROUND_MODEL = 'claude-haiku-5-5'`, `BACKGROUND_REQUEST = { model, thinking: { type: 'disabled' }, output_config: { effort: 'low' } }` (194-198), `messageText()` (208-213), `mergeModels` (238-269), `allowedModelIds` (279-281). `main/modelCatalog.ts`: `GET /v1/models` with `anthropic-version: 2023-06-01`, cached 6 h, main-only. `shared/apiKeyCheck.ts`: verdict from `GET /v1/models?limit=1` (401/403 → rejected). `auth:setApiKey` (`main/index.ts:2753-2792`): `setCustomAnthropicKey` (safeStorage), `setCredentials`, `refreshAndPushCredentials({force:true})` → `POST /credentials`, `refreshModels(force)`, `checkAnthropicKey`. Key resolution order env `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` → settings (`resolveApiKey`, 310-316).

**g. Direct `@anthropic-ai/sdk` (Messages API) call sites, all `new Anthropic({ apiKey, baseURL })`** — title generation (`main/index.ts:2196-2225`, `...BACKGROUND_REQUEST, max_tokens: 40`), mini-app manifest metadata (`AgentInfrastructureController.ts:590-648`, `max_tokens: 400`), scanner classifiers (`fileTagging.ts:116, 475, 526, 548`), mini-app bridge proxy `anthropic:complete` / `anthropic:stream` (`main/index.ts:2646-2727`; `validateAnthropicParams` clamps `model` to `anthropicAllowedModels()` else `BACKGROUND_MODEL` with `thinking: {type:'disabled'}`, `max_tokens` ≤ limit, string `system`; stream relays `'chunk'|'done'|'error'` over `anthropic:stream:event` keyed by a renderer-minted UUID `streamKey`), calendar assistant (`calendarAgentSession.ts:610-700`: `client.messages.stream({ model: 'claude-sonnet-4-6', max_tokens: 8192, system, tools: CALENDAR_TOOLS, messages })` hand-rolled tool loop implementing the same `AgentSession` interface and `ChatStreamMessage` events; 401/403 → `refreshCredentials` once).

**h. Identity text** — `IDENTITY_PREAMBLE` says "built on Claude by Anthropic" (`identityPreamble.ts:8`); `NSSpeechRecognitionUsageDescription` mentions Anthropic (`forge.config.js:152`); `NO_API_KEY_MESSAGE = 'No Anthropic API key configured. Add one in Settings.'` (`main/index.ts:488`).

**i. Packaging** — `forge.config.js:34 nativeModuleRoots = ['better-sqlite3', '@anthropic-ai/claude-agent-sdk']`; asar `unpack: '{**/node_modules/better-sqlite3/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk/**/*,**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*}'` (112); `extraResource: ['dist/agent-server.js', …, 'src/cobuilding/skills', 'src/cobuilding/hooks', …]` (114-141). `getCobuildingSourceDir()` = `process.resourcesPath` when packaged (`skillStore.ts:91-94`). Scripts: `build:agent-server` = webpack; `prestart` builds it (`package.json:9-11`).

**j. Tool-name convention `mcp__<server>__<tool>`** is load-bearing in: `filterMcpServers` (`sessionConfig.ts:87-96`), `connectorAllowedTools` (`mcp__<id>`), `RESERVED_CONNECTOR_IDS`, the OAuth pin regexes, the omission watch (`noteTurn` classifies connector tools by prefix, `omissionWatch.ts:254-262`), the hook matcher for the scanner, `CLAUDE.md` instructions to the model, and the skill/SKILL.md docs (`database-lookup` tells the agent to call `WebFetch`).

**k. Bundled-SDK skills** — `BUNDLED_SDK_SKILLS` (`shared/skills.ts:127-…`: batch, claude-api, claude-in-chrome, debug, dream, fewer-permission-prompts, keybindings-help, loop, …) are reserved ids; only `claude-api` is allowed onto the roster (`BUNDLED_ALLOW`, 154).

**l. Transcript-derived features** — per-turn cost from cumulative `total_cost_usd` (`shared/turnCost.ts`); `modelUsage`/`duration_api_ms` stored on result rows; `read_chat`/`list_chats` read Acabox's own SQLite rows (not the SDK transcript).

---

## 6. SDK capabilities Acabox depends on (numbered, with where used)

1. **Streaming-input `query()`** (`prompt: AsyncIterable<SDKUserMessage>`), multi-turn over one subprocess, ended by `messageQueue.done()` — `agent-server/index.ts:524-529, 624-626`.
2. **Rich user content blocks** (text, base64 image, base64 PDF document, text document, synthetic file-reference text) — `index.ts:531-552`; attachment adapters in renderer (not read).
3. **`resume` by SDK session id** + persisted JSONL transcripts under `CLAUDE_CONFIG_DIR/projects/<key>/` (`persistSession` default true) — `index.ts:641, 712-736`; `transcriptStore.ts`; `chatRepository.setSdkSessionId/clearSdkSessionId`.
4. **`model` per session + `thinking: adaptive` + `effort` (low..max)** — `index.ts:635-639`; pins in `main/index.ts:2296-2303`; UI `ModelSelector.tsx:41-46`.
5. **`systemPrompt` preset `claude_code` with `append`** (the harness's own system prompt plus Acabox's five appended blocks) — `index.ts:510-522, 640`.
6. **`settingSources: ['project']` → workspace `.claude/CLAUDE.md` + `.claude/settings.json` (command hooks) + `.mcp.json`** — `AgentInfrastructureController.ts:507-511`; `main/skills.ts:210-236`; `connectorsStore.detectUnmanagedMcpJson`.
7. **`cwd` = workspace root with symlinked user folders; relative-path addressing** — `index.ts:643`; `containerService.ts:226-294`; `readOnlyRules.mountNames`.
8. **`env` injection into the subprocess (API key, base URL, config dir, custom vars) layered on `buildSubprocessEnv`** — `index.ts:644-650`; `containerService.ts:104-140, 514-531`.
9. **`allowedTools` auto-approve list** incl. `mcp__<server>__<tool>` entries and `mcp__<id>` server wildcards; no `canUseTool`, no `tools` restriction, default `permissionMode` — `shared/agentAllowedTools.ts`; `connectors.ts:298-338`.
10. **Built-in tools the product's prompts and features name**: `Bash` (incl. `run_in_background` semantics, exit codes, command logging), `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `Agent` (subagents), `WebSearch`, `WebFetch`, `TodoWrite`/`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`, `ToolSearch`, `EnterPlanMode`/`ExitPlanMode`, `Skill`, `DesignSync` — `agentAllowedTools.ts:43-80`; `readOnlyRules.ts:35`; `CLAUDE.md`; `agentSession.ts:1722-1771`.
11. **`skills` roster option + SDK-added `Skill(<id>)` approvals + `settings.skillListingBudgetFraction` + `.claude/skills/<dir>` discovery keyed on dirent name** — `index.ts:658, 673`; `shared/skills.ts:1-80, 571-611`; `skillRender.ts` (symlinks).
12. **Auto-memory** (`autoMemoryEnabled`, `autoMemoryDirectory`, `autoDreamEnabled:false`, `MEMORY.md` always in context) — `index.ts:659-667`; `shared/paths.ts:25-39`; scanner writes `about_you.md`/`working_on.md`.
13. **`settings.permissions.deny` rules in Claude Code rule syntax (`Edit(//abs/**)`) beating `allowedTools`** — `index.ts:674-678`; `shared/readOnlyRules.ts`; `agentSession.ts:658-667`.
14. **Command hooks (`PreToolUse`, matchers `Bash`, `Read|Edit|Write`) with stdin JSON and exit-2 deny** — `settings.json`; `hooks/*.sh`.
15. **In-process MCP servers via `createSdkMcpServer` + `tool(name, desc, zodShape, handler)`** — relays `index.ts:230-394`, hosted `417-436`, scanner `documentReaderMcpServer.ts`.
16. **External MCP servers via `mcpServers` config (`http`/`sse`/`stdio`, headers/env, `alwaysLoad`)** — `shared/connectors.ts:253-285`; boot `AgentInfrastructureController.ts:459-460`.
17. **`Query.setMcpServers()` (replace-whole-set semantics), `toggleMcpServer()`, `mcpServerStatus()`** — `dynamicMcp.ts:126-198`; `index.ts:1056-1070`; `connectorsStore.recordConnectorStatus`.
18. **CLI-managed remote-MCP OAuth** (`mcp__<id>__authenticate` / `complete_authentication`, 300 s flow, keychain credential store) — `shared/oauthWindow.ts`; `sessionRegistry.ts:136-173, 311-361`; `block-secret-reads.sh:110-115` tells the agent to use it.
19. **`Query.interrupt()`** producing the CLI's own terminating result — `index.ts:1168-1181`; `agentSession.ts:139-160, 1133-1174`.
20. **`Query.close()`** for stop / eviction / SIGTERM / auth abort — `index.ts:701, 794, 1191, 1226`.
21. **`includePartialMessages` → `stream_event` carrying raw Anthropic streaming events** (text/thinking/input_json deltas) — `index.ts:642`; `agentSession.ts:1631-1669`; also the swallowed-turn watchdog counts them (`noteSwallowSignals`).
22. **`assistant` / `user` messages shaped as Messages-API content blocks (`text`, `tool_use{id,name,input}`, `thinking`, `tool_result{tool_use_id,content,is_error}`)** — `agentSession.ts:1426-1438, 1710-1775`; rows stored verbatim (`insertMessage`), replayed by `historyMessageConverter` (renderer, not read).
23. **`result` message: `subtype success|…`, `result`, `is_error`, cumulative `total_cost_usd`, `duration_api_ms`, `modelUsage`, `terminal_reason`, `structured_output`** — `agentSession.ts:1439-1554`; `shared/turnCost.ts`; `directoryScanner/shared.ts:161-183`.
24. **`system`/`init`: `session_id`, resolved `model`, `mcp_servers[]` status** — `agentSession.ts:1402-1425` (model pin, connector status, resume pointer).
25. **`system` `task_started`/`task_progress`/`task_notification` and `tool_progress` events** (subagent + background-task lifecycle, elapsed time) — `agentSession.ts:1671-1708, 214-226`.
26. **`system`/`api_retry` with `error_status`** → auth abort/retry loop — `index.ts:696-704`; `agentSession.ts:37-41, 890-912`.
27. **Context-overflow signalling via `is_error` + API wording** — `agentSession.ts:52-57, 1474-1488`.
28. **`.claude.json` `customApiKeyResponses.approved` key approval** — `shared/claudeConfigApproval.ts`; `index.ts:620`; `shared.ts:193`.
29. **`CLAUDE_CONFIG_DIR` relocation (two separate dirs: chat and scanner)** — `claudeConfigDir.ts`; `shared.ts:190, 208`; `index.ts:178-181, 1285`.
30. **Bundled CLI binary auto-resolution (`pathToClaudeCodeExecutable` unset) + asar unpack of `@anthropic-ai/claude-agent-sdk-*`** — `index.ts:629`; `forge.config.js:112`; `claudeDesign.ts:84-95`.
31. **`stderr` callback** — `index.ts:630-634`; `shared.ts:218-222`.
32. **One-shot scanner queries: `tools` restriction, in-process `hooks` (`HookCallback` deny), `persistSession:false`, `thinking:disabled`, `effort:'low'`, `settingSources:[]`, `maxTurns`, `maxBudgetUsd`, `outputFormat json_schema` → `structured_output`, `abortController`** — `shared.ts:185-278`; `fileTagging.ts:36-49`; `researchProfile.ts:31-44`.
33. **Model ids and the "CLI version gates new models" rule; discovery via `GET /v1/models`; key check via `GET /v1/models?limit=1`** — `shared/models.ts`; `main/modelCatalog.ts`; `shared/apiKeyCheck.ts`; `main/index.ts:2753-2792`.
34. **Direct Messages-API clients for background calls and the mini-app bridge** (`messages.create/stream`, `thinking`, `output_config.effort`, `tools` with `input_schema`, streaming `text` events, `finalMessage()`) — `main/index.ts:2196-2225, 2646-2727`; `AgentInfrastructureController.ts:611-631`; `fileTagging.ts`; `calendarAgentSession.ts:610-700`.
35. **DesignSync tool + hidden `design-login --json` subcommand** — `shared/claudeDesign.ts`; `main/claudeDesignLogin.ts`.
36. **Identity/UX strings asserting "built on Claude"** — `identityPreamble.ts:8`; `main/index.ts:488`.
37. **`mcp__<server>__<tool>` naming convention across allowlists, reserved ids, prompts, classifiers** — `sessionConfig.ts:87-96`; `connectors.ts:146-172`; `omissionWatch.ts`; `CLAUDE.md`.
38. **Agent-server HTTP/SSE contract (host-owned, SDK-independent but must be preserved)**: `/health` instance token, `/credentials`, `/connectors`, `/hosted`, `/skills`, `/connectors/status`, `/sessions`, `/messages`, `/events` (ring buffer + `Last-Event-Id`), `/mcp-result`, `/interrupt`, `/stop`; SSE `message|mcp-call|done|error`; 120 s relay timeout; 10 min idle eviction — §2, §3.
39. **Host-side session policy (SDK-independent, but tuned to CLI behaviour)**: subscriber-count eviction, pending destroy, OAuth pin, swallowed-turn ladder, 15 s follow-up watchdog, 4 s interrupt wait, heartbeat 15 s, SSE reconnect backoffs `[250,500,1000,2000,5000]`, `waitForAgent` 5 min — `sessionRegistry.ts`; `agentSession.ts:586-635, 882-932`.
40. **PI env-var confirmation (for the planner)**: `packages/coding-agent/docs/environment-variables.md` lists `PI_CODING_AGENT_DIR` — "Override the config directory; default is `~/.pi/agent`" — and `PI_CODING_AGENT_SESSION_DIR` — "Override session storage; overridden by `--session-dir`". Also documents shell-tool env `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` and process markers `AI_AGENT=pi`, `PI_CODING_AGENT=true` (not set when embedded via the SDK).

---

## 7. Doc-vs-code disagreements noticed
- `agent-server/index.ts:1-21` header still says "runs inside the Podman container" and lists routes without `/credentials`, `/connectors`, `/hosted`, `/skills`, `/connectors/status`; code wins (§2a).
- `main/claudeConfigDir.ts:6-7` says `.claude.json` holds `mcpOAuth`; CLAUDE.md (2026-07-29 correction) and `block-secret-reads.sh` comments say tokens go to the keychain / `.credentials.json`. Treat `.claude.json` as approval-list only.
- `agentSession.ts:833-835` comment says sessions are persisted to `/data/.academia/sessions/`; code resumes from the SDK transcript in `CLAUDE_CONFIG_DIR/projects/` (`index.ts:712-736`).
- `agentSession.ts:611, 616` use `http://localhost:${port}` while `containerService.ts` deliberately uses the `127.0.0.1` literal (comment 630-631); works today, but inconsistent.
- `containerService.ts:1012-1014` comment claims container-era ports "agent 23300-23320, kernel 23330-23350"; code uses 23200-23299 (agent) and 23400-23499 (kernel).

## KEY FACTS
- The chat path calls query() exactly once per agent-server session in streaming-input mode, with an async generator as the prompt.
  - evidence: src/cobuilding/agent-server/index.ts:624-626 — `const queryInstance = query({ prompt: userMessageGenerator(messageQueue), options: {`; generator at 524-529 yields `{ type: 'user', message: { role: 'user', content } } as SDKUserMessage`
- Thinking is adaptive and effort is a per-session level; the boot default effort is 'high' and the default model is claude-opus-5-5.
  - evidence: agent-server/index.ts:636 `thinking: { type: 'adaptive' },` and :639 `...(sessionConfig.effort ? { effort: sessionConfig.effort as any } : {})`; AgentInfrastructureController.ts:493-496 `model: DEFAULT_MODEL, … effort: 'high',`; shared/models.ts:160 `export const DEFAULT_MODEL = 'claude-opus-5-5';`
- The system prompt is the claude_code preset with Acabox's blocks appended; CLAUDE.md is loaded separately via settingSources ['project'].
  - evidence: AgentInfrastructureController.ts:497 `systemPrompt: { type: 'preset', preset: 'claude_code' },` and :511 `settingSources: ['project'],`; agent-server/index.ts:518-519 `return { ...config.systemPrompt, append: appendParts } as unknown;`
- Settings passed to query(): auto-memory on, memory dir under the workspace, dream off, skill roster budget 5%, deny rules only when folders are locked.
  - evidence: agent-server/index.ts:659-679 `settings: { autoMemoryEnabled: true, autoMemoryDirectory: `${getWorkspaceRoot()}/${AGENT_MEMORY_SUBDIR}`, … autoDreamEnabled: false, … skillListingBudgetFraction: 0.05, … ? { permissions: { deny: sessionConfig.permissionDeny } } : {}`
- Deny rules use Claude Code rule syntax `Tool(//abs/path/**)` for Edit, Write and NotebookEdit on both the real path and the workspace symlink.
  - evidence: shared/readOnlyRules.ts:35 `export const READ_ONLY_RULE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;` and :77 `return `${tool}(/${escapeForRule(clean)}/**)`;`
- mcpServers handed to query()/setMcpServers is always the three-way merge of relays, connectors and hosted servers, because setMcpServers replaces the whole dynamic set.
  - evidence: agent-server/dynamicMcp.ts:100-108 `const merged = { ...state.mcpRelayServers, ...state.mcpConnectors, ...state.mcpHosted }; assertDynamicMcpComplete(...)`; :26-29 `setMcpServers REPLACES the entire dynamic set; it does not merge`
- allowedTools is auto-approve, not a restriction; there is no canUseTool handler and `tools` is never set on the chat path.
  - evidence: shared/agentAllowedTools.ts:12-16 `It is auto-approve, not a restriction. The SDK's restriction option is `tools`, which this app never sets, so an unlisted tool still runs … there is no `canUseTool` handler anywhere in Acabox`
- The full base allowedTools list is fixed in one module and must include mcp__knowledge__record_finding or the agent server throws at boot.
  - evidence: shared/agentAllowedTools.ts:43-80 `export const BASE_AGENT_ALLOWED_TOOLS: readonly string[] = [ 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', … 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'mcp__activity__query_activity', KNOWLEDGE_RECORD_FINDING_TOOL, …]`; agent-server/index.ts:884 `assertKnowledgeToolAllowed(initialConfig.allowedTools ?? []);`
- Relay servers are in-process SDK MCP servers whose handlers broadcast an SSE mcp-call and wait up to 120 s for POST /mcp-result.
  - evidence: agent-server/index.ts:197-200 `reject(new Error(`MCP call ${serverName}/${toolName} timed out after 120s`)); }, 120_000);` and :209-214 `broadcastSSE(state, 'mcp-call', { callId, serverName, toolName, args });`
- Host dispatch order for a relayed call is built-in handlers on globalThis.__hostMcpServers, then mini-app published tools, then hosted stdio servers with a per-tool enable gate.
  - evidence: main/agentSession.ts:324-327 `const mcpServers = (globalThis as any).__hostMcpServers … return await mcpServers[serverName][toolName](args);`; :337 `if (miniAppMcpRegistry.hasServer(serverName))`; :386 `if (!mcpHost.isToolEnabled(serverName, toolName))`; :398 `Unknown MCP server`
- SSE events are id/event/data frames with four event names and a 500-event replay ring buffer keyed by Last-Event-Id.
  - evidence: agent-server/index.ts:836-838 `return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;`; :756 `const SSE_RING_BUFFER_SIZE = 500;`; events broadcast at :694 ('message'), :209 ('mcp-call'), :707/740 ('done'), :743 ('error')
- POST /sessions accepts per-session overrides (model, effort, soulMd, hostGuidance, workspaceDirectoriesGuidance, permissionDeny, apiGuidance) and returns 201 {sessionId}.
  - evidence: agent-server/index.ts:1076-1088 `const sessionOverrides: SessionOverrides = { additionalAllowedTools: body.additionalAllowedTools, soulMd: body.soulMd, hostGuidance: body.hostGuidance, workspaceDirectoriesGuidance: …, permissionDeny: …, apiGuidance: body.apiGuidance, model: body.model, effort: body.effort }; createSession(…); sendJSON(res, 201, { sessionId });`
- /interrupt calls Query.interrupt() and keeps the session; /stop closes the query, ends the message queue, rejects pending MCP calls and deletes the session.
  - evidence: agent-server/index.ts:1175 `await q.interrupt();`; :1185-1200 `state.stopped = true; … state.queryInstance.close(); … state.messageQueue.done(); … pending.reject(new Error('Session stopped')); … sessions.delete(route.sessionId);`
- Idle eviction is 10 minutes and is asserted at boot to exceed the 300 s OAuth pin window.
  - evidence: agent-server/index.ts:126-133 `const IDLE_EVICTION_MS = 10 * 60 * 1000; if (IDLE_EVICTION_MS <= OAUTH_FLOW_WINDOW_MS) { throw new Error(`; shared/oauthWindow.ts:39 `export const OAUTH_FLOW_WINDOW_MS = 300_000;`
- Resume is validated against transcript files in CLAUDE_CONFIG_DIR/projects/<key>/<id>.jsonl before being passed to query().
  - evidence: agent-server/index.ts:719-725 `// SDK stores sessions in {CLAUDE_CONFIG_DIR}/projects/{projectKey}/{sessionId}.jsonl … if (fileExists(`${projectsDir}/${proj}/${validResume}.jsonl`)) { found = true;`
- The host pins the resolved model from the SDK init event and records connector status from init.mcp_servers.
  - evidence: main/agentSession.ts:1407-1410 `const resolvedModel = (message as any).model; if ((message as any).subtype === 'init' && typeof resolvedModel === 'string' && resolvedModel) { setSessionModelInfo(sessionId, { model: resolvedModel }); }`; :1415-1424 `recordConnectorStatus(mcpServers.map((s: any) => ({ name: s?.name, status: s?.status ?? 'unknown', …`
- Per-turn cost is derived from the SDK result's cumulative total_cost_usd stored on result rows.
  - evidence: main/agentSession.ts:1498 `...(typeof (message as any).total_cost_usd === 'number' ? { total_cost_usd: (message as any).total_cost_usd } : {}),`; shared/turnCost.ts:5-8 `The SDK's `total_cost_usd` is cumulative, and on a resume it does NOT start from zero.`
- Token-level streaming in the UI depends on includePartialMessages and raw Anthropic stream_event shapes.
  - evidence: agent-server/index.ts:642 `includePartialMessages: true,`; main/agentSession.ts:1645-1659 `} else if (event.type === 'content_block_delta') { if (event.delta.type === 'text_delta') { onEvent({ type: 'text-delta', text: event.delta.text }); } else if (event.delta.type === 'input_json_delta') {…} else if (event.delta.type === 'thinking_delta') {`
- Before every query() the host writes the key's last 20 chars into .claude.json customApiKeyResponses.approved because headless Claude Code refuses unapproved env keys.
  - evidence: shared/claudeConfigApproval.ts:21-22 `const entry = apiKey.slice(-20); const configPath = path.join(configDir, '.claude.json');`; agent-server/index.ts:620 `ensureApiKeyApproved(getClaudeConfigDir(), sessionConfig.anthropicApiKey);`
- The CLI subprocess env is the agent-server env plus ANTHROPIC_API_KEY, optional ANTHROPIC_BASE_URL, MINI_APP_WORKSPACE_DIR and CLAUDE_CONFIG_DIR.
  - evidence: agent-server/index.ts:644-650 `env: { ...process.env, ANTHROPIC_API_KEY: sessionConfig.anthropicApiKey, ...(sessionConfig.anthropicBaseURL ? { ANTHROPIC_BASE_URL: sessionConfig.anthropicBaseURL } : {}), MINI_APP_WORKSPACE_DIR: getWorkspaceRoot(), CLAUDE_CONFIG_DIR: getClaudeConfigDir(), },`
- buildSubprocessEnv exports venv/npm paths, NODE_PATH, a prepended PATH and the per-caller API-proxy base/token.
  - evidence: main/containerService.ts:114-139 `return { ...process.env, COSCIENTIST_VENV_DIR: venvDir, COSCIENTIST_NPM_PREFIX: npmPrefix, NODE_PATH: getNpmNodeModulesPath(), PATH: [venvBinDir, npmBinDir, existingPath].filter(Boolean).join(binSep), … ...(apiProxy.isRunning() ? { [API_BASE_ENV]: apiProxy.baseUrl()!, [API_TOKEN_ENV]: apiProxy.tokenFor(caller)!, } : {}), };`; shared/apis.ts:129-130 `export const API_BASE_ENV = 'ACABOX_API_BASE'; export const API_TOKEN_ENV = 'ACABOX_API_TOKEN';`
- The agent server is spawned from the Electron binary as Node with a 1536 MB heap, and the host only adopts a /health response carrying its own instance token.
  - evidence: main/containerService.ts:533-536 `const proc = spawn(process.execPath, [`--max-old-space-size=${NODE_HEAP_MB}`, bundlePath, ], {` with :520 `ELECTRON_RUN_AS_NODE: '1',`; :644 `const mine = body?.instance === this.instanceToken;`
- agent.json (raw key + decrypted connector headers) is written to userData with mode 0600 and read by the agent server from COSCIENTIST_AGENT_CONFIG.
  - evidence: main/containerService.ts:507 `await fs.promises.writeFile(configPath, configJson, { encoding: 'utf-8', mode: 0o600 });`; agent-server/index.ts:162 `const configPath = process.env.COSCIENTIST_AGENT_CONFIG || '/data/.academia/agent.json';`
- Command hooks are provisioned into the workspace .claude/ with a 'restore' policy and parse the CLI's PreToolUse stdin JSON via plutil.
  - evidence: main/skills.ts:216 `{ src: 'settings.json', dest: path.join('.claude', 'settings.json'), policy: 'restore' },`; src/cobuilding/settings.json lines 3-5 `"PreToolUse": [ { "matcher": "Bash",`; hooks/block-host-installs.sh:46 `printf '%s' "$input" | "$PLUTIL" -extract "tool_input.$1" raw -o - - 2>/dev/null || true`
- The scanner runs two one-shot query() calls with restricted tools, in-process PreToolUse hook callbacks, no persistence, thinking disabled, low effort and JSON-schema structured output.
  - evidence: main/directoryScanner/shared.ts:197-216 `tools: ["Read", "Glob", "Grep", docReaderTool], allowedTools: […], cwd: ctx.cwd, env: {…CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), 'scanner-claude-config')}, mcpServers: { "document-reader": … }, persistSession: false as const, thinking: { type: "disabled" as const }, effort: "low" as const, settingSources: [] as any[], hooks: createHooks(directoryPaths),`; agents/fileTagging.ts:40-47 `model: BACKGROUND_MODEL, systemPrompt: buildSystemPrompt(), maxTurns: 15, maxBudgetUsd: 1, outputFormat: { type: "json_schema", schema: FILE_TAGGING_SCHEMA },`
- The connector OAuth pin is keyed to the SDK's MCP auth tool names.
  - evidence: shared/oauthWindow.ts:50 `export const MCP_AUTHENTICATE_TOOL = /^mcp__[a-z0-9-]+__authenticate$/;` and :57 `export const MCP_COMPLETE_AUTH_TOOL = /^mcp__[a-z0-9-]+__complete_authentication$/;`
- The swallowed-resume-turn detector needs an empty success result, no assistant/stream output and a stopped task_notification in the same turn.
  - evidence: main/agentSession.ts:201-205 `if (msg?.type !== 'result' || msg.subtype !== 'success' || msg.is_error) return false; if (typeof msg.result === 'string' && msg.result.trim() !== '') return false; if (turn.assistantMessages > 0 || turn.streamEvents > 0) return false; return turn.stoppedTaskNotifications > 0;`
- Context overflow is detected from the result's is_error plus the API's wording, then the resume pointer is cleared.
  - evidence: main/agentSession.ts:54-56 `if (msg?.type !== 'result' || !msg.is_error) return false; … return /prompt is too long|context (window|length) exceeded|too many (input )?tokens/i.test(text);`; :1479-1480 `clearSdkSessionId(sessionId); turnState.resumeDisabled = true;`
- DesignSync sign-in drives the bundled CLI's hidden design-login --json subcommand under the same CLAUDE_CONFIG_DIR the agent server uses.
  - evidence: main/claudeDesignLogin.ts:58-59 `return spawn(bin, ['design-login', '--json', ...args], { env: buildDesignLoginEnv(process.env, getClaudeConfigDir()),`
- Mini-apps call the Anthropic Messages API through a main-process proxy that clamps the model to the known roster and defaults to Haiku 5.5 with thinking disabled.
  - evidence: main/index.ts:2629-2630 `const requested = typeof p.model === 'string' && anthropicAllowedModels().has(p.model) ? p.model : null; const model = requested ?? BACKGROUND_MODEL;` and :2641 `...(requested ? {} : { thinking: { type: 'disabled' as const } })`
- PI relocates its agent directory via PI_CODING_AGENT_DIR (confirmed in the PI docs).
  - evidence: /private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-src/pi/packages/coding-agent/docs/environment-variables.md — `| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |` and `| `PI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |`
- The SDK's query() signature and the Query methods Acabox calls are: interrupt(), setMcpServers(), toggleMcpServer(), mcpServerStatus(), close().
  - evidence: node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3265-3268 `export declare function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options; }): Query;`; :2879 `interrupt(): Promise<SDKControlInterruptResponse | undefined>;`; :3044 `mcpServerStatus(): Promise<McpServerStatus[]>;`; :3184 `toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;`; :3226 `setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;`; :3262 `close(): void;`

## RISKS
- Several host behaviours are workarounds for Claude Code CLI quirks and may be wrong or harmful against PI: the swallowed-resume-turn ladder (agentSession.ts:197-262, 730-799) keys on `system/task_notification status:'stopped'` + empty results; the 401/403 `api_retry` abort (agent-server/index.ts:696-704); context-overflow text matching (agentSession.ts:52-57); the 4 s interrupt wait expecting a CLI-authored result with `terminal_reason`. Porting them verbatim would silently never fire or misfire.
- The renderer's token streaming, tool-call cards, thinking display, subagent progress and tool-progress clocks all derive from Anthropic `stream_event` shapes and SDK `system` subtypes (agentSession.ts:1626-1776). PI's event model is different; `processQueryMessage` must be re-derived from PI's actual event types, not patched.
- `setMcpServers` replace-the-whole-set semantics, the `toggleMcpServer` backstop and `mcpServerStatus` are what connector live-apply and the Servers/Connectors UI status depend on (dynamicMcp.ts, index.ts:1056-1070, connectorsStore.recordConnectorStatus). If PI's MCP integration (`createMcpExtension`) has no live add/remove or status API, 'add a connector without a new chat' and observed status both regress.
- Connector OAuth (Hex/Sentry/Notion/Linear/GitHub, all `auth:'oauth'` in CONNECTOR_CATALOG) relies on the Claude CLI's built-in remote-MCP OAuth (`mcp__<id>__authenticate` tools, 300 s flow, keychain storage) and the host's session pin keyed to those tool names. Without an equivalent in PI, every catalog connector needs a new sign-in path.
- Security controls are CLI-specific: `permissions.deny` rules (`Edit(//abs/**)`) enforce folder locks; `.claude/settings.json` PreToolUse command hooks block direct package installs and credential-file reads (fail-closed exit 2 with Claude Code's stdin JSON shape). PI must provide equivalent pre-tool interception or these become advisory-only (the lock was advisory before 2026-10-01 and was fixed deliberately).
- The system prompt depends on the `claude_code` preset (harness-authored content Acabox never wrote) plus `settingSources:['project']` loading `.claude/CLAUDE.md`, auto-memory (`MEMORY.md` always in context), and the skill roster listing with a character budget. PI has its own AGENTS.md/skills/prompt conventions; the appended blocks (IDENTITY_PREAMBLE, SOUL.md, workspace dirs, API guidance, KNOWLEDGE_ROUTING_GUIDANCE) must be re-homed and the CLAUDE.md text rewritten because it names Claude-specific tools (`TodoWrite`, `mcp__*` ids, `.applications/install` hook behaviour).
- Tool identity is coupled to the `mcp__<server>__<tool>` naming convention in at least six places (filterMcpServers, connectorAllowedTools/replaceConnectorAllowedTools, RESERVED_CONNECTOR_IDS, oauthWindow regexes, omissionWatch classification, CLAUDE.md and skill prose). If PI names MCP tools differently, every one of these must change together.
- Transcript-based features assume Claude Code's JSONL layout and cumulative `total_cost_usd` on each result: resume validation (index.ts:712-736), orphan sweep/delete (transcriptStore.ts), per-turn cost (turnCost.ts), model pin from `init.model`. PI session files (`PI_SESSION_FILE`, session JSONL format doc) have a different schema; cost/usage accounting must be re-sourced.
- Secrets handling: `agent.json` holds the raw Anthropic key and decrypted connector headers (0600 in userData), and the CLI subprocess env carries `ANTHROPIC_API_KEY` — INFERRED to be inherited by Bash children. A multi-provider PI build adds OpenAI/OpenRouter keys and ChatGPT OAuth tokens to the same surfaces; the secret-read hook patterns (`agent\.json`, `claude-config`, `\.claude\.json`) and the keychain-backed stores must be extended, and PI's own `~/.pi/agent` auth store must be relocated via PI_CODING_AGENT_DIR out of the agent-writable workspace.
- The directory scanner's two one-shot queries depend on `outputFormat: json_schema` → `structured_output`, `maxBudgetUsd`, `tools` restriction and in-process `HookCallback` denies for path confinement. These need a PI equivalent (structured output + path guards) or the scanner must be rewritten against a raw provider client.
- Background (non-chat) model calls and the mini-app bridge use `@anthropic-ai/sdk` directly with Anthropic-specific request fields (`thinking`, `output_config.effort`, `tools[].input_schema`, streaming `text` events) — title generation, manifest metadata, scanner classifiers, calendar assistant (`claude-sonnet-4-6` tool loop), `anthropic:complete/stream` for mini-apps. Wider provider support needs a provider-neutral client (e.g. pi-ai) and a changed mini-app bridge contract (`bridge.ts` ships inside every built app, so old apps keep the Claude shape).
- Identity and UX strings assert 'built on Claude by Anthropic' (identityPreamble.ts:8) and the no-key message names Anthropic (main/index.ts:488); the OFFLINE/STARTING chrome, key-check verdicts (`GET /v1/models?limit=1`) and model discovery (`GET /v1/models`) are all Anthropic-endpoint specific.
- Packaging depends on unpacking `@anthropic-ai/claude-agent-sdk-*` from asar and shipping `dist/agent-server.js` as an extraResource; PI is ESM-only (`"type":"module"`), so the webpack `target:'node'` CJS bundle strategy (and the `require.main === module` guard) needs re-validation.
- `allowedTools` is auto-approve only — with no `canUseTool`, an unlisted tool still runs. If PI defaults to prompting for tool permission (or has no equivalent of auto-approve), headless sessions will stall; conversely, a PI default of 'run everything' reproduces today's behaviour but the deny/hook layers must then exist.
- The agent server's HTTP/SSE contract (routes, SSE event names, 120 s relay timeout, 500-event ring buffer, 10 min idle eviction, `/interrupt` vs `/stop`) is consumed by agentSession.ts in detail; keeping it byte-compatible is the cheapest way to leave the host and renderer untouched, but every route body that embeds SDK shapes (`mcpServers` McpServerConfig records, `resumeSessionId`, raw `SDKMessage` on the `message` event) will change meaning.

## UNKNOWNS
- Whether the Claude Code CLI scrubs ANTHROPIC_API_KEY / ELECTRON_RUN_AS_NODE from the Bash tool's child env (I only read that the CLI subprocess env contains them: agent-server/index.ts:644-650).
- Exact runtime shape of `mcp_servers[].tools`/`error`/`scope` on the init event — agentSession.ts:1417-1423 reads `s.tools` and `s.scope`, while sdk.d.ts:5986-5993 declares only `name`, `status`, `source?`; code tolerates absence, so this is best-effort.
- What the renderer does at turn end (detach → session destroy) — the 'one turn = one query = one CLI subprocess' claim is from code comments (sessionRegistry.ts:389-390, CLAUDE.md), not from reading the renderer.
- The precise CLI transcript project-key derivation from `cwd` (transcriptStore.ts:33-36 says 'the SDK keys projects off the query's cwd'); not verified against the binary.
- Whether `additionalAllowedTools` (POST /sessions, sessionConfig.ts:75, 99-101) has any live caller — the host's createBody (agentSession.ts:836-846) does not send it; CLAUDE.md calls it 'now-unused'.
- The SDK's `CallToolResult` type alias was not located in sdk.d.ts by grep (`tool()` at 9821 references it); the shape Acabox returns is `{ content: [{ type: 'text', text }], isError?: boolean }`.
- PI-side equivalents for every capability — deliberately out of scope here beyond confirming PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR exist; other readers cover PI's SDK (createAgentSession, SessionManager, createMcpExtension) and auth.
- The exact bytes of `Options.systemPrompt` 'append' ordering vs the preset's own dynamic sections (CLAUDE.md, memory, skills listing) — only the SDK option shape was read, not the composed prompt.
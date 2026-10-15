# Harness ↔ Acabox message contract (read 2026-10-15, Acabox `main` @ 3f4ad5fe)

Everything below is READ from the Acabox sources unless marked **INFERRED**. Paths are under `/Users/iliasbeshimov/Documents/Dev Folders/Acabox/src/cobuilding/`. Where a doc comment and code disagreed I say so and the code wins.

---

## 0. Topology: there are TWO contract layers a PI adapter can target

```
renderer (assistant-ui)                 main process                                  agent-server child (SDK)
chatAdapter.ts / useSessionSubscription ─ IPC chat:send/chat:event ─ index.ts chat:send ─ agentSession.ts ─ HTTP+SSE ─ agent-server/index.ts ─ query()
                                        ◄─ chat:event / chat:done / chat:error ◄──────── ChatStreamMessage ◄──── raw SDKMessage JSON over SSE
                                                                     └── SQLite messages/sessions rows (chatRepository.ts)
```

- **Layer A (wire)**: `agentSession.ts` speaks to the agent-server over loopback HTTP and reads an SSE stream whose `message` events carry **raw `SDKMessage` JSON** (`agent-server/index.ts:694 broadcastSSE(state, 'message', message)`). An adapter that keeps this layer (a PI-backed "agent-server" emitting SDK-shaped JSON on the same routes) needs **zero** host/renderer/DB changes.
- **Layer B (host→renderer+DB)**: `createAgentSession()` (`main/agentSession.ts:459`) converts SDK messages into the `ChatStreamMessage` union (`shared/types.ts:2-48`) and into `messages` rows. An adapter that replaces `createAgentSession` must emit exactly these events and rows.

Both layers are specified below. Section 5 is the checklist.

### 0.1 Layer-A HTTP routes the host actually calls (agent-server/index.ts:13-21, 858-873, 1072-1203)

| Route | Host caller | Body / response |
|---|---|---|
| `GET /health` | `agentSession.ts:611` (`res.includes('"ok"')`), `containerService.ts:625-648` (`body.instance === this.instanceToken`) | `{status:'ok', sessions, instance: process.env.COSCIENTIST_AGENT_INSTANCE ?? null, workspace}` (agent-server:897-902) |
| `POST /sessions` | `agentSession.ts:836-850` | body `{sessionId, resumeSessionId, model, effort, soulMd, hostGuidance, workspaceDirectoriesGuidance, permissionDeny: string[], apiGuidance}` → `201 {sessionId}` (agent-server:1072-1088; overrides merged by `mergeSessionConfig` sessionConfig.ts:98-114) |
| `POST /sessions/:id/messages` | `agentSession.ts:870-873, 1076-1079, 740-742` | `{text, attachments, messageId}` → `200 {ok:true}`; **404 ⇒ host re-queues the message and restarts the loop with resume** (`agentSession.ts:1083-1085`) |
| `GET /sessions/:id/events` | `agentSession.ts:1343-1349` with header `Last-Event-Id` on reconnect | SSE `id: N\nevent: <message|mcp-call|done|error>\ndata: <JSON>\n\n` (agent-server:836-838); ring buffer 500 events replayed from `Last-Event-Id+1` (agent-server:756, 1122-1138) |
| `POST /sessions/:id/interrupt` | `agentSession.ts:1148` (Stop) | `200 {ok:true}` / `409 {error:'No active query'}` / `500` (agent-server:1168-1181 → `queryInstance.interrupt()`) |
| `POST /sessions/:id/stop` | `agentSession.ts:1129` (destroy) | closes the query, rejects pending MCP calls, deletes session (agent-server:1184-1203) |
| `POST /sessions/:id/mcp-result` | `agentSession.ts:1565-1571` | `{callId, result}` or `{callId, error}` (agent-server:1148-1162) |
| `POST /credentials`, `/connectors`, `/hosted`, `/skills` | `containerService` / connectors push, not `agentSession` | see agent-server:906-1050 |

Spawn env the host gives the child (`containerService.ts:514-531`): `ELECTRON_RUN_AS_NODE=1`, `COSCIENTIST_AGENT_PORT`, `COSCIENTIST_AGENT_CONFIG` (absolute path of `agent.json`, mode 0600), `COSCIENTIST_WORKSPACE` (agent cwd), `COSCIENTIST_AGENT_INSTANCE` (per-run UUID echoed by `/health`), `COSCIENTIST_CLAUDE_CONFIG_DIR`. Spawned as `process.execPath --max-old-space-size=… <agentDir>/.academia/agent-server.js` (`containerService.ts:533-540`; the bundle is copied there by `ensureAgentFilesInWorkspace`, :456-467).

`agent.json` shape = `AgentConfig` (`agent-server/sessionConfig.ts:3-72`), built at `controllers/AgentInfrastructureController.ts:487-512`:
```ts
{ port: 8080, mcpServers: connectorServers, hostedServers: hostedInventory,
  anthropicApiKey, anthropicBaseURL?, model: DEFAULT_MODEL, effort: 'high',
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  allowedTools: buildAgentAllowedTools([...connectorTools, ...hostedIds.map((id) => `mcp__${id}`)]),
  skills, settingSources: ['project'] }
```

### 0.2 SSE reader semantics the adapter must respect (agentSession.ts:1319-1612)
- Parser splits on `\n\n`, reads `event: `, `data: `, `id: ` lines (1356-1374). `id` advances `sseCursor.lastEventId` even if the handler throws (1379).
- `event === 'message'`: ignored entirely once `sessionState.stopped` (1390) — anything after a Stop/destroy never becomes a row or event.
- Each message is `JSON.parse(data) as SDKMessage` (1392); non-`stream_event` messages are logged `[AgentSession:SSE] message type=… subtype=…` (1393-1398).
- Order of work per message: `processQueryMessage` (renderer events) → `noteSwallowSignals` → `system` handling → `assistant` row → `user`/tool_result row → `result` handling (1399-1554).
- `event === 'mcp-call'` → `handleMcpRelay` → POST `/mcp-result` with retry [250,500,1000] ms (1558-1574, 1251-1279).
- `event === 'done'` → `emitDone()` and resolve (1575-1578). `event === 'error'` → `{error}`; auth errors reject with `AuthRetryError` once, else `emitError(errorMsg)` (1579-1592).
- Transport failure → reconnect with backoff `[250, 500, 1000, 2000, 5000]` ms carrying `Last-Event-Id` (882-932).

---

## 1. Every SDK message type/subtype the host consumes and what it does

### 1.1 `system` (any subtype) — `agentSession.ts:1402-1425`
```ts
if (message.type === 'system') {
  setSdkSessionId(sessionId, (message as any).session_id);          // :1403 — EVERY system message
  const resolvedModel = (message as any).model;
  if ((message as any).subtype === 'init' && typeof resolvedModel === 'string' && resolvedModel) {
    setSessionModelInfo(sessionId, { model: resolvedModel });          // :1408-1410 write-once (WHERE model IS NULL)
  }
  const mcpServers = (message as any).mcp_servers;
  if ((message as any).subtype === 'init' && Array.isArray(mcpServers)) {
    recordConnectorStatus(mcpServers.map((s: any) => ({ name: s?.name, status: s?.status ?? 'unknown', error: s?.error, toolCount: Array.isArray(s?.tools) ? s.tools.length : undefined, scope: s?.scope })));  // :1415-1423
  }
}
```
- **Any** `type:'system'` message writes `sessions.sdk_session_id = message.session_id` (chatRepository.ts:282-286, plain `UPDATE`). An adapter must put a string `session_id` on every `system` message; a missing value is bound as `undefined` (**INFERRED**: better-sqlite3 throws on `undefined` bindings, which would be caught at :1555 and skip the init model pin / connector status for that message — not measured).
- SDK `init` fields used: `model`, `mcp_servers[{name,status,…}]`, `session_id` (sdk.d.ts:5973-6056: `SDKSystemMessage = {type:'system'; subtype:'init'; apiKeySource; claude_code_version; cwd; tools: string[]; mcp_servers: {name; status; source?}[]; model: string; permissionMode; slash_commands; output_style; skills; plugins; effort?; uuid; session_id}`).
- `subtype:'task_started'|'task_progress'|'task_notification'` with `tool_use_id` → renderer subagent events (`processQueryMessage` :1680-1707):
  - `task_started {task_id, tool_use_id, description}` → `{type:'subagent-started', taskId, parentToolCallId: tool_use_id, description}`
  - `task_progress {task_id, tool_use_id, summary?, last_tool_name?, usage:{tool_uses,duration_ms}}` → `{type:'subagent-progress', taskId, parentToolCallId, summary, lastToolName, toolUseCount: usage?.tool_uses ?? 0, durationMs: usage?.duration_ms ?? 0}`
  - `task_notification {task_id, tool_use_id?, status:'completed'|'failed'|'stopped', summary}` → `{type:'subagent-done', taskId, parentToolCallId, status, summary}`; **a `task_notification` with `status:'stopped'` (with or without tool_use_id) increments `turn.stoppedTaskNotifications`** (`noteSwallowSignals` :223-224) — the swallowed-turn fingerprint (§4.1).
- `subtype:'api_retry'` with `error_status` 401/403 is handled **in the agent-server** (agent-server:696-704): the second one closes the query and throws `Failed to authenticate. API Error: ${status}` → SSE `error` → host auth ladder (§4.3).
- All other system subtypes (`compact_boundary`, `status`, `mcp_status`, hook_*, …) are ignored apart from the `session_id` write.

### 1.2 `assistant` — `agentSession.ts:1426-1429` + `processQueryMessage` :1710-1737
```ts
if (message.type === 'assistant' && (message as any).message?.content) {
  insertMessage(sessionId, 'assistant', JSON.stringify((message as any).message.content), turnState.currentMessageId ?? undefined);  // :1427
  collectKnowledgeSignals((message as any).message.content, turnState);                                                           // :1428
}
```
- One row per SDK assistant message, content = the **raw Anthropic content-block array** (`text`, `thinking`, `tool_use`), stringified as-is. With `includePartialMessages: true` (agent-server:642) the SDK emits one assistant message per content block, so a turn produces many assistant rows; the history converter merges them.
- Renderer events, per block (:1711-1736): `text` → `{type:'text', text}`; `tool_use {id,name,input}` → `{type:'tool-call', toolCallId: block.id, toolName: block.name, args: block.input, argsText: JSON.stringify(block.input, null, 2)}`. `thinking` blocks emit nothing here (deltas already streamed).
- Side effects: `name === 'Bash'` with `input.command` → `state.pendingBashCalls.set(block.id, {command})` (:1722-1727); `extractOpenedDirName(block)` → `onAppLink(dir,'open')` for `mcp__mini-apps__open_mini_application` / `mcp__mini-apps__build_and_open_mini_application` with `input.dir_name` matching `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (`appChatLink.ts:21, 61-78`); `collectKnowledgeSignals` pushes every `tool_use.name` into `turnState.toolNames` and, for `name === 'Read'`, `input.file_path` into `readPaths` + `noteFindingsFileRead(filePath)` (:1294-1317).
- **No `parent_tool_use_id` filter** anywhere in `agentSession.ts` (grep confirmed): subagent (Agent tool) inner assistant/user messages, which the SDK tags with `parent_tool_use_id`, are stored and emitted exactly like top-level ones.
- Counted in `turn.assistantMessages` (:219-220).

### 1.3 `user` — `agentSession.ts:1430-1438` + `processQueryMessage` :1740-1775
```ts
if (message.type === 'user' && (message as any).message?.content) {
  const content = (message as any).message.content;
  if (Array.isArray(content)) {
    const hasToolResults = content.some((b: any) => typeof b !== 'string' && b.type === 'tool_result');
    if (hasToolResults) insertMessage(sessionId, 'tool_result', JSON.stringify(content), turnState.currentMessageId ?? undefined);  // :1433-1436
  }
}
```
- Only user messages containing `tool_result` blocks become rows (type `tool_result`, content = whole array). The SDK's echo of the host's own user message (`SDKUserMessageReplay`, sdk.d.ts:6405, also `type:'user'`) has no tool_result blocks → no row, no event.
- Per `tool_result` block → `{type:'tool-result', toolCallId: block.tool_use_id, result: block.content, isError: block.is_error ?? false}` (:1745-1750).
- Bash bookkeeping (:1751-1770): if `pendingBashCalls` has the id → `commandLogger.log({command:['bash','-c',cmd], stdout: extractToolResultText(block.content), stderr:'', exitCode: block.is_error ? 1 : 0, appDirName: parseAppDirFromArgs(...), source:'agent'})` (Debug tab command log, 10 KB/field cap, `commandLogger.ts:8-24`), then `extractScaffoldedDirName(pending.command, resultText)` → `onAppLink(dir,'scaffold')` when the command contains `manage_mini_app.mjs` and some stdout line parses as a JSON object with a linkable `dir_name` (`appChatLink.ts:40-59`).
- `extractToolResultText` (:1778-1787): string → itself; array → join of `text` blocks.

### 1.4 `result` — `agentSession.ts:1439-1554` (the turn terminator)
Steps, in order:
1. `completedMessageId = turnState.currentMessageId` (:1440).
2. `isSwallowedResumeTurn` (:197-206) → if matched, `onSwallowedResult()` may **absorb** it (no row, no turn-complete) — §4.1.
3. Clear the follow-up watchdog (:1462-1465).
4. `isContextOverflowResult` (:52-57) → `clearSdkSessionId`, `resumeDisabled = true`, insert an assistant row `[{type:'text', text: CONTEXT_OVERFLOW_MESSAGE}]` and emit `{type:'text', text}` **before** the result row (:1474-1488) — §4.2.
5. Insert the result row (:1489-1504):
```ts
insertMessage(sessionId, 'result', JSON.stringify({
  subtype: (message as any).subtype,
  result: (message as any).subtype === 'success' ? (message as any).result : undefined,
  is_error: (message as any).is_error,
  run_id: agentSessionId,
  ...(typeof (message as any).total_cost_usd === 'number' ? { total_cost_usd: (message as any).total_cost_usd } : {}),
  ...(typeof (message as any).duration_api_ms === 'number' ? { duration_api_ms: (message as any).duration_api_ms } : {}),
  ...((message as any).modelUsage ? { modelUsage: (message as any).modelUsage } : {}),
  ...(turnState.stopReason ? { stopped_by: turnState.stopReason } : {}),
}), completedMessageId ?? undefined);
```
6. `noteTurn({sessionId, chatTitle, toolNames, readPaths, hostedIds})` (knowledge omission watch, :1509-1529).
7. `turnState.turnInProgress = false; noteTurnEnded(sessionId)` (:1533-1534) — **before** the event so the registry's deferred destroy sees it.
8. `turnCostUsd = last of turnCosts(listResultCostRows(sessionId))` (:1537-1544), computed from the rows just written.
9. `emitEvent({type:'turn-complete', messageId: completedMessageId ?? undefined, ...(costUsd)})` (:1545).
10. `turnState.currentMessageId = null` (:1548); if a Stop is waiting, log `subtype/is_error/terminal_reason` and fire `onTurnEnded` (:1550-1553).

Fields read from the SDK result: `subtype`, `result` (only kept when `subtype === 'success'`), `is_error`, `total_cost_usd`, `duration_api_ms`, `modelUsage`, `terminal_reason` (log only). SDK shapes (sdk.d.ts:5789-5875): `SDKResultSuccess {type:'result'; subtype:'success'; duration_ms; duration_api_ms; is_error; num_turns; result: string; stop_reason; total_cost_usd; usage; modelUsage: Record<string, ModelUsage>; permission_denials; terminal_reason?; uuid; session_id; …}`; `SDKResultError.subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'` (no `result` field). `ModelUsage` (sdk.d.ts:1436-1462): `{inputTokens, outputTokens, thinkingTokens?, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, canonicalModel?, provider?, costBasis?: 'list'|'managed'|'unknown'}`. `TerminalReason` (sdk.d.ts:9790) includes `'aborted_tools'`, `'prompt_too_long'`, `'completed'`.
- **`modelUsage` and `duration_api_ms` are stored and never read back** (grep: no readers outside `agentSession.ts`). `run_id` is parsed by `parseCostRow` but "deliberately not keyed on" (`turnCost.ts:12-13`). `total_cost_usd` is the only cost input (§2.4).

### 1.5 `stream_event` — `processQueryMessage` :1631-1669 (needs SDK `includePartialMessages: true`)
```
content_block_start  tool_use  → {type:'tool-call-start', toolCallId: content_block.id, toolName: content_block.name}; state.currentToolCallId = id
content_block_start  thinking  → state.currentBlockIsThinking = true (no event)
content_block_delta  text_delta        → {type:'text-delta', text: delta.text}
content_block_delta  input_json_delta  → {type:'tool-call-args-delta', toolCallId: state.currentToolCallId ?? '', argsText: delta.partial_json}
content_block_delta  thinking_delta    → {type:'thinking-delta', text: delta.thinking}
content_block_stop   (thinking)        → {type:'thinking-end'}
content_block_stop   (tool_use)        → {type:'tool-call-end', toolCallId}
message_start / message_delta / message_stop / signature_delta → nothing (but every stream_event bumps turn.streamEvents, :221-222)
```
Only these deltas reach the renderer: text, thinking, tool-input JSON. Note `tool-call-args-delta` is stamped with the *current* tool call id tracked from `content_block_start`, not from the delta's `index`.

### 1.6 `tool_progress` — :1671-1678
`{type:'tool_progress', tool_use_id, tool_name, elapsed_time_seconds, parent_tool_use_id, …}` (sdk.d.ts:6206-6224) → `{type:'tool-progress', toolCallId: tool_use_id, toolName: tool_name, elapsedSeconds: elapsed_time_seconds}`. Optional: the renderer's `RunningStep` falls back to a local clock (`turn-steps.tsx:85-89`), and `clearToolProgress` on `tool-call-end`/`tool-result` stores the last value as the card's final elapsed (`progressStore.ts:58-68`).

### 1.7 Ignored SDK types
Everything else in `SDKMessage` (sdk.d.ts:5383: `SDKCompactBoundaryMessage`, `SDKStatusMessage`, `SDKAPIRetryMessage`, hook messages, `SDKRateLimitEvent`, `SDKToolUseSummaryMessage`, …) is logged at debug and dropped.

### 1.8 Host-authored events (not from the SDK)
- `{type:'heartbeat'}` every 15 s while `running` (:523-528). The renderer's stall watchdog is `STALL_TIMEOUT_MS = 45_000` = three missed beats (`chatAdapter.ts:25`); `useSessionSubscription` ignores heartbeats when deciding a foreign turn started (`useSessionSubscription.ts:181`).
- `{type:'status', status}` during `waitForAgent` (:586-635): `'Starting Acabox…'` while `containerService.isRunning()` is false, `'Almost ready…'` while no port / `/health` not `"ok"`, then `''` to clear; rendered as `WORKING — <status>` by `WorkingIndicator` (`thread.tsx:327`).
- `{type:'user-message', text, messageId}` right after the user row insert (:1027).
- `{type:'turn-complete', messageId?, costUsd?}` (:1545, :709).
- `onDone()` → IPC `chat:done` (index.ts:626-636); `onError(text)` → IPC `chat:error` (index.ts:637-641) after `toUserFacingError` (`agentSession.ts:546`, `userFacingError.ts:46-64`, details joined with `'\n\nDetails: '`, `errorDetails.ts:7`).

### 1.9 The `ChatStreamMessage` union, verbatim (`shared/types.ts:2-48`)
```ts
export type ChatStreamMessage =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; argsText: string }
  | { type: 'tool-result'; toolCallId: string; result: unknown; isError?: boolean }
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
IPC: `sender.send('chat:event', threadId, msg)` (index.ts:624), `'chat:done'` (:632), `'chat:error', threadId, err` (:639). Preload buffers events per thread when no iterator is active (cap 2000, `preload.ts:609-631`), drops a *lone* `chat:done` (:632-652), and `sendMessage` discards leftovers (`discardBuffered`, :815). `turn-complete` additionally dispatches `window` event `chat:turn-end {threadId}` (preload :621) which `index.tsx:344-354` uses to reload SQLite when the thread is not locally running.

### 1.10 `mcp-call` relay contract
SSE `mcp-call` data: `{callId, serverName, toolName, args}` (agent-server:209-214). Host dispatch (`handleMcpRelay`, `agentSession.ts:323-399`): `globalThis.__hostMcpServers[serverName][toolName](args)` → mini-app registry (`miniAppMcpRegistry.invoke`) → hosted servers (`mcpHost.isToolEnabled` gate then `mcpHost.invoke`) → `{content:[{type:'text', text:'Unknown MCP server: …'}], isError:true}`. Result type `ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }` (:268); host handlers use `ok(text)`/`fail(text)` (`AgentInfrastructureController.ts:120-121`). Registered servers/tools (AgentInfrastructureController.ts:127-384): `activity.query_activity`, `notification.show_notification`, `mini-apps.{open_mini_application, build_and_open_mini_application, list_published_servers, call_published_tool}`, `knowledge.record_finding`, `workspace.{get_scanned_files, get_research_profile}`, `apis.list_apis`, `chats.{list_chats, read_chat}`. Zod schemas the model sees live in `agent-server/index.ts:230-394` (e.g. `show_notification {title, body, navigation?:{type:'thread'|'sidebar', threadId?, sidebarTab?: SIDEBAR_TAB_IDS}}`, `read_chat {chat, detail?:'conversation'|'full', from_message_id?, max_chars?, include_tool_results?}`). Agent-server-side timeout per call: 120 s (agent-server:197-200). A relay server is only attached if `allowedTools` has an `mcp__<server>__*` entry (`filterMcpServers`, sessionConfig.ts:87-96) and boot asserts `mcp__knowledge__record_finding` is present (`agentAllowedTools.ts:109-117`).

---

## 2. Exact JSON stored in `messages.content` per row type, ordering invariants, cost rule

### 2.1 Schema (`main/db/database.ts`)
```sql
CREATE TABLE sessions (                                  -- :24-31
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sdk_session_id TEXT,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);
-- v2  ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT NULL;            (:46)
-- v14 ALTER TABLE sessions ADD COLUMN document_path TEXT DEFAULT NULL;     (:250)
-- v15 ALTER TABLE sessions ADD COLUMN app_dir_name TEXT DEFAULT NULL;      (:257)
-- v31 ALTER TABLE sessions ADD COLUMN model TEXT DEFAULT NULL; ALTER TABLE sessions ADD COLUMN effort TEXT DEFAULT NULL;  (:506-507)
-- v32 ALTER TABLE sessions ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;   (:518)
CREATE TABLE messages (                                  -- :33-39
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);
-- v23 ALTER TABLE messages ADD COLUMN message_id TEXT DEFAULT NULL;        (:384)
-- v33 message_prose FTS5 + triggers (messageProse.ts); v34 workspace_directories.read_only = 0
```
`Session` TS shape: `chatRepository.ts:10-28` (`sdk_session_id: string | null; model; effort; unread: number; app_dir_name; source; document_path`). Timestamps are UTC without `Z`; the renderer appends `Z` (`sessionTimestamps.ts:8-15`).

### 2.2 Row types and exact content
Four `type` values are written by the chat path: `'user'`, `'assistant'`, `'tool_result'`, `'result'`. `message_id` is the renderer's UUID for the whole turn (user row: `messageId` param; later rows: `turnState.currentMessageId`).

**`user`** (`agentSession.ts:979-1000`):
```ts
insertMessage(sessionId, 'user', JSON.stringify({ text: userMessage, attachments: storedAttachments, ...(quote ? { quote } : {}) }), messageId);
// storedAttachments: file_reference → { type, filePath, name }; image/document → { type, mediaType, name, title: (document ? title : undefined) }; undefined when none (key omitted)
```
Stored text is what the user TYPED. Quote (`AcaboxQuote = {text, truncated, messageId, source: {kind:'message',role} | {kind:'tool',toolName} | {kind:'file',path} | {kind:'miniapp',appDirName,appName}}`, `quotes.ts:26-49`) is a separate field. Test-pinned example: `{ type: 'user', content: JSON.stringify({ text: 'Is that per user?', quote }) }` (historyMessageConverter.test.ts:215).

**`assistant`** (:1427): `JSON.stringify(message.message.content)` — a JSON **array** of Anthropic blocks, e.g. `[{"type":"text","text":"hello!"}]`, `[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"sleep 100"}}]` (stopTurn.test.ts:134-137), `[{type:'thinking', thinking, signature}]` (stored, never rendered). Host-authored variants: `[{type:'text', text: CONTEXT_OVERFLOW_MESSAGE}]` (:1481-1486), `[{type:'text', text: SWALLOWED_TURN_MESSAGE}]` (:1452-1457), `[{type:'text', text:'Stopped by you.'}]` / `'Stopped — Acabox closed this chat before the reply finished.'` (`stoppedTurnRows`, :123-131, via `completeTurnFromHost` :700-711). `message_prose` requires `json_type(content) = 'array'` and indexes only `text` blocks (`messageProse.ts:36-39`).

**`tool_result`** (:1435): `JSON.stringify(content)` of the SDK user message's content array, e.g. `[{"type":"tool_result","tool_use_id":"call-1","content":"found 5 papers"}]`, `[{"type":"tool_result","tool_use_id":"call-x","content":"oops","is_error":true}]` (historyMessageConverter.test.ts:71-73, 104-105). `content` may be a string or `[{type:'text',text}, …]`.

**`result`** (:1489-1504): `{"subtype":"success","result":"<final text>","is_error":false,"run_id":"<agent-server session id>","total_cost_usd":0.14,"duration_api_ms":1234,"modelUsage":{…}}`; error turns: `{"subtype":"error_during_execution","is_error":true,"run_id":…,…}` (`result` omitted); interrupted by Stop: `{ subtype: 'error_during_execution', is_error: true, stopped_by: 'user' }` (stopTurn.test.ts:172); host-authored: `{ subtype: 'stopped', result: '', is_error: false, stopped_by: 'user' }` (stopTurn.test.ts:191; `'teardown'` from destroy), `{ subtype: 'stopped', result: '', is_error: false, stopped_by: 'crash' }` (`closeOrphanTurn`, chatRepository.ts:371), `{ subtype: 'success', result: '', is_error: false }` (`completeTurnFromHost` default, :700). Cost fields are absent on host rows.

### 2.3 Ordering invariants (all READ)
1. `createSession` (INSERT OR IGNORE, title `DEFAULT_SESSION_TITLE = 'New chat'`) runs at `createAgentSession` construction (:553), then `closeOrphanTurn` (:559): any `assistant`/`tool_result` rows with `id >` the last `result` row get a `{subtype:'stopped', stopped_by:'crash'}` result appended carrying the last open row's `message_id` (chatRepository.ts:351-375). Rows are never deleted.
2. `sendMessage` order (:975-1027): set `currentMessageId` → **insert user row** → `turnInProgress = true; noteTurnStarted(sessionId)` → reset per-turn counters → emit `user-message` → compose text → POST. Pinned by `chatActivityWiring.test.ts:72 'the user row is written before the turn start is announced'`.
3. During the turn: assistant rows and tool_result rows in SSE arrival order, each stamped with the turn's `message_id`.
4. Explanation rows (overflow, swallowed-surface, stop text) are inserted **before** the result row, because a boot-time `closeOrphanTurn` treats any assistant row after the last result as an open turn (:1467-1473).
5. The result row is the last row of a turn; `turnInProgress` clears and `noteTurnEnded` fires before `turn-complete` is emitted (:1530-1545).
6. `insertMessage` bumps `sessions.updated_at` on every row (chatRepository.ts:314-319) — the sort key of every list; `onChatTurnBoundary` → `sessions:changed` broadcast at turn start and end (`chatActivity.ts:109-128`, index.ts:1103).
7. Dedup: `chat:send` looks up `findMessageByMessageId(threadId, messageId)` and, if a row exists, only re-attaches forwarding (index.ts:2264-2271).
8. `destroy()` with `turnInProgress` writes `stoppedTurnRows(reason)` (text row + result row) BEFORE severing the SSE and POSTing `/stop` (:1115-1130); after `sessionState.stopped` no SSE message is persisted (:1390).
9. `sessions.sdk_session_id` is written on every `system` message; cleared only by `clearSdkSessionId` (overflow). Resume value: `getSession(sessionId)?.sdk_session_id ?? constructor sdkSessionId`, or `undefined` when `resumeDisabled` (:815-818). Agent-server additionally checks `<CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl` exists before resuming (agent-server:712-736).
10. `sessions.model` is write-once from `init.model` (chatRepository.ts:87); `sessions.effort` is write-once from `chat:send` right after `createAgentSession` (index.ts:2358) — i.e. effort is pinned even if the first turn then fails. `chat:send` prefers the pinned values over the picker (index.ts:2300-2303).
11. `sessions.unread` set by `noteTurnEnded` when `!(windowFocused && viewingId === sessionId)`, only for `source IS NULL` rows (`chatActivity.ts:121-128`, chatRepository.ts:102-106).
12. `sessions.app_dir_name` NULL-fill only (`setSessionAppDirName`, chatRepository.ts:69-74); app chats may be pre-created with `app_dir_name` and `title = manifest.name` before any message (`sessions:findForApp` index.ts:1991-1995; `sessions:createForApp` :2036-2037). `isFirstMessage` (title trigger) = `countMessages(threadId) === 0 && (!existingDbSession || isPlaceholderTitle(existingDbSession.title))` (index.ts:2292-2294).
13. Scheduled tasks use the same `createAgentSession` with `source = task.session_source` and kind `'background'` (`scheduledTasks/runner.ts:25-55`); their rows are identical.

### 2.4 Cost rule (`shared/turnCost.ts`, pure, used by main AND renderer)
- `parseCostRow` (:34-42): `total_cost_usd` must be a finite number `> 0`, else `null`; `run_id` kept informationally.
- `turnCosts` (:53-68): per-turn cost = `v - prev` in row order; `v < prev` ⇒ restart ⇒ cost `v`; a null/zero row yields `null` and **does not** become the baseline; **the first costed row after any uncosted rows is `null`** (it carries earlier turns) but still becomes the baseline. Tests: `turnCost.test.ts:17-57` (e.g. `[0.5,0.7,0.9(run b),1.0(run c)] → [0.5,0.2,0.2,0.1]`; `[null,null,2.0,2.3] → [...,null,0.3]`).
- `chatTotalCost` (:74-84): sum of each restart segment's last value; header shows `formatCost(total) + ' so far'` (`ChatHeader.tsx:139-141`, `sessions:cost` index.ts:1862). `formatCost` (:87-91): `<$0.01` below a cent else 2 decimals; null/0 renders nothing.
- Live: `turn-complete.costUsd` is the last `turnCosts(...)` value computed after the row insert (`agentSession.ts:1537-1545`); history: `historyMessageConverter.ts:93,150` assigns `resultCosts[resultIndex++]` to each turn. So **the SDK's `total_cost_usd` must be cumulative across the whole chat** (continuing across sessions/resumes), exactly as the SDK documents (sdk.d.ts:5842); a per-turn figure would be misread as a restart on every drop.

---

## 3. Renderer expectations

### 3.1 Live parts (`chatAdapter.ts:334-458 responseBuilder`)
- `thinking-delta` accumulates `streamingReasoning`; `thinking-end` pushes `{type:'reasoning', text}`.
- `text-delta` accumulates `streamingText` (rendered as a trailing text part); the complete `text` event **resets `streamingText` and pushes `{type:'text', text}`** (:422-425). Consequence: emit the complete `text` block event at block end, otherwise text that preceded a tool call would render after it (getContent appends streaming parts after `messages`, :345-367).
- `tool-call-start` creates the streaming tool call `{toolCallId, toolName, argsText:''}` → part `{type:'tool-call', toolCallId, toolName, args:{}, argsText}`; `tool-call-args-delta` appends; `tool-call-end` clears it (+ `clearToolProgress`); the complete `tool-call` event pushes `{type:'tool-call', toolCallId, toolName, args, argsText}` (:426-435). Expected order: start → args-delta* → end → tool-call → tool-result.
- `tool-result` patches `result`/`isError` into the existing tool-call part by `toolCallId` (:436-450); unknown ids are dropped.
- `tool-progress` / `subagent-*` → `progressStore` (keyed by toolCallId / parentToolCallId); `status` → `setProcessingLabel(threadId, status || null)`.
- `turn-complete` → yields `{content, metadata:{custom:{workedMs: Date.now()-turnStartMs, costUsd?}}}` then breaks (:266-293). `heartbeat`s are consumed but not rendered.
- Stop: `abort` → `window.chatAPI.stopResponding` (IPC `chat:stop`); after the loop, `if (isUserCancel(abortSignal.reason)) throw abortSignal.reason` (:305) so assistant-ui marks `{incomplete, cancelled}`; `isUserCancel` = `reason.name === 'AbortError' && reason.detach === false` (`userCancel.ts:9-13`). A detach (thread switch) returns normally.
- Stall: 45 s silence → `getTurnStatus` → if `turnInProgress` set `RECONNECTING_LABEL = '__reconnecting__'` and keep waiting; else end the run and dispatch `chat:stream-stalled` → `reloadThreadHistory` from SQLite (:205-227, 319-328).
- `extractAttachments` (:460-495): image parts must be `data:image/<x>;base64,<b64>` (regex `^data:(image\/[^;]+);base64,(.+)$`); document parts `{type:'file', data, mimeType, filename}`; `file_reference` attachments carry the workspace-relative path as a text part.
- Creation-prompt telemetry: any streamed/complete tool args containing `'manage_mini_app.mjs'` fires `toolAnalyticsAPI.setThreadCreationPrompt` once per turn (:148-160) — tool-name agnostic.
- Model/effort sent: `context?.config?.modelName ?? getSelectedModel()` and `getSelectedEffort()` (:92-95); effort ids `'low'|'medium'|'high'|'xhigh'|'max'` (`ModelSelector.tsx:41-50`), default `'high'`.

### 3.2 History parts (`historyMessageConverter.ts:76-251`)
- `user` row → `{role:'user', content: text, attachments?: [{id:'att-i', type, name: name ?? title ?? ('image'|'file'), contentType: mediaType, status:{type:'complete'}, content:[]}], metadata?:{custom:{quote}}, createdAt}` (:199-226).
- `assistant` rows between two user rows merge into one assistant message; blocks filtered to `text`/`tool_use` only (thinking dropped, :233-236); `tool_use` → `{type:'tool-call', toolCallId: id, toolName: name, args: input ?? {}, result: toolResults.get(id)?.result, isError: … ?? false}`.
- `tool_result` rows build the map by `tool_use_id`; a block with `is_error` whose content starts with `"The user doesn't want to proceed with this tool use"` is skipped so a Stop reads as cancelled, not failed (:168-194).
- `result` row: `turnCost = resultCosts[i]`; `isStoppedResult` = `subtype === 'stopped' || typeof stopped_by === 'string'` (:162-166) ⇒ `status:{type:'incomplete', reason:'cancelled'}` + `metadata.custom.stopped = true` and **no `workedMs`**.
- `workedMs = Date.parse(last row of turn createdAt) - Date.parse(user row createdAt)` (the result row counts, :81-86, 99-101, 138); test: `252_000` for 10:00:00 → 10:04:12 (test :296-304). Absent when either timestamp is missing.
- Rows are loaded via `sessionsAPI.listMessages` = IPC `messages:list` = `getMessages` (all rows ordered by id, `threadHistoryAdapter.ts:21-31`, index.ts:1885).

### 3.3 Tool names the renderer special-cases
`tool-card-display.ts:41-101` (icon/name/args): `Bash` (`command`, `description`; `.applications/install` prefix ⇒ "install"), `Read`/`Write`/`Edit` (`file_path`), `NotebookEdit` (`notebook_path`), `Glob`/`Grep` (`pattern`), `WebSearch` (`query`), `WebFetch` (`url`), `Agent` (`description`|`prompt`), `Skill` (`skill`), `TodoWrite`/`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` ("checklist"), `ToolSearch` (`query`), `EnterPlanMode`/`ExitPlanMode` ("plan"), `mcp__mini-apps__open_mini_application` / `mcp__mini-apps__build_and_open_mini_application` (`dir_name`), `mcp__workspace__get_scanned_files` (`file_type`), `mcp__workspace__get_research_profile`; default: `/^mcp__(.+?)__(.+)$/` ⇒ server name + tool, else `toolName.toLowerCase()`.
`turnSteps.ts:161-203 categoryOf`: Bash (install vs command), Read, Write, Edit|NotebookEdit, Grep|Glob|ToolSearch|WebSearch ("searched"), WebFetch, Agent ("helpers"), Skill, TodoWrite|Task* ("updated tasks"), `mcp__<server>__…` ("called <server>"), else "used <name>". `MAX_PHRASES = 4`.
`OUTCOME_TOOLS` (:54-59) = the two mini-app tools + `EnterPlanMode`/`ExitPlanMode`; `CHECKLIST_TOOL = 'TodoWrite'` only (:61) — `TaskCreate` etc. are NOT treated as the outcome checklist. `tool-fallback.tsx:116` shows the subagent line only for `toolName === 'Agent'`; `resultLineMeta` (:124-144) reads `content`/`new_string` for Write/Edit and counts output lines for Read/Bash.
Dedicated UIs: `tools: { Fallback: ToolFallback, TodoWrite, EnterPlanMode }` (`thread.tsx:389-393`); `TodoWrite` reads `args.todos: {id, content, status:'pending'|'in_progress'|'completed', priority?}[]` (`todo-write.tsx:5-27`); `EnterPlanMode` reads `args.plan` (string, split on lines, :4-26); `useAssistantToolUI({toolName:'mcp__mini-apps__open_mini_application'})` opens the tool when `status.type === 'running'` with `args.dir_name` (`index.tsx:475-496, 554-563`); `…build_and_open…` opens on a running→complete transition with `!isError` (:517-552, 564-572).

### 3.4 Flags, timing, failures, final-answer split (`turnSteps.ts`)
- `PartLite.install` = `isInstallCommand(args)` = `str(args.command).trim().startsWith('.applications/install')` (:148-150), precomputed only for `toolName === 'Bash'` (`turn-steps.tsx:41`); `blank` = text part whose `text.trim() === ''` (:43). Blank text and reasoning parts are "step-like" and fold into runs (:67-72).
- `isFailed` (:112-116): `type === 'tool-call' && status !== 'running' && (isError === true || (status === 'incomplete' && statusReason !== 'cancelled'))`. Failures are counted in red and open their group (`turn-steps.tsx:117-123`).
- `finalAnswerStart` (:123-128) = index after the LAST tool-call; everything before folds; a turn ending on a tool call folds entirely.
- `turnFoldLabel(stepCount, workedMs, stopped, costUsd)` (:281-295): `Worked for 4m 12s · 26 steps · $0.14` / `Worked · N steps` (no duration) / `Stopped · N steps`. `workedMs` from `metadata.custom.workedMs`; `stopped` from `isStoppedMessage(status, custom)` = `custom.stopped === true || (status.type==='incomplete' && status.reason==='cancelled')` (:254-260). `isEmptyFinishedMessage` hides a finished message with zero parts unless `incomplete/error` (:268-275).
- Running step line: `RunningStep` uses `getToolCardDisplay` on the running part and `useToolElapsed(toolCallId) ?? local seconds` (`turn-steps.tsx:75-100`).

### 3.5 Working indicator (`thread.tsx:307-331`)
Shown when the message `isLast && status.type === 'running'` and the last part is not itself running; label `THINKING…` by default, `WORKING — ${customLabel}` when a `status` event set one, `RECONNECTING…` for the sentinel. `Reasoning` part (`thinking-indicator.tsx`) renders "Thinking"/"Thought" with the collapsible text. Message time via `createdAt` (`AssistantMeta`, :373-382); day separators from consecutive `createdAt`s (:191-210).

### 3.6 Session meta
`useSessionMeta` reads `sessions.model/effort/app_dir_name` via `sessions:get` (`useSessionMeta.ts:26-50`), re-read when `isRunning` flips; `formatModelLabel(id)` = curated label ?? `supersededModelLabel(id)` ?? raw id (`ModelSelector.tsx:79-81`); `formatEffortLabel` passes unknown ids through. Empty chat shows the picker's current selection (`formatSessionModelMeta`, :60-67).

### 3.7 Other row consumers that fix the content shapes
- `message_prose` triggers (`messageProse.ts:29-82`): `user` → `$.text` + `\n` + `$.quote.text`; `assistant` → join of `$.type == 'text'` blocks' `$.text`; only types `user`/`assistant`; `result` rows deliberately not indexed. Chat search (`chatSearch.ts`) and `listChatPreviews` (first user + first assistant prose row, :146-181) read this index.
- `chatReference.ts` (`read_chat`): user `{text, quote.text, attachments[].name}` (:106-119); assistant blocks `type/text/name/input` with `thinking` skipped (:211-229); `summarizeToolUse` special-cases `Bash`(`command` first line) and `Read|Write|Edit|Glob|Grep` (`file_path`|`pattern`) (:121-134); `tool_result` envelopes `{tool_use_id, content: string|[{type,text}]}` (:93-97, 136-145); `result` `{subtype, result, is_error, stopped_by}`: `stopped`/`stopped_by` ⇒ `[stopped by the user]`; `is_error` ⇒ `(turn failed: …)`; **`subtype === 'success'` ⇒ `[assistant hh:mm] ${result}` is what `conversation` mode shows as the turn's reply** (:244-270) — so `result.result` must carry the final assistant text.
- `listResultCostRows` reads `type = 'result'` rows only, ordered by id (chatRepository.ts:155-162).

---

## 4. The special ladders in `agentSession.ts`

### 4.1 Swallowed resume turn (:167-262, :730-799, :1448-1460)
Fingerprint `isSwallowedResumeTurn` (:197-206): `type:'result' && subtype:'success' && !is_error && result.trim() === '' && assistantMessages === 0 && streamEvents === 0 && stoppedTaskNotifications > 0` (all three counters per turn, reset in `sendMessage` :1013-1015; counted by `noteSwallowSignals` :214-226). Ladder `swallowedResultAction` (:239-245): `wait` (first: keep the turn open, arm a 15 s watchdog `SWALLOW_FOLLOW_UP_WAIT_MS` :253 that fires redelivery if still no assistant/stream activity) → `redeliver` (re-POST the same `{text, attachments, messageId}` to the same agent session once, :730-752; no new user row/event) → `surface` (insert assistant row `SWALLOWED_TURN_MESSAGE` :260-262 and complete). Absorbed results write no result row and emit no `turn-complete`. This is purely a Claude Code CLI artifact (an orphaned background Bash task replayed as a `<\task-notification>` turn).

### 4.2 Context overflow (:43-57, :162-165, :1474-1488)
`isContextOverflowResult`: `type:'result' && is_error && /prompt is too long|context (window|length) exceeded|too many (input )?tokens/i.test(result)` (note `subtype` stays `'success'` on the wire — test `contextOverflow.test.ts:43-51`). Action: `clearSdkSessionId(sessionId)` (SQL `UPDATE sessions SET sdk_session_id = NULL`), `turnState.resumeDisabled = true` (so a loop restart inside the same object cannot resurrect the constructor id, :485-491), insert assistant row + emit text `CONTEXT_OVERFLOW_MESSAGE` = "This chat got too long for me to keep in memory, so I've had to start fresh. I no longer remember the earlier messages here — they're still shown above, so you can paste anything I need.", then the normal result row.

### 4.3 401 → credential refresh → retry (:31-41, :890-912, :1583-1588)
Trigger: SSE `error` event whose text passes `isAuthError` = lower-case contains `'401'` AND (`'authenticat'` | `'token'` | `'unauthorized'`), only when `refreshAndPushCredentials` exists and `!authRetried` (once per loop). Action: `refreshAndPushCredentials()` (main re-reads env→settings and POSTs `/credentials`); on `true` the in-flight message is re-queued and `startLoop()` restarts (resume from DB id); on `false`/throw: `emitError('Your Anthropic API key was rejected. Update it in Settings and try again.')`. Agent-server side: a second `system/api_retry` with `error_status` 401/403 closes the query and throws `Failed to authenticate. API Error: 401` (agent-server:696-704). `NO_API_KEY_MESSAGE = 'No Anthropic API key configured. Add one in Settings.'` (index.ts:488; duplicated verbatim in agent-server:611) must stay free of `401`/`token`/`unauthorized`. `chat:send` refuses with it over `chat:error` before any session is created (index.ts:2252-2258).

### 4.4 Stop / interrupt / `stopped_by` (:111-160, :1096-1174; registry `stopSession` sessionRegistry.ts:189-200)
`chat:stop` (index.ts:2407-2412) → `removeForwarding` + `stopSession(threadId,'user')` → `session.stop('user')`: sets `turnState.stopReason` (so `isRunning` reports false, :1181-1187, and the CLI's own result is tagged `stopped_by`), then `runStop`: if no turn in progress → destroy; else POST `/interrupt`; delivered ⇒ wait `INTERRUPT_WAIT_MS = 4_000` for the result branch to fire `onTurnEnded`; then `destroy(reason)` regardless. `destroy` (idempotent via `sessionState.stopped`): if `turnInProgress` → `completeTurnFromHost(text, {subtype:'stopped', result:'', is_error:false, stopped_by})`; sever SSE; POST `/stop`. Measured CLI behaviour recorded in CLAUDE.md: interrupt result `subtype:'error_during_execution'`, `terminal_reason:'aborted_tools'`, plus a `tool_result` rejection text that the converter drops. `destroy()` default reason is `'teardown'` (quit, eviction, crash restart).

### 4.5 Attachments (:979-989, :1048-1065; agent-server:531-552; renderer `attachmentAdapter.ts`)
`IPCAttachment` = `{type:'image', data(base64), mediaType, name?} | {type:'document', data, mediaType, title?, name?} | {type:'file_reference', filePath, name}` (`shared/types.ts:54-57`). Stored rows strip `data`. Path translation (:1048-1065): `file_reference.filePath` under `workspace.directory_path + sep` → relative (dead: that column is `''` — CLAUDE.md 2026-10-01 note); under a shared dir `dir.directory_path` → `basename(dir) + rest` (the workspace symlink name; note `mountNames` sanitises/suffixes names (`readOnlyRules.ts:49-57`) while this uses the raw basename — **INFERRED** mismatch for folders with special characters or collisions). Agent-server `buildContentBlocks`: image → `{type:'image', source:{type:'base64', media_type, data}}`; document pdf → `{type:'document', source:{type:'base64', media_type:'application/pdf', data}, title}`; other document → decoded text `{type:'document', source:{type:'text', media_type:'text/plain', data}, title}`; file_reference → `{type:'text', text:'[Attached file: <filePath>]\nThis file has been placed in the workspace. You may need to preprocess it before use.'}`; the typed text is the LAST block. Renderer limits: `MAX_INLINE_IMAGE_BYTES = 7 MiB` source / `MAX_INLINE_IMAGE_BASE64_BYTES = 10 MiB` after conversion; non-JPEG/PNG/GIF/WebP images converted via `filesAPI.convertImageToPng` (macOS `sips`), SVG falls to file_reference; `MAX_INLINE_TEXT_BYTES = 256 KiB`, `MAX_INLINE_PDF_BYTES = 2 MiB`; `FileReferenceAttachmentAdapter` copies into the workspace and sends the relative path, max size from `settingsAPI.getMaxAttachmentSizeMB` (`attachmentAdapter.ts:20-248`).

### 4.6 Chat-link reference block (:1033-1041; `chatRefResolver.ts`; `chatLinks.ts:157-165`)
`resolveChatRefs(text, sessionId, workspace.id, {getSession, getActivity})`: ids from `acabox://chat/<uuid>` links, own id dropped, capped at `MAX_CHAT_REFS_PER_MESSAGE = 8`, other-workspace/missing ⇒ `exists:false`. `composeChatRefsText` appends after the (quoted) text:
```
Referenced chats — load each with the read_chat tool before answering (start with detail "conversation"; page with from_message_id if the result says it was truncated):
- acabox://chat/<id> — "Title" — 12 messages · tool <dir> · last active 2026-09-18 07:40 UTC
- acabox://chat/<id> — no chat with this id exists in this workspace; say so rather than guessing its contents.
```
Stored row keeps the typed text only.

### 4.7 Quote composition (`quotes.ts:156-173`, called at :1031)
```
> line1
> line2
(from <describeQuoteSource(source)>[, excerpt truncated])   ← only when source.kind !== 'message' or truncated

<typed text>
```
`MAX_QUOTE_CHARS = 8_000`. Order of composition: quote → typed → chat refs → `messagePreprocessor` (unused for chat/scheduled; param 8 of `createAgentSession`).

### 4.8 `onAppLink` (`MessageProcessingState.onAppLink`, :564-578; `appChatLink.ts`)
`setSessionAppDirName(sessionId, dirName)` (NULL-fill) on (a) a `tool_use` named `mcp__mini-apps__open_mini_application`/`…build_and_open_mini_application` with linkable `input.dir_name` ('open'); (b) a Bash `tool_result` whose command contained `manage_mini_app.mjs` and whose stdout has a JSON line with `dir_name` ('scaffold'). Legacy fallback scan `findSessionForApp` (chatRepository.ts:416-448) greps stored content for `open_mini_application`/`manage_mini_app.mjs` + dir name, the marker `connected to the application \"<dir>\"`, or `\"dir_name\":\"<dir>\"` in tool_result rows.

### 4.9 Title generation (index.ts:2196-2225, trigger :2365-2367)
Fire-and-forget from `chat:send` when `isFirstMessage && !isCalendarSession`, concurrent with the turn. Direct `new Anthropic({apiKey, baseURL}).messages.create({...BACKGROUND_REQUEST, max_tokens: 40, messages:[{role:'user', content: 'Give a short title (5 words or less) that summarizes this message. Reply with ONLY the title, no quotes or punctuation.\n\nMessage: ' + firstMessage}]})` where `BACKGROUND_REQUEST = { model: 'claude-haiku-5-5', thinking: {type:'disabled'}, output_config: {effort:'low'} }` (`models.ts:181-198`); text read by block type (`messageText`); then `updateSessionTitle` + IPC `sessions:titleUpdated (sessionId, title)` + `sessions:changed`.

### 4.10 Other host plumbing a replacement must preserve
- Knowledge: `collectKnowledgeSignals` (Read paths → `noteFindingsFileRead`), `noteTurn` at result (:1509-1529).
- Registry (`sessionRegistry.ts`): OAuth pin on a `tool-call` whose name matches `/^mcp__[a-z0-9-]+__authenticate$/` for `OAUTH_FLOW_WINDOW_MS = 300_000`; early unpin on the `tool-result` of `/^mcp__[a-z0-9-]+__complete_authentication$/` (`oauthWindow.ts:50-57`; registry :148-173); deferred destroy on `turn-complete` when no subscribers (:123-134, 252-288); `recordConnectorLiveness(false)` when the last entry dies (:393).
- Activity: `noteTurnStarted/Ended` → `chats:activity` broadcast + `sessions:changed`; `emitError` and `destroy` both call `noteTurnEnded` (:544, :1122).
- Session creation prompt inputs (:639-682): `SOUL.md` from `<agentDir>/.academia/SOUL.md`, `IDENTITY_PREAMBLE` (`identityPreamble.ts:8-14`, "You are Acabox … built on Claude by Anthropic"), workspace directory guidance lines (`- <name>/ (read & write) — edit files directly.` / `- <name>/ (locked by you) — Acabox blocks Edit/Write on it. …`), `permissionDeny` rules `Edit(//abs/path/**)`, `Write(...)`, `NotebookEdit(...)` for real path and symlink (`readOnlyRules.ts:35, 73-101`), `apiGuidance` (`apis.ts:451-483`, only when the API proxy is running).
- Workspace provisioning writes `<workspace>/.claude/settings.json` with `PreToolUse` hooks (`settings.json`: matcher `Bash` → `block-host-installs.sh` + `block-secret-reads.sh`; matcher `Read|Edit|Write` → `block-secret-reads.sh`; `skills.ts:215-230`) and `<workspace>/CLAUDE.md` (agent rules, `settingSources:['project']`).

---

## 5. Checklist: what a replacement harness adapter must emit or do

**A. If it keeps Layer A (recommended: PI-backed agent-server emitting SDK-shaped JSON over the same SSE):**
1. Serve `GET /health` returning JSON containing `"ok"` and `instance: process.env.COSCIENTIST_AGENT_INSTANCE`, `workspace`.
2. `POST /sessions` accepting `{sessionId, resumeSessionId, model, effort, soulMd, hostGuidance, workspaceDirectoriesGuidance, permissionDeny, apiGuidance}` → `201 {sessionId}`; `POST /sessions/:id/messages {text, attachments[], messageId}` → 200 (404 only if evicted); `GET /sessions/:id/events` SSE with `id:` lines and `Last-Event-Id` replay; `POST /interrupt` (abort current turn, keep session, let a `result` follow within 4 s); `POST /stop`; `POST /mcp-result`.
3. On each turn emit, in order: `system` `{type:'system', subtype:'init', session_id, model, mcp_servers:[{name,status}], …}` (the `session_id` must be the stable per-chat resume id; `model` the resolved id); `stream_event`s (`content_block_start` tool_use/thinking, `content_block_delta` text_delta/input_json_delta/thinking_delta, `content_block_stop`); one `assistant` `{type:'assistant', message:{content:[block]}, session_id}` per completed block (text / thinking / `tool_use {id,name,input}`); one `user` `{type:'user', message:{role:'user', content:[{type:'tool_result', tool_use_id, content, is_error}]}}` per tool result; optional `tool_progress`; finally exactly one `result` `{type:'result', subtype:'success'|'error_during_execution'|…, result:<final text>, is_error, total_cost_usd:<cumulative for the chat>, duration_api_ms?, modelUsage?, session_id, terminal_reason?}`.
4. Emit `mcp-call {callId, serverName, toolName, args}` for host tools and await `/mcp-result`; keep the tool names/schemas of agent-server:230-394 exactly (`mcp__mini-apps__open_mini_application` etc. are matched by name in 6 places: `appChatLink.ts:61-64`, `tool-card-display.ts:85-88`, `turnSteps.ts:54-59`, `index.tsx:556,565`, `agentAllowedTools.ts:69-80`, `CLAUDE.md`).
5. Emit SSE `done` when the session loop ends (idle eviction/stop) and `error {error}` on fatal failure; 401-class failures must contain `401` + `authenticat`/`token`/`unauthorized` to trigger the credential refresh ladder.
6. Never emit an empty-`result` success with zero assistant/stream activity after a `task_notification stopped`, or the swallowed-turn ladder will hold the turn open 15 s and re-send.

**B. If it replaces `createAgentSession` (Layer B), the object must implement `AgentSession` (`agentSession.ts:436-457`: `sendMessage(text, attachments?, messageId?, quote?)`, `destroy(reason?)`, `stop(reason?)`, `addListener(cb)`, `isRunning`, `isTurnInProgress`) and must:**
1. `createSession` + `closeOrphanTurn` at construction; insert the `user` row `{text, attachments, quote?}` BEFORE `noteTurnStarted` and before emitting `user-message`; compose quote → chat refs for the model only.
2. Emit `ChatStreamMessage`s exactly as §1.9, with the ordering text-delta* → `text`, tool-call-start → args-delta* → tool-call-end → `tool-call` → `tool-result`, thinking-delta* → thinking-end; `heartbeat` every 15 s; `status` strings while starting.
3. Write `assistant` rows as JSON arrays of Anthropic-shaped blocks (`text`, `tool_use {id,name,input}`; `thinking` optional), `tool_result` rows as arrays of `{type:'tool_result', tool_use_id, content, is_error?}`, and one `result` row `{subtype, result (final text, success only), is_error, run_id, total_cost_usd (cumulative), …}`; stamp every row with the turn's `message_id`.
4. On result: clear `turnInProgress`, `noteTurnEnded`, compute `costUsd` via `turnCosts(listResultCostRows)`, emit `turn-complete {messageId, costUsd}`, honour `onTurnEnded` for Stop.
5. Pin `sessions.model` via `setSessionModelInfo({model})` from the resolved model; write `sessions.sdk_session_id` to the harness's own resumable conversation id; implement overflow recovery (`clearSdkSessionId` + `resumeDisabled` + explanation row before the result row); implement Stop as interrupt-then-wait-4s-then-`stoppedTurnRows`; keep `isRunning` false once `stopReason` is set.
6. Keep `onAppLink` extraction (Bash `manage_mini_app.mjs` stdout JSON `dir_name`; open/build tool `input.dir_name`), `commandLogger.log` for shell commands, `collectKnowledgeSignals` (Read `file_path`), `noteTurn` at result, and `recordConnectorStatus` from the harness's MCP status.
7. Route host tool calls through `handleMcpRelay(serverName, toolName, args)` and return its `{content:[{type:'text',text}], isError}` to the model.
8. Call `generateSessionTitle` semantics are in `chat:send`, not the session — unchanged, but the Anthropic client there must become provider-aware.

**C. Claude-shaped assumptions that need a small generalisation (ranked by blast radius)**
1. **Tool names and arg names** (§3.3): `Bash.command/description`, `Read/Write/Edit.file_path`, `Edit.new_string`, `Write.content`, `NotebookEdit.notebook_path`, `Glob/Grep.pattern`, `WebSearch.query`, `WebFetch.url`, `Agent`, `Skill.skill`, `TodoWrite.todos[]`, `EnterPlanMode.plan`, `ToolSearch.query`; plus `'Bash'`/`'Read'` literals in `agentSession.ts:1722,1304`, `chatReference.ts:124-126`, `turnSteps.ts`, `tool-fallback.tsx:131,139`. Either the adapter maps PI tool names/args onto these (a `toolName`/`args` translation table at the adapter boundary, applied to both events and stored `tool_use.name/input`) or every consumer gains a second alias table. PI's actual tool/arg names were NOT read here (another reader's job).
2. **`mcp__<server>__<tool>` naming** for every host/connector/hosted tool (regexes in `tool-card-display.ts:96`, `turnSteps.ts:195`, `oauthWindow.ts:50,57`, `filterMcpServers`, `omissionWatch.connectorIdOfTool`, `agentAllowedTools`). PI's MCP naming must be mapped to this form or these sites updated.
3. **Stored block shapes are Anthropic's** (`tool_use {id,name,input}`, `tool_result {tool_use_id, content, is_error}`, `thinking`). A PI adapter converts PI's message format to these before insert; the renderer/DB/search/read_chat then stay untouched.
4. **`total_cost_usd` must be cumulative per chat** across sessions (§2.4); `modelUsage`/`duration_api_ms` are opaque and may be omitted or PI-shaped; `run_id` informational.
5. **`sdk_session_id` means "Claude Code transcript id under `<CLAUDE_CONFIG_DIR>/projects/<key>/<id>.jsonl`"**: used for resume (`agentSession.ts:815-818`, agent-server:712-736 file-exists check), `deleteTranscript`/`sweepOrphanTranscripts` (`transcriptStore.ts`), overflow recovery (`clearSdkSessionId`), and the Knowledge page's memory-file origin join (`index.ts:3355-3360`, matching the `originSessionId` the CLI stamps into memory files). For PI it should hold PI's session identifier; `transcriptStore` must be re-pointed at PI's session storage (otherwise its delete/sweep are silent no-ops) and the memory-origin join becomes meaningless.
6. **`sessions.model`** is a raw id rendered through `CURATED_MODELS` (Claude ids) with raw-id fallback; **`effort`** values are SDK levels `low|medium|high|xhigh|max` (`ModelSelector.tsx:41-50`, `AgentConfig.effort`); PI's thinking levels need a mapping and the picker a provider-aware roster (`modelCatalog.ts` reads Anthropic `GET /v1/models`).
7. **Error text matching is Anthropic/CLI-specific**: overflow regex (§4.2) — OpenAI's "maximum context length" phrasing is NOT matched (only "context (window|length) exceeded" / "too many tokens" / "prompt is too long"); `isAuthError`; `toUserFacingError` regexes and copy ("Your Anthropic API key…", "Your Anthropic account has run out of credit", "Anthropic is busy", `userFacingError.ts:13-29,51-62`); `NO_API_KEY_MESSAGE`; the interrupt rejection text `"The user doesn't want to proceed with this tool use"` (`historyMessageConverter.ts:168`) which a PI abort will not produce (**INFERRED**) — a PI Stop must either leave the tool call without a result or the converter needs PI's equivalent.
8. **Swallowed-turn ladder** (§4.1) and `task_notification`/`task_started`/`task_progress`/`tool_progress` are CLI features; harmless if never emitted (subagent lines and SDK-reported elapsed simply never show).
9. **Permission/hook model**: `allowedTools` auto-approve, `permissions.deny` rules for locks, `PreToolUse` hook scripts in `<workspace>/.claude/settings.json`, `systemPrompt {preset:'claude_code'}` + append, `settingSources:['project']` (loads `CLAUDE.md` + `.mcp.json`), `Options.skills` roster, `autoMemoryEnabled`/`autoDreamEnabled`, `ensureApiKeyApproved` (`claudeConfigApproval.ts`) — all live in the agent-server/config layer, not in the message contract, but a PI adapter must reproduce the lock (deny Edit/Write/NotebookEdit under locked paths) and the install/secret guards through PI's own mechanism.
10. **MCP OAuth pin** keys on tool names `mcp__<id>__authenticate` / `complete_authentication` — the CLI's remote-MCP OAuth flow; PI's MCP client is different (not read here).
11. **`system` messages write `sdk_session_id` unconditionally** — an adapter must either always include `session_id` or the host should guard the write.
12. **Subagent messages are not filtered by `parent_tool_use_id`** — any nested agent output a PI adapter emits as `assistant`/`user` messages will be stored and rendered inline.
13. **Title generation and other "background" calls** (`BACKGROUND_REQUEST`, `generateSessionTitle`, manifest metadata, scanner `directoryScanner/shared.ts:197-216` which uses `query()` with `tools: ['Read','Glob','Grep', docReaderTool]`) call Anthropic directly — a provider-abstracted small-call client is a separate ticket.
14. `calendarAgentSession.ts` is a second, independent `AgentSession` implementation over `@anthropic-ai/sdk` directly (798 lines; tool loop and rows of its own) — out of the chat harness but also Claude-only.

PI env var confirmed in its docs: `PI_CODING_AGENT_DIR` — "Override the config directory; default is `~/.pi/agent`" (`pi/packages/coding-agent/docs/environment-variables.md:81`).

## KEY FACTS
- The host consumes raw SDKMessage JSON from SSE `message` events; the agent-server broadcasts every query() message unchanged.
  - evidence: agent-server/index.ts:693-694 `for await (const message of queryInstance) { broadcastSSE(state, 'message', message);` and main/agentSession.ts:1392 `const message = JSON.parse(data) as SDKMessage;`
- Every `system` message (any subtype) overwrites sessions.sdk_session_id with message.session_id; only `init` pins the model and records MCP status.
  - evidence: main/agentSession.ts:1402-1410 `if (message.type === 'system') { setSdkSessionId(sessionId, (message as any).session_id); ... if ((message as any).subtype === 'init' && typeof resolvedModel === 'string' && resolvedModel) { setSessionModelInfo(sessionId, { model: resolvedModel }); }`
- Assistant rows store the raw Anthropic content-block array; tool_result rows store the whole user content array only when it contains a tool_result block.
  - evidence: main/agentSession.ts:1427 `insertMessage(sessionId, 'assistant', JSON.stringify((message as any).message.content), turnState.currentMessageId ?? undefined);` and :1433-1436 `const hasToolResults = content.some((b: any) => typeof b !== 'string' && b.type === 'tool_result'); if (hasToolResults) { insertMessage(sessionId, 'tool_result', JSON.stringify(content), ...`
- The stored result row keeps subtype, result (success only), is_error, run_id, total_cost_usd, duration_api_ms, modelUsage and stopped_by.
  - evidence: main/agentSession.ts:1489-1504 `insertMessage(sessionId, 'result', JSON.stringify({ subtype: (message as any).subtype, result: (message as any).subtype === 'success' ? (message as any).result : undefined, is_error: (message as any).is_error, run_id: agentSessionId, ...(typeof (message as any).total_cost_usd === 'number' ? { total_cost_usd: ... } : {}), ...(duration_api_ms), ...(modelUsage), ...(turnState.stopReason ? { stopped_by: turnState.stopReason } : {}) })`
- modelUsage and duration_api_ms are stored but never read back anywhere; only total_cost_usd (cumulative) feeds the cost UI.
  - evidence: grep over src/cobuilding for `modelUsage` and `duration_api_ms` outside agentSession.ts returned nothing; shared/turnCost.ts:36-41 reads only `run_id` and `total_cost_usd`
- Per-turn cost is the delta between consecutive cumulative result rows; a drop is a restart; the first costed row after uncosted rows shows no per-turn figure.
  - evidence: shared/turnCost.ts:53-68 `if (prev === null) cost = sawUncosted ? null : v; else cost = v < prev ? v : v - prev;` and turnCost.test.ts:50-56 `turnCosts([row(null,null), row(null,null), row('a', 2.0), row('b', 2.3)]) → c[2] null, c[3] ≈ 0.3`
- The user row is inserted before the turn is announced and before the user-message event; the result row is the last row of a turn and turn-complete is emitted after turnInProgress clears.
  - evidence: main/agentSession.ts:995-1027 (insertMessage user → turnState.turnInProgress = true; noteTurnStarted → emitEvent user-message) and :1533-1545 (`turnState.turnInProgress = false; noteTurnEnded(sessionId);` ... `emitEvent({ type: 'turn-complete', messageId: completedMessageId ?? undefined, ...(costUsd) })`); chatActivityWiring.test.ts:72 'the user row is written before the turn start is announced'
- closeOrphanTurn appends a `{subtype:'stopped', stopped_by:'crash'}` result row to assistant/tool_result rows left after the last result; nothing is deleted.
  - evidence: main/db/chatRepository.ts:368-373 `insertMessage(sessionId, 'result', JSON.stringify({ subtype: 'stopped', result: '', is_error: false, stopped_by: 'crash' }), last?.message_id ?? undefined);`
- The renderer only receives text, thinking and tool-input-JSON deltas; message_start/delta/stop are ignored.
  - evidence: main/agentSession.ts:1645-1659 `if (event.delta.type === 'text_delta') { onEvent({ type: 'text-delta', ... }) } else if (event.delta.type === 'input_json_delta') { onEvent({ type: 'tool-call-args-delta', toolCallId: state.currentToolCallId ?? '', argsText: event.delta.partial_json }) } else if (event.delta.type === 'thinking_delta') { onEvent({ type: 'thinking-delta', ... }) }`
- The complete `text` event resets the streaming buffer and pushes a finished text part, so deltas alone are not enough for correct part ordering.
  - evidence: renderer/chatAdapter.ts:422-425 `case 'text': streamingText = ''; messages.push(msg); return;` and :345-367 getContent appends streamingReasoning/streamingText/streamingToolCall after `messages`
- Context overflow is detected on a result with is_error and Anthropic's wording; the resume pointer is cleared and an explanation row precedes the result row.
  - evidence: main/agentSession.ts:52-57 `return /prompt is too long|context (window|length) exceeded|too many (input )?tokens/i.test(text);` and :1474-1488 `clearSdkSessionId(sessionId); turnState.resumeDisabled = true; insertMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text: CONTEXT_OVERFLOW_MESSAGE }]), ...)`
- The swallowed-resume-turn fingerprint requires an empty success result, zero assistant messages, zero stream events and a stopped task_notification; the ladder is wait → redeliver → surface.
  - evidence: main/agentSession.ts:197-206 `if (msg?.type !== 'result' || msg.subtype !== 'success' || msg.is_error) return false; if (typeof msg.result === 'string' && msg.result.trim() !== '') return false; if (turn.assistantMessages > 0 || turn.streamEvents > 0) return false; return turn.stoppedTaskNotifications > 0;` and :239-245
- The 401 retry is keyed on the SSE error text containing '401' plus an auth word, runs once, and ends with the Anthropic-specific rejection copy.
  - evidence: main/agentSession.ts:37-41 `return lower.includes('401') && (lower.includes('authenticat') || lower.includes('token') || lower.includes('unauthorized'));` and :910 `emitError('Your Anthropic API key was rejected. Update it in Settings and try again.');`
- Stop interrupts first, waits 4 s for the CLI's own result (tagged stopped_by), then destroys; a turn still open at destroy gets host-authored stopped rows.
  - evidence: main/agentSession.ts:115 `export const INTERRUPT_WAIT_MS = 4_000;`, :139-160 runStop, :1115-1119 `if (turnState.turnInProgress) { const effective = reason ?? turnState.stopReason ?? 'teardown'; const { text, result } = stoppedTurnRows(effective); ... completeTurnFromHost(text, result); }`; stopTurn.test.ts:172 `expect(results[0]).toMatchObject({ subtype: 'error_during_execution', stopped_by: 'user' });`
- The history converter treats a result with subtype 'stopped' or any stopped_by string as a cancelled turn, drops thinking blocks, and skips the CLI's interrupt-rejection tool_result.
  - evidence: renderer/historyMessageConverter.ts:162-166 `return c.subtype === 'stopped' || typeof c.stopped_by === 'string';`, :168 `const INTERRUPT_REJECTION = "The user doesn't want to proceed with this tool use";`, :233-236 filter to text/tool_use
- Worked-for timing on reload is user-row createdAt to the last row of the turn (including the result row); live it is measured in chatAdapter.
  - evidence: renderer/historyMessageConverter.ts:99-101 `const workedMs = turnStartAt && turnEndAt ? Date.parse(turnEndAt) - Date.parse(turnStartAt) : NaN;` with :138 `if (msg.createdAt) turnEndAt = msg.createdAt;`; chatAdapter.ts:282-291 `metadata: { custom: { workedMs: Date.now() - turnStartMs, ...costUsd } }`
- Tool names are special-cased by exact Claude Code names in the card display and the step summariser; MCP tools must match mcp__<server>__<tool>.
  - evidence: renderer/components/assistant-ui/tool-card-display.ts:41-101 (`case 'Bash'`, `'Read'`, `'Write'`, `'Edit'`, `'NotebookEdit'`, `'Glob'`, `'Grep'`, `'WebSearch'`, `'WebFetch'`, `'Agent'`, `'Skill'`, `'TodoWrite'`, `'TaskCreate'`…, `'ToolSearch'`, `'EnterPlanMode'`, `const mcp = toolName.match(/^mcp__(.+?)__(.+)$/)`); turnSteps.ts:161-203 categoryOf
- Only TodoWrite (not TaskCreate/TaskUpdate) is the fold's outcome checklist; the two mini-app tools and EnterPlanMode/ExitPlanMode are the other outcome tools.
  - evidence: renderer/components/assistant-ui/turnSteps.ts:54-61 `const OUTCOME_TOOLS = new Set(['mcp__mini-apps__open_mini_application', 'mcp__mini-apps__build_and_open_mini_application', 'EnterPlanMode', 'ExitPlanMode']); const CHECKLIST_TOOL = 'TodoWrite';`
- A failure is an isError tool call or an incomplete one not cancelled; the final answer starts after the last tool call.
  - evidence: renderer/components/assistant-ui/turnSteps.ts:112-116 `if (p.isError === true) return true; return p.status === 'incomplete' && p.statusReason !== 'cancelled';` and :123-128 `if (parts[i].type === 'tool-call') return i + 1;`
- The install flag is a Bash command starting with `.applications/install`; the blank flag is whitespace-only text.
  - evidence: turnSteps.ts:148-150 `return str(args?.command).trim().startsWith('.applications/install');` and turn-steps.tsx:41-43 `if (p.toolName === 'Bash') lite.install = isInstallCommand(p.args); if (p?.type === 'text') lite.blank = (p.text ?? '').trim() === '';`
- The working indicator reads THINKING… / WORKING — <status> / RECONNECTING… and the stall watchdog is 45 s.
  - evidence: renderer/components/assistant-ui/thread.tsx:325-327 `{isReconnecting ? 'RECONNECTING…' : customLabel ? `WORKING — ${customLabel}` : 'THINKING…'}`; chatAdapter.ts:25 `const STALL_TIMEOUT_MS = 45_000;`
- Attachments reach the model as Anthropic image/document blocks with the typed text last; file references become a text block naming the workspace path.
  - evidence: agent-server/index.ts:536-551 `blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } })` … `blocks.push({ type: 'text', text: `[Attached file: ${att.filePath}]\nThis file has been placed in the workspace. You may need to preprocess it before use.` })` … `if (text) blocks.push({ type: 'text', text });`
- Image inlining caps are 7 MiB source / 10 MiB base64 after conversion; text docs 256 KiB; PDFs 2 MiB.
  - evidence: renderer/attachmentAdapter.ts:45 `const MAX_INLINE_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;`, :50 `const MAX_INLINE_IMAGE_BYTES = 7 * 1024 * 1024;`, :131 `const MAX_INLINE_TEXT_BYTES = 256 * 1024;`, :135 `const MAX_INLINE_PDF_BYTES = 2 * 1024 * 1024;`
- The stored user row keeps the typed text and the quote separately; the model receives the composed blockquote plus a chat-reference block.
  - evidence: main/agentSession.ts:995-1000 `JSON.stringify({ text: userMessage, attachments: storedAttachments, ...(quote ? { quote } : {}) })` and :1031-1042 `const quotedText = composeQuotedText(quote, userMessage); ... const withRefs = composeChatRefsText(quotedText, chatRefs);`
- App-chat linking fires from the open/build tool's input.dir_name and from the scaffold script's stdout JSON after a Bash tool_result.
  - evidence: main/appChatLink.ts:40-41 `if (typeof command !== 'string' || !command.includes('manage_mini_app.mjs')) return null;` and :61-64 `const OPEN_TOOL_NAMES = new Set(['mcp__mini-apps__build_and_open_mini_application', 'mcp__mini-apps__open_mini_application']);`; agentSession.ts:1728-1735, 1763-1770
- Title generation is a direct Anthropic Haiku 5.5 call from chat:send on the first message of a placeholder-titled chat.
  - evidence: main/index.ts:2292-2294 `isFirstMessage = countMessages(threadId) === 0 && (!existingDbSession || isPlaceholderTitle(existingDbSession.title));`, :2365-2367, :2201-2212 `const client = new Anthropic({ apiKey, baseURL }); const response = await client.messages.create({ ...BACKGROUND_REQUEST, max_tokens: 40, ...`; shared/models.ts:181 `export const BACKGROUND_MODEL = 'claude-haiku-5-5';`
- read_chat's conversation mode shows the result row's `result` text as each turn's reply, so the result must carry the final assistant text.
  - evidence: main/chatReference.ts:257-264 `} else if (parsed.subtype === 'success') { const resultText = parsed.result ?? ''; ... contributions.push({ id: row.id, lines: [`[assistant ${hhmm(row.created_at)}] ${resultText}`] });`
- The message_prose search index covers only user text (+quote) and assistant text blocks, and requires assistant content to be a JSON array.
  - evidence: main/db/messageProse.ts:32-39 `WHEN ${alias}.type = 'user' AND json_valid(...) THEN ... json_extract(..., '$.text') ... '$.quote.text' ... WHEN ${alias}.type = 'assistant' AND json_valid(...) AND json_type(${alias}.content) = 'array' THEN ... WHERE json_extract(value, '$.type') = 'text'`
- sdk_session_id is Claude Code's transcript id and is also used to delete/sweep transcripts and to join memory-file origins.
  - evidence: main/transcriptStore.ts:4-6 `Claude Code writes one JSONL transcript per conversation to \`<CLAUDE_CONFIG_DIR>/projects/<key>/<sdkSessionId>.jsonl\``; main/index.ts:3355-3359 `// Resolve origin chats in one pass; sdk_session_id is the only join key ... if (s.sdk_session_id) bySdkId.set(s.sdk_session_id, ...)`
- The agent-server validates a resume id by looking for the transcript file before resuming.
  - evidence: agent-server/index.ts:719-735 `// SDK stores sessions in {CLAUDE_CONFIG_DIR}/projects/{projectKey}/{sessionId}.jsonl ... if (!found) { console.log(`[AgentServer] Session ${validResume} not found in config dir, starting fresh`); validResume = undefined; }`
- Host MCP tool handlers return {content:[{type:'text',text}], isError?} and are dispatched from globalThis.__hostMcpServers first.
  - evidence: controllers/AgentInfrastructureController.ts:120-121 `const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] }); const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });` and agentSession.ts:324-327
- The OAuth pin keys on tool names matching mcp__<id>__authenticate for exactly 300 s.
  - evidence: shared/oauthWindow.ts:39 `export const OAUTH_FLOW_WINDOW_MS = 300_000;` and :50 `export const MCP_AUTHENTICATE_TOOL = /^mcp__[a-z0-9-]+__authenticate$/;`; sessionRegistry.ts:151-156
- No parent_tool_use_id filtering exists in the host, so subagent frames are stored and rendered inline.
  - evidence: grep -n parent_tool_use_id src/cobuilding/main/agentSession.ts returned no matches; sdk.d.ts:3630-3636 SDKAssistantMessage carries `parent_tool_use_id: string | null`
- The agent-server's SDK options include adaptive thinking, effort, includePartialMessages, settingSources, skills, permissions.deny and allowedTools.
  - evidence: agent-server/index.ts:635-686 `model: sessionConfig.model, thinking: { type: 'adaptive' }, ...(sessionConfig.effort ? { effort } : {}), systemPrompt: buildSystemPrompt(sessionConfig), ...(resume && { resume }), includePartialMessages: true, cwd: getWorkspaceRoot(), ... settingSources, skills, settings: { autoMemoryEnabled: true, ..., permissions: { deny } }, mcpServers: mergeDynamicMcpServers(state), allowedTools`
- PI relocates its agent directory through PI_CODING_AGENT_DIR.
  - evidence: pi/packages/coding-agent/docs/environment-variables.md:81 `| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |`

## RISKS
- `setSdkSessionId` runs for EVERY `system` message with `message.session_id`; an adapter that emits a `system` message without a string `session_id` will bind `undefined` (INFERRED: better-sqlite3 throws, caught at agentSession.ts:1555, silently skipping the init model pin and connector status for that message).
- The cost rule assumes `total_cost_usd` is cumulative across the whole chat; an adapter that reports per-turn cost will be misread (every lower value is treated as a restart, every higher value as a delta), producing wrong fold-line and header dollars.
- The overflow regex (`prompt is too long|context (window|length) exceeded|too many (input )?tokens`) will not match OpenAI/OpenRouter wording such as 'maximum context length'; without normalisation an overflowed PI chat stays permanently dead exactly as the pre-2026-07-28 Claude bug.
- Tool names/args are matched by exact Claude Code spellings in at least 9 modules (tool-card-display, turnSteps, tool-fallback, chatReference, agentSession Bash/Read bookkeeping, appChatLink, index.tsx tool UIs, agentAllowedTools, oauthWindow); PI tool names must be translated at the adapter boundary or every site aliased, and the two must agree for stored rows too (history re-renders from stored `tool_use.name`).
- The history converter identifies a Stop by the CLI's literal rejection text "The user doesn't want to proceed with this tool use"; a PI abort that writes any other tool_result text will render the stopped step as FAILED.
- `read_chat` conversation mode prints `result.result` as each turn's reply; an adapter that leaves `result` empty on success makes every referenced chat read as blank replies to the model.
- `transcriptStore.deleteTranscript`/`sweepOrphanTranscripts` only know `<CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl`; with PI the column would name a session the sweep cannot find, so PI session files leak on chat delete unless re-pointed, and the boot sweep must not delete PI files it does not understand.
- The `isAuthError` ladder depends on the error text containing '401' plus an auth word; PI/OpenAI auth failures phrased differently will surface as the GENERIC error instead of prompting a key refresh, and `toUserFacingError` copy names Anthropic explicitly.
- Subagent frames are not filtered by `parent_tool_use_id`; if a PI adapter streams nested agent output as assistant/user messages it will be stored and shown inline as top-level steps.
- The swallowed-turn ladder will hold a turn open 15 s and re-send the message if an adapter ever emits an empty `success` result with no assistant/stream activity after a `task_notification` with status 'stopped'; conversely an adapter must not rely on `/compact`-style empty successes being treated as turn ends unless it never emits stopped task notifications.
- The agent-server duplicates `NO_API_KEY_MESSAGE` verbatim (no shared import) and `chat:send` checks for an Anthropic key before any session exists; multi-provider auth needs that gate generalised or ChatGPT-subscription users are refused at the IPC boundary.
- `attachments` path translation uses the raw basename of a shared dir while the workspace symlink uses `mountNames` (sanitised, `_2` suffixed); for a folder with special characters or a basename collision the agent is told a path that does not exist (INFERRED mismatch, not measured).

## UNKNOWNS
- PI's actual built-in tool names and argument field names (and its message/tool-call wire format) were not read here; the exact Claude→PI tool/arg mapping table has to come from the PI reader.
- Whether better-sqlite3 throws or binds NULL when `setSdkSessionId` receives `undefined` (affects what happens if an adapter omits `session_id` on a system message); not measured.
- Whether PI exposes a cumulative per-session cost figure or only per-request usage; the adapter's accumulation strategy for `total_cost_usd` depends on it.
- What text (if any) PI writes into a tool result when a turn is aborted mid-tool, which decides whether `INTERRUPT_REJECTION` needs a PI counterpart.
- The exact runtime behaviour of the momentary gap between `tool-call-end` (streaming part cleared) and the complete `tool-call` event (part pushed) in assistant-ui — I inferred a harmless flicker from `responseBuilder` but did not observe it.
- The calendar assistant (`calendarAgentSession.ts`, 798 lines) and the directory scanner (`directoryScanner/shared.ts`) are additional Claude-only harness consumers outside the chat contract; only their entry points were noted, not their full contracts.
- Whether the `mountNames` vs raw-basename mismatch in attachment path translation is reachable in practice (needs a shared folder whose basename contains characters outside `[a-zA-Z0-9._-]` or a collision).
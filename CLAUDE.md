# Acabox — engineering context

> This file is auto-loaded at the start of every Claude Code session in this
> repo. It is the working-context handoff for whoever (human or agent) picks
> up next. Keep it current: when you finish a meaningful chunk, update the
> "Status" and "Known hazards" sections.
>
> NOTE: this is NOT the workspace-agent instructions. Those live at
> `src/cobuilding/CLAUDE.md` and are read by the Claude that runs *inside* the
> Acabox app. Don't confuse the two.

## What this project is

Acabox (formerly working name `clawdbox`) is a slimmed-down fork of
`academia-edu/academia-electron` — the "Academia Coscientist" Electron app.
The product lets a scientist point the app at local research folders and use
Claude to build, host, and run small local apps ("mini-apps") that work with
their files.

The fork's purpose: **remove the Podman/VM container** (it ate too many
resources) while preserving the three capabilities that matter:

1. Local file access from user-shared folders for data analysis.
2. Mini-apps live, are accessed, and used inside Acabox.
3. **New:** mini-apps can create and run MCP servers that the agent and other
   mini-apps can call.

Dropped on purpose: Apple Notes, Word overlay, browser extension, Google
Drive/Docs, Obsidian, Zotero, CiteRight, grants — and all their MCP servers.

- GitHub: `https://github.com/iliasacademia/acabox` (private). Default branch
  `main` — local `main` tracks the `acabox` remote; push there. The original
  upstream is still wired as the `origin` remote
  (`academia-edu/academia-electron`) for reference only. The earlier
  `clawdbox` remote/repo is retired.
- App identity: package name `acabox`, product name "Acabox", bundle id
  `com.electron.acabox`, userData under
  `~/Library/Application Support/acabox/<channel>`. Deliberately disjoint
  from the original Coscientist app so both can coexist on one machine.

## Architecture (post-slim)

The container is gone. Everything runs as **host child processes** spawned by
the Electron main process:

- **Agent server** — `dist/agent-server.js`, a webpack bundle of
  `src/cobuilding/agent-server/`. Spawned via `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1`. Wraps the Claude Agent SDK `query()` in an
  HTTP/SSE server on `127.0.0.1` (port from `findFreePort(23200..23299)`).
  Talks to the host over SSE; MCP tool calls relay back to the host via
  `mcp-call` SSE events + a `/mcp-result` POST.
- **Jupyter kernel gateway** — spawned from the per-user Python venv on first
  notebook use. Port range **`23400..23499`** (`containerService.ts:817`). This
  line said `23300..23399` until 2026-07-29 and was simply wrong; a stale
  comment at `containerService.ts:815` claims a third thing again
  (`agent 23300-23320, kernel 23330-23350`). Believe the code.
- **API proxy** — `main/apiProxy.ts`, the loopback server that holds API
  credentials so the agent never sees them. Port range `23500..23599`.
  Started by `AgentInfrastructureController.start()` **before** the agent
  server, because `buildSubprocessEnv()` only exports `ACABOX_API_BASE` /
  `ACABOX_API_TOKEN` while it is listening and the agent server inherits its
  env once, at spawn.
- **Python venv** — `~/Library/Application Support/acabox/<channel>/python-venv`.
  Bootstrapped lazily (and now eagerly, in the background, on
  `agentInfrastructure.start`) from system `python3` (3.9+ required). Holds
  `jupyter_kernel_gateway ipykernel pandas numpy matplotlib` plus whatever
  mini-apps install.
- **npm prefix** — `~/Library/Application Support/.../npm-site`. Shared global
  install location for mini-app npm deps. `NODE_PATH` points at
  `<prefix>/lib/node_modules` so esbuild bundles resolve them.
- **Workspace** — `~/Library/Application Support/.../cobuilding-workspace`.
  The agent's cwd. User-shared directories are **symlinked into** this
  workspace (e.g. `<workspace>/MyResearch -> /Users/x/Data/MyResearch`) so the
  agent reaches them with relative paths. Symlinks are resynced on
  `containerService.start()`.

Subprocess env (agent Bash, esbuild, kernel, install wrapper) is built by
`buildSubprocessEnv()` in `containerService.ts`: sets `COSCIENTIST_VENV_DIR`,
`COSCIENTIST_NPM_PREFIX`, `NODE_PATH`, and prepends venv `bin/` + npm `bin/`
to `PATH`.

## Key files

- `src/cobuilding/main/containerService.ts` — `HostProcessService` (replaces
  the old Podman service, same public surface). Spawns/monitors agent server
  + kernel gateway, syncs workspace symlinks, builds subprocess env,
  auto-restarts the agent server on unexpected exit (throttled 3/60s).
- `src/cobuilding/main/agentSession.ts` — host side of a chat turn: waits for
  agent health, creates the agent session, drives the SSE stream, relays MCP
  calls, handles 401 → credential refresh → retry, translates attachment
  paths to workspace-relative.
- `src/cobuilding/agent-server/index.ts` — the agent server itself. MCP relay
  servers: activity, notification, reaction, mini-apps, suggested-tasks,
  workspace. (All the dropped integrations were deleted from here.)
- `src/cobuilding/main/controllers/AgentInfrastructureController.ts` — builds
  the agent config + allowedTools, registers `globalThis.__hostMcpServers`,
  starts the agent server, kicks the background venv bootstrap.
- `src/cobuilding/main/miniAppBuilder.ts` — single esbuild entry point for
  both the renderer Rebuild button and the agent's
  `build_and_open_mini_application` tool. Resolves esbuild from
  `node_modules/.bin`.
- `src/cobuilding/main/miniAppMcpRegistry.ts` — routes agent ↔ mini-app-iframe
  tool calls via `webContents.send` + postMessage, with WebContents-destroyed
  reaping and a 60s invocation timeout.
- `src/cobuilding/main/packageInstaller.ts` — host pip/npm install waves.
  pip → venv pip; npm → `npm -g --prefix <npm-site>`; R/apt refused.
- `src/cobuilding/main/pythonSetup.ts` / `nodeSetup.ts` — venv + npm
  bootstrap/detection helpers. `ensurePythonVenv` is single-flight.
- `src/cobuilding/skills/manage-mini-application/assets/install` — the
  `.applications/install` wrapper the agent uses. Host pip/npm only; reads
  `COSCIENTIST_VENV_DIR` / `COSCIENTIST_NPM_PREFIX`.
- `src/cobuilding/main/freePort.ts` — loopback port probing for the agent
  server + kernel gateway. Electron-free so it can be unit-tested; see the
  header for why the probe address is load-bearing.
- `src/cobuilding/main/secretStore.ts` — `safeStorage` encryption-at-rest for
  the API key and connector auth values, plus the mask/decrypt helpers that
  keep secrets off the IPC boundary.
- `src/cobuilding/main/claudeConfigDir.ts` — resolves + migrates
  `CLAUDE_CONFIG_DIR` (MCP OAuth tokens, transcripts) to userData.
- `src/cobuilding/shared/connectors.ts` — user-configured MCP connectors: the
  catalog (add a service = one entry), id/URL validation, and conversion to the
  SDK's `mcpServers` shape. Shared by main, agent-server, and renderer.
- `src/cobuilding/main/connectorsStore.ts` — connector persistence in
  `cobuilding-settings.json` (host-owned, outside the workspace), observed
  status, and `.mcp.json` detection.
- `src/cobuilding/main/controllers/WorkspaceController.ts` — workspace + shared
  dir management. Dedups directories by `realpath`.
- `forge.config.js` — packaging. Ships `dist/agent-server.js` + skills + hooks
  via `extraResource`; unpacks the Claude SDK native binary from asar.

## Conventions

- **Test with `npm start`** (dev mode). It runs `prestart` (builds the
  agent-server bundle + Rust file monitor) then `electron-forge start`.
- `npm start -- -- --smoke-test` runs main-process startup then exits 0 — use it
  to verify boot without the UI. **Know what it does and does not prove
  (measured 2026-07-29):** it quits at `main/index.ts:832`, right after
  `startScheduledTasks`, so it covers DB init, workspace load, window creation,
  tray and scheduler — but the agent server and background builder are started
  by the *renderer* via `agentInfrastructure.start`, which it never reaches.
  `[AgentServer] Listening`, `[HostProcess] Agent server healthy` and
  `[BackgroundBuilder] Watching` therefore do **not** appear in a smoke run;
  an earlier version of this line claimed they were its success signals, which
  sent at least one session hunting a non-existent regression. To check the
  agent server itself, run the bundle directly:
  `COSCIENTIST_AGENT_CONFIG=<agent.json> COSCIENTIST_WORKSPACE=<dir>
  COSCIENTIST_AGENT_PORT=23288 node dist/agent-server.js`, then curl `/health`.
- `npx tsc --noEmit` must stay clean before committing.
- **Run tests with `npm test`, never bare `npx jest`.** The script is
  `ELECTRON_RUN_AS_NODE=1 electron node_modules/.bin/jest`, and the Electron ABI
  is the point: `better_sqlite3.node` is built for it. Under plain `npx jest`
  `fileMonitorIntegration` fails with `NODE_MODULE_VERSION 136 … requires 141`,
  which is an artifact of the wrong runner, not a real failure. **The old
  "245/246, only `fileMonitorIntegration` fails" baseline recorded throughout
  this file is stale and was measured that way** — under `npm test` the suite is
  fully green (592/592, 34 suites as of 2026-07-29).
- **Electron 37 ships Node 22.17; your shell's `node` is likely much newer.**
  `fs` semantics diverge between them, so measure platform behaviour with
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  not with `node`. Concretely: `fs.cpSync` of a directory onto a symlink throws
  `ERR_FS_CP_DIR_TO_NON_DIR` on Node 25 but **silently writes through the link**
  on 22.17 — a design premise was wrong for exactly this reason.
- Do NOT run `npm run package` for routine testing — production build only.
- **A packaged build launched headlessly will hang forever, and it is not a bug
  in your change.** Root-caused with `sample` on 2026-08-05: the main thread
  blocks in `SecKeychainFindGenericPassword` -> `CSSM_DecryptDataFinal` — Chromium's
  own OSCrypt keychain init, which runs *before* `app.whenReady()` and cannot be
  moved. Every freshly packaged, ad-hoc-signed binary carries a new signature, so
  macOS demands fresh Keychain authorization and waits for a click nobody makes.
  Same root cause as the auto-update TCC re-prompt in Known hazards. A real user
  double-clicking the app just dismisses the prompt. For measurement only, pass
  Chromium's `--use-mock-keychain`; no code change.
- Logs: `~/Library/Application Support/acabox/development/cobuilding.log`,
  plus the in-app Debug tab (command log + system log streams).
- To kill stray dev instances:
  `pkill -9 -f "Acabox/node_modules/electron"`. **Never while `npm test` is
  running** — jest runs inside that same Electron binary, so the pkill
  SIGKILLs the suite mid-run and the tail prints `[exited with code 0]`
  from the pipe, which reads as a pass. Measured 2026-09-18.

## Status (last updated 2026-10-12)

**Sonnet 5.5 and Haiku 5.5: SDK 0.3.280 → 0.3.296, and Acabox's own small
calls moved to Haiku 5.5 (2026-10-12).** Asked as "new Anthropic models are
out — should we update?"
- **Unlike Fable 5.1 and Opus 5.5, the old CLI did not refuse these models.
  It ran them, which made the problem quieter.** Measured on 2.1.280: both
  answered, but `modelUsage` said `costBasis: "unknown"` and
  `contextWindow: 200000` (the real window is 1M), and Haiku 5.5 was billed at
  a fallback rate about 20x its list price. So T10's fold-line and header
  dollars would have been wrong, and long chats would likely have compacted
  around 200K (inferred, not observed). Discovery had listed both since
  10-01 and 10-09, labelled "may need an Acabox update", which was true.
  **The lesson: a model that runs is not a model the CLI knows. Check
  `modelUsage.costBasis` is `list`, not just that a turn returns.**
- **Patch bump, all peers already satisfied** (checked before installing);
  `@modelcontextprotocol/sdk` verified still exactly 1.29.0; the binary is
  2.1.296. On it, all three of Sonnet 5.5, Haiku 5.5 and Opus 5.5 return
  `costBasis: "list"` and a 1M window. Haiku 5.5's cost matches list price to
  the cent, and the CLI's `outputFormat: json_schema` (file tagging's path)
  works on Haiku 5.5.
- **Roster:** Sonnet 5.5 and Haiku 5.5 are curated; Sonnet 5 and Haiku 4.5 step
  down to superseded (they must stay KNOWN, or discovery re-adds them as new).
  The default stays Opus 5.5. **Superseded ids now carry labels**
  (`supersededModelLabel`). Without them, a chat pinned to Haiku 4.5 showed its
  locked chip as the raw `claude-haiku-4-5`. A test caught this, and it was
  then seen fixed live. Exact ids only: unknown snapshot ids still show
  verbatim.
- **Background calls → Haiku 5.5** (`BACKGROUND_MODEL`, $0.10/$0.50 vs $1/$5):
  title generation, manifest metadata, the scanner's three direct classifiers
  and its tagging agent, plus the mini-app proxy's fallback. That is roughly
  10x cheaper, with no added calls.
  - **The trap is that Haiku 5.5 thinks by default**, and thinking counts
    toward `max_tokens`. Every one of these calls has a cap sized for the
    answer alone (10 for a YES/NO, 30 for a title), and every one read
    `content[0].text`, which is a thinking block on a thinking model. So the
    direct calls spread `BACKGROUND_REQUEST`: thinking off at effort `low`
    (`disabled` 400s at xhigh/max), which is how they ran on 4.5. Replies are
    read with `messageText()`, by block type.
  - The title cap went 30 → 40 and the briefing cap 300 → 400, because the
    tokenizer is about 30% denser: a real title used 19 of 30.
- **Proxy fallback:** a mini-app that names no model gets Haiku 5.5 with thinking
  off, since the docs taught `content[0].text`. A model the app names is passed
  through untouched. Docs now default to Haiku 5.5 and read the answer by type,
  and `bridge.ts`'s `AnthropicMessage` type now admits thinking blocks. esbuild
  doesn't typecheck, so old apps are unaffected.
- Verified: tsc clean; **2025/2025 across 150 suites** (+3); `--smoke-test`
  exits 0; `--smoke-test-mcp` PASS; the rebuilt bundle serves `/health`
  standalone. Real Haiku 5.5 calls in all four request shapes returned text-only
  replies, `end_turn`, about 1 s each. Live over CDP on `npm start`: the picker
  listed Sonnet 5.5 and Haiku 5.5 with no discovered extras. A real Haiku 5.5
  turn produced the pin `claude-haiku-5-5` and a title from the new path in
  0.9 s ("Volcano Plot RNA-seq Request"), and its result row is list-priced with
  a 1M window. The dev profile's stale Haiku 4.5 selection fell back to Opus 5.5.
- **Left alone:** `researchProfile.ts` and `calendarAgentSession.ts` run Sonnet
  4.6 through the CLI, which knows it; the `westernBlotAnnotator` template names
  `claude-opus-4-20250514`. Neither was part of this change. The second has
  fallen to the proxy default whenever discovery stops listing it.

## Status (2026-10-01)

**Review increment 1 shipped: the truth-week fixes and the owner's four
decisions (2026-10-01).** Twelve tickets from `docs/design/product-review-2026-09-30.md`,
written in `docs/design/review-increment-1-tickets.md`, implemented by Sonnet
agents in worktrees, reviewed, merged, and checked live over CDP on `npm start`.
Owner decisions taken: **Opus 5.5 is the default model** (cost: $4/$20 vs
$5/$25 — `DEFAULT_MODEL` in `shared/models.ts`); **folders writable by default,
a lock enforced**; **one name** ("I'm Acabox, built on Claude" — the old "Never
identify yourself as Claude" line is gone); **delete Quick Chat, Reactions and
the R/DESeq2 skills; Debug dev-only**.
- **Found during review, the most consequential bug of the batch: the user's
  custom instructions never reached a chat.** `workspace.directory_path` is `''`
  for every workspace (`createWorkspace` inserts it empty), so `agentSession`
  read `SOUL.md` relative to the main process's cwd. Production holds 8,000
  bytes of instructions the agent never saw. Now read from
  `containerService.getAgentDir()`; proven live with a planted codeword.
  **Anything else that joins `workspace.directory_path` is suspect** — the
  attachment translation in `sendMessage` does too, but it only ever receives
  workspace-relative paths, so it is dead rather than wrong (C16 deletes it).
- **Stop (T02):** `chat:stop` → `stopSession` → `session.stop()` POSTs the new
  agent-server `/sessions/:id/interrupt` (`queryInstance.interrupt()`), waits up
  to 4 s for the CLI's own result, then destroys. Measured live: the CLI answers
  in ~100 ms with `error_during_execution` / `terminal_reason: aborted_tools`,
  the host tags it `stopped_by: 'user'`, and there is no "blames the sandbox"
  reply. A turn still open at destroy gets a host `{subtype:'stopped'}` row;
  `cleanupOrphanTurnRows` became `closeOrphanTurn`, which **appends** a
  terminator instead of deleting (the next message after a Stop kept all 5
  rows; yesterday's run lost 4). Two follow-ups found live and fixed: the CLI
  records the interrupted tool as a rejection ("The user doesn't want to
  proceed…"), which counted as FAILED — the converter now drops it; and a live
  Stop read "Worked" because assistant-ui marks a run cancelled only when the
  generator throws an AbortError — `chatAdapter` now rethrows the runtime's
  reason for a user cancel (`renderer/userCancel.ts`; a detach keeps returning).
- **Cost (T10):** result rows carry `total_cost_usd`/`duration_api_ms`/
  `modelUsage`; fold line `· $0.14`, header `$3.40 so far`. **The rule is a delta
  across the WHOLE chat, not per run**: the SDK documents that "a resumed …
  session continues from the total its transcript saved", and every Acabox turn
  is a resumed query — confirmed live (a torn-down-and-resumed session continued
  $0.047 → $0.055 and the turn showed `<$0.01`). A drop is a restart; the first
  costed row after uncosted ones (older chats) shows no per-turn figure.
  `shared/turnCost.ts`. The stored `run_id` equals the chat id and is useless;
  harmless.
- **Lock (T05):** see Known hazards. Live: an Edit through the workspace link
  was refused with "File is in a directory that is denied by your permission
  settings"; the file was untouched.
- **Hooks (T04):** both PreToolUse hooks parse with `/usr/bin/plutil -extract …
  raw` (ships with every supported macOS; handles quotes, unicode, newlines and
  JSON null), jq only as a fallback, and **fail closed** (exit 2) on a payload
  they cannot read. Verified live: settings read and `pip install` both blocked.
- **Also shipped:** Files-tab Delete → "Move to Trash" behind a confirm, never
  on a root (T01, live: root refused, file trashed); scheduler clamps timers to
  2^31−1 ms and offers Daily/Weekly at a set time instead of a day-of-month
  step, repairs stale `running` rows at boot (T03); esbuild aliases react/
  react-dom to the npm-site copy (T06); API key verified on save
  (`shared/apiKeyCheck.ts`), never sent to the renderer — only `maskedKey`
  (T09); `SYNCED`/`~/workspace-data`/`AGENTS 0 LIVE` gone, chip STARTING/READY/
  OFFLINE from a real `agentAlive`/`gaveUp`, message and Home times parsed as UTC
  (live: history read 18:16 for an 11:16 message before), ⌘K focuses chat search
  (T11); Quick Chat + `processCpuMonitor` deleted, Debug hidden when packaged,
  Export logs moved to Settings (T07); Reactions vertical, `reaction`/
  `activity-summary`/`differential-expression` skills and the R template
  deleted, scheduling migration 8 (T08); one voice across ~150 strings, plain
  error headlines with Details (`main/userFacingError.ts`), `main/hostApps/`
  deleted (T12a/b).
- Verified: tsc clean; **2022/2022 across 150 suites**; `--smoke-test` exits 0;
  `--smoke-test-mcp` PASS. Live on the dev channel: every item above marked
  "live". **Not verified live:** the Opus 5.5 default on a fresh profile (the dev
  profile has Haiku stored), the key-check verdicts on save (would overwrite the
  dev key), the OFFLINE chip, and the build-failed/crash screens.
- **Known, not fixed:** the chat header title does not update when the title
  arrives (it shows `New chat` until navigation — pre-existing; the hint beside
  it is now at least consistent with it); ChromeBar polls every 10 s, so it reads
  STARTING for up to one poll after the agent is healthy; ModelSelector's effort
  help still says "uses your limits" (#34); `preBuilt` branches are dead code;
  agent-server still accepts the now-unused `additionalAllowedTools`. Two jest
  suites (`skillImporter`, `skillImportService`) hit live GitHub unauthenticated
  — nine parallel agents exhausted the 60/hour limit; they are not flaky, they
  are rate-limited.

## Status (2026-09-30)

**Product review against other chatbot and vibecoding platforms, for
non-technical scientists (2026-09-30).** Review only — no code changed. The
document is `docs/design/product-review-2026-09-30.md`; its evidence is
archived in `docs/design/review-2026-09-30/` (16 reader and research reports,
3 syntheses, the 36 adversarial verifier verdicts, the completeness critique,
12 screenshots and the five analysis/driver scripts — the production-DB copy
and the intermediate JSON were NOT committed). Method: eight code readers + a read-only production miner +
seven web researchers + a live CDP walkthrough of every screen on `npm start`,
then a three-lens synthesis → merge → one adversarial verifier per item →
completeness critic. **The verifiers corrected about a third of the items, so
read the document, not any earlier draft's claims.** NOT done: no scientific
task was run end to end in the live app (the dev workspace had no shared
folders), no fresh-Mac install, no packaged build, no hands-on competitor use.
- **Verified live:** pressing Stop destroys the session, the model keeps
  talking during the kill grace and blames a nonexistent sandbox, the UI shows
  it as a finished turn, and the next message's `cleanupOrphanTurnRows`
  deletes the rows (production: 237 rows on one Stop). **Code reading says
  `destroy()` severs the SSE synchronously, so that reply should never have
  rendered; it did — the ingress is unmeasured. Measure before guarding.** A
  render-time mini-app crash is a blank pane under IDLE: the scaffold boundary
  renders null and the host tracks build errors only. `error-capture.ts` DOES
  buffer errors and `ErrorDisplay` replays them, so the dev overlay most likely
  crashed itself — lucide-react against a nested React copy in the dev
  npm-site; `--alias:react` / `--alias:react-dom` in `miniAppBuilder.ts` is the
  two-line fix. The agent has no `AskUserQuestion` (no `canUseTool`), and
  unlisted tools are DENIED on SDK 0.3.280 — the `agentAllowedTools.ts:12-16`
  comment and the 2026-07-28 "allowedTools: [] still ran Bash" measurement are
  stale. ⌘K only switches to Chats. Home "Jump back in" parses zone-less SQLite
  timestamps as local (`CommandDesk.tsx:171`; `dateFromSessionStoredAt` exists
  and is unused there), and `historyMessageConverter.ts:94,169` do the same
  for message times, so bubble times and day separators are very likely off
  too. `SYNCED` in the rail is a literal; `HEALTHY` is `startedFlag`, and
  `waitForAgent` trusts the same flag for five minutes.
- **Found by code reading, not yet seen live:** Files-tab Delete is `rm -rf`
  with no confirm and a hover icon on shared-folder roots (`FilesTab.tsx:368-371`,
  `fileHandlers.ts:323`). **Every shared folder is read-only by default** —
  `workspaceRepository.ts:63` declares `readOnly = true` and both callers omit
  it — so "enforce the lock" would refuse edits in every folder a user shares;
  decide the default first. **Both PreToolUse hooks need `jq`**
  (`block-host-installs.sh:23`, `block-secret-reads.sh:29`), which ships only
  on macOS 15+: on 13/14 the install guard and the secret-read guard are
  silently inert. **Scheduler: an interval of 25–31 days** (`validateInterval`
  allows 31) overflows `setTimeout` (`scheduler.ts:43`, no clamp), so the run
  fires at once, re-arms on the same far date and loops full Opus-high turns
  until quit — latent (0 tasks exist) but the only unbounded bill in the
  product. "Every N days" emits `0 0 */N * *`, a day-of-month step (Oct 29 →
  **Nov 1**). The Reactions `*/15` system task is NOT a live cost — no shipped
  build ever had a UI that sets its flag — but `ReactionsToolView` is reachable
  via the chat-invoked `create_reaction_thread` relay and dead-ends at "Enable
  in Settings → Reactions", a section that does not exist. `auth:getApiKey`
  returns the plaintext key over IPC. `OutputFileList`'s Download works only
  for `type === 'text'` (CSV/XLSX/PDF/images silently no-op). The dev pip wave
  logs exit 1 on every boot with every package satisfied — readiness is
  in-memory, so re-running is by design — and the real FAILED→QUEUED loop
  trigger is `readAppDeps` using the raw spec as a package's identity while
  `parsePipLine` stops at `<>=!~`.
- **Production data (nine weeks, 56 chats):** 19 "any update?" nudges and
  ~56 h stalled across 8 incidents — a product manager's Devin/Hex workload,
  i.e. work that ran elsewhere, not a bench scientist's; 386 dead
  `task_notification` events in 5 days; scheduler 0 tasks / 0 runs. Cost is
  received on every SDK result (cumulative per `query()`) and dropped at
  `agentSession.ts:1328-1332`; estimated ≈$2,750 spent with nothing shown; 40
  of the last 73 sessions at `max`. **Lead not followed: the CLI transcripts
  hold 142 `cost-state` lines carrying `totalCostUSD` — if cumulative, real
  per-chat cost history already exists on disk.** At list price the pinned
  default Opus 5 ($5/$25) costs 25% more per token than Opus 5.5 ($4/$20), yet
  all 23 fallback blocks and both hard refusals were in Opus 5.5 chats — a
  coupled decision, not a free move. 14 tools, 7 published within hours, 3
  ever re-run as host jobs; every notebook is the untouched scaffold (the
  notebook FILE works as each tool's state store; the kernel never ran). The
  fold hid prose in 0 of 305 turns — the inferred "fold trap" is not real.
  **`mcp__knowledge__record_finding` IS volunteered (134 calls)** — the
  2026-07-29 "NOT verified" line is stale. The empty-state chips are
  hard-coded, not profile-seeded (the Phase B entry is stale). `ContainerTests`
  is unmounted, so the hazard about it below is stale too.
- **Stock Mac (expected, not reproduced):** the scaffold needs `node` and the
  "already installed" React packages need `npm`; neither ships and nothing
  seeds them (`nodeSetup.ts:9`). Launch execs `python3` from PATH
  (`AgentInfrastructureController.ts:550`); the CLT stub's installer dialog is
  Apple's documented behaviour and was never observed here; `userActionable`
  has no consumer. The eager venv bootstrap is recorded as deliberate above —
  guard the probe, do not defer the bootstrap. "Right-click → Open" is stale
  for macOS 15+ (Open Anyway in System Settings); release notes are the
  version string (`release.mjs:144`).
- **Dead weight the simplify rule applies to:** ~10,000 unreachable renderer
  lines (28 files by import walk from the forge entries) + 2,618 in
  `prebuilt-apps/grantFinder` + ~1,200 backend lines and 31 IPC handlers for
  the calendar; `processCpuMonitor.ts` (Podman VM watchdog, `ps -eo` every 60 s,
  ~140 false warnings per 5 days); Quick Chat on a global `Alt+Shift+A` that
  hijacks typing Å; the `.docx` → Word branch plus a throwing dropped overlay
  call (`renderer/index.tsx:758-765`) — deleting that branch alone makes
  `.docx` render as mojibake in a `<pre>`, so pair it with a viewer.
  `coscientistAnalytics.ts` stays (recorded keep). Three proposed removals
  reverse recorded decisions and are listed as owner calls, not cleanup:
  Knowledge out of the rail (`skills-knowledge-loop.md:487`, "Settled"), the
  status bar's hardware stats (Home handoff), hosted servers under Settings
  (`mcp-hosting.md`).
- The CDP driving recipe is in the project memory (`driving-dev-app-over-cdp`).

## Status (earlier on 2026-09-28)

**Chat lists re-sort when a turn runs, not only when a chat is created
(2026-09-28).** Reported as "chats attached to an app don't appear in Recents"
— the user's latest chat, "Traffic based on knowledge" (a tool chat), was
missing from the rail.
- **Not app-specific, and the data showed it.** In the production DB that chat
  WAS first by `updated_at` (`insertMessage` stamps it on every row). The
  renderer lists (rail Recents, Home's "Jump back in", the Chats page) re-read
  only on `sessions:changed`, which fired on create, rename, delete, title and
  `findForApp`/`createForApp`, never on a turn in an existing chat. The last
  one that day was the title of a chat created at 18:26 UTC. Every turn after
  it (Traffic 21:20–21:41, Agent Bug 20:51–21:38) moved the DB and not the
  screen, and the rail matched the 18:26 order exactly. Tool chats show it
  most because they are the ones people keep returning to. A new chat always
  looked right, because its title generation broadcasts.
- **Fix: `onChatTurnBoundary` in `main/chatActivity.ts`**, fired by
  `noteTurnStarted`/`noteTurnEnded` and nothing else; main answers with
  `notifySessionsChanged()`. `agentSession.ts` writes the user row just before
  a turn starts and the result row just before it ends, so these are exactly
  the moments the sort key moves. It is kept separate from
  `onChatActivityChanged`, which also fires when a chat is merely read.
  `chatActivityWiring.test.ts` pins both the subscription and "user row before
  announcement" (otherwise the lists would re-read stale).
- **A mid-turn broadcast is safe for the chat that is streaming**, checked
  rather than assumed. `sendMessage` claims the preload's `activeStreams` slot
  synchronously, so `useSessionSubscription`'s re-subscribe on
  `sessions:changed` defers to it. Title generation already fires this same
  broadcast mid-first-turn in every new chat.
- **Cost: zero model calls.** Two broadcasts per turn; each re-reads the
  sessions list, previews (4 ms), activity, and the thread list (debounced
  500 ms).
- Verified: tsc clean; **1890/1890 across 132 suites** (+7; the three positive
  boundary cases proven non-vacuous by deleting the emits); smoke exits 0.
  Live over CDP on `npm start`: a real turn sent into an app chat
  (`linkProbeTool`, last active 09-18, not in the top 5) put it **first in the
  rail's Recents at the first 250 ms sample**, i.e. at turn start and not at
  the reply. It stayed first through turn-complete, and the Chats page
  re-sorted with it. DB: `user → assistant "OK" → result`.
- **Seen, not changed:** the Chats page sorts by last activity, but each row's
  date is the chat's `createdAt`, so a chat that just moved to the top can
  read "1 week ago". Home's "Jump back in" uses `updated_at`.

**Chat search reads message text, and the Chats page stopped copying every
chat into the renderer (2026-09-28).** Asked for as "we only search titles —
what if we searched content?". Design + tickets + measurements in
`docs/design/chat-search.md`; the decisions (prose only, up to 3 lines per
chat, titles ranked first) were the user's.
- **The preview loader was the bigger defect.** Each Chats row called
  `listMessages` — the chat's WHOLE history — to keep 120 characters, and the
  list is not virtualized: **84.8 MB** crossed IPC per app run on the
  production DB. Now one `sessions:previews` query: 4 ms, 13 KB.
  `renderer/chatPreviewStore.ts`, re-read on `sessions:changed`.
- **Prose only, measured, not assumed.** Of the production DB's 77 MB of
  message text, what people typed plus Claude's written replies is 1.5 MB;
  tool output is 43 MB and thinking blocks 22 MB (of which 22.15 MB is
  encrypted signature). `result` rows are NOT indexed: all 248 non-empty ones
  duplicate an assistant text block, so every answer would match twice.
- **`message_prose` (FTS5, trigram tokenizer, migration 33) is written ONLY by
  triggers on `messages`** — insert, delete, update — so chat delete, hard
  reset, orphan cleanup and the overflow repair cannot forget it. Verified in
  real SQLite that the delete trigger fires on the `sessions` ON DELETE
  CASCADE. The extraction SQL exists once (`proseExpr` in
  `main/db/messageProse.ts`). Trigram = case-insensitive substring, like the
  old filter; `MATCH` needs 3+ characters, so 1-2 char queries fall back to a
  `LIKE` scan of the prose (7.6 ms on production).
- **Search runs in main** (`main/db/chatSearch.ts`, `sessions:searchProse`):
  up to 3 most recent hits per chat plus a total, snippets cut by
  `shared/proseSnippet.ts`. The renderer ranks (`chatSearchRank.ts`: title
  matches first, then list order) and renders via
  `ThreadListPrimitive.ItemByIndex`. The agent's `list_chats(query)` now
  matches message text through the same clause.
- **Found live, not by tests:** a snippet centred on the match still hid it,
  because a row ellipsizes at ~95 chars while the window was 160 — "…(same as
  the dat…". Snippets now open ~40 chars before the match.
  **And: a hidden Electron window stretches a 150 ms timer to ~1.1 s**, which
  made the debounced search look broken under CDP. Measure UI timing with
  `--disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows` (measurement only).
- **Visible side effect:** 38 of 50 production previews now show a `CS: …`
  half. The old loader looked only at a chat's first assistant ROW, which is
  usually thinking or a tool call, so it showed nothing; the new query takes
  the first assistant row that has prose. That was the preview's evident
  intent.
- **Cost: zero model calls.** Production migration: 138 ms, +4.1 MB.
- Verified: tsc clean; **1883/1883 across 132 suites** (+22, 5 new suites);
  smoke exits 0; the real migration run on a copy of the production DB; then
  live over CDP on `npm start`: title-then-prose ranking, 3 hit lines with
  `+5 MORE`, the "No chats mention" state, a 2-char query, every highlighted
  match inside the visible part of its line, a hit click opening its chat, and
  hits on screen 188 ms after the keystroke.
- **Known gap, stated to the user:** their own example, "KII", returns nothing.
  In production it appears in no title and no prose, only inside a document
  Claude read (tool output) and as noise in thinking signatures. Tool output
  was deliberately excluded (+73 MB, noisy).
- **Not built: jump-to-message.** The API already returns each hit's
  `messageId`. What makes it real work: the history converter drops DB row ids
  and merges a turn into one message; folded narration is unmounted, not
  hidden (all three live hits in the test chat sat inside a collapsed "Worked
  for" fold, where ⌘F cannot see them); and the thread scrolls to the bottom
  on open.

## Status (earlier on 2026-09-25)

**Copy button on the file view (2026-09-25).** Asked for as "files can be very
long — add a Copy button at the top like Claude Code has". It sits at the right
of the sticky file header, facing Back, so it stays on screen at any scroll
depth. It copies the file **as it is on disk** — markdown source even in
Rendered mode, since pasting into a chat or editor wants the markup. Absent for
images, PDFs, spreadsheets and too-large files (no dead button). The text comes
from `FileViewer`'s own read via `onCopyableText`, so nothing is read twice;
the rule is `copyableText` in `fileViewers/CopyFileButton.tsx`.
- **Found and fixed alongside:** `FileViewer` had no `.catch` on `readFile`,
  so a refused read (a chat link to a path outside the shared folders) showed
  "Loading..." forever. It now shows "Couldn't open this file." with the
  reason. In dev the same rejection raised webpack's full-window error overlay
  (`#webpack-dev-server-client-overlay`, z-index max), which silently ate every
  click — **if a CDP click does nothing in dev, hit-test for that iframe first.**
- Verified: tsc clean; **1840/1840 across 127 suites** (+7, 1 new suite);
  smoke exits 0. Live on `npm start` with a real mouse click: the clipboard held
  the file byte-for-byte (15,417 chars vs the file on disk), the label went
  Copied → Copy after 1.5 s, the button stayed at the top after scrolling to the
  end, a PNG showed no button, and a refused path showed its error.
- Cost: zero model calls.

## Status (earlier on 2026-09-23)

**Settings → Claude Design: a sign-in so chats can reach claude.ai/design
(2026-09-23).** Built by the in-app agent on branch `claude-design-sign-in`
(chat `d844d9ff…`), reviewed and fixed here. The SDK already ships a
`DesignSync` tool; it answered "needs design-system authorization" forever,
because the credential comes from `/design-login`, a slash command headless
sessions cannot type.
- **Mechanism: the CLI's hidden `claude design-login --json [--status]`**,
  built for the VS Code extension. Read out of the 2.1.280 binary, not
  guessed: `--status` prints `{available, signed_in, can_sign_in_here}`; the
  flow prints `{"event":"pages",url,manual_url,manual_first}` then
  `{"event":"done",ok}`, and takes a pasted `{"code":"<code>#<state>"}` on
  stdin. The credential lands in secure storage keyed by `CLAUDE_CONFIG_DIR`,
  so it is spawned with `getClaudeConfigDir()` — the exact string the agent
  server passes as `COSCIENTIST_CLAUDE_CONFIG_DIR`; any other value mints a
  credential no chat sees. The CLI refuses when `CLAUDECODE` /
  `CLAUDE_CODE_CHILD_SESSION` are set (an Acabox started from a Claude Code
  terminal inherits both), hence `DESIGN_LOGIN_ENV_STRIP`. Pure protocol in
  `shared/claudeDesign.ts`, spawn/relay in `main/claudeDesignLogin.ts`.
- **Three review fixes.** (1) It added a second `will-quit` listener;
  `handleWillQuit` is the sole one by design, so cancel is now an
  `appTeardown` step. (2) The status was read at mount — Settings mounts at
  boot behind `display:none`, so every launch spawned the CLI and read the
  keychain, then showed that snapshot forever (the API-proxy-banner bug). Now
  read on arrival via `active`, pinned by a render test proven red on the old
  code. (3) Inline styles on nonexistent tokens (`--border-color`,
  `--error-color`, `#555`) replaced with `connectorField__input` /
  `wsSettings__dirError`.
- **`DesignSync` is NOT in the auto-approved tools.** Reads should work
  without it; writes publish into the org's shared design projects and the
  tool asks for approval, which Acabox has no prompt to answer — so writes may
  be refused. One line in `agentAllowedTools.ts` if that is wanted.
- **Cost: zero model calls.** The status check is a 0.45 s CLI spawn.
- Verified: tsc clean; **1833/1833 across 126 suites** (+18, 2 new suites);
  smoke exits 0. Live on `npm start`: before Settings was visited the section
  read "Checking…" (no spawn); on arrival it showed "Not signed in" with an
  enabled Sign in, from the real binary via the real main process. The
  in-app agent had started a real flow against a throwaway config dir and
  seen the https sign-in page event.
- **NOT verified: a completed sign-in, and a chat then reading a project** —
  needs the user's browser and claude.ai account. Also unknown: whether a live
  session picks up a fresh credential or needs a new chat. **Acceptance test:
  Settings → Claude Design → Sign in, approve in the browser, open a NEW chat,
  ask it to list your Claude Design projects.**

**Chats show when they are working and when they have news you haven't seen
(2026-09-23).** Asked for from a screenshot of a tool's chat switcher: "some are
actively streaming — we need an unread indicator, a simple way to track what
has and hasn't been read, and a sign a chat is active". The three design calls
were the user's: read = on screen AND Acabox focused; the sidebar keeps its
total and adds a dot (`Chats • 45`); working = the pulsing amber dot.
- **Two states, never merged.** ACTIVE = a turn in flight, live only (no turn
  survives the app, so a fresh process correctly shows none). UNREAD = a turn
  ENDED while nobody was looking, persisted in `sessions.unread` (migration 32)
  so a reply that landed overnight is still flagged after a restart. Working
  outranks unread on a row. One flag, not a read cursor: nothing in the thread
  knows how far someone has scrolled.
- **`main/chatActivity.ts` is fed from the one place turn state changes** —
  `agentSession.ts`'s three `turnInProgress` writes, plus `emitError` and
  `destroy()` (an error or a mid-turn teardown never reaches a result row, and
  would otherwise pulse "working" forever). `emitError` deliberately does NOT
  clear `turnInProgress` itself; the registry's deferred-destroy logic reads
  it. `chatActivityWiring.test.ts` pins every write to its announcement.
- **"Looking" has two halves and each comes from the only side that knows.**
  The renderer reports which conversation is on screen (`ChatViewingReporter`,
  mounted in the Chats page and the tool side panel with a real `visible`
  prop — every tab stays mounted behind `display:none`, so subscribers cannot
  answer this). Main observes focus from its own BrowserWindow events. The
  renderer registry is KEYED by surface: switching surfaces fires one's
  "hidden" and the other's "shown" in an order React does not promise, and
  last-writer-wins would sometimes land on null with a chat plainly on screen.
- **Unread is limited to `source IS NULL`** — the set the Chats list shows. A
  flag on a row no list renders would still light the sidebar dot, pointing at
  a chat nobody can find. Scheduled-task runs with no `session_source` DO show
  in the list, so they get marked, which is the point.
- **Surfaces, all one `ChatMarkDot` over one store** (`renderer/chatActivityStore.ts`,
  pushed from main, re-read on `sessions:changed`): the tool chat switcher, the
  Chats page, Home's "Jump back in", the rail's Recents, the rail's Chats entry,
  and the tool panel's collapsed strip (replacing its private `UnreadWatcher`
  state, lost on reload). No bold-for-unread in the switcher: bold already means
  "the chat you are on" there, and one style with two meanings is exactly what
  the sidebar count was kept free of.
- **The old "running" dot was wrong twice and is gone.** `sessions:runningIds`
  asked `isRunning` (does an agent session OBJECT exist) — true for up to 60 s
  after a turn while the renderer holds its subscription — and was only sampled
  when the thread list re-fetched. The status bar's `AGENTS N LIVE` read the
  same predicate on a 5 s poll; it now reads the store and stays hidden until
  main has answered once, rather than showing a made-up 0.
- **Cost: zero model calls.**
- Verified: tsc clean; **1815/1815 across 124 suites** (+26, 3 new suites; the
  focus rule and the keyed registry each proven non-vacuous by mutation — two
  and one cases go red respectively); smoke exits 0. Live over CDP on
  `npm start`, real Haiku turns: a reply that landed while on Home showed amber
  on the Home row and rail recents with `AGENTS 1 LIVE`, then blue with DB
  `unread=1` and `Chats • 45`; opening it cleared the row, the DB and the
  sidebar dot. Focus rule end to end: the chat on screen with **Finder**
  frontmost when the reply landed → `unread=1`; bringing Acabox forward cleared
  it. Tool panel: collapsed mid-turn, the strip went amber then blue; the
  switcher from the original screenshot showed amber while running, blue once
  finished, the quiet row empty but aligned. Switcher and rail screenshotted.
- **A false alarm worth recording.** The tool-panel "expand reads it" step
  failed once, and temporary logging showed the main window losing key status
  with Acabox still frontmost. It was the user's PRODUCTION Acabox (pid 17021,
  named "Acabox" in System Events — the dev build registers as "Electron"),
  in use during the test. The rule behaved correctly: that window was not
  focused. A real blur→focus cycle then cleared it. **When verifying focus
  behaviour, check `frontmost` by PID, not by the name "Acabox".**
- **NOT verified in one uninterrupted run:** "expanding the tool panel reads
  the chat". Its renderer half was observed (`setViewing <that id>` on expand)
  and main's clear-on-focus path was observed in the Finder scenario; they were
  never seen together because the dev window kept losing focus to the real app.
  Also unverified: the packaged build, and a production database migrating to
  32 (the dev channel migrated cleanly).

**A tool's chat can now pick its model, and a pinned chat says so (2026-09-23).**
Reported as "when chats are attached to an app, even when I start a new chat, I
can no longer change the model".
- **It was two different things wearing one symptom, and only one was a
  missing control.** `ModelSelector` is mounted solely in the docked
  `GlobalComposer`, which `index.tsx` hides in mini-app detail view — so a chat
  started from a tool's side panel silently took whatever `getSelectedModel()`
  last returned, with no picker on screen. The harness never had a problem
  with it: `chatAdapter.ts` already falls back to the stored selection.
- **The second half is deliberate and was simply never stated.** Model and
  effort are pinned to a conversation on its FIRST turn (`setSessionModelInfo`,
  a write-once `WHERE model IS NULL`) and `chat:send` prefers the pin over the
  picker. Until now the picker stayed fully interactive in a pinned chat, so
  choosing a model there changed a global default and did nothing at all to the
  conversation in front of you — which is what made a settled pin read as a
  broken control. It now renders as a locked chip naming what the chat runs on:
  *"This chat runs on Opus 5.5 · High, fixed when it started. Start a new chat
  to use a different model."*
- **The picker went in the panel HEADER, not the panel composer.** Row two
  already carried the static `MODEL · EFFORT` line, so the control replaces the
  label it duplicated instead of crowding a 320px composer row that already
  holds screenshot, dictation and send. Styled through
  `.cdSidePanel__meta .modelSelectorTrigger` — chained, so it cannot lose a
  specificity tie to `commandDesk.css`'s `.cdComposerField` restyle of the same
  shared class, whichever order the sheets import in.
- **A resolved snapshot id is shown verbatim, never renamed to the nearest
  roster entry.** The pin records what the SDK's `init` event resolved, which
  can be a dated id the picker has never heard of (`claude-sonnet-5-20260801`);
  `formatModelLabel` falls through to the raw string so the chip cannot claim a
  model the chat is not running. Found by a test using a realistic id.
- Verified: tsc clean; **1789/1789 across 121 suites** (+11, 2 new suites);
  then live over CDP on `npm start`. In the tool side panel the header row
  opened the real picker, listed all six models and committed **Haiku 4.5**;
  a real turn sent from the panel composer stored `model=claude-haiku-4-5,
  effort=high` (the SDK's own thinking signature carries
  `claude-haiku-4-5-20251001`, so Haiku is what actually ran) and the agent
  replied `PANELMODEL OK`. The chip then **locked**; `+ New chat` unlocked it;
  and an older conversation pinned to Opus 5.5 showed the locked chip in the
  docked composer with the matching DB row. Both surfaces screenshotted.
- **Cost: zero extra model calls** — the pin is read from a row the chat
  surfaces already fetch.
- **NOT changed:** `ChatHeader`'s own `MODEL · EFFORT` line, which still renders
  nothing for a pre-pinning chat while the picker beside it shows the live
  selection that such a chat would actually use.

## Status (last updated 2026-09-22)

**Screenshot button in both composers: one click inside Acabox, a picker click
outside it, no permission (2026-09-22).** Asked for as "a button that takes a
screenshot and appends it as context — ideally anything on my desktop". The
design was the user's pick after three rounds: no Screen Recording grant.
- **The gesture.** The button lays a clear sheet over every display
  (crosshair, faint tint, the Acabox window outlined "ACABOX · INSTANT"). Drag
  or click inside Acabox -> our own `capturePage`, instant. Drag or click
  anywhere else -> the macOS system picker; "Share Entire Screen" and the box is
  cropped out of the frame, or pick a window and get the whole window. Esc or
  right-click cancels. The image lands as an ordinary composer attachment;
  nothing sends by itself. Pure rules in `shared/screenshot.ts`, glue in
  `main/screenshotHost.ts` + `renderer/screenshotGrab.ts`, sheet page
  `renderer/screenshot-overlay-*` (its own forge entry).
- **Why no permission.** Direct capture of other apps needs Screen Recording,
  which TCC keys to our ad-hoc signature, so it would lapse at every update.
  `setDisplayMediaRequestHandler(…, {useSystemPicker: true})` uses
  ScreenCaptureKit's picker, where the click IS the consent. **Measured with a
  fresh bundle id launched through LaunchServices** (launching from a terminal
  makes the terminal the responsible process, and ours already had the grant):
  `getMediaAccessStatus('screen')` read `denied` before and after, and a full
  3456x2234 frame of real screen content came back. macOS 15+ only; below that
  our fallback handler runs and the user is told so.
- **`getDisplayMedia` is called from MAIN via `executeJavaScript(…, true)`**
  — it needs transient activation, and the button click's has expired by the
  time a box is drawn. Chromium abandons the picker after ~10 s
  ("Timeout starting video source"), surfaced as "try again".
- **Four macOS surprises, all measured, all now in code comments:**
  (1) `setVisibleOnAllWorkspaces({visibleOnFullScreen})` deactivates the app
  unless given `skipTransformProcessType: true` — Esc then went to whatever
  app was behind. (2) Windows at the menu-bar level or higher
  (`screen-saver` included) were kept OFF SCREEN (CGWindowList
  `onscreen=false`, even as the front app) partway through the session, having
  worked earlier; the sheet uses `modal-panel`, which rendered throughout, and
  so sits under the menu bar and Dock. (3) The window server placed windows
  lower than requested (sheet asked y=33, drawn at 80; the main window reported
  53, drawn at ~79) while Electron AND Accessibility both reported the
  requested frame — so NO coordinate is trusted: the sheet calibrates its
  origin on the first pointer event against `screen.getCursorScreenPoint()`,
  and the button press does the same for the main window (a keyboard press
  falls back to `getContentBounds()`). (4) A destroyed sheet does not return
  key status, so every second capture needed two clicks; main now refocuses
  the window after the sheet and after the picker. The picker's first frames
  are 556 px thumbnails; `screenshotGrab` waits for a full-size frame + 250 ms.
- **Cost: zero extra model calls.** Captures are capped at 3.5 MP
  (`MAX_SCREENSHOT_PIXELS`), about what the API downscales to anyway, which
  also keeps a Retina full-screen grab under the image adapter's 7 MB inline
  ceiling (otherwise it would become a file path the agent must Read).
- Verified: tsc clean; **1778/1778 across 119 suites** (+20, 1 new suite, one
  of which caught a real bug: at 1% tolerance a 1400x900 window read as the
  laptop screen); smoke exits 0. Live on `npm start`, real mouse events: a drag
  around a tool card cropped to it within 1 pt of its DOM rect (after the
  calibration fix; before it, 28 pt off); click-inside gave the whole window at
  2366x1479 (fitted from 2880x1800); drag over another app + "Share Entire
  Screen" gave exactly that 126x370 pt region at 2x; a window picked in the
  picker; Esc cancelled with nothing attached; picker timeout message shown;
  and a real turn with two screenshots — the agent described both correctly.
- **NOT verified:** the packaged build; Acabox itself in native full screen;
  a display arranged side by side where "Share Entire Screen" may pick the
  other display (the crop then refuses and attaches the whole frame, by
  design). In the measured condition a 47 pt strip under the menu bar is not
  covered by the sheet, so a drag starting there reaches the app beneath.

**A turn's steps now collapse; a finished turn folds to one line (2026-09-22).**
Asked for as "every step has its own box and it takes up a lot of vertical
space — I want to know what it's doing right now, and the rest only when I go
looking". Option C of three proposed, the user's pick.
- **The layout.** While a turn runs, Claude's narration stays visible and every
  run of consecutive tool calls between two pieces of prose is ONE line:
  `Ran 3 commands, wrote 2 files` — or, while a step is in flight, that step's
  name, target and a ticking clock. When the turn ends, everything before the
  final answer folds behind `Worked for 4m 12s · 26 steps`; opening it restores
  the running layout, and opening a step line shows its steps as flat rows
  (no borders — boxing each one was exactly the weight being removed).
- **Two things never fold.** Results — the mini-app open/build cards, plan
  prompts, and the LAST task checklist (earlier ones are superseded snapshots,
  so they fold with the steps) — stay in view. Failures are counted in red on
  whichever line hides them, and a step group with a failure opens itself.
- **`assistant-ui` was already grouping tool calls and we were throwing it
  away**: our `ToolGroup` slot was `<>{children}</>`. It is deleted rather
  than filled in, because the fold has to split a message AT AN INDEX (work
  before the answer, answer after) and the library's grouping has no notion of
  that. `turn-steps.tsx` renders parts one by one through
  `MessagePrimitive.PartByIndex`; every decision it makes lives in pure
  `turnSteps.ts` (segmenting, outcome rules, failure rule, final-answer start,
  summary phrasing), because the React half cannot be imported under jest.
- **The selector copies no `text` or `args`.** It runs on every streamed token
  for every mounted message and a Write's args can be a 75 KB file, so it
  passes precomputed `blank`/`install` flags, and returns a JSON string so
  `useSyncExternalStore` sees a stable primitive (a fresh array would loop).
  Only the one running step reads its own arguments.
- **"Worked for" is measured, never estimated.** Live: `chatAdapter` yields
  `metadata.custom.workedMs` at turn-complete from the start time it already
  held. Reload: `historyMessageConverter` computes user row -> last row of the
  turn (the `result` row, which it previously skipped). Either timestamp missing
  -> the label reads `Worked · N steps`, no guessed number. Differences only, so
  SQLite's zone-less timestamps cancel out. The message meta line dropped its
  `N TOOL CALLS` segment, now said by the fold.
- Verified: tsc clean; **1758/1758 across 118 suites** (+24: 21 layout cases,
  3 duration cases); smoke exits 0. Live over CDP on `npm start`: a 16-step
  history chat folded to `Worked for 3m 24s · 16 steps` with `3 FAILED` in red
  and only its last checklist in view; opened, it showed 11 one-line groups
  between the narration with the three failing groups already open as red flat
  rows. A real live turn sampled every 900 ms: `bash sleep 6` with the clock
  ticking 0S -> 5S, collapsing to `Ran 1 command · 1 STEP` when it finished,
  **zero** boxed cards at any sample, then `Worked for 18s · 4 steps` above
  `DONE` the moment the turn ended.
- **Cosmetic, left:** for the instant a call's arguments are still streaming the
  running line reads `bash 0S` with no target. The tool-card fallback for
  `TodoWrite` in history rows still shows an empty `todo` row — pre-existing,
  unchanged here.

## Status (earlier on 2026-09-22)

**Opus 5.5: discovery found it, the CLI refused it, SDK 0.3.273 -> 0.3.280 fixed
it (2026-09-22).** Asked as "do we need to update Acabox to get Opus 5.5, and
can we avoid that in future?"
- **The auto-discovery built on 09-16 worked exactly as designed, and that is
  what exposed the gap.** `claude-opus-5-5` appeared in `GET /v1/models` at
  10:00 and `mergeModels` put it at the top of the picker with no code change,
  labelled "New from Anthropic — may need an Acabox update". The user selected
  it. **That label turned out to be literally true**, which is the whole
  finding: discovery proves a model EXISTS, never that this build can RUN it.
- **Measured, not assumed, with a two-model control.** A direct `query()` against
  the shipped SDK: `claude-opus-5` -> `PONG`; `claude-opus-5-5` ->
  `400 Claude Code 2.1.273 does not support this model; version 2.1.280 or
  newer is required`. Same build, same key, same prompt — so the gate is the
  CLI version and nothing else, exactly as the Known hazard predicted.
- **The SDK's minor tracks the CLI's patch: 0.3.N bundles Claude Code 2.1.N.**
  Confirmed by reading `manifest.json` out of the 0.3.280 tarball before
  installing (`version: 2.1.280`, built 2026-09-21) rather than inferring it
  from the numbering. That mapping is how to pick the target version next time:
  the 400 names the CLI version it wants, so ask for that same N.
- **A patch bump, and all three peers already satisfied it** (`@anthropic-ai/sdk
  >=0.93.0` vs our 0.126.0, `@modelcontextprotocol/sdk ^1.29.0` vs our exact
  1.29.0, `zod ^4.0.0` vs our 4.3.6) — checked BEFORE installing, which is why
  this took one command where 0.2 -> 0.3 took an afternoon. **`@modelcontextprotocol/sdk`
  verified still exactly 1.29.0 afterwards**, the thing this file warns a bump
  can move silently.
- **The default model deliberately did NOT move to Opus 5.5.** The default is
  what every new chat costs and nobody chose it; auto-jumping on release is the
  exact behaviour `shared/models.ts` rules out. Recorded at the `DEFAULT_MODEL`
  declaration so the next person does not "fix" it.
- **The answer to "without an update" is no, and the reason is worth keeping.**
  The refusal is server-side, keyed on the version string the CLI sends, so
  there is no client flag to set. The only real alternative is shipping a newer
  CLI without shipping the app — the SDK does expose
  `pathToClaudeCodeExecutable`, so Acabox could fetch one into userData — but
  that is a ~212 MB signed binary that runs with the user's API key and full
  Bash, and its protocol is only tested against its own SDK build. Acabox
  already auto-updates, and the app download is the same order of magnitude, so
  a second update channel buys turnaround time and duplicates the risk.
  **The gate is CHAT-only** — mini-apps reach Opus 5.5 today, no update, because
  they call the API through the proxy with no CLI in the path.
- Verified: tsc clean; **1734/1734 across 117 suites**; `--smoke-test` exits 0
  and `--smoke-test-mcp` **PASSes**; the rebuilt `dist/agent-server.js` boots
  standalone under Electron's own Node and serves `/health`. Real turns on the
  new CLI: **`claude-opus-5-5` -> PONG**, plus `claude-opus-5` and
  `claude-fable-5-1` as regressions, all three `is_error=false`.

## Status (last updated 2026-09-21)
**The first message after a gap no longer vanishes (2026-09-21).** Reported as
"I send a message, it shows thinking, then that disappears and I have to
re-prompt". Found in the production DB **eight times** between 09-17 and 09-21,
the same shape every time — including one real request swallowed and not
re-sent for 34 minutes.
- **What it was, read from the SDK transcripts, not inferred.** The previous
  turn had started a background Bash command (the Devin pollers). Acabox tears
  the CLI down after every turn, which orphans it; on the next resume the CLI
  queues ITSELF a `<task-notification>` about it and dequeues that as a turn's
  prompt **9–18 ms before the user's text reaches the queue**. That turn makes
  no API call (zero `assistant` lines in every one of the eight) and ends
  `{"subtype":"success","result":"","is_error":false}`. The host read that as
  turn-complete, the renderer hid the indicator, and the registry destroyed
  the session 28 ms later.
- **The load-bearing finding came from the fix's first live run, not from the
  diagnosis.** The CLI does NOT drop the user's text: it dequeues it and starts
  a turn for it on its own, with `init` ~10 ms after the empty result — visible
  in production too, as the `system, system` pair between the result and
  `destroying`. The host was killing that turn. The first version of the fix
  re-sent the message the moment the empty result landed, and the transcript
  then showed **two** user turns and **two** model calls — the CLI's own answer
  arrived before the redelivery had even been dequeued. So redelivery is the
  FALLBACK, not the fix.
- **The fix is a ladder in `agentSession.ts`: wait → redeliver → surface.**
  `isSwallowedResumeTurn` fingerprints the result: empty success, zero
  assistant messages, zero stream events, and a `stopped` `task_notification`
  seen this turn. **All three required** — `/compact` also ends in an empty
  success and IS an API call. On a match the host absorbs the result (no result
  row, no turn-complete, `turnInProgress` stays set, `currentMessageId` kept so
  the real answer correlates) and arms a 15 s watchdog. The CLI's follow-up
  cancels it by producing anything — a streamed delta counts, since
  `includePartialMessages` is on and `message_start` lands as soon as the API
  answers. Only 15 s of silence, or a second empty result, re-sends the message
  once; a third empty ends the turn with a host-authored line instead of
  nothing. `swallowedResultAction` is the pure rule; each rung fires at most
  once per message.
- **Cost decided the design, at the user's explicit request.** The eaten turn
  was free (no model call) and the manual retype cost one turn, so the common
  path now costs exactly what it did — minus the retype and the wait. Keeping
  sessions alive so pollers actually run was rejected: unattended model turns
  on a timer are the one option with an open-ended bill, and it would not have
  closed the trap anyway (idle eviction and quit orphan tasks the same way).
- **The SSE debug line now carries `subtype=`.** Without it an eaten turn reads
  as `system, system, result` and cannot be diagnosed from the log; the
  production case needed the raw SDK transcript.
- **Part 2: the agent is told background commands do not outlive the turn**
  (`src/cobuilding/CLAUDE.md`, "Background commands"): no pollers, watchers or
  heartbeats; check now and tell the user to ask again. Those pollers never ran
  — Claude itself once wrote "The previous poller died when the app session
  ended". It reaches existing workspaces through the three-way reconcile
  (production's copy was byte-identical to shipped, so it fast-forwards; the
  dev copy did on the next boot). Probed once, live: asked casually to "keep an
  eye on the tool-data folder", the agent started **no** background task, ran
  two foreground `ls`/`find`s, and replied "I can't actually watch it — that's
  a real limitation, not a shortcut. Acabox stops my process as soon as I
  reply", then took a baseline snapshot for a later comparison.
- Verified: tsc clean; **1734/1734 across 117 suites** (+15, 1 new suite; the three
  positive fingerprint cases proven non-vacuous by neutering the predicate —
  exactly those three go red). Incidentally hardened `processTree.test.ts`,
  whose fixed 500 ms wait for the fixture's grandchild flaked 1-in-2 under load
  (now polled up to 5 s); smoke exits 0. Then the bug **reproduced live** over CDP
  against `npm start` — a turn that leaves `sleep 900` running, session
  destroyed, second message → `task_notification`, `init`, empty `result`
  291 ms in with zero assistant output, the production shape exactly. With the
  ladder: "keeping the turn open" → the CLI's own `init` 17 ms later → answer →
  **one** turn-complete carrying the original messageId, 3.6 s end to end. DB:
  `user → assistant → result`, no empty result row, one user row. SDK
  transcript: one user turn, one answer (the redeliver-first version had two of
  each). DOM: one bubble, one reply, composer back to Send, no stuck indicator.
- **NOT verified live: the redeliver and surface rungs.** The CLI ran its
  follow-up on every attempt, so nothing exercised them beyond their unit
  tests and the redeliver-first run — which did prove that a second message
  POSTed into a live agent session is answered (the first time that path has
  ever run outside a test; production's log held 116 sessions and 116 first
  messages). The packaged build is also unverified.


**Chat links: paste `acabox://chat/<id>` and the agent can read that chat
(2026-09-21).** Asked for as "Devin style — paste a link to another chat and it
receives context from it". Nothing of the kind existed: the agent had no tool
over other sessions and the UI had no way to name a chat.
- **The link IS the reference; nothing is stored beside the message.** The
  user copies `acabox://chat/<id>` from the chat header's link button and
  pastes it into any message. The bubble (optimistic and rehydrated alike),
  the agent's view, and the click target all derive from that one string in
  the typed text — titles are looked up live, so a renamed chat shows its new
  name. Contract in `shared/chatLinks.ts` (`parseChatLinks`, `extractChatId`,
  `splitTextByChatLinks`, `composeChatRefsText`, `describeChatRef`).
- **The transcript is PULLED and PAGINATED, never inlined.** A chat here is
  routinely a megabyte, and inlining one would recreate the 5.5 MB-transcript
  failure. At send time `agentSession.ts` resolves each linked id
  (`main/chatRefResolver.ts`, workspace-scoped, capped at 8, own chat dropped)
  and appends a short "Referenced chats" block — title · N messages · tool ·
  last active — telling the agent to load it with `read_chat`. The stored user
  row keeps the typed text only. New relay `chats` with `list_chats(query,
  limit)` and `read_chat(chat, detail, from_message_id, max_chars,
  include_tool_results)`, rendered host-side by `main/chatReference.ts`:
  `conversation` = what the user said plus each turn's `result` row (a turn with
  no result row still shows its last assistant text); `full` adds every
  assistant block and one line per tool call; budget default 30k chars, clamp
  2k..120k, footer names the `from_message_id` to continue from. A cross-
  workspace id reads as nonexistent, never as "exists elsewhere". Reserved
  `chats` in `RESERVED_CONNECTOR_IDS` so a connector cannot shadow the relay;
  `filterMcpServers` would silently drop the relay without the two
  `mcp__chats__*` allowlist entries, and the relay-name test now pins it.
- **UI:** `ChatLinkChip` (`assistant-ui/chat-link-chip.tsx`, imports nothing
  from `@assistant-ui/react` so it renders under jest) replaces the URL in user
  bubbles via a `Text` part that mirrors the library default's
  `<p style="white-space:pre-line">` wrapper, and in agent replies via
  `AnchorWithDoi`. Click dispatches `cd:open-chat`; `index.tsx` switches
  threads. Missing chat → "Deleted chat", struck through. The user bubble is
  `--cd-pale`, the same as the chip's default fill, so the chip goes white
  inside a bubble (same fix `.cdUser__file` already carries).
- **Two bugs caught by the tickets' own tests, not by reading:** a Python
  heredoc collapsed `\\` in the repository's LIKE-escaper so it emitted the
  literal text `${c}` (a title search containing `_` or `%` matched nothing);
  and the relay-name reservation above was missing until the connectors test
  failed. Both fixed; the escaper case now asserts the exact match.
- Verified: tsc clean; **1719/1719 across 116 suites** (+51, 4 new suites);
  smoke exits 0. Then live over CDP on the dev channel: a real turn containing
  a pasted link showed **one chip with the target's title and no raw URL** in
  the bubble; main logged `[ChatLinks] 1 referenced chat(s)`; the SDK
  transcript carried the exact reference block after the typed text; the agent
  called `list_chats` (2 matches) and `read_chat` with the pasted link, got the
  compact rendering (`[user 08:06] …` / `[assistant 08:06] DONE`) and replied
  `LAST: DONE`; the stored row holds the typed text with no block (0 rows
  contain "Referenced chats"); clicking the chip switched the header to the
  target chat.
- **NOT verified live: the Copy-link clipboard write.** Under CDP the document
  is unfocused and Chromium refuses `navigator.clipboard`, so the button's
  "Copied" flip could not be observed — a real click has focus. Also not built,
  deliberately: a composer-side chip while drafting (the URL sits in the
  textarea until send), an OS-level `acabox://` protocol handler
  (`forge.config.js` still declares no scheme), and any write access to other
  chats.

## Status (last updated 2026-09-18)

**A tool opened mid-write no longer strands the chat that is writing it
(2026-09-18).** Reported as "the Co-Scientist Spend Explorer chat is empty and
the app isn't built". Nothing was lost; three defects lined up.
- **What actually happened, from the production DB and log.** The chat
  scaffolded the tool at 00:28:58, then spent 4m18s generating a 75 KB
  `App.tsx` in ONE Write. The user clicked the new card at 00:33:22. The viewer
  ran esbuild → `Could not resolve "./App"` → BUILD FAILED, recorded in
  `tool-build-health.json`. `sessions:findForApp` found no linked chat, created
  an EMPTY one titled after the tool and pinned it into `manifest.chatSessionId`
  — after which `backfillAppChatLinks` skips the scan forever. The real
  conversation sat in the Chats list under its auto-title.
- **Root cause A — the link was never made at the moment it could be.**
  `findSessionForApp` needs an *assistant* row carrying the dir name, but the
  scaffold command only carries `--name "<display name>"`; the dir name exists
  only in the tool_result JSON. Fixed deterministically in
  `agentSession.ts`: `processQueryMessage` now fires `onAppLink` when a Bash
  `manage_mini_app.mjs` result names a `dir_name` or an MCP open/build call
  names one, and the session calls `setSessionAppDirName` (NULL-fill only, so
  a chat is still never re-homed). Pure extractors in `main/appChatLink.ts`.
  The legacy scan also gained a `tool_result` clause for existing databases.
- **Root cause B — an unwritten tool read as a broken one.** `buildMiniApp`
  now returns `reason: 'source-missing'` when `src/index.tsx` exists but no
  `src/App.{tsx,ts,jsx,js}` does — esbuild never runs and nothing is recorded
  as a failure (the agent-facing message says to write the file first). The
  viewer renders **BEING WRITTEN** / "Claude is still writing this tool"
  instead of BUILD FAILED, never mounts the iframe, polls for `src/App.tsx`
  every 2 s and builds on its own when it lands. Shared bits live in
  `renderer/components/miniAppBuildState.tsx` because `MiniAppViewer.tsx`
  cannot be imported under jest (`@assistant-ui/react` → ESM-only
  `assistant-stream`).
- **Root cause C — the reload signal rode the chat renderer.** The agent's
  successful `build_and_open` reached the viewer only via the tool-call card in
  the *visible* thread, so with a different chat on screen the viewer kept its
  BUILD FAILED latch until relaunch. Main now broadcasts `miniApps:built` from
  the build-succeeded hook; `ChatView` bumps the open tab's reload nonce. That
  broadcast is the ONLY remount path now — `BuildAndOpenMiniAppToolUI` no
  longer passes `forceReload`, and the Rebuild button no longer bumps its own
  key (both would have remounted the iframe twice). `open_mini_application`
  (no build) still force-reloads itself.
- **Production data repaired by hand:** the building chat
  (`14027f7d…`, "Cost Breakdown Visualization and Analysis Tool") was linked to
  `coScientistSpendExplorer` and the manifest's `chatSessionId` re-pointed at
  it. The bug-created empty chat `2cf62d69…` ("Co-Scientist Spend Explorer",
  0 messages) was left for the user to delete or reuse. The renderer caches
  dirName→chat per app run, so the side panel shows the change after picking
  the chat from its dropdown or restarting.
- **Prevention beyond the code:** `manage-mini-application/SKILL.md` Step 2 now
  tells the agent to write `App.tsx` as the very next action after scaffolding
  and to split a large app rather than compose one giant file — the card is
  visible from the scaffold onward.
- Verified: tsc clean; **1668/1668 across 112 suites** (+41, 3 new suites;
  the two DB/builder regression cases proven to fail against the old code);
  smoke exits 0. Then live over CDP against `npm start` on the dev channel: a
  real scaffold with no `App.tsx` opened to chip **BEING WRITTEN**, the waiting
  copy, no iframe, no BUILD FAILED, build-health file untouched, and the
  builder's info line in the log; writing `App.tsx` flipped it to **IDLE** with
  the iframe mounted within the 9 s window and still no health row; a build
  fired through `miniAppsAPI.build` (not the button, not a chat) remounted the
  iframe (a marker set on the element was gone). Then a **real turn** running
  only the scaffold command: `[AppChatLinks] Linked chat … to linkProbeTool
  (via scaffold)` 4 ms after the command result, `sessions.app_dir_name` set,
  manifest carrying no `chatSessionId`.
- **NOT verified:** the packaged build; the exact incident path with the real
  agent build tool while a different chat is visible (the broadcast leg was
  exercised via IPC instead); and a long-lived awaiting screen surviving a
  tab switch. **Cosmetic, unchanged:** the first build of any tool still logs
  one `[local-file] … dist/bundle.js … ERR_FILE_NOT_FOUND` because
  `MiniAppContent` mounts while the build runs. **Seen, not chased:** setting
  `localStorage.selectedModel` to Haiku and reloading still produced an
  Opus 5 session — the mounted picker's context provider, not the storage
  fallback, decides the model.

## Status (last updated 2026-09-17)

**"Test" now tests the KEY, not just reachability (2026-09-17).** Reported as
"all my APIs are giving 404". They were not: the proxy was relaying real
upstream 404s, and the button was asking a question that could not be answered.
- **The old button was wrong in BOTH directions, and the catalog proves it.**
  Measured unauthenticated on 2026-09-17: `api.github.com/` and
  `api.osf.io/v2/` answer **200 with no credential at all**, so a green Test
  meant nothing — an API with a garbage key, or none, tested fine. Hex, Zenodo,
  Figshare and protocols.io answer **404** at their root with or without a good
  key, so a red Test meant nothing either. It GET the bare base URL and
  forwarded the raw status.
- **Two fixes, because the base URL and the interpretation were both wrong.**
  (1) A curated `testPath` per catalog entry — `hex projects?limit=1`,
  `zenodo deposit/depositions`, `figshare account`, `osf users/me/`,
  `github user` — each **curled unauthenticated and verified to return
  401/403**, which is the property that makes a later 2xx mean something. A
  path that answers 200 or 404 to everyone is not a test.
  (2) `interpretApiTest` in `shared/apis.ts`, pure and unit-tested, turning the
  status into one of four verdicts instead of pass/fail.
- **The load-bearing idea is a COMPARISON, not a better status list.** Test now
  sends the same GET twice, once with the credential and once without
  (`omitCredential`, settable only from main — the loopback door builds
  `ApiRequestInput` field by field, so neither the agent nor a mini-app can
  set it). If the server treats the two differently the key is demonstrably
  doing work, and that holds for a **custom** API nobody curated, which is the
  case the user actually hit. If it treats them the same, the UI says so
  rather than inventing a verdict. The second probe is skipped on 401/403,
  which is decisive on its own, so the common failure still costs one request.
- **`unconfirmed` is a first-class outcome and the reason the old button
  lied.** "Reached it but cannot confirm the key" is neither pass nor fail, and
  collapsing it into either is what produced both false readings. Rendered in
  muted grey; the default style stays the error colour so an unstyled verdict
  can never read as success.
- Verified: tsc clean; **1627/1627 across 109 suites** (+10); smoke exits 0.
  Then driven live over CDP against a real `npm start`, all three reachable
  verdicts observed end to end: **Hex with a deliberately wrong key → 401 →
  "The server rejected the credential"** (which also proves the curated
  `testPath` is in use — the bare base URL returns 404, not 401); **UniProt,
  which ignores the credential → 200 both ways → "the same request works
  without your key"**, the exact false positive this removes; and Crossref
  rate-limited → a named 429 rather than a bare status. The UI was checked in
  the DOM, not just over IPC (`apiTestResult--ok`, green, honest text).
- **NOT verified live: the `ok`-with-a-real-working-key path**, because the dev
  channel holds no valid credential. It is unit-tested against the measured
  status pairs, and production has Hex with a real key plus a curated
  `testPath`, so pressing Test there is the acceptance check.
- Unrelated but found in the same log and still open: `api.devin.ai` redirects
  to a plain `http://` URL and the proxy refuses it (`REFUSED devin → 403`),
  correctly, since following it would send the token unencrypted. Devin is
  therefore unusable until that is looked at separately.

**Agent SDK 0.2.121 → 0.3.273, and Fable 5.1 now runs (2026-09-17).** The
upgrade the model work below identified as the only route to 5.1.
- **It went far more cleanly than budgeted, for a measurable reason: our SDK
  surface is tiny.** Three values (`query`, `createSdkMcpServer`, `tool`), six
  types, and exactly one method on the `Query` object (`close()`). `tsc
  --noEmit` came back with **zero errors** across a major-line jump.
- **npm surfaced the real blocker, which was a SECOND upgrade.** 0.3.273 has a
  peer of `@anthropic-ai/sdk >= 0.93.0` and we were on 0.82, so the install
  refused (`ERESOLVE`). Resolved by upgrading that too — **0.82 → 0.126**, safe
  because our whole use of it is `new Anthropic()`, `messages.create` and
  `messages.stream`. **Do not reach for `--force` here**: it would leave the
  peer genuinely unsatisfied at runtime rather than fixing anything.
- **`@modelcontextprotocol/sdk` held at exactly 1.29.0**, which is the thing
  this file warned a bump could silently move. Checked after installing, not
  assumed.
- **Four breaking changes in the 0.2→0.3 range; three were free.** The v2
  session API was removed (we use `query()` + `resume`), `'Skill'` in
  `allowedTools` was removed (we already use the `skills` option), and
  `options.env` replacing rather than overlaying `process.env` landed back in
  0.2.113 (we already spread `...process.env`).
- **The fourth, TodoWrite → Task tools, is NOT what the changelog implies, and
  only running it showed that.** 0.3.142 says SDK sessions use
  `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` instead of `TodoWrite`; 0.3.233
  then made todo/task tools non-default on newer models. Measured on 0.3.273
  with Fable 5.1, a real tracked-task turn emitted **`TodoWrite` four times** —
  so the existing renderer and allowlist entry are fine and nothing regressed.
  Because which name appears clearly varies by model and SDK build, **both
  spellings** are now auto-approved and labelled, plus `ToolSearch`, which
  showed up in the same turn and is new in the 0.3 line.
- **Fable 5.1 is in the picker and Fable 5 steps down to superseded**, which is
  the choice made when this started. `UNSUPPORTED_MODEL_IDS` is now empty but
  kept, with the mechanism written down — it is where the next
  too-new-for-our-CLI model goes, and its test still proves such an id cannot
  be auto-re-added by discovery.
- Verified: tsc clean; **1617/1617 across 108 suites**; `npm start --
  --smoke-test` exits 0 and `--smoke-test-mcp` **PASSes** (the echo fixture
  spawns, reaches ready and round-trips, so the 0.3 background-MCP-connection
  change did not break hosted servers). The rebuilt `dist/agent-server.js`
  boots standalone under Electron's own Node and serves `/health`. Then live
  over CDP: a real turn on **Opus 5** as a regression check, and a real turn on
  **`claude-fable-5-1`** replying normally where the same turn returned a 400
  yesterday.
- **NOT verified on the new SDK:** the connector "pending" status (0.3.142
  makes MCP servers connect in the background and report `status: "pending"`
  in `init`; the dev channel has no connector configured, so the Connectors UI
  was never exercised against it — **production has Hex, so check that row
  after updating**), mini-app bridge calls, notebooks, and the packaged build.

## Status (last updated 2026-09-16)

**Sharing is deployed and a real app has been shared (2026-09-16).** Increment
0 — the manual Cloudflare setup that had never been run, ticket X1 — is done.
Both Workers are live on `share-api.acabox.us` (bearer token) and
`share.acabox.us` (Cloudflare Access, Google, `@academia.edu`), and a real
mini-app has been published and opened by a signed-in user.
- **Two of the README's manual steps were unnecessary and would have been
  redone blindly.** The account has run Zero Trust since June 2026 for
  paper-monitor, so a team domain (`proud-butterfly-1eb0.cloudflareaccess.com`)
  and a working **Google identity provider** already existed — the Google Cloud
  Console detour was skipped entirely. Check `access/identity_providers` before
  creating one; the README now says so and records the live values.
- **`allowed_idps` is pinned to that one Google provider, deliberately.** Empty
  means *all* providers and one-time PIN is enabled account-wide here, so an
  empty list would let any email address on earth request a code and pass the
  gate. The sibling apps (paper-monitor, reader) do exactly that, with
  `include: everyone` — a shape not to copy.
- **The wrangler OAuth token cannot configure Access**, and reads through it
  are actively misleading: `access/apps` and `access/identity_providers`
  returned `success: true` with **empty lists** while six apps and two IdPs
  existed. Writes are `auth.forbidden`. A scoped API token is needed; probe
  write access by POSTing an invalid body and reading validation-vs-auth.
- **R2 enablement is the one thing no token can do** — dashboard only, payment
  method required even on the free tier; `/subscriptions` 403s as well.
- **A published app tried to save on load, and the viewer blamed the app.**
  `useAppState` debounce-saves the notebook off state changes, so it fires
  during hydration with nobody touching the page; the shim refuses every write,
  which produced two console errors AND raised the viewer's hint — whose text,
  *"This tool tried to run something"*, was simply false. Fixed at both ends:
  `init` now carries `readOnly: true`, the bridge exposes `isReadOnly()`, and
  `useAppState` skips persistence instead of attempting it. `writeFile` is
  still **refused** rather than faked — answering ok would let an app report
  "Saved" for a write that went nowhere — but no longer raises the hint.
- **The guard's own test found the write site the fix missed.** Counting
  `.writeFile(` call sites caught `markRunComplete`, where the write sits
  *before* `setLastRunHash`/`setLastRunAt` — so a refusal skipped both state
  updates and rejected to the caller. Asserted against the shipped source,
  because that file is not in the tsc project and is bundled per-app.
- **Split responsibility, and it matters for what a republish fixes:** the shim
  and viewer are served by the Worker, so the false hint is gone for snapshots
  already published. The bridge and `useAppState` are bundled INTO each
  snapshot, so the console errors persist in an already-published app until it
  is rebuilt and republished.
- **`wrangler r2 object get` reads the LOCAL simulated store unless given
  `--remote`**, and against a key that really exists it reports "The specified
  key does not exist" — indistinguishable from a failed upload. It briefly
  produced evidence that a successful publish had failed.
- Verified: tsc clean; **1617/1617 across 108 suites** (+6, 1 new suite), the
  two shim cases proven non-vacuous by reverting each change independently.
  Live: `/v1/health` 200 with the token and 401 without; `share.acabox.us/` and
  `/viewer.js` both 302 to Access with the redirect's `kid` matching the AUD;
  and a real file published, fetched back out of R2 **byte-for-byte with a
  matching sha256**, then deleted — which also proved delete reclaims the
  object, not just the index row.

**Models: one roster, discovered live — and the real blocker turned out to be
the bundled CLI, not our list (2026-09-16).** Asked as "the picker shows Fable
5, but Fable 5.1 exists — can new models appear as soon as they ship?"
- **The premise was half right, and the missing half is the important part.**
  The roster WAS three hardcoded copies that drift (that is fixed). But adding
  `claude-fable-5-1` to the picker and sending a real turn returns
  `400 invalid_request_error — "Claude Code 2.1.121 does not support this
  model; version 2.1.251 or newer is required"`, while `claude-fable-5` on the
  same build replies normally. **The gate is the CLI version the Agent SDK
  bundles**, not the account's roster: `GET /v1/models` cheerfully lists
  5.1. So discovery can tell us a model EXISTS and never that we can run it —
  and a brand-new model is exactly the case an old CLI rejects.
  **Fable 5.1 is therefore deliberately NOT offered**, recorded in
  `UNSUPPORTED_MODEL_IDS` with the measurement, and unblocking it means
  upgrading `@anthropic-ai/claude-agent-sdk` **0.2.121 → 0.3.273** — a
  major-line jump that also moves the exactly-pinned
  `@modelcontextprotocol/sdk`, so it is its own piece of work, not a bump.
- **The gate applies to CHAT only.** Mini-apps call the Anthropic API directly
  through the proxy with no CLI in the path, which is why the mini-app
  allowlist trusts discovery outright while the picker cannot.
- New `shared/models.ts` is the single source of truth for all three former
  copies; `main/modelCatalog.ts` reads `GET /v1/models` (main-owned, because
  the key never leaves main), cached 6h, single-flight, best-effort — a failure
  returns the roster you already had, so the picker can never go empty.
- **`UNSUPPORTED_MODEL_IDS` must stay inside `KNOWN_MODEL_IDS`, and that is a
  live bug if forgotten:** "known" is what stops `mergeModels` reading an id as
  a new release, and 5.1 is newer than everything else on the roster — so an
  unknown 5.1 would be auto-added on the next discovery and 400 for whoever
  picked it. Pinned by a test.
- **The merge rule, and why it is two conditions:** a discovered model is shown
  only when its id is unknown **and** it is newer than every id we do know,
  with the cutoff computed from the API's own `created_at` (no hardcoded date
  to go stale). Each half alone fails a real case — validated on live data:
  the account returns 11 models including `claude-opus-4-5-20251101` and
  `claude-sonnet-4-5-20250929`, both unknown to this build and both correctly
  suppressed as old rather than announced as new.
- The default model stays **pinned** to `claude-opus-5`. Auto-jumping to
  whatever is newest would change every new chat's cost because Anthropic
  shipped something, with nobody choosing it.
- Verified: tsc clean; **1611/1611 across 107 suites** (+25, 2 new suites — the
  fetch layer driven against a real loopback server, `@jest-environment node`
  because jsdom's fetch never reaches it). Then live over CDP: discovery
  returned 11 models with no error, the picker rendered exactly the curated
  five, and real turns confirmed Fable 5 works and Fable 5.1 400s.
- **A false positive worth recording:** the first live turn "passed" because
  the probe typed into the Settings *custom instructions* textarea — the first
  visible `textarea` on the page — and then matched its own text in
  `document.body.innerText`. Assert on the DB row and the `Session created:
  model=` log line, not on page text, and scope DOM writes to a real class
  (`.cdComposerInput`). Nothing was saved; the field was cleared.

**Released v0.1.14 (2026-09-16).** Find in page, sharing, and the API proxy
banner fix below, plus the two prior sessions' uncommitted work, which had been
sitting in the tree. Verified after publishing rather than from the release
log: the three assets carry the right 0.1.14 names/sizes (dmg 187,846,189 · zip
190,723,146 · yml 395), `latest-mac.yml` is **anonymously downloadable** with
the token stripped from the environment (`http=200` — the property the updater
depends on), its sha512 matches the built zip byte-for-byte, and the packaged
bundle is `valid on disk / satisfies its Designated Requirement` with
`CFBundleShortVersionString` 0.1.14 and id `com.electron.acabox`. Also checked
that the work **shipped** rather than merely built, which is the check a
release log cannot answer: `/.webpack/renderer/find_bar_window` is present in
the packaged asar (so the new forge entry took), and the minified renderer
holds `createElement(ApiSettings,{active:a})` inside the `wsSettings__sectionCard`
under the "APIs" label — the proxy fix, in the artifact. Ad-hoc signed as
usual, so a fresh download still needs right-click → Open.
- **Sharing shipped INERT and that is the point.** Increments 1-4 are built and
  unit-tested, but Increment 0 — the manual Cloudflare Zero Trust setup in
  `src/share-workers/README.md` — has never been run, and no app or file has
  been published end to end (ticket X1). Nothing auto-publishes, there are no
  hardcoded endpoints, and nothing leaves the laptop until the user sets a site
  URL, an API URL and a publish token; the token is encrypted at rest and never
  crosses IPC. Checked, not assumed, before shipping it.
- **Two status headers were lying in opposite directions and are fixed.**
  `docs/design/sharing.md` still said "**proposal, nothing built**" while every
  implementation ticket had landed, and `src/share-workers/README.md` still said
  the Workers were a scaffold returning `501` when the routes are implemented
  and tested. A reader trusting either would have drawn the wrong conclusion
  about what is safe to ship. Both now say what is true: code done, deployment
  and end-to-end not.
- **One commit, deliberately, and the reason is worth keeping.** The three
  workstreams overlap in `index.tsx`, `preload.ts`, `types.d.ts` and
  `DirectoryPermissions.tsx`, so no subset of them typechecks alone — splitting
  by path would have produced an intermediate commit that does not build.
- Gate before publishing: tsc clean; **1586/1586 across 105 suites**; smoke
  exits 0. Note `git push` reported `remote: fatal error in commit_refs` and
  then `Everything up-to-date` — a transient GitHub hiccup after the objects
  were already written, confirmed by `git ls-remote` matching local HEAD. Not a
  failed push; do not re-push blindly on that message, check the ref.

**"The API proxy isn't running" was the page lying, not the proxy (2026-09-16).**
Reported from the field, with a screenshot: the banner up, the Hex row green,
and Test greyed out. The proxy was listening the whole time.
- **It is a boot RACE that the Settings page then froze forever.** The Settings
  tab is mounted at app start and merely hidden behind `display: none`
  (`renderer/index.tsx`), so `ApiSettings`' `useEffect(..., [load])` — `load`
  being a `useCallback([])`, hence stable — fired once, milliseconds after the
  renderer loaded. `apiProxy.start()` is ~200ms behind that, because the proxy
  is started by `agentInfrastructure.start()`, which **the renderer itself**
  triggers via `container:ensureSetup`. Measured on two real boots:
  production `did-finish-load` 11:48:03.687 → `[APIs] Proxy listening`
  11:48:03.908 (221ms); dev 12:25:43.006 → .177 (171ms). The `running: false`
  snapshot was correct for a fifth of a second and then never re-read.
- **The banner's own advice could not clear it, which is why it never went
  away.** "Open a chat" does not start the proxy (boot does) and does not make
  the page look again; "restart Acabox" reproduces the identical race. Greyed
  Test is the same stale bit — it is gated on `proxy.running`.
- **Same defect, same fix as the Servers page's mid-session scan**: an `active`
  prop threaded `index.tsx` → `DirectoryPermissions` → `ApiSettings`, re-reading
  on arrival. Deterministic here because the app lands on `home`, so the tab
  always transitions false → true before anyone can see the banner. A hidden
  tab now reads **nothing at all** rather than taking a snapshot it cannot
  refresh, so `loaded` stays false and the section renders empty.
- **Deliberately NOT a broadcast**, unlike `scheduledTasks:changed`. Checked
  rather than assumed: `apiProxy.start()` is early-return-if-running and the
  only `stop()` is app teardown, so in practice the proxy starts once per boot
  and stops at quit — the renderer is destroyed in between. "Announce at the
  write" would buy nothing a re-read on arrival does not already cover.
  `ConnectorsSettings` next door already has a push channel plus a manual
  refresh, which is why it never showed this; `ApiSettings` was the one
  status section with neither.
- Verified: tsc clean; **1586/1586 across 105 suites**; the 3 new cases proven
  non-vacuous by reverting the effect (2 of 3 fail on the old code, and the
  genuine-bind-failure case correctly still passes). Then driven live over CDP
  against a real `npm start`: with main reporting
  `{running:true, baseUrl:'http://127.0.0.1:23501'}`, the hidden tab held only
  the "APIs" heading, and clicking through to Settings rendered the section
  with **no banner** and Test **enabled** (`title="Send one real GET at the
  base URL"`) — the same bit the screenshot showed greyed.
- **NOT changed: the banner copy.** After this fix the no-error branch is
  nearly unreachable (a genuine bind failure takes the other branch, which
  names the error), but "It starts with the agent — open a chat" is still
  wrong about how the proxy starts. Left alone rather than churned.

## Earlier status (last updated 2026-09-09)

**Select any text, quote it into the composer (2026-09-09).** Asked for after
seeing it in Devin: select text in a reply, a floating toolbar appears, clicking
it drops the excerpt into the message box as a chip that rides along with the
next turn. Design decisions were the user's: blockquote wire format, all
surfaces, one quote at a time, persisted block, everything in one change.
- **`@assistant-ui/react` 0.12.22 already ships half of this** and the half it
  ships is the half worth keeping: a composer quote slot (`setQuote`, one at a
  time, auto-cleared on send), a `Quote` render slot on `MessagePrimitive.Parts`,
  and `data-message-id` already emitted by `MessageRoot`. The load-bearing
  discovery is that **`setQuote` writes its argument VERBATIM into the outgoing
  message's `metadata.custom.quote`, and `custom` is untyped** — so `AcaboxQuote`
  (text + truncated + provenance) rides through unchanged with a cast, and the
  optimistic bubble and the rehydrated-from-SQLite bubble render through one
  component. Two renderers for "before send" and "after reload" is how they
  drift; there is one.
- **What the library does NOT do is send it.** The quote lands in metadata and
  `chatAdapter` built `userText` from text parts only, so without wiring, a
  quote would render, send cleanly, and be invisible to the agent. It now travels
  as its own field to main, which composes the blockquote on the way out
  (`composeQuotedText`, the only place composition happens) while the row stores
  the text the user TYPED. Storing the composed string instead would render the
  excerpt twice in the bubble — once as its block, once in the body.
- **Its own toolbar, not `SelectionToolbarPrimitive.Root`**, because that one
  requires `data-message-id` and refuses every surface that is not a chat
  message. `renderer/components/command-desk/quoteSource.ts` generalizes the
  lookup to an opt-in `[data-quote-source="kind:value"]` ancestor with
  `data-message-id` as fallback, so chat messages needed no markup change.
  Inner claim wins: a tool card inside a reply is attributed to the tool.
- **Deliberate divergence from the library: a TIMER, not `requestAnimationFrame`.**
  Found by driving the real app — with the window occluded (`document.hidden`),
  **rAF never fires in either the host page or a mini-app frame** while
  `setTimeout` fires in both, so the rAF version silently stopped offering to
  quote. The deferral only has to outlast the selection settling; it has nothing
  to do with painting. Pinned by a test asserting on the shipped shim SOURCE so a
  revert to rAF fails.
- **Mini-app iframes work via `main/miniAppSelectionShim.ts`**, injected beside
  the link shim on `did-frame-navigate` (same reason: `local-file://` is
  cross-origin, `contentDocument` is null). The frame reports text + rect;
  MiniAppViewer offsets the rect by the iframe's own box and the HOST draws the
  toolbar, so it can't inherit the tool's CSS. Two consequences the protocol has
  to carry: a host button **cannot** clear a selection in the frame's document
  (clearing is a message back in), and the frame's internal scroll is invisible
  to the host's scroll listener (the shim reports it). The frame slices at
  **cap + 1**, not cap — pre-slicing at the cap would make a million-character
  selection arrive at the limit and be reported as complete.
- **`MAX_QUOTE_CHARS = 8000`, and it is not a guardrail against carelessness.**
  It is the same failure mode as the 39,335-row CSV that produced a 5.5 MB
  transcript and bricked a thread forever: a rendered spreadsheet is one Cmd-A
  from megabytes. Truncation is never silent — flagged, ellipsized, and stated
  in the attribution line even for chat prose, which is otherwise unattributed.
- **Attribution asymmetry, deliberate:** the agent gets no source line for chat
  prose (the excerpt is verbatim in the transcript directly above) but always
  gets one for a file/tool/mini-app; the chip always shows one (the user is
  looking at something detached from its origin). A file is also the one source
  where the two differ in content: the agent gets the **full path** (it can hand
  that to `Read`), the chip gets the tail.
- **Routing:** the toolbar is mounted wherever a quote has somewhere to land —
  wider than `globalComposerVisible`, since mini-app detail hides the docked
  composer but the tool's side-panel chat is right there. Quoting expands that
  panel if collapsed. Settings and Debug have no chat, so no toolbar.
- Verified: tsc clean; **1148/1148 across 74 suites** (+66, 5 new suites,
  including 11 against the REAL injected shim string in JSDOM); smoke exits 0.
  Then driven live over CDP against a real `npm start`: toolbar positioned 8px
  above the selection and horizontally centred on it; quote → chip → send → the
  SDK transcript holds exactly
  `> Built it as DNA Toolkit…\n\nQUOTETEST: reply with only the word ACK` while
  the SQLite row holds the typed text and the quote as separate fields; agent
  replied; **reload → the block came back from SQLite** with the typed text
  appearing exactly once. Refusals confirmed live: a drag spanning two messages,
  a selection inside the composer's own textarea, and scroll-dismiss. The shim
  was proven injected into a real `local-file://` frame and its report reached
  the host.
- **A screenshot caught what no assertion did, again.** The meta line is mono
  UPPERCASE across this design system — right for a category, wrong for a path:
  it rendered `MyResearch/Data.csv` as `MYRESEARCH/DATA.CSV`. The component was
  holding the correct string the whole time. File labels now opt out via
  `cdQuoteMeta--literal` (chained selectors, so it cannot lose a specificity tie
  to import order — the scheduler lesson).
- **NOT verified: a quote taken from a real mini-app iframe end to end.** The
  only tool in this dev workspace (`liverAtlasExplorer`) has a **pre-existing,
  unrelated build failure** — `Could not resolve "lucide-react"` from the shared
  `.applications/_reusable/ErrorDisplay.tsx`, i.e. the dep is missing from the
  dev npm-site — so no mini-app iframe can mount. Deliberately not fixed here,
  as it is someone else's bug and papering over it would hide it. What WAS proven
  instead: injection into a real `local-file://` frame, the frame→host message,
  and the host contract (`cd:frame-selection` → toolbar at the translated
  coordinates → chip naming the tool → panel-expand and clear-selection events
  both firing). The one unproven link is MiniAppViewer's `event.source` check
  against its own iframe. **Acceptance test: install `lucide-react` into the
  npm-site, rebuild that tool, select text inside it, confirm the chip appears
  and the panel expands.**

## Earlier status (last updated 2026-08-31)

**The scheduler is finally reachable, on the Activity page (2026-08-31).**
Increment 8 of `docs/design/mcp-hosting.md`, unrelated to MCP and pulled forward
because it was 494 lines of finished UI held hostage by a four-week plan.
- **The backend was complete and already running the whole time** —
  `startScheduledTasks` at `main/index.ts`, eight IPC channels, its own
  `scheduling.db` with run history. What did not exist was any way to see it:
  `ScheduledTaskEditor.tsx` (372 lines) and `ScheduledTasksSidebar.tsx` (122)
  were imported nowhere, and `ScheduledTasks.css` (334 lines) was never swept in
  the palette pass because nothing imported it either. All three are deleted —
  **828 lines** — and their cron translation survives in
  `renderer/components/schedule/scheduleCron.ts`, which **has tests it never
  had** (29).
- **It lives on Activity because a schedule and the output it produces are one
  subject.** The counter-argument is real and recorded: Activity is also the one
  nav slot where someone hunting for "automations" would not look. If that
  bites, the fix is a rail entry pointing here, not a second home.
- **"On a schedule" renders even when empty**, unlike every other section on
  that page. The others signal news; this one is also the only place the feature
  can be discovered, and a heading that vanishes when nothing is scheduled can
  never teach anyone that scheduling exists.
- **Found by a test, not by reading:** `cronToInterval` parsed a zero step into
  `{interval: 0}`, which `intervalToCron` wrote straight back out and
  `cronToHuman` rendered as "Every 0 minutes". The editor could never produce
  one (`validateInterval` rejects 0) but the list is fed from a hand-editable
  `scheduling.db`. A non-positive step now falls through to the default — the
  **one** deviation from an otherwise verbatim lift.
- **The docked panel needed a shell.** ActivityPanel is mounted in a container
  that scrolls, so an absolutely-positioned panel inside it scrolls away with
  the content. It now has ServersPage's three-part structure: non-scrolling
  relative shell, scrolling body, panel as a **sibling** of the body. Copy that
  shape for the next docked panel rather than rediscovering it.
- **The three-copy deep-link tab union is fixed.** It lived in
  `shared/types.ts`, `main/mcpServers/notificationMcpServer.ts` and
  `agent-server/index.ts` — and the third is a **zod enum, which silently
  strips** an unknown value, so fixing the first two alone produced a
  notification that navigated nowhere with no error anywhere. Now one
  `SIDEBAR_TAB_IDS` in `shared/types.ts` imported by both zod sites; all three
  had been missing `knowledge` and `activity`. `shared/__tests__/sidebarTabs.test.ts`
  scans the source for a fourth copy **and** asserts the two known sites still
  import the constant, so it cannot pass vacuously.
- **The 30s poll is gone (2026-09-08): the repository now broadcasts.**
  `onScheduledTasksChanged` in `db/scheduledTaskRepository.ts` fires on all
  seven mutations, main fans it out as `scheduledTasks:changed`, and Activity
  subscribes. **Notified from the REPOSITORY, not the IPC handlers**, because
  `runner.ts` writes run rows and `scheduler.ts` stamps `updateLastRun` from the
  timer — neither passes through IPC, and those are exactly the writes the poll
  existed to catch. Same lesson as `emitRecordChange` in `mcpHost`: announce at
  the write, which is the one place that cannot be bypassed.
- Verified: tsc clean; **1055/1055 across 67 suites**; smoke exits 0 (its log
  now ends `[APP] will-quit: exiting via the shutdown path`, which is the
  Increment 1 teardown firing on the right event). Then driven live over CDP
  against a real `npm start`: the full lifecycle — create, list, pause (row
  dims, button flips to Resume), reopen with the cron round-tripping back into
  the form as "24 hours", delete through the confirm modal, empty state
  restored — plus the validation path (`7` minutes → "Must be a multiple of 5",
  Create disabled) and the unit-snap (7 → 5 on switching to minutes).
- **A layout bug got through every test and was caught only by looking at a
  screenshot.** `.connectorField__input` sets `width: 100%`, and
  `.scheduleIntervalRow__num` carried the same (0,1,0) specificity — so which
  won came down to stylesheet import order, and this file lost. The number
  input ate the whole row and **the unit dropdown was pushed clean off the
  panel's right edge**: the user could set a number but never a unit. The
  component was computing the right values into a box nobody could see, which
  is precisely the class of defect a value-asserting test cannot reach. Now
  chained selectors (`.scheduleIntervalRow .x.connectorField__input`) so it
  cannot lose that race again. **The lesson is the general one: when reusing a
  shared input class inside a new layout, specificity ties resolve by import
  order — take the screenshot.**

**Local MCP servers: Acabox now hosts them, and Claude can write you one
(2026-08-31).** Design, review and every decision in
`docs/design/mcp-hosting.md` — read its header table first, it is kept in sync.
**Increments 0-5 and 7 are built and green; 6 (installer) and 8 (scheduler) are
not started.**
- **The charter line "mini-apps can create and run MCP servers" was half-true and
  the stdio connector was a dead end**, for three measured reasons: the connector
  was serialized into the SDK's `mcpServers` and the **per-turn CLI subprocess**
  spawned the child, so the server was killed once per chat message; no typable
  string produced working argv for a path with a space
  (`d.args.trim().split(/\s+/)` + `shell:false`); and the child inherited the
  agent server's whole environment, `ANTHROPIC_API_KEY` included.
- **Architecture: main owns the child, and the agent reaches it through an SDK
  relay — no loopback HTTP server.** `setMcpServers` special-cases `type:'sdk'`
  entries whose only contract is speaking MCP JSON-RPC, and this repo already
  runs seven such relays daily. So there is **no fifth port range**, no bearer
  token, no Streamable-HTTP compliance — which is also what "local-only" actually
  means. Main owns the child rather than the agent-server because the
  agent-server is itself crash-restarted, which would kill every server on every
  restart.
- **`main/appTeardown.ts` fixes a live bug that had nothing to do with MCP.**
  There were two `before-quit` listeners and no `will-quit` anywhere; the second
  ran its 12 teardown steps **even when the user clicked Cancel**, and twice on
  accept. Clicking Cancel SIGTERMed the agent server and kernel gateway, stopped
  the file monitor, dictation, scheduler and background builder, invalidated
  every API-proxy token and closed three SQLite handles — while leaving the app
  open. Teardown is now one idempotent `teardown()` on `will-quit`, ending in
  `app.exit(0)` (**not** `app.quit()`, which re-enters the emit chain).
- **Env is an allowlist, not spread-and-strip** (`mcpHost/hostedEnv.ts`) — it
  starts from the MCP SDK's own `DEFAULT_INHERITED_ENV_VARS`, imported by
  reference rather than transcribed. There is nothing to strip because nothing is
  spread; the test asserts on **values**, not key names, so it catches the next
  accidental spread.
- **There is no write-gate boolean, and the reasoning is worth keeping.** A tool
  cannot be classified read-vs-write from an untrusted server (name heuristics
  fail on `run_query`/`execute`/`fetch`, and a self-declared `readOnly:true` is
  the attacker's own claim), so `allowWrites:false` could only honestly mean "all
  or none" — and "none" is already spelled `enabled:false`. It ships instead as
  per-tool `enabledTools?: string[]` (**absent means all**, so no migration),
  enforced twice: filtered before `POST /hosted` (the optimisation, and it keeps
  unselected schemas out of context) and re-checked in the host relay handler
  (the boundary — a mid-session narrowing leaves the CLI holding the wider push).
- **The curated catalog was cut after measurement, not after debate.** Nothing
  credible existed to put in it: three candidates were never on npm, one is
  deprecated abandonware, and the survivors duplicate `Read`/`Write`/`Glob`/`Grep`
  — shipping `filesystem` would charge a permanent ~2,000-token context tax for a
  *narrower* version of tools the agent already holds. **Increment 5 (Claude
  authors the server) is therefore the only acquisition path**, which is also the
  fork's own charter. What survived: typed inputs instead of a freeform argv row
  editor, plain-language confirmation instead of a `tools/list` dump, and the
  rule that any future catalog entry is spawned in a real test and carries a
  `verifiedOn` date.
- **`@modelcontextprotocol/sdk` is now a direct, exactly-pinned dependency
  (1.29.0)** — it was transitive under the Agent SDK, so any bump could have moved
  it silently. Two rules for importing it here, both measured: **always use the
  `.js`-suffixed deep path** (`@modelcontextprotocol/sdk/client/stdio.js` — the
  extensionless form resolves at runtime but not for types), and **never import
  the bare specifier**, whose `.` export points at a `dist/cjs/index.js` that does
  not exist in 1.29.0. It resolves under `moduleResolution: node` only because the
  exports map has a `"./*"` wildcard and the package ships legacy `typesVersions`;
  no `paths` entry or `.d.ts` shim is needed, and none should be added.
- Verified 2026-09-08: `npx tsc --noEmit` clean; **1082/1082 across 69 suites**;
  `npm start -- -- --smoke-test` exits 0. Note the smoke test proves **nothing**
  about hosted MCP — `mcpHost.startAll()` sits on the renderer-triggered
  `agentInfrastructure.start` path the smoke run never reaches. Use the
  `--smoke-test-mcp` flag for that.
- **The Increment 5 funnel WAS driven end to end (2026-09-01) and it failed at
  exactly one seam — now fixed.** Claude wrote `.mcp-servers/dna-toolkit/`, the
  user was told to go to the Servers page, and the page said **"No servers
  yet."** Three causes, all the same shape — *the moment a record changes,
  nothing tells anyone*:
  1. **Nothing scanned mid-session.** `scanAndAdoptAuthoredServers` ran at boot
     or from a button, and the agent writes servers between boots. The Servers
     page now scans **whenever it becomes the visible tab** (an `active` prop —
     every tab stays mounted forever behind `display:none`, so `useEffect` on
     mount fires once at boot and never again). Arriving on the page is exactly
     when the user is asking "did it appear?".
  2. **The only manual control was unreachable.** "Check for new servers" lived
     *inside* the `Authored by Claude` section, which renders only once a server
     has been found — a control that required its own outcome to have already
     happened. It is now also in the empty state.
  3. **`onInventoryChanged` was a PROCESS event, not a record event.** It was
     wired only to `supervisor.onStatusChange`, and an adopted-but-never-started
     record has no handle, so it fired nothing — `servers.json` gained the row
     and every subscriber stayed silent. Adoption is the one moment the user is
     told to go and look, which makes it the worst possible moment to be quiet.
     Now `emitRecordChange` folds record changes into the *same* subscription
     (one primitive, so no caller can subscribe to half the truth). **Removal
     had the identical bug in mirror image** — a deleted row sat on the page
     until a reload — and is fixed in the same place.
- **What the funnel proved once step 3 worked:** adopted **disabled** as
  "Awaiting review"; enable promotes a **separate copy** into
  `<userData>/mcp-servers/<id>/` (verified by hash, running from the
  non-agent-writable path); the model called `dna-toolkit/reverse_complement`
  and got `TACCGCAT`; quit stopped the child cleanly before `will-quit` with
  **no orphan**; reopen brought it back Available as a single instance.
- **Two more findings from the same run. (1) is FIXED (2026-09-08).** Saving an
  API key did not take effect until restart. `POST /credentials` updated only
  the server-wide `currentConfig` — the template for FUTURE sessions — while a
  live session held its own merged copy and kept the stale key for life,
  **including across the 401 retry, whose entire purpose is to pick up a
  refreshed credential**. Now `applyCredentialsToSessions`
  (`agent-server/sessionConfig.ts`, extracted there because `index.ts` cannot be
  imported under Jest — the Agent SDK is ESM-only, the same constraint
  `dynamicMcp.ts` was carved out for) patches every live session in place;
  `startQuery` closes over the same object, so replacing it rather than mutating
  it would silently not work. Two supporting changes: the explicit Settings save
  passes `force` so the `lastPushedApiKey` short-circuit (correct for the retry
  path, wrong for a deliberate save) cannot skip it, and a push that fails now
  returns a `warning` the UI shows — *"Saved. The assistant was not reachable
  just now, so restart Acabox if the next message still reports a key problem."*
  Silence there is what made a stored-but-401ing key read as a bad key.
  **(2) is NOT fixed:** the turn that called the tool produced no prose reply,
  only a collapsed tool card — the right answer was inside it, but the user has
  to expand it to see anything.
- **`remove()` now reclaims the promoted copy (R13, 2026-09-08).** It dropped the
  record and left `<userData>/mcp-servers/<id>/` on disk forever — dead disk for
  an npm-installed server (its own `node_modules`), and a landmine besides:
  re-adopting the same id would promote a fresh copy on top of a stale tree.
  Deliberately `rm`, not trash — that tree is a COPY the host made at approve
  time; the user's artifact is the agent-written source under
  `<workspace>/.mcp-servers/<id>/`, which is left alone.
- **Increment 9's "log rotation" needed no work, checked rather than assumed:**
  `cobuilding.log` already rotates (`log.transports.file.maxSize = 5MB`) and
  hosted-server stderr is a bounded 8192-char in-memory ring
  (`STDERR_RING_MAX_CHARS`), never written to disk. Nothing in this subsystem
  grows without bound. (`workspace-file-backups/` still does — unrelated, and
  still open.)
- **Still NOT verified:** Chat turn -> Claude writes a server
  -> *Authored by Claude* row -> enable -> host promotes the copy out of the
  agent-writable workspace -> agent calls it -> quit -> reopen. Every part is
  tested; the whole is not, and the catalog cut made it the only way in. Also
  unverified: the "Published by your tools" section with a mini-app actually
  mounted. And R3's `runtime` field was never added, so "we control
  `NODE_MODULE_VERSION`" stays narrower than stated for the Advanced
  typed-command path.

## Earlier status (last updated 2026-07-30)

**Mini-apps now speak the Command Desk language (2026-07-30).** Reported as
"our mini-app design still looks like Coscientist". It did, and nothing about a
mini-app's appearance was connected to the host: an app is a separate esbuild
bundle in a `local-file://` iframe, so it inherits **zero** CSS from the
renderer and cannot reach it (different origin, webpack-content-hashed font
URLs). Its look came from five places, all still carrying the pre-fork palette.
- **The style guidance was not merely dated, it was false.** `SKILL.md` told the
  agent the page MUST be `bg-[#faf8f5]` *because that is the host's nav-bar
  colour*. Grep says `#faf8f5` existed in exactly three places, all inside
  mini-app land — the host chrome is `#ffffff` on `--cd-border #dddde2`. The
  rule written to prevent a seam was creating one. Past that hex it said only
  "modern and professional": no tokens, no type scale, no vocabulary.
- **The fix is shipped assets, not prose.** New `assets/vendor/acabox.css` —
  the `:root` tokens, `@font-face` for DM Sans + IBM Plex Mono, and ~40 `ab-*`
  component classes (`ab-label`, `ab-card`, `ab-stat`, `ab-btn`, `ab-table`, …).
  `syncMiniAppAssets()` already force-copies `assets/vendor` → `_vendor` on
  every boot, so it needed no new plumbing. Fonts are **DM Sans + IBM Plex Mono
  only** (112 KB); Material Symbols is deliberately not shipped — mini-app icons
  stay lucide, and it is 281 KB for glyphs nothing renders.
- **The load-bearing trick is the REFLEX REMAP, not the token names.** The
  scaffold's Tailwind config re-points Tailwind's own `gray/slate/blue/red/
  amber/green` scales at the Acabox ramp. An agent writing React types
  `text-gray-500` and `bg-blue-600` by reflex and no amount of prose reliably
  suppresses that; redirecting the reflex works where forbidding it does not.
  Verified against the **real vendored tailwind.js** driving the **real
  scaffolded config**: `text-gray-500`→`#91919e`, `bg-blue-600`→`#0645b1`,
  `font-sans`→DM Sans, 12/12. (Tailwind emits `rgb(r g b / …)`, not hex — an
  assertion on the hex is a false negative, which cost one round here.)
- **`index.html` is written once at scaffold time and is then the app's own
  file**, so the link tag alone would never reach the 3 existing apps — and
  restyling the shared components to `var(--cd-*)` would have left them
  colourless there. The bridge (`_bridge/design-system.ts`) injects the sheet
  when absent. It **appends** to `<head>` rather than prepending: legacy
  scaffolds carry an inline `body { font-family: system-ui }` and both are
  element selectors, so only document order separates them. Utilities are
  unaffected either way — a class (0,1,0) beats an element rule (0,0,1)
  regardless of order.
- **Charts got the most attention because they dominate these apps visually.**
  New `@reusable/plotTheme.ts` is the single source for chart chrome and colour;
  `react-plotly/SKILL.md` had been shipping a *fifth* competing design system
  (system-ui, `#fafafa` plot wash, stock Plotly ramp). The categorical palette
  was **computed, not chosen** — run through the dataviz validator at
  `--pairs all` and passing all six checks (worst CVD ΔE 8.4 protan, normal
  floor 15.8, all ≥3:1 on white). **Six hues is a measured ceiling:** a 7th
  olive step collided with the orange (5.2 protan) and the green (12.2 normal
  vision) and was cut rather than re-tinted. Diverging arms are
  lightness-symmetric to 0.010 OKLab L with a **neutral gray** midpoint.
  `types.ts` no longer holds a second, different set of regulation colours.
- **`ErrorDisplay` keeps literal fallbacks on every `var()`** — it is the one
  component that must render when the app around it is broken, so it must not
  depend on a stylesheet having loaded.
- Verified: tsc clean; **757/757 across 43 suites** (35 new); smoke exits 0; a
  real app scaffolded by the **real script**, bundled by the **real esbuild**
  with the builder's exact flags, and executed in JSDOM — **29/29**, including
  no-double-inject on a new app, injection-after-the-legacy-style on an old
  one, and full token parity with `commandDesk.css`. Confirmed on disk that the
  new assets reached the dev workspace's `_vendor`/`_bridge`.
- **Existing apps do not self-heal.** Tokens, fonts and the shared components
  land on next rebuild, but each app's own `App.tsx` is agent/user code the host
  must not rewrite — so `bg-[#faf8f5]` written into an old app stays until the
  agent restyles it. `SKILL.md` now tells it to bring such an app's `<head>` in
  line when it touches one.
- **NOT verified visually.** Every claim above is from tests and measurement;
  nobody has looked at a rebuilt app. **Acceptance test: `npm start`, rebuild
  `coScientistUserMessages`, and confirm it comes back in DM Sans on white with
  blue (not green) accents.**
- Same pass: the **mic button in the side-panel composer was 8px low**. That
  field is `align-items: flex-end`, where the glyph (`margin-bottom: 14px`) and
  send button (`7px`) are pushed onto a shared centre line by hand; the mic is a
  `.cdIconBtn` and the compensating rule (`.cdComposerField .cdIconBtn`) is
  scoped to the *docked* composer's field class, which this composer does not
  use. Now given the send button's exact box. Pinned by a test that asserts the
  two **match each other** rather than asserting the numbers. Fixed from the
  computed geometry — a live layout measurement was attempted via Electron and
  **could not be completed** (GUI launches produce no output under the agent's
  shell, as recorded in Conventions).

## Earlier status (last updated 2026-07-29)

**Cleared the whole outstanding list: B21–B25, HTTP Basic, and mini-app API
access (2026-07-29).** Everything the v0.1.9 report left open.
- **B21 was the one that mattered**, and it was worse than "bypasses the trash".
  Its guard was `modifiedFiles(...).length === 0`, and `modifiedFiles`
  *deliberately* skips host-owned paths so a findings ledger never reads as a
  user edit — correct for "did the user change this", catastrophic for "is it
  safe to delete this", which used the same function. A skill with a hundred
  findings and no edits to its shipped files read **unmodified** and was erased.
  New `hostOwnedFiles()` asks the other half; the delete routes through
  `newTrashDir`/`moveInto`; a dropped skill holding findings is **kept as
  custom**. The general rule: anything deciding to DESTROY a skill must ask both
  questions. **`differential-expression` can now be retired safely.**
- **B22 had no ceiling, not just a slow path.** The 10s timeout is charged once
  per root PER SUPERSEDED TOKEN, so the worst case grew with (shared dirs ×
  superseded findings). Now one `BLAST_TOTAL_BUDGET_MS` across the whole call,
  and `execFile` instead of `execFileSync` — `recordFinding` and
  `findBlastRadius` are async. Pinned by a **liveness** test rather than a
  structural one: a 15ms timer must fire *during* a grep over 3000 files (~80ms
  measured here), which a synchronous grep cannot permit.
- **B24 is a real self-modification path, not tidiness.** The agent has Write and
  Bash on the workspace, so it could create `<workspace>/.claude/skills/<x>` and
  be shaping every turn by the next boot. Unknown adoptions and recoveries now
  arrive **disabled**. A directory matching a **shipped** skill stays enabled on
  purpose — recovery exists for a lost state file, and answering that by
  emptying the roster is worse than the risk it guards. Residual, recorded in
  code: an agent could name its directory after a shipped skill, but that reads
  as a MODIFIED built-in and cannot introduce a new one.
- B23 is guarded in `normalizeState` — the single funnel every state-file reader
  passes through — rather than in `reconcile` alone; B25 inside `deleteSkill`
  rather than at its IPC. Both cover every caller instead of the noticed one.
- **HTTP Basic + Benchling.** `basicCredential()` is the single place deciding
  between `user:password` and the key-as-username `secret:` convention that
  Benchling and Stripe use — getting that backwards yields a 401 identical to a
  wrong key. Benchling's host is **per-tenant**: measured that
  `demo.benchling.com/api/v2/entries` returns Benchling's own
  `authentication_error` while an unknown tenant does not resolve, so the
  catalog ships a `YOUR-TENANT` placeholder with `baseUrlNeedsEditing`.
- **Phase 2: mini-apps can call granted APIs.** `window.hostAPI.api.fetch()`,
  an `apis` array in the tool manifest, and a grant checklist in the tool's
  Settings panel. **The grant is read from the manifest in MAIN, never from the
  renderer** — a compromised renderer can lie about which tool is calling but
  cannot invent a grant. Buffered, not streamed: postMessage cannot carry a
  stream, and the large-download case belongs to the agent.
- Verified: tsc clean; **722/722 across 41 suites**; smoke exits 0; the **real
  bridge bundle** built with the real esbuild and executed in JSDOM (10/10,
  incl. `containerAPI === hostAPI` still holding); and Phase 2 driven live —
  ungranted **403** naming the tool, granted **200** with real Crossref data,
  a granted tool still **405** on a write, revoked **403**, unknown tool
  **403**, traversal tool name **400**.
- Note for anyone touching the bridge: it is **not** in the tsc project, so a
  clean typecheck proves nothing about it. Bundle and execute it.

**APIs: the user can register HTTP endpoints and Claude can call them
(2026-07-29).** Phase 1 of `docs/design/api-tokens.md`, agent-only. Asked for as
"how do I add an API key" after the Hex connector was signed in — the honest
answer being that Hex's MCP endpoint is OAuth-only *and* read-only by its own
server instructions, while its REST API is neither.
- **A connector is not a substitute and this is the gap it leaves.** MCP gives
  you the tools a vendor chose to expose. Most scientific APIs ship no MCP
  server at all, and an MCP response flows through the model's context, so a
  real dataset cannot come back that way. Ten of the sixteen catalog entries
  need **no credential** — the point isn't the keyring, it's that a registered
  API means a base URL the agent stops guessing, host-allowlist enforcement, a
  write gate, and an audit line.
- **`performApiRequest()` is the only code that sees a decrypted secret**, and
  callers reach it through a door that establishes identity: agent subprocesses
  over the loopback server, mini-apps over postMessage in Phase 2. **Mini-apps
  deliberately do NOT get the loopback URL** — a `local-file://` frame's fetch
  carries an opaque origin, so the proxy could not tell app A from app B and the
  per-app grant the user chose would silently not be enforced.
- **Redirects are followed by hand because of a MEASURED undici behaviour.** On
  Electron 37's Node 22.17, across a cross-origin 302: `Authorization` stripped,
  `Cookie` stripped, **`x-api-key` survives with its value intact**. undici
  protects the headers it recognises and has no idea a custom one is a
  credential. Auth is now re-attached **only on a same-origin hop** — stricter
  than the design's "still on the allow list", and also the more *compatible*
  reading: GitHub, Zenodo and Figshare all redirect downloads to a presigned
  object host that rejects a request carrying two auth mechanisms.
- **Read-only by default is a real boundary, not a guardrail.** The host holds
  the credential, so a refused write cannot be made by another route — unlike
  `block-secret-reads.sh` it is not defeated by the agent having unrestricted
  Bash, because Bash without the token is just Bash. It does **not** defend
  against reads as exfiltration; the audit log is the honest mitigation there.
- **`resolveTargetUrl` is where this gets attacked**, so it is pure and heavily
  tested. The ordering it depends on: an absolute URL in the caller's "path"
  WINS at parse time (`new URL('https://evil.com/x', base)`), which is exactly
  why the host check runs on the **resolved** URL. Also enforced: `..`
  containment within the base path *on the base host only* (an extra allowed
  host is a CDN with its own layout), no userinfo, https-or-loopback, and suffix
  matching that cannot degenerate — `.zenodo.org` matches `files.zenodo.org` and
  not `evil-zenodo.org`.
- **All 16 catalog base URLs were curled, not recalled.** The connector catalog
  carries the identical caveat and shipped a 404 `docsUrl` anyway. Two results
  worth keeping: protocols.io reports a *missing* token as **400**, not 401; and
  OSF's apparent failure was my own shell eating `[` brackets, not the API.
- New: `shared/apis.ts`, `main/apiStore.ts`, `main/apiProxy.ts`,
  `renderer/components/ApiSettings.{tsx,css}`. `'apis'` added to
  `RESERVED_CONNECTOR_IDS`; `mcp__apis__list_apis` added to the base allowlist.
  Nothing is pushed to the agent server on a change — the proxy reads the store
  on **every request**, so only the prompt's summary is session-scoped.
- **Verified at runtime, not just by test.** tsc clean; **704/704 across 41
  suites** (86 new: 39 on `resolveTargetUrl`/catalog, 27 driving the real proxy
  against real local HTTP servers, 20 on the store); smoke exits 0. Then, live:
  the proxy bound 23500 **before** the agent server started (38.697 vs 38.803,
  the ordering invariant holding in fact); a real chat turn had the agent read
  `$ACABOX_API_BASE`, use a 36-char token and return real Crossref data
  ("Nanometre-scale thermometry in a living cell"); a POST to a read-only API
  returned **405** with the agent quoting the actionable message verbatim; and a
  canary credential configured through the real UI reached the wire (Crossref
  401'd the bogus bearer, proving transmission) while appearing in **zero**
  places — chat DB, `cobuilding.log`, and settings.json plaintext all clean,
  with `enc:v1:` on disk from the real keychain.
- **Found by running it, not by reading it:** refusals wrote no log line at all
  — only an in-memory counter that dies with the app — so a blocked write left
  no lasting trace. Now logged, with a test pinning that a `query`-auth secret
  stays out of the refusal line too.
- **Deviations from the design, all deliberate:** cross-origin auth stripping
  (above); `allowedHosts` means *additional* hosts with the base host implicit,
  so editing `baseUrl` can't strand you on a stale allow-list; request bodies
  are **buffered** (100 MB cap) because a 307 replay cannot re-read a consumed
  stream — responses stay streamed and uncapped, which was the whole argument
  for a proxy over an MCP tool; an `apis:test` IPC was added because "did my key
  work" was otherwise unanswerable without starting a chat.
- **NOT done:** Phase 2 (mini-app bridge, manifest grant) — the grant check is
  written and tested so it is additive. No Basic auth, so **Benchling is
  deliberately absent** and is the first thing to revisit. Counters reset on
  restart, labelled "since launch". A newly added API is callable immediately
  but only *announced* to the next chat, since guidance is set at session
  create; `list_apis` reads live state.

**Skills are now user-owned, importable, and can accumulate knowledge
(2026-07-29). Built, verified, NOT yet exercised in real daily use.** Design in
`docs/design/skills-knowledge-loop.md` (operative) and
`docs/design/skills-plugins-connectors.md` (taxonomy, registries, the leaked-harness
assessment). Acabox is a private single-user tool, so third-party skill licences
are moot — do not re-raise them.
- **The old model destroyed user work by design.** `copySkillsToWorkspace`
  `cpSync`'d every shipped skill over `<workspace>/.claude/skills` on every
  provision and `rmSync`'d any directory not in a hardcoded `SKILLS` array. An
  edit died at the next boot; a custom skill was deleted outright.
- **Now Pristine / Store / Render.** Shipped skills stay read-only in
  `Resources`; the only writable copy is `<userData>/<channel>/skills/<id>/`;
  `<workspace>/.claude/skills/<id>` is an **absolute symlink** into it. Verified
  the CLI loader accepts symlinked dirs (`isDirectory()&&!D.isSymbolicLink())return`
  in the darwin-arm64 binary) and keys identity on the **dirent name** — frontmatter
  `name` is a display alias only. Render must stay under `.claude/`: a
  workspace-root symlink is unlinked on every `containerService.start()` by the
  reaper at `containerService.ts:220-227`, which skips dot-prefixed names at `:221`.
- **The write-path problem is dissolved, not solved.** Agent `Edit`, a Bash
  heredoc, vim and the UI all land in the same inode. `MODIFIED` is *derived*
  (`sha256(store file) !== baseline[relPath]`, **per file**, so one edited byte in
  `xlsx/SKILL.md` does not block upstream fixes to its other 53 files), never a flag.
- **Unknown directories are ADOPTED as custom skills, never pruned** — the
  deliberate inversion of the old destructive loop. Revert is rename-to-trash then
  copy-from-pristine, never a bare delete; trash at `<userData>/<channel>/skills-trash/`.
  `references/findings/**` is host-owned and excluded from both baseline and revert,
  so a Revert cannot destroy accumulated knowledge.
- **Importing works end to end**, no git: one codeload tarball, `/usr/bin/tar`
  (real bsdtar, unlike the `/usr/bin/git` CLT shim). Measured: `anthropics/skills`
  18 skills / 3.68 MB / 1.5s; `openai/plugins` **581 skills / 21.7 MB / 8.2s with
  zero further API calls**. Provenance pins a resolved **40-char SHA** plus two hash
  sets — `upstreamBlobs` answers "did upstream change", `baseline` answers "did I
  change it" — which is what lets an upstream fix be taken while local edits are kept.
  Symlinks are stripped from every payload (bsdtar refuses `..` but *does*
  materialise absolute links, and the workspace reaper only covers root-level ones).
  **Imports arrive `enabled: false`**, enforced as a literal in `skillStore.ts:1153`
  that no caller can override. Id collisions **refuse** — never silently rename
  (the id is what the model types and what the skill's own prose refers to) and
  never replace.
- **The roster was silently over budget and is now fixed.** The always-in-context
  skill listing is capped at `contextTokens × 4 × skillListingBudgetFraction`;
  at the 1% default that is 8,000 chars and the 21 shipped skills need **10,193**
  (real YAML parse — a regex under-counted by 55% because descriptions are
  multi-line block scalars). `skillListingBudgetFraction: 0.05` set at
  `agent-server/index.ts:473`. `autoDreamEnabled: false` alongside it: consolidation
  runs with `Edit`/`Write`/`rm` in the memory dir, is told CLAUDE.md wins over any
  contradicting memory, and cannot tell hand-authored bytes from generated ones.
- **Memory ≠ skills, and the rule is: if Claude must type it into a prompt for
  another system, it is a skill.** `mcp__hex__create_thread` takes one string and
  Hex's agent cannot see the workspace, so warehouse knowledge must be restatable
  into that string — a memory cannot guarantee it is in context. **Measured: automatic
  memory recall is NOT firing here** — zero `memory_recall` / `relevant_memories`
  across all 10 production transcripts; the gate is `tengu_moth_copse`, default off.
  Memory works only because `MEMORY.md` is unconditionally loaded and the agent then
  chooses to `Read` what it points at. Do not render a "recalled from memory" chip.
- New: `shared/skills.ts`, `shared/agentAllowedTools.ts`, `main/skillHash.ts`,
  `main/skillStore.ts`, `main/skillRender.ts`, `main/knowledge/{skillImporter,
  skillImportService,findingsLedger,omissionWatch}.ts`, `renderer/components/knowledge/`.
  Two boot assertions: `mcp__knowledge__record_finding` must be in the resolved
  `allowedTools` (`filterMcpServers` drops a relay with no matching entry, so
  forgetting it makes write-back vanish silently), and `.applications/_bridge` must
  exist after provisioning.
- Verified: tsc clean; **592/592, 34 suites**; smoke exits 0; and the acceptance
  test run for real — an edit to a built-in **survived a reboot** and reads MODIFIED,
  a hand-made custom skill **survived and was adopted**, and a real import from
  `anthropics/skills` landed with all four `upstreamBlobs` matching GitHub's tree
  API byte-for-byte.
- ~~**NOT verified, and the headline rests on the first one:** whether the model
  *volunteers* `mcp__knowledge__record_finding` mid-task~~ **Verified 2026-09-30: it does — 134 calls across 11 skills in production (see the 2026-09-30 entry).** The rest of this bullet is kept as written: — every ledger test drove
  the call directly or instructed it, and the design's one-week measurement has not
  been run. Also unverified: that `skillListingBudgetFraction` is honoured **at
  runtime** (fallback is the env var `SLASH_COMMAND_TOOL_CHAR_BUDGET`); that the
  knowledge relay survives `applyConnectorsToSession`'s mid-session `setMcpServers`
  replacement (this codebase has been burned by exactly that once); and a genuine
  fresh-install boot on a virgin machine, which is covered by tests only.
- Known and unpruned: `<userData>/workspace-file-backups/<stamp>/` accumulates one
  directory per hook/settings restore with no counterpart to `pruneSkillsTrash`.

**On-device voice dictation in both chat composers (2026-07-29).** Asked for
after seeing dictation in the Claude Code IDE extension. **Being built on the
Agent SDK buys nothing here** — Anthropic has no speech-to-text API and Claude
accepts no audio input, so the transcript has to come from somewhere else
entirely.
- **The browser route is dead in Electron, and this is checked rather than
  assumed.** `node_modules/electron/dist` ships **no `libsoda` and no SODA model
  files** (18 `soda_` strings in the framework, zero model assets), so
  Chromium's on-device path cannot run; the surviving Web Speech path POSTs the
  microphone to Google, which is disqualifying for an app whose premise is that
  research data stays local. A runtime probe of `webkitSpeechRecognition` was
  attempted and **could not be completed** — Electron GUI launches produce no
  stdout under the agent's shell — so that half is reasoned from the shipped
  binary, not observed. It doesn't change the decision: even a working Web
  Speech would be the wrong answer on privacy grounds.
- **Apple's Speech framework, in a Swift helper.** New
  `src/cobuilding/swift/dictation-mac/main.swift` — second instance of the
  existing native-helper pattern (the Rust file monitor is the first). Measured
  on this machine: `SFSpeechRecognizer` en-US `available=true onDevice=true`
  across 63 locales, and `SpeechTranscriber` (macOS 26 `SpeechAnalyzer`)
  **present**, 30 supported locales, 9 installed. Prefers `SpeechTranscriber`
  with the `.progressiveTranscription` preset (volatile results — plain
  `.transcription` returns nothing until you stop talking, which reads as a
  hang), falls back to `SFSpeechRecognizer` below macOS 26. Newline-delimited
  JSON over stdio both ways.
- **`--probe` is prompt-free, and that is the load-bearing property.** It
  reports engine/locale/model/auth while touching neither the microphone nor the
  recognizer, so a composer can ask "does dictation exist" on mount without
  nagging. That is what lets the mic button be **absent** rather than
  present-and-disabled where it can't work — a permanently dead control is worse
  than no control. Pinned by a test that probes twice and asserts `speechAuth`
  stays `notDetermined`.
- **Wired through assistant-ui's own dictation primitives, not around them.**
  `@assistant-ui/react` already has `ComposerPrimitive.Dictate` /
  `.StopDictation` and a `DictationAdapter` contract; the shipped
  `WebSpeechDictationAdapter` is exactly the thing that can't work, so
  `renderer/hostDictationAdapter.ts` implements the same interface over the
  helper. Registering it in `useLocalRuntime({adapters})` is also what enables
  the primitive — with no adapter the hook returns null and the button disables
  itself, which is the right outcome on a machine with no helper. The runtime
  snapshots already-typed text as the base, so appending is free.
- **Transcript ordering is a real trap, now covered.** The helper's `partial`
  is the whole utterance so far, not a delta (later words revise earlier ones),
  which matches assistant-ui's "interim replaces the tail" model — marking
  partials final would concatenate and duplicate. And the final transcript must
  be delivered via `onSpeech(isFinal:true)` **before** `onSpeechEnd`, because
  the runtime tears the session down inside `onSpeechEnd`; after it, the user's
  last words are silently discarded.
- **Two bugs found by tests, not by reading.** (1) The helper called `exit(0)`
  straight from the stdin reader, racing in-flight tasks — it could terminate
  with the audio engine still running and the closing `stopped` unwritten.
  Shutdown now queues behind the `Session` actor. (2) The window-destroyed
  cleanup was hung off `app.on('web-contents-created')` inside
  `registerDictationHandlers()`, which runs **after** `createMainWindow()` — so
  it would never have fired for the one window that matters. Now attached at
  ownership time, no ordering dependency.
- Also: `stop()` waits for the helper's `final` (resolving early cuts the last
  word) with a 3s timeout so a dead helper can't wedge the composer in
  "recording"; the helper exits on stdin close so a crashed Acabox can't orphan
  a process holding the mic; one helper app-wide, kept warm between dictations
  (~200ms of spawn latency sits right between pressing the mic and being able to
  talk) and holding no audio device while stopped.
- Build is **deliberately non-fatal**: no Command Line Tools → no helper → no
  mic button, rather than a broken `npm start` for everyone. `prestart` builds
  debug, `premake`/`prepackage` build release; `forge.config.js` ships it via
  `extraResource` guarded on existence. Added `NSMicrophoneUsageDescription` +
  `NSSpeechRecognitionUsageDescription` to `extendInfo` and `audio-input` +
  `speech-recognition` to `entitlements.plist` — the helper is not itself
  bundled, so TCC resolves the usage strings against Acabox.app as the
  responsible process, and **omitting either one kills the helper on first use
  rather than denying it gracefully**.
- Verified: tsc clean; jest **276/276** (30 new — 6 against the REAL helper
  binary's stdio protocol, 17 on adapter transcript ordering, 7 rendering the
  real button through React); smoke test exits 0; `--probe` exercised against
  en-US, an uninstalled locale (fr-FR), and a bogus one.
- **NOT verified: a single word has never been dictated.** Every mic-touching
  path is untested. This was a deliberate choice — driving `start` from the
  agent's shell would have granted Speech Recognition TCC to the terminal
  instead of to Acabox, a real change to the machine a test has no business
  making — and Electron GUI launches produce no output here anyway. **Acceptance
  test: `npm start`, click the mic in the composer, grant both prompts, speak,
  and confirm text appears and survives pressing stop.** Until that runs, treat
  the whole live path as unproven.
- Known consequence of ad-hoc signing: TCC grants are keyed to a signature that
  changes on every build, so **auto-update will likely re-prompt for microphone
  access** — same root cause as the Squirrel designated-requirement problem
  below. Not fixable without a Developer ID.
- Not done: macOS-only (consistent with arm64-darwin being the only build), and
  dictation is not exposed to mini-apps through `window.hostAPI` — composer-only
  by choice.

**Released v0.1.6 (2026-07-29).** Everything below through the connector OAuth
pin is shipped. Verified after publishing, not from the release log: the three
assets carry the right 0.1.6 names/sizes (dmg 187,318,598 · zip 190,210,548 ·
yml 391), `latest-mac.yml` is **anonymously downloadable** with the token
stripped from the environment (`http=200` — the property the updater depends
on), its sha512 matches the built zip byte-for-byte, and the packaged bundle is
`valid on disk / satisfies its Designated Requirement` with
`CFBundleShortVersionString` 0.1.6 and id `com.electron.acabox`. Also checked
that the fix actually shipped rather than merely built: the `agent-server.js`
**inside `Acabox.app/Contents/Resources`** carries the new boot assertion and
boots to `[AgentServer] Listening` + a healthy `/health`. Ad-hoc signed as usual
(no Developer ID), so a fresh download still needs right-click → Open;
auto-update installs via `main/selfUpdater.ts` rather than Squirrel.

**Connector OAuth sign-in was unwinnable by construction; sessions now pin
across the browser round-trip (2026-07-29).** Reported as "I still can't connect
to Hex". Root-caused from the real logs and the shipped CLI binary, not inferred.
- **One mechanism, both symptoms.** The pending handshake — PKCE verifier, state
  nonce, and the `127.0.0.1:<ephemeral>/callback` listener — lives *only* in the
  memory of the CLI subprocess that ran `mcp__hex__authenticate` (binary offsets
  `@81464045` for the module-scope flow maps, `@81445700` for
  `k.listen(P,"127.0.0.1",…),k.unref()` and the `setTimeout(…,300000)` ceiling).
  The tool deliberately returns early via `Promise.race` with the URL — so
  **handing the user the link IS what ends the turn** — and the host destroyed
  the session at every turn end. The listener died seconds later
  (`ERR_CONNECTION_REFUSED`), and `complete_authentication` ran in a *later*
  subprocess whose map was empty. Its first statement is
  `let T=mdH(H);if(!T)return{...'No OAuth flow is in progress'}` — a lookup miss
  checked **before** the code, state or port is examined, which is why a
  byte-exact state could not help and the rejection took 3ms with no network call.
- **The kill chain**: renderer detaches at turn end → `sessionRegistry.ts:154`
  destroys → `agentSession.ts:572` POSTs `/stop` → `agent-server/index.ts:893`
  `queryInstance.close()` → SDK ends stdin, SIGTERM +2s, SIGKILL +7s. Measured in
  the production log: 25 `Creating session` / 25 `Starting query()` / 25
  `message received`, one-for-one — **no agent-server session in the entire log
  ever received a second message.**
- **Fix: a pin, not a rewrite.** New `shared/oauthWindow.ts` holds
  `OAUTH_FLOW_WINDOW_MS = 300_000` — matched to the CLI's own hard ceiling, which
  has no config knob, so shorter discards a live flow and longer holds an
  API-key-bearing process that can no longer accomplish anything.
  `sessionRegistry` gained `pinSession`/`unpinSession`; a pin outranks visibility
  in `removeSubscriber` and in the deferred-destroy hook. The trigger is the
  event stream the registry already listens to (`tool-call` matching
  `MCP_AUTHENTICATE_TOOL`) — no new plumbing and no import cycle with
  `agentSession`. **The tradeoff is that session lifetime is now coupled to a
  tool NAME**: if the SDK renames these tools the pin silently stops arming and
  the original bug returns.
- **A pin defers eviction, it does not cancel it.** Caught by a test, not by
  reading: the pinned branch of `removeSubscriber` originally just returned, so
  when the pin was released the entry had no `pendingDestroy` and leaked a dead
  session forever. It now records the destroy as owed.
- **Idle eviction is an ordering invariant, not a second protocol.**
  `IDLE_EVICTION_MS` (10 min) must exceed the pin window, because a session
  waiting on a browser is *idle by that timer's definition*. Rather than push
  pin-awareness across the process boundary, the agent server now **throws at
  boot** if the relationship is ever inverted.
- Also fixed, all found during the investigation and all proven: `POST
  /connectors` updated `mcpServers` but never `allowedTools`, so `mcp__hex` was
  absent for the running server's entire 12h life (survivable only because
  there is no `canUseTool` handler); an agent-server crash-restart replayed the
  **boot** config and would silently delete every connector added since, with no
  log line; four call sites addressed the server as `localhost` while it binds
  `127.0.0.1`; and the Hex catalog `docsUrl` 404'd. The allowedTools recompute is
  now one shared `replaceConnectorAllowedTools` used by both the agent server and
  the host's restart config — if those two ever disagreed, a crash would change
  which tools are auto-approved.
- **Two CLAUDE.md claims were wrong and are struck through below.** "The CLI
  subprocess survives across turns" is true of the SDK and false of the app.
  "Tokens persist to `mcpOAuth` in `.claude.json`" is false for SDK 0.2.121 —
  they go to a credentials store, **macOS keychain primary**, 0600
  `.credentials.json` fallback. **Verify a sign-in by the keychain entry or by
  the connector's real tools appearing, never by grepping `.claude.json`.**
- The workspace agent had written itself a memory note telling future turns
  never to retry OAuth. Rewritten (not deleted — its diagnosis was right) to
  state the deadline instead; its IPv6/IPv4 "fault 2" was a red herring, which
  its own forwarder experiment proves.
- **Residual risk, stated plainly: the payoff path has never run in production.**
  A surviving session means the next turn takes the `existingRunning?.isRunning`
  branch at `main/index.ts:1684` and calls `sendMessage` on the LIVE session —
  pushing onto the queue the streaming `userMessageGenerator` is consuming, so
  the same CLI subprocess handles it. That is the SDK's intended design and the
  code has always been there, but per the log above **no agent-server session
  had ever received a second message**, so it was dead code until now. Checked
  by reading, and the prerequisite holds: `broadcastSSE(state,'done')`
  (`agent-server/index.ts:502`) fires only after the `for await` loop ends —
  `/stop`, idle eviction, or crash — never between turns, so `running` stays
  true and `onDone` does not clear the pin at every turn boundary. Not yet
  exercised at runtime.
- Verified: tsc clean; jest **245/246** (35 new — 27 on the pin lifecycle incl.
  the exact turn sequence and the leak above, 8 on the recompute; only the
  pre-existing `fileMonitorIntegration` fails); the predicates checked against
  the **exact tool names in the user's real transcript** (4×
  `mcp__hex__authenticate`, 3× `mcp__hex__complete_authentication`, with
  `mcp__mini-apps__open_mini_application` from the same file as a real negative);
  the rebuilt bundle boots and `allowedTools` observably tracks `mcpServers`
  across add/remove/clear. **NOT yet verified: a real end-to-end Hex sign-in** —
  that needs the user's own Hex account. Acceptance test: authorize in the
  browser, then confirm a real Hex data tool returns data.

**Transcripts are now reclaimed, and every image format converts (2026-07-29).**
The two gaps flagged at the end of the overflow work below, both closed.

*Deleting a chat no longer strands its SDK transcript.* Nothing in the app ever
deleted one — `deleteSession` dropped the row, the Debug hard reset dropped
every row, and `<CLAUDE_CONFIG_DIR>/projects/<key>/<id>.jsonl` stayed forever.
Not small: two ordinary chats on this machine carry 1.38 MB and 1.1 MB.
- **One chat is one transcript** — established by measurement, not assumption:
  resume *appends* and keeps the same session id (`b31f64b2` grew 922 KB →
  1.38 MB across turns while staying the referenced id). So there is no chain
  of ancestor files to chase and a targeted delete is complete.
- New `main/transcriptStore.ts`. `deleteTranscript` is called from
  `sessions:delete` **before** the row is dropped — afterwards there is nothing
  left to identify the file by. `sweepOrphanTranscripts` removes anything no
  live `sessions.sdk_session_id` names; the Debug hard reset calls it with an
  empty live set (every chat is gone, so every transcript is unreachable).
- **The sweep is sound because resume only ever names an id read out of that
  column** — an unreferenced transcript can never be replayed. It therefore also
  reclaims transcripts from runs that were never chats (workspace scanner, title
  generation, dev harnesses); those are one-shot queries, so that is intended.
- **Runs at boot, and must stay there.** Nothing is resuming or writing a
  transcript at that point. Do not move it onto a timer — the scanner and title
  generation both create transcripts mid-run and would be swept out from under
  themselves.
- Verified beyond unit tests: the sweep's decision was dry-run against the
  **real production config dir** before it could run for real — kept all 4 live
  chat transcripts, deleted exactly the 5 dev-harness orphans, and treated the
  one live id whose file was already gone as a no-op. Then a real `npm start`
  boot swept the **development** channel (3 orphans, 50 KB) and kept the only
  referenced transcript there.

*Every image format the API rejects now converts.* `ImageAttachmentAdapter`
special-cased TIFF and inlined everything else under `image/*` with a
`media_type` the API refuses (HEIC — every iPhone photo — plus BMP, AVIF, SVG).
- The converter is macOS `sips`, and **it sniffs content rather than trusting
  the extension** (verified by converting a BMP written to a `.tiff` path), so
  the existing plumbing already handled all of them. Verified end to end through
  the handler's exact command: HEIC, BMP, AVIF, TIFF all convert; **SVG is the
  only failure** — sips cannot rasterize vector — and falls through to a
  workspace path, which is the better answer anyway since an SVG is text the
  agent can read directly.
- **`needsConversion` keys on MIME alone, deliberately.** The MIME is what gets
  sent as `media_type`, so it is exactly what must be one of the four; Chromium
  derives it from the extension anyway. An extension check was written first and
  removed — it re-encoded a correctly-typed PNG whose name carried no extension
  (a pasted screenshot) for nothing. Related fact, now covered by a test because
  the rule depends on it: a file Chromium cannot type at all **never reaches this
  adapter** — `image/*` does not match an empty MIME, so the composite routes it
  to the wildcard and the agent gets a path.
- Incidental bug my own change would have made reachable: the converter's temp
  files were named `convert-${Date.now()}.{tiff,png}`, which collide when two
  conversions land in the same millisecond. Harmless when only TIFF went through
  it; a real corruption risk once *dropping several photos at once* converts
  them concurrently. Now `randomUUID()`, and the input extension is `.img` since
  it never carried a truthful format claim.
- Verified: tsc clean; jest **210/211** (22 new; only the pre-existing
  `fileMonitorIntegration`); smoke test exits 0.

**A context overflow no longer kills a chat forever; images got the ceiling
documents already had (2026-07-28).** Reported from the field: a thread where
*every* turn — including a bare "Hi" — came back `Prompt is too long`.
Diagnosed from the real data, not inferred: the thread's SDK transcript was
**5.5 MB, of which one line was 5,494,023 bytes** — a `document` block holding
an entire 39,335-row CSV, inlined at 2026-07-27T20:31Z. Commit `a18bd6b3`, which
stops oversized documents being inlined, landed at 20:36Z — **five minutes
later**, so the attachment predates its own fix (confirmed `a18bd6b3` is an
ancestor of the v0.1.5 release commit, and its 6 regression cases still pass).
- **The cause was fixed; the damage was not, and could not heal.** Every turn
  resumes the same transcript, so the failure had nothing to do with what the
  user typed. `agentSession.ts` now detects the rejection at the `result`
  message (`is_error` + the API's wording — **matching the text too is
  load-bearing**, since an ordinary failed turn also sets `is_error` and
  dropping the agent's memory of a conversation is far too destructive a
  response to a tool that threw), clears `sessions.sdk_session_id` via the new
  `clearSdkSessionId`, and replaces the bare error with an explanation that says
  plainly what was lost.
- **Clearing the DB column alone was not enough** — `startLoop` falls back to
  the constructor-time `sdkSessionId` when the column is null, which would
  resurrect the id we just cleared if the loop restarts inside the same session
  object (second message before the registry destroys it, 404 re-queue, auth
  retry). A `resumeDisabled` flag on the shared `TurnState` closes it.
- **The explanation is inserted BEFORE the result row**: `cleanupOrphanTurnRows`
  sweeps assistant rows that land after the last `result`, so writing it after
  would have made it vanish on the next boot.
- **Images were the last hole of the CSV's class.** `ImageAttachmentAdapter` is
  first in the composite, accepts `image/*`, and had **no ceiling at all** — not
  even the 30 MB user guard, which lives only in the file-reference adapter. The
  ceiling is a *transport* limit, not a token budget (the API downscales to
  ≤4784 visual tokens, so an image cannot blow the window): 10 MB **base64**
  per image, i.e. ~7.5 MB of source, so 7 MB with margin. TIFF is measured on
  the **converted PNG** — a compressed scan expands several-fold, so the source
  size says nothing about what would actually be sent.
- Verified: tsc clean; jest **188/189** (10 new; only the pre-existing
  `fileMonitorIntegration`); the overflow predicate exercised against the
  **exact payload observed in the user's DB** plus the ordinary-failure cases it
  must not fire on; `clearSdkSessionId`'s SQL run against a **copy of the real
  production cobuilding.db** by `scripts/verify-clear-resume-pointer.sh` (jest
  can't — better-sqlite3 is built for Electron's ABI); smoke test exits 0.
- The 5.5 MB transcript was deleted (backed up first, and the CSV recovered out
  of it intact at 39,335 rows). Two gaps found here — orphaned transcripts on
  chat delete, and `image/*` formats the API rejects — were **both closed
  2026-07-29**; see the entry above.

**Released v0.1.5 (2026-07-28).** Everything below through the tool-status work
is shipped. Verified after publishing, not just from the release log: the three
assets carry the right 0.1.5 names/sizes, `latest-mac.yml` is **anonymously
downloadable** (the property the updater depends on — no embedded token), its
sha512 matches the built zip byte-for-byte, and the packaged bundle is `valid on
disk / satisfies its Designated Requirement` with `CFBundleShortVersionString`
0.1.5 and id `com.electron.acabox`. Ad-hoc signed as usual (no Developer ID), so
a fresh download still needs right-click → Open; auto-update installs via
`main/selfUpdater.ts` rather than Squirrel.

**Stop, build health, and an Activity surface (2026-07-28).** Closing the three
gaps left by the job registry below. The framing that drove the design: all
three are the same question at different moments — *what is my computer doing
for me, and what happened while I wasn't looking?* — so they share one surface
rather than being three patches.
- **Stopping work was not a convenience, it was a missing emergency brake.**
  There was no way to stop a running tool at all: not from the tool, not from
  the app, and **not by quitting** (verified — the app exits and the work keeps
  going). A tool stuck in a loop, burning CPU or the user's API key, survived
  every gesture short of Activity Monitor. `cancelJob` now kills `command` work
  outright and asks the owning renderer to interrupt `kernel`/`claude` work
  (relayed via `jobs:cancelRequested`; the shell handles it so it works with no
  viewer mounted). Stop lives in the tool header and on every Activity row.
  Cancelled is its own status, distinct from `failed`, because half-written
  output must not be adopted as a result — and it does **not** stamp `lastRun`.
- **Kills walk the process tree, never `kill(-pid)`.** These children are
  spawned without `detached`, so they share Acabox's own process group — a
  negative-pid signal would kill the app itself. `descendantsOf` recurses via
  `pgrep -P`, SIGTERM from the leaves up, SIGKILL to survivors after 3s. Covered
  by a test that builds a real `sh → sh → sleep` tree and asserts every level
  dies (a naive single-pid kill leaves the grandchild running).
- **Quit warns instead of killing (user's call).** `before-quit` shows
  Quit / Stop them and quit / Cancel when work is in flight, so the long-run
  case (close the lid at 6pm, analysis finishes overnight) keeps working while
  never being a silent surprise. Guarded against blocking a headless quit —
  `--smoke-test` and a destroyed-window state skip the prompt.
- **New `main/buildHealth.ts` — build failure is a health state, not a status.**
  Statuses describe what's happening now and are rightly transient; "this tool
  doesn't build" is a property of the tool that stays true while nobody is
  looking. Recorded inside `buildMiniApp` so every build path (Rebuild button
  and the agent's tool) reports identically, persisted to
  `<userData>/tool-build-health.json` — deliberately **not** the manifest, which
  travels on export, where a failure on this machine means nothing. Cleared on
  tool delete so a later tool reusing the dir name doesn't inherit it.
- **New `command-desk/ActivityPanel.tsx`** replaces the old briefings page on
  the under-used Activity tab: *Needs attention* (unseen outcomes + broken
  tools, each with **Ask Claude to fix it**, which composes the real build error
  into a chat turn), *Running now* (with Stop and elapsed time), *Recently
  finished* (24h). Empty sections aren't rendered. Wording never invents an
  outcome — work that outlived a quit reads "result unknown", because we weren't
  its parent and there is no exit code.
- Verified live: a failed build put **BUILD FAILED on the home card with no
  viewer mounted** (impossible before); Stop killed a real `sleep 300` and the
  job read `cancelled`; the Activity panel rendered all three sections with the
  right copy. Plus 19 registry cases (incl. the real process-tree kill) and 29
  store cases. tsc clean; jest 178/179 (only the pre-existing
  `fileMonitorIntegration`); smoke test exits 0.
- **Still not done: notifications.** Deliberately deferred — the design is the
  hard part, not the plumbing. The unit should be the *wait*, not the job (a
  tool making 20 short kernel calls must not fire 20 toasts), tiered by where
  the user is: in-app cue when they're elsewhere in Acabox, OS notification when
  they've switched away, and a digest line on Home for work that finished while
  it was closed. Only for user-started work that ran past ~30s or failed —
  background dep installs must never toast.
- Known nit: `buildFailed` outranks `working` in the chip precedence, so a
  broken tool that is somehow also running shows BUILD FAILED. Activity shows
  both, which is what it's for.

**The host owns a tool's work; status survives navigation and restart
(2026-07-28).** Follow-on to the status rewrite below, which left a real gap:
`clearToolStatus` fired when a tool's viewer unmounted, so the status went dark
while the work carried on. Established by test first: a mini-app's shell command
**completes normally after Acabox has fully quit** (0 Electron processes left,
marker file still written on schedule) — `exec` children aren't in the
`before-quit` teardown and a POSIX child outlives its parent.
- **New `main/jobRegistry.ts`** — a persisted, host-owned record of what each
  tool is doing (`<userData>/tool-jobs.json`). `container:execLogged` opens a
  job itself when `appDirName` is set (it owns the child process, and gets its
  pid via the new `exec(..., {onSpawn})`); the renderer reports what main can't
  see for itself — kernel runs and Claude calls — over `jobs:begin`/`jobs:end`,
  tagged with the reporting WebContents so its death closes them out.
- **Boot reconciliation is per-kind, because survival is per-kind.** A `command`
  may genuinely still be running, so its pid is checked and the job re-adopted;
  `kernel` dies with the app (the gateway is killed in `before-quit`) and
  `claude` is an HTTP call from main, so both are reported **interrupted** and
  never as running. An adopted job whose process is gone becomes
  `finishedWhileAway` — it ran unsupervised, so claiming it succeeded would be
  a guess. Adopted pids are polled (3s) since nothing will notify us.
- **Bug caught by the test, not by reading:** the pid fingerprint originally
  included the command line, but `sh -c "…"` **execs** into the program it runs,
  so `ps` reports `/bin/sh -c sleep 30` at spawn and `sleep 30` moments later —
  every shell command would have failed to re-adopt. The signature is now start
  time only (pid + start time is unique; pid reuse gets a new start time).
- **Consequences in the UI.** The home/rail chip is no longer unreachable: a
  tool with work in flight reads **WORKING** with no viewer open. `StatusBar`
  gained a "N TOOLS WORKING" segment (hidden at zero) — the only always-visible
  surface. New `interrupted` status renders **RAN WHILE CLOSED** /
  **INTERRUPTED**, cleared when the user opens the tool (`jobs:acknowledge`).
  `lastRun` is now stamped by **main** on job completion, so it records work the
  renderer never saw finish; the renderer-side `miniApps:markRun` IPC is gone.
- **Tools are now expected to be resumable** (the other half — results must
  outlive the UI, not just the status). `useAppState` exposes `lastRunAt`; new
  `@reusable/useRunsWhileClosed` compares it against the host's job history and
  reports runs that completed while the tool was closed, via a new
  `jobs:listForApp` bridge call, so the app can re-read `output/run_metadata.json`
  and adopt results it never got to record. SKILL.md gained a "Your UI is not
  where the work lives" section making this a rule rather than a nicety.
- Verified live end-to-end, not just unit-tested: work started with **no viewer
  open** lit the home card WORKING + "1 TOOL WORKING"; quitting Acabox left 0
  Electron processes with the work still alive; **reopening showed WORKING again
  immediately**; and when the process exited at t+70s the card flipped to RAN
  WHILE CLOSED. Plus 14 jest cases against the real registry (adopt/interrupt/
  recycled-pid/persistence, exercised against real live and real dead pids) and
  10 more on the store's host-job merge. tsc clean; jest 173/174 (only the
  pre-existing `fileMonitorIntegration`).
- Not done: no notification when work finishes while you're elsewhere, and no
  way to cancel a running job from the UI. Both are natural next steps now that
  the jobs are enumerable.

**Measured: what an open tool actually costs in memory (2026-07-28).** Taken to
size a "keep tools alive when you navigate away" decision. Method: dev build,
one **fresh app launch per condition** (tool tabs persist in app state, so
conditions leak into each other otherwise), median of 5 samples, macOS
`phys_footprint` — the number Activity Monitor calls "Memory".
- **All mini-apps share ONE renderer process, not one each.** Verified with 1,
  2, 3 and 4 tools open simultaneously — always exactly 1 extra process. They
  are all same-origin (`local-file://`), so Chromium's site isolation puts them
  together. Any reasoning that assumes a process per tool is wrong.
- Simultaneously-open tools (React tool w/ a 250-row table): **1 → 36 MB,
  2 → 42 MB, 3 → 46 MB, 4 → 51 MB.** So the *first* tool costs ~36 MB (mostly
  the shared process itself, paid once) and each additional ordinary tool adds
  only **~5 MB**.
- By weight, measured alone: trivial (no framework) **21 MB**, typical React
  **36 MB**, heavy (120k parsed records held in memory) **145 MB**.
- **Conclusion: memory is not the constraint on keeping tools warm.** Four
  ordinary tools ≈ 51 MB. The risk is concentrated entirely in data-heavy
  tools — one is worth ~3 typical ones — so any eviction policy should be
  **memory-aware, not count-aware** ("keep the last 3" is the wrong shape).
  The real arguments against keep-alive are non-memory: unattended CPU/API
  spend, silently stale data, and invisible accumulation.
- Caveat: the app's own dev baseline (~650 MB) is inflated by dev tooling and
  is **not** a production number; no prod baseline was captured. The per-tool
  figures do transfer, since the mini-app bundle is identical in both.

**Removed the stale signing scripts + the wrong release warning (2026-07-28).**
`release.mjs` warned that "macOS auto-update will download but FAIL to install
until Developer-ID signed + notarized (Squirrel.Mac refuses unsigned updates)"
— untrue since `main/selfUpdater.ts` took over the install step precisely to
remove that requirement. It now states what is actually true: auto-update
works, and the only consequence of an ad-hoc build is Gatekeeper on a *fresh
download* (right-click → Open). Also deleted the `codesign`, `package:sign`
and `make:sign` npm scripts: they ran `codesign` **after** the dmg/zip were
built, so they never reached the distributed artifact, and forge's
`postPackage` hook already ad-hoc signs at the correct point (before the
makers). They were dead and actively misleading — running `make:sign` would
have produced an artifact no better than `make`, with the false impression it
was signed. The Squirrel references left in `selfUpdater.ts`/`updater.ts` are
accurate and explain why that module exists; they stay.

**Port isolation + secrets at rest (2026-07-28).** Two hazards the connector
work surfaced, both fixed and verified live.

*Dev no longer hijacks the packaged app's agent server.* `findFreePort` probed
`0.0.0.0` while both host servers bind `127.0.0.1`; on macOS the wildcard bind
succeeds while loopback is held, so a dev instance called 23200 "free" while
the packaged app served on it, then `isAgentServerHealthy()` saw a 200 and
adopted it — wrong workspace, wrong key, wrong channel.
- Probe moved to `main/freePort.ts` (electron-free, so it is unit-testable)
  and binds `127.0.0.1`. **The rule is that the probe must perform exactly the
  bind the server performs.** Measured: wildcard and loopback do *not* collide
  in either direction on macOS, so loopback probing is not "stricter" — it is
  simply the same question `listen()` asks. An earlier comment claiming it was
  strictly stricter was wrong and the test that disproved it is kept.
- `/health` now returns `instance` (a per-app-run token passed as
  `COSCIENTIST_AGENT_INSTANCE`) and `workspace`; adoption requires a token
  match, so a stranger's server *or our own orphan from a crashed run* is
  replaced rather than driven. Probe host is the `127.0.0.1` literal, not
  `localhost` (which can resolve to `::1` first). If the cached port is taken
  after our process dies, we re-pick instead of spawning onto a dead bind.
- Verified live: with the packaged app holding 23200, dev now starts on
  **23201** and both coexist.

*Secrets are encrypted at rest and out of the agent's reach.* The trigger is
in the user's own transcript: the agent read `cobuilding-settings.json` while
answering a question and printed the API key into the chat.
- New `main/secretStore.ts` wraps Electron `safeStorage` (macOS Keychain) with
  an `enc:v1:<base64>` envelope. Applied to `customAnthropicApiKey` **and**
  connector headers/env. Legacy plaintext reads through untouched and is
  re-encrypted once at boot (`migratePlaintextApiKey`,
  `migratePlaintextConnectorSecrets`, both after `whenReady` — `safeStorage`
  throws before it). Falls back to plaintext with a warning where the OS has
  no keyring rather than refusing to save.
- **Secrets never cross IPC.** `listConnectors()` returns header *keys* with
  blank values; `listConnectorsWithSecrets()` (main-only) is what builds the
  agent config. A blank value on save means "keep the stored one", so editing
  a URL doesn't wipe the token; deleting the row removes it.
- `CLAUDE_CONFIG_DIR` moved from `<workspace>/.academia/claude-config` to
  userData (`main/claudeConfigDir.ts`, with migration). It was sitting in the
  agent's own cwd. Session resume is unaffected (the SDK keys projects off
  `cwd`, which didn't change). **Correction (2026-07-29): this entry used to
  say the dir "holds `mcpOAuth` — access/refresh tokens for every connector".
  It does not.** On SDK 0.2.121 those tokens go to a credentials store —
  macOS keychain primary, 0600 `.credentials.json` fallback — and the dir's
  own path is only an *input* to the keychain service name (sha256 of it).
  Moving it was still right (it holds transcripts and the DCR client
  registrations), but it is not where a sign-in lands.
- **`agent.json` moved too, and this one mattered most.** It is the SDK's
  input, so it holds the *raw* key and *decrypted* headers and cannot be
  encrypted — and it was being written to `<workspace>/.academia/agent.json`.
  Encrypting settings.json while leaving that would have been theatre. Now
  userData, mode 0600, with the legacy in-workspace copy deleted on boot.
- New `hooks/block-secret-reads.sh` (PreToolUse on `Bash` and
  `Read|Edit|Write`) denies those paths. Honest scope: with unrestricted Bash
  this is a guardrail against incidental leakage, **not** a security boundary;
  the encryption is the real control.
- Verified: 11/11 secretStore assertions against the **real macOS keychain**
  in a real Electron main process (jest can't — `ELECTRON_RUN_AS_NODE` has no
  `safeStorage`); 12/12 over CDP on the live app (ciphertext on disk, no
  plaintext anywhere in the file, blank-on-IPC, secret preserved across an
  edit, replaced when retyped, dropped when the row is deleted); a **real chat
  turn** round-tripped "ENCRYPTION OK" proving the decrypt path still feeds
  the SDK; and the screenshot scenario re-run against the live agent — asked
  to `cat` the settings file it was blocked and answered without any secret in
  the transcript. jest 150/150 (15 new), tsc clean, smoke exits 0.

**Tool status states are now truthful; RUNNING is gone (2026-07-28).** Every
tool the user had ever opened claimed **RUNNING** on the home grid while doing
nothing. There were two disjoint status systems both using that word:
`liveToolDirNames` (home + rail) was literally "a viewer tab is open this
session", while `toolStatusStore`'s `running` was the *else-branch* of the
build/install lifecycle — never set deliberately, and the default for any tool
with no entry. Neither had any notion of the tool executing something.
- **One vocabulary, one store.** `toolStatusStore.ts` now merges *lifecycle*
  (`installing` / `building` / `buildFailed`, pushed by MiniAppViewer via the
  renamed `setToolLifecycle`) with *activity* (`working`, ref-counted). `idle`
  is the resting state and the default. Precedence: buildFailed > building >
  installing > working > idle. Idle tools are **absent** from the snapshot map,
  so surfaces that only signal news render nothing on a miss.
- **WORKING is derived from operations the host already brokers** — no new
  mini-app API, so tools built before today report it. `ACTIVITY_BRIDGE_TYPES`
  in MiniAppViewer wraps `executeCode`, `executeCommand`, `anthropic:complete`
  and `anthropic:stream` (the stream closes its episode on done/error, not when
  the handler returns), plus agent→mini-app MCP invocations (opened at the
  `mcp:invoke` postMessage, closed at the matching `mcp:result`). File I/O and
  `mcp:callTool` are **deliberately excluded** — millisecond-scale, would strobe.
- **Anti-flicker: 200ms delay-in, 800ms minimum-visible.** A sub-200ms op never
  shows; a shown op stays readable; a new op inside the hold-out keeps WORKING
  continuously instead of blinking.
- **Home cards and the rail carry a chip/dot only when non-idle.** An idle tool
  shows nothing at all, so any chip means something is genuinely happening.
  The viewer header always has a chip and spells `IDLE` out.
- **Real `lastRun`.** The card metric said "LAST 22M" sourced from
  `lastOpened` — the same class of lie. New `miniApps:markRun` IPC stamps
  `manifest.lastRun` when an activity episode ends (trailing-edge collapsed 3s
  in the renderer so a burst of short ops is one write). Cards read
  `LAST RUN …`, falling back to `OPENED …`, then `NEW`.
- Verified live over CDP against a running app with a throwaway fixture tool
  driving a **real** `executeCommand` through the bridge: baseline `IDLE` →
  `WORKING` at 214ms → held across the whole 3s → `IDLE` at 3060ms; a 50ms op
  never showed; `BUILDING` caught at 10ms and cleared at 44ms (a 34ms build —
  coarser sampling misses it); `BUILD FAILED` observed on a genuinely broken
  build; `lastRun` landed on disk and the card read `LAST RUN NOW`; and
  `RUNNING`/`SLEEPING` appear nowhere in the rendered document. 19 new jest
  cases against the real store (timing, precedence, ref-counting, stale-end
  safety) plus one that renders `useToolStatus` through React. tsc clean;
  jest 133/134 (only the pre-existing `fileMonitorIntegration`).
- **Gap found here, FIXED the same day by the job registry above:** navigating
  away from a tool unmounts its viewer and destroys the iframe (verified: 0
  iframe CDP targets after nav), which fired `clearToolStatus` — so a home card
  could never actually light up, and the work kept running unobserved. Host-owned
  jobs make `working` reachable with no viewer mounted. Still true and still
  unfixed: `building`/`installing` are written directly with no delay-in, so a
  34ms build flashes; and `buildFailed` is viewer-local, so it still disappears
  from the grid when you leave the tool (only *jobs* survive, not lifecycle).
  **`buildFailed` FIXED later the same day** by `buildHealth.ts` — see the top
  of Status. The `building`/`installing` flash is still real.

**De-Podman'd the agent-facing docs; `containerAPI` → `hostAPI` (2026-07-28).**
The mini-app bridge still exposed `window.containerAPI.exec` documented as
"execute a command in the Podman container", and the drift ran much wider than
that one line. Three defects were **actively wrong**, not merely dated:
- **The PreToolUse hook's rejection message was a trap.** `block-host-installs.sh`
  told the agent to use `.applications/install R` / `install apt` — which the
  wrapper hard-refuses (`assets/install:70`, `packageInstaller.ts:366`). Agent
  runs `apt-get install` → blocked, redirected to the wrapper → wrapper refuses.
  Two guaranteed wasted turns. The message now states plainly that apt/R/conda
  have no wrapper equivalent and must not be retried. Same fix in
  `src/cobuilding/CLAUDE.md` and `manage-mini-application/SKILL.md`.
- **The documented esbuild snippet could not work.** It passed
  `--alias:@reusable=/data/.applications/_reusable`, a container path. Verified
  against the real production workspace: the absolute `$PWD/...` form builds
  clean (exit 0, 14.5 MB bundle), while both the container path and a relative
  path fail — esbuild does not resolve a relative alias against cwd. Corrected,
  with the reason recorded so nobody "simplifies" it back.
- **Two skills claimed packages that are not installed.** `geo-database` claimed
  `GEOparse`, `pdb-database` claimed `rcsb-api`; neither is in the venv (checked
  with real `pip list`). Both now say so and give the install command. Across the
  10 database skills, "pre-installed in the container" is replaced with the
  guaranteed set (`pandas`/`numpy`/`matplotlib` = `REQUIRED_PACKAGES`), noting
  `requests` is present only **transitively** via jupyter-kernel-gateway, so an
  app that depends on it should declare it.
- **`window.hostAPI` is the new bridge name**, with `containerAPI` kept as a
  one-line alias to the same object (mini-apps can be exported/imported, so the
  full consumer set isn't enumerable; the shared `_bridge/` is force-overwritten
  on every boot, so there's no per-app opt-out). The postMessage wire type was
  already correctly named `executeCommand`, so nothing host-side changed. Delete
  the alias once no shared app references it. `bridge-api.md` now documents what
  `exec` really does: host child process, cwd = workspace root, venv + npm-prefix
  `bin/` on PATH, and **exitCode 127 = never launched** (a missing dependency,
  not a failed analysis) — a distinction callers kept getting wrong.
- **Found dead, flagged not deleted:** the `differential-expression` skill and
  the `differentialExpression` mini-app template are both unrunnable. The
  template hardcodes `kernel: "ir"`; verified against the real gateway that only
  `python3` is registered and there is no R binary on the machine, and R cannot
  be installed. Both are now marked non-functional in the docs the agent reads
  (so no turn is wasted scaffolding a tool that fails on first Run) and point at
  `pydeseq2` as the Python route. **Deleting them is a product call — not made.**
  Likewise `scripts/bench-build.sh`, which benchmarks building a `Dockerfile.base`
  that no longer exists and which nothing references.
- Verified: `tsc --noEmit` clean; jest 114/115 (only the pre-existing
  `fileMonitorIntegration`); the edited hook re-tested end-to-end (exit 2 +
  new message on `apt-get install`, exit 0 on a harmless command); and the
  renamed bridge bundled with the **real** esbuild and executed in JSDOM —
  7/7 assertions incl. `hostAPI === containerAPI` and both posting identical
  `executeCommand` messages. Note `bridge.ts` is **not** in the tsc project
  (it ships as source, bundled per-app), so a clean typecheck proves nothing
  about it — hence the execution test.

**Connectors: user-configured MCP servers (2026-07-28).** Settings → Connectors
lets the user attach external MCP services (Hex, Sentry, Notion, Linear,
GitHub, or Custom). Every behavioural claim below was measured against the
bundled SDK/CLI, not inferred from docs.
- **What was already true.** `settingSources: ['project']` (needed for
  CLAUDE.md) *also* loads a project `.mcp.json`, so the workspace could always
  have grown connectors. What silently does **not** work is `claude mcp add` —
  its default (**local**) and `--scope user` writes land in `.claude.json`,
  which `['project']` never reads. Measured: `['project']`→`[]`,
  `['project','local']`→`[hexlocal]`, `['user','project','local']`→both.
- **Host-owned, not workspace-owned.** Connectors live in a `connectors` array
  in `cobuilding-settings.json` (userData), *not* in the workspace — the agent
  has Write+Bash on the workspace, and an agent that can add an arbitrary
  remote MCP server can exfiltrate it. `.mcp.json` can't be turned off without
  losing CLAUDE.md, so `detectUnmanagedMcpJson` surfaces one in Settings with a
  Remove button instead.
- **Live apply, no new chat.** New `POST /connectors` on the agent server calls
  `query.setMcpServers()` on every live session. **Trap, verified:**
  `setMcpServers` *replaces* the whole dynamic set, and Acabox's relay servers
  (activity, mini-apps, workspace, notification, reaction) are themselves
  dynamic — sending only the connectors returned `removed:['relaydemo']` and
  killed them. `applyConnectorsToSession` always sends relay+connectors
  together; nothing else may call `setMcpServers`.
- **Second trap, verified:** a server passed in the original `mcpServers`
  option that never got past `needs-auth` is *not* dropped by
  `setMcpServers({})` (returns `removed:[]`, stays in `mcpServerStatus()`).
  `toggleMcpServer(name, false)` does disable it, so that's the backstop —
  applied only to names we ourselves supplied, never a relay or a `.mcp.json`
  server.
- ~~**OAuth works headlessly.**~~ **WRONG — this claim was never true, and it
  cost a day.** Corrected 2026-07-29; see the Status entry at the top. Two of
  its three premises are false. (1) *"The CLI subprocess survives across
  turns"* is true of the SDK and false of the running app: `query()` is called
  once per agent-server session, but the host destroys the session after every
  turn, so one turn = one query = one CLI subprocess (measured: 25 `Creating
  session` / 25 `Starting query()` / 25 `message received`, one-for-one, and no
  agent-server session in the whole log ever received a second message). Since
  the callback listener and the PKCE state live only in that process's memory,
  the handshake could never span the user's browser round-trip. (2) *"Tokens
  persist to `mcpOAuth` in `.claude.json`"* is false for SDK 0.2.121: `mcpOAuth`
  is written through a credentials store — **macOS keychain primary** (service
  name scoped by a sha256 of `CLAUDE_CONFIG_DIR`), with a 0600
  `<CLAUDE_CONFIG_DIR>/.credentials.json` fallback. **Verify a sign-in by
  looking for the keychain entry, never by grepping `.claude.json`** — it does
  not go there, and checking there reads as failure when the fix worked.
  Only the third premise held: links do open in the system browser.
- **`allowedTools` is not what gates this.** Measured: with Acabox's exact list
  and hex omitted, `mcp__hex__authenticate` still ran; `allowedTools: []` still
  ran `Bash`. It is auto-approve, not a restriction, and there is no
  `canUseTool` handler anywhere. `connectorAllowedTools()` adds `mcp__<id>`
  per connector so this is correct rather than accidental.
- Status shown in the UI is observed only — captured from the SDK `system`/
  `init` event (`mcp_servers`) and `mcpServerStatus()`. No session yet → the row
  says "Unknown", never a fabricated "Connected".
- New files: `shared/connectors.ts` (types + catalog + validation + SDK
  serialization; **adding a service is one entry in `CONNECTOR_CATALOG`**),
  `main/connectorsStore.ts`, `renderer/components/ConnectorsSettings.{tsx,css}`.
  Touched: agent-server `index.ts`/`sessionConfig.ts`, `containerService.ts`,
  `AgentInfrastructureController.ts`, `main/index.ts`, `preload.ts`,
  `types.d.ts`, `DirectoryPermissions.tsx`, `skills/acabox/SKILL.md`.
- Verified: `tsc --noEmit` clean; jest **115/115** (24 new); **11/11** against
  the REAL built `dist/agent-server.js` on its own port and workspace (relay
  survival, live add, live removal, clear); **14/14** driving the real app over
  CDP (IPC round-trip, main-side rejection of bad ids / remote plaintext http /
  reserved names, enable-disable persistence, UI rendering, catalog picker,
  custom form) plus screenshots; smoke test exits 0.
- Secrets note: connector headers are stored **plaintext** in settings.json,
  same as `customAnthropicApiKey`. The UI says so. `safeStorage` is the upgrade
  if that ever needs to change — for both, together.
- **The `findFreePort` hazard bit this during testing** and is worth fixing: a
  running packaged Acabox owned `127.0.0.1:23200`, the dev instance's
  `0.0.0.0` probe called it free, and dev then drove the *packaged* app's agent
  server — which has no `/connectors` route, so status came back
  `{"error":"Not found"}`. Both connector read paths now tolerate that, but the
  one-word fix (probe `127.0.0.1`) is still not applied.

## Earlier status (last updated 2026-07-27)

**Links open in the system browser; agent got `WebFetch` (2026-07-27).** Two
things, after an evaluation of embedding a Chromium browsing surface concluded
**don't** (Electron 37 = Chromium 138, EOL 2026-01-13, so browsing the open web
would run 13 months of unpatched Chromium; and authenticated interactive
automation would close the prompt-injection trifecta against an agent that has
auto-approved `Bash` with no `canUseTool` gate anywhere in the app).
- **`WebFetch` added to `allowedTools`** (`AgentInfrastructureController.ts`).
  It was missing while `database-lookup/SKILL.md` and `reaction/SKILL.md` both
  instruct the agent to call it. Note `allowedTools` is **auto-approve, not a
  restriction** — the SDK's restriction option is `tools`, which this app never
  sets, so with the `claude_code` preset the agent has the full toolset and
  anything off the list just falls to the default permission path with no
  handler to answer it. Also de-Podman'd the two stale skills (they still said
  "Running in the container" / "use `podman exec`") and corrected their
  "`requests` and `pandas` pre-installed in the container" line.
- **Every surfaced link now opens in the default browser.** New
  `main/externalLinks.ts`, installed on **every** WebContents via
  `app.on('web-contents-created')` before `whenReady`, so it also covers code
  not yet written. `setWindowOpenHandler` denies all `window.open`/`_blank` and
  hands remote http(s) to `shell.openExternal`; `will-frame-navigate` cancels
  remote navigation and does the same. Deliberately **not** also listening to
  `will-navigate` — it is main-frame-only and would double-fire, opening two
  tabs. Both reuse `validateExternalUrl`, so guards can't become a looser
  second door to `shell.openExternal` than the existing IPC.
  `shared/urlTargets.ts` holds the one definition of "internal" (`file:`,
  `local-file:`, `about:`/`data:`/`blob:`, devtools, and http(s) on loopback).
  This fixed two live bugs: `XlsxView.tsx`'s `target="_blank"` hyperlinks and
  `PaperMonitorView.tsx`'s `window.open` both spawned a bare BrowserWindow
  inheriting our preload, and any stray `<a href>` navigated the whole app away
  with no back button.
- **Mini-app links needed a different mechanism, established by testing not
  inference.** Two dead ends, both ruled out live: (1) a listener attached from
  MiniAppViewer can't work — a mini-app frame is `local-file://` while the host
  is `localhost:3000`/`file://`, so `iframe.contentDocument` is cross-origin and
  null (an interceptor written this way was built, proven inert, and deleted);
  (2) letting the frame navigate so the main guard catches it can't work either
  — the host CSP `frame-src local-file: http://localhost:*` makes Chromium
  refuse it ("Refused to frame 'https://…'") *before* `will-frame-navigate`
  fires, so the click silently did nothing. Note the CSP violation report is
  also useless as a signal: it strips the path (`https://example.com/`).
  Fix: `main/miniAppLinkShim.ts`, a script injected into every `local-file:`
  subframe on `did-frame-navigate` via `webFrameMain.executeJavaScript`, which
  routes clicks through the `{type:'openExternal', id, url}` bridge
  MiniAppViewer already exposes (and which validates `event.source`).
- Verified live over CDP against the running app, not just read: chat-style
  anchor click and `window.open` both logged `[ExternalLinks] Opening in default
  browser (navigation | window.open)` with the app never navigating away and
  `window.open` returning null; and a real `local-file:` fixture frame produced
  the bridge message with the **full URL incl. path**, with the four
  `frame-src` CSP violations that the same fixture produced beforehand dropping
  to zero. `tsc --noEmit` clean; jest 90/91 (only the pre-existing
  `fileMonitorIntegration`), including 9 cases on the shared predicate and 8
  that evaluate the **actual shipped shim string** in a fresh JSDOM window per
  case rather than a reimplementation; smoke test exits 0.
- Not done (deliberately, see the evaluation): no in-app reader view, no
  headless browsing tool for the agent, no browser tab. Those were staged 1–3
  and are not started.

**macOS auto-update works without a Developer ID (2026-07-27).** v0.1.2 shipped
and the tray "Check for Updates…" reached the install step and died there:

    Code signature at URL file:///…/com.electron.acabox.ShipIt/update.wdWeDhW/
    Acabox.app/ did not pass validation: code failed to satisfy specified code
    requirement(s)

That is the predicted ad-hoc/cdhash failure (see Known hazards) and it is
unfixable by configuration — the check is inside Squirrel's ShipIt binary.
Rather than block on an Apple Developer ID, the install step is now ours:
- **New `main/selfUpdater.ts`.** electron-updater still does **detection only**
  (it reads `latest-mac.yml` off the release and compares versions — that part
  always worked). On accept we download the zip the manifest names, verify the
  manifest's **sha512**, `ditto -x -k` it into a staging dir **beside** the
  installed bundle (same volume, so the final move is a rename not a 180MB
  copy), validate the unpacked bundle (CFBundleIdentifier,
  CFBundleShortVersionString == the expected version, `codesign --verify
  --strict` to catch transit corruption), then spawn a **detached bash script**
  that waits for our pid to exit and swaps the bundles.
- **Swap safety.** The old bundle is *moved aside*, never deleted first, so
  there is no window with nothing installed; any failure rolls it back. If the
  app is somehow still alive after 60s the script **aborts** rather than
  replace a running bundle. Swap log: `~/Library/Logs/Acabox/update-swap.log`.
- `autoUpdater.autoInstallOnAppQuit` is now **false** and the
  `update-downloaded`/`download-progress` handlers are gone — nothing may hand
  Squirrel a payload, including the quit-time path, which would fail silently.
- Preflight (`checkSelfUpdateSupported`) runs at boot and logs whether a swap
  is possible: refuses non-darwin, dev mode, an unresolvable bundle, an
  **App Translocation** path (a quarantined app runs from a read-only shadow
  copy — swapping it would silently do nothing), or an unwritable parent dir.
- Verified before shipping: 15/15 sandbox assertions against the **real**
  extracted swap script (happy path, rollback when the new bundle vanishes
  mid-swap, refusal while the pid is alive, paths containing spaces) using fake
  bundles in a temp dir; and the whole download→validate pipeline against the
  **real published v0.1.2 artifact** — sha512 base64 matches the manifest,
  `ditto` yields `Acabox.app`, bundle id / version / `codesign --verify` all
  pass.
- **Delete this module once there's a Developer ID** — plain Squirrel beats
  anything hand-rolled. It is self-contained for exactly that reason.

**Model/effort pinned per chat + many chats per tool (2026-07-27).** Two
user-requested features, both verified live over CDP against a running app.
- **Model + effort are now pinned to the conversation and displayed.** They
  were never actually pinned: `chat:send` only read the picker when no
  in-memory session existed, and `sessionRegistry` destroys a session as soon
  as its last subscriber detaches (i.e. after *every* turn), so each turn
  silently re-read whatever the picker then said. DB migration **31** adds
  `sessions.model` / `sessions.effort`, written **once** on the first turn and
  reused forever after (`setSessionModelInfo` is a write-once
  `... WHERE ... IS NULL` update, so a pin cannot drift mid-conversation).
  `model` is captured from the Agent SDK's `system`/`init` event — the id it
  actually **resolved**, not what we asked for; `effort` is what we sent (the
  SDK does not echo it back). Shown as a mono `OPUS 5 · HIGH` meta line in both
  `ChatHeader` and the tool side-panel header, via the new shared
  `command-desk/useSessionMeta.ts`. Rows predating the migration are NULL and
  render **no chip** rather than a guess (no-mocks rule); they pin on their
  next turn.
- **Incidental real bug this surfaced:** `ModelSelector` is the only thing that
  calls `registerModelContextProvider`, and it's mounted solely in the docked
  `GlobalComposer` — which is hidden in tool detail view. So chats started in a
  tool side panel sent **no model at all** and silently got the agent-server
  default, ignoring the picker. Pre-existing, but load-bearing once we pin.
  `chatAdapter.ts` now falls back to `getSelectedModel()`, mirroring what
  `effort` already did.
- **A tool can now own many chats.** The link was `manifest.chatSessionId` →
  exactly one chat. It's now the `sessions.app_dir_name` column (added by
  migration 15, indexed, and never used until now). New
  `sessions:listForApp` / `sessions:createForApp` IPCs; the side-panel header
  is two rows (title-as-dropdown · GENERATING · ＋ · pop-out · collapse, over
  the model meta), the dropdown lists that tool's chats **newest-message-first**.
  Ordering is `MAX(messages.created_at)`, deliberately **not** `updated_at` —
  `updateSessionTitle` bumps `updated_at`, so a rename would have jumped a chat
  to the top. Opening a tool loads its most recently active chat; `＋` reuses an
  existing unused chat instead of stacking empties; switching chats keeps the
  tool view open (`suppressThreadDeactivateRef`). Chats-list rows carry a tool
  chip. A boot sweep (`backfillAllAppChatLinks`) populates the column from
  existing manifests, which also let `ChatHeader` drop a per-chat
  `.applications/*` directory scan.
- Also fixed: pre-creating app chat rows would have made `isFirstMessage`
  (`!existingDbSession`) permanently false, so new app chats would never
  auto-title. Redefined as "no messages yet AND title is still the
  `DEFAULT_SESSION_TITLE` placeholder".
- Verified: tsc clean; smoke test exits 0; jest 67/68 (only the pre-existing
  `fileMonitorIntegration`); a 22-assertion harness against the **real**
  `chatRepository` + migration chain (incl. "rename does not reorder" and
  "second write is ignored"); and live CDP — with the picker set to
  Haiku/Low, a turn in a pinned chat logged
  `Session created: … model=claude-opus-5 effort=high`.

**Chat now refuses cleanly with no API key (2026-07-27).** A keyless build
answered chat turns with Claude Code's own "Not logged in · Please run /login"
— meaningless in a fork with no login. (Trigger in the wild: the *packaged*
app uses the `production` userData channel, and the key only ever existed in
`development/cobuilding-settings.json`; `.env.local` is empty and a
GUI-launched app inherits no shell env, so `resolveApiKey()` returned null.)
Three edits:
- `main/index.ts` — new `NO_API_KEY_MESSAGE` constant (also reused at the two
  existing literal sites), and a guard at the head of the `chat:send` handler,
  above the dedup / already-running / calendar / `createAgentSession` branches
  so no session is ever created or re-messaged without a key. It checks the
  in-memory store first, then re-resolves env → settings from disk (same
  two-step as the reference-file converter) so a key added out-of-band counts.
  Reported via `event.sender.send('chat:error', …)` and a **resolved** invoke —
  *not* a throw: Electron wraps a rejected `invoke` as "Error invoking remote
  method 'chat:send': …" and preload forwards `.message` verbatim, which would
  put IPC plumbing in front of the user's instructions.
- `agent-server/index.ts` — `startQuery()` refuses an empty
  `sessionConfig.anthropicApiKey` before flipping `state.running`. Defence in
  depth: the key is snapshotted at `createSession()` and `POST /credentials`
  only updates `currentConfig`, so a session born keyless stays keyless, and
  handing `''` to the SDK blanks the inherited env key. The throw is caught by
  the existing IIFE and broadcast as an `error` SSE → `chat:error`.
- Both messages stay free of `401`/`token`/`unauthorized` so
  `agentSession.isAuthError()` can't reclassify them as retryable.

Verified at runtime, not just by reading: (1) real app driven over CDP with the
settings file stashed — the thread rendered exactly "No Anthropic API key
configured. Add one in Settings.", no `/login`, no IPC prefix, log shows
`[chat:send] Refusing turn`, no session created, and **zero rows persisted**
for that thread (a refused turn isn't saved — matches the `No active
workspace` early-return); (2) regression — with the key restored, a real turn
round-tripped and the DB holds `assistant: "ACABOX WORKS"`, `is_error:false`;
(3) the agent-server guard exercised standalone against the built bundle on
its own port — empty key → `error` SSE with the exact message and `query()`
never starts; key present → `Starting query()` and no guard message.
`tsc --noEmit` clean; jest 67/68 (only the pre-existing `fileMonitorIntegration`
failure). Still open: no first-run banner pointing at Settings, so a fresh
install is silent until the user sends a message and reads the refusal.

**macOS "…is damaged" / code-signing fixed; prod build validated (2026-07-24).**
A downloaded packaged build showed *""Acabox" is damaged and can't be opened."*
Root cause: with no Developer ID, the Electron fuses flip left an **invalid**
ad-hoc signature (`Info.plist=not bound`, identifier `com.github.Electron`);
invalid signature + the browser's `com.apple.quarantine` = "damaged" on Apple
Silicon.
- **Fix:** forge.config's new `postPackage` hook ad-hoc re-signs the whole
  bundle (`codesign --force --deep --sign -`) after packaging/fuses, before the
  dmg/zip makers — only when `APPLE_IDENTITY` is unset (a real identity signs
  during packaging via `osxSign`). Verified on the **published** v0.1.1 dmg:
  `codesign --verify` → "valid on disk / satisfies its Designated Requirement",
  identifier `com.electron.acabox`, Info.plist now bound. Downloaders now get
  "unidentified developer" → **right-click → Open** (works), not "damaged".
  A clean download (no prompt) + macOS auto-*install* still require Developer ID
  + notarization.
- **Published v0.1.1** with the fix; **deleted the broken v0.1.0** (release +
  tag). `release.mjs` now always runs `npm run make` (osxSign covers Developer
  ID, the postPackage hook covers ad-hoc; the old `make:sign` codesign step ran
  after the dmg and never reached the artifact).
- **Dev gotcha that cost hours:** `ELECTRON_RUN_AS_NODE=1` in a shell makes a
  direct `Acabox.app/Contents/MacOS/Acabox` exec run as **Node** (reads stdin,
  exits 0) — it looks exactly like an instant silent crash but the app is fine.
  Test packaged launches via Finder / `open`, or `env -u ELECTRON_RUN_AS_NODE`.
  Also note: packaged logs go to the **`production`** channel
  (`~/Library/Application Support/acabox/production/cobuilding.log`), and console
  logging is off when packaged.

**Update pipeline switched to GitHub Releases + prod build unblocked
(2026-07-24).** The leftover Coscientist S3/CloudFront auto-update vertical is
replaced with GitHub Releases; the prod build no longer needs any secret env.
- **Build gate removed.** `webpack.plugins.js` used to `throw` on any non-dev
  build unless `CLOUDFRONT_DOMAIN` was set — this silently blocked `npm run
  make`. Removed the gate + the now-unused `CLOUDFRONT_DOMAIN` DefinePlugin
  entry. `npm run make` now runs clean with zero env (verified: full make →
  `out/make/Acabox-0.0.1-arm64.dmg` + `…/zip/darwin/arm64/Acabox-darwin-arm64-0.0.1.zip`).
- **Updater → GitHub provider.** `updater.ts` now uses `electron-updater`'s
  `github` provider (`iliasacademia/acabox-releases`, env-overridable), dropped
  the custom `channel = 'acabox'` (default channel matches the standard
  `latest-mac.yml`), and added a silent check-on-launch. Gated on
  `app.isPackaged`; degrades gracefully (logs, no crash) when there's no
  release/repo.
- **Release command.** `npm run release` (`scripts/release.mjs`): builds with
  plain `npm run make` (see 2026-07-28 — `make:sign` was wrong and is gone), reuses
  `scripts/generate-update-manifest.js` to emit `latest-mac.yml`, and
  `gh release create v<version>` with the zip + dmg + yml. Supports
  `--dry-run` / `--skip-make` / `--repo`. Verified end-to-end in dry-run
  against a real build (correct sha512/size yml, correct asset set, correct
  `gh` command).
- **Deleted dead CloudFront pieces:** `scripts/update-manifest.js`
  (CloudFront URL-rewriter), `src/utils/validateCloudFrontDomain.{js,d.ts}`.
  Kept `scripts/generate-update-manifest.js` (the sha512/yml generator, reused).
- **First release published + verified (v0.1.0).** `iliasacademia/acabox-releases`
  is created, public, and seeded — a brand-new repo has no default branch, so it
  needed one initial commit before `gh release create` would work (422
  "Repository is empty" otherwise). `npm run release` published v0.1.0 (dmg +
  zip + `latest-mac.yml`); confirmed `latest-mac.yml` is anonymously
  downloadable (the proof the public-repo path lets the updater read it without
  a token). `release.mjs` now `rm -rf out/make` before building so a version
  bump can't leave stale artifacts that get uploaded / mis-referenced in the
  metadata. Remaining gap: **Apple Developer ID** — Mac builds are unsigned, so
  Mac auto-*install* still won't work (Win/Linux fine); auto-update *detection*
  only exercises on the next release (bump `version` → `npm run release`).
  `tsc --noEmit` clean.

**Files tab now hides internal dot-dirs (2026-07-24).** Fix for "Home says no
files but I have files": the Home "Drive" card (`files:findByExtension`) has
always skipped dotfiles at every level, so on a blank workspace (no shared
folders) it correctly showed "No files yet". But the **Files tab** listed the
workspace tree *including* Acabox's internal `.applications`/`.claude`/`.academia`
dirs, so it looked populated while Home said empty — the source of the confusion.
Fix: `FilesTab.tsx`'s `isHiddenWorkspaceEntry` now also returns true for any
name starting with `.` (was `~$`-only). It's the single predicate used by
`loadRoot`, `loadChildren`, and `countFilesFromEntries`, so root + subdir
listings + the FILES count all now exclude dotfiles — the Files tab and Home
agree (blank workspace → "0 FILES", empty tree). Standard file-browser
convention; also drops incidental `.git`/`.DS_Store` inside research folders.
New jest case in `FilesTab.test.tsx` asserts the three internal dot-dirs are
hidden while a real file (`Data.csv`) still renders. Verified: tsc clean, full
jest green (68/68), and live via CDP against `npm start` (Files tab shows
"0 FILES" + only the `workspace-data` root, no children).

**Tool cleanup + code/data separation (2026-07-24).** Two changes:
- **All 7 pre-built stub tools removed.** Deleted `availableTools.ts`
  (`AVAILABLE_TOOLS_STUB`) and every consumer: the ToolsPage "Other available
  tools" section + all stub-only machinery (file-picker modal, Word-overlay
  handlers, `handleStubAction`/`handleOpenFilePicker`/`handlePickFile`/
  `handleBrowseFile`, `reactionsStatus`, the `onOpenReactions` prop), the
  CommandDesk home-grid stub cards, and the rail/home tool counts (now
  `activeApps.length`). The Reactions *scheduled* feature (cron task, `reaction`
  agent MCP, `ScheduledTaskEditor`, settings) and its notification deep-link
  view (`ReactionsToolView`, `toolsViewMode==='reactions'`) are untouched — only
  the tools-list card is gone. Still-dead-regardless files left for a separate
  pass: `ReactionsSidebar.tsx`, `FocusEditor.tsx`, `mcpServers/reactionMcpServer.ts`.
- **Tool code and tool data are now separated on disk.** A mini-app's working
  files live under `<workspace>/tool-data/<dir>/{input,output}/` (durable); the
  code dir `.applications/<dir>/` reaches them via relative symlinks
  (`input`/`output` -> `../../tool-data/<dir>/...`). Every existing path
  convention (`.applications/<dir>/output/...`) keeps working transparently
  through the symlinks — no change to `useAppState` or app code. **Deleting a
  tool now removes only its code and keeps its data.** Pieces:
  `shared/paths.ts` (`TOOL_DATA_DIR`); `main/toolDataMigration.ts`
  (`ensureToolDataLayout` — idempotent boot sweep that migrates pre-split apps +
  `ensureToolDataLayoutForApp` for scaffold/import), called from `index.ts` boot
  and after `miniApps:import`; new `miniApps:delete` IPC (stashes the tool name
  in `tool-data/<dir>/.tool-meta.json`, unlinks the symlinks, then rm's the code
  dir; GCs empty data dirs); `miniApps:export` now `cp`s with `dereference:true`
  so zips carry real data; the scaffold (`manage_mini_app.mjs`) creates the
  split layout + symlinks. ToolsPage/MiniAppsTab delete via the new IPC.
- **Browse saved data in-app.** New `toolData:list`/`toolData:delete` IPCs +
  `toolDataAPI` (preload/types). ToolsPage grew a "Saved data" section (shown
  when a deleted tool left files) with Reveal-in-Finder, an inline recursive
  file list, an in-page `FileViewer` modal, and Delete-data. CSS in App.css
  (`toolsSection__note`, `savedFilesList*`, `savedFileViewer*`).
- Verified: `tsc --noEmit` clean; smoke test boots clean + exits 0; jest green
  except the pre-existing `fileMonitorIntegration` failure; and a standalone
  harness exercising the REAL migration module + REAL scaffold script confirmed
  all 12 assertions incl. the core guarantee (delete code → data survives in
  tool-data, readable through the symlink). Note: boot migration wasn't
  exercised against a live app (none present in dev workspace) — covered by the
  harness instead.

**Done & verified:**
- Boots clean, `tsc --noEmit` clean, smoke-test exits 0.
- Podman fully removed; agent server + kernel gateway run as host processes.
- Install wrapper rewritten for host (runtime-tested with missing-env cases).
- Mini-app MCP publishing wired end-to-end (not yet exercised with a real app).
- Dead-code cleanup: ~80k lines of dropped integrations, no-op IPCs, vestigial
  debug UI, stale skills (google-drive, grant-finder), podman-warn hook.
- Login-shell PATH resolution for packaged builds (`shellPath.ts`, wired into
  `buildSubprocessEnv`, npm probe, python discovery). Ledger: BUGS.md.
- Renamed product to **Acabox** (was Academia Coscientist / clawdbox): app
  name, bundle id, userData dir, protocol declaration, UI strings, analytics
  event_type (`AcaboxEvent`), logging service tag, cookie-store salt. The
  userData move means first launch after the rename bootstraps a fresh
  venv/npm-site/workspace/DB.
- Development moved to `https://github.com/iliasacademia/acabox`.
- **Removed academia login entirely.** No welcome-gated academia session, QR
  auth, deep-link scheme, or credential gateway. The Claude API key comes from
  the user: `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` env (dev via `.env.local`)
  or the Settings screen (stored in settings.json). Resolved into the in-memory
  credential store at boot (`resolveApiKey`/`loadCredentialsIntoStore` in
  `index.ts`), before the agent starts. Renderer always boots straight into
  the app shell — no key gate (onboarding removed entirely, see below);
  Settings has an `ApiKeySettings` section. Analytics
  stays gated off (no academia egress). The academia backend client
  (`apiClient`, `academia:fetch`) is kept but optional — used only by mini-apps,
  degrades to 401 if invoked without a session.

**Command Desk shell implemented (2026-07-23).** The Home design from
`docs/design/design_handoff_acabox_home/` is now the app shell + home screen.
Verified live via CDP screenshots (rail expand/collapse, nav, composer focus,
fonts, real chats/files data). Key facts:
- New components in `src/cobuilding/renderer/components/command-desk/`
  (ChromeBar, Rail, StatusBar, CommandDesk, useHomeData, MSymbol) + all styles
  and design tokens in `src/cobuilding/renderer/commandDesk.css`.
- Shell layout: ChromeBar (real title bar — main window is now
  `titleBarStyle: 'hiddenInset'`) → rail + content column → docked
  GlobalComposer (rewritten to spec) → status bar. Legacy tabs (Chats, Tools,
  Files, Debug, Settings) render unrestyled inside the new shell — restyling
  them is future work with no design spec yet.
- Fonts self-hosted (`renderer/assets/fonts/`, woff2 webpack asset rule):
  DM Sans, IBM Plex Mono, Material Symbols. Old screens now get real DM Sans
  (previously silently fell back to system fonts). Mini-app tool icons stay
  lucide (manifests name lucide icons); everything else uses Material Symbols.
- The old briefings Home (`HomePage.tsx`) moved to a new "Activity" nav tab.
- Real data: chats via `sessionsAPI`, drive card via `files:findByExtension`
  (handler now also returns `size` + absolute `path`), tools via
  `miniAppsAPI`; app version via webpack `process.env.APP_VERSION` define.
- Status bar shows real host stats via `stats:get` IPC
  (`main/systemStats.ts`): CPU% (os.cpus() delta), memory (Activity-Monitor
  formula via vm_stat: anonymous − purgeable + wired + compressed), disk
  (statfs on homedir, decimal units to match Finder), running-agent count,
  app uptime. Nothing in the status bar is mocked.
- Dev menu bar says "Acabox": `scripts/rename-dev-electron.js` (runs in
  prestart) rewrites CFBundleName/DisplayName of the dev
  `node_modules/electron/dist/Electron.app` and ad-hoc re-signs it;
  idempotent, self-heals a stale signature, re-applies after npm install.
  Packaged builds were already named via packagerConfig.
- Superseded 2026-07-28: the RUNNING/SLEEPING tab-open heuristic is gone — see
  the tool-status entries at the top of Status, where the **host-side** job
  registry now lets a tool report state with no viewer mounted, and cancel
  exists. Still deferred: per-job progress, notifications, and ⌘K opens the
  chats list instead of a real command palette.
- Tool archiving (2026-07-23): `archived: true`/`archivedAt` in the app's
  manifest.json (travels with the folder on export). `miniApps:setArchived`
  IPC + preload; Tools page grew an "Archived" section (hidden when empty)
  with dimmed rows + Restore/Delete; Archive lives in each active row's
  Settings panel next to Delete. Archived apps are filtered out of the home
  grid, rail badge, and pinned list (`activeApps` in index.tsx); ToolsPage
  got an `onAppsChanged` callback so archive/delete/import refresh the shell
  immediately. Verified end-to-end via CDP (archive → Archived section, badge
  7→8, manifest round-trip, restore).
- Manifest write race FIXED (2026-07-23): opening a tool fires several
  concurrent read-modify-writes on the same manifest.json (miniApps:touch,
  tool:opened, sessions:findForApp); fs.writeFile truncates in place, so a
  torn read parsed as "no manifest" and tool:opened rewrote it from scratch —
  observed live destroying name/description/icon (and would destroy
  archived). All manifest writers now go through `main/manifestIO.ts`:
  atomic temp-file+rename writes and per-path serialized update queues
  (touch, setArchived, tool:opened, findForApp, manifest migration).
- Home tools grid (2026-07-23): section renamed "Instruments" → "Tools" and
  it now shows the same inventory as the Tools page — real mini-apps first,
  then the pre-built tools (shared source of truth:
  `renderer/components/availableTools.ts`, extracted from ToolsPage's
  hardcoded stub list). Pre-built cards navigate to the Tools page where
  their real actions live; rail Tools badge counts apps + pre-built. Note:
  several pre-built entries target dropped features (Grant Finder,
  Peer Review→Word overlay) or are pure placeholders (Literature Synthesis,
  Paper Monitor, Citation Alerts alert "placeholder for now") — candidates
  for the next removal/re-point pass alongside the writing_agent hazard.

**Design unification Phase A done (2026-07-23).** All legacy screens
(Chats list, Tools, Files, Activity, Settings, modals/dropdowns) restyled
into the Command Desk language via a palette sweep (warm/tan hexes → design
tokens, Gupter → DM Sans) across App.css + component CSS, plus targeted
rewrites (mono section labels/eyebrows, 8px card radii, blue primary/XS
buttons, pale-blue hovers). Verified via CDP screenshots of every tab.
Also removed per user directive ("no mocks in prod"): the blinking-cursor
motif, and ToolsPage's fabricated stub timestamps/statuses ("ran this
morning · 4 items" etc. — only the real Reactions enabled-state remains).
Phase B (chat thread, mini-app viewer chrome, onboarding — screens needing
real design decisions) is briefed in `docs/design/phase-b-design-brief.md`,
to be run through the design tool; implement its handoffs when they land.

**Design unification Phase B done (2026-07-23).** The three Phase-B handoff
screens (`docs/design/design_handoff_acabox_phase_b/`) are implemented and
verified live via CDP screenshots. All styles in
`renderer/phaseB.css` (zero new tokens; `cd*` classes off commandDesk.css).
- **Chat view** — new `command-desk/ChatHeader.tsx` (back · title · mono
  model meta · GENERATING chip · Open-tool when the chat owns a mini-app,
  found by scanning `.applications/*/manifest.json` for `chatSessionId` ·
  rename · delete) + a full rewrite of `assistant-ui/thread.tsx` into the
  Command Desk language: 760px centered column, right-aligned user bubbles
  with attachment chips + timestamps, plain assistant blocks with a mono
  meta line (`N TOOL CALLS · HH:MM`), day separators, working indicator
  (`THINKING…`/`WORKING — …`), streaming heartbeat dot (CSS `::after`, not a
  cursor), empty state ("Where to?" + profile-seeded chips), jump-to-latest
  pill. `turnAnchor` default flipped `top`→`bottom` so short threads bottom-
  anchor with no phantom scroll/stray pill. Markdown restyled in
  `.cdAsst .auiMd`. Message `createdAt` now threaded through
  `historyMessageConverter` so timestamps/day-separators are real.
- **Tool-call cards** — `assistant-ui/tool-fallback.tsx` rewritten as
  instrument readouts (status dot · MSymbol · mono name · key args · right
  meta · chevron; error tint + auto-expand). Name/icon/args mapping in
  `assistant-ui/tool-card-display.ts`. `progressStore` gained
  `useToolFinalElapsed` for completed-card durations.
- **Tool viewer** — new `command-desk/ToolWorkspace.tsx` (tab bar with
  per-tool status dots + close/middle-click, viewer header, drag-resizable
  320–560 chat side panel persisted to localStorage, collapsed 44px strip
  with vertical label + unread dot, more-menu). `MiniAppViewer.tsx` header
  restyled + first-boot dependency interstitial and build-error state
  redesigned to spec; live per-tool status flows through new
  `toolStatusStore.ts`. Replaces the old react-resizable-panels layout in
  `index.tsx`.
- **Onboarding** — new `command-desk/Onboarding.tsx` is a single 5-step
  component (welcome · API key + validation error · workspace dirs with
  read-only toggles · live scanning · scan review) rendered in the chrome +
  `StatusBar firstRun` frame, no rail. Replaces WelcomeScreen /
  ApiKeyOnboarding / WorkspaceOnboarding / ScanningProgress /
  ScanResultsReview (all deleted) and the `App()` step machine in
  `index.tsx` (now a 3-state boot gate). Esc-to-stop wired via `EscStopsRun`.
  **Superseded:** onboarding was removed entirely later the same day — see
  "Onboarding flow removed" below.
- Deleted with their screens: the 5 onboarding components + CSS,
  `assistant-ui/overlay-file-picker.tsx`,
  `assistant-ui/find-and-replace-suggestion.tsx`, and ~700 lines of stale
  thread/message/tool CSS from App.css. `chat-composer.tsx` is now the
  narrow side-panel composer only (attach + model picker live in the docked
  GlobalComposer). `tsc --noEmit` clean; jest green except the pre-existing
  `fileMonitorIntegration` failure (fails identically on a clean tree).
- Known gap (not a mock): per-directory FILES·SIZE meta in onboarding step 3
  is omitted — the workspace-directory API doesn't expose counts, and
  fabricating them would violate "no mocks in prod"; needs a new stat IPC.

**Model lineup refreshed (2026-07-23; Opus 5 added 2026-07-24).** Chat picker
(`ModelSelector.tsx`) now offers Fable 5 / Opus 5 / Opus 4.8 / Sonnet 5 /
Haiku 4.5 (**default now `claude-opus-5`**; stale localStorage selections
sanitized on init). Agent-server default also bumped to `claude-opus-5`
(`AgentInfrastructureController.ts`); mini-app proxy allowlist
(`ANTHROPIC_ALLOWED_MODELS` in `main/index.ts`) extended with the new IDs,
old ones kept. Opus 5 is same-priced as Opus 4.8 ($5/$25), 1M context, same
API surface (adaptive thinking only, no `budget_tokens`, effort defaults
`high`), no data-retention requirement — a clean drop-in; verified as the
exact API ID `claude-opus-5` against the live models doc. Decision:
**Claude-only** — no LiteLLM / Cloudflare gateway / multi-provider; the
Agent SDK harness is Claude-specific, and `ANTHROPIC_BASE_URL` already
exists as the power-user proxy hook. Caveat: Fable 5 needs 30-day org data
retention (400s on ZDR) and may return `stop_reason: refusal` on bio/cyber-
adjacent content. **Models are a hardcoded list in three places — there is
no auto-discovery**; adding a model is a manual 3-edit change (picker
array + agent-server default + proxy allowlist).

**Suggested-tasks feature fully removed (2026-07-23).** Per user directive
(simplify; remove unneeded upstream features), the entire "suggested tasks"
vertical is gone: the quick + in-depth task-suggestion scan agents
(`directoryScanner/agents/taskSuggestion.ts`), the hourly
BriefingsController re-scan cycle (was ≤$5 of Sonnet per hour on the user's
API key), the `suggested-tasks` MCP server (host handlers + agent-server
relay + allowedTools + workspace skill), the notification bell UI +
`notifications` DB writes (`NotificationsController`/`notificationsRepository`
deleted; DB migration v26 left in place, table now orphaned/harmless), the
Home/Tools suggestion cards, the suggestion→tool attribution plumbing
(`tool:setThreadAttribution`, renderer pending-attribution queue;
`tool.created` now always `creation_source: 'chat'`), and the dead
`paper`/`citation`/`grant` briefing card branches (no producers since the
fork). What remains: the initial workspace scan runs the research-profile +
file-tagging agents only; briefings are now only `writing_agent` manuscript
cards (from file tagging); the chat agent's `mcp__notification__show_notification`
desktop-toast tool is unchanged. `BriefingsController` shrank to just
`runInitialWorkspaceScan`. Verified: tsc clean, smoke test exits 0 with all
boot-healthy signals, stale skill auto-pruned from the workspace on boot.

**FIXED (2026-07-23): "Not logged in · Please run /login" on chat turns.**
Root cause: the bundled Claude Code binary only honors an env
`ANTHROPIC_API_KEY` when the key is "approved" — interactive Claude prompts
and stores the key's LAST 20 CHARS in `customApiKeyResponses.approved` of
`.claude.json` (CLAUDE_CONFIG_DIR). Headless SDK runs can never answer that
prompt, so any user-supplied key was refused (reproduced with the raw binary;
approval-entry format verified from the binary: `RS(H){return H.slice(-20)}`).
Fix: `shared/claudeConfigApproval.ts` (`ensureApiKeyApproved`) writes the
approval before every SDK invocation — called in `agent-server/index.ts`
startQuery() and `directoryScanner/shared.ts` buildCommonQueryOptions() (the
scanner had the same latent bug). Verified end-to-end: real chat turn
round-tripped ("Reply with exactly: ACABOX WORKS" → "ACABOX WORKS",
is_error:false) and title generation named the session.
Also fixed in the same pass: TitleGen crashed post-save on a dead upstream
`require('../../server/events/wordPollEventBus')` (removed), and its failure
log printed the RAW API KEY into cobuilding.log (now `hasApiKey=` boolean;
existing log files scrubbed). "A real chat turn" can move out of the
"NOT yet tested" list below.

**Brand "B-box" mark + app icon implemented (2026-07-23).** The new logo
(rounded blue `#0645b1` tile, white B-box glyph that reads as **B** and as a
box + prompt-wedge) replaces the old academia/`play_arrow` marks everywhere.
Sources of truth are three SVGs in `src/assets/brand/` (mark-master for ≥64px,
optically-corrected mark-small for ≤32px, glyph-template for the menu bar) plus
`acabox-wordmark.svg` (the only sanctioned lockup). `scripts/gen-icons.mjs`
(Node + `@resvg/resvg-js`, a new dev dep, + macOS `iconutil`) rasterizes each
size DIRECTLY from SVG — small classes from the small master, ≥64px from the
large master — and emits, into `src/assets/icons/`: `dock-icon.icns` (all 10
size classes), `dock-icon.png` (1024 master, for the tray/dock compositor),
and `trayTemplate.png`/`@2x` (menu-bar template image). Rerun with
`node scripts/gen-icons.mjs` whenever the mark changes. In-app: new
`AcaboxMark` component (renderer/components/command-desk) renders the mark as an
`<img>`; swapped into the rail chip (28px), chrome bar (16px), and onboarding
step 1 badge (48px master). `tray.ts` now uses the glyph as an `isTemplate`
menu-bar image (auto light/dark/tint); the old pixel-compositing tray helper
and the stale `tray.icns` were removed (dev dock icon still cyan-tinted).
Verified: tsc clean, dev smoke test boots all services + tray created, `.icns`
round-trips to all 10 sizes, and the three in-app placements were screenshotted
in real Chromium (real CSS + SVGs) and look correct. Caveat: `prune:false`
means `@resvg/resvg-js` ships in packaged builds as dead weight (dev-only tool,
never required at runtime) — negligible next to the other bundled devDeps.

**Onboarding flow removed (2026-07-23).** Per user directive ("we don't need
onboarding for acabox"), the first-run onboarding is gone entirely; the app
always boots straight into the Command Desk shell.
- Main boot (`main/index.ts`): if `loadActiveWorkspace()` finds nothing, it
  creates a **blank workspace** (zero shared directories) via
  `workspaceController.create([], apiKey)` — so an active workspace is now a
  boot invariant. The user adds folders (Settings → Workspace directories)
  and the API key (Settings → Account) afterwards.
- Deleted: `command-desk/Onboarding.tsx` + its entire CSS block in
  `phaseB.css`, the renderer `App()` boot gate (now: fetch workspace →
  ChatView), `StatusBar`'s `firstRun` prop, the `debug:restartOnboarding`
  IPC (main/preload/types), the `workspaces:create` IPC (main/preload/types;
  workspace creation is main-boot-only now), and
  `WorkspaceController.deactivateAll` / `deactivateAllWorkspaces` (dead).
- Settings "Restart onboarding" row replaced by **"Rescan workspace"**
  (runs `scannerAPI.start()` — still the only trigger for the
  research-profile + file-tagging scan, which used to run in onboarding
  step 4; it silently no-ops without directories or an API key).
- Hard reset (Debug tab) now wipes and **relaunches the app** via
  `app.relaunch()` + `app.quit()` inside `debug:hardResetWorkspace`; boot
  then creates a fresh blank workspace.
- `thread.tsx`'s setup progress bar reused onboarding CSS classes — renamed
  to `.cdProgressBar`/`.cdProgressBar__fill` (kept in phaseB.css).
- Verified: tsc clean, smoke test exits 0, jest green except the
  pre-existing `fileMonitorIntegration` failure. The fresh-install path
  (no workspace row → blank workspace auto-created) is code-reviewed but
  not runtime-tested against a virgin userData dir.

**NOT yet tested at runtime (highest priority next):**
- A real chat turn — agent doing Bash/Read/Write against a shared dir.
- `.applications/install pip <pkg>` against a real venv.
- Mini-app build → iframe load → bridge tool calls.
- Notebook → kernel gateway → Python execution.
- A mini-app that publishes an MCP the agent then calls.
- Production package launch: **now tested & working** (2026-07-24). `npm run
  package`/`make` produce an app that boots (window + agent server). It is
  ad-hoc signed via the forge `postPackage` hook (see below); a *downloaded*
  copy is still quarantined → "unidentified developer" (right-click → Open)
  until Developer-ID + notarization. Full chat/mini-app/notebook flows in the
  packaged build remain to be exercised.

## Known hazards (design constraints, not bugs)

- **New Claude models need an Agent SDK upgrade, not just a list edit.** The
  bundled Claude Code CLI gates which models it will run: a model newer than
  the CLI returns `400 … does not support this model; version X or newer is
  required`, no matter what `GET /v1/models` says the account can reach.
  Discovery (`main/modelCatalog.ts`) keeps the roster current by itself, but
  the picker can only offer what the CLI accepts — so `shared/models.ts` keeps
  an `UNSUPPORTED_MODEL_IDS` list for anything held out on those grounds.
  Measured 2026-09-16 on SDK 0.2.121 (== Claude Code 2.1.121): Fable 5.1 was
  refused and wanted 2.1.251+. **Cleared 2026-09-17 by upgrading to 0.3.273**,
  so the list is empty today — but the constraint is permanent, and the next
  model Anthropic ships will hit it again. Keeping models current means
  keeping the SDK current. Note the gate is CHAT-only: mini-apps call the API
  directly through the proxy with no CLI in the path.

- **Background Bash commands die with the turn.** One CLI subprocess per turn
  — the registry destroys the session when its last subscriber detaches — so a
  `run_in_background` command the agent starts is SIGTERMed with it, and the
  CLI files a `stopped` task notification that it replays as a turn on the next
  resume. That replay is what swallowed first messages (Status, 2026-09-21);
  the host now absorbs it, and the agent is told not to start pollers. Keeping
  sessions alive to make pollers real was deliberately NOT done — see the cost
  bullet in that entry.
- **A locked folder blocks the file tools, not the shell.** Since 2026-10-01 a
  lock is SDK `permissions.deny` rules for `Edit`/`Write`/`NotebookEdit` on the
  real path and the workspace symlink (`shared/readOnlyRules.ts`), verified
  live. Bash can still write there; the agent is only told not to. Rules are
  built at session create, so a lock applies to new chats. Folders are
  writable unless locked (migration 34 unlocked every pre-existing row — the
  old `readOnly = true` default was never chosen by anyone).
- ~~**`findFreePort` probes the wrong interface — dev can hijack prod's agent
  server.**~~ **FIXED 2026-07-28** — see the Status entry. The probe now binds
  `127.0.0.1` (`main/freePort.ts`, extracted so it is unit-testable), and
  `/health` echoes a per-app-run instance token that `isAgentServerHealthy()`
  requires before adopting a server. Note the rule that matters if this is
  ever touched again: the probe must perform **exactly** the bind the server
  performs, not a stricter one — measured on macOS, wildcard and loopback
  binds do not collide in *either* direction, so "probe the wildcard to be
  safe" is not conservative, it is just wrong.
- **Mid-session directory changes don't refresh agent context** — new dirs
  only surface to the next chat session (guidance is set at session create).
- ~~**ContainerTests debug panel is stale**~~ **Stale hazard (2026-09-30): `ContainerTests.tsx` is imported by nothing and never mounts; it is dead code on the 4.4a removal list.** It used to run old container commands
  (`ls /data`, `R --version`); failures there are cosmetic.
- **Requires system Python 3.9+ and npm on PATH** for Python/npm mini-app
  deps. No bundled Python yet (python-build-standalone is a future option).
- **Auto-update runs on GitHub Releases now (was CloudFront).** `updater.ts`
  uses `electron-updater`'s **github** provider (`iliasacademia/acabox-releases`,
  overridable via `ACABOX_UPDATE_OWNER`/`ACABOX_UPDATE_REPO`), default channel
  (`latest-mac.yml`). `npm run release` (`scripts/release.mjs`) builds →
  generates metadata (`scripts/generate-update-manifest.js`) → `gh release
  create`. The public releases repo
  `iliasacademia/acabox-releases` is set up. **Detection is confirmed working**
  (2026-07-27): the production log shows `[UPDATER] Configured GitHub Releases
  feed` → `[UPDATER] No update available.` on a real v0.1.1 install, i.e. the
  feed is fetched, `latest-mac.yml` parsed, and versions compared. Note
  `app-update.yml` omits `updaterCacheDirName`, so electron-updater logs an
  error and falls back to `app.name` — cosmetic, one-line fix if it ever
  matters. `setFeedURL` means the yml is only consulted for that cache dir.
  Two gotchas for the record: a brand-new release repo must be **seeded with
  one commit** before `gh release create` works (empty repo → 422 "Repository
  is empty"; done once); and **Squirrel.Mac auto-*install* needs a Developer
  ID** — which is why the install step is no longer Squirrel's (see
  `main/selfUpdater.ts` and the Status entry). The underlying constraint still
  governs any return to Squirrel:
  Concretely: `codesign -d -r- /Applications/Acabox.app` →
  `designated => cdhash H"…"`, i.e. the ad-hoc DR is a hash of that exact
  build. Squirrel.Mac validates the downloaded bundle against the **running**
  app's designated requirement, and a new build always has a different cdhash,
  so it can never satisfy it. Not fixable in config — the DR has to be
  identity-based. Everything for signing is already wired (forge.config reads
  `APPLE_IDENTITY` → `osxSign` with hardenedRuntime + `entitlements.plist`, and
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` → `osxNotarize`; the
  ad-hoc `postPackage` hook self-disables); what's missing is only the cert
  (`security find-identity -v -p codesigning` → 0 valid identities). **The
  first signed release still cannot update the ad-hoc installs** — the running
  build's DR is a cdhash regardless of how the new one is signed — so one
  manual reinstall is unavoidable at that transition. Untested under hardened
  runtime: the agent server spawns with `ELECTRON_RUN_AS_NODE=1`; the
  `RunAsNode` fuse is `true` and the entitlements cover jit /
  unsigned-executable-memory / disable-library-validation /
  allow-dyld-environment-variables, so it should survive — confirm
  `[HostProcess] Agent server healthy` on the first signed build.
  Only **arm64** is built; Intel Macs get nothing, and adding an x64 build
  would clobber `latest-mac.yml` in the same release (`release.mjs` writes one
  manifest per run and does not merge). There is a silent check-on-launch (10s
  after ready) plus the tray "Check for Updates…" manual path.
- **No Anthropic API key = no agent.** With login and onboarding gone, a
  fresh install boots straight to the Command Desk with no key prompt; chat
  and scans fail until a key is set (env or Settings → Account). Surfaced as
  "No Anthropic API key configured. Add one in Settings." — not a crash.
  (Until 2026-07-27 this was only true of the *scan* path: chat ran the turn
  anyway and the user got Claude Code's own "Not logged in · Please run
  /login". Fixed — see the Status entry.) There is no first-run nudge toward
  Settings; candidate for a small banner if this trips real users.
- **`academia:fetch` is unauthenticated now.** Mini-apps that call it (the old
  grant-finder bridge) get 401s since there's no session. Core features don't
  use it. Kept as an optional path, not removed.
- **Analytics is gated off** (no login flips the auth gate), so `track()` is a
  no-op and nothing is posted to academia. `coscientistAnalytics` +
  `apiClient`/`apiCall` are kept but dormant; re-enable against a fork-owned
  backend if ever wanted.
- **`writing_agent` briefings target the dropped Word overlay.** File tagging
  still creates "review your manuscript intro" cards (one Haiku call per
  manuscript found during a scan), and clicking them calls
  `fileMonitorAPI.openFile(..., 'com.microsoft.Word')` + overlay docking —
  a flow from the upstream Word-overlay feature this fork nominally dropped.
  Candidate for the next removal pass (or re-point at an in-app chat flow);
  parts of the overlay plumbing evidently still exist.

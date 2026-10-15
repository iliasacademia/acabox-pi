# Acabox PI: port plan

**Status: plan agreed, increment 0 starting (2026-10-15).** The owner answered
the ten decisions in section 9 on 2026-10-15; the answers are recorded there
and folded into D8, D10, D15, P1-16, P2-05, P3-05 and P5-07. Everything else in
this document is settled by measurement or by reading code, and each claim
names its evidence.

Evidence lives next to this file in `pi-port-research-2026-10-15/`:
`acabox-and-pi/` (12 reader reports over Acabox, the PI 1.2.0 source and the
sign-in policies, plus a completeness critique), `co-scientist/` (five reader
reports over the co-scientist `cobuild` branch's PI implementation, and their
synthesis) and `spike/` (the two scripts that ran real PI turns under
Electron's Node). "R:" pointers below name those files. Every file:line pointer
into Acabox refers to `iliasacademia/acabox` at `3f4ad5fe` (v0.1.31); pointers
into PI refer to `earendil-works/pi` at `5ab7fe7` (1.2.0).

**Where the work runs (decided 2026-10-15):** implementation runs in Claude
Code cloud sessions on this repository, one PR per ticket batch; acceptance
runs on a Mac (the office Mac mini or the owner's laptop) through
`claude --teleport`. Section 6 opens with the rules and the facts behind them;
P0-09 and P0-10 set the two hosts up. The archive is committed in its scrubbed
form (no private code excerpts, no internal hosts, no token values) **without
the `co-scientist/` folder**, which stays on the laptop (question 1).

## 1. What Acabox PI is

The same product as Acabox: a scientist points the app at local research
folders and uses an agent to analyse files, build and run mini-apps, and reach
MCP services. Two things change:

1. **The harness.** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`,
   which bundles the Claude Code CLI) is replaced by the PI coding-agent SDK
   (`@earendil-works/pi-coding-agent`, pi.dev, MIT). PI is a library, not a
   CLI: the agent loop, tools, sessions and compaction run inside our own
   process.
2. **Sign-in.** Instead of one Anthropic API key, the user connects one or more
   providers: **Sign in with ChatGPT** (spends a ChatGPT plan), an **OpenAI**
   API key, an **Anthropic** API key, or an **OpenRouter** key (which reaches
   hundreds of models). The model picker lists what the connected providers can
   run.

Acabox PI is a sibling app that must coexist with Acabox on one Mac: its own
bundle id, userData directory, keychain item and release feed.

## 2. Facts the plan rests on

All of these were measured on this machine on 2026-10-15 unless marked READ
(read from source) or POLICY (read from a vendor's published terms).

| # | Fact | Evidence |
|---|---|---|
| F1 | PI 1.2.0's SDK loads and runs under Electron 37.2.0's bundled Node 22.17 (`ELECTRON_RUN_AS_NODE=1`) although PI declares `engines.node >= 22.19`. The CLI bundle prints `1.2.0`; a session is created in 12–20 ms; import of the esbuild bundle takes 100–130 ms; the SDK adds about 59 MB RSS; offline it makes zero network calls and writes only `auth.json`/`models-store.json` into its agent dir. | R: `pi-packaging-runtime.md` §5 |
| F2 | A real chat turn ran under Electron's Node on `claude-haiku-5-5`: thinking, tool-call and text deltas streamed; four tool calls in one assistant message executed in parallel; a custom tool named `mcp__workspace__get_research_profile` was listed in the prompt and called; a `tool_call` guard that returned `{block:true}` produced an error tool result; a guard that **threw** also blocked the tool (fail closed) and the turn continued; `abort()` killed a running `sleep` with the tool result "Command aborted"; the session file was reopened and resumed; per-message `usage.cost.total` and `getSessionStats().cost` were populated. Whole spike cost under one cent. | `spike/spike.mjs`; output in section 11 |
| F3 | A session file truncated after an assistant message whose tool calls had no results (a force-quit mid-tool) resumed cleanly: the next prompt was answered. PI closes dangling calls itself. | `spike/dangling.mjs`; section 11 |
| F4 | A custom tool named `bash` passed in `customTools` replaces PI's built-in bash (so a default timeout and an environment scrub can be added without patching PI). | `spike/spike.mjs` ("SHADOWED BASH") |
| F5 | PI's `tools` option is an allowlist that also filters `customTools`; a custom tool not named in it is silently never registered. Omit `tools` and use `excludeTools`, or use `+name` modifiers. | R: `pi-sdk-surface.md` §1 (MEASURED); co-scientist shipped a six-name list beside 76 custom tools once, R: `co-scientist/lessons-and-ops.md` L13 |
| F6 | A custom system prompt (`systemPromptOverride`/`systemPrompt`) replaces PI's preamble **and drops its generated `<tools>`, `<rules>` and `<docs>` sections**; `appendSystemPrompt` keeps them. | R: `pi-sdk-surface.md` §5 (MEASURED) |
| F7 | PI reads `AGENTS.md`/`CLAUDE.md` from the agent dir, the cwd **and every ancestor of the cwd up to `/`**, and the SDK treats the cwd as a trusted project by default (`projectTrusted = true`), so a `.pi/extensions/*.ts` planted in the agent-writable workspace would execute in our process. | R: `pi-packaging-runtime.md` §7 (MEASURED), `pi-tools-extensions-skills.md` §6 |
| F8 | Webpack-bundling the PI SDK compiles but dies at load (`Cannot find module 'node:fs'`, baked `import.meta.url` paths). PI's own relocated esbuild bundle plus three deps (photon-node, jiti, quickjs-wasi) is 14 MB and runs; a webpack CJS bundle can load it with `await import(/* webpackIgnore: true */ fileUrl)`. | R: `pi-packaging-runtime.md` §5c |
| F9 | Importing PI installs SIGINT/SIGTERM/SIGHUP listeners (signal-exit via proper-lockfile) and, inside Electron main, PI's providers would run over Electron's net-backed `fetch`. Neither is a problem in a dedicated child process. | R: `pi-packaging-runtime.md` §6 |
| F10 | "Sign in with ChatGPT" is OpenAI's official flow for third-party agents (DevDay 2026-09-29): dynamic client registration (`client_id=dynamic_agent_client`), an `agent_name_hint` the app sets, a per-install UUID host id, a fixed loopback callback on port 1455, scopes including `chatgpt.tokens.use.direct`, and the resulting token calls the normal Responses API at `api.openai.com/v1`. PI 0.99+ implements it as the `openai` provider's OAuth method (`LoginOptions.agentName`, `getDeviceId`). | READ R: `pi-auth-models.md` §1.3; POLICY R: `signin-policy-research.md` §1.2 |
| F11 | Plan usage through SIWC is self-serve for "open-source and locally hosted apps"; paid or remotely hosted apps go through an interest form; OpenAI's own docs list Pi, OpenCode, OpenClaw and T3 as open-source integrations. The SIWC Terms require the app's own name, local token storage, express consent before background use, "connected application only", and no charge to the user. The preview has open bugs (an HTTP 520 outage on every SIWC token since 2026-10-14; refresh tokens refused with `invalid_grant`, forcing hourly re-login) and ChatGPT Business workspaces are denied. | POLICY R: `signin-policy-research.md` §0, §1.1, §1.6, §1.7 |
| F12 | Anthropic's terms forbid third-party apps from routing requests through Free/Pro/Max credentials or intermediating Claude.ai credentials. PI's built-in Anthropic OAuth impersonates Claude Code (its client id, a `claude-cli` user agent, an injected "You are Claude Code" prompt). Acabox PI must offer Anthropic **API keys only** and reject `sk-ant-oat…` tokens. | POLICY R: `signin-policy-research.md` §2 |
| F13 | OpenRouter supports API keys and a PKCE sign-in that yields a permanent key; `GET /api/v1/key` answers 401 without a credential and is the valid key check, while `/models/user` and `/models` answer 200 to anyone. | R: `signin-policy-research.md` §3; `acabox-identity-and-ui-surface.md` B6 (MEASURED) |
| F14 | The co-scientist web agent (`academia-edu/academia-electron`, `cobuild`, `agent_cloud/`) runs PI 0.87.1 in-process through `createAgentSession`, translates PI events into Claude-SDK-shaped SSE messages (`piEventAdapter.ts`), bridges its `createSdkMcpServer` relays into PI custom tools over an in-memory MCP transport, guards tools with an inline extension, and keeps SQLite as the source of truth with a per-turn in-memory PI session. Its recorded lessons are archived in five reader reports and a synthesis. | R: `co-scientist/agent-cloud-pi-runner.md`, `co-scientist/cloud-routes-mcp-and-mini-apps.md`, `co-scientist/rootfs-prompts-and-desktop.md`, `co-scientist/agent-shared-catalog-extensions.md`, `co-scientist/lessons-and-ops.md`, `co-scientist/synthesis.md` |
| F15 | Acabox's renderer, SQLite rows, chat search, `read_chat` and cost display all consume **Claude-SDK-shaped JSON** (`stream_event` deltas, `assistant` content blocks, `user` tool_result blocks, one cumulative-cost `result` per turn) that the agent server relays verbatim over SSE. | R: `acabox-host-session-contract.md` §0–§2 |
| F16 | PI's `read`, `write` and `edit` tool factories take pluggable `operations` (`readFile`, `writeFile`, `access`, `mkdir`) that receive the **resolved absolute path**, so a host guard sees the real target without reimplementing PI's path resolution (which strips a leading `@` and expands `~`, the trap the co-scientist hit). | READ: PI `core/tools/{read,write,edit}.ts`; R: `co-scientist/rootfs-prompts-and-desktop.md` lessons |
| F17 | PI's `read` treats every non-image file as UTF-8 text, so a PDF comes back as decoded binary; Claude Code's `Read` extracted PDFs natively. Acabox already depends on `pdf-parse` and `mammoth`, pure JS, used by the scanner's document reader. | READ: PI `core/tools/read.ts`; R: `co-scientist/rootfs-prompts-and-desktop.md` headline 8; Acabox `package.json` |
| F18 | A Claude Code cloud session is a fresh Ubuntu 24.04 x86_64 VM (4 vCPU, 16 GB RAM, 30 GB disk, root) with Node 20/21/22 (22 on PATH), Rust, ripgrep, gh, jq and Docker preinstalled. Network is an allowlist: the default Trusted list covers GitHub (including `objects.githubusercontent.com`, where the Electron binary comes from), npm, crates.io, nodejs.org and `api.anthropic.com`; a Custom list adds other hosts. Environment variables are plain `.env` lines; network secrets attach a key outside the sandbox. A setup script runs as root and is snapshotted when it finishes in about five minutes. A foreground command times out at 2 min (10 max) and then continues in the background for up to 30 min; `BASH_DEFAULT_TIMEOUT_MS` raises both. Idle VMs pause and are reclaimed, and background work does not survive that. Sessions bill plan usage, not an API key. A session sees only the repository it cloned plus other GitHub repos the connected credential can read. Acabox's prestart scripts all skip on non-darwin, so `npm test` and the agent server run there; packaging, the keychain behind `safeStorage`, TCC, dictation, screenshots, the Rust file monitor and the SIWC loopback callback do not. | READ: code.claude.com/docs `cloud-environments`, `claude-code-on-the-web`, 2026-10-15; Acabox `scripts/*.js` platform guards |
| F19 | The office Mac mini (`ssh fors-mac-mini`, Tailscale): Macmini9,1, Apple M1, 8 GB RAM, 108 GB free, macOS 26.6.2, a held GUI session with Screen Sharing on and a display attached, FileVault on, no auto-login. Present: Xcode CLT 27, Swift 6.4, Python 3.9.6, Homebrew, git, gh, Node 26.3, Claude Code 2.1.201 signed in as the owner. Missing: Rust, ripgrep, fd, a git identity, valid gh tokens (both stored accounts are expired), any provider key, any checkout. Dev-loop peaks measured on the laptop: tsc 1.25 GB, agent-server webpack 0.5 GB, the dev app about 0.65 GB; jest defaults to one worker per core minus one (7 on the mini). | MEASURED 2026-10-15 over SSH; `/usr/bin/time -l` on the laptop |

## 3. Architecture after the port

```
renderer (unchanged shell)      Electron main (owns secrets, DB, UI)              agent server child (PI in-process)
assistant-ui thread  ── IPC ──  index.ts chat:send ── agentSession.ts ── HTTP+SSE ── agent-server/index.ts
model picker, settings          secretStore (safeStorage)   ◄── host-events SSE ──  PI SDK: createAgentSession per chat
                                relay handlers (12 tools)   ◄── mcp-call/mcp-result  customTools, guards extension,
                                mcpHost (stdio servers)                              createMcpExtension (connectors),
                                                                                     ModelRuntime + in-memory CredentialStore
```

What stays where it is: the Electron main process keeps every host concern it
has today (SQLite, encrypted settings, the 12 relay tool handlers, hosted MCP
supervision, the mini-app builder, the kernel gateway, the Python venv, the
file monitor, dictation, screenshots, sharing). The renderer keeps its shell,
its SQLite row shapes and its assistant-ui stream. The agent server child keeps
its process boundary, its HTTP/SSE routes and its relay round trip. Only what
runs **inside** the child changes: `query()` from the Claude SDK becomes an
`AgentSession` from PI, and a translator turns PI's events back into the
SDK-shaped JSON the host already understands.

Three new pieces exist: a **credential channel** (main pushes decrypted
per-provider credentials to the child, the child reports rotated OAuth tokens
and login events back), a **provider login flow** (the child runs PI's OAuth
flows, main opens the browser and shows the prompts), and a **model roster
served by the child** (what the connected providers can run, with prices and
thinking levels).

## 4. Decisions

Each decision names the alternative that was rejected and why.

### D1. PI runs inside the existing agent-server child, in-process through the SDK

Rejected: running PI in Electron main (F9: signal handlers and Electron's
`fetch` in main; a PI or tool bug would take the app down; the child's env is
`buildSubprocessEnv()`, which the agent's shell must inherit; the child is
already crash-restarted 3/60 s). Rejected: driving `pi --mode rpc` as the child
(one session per process, tools only from extension files on disk, no host
credential store; R: `pi-mcp-sessions-rpc.md` §4.6–4.7). The co-scientist cloud
made the same in-process choice (F14).

### D2. PI ships as its own relocated bundle under `Resources/pi`, pinned exactly

A build step assembles `build/pi/` from `node_modules`: `dist/bundle/**` (8.9
MB), `@silvia-odwyer/photon-node`, `jiti`, `quickjs-wasi`, a hand-written
`package.json` (`"type":"module"`, the pinned version). Shipped via forge
`extraResource`, loaded by file URL with `webpackIgnore` (F8). `piConfig` is
**not** rebranded, so the agent-dir variable stays `PI_CODING_AGENT_DIR`
(rebranding silently renames it; R: `pi-packaging-runtime.md` §3). Every PI
process gets `PI_CODING_AGENT_DIR=<userData>/pi-agent`, `PI_OFFLINE=1`,
`PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, and has every provider environment
variable PI auto-adopts scrubbed from its env (the list is read from PI's own
`env-api-keys` module, 54 names in 1.2.0, not copied). The dependency is pinned
exactly (`1.2.0`) because the co-scientist's only recorded PI upgrade broke
every turn (typebox hoisting flipped between 0.84 and 0.85) and because PI's
`engines` floor is above Electron's Node; a boot probe guards the gap. The
co-scientist's 0.87.1 was never an option: Sign in with ChatGPT exists in PI
only from 0.99.0.

### D3. The wire contract stays SDK-shaped; tool names become PI's own

The agent server keeps its routes (`/health` with the instance token,
`/sessions`, `/messages`, `/events` with the `Last-Event-Id` ring buffer,
`/interrupt`, `/stop`, `/mcp-result`, `/credentials`, `/connectors`, `/hosted`,
`/skills`) and its SSE event names. A translator (port of the co-scientist's
`piEventAdapter.ts`) emits `system/init`, `stream_event` deltas, one
`assistant` message per PI assistant message holding all its blocks (the host's
rows already store a block array, and the history converter merges a turn
anyway), `user` tool_result messages and one `result` per turn. SQLite rows
therefore keep their Anthropic block shapes; chat search, `read_chat`, the
history converter and the cost rule stay untouched (F15).

Tool names are **not** translated back to Claude spellings: rows store
`bash`/`read`/`write`/`edit`/`grep`/`find`/`ls`/`web_fetch`/`todo_write` and
the renderer's tables learn them (the co-scientist desktop renderer already has
such a table, `tool-labels.ts`). Rejected: translating `bash`→`Bash`,
`read.path`→`Read.file_path` at the boundary. It would make stored rows lie
about what ran and would have to be undone in `read_chat` and every log. The 12
relay tools keep their `mcp__<server>__<tool>` names unchanged, so the code
that matches them literally needs no edit.

### D4. Sessions: PI's own JSONL per chat, one live session per chat

`SessionManager.create(cwd, <userData>/pi-sessions, { id: <chat id> })` for a
new chat, `SessionManager.open(<path>)` to resume (PI names the file `<ISO
timestamp>_<id>.jsonl`, so the host locates it by its `_<chat id>.jsonl`
suffix, one file per chat); the chat's own UUID is a valid PI session id and it
also becomes OpenAI's `prompt_cache_key`, which the co-scientist found
necessary for cache hits (R: `co-scientist/lessons-and-ops.md`, the
prompt-cache lesson). `sessions.sdk_session_id` keeps holding the resumable id
(now equal to the chat id); `transcriptStore` is re-pointed at the PI session
directory so chat delete and the orphan sweep still reclaim files.

The PI session stays alive across turns inside the child (idle eviction after
10 minutes, as today), so MCP connectors connect once per chat rather than once
per turn and PI's compaction entries persist in the file. A mid-turn send goes
to `session.followUp()` (delivered after the current run, which is what the
Claude queue did). Stop is `abort()` plus `clearQueue()` and the session
survives; `/stop` (dispose) is used on chat delete, quit and crash restart.

Rejected: the co-scientist's SQLite-as-truth design with a per-turn in-memory
PI session. It exists because a cloud machine could not keep a process alive
and had to migrate Claude transcripts; it costs them hand-written history
repair, compaction persistence, usage patching and queue ordering (R:
`co-scientist/lessons-and-ops.md` L1–L5). F3 shows PI's own files survive the
one local failure that matters (force-quit mid-tool). Their `piHistory.ts`
stays archived as the fallback if a later PI version regresses that.

### D5. Credentials: main owns the encrypted store; the child holds them in memory and is the only refresher

Main keeps per-provider credentials encrypted with `safeStorage` (the existing
`secretStore` envelope, one entry per provider id, masked over IPC). At child
start and on every change main pushes the decrypted set over `POST
/credentials` (a provider map replaces today's single Anthropic key); the child
seeds an in-memory `CredentialStore` (PI's `read/list/modify/delete` contract)
and `ModelRuntime.create({ credentials, modelsPath: null })`. OAuth refresh
runs inside `modify` in the child; the store's `modify` also posts the rotated
credential to main over a new child→main SSE stream (`GET /host-events`, event
`credential-updated`) right after its in-memory write; main persists it and
re-pushes the full set. PI's 15 s timeout covers only the provider call inside
`modify`, and an SSE event has no acknowledgement, so the child keeps the
rotated token in memory and the only loss is a child crash in the milliseconds
before main writes, which surfaces as the same "reconnect ChatGPT" state
OpenAI's own refresh bug produces today (OpenAI rotates on every refresh and
invalidates the old token). The credential object is stored and pushed
verbatim: PI's OpenAI flow adds `clientId` and `scopes` as extra fields and its
refresh throws without `clientId`.

Because the child performs **every** model call, including background title
generation, the mini-app proxy and the scanner (D11), there is exactly one
process refreshing tokens, which the SIWC docs require ("serialize refreshes").
The ChatGPT login itself also runs in the child (D6); main only opens the
browser and renders prompts. `agent.json` stops carrying secrets: the child
receives them after `/health`, which is a strict improvement on today's
plaintext 0600 file.

Rejected: PI's default `auth.json` under the agent dir (plaintext 0600 holding
OAuth tokens; two writers once main also needs to read status). Rejected:
making main a second `ModelRuntime` for background calls (two refreshers).

### D6. Providers in v1: OpenAI (Sign in with ChatGPT and API key), Anthropic (API key only), OpenRouter (API key and PKCE sign-in)

The `openai` provider's OAuth method is the sanctioned SIWC flow; the login is
started with `agentName: 'Acabox PI'` and a persisted UUID device id. The
`openai-codex` (legacy) provider, which borrows the Codex CLI's client id, is
**not** offered unless the owner asks for an advanced toggle (section 9). PI's
Anthropic OAuth is hidden and `sk-ant-oat…` values are refused as keys (F12).
OpenRouter's PKCE flow is offered because it yields a permanent key with no
refresh. A ChatGPT sign-in and an OpenAI API key can coexist: PI holds one
credential per provider id, so the key is registered under a host-defined
second provider id (`openai-api`, same catalog and base URL) through
`ModelRuntime.registerProvider`, which is what lets a chat run on the plan
while background calls use the key (question 3). Google and the other 38 PI
providers are one catalog entry each later; Google's own OAuth is never offered
(bans reported; R: `signin-policy-research.md` §5).

### D7. Host tools: the 12 relays reach PI through an in-memory MCP bridge; guards wrap PI's own file tools; bash is wrapped; read learns PDFs

- The 12 relay tools keep their `createSdkMcpServer`/`tool` definitions and zod
  schemas unchanged. Their import moves to a 116-line in-process replacement
  built on `@modelcontextprotocol/sdk` (the co-scientist's `sdkServer.ts`,
  copied verbatim), and the co-scientist's `piMcpBridge.ts` (87 lines) connects
  each server over `InMemoryTransport.createLinkedPair()` and exposes every
  tool as a PI custom tool named `mcp__<server>__<tool>`, with a one-line
  `promptSnippet` cut from its description (PI lists a custom tool in the
  prompt only when it has one), its JSON schema reduced by
  `agentSdkInputSchema` (the reduction the Agent SDK applied, so the
  model-visible surface does not change at the swap), and a thrown error on
  `isError` (PI's tool result has no error flag; the throw becomes the tool
  result and the turn continues). A per-tool options map adds `executionMode:
  'sequential'` for `record_finding`. The handlers stay in main behind the
  existing `mcp-call`/`mcp-result` relay (they need Electron `Notification`,
  better-sqlite3 built for Electron's ABI, `safeStorage` and `WebContents`). No
  `tools` allowlist is passed (F5); `powershell` is inactive by default. A
  snapshot test pins names, descriptions and reduced schemas against a fixture
  recorded under the current Agent SDK build before the swap. Rejected:
  rewriting the 12 tools as hand-written `ToolDefinition`s (more code, and a
  surface that drifts from what production prompts were tuned on).
- Guards use PI's own extension points instead of shell hooks (PI has no
  PreToolUse hooks; the scripts also read `file_path`, and PI's field is
  `path`, so a naive port is silently inert). The folder lock and the secret
  deny list are `operations` wrappers on `read`, `write` and `edit` (F16): they
  receive the resolved absolute path (`write`'s `mkdir` included, or a
  directory would be created under a locked folder before the write is
  refused), realpath the deepest existing ancestor (a new file under a locked
  folder has no realpath of its own), and throw the lock or deny message for a
  target under a locked folder's real path or its workspace symlink, or one
  matching a secret pattern (`cobuilding-settings.json`, `agent.json`, and the
  PI agent dir's `auth.json`, `models.json`, `mcp.json`, `mcp-auth.json`,
  `trust.json`). Patterns the file tools cannot see run in a `tool_call`
  extension handler (`extensionFactories: [guards]`, `noExtensions: true`, and
  `SettingsManager.inMemory(…, { projectTrusted: false })`, F7): the
  install-command patterns from `block-host-installs.sh` on `bash` (the same
  seven patterns the co-scientist uses; the message says apt/R/conda have no
  wrapper), and secret patterns on `bash` commands and on `grep`/`find`/`ls`
  paths. The handler catches its own errors and returns `{block:true}` so a bug
  fails closed (F2). Reads are never confined to the workspace's real path: the
  skills are symlinks into userData and PI's loader follows them.
- `bash` is shadowed (F4) by `createBashToolDefinition(cwd, { spawnHook })`
  with a 120 s default and 600 s cap applied inside `execute` (PI validates the
  argument's type but sets no bound and no default), the provider environment
  variables scrubbed from the child env, and `COSCIENTIST_*`/`ACABOX_API_*`
  passed through as today.
- `read` is wrapped (F17): a `.pdf` or `.docx` target (by extension or the
  `%PDF` magic) is extracted to text with `--- Page N of M ---` markers by the
  `pdf-parse`/`mammoth` module Acabox already ships, paged with the tool's own
  `offset`/`limit`, cached per path and mtime; anything else delegates to PI's
  definition. Page images of figures (the co-scientist's poppler path) are
  deferred: poppler is not on macOS.
- `grep`, `find` and `ls` are switched on with `tools: ['+grep', '+find',
  '+ls']`: PI's default selection is only `read`, `bash`, `edit` and `write`,
  and a modifiers-only list adds to it while keeping custom tools enabled,
  unlike a plain allowlist (F5). `rg` and `fd` are shipped as `extraResource`
  binaries because `PI_OFFLINE=1` stops PI downloading them.
- New custom tools: `web_fetch` (the co-scientist's `piWebFetch.ts` ported:
  `url` only, 30 s, 2 MB, HTML to text, 100 k-char cap; plus a refusal of
  private, link-local and metadata address ranges after DNS resolution, which
  their fetch tool lacks and their `publicUrl.ts` has), `todo_write` (replaces
  `TodoWrite`; same `todos[]` shape so the checklist UI is a rename), and in
  increment 5 `ask_user` through a host `ExtensionUIContext`. `web_search` is
  deferred: PI cannot declare Anthropic's server-side search and the
  co-scientist's workaround needs an Anthropic key (their OpenAI Responses
  version measured 84 s against 14 s); it ships only for users with one
  (increment 5, optional).

### D8. The context pack: Acabox's own preamble, PI-style tool sections rebuilt by the host, static per chat

The system prompt is assembled in the child from: the co-scientist's
`piGeneralPrompt.md`, adopted wholesale as the base voice (question 10; the
file is copied from the private repo into `src/cobuilding/prompts/`, so its
text becomes public with the repo), then an identity line that says "I'm
Acabox" (question 9: the brand stays Acabox; "PI" is the edition name of D14)
and states the model actually serving the chat, because PI does not and a
co-scientist session on Opus 5 claimed to be Sonnet 4.6; then a
`<tools>` and `<rules>` section rebuilt from `getAllTools()` snippets and
guidelines in PI's own format (F6 means we must write them ourselves), the
user's `SOUL.md`, the workspace-directories block, the API-proxy guidance, the
knowledge-routing guidance, the memory section (D9), then PI's project context
(the provisioned workspace rules file, injected through `agentsFilesOverride`
with `noContextFiles: true` so nothing from `~` or `/` leaks in, F7), PI's
skills section (`additionalSkillPaths: [<workspace>/.claude/skills]`, the
existing symlink render; the loader follows symlinks, MEASURED) filtered by the
enabled roster through `skillsOverride` with a host-side character budget, and
PI's `<cwd>` section. Nothing in it changes between turns of one chat (the
co-scientist measured that a time-varying prompt re-wrote the whole
conversation at cache-write rates every turn; R:
`co-scientist/lessons-and-ops.md`, the prompt-cache lesson); the time of day
travels on each user message as a one-time stamp, as they do.

### D9. Memory is re-implemented as a prompt protocol plus one extension handler

PI has no memory feature. Production Acabox relies on the Claude Code one (28
agent-written memory files, `MEMORY.md` loaded every turn). The protocol text
is reproduced (file layout, frontmatter, the two-step save, "what not to save")
as a prompt section; `MEMORY.md` is injected per chat and snapshotted at chat
start; the save protocol tells the model to stamp `originSessionId` with the
chat id, which is what the Knowledge page joins on. The co-scientist's
`piMemory.ts` is the template (byte-compatible with the SDK format by design).

### D10. Models, effort and cost

The roster is what `modelRuntime.getAvailable()` returns for the connected
providers, grouped by provider, with `contextWindow`, per-million prices,
`reasoning`, supported thinking levels and image input from PI's catalog; for a
ChatGPT sign-in the child additionally filters by `GET /v1/models` with the
user's token (the SIWC docs say to). A chat pins `provider/modelId` into the
existing `sessions.model` column (write-once as today, no new column). Effort
becomes PI's thinking level, clamped per model; the picker shows the levels the
model supports. Per-turn cost: the translator emits `total_cost_usd` as the
chat's **cumulative** `getSessionStats().cost`, so `shared/turnCost.ts` and the
fold line keep working unchanged; dollars are hidden for chats on a
subscription provider (list price would be misleading). Defaults are per provider (section 9, question 8) and `BACKGROUND_MODEL`
becomes a per-provider resolver with reasoning forced off, because the
10/40/100/400-token caps assume no reasoning tokens. With the consent toggle
of P2-05 on, a ChatGPT-plan profile resolves background calls to `gpt-6-luna`
with reasoning off (its catalog entry maps `off` to `"none"`); with it off,
background calls use an API-key provider or do not run. PI's catalog marks Haiku 5.5 (and Opus 5.5, Sonnet 5.5) as
unable to turn thinking off (`thinkingLevelMap.off = null`,
`forceAdaptiveThinking`), while Anthropic's API accepts `thinking: disabled` at
low effort on Haiku 5.5 (Acabox measured it on 2026-10-12), so background calls
pass a model object cloned from the catalog entry with that override, verified
by a real call that returns no thinking block.

### D11. Background calls, the mini-app proxy and the scanner all run in the child on pi-ai

Title generation, manifest metadata and the scanner's classifiers call `POST
/complete`; the mini-app `anthropic:complete`/`anthropic:stream` IPC keeps its
Anthropic-shaped wire contract (bundled into every shipped mini-app) and is
translated in the child to `modelRuntime.completeSimple`/`streamSimple` (the
runtime's own methods are the only route that reads the injected credential
store; pi-ai's root index does not export them); PDF `document` blocks are
extracted to text in main (`shared/documentText.ts`, P1-18) because pi-ai's
user content has no document type. The two scanner agents become PI sessions in
the child with only `read`/`grep`/`find`/`read_document`, path guards in the
same extension as D7, a strict-schema `submit_result` tool in place of
`outputFormat: json_schema`, and host-side turn and dollar caps in place of
`maxTurns`/ `maxBudgetUsd`.

### D12. MCP: connectors through PI's MCP extension, hosted servers stay host-owned, the mini-app gateway is untouched

User connectors are passed to `createMcpExtension({ loadConfig, openUrl,
updateConfig })` from the host's own store (never from `mcp.json`), as `http`
servers with headers escaped (`$`→`$$`, leading `!`→`$!`, because PI
interpolates them), exposure set explicitly per server (`direct` when
`alwaysLoad`, else `deferred` behind `createToolSearchExtension()`, which
registers `tool_search` inactive, so `tools` gains `'+tool_search'`; PI's
default exposure is `codemode`); `sse` rows are refused with a message. OAuth
sign-in to a connector becomes a host-driven button that runs PI's MCP OAuth in
the child with the URL relayed to main (PI never opens a browser from the SDK).
Status comes from a transport wrapper the child installs through
`createTransport` (PI exposes no status event). Hosted stdio servers keep
`main/mcpHost/*` (env allowlist, supervision, approval, orphan reconcile) and
are exposed to PI as generated custom tools from `readyServersForAgent()`,
re-registered hidden when withdrawn. Rejected: letting PI spawn hosted servers
(it inherits the whole process env and respawns per session). The mini-app
published-tool gateway needs no change (it is already reached through two
generic relay tools). The OAuth pin, `oauthWindow.ts`, the idle-eviction
assertion and the swallowed-turn ladder are deleted (PI has no background bash,
so the hazard they guard does not exist).

### D13. Context overflow uses PI's compaction

PI compacts at `contextWindow − 16384` tokens and once more on an overflow
error, summarising with the chat's model. Acabox's "this chat got too long, I
had to start fresh" ladder is removed; a compaction shows as a host-authored
row. A cheaper summariser through `session_before_compact` is a later option.

### D14. Rename and coexistence

Package `acabox-pi`, product "Acabox PI", bundle id `com.electron.acabox-pi`,
userData `~/Library/Application Support/acabox-pi/<channel>`, release repo
`iliasacademia/acabox-pi-releases`, env prefix `ACABOX_PI_` for the update
variables, keychain item follows the product name, distinct icon tint. The
mini-app bridge globals, `ab-*` CSS, `@acabox/jsx-edit`, `ACABOX_API_*` and the
`acabox://chat/` link syntax are **not** renamed so exported tools and pasted
links keep working across the two apps. The two destructive npm scripts
(`fresh-install`, `db:cobuilding:reset`) are rewritten before any other code
change, because copied unchanged they delete the original Acabox install and
database (R: `acabox-identity-and-ui-surface.md` finding 1).

### D15. What is dropped

`claudeConfigDir.ts`, `ensureApiKeyApproved`, `UNSUPPORTED_MODEL_IDS`, the swallowed-turn ladder, the OAuth pin, the
context-overflow ladder, the two shell hooks, `dynamicMcp.ts` and
`jsonSchemaToZod.ts`, the unreachable calendar assistant, the dated
`migrateMissingManifests`, `auth:setEndpoint`, plan mode and subagents (no PI
primitive; the pptx skill's "use subagents" line is rewritten), `NotebookEdit`
(the kernel path uses the bridge, not the agent). The Word-overlay
`writing_agent` briefings and the stale `mcp__ms-word__*` references in the
`docx` and `academic-writing-agent` skills are already dead in Acabox and are
removed here (confirmed, section 9). **Kept by owner decision (question 5): the
Claude Design sign-in**, re-attached to PI in P5-07; its Settings section and
main-side files stay in the tree throughout.

## 5. Capability map

How each thing the Claude SDK did for Acabox is done on PI. The ticket column
points into section 6.

| Acabox capability | Claude SDK mechanism today | PI mechanism | Ticket |
|---|---|---|---|
| Multi-turn chat over one process | streaming-input `query()` | one `AgentSession` per chat, `prompt()`/`followUp()` | P1-03, P1-05 |
| Token streaming to the renderer | `includePartialMessages` → `stream_event` | `message_update` deltas → translator | P1-04 |
| Assistant/tool rows in SQLite | SDK `assistant`/`user` messages relayed | `message_end` → translator | P1-04 |
| Per-turn cost, header total | cumulative `total_cost_usd` on `result` | `getSessionStats().cost` emitted as cumulative | P1-04 |
| Resume after the app restarts | `resume: <sdk session id>` + CLI transcripts | `SessionManager.open(<userData>/pi-sessions/…)` | P1-03, P1-13 |
| Stop | `interrupt()` then destroy | `abort()` + `clearQueue()`, session kept | P1-06 |
| Model and effort pin | `model`, `effort`, `init.model` | `model: provider/id`, `thinkingLevel`, clamp | P1-15 |
| System prompt | `claude_code` preset + `append` | host-built prompt (D8) | P1-11 |
| Workspace rules, SOUL.md | `settingSources: ['project']` | `agentsFilesOverride`, `appendSystemPrompt` | P1-11 |
| Skills roster + budget | `skills` option, `skillListingBudgetFraction` | `additionalSkillPaths`, `skillsOverride` + host budget | P1-12 |
| Folder lock | `permissions.deny` `Edit(//path/**)` | `operations` wrappers on `read`/`write`/`edit` (F16) | P1-07 |
| Install and secret guards | PreToolUse shell hooks | `tool_call` guard on `bash`/`grep`/`find`/`ls` plus the file-tool wrappers | P1-07 |
| Bash environment, timeout | CLI defaults (120 s) | shadowed `bash` with `spawnHook` | P1-08 |
| 12 relay tools | `createSdkMcpServer` relays | `customTools` with unchanged names | P1-09 |
| WebFetch / TodoWrite | CLI built-ins | `web_fetch`, `todo_write` custom tools | P1-10 |
| Attachments (images) | base64 `image` blocks | `prompt(text, { images })` | P1-05 |
| Attachments (PDF/text documents) | `document` blocks | host-side text extraction, text block | P1-05 |
| Reading a PDF or docx in chat | CLI `Read` extracted natively | wrapped `read` on `pdf-parse`/`mammoth` | P1-18 |
| API key check, key storage | Anthropic `/v1/models`, one encrypted key | per-provider encrypted entries, provider probes | P1-16, P2-04 |
| Sign in with ChatGPT | n/a | `ModelRuntime.login('openai','oauth', interaction, {agentName,getDeviceId})` in the child | P2-01 |
| Model discovery | Anthropic `/v1/models` merge | `getAvailable()` grouped by provider; SIWC model list | P1-15, P2-03 |
| Background model calls | `@anthropic-ai/sdk` in main | `POST /complete` → `modelRuntime.completeSimple` | P3-01 |
| Mini-app model proxy | `@anthropic-ai/sdk` in main | same IPC, translated in the child | P3-02 |
| Workspace scanner agents | two one-shot `query()`s with hooks and json_schema | scanner PI sessions, `submit_result` tool, caps | P3-03 |
| Connectors (remote MCP, OAuth) | SDK `mcpServers` + CLI OAuth tools + pin | `createMcpExtension`, host-driven sign-in | P4-01, P4-02 |
| Hosted MCP servers | per-server SDK relay from `tools/list` | generated custom tools over `mcpHost.invoke` | P4-03 |
| Mini-app published tools | two generic relays | unchanged | — |
| Memory | CLI auto-memory | prompt protocol + extension (D9) | P5-01 |
| Context overflow | detect + start fresh | PI compaction | P5-02 |
| Scheduled tasks | background sessions, `done` on loop end | same sessions, completion at `turn-complete` | P5-05 |

Carried over untouched because they never touch the harness: the kernel gateway
and venv/npm-site bootstrap, `miniAppBuilder`, `backgroundBuilder`,
`packageInstaller`, the file monitor, dictation, screenshots, the quote
toolbar, text-edit-in-place, sharing, the skills store/import/findings ledger,
chat search, pinned tools, the Command Desk shell. Their only shared seams are
`buildSubprocessEnv()` (which the shadowed `bash` must reproduce) and the
stored row shapes (kept by D3).

## 6. Increments and tickets

Tickets are sized for one Sonnet (or Haiku, where marked) run each: one
concern, named files, a spec that fits on one screen, and an acceptance check
that a reviewer can run. Each cites the report section that holds the contract
so the implementer does not have to rediscover it. Increments are ordered by
dependency; within an increment, tickets without a stated dependency can run in
parallel, as separate cloud sessions or in worktrees.

### Where the work runs: cloud sessions build, a Mac verifies

Decided 2026-10-15. Every implementation ticket runs as a Claude Code cloud
session (claude.ai/code, or `claude --cloud` from a checkout) on
`iliasacademia/acabox-pi`, and ends in a PR. Acceptance runs on a Mac, the
office Mac mini (F19, set up by P0-10) or the owner's laptop: `claude
--teleport <session-id>` from a clean checkout fetches the session's branch,
then `npm start` and the live checks in section 10 run there. The facts are
F18 and F19; the consequences:

- **The repository is the only thing a cloud session sees.** The plan and the
  scrubbed archive are pushed before the first session (P0-01, from the
  laptop). The co-scientist repo is private; the `iliasacademia` account can
  read it but is a member, not an admin, of `academia-edu`, so the Claude
  GitHub App cannot be installed there by the owner. The route is `/web-setup`
  run in a terminal while `gh` is switched to `iliasacademia`, which lets
  sessions clone any repo that token can read, including
  `academia-edu/academia-electron`. The Claude GitHub App is installed on
  `acabox-pi` for PR creation. The `co-scientist/` reports are not committed
  (question 1): they stay on the laptop behind a `.gitignore` entry, and a
  cloud ticket that cites one has the cited section pasted into its dispatch
  prompt; the code they describe is read from the private repo itself.
- **Definition of done differs by host.** A ticket is done in the cloud when
  `npx tsc --noEmit` is clean, `npm run test:linux` is green (P0-09) and the
  PR lists the mac checks it needs. An increment is done when its section 10
  mac checks have run on a Mac. Mac-only suites are tagged, never deleted or
  weakened to pass on Linux.
- **What the cloud cannot touch** (F18): packaging and signing (I6), the
  keychain, TCC, dictation, screenshots, the Rust file monitor, the real
  ChatGPT browser callback (only the manual-paste path, P2-01, can be
  exercised there), and every live CDP check on the macOS app. By inspection
  about five of Acabox's 165 suites are macOS-bound (`dictationHelper` spawns
  the real helper, `fileMonitorIntegration` needs the Rust build,
  `attachmentAdapter` calls `sips`, three gate on darwin); P0-09 measures the
  real list on Ubuntu rather than trusting this count.
- **Memory.** 16 GB in the cloud clears every measured peak; the mini's 8 GB
  does not clear jest's default worker count, so it runs `--maxWorkers=2`.
- **Secrets.** Provider keys are network secrets of the cloud environment
  (P0-09; environment variables are visible to anyone using the environment).
  The headless tests push a credential through the channel of D5, because D2
  scrubs every provider variable from the child's own env; nothing secret is
  committed, and the `agent.json` dev key on the laptop stays there.

### Increment 0: bootstrap (no behaviour change)

**P0-01 Fork and hygiene.** Clone `iliasacademia/acabox` with full history into
a sibling temporary directory, move its working tree and `.git` into this
folder beside the existing `docs/` (a plain clone into a non-empty folder
fails), commit the docs, add remote `acabox-pi`, push `main` (after the owner
answers questions 1 and 6; this runs on the laptop before the first cloud
session, because a session sees only what is in the repo). The archive is
committed only in its scrubbed form: `grep -rn 'supersecuredevtoken\|devdemia\|workers\.dev'
docs/design/pi-port-research-2026-10-15` prints nothing and no fenced block
quotes `academia-electron` code, and `.gitignore` excludes
`docs/design/pi-port-research-2026-10-15/co-scientist/`. Add an MIT `LICENSE`
(question 1). Delete `.mcp.json` (a dev token; it points at
scripts that do not exist), `.github/workflows/claude-code-review.yml`, the
stale `docs/AUTO_UPDATER.md`/`docs/ARCHITECTURE.md`/`docs/FEED_SERVER.md`,
`OVERLAY_ARCHITECTURE_PLAN.md`, `BUGS.md`. Move the Acabox `CLAUDE.md` to
`docs/history/acabox-claude-status-2026-10-15.md` and write a new `CLAUDE.md`
(section 10). Review `src/share-workers/**/wrangler.toml` and
`docs/design/review-2026-09-30/` for anything the owner does not want public.
Acceptance: `npm install && npx tsc --noEmit && npm test` green on the fork,
on a Mac, before any other ticket (the cloud runs the Linux-safe subset from
P0-09 on). R: `acabox-identity-and-ui-surface.md` A5.

**P0-02 Destructive scripts first.** Rewrite `package.json` `fresh-install` and
`db:cobuilding:reset` for the new app name, bundle id and userData dir;
re-point `logs:dev:watch` (it exists). Acceptance: `grep -nE
'acabox([^-]|$)|Logs/Acabox' package.json` matches only `acabox-pi` forms (a
plain `com.electron.acabox` grep would also match the new id) and the package
name is `acabox-pi`. (Haiku-sized.) R: `acabox-identity-and-ui-surface.md`
finding 1.

**P0-03 Product constants.** New `product.json` at the repo root (name,
productName, bundleId, userDataDir, releaseOwner, releaseRepo, envPrefix) read
by `forge.config.js`, `scripts/rename-dev-electron.js`, `scripts/release.mjs`,
`scripts/generate-update-manifest.js`, and exported to code as
`shared/product.ts`; replace every identity touchpoint listed in
`acabox-identity-and-ui-surface.md` A1.1–A1.4 (`app.setName`, userData path,
window title, tray tooltip, Sentry release and tag, logging service, cookie
salt, `acabox-mcp-host` client name, `selfUpdater` expected id and temp-file
prefixes, `updater.ts` defaults and `ACABOX_PI_UPDATE_*` env names,
`app-update.yml`, forge usage strings, squirrel name). Add a jest test that
`forge.config.js`, `selfUpdater`'s expected bundle id and `app-update.yml`
agree with `product.json`. Acceptance: that test, plus `npm start` shows
"Acabox PI" in the menu bar and writes to `~/Library/Application
Support/acabox-pi/development`.

**P0-04 Brand assets.** Give the mark a distinct tint through
`scripts/gen-icons.mjs` and regenerate `src/assets/icons/*`; update the rail
wordmark and ChromeBar strings to the product name. Acceptance: the dev app and
Acabox are distinguishable in the Dock.

**P0-05 Vendor PI.** Add `@earendil-works/pi-coding-agent` at exactly `1.2.0`
as a devDependency. New `scripts/build-pi-bundle.mjs` (run from `prestart`,
`prepackage`, `premake`) that assembles `build/pi/` as D2 describes, plus
`scripts/verify-pi-runtime.mjs` that imports the bundle under Electron's Node
with an in-memory credential store and asserts `createAgentSession` works
offline (the probe from F1). Ship `build/pi` via `extraResource`. The
`@anthropic-ai/claude-agent-sdk` entries in `nativeModuleRoots`, `asar.unpack`
and the main webpack externals stay until P3-05: the scanner, the document
reader and the notification server still import the SDK until increment 3.
Acceptance: `npm start` prestart prints the probe's `pi 1.2.0 ok` line; `du -sh
build/pi` ≈ 14 MB. R: `pi-packaging-runtime.md` §8.

**P0-06 Ship `rg` and `fd`.** Add the two arm64 binaries (ripgrep and fd, with
their licences) under `resources/bin`, resolved in dev from
`node_modules/.bin`-style paths or Homebrew; prepend that directory to the
agent server's `PATH` so PI's `grep`/`find` find them (PI looks on PATH before
downloading). Acceptance: `rg --version` and `fd --version` run from the
child's PATH in both dev and a packaged build. R:
`pi-tools-extensions-skills.md` §1 (grep/find rows).

**P0-07 Release feed.** Create and seed `iliasacademia/acabox-pi-releases`
(public, one commit); make `release.mjs` rename the forge artifacts to
hyphenated names before upload and generate `latest-mac.yml` from the renamed
zip (GitHub rewrites spaces). Acceptance: `npm run release -- --dry-run` lists
`Acabox-PI-darwin-arm64-<v>.zip`. R: `acabox-identity-and-ui-surface.md`
finding 6, A1.2.

**P0-08 Tool-surface fixture.** Before the Claude SDK leaves the tree, record
the model-visible surface of the 12 relay tools (names, descriptions, the
schemas as the SDK publishes them) into
`agent-server/__tests__/toolSurface.fixture.json` with the co-scientist's
`toolSnapshot.ts` adapted; the test is skipped until P1-09 turns it on.
Acceptance: the fixture lists exactly 12 tools. (Haiku-sized.) R:
`co-scientist/cloud-routes-mcp-and-mini-apps.md` §2.1, §2.4.

**P0-09 Cloud environment and the Linux-safe test run.** The first cloud
session's ticket. (a) `scripts/cloud-setup.sh`: `apt-get install -y libnss3
libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1
libasound2t64 libxss1 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0
xvfb` (Electron's Linux runtime libraries, needed even under
`ELECTRON_RUN_AS_NODE`), then `npm ci`. Time it: the snapshot caches only
when the script finishes in about five minutes (F18); if `npm ci` plus the
Electron download exceeds that, record the per-session cost in `CLAUDE.md`
rather than trimming the install. (b) A `mac-only` marker for jest: suites
that need macOS wrap in `describeMac` from `src/test/platform.ts` (`describe`
on darwin, `describe.skip` elsewhere, with the reason printed), and `npm run
test:linux` runs the usual Electron-run jest with those suites skipped and
lists them; `npm test` on macOS is unchanged. Start from the candidates in the
"Where the work runs" section, then run the whole suite on Ubuntu and tag
exactly what fails for a platform reason; a failure for any other reason is a
bug to fix. (c) Environment settings, entered by the owner in the claude.ai
environment dialog and recorded in `CLAUDE.md`: network Custom with the
default list kept plus `api.openai.com`, `auth.openai.com`, `chatgpt.com`,
`openrouter.ai`; variables `BASH_DEFAULT_TIMEOUT_MS=600000` and
`PI_SKIP_VERSION_CHECK=1` only (the dialog warns that variables are visible to
anyone using the environment); the three provider keys as **network
secrets**: bearer `Authorization` for `api.openai.com` and `openrouter.ai`,
header `x-api-key` with no prefix for `api.anthropic.com`. Whether the proxy
replaces the `Authorization`/`x-api-key` header PI sends with its own is
measured in P1-17's headless provider tests; if it does not, the tests send
a placeholder credential, and as a last resort the keys become variables on
this personal environment. Setup script `bash scripts/cloud-setup.sh`, set
only after this ticket's PR lands (an empty field until then; a failing
script blocks every session from starting).
Acceptance: the session reports `npx tsc --noEmit` clean, `npm run
test:linux` green with the skipped list and its measured length, and `node
scripts/verify-pi-runtime.mjs` (P0-05) passing on the VM. (Sonnet-sized.)

**P0-10 The Mac mini as the verification host.** Not a cloud ticket: run
over `ssh fors-mac-mini` from the laptop, with the owner for the interactive
steps. State in F19. Steps: install rustup (`cargo` is required, Acabox's
prestart exits 1 without it); `brew install fnm ripgrep fd`; `fnm install 25`
and `fnm default 25` (better-sqlite3 declares Node 20–25; the mini has 26);
`git config --global user.name` and `user.email`; `gh auth login` as
`iliasacademia` (owner, interactive; both stored tokens are expired); copy the
plan's memory files into `~/.claude/projects/<acabox-pi dir>/memory`; clone
`acabox-pi` into `~/Documents/Dev Folders/Acabox-PI`; `npm install && npx tsc
--noEmit && npm test -- --maxWorkers=2` and `npm start -- -- --smoke-test`.
Rules recorded in `CLAUDE.md`: quit Antigravity IDE before building; planned
restarts go through `sudo fdesetup authrestart`, because FileVault leaves a
plainly rebooted mini unreachable until someone types the password at it;
teleport with `claude --teleport <session-id>` from that checkout. Acceptance:
the smoke test exits 0 on the mini and one teleported session's branch checks
out there.

### Increment 1: the harness swap (chat works on API keys)

**P1-01 Load PI in the agent server.** New `agent-server/piRuntime.ts`: resolve
the bundle (`PI_PACKAGE_DIR` → `process.resourcesPath/pi` when packaged,
`node_modules/@earendil-works/pi-coding-agent/dist/bundle` in dev), `await
import(/* webpackIgnore: true */ pathToFileURL(...).href)`, set the env in D2
before import, scrub the provider variables, create `ModelRuntime` with the
host `CredentialStore` from P1-02, `modelsPath: null`, `refreshOnCreate:
false`, then `refresh({ allowNetwork: false })`. The agent server stops
importing `@anthropic-ai/claude-agent-sdk`; the package,
`ensureApiKeyApproved`, `claudeConfigDir.ts` and `claudeConfigApproval.ts` stay
until P3-05 because main's scanner, document reader, notification server,
`containerService` and `transcriptStore` still import them, so the tree
compiles at every ticket. Acceptance: the rebuilt `dist/agent-server.js` boots
standalone under Electron's Node and `/health` answers; the webpack build has
no `@earendil-works` chunk and the agent-server bundle no `claude-agent-sdk`
code. R: `pi-packaging-runtime.md` §5c, §8; `pi-sdk-surface.md` §13, §17.

**P1-02 Credential channel.** `POST /credentials` takes `{ providers:
Record<string, Credential>, deviceId: string }` (PI's `Credential` union,
`{type:'api_key', key?, env?}` or `{type:'oauth', access, refresh, expires, …}`
with extra fields such as `clientId` and `scopes` that PI's OpenAI flow writes
and its refresh requires, so main stores and pushes the object verbatim); the
child applies each through its in-memory store. New `GET /host-events` SSE (one
stream per child, with the ring buffer and `Last-Event-Id` the session streams
already use) carrying `credential-updated { providerId, credential }`, emitted
from the store's `modify` after its in-memory write whenever PI rotates a token
(D5 says why it is not awaited). Main side: `main/providerCredentials.ts` keeps
`Record<providerId, enc:v1 blob>` in `cobuilding-settings.json` through
`secretStore`, pushes on child health and on change
(`containerService.updateAgentCredentials` generalised), and persists
`credential-updated`. `agent.json` loses its secret fields. The device id is a
UUID minted once and stored in settings (the existing `utils/deviceId.ts`
fallback is `fallback-<hostname>`, which PI rejects). Acceptance: unit tests on
the store contract (`modify` serialises per provider, returns the post-write
credential, `list` never resolves keys) and a real `ModelRuntime.create({
credentials })` probe under Electron's Node showing
`getProviderAuthStatus('anthropic').source === 'stored'`. R:
`pi-auth-models.md` §4.1, §4.4; `signin-policy-research.md` obligations list.

**P1-03 Sessions on PI.** `POST /sessions` creates one `AgentSession` per chat:
`cwd` = workspace root, `agentDir`, `modelRuntime`, `model` resolved from the
body's `provider/modelId` via `modelRuntime.getModel`, `thinkingLevel` clamped,
`customTools` from P1-07 (guarded `read`/`write`/`edit`), P1-08 (`bash`), P1-09
(bridged relays), P1-10 and P1-18, `resourceLoader` from P1-11/P1-12,
`settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', compaction:
{enabled: true}, retry: PI defaults, images: {autoResize: true} }, {
projectTrusted: false })`, `sessionManager` per D4, `tools: ['+grep', '+find',
'+ls']` (a modifiers-only list, never a plain allowlist, F5), then
`bindExtensions({ mode: 'rpc', uiContext, onError })`. Sessions are kept in the
map across turns; idle eviction disposes after 10 minutes; `/stop` disposes.
`POST /sessions` must reject a provider with no credential with the wording
main's `userFacingError` expects (P1-13). Acceptance: the live
`--smoke-test-pi` from P1-17 creates, resumes and disposes a session. R:
`pi-sdk-surface.md` §1, §2, §9, §13; `pi-mcp-sessions-rpc.md` §2.2–2.3.

**P1-04 Event translator.** New `agent-server/piEventAdapter.ts`, ported from
the co-scientist's file of the same name: `message_update` → Anthropic
`stream_event`s (`content_block_start` for text/thinking/tool_use with `index`
= `contentIndex`, `text_delta`, `thinking_delta`, `input_json_delta` from
`toolcall_delta`, `content_block_stop`); `message_end` assistant → one
`assistant` message whose `content` holds `text`, `thinking{thinking,
signature}` and `tool_use{id,name,input}` blocks; `message_end` toolResult →
`user` with one `tool_result{tool_use_id, content, is_error}`; `agent_settled`
→ `result` with `subtype` `success` (or `error_during_execution` when the last
assistant message has `stopReason` `error`/`aborted`), `result` = the final
assistant text, `is_error`, `total_cost_usd` = `getSessionStats().cost`,
`duration_api_ms` = sum of assistant `durationMs`, `terminal_reason:
'aborted_tools'` on abort, `session_id` = chat id; session create → `system`
`init { session_id, model: 'provider/id', mcp_servers: [...] }`. Every message
carries `session_id`. `agent_end.willRetry` and `auto_retry_*` map to nothing
(the host's heartbeat covers the wait); the session events
`compaction_start`/`compaction_end` map to a `system` message with subtype
`compact_boundary` (P5-02 renders it). Acceptance: jest table tests built from
the recorded spike events, plus the co-scientist's `piEventAdapter.test.ts`
cases. R: `acabox-host-session-contract.md` §1, §5A; `pi-sdk-surface.md` §3–§4;
`co-scientist/agent-cloud-pi-runner.md` §2.

**P1-05 Messages route.** `POST /sessions/:id/messages`: text plus `images`
(`{type:'image', data, mimeType}`; PI resizes to the model's limits, so the
renderer's 7 MiB cap stays as a transport guard); `document` attachments arrive
already extracted to text by main (`agentSession.ts` calls
`shared/documentText.ts` from P1-18; PDFs over the existing 2 MiB cap and text
over 256 KiB keep today's file-reference fallback); `file_reference` keeps its
text note. Every send is `session.prompt(text, { images, expandPromptTemplates:
false, streamingBehavior: 'followUp' })`: `expandPromptTemplates` never `true`
(a leading `/` would be dispatched as a command), and `followUp` so a send
during a run is queued for one follow-up turn instead of throwing. A send
during compaction (PI throws "Cannot submit a prompt while compaction is in
progress") waits for `compaction_end` and retries. A queued message's SQLite
user row is written when PI delivers it (the translator marks the user-message
`message_end`), not on arrival, so rows keep conversation order; the
co-scientist solves the same ordering by writing those rows at turn end
(`piController.ts:86-97`). Acceptance: a real turn with a PNG and a PDF
attachment answers about both. R: `pi-sdk-surface.md` §2, §11; `critique.md`
(document attachments gap).

**P1-06 Interrupt and stop.** `/interrupt` → `await session.abort();
session.clearQueue()`; the translator's `result` for an aborted run carries
`terminal_reason: 'aborted_tools'`; the host's 4 s wait and `stopped_by`
tagging stay. `/stop` → `session.dispose()` and map delete; the host registry
calls `/stop` only on chat delete, quit and crash restart, and otherwise leaves
the PI session alive (new `POST /sessions/:id/detach` that just clears pending
relay calls). History converter: the single `INTERRUPT_REJECTION` constant
becomes a list that also holds "Operation aborted" and "Command aborted", so a
stopped step renders as cancelled, not failed. Acceptance: the Stop live check
from Acabox's T02 (press Stop during a `sleep`, no ghost reply, rows `user →
assistant → tool_result → result{stopped_by:'user'}`). R:
`acabox-host-session-contract.md` §4.4; `pi-sdk-surface.md` §10.

**P1-07 Guards.** New `agent-server/guards.ts` exporting (a)
`guardedFileTools(cwd, locks, denyPatterns)`: PI's
`createReadToolDefinition`/`createWriteToolDefinition`/`createEditToolDefinition`
with `operations` wrappers (`readFile`, `access`, `writeFile` and `write`'s
`mkdir`) that throw the lock or deny message (reasons reuse the hook scripts'
wording; locks refreshed per run from `before_agent_start`), and (b) an inline
extension factory with one `tool_call` handler for the bash install patterns
and the secret patterns on `bash`/`grep`/`find`/`ls`, returning `{block:true,
reason}`; an error inside the handler blocks with "Acabox PI could not check
this call, so it was blocked." Delete `src/cobuilding/hooks/`, `settings.json`
and the `.claude/settings.json`/hooks provisioning in `main/skills.ts` (keep
`CLAUDE.md` provisioning). Acceptance: the pi-tools reader's measured matrix
(`edit LockedData/x` blocked, `write <real path>` blocked, `write
LockedData/new/file.txt` blocked with no directory created, `write OpenData/x`
allowed, `pip install` blocked, `zipper install` allowed, `cat
…cobuilding-settings.json` blocked, `read .claude/skills/pdf/SKILL.md` through
the symlink allowed) as jest tests driving the tool definitions directly and
`session.extensionRunner.emitToolCall`. R: `pi-tools-extensions-skills.md` §3;
`acabox-skills-hooks-context.md` §3;
`co-scientist/rootfs-prompts-and-desktop.md` §3.4.

**P1-08 Shadowed bash.** `createBashToolDefinition(cwd, { spawnHook })` with
the env from P1-01 (`buildSubprocessEnv()` minus provider variables), a 120 s
default and 600 s maximum timeout applied inside `execute` (PI validates the
type but sets no bound), and the same `command`/`timeout` schema. Acceptance:
`echo $COSCIENTIST_VENV_DIR` from a turn prints the venv path; `sleep 200` with
no timeout is killed at 120 s with PI's "timed out" text. R:
`pi-tools-extensions-skills.md` §1 (bash row);
`co-scientist/agent-cloud-pi-runner.md` §7 (piBashTimeout).

**P1-09 Relay tools through the MCP bridge.** Copy the co-scientist's
`sdkServer.ts` (as `agent-server/sdkServer.ts`: `tool`, `createSdkMcpServer`,
`agentSdkInputSchema` on `@modelcontextprotocol/sdk`) and `piMcpBridge.ts` (as
`agent-server/piMcpBridge.ts`: in-memory transport, `mcp__<server>__<tool>`,
140-char `promptSnippet`, throw on `isError`, text-only content, a per-tool
options map for `executionMode`); switch the seven relay servers'
`createSdkMcpServer`/`tool` import (`agent-server/index.ts:234-423`) from the
Claude SDK to `sdkServer.ts` with no other change; add host-side truncation of
large results (PI truncates none of them). `agentAllowedTools.ts` derives its
`mcp__` entries from the bridged list; `jsonSchemaToZod.ts` and the boot
assertion go; `dynamicMcp.ts` and `filterMcpServers` stay until P4-01/P4-03
because the `/connectors` and `/hosted` routes still call them. Turn on the
P0-08 snapshot test. Acceptance: the snapshot test passes against the bridge;
all 12 appear in `getActiveToolNames()` and, once P1-11 is in, in the prompt; a
real turn calls `get_research_profile` through the relay (F2 did this with a
stub). R: `acabox-mcp-relays-host-tools.md` C, J;
`co-scientist/cloud-routes-mcp-and-mini-apps.md` §2.1–2.4.

**P1-10 web_fetch and todo_write.** Port the co-scientist `piWebFetch.ts`
(`url` only, 30 s, 2 MB, HTML to text, 100 k-char cap) as `web_fetch(url)` and
add a refusal of private, link-local and metadata ranges after DNS resolution,
lifted from their `publicUrl.ts` (their fetch tool has none); add
`todo_write(todos[])` whose result echoes the list. Renderer: `todo-write.tsx`
keyed on `todo_write`, `turnSteps.ts` `CHECKLIST_TOOL` updated. Acceptance: a
turn asked to fetch `https://example.com` returns its text; a 3-step task
renders the checklist. R: `co-scientist/agent-cloud-pi-runner.md` §8;
`acabox-host-session-contract.md` §3.3.

**P1-11 System prompt builder.** New `agent-server/systemPrompt.ts` building
D8's prompt: preamble (identity text from a provider-neutral
`identityPreamble.ts`: "You are Acabox PI… running on <provider label>'s <model
label>"), `<tools>`/`<rules>` from the `promptSnippet` and `promptGuidelines`
of the tool definitions the host itself assembles (the factories for
`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls` plus the custom tools;
`session.getAllTools()` carries no snippets, and the loader's override
callbacks run inside `reload()` before the session exists) in PI's format (R:
`pi-tools-extensions-skills.md` §6.2 gives the exact format), addendum blocks
from the `POST /sessions` body (`soulMd`, `workspaceDirectoriesGuidance`,
`apiGuidance`, `KNOWLEDGE_ROUTING_GUIDANCE` rewritten for
`todo_write`/`web_fetch`), the memory section placeholder for P5-01; workspace
rules via `agentsFilesOverride` reading `<workspace>/.claude/CLAUDE.md` with
`noContextFiles: true`; `systemPromptOverride` returns the preamble;
`appendSystemPromptOverride` returns the blocks. A jest test pins byte-identity
of the prompt across two turns of one chat. Acceptance: `session.systemPrompt`
shows the sections in order and no "operating inside pi" text. R:
`pi-sdk-surface.md` §5; `acabox-skills-hooks-context.md` §5.

**P1-12 Skills on PI.** `additionalSkillPaths: [<workspace>/.claude/skills]`,
`noSkills: false`, `skillsOverride` filtering to the enabled roster from
`readSkillsState()` and trimming to a 16 000-character budget (longest
descriptions first), diagnostics logged; `POST /skills` replaces the roster for
new sessions as today. Delete `BUNDLED_SDK_SKILLS`/`BUNDLED_ALLOW` and the CLI
budget constants in `shared/skills.ts`, keeping `RESERVED_SKILL_IDS` as its own
literal list (today it aliases `BUNDLED_SDK_SKILLS` and feeds id validation).
Acceptance: the 19 shipped skills appear in the prompt's `<available_skills>`
with the symlink path; disabling one in the Knowledge page removes it from the
next session. R: `pi-tools-extensions-skills.md` §5;
`acabox-skills-hooks-context.md` §2.

**P1-13 Host session cleanup.** In `main/agentSession.ts`: delete the
swallowed-turn ladder, the context-overflow ladder and `clearSdkSessionId`;
generalise `isAuthError` and `userFacingError.ts` to provider-neutral patterns
(PI's "No API key found for <provider>", "No models available", "reconnect
ChatGPT", OpenAI `subscription_sharing_*`, 401/403 texts) with copy that names
the provider, and PI's "Run '/login <provider>'" wording mapped to "Reconnect
<provider> in Settings"; `collectKnowledgeSignals` reads `read.path`; Bash
bookkeeping and `commandLogger` read `bash.command`; `transcriptStore`
re-pointed at `<userData>/pi-sessions` (delete on chat delete, orphan sweep at
boot keyed by chat ids). In `main/sessionRegistry.ts`: delete the OAuth pin and
`shared/oauthWindow.ts`; destroy → `/detach`. `buildReadOnlyDenyRules` in
`shared/readOnlyRules.ts` goes (keep `mountNames`, which `WorkspaceController`
uses). In `agent-server`: delete `IDLE_EVICTION_MS > OAUTH_FLOW_WINDOW_MS`.
Acceptance: existing jest suites for stop, orphan turns and transcripts updated
and green. R: `acabox-host-session-contract.md` §4, §5C.

**P1-14 Renderer tool vocabulary.** Teach `tool-card-display.ts`,
`turnSteps.ts`, `tool-fallback.tsx`, `tool-write.tsx` (it parses `file_path`
and a streaming `content`), `chatReference.ts`, `appChatLink.ts` and
`index.tsx` the PI names (`bash`, `read`, `write`, `edit`, `grep`, `find`,
`ls`, `web_fetch`, `todo_write`; P5-04 adds `ask_user`) and argument names
(`path`, `command`, `pattern`, `edits[]`), keeping the Claude names as aliases
so history imported from Acabox later still renders. Acceptance: snapshot tests
on the card display for each PI tool; a live turn's fold reads "Ran 2 commands,
read 1 file". R: `acabox-host-session-contract.md` §3.3–§3.4.

**P1-15 Roster and pins.** `GET /models` on the child returns
`modelRuntime.getAvailable()` grouped by provider with `id`, `name`,
`contextWindow`, `cost`, `reasoning`, thinking levels, `input` modalities and
the provider's auth kind (`api_key`/`oauth`); `models:list` IPC proxies it;
`shared/models.ts` becomes the `PickerModel` shape with `provider/modelId` ids
and per-provider `DEFAULT_MODEL` and `BACKGROUND_MODEL` resolvers;
`formatModelLabel` (in `ModelSelector.tsx`, also used by `useSessionMeta.ts`)
keeps falling back to the raw id; `ModelSelector` groups by provider, shows
price per MTok and context, and offers only the model's thinking levels (adds
Off and Minimal); `chat:send` passes `provider/modelId`; `sessions.model`
stores it (no migration needed, the column is TEXT). Acceptance: the picker
lists only connected providers' models; a pinned chat shows "GPT-6.1 Sol ·
High". R: `acabox-background-model-calls.md` §3;
`acabox-identity-and-ui-surface.md` B7; `pi-auth-models.md` §5.

**P1-16 Provider keys in Settings (v1).** Replace `ApiKeySettings` with a "AI
providers" section (first on the page) holding one row per provider with masked
key, Save/Test/Remove, and the verdict pattern from `shared/apiKeyCheck.ts`
generalised per provider (probe endpoints: OpenAI `/v1/models`, Anthropic
`/v1/models?limit=1`, OpenRouter `/api/v1/key`; all 401 without a key). IPC
`providers:list|setApiKey|test|remove`; main stores through P1-02 and
re-pushes. The Claude Design section (`ClaudeDesignSettings.tsx`) stays below
it, untouched (question 5; P5-07). Acceptance: saving a wrong Anthropic key shows
"rejected"; saving the dev key shows "accepted" and the picker gains Anthropic
models within a second. R: `acabox-identity-and-ui-surface.md` B6;
`acabox-background-model-calls.md` §4.

**P1-17 Tests and smoke.** ESM carve-outs: the translator, prompt builder,
guards, relay schema module and bash wrapper live in modules that import PI
types only, so jest covers them; `--smoke-test-pi` boots the agent server,
creates an offline session with an in-memory credential store, asserts the tool
list, the prompt and an empty extension-error list
(`loader.getExtensions().errors`), and exits 0; a CDP checklist (section 10)
for the live acceptance. Acceptance: `npm test` green; both smoke flags exit 0.

**P1-18 PDF-aware read.** `agent-server/piReadTool.ts` wraps PI's `read` as D7
describes, on a new `shared/documentText.ts` (the `pdf-parse`/`mammoth`
extraction lifted out of `main/directoryScanner/documentReaderMcpServer.ts`,
used unchanged by main for attachments in P1-05 and by the scanner in P3-04). A
PDF with no text layer returns an explicit note instead of garbage. Acceptance:
a turn asked what a 40-page PDF in a shared folder says answers from page text,
the tool result shows `--- Page 3 of 40 ---` markers and the second call
continues from the offset; a PNG still arrives as an image. R:
`co-scientist/rootfs-prompts-and-desktop.md` headline 8 and its "PDF-aware read
wrapper" entry.

### Increment 2: sign-in and the providers UI

**P2-01 Provider login protocol.** Child routes `POST /providers/:id/login {
method: 'oauth'|'api_key' }`, `POST /providers/:id/login/answer { promptId,
value }`, `POST /providers/:id/login/cancel`, `POST /providers/:id/logout`. The
child runs `modelRuntime.login(id, method, interaction, { agentName: 'Acabox
PI', getDeviceId })` where `interaction.notify` and `interaction.prompt` emit
`auth-event` and `auth-prompt { promptId, prompt }` on `/host-events` and
resolve from `/login/answer` (a `manual_code` prompt stays pending until the
loopback callback wins or the user pastes). Main opens `auth_url` through
`validateExternalUrl` (`src/utils/urlValidation.ts`, https only) plus a new
host allowlist for login pages (`auth.openai.com`, `openrouter.ai`) and
`shell.openExternal`; a 10-minute host-side timeout aborts the signal. Logout
for OpenAI also POSTs the revocation endpoint
(`https://auth.openai.com/api/accounts/oauth/revoke`) with the refresh token,
which PI does not do. Port-1455 `EADDRINUSE` maps to plain-language copy.
Acceptance: a real ChatGPT sign-in on the dev channel ends with
`getProviderAuthStatus('openai') = {configured, source:'stored'}` and a
`credential-updated` event persisted by main. R: `pi-auth-models.md` §1.1–1.5;
`signin-policy-research.md` §1.2, obligations.

**P2-02 Providers section UI.** Rows with states (not connected, connected with
`CHATGPT PLAN`/`API KEY`/`FROM ENVIRONMENT` chips, checking, expired,
rejected), the ChatGPT flow modelled on the `ClaudeDesignSettings.tsx` that
P1-16 removed (git history: idle/starting/ waiting/failed, manual-paste box,
"Open the page again", Cancel), API-key forms per provider, the OpenAI row
holding both a ChatGPT sign-in and an API key (the key is registered under the
second provider id `openai-api`, D6), a push-fed `providerStore.ts`. SIWC
obligations: a "Continue with ChatGPT" button, a one-time "You're using your
ChatGPT plan" notice, a "Using ChatGPT plan · Manage usage" chip by the
composer when the chat runs on it, and "Manage usage" as the primary action on
a limit error. A Home first-run card, a composer "Connect an AI provider" state
and a chrome provider chip replace the missing no-key nudge. Acceptance: render
tests for every state; live sign-in and sign-out. R:
`acabox-identity-and-ui-surface.md` B6–B8; `signin-policy-research.md` §1.6.

**P2-03 ChatGPT model list.** After a ChatGPT sign-in the child calls `GET
https://api.openai.com/v1/models` with the access token and keeps the slugs
with `visibility === 'list'`, intersected with PI's `openai` catalog; refresh
on sign-in and on account switch. Acceptance: the picker's OpenAI group under a
plan shows only the served models. R: `signin-policy-research.md` §1.4.

**P2-04 OpenRouter.** PKCE sign-in through P2-01 (PI's flow, any loopback
port); key verification against `/api/v1/key`; attribution headers
(`HTTP-Referer`, `X-OpenRouter-Title`) set to Acabox PI's own through a
`before_provider_headers` extension handler for chats and `transformHeaders` on
direct runtime calls (with `PI_TELEMETRY=0` PI sends none of its own); catalog
personalisation `refresh({ allowNetwork: true, providers: ['openrouter'] })` on
key save, with the network opt-in confined to that call. Acceptance: a saved
key lists only the models it may use; a bad key reads "rejected". R:
`pi-auth-models.md` §3; `signin-policy-research.md` §3.

**P2-05 Subscription rules and the consent toggle.** Hide dollar figures in
the header and fold line when the chat's provider is `isUsingSubscription`.
One Settings toggle, "Use my ChatGPT plan for background work and tools"
(default off; question 3), covers everything that is not a chat turn: title
generation, manifest metadata, the scanner's classifiers and tagging agent,
mini-app proxy calls, and scheduled runs. Its copy states what the SIWC Terms
say (plan use is for the connected application, and background use needs the
user's express consent) and that OpenAI may suspend the app's access. With the
toggle off, those calls use an API-key provider, and a profile with only a
ChatGPT plan gets no background calls: a chat's title falls back to its first
message, the scanner stays idle with a one-line notice, a mini-app model call
is refused with a message naming the toggle, and the schedule editor refuses
to save. With it on, D10's resolver picks `gpt-6-luna` with reasoning off and
the mini-app proxy may route to the plan's models. The toggle is stored in
`cobuilding-settings.json` and pushed to the child like a credential.
Acceptance: tests on the cost formatter, the resolver with the toggle in both
states, and the schedule validator; live, a titled chat on a plan-only profile
with the toggle on and an untitled one with it off. R:
`signin-policy-research.md` §1.6; `critique.md`.

### Increment 3: background calls, the mini-app proxy and the scanner

**P3-01 Completion routes.** `POST /complete` and `POST /stream` on the child
taking `{ model: 'provider/id', system?, messages, maxTokens, reasoning: 'off'
}`, served by `modelRuntime.completeSimple`/`streamSimple` and answering with
pi-ai's `AssistantMessage` (streaming over SSE for `/stream`); the Anthropic
background model is passed as a cloned catalog entry with thinking `off`
enabled (D10). Main's title generation, manifest metadata and the three
classifiers call them with the per-provider background model and their existing
caps (40/400/10/100/400 tokens); each call logs `usage.cost.total`. Acceptance:
a new chat is titled on each of the three API-key providers. R:
`acabox-background-model-calls.md` §1, §7a; `pi-auth-models.md` §6.

**P3-02 Mini-app proxy.** `anthropic:complete`/`anthropic:stream` keep their
IPC and postMessage names and the `AnthropicParams`/`AnthropicMessage` shapes;
main validates as today, extracts PDF documents to text, maps the model (bare
Claude ids resolve to `anthropic/<id>` when an Anthropic key exists, else the
background model), calls P3-01, and projects the reply back to `{ id, content:
[{type:'text', text}], model, usage: {input_tokens, output_tokens} }`. The
`westernBlotAnnotator` template's hard-coded model and `content[0]` read are
fixed. Acceptance: the bridge test (`bridge.test.ts`) plus a live call from a
mini-app on an OpenRouter-only profile. R: `acabox-background-model-calls.md`
§2, §7c.

**P3-03 Scanner on PI.** `POST /scan` on the child runs a scanner session
(`read`, `grep`, `find`, `read_document`; guard rules: no hidden paths, no path
outside the scan roots; `submit_result` with `constrainedSampling:
{type:'json_schema', strict:'prefer'}` and the file-tagging and
research-profile schemas; host-side caps: 15 and 10 turns, $1 and $2); main's
`directoryScanner/shared.ts` consumes the `structured_output` the child
returns. The research-profile model becomes a "scanner model" setting
defaulting to the chat default. Acceptance: Rescan on the dev workspace tags
the fixtures and writes `about_you.md`. R: `acabox-background-model-calls.md`
§1b, §7b; `pi-auth-models.md` §6 (structured output).

**P3-04 read_document tool.** Expose `shared/documentText.ts` (P1-18) to the
scanner session as a custom `read_document` tool and delete
`documentReaderMcpServer.ts`. Acceptance: unit tests on a docx and a pdf
fixture.

**P3-05 Deletions.** Remove `@anthropic-ai/claude-agent-sdk` from
`package.json`, `forge.config.js` (`nativeModuleRoots`, `asar.unpack`) and the
main webpack externals; delete `ensureApiKeyApproved`, `claudeConfigDir.ts`,
`claudeConfigApproval.ts`, whatever in main still imports the SDK after P3-03
and P3-04 (`notificationMcpServer.ts`, the document reader), and
`calendarAgentSession.ts` with `renderer/components/calendar/*`,
`migrateMissingManifests` and `auth:setEndpoint`. `claudeDesignLogin.ts` and
`shared/claudeDesign.ts` stay for P5-07, so the Claude Code CLI binary the
sign-in spawns must still be available at that point: P3-05 keeps a
`claude` binary reachable (P5-07 decides how) or P5-07 lands first.
Acceptance: tsc clean, no `claude-agent-sdk` import anywhere, dead-import grep
empty.

### Increment 4: connectors and hosted MCP

**P4-01 Connectors on PI.** `toPiMcpConfig` in `shared/connectors.ts` (`http`
only; `sse` refused with PI's own "use the streamable HTTP URL"; existing
`stdio` rows refused with a pointer to hosted servers, where stdio already
lives; header values escaped); the child's `createMcpExtension({ loadConfig: ()
=> hostConnectors, openUrl: relay to main, updateConfig: noop, startupWaitMs:
10000 })` plus `createToolSearchExtension()` with `'+tool_search'` added to the
session's `tools` modifiers; `POST /connectors` updates the list and reconnects
live through a held `pi` handle (`registerMcpServer`/`unregisterMcpServer`), or
disposes idle sessions so the next turn reconnects; status from a
`createTransport` wrapper that records connect/close/401 into
`recordConnectorStatus`; `GET /connectors/status` served from it;
`dynamicMcp.ts` and `filterMcpServers` are deleted here. Acceptance: a Hex
connector's tools appear through `tool_search` in a real turn; `.pi/mcp.json`
in the workspace is ignored. R: `pi-mcp-sessions-rpc.md` §1;
`acabox-mcp-relays-host-tools.md` F, I, J.

**P4-02 Connector sign-in.** A "Sign in" button on the connector row runs PI's
MCP OAuth in the child (`@earendil-works/pi-mcp/oauth`: `authorizeMcp`,
`OAuthCallbackServer`, with `oauth.clientName: 'Acabox PI'`), relaying the URL
and the paste prompt through `/host-events` like P2-01; tokens stay in PI's
`mcp-auth.json` under the agent dir in v1 (0600; already on D7's deny list),
with the encrypted store as a follow-up. Delete the "ask in chat: authenticate"
copy (the pin and `oauthWindow.ts` went in P1-13). Acceptance: Hex signs in and
a data tool returns rows. R: `pi-mcp-sessions-rpc.md` §1.7; `critique.md` (MCP
OAuth primitives).

**P4-03 Hosted servers as generated tools.** From `readyServersForAgent()`
build `ToolDefinition`s named `mcp__<id>__<tool>` (64-char sanitising with a
hash suffix on collision), JSON schema passed through, `execute` =
`isToolEnabled` gate + `mcpHost.invoke` + text-only result mapping; on
`onInventoryChanged` the child re-registers (withdrawn tools re-registered
`hidden`) through the held `pi` handle; `POST /hosted` keeps its body.
Acceptance: the `--smoke-test-mcp` echo fixture round-trips through PI. R:
`acabox-mcp-relays-host-tools.md` E, J.

**P4-04 Servers page copy.** Status vocabulary unchanged; "Authored by Claude"
and other harness copy generalised. (Haiku-sized.)

### Increment 5: memory, compaction UX, prose, polish

**P5-01 Memory extension.** Inline extension: on `before_agent_start` for the
first run of a session, inject the memory section (protocol text ported from
the CLI's "auto memory" section and the co-scientist `piMemory.ts`, the
`MEMORY.md` index capped at 8 000 chars, snapshotted per chat) and tell the
model to write `originSessionId: <chat id>`. Knowledge page join unchanged
(`sdk_session_id` = chat id). Acceptance: a turn told "remember that I prefer
tidy CSVs" writes `user_*.md` and a `MEMORY.md` line; the Knowledge page shows
"from <chat>". R: `acabox-skills-hooks-context.md` §6;
`co-scientist/agent-cloud-pi-runner.md` §4 (memory section).

**P5-02 Compaction UX.** `compact_boundary` system messages become a
host-authored assistant row "I compacted the earlier part of this chat to keep
going." and a `status` event while compacting; `userFacingError` learns PI's
overflow failure text. Acceptance: a chat driven past the threshold with Haiku
shows the row and continues.

**P5-03 Prose rewrite.** `src/cobuilding/CLAUDE.md` (tool names, no background
commands section, `todo_write`), `identityPreamble.ts`,
`skills/acabox/SKILL.md` (identity, capabilities, provider wording, sign-in
flow), `database-lookup`/`gnomad-database`/`opentargets-database`
(`web_fetch`), `flow-cytometry` (drop the Glob quirk line),
`manage-mini-application` (Monitor/ScheduleWakeup/NotebookEdit/PreToolUse
lines, bridge docs' model default), `manage-mcp-server` (reserved ids, hosted
env), `pptx` (subagents and Edit-tool lines), `docx` and
`academic-writing-agent` (remove the Word/Zotero/CiteRight flows per question
5), `KNOWLEDGE_ROUTING_GUIDANCE`. Acceptance: grep for `WebFetch`, `TodoWrite`,
`Glob`, `PreToolUse`, `run_in_background`, `mcp__ms-word` in
`src/cobuilding/skills`, `src/cobuilding/CLAUDE.md` and the prompt builders is
empty (the renderer keeps the Claude names as display aliases, P1-14).

**P5-04 ask_user.** Host `ExtensionUIContext` in the child (a large interface;
members with no host surface, such as widgets and status, are no-ops) relays
`select`/`confirm`/`input` as `ui-request` events on the session stream,
answered by `POST /sessions/:id/ui-response`; the renderer shows a question
card in the thread; a `model-only`, sequential `ask_user(question, options)`
tool. Acceptance: a turn told to ask before deleting shows the card and
continues with the answer. R: `pi-tools-extensions-skills.md` §10.

**P5-05 Scheduled tasks.** The runner passes an explicit model/effort from a
task setting, background sessions complete at `turn-complete`, consent per
P2-05. Acceptance: a daily task runs once on Haiku with the right pin.

**P5-07 Claude Design on PI (kept by owner decision, question 5).** Today the
sign-in spawns the Claude Code CLI's hidden `claude design-login --json` and
the chat reaches claude.ai/design through the SDK's `DesignSync` tool, neither
of which PI has. Spike first (half a day, read-only): read `DesignSync`'s HTTP
protocol and credential lookup out of the 2.1.296 binary the same way
`design-login` was read, and measure whether a `design_sync` custom tool in
the child can call it with the credential `design-login` stores. Then one of
two shapes, decided from the spike: (a) re-implement, a `design_sync` custom
tool in the child plus the existing `claudeDesignLogin.ts` flow, with the CLI
binary fetched into userData only for the login step; (b) keep the CLI as a
design-only sidecar (the 212 MB binary stays in the bundle for this feature
alone). Either way the feature is Anthropic-account-bound and works for any
chat provider. Acceptance: Settings → Claude Design → Sign in completes in the
browser, and a new chat on a non-Anthropic model lists the user's design
projects. R: Acabox `CLAUDE.md` 2026-09-23 entry (the protocol as read from
the binary).

**P5-06 Secrets hygiene and Debug.** Scrub provider variables from
`buildSubprocessEnv()`; the Debug tab shows provider auth sources, the PI agent
dir and the session dir; `--smoke-test-pi` in the Debug tab's checks.
(Haiku-sized.)

### Increment 6: packaging and release

**P6-01 Packaged build.** `npm run package` with `build/pi`, `rg`/`fd`, no
Claude SDK unpack; launch with `--use-mock-keychain` to confirm the agent
server boots PI from `Resources/pi`; `codesign --verify --strict` on the bundle
including the `.wasm` payload. Acceptance: a packaged turn on an API key.

**P6-02 Release.** First `npm run release` to `acabox-pi-releases`;
`THIRD_PARTY_NOTICES.md` (PI MIT, ripgrep, fd) shipped and linked from Settings
→ Diagnostics with "Powered by PI (pi.dev)". Acceptance: `latest-mac.yml`
anonymously downloadable, self-update from the previous build.

**P6-03 Docs.** New `CLAUDE.md` with the port's status entry, this plan marked
"built", the research archive index.

## 7. Dropped or deferred

Dropped (D15). Deferred, with the condition that brings each back: `web_search`
(an Anthropic key, or an OpenAI plan where Responses `web_search` works under
SIWC); subagents (`Agent` tool over a nested session, co-scientist code exists)
when a workflow needs them; a cheaper compaction summariser when a cost
complaint arrives; an encrypted MCP token store when PI exports its credential
store; importing a user's Acabox chats into Acabox PI (the co-scientist's
`claudeTranscript.ts` converter maps the SDK JSONL to PI messages) if anyone
asks for it; a refusal fallback to a second model (the co-scientist retries
bio-risk refusals on another model; on PI 1.2.0 the refused attempt must be
omitted through the session manager's context edit, not by slicing
`agent.state.messages`) if refusals are reported; the legacy Codex route
(question 2).

Worth taking from the co-scientist later, independent of the harness: the
mini-app prelude (SKILL.md and the current `App.tsx` injected as a synthetic
exchange; they measured 80% of build turns re-reading the skill, R:
`co-scientist/rootfs-prompts-and-desktop.md` §5), the build verifier
(`VERIFIER.md`: mount check, run test, 3-block cap, infra pass-through), the
mini-app skill rules on silent execution, wiring every control and phone-width
layouts, an environment manifest generated at boot from the real venv and npm
prefix, and the `datarevision: revision` fix in `react-plotly` (a real bug in
Acabox's skill today, nothing to do with PI).

## 8. Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| SIWC preview is unstable today: HTTP 520 on every SIWC token since 2026-10-14, refresh refused with `invalid_grant` (hourly re-login), Business workspaces denied | P2 | API keys and OpenRouter ship first (I1) and remain the guaranteed path; the UI treats "expired" as a one-click re-sign-in; re-verify the two devkit issues before announcing SIWC |
| Eligibility: a closed or commercial app may not qualify for self-serve plan usage, and OpenAI can suspend an application's SIWC access | P2 | Question 1 (licence / interest form) is answered before I2 starts |
| PI declares Node ≥ 22.19; Electron 37 ships 22.17 | every PI process | exact pin, boot probe (P0-05); a newer Electron is the fallback (check its bundled Node before relying on it) |
| PI's catalog cannot turn thinking off on Haiku 5.5, which the background caps assume | D10, P3-01 | cloned catalog entry with the override, verified by a real call; if Anthropic ever refuses it, Haiku 4.5 is the fallback at ten times the price |
| A PI upgrade changes behaviour (the co-scientist's only recorded upgrade broke every turn) | all | exact pin; the spike scripts are the upgrade test |
| Tool schemas that some providers reject (`$ref`, free-form records, empty objects) once OpenRouter models are in play | P1-09, P4-03 | strict-schema lint on the relay module; a provider matrix live check per release |
| Port 1455 contention (Codex CLI, pi CLI, a second Acabox PI) | P2-01 | plain-language copy and retry; manual paste cannot rescue a bind failure |
| Cost figures under a subscription are list prices PI computes anyway | D10 | hidden under subscription; "included in your plan" wording |
| Two apps on one Mac: dev builds share Electron's bundle id and TCC grants | dev only | rename-dev-electron keeps names distinct; document in CLAUDE.md |
| The agent-writable workspace could host `.pi/` resources | D7 | `projectTrusted: false`, `noExtensions`, inline factories only, guard deny-list on PI files |
| PI's first prompt waits up to 10 s for `direct` MCP servers | P4-01 | `deferred` exposure by default; `alwaysLoad` is the user's explicit choice |
| Image resize runs in a worker whose URL resolution under `Resources/pi` was not exercised with a real image | P1-05 | live check with a PNG attachment in I1 (falls back in-process if the worker fails) |
| PI's `read` returns decoded binary for a PDF, and research folders are full of them | P1-18 | the wrapper ships in I1; a scan with no text layer gets an explicit note; page images are deferred |
| The cloud VM is Linux, so a macOS regression stays invisible until the increment's acceptance | every cloud ticket | mac-only suites tagged, never deleted; each PR names the mac checks it needs; one mac acceptance pass per increment, and an extra one for any ticket touching main-process platform code |
| The consent toggle lets a ChatGPT plan pay for mini-app and scheduled calls, which the SIWC Terms describe as outside "the connected application" | P2-05 | default off; the copy quotes the Terms; API-key providers remain the path that needs no consent; if OpenAI objects, the toggle is removed and the API-key path is unchanged |
| The setup snapshot caches only if `npm ci` plus the Electron download finishes in about five minutes | P0-09 | measured in the first session; if over, every session repays the install (minutes, not a blocker) and `CLAUDE.md` says so |

## 9. Owner decisions (answered 2026-10-15)

| # | Decision | Answer | Where it lands |
|---|---|---|---|
| 1 | Visibility and licence | Public, MIT now; the `co-scientist/` reports are not committed | P0-01, section 6.0 |
| 2 | ChatGPT routes | Official Sign in with ChatGPT plus API keys only | D6, I2 |
| 3 | Where a ChatGPT plan may be spent | Everything, behind a consent toggle that defaults off (against the recommendation; risk row in section 8) | P2-05, D10 |
| 4 | Anthropic | API keys only (first answer chose PI's Anthropic OAuth; reverted when the terms consequence was restated) | D6, F12 |
| 5 | Drop list | Drop all of it except the Claude Design sign-in, which is kept | D15, P1-16, P3-05, P5-07 |
| 6 | Fork mechanics | Full history | P0-01 |
| 7 | v1 scope and order | I0–I3, then I4, then I5–I6 | section 6 |
| 8 | Defaults | Provider flagship, thinking high; cheapest reasoning-off model for background | D10 |
| 9 | Identity | "Keep as Acabox": the agent says "I'm Acabox"; read as the brand staying Acabox with "PI" the edition name of D14 (interpretation, flagged to the owner) | D8 |
| 10 | Prompts | Adopt the co-scientist's `piGeneralPrompt.md` wholesale (its text becomes public with the repo) | D8 |

The options as they were put, recommended first:

1. **Repository visibility and licence.** Facts, checked 2026-10-15:
   `acabox-pi` is public, empty and unlicensed; `acabox` is also public and
   unlicensed although its CLAUDE.md calls it private. OpenAI's self-serve
   plan usage is for "open-source and locally hosted apps"; a commercial or
   closed app goes through an interest form and may be refused. Recommended:
   make `acabox-pi` **private for development** (`gh repo edit
   iliasacademia/acabox-pi --visibility private`, one command, reversible),
   and decide public-with-MIT (matching PI, and the shape the self-serve path
   is written for) before the first release, once the archive grep in P0-01
   passes and `docs/design/review-2026-09-30/` has been checked. Private now
   costs nothing: cloud sessions reach a private repo through the connected
   GitHub credential. Alternative: public from day one, which requires the
   scrub to be complete before P0-01's push and every later commit to keep
   that discipline.
2. **ChatGPT routes.** Recommended: only the official Sign in with ChatGPT plus
   API keys. Alternative: also the legacy Codex-CLI route (works for ChatGPT
   Business workspaces that the new route denies; undocumented, first-party
   client id, could be cut off without notice) behind an "unsupported" toggle.
3. **Where a ChatGPT plan may be spent.** Recommended: chat turns only;
   mini-app calls, title generation and scheduled runs use API-key providers
   (the SIWC Terms say "connected application only" and require express consent
   for background use). Alternative: allow all of it with a consent toggle.
4. **Anthropic: API keys only.** Confirm. The alternative (PI's Anthropic
   OAuth) impersonates Claude Code and violates Anthropic's terms.
5. **Drop list.** Confirm the removal of Claude Design, the calendar assistant,
   the Word-overlay briefings, the Word/Zotero/CiteRight flows in the `docx`
   and `academic-writing-agent` skills, plan mode, subagents and `NotebookEdit`
   from v1.
6. **Fork mechanics.** Recommended: clone with full history so fixes can be
   cherry-picked both ways; the push is P0-01, run from the laptop once
   question 1 is settled and before the first cloud session (a session sees
   only what is in the repo). Alternative: a squashed first commit.
7. **v1 scope.** Recommended order: I0–I3 first (a usable multi-provider chat
   with mini-apps), then I4 (connectors and hosted servers), then I5–I6. If
   connectors are needed on day one, I4 moves ahead of I3.
8. **Defaults.** Recommended: default chat model = the connected provider's
   flagship (Anthropic `claude-opus-5-5`, OpenAI `gpt-6.1-sol`, OpenRouter
   `anthropic/claude-sonnet-5.5` until told otherwise), default thinking level
   `high` where the model supports it, background model = the cheapest model of
   the same provider that can run with reasoning off (`claude-haiku-5-5`,
   `gpt-6-luna`, an OpenRouter equivalent). These are settings, not code.
9. **Identity wording.** Recommended: "I'm Acabox PI, running on <provider>'s
   <model>", with "Powered by PI (pi.dev)" in Settings → Diagnostics and the
   About box.
10. **Co-scientist prompts.** Recommended: keep Acabox's own `SOUL.md`,
    workspace rules and skills text and adopt only the co-scientist's
    structural rules (static prompt, sent-time stamp, identity line, memory
    snapshot). Alternative: adopt `piGeneralPrompt.md` ("be concise, assume
    expertise, don't do too much") wholesale.

## 10. Verification

In the cloud, at the end of every ticket:

- `npx tsc --noEmit` clean and `npm run test:linux` green (Electron-run jest
  with the mac-only suites skipped and listed, P0-09); ESM-only PI code is
  kept behind the same carve-out discipline Acabox used for the Claude SDK.
- `node scripts/verify-pi-runtime.mjs` (P0-05) passes; from I1 on, the
  headless agent-server tests make real provider calls with the environment's
  keys.
- The PR names the mac checks it needs.

On a Mac (the mini or the laptop), per increment, from a teleported checkout:

- `npm test` fully green, mac-only suites included, and `npm start -- --
  --smoke-test` (boot) and `--smoke-test-pi` (offline PI session in the real
  agent server) exit 0.
- Live over CDP on `npm start`, per increment: I1 a real turn on each
  configured provider with a file read, a bash command, a relay tool, Stop,
  resume after restart, an image and a PDF attachment; I2 a real ChatGPT
  sign-in, sign-out and an OpenRouter PKCE sign-in; I3 a titled chat and a
  mini-app model call on an OpenRouter-only profile, a Rescan; I4 a Hex sign-in
  and a data call, the echo hosted server; I5 a memory save, a compaction; I6 a
  packaged turn and a self-update.
- The two spike scripts under `pi-port-research-2026-10-15/spike/` are the
  regression test for any PI version bump.

## 11. Spike output (abridged)

```
import ms 334   (the unbundled dist/index.js; the relocated bundle imports in 100-130 ms, F1)
using anthropic/claude-haiku-5-5 cost {"input":0.1,"output":0.5,"cacheRead":0.01,"cacheWrite":0.125,...} ctx 1000000 reasoning true
custom session id accepted: chat-test-1
tools: read,bash,edit,write,mcp__workspace__get_research_profile | fallback: none | ext errors: []
prompt mentions mcp tool: true
turn1 ms 13737
  assistant_end stop=toolUse cost=0.000528025 in=4 out=309
  tool_start bash {"command":"echo SPIKE_OK","timeout":null}
  tool_start mcp__workspace__get_research_profile {}
  tool_start bash {"command":"rm -rf /tmp/does-not-exist","timeout":null}
  tool_end bash isError=true "Blocked by the Acabox guard: destructive command."
  tool_start bash {"command":"echo THROW_TEST","timeout":null}
  tool_end bash isError=true "guard crashed on purpose"
  tool_end mcp__workspace__get_research_profile isError=false "PROFILE: nucleotide sequence analysis lab"
  tool_end bash isError=false "SPIKE_OK\n"
  assistant_end stop=stop cost=0.00014455 in=2 out=109
  agent_settled aborted=false
counts: message_update 56 (thinking_delta 8, toolcall_delta 17, text_delta 19), tool_execution_start 4, tool_execution_end 4
stats: ... "cost":0.000672575, "contextUsage":{"tokens":3576,"contextWindow":1000000}
turn2 (abort at 2502 ms): tool_end bash isError=true "Command aborted" → assistant_end stop=error err=This operation was aborted → agent_settled aborted=true
resumed messages: 12 id chat-test-1 stats cost 0.000766375
bash definition description: SHADOWED BASH
dangling.mjs: loaded roles: system | user | assistant:toolUse → prompt answered "RESUMED" in 2051 ms
```

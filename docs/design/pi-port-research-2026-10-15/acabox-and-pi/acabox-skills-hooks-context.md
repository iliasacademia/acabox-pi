# Acabox agent context pack: inventory and Claude-Code-specific surface (reader report for the Acabox PI planner)

## 0. Conventions and scope

- **[READ]** means I read it at the cited `file:line`. **[MEASURED]** means I ran something: the shipped hook scripts on sample payloads, the repo's own `js-yaml` over all 19 `SKILL.md` files, `strings`-style extraction from the bundled CLI binary, or `ls` (names only, no secret contents) of the dev profile. **[INFERRED]** means not directly observed.
- Acabox repo root is `/Users/iliasbeshimov/Documents/Dev Folders/Acabox`; paths below are relative to it. Code beats docs everywhere; disagreements are listed in section 10.
- PI references: `PI-docs/` is `/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/pi-pkg/node_modules/@earendil-works/pi-coding-agent/docs/`; `PI-src/` is `.../scratchpad/pi-src/pi/packages/coding-agent/src/`; `PI-ex/` is `.../pi-pkg/.../pi-coding-agent/examples/extensions/`. PI version 1.2.0.
- Dev profile on disk: `~/Library/Application Support/Acabox/development` (code says `acabox`; the macOS volume is case-insensitive and both spellings exist). Workspace root there is `workspace-data/`.
- Scratch scripts live in `.../scratchpad/work-contextpack/` (`measure-roster.js`, `dump-desc.js`). Nothing in the Acabox repo, the PI clone, or `~` was modified.

### 0.1 Ten-line summary

1. The "context pack" is seven layers: (a) the `claude_code` preset system prompt plus five appended strings; (b) a workspace instructions file at `.claude/CLAUDE.md`; (c) 19 skills delivered through Pristine / Store / Render; (d) two `PreToolUse` shell hooks wired by `.claude/settings.json`; (e) CLI auto-memory in `.academia/agent-memory/`; (f) SDK inline `settings`, `allowedTools` and `permissions.deny`; (g) the CLI state dir `claude-config/` (`.claude.json`, transcripts).
2. Most of the machinery (skill store, hashing, three-way reconcile, import, findings ledger, provisioning reconciler, hosted-MCP authoring flow) is plain Node/FS and harness-neutral. The Claude coupling sits in a thin set of places: path names (`.claude/...`), tool names in prose, the hook payload shape and exit codes, the `Options.skills` / roster-budget semantics, the memory feature, and the system-prompt preset.
3. PI reads `AGENTS.md`/`CLAUDE.md` only directly in cwd, its ancestors and the agent dir, never `.claude/CLAUDE.md` [READ `PI-src/core/resource-loader.ts:184-205`]. The provisioned workspace file would not be seen by PI as shipped.
4. PI loads context files from every ancestor of cwd up to `/` and skills from `~/.agents/skills` [READ `resource-loader.ts:232-270`; `PI-docs/skills.md:61`]. Without `noContextFiles` / `noSkills`, a user's own `~/AGENTS.md`, `~/CLAUDE.md` or `~/.agents/skills` would leak into every Acabox PI chat.
5. The secret-read hook reads `tool_input.file_path`; PI's `read`/`write`/`edit` use `path` [READ `PI-src/core/tools/read.ts:15`, `write.ts:12`, `edit.ts:34`]. I ran the real script with a `path` payload: exit 0, so a naive port is silently inert [MEASURED].
6. PI has no auto-memory, no web fetch/search, no TodoWrite, no sub-agents, no plan mode, no NotebookEdit, no Skill tool [READ `PI-docs/settings.md:42-46`, `README.md:19`, tools dir listing]. Acabox's production profile relies on memory (28 agent-written files, 5.7 KB `MEMORY.md` per the 2026-09-30 review) and several skills instruct tools PI lacks.
7. Several shipped skills are already stale in the fork: `academic-writing-agent` and `docx` instruct `mcp__ms-word__*`, `mcp__zotero__*`, `mcp__citeright__*` (none exist in app code), and `docx` references two scripts that are not in its directory.
8. Skill identity differs: the CLI keys on the directory name; PI uses frontmatter `name` falling back to the directory name [READ `PI-src/core/skills.ts:321`]. All 19 shipped skills have `name == directory`, so only imports with mismatched names are affected.
9. The skill roster is budgeted by the CLI (8,000 chars default, Acabox raised to 40,000); PI has no budget and injects every visible skill as XML with an absolute path. 19 skills cost about 10.3 K chars in the CLI format and about 14.7 K chars in PI's XML [MEASURED].
10. Hooks live in the agent-writable workspace today (hence the `restore` policy and backups). A PI port that supplies the guard as an in-process extension removes that attack surface [INFERRED recommendation, grounded in `PI-docs/extensions.md:170-176`].

---

## 1. Everything Acabox writes for the agent (workspace + userData + temp), with writer code

### 1.1 Workspace = agent cwd = `<userData>/workspace-data/`

Definition: `src/cobuilding/shared/paths.ts:9` `WORKSPACE_DATA_DIR = 'workspace-data'`; `main/controllers/WorkspaceController.ts:85-87` `getAgentControlledDir()`. (Root `CLAUDE.md` still says `cobuilding-workspace`; that is stale, see section 10.)

| Path under workspace | Purpose | Written by | Change policy | Claude-coupled? |
|---|---|---|---|---|
| `.claude/CLAUDE.md` | Workspace instructions (source `src/cobuilding/CLAUDE.md`, 7,478 B, 105 lines) | `main/skills.ts:214` through `reconcileProvisionedFile` (`:139-208`) | `keep-local`: agent/user edits survive; shipped changes fast-forward only an untouched file | Yes: dir + filename, loaded by CLI via `settingSources:['project']` |
| `.claude/settings.json` | Wires the two hooks (28 lines, section 7.1) | `skills.ts:216` | `restore`: divergent copy moved to `<userData>/workspace-file-backups/<stamp>/` then shipped bytes put back | Yes |
| `.claude/hooks/block-host-installs.sh`, `.claude/hooks/block-secret-reads.sh` | PreToolUse guards (4,776 B and 4,643 B) | `skills.ts:219-234`, `mode: 0o755`, chmod re-applied every provision (`:170-172`) | `restore` | Yes (payload shape, exit codes) |
| `.claude/skills/<id>` (19 absolute symlinks in dev) | Skill "render" pointing into the store | `main/skillRender.ts:73-190` (`fs.symlinkSync(target, link, 'dir')` at `:135`) | Host-owned. A REAL directory found here is adopted into the store, never deleted (`skillStore.ts:604-678`) | Path and loader semantics |
| `.applications/_bridge`, `_vendor`, `_templates`, `_reusable`, `install` | Mini-app shared assets, copied from the STORE copy of `manage-mini-application/assets` | `skills.ts:255-295` (`syncMiniAppAssets`), `install` chmod 0o755 | Force-overwritten every provision | Neutral |
| `.applications/<app>/` (`src/`, `dist/`, `notebook.ipynb`, `manifest.json`, `requirements.txt`, `package.json`, `setup/*.sh`, `input`/`output` symlinks) | Mini-apps | Agent, via `skills/manage-mini-application/scripts/manage_mini_app.mjs`; env `MINI_APP_WORKSPACE_DIR` or cwd (`:18`) | Agent/user | Neutral |
| `tool-data/<app>/{input,output}` | Durable tool data; code dir symlinks into it | scaffold script, `main/toolDataMigration.ts` | Neutral | Neutral |
| `.academia/agent-server.js` | Copy of `dist/agent-server.js`; the spawn target (`spawn(process.execPath, ['--max-old-space-size=1536', bundlePath])`) | `containerService.ts:456-467`, spawn `:510-540` | Host, overwritten each start | The bundle wraps the Claude SDK; replaced wholesale in PI |
| `.academia/SOUL.md` | The user's "Instructions for Acabox" (custom system-prompt text) | Settings UI -> `academiaFile:write` (`main/index.ts:3512-3531`, relative path `SOUL.md`, constant `shared/paths.ts:45`); read at `main/agentSession.ts:639-649` | User; also agent-writable because it is in cwd [INFERRED from location] | Name only; content is injected into the system prompt |
| `.academia/agent-memory/MEMORY.md` + `<type>_<slug>.md` | CLI auto-memory (index + notes) | The CLI/agent; directory set by `settings.autoMemoryDirectory` (`agent-server/index.ts:661`); constants `shared/paths.ts:25-36` | Agent + user edits (Knowledge page) | Yes: format and loading are CLI behaviour (section 6) |
| `.academia/agent-memory/about_you.md`, `working_on.md` | User profile text | Settings UI (`DirectoryPermissions.tsx:3,60,85` via `MEMORY_PATH_ABOUT_YOU`) and the scanner `main/directoryScanner/agents/researchProfile.ts:195-213` (raw text, no frontmatter) | User/scanner. NOT linked from `MEMORY.md` | Files neutral; "auto-loaded" claim is wrong (section 6) |
| `.academia/references/<name>.md`, `index.json` | PDF-to-markdown reference cache consumed by `get_scanned_files` | `fileTagging.ts:462-476` (`path.dirname(ctx.memoryDir)/references`), `:514-526` (`convertReferenceFile`) | Scanner | Neutral (calls Anthropic client directly) |
| `.academia/skill-state/academic-writing-agent/manuscripts/<doc-hash>/{detected-doctype,field,_state,grant-instructions,conference-style,thesis-context}.md` | Per-manuscript cache | Agent via `Write` per `skills/academic-writing-agent/memory.md:111`; no host code creates it | Agent | Skill-defined; none present in dev profile [MEASURED] |
| `.academia/temp_files/` | File-monitor snapshots | `fileMonitor/fileMonitorService.ts:72` | Host | Not agent context |
| `.mcp-servers/<id>/{index.mjs,manifest.json}` | Agent-authored hosted MCP servers, adopted disabled | Agent; adoption in `main/mcpHost/authored.ts` (header `:25-60`) | User must enable; promote-on-enable copies it to `<userData>/mcp-servers/<id>/` | Neutral on disk |
| `<MountName>` symlinks | User research folders as `MyResearch/`, `LabData/` | `containerService.ts:226-294` (`syncWorkspaceSymlinks`; reaps stale root links, skips dot-names at `:277`) | Host | Neutral |
| `.mcp.json` | NOT written by Acabox; detected and deletable | `main/connectorsStore.ts:363-391` (`detectUnmanagedMcpJson`, `removeUnmanagedMcpJson`) | User | Claude loads a project `.mcp.json` [READ `AgentInfrastructureController.ts:507-510`] |
| `google-drive` symlink, `data/` | Legacy leftovers visible in the dev profile | [MEASURED `ls`] | n/a | n/a |

### 1.2 `<userData>` (agent-relevant entries)

| Path | Purpose | Writer |
|---|---|---|
| `skills/<id>/` | THE writable skill store (layer W) | `skillStore.ts:100-102`, `reconcile` `:817-1003` |
| `skills-state.json` | Rebuildable index: origin, enabled, removed, per-file `baseline` sha256, `dismissed`, `updateAvailable`, import provenance | `shared/skills.ts:54`, `skillStore.ts:112-114`, `updateSkillsState` `:331-342` via `main/manifestIO.ts` (atomic + per-path queue) |
| `skills-trash/<id>-<stamp>/` | Pre-revert/delete forks, pruned after 30 days (`SKILLS_TRASH_MAX_AGE_MS`, `skillStore.ts:243-267`) | `skillStore.ts:229-240` |
| `workspace-provisioning.json` | `{version:1, files:{".claude/CLAUDE.md":"sha256:…", ".claude/settings.json":…, ".claude/hooks/*.sh":…}}`, the "what we last wrote" baseline [MEASURED on dev] | `skills.ts:71-81,400-428` |
| `workspace-file-backups/<stamp>/…` | Divergent hook/settings copies before `restore`; never pruned | `skills.ts:120-127` (absent on dev: nothing diverged) |
| `agent.json` (0600) | Agent-server start config, includes raw API key and decrypted connector headers | `containerService.ts:49-51,505-508` |
| `claude-config/` (`CLAUDE_CONFIG_DIR`) | `.claude.json`, `projects/<key>/<sdkSessionId>.jsonl` transcripts, credentials fallback | `main/claudeConfigDir.ts:24-29`; env injected `containerService.ts:530` |
| `scanner-claude-config/` | Separate CLI state for scanner agents | `directoryScanner/shared.ts:190-208` |
| `cobuilding-settings.json` | Connectors, API key (encrypted), model selection | `connectorsStore.ts:32` |
| `knowledge-review.json` | "Needs attention" rows from the omission watch | `knowledge/omissionWatch.ts:165` |
| `mcp-servers/{servers.json,<id>/,authored-known-ids.json}` | Hosted MCP records and promoted copies | `mcpHost/store.ts:59-74`, `authored.ts:239` |
| `python-venv/`, `npm-site/`, `mini-app-jsx-runtime/` | Runtimes the agent's Bash uses | `pythonSetup.ts:34`, `nodeSetup.ts:23`, `miniAppBuilder.ts:159` |
| `tool-jobs.json`, `tool-build-health.json` | Host job/build status | `jobRegistry.ts:79`, `buildHealth.ts:34` |
| `cobuilding.db`, `observations.db`, `scheduling.db` | Chats, activity, schedules | main |

Temp: `os.tmpdir()/acabox-import-*/skill` stages imported skills (`knowledge/skillImportService.ts:160-165`); disposed on modal close.

Shipped read-only inputs (layer P): `forge.config.js:114-129` `extraResource` ships `dist/agent-server.js`, `src/cobuilding/skills`, `src/cobuilding/CLAUDE.md`, `src/cobuilding/settings.json`, `src/cobuilding/hooks`. Dev reads from `src/cobuilding/`, packaged from `Contents/Resources/` (`skillStore.ts:91-94`).

### 1.3 Provisioning algorithm (`main/skills.ts:327-451`, serialised at `:317-325`)

Steps, each in its own try/catch (`:337-345`): (1) `pruneSkillsTrash`; (2) `reconcile({workspaceDir})` (store); (3) `renderSkills`; (4) `provisionedFiles` three-way reconcile for CLAUDE.md, settings.json, hooks; (5) `syncMiniAppAssets`; then a boot assertion that `.applications/_bridge` exists (`:439-447`). `AgentInfrastructureController.start()` awaits it before spawning the agent server (`:399-407`).

Three-way table for a provisioned file (`reconcileProvisionedFile`, `:139-208`): `current===undefined` -> seed; `current===shipped` -> adopt as baseline; `baseline===undefined || current===baseline` -> fast-forward; else divergence -> `keep-local` keeps, `restore` backs up then overwrites. This function is harness-neutral; only `dest` paths and the policy list (`:211-236`) change for PI.

---

## 2. Skill substrate: Pristine / Store / Render and the roster budget

Authoritative sources: `main/skillStore.ts` header `:1-42`, `main/skillRender.ts` header `:1-35`, `main/skillHash.ts`, `shared/skills.ts`, design docs `docs/design/skills-plugins-connectors.md:133-262` (P/S/R decision and disk layout) and `docs/design/skills-knowledge-loop.md:258-307` (roster bound). The Pristine/Store/Render section is in `skills-plugins-connectors.md`, not in `skills-knowledge-loop.md`.

- **P (pristine)**: `src/cobuilding/skills/` (dev) / `Resources/skills/` (packaged). Read-only seed, revert source, hash reference. 19 skills, 256 files, all git-tracked, no symlinks, 15 executable files [MEASURED].
- **W (store)**: `<userData>/skills/<id>/`. The only writable copy. `copyTree` uses `fs.cpSync(..., {preserveTimestamps:true, verbatimSymlinks:true})` with EINTR retry (`skillStore.ts:183-197`).
- **R (render)**: `<workspace>/.claude/skills/<id>` absolute symlink to W, one per non-removed skill INCLUDING disabled ones (`skillRender.ts:91-95`, rationale `:27-34`). Stale links into the store are swept (`:143-181`); links elsewhere are left alone.
- **Why a symlink**: Edit/heredoc/vim/UI all write the same inode; "modified" is derived `sha256(file) !== baseline[rel]` (per file), never a flag (`skillHash.ts:1-26`). CLI loader accepts symlinked dirs and keys identity on the dirent name (`shared/skills.ts:13-36`).
- **State file shape** (`shared/skills.ts:249-327`): `SkillStateEntry { origin:'builtin'|'custom'|'imported'; enabled; removed?; createdAt?; formerlyBuiltin?; baseline?; dismissed?; updateAvailable?; source?; importedAt?; importedVia?:'ui'|'agent'; importedFrom?; upstreamTreeSha?; upstreamBlobs?; declared?:{name,description,license}; aliasOfDirName?; fileCount?; execCount?; hostOwnedPaths? }`; `SkillsState { version:1; seededAppVersion?; pristineRootHash?; skills }`. Dev profile: 19 entries, all `builtin`, all `enabled`, keys `baseline/enabled/origin` only; `seededAppVersion` 0.1.30 [MEASURED].
- **Reconcile** (`skillStore.ts:817-1003`): runs the per-file table only when `seededAppVersion !== version || pristineRootHash !== rootHash` (`:851-852`). Order: adopt render dirs (`:854`), recover untracked store dirs (`:859-873`), seed missing built-ins (`:878-900`), per-file table (`:905-912`), dropped-upstream handling through the trash (`:915-979`), drop rows whose dir vanished (`:983-989`). If the shipped tree is unreadable, every shipped-tree-dependent pass is skipped (`:839-847`).
- **Per-file rows** (`reconcileSkillFiles`, `:693-810`): B baseline, Pn shipped now, Wn store now. Fast-forward when `Wn===B`; conflict kinds `changed-upstream`, `user-deleted-and-changed`, `user-created-at-upstream-path`; `Wn===Pn` is never a conflict; `dismissed[rel]===Pn` suppresses.
- **Host-owned**: `references/findings/**` (`shared/skills.ts:82`) is excluded from baseline and revert (`skillStore.ts:144-156`).
- **Unknown render dirs / unknown store dirs arrive `enabled:false`** except those matching a shipped skill (B24, `skillStore.ts:647-667`, `:862-870`). Imports are `enabled:false` as a literal (`:1242`).
- **Import**: codeload tarball via `/usr/bin/tar`, symlinks stripped (`knowledge/skillImporter.ts:433-485`), file/size caps `MAX_SKILL_FILES=4000`, `MAX_SKILL_BYTES=64 MB`, git blob SHAs recomputed locally (`:543-555`), id collision refuses and suggests `<id>-<owner>` (`:613-675`), marketplaces read from `.agents/plugins/marketplace.json` or `.claude-plugin/marketplace.json` (`:117-120`). An imported skill on disk is just a directory with `SKILL.md` (+ `scripts/`, `references/`, `assets/`) in `<userData>/skills/<id>/`, no symlinks, with the state entry above.
- **Roster to the SDK**: `buildSkillRuntimeConfig(state)` (`shared/skills.ts:571-580`) returns enabled non-removed store ids plus `BUNDLED_ALLOW=['claude-api']` (`:154`); passed as `Options.skills` (`agent-server/index.ts:658`; carried in config `AgentInfrastructureController.ts:506`; crash replay `containerService.ts:745-792`). The SDK unions `Skill(<id>)` into `allowedTools` itself, so bare `'Skill'` is deliberately absent (`shared/agentAllowedTools.ts:18-26`). 11 bundled SDK skill ids are reserved so a store skill cannot shadow them (`shared/skills.ts:127-139`).
- **Budget** (CLI constants, `shared/skills.ts:602-632`): budget = `SLASH_COMMAND_TOOL_CHAR_BUDGET` env, else `contextTokens*4*fraction`, else `8000*(fraction/0.01)`; per-description cap 1536; below 20 chars per skill the CLI silently drops descriptions. Acabox sets `skillListingBudgetFraction: 0.05` at `agent-server/index.ts:673` (the exported `ACABOX_ROSTER_BUDGET_FRACTION` at `shared/skills.ts:629` is unused). Enable/disable is the budget allocator, not a sandbox; disabled skills keep bytes and symlink.
- **Measured roster** [MEASURED, `measure-roster.js`]: 19 skills; all `name == directory`; description lengths 300-941 (largest `xlsx` 941; `manage-mcp-server` 889; `academic-writing-agent` 819); total CLI-format roster 10,252 chars (over the 8,000 default, under 40,000); PI XML format about 14,725 chars with a nominal 100-char path.
- **Frontmatter fields used**: `name`, `description`, `license`, `source`; none of the 19 uses `when_to_use` or `metadata`. The parser (`shared/skills.ts:346-471`) replicates CLI quirks: `when_to_use` concatenated with ` - `, a YAML repair pass, the CLI's delimiter regex.
- **Writer paths for agents**: there is no `write_skill_file` relay tool (relay list `agent-server/index.ts:230-394` has activity, notification, mini-apps, knowledge, workspace, apis, chats). The docstring at `skillStore.ts:1037-1044` is stale. The agent edits skills with ordinary Edit/Write/Bash through the render symlink, and creates new ones by `mkdir` under `.claude/skills/` (adopted disabled). The UI composes prompts that name the path: `KnowledgePage.tsx:719`, `KnowledgeDetail.tsx:248`.
- **Findings ledger** (host-written, harness-neutral on disk): `<store>/<skill>/references/findings/{digest.md,index.md,index-archive.md,<bucket>.md}` (`knowledge/findingsLedger.ts:56-88`); tool surface `mcp__knowledge__record_finding` (`agent-server/index.ts:307-326`); read-watch in `agentSession.ts:1294-1319` matches `b.name !== 'Read'` and `b.input?.file_path` (`:1304-1305`); omission rule keys on `mcp__<id>__` tool names (`omissionWatch.ts:58-90`). Not built despite the design doc: the `MEMORY.md` routing block (`acabox:routing` grep: no hits) and the `x-acabox-ledger` frontmatter gate (only appears in the design doc).

---

## 3. Hooks: exact semantics as a spec

Registered by shipped `src/cobuilding/settings.json` (full file, `:1-28`), copied to `<workspace>/.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [
  { "matcher": "Bash", "hooks": [
      { "type": "command", "command": "bash .claude/hooks/block-host-installs.sh" },
      { "type": "command", "command": "bash .claude/hooks/block-secret-reads.sh" } ] },
  { "matcher": "Read|Edit|Write", "hooks": [
      { "type": "command", "command": "bash .claude/hooks/block-secret-reads.sh" } ] } ] } }
```

- **Event/matcher**: `PreToolUse`, regex over the tool name. Commands are cwd-relative, so they work only when the CLI cwd is the workspace root. Glob, Grep, NotebookEdit, Agent, WebFetch and MCP tools are not covered by either hook.
- **Input**: JSON on stdin, SDK type `PreToolUseHookInput = BaseHookInput & { hook_event_name:'PreToolUse'; tool_name:string; tool_input:unknown; tool_use_id:string; mcp_server? }` with `BaseHookInput { session_id; transcript_path; cwd; prompt_id?; permission_mode?; agent_id?; ... }` [READ `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:175-189,2759-2765`, SDK 0.3.296]. The scripts read ONLY `tool_input.command` (Bash) and `tool_input.file_path` (Read/Edit/Write).
- **Exit codes**: `2` = deny, stderr is fed back to the model; `0` = allow; any other non-zero = non-blocking, tool proceeds [READ comments `block-host-installs.sh:28-32`, `blockSecretReads.test.ts:5`]. This is why both scripts fail closed with an explicit `exit 2`.
- **Parsing** (identical in both, `block-host-installs.sh:27-57`, `block-secret-reads.sh:32-62`): empty stdin -> exit 0. Parser chosen by test: `/usr/bin/plutil -convert json -o /dev/null -` succeeds -> use `plutil -extract "tool_input.<key>" raw -o - -`; else `jq -e .` succeeds -> `jq -r ".tool_input.<key> // empty"`; else fail closed: stderr `Acabox could not check this command, so it was blocked. Try again; if it repeats, report it.`, exit 2. Env `ACABOX_HOOK_PLUTIL` overrides the plutil path (tests only). Missing field -> empty string -> exit 0.

**Hook A: `block-host-installs.sh`** (Bash only). `command=$(json_field command)`; empty -> exit 0. Blocks if ANY of these ERE patterns matches the whole command string (`:73-81`; the leading boundary `(^|[^[:alnum:]_/.-])` means the tool name must not be preceded by alnum, `_`, `/`, `.` or `-`):

```
(^|[^[:alnum:]_/.-])pip3?[[:space:]]+install([[:space:]]|$)
(^|[^[:alnum:]_/.-])pipx[[:space:]]+install([[:space:]]|$)
(^|[^[:alnum:]_/.-])python3?[[:space:]]+-m[[:space:]]+pip[[:space:]]+install([[:space:]]|$)
(^|[^[:alnum:]_/.-])(npm|pnpm|yarn)[[:space:]]+(install|i|add)([[:space:]]|$)
(^|[^[:alnum:]_/.-])apt(-get)?[[:space:]]+install([[:space:]]|$)
(^|[^[:alnum:]_/.-])(conda|mamba)[[:space:]]+(install|create)([[:space:]]|$)
install\.packages[[:space:]]*\(
```

On match, stderr is a fixed message (`:91-118`): "Direct package installation is not allowed.", "Detected in command:", the command, the three allowed `.applications/install pip|npm|manual ... --app <app_dir_name>` forms, an explanation that the wrapper records `requirements.txt`/`package.json`/`setup/*.sh`, "apt, R, and conda have NO wrapper equivalent... do not retry through the wrapper, it refuses them too.", and "For downloading DATA ... use curl or wget". Exit 2. Otherwise exit 0.

Measured behaviour [MEASURED, real script, sample payloads]: `pip install pandas` 2; `python3 -m pip install x` 2; `uv pip install x` 2; `npm install -g docx` 2; `/usr/bin/pip install pandas` 0 and `.venv/bin/pip install pandas` 0 (path-qualified bypass); `npx some-cli` 0; `brew install qpdf` 0; `poetry add requests` 0; `.applications/install pip seaborn --app a` 0.

**Hook B: `block-secret-reads.sh`** (Bash, and Read|Edit|Write). `command="$(json_field command) $(json_field file_path)"` (`:66`); if only whitespace -> exit 0. Blocks if the concatenation matches ANY of (`:76-84`, unanchored, so basename match anywhere in a path or command): `cobuilding-settings\.json`, `claude-config`, `\.claude\.json`, `agent\.json`. Message (`:94-118`): "That file holds Acabox's own credentials and is off limits.", the command, an explanation of what each file holds, three "There is no task that needs them" bullets (try the work; ask the user or read Settings status; use the connector flow and call `mcp__<connector>__authenticate`), and "tell them to do it in Settings". Exit 2. Measured: `cat /x/agent.json` 2; Read of `/ws/MyResearch/my-agent.json` 2 (false positive: `agent\.json` is unanchored); payload with only `path` 0; payload with only `pattern` 0; `/ws/.claude/settings.json` 0 (explicit test `blockSecretReads.test.ts:70-74`).

**Honest scope (stated in the script header `block-secret-reads.sh:17-21`)**: a guardrail against incidental leakage, not a security boundary (Bash is unrestricted). The real control is encryption (`main/secretStore.ts`).

**Tests that pin the contract**: `main/__tests__/blockSecretReads.test.ts`, `blockHooksNoJq.test.ts` (runs scripts with no jq on PATH, with no parser, and asserts fail-closed), `workspaceProvisioning.test.ts` (restore + backup of hooks/settings).

**Second, in-process hook set (scanner agents)**: `main/directoryScanner/shared.ts:226-278` registers SDK `hooks: { PreToolUse: [{ matcher: "Read|Glob|Grep|mcp__document-reader__read_document", hooks:[blockHiddenPaths, blockOutsideCwd] }] }` using `HookCallback`/`PreToolUseHookInput`, returning `{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason}}`. It reads `tool_input.file_path`, `.path`, `.pattern`. It denies any path segment starting with `.` and any path outside the scan roots.

**Lock enforcement is not a hook**: locked shared folders become SDK `settings.permissions.deny` rules `Edit(//abs/**)`, `Write(...)`, `NotebookEdit(...)` for both the real path and the workspace symlink (`shared/readOnlyRules.ts:35,73-100`), session-scoped (`agent-server/index.ts:676-678`). Bash is not blocked. Guidance text (`agentSession.ts:672-675`): "(locked by you) — Acabox blocks Edit/Write on it. Do not change files here with shell commands either; copy the file into the workspace and edit the copy."

PI facts for re-expression [READ]: `pi.on("tool_call", handler)` can mutate input or block with `{ block: true, reason }`; a handler that throws blocks the tool as a fail-safe (`PI-docs/extensions.md:106,170-176,263`); event shape in examples: `event.toolName` is lowercase, `event.input.command` for `bash`, `event.input.path` for `write`/`edit` (`PI-ex/permission-gate.ts:15-19`, `PI-ex/protected-paths.ts:14-18`); PI built-in tool schemas: `read{path,offset?,limit?}`, `write{path,content}`, `edit{path,edits:[{oldText,newText}]}`, `bash{command,timeout?}`, `grep{pattern,path?,glob?,...}`, `find{pattern,path?,limit?}`, `ls{path?,limit?}`. PI does not prompt for approval by default (`PI-docs/security.md:3`).

---

## 4. Skills: ids, frontmatter, and Claude-specific references per skill

Descriptions below are the exact frontmatter `description` values, whitespace-collapsed [MEASURED with js-yaml]. All 19 have `name == directory`. Counts: files (f), executable (x), SKILL.md bytes (B), description chars (d).

| id | f / x / B / d | license / source | Claude- or harness-specific references (file:line) |
|---|---|---|---|
| `acabox` | 1 / 0 / 15,279 / 602 | Proprietary | Identity "built on Claude by Anthropic" `:41-43`; "Glob and Grep" `:67`; relay tool names `mcp__workspace__get_scanned_files/get_research_profile` `:71-73`, `mcp__activity__query_activity` `:74`, `mcp__mini-apps__*` `:101-104`, `mcp__<connector>__*`/`authenticate`/`complete_authentication` `:110,136,149`, `mcp__apis__list_apis` `:190`, `mcp__notification__show_notification` `:258`; "a hook blocks it" `:82`; **Never run `claude mcp add`** and `settingSources: ['project']` `:112-117`; `.mcp.json` rule `:119-123`; five-minute OAuth window `:133-158`; "blocked by a hook" for settings/`agent.json`/"Claude config directory" `:164-171`; `read_chat`/`list_chats` `:214-238`; "Web search and fetch" `:242`; "Requires an Anthropic API key" `:281`; "Locked folders block Edit and Write" `:272-276`. |
| `academic-writing-agent` | 24 / 0 / 16,466 / 819 | none | Dead tools `mcp__ms-word__find_and_replace/get_selection/get_text/get_file_path` (`actions/revise.md:25-52`, `actions/draft.md:34-53`, `actions/cite.md:113-115`, `format.md:27`), `mcp__zotero__status/search_library` (`cite.md:24-29`), `mcp__citeright__*` (`cite.md:120-186`); deferred-tool loading via `ToolSearch` (`revise.md:29-32`, `draft.md:38-41`, `format.md:40`); "The SDK's tool-use loop re-invokes the model" (`format.md:58`, `revise.md:56`); "overrides the harness's default end-of-turn summary convention" (`format.md:5`); one-HTML-block output vocabulary `<details class="skill-trace">` etc. (`format.md:3-90`); "`about_you.md` is auto-loaded by the harness" (`SKILL.md:56,58`, `memory.md:5,8`) which is false; `Write` tool and composite-Bash + parallel-Read batching (`SKILL.md:46-52,130-137`, `memory.md:65-123`); every file ends `<!-- skill-file: path @date -->` markers. |
| `alphafold-database-access` | 1 / 0 / 4,950 / 349 | CC-BY-4.0 / jaechang-hits/SciAgent-Skills | `.applications/install pip ... --app` `:26`; neutral otherwise. |
| `database-lookup` | 1 / 0 / 3,046 / 359 | K-Dense | "(a PreToolUse hook blocks it)" `:30`; **"use WebFetch (Claude Code native) for GET endpoints"** `:36`. |
| `docx` | 49 / 2 / 14,587 / 785 | Proprietary | `mcp__ms-word__get_text/find_and_replace/track_changes_status/set_track_changes/save_document` `:17-19,400-408` (tools dropped from the fork); `npm install -g docx` `:58,420` (blocked by hook); references scripts that do not exist in the skill: `scripts/accept_changes.py` `:51`, `scripts/office/unpack.py` `:36` [MEASURED]; needs pandoc, LibreOffice, poppler (`:419-422`). |
| `ensembl-database` | 1 / 0 / 4,065 / 331 | Apache-2.0 / SciAgent | Install wrapper only; points at nonexistent `kegg-database` skill. |
| `flow-cytometry` | 7 / 0 / 10,371 / 463 | none | **"Do NOT use Glob to find directories — it only matches files"** `:25` (Claude Glob quirk); `.claude/skills/flow-cytometry/scripts/*.py` at `:56,93,117,152,167,206,245`. |
| `geo-database` | 1 / 0 / 4,926 / 381 | MIT / SciAgent | Install wrapper only. |
| `gnomad-database` | 1 / 0 / 3,825 / 361 | ODbL-1.0 / SciAgent | "`WebFetch` cannot reach it" `:17`. |
| `manage-mcp-server` | 3 / 0 / 17,047 / 889 | none | "a tool Claude can call" `:6,31,39`; `.claude/skills/manage-mcp-server/assets/scaffold/*` `:57-58`; SDK tool-name rule `mcp__<id>__<tool>` `:94`; reserved ids list of six `:99-100` (code has seven, adds `chats`); "Authored by Claude" `:182`; hosted env lacks `ANTHROPIC_API_KEY` `:211`; "no permission prompt for MCP tool calls" `:222-226`; `.claude/skills/manage-mini-application/assets/install` `:234`. |
| `manage-mini-application` | 33 / 2 / 40,247 / 760 | none | Script path `.claude/skills/manage-mini-application/scripts/manage_mini_app.mjs` `:29`; `window.coscientist.callMcpTool` `:80`; `mcp__mini-apps__list_published_servers/call_published_tool` `:81`; **"Do NOT use `Monitor`, `ScheduleWakeup`"** `:107`; `build_and_open_mini_application` `:108,455,470`; viewer text "Claude is still writing this tool" `:117`; `.claude/skills/react-plotly/SKILL.md` `:121`; **`NotebookEdit`** `:441`; "PreToolUse hook" `:533,535`; `window.anthropicAPI`, `claude-haiku-5-5` `:701-744`. Also `bridge-api.md:92-150`. |
| `opentargets-database` | 1 / 0 / 5,362 / 361 | Apache-2.0 / SciAgent | "`WebFetch` cannot reach it" `:16`. |
| `pdb-database` | 1 / 0 / 5,724 / 358 | CC0 / SciAgent | Install wrapper only. |
| `pdf` | 12 / 1 / 8,072 / 437 | Proprietary | `pip install pytesseract pdf2image` `:235` (hook-blocked); vision-dependent form flow `forms.md:53-55,174-245,288` (needs the model to look at PNGs); poppler/qpdf/tesseract assumed. |
| `pptx` | 59 / 6 / 9,182 / 688 | Proprietary | **"USE SUBAGENTS — even for 2-3 slides"** `:165`; `editing.md:31,38,115-125` "Use subagents here if available", "Use the Edit tool, not sed", `:187` "the Edit tool converts smart quotes"; raw installs `:228-230`, `pptxgenjs.md:238`; vision QA `:163-203`. |
| `react-plotly` | 5 / 0 / 8,736 / 300 | none | Neutral (React/Plotly guidance; `@reusable/plotTheme`). |
| `reactome-database` | 1 / 0 / 5,622 / 350 | CC-BY-4.0 / SciAgent | Install wrapper only. |
| `string-database-ppi` | 1 / 0 / 5,562 / 363 | CC-BY-4.0 / SciAgent | Install wrapper only. |
| `xlsx` | 54 / 4 / 11,463 / 941 | Proprietary | Assumes LibreOffice (`:74`, `scripts/recalc.py`); no Claude-tool references. |

Full descriptions (verbatim, collapsed): see `dump-desc.js` output reproduced here for the two Acabox-authored routing-critical ones.
- `acabox`: "Acabox's own identity, voice, and capability inventory. Use this skill whenever the conversation is about Acabox itself rather than about the user's research: "who are you", "what are you", "what is Acabox", "what can you do", ... or any feasibility, onboarding, or scope question. Also use it when the user seems stuck or is about to ask for something Acabox cannot do, so the answer names the nearest thing that IS possible."
- `manage-mini-application`: "PRIORITY SKILL: Invoke this skill BEFORE any analysis or data-processing skills whenever the user's PRIMARY intent is to build, create, make, develop, or update an application, tool, dashboard, or UI ... DO NOT run analysis skills as a prerequisite step. ... Do NOT use this skill when the user wants to directly run an analysis on their data with no mention of building a UI or application."
(The other 17 descriptions are 300-941 chars each and are reproducible with `.../scratchpad/work-contextpack/dump-desc.js`.)

Cross-cutting skill findings:
- **Raw-install contradiction** (pre-existing): `docx`, `pptx`, `pdf` tell the agent to run `npm install -g` / `pip install`, which Hook A blocks; `.applications/install` requires `--app <existing mini-app dir>` (`skills/manage-mini-application/assets/install:101-117`) and reads `COSCIENTIST_VENV_DIR`, `COSCIENTIST_NPM_PREFIX`, `jq`.
- **System binaries not shipped**: pandoc, LibreOffice (`soffice`), poppler (`pdftoppm`), qpdf, tesseract, ImageMagick `magick`; apt/brew are refused. Harness-neutral but affects parity equally.
- **Skill-relative script paths** (`python scripts/office/soffice.py` in docx/pptx/xlsx/pdf) rely on the harness telling the model the skill base dir; PI's roster says to resolve relative paths against the SKILL.md directory (`PI-src/core/skills.ts:358-390`).
- **Vision**: flows that need the model to look at images (pdf forms, pptx/docx QA) require a vision-capable model; PI `read` can return image content (`read.ts:34-35`).
- **Executables** (15): `docx/scripts/__init__.py`, `docx/scripts/office/validate.py`, `manage-mini-application/assets/install`, `.../westernBlotAnnotator/setup/download_model.sh`, `pdf/scripts/extract_form_structure.py`, six under `pptx/`, four under `xlsx/`. Largest file: `assets/vendor/tailwind.js` 407 KB.

---

## 5. Workspace instructions (`src/cobuilding/CLAUDE.md`) section by section, plus the prompt stack

### 5.1 The file, section by section (105 lines)

1. **File Access** (`:3-9`): working dir holds agent-managed `.claude/`, `.applications/`, `.academia/` (`:5`); always relative paths; "To access skills: `.claude/skills/...`" (`:7`); "**Never use `cd`**" (`:9`).
2. **Installing packages** (`:11-31`): everything through `.applications/install`; apt/R/conda unavailable; "All of these invocations are blocked by a PreToolUse hook." (`:25`); data downloads exempt; durable `input/`/`output/` symlinks; points to `.claude/skills/manage-mini-application/SKILL.md` (`:31`).
3. **Calling APIs** (`:33-67`): curl recipe with `$ACABOX_API_TOKEN`/`$ACABOX_API_BASE`; "Use `mcp__apis__list_apis`" (`:47`); never ask for keys; 405/403 handling; mini-apps use `window.hostAPI.api.fetch`.
4. **Running skill scripts** (`:69-77`): "Skill scripts are located in the workspace at `.claude/skills/<skill-name>/scripts/`" and the template `<command> .claude/skills/<skill-name>/scripts/<script> <args>`.
5. **Opening mini-applications** (`:79-83`): "call the `mcp__mini-apps__open_mini_application` tool ... Use `mcp__mini-apps__build_and_open_mini_application` instead when you've just created or edited the app's source".
6. **Workspace Files and Research Profile** (`:85-89`): `mcp__workspace__get_scanned_files`, `mcp__workspace__get_research_profile`.
7. **Background commands** (`:91-101`), verbatim: "**A background shell command dies when your turn ends.** Acabox stops the agent process between messages, and every `run_in_background` Bash command goes with it. Nothing you start in the background keeps running after you have replied, and nothing wakes you when it finishes". Bullets: no pollers/watchers/heartbeats; waiting on external work -> check now and tell the user to ask again; long commands run in the foreground with a timeout; "An orphaned background command is also reported back to you at the start of the next session ... Leave nothing running."
8. **Progress Tracking** (`:103-105`), verbatim: "When working on multi-step tasks (3 or more steps), use the `TodoWrite` tool to create and maintain a task list ... mark items as `in_progress` ... `completed`".

Claude-specific sentences to re-express: `:5,7,25,31,47,71-77,81-83,87-89,93-101,105`. The file contains NO identity line and does not name "Claude" except via these tool names.

### 5.2 The identity line lives elsewhere

- `main/identityPreamble.ts:8` (injected every session): "You are Acabox, a local research workbench that does the work and builds the tools, built on Claude by Anthropic. If asked what you are, say so plainly — "I'm Acabox, built on Claude". Speak in the first person: "I'll load the counts"." Also `:10` ("Keep internal names — directory names, tool ids, error codes, `mcp__` names — out of replies unless asked") and `:14` ("invoke the `acabox` skill for the full identity and capability inventory").
- `skills/acabox/SKILL.md:41-43`: "You are Acabox, built on Claude by Anthropic. If asked, say so plainly ("I'm Acabox, built on Claude") and never deny it."
- Product decision recorded in `CLAUDE.md` (root) Status 2026-10-01: "one name (I'm Acabox, built on Claude)". A multi-provider build needs this made provider-neutral.

### 5.3 System prompt composition and injection sites

- Base: `systemPrompt: { type: 'preset', preset: 'claude_code' }` (`main/controllers/AgentInfrastructureController.ts:497`), no `tools` restriction, no `canUseTool`, no `permissionMode`, no `maxTurns`/`maxBudgetUsd` for chat [MEASURED by grep of `agent-server/index.ts` option set].
- Append (`agent-server/index.ts:510-522`): `[config.soulMd, config.docxGuidance, config.workspaceDirectoriesGuidance, config.apiGuidance, KNOWLEDGE_ROUTING_GUIDANCE].filter(Boolean).join('\n\n')` -> `{...systemPrompt, append}`. Note `docxGuidance` is a legacy name for the host guidance: `mergeSessionConfig` maps `overrides.hostGuidance -> docxGuidance` (`agent-server/sessionConfig.ts:109`).
- Host builds per session (`main/agentSession.ts`): SOUL.md read from `containerService.getAgentDir()/.academia/SOUL.md` (`:639-649`; the old read via `workspace.directory_path` silently failed); `hostGuidance = IDENTITY_PREAMBLE` (`:651`, about 956 chars); workspace directories guidance (`:657-682`): "## Workspace Directories / The following user research directories are available as subdirectories of your workspace:" then `- Name/ (locked by you) ...` or `- Name/ (read & write) — edit files directly.`; `permissionDeny` (`:660-667`); `apiGuidance` from `shared/apis.ts:451-481` only when the proxy runs (`:829-831`). Create-session body (`:837-846`): `{sessionId, resumeSessionId, model, effort, soulMd, hostGuidance, workspaceDirectoriesGuidance, permissionDeny, apiGuidance}`.
- `KNOWLEDGE_ROUTING_GUIDANCE` (`agent-server/index.ts:495-508`, about 768 chars), verbatim essentials: "A fact about the USER ... → write a memory file, as the auto-memory section above describes. A fact about a DATA SOURCE, A SYSTEM, OR A PROCEDURE ... → call mcp__knowledge__record_finding. Do NOT write it as a memory." It presupposes the CLI's "# auto memory" section.
- Sizes: workspace CLAUDE.md 7,478 B; SOUL.md in production about 8,000 B (review doc); acabox SKILL.md 15,279 B (only loaded on activation).
- Scheduled tasks reuse the identical pack (`main/scheduledTasks/runner.ts:25,55` -> `createAgentSession`). Two other prompt owners exist that are NOT the workspace agent: the scanner agents (`directoryScanner/shared.ts:66-120`, prompts naming `Read`, `Glob`, `Grep`, `mcp__document-reader__read_document`) and the calendar assistant (`main/calendarAgentSession.ts:273,623-640`, direct `@anthropic-ai/sdk`, hardcoded `claude-sonnet-4-6`).

---

## 6. The memory story

**What Acabox sets** (`agent-server/index.ts:659-679`): `autoMemoryEnabled: true`, `autoMemoryDirectory: ${workspaceRoot}/.academia/agent-memory`, `autoDreamEnabled: false` (reason in comment `:662-666`: the dream pass would run Edit/Write/rm in the memory dir and cannot tell hand-authored from generated bytes). Nothing else in Acabox writes memory instructions.

**What Claude Code did automatically** [READ out of the bundled binary `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, offsets 191843500-191906000 and 80112011; plus `docs/design/skills-knowledge-loop.md:73-83,291-307`]:
- Injected an unconditional `# auto memory` system-prompt section containing: the memory directory path; "Your personal memory directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence)"; the four memory types `user`, `feedback`, `project`, `reference` with when-to-save / how-to-use / body-structure (rule, then `**Why:**` and `**How to apply:**`) / examples (software-engineering flavoured); a "What NOT to save" list (code patterns, git history, debugging recipes, anything in CLAUDE.md, ephemeral task state); "When to access memories" ("You MUST access memory when the user explicitly asks you to check, recall, or remember"; if the user says to ignore memory, do not use it); "Before recommending from memory" staleness rules; and the save protocol: Step 1 write `<type>_<slug>.md` with frontmatter `name`, `description`, `type` (newer template nests `metadata: type:`; the dev file uses top-level `type: user`), Step 2 add a one-line pointer `- [Title](file.md) — one-line hook` (under about 150 chars) to `MEMORY.md`, "`MEMORY.md` is an index, not a memory ... no frontmatter ... Never write memory content directly into `MEMORY.md`".
- Loaded `MEMORY.md` into context on every turn through the same loader as CLAUDE.md (tag `AutoMem`), capped about 200 lines / 25 KB (design doc `:78`).
- Created the directory, stamped `originSessionId` in frontmatter of files it authors (read by `main/index.ts:3385`, joined to `sessions.sdk_session_id` for the "from <chat>" link `:3355-3397`).
- Had a gated relevance recall (`memdir_relevance`, flag `tengu_moth_copse`, default off) and a `dream` consolidation pass. Measured NOT firing here: zero `memory_recall` events across production transcripts (`skills-knowledge-loop.md:25-30,83`); dream disabled.
- Explicit "remember"/"forget" handling lives in that CLI prompt text, not in any Acabox file.

**What Acabox relies on today**:
- `MEMORY.md` is the only memory content verified to be in context each turn; the agent then `Read`s files it points at. Production at 2026-09-30: 28 agent-written memory files (`feedback_*`, `project_*`, `reference_*`, `user_*`), `MEMORY.md` 5.7 KB (`docs/design/review-2026-09-30/agent-capabilities.md:15,89`). The review reports "the agent's knowledge of the user lives" in `MEMORY.md`. Dev profile example [MEASURED]: `MEMORY.md` = `# Memory Index` + `- [Works with nucleotide sequences](user_sequence_work.md) — routine DNA/RNA analysis; prefers durable tools over one-off scripts`; the note has frontmatter `name`, `description`, `type: user`.
- `about_you.md` / `working_on.md`: raw text, no frontmatter, NOT linked from `MEMORY.md`, therefore not auto-loaded (docs/design/product-review-2026-09-30.md:160, skills-knowledge-loop.md:95). They reach the agent only through `mcp__workspace__get_research_profile` (`AgentInfrastructureController.ts:287-309`: prefers the scan report, falls back to the files). `academic-writing-agent/SKILL.md:56` and `memory.md:5` wrongly say they are auto-loaded by the harness.
- UI surfaces built on the CLI's format: Knowledge page memory list (`main/index.ts:3333-3413`: lists `*.md`, parses frontmatter with the skill parser, `indexed` = filename appears in `MEMORY.md`, `isIndex`, `originChat`), Settings "About you".
- `record_finding` and the routing guidance are written as a counterweight to the memory section (`agent-server/index.ts:486-494`).
- Separate from memory but also CLI-state: transcripts `<claude-config>/projects/<key>/<sdkSessionId>.jsonl` are what `resume` replays; lifecycle in `main/transcriptStore.ts` (delete on chat delete, orphan sweep at boot `main/index.ts:1003`); the agent-server checks the file exists before resuming (`agent-server/index.ts:710-736`).

**PI status**: no memory feature exists (grep over `PI-docs/`; `README.md:19`). File format (markdown + frontmatter + index) is harness-neutral, so existing directories and the Knowledge page keep working if something else provides the prompt section, the `MEMORY.md` injection and the write protocol [INFERRED].

---

## 7. Settings and config content Acabox relies on

### 7.1 `.claude/settings.json` (shipped file): hooks only, verbatim in section 3.

### 7.2 SDK inline `settings` object (`agent-server/index.ts:659-679`)
`autoMemoryEnabled: true`; `autoMemoryDirectory: ${workspaceRoot}/.academia/agent-memory`; `autoDreamEnabled: false`; `skillListingBudgetFraction: 0.05`; `permissions: { deny: sessionConfig.permissionDeny }` only when non-empty.

### 7.3 Other `query()` options (`:624-688`)
`pathToClaudeCodeExecutable` (optional), `model`, `thinking: { type: 'adaptive' }`, `effort`, `systemPrompt` (preset + append), `resume`, `includePartialMessages: true`, `cwd: getWorkspaceRoot()`, `env`, `settingSources: ['project']`, `skills`, `settings`, `mcpServers: mergeDynamicMcpServers(state)` (7 relays + connectors + hosted), `allowedTools`. `env` = `...process.env` plus `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`, `MINI_APP_WORKSPACE_DIR`, `CLAUDE_CONFIG_DIR`.

`settingSources: ['project']` is what loads CLAUDE.md, `.claude/settings.json` (hooks), `.claude/skills`, and a project `.mcp.json` (`AgentInfrastructureController.ts:507-511`). That `.claude/agents`, `.claude/commands` and `settings.local.json` are also loaded is [INFERRED] and ungoverned by Acabox. Scanner agents use `settingSources: []`, `persistSession: false`, `tools: ["Read","Glob","Grep",docReaderTool]`, `thinking disabled`, `effort low`, `maxTurns`, `maxBudgetUsd`, `outputFormat json_schema` (`directoryScanner/shared.ts:185-224`; `fileTagging.ts:36-49`; `researchProfile.ts:31-44`).

### 7.4 `allowedTools` (auto-approve, not a restriction): `shared/agentAllowedTools.ts:43-80`, verbatim
`'Bash','Read','Write','Edit','Glob','Grep','Agent','WebSearch','WebFetch','TodoWrite','TaskCreate','TaskUpdate','TaskGet','TaskList','ToolSearch','EnterPlanMode','ExitPlanMode','mcp__activity__query_activity','mcp__knowledge__record_finding','mcp__apis__list_apis','mcp__mini-apps__open_mini_application','mcp__mini-apps__build_and_open_mini_application','mcp__mini-apps__list_published_servers','mcp__mini-apps__call_published_tool','mcp__notification__show_notification','mcp__workspace__get_scanned_files','mcp__workspace__get_research_profile','mcp__chats__list_chats','mcp__chats__read_chat'` plus `mcp__<id>` per connector/hosted server. `filterMcpServers` (`sessionConfig.ts:87-96`) drops a relay with no `mcp__<name>__*` entry, hence the boot assertion `assertKnowledgeToolAllowed` (`agentAllowedTools.ts:109-117`). Reserved relay ids: `activity, notification, mini-apps, workspace, knowledge, apis, chats` (`shared/connectors.ts:157-172`).

### 7.5 `AgentConfig` written to `<userData>/agent.json` (`agent-server/sessionConfig.ts:3-72`)
`port`, `claudeBinaryPath?`, `mcpServers`, `hostedServers?`, `anthropicApiKey`, `anthropicBaseURL?`, `model`, `effort?`, `systemPrompt: unknown`, `allowedTools: string[]`, `skills?: string[]`, `settingSources: string[]`, `soulMd?`, `docxGuidance?`, `workspaceDirectoriesGuidance?`, `permissionDeny?`, `apiGuidance?`. `SessionOverrides` adds `additionalAllowedTools?` (no longer used), `hostGuidance?`, `model?`, `effort?`. Live updates: `POST /credentials`, `/connectors`, `/skills`, `/hosted`; stop `/sessions/:id/interrupt`.

### 7.6 `.claude.json` in `CLAUDE_CONFIG_DIR` (`shared/claudeConfigApproval.ts:19-48`)
Acabox writes only `customApiKeyResponses.approved` (the key's last 20 characters, `apiKey.slice(-20)`) and clears `rejected`, preserving everything else; called before every `query()` (`agent-server/index.ts:620`) and before scanner runs (`directoryScanner/shared.ts:193`). Without it the headless CLI answers "Not logged in". Connector OAuth tokens are NOT here (macOS keychain primary, `.credentials.json` 0600 fallback; correction recorded in root CLAUDE.md). The secret hook protects this file.

### 7.7 Environment (`containerService.ts:104-140`, `:514-531`)
Subprocess env: `COSCIENTIST_VENV_DIR`, `COSCIENTIST_NPM_PREFIX`, `NODE_PATH`, `PATH` = venv bin : npm bin : login-shell PATH, `ACABOX_API_BASE`/`ACABOX_API_TOKEN` (only when the proxy listens; token scoped per caller). Agent-server spawn adds `ELECTRON_RUN_AS_NODE=1`, `COSCIENTIST_AGENT_PORT` (probe range 23200-23299, `:475`), `COSCIENTIST_AGENT_CONFIG`, `COSCIENTIST_WORKSPACE`, `COSCIENTIST_AGENT_INSTANCE`, `COSCIENTIST_CLAUDE_CONFIG_DIR`.

---

## 8. Classification: must re-express for PI vs harness-neutral

### 8.1 MUST re-express (ticket-sized), with the PI fact that constrains it

| # | Item | Where (Acabox) | Why Claude-specific | PI constraint / equivalent [READ unless marked] |
|---|---|---|---|---|
| R1 | Base system prompt + append stack | `AgentInfrastructureController.ts:497`; `agent-server/index.ts:510-522` | `claude_code` preset is Claude Code's whole behavioural prompt (not extractable cleanly; see unknowns) | PI default preamble is "You are an expert coding assistant operating inside pi, a coding agent harness." (`PI-src/core/system-prompt.ts:155-156`) plus tools/rules/docs sections. Replace with `systemPrompt` (`DefaultResourceLoaderOptions.systemPrompt`) and pass the 5 strings as `appendSystemPrompt: string[]` (`resource-loader.ts:292-300`). Section order: preamble, tools, rules, docs, addendum, project_context, skills, cwd (`system-prompt.ts:152-186`). With a custom prompt the tools/rules/docs sections disappear. |
| R2 | Identity wording | `identityPreamble.ts:8-14`; `skills/acabox/SKILL.md:41-43,281` | "built on Claude by Anthropic"; "Requires an Anthropic API key" | Must be provider-neutral; PI exposes `PI_PROVIDER`/`PI_MODEL` to the bash tool (`PI-docs/environment-variables.md:20-39`) but the prompt is built per session. |
| R3 | Workspace instructions file location | `skills.ts:214` -> `.claude/CLAUDE.md` | PI only reads `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` directly in a dir (`resource-loader.ts:184-205`) | Provision to `<workspace>/AGENTS.md` (or `CLAUDE.md`), or inject via `agentsFilesOverride`/`appendSystemPrompt`. Reuse `reconcileProvisionedFile` unchanged. |
| R4 | Edit CLAUDE.md prose | `CLAUDE.md:5,7,25,31,47,71-77,81-89,93-101,105` | `.claude/skills` paths, "PreToolUse hook", `mcp__*` names, `run_in_background`, `TodoWrite` | PI `bash` schema has only `command`, `timeout` (`bash.ts:40-42`); no TodoWrite. |
| R5 | Two PreToolUse hooks -> `tool_call` extension | `hooks/*.sh`, `settings.json` | Payload fields, exit-code protocol, matcher regex, jq/plutil parsing | Tools `bash.command`, `read/write/edit.path`, `grep/find/ls.path`+`pattern`. Handler throw = block (inverse default of the CLI). Ship as an inline extension via `extensionFactories` (in-process, not editable by the agent) rather than `.pi/extensions/` (needs project trust). Add `path`, `pattern` and PI credential files to the secret patterns. |
| R6 | Delete `.claude/settings.json` + hook provisioning + `restore`/backup policy for them | `skills.ts:211-236`, `workspace-file-backups` | Exists only because hooks sit in the agent-writable workspace | If the guard is in-process, the `restore` machinery is dead weight for these files. |
| R7 | Skill discovery/enablement | `skillRender.ts`; `buildSkillRuntimeConfig`; `Options.skills` | `.claude/skills` render, CLI allowlist, `Skill(<id>)` tool, bundled ids, CLI roster budget | PI: `additionalSkillPaths`, `noSkills`, `skillsOverride(base)` (`resource-loader.ts:282-296,599-601,842-852`); skills are loaded by the model `read`ing SKILL.md; roster is XML with `<name>`, `<description>`, `<location>` and NO budget (`skills.ts:358-390`); `disable-model-invocation` hides a skill (`PI-docs/skills.md:53,79`) but is a frontmatter edit, so use `skillsOverride` to filter by `enabled` instead. |
| R8 | Skill identity | CLI keys on dirent name (`shared/skills.ts:19-25`) | PI `name = frontmatter.name \|\| parent dir` (`skills.ts:321`); collisions keep first and warn (`PI-docs/skills.md:85`) | Affects imported skills with mismatched names (62 of 607 in `openai/plugins` per `skillImporter.ts:570`). |
| R9 | `.claude/skills/...` path strings in docs/code | see list below | Render path | Keep a symlink render at the same path and load that dir via `additionalSkillPaths`, or sweep all occurrences. Occurrences: `CLAUDE.md:5,7,31,71-75`; `manage-mini-application/SKILL.md:29,121`; `manage-mcp-server/SKILL.md:57-58,234`; `flow-cytometry/SKILL.md:56,93,117,152,167,206,245`; `westernBlotAnnotator/template.md:136`; `KnowledgePage.tsx:719`; `KnowledgeDetail.tsx:248`; `agent-server/index.ts:313`; `shared/paths.ts:16`, `shared/skills.ts:71`. |
| R10 | Memory | section 6 | CLI feature | PI has none. Needs: prompt section with the protocol, `MEMORY.md` injection (e.g. `before_agent_start`, `PI-docs/extensions.md:104`), and rewrite of `KNOWLEDGE_ROUTING_GUIDANCE` and the `record_finding` tool description. |
| R11 | Claude tool names used as instructions | acabox skill `:67,242`; flow-cytometry `:25`; manage-mini-application `:107,441`; pptx `:165`, `editing.md:31-38,115-125`; database-lookup `:36`; CLAUDE.md `:93-105` | Bash, Read, Write, Edit, Glob, Grep, Agent/subagents, WebFetch, WebSearch, TodoWrite, NotebookEdit, Monitor, ScheduleWakeup, ToolSearch | PI defaults `read, bash, edit, write`; `grep, find, ls` available (`PI-docs/settings.md:42-46`); no web, todo, sub-agents, plan mode (`README.md:19`). Example extensions exist: `todo` tool (`PI-ex/todo.ts:137`), `question` (`PI-ex/question.ts:46`), `subagent/`, `plan-mode/`. |
| R12 | Web access | `acabox` skill "Web search and fetch", `database-lookup` | WebFetch/WebSearch are CLI built-ins and in `allowedTools` | PI ships none; needs an Acabox tool or curl-based instructions. |
| R13 | MCP naming and OAuth guidance | acabox skill `:71-258`; CLAUDE.md; allowlist; hook message; `omissionWatch.ts:58-90` | `mcp__<server>__<tool>`; CLI-synthesised `authenticate`/`complete_authentication`; `claude mcp add`; `.mcp.json`; 5-minute CLI-held OAuth window | PI MCP config lives in `<agent-dir>/mcp.json` and `.pi/mcp.json` (`PI-docs/configuration.md:15,31`); PI MCP tool naming and OAuth were not read (unknown). |
| R14 | Locked-folder enforcement grammar | `shared/readOnlyRules.ts:35-100`; guidance `agentSession.ts:672-675` | SDK `permissions.deny` strings `Edit(//abs/**)` | Implement as `tool_call` check on `edit`/`write` `input.path`; reword guidance (tool names). |
| R15 | API-key approval + credential-file patterns | `claudeConfigApproval.ts`; `block-secret-reads.sh:76-84` | `.claude.json`, `claude-config` | PI keeps credentials in `<agent-dir>/auth.json`, models in `models.json`, relocatable with `PI_CODING_AGENT_DIR` (`PI-docs/configuration.md:9-17`; `PI-src/config.ts:585`). |
| R16 | Transcript/resume layer | `claudeConfigDir.ts`, `transcriptStore.ts`, `agent-server/index.ts:710-736` | `projects/<key>/<id>.jsonl` layout | PI sessions are JSONL under the agent dir or `sessionDir` (`PI-docs/settings.md:66`, `how-pi-works.md:27`). |
| R17 | Findings read-watch | `agentSession.ts:1304-1305` | `Read` / `file_path` | `read` / `path`. |
| R18 | Scanner agents | `directoryScanner/shared.ts`, `fileTagging.ts`, `researchProfile.ts` | `tools`, `hooks`, `outputFormat`, `maxTurns`, `maxBudgetUsd`, `settingSources:[]` | No PI equivalents for budget/structured-output flags (example `PI-ex/structured-output.ts` exists). |
| R19 | `academic-writing-agent` | section 4 | Dead Word/Zotero/CiteRight tools, `ToolSearch`, SDK-loop prose, HTML-only protocol, false auto-load claim | Decide: drop those flows or rewrite; the renderer sanitises raw HTML and allows `<details>/<summary>` (`renderer/components/assistant-ui/doi-link.tsx:64-70`). |
| R20 | `docx` Word-MCP section and missing scripts | `docx/SKILL.md:17-19,36,51,400-408` | Dropped tools; missing files | Remove or restore scripts. |
| R21 | Provider-specific mini-app runtime docs | `manage-mini-application/SKILL.md:701-744`; `bridge-api.md:92-150`; `bridge.ts:66-118,226-288` | `window.anthropicAPI`, Anthropic message shapes, `claude-haiku-5-5` default | Needs provider-neutral API (overlaps the proxy reader). |
| R22 | Context-file and skill isolation | n/a | PI loads ancestors' `AGENTS.md`/`CLAUDE.md` up to `/` (`resource-loader.ts:253-270`) and `~/.agents/skills` | Set `noContextFiles` and `noSkills` and supply explicit paths. |
| R23 | Project trust | n/a | `.pi/settings.json`, `.pi/skills`, `.pi/extensions`, `.pi/SYSTEM.md` need a trust decision; non-interactive default `ask` skips them (`PI-docs/security.md:35-82`) | Use agent-dir, `additionalSkillPaths`, inline extensions, never workspace `.pi/`. |
| R24 | Vision-dependent skill flows | `pdf/forms.md`, pptx QA, docx image conversion | Assume an image-capable model | Multi-provider roster must flag vision capability. |

### 8.2 Harness-neutral (carry over as is)
- N1 skill store/state/hash/reconcile/trash/import/ledger code (`skillStore.ts` except the `RESERVED_SKILL_IDS`/`BUNDLED_*`/roster math and CLI-quirk frontmatter parsing in `shared/skills.ts`); `skillHash.ts`; `skillImporter.ts`; `skillImportService.ts`; `findingsLedger.ts`.
- N2 `reconcileProvisionedFile` and `workspace-provisioning.json` mechanism (change paths/policy list only).
- N3 `syncMiniAppAssets` and all of `manage-mini-application/assets/` (bridge, reusable, vendor, templates, `install`, scaffold script), `react-plotly`, `flow-cytometry` scripts, `xlsx`/`pdf`/`pptx` scripts, the eight database skills (aside from `WebFetch` and install-wrapper lines).
- N4 `.academia/` layout, SOUL.md file and its UI, memory file FORMAT, `references/` conversion, hosted-MCP authoring flow (`.mcp-servers`), `tool-data` split, shared-folder symlinks, `buildSubprocessEnv`, API proxy env vars.
- N5 `src/cobuilding/shared/agentAllowedTools.ts` intent (a list of tools to expose) becomes a tool-selection list in PI.

### 8.3 What Claude Code did implicitly that PI will not (checklist)
`claude_code` prompt (tone, tool policy, safety, environment block); CLAUDE.md auto-load; `Skill` tool plus roster budgeting; `.claude/settings.json` hooks; `allowedTools` auto-approve and `permissions.deny`; auto-memory section + `MEMORY.md` load + dir creation + `originSessionId`; transcripts/resume; tools Bash (with `run_in_background`), Read (images/PDF/notebooks), Edit (requires prior Read), Glob, Grep, Agent, WebSearch, WebFetch, TodoWrite/Task*, ToolSearch, plan mode, NotebookEdit, AskUserQuestion; MCP naming and OAuth; API-key approval gate; auto-compaction, prompt caching, adaptive thinking, `effort`; orphaned-background-task notifications (the cause of the swallowed-turn workaround in agentSession).

---

## 9. PI facts used above (all [READ])
- Agent dir: env `PI_CODING_AGENT_DIR` or SDK `agentDir`; files `settings.json`, `keybindings.json`, `mcp.json`, `models.json`, `auth.json`, `AGENTS.md`/`CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/`, `skills/`, `prompts/`, `themes/` (`PI-docs/configuration.md:7-24`; `PI-src/config.ts:585,606-610`). Project `.pi/` mirrors this (`:26-37`).
- Context files: candidates list at `resource-loader.ts:185`; loaded from agent dir, cwd, every ancestor (`:232-270`); disabled by `noContextFiles`; overridable by `agentsFilesOverride` (`:292-309`); load regardless of project trust (`PI-docs/security.md:57`).
- Skills: Agent Skills spec; name from frontmatter else dir (`skills.ts:321`); description max 1024 and name rules produce warnings only (`:11-14,92-112,300-316`); a directory with `SKILL.md` is a root, no deeper recursion; symlinked dirs followed; dot-prefixed children skipped (`:164-248`); malformed or description-less skills not loaded (`PI-docs/skills.md:85`); roster XML (`skills.ts:358-390`).
- Tools: defaults `read,bash,edit,write`; also `grep,find,ls,powershell`; `defaultTools` setting with `+name`/`-name` (`PI-docs/settings.md:38-60`).
- No approval prompts by default; extensions run in-process with the process permissions (`PI-docs/security.md:3,47`; `how-pi-works.md:47-49`).
- Built-in MCP extension reads `mcp.json`; SDK sessions must add `createMcpExtension()` themselves (`PI-docs/sdk.md:116`).
- Env for the bash tool: `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` (`PI-docs/environment-variables.md:20-39`); `spawnHook` can inject env (`:53-62`).

---

## 10. Documentation vs code disagreements found (code wins)
1. Root `CLAUDE.md` says workspace is `cobuilding-workspace`; code and disk use `workspace-data` (`WorkspaceController.ts:85-87`, `shared/paths.ts:9`).
2. Root `CLAUDE.md` and design docs say 21 shipped skills; the tree has 19 (256 files, all tracked).
3. `academic-writing-agent/SKILL.md:56`, `memory.md:5` claim `about_you.md` is auto-loaded; measured not (not linked from `MEMORY.md`).
4. `manage-mcp-server/SKILL.md:99-100` lists six reserved ids; code reserves seven (adds `chats`, `shared/connectors.ts:171`).
5. `docx/SKILL.md:36,51` reference scripts absent from the skill dir.
6. `skillStore.ts:1037-1044` mentions an agent `write_skill_file` tool that does not exist in the relay list.
7. `agent-server/index.ts:2-3` header says it runs "inside the Podman container" (stale); `agentSession.ts:833-835` comment claims sessions are persisted by a custom store at `/data/.academia/sessions/` (stale; transcripts are in `claude-config`).
8. `skills-knowledge-loop.md` header says "proposed, not approved, not implemented"; findings, import and the Knowledge page are implemented, but the `MEMORY.md` routing block and the `x-acabox-ledger` gate are not (no hits in `src`).
9. `ACABOX_ROSTER_BUDGET_FRACTION` (`shared/skills.ts:629`) is unused; `agent-server/index.ts:673` hardcodes `0.05`.
10. `FOCUS_MD` (`shared/paths.ts:46`) is read by nothing except migration 24 and hard reset (`db/database.ts:424`).
11. `ensembl-database` description points to a `kegg-database` skill that does not ship.
12. The 2026-09-30 review quotes an older identity line ("Never identify yourself as Claude"); current code says the opposite (`identityPreamble.ts:8`).

## KEY FACTS
- Workspace instructions are provisioned to .claude/CLAUDE.md with policy keep-local; settings.json and hooks use policy restore
  - evidence: src/cobuilding/main/skills.ts:214 "{ src: 'CLAUDE.md', dest: path.join('.claude', 'CLAUDE.md'), policy: 'keep-local' }," and :216 "{ src: 'settings.json', dest: path.join('.claude', 'settings.json'), policy: 'restore' },"
- Hook scripts are provisioned to .claude/hooks/*.sh with policy restore and mode 0o755
  - evidence: src/cobuilding/main/skills.ts:228-233 "dest: path.join('.claude', 'hooks', name), policy: 'restore', mode: 0o755,"
- The shipped settings.json registers exactly two PreToolUse hooks: Bash gets both scripts, Read|Edit|Write gets the secret guard
  - evidence: src/cobuilding/settings.json:5-23 "matcher": "Bash" ... "command": "bash .claude/hooks/block-host-installs.sh" ... "matcher": "Read|Edit|Write" ... "bash .claude/hooks/block-secret-reads.sh"
- Hook protocol: exit 2 denies, any other non-zero status is read by the CLI as allow, so scripts fail closed with explicit exit 2
  - evidence: src/cobuilding/hooks/block-host-installs.sh:28-32 "the script died under `set -e` with a status other than 2, which the CLI reads as \"allow\" — the guard was silently off"
- The secret hook reads tool_input.command and tool_input.file_path only and concatenates them; patterns are unanchored basenames
  - evidence: src/cobuilding/hooks/block-secret-reads.sh:66 command="$(json_field command) $(json_field file_path)" and :76-84 patterns 'cobuilding-settings\.json' 'claude-config' '\.claude\.json' 'agent\.json'
- Measured: a payload with only 'path' (PI's field name) makes the secret hook exit 0, and 'my-agent.json' is a false positive (exit 2)
  - evidence: Ran src/cobuilding/hooks/block-secret-reads.sh on {"tool_input":{"path":"/x/cobuilding-settings.json"}} -> exit 0; {"tool_input":{"file_path":"/ws/MyResearch/my-agent.json"}} -> exit 2
- Measured: path-qualified installs bypass the install hook (/usr/bin/pip install and .venv/bin/pip install exit 0) while 'uv pip install' and 'npm install -g' are blocked
  - evidence: Ran src/cobuilding/hooks/block-host-installs.sh: '/usr/bin/pip install pandas' -> 0; '.venv/bin/pip install pandas' -> 0; 'uv pip install x' -> 2; 'npm install -g docx' -> 2; boundary class (^|[^[:alnum:]_/.-]) at block-host-installs.sh:74
- The chat agent uses the claude_code preset with settingSources ['project'] and no tools restriction
  - evidence: src/cobuilding/main/controllers/AgentInfrastructureController.ts:497 "systemPrompt: { type: 'preset', preset: 'claude_code' }," and :511 "settingSources: ['project'],"
- System prompt append stack is soulMd, docxGuidance (host guidance), workspaceDirectoriesGuidance, apiGuidance, KNOWLEDGE_ROUTING_GUIDANCE joined by blank lines
  - evidence: src/cobuilding/agent-server/index.ts:511-517 "config.soulMd, config.docxGuidance, config.workspaceDirectoriesGuidance, config.apiGuidance, KNOWLEDGE_ROUTING_GUIDANCE," ; sessionConfig.ts:109 "docxGuidance: overrides?.hostGuidance ?? config.docxGuidance"
- Identity is 'built on Claude by Anthropic' in IDENTITY_PREAMBLE and the acabox skill; root CLAUDE.md workspace file has no identity line
  - evidence: src/cobuilding/main/identityPreamble.ts:8 "You are Acabox, a local research workbench that does the work and builds the tools, built on Claude by Anthropic." ; skills/acabox/SKILL.md:42-43 "I'm Acabox, built on Claude"
- SOUL.md is read from <agentDir>/.academia/SOUL.md and passed as soulMd in the create-session body
  - evidence: src/cobuilding/main/agentSession.ts:646 "const soulPath = path.join(containerService.getAgentDir() ?? workspace.directory_path, ACADEMIA_DIR, SOUL_MD);" and :841 "soulMd: soulMdContent,"
- Auto-memory, dream-off and roster budget are set through the SDK inline settings object
  - evidence: src/cobuilding/agent-server/index.ts:660-673 "autoMemoryEnabled: true, autoMemoryDirectory: `${getWorkspaceRoot()}/${AGENT_MEMORY_SUBDIR}`, ... autoDreamEnabled: false, ... skillListingBudgetFraction: 0.05,"
- The agent-memory dir is <workspace>/.academia/agent-memory and MEMORY.md is the CLI's index file
  - evidence: src/cobuilding/shared/paths.ts:25-26 "AGENT_MEMORY_DIR = 'agent-memory'; AGENT_MEMORY_SUBDIR = `${ACADEMIA_DIR}/${AGENT_MEMORY_DIR}`" and :36 "MEMORY_INDEX_FILE = 'MEMORY.md'"
- The bundled CLI injects a '# auto memory' section whose save protocol is: write a typed memory file with frontmatter, then add a one-line pointer to MEMORY.md (an index, not a memory)
  - evidence: node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude @191867500: "Saving a memory is a two-step process: **Step 1** — write the ... memory to its own file ... using this frontmatter format ... **Step 2** — add a pointer to that file in ... `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters"
- about_you.md and working_on.md are written raw by the scanner and Settings UI and are not linked from MEMORY.md
  - evidence: src/cobuilding/main/directoryScanner/agents/researchProfile.ts:201-207 fs.writeFile(path.join(memoryDir, MEMORY_FILE_ABOUT_YOU), result.about_you) ; docs/design/product-review-2026-09-30.md:160 "`MEMORY.md` never links `about_you.md`"
- academic-writing-agent wrongly claims about_you.md is auto-loaded by the harness
  - evidence: src/cobuilding/skills/academic-writing-agent/SKILL.md:56 "`about_you.md` is auto-loaded by the harness, so user-level grounding is still available."
- Production reliance on memory: 28 agent-written memory files and a 5.7 KB MEMORY.md loaded every turn (2026-09-30 review)
  - evidence: docs/design/review-2026-09-30/agent-capabilities.md:15 "production has 28 agent-written memory files with a 5.7 KB `MEMORY.md` loaded every turn, and 6 findings in `manage-mini-application`"
- Skill render is an absolute symlink per non-removed skill, including disabled ones, under .claude/skills
  - evidence: src/cobuilding/main/skillRender.ts:135 "fs.symlinkSync(target, link, 'dir');" ; :91-95 "Every non-removed skill, enabled or not."
- The skill store is <userData>/skills/<id>/ with index skills-state.json and trash skills-trash/
  - evidence: src/cobuilding/shared/skills.ts:47 "SKILLS_STORE_DIR = 'skills'" ; :54 "SKILLS_STATE_FILE = 'skills-state.json'" ; :60 "SKILLS_TRASH_DIR = 'skills-trash'" ; :71 SKILLS_RENDER_SUBDIR = `${CLAUDE_DIR}/${SKILLS_STORE_DIR}`
- Imports and unknown render/store directories arrive disabled; imports write enabled:false as a literal
  - evidence: src/cobuilding/main/skillStore.ts:1242 "enabled: false," inside registerImportedSkill; :665-667 "{ origin: 'custom', enabled: false, createdAt: nowIso() }"
- The roster allowlist passed as Options.skills is enabled store ids plus the bundled claude-api skill
  - evidence: src/cobuilding/shared/skills.ts:154 "BUNDLED_ALLOW: readonly string[] = ['claude-api'];" and :571-580 buildSkillRuntimeConfig
- Measured roster: 19 skills, all name==dir, max description 941 chars (xlsx), CLI-format roster 10,252 chars, PI XML roster about 14,725 chars
  - evidence: scratchpad/work-contextpack/measure-roster.js output: totalClaudeRosterChars 10252, totalPiRosterCharsApprox 14725, count 19, every row 'name==dir'
- PI reads context files only directly in a directory (AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD), from agent dir, cwd and every ancestor
  - evidence: PI-src/core/resource-loader.ts:185 "const candidates = [\"AGENTS.override.md\", \"AGENTS.md\", \"AGENTS.MD\", \"CLAUDE.md\", \"CLAUDE.MD\"];" ; :253 "while (true) {" ancestor walk in loadProjectContextFiles
- PI skill name is frontmatter name or parent directory name (CLI keys on dirent name)
  - evidence: PI-src/core/skills.ts:321 "const name = frontmatterName || parentDirName;" ; src/cobuilding/shared/skills.ts:19-25 "A skill's identity is its DIRECTORY name"
- PI injects every visible skill as XML with an absolute SKILL.md path and no budget; disabled-for-model skills are excluded
  - evidence: PI-src/core/skills.ts:358-390 formatSkillsForPrompt: "<available_skills>" ... "<location>${escapeXml(skill.filePath)}</location>" ; filter `!s.disableModelInvocation`
- PI default system preamble identifies as a coding assistant inside pi; custom prompt replaces preamble, tools, rules and docs sections
  - evidence: PI-src/core/system-prompt.ts:155-156 "You are an expert coding assistant operating inside pi, a coding agent harness." ; :152-153 "if (customPrompt) { promptSections.preamble = customPrompt; }"
- PI tool input fields: read/write/edit use 'path', bash uses 'command'; tool names are lowercase
  - evidence: PI-src/core/tools/read.ts:15 "path: Type.String({ description: \"Path to the file to read (relative or absolute)\" })" ; write.ts:12 path ; bash.ts:41 "command: Type.String({ description: \"Shell command to execute\" })" ; edit.ts:34 path
- PI default tools are read, bash, edit, write; sub-agents and plan mode are intentionally not shipped
  - evidence: PI-docs/settings.md:42 "| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write` |" ; PI README.md:19 "Pi ships with powerful defaults but skips features like sub-agents and plan mode."
- PI tool_call handlers can block with {block:true, reason} and a handler failure blocks (fail-safe)
  - evidence: PI-docs/extensions.md:263 "A `tool_call` handler failure blocks the tool as a fail-safe" ; :176 "return { block: true, reason: `${event.toolName} was not approved` };"
- PI relocates its agent dir via PI_CODING_AGENT_DIR and keeps auth.json, models.json, settings.json, mcp.json there
  - evidence: PI-docs/configuration.md:9 "Set its location with the `PI_CODING_AGENT_DIR` environment variable or the SDK's `agentDir` option." ; PI-src/config.ts:585 "ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`"
- PI project resources (.pi/settings.json, skills, extensions, SYSTEM.md) require project trust; non-interactive default 'ask' skips them
  - evidence: PI-docs/security.md:37-43,77-80 "`defaultProjectTrust: \"ask\"` or `\"never\"` skips them."
- PI DefaultResourceLoader exposes noSkills, noContextFiles, additionalSkillPaths, skillsOverride, agentsFilesOverride, systemPrompt, appendSystemPrompt
  - evidence: PI-src/core/resource-loader.ts:282-309 additionalSkillPaths?, noSkills?, noContextFiles?, systemPrompt?, appendSystemPrompt?: string[], skillsOverride?, agentsFilesOverride?
- Claude-specific tool names are baked into the auto-approve list (Bash, Read, Write, Edit, Glob, Grep, Agent, WebSearch, WebFetch, TodoWrite, Task*, ToolSearch, plan mode)
  - evidence: src/cobuilding/shared/agentAllowedTools.ts:44 "'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'," ; :48 "'WebSearch', 'WebFetch'," ; :57-62 TodoWrite/Task*/ToolSearch/EnterPlanMode/ExitPlanMode
- Locked folders are enforced as SDK permission deny rules on Edit/Write/NotebookEdit only; Bash is not blocked
  - evidence: src/cobuilding/shared/readOnlyRules.ts:35 "export const READ_ONLY_RULE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;" ; :26-28 "Shell writes (`Bash`) are NOT blocked by any of this"
- Headless CLI needs the API key pre-approved in .claude.json (last 20 chars)
  - evidence: src/cobuilding/shared/claudeConfigApproval.ts:21 "const entry = apiKey.slice(-20);" and :39-44 writes customApiKeyResponses.approved
- The findings read-watch matches Claude's Read tool and file_path field
  - evidence: src/cobuilding/main/agentSession.ts:1304-1305 "if (b.name !== 'Read') continue; const filePath = b.input?.file_path;"
- CLAUDE.md names run_in_background and TodoWrite and .claude/skills paths
  - evidence: src/cobuilding/CLAUDE.md:93 "every `run_in_background` Bash command goes with it" ; :105 "use the `TodoWrite` tool" ; :7 "To access skills: `.claude/skills/...`"
- database-lookup instructs the Claude Code native WebFetch tool; docs for gnomad/opentargets say WebFetch cannot reach POST-only APIs
  - evidence: src/cobuilding/skills/database-lookup/SKILL.md:36 "use WebFetch (Claude Code native) for GET endpoints" ; gnomad-database/SKILL.md:17
- manage-mini-application names Claude tools Monitor, ScheduleWakeup and NotebookEdit
  - evidence: src/cobuilding/skills/manage-mini-application/SKILL.md:107 "Do NOT use `Monitor`, `ScheduleWakeup`, or polling loops" ; :441 "using `NotebookEdit`"
- pptx skill mandates subagents and the Edit tool
  - evidence: src/cobuilding/skills/pptx/SKILL.md:165 "**⚠️ USE SUBAGENTS** — even for 2-3 slides." ; pptx/editing.md:125 "**Use the Edit tool, not sed or Python scripts.**"
- academic-writing-agent and docx instruct MCP tools that no longer exist in the app (ms-word, zotero, citeright)
  - evidence: src/cobuilding/skills/academic-writing-agent/actions/revise.md:32 "ToolSearch query: \"select:mcp__ms-word__find_and_replace,mcp__ms-word__get_selection,mcp__ms-word__get_text\"" ; grep of src (excluding skills) finds only two test files mentioning them
- docx SKILL.md references two scripts missing from the shipped skill
  - evidence: docx/SKILL.md:36 "python scripts/office/unpack.py" and :51 "python scripts/accept_changes.py"; filesystem check: MISSING scripts/accept_changes.py, MISSING scripts/office/unpack.py
- flow-cytometry encodes a Claude Glob-tool quirk and hardcodes .claude/skills script paths
  - evidence: src/cobuilding/skills/flow-cytometry/SKILL.md:25 "**Important:** Do NOT use Glob to find directories — it only matches files." ; :56 ".claude/skills/flow-cytometry/scripts/inspect_fcs.py"
- manage-mcp-server lists six reserved ids while code reserves seven (adds chats)
  - evidence: skills/manage-mcp-server/SKILL.md:99-100 "`activity`, `notification`, `mini-apps`, `workspace`, `knowledge`, `apis`" vs shared/connectors.ts:157-172 includes 'chats'
- Scanner agents use a second, in-process SDK hook set and CLI-only options
  - evidence: src/cobuilding/main/directoryScanner/shared.ts:275 "{ matcher: \"Read|Glob|Grep|mcp__document-reader__read_document\", hooks: [blockHiddenPaths, blockOutsideCwd] }" ; :197-216 tools, settingSources: [], persistSession: false
- Workspace root is <userData>/workspace-data, not cobuilding-workspace as root CLAUDE.md says
  - evidence: src/cobuilding/main/controllers/WorkspaceController.ts:85-87 "return path.join(app.getPath('userData'), WORKSPACE_DATA_DIR);" ; shared/paths.ts:9 "WORKSPACE_DATA_DIR = 'workspace-data'" ; dev profile ls shows workspace-data/
- Agent-server start config with raw API key is written to <userData>/agent.json at 0600, outside the workspace
  - evidence: src/cobuilding/main/containerService.ts:49-51 "path.join(app.getPath('userData'), 'agent.json')" and :507 "mode: 0o600"
- Dev profile workspace has .claude/{CLAUDE.md,settings.json,hooks,skills(19 symlinks)}, .applications/{_bridge,_reusable,_templates,_vendor,install}, .academia/{agent-memory,agent-server.js}, .mcp-servers, tool-data
  - evidence: ls ~/Library/Application Support/Acabox/development/workspace-data (names only) [MEASURED]
- The shipped context pack is delivered via extraResource: agent-server.js, skills, CLAUDE.md, settings.json, hooks
  - evidence: forge.config.js:114-129 extraResource ['dist/agent-server.js', ..., 'src/cobuilding/skills', 'src/cobuilding/CLAUDE.md', 'src/cobuilding/settings.json', 'src/cobuilding/hooks', ...]
- The MEMORY.md routing block and x-acabox-ledger gate described in the design doc were not built
  - evidence: grep -rn 'acabox:routing' src -> no hits; grep 'x-acabox-ledger' only in docs/design/skills-knowledge-loop.md:167

## RISKS
- Secret-read guard is silently inert if ported naively: PI tool payloads use 'path' (not 'file_path') and the grep/find tools carry 'pattern'; measured exit 0 on a path-only payload. The PI extension must scan path, pattern, command, and PI's own credential files (auth.json, models.json) after relocating the agent dir.
- Fail-open versus fail-closed inversion: the CLI treats any non-2 exit as allow (hence explicit exit 2 on parse failure), while a throwing PI tool_call handler blocks every call. A buggy ported guard can brick all bash/edit/write calls instead of silently allowing them.
- Context leakage into every Acabox PI chat: PI loads AGENTS.md/CLAUDE.md from every ancestor of the workspace up to '/', and skills from ~/.agents/skills; a developer's own ~/CLAUDE.md or ~/AGENTS.md would be injected. Must set noContextFiles/noSkills and supply explicit paths.
- Project-trust gating: anything placed under <workspace>/.pi/ (settings, skills, extensions, SYSTEM.md) is skipped in non-interactive modes unless trust is granted; skills or guards could be silently absent. Use agent-dir, additionalSkillPaths and inline extensionFactories.
- PI's default system preamble ('expert coding assistant operating inside pi') and docs section would conflict with the Acabox identity unless systemPrompt is replaced; replacing it also removes PI's tool/rule sections, so tool guidance must be re-supplied.
- Memory regression: production relies on CLI auto-memory (28 files, 5.7 KB MEMORY.md loaded each turn); PI has no memory feature. Without a replacement prompt section, MEMORY.md injection and write protocol, personalization and the Knowledge page memories silently stop accruing. KNOWLEDGE_ROUTING_GUIDANCE and the record_finding description presuppose the CLI memory section.
- Roster budget disappears: PI injects every visible skill description with absolute path (about 14.7K chars for 19 skills) and has no cap; imported catalogues (hundreds of skills) would be unbounded unless filtered through skillsOverride. The CLI silently truncating descriptions was the original failure mode being budgeted.
- Skill identity semantics differ (frontmatter name vs directory name): imported skills with mismatched names (62 of 607 in openai/plugins) change identity and may collide, undoing the 'never rewrite the file' design.
- Stale or dead instructions will produce failing tool calls on PI: Word/Zotero/CiteRight MCP tools in academic-writing-agent and docx; WebFetch/WebSearch in database-lookup and the acabox capability list; TodoWrite in CLAUDE.md; Monitor/ScheduleWakeup/NotebookEdit in manage-mini-application; subagents and 'Edit tool' in pptx; run_in_background in CLAUDE.md. PI has none of these built in.
- Self-modification surface: workspace instructions (keep-local), SOUL.md, memory and all skills are agent-writable by design; in PI an AGENTS.md at the workspace root is equally agent-writable. Hooks are protected today only by the restore policy because they live in the workspace; moving the guard in-process removes that need.
- Pre-existing hook/skill contradiction carries over: docx, pptx and pdf skills tell the agent to run raw npm/pip installs that the install hook blocks, while the .applications/install wrapper needs an existing --app directory and jq.
- Install hook has real bypasses (path-qualified pip/npm, npx, brew, poetry, uv add, R CMD INSTALL) and the secret hook has false positives (any file named *agent.json); porting verbatim preserves both.
- Vision-dependent flows (pdf form filling, pptx/docx visual QA) require an image-capable model; with a wider roster (OpenAI, OpenRouter) a non-vision model silently fails these skills.
- docx skill ships incomplete (missing unpack.py/accept_changes.py) and system binaries (pandoc, LibreOffice, poppler, qpdf, tesseract) are not shipped and cannot be installed by the agent; parity issues independent of harness.
- Provider-specific mini-app runtime (window.anthropicAPI, claude-haiku-5-5 default, Anthropic message shapes documented to the agent) will mislead the agent on a multi-provider build until the bridge is generalized.

## UNKNOWNS
- The exact text of the claude_code preset system prompt (tone, tool-usage policy, safety rules, environment block) could not be extracted cleanly from the bytecode-packed 240 MB CLI binary; the planner must decide which behaviours to restate for PI rather than copy.
- Whether PI's MCP extension names tools mcp__<server>__<tool> and how it handles OAuth/authenticate flows was not read (outside this task); Acabox prose, allowlists, omissionWatch and the hook message all assume the Claude naming.
- Whether PI's loader follows a symlinked directory supplied directly via additionalSkillPaths when the root path itself lives under a dot-directory (.claude/skills): code follows symlinked children and skips dot-prefixed children, but the root-as-symlink case was not executed.
- Whether PI's read tool can read PDFs/notebooks (Claude's Read does); only image output was seen in read.ts. Acabox skills tell the scanner agents the opposite for PDFs/docx.
- Whether the CLI under settingSources ['project'] also loads .claude/agents, .claude/commands and settings.local.json from the agent-writable workspace (inferred, not in repo); relevant only to how much of .claude/ a PI port must neutralize.
- Whether the CLI's relevance-recall selector (memdir_relevance, gate tengu_moth_copse) is active in the current 2.1.296 binary; measured not firing on older production transcripts only.
- Real production skills-state.json shape (22 built-ins, 6 custom per the 2026-09-30 review) vs the dev profile (19 builtin); no production files were read, so migration of existing user stores into an Acabox PI profile is unmeasured and may be moot if PI uses a fresh userData.
- How PI should receive subprocess env (COSCIENTIST_VENV_DIR, COSCIENTIST_NPM_PREFIX, NODE_PATH, PATH, ACABOX_API_BASE/TOKEN) for its bash tool: docs show spawnHook and PI_* session vars, but the host-spawn path was not exercised.
- Whether CLI-formatted frontmatter quirks (when_to_use concatenation, YAML repair pass) matter once PI parses frontmatter itself; no shipped skill uses when_to_use, but imported ones may.
- How many of the 8 dropped-integration references (Word/Zotero/CiteRight) the product owner wants kept as future PI tools versus deleted; the skills currently encode a Word-overlay workflow the fork nominally removed.
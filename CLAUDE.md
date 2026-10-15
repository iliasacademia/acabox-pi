# Acabox PI — engineering context

> Auto-loaded at the start of every Claude Code session in this repo, local or
> cloud. It is the handoff for whoever picks up next. Keep the "Status" and
> "Hazards" sections current when you finish a ticket.
>
> This is NOT the workspace-agent instructions (`src/cobuilding/CLAUDE.md`,
> read by the agent that runs *inside* the app).

## What this project is

Acabox PI is Acabox, the Electron app for scientists, with the Claude Agent SDK
replaced by the PI harness (pi.dev, `@earendil-works/pi-coding-agent`), so a
chat can run on an OpenAI, Anthropic or OpenRouter key, or on a ChatGPT plan
through Sign in with ChatGPT. It is a fork of `iliasacademia/acabox` at
`3f4ad5fe` (v0.1.31) with full history.

**The plan is `docs/design/acabox-pi-port-plan.md`. Read these parts before
any ticket:** the status line at the top, section 6's opening ("Where the work
runs"), the increment you are in, and the ticket itself. Section 9 holds the
owner's ten decisions; section 4 the design decisions D1–D15; section 2 the
measured facts. Evidence is in `docs/design/pi-port-research-2026-10-15/`
(the `co-scientist/` reports are deliberately not in git; a ticket that needs
one gets the section pasted into its prompt).

Acabox's own CLAUDE.md, with the full history of the original app, is at
`docs/history/acabox-claude-status-2026-10-15.md`. Its conventions and hazards
still apply to every file it describes.

## Where the work runs

- **Implementation runs in Claude Code cloud sessions** on this repo (Ubuntu
  24.04 x86_64, 16 GB). A ticket is done there when `npx tsc --noEmit` is
  clean, the Linux-safe test run is green, and the PR names the mac checks it
  needs. Until P0-09 lands, the Linux-safe run is plain `npm test` with these
  expected platform failures: `dictationHelper`, `fileMonitorIntegration`, the
  `sips` case in `attachmentAdapter`, and any suite gated on darwin.
- **Acceptance runs on a Mac** (the office Mac mini, `ssh fors-mac-mini`, or
  the owner's laptop): `claude --teleport <session-id>` from a clean checkout,
  then `npm test` in full, the smoke tests and the live CDP checks of plan
  section 10. Mac-only suites are tagged, never deleted or weakened.
- **Cloud environment settings** (claude.ai environment dialog): network
  Custom with the default list kept plus `api.openai.com`, `auth.openai.com`,
  `chatgpt.com`, `openrouter.ai`; variables `BASH_DEFAULT_TIMEOUT_MS=600000`
  and `PI_SKIP_VERSION_CHECK=1`; the provider keys as network secrets, never
  as variables (variables are visible to anyone using the environment; see
  plan P0-09); setup script `bash scripts/cloud-setup.sh`, set only after
  P0-09's PR lands. Secrets never go in the repo.
- **Mac mini rules** (plan P0-10): run jest with `--maxWorkers=2` (8 GB);
  quit Antigravity IDE before building; planned restarts go through
  `sudo fdesetup authrestart` (FileVault leaves a plainly rebooted mini
  unreachable until someone types the password at it).

## Conventions (carried over from Acabox)

- Dev mode is `npm start`; `npm start -- -- --smoke-test` boots main and exits
  0 (it never reaches the agent server). `npx tsc --noEmit` must be clean
  before committing.
- **Run tests with `npm test`, never bare `npx jest`**: the script runs jest
  under Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), which is the ABI
  `better_sqlite3.node` is built for. Electron 37 ships Node 22.17; measure
  platform behaviour with Electron's Node, not your shell's.
- Do not run `npm run package` for routine testing. A packaged, ad-hoc-signed
  build launched headlessly hangs in the keychain prompt; pass
  `--use-mock-keychain` for measurement only.
- Kill stray dev instances with `pkill -9 -f "Acabox-PI/node_modules/electron"`,
  never while `npm test` is running (jest runs inside that same binary).

## Hazards

- **Until P0-02 lands, `npm run fresh-install` and `npm run
  db:cobuilding:reset` delete the ORIGINAL Acabox install and database.** Do
  not run them on a machine that has Acabox.
- **Until P0-03 lands, the dev app still identifies as Acabox**: `npm start`
  uses Acabox's bundle id and writes to
  `~/Library/Application Support/acabox/development`, the same dev profile as
  Acabox. Prefer `npm test` and the smoke test on a machine that has Acabox.
- `.mcp.json` was deleted in P0-01 (a dev token for scripts that no longer
  exist). Do not recreate it.
- PI is ESM-only and the agent server is a webpack CJS bundle; see plan D2 and
  F8 before importing PI anywhere.

## Status

- **2026-10-15 — P0-01 done.** Fork with full history, plan and scrubbed
  archive committed, MIT licence, hygiene deletions (`.mcp.json`, the
  Claude review workflow, stale docs, `BUGS.md`,
  `OVERLAY_ARCHITECTURE_PLAN.md`), Acabox's CLAUDE.md moved to
  `docs/history/`. Verified on the laptop: `npm ci` 30 s, `npx tsc --noEmit`
  clean, `npm test` **2599/2599 across 163 suites** (8 tests and 1 suite
  skipped by their own guards), 35 s. Next: P0-09 (first cloud session),
  then P0-02…P0-08 in parallel sessions; P0-10 on the mini before
  increment 0's acceptance.

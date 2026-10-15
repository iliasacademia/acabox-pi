# Mac mini as the verification host (plan P0-10)

One-time, on the mini, in a Terminal of the logged-in GUI session:

```bash
gh auth login -h github.com -u iliasacademia      # interactive, once
mkdir -p ~/acabox-pi-ops && cd ~/acabox-pi-ops
curl -sSL https://raw.githubusercontent.com/iliasacademia/acabox-pi/main/scripts/mini/setup.sh -o setup.sh
curl -sSL https://raw.githubusercontent.com/iliasacademia/acabox-pi/main/scripts/mini/verify.sh -o verify.sh
nohup bash -c "bash setup.sh; bash verify.sh" > launcher.out 2>&1 < /dev/null &
```

`setup.sh` installs Rust, fnm + Node 25, ripgrep and fd, sets the git identity,
clones `acabox-pi` into `~/Documents/Dev Folders/Acabox-PI`, runs `npm ci`,
`tsc` and the full test suite with two workers. Log: `~/acabox-pi-ops/setup.log`.

`verify.sh` then runs for 16 hours: every 10 minutes it fetches, and for every
new commit on a non-main branch runs `npm ci`, `tsc`, the full Electron jest
suite and the smoke test, and posts the result as a comment on the branch's
PR. It never merges. Log: `~/acabox-pi-ops/verify.log`.

## Closed loop: the fix-up routine

When an open PR's head commit fails Mac verification, `verify.sh` fires a
Claude Code routine (API trigger) with the report as payload, once per commit,
at most 20 times. The routine fixes and pushes to the same branch; the mini
re-verifies on its next pass. Create the routine at claude.ai/code/routines
with repository `iliasacademia/acabox-pi`, the `Acabox` environment, an API
trigger, and this prompt:

> You are the fix-up routine for iliasacademia/acabox-pi. The
> routine-fire-payload block holds a Mac verification report from the office
> Mac mini for one commit (its branch and full sha are in it). Act on it:
> check out that branch at that commit, read CLAUDE.md and the "Where the work
> runs" section of docs/design/acabox-pi-port-plan.md, reproduce what you can
> on Linux (npx tsc --noEmit, then npm run test:linux if it exists, else
> npm test), and fix exactly the failures the report names: tsc errors and
> failing suites. A smoke-test failure whose output mentions the window
> server, a display, or a keychain is a background-launch artifact on the
> mini, not a code bug: note it in the commit message and do not change code
> for it. Never weaken, skip or delete a mac-only test to make it pass. Run
> tsc and the tests again, commit with a message starting "fix(mac-verify):",
> push to the same branch, and stop. Do not open a new PR and do not merge.
> If the report's result is GREEN, do nothing.

Then put the routine's URL and token on the mini, mode 600:

```bash
printf 'ROUTINE_URL=%s\nROUTINE_TOKEN=%s\n' '<fire url>' '<token>' > ~/acabox-pi-ops/routine.env && chmod 600 ~/acabox-pi-ops/routine.env
```

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

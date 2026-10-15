#!/bin/bash
# Acabox PI verifier: every 10 minutes for 16 hours, verify every new commit on every
# non-main branch (npm ci, tsc, full Electron jest, smoke test) and post the result as a
# comment on its PR. It never merges; the owner merges after reading the comment.
OPS="$HOME/acabox-pi-ops"; exec >> "$OPS/verify.log" 2>&1
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"; eval "$(fnm env --shell bash)"; fnm use 25 >/dev/null 2>&1
cd "$HOME/Documents/Dev Folders/Acabox-PI" || exit 1
touch "$OPS/verified" "$OPS/handled"
END=$(( $(date +%s) + 16*3600 ))
echo "=== verifier start $(date), node $(node --version)"
while [ "$(date +%s)" -lt "$END" ]; do
  git fetch -q --prune origin 2>/dev/null
  for ref in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -vE '^origin/(main|HEAD)$'); do
    sha=$(git rev-parse "$ref"); br=${ref#origin/}; short=${sha:0:10}
    grep -q "^$sha " "$OPS/verified" && continue
    echo "=== $(date '+%H:%M') verifying $br @ $short"
    git checkout -q --detach "$sha" || { echo "$sha checkout-failed" >> "$OPS/verified"; continue; }
    if ! npm ci --no-audit --no-fund > "$OPS/ci.$short.out" 2>&1; then
      echo "$sha FAILED npm-ci" >> "$OPS/verified"; echo "npm ci failed"; continue; fi
    tsc_ok=0; npx tsc --noEmit > "$OPS/tsc.$short.out" 2>&1 && tsc_ok=1
    npm test -- --silent --maxWorkers=2 > "$OPS/test.$short.out" 2>&1; test_rc=$?
    summary=$(grep -E "^Tests:|^Test Suites:" "$OPS/test.$short.out" | tr '\n' ' ')
    perl -e 'alarm 1200; exec @ARGV' npm start -- -- --smoke-test > "$OPS/smoke.$short.out" 2>&1; smoke_rc=$?
    pkill -9 -f "Acabox-PI/node_modules/electron" 2>/dev/null
    status=FAILED; [ $tsc_ok = 1 ] && [ $test_rc = 0 ] && status=GREEN
    echo "$sha $status" >> "$OPS/verified"
    echo "tsc=$tsc_ok test_rc=$test_rc smoke_rc=$smoke_rc :: $summary"
    # commit status so the cloud side (auto-fix / a routine) sees a pass or fail on this sha
    gstate=failure; [ "$status" = GREEN ] && gstate=success
    gdesc="tsc $([ $tsc_ok = 1 ] && echo ok || echo FAIL); $summary smoke rc=$smoke_rc"
    gh api -X POST "repos/iliasacademia/acabox-pi/statuses/$sha" -f state="$gstate" -f context="mac-mini/verify" -f description="${gdesc:0:130}" >/dev/null 2>&1 && echo "status $gstate posted for $short"
  done
  # PRs: one comment per head sha with the stored result
  gh pr list --state open --json number,headRefName,headRefOid --jq '.[] | "\(.number) \(.headRefOid) \(.headRefName)"' 2>/dev/null | while read -r num hsha hbr; do
    line=$(grep "^$hsha " "$OPS/verified" | tail -1); [ -z "$line" ] && continue
    grep -q "^$hsha " "$OPS/handled" && continue
    st=$(echo "$line" | awk '{print $2}'); hs=${hsha:0:10}
    body="Mac mini verification of $hs on \`$hbr\` ($(date '+%Y-%m-%d %H:%M %Z'); M1, 8 GB, Node $(node --version)):
- tsc: $([ -s "$OPS/tsc.$hs.out" ] && echo 'errors, see below' || echo clean)
- npm test under Electron, 2 workers: $(grep -E '^Tests:|^Test Suites:' "$OPS/test.$hs.out" 2>/dev/null | tr '\n' ' ')
- smoke test (\`npm start -- -- --smoke-test\`, launched from a background process over SSH): $(tail -1 "$OPS/smoke.$hs.out" 2>/dev/null | cut -c1-160)

Result: **$st**. Not merged: the owner merges after reading this."
    [ -s "$OPS/tsc.$hs.out" ] && body="$body

tsc:
\`\`\`
$(head -15 "$OPS/tsc.$hs.out")
\`\`\`"
    grep -qE '^FAIL' "$OPS/test.$hs.out" 2>/dev/null && body="$body

failing suites:
\`\`\`
$(grep -E '^FAIL|●.*›' "$OPS/test.$hs.out" | head -20)
\`\`\`"
    gh pr comment "$num" --body "$body" >/dev/null 2>&1 && echo "commented on #$num ($st)"
    echo "$hsha $st" >> "$OPS/handled"
  done
  git checkout -q main 2>/dev/null
  sleep 600
done
echo "=== verifier end $(date)"

#!/bin/bash
# Acabox PI verifier (Mac mini): every 10 minutes for 16 hours, verify every new commit on every
# non-main branch (npm ci, tsc, full Electron jest, smoke test), post a mac-mini/verify commit
# status, comment the result on the branch's PR, and on a FAILED PR head fire the fix-up routine
# (once per commit, cap 20). It never merges; the owner merges after reading the comment.
OPS="$HOME/acabox-pi-ops"; exec >> "$OPS/verify.log" 2>&1
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"; eval "$(fnm env --shell bash)"; fnm use 25 >/dev/null 2>&1
REPO=iliasacademia/acabox-pi
cd "$HOME/Documents/Dev Folders/Acabox-PI" || exit 1
touch "$OPS/verified" "$OPS/handled"
END=$(( $(date +%s) + 16*3600 ))
echo "=== verifier start $(date), node $(node --version)"
while [ "$(date +%s)" -lt "$END" ]; do
  git fetch -q --prune origin 2>/dev/null
  for ref in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -vE '^origin(/main|/HEAD)?$'); do
    sha=$(git rev-parse "$ref"); br=${ref#origin/}; short=${sha:0:10}
    grep -q "^$sha " "$OPS/verified" && continue
    echo "=== $(date '+%H:%M') verifying $br @ $short"
    git checkout -q --detach "$sha" || { echo "$sha FAILED checkout" >> "$OPS/verified"; continue; }
    R="$OPS/result.$short.md"
    if ! npm ci --no-audit --no-fund > "$OPS/ci.$short.out" 2>&1; then
      printf -- '- npm ci: FAILED\n```\n%s\n```\n' "$(grep -E 'npm error' "$OPS/ci.$short.out" | head -8)" > "$R"
      echo "$sha FAILED npm-ci" >> "$OPS/verified"; echo "npm ci failed"; continue
    fi
    tsc_ok=0; npx tsc --noEmit > "$OPS/tsc.$short.out" 2>&1 && tsc_ok=1
    npm test -- --silent --maxWorkers=2 > "$OPS/test.$short.out" 2>&1; test_rc=$?
    summary=$(grep -E "^Tests:|^Test Suites:" "$OPS/test.$short.out" | tr '\n' ' ')
    perl -e 'alarm 1200; exec @ARGV' npm start -- -- --smoke-test > "$OPS/smoke.$short.out" 2>&1; smoke_rc=$?
    pkill -9 -f "Acabox-PI/node_modules/electron" 2>/dev/null
    smoke_err=$(grep -m1 -E "Error|error:|Cannot|EADDRINUSE|window server|keychain" "$OPS/smoke.$short.out" | cut -c1-220)
    status=FAILED; [ $tsc_ok = 1 ] && [ $test_rc = 0 ] && [ $smoke_rc = 0 ] && status=GREEN
    {
      echo "- tsc: $([ $tsc_ok = 1 ] && echo clean || echo 'errors, see below')"
      echo "- npm test under Electron, 2 workers: $summary"
      echo "- smoke test (\`npm start -- -- --smoke-test\`, 20-min cap, launched from a background process over SSH): exit $smoke_rc$( [ $smoke_rc = 142 ] && echo ' (timed out: the app did not quit)' )$( [ -n "$smoke_err" ] && printf '; first error line: `%s`' "$smoke_err" )"
      [ $tsc_ok = 1 ] || printf '\ntsc:\n```\n%s\n```\n' "$(head -15 "$OPS/tsc.$short.out")"
      [ $test_rc = 0 ] || printf '\nfailing suites:\n```\n%s\n```\n' "$(grep -E '^FAIL|●.*›' "$OPS/test.$short.out" | head -20)"
    } > "$R"
    echo "$sha $status" >> "$OPS/verified"
    echo "tsc=$tsc_ok test_rc=$test_rc smoke_rc=$smoke_rc :: $summary"
    gstate=failure; [ "$status" = GREEN ] && gstate=success
    gdesc="tsc $([ $tsc_ok = 1 ] && echo ok || echo FAIL); tests rc=$test_rc; smoke rc=$smoke_rc; $summary"
    gh api -X POST "repos/$REPO/statuses/$sha" -f state="$gstate" -f context="mac-mini/verify" -f description="${gdesc:0:130}" >/dev/null 2>&1 && echo "status $gstate posted for $short"
  done
  gh pr list --state open --json number,headRefName,headRefOid --jq '.[] | "\(.number) \(.headRefOid) \(.headRefName)"' 2>/dev/null | while read -r num hsha hbr; do
    line=$(grep "^$hsha " "$OPS/verified" | tail -1); [ -z "$line" ] && continue
    grep -q "^$hsha " "$OPS/handled" && continue
    st=$(echo "$line" | awk '{print $2}'); hs=${hsha:0:10}
    body="Mac mini verification of $hs on \`$hbr\` ($(date '+%Y-%m-%d %H:%M %Z'); M1, 8 GB, Node $(node --version)):
$(cat "$OPS/result.$hs.md" 2>/dev/null)
- commit: $hsha

Result: **$st**. Not merged: the owner merges after reading this."
    gh pr comment "$num" --body "$body" >/dev/null 2>&1 && echo "commented on #$num ($st)"
    if [ "$st" = FAILED ] && [ -s "$OPS/routine.env" ]; then
      . "$OPS/routine.env"
      if [ "$(grep -c '^fire ' "$OPS/handled")" -lt 20 ] && [ -n "${ROUTINE_URL:-}" ] && [ -n "${ROUTINE_TOKEN:-}" ]; then
        payload=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')
        code=$(curl -s -o "$OPS/fire.$hs.out" -w '%{http_code}' -X POST "$ROUTINE_URL" -H "Authorization: Bearer $ROUTINE_TOKEN" -H "anthropic-beta: experimental-cc-routine-2026-04-01" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" -d "$payload")
        echo "fire $hsha http $code" >> "$OPS/handled"; echo "fired fix-up routine for $hs: http $code"
      fi
    fi
    echo "$hsha $st" >> "$OPS/handled"
  done
  git checkout -q main 2>/dev/null
  sleep 600
done
echo "=== verifier end $(date)"

#!/bin/bash
# Acabox PI: one-time setup of the Mac mini as the verification host (plan P0-10).
OPS="$HOME/acabox-pi-ops"; mkdir -p "$OPS"; exec >> "$OPS/setup.log" 2>&1
echo "=== setup start $(date)"
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal 2>&1 | tail -2
fi
command -v cargo && cargo --version
brew install fnm ripgrep fd 2>&1 | tail -3
eval "$(fnm env --shell bash)"; fnm install 25 2>&1 | tail -1; fnm use 25; node --version; npm --version
git config --global user.name "Ilias Beshimov"; git config --global user.email "ilias@academia.edu"
if [ -s "$OPS/.ghtoken" ]; then gh auth login --with-token < "$OPS/.ghtoken" && rm -f "$OPS/.ghtoken"; fi
gh auth switch -u iliasacademia 2>&1 | tail -1; gh auth setup-git 2>&1 | tail -1; gh auth status 2>&1 | grep -E "Logged in|Active account"
mkdir -p "$HOME/Documents/Dev Folders"; cd "$HOME/Documents/Dev Folders" || exit 1
[ -d Acabox-PI/.git ] || git clone -q https://github.com/iliasacademia/acabox-pi.git Acabox-PI
cd Acabox-PI && git checkout -q main && git pull -q && git log --oneline -1
echo "--- npm ci"; npm ci --no-audit --no-fund 2>&1 | tail -2
echo "--- tsc"; npx tsc --noEmit && echo "tsc clean"
echo "--- npm test (2 workers)"; npm test -- --silent --maxWorkers=2 2>&1 | grep -E "^Tests:|^Test Suites:"
echo "=== setup done $(date)"

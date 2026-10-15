#!/usr/bin/env bash
# Cloud environment setup script (claude.ai environment dialog: `bash scripts/cloud-setup.sh`).
# Installs Electron's Linux runtime libraries (needed even under ELECTRON_RUN_AS_NODE), then npm ci.
set -euo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y
$SUDO apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 \
  libasound2t64 libxss1 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 xvfb

cd "$(dirname "$0")/.."
npm ci

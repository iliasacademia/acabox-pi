# Bundled search tools (macOS arm64)

PI's `grep` and `find` tools look for `rg` and `fd` on PATH before trying to
download them. Acabox PI ships both so no first-use download is needed.

| Tool | Version | Source | sha256 of the release archive |
|---|---|---|---|
| ripgrep (`rg`) | 15.1.0 | https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0 (`ripgrep-15.1.0-aarch64-apple-darwin.tar.gz`) | 378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715 |
| fd | 10.3.0 | https://github.com/sharkdp/fd/releases/tag/v10.3.0 (`fd-v10.3.0-aarch64-apple-darwin.tar.gz`) | 0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904 |

Licences: ripgrep is MIT or Unlicense, fd is MIT or Apache-2.0 (texts alongside).
Both are Mach-O arm64 and run only on Apple Silicon; `main/bundledBin.ts` adds this
directory to PATH only on darwin/arm64 and otherwise falls through to the user's PATH.
Shipped to `<Resources>/bin` via forge `extraResource`.

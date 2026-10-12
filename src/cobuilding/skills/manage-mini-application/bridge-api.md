# Bridge API Reference

The scaffolded `index.tsx` imports a bridge that sets up `window.filesAPI`, `window.kernel`, and `window.hostAPI` as postMessage wrappers. The mini-app can use these to communicate with the electron app.

Everything below runs **on the user's machine**. Acabox has no container — the kernel, `hostAPI.exec`, and every installed package live in the user's home directory.

## Kernel API (primary — for notebook-backed computation)

- `window.kernel.connect(kernelName)` — Connect to a Jupyter kernel. Pass `"python3"`. Starts the kernel gateway automatically if needed (a host process from Acabox's Python venv).
- `window.kernel.executeCode(code)` — Execute code in the connected kernel. Returns an array of cell outputs, each with an `output_type` field:
  - `"stream"` — stdout/stderr text (`name`, `text` fields)
  - `"execute_result"` — result data (`data`, `metadata`, `execution_count` fields)
  - `"display_data"` — display data like images (`data`, `metadata` fields)
  - `"error"` — execution error (`ename`, `evalue`, `traceback` fields)

## Files API

- `window.filesAPI.readFile(path)` — Read a file from the host filesystem. Returns a discriminated union — you must check the shape before using:
  - `{ type: "text", content: string }` — text file (most things you'll touch)
  - `{ type: "image", fileUrl: string }` — image; use `fileUrl` as an `<img src>`
  - `{ error: "too-large", size: number }` — file exceeded the 10 MB limit; nothing was read
  Common bug: `parseCsv(await window.filesAPI.readFile(path))` passes the whole object instead of `.content`. For input slots managed by `useAppState`, prefer `readInput(slot)` which extracts the text for you.
- `window.filesAPI.writeFile(path, content)` — Write a file.
- `window.filesAPI.copyFile(sourcePath, destinationDir)` — Copy a file (typically a host-absolute path returned by `selectFile`) into a workspace directory. Creates the destination directory if missing. The copy lands at `destinationDir/<basename>`. This is the right primitive for "snapshot the user's input file into the app folder so it stays available later" — `useAppState`'s `selectInput` is built on top of it.
- `window.filesAPI.deleteFile(path)` — Recursively delete a file or directory inside the workspace. Used by `useAppState`'s `selectInput` / `clearInput` to wipe the previous file in an input slot before copying the new one.
- `window.filesAPI.downloadFile(filename, content)` — Download a file to the user's computer. Shows a native save dialog with the suggested filename. The `content` is a string (use `JSON.stringify()` for objects, or generate CSV/TSV text directly).
- `window.filesAPI.showInFinder(path)` — Open the containing folder in the OS file manager and highlight the item. The `path` must be a relative workspace path.
- `window.filesAPI.selectFile(filters?)` — Open native file picker dialog. Returns the selected absolute path or `null`.
- `window.filesAPI.selectDirectory()` — Open native directory picker. Returns the selected path.
- `window.filesAPI.readDirectory(path)` — List directory contents. Returns `{ name, isDirectory }[]`.

## Host API (alternative — for one-shot script execution)

- `window.hostAPI.exec(command, args)` — Run a command as a child process on the user's machine and return `{ stdout, stderr, exitCode }`. Use this for one-shot script execution that doesn't need kernel state; use `window.kernel` when state has to persist between runs.

  ```typescript
  const { stdout, stderr, exitCode } = await window.hostAPI.exec(
    "python3",
    [".applications/myApp/scripts/analyze.py", "--input", "input/data.csv"],
  );
  ```

  - **Working directory is the workspace root**, so relative paths work for both app files (`.applications/<dir_name>/…`) and the user's shared research folders (`MyResearch/data.csv`). Do not pass absolute paths.
  - **PATH includes Acabox's Python venv and npm prefix**, so `python3` and anything installed via `.applications/install` resolves by bare name. Nothing else is guaranteed — this is the user's own machine, not a fixed image, so probe with `command -v <binary>` before depending on a tool you did not install.
  - **`exitCode: 127` means the process never launched** (binary not found or not executable) — `stderr` names it. Any other non-zero value is the command's real exit status. Distinguishing the two matters: 127 is a missing dependency, not a failed analysis.
  - Timeout is 10 minutes; combined stdout+stderr is capped at 50 MB.

  `window.containerAPI` is a deprecated alias for the same object, left over from when Acabox ran a Podman container. Use `window.hostAPI` in new code.

- `window.hostAPI.fileUrl(relPath)` — Build a URL for an `<img>`/`<a>`/`<video>` `src` or `href` that points at a workspace file, e.g. a plot written to `output/`. Pass the same workspace-relative path you'd give `filesAPI.readFile`:

  ```tsx
  <img src={window.hostAPI.fileUrl(`.applications/${dirName}/output/plot.png`)} alt="Plot" />
  ```

  This is the **only** sanctioned way to build such a URL — never hand-build `` `local-file://${window.getWorkspacePath()}/...` `` yourself. Locally it resolves to a `local-file://` URL; if this app is later published as a read-only shared snapshot (see the sharing feature) there is no workspace on disk and no `local-file://` scheme at all, and `fileUrl` instead returns a plain relative URL the shared viewer can serve. Routing through `fileUrl` is what makes the same `<img>` tag work in both places with no branching in your code.

## APIs (external HTTP services the user has configured)

`window.hostAPI.api.fetch(apiId, path, init?)` calls an HTTP API that the user
registered in **Settings → APIs**. Acabox holds the credential and attaches it
on the way out, so the tool never sees a key and **must never ask the user to
paste one into a field**.

```typescript
const res = await window.hostAPI.api.fetch('ncbi', 'esearch.fcgi?db=pubmed&term=crispr&retmode=json');
if (res.ok) {
  const data = JSON.parse(res.body!);
} else {
  // `res.error` is set when ACABOX refused, not the service.
  console.error(res.error ?? `HTTP ${res.status}`);
}
```

- `init` takes `{ method, headers, body }`. `body` is a string — `JSON.stringify`
  it yourself and set `content-type`.
- `res` is `{ ok, status, headers, body, error }`. `ok` is a 2xx from the
  service; a refusal by Acabox is never `ok`.
- **Two things must be true before a call works**: the user has configured that
  API, *and* has granted it to this tool in the tool's Settings panel. Without
  the grant every call returns 403 naming the tool. That is a decision for the
  user to make in the UI — say so rather than trying another route.
- A `405` means the API is read-only in the user's settings. A `403` naming a
  host means the request or a redirect went somewhere off that API's allow list.
- **The body is a string, and there is no streaming.** For a large or binary
  download, ask the agent instead — it reaches the same proxy over HTTP and can
  stream straight to disk.

Design a tool so a missing API degrades gracefully: check `res.error` and show
the user what to configure, rather than rendering an empty chart.

## Anthropic API

Call Claude from within a mini-app. The API key is managed by the host — it is never exposed to the iframe.

- `window.anthropicAPI.complete(params)` — Single request/response. Returns a full `AnthropicMessage` once the model finishes.
- `window.anthropicAPI.stream(params, onChunk)` — Streaming. Calls `onChunk(text)` for each text delta as it arrives, then resolves with the final `AnthropicMessage`.

**`params` fields:**
- `messages` *(required)* — `Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>`
- `model` *(optional)* — defaults to `"claude-haiku-5-5"`, with thinking off. A model you name explicitly may think first: its reply can start with `thinking` blocks, so always read the answer by block type (below), never as `content[0]`.
- `max_tokens` *(optional)* — defaults to `1024`
- `system` *(optional)* — system prompt string

**Content blocks** (when `content` is an array):
- `{ type: "text", text: "..." }` — text content
- `{ type: "image", source: { type: "file", path: "./data/photo.png" } }` — image from workspace file (png, jpg, gif, webp)
- `{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }` — inline base64 image (e.g. from canvas export)
- `{ type: "document", source: { type: "file", path: "./data/report.pdf" }, title?: "..." }` — PDF from workspace file
- `{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "..." }, title?: "..." }` — inline base64 PDF

Only `file` and `base64` source types are supported. URL sources are not allowed. File paths are resolved relative to the workspace directory.

**Examples:**
```typescript
// Non-streaming (text only)
const msg = await window.anthropicAPI.complete({
  messages: [{ role: 'user', content: 'Summarize this in one sentence: ...' }],
});
console.log(msg.content.find((b) => b.type === "text")?.text ?? "");

// Streaming
let output = '';
await window.anthropicAPI.stream(
  { messages: [{ role: 'user', content: 'Explain CRISPR step by step.' }] },
  (chunk) => { output += chunk; setDisplayText(output); },
);

// Send an image for analysis
const msg = await window.anthropicAPI.complete({
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'file', path: './data/chart.png' } },
      { type: 'text', text: 'Describe what this chart shows.' },
    ],
  }],
});

// Send a PDF for analysis
const msg = await window.anthropicAPI.complete({
  messages: [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'file', path: './data/paper.pdf' }, title: 'Research Paper' },
      { type: 'text', text: 'Summarize the key findings.' },
    ],
  }],
});
```

## Utilities

- `window.getWorkspacePath()` — Returns the filesystem path of the workspace. Use this to convert absolute paths (from file pickers) to relative workspace paths: `"./" + hostPath.slice(workspacePath.length + 1)`. Store and pass relative paths everywhere — `filesAPI`, `hostAPI.exec`, `hostAPI.fileUrl`, and the kernel all resolve them against the workspace root.

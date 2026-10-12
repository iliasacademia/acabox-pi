---
name: manage-mini-application
description: >
  PRIORITY SKILL: Invoke this skill BEFORE any analysis or data-processing 
  skills whenever the user's PRIMARY intent is to build, create, make, develop, 
  or update an application, tool, dashboard, or UI — even if the request 
  mentions scientific methods like differential expression, PCA, or clustering. 
  Those methods describe what the app should do internally, not what you should 
  execute now. DO NOT run analysis skills as a prerequisite step.

  Use this skill when the user says things like: "make an app", "build a tool", 
  "create an interface", "I want a UI for X", "develop a dashboard", or 
  "update/edit/change the app".

  Do NOT use this skill when the user wants to directly run an analysis on 
  their data with no mention of building a UI or application.
---

# Manage Mini-Application

Each mini-app lives under `.applications/<lowerCamelCaseName>`. The agent writes `src/App.tsx`, optionally creates a backing Jupyter notebook, and compiles with esbuild.

## Creating a mini-app

### Step 1: Scaffold the directory

```bash
node \
  .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "<display name>" \
  --description "<one-line description>" \
  --icon "<lucide icon name>" \
  [--template "<template name>"]
```

`--description` and `--icon` are required and populate `manifest.json` (see below).

- **description**: a short, one-line summary (≤ 80 chars) of what the app does, shown under the title on the Tools page. Write it for the user, not the agent.
- **icon**: a [Lucide](https://lucide.dev/icons) icon name in PascalCase (e.g. `FlaskConical`, `LineChart`, `Microscope`, `Dna`, `Beaker`, `Image`, `Table`, `BarChart3`). Pick one that visually matches what the app does — the Tools page renders it as the app's icon.

The script prints `{ name, dir_name, dir }` to stdout and creates:
- `<dir>/src/index.html` — HTML shell: the Acabox design system (`_vendor/acabox.css` — fonts, tokens, `ab-*` classes), Tailwind, and a Tailwind config that maps the tokens onto class names. You should not need to edit it.
- `<dir>/src/index.tsx` — React mount boilerplate with error boundary
- `<dir>/dist/` directory, plus `<dir>/output/` and `<dir>/input/` — these two are symlinks into `tool-data/<dir_name>/`, a **durable** data area that is preserved when the tool is deleted (deleting a tool only removes its code dir). Keep writing to `.applications/<dir_name>/input|output/...` as usual; the paths are unchanged and resolve through the symlinks. Do **not** write user data loosely into `<dir>/` itself — that is code and is destroyed on delete.
- `<dir>/notebook.ipynb` — canonical notebook with a `parameters` cell + cobuild metadata; kernel is `python3` (the only one Acabox has; R is not available)
- `<dir>/manifest.json` — `{ name, description, icon, lastOpened }`. The Tools page uses `name` as the title, `description` as the subtitle, `icon` to render the app's Lucide icon, and orders apps by `lastOpened` (most recent first). `lastOpened` is initialized to the current time when the app is created and is updated by the host each time the app is opened — do not set it yourself.

If you later edit an app's purpose, also update `manifest.json` (name/description/icon) so the Tools page stays in sync.

### Publishing an MCP server from a mini-app

A mini-app can optionally expose tools that other mini-apps and the agent itself can call. Declare them in `manifest.json` under an `mcp` key:

```json
{
  "name": "Variant Annotator",
  "description": "Annotates a list of genomic variants",
  "icon": "Dna",
  "mcp": {
    "server_name": "variant-annotator",
    "tools": [
      {
        "name": "annotate",
        "description": "Annotate a list of variants with gene + clinical significance.",
        "input_schema": {
          "type": "object",
          "properties": {
            "variants": { "type": "array", "items": { "type": "string" }, "description": "rsIDs or chrom:pos:ref:alt" }
          },
          "required": ["variants"]
        }
      }
    ]
  }
}
```

The MCP server registers as soon as the mini-app's iframe loads and unregisters when it closes. While loaded:

- Other mini-apps invoke its tools via `window.coscientist.callMcpTool(serverName, toolName, args)` (or the bridge `mcp:callTool`).
- The agent invokes them via `mcp__mini-apps__list_published_servers` and `mcp__mini-apps__call_published_tool`.

To handle inbound invocations, the mini-app listens for `{ type: 'mcp:invoke', invocationId, toolName, args }` postMessages and responds with `{ type: 'mcp:result', invocationId, result }` (or `error`). Wrap this in a small handler in `index.tsx`:

```ts
window.addEventListener('message', async (event) => {
  if (event.data?.type !== 'mcp:invoke') return;
  const { invocationId, toolName, args } = event.data;
  try {
    const result = await myToolImplementations[toolName](args);
    window.parent.postMessage({ type: 'mcp:result', invocationId, result }, '*');
  } catch (err) {
    window.parent.postMessage({ type: 'mcp:result', invocationId, error: String(err) }, '*');
  }
});
```

Tool names must match `[A-Za-z0-9_]+`, server names `[A-Za-z0-9_-]+`. Keep `description` and `input_schema` accurate — those are what other callers see.

If `--template` is specified, the template tree at `.applications/_templates/<name>/` is mirrored into the new app — anything inside `<template>/src/` lands in the new app's `src/`, anything else lands at the app root. So a template can ship `src/App.tsx`, `notebook.ipynb`, `scripts/foo.py`, `requirements.txt`, `setup/*.sh`, etc., and each file ends up where it belongs.

**Dependencies install asynchronously — do not wait for them.** The host has a BackgroundBuilder that watches `.applications/<app>/requirements.txt`, `package.json`, and `setup/*.sh`. The moment those files appear it runs the install, into Acabox's own Python venv and npm prefix, which persist across restarts. Templates therefore declare both their code and their installable dependencies (including model-checkpoint downloads written as idempotent `setup/*.sh` scripts), and the install pipeline picks them up automatically — no agent action required.

**Hard rules for the agent when scaffolding from a template:**

- Do NOT run `.applications/install` yourself — BackgroundBuilder is already running it. A second concurrent install races for bandwidth and slows everything down.
- Do NOT use `Monitor`, `ScheduleWakeup`, or polling loops to wait for installs to finish. A cold install can take 5–15 minutes; blocking the chat turn on it produces a bad UX (silent agent, opaque "thinking" state).
- After running the manage script, immediately call `build_and_open_mini_application` — it runs esbuild and opens the app in one atomic tool call.
- The mini-app's own "Installing software…" view surfaces live install progress to the user when they open the app — they will see it there, not in the chat. Tell the user once that you've opened the app and that deps are still installing in the background, and let the in-app UI take over from there.

Each template also ships with a colocated `template.md` describing its parameters, output contract, and design rationale; read that before editing the template's code. The `template.md` itself is excluded from the per-app copy. Available templates:

- `westernBlotAnnotator` — interactive Western blot annotation: GelGenie-based band/lane detection, LLM-assisted band filtering, click-to-edit labels, and PNG figure export. Ships with a Python pipeline and a `setup/download_model.sh` that pulls the TorchScript GelGenie checkpoint from HuggingFace. See `.applications/_templates/westernBlotAnnotator/template.md`.

### Step 2: Write `src/App.tsx`

Write the React component to `<dir>/src/App.tsx`, **as your very next action after Step 1**. The tool card is visible to the user from the moment the scaffold runs; until this file exists the viewer shows "Claude is still writing this tool" and builds it automatically once the file lands. Do not run other exploration between the two steps, and do not spend minutes composing one giant file when the app can be written as `App.tsx` plus a small `data.ts`/`types.ts` — the first file on disk is what turns the waiting screen into a running tool.

Available packages (already installed — import them directly, no wrapper call needed):
- `react`, `react-dom`
- `react-plotly.js` — Plotly charts. See the **react-plotly** skill (`.claude/skills/react-plotly/SKILL.md`) for responsive container patterns, design system, trace types, and complete examples.
- `lucide-react` — Icons
- `@reusable` — Shared building blocks. Resolved via esbuild alias to `.applications/_reusable/`. **Compose these instead of writing your own — they are how the framework enforces consistent behavior across apps.**
  - **State**: `useAppState` (params + inputs + outputs + runResult, all persisted to the notebook).
  - **Kernel runs**: `useKernelAction` (connect, inject params, execute action cell, surface errors).
  - **Recovering a run that outlived the UI**: `useRunsWhileClosed` (see below).
  - **UI building blocks**: `<FileSlotPicker>`, `<RunButton>`, `<RunStateBadge>`, `<OutputFileList>`, `<VolcanoPlot>`, `<MAPlot>`, `<ErrorDisplay>` (auto-mounted by the scaffolded `index.tsx`; do not add a second one).
  - **Chart theme**: `plotTheme` — `ACABOX_LAYOUT`, `ACABOX_AXIS`, `ACABOX_CONFIG`, and the validated palettes. Import these instead of choosing chart colours.
  - **Utilities**: `readJsonOutput<T>(path)`, `parseCsvLine`, `formatParamsAssignment`.

#### Your UI is not where the work lives

**Assume the app can be closed mid-run and must recover.** Long operations are
owned by Acabox, not by your React tree. The user can navigate away — which
unmounts your app entirely and destroys its iframe — or quit Acabox, and the
work carries on regardless: a shell command started by a tool completes even
after the whole app has exited. Two consequences you must design for:

1. **Never let a result exist only in memory.** The action cell writes its
   outputs to `output/` and a `run_metadata.json` describing them. That file,
   not React state, is the result. If your app holds the only copy, closing the
   tool destroys it.
2. **On mount, check whether a run finished while you were closed.** Compare
   `lastRunAt` from `useAppState` against the host's job history using
   `useRunsWhileClosed`; if there is a completed run newer than the last one you
   recorded, re-read `output/run_metadata.json` and adopt it via `setOutputs` /
   `setRunResult` / `markRunComplete`. Without this the user comes back to a
   tool that says it never ran, next to a folder full of results.

```tsx
const { lastRunAt, setOutputs, setRunResult, markRunComplete } = useAppState(...);
const { missedRuns, dismiss } = useRunsWhileClosed(DIR_NAME, lastRunAt);

useEffect(() => {
  if (missedRuns.length === 0) return;
  void (async () => {
    const meta = await readJsonOutput<MyRunResultFile>(
      `.applications/${DIR_NAME}/output/run_metadata.json`,
    );
    if (meta) {
      setRunResult(/* derived from meta */);
      setOutputs(meta.files.map(toOutputFile));
      await markRunComplete();
    }
    dismiss();
  })();
}, [missedRuns]);
```

Acabox shows the user the other half of this: a tool with work in flight reads
**WORKING** on the home grid even when its viewer is closed, and one whose work
outlived a restart reads **RAN WHILE CLOSED** until they open it.

#### Persistent state — use `useAppState`

**All persistent params and selected input files MUST go through `useAppState`.** This is the only mechanism that survives tab switches and Electron restarts. Raw `useState` is only for transient UI (open/closed sections, in-flight viz adjustments that don't need to be preserved).

```tsx
import { useAppState } from "@reusable/useAppState";

interface MyParams {
  threshold: number;
  input_csv: string;       // file path slot
  variant: "a" | "b";
}

const DEFAULTS: MyParams = { threshold: 0.5, input_csv: "", variant: "a" };

import type { OutputFile } from "@reusable/OutputFileList";

// Optional: define a typed "run result" shape if your app produces structured
// data beyond a flat file list (summary stats, viz descriptors, etc.).
interface MyRunResult {
  summary: { count: number };
  // ...whatever your app needs to re-render after a remount
}

const {
  loading,
  params, setParams,
  selectInput, clearInput, readInput,
  outputs, setOutputs,         // persisted list of generated output files
  runResult, setRunResult,     // persisted structured run summary (or null)
  freshness,                   // 'never' | 'fresh' | 'stale' — drive <RunStateBadge>
  markRunComplete,
} = useAppState<MyParams, OutputFile, MyRunResult>({
  dirName: "myApp",
  defaults: DEFAULTS,
  inputSlots: ["input_csv"],   // param keys that hold file paths
});

// `runResult` is for structured run output beyond the flat file list —
// summary statistics, visualization descriptors, etc. Persisted in
// `notebook.metadata.cobuild.runResult` and hydrated on mount, so the UI
// re-renders the previous run's results without any disk I/O. Apps with
// no structured result can omit the third type param and ignore the field.

// Pick a file, then read its content:
const path = await selectInput("input_csv", [{ name: "CSV", extensions: ["csv"] }]);
if (path) {
  const text = await readInput("input_csv");  // string content, or null
  if (text) {
    const rows = parseCsv(text);
    // ...
  }
}

// Re-load on mount (so the user sees their previously-picked file):
useEffect(() => {
  if (loading || !params.input_csv) return;
  (async () => {
    const text = await readInput("input_csv");
    if (text) setRows(parseCsv(text));
  })();
}, [loading, params.input_csv]);

// After producing a result, persist its descriptor so it survives remounts:
const outName = "result.csv";
await window.filesAPI.writeFile(`.applications/myApp/output/${outName}`, csv);
setOutputs([{ name: outName, description: "...", path: `.applications/myApp/output/${outName}` }]);
await markRunComplete();
// → next time the user opens this app, `outputs` is already populated and
//   <OutputFileList files={outputs} ... /> renders without any extra work.

// Update a value (debounced auto-save to notebook.ipynb):
setParams({ threshold: 0.8 });

// After a successful run, record what was used:
await markRunComplete();
// → `freshness` becomes 'fresh' until the user changes any param,
//   then flips to 'stale' so <RunStateBadge> warns that results are out of date.
```

The hook hydrates from the notebook's `parameters` cell on mount (so the user sees what they left), debounces writes back to the same cell on every change, and stores run-completion metadata in `notebook.metadata.cobuild.lastRun`. Render a loading state while `loading` is true.

**Do not call `window.filesAPI.selectFile` directly for input files** — bypass `selectInput` and the file is not copied into the portable `input/` folder, the path is not persisted, and the staleness check is broken.

**Prefer `readInput(slot)` over calling `window.filesAPI.readFile` on a slot path** — it returns the text content directly (or `null`), so you don't have to handle the discriminated `{ type, content } | { type, fileUrl } | { error }` return shape yourself. Forgetting to extract `.content` is a common source of "the file shows up but nothing happens" bugs.

**Prefer `readJsonOutput<T>(path)` for reading JSON files in `output/`** — same reason: it parses and returns `T | null` instead of forcing you to dance around the readFile return shape.

#### Kernel-backed runs — use `useKernelAction`

**Do not hand-roll the connect/inject/execute/error flow.** `useKernelAction` is the single way to run a notebook-backed analysis. It handles kernel connection, parameter injection (using the same canonical format the persisted parameters cell uses), action-cell lookup by tag, error dispatch into the global `<ErrorDisplay>`, and the elapsed-time + phase tracking that drives `<RunButton>`.

```tsx
import { useKernelAction } from "@reusable/useKernelAction";
import { RunButton } from "@reusable/RunButton";
import { RunStateBadge } from "@reusable/RunStateBadge";
import { readJsonOutput } from "@reusable/readJsonOutput";

const action = useKernelAction({
  dirName: "myApp",
  kernel: "python3",
  buildKernelParams: () => ({
    ...params,
    outdir: `.applications/myApp/output`,
  }),
});

const handleRun = async () => {
  setRunResult(null);
  setOutputs([]);

  const result = await action.run();
  if (!result.ok) return;               // error already in the floating ErrorDisplay

  // Read whatever your action cell produced and translate into the hook:
  const meta = await readJsonOutput<MyRunResultFile>(
    `.applications/myApp/output/run_metadata.json`,
  );
  if (meta) {
    setRunResult({ /* ...derived from meta... */ });
    setOutputs(meta.files.map(toOutputFile));
  }
  await markRunComplete();
};

// In the JSX:
<RunButton action={action} onRun={handleRun} disabled={!canRun}>
  Run Analysis
</RunButton>
{runResult && <RunStateBadge freshness={freshness} />}
```

**Errors from the kernel surface in the global floating `<ErrorDisplay>` panel** — auto-mounted by the scaffolded `index.tsx`. Do not add a second error UI inside the app's main flow.

#### File pickers — use `<FileSlotPicker>`

```tsx
import { FileSlotPicker } from "@reusable/FileSlotPicker";

<FileSlotPicker
  state={appState}
  slot="input_csv"
  label="Counts CSV"
  filters={[{ name: "CSV", extensions: ["csv"] }]}
/>
```

The component reads the slot from `params`, calls `selectInput`/`clearInput`, and renders the upload affordance vs. the filename + clear button. Don't reimplement this layout in each app.

**Prefer Plotly.js for all data visualizations** (charts, plots, graphs, heatmaps). Do not use custom SVG/Canvas rendering or other charting libraries when Plotly can handle the visualization.

### App style — the Acabox design language

A mini-app is a panel inside Acabox, not a standalone web page. It should be
indistinguishable from the surrounding app. The whole design system is already
loaded for you — `_vendor/acabox.css` gives every app DM Sans, IBM Plex Mono,
the design tokens as CSS variables, and a set of `ab-*` component classes; the
scaffold's Tailwind config maps the tokens onto class names. You do not need to
choose any colours.

**The five rules that matter.**

1. **The page is white.** `#ffffff`, which is what `.ab-app` gives you. The tool
   viewer around your app is white, and any other page tone shows up as a seam.
   (If you have seen `#faf8f5` in an older app, it is stale — it was the
   Coscientist chrome colour and matches nothing in Acabox today.)
2. **Section headers are mono, uppercase, letter-spaced** — the `ab-label`
   class. Not a bold sans heading. This single idiom does more than anything
   else to make an app read as Acabox.
3. **Blue means clickable.** `#0645b1` is for links, primary buttons and the
   active tab. Never colour a metric, a status or a heading blue — a number that
   looks like a link is the most common way an app stops looking native.
4. **Hairlines, not shadows.** Surfaces are separated by `1px` borders in
   `--cd-border` with `8px` radius. No drop shadows except on the floating error
   overlay.
5. **Text uses the ink ramp**: `--cd-ink` for primary, `--cd-text2` for
   secondary, `--cd-text3` for meta. Numbers in stat tiles get
   `font-variant-numeric: tabular-nums` so they stop jittering as they update.

**Use the `ab-*` classes rather than rebuilding them.** They are in
`_vendor/acabox.css` — read it if you need the exact declarations.

| Class | Use |
| --- | --- |
| `ab-app` (`--flush`), `ab-page` (`--wide`, `--full`) | Page shell and centred column. `--flush` drops the page padding for a full-bleed header or sidebar. |
| `ab-label` | Mono uppercase section header |
| `ab-h1`, `ab-h2`, `ab-sub`, `ab-meta` | Type scale |
| `ab-card` (`--pale`, `--error`, `--flush`, `--action`) | Bordered surface |
| `ab-stats`, `ab-stat`, `ab-stat__label/__value/__meta` | KPI tile row |
| `ab-btn` (`--primary`, `--ghost`, `--danger`, `--sm`, `--lg`) | Buttons |
| `ab-icon-btn` (`--danger`) | Square icon button |
| `ab-input`, `ab-select`, `ab-textarea`, `ab-field`, `ab-check` | Form controls |
| `ab-tabs`, `ab-tab` (`--active`) | Underline tabs |
| `ab-table`, `ab-table__num` | Data table with a mono header row |
| `ab-chip` (`--ok`, `--error`), `ab-dot`, `ab-tag` (`--warn`, `--text`) | Status |
| `ab-rows` | Hairline-separated list |
| `ab-note` (`--error`), `ab-empty`, `ab-spinner`, `ab-divider` | Misc |

**Tailwind still works for layout** — flex, grid, spacing, sizing. For colour,
prefer the token names (`text-ink`, `text-text2`, `text-text3`, `bg-pale`,
`border-line`, `text-accent`). Tailwind's own `gray-*`, `blue-*`, `red-*`,
`amber-*` and `green-*` scales have been remapped onto the Acabox ramp, so a
reflexive `text-gray-500` lands on the right colour — but the token names say
what you mean.

**Charts:** import the theme, do not pick colours. `ACABOX_LAYOUT`,
`ACABOX_AXIS`, `ACABOX_CONFIG`, `ACABOX_CATEGORICAL`,
`ACABOX_SEQUENTIAL_SCALE`, `ACABOX_DIVERGING_SCALE` and `REGULATION_COLORS` all
come from `@reusable/plotTheme`. The categorical palette is capped at six hues
and that ceiling is real — it was validated for colourblind separation at every
pair, and a seventh hue was tried and cut. A 7th series folds into "Other" or
becomes small multiples. See the **react-plotly** skill for the full rationale.

```tsx
import { ACABOX_LAYOUT, ACABOX_AXIS, ACABOX_CONFIG } from "@reusable/plotTheme";

<Plot
  layout={{ ...ACABOX_LAYOUT,
            xaxis: { ...ACABOX_AXIS, title: { text: "log2 fold change" } },
            yaxis: { ...ACABOX_AXIS, title: { text: "−log10 p" } } }}
  config={ACABOX_CONFIG}
/>
```

**Icons** are `lucide-react`, at 16px inside buttons and rows. Do not add an
icon font.

A minimal app that is already on-language:

```tsx
<div className="ab-app">
  <div className="ab-page">
    <div>
      <h1 className="ab-h1">Sample QC</h1>
      <p className="ab-sub">Read depth and duplication across the run.</p>
    </div>

    <div className="ab-stats">
      <div className="ab-stat">
        <span className="ab-stat__label">Samples</span>
        <span className="ab-stat__value">148</span>
      </div>
      <div className="ab-stat">
        <span className="ab-stat__label">Median depth</span>
        <span className="ab-stat__value">31×</span>
        <span className="ab-stat__meta">min 12× · max 58×</span>
      </div>
    </div>

    <div className="ab-card">
      <h2 className="ab-label">Inputs</h2>
      {/* … */}
    </div>
  </div>
</div>
```

**Editing an app built before the design system landed?** Its `src/index.html`
is missing the stylesheet link and the Tailwind config. The tokens and `ab-*`
classes still reach it (the bridge injects the stylesheet at runtime), but the
Tailwind colour names will not resolve. Bring its `<head>` in line with the
scaffold in `scripts/manage_mini_app.mjs` when you touch such an app.

### Step 3: Add an action cell to the notebook (only for kernel-backed apps)

Every app already has a `<dir>/notebook.ipynb` from the scaffold, with a markdown doc cell, a `parameters`-tagged cell that `useAppState` reads/writes, and `cobuild` metadata for run-state bookkeeping.

If the app needs Python computation, append an **action cell** (tag: `action`) using `NotebookEdit`. It should source existing skill scripts and call functions with parsed parameters. Use relative file paths.

```python
import json
params = json.loads(params_json)
# ... call your functions with params["<field>"] ...
```

The React app injects a fresh `params_json` (built from the persistent `params` plus run-time-only fields like `outdir`) into the kernel before executing this cell, so the cell can rely on `params_json` being defined.

If your app does no kernel computation (everything happens in the React side), do not add an action cell — the parameters cell alone is enough to make the directory a self-describing record of the user's configuration.

### Step 4: Build and open

Call `build_and_open_mini_application` with the `dir_name` from Step 1. The tool runs esbuild and opens the app in one atomic step. If the build fails, the tool returns the esbuild error in its output — fix the issue in `App.tsx` and call the tool again.

See **Build and open tools** below for when to use the build-only and open-only variants instead.

### Step 5: Work summary

If the the app you've created is complex, requires instructions on how to use, or if the user would benefit from understanding a little about how it works under the hood, give the use a brief summary of the app and how it works.

If the app is simple and self explanatory, Just say, "Your [tool description] tool is ready to use."

## Editing a mini-app

1. Locate the mini-app at `.applications/<dir_name>/` within the workspace.
2. Edit `App.tsx` and/or `notebook.ipynb` to change the UI, the backing analysis, or the params.
3. If the change alters what the app does, also update `manifest.json` (`name`, `description`, `icon`) so the Tools page stays in sync. Leave `lastOpened` alone — the host owns that field.
4. Call `build_and_open_mini_application` with the app's `dir_name` to bundle the new source and reload the user's view. If the build fails, the tool returns the esbuild error so you can fix and call again.


## Opening an existing mini-app on demand

When the user asks to open an app whose source hasn't changed since its last build (e.g. *"open the differential expression app"*), call `open_mini_application` with its `dir_name`. This tool just signals the UI to open the already-built bundle and is faster than `build_and_open_mini_application` because it skips esbuild. Use `build_and_open_mini_application` whenever you've just edited the source.


## Build and open tools

Three ways to build and/or open. Pick by intent:

| Intent | Tool / command | What it does |
|---|---|---|
| Just created or edited the source — show it to the user | `build_and_open_mini_application` (MCP) | Runs esbuild, then opens. Build failure returned as tool error. |
| User asked to open an app (source unchanged since last build) | `open_mini_application` (MCP) | Opens the already-built bundle without rebundling. |
| Iteratively editing — want to type-check the build without disrupting the user's focus | bare `esbuild` via Bash | Compiles only. No tab open, no UI remount. |

The bare esbuild command for build-only verification:

```bash
esbuild \
  .applications/<dir_name>/src/index.tsx \
  --bundle \
  --outfile=.applications/<dir_name>/dist/bundle.js \
  --jsx=automatic \
  --loader:.tsx=tsx \
  --loader:.ts=ts \
  --format=iife \
  --alias:@reusable=$PWD/.applications/_reusable
```

The alias target must be **absolute** — esbuild does not resolve a relative alias against the working directory, so `--alias:@reusable=.applications/_reusable` fails with "Could not resolve @reusable/…". `$PWD` expands correctly because the working directory is always the workspace root.

## Installing software

Two cases. Pick the right one:

- **Adds a package or binary that other processes look up by name** → use the install wrapper.
- **Produces a file in the app folder that the app code reads** (model weights, datasets, fixtures) → direct download with `curl`/`wget`, no wrapper.

### Case 1: Install wrapper (pip / npm / manual)

All installs go through `.applications/install`:

```bash
.applications/install pip seaborn --app <dir_name>
.applications/install pip 'pandas>=2.0' scipy --app <dir_name>
.applications/install npm d3 --app <dir_name>
.applications/install npm 'd3@^7.0' --app <dir_name>
.applications/install manual .applications/<dir_name>/setup/fetch-model.sh --app <dir_name>
```

The wrapper atomically (1) runs the live install so the package is usable immediately, and (2) records it in the app's per-registry file so it travels when the app is shared. pip installs land in Acabox's own Python venv, npm in Acabox's own npm prefix — the user's system Python and global npm are never touched.

Per-registry files — the single source of truth for each registry. Do not write to them directly; always use the wrapper.

| Registry | File | Format |
|---|---|---|
| pip    | `.applications/<dir_name>/requirements.txt` | Standard pip format, version specs supported (`pandas>=2.0`) |
| npm    | `.applications/<dir_name>/package.json`     | Standard `package.json` `dependencies` field |
| manual | `.applications/<dir_name>/setup/*.sh`       | Check-then-install scripts (see below) |

**`apt`, `R`, and `conda` are not available.** Acabox runs directly on the user's machine and will not install into their system package manager — the wrapper refuses those registries with an error, and the PreToolUse hook blocks the raw commands. There is no workaround: find a pip/npm alternative, or tell the user what to install themselves and stop. Do not retry through the wrapper.

**Never call `pip install` / `npm install` / `apt-get install` / `Rscript -e 'install.packages(...)'` yourself.** All of these are blocked by a PreToolUse hook. A direct pip/npm install does work live but doesn't update the dependency file, so the package is silently lost when the app is shared.

**`--app <dir_name>` is required** so installs are associated with the app that needs them.

**npm is always global.** Even with a per-app `package.json`, there is no local `node_modules` — packages go into Acabox's shared npm prefix (alongside `react`, `react-plotly.js`, etc.) and esbuild resolves them via `NODE_PATH`. Treat `package.json` here as a declarative manifest, not a real npm project.

**`manual` is elevated-risk** — it runs arbitrary shell as the user, on the user's own machine, with no container to contain it. Verify with the user before running one.

### Writing a manual install script

Use `manual` when no standard package manager can install what you need (binary releases, conda, building from source).

Scripts must live under `.applications/<dir_name>/setup/` — the wrapper refuses scripts elsewhere, and that location is what makes the script travel with the app. Pick a descriptive name like `fetch-model.sh`.

The script runs **as the user, on the user's own machine**. There is no container and no root. Two rules follow:

- **Write only inside the app folder** (`.applications/<dir_name>/…`) or the durable data dirs. Never `/opt`, `/usr/local`, `~/.bashrc`, or anywhere else on the user's system — Acabox is a tool they installed, not a package manager, and a script that scatters files outside the app folder cannot be undone by deleting the app.
- **It must be idempotent.** It re-runs whenever the app is opened on a machine that hasn't run it yet, so it must succeed whether or not the work is already done. A script that errors on "already present" breaks every subsequent open.

**Pattern: check first, then install.** Detect if the work is already done; if so, exit 0 immediately.

```bash
#!/usr/bin/env bash
# Fetch the model checkpoint into the app's own folder.
set -euo pipefail

APP_DIR=".applications/myApp"
MODEL="$APP_DIR/input/model.pt"

# Check first: if the checkpoint is already there, we're done.
if [ -f "$MODEL" ]; then
  echo "model already present at $MODEL — skipping"
  exit 0
fi

# Download to a temp file and move into place, so an interrupted run does not
# leave a truncated file that the check above would accept next time.
mkdir -p "$(dirname "$MODEL")"
TMP=$(mktemp "$APP_DIR/.model-XXXXXX")
trap 'rm -f "$TMP"' EXIT

curl -fsSL -o "$TMP" https://example.com/model.pt
mv "$TMP" "$MODEL"

echo "fetched model to $MODEL"
```

Key techniques: `set -euo pipefail` for fail-fast; a cheap presence check (`[ -f … ]`, `command -v <tool>`, `<tool> --version`); `mktemp` + `trap` for cleanup; and download-to-temp-then-`mv` so the presence check can never be satisfied by a partial file. Paths are relative to the workspace root — the wrapper runs the script from there. Run it with:

```bash
.applications/install manual .applications/myApp/setup/fetch-model.sh --app myApp
```

The script's presence in `setup/` is the record — nothing else needs updating.

### Case 2: Downloading data into the app folder

App data (model weights, datasets, fixtures) is not a package install. Write directly into the app folder — no wrapper needed.

```bash
mkdir -p .applications/<dir_name>/data
curl -L -o .applications/<dir_name>/data/model.pt https://example.com/model.pt
```

These files persist because the app folder persists, and travel with the app when shared.

## Guidelines

### File paths

All files must be within the workspace. Convert absolute host paths (from file pickers) to relative paths before passing to notebooks:

```typescript
const relativePath = "./" + hostPath.slice(window.getWorkspacePath().length + 1);
```

### Output files

All output files must be written to `.applications/<dir_name>/output/`, regardless of how they are generated. There are two ways output files are created:

1. **From a backing notebook** — Python code writes results to the output directory during kernel execution (e.g. CSVs, images, JSON metadata).
2. **From the React app** — The app generates data in-browser (e.g. a user transforms a dataset, shuffles rows, exports a selection) and writes it via `window.filesAPI.writeFile()`.

Both cases must follow the same pattern: write to the output directory as soon as data is generated, then display all outputs using the `OutputFileList` reusable component at the bottom of the app UI. Every app that has output files should render this component.

**Important rules:**

- Write output files **immediately when data is generated** (e.g. when the user clicks a button like "Run"), not in a separate "Save" or "Download" step. The user should see the output list appear as soon as processing finishes.
- Use `setOutputs` from `useAppState` (not a local `useState`) so the list survives remounts and Electron restarts. The descriptors are persisted alongside the rest of the app state in `notebook.metadata.cobuild.outputs`.
- Wrap `writeFile` in try/catch, but **always call `setOutputs` AFTER the try/catch** (not inside it) so the output list appears even if the file write fails.
- The `OutputFileList` must always be rendered at the very bottom of the app layout, outside any conditional result sections.
- The `OutputFileList` provides its own "Download" button (native save dialog) for each file — do not add separate download buttons elsewhere.

```typescript
import { OutputFileList, type OutputFile } from "@reusable/OutputFileList";
```

```tsx
const { outputs, setOutputs, markRunComplete } = useAppState<MyParams, OutputFile>({ ... });

// Write output as soon as data is generated (e.g. in the shuffle/run handler):
const handleProcess = async () => {
  const result = processData(input);
  const outName = "results.csv";
  try {
    await window.filesAPI.writeFile(`.applications/${dirName}/output/${outName}`, result);
  } catch (err) {
    console.error("Failed to write output:", err);
  }
  setOutputs([{
    name: outName,
    description: "Processed results",
    path: `.applications/${dirName}/output/${outName}`,
  }]);
  await markRunComplete();
};

// Always render at the bottom of the app, outside conditional sections:
<OutputFileList files={outputs} outputDir={`.applications/${dirName}/output`} />
```

Each `OutputFile` has `name` (display name), `description` (short summary), and `path` (relative workspace path). The component renders each file with inline "Show in Finder" and "Download" buttons.

### Downloading files

Use the bridge download API to let users save/export data:

```typescript
const csvContent = [header, ...rows].map(r => r.join(",")).join("\n");
await window.filesAPI.downloadFile("results.csv", csvContent);
```

Do NOT use `document.createElement('a')` with blob URLs — it does not work reliably in the sandboxed iframe.

### Image tags

Mini-apps run inside an iframe on the Electron host. The `<img>` tag `src` attribute cannot use a workspace-relative path directly — build it with `window.hostAPI.fileUrl(relPath)` instead. This is the one place a URL needs building at all; everywhere else (`filesAPI`, `hostAPI.exec`, the kernel) already takes workspace-relative paths as-is.

Pass `fileUrl` the same workspace-relative path you'd give `filesAPI.readFile`:

```typescript
const dirName = "myApp"; // the application dir_name

// For an image generated by a backing notebook into the output dir:
const src = window.hostAPI.fileUrl(`.applications/${dirName}/output/${imageFileName}`);
```

```tsx
<img
  src={window.hostAPI.fileUrl(`.applications/${dirName}/output/plot.png`)}
  alt="Plot description"
/>
```

**Never hand-build the URL yourself** (e.g. `` `local-file://${window.getWorkspacePath()}/...` ``). `hostAPI.fileUrl` is the only sanctioned way to build one, and the reason is not style: a mini-app can also be published as a read-only shared snapshot (see the sharing feature), where there is no workspace on disk and no `local-file://` scheme at all — `fileUrl` resolves to the right kind of URL in both places with no branching in your code, while a hand-built string only ever works locally and silently breaks the shared copy.

**For img tags do NOT use:**
- Relative paths (`./output/image.png`) — won't resolve in the iframe context
- A bare absolute path (`/Users/.../output/plot.png`) — go through `hostAPI.fileUrl` instead
- A hand-built `local-file://${workspacePath}/...` string — works locally, breaks once the app is shared
- Blob URLs or data URIs for files that already exist on disk

### Error display

Runtime errors are captured automatically by the bridge and shown in a floating red overlay (bottom-right of the iframe). This covers uncaught exceptions, unhandled promise rejections, `console.error` calls, failed fetches (non-2xx), resource load failures, and React render errors. **Do not add your own error UI** — the overlay is already mounted by the scaffolded `index.tsx`.

### Calling Claude from a mini-app

Use `window.anthropicAPI` — **do NOT read `ANTHROPIC_API_KEY` from env, pass it into a subprocess, or make direct API calls from notebook cells.** The key is the user's own and is managed by the host; the bridge handles auth transparently and never exposes the key to the iframe.

```tsx
// Non-streaming — await the full response
const msg = await window.anthropicAPI.complete({
  messages: [{ role: 'user', content: userText }],
  system: 'You are a helpful assistant.',   // optional
  // model: omit for claude-haiku-5-5 with thinking off — fast and cheap
  max_tokens: 1024,                         // optional, this is the default
});
// Read by type: models that think put thinking blocks before the text.
const reply = msg.content.find((b) => b.type === 'text')?.text ?? '';

// Streaming — onChunk fires for each text delta
let output = '';
await window.anthropicAPI.stream(
  { messages: [{ role: 'user', content: userText }] },
  (chunk) => { output += chunk; setDisplayText(output); },
);

// Send an image for analysis — use file paths, not base64
const msg = await window.anthropicAPI.complete({
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'file', path: imagePath } },
      { type: 'text', text: 'Analyze this image.' },
    ],
  }],
});

// Send a PDF for analysis
const msg = await window.anthropicAPI.complete({
  messages: [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'file', path: './data/paper.pdf' } },
      { type: 'text', text: 'Summarize the key findings.' },
    ],
  }],
});
```

### Bridge API

See [bridge-api.md](bridge-api.md) for the full API reference (`window.filesAPI`, `window.kernel`, `window.hostAPI`, `window.anthropicAPI`, `window.getWorkspacePath()`).

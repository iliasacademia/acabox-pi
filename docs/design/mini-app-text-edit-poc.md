# Edit a tool's text in place — POC

Status: **POC on branch `poc/mini-app-text-edit`, not released.** Asked for on
2026-10-13: "I'd like to modify some things in the mini-apps UI myself, not via
an agent — enter Edit mode and modify any text as if editing a Word doc."

## What the user gets

1. In a tool's header, **Edit text**. The tool stays live, but clicking no
   longer presses its buttons: hovering any text outlines it, clicking puts a
   caret in it, and typing changes it, in place, in the tool's own fonts.
2. **Enter** (or clicking elsewhere) saves; **Esc** cancels. The change is
   written into the tool's source (`src/App.tsx` etc.) and the tool is rebuilt
   to prove it still builds. The edit bar says where it went:
   `Saved · src/App.tsx · line 42`.
3. **Undo** (button or ⌘Z) takes back the last change. **Done** leaves edit
   mode and reloads the tool from the rebuilt bundle.
4. Text the tool computes while it runs (`Showing 312 genes`, a value from a
   CSV) cannot be edited in source. Clicking it opens the same in-place editor
   in amber. On Enter the request goes to the tool's chat, pre-filled ("In this
   tool, change the text "…" to "…"."), and the user decides whether to send it.

**Cost: zero model calls** on every path. The only path that can lead to one is
the amber hand-off. It fills the composer and does not send.

## Why it works: three measured facts

- **esbuild can tell us where every element was written.** With `--jsx-dev`,
  esbuild calls `jsxDEV(type, props, key, isStatic, {fileName, lineNumber,
  columnNumber})`. We route that call through our own tiny runtime
  (`--jsx-import-source` + `--alias`) that stamps host elements with
  `data-acabox-src=".applications/<dir>/src/App.tsx:42:7"` and then calls React's
  ordinary `jsx`/`jsxs`. Measured 2026-10-13 on esbuild 0.25.12 with React 19.2.8
  from the dev npm-site:
  - `fileName` is relative to esbuild's cwd, which is the workspace root.
  - Line and column are 1-based.
  - The column counts **UTF-16 code units**, so it matches TypeScript's
    `getLineAndCharacterOfPosition` + 1 (checked with `é—🧬` before the tag).
  - The column points at the `<`.
  - Library code ships as compiled JS, so only our TSX is stamped: the tool's
    own files and `_reusable`.
- **Each static text run is its own DOM text node, equal to the cooked JSX
  text.** For `<p>Showing <strong>{n}</strong> genes above threshold</p>` the
  `<p>` holds three nodes: `"Showing "`, `<strong>`, and `" genes above
  threshold"`. Multi-line JSX text arrives with its whitespace folded,
  following the JSX whitespace rule. A clicked text node therefore maps back to
  exactly one JSX literal, and replacing that one node's value never disturbs
  React's DOM bookkeeping.
- **Your tools mostly write visible text as JSX text.** Across the 68 source
  files of the 21 production tools, measured 2026-10-13:
  - 2,244 non-blank JSX text literals.
  - 125 string literals rendered as a JSX child (`{cond ? "A" : "B"}`).
  - About 300 display-like props: `label` 105, `title` 100, `placeholder` 12,
    `subtitle` 5, and others.
  - Object values: `label` 97, `name` 92, `text` 63, `headline` 45,
    `description` 33, `what` 26, and others.
  - Only 21 strings set as `const` initializers.

  So JSX text carries the feature, and literals passed through props or data
  objects are the long tail worth covering.

## Architecture

| Part | Where | Ticket |
|---|---|---|
| Stamp elements with their source location | `main/miniAppJsxRuntime.ts`, `main/miniAppBuildArgs.ts`, `main/miniAppBuilder.ts` | T1 |
| Resolve text → one literal, rewrite it, verify, undo | `main/textEdit/*`, one call in `main/index.ts` | T2 |
| Make the running tool editable; report edits | `main/miniAppEditShim.ts`, injected by `main/externalLinks.ts` | T3 |
| Edit button, edit bar, frame ↔ main relay | `renderer/components/MiniAppViewer.tsx`, `renderer/components/miniAppEditSession.ts`, `renderer/phaseB.css` | T4 |

**All contracts are code**, in `src/cobuilding/shared/miniAppTextEdit.ts`:
- the stamp attribute
- IPC channel names and shapes (`TEXT_EDIT_IPC`)
- the frame ↔ host postMessage protocol (`EDIT_MSG`)
- the refusal reasons
- the limits

`window.miniAppsAPI.textEdit.{probe,apply,undo,undoDepth}` is already wired in
`main/preload.ts` and typed in `renderer/types.d.ts`. Tickets import these; none
redefines them.

```
 frame (tool iframe, local-file://)          host (MiniAppViewer)                  main
 ─────────────────────────────────           ─────────────────────                 ────
 click text ──── probe{probeId,target} ────▶ textEdit.probe(dir,target) ─────────▶ resolve (read-only)
 open editor ◀── probeResult{editable} ────── ◀─────────────── {editable,location|reason}
 Enter ───────── commit{editId,target,new} ─▶ textEdit.apply(dir,req) ───────────▶ resolve → plan → verify
                                                                                    → atomic write → build
 keep/revert ◀── applyResult{ok,…} ────────── ◀──────────── {ok,location,undoDepth} (build fail ⇒ revert)
 amber Enter ─── suggest{old,new} ──────────▶ fill the chat composer (not sent)
 ⌘Z / Esc ────── shortcut{undo|done} ───────▶ textEdit.undo / leave edit mode
 put text back ◀ revert{editId} ◀─────────── after a successful undo
```

### Decisions and why

- **Edit the source, not an overlay of overrides.** An override file
  ("replace X with Y at runtime") would be invisible to Claude, would go stale
  the moment the text changes, and cannot tell two `Save` buttons apart. The
  source is already where the text lives.
- **Stamp in every build, not only while editing.**
  - Entering edit mode is instant, and there is no second build mode to race
    the agent's builds.
  - The bundle grows by one small object literal per JSX element; on the
    production tools that is measured at integration time.
  - An agent's "bare esbuild" build (SKILL.md) has no stamps. Edit mode detects
    that (`state.stamped === 0`, final) and rebuilds once.
- **The parser is TypeScript's own** (`typescript` 5.9.3, already in
  `node_modules`, bundled into main by webpack). It is the reference parser for
  `.tsx`. The cost is main-bundle size; a lazy chunk is the integration-time
  fix if it matters.
- **Verify twice before calling an edit done.**
  - First, re-parse the new file: the edit must add no new parse errors, and
    the rewritten literal must display exactly the new text.
  - Second, rebuild with esbuild. A failed build reverts the file. The build
    has to run anyway: it is what keeps `dist/bundle.js` true to the source if
    Acabox quits mid-session.
- **Edit mode freezes reloads.** Every per-edit build broadcasts
  `miniApps:built`, which would remount the iframe after each keystroke-save.
  While editing, the viewer holds the iframe's key; Done releases it, so the
  tool reloads once.
- **Be conservative where code meets data.** A literal in an object property is
  editable only if the same text is not also used as code: compared, switched
  on, looked up, a key, or a type. Otherwise `{ name: "Revenue" }` plus
  `d.name === "Revenue"` would break silently, and the build cannot catch it.
  JSX text and JSX attributes are pure display and never refused on these
  grounds.

### Out of scope for the POC (named so nobody assumes otherwise)

- **Not editable in place:**
  - text drawn in SVG or canvas (Plotly titles and axis labels)
  - `placeholder`, `title` tooltips and `<option>` text
  - template literals with substitutions (`` `Showing ${n}` ``)
- **Not supported:** formatting (bold, italic), adding or removing elements, and
  style edits.
- **No lock against the agent.** An agent editing the same file in the same
  second can lose one side's change. The writes are atomic, but there is no
  merge.
- **Development build only.** Not tried in the packaged build.

---

# Tickets

Each ticket is self-contained. Read `src/cobuilding/shared/miniAppTextEdit.ts`
first; it is the contract. Do not edit it. If a contract is wrong, say so in
your report instead of changing it.

## Common setup and gate (every ticket)

```bash
# 1. Start from the POC branch, on your own branch.
git checkout -B <your-branch> poc/mini-app-text-edit
# 2. node_modules is not in the worktree; borrow the main checkout's.
ln -s "/Users/iliasbeshimov/Documents/Dev Folders/Acabox/node_modules" node_modules   # skip if it exists
# 3. Gate — both must pass before you commit.
npx tsc --noEmit
npm test            # NEVER bare `npx jest` (Electron ABI; see CLAUDE.md)
```

- Commit on your branch with a message that says what and why, ending with
  the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not push.
- Do not touch files another ticket owns.
- Match the surrounding code: comment density, naming, plain language in
  user-facing strings.
- Never run `pkill` on Electron while tests run.
- **jsdom vs node environments.**
  - The default jest environment is jsdom.
  - A test that calls esbuild's JS API (`require('esbuild')`) needs the
    `/** @jest-environment node */` docblock: esbuild needs the real
    `TextEncoder`.
  - Such a test can still build a DOM with `require('jsdom')`.
  - Spawning the esbuild CLI with `child_process` works in either environment.
- Two jest suites (`skillImporter`, `skillImportService`) hit live GitHub and
  can fail on the unauthenticated rate limit. That is not your bug; say so in
  the report if it happens.

---

## T1 — Stamp every JSX host element with its source location

Branch `poc-edit/t1-stamp`. Owns: `src/cobuilding/main/miniAppJsxRuntime.ts`
(new), `src/cobuilding/main/miniAppBuildArgs.ts` (new),
`src/cobuilding/main/miniAppBuilder.ts`, and their tests.

### 1. `main/miniAppJsxRuntime.ts` (no `electron` import; it must load under jest)

```ts
/** esbuild imports `${JSX_EDIT_IMPORT_SOURCE}/jsx-dev-runtime`. */
export const JSX_EDIT_IMPORT_SOURCE = '@acabox/jsx-edit';
/** ESM source of `jsx-dev-runtime.js`. */
export const JSX_EDIT_RUNTIME_SOURCE: string;
/** Write `<dir>/jsx-dev-runtime.js` unless it already holds exactly JSX_EDIT_RUNTIME_SOURCE. Returns dir, or null if it could not be written. */
export function ensureJsxEditRuntime(dir: string): string | null;
/** ['--jsx-dev', `--jsx-import-source=${JSX_EDIT_IMPORT_SOURCE}`, `--alias:${JSX_EDIT_IMPORT_SOURCE}=${runtimeDir}`], or [] for null. */
export function jsxEditFlags(runtimeDir: string | null): string[];
```

`JSX_EDIT_RUNTIME_SOURCE` has these semantics. Build it from
`MINI_APP_SRC_ATTR` rather than hard-coding the attribute name.

```js
// Written by Acabox (main/miniAppJsxRuntime.ts); rewritten on every build — do not edit.
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
export { Fragment };
export function jsxDEV(type, props, key, isStaticChildren, source) {
  if (typeof type === 'string' && source && props && props['data-acabox-src'] === undefined) {
    props['data-acabox-src'] = source.fileName + ':' + source.lineNumber + ':' + source.columnNumber;
  }
  return isStaticChildren ? jsxs(type, props, key) : jsx(type, props, key);
}
```

- **Mutating `props` is deliberate and safe.** esbuild passes a fresh object
  literal at every call site. React 19 may adopt that object as the element's
  props and freeze it in DEV, but only inside `jsx()`, after our write.
- **Do not delegate to React's `jsxDEV`.** It is `undefined` in React's
  production build. Our wrapper works under either build.
- **Only host elements (`typeof type === 'string'`) are stamped.** A component
  must never receive the prop.
- **An explicit `data-acabox-src` written by app code wins.**

### 2. `main/miniAppBuildArgs.ts` (pure, no `electron`)

```ts
export interface MiniAppEsbuildArgsInput {
  entry: string; outfile: string; reusableAlias: string;
  /** e.g. reactAliasFlags(npmPrefix) — passed in so this module stays electron-free. */
  extraFlags: string[];
  /** From ensureJsxEditRuntime; null = build without stamps. */
  jsxRuntimeDir: string | null;
}
/** The esbuild argv after the binary, exactly as buildMiniApp runs it. */
export function miniAppEsbuildArgs(input: MiniAppEsbuildArgsInput): string[];
```

Order: `entry, --bundle, --outfile=…, --jsx=automatic, --loader:.tsx=tsx,
--loader:.ts=ts, --format=iife, --alias:@reusable=…, ...extraFlags,
...jsxEditFlags(jsxRuntimeDir)`. This is today's argv with the three new flags
appended.

### 3. `main/miniAppBuilder.ts`

Build the argv with `miniAppEsbuildArgs`, passing:
- `extraFlags: reactAliasFlags(getNpmPrefix())`
- `jsxRuntimeDir: ensureJsxEditRuntime(path.join(app.getPath('userData'), 'mini-app-jsx-runtime'))`

The runtime lives outside the workspace on purpose: it is host code the agent
must not be able to edit. Behaviour is otherwise unchanged. When the runtime
cannot be written, log one warning and build without stamps; the build must
not fail.

### Tests (`main/__tests__/miniAppJsxRuntime.test.ts`; add `miniAppBuildArgs.test.ts` if it reads better)

- `jsxEditFlags(null)` → `[]`; `jsxEditFlags('/x')` → the exact three flags.
- `ensureJsxEditRuntime(tmp)`: writes the file, is idempotent, restores a
  tampered file, and returns null for an unwritable path. The unwritable case
  is a path under a regular file.
- `miniAppEsbuildArgs`: exact argv with and without a runtime dir. This is the
  regression net for the builder.
- **End to end with the real esbuild CLI.** Use
  `<repo>/node_modules/.bin/esbuild`, resolved from `__dirname`, which works
  through the worktree's node_modules symlink.
  1. Write a fixture workspace in a tmp dir: `.applications/demo/src/index.tsx`,
     `App.tsx`, and `.applications/_reusable/Header.tsx`. Include:
     - an element after non-ASCII text on the same line (`é—🧬`)
     - a component that renders `{JSON.stringify(Object.keys(props))}`
     - a mapped list with keys
     - a fragment
     - an explicit `data-acabox-src="keep"`
  2. Run esbuild with cwd = the fixture workspace and argv from
     `miniAppEsbuildArgs`. Pass `extraFlags` aliasing `react` and `react-dom`
     to `<repo>/node_modules/react` and `react-dom`, plus a real runtime dir
     from `ensureJsxEditRuntime`.
  3. Evaluate the bundle in a JSDOM window. Use `require('jsdom')`;
     `runScripts: 'outside-only'`, then `window.eval`.
  4. Assert:
     - exact `data-acabox-src` values on host elements, including the
       `_reusable` one and the non-ASCII line (UTF-16 column)
     - no `data-acabox-src` key reaches the component's props
     - the explicit value is kept
     - the list and fragment render
     - `console.error` saw no React warnings (spy on the JSDOM window's
       console)

Acceptance: gate passes; the e2e test fails if you delete `--jsx-dev` from
`jsxEditFlags`. Check this once, then restore it.

---

## T2 — Resolve a clicked text to one literal; rewrite, verify, build, undo

Branch `poc-edit/t2-resolve`. Owns `src/cobuilding/main/textEdit/` (new
directory, four modules and their tests) and one registration call in
`src/cobuilding/main/index.ts`. Uses `typescript` (already in node_modules):
`import * as ts from 'typescript'`.

### Module layout

- `textEdit/jsxText.ts`: pure string rules.
- `textEdit/resolveTextEdit.ts`: pure, AST in, decision out.
- `textEdit/textEditService.ts`: fs, queueing, undo, build.
- `textEdit/textEditIpc.ts`: `registerTextEditIpc(ipcMain, service)`.

### `jsxText.ts`

- `cookJsxText(raw: string): string` folds whitespace with the JSX rule (Babel's
  `cleanJSXElementLiteralChild`), then decodes entities:
  1. Split on `\r\n|\n|\r`.
  2. Replace tabs with spaces.
  3. Trim leading spaces on every line except the first.
  4. Trim trailing spaces on every line except the last.
  5. Drop empty lines.
  6. Join the non-empty lines with one space (no trailing space after the last
     non-empty line).
  7. Run `decodeJsxEntities`.
- `decodeJsxEntities(s)` decodes:
  - numeric references: `&#123;` and `&#x1F;`
  - a curated named set: amp lt gt quot apos nbsp ndash mdash hellip lsquo
    rsquo ldquo rdquo laquo raquo middot bull times divide plusmn deg micro
    para sect copy reg trade larr rarr uarr darr harr le ge ne asymp infin
    minus prime alpha beta gamma delta epsilon lambda mu pi sigma omega

  Unknown names stay literal, so they never match. That is conservative by
  design.
- `encodeJsxTextReplacement(raw: string, newText: string): string` returns the
  new raw text for a JsxText node so that `cookJsxText(result) === newText`:
  - `lead`: the maximal leading whitespace run, kept only if it contains a
    newline (else `''`).
  - `trail`: the same rule at the end.
  - `core` is `newText` with these replacements: `&`→`&amp;`, `<`→`&lt;`,
    `>`→`&gt;`, `{`→`&#123;`, `}`→`&#125;`, U+00A0→`&nbsp;`.
  - Use the expression form `{${JSON.stringify(newText)}}` instead of `core`
    when either holds:
    - `lead !== ''` and newText starts with a space
    - `trail !== ''` and newText ends with a space
  - `newText === ''` returns `lead + trail`.
- `encodeStringLiteral(originalLiteralSource: string, newText: string)` keeps
  the original quote character and escapes:
  - backslash
  - that quote
  - `\n` and `\r`
  - U+2028 and U+2029
  - other control characters below 0x20, as `\uXXXX`
- `encodeTemplateLiteral(newText)` escapes `` \ ``, `` ` ``, and `${`.
- `encodeJsxAttributeString(originalInitializerSource: string, newText: string)`
  is for a string literal written directly as a JSX attribute value
  (`title="…"`). JSX attribute strings take no backslash escapes. If newText
  contains the quote character, `&`, `{`, `}`, or a newline, return
  `{${JSON.stringify(newText)}}`. Otherwise return quote + newText + quote.

### `resolveTextEdit.ts`

```ts
export interface AppSource { /** app-relative, e.g. "src/App.tsx" */ path: string; text: string; }
export interface ResolveInput {
  dirName: string;               // the tool, e.g. "geneExplorer"
  files: AppSource[];            // every source file under the tool's src/
  target: TextEditTarget;        // from the shared contract
}
export type Resolution =
  | { ok: true; file: string; start: number; end: number; kind: TextEditKind; sameElementScope: boolean;
      /** source text of the literal / JsxText being replaced, for planning */ original: string }
  | { ok: false; reason: TextEditRefusal; message: string };
export function parseSrcLoc(src: string): { file: string; line: number; col: number } | null;
export function resolveTextEdit(input: ResolveInput): Resolution;
export function planTextEdit(file: AppSource, r: Resolution & { ok: true }, newText: string):
  { start: number; end: number; replacement: string };
export function verifyPlannedEdit(before: AppSource, afterText: string,
  plan: { start: number; end: number; replacement: string }, newText: string): boolean;
```

**Stamp paths.**
- A stamp's file is workspace-relative: `.applications/<dir>/src/App.tsx`.
- It belongs to this tool only when it starts with `.applications/<dirName>/src/`.
  Strip `.applications/<dirName>/` to get the `AppSource.path`.
- Any other stamp (`_reusable`, another tool) is outside.
- `parseSrcLoc` splits on the **last two** colons and requires positive
  integers.

**Parsing.** `.tsx`, `.jsx` and `.js` parse as `ScriptKind.TSX`; `.ts` parses as
`ScriptKind.TS`. Use `setParentNodes: true`.

**Display value of a node.**
- JsxText: `cookJsxText(raw)`, with `raw = text.slice(node.pos, node.end)`.
- StringLiteral that is directly a `JsxAttribute.initializer`:
  `decodeJsxEntities(node.text)`. Confirm with the esbuild oracle (below) that
  `node.text` is the raw attribute string.
- Any other StringLiteral or NoSubstitutionTemplateLiteral: `node.text`.

**Occurrences.** Walk every file and keep each JsxText, StringLiteral or
NoSubstitutionTemplateLiteral whose display value `=== target.text` (exact).
Classify each occurrence:

- **DISPLAY**
  - **JsxText** → kind `jsx-text`.
  - **Literal reaching a JSX child position** → kind `jsx-expression`.
    - Walk up from the literal through Parenthesized, As, Satisfies,
      TypeAssertion and NonNull expressions.
    - Continue through ConditionalExpression only when the literal is on the
      `whenTrue` or `whenFalse` side.
    - Continue through BinaryExpression `||` and `??` (either side) and `&&`
      (right side only).
    - It counts if the walk reaches a JsxExpression whose parent is a
      JsxElement or JsxFragment.
  - **JSX attribute value whose name is not denied** → kind `jsx-attribute`.
    The literal is either a JsxAttribute's string initializer or inside its
    JsxExpression (same walk).
  - **Object property value whose name is not denied** → kind
    `object-property`. The literal is a PropertyAssignment's initializer (same
    walk). The name is an identifier or a string-literal key.
- **USAGE**: signals the text is used as code.
  - comparison operand: `===` `!==` `==` `!=` `<` `>` `<=` `>=` `in`
  - CaseClause expression
  - ElementAccess argument
  - Call or New argument
  - ArrayLiteral element
  - LiteralTypeNode
  - a property **name** equal to the text: identifier, string literal or
    computed, in an object literal, a property access (`colors.Revenue`), or a
    type member. Collect these even though they are names, not values.
- **OTHER**: everything else.
  - variable initializers
  - denied attribute and property values
  - imports
  - returns
  - default parameters

**Denied attribute names.**
- `key ref className class style id href src srcSet type name value
  defaultValue htmlFor role target rel method action accept pattern
  autoComplete inputMode lang dir form fill stroke d viewBox xmlns width height
  color variant size icon kind mode as to path url dataKey accessor field
  column sortKey format tabIndex min max step`
- Any `data-*` or `aria-*` attribute.

**Denied property names.** `id key type kind value field column col dataKey
accessor accessorKey className cls class style color fill stroke href src url
path file icon variant mode status format sort sortKey slug code ref
gridTemplateColumns gridArea padding margin flex width height font fontFamily
family fontWeight align display position background backgroundColor border
cursor transform transition opacity zIndex hovertemplate`.

**Decision.** Let D be the DISPLAY occurrences in the tool's own files.

1. If D is empty:
   - The target's `elementSrc` is outside the tool, and no occurrence exists in
     the tool → `outside-tool`.
   - Any USAGE occurrence → `used-by-code`, message *"The tool's code also uses
     this text to look things up, so changing it here could break the tool."*
   - Any OTHER occurrence → `used-by-code`, message *"This text is set in the
     tool's code in a way that isn't safe to change here."*
   - Otherwise → `computed`, message *"This text is produced by the tool's code
     while it runs, so it can't be changed here directly."*
2. Pick a candidate:
   - If |D| = 1, take it.
   - Otherwise, disambiguate in order:
     - **(a) Direct child.** Look at the candidates that are direct children of
       the JSX element at `elementSrc`: a JsxText child, or a literal inside a
       child JsxExpression, looking through child JsxFragments. If exactly one,
       take it.
     - ~~**(b) Nearest enclosing element.**~~ **Withdrawn at integration
       (2026-10-13). Do not implement it.** The rule took a duplicate because
       it sat inside an ancestor element's source span. The page root's span
       contains nearly everything, so the rule can pick the wrong literal. In
       the demo tool, a tab labelled "Gene table" (from a `TABS` constant)
       resolved to `<Card title="Gene table">` further down the page. The
       right literal is often lexically outside every DOM ancestor: in a
       const, in a data object, or in another component's JSX. No containment
       test can prove which literal produced the text. Measured on the 21
       production tools, the duplicates this rule existed for are almost all
       CSS and Plotly config values, which are never clickable text, or
       repeated data categories (`"Core"` ×11). For a category, refusing and
       handing the change to Claude is right anyway: renaming it everywhere
       is a code change.
     - **(c)** Otherwise → `ambiguous`, message *"This exact text appears in
       several places in the tool's code, so it isn't clear which one to
       change."*
3. `sameElementScope` is true when the chosen candidate passes the (a) test
   with kind `jsx-text` or `jsx-expression`. This applies even when |D| = 1.
4. If the chosen kind is `object-property` and any USAGE occurrence exists
   anywhere → `used-by-code`.
5. **Finding the element for a stamp** (used by rule (a)). Use the JsxElement or
   JsxSelfClosingElement whose `getStart()` sits at `(line-1, col-1)`. If none
   matches and the stamp is `elementSrc`, accept the single JsxElement starting
   on that line whose tag name equals `target.tagName`.

**`planTextEdit`.** The replaced span is the node's full source:
- JsxText `[pos, end)`, through `encodeJsxTextReplacement`.
- Attribute initializer `[getStart(), end)`, through `encodeJsxAttributeString`.
- StringLiteral through `encodeStringLiteral`.
- NoSubstitutionTemplateLiteral through `encodeTemplateLiteral`.

**`verifyPlannedEdit`.** Re-parse the spliced text and check:
- The parse diagnostics count is not higher than before. Use
  `(sf as any).parseDiagnostics?.length ?? 0` for both.
- If `newText !== ''`, a DISPLAY occurrence of `newText` starts inside
  `[start, start + replacement.length]`.

### `textEditService.ts`

```ts
export interface TextEditServiceDeps {
  getWorkspacePath: () => string | null;
  build: (dirName: string) => Promise<{ ok: boolean; error?: string; reason?: 'source-missing' }>;
}
export interface TextEditService {
  probe(dirName: unknown, target: unknown): Promise<TextEditProbeResult>;
  apply(dirName: unknown, req: unknown): Promise<TextEditApplyResult>;
  undo(dirName: unknown): Promise<TextEditUndoResult>;
  undoDepth(dirName: unknown): number;
}
export function createTextEditService(deps: TextEditServiceDeps): TextEditService;
```

**Input validation.** Everything arriving over IPC is untrusted.
- `dirName`: `/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/`.
- `target`:
  - `text`: a string of 1..10,000 chars, not whitespace-only.
  - `elementSrc`: a string ≤ 400 chars, or null.
  - `tagName`: a string ≤ 40 chars.
  - `ancestorSrcs`: ≤ `MAX_ANCESTOR_SRCS` strings of ≤ 400 chars each.
- `editId` matches `EDIT_ID_PATTERN`.
- `newText`:
  - Fold `\r\n|\r|\n|\t` to single spaces first.
  - Length must be ≤ `MAX_EDIT_TEXT_CHARS`.
  - Empty is allowed; it deletes the text.

Each failure returns reason `invalid` with a specific plain message.

**Reading the tool.**
- Walk `<ws>/.applications/<dir>/src/` recursively.
- Take `.tsx .ts .jsx .js` files.
- Skip `node_modules`, dot-directories and symlinks (`lstat`).
- Skip files over 2 MB; stop at 300 files.
- Cache parses by `(absPath, mtimeMs, size)`.
- A missing tool or `src/` → `invalid`.

**apply**, serialized per tool (one promise chain per `dirName`):
1. validate
2. read
3. resolve. A refusal is returned as is, with the current `undoDepth`.
4. plan
5. splice
6. verify. A failure returns `invalid`: *"Couldn't apply this change safely."*
7. Re-read the file. If it changed since step 2 → `changed`.
8. Write atomically: a temp file in the same directory, the original mode
   preserved, then rename.
9. `deps.build(dirName)`.
10. If the build is not ok and `reason !== 'source-missing'`:
    - write the old text back atomically
    - build again and ignore the result
    - return `build-failed` with the build error's first line in the message
11. Push `{editId, absFile, relFile, before, after, location}` onto the tool's
    undo stack (cap 50, drop the oldest).
12. Return ok, with `location.line` (1-based, of `start`) and
    `sameElementScope`.

**probe:** steps 1–4, no write.

**undo**, serialized per tool:
1. Pop the latest entry. An empty stack returns ok:false, *"Nothing to undo."*
2. If the file's current text is not `after`, drop the entry and return
   ok:false: *"The file has changed since that edit, so it can't be undone
   automatically."*
3. Otherwise write `before` atomically, build, and return ok with that entry's
   `editId` and `location`.

**Undo stacks** are in memory only (reset with the app). That is deliberate
for a POC.

### `textEditIpc.ts` and `index.ts`

`registerTextEditIpc(ipcMain: Pick<Electron.IpcMain, 'handle'>, service)`
registers the four `TEXT_EDIT_IPC` channels with `(event, ...args)`
signatures.

In `main/index.ts`, next to the `miniApps:build` handler, create the service:
- `getWorkspacePath: () => workspaceController.workspacePath`
- `build`: calls `buildMiniApp(workspacePath, dirName)`, imported from
  `./miniAppBuilder`, and returns `{ ok: false, error: 'No active workspace' }`
  without one.

Then register it.

### Tests (`main/textEdit/__tests__/`)

**`jsxText.test.ts`**
- **Oracle.** The real compiler is the judge, via
  `require('esbuild').transformSync(code, { loader: 'tsx', jsx: 'automatic' })`.
  Extract the emitted `children: "<json string>"` with a regex and `JSON.parse`
  it.
- Run at least 20 raw JsxText cases through the oracle against `cookJsxText`:
  - tabs, CRLF, entities, nbsp
  - leading spaces on the first line, trailing spaces on the last line
  - blank lines, whitespace-only
- Round trips: for newTexts with leading and trailing spaces, quotes, `{}<>&`,
  nbsp, emoji, backslash and an empty string, crossed with raw contexts
  (single-line, newline-led, newline-trailed, multi-line), compile
  `<b>{replacement}</b>` with the oracle and get exactly newText. Do the same
  for attribute strings and JS string and template literals.

**`resolveTextEdit.test.ts`** uses in-memory fixtures. Cover each of these:
- direct JSX text
- text split by an inline element
- multi-line text
- `<Card>Text</Card>` passed through a component
- `<Header title="X"/>` clicked on an `_reusable` element, with an ancestor stamp
- `{cond ? "A" : "B"}`
- `label:` object property
- duplicates resolved by (a)
- duplicates resolved by (b)
- unresolvable duplicates → `ambiguous`
- `{id:"Overview", label:"Overview"}` → label
- the same plus `type Tab = "Overview"` → `used-by-code`
- `d.name === "Revenue"` with `{name:"Revenue"}` → `used-by-code`
- `colors.Revenue` with `{name:"Revenue"}` → `used-by-code`
- `const T = "X"` → `used-by-code` (OTHER message)
- computed → `computed`
- entities, nbsp, emoji
- non-ASCII before the tag (UTF-16 column)
- `.ts` data file object property
- `_reusable`-only text → `outside-tool`
- another tool's stamp → treated as outside
- `parseSrcLoc` edge cases

**`textEditService.test.ts`** runs against a real tmp workspace on disk with a
fake build that records calls and can be told to fail.
- apply writes the exact expected file text
- probe never writes
- undo restores exactly
- undo after an outside modification is refused
- a failed build restores the file and says `build-failed`
- two concurrent applies to one tool both land
- invalid inputs: `../x`, a `_reusable` dirName, missing fields, too long, bad
  editId, non-string types
- a symlinked file under `src/` is ignored
- text no longer present → refusal, no write
- mode preserved after the write

Add one test with the real esbuild:
1. Apply an edit.
2. `transformSync` the written file.
3. Assert it compiles and the new text is in the output.

---

## T3 — The edit shim injected into the tool's frame

Branch `poc-edit/t3-shim`. Owns `src/cobuilding/main/miniAppEditShim.ts`
(new), its test, and the injection line in `src/cobuilding/main/externalLinks.ts`.

`export const MINI_APP_EDIT_SHIM: string` follows the form of
`miniAppSelectionShim.ts`, which you should read first:
- **ES5-style text**, never transpiled.
- **Wrapped in an IIFE** that guards `window.__acaboxEditShimInstalled` and
  returns `'installed'` or `'already-installed'`.
- **Constants interpolated** from the shared contract with
  `JSON.stringify(...)`: the attribute name, every `EDIT_MSG` value, and
  `MAX_ANCESTOR_SRCS`.

Inject it in `externalLinks.ts` beside the two existing shims, as its own
`executeJavaScript` with its own `.catch` log.

### Behaviour

**Install.**
- Add all listeners once, on `window` in the **capture** phase. Every handler
  returns immediately while edit mode is off.
- Post `{type: EDIT_MSG.ready}` to `window.parent`.
- Accept host messages by `event.data.type`; like the selection shim, do not
  check `event.source`. The host is the security boundary: it ignores frame
  messages unless it is in edit mode.

**`mode {on:true}`.**
- Inject a `<style id="__acabox_edit_style">` once.
- Add the class `__acabox-editing` to `<html>`. Its rule
  `html.__acabox-editing, html.__acabox-editing * { cursor: text !important; }`
  overrides app cursors.
- Create a layer `<div id="__acabox_edit_layer">`, appended to
  `document.documentElement`, never to `#root`:
  - `position: fixed; inset: 0; pointer-events: none; z-index: 2147483647`
  - a faint inset frame showing that edit mode is on
  - a hidden dashed hover box
- Blur any focused app control.
- Post `state {on:true, stamped:N, final:N>0}`, where `N` is the count of
  `[data-acabox-src]` elements. If `N === 0`, watch with a MutationObserver
  (subtree, childList) for up to 4000 ms. Post `state {final:true}` with the
  new count once it is above 0, or with 0 at the timeout.

**`mode {on:false}`.**
- Finish any open editor with commit.
- Remove the class, the hover box and the frame.
- Cancel a pending probe.
- Post `state {on:false, stamped:N, final:true}`.

**Blocking the app** (while on). In the window-capture handler, call
`stopPropagation()` and `stopImmediatePropagation()` for every event in this
list: `click dblclick auxclick mousedown mouseup pointerdown pointerup
contextmenu submit dragstart touchstart touchend keydown keyup keypress input
beforeinput paste cut focusin focusout`. Then apply these rules:

| Situation | Rule |
|---|---|
| Inside the open editor span | Allow the default action (caret, selection, typing). |
| Mouse, submit or dragstart events outside the editor | `preventDefault()`. |
| `focusin` on anything but the editor | `blur()` that element. |

All the editor's behaviour lives in these window handlers; none goes on the
span. Stopping propagation at window capture means a span listener would never
run.

**Hover.** On `mousemove`, throttled to 30 ms, with no editor open:
- Find the text node under the pointer (the hit test below).
- Place the dashed box around `range.getBoundingClientRect()` of that node.
- Hide the box when there is no hit, or on any `scroll` (capture).

**Hit test** `(x, y, eventTarget)`:
1. Take the node from `document.caretRangeFromPoint`, else
   `caretPositionFromPoint`, else the first non-whitespace text child of
   `eventTarget` at offset 0. The last fallback is what JSDOM uses.
2. It must be a Text node with non-blank `nodeValue`.
3. It must not be inside the layer, an open editor, `script style textarea
   input select option noscript svg math canvas iframe video audio`, or an app
   element that `isContentEditable`.
4. When a caret API was used, one of the node's client rects must contain the
   point (2 px tolerance). An empty rect list is accepted.

**Click** (on):
1. If an editor is open and the click is outside it, finish it with commit.
2. Hit-test the click.
3. On a hit, post `probe {probeId, target}`, where `target` follows
   `TextEditTarget`:
   - `text`: the node's value
   - `elementSrc`: the parent's attribute, or null
   - `tagName`: lowercase
   - `ancestorSrcs`: walk up from the parent's parent, nearest first, skip
     consecutive duplicates and values equal to the previous one, at most
     `MAX_ANCESTOR_SRCS`

   Remember `{probeId, node, offset, target}`.

**`probeResult {probeId, editable}`.**
- If it does not match the pending probe, or the node is gone, ignore it.
- Otherwise open the editor: build a `<span data-acabox-editor="direct|suggest"
  contenteditable="plaintext-only" spellcheck="true">` holding the node's text.
  If the browser rejects `plaintext-only`, fall back to `"true"`.
- Swap it in with `parent.replaceChild(span, node)`. The original Text node is
  kept, detached.
- Focus the span and put the caret at the clicked offset (clamped).
- Style: direct is a blue 2 px outline with a pale blue tint (`#0645b1`);
  suggest is amber (`#b45309`).

**Keys** (on, editor open):

| Key | Action |
|---|---|
| Enter (not during IME composition) or Tab | Commit. |
| Shift+Enter | `preventDefault()` (no newlines). |
| Escape | Cancel. |
| `beforeinput` of `insertParagraph` or `insertLineBreak` | `preventDefault()`. |
| `paste` | `preventDefault()`, then insert the clipboard's plain text with newlines folded to spaces via `document.execCommand('insertText')`. |

**Keys** (on, no editor):

| Key | Action |
|---|---|
| Escape | Post `shortcut {action:'done'}`. |
| ⌘Z or Ctrl+Z, without Shift | Post `shortcut {action:'undo'}`. |
| Anything else | Only `stopPropagation`, so scroll keys still scroll. |

**Finish editor** (`commit`).
1. Restore the original node with `span.parentNode.replaceChild(node, span)`,
   when the span is still attached.
2. Fold the text from `span.textContent`:
   - U+00A0 becomes a space, unless the old text contained U+00A0.
   - Each `[\r\n\t]+` run becomes one space.
3. If cancelled, or the text is unchanged, stop there.
4. In `suggest` mode, post `suggest {oldText, newText}`, flash amber and keep
   the old text.
5. In `direct` mode:
   - set `node.nodeValue = newText`
   - record `applied[editId] = {node, oldText, newText, src: elementSrc}`
   - post `commit {editId, target, newText}`
   - flash a pending outline
6. A window `blur` (focus left for the host, e.g. its Done button) also
   finishes with commit.

**`applyResult {editId, ok, sameElementScope}`.**
- **ok:**
  - Flash green around the parent element.
  - If `sameElementScope` and a `src` exists, set every other direct child
    Text node of elements with the same `data-acabox-src` whose value is
    `oldText` to `newText`. Remember those nodes for revert.
- **not ok:**
  - If the node still shows `newText`, put `oldText` back.
  - Flash red.
  - Forget the edit.

**`revert {editId}`.**
- If that edit's node is still connected and shows `newText`, restore
  `oldText`, plus its same-scope siblings.
- Post `reverted {editId, ok}`, with `ok` false when it could not restore.

**IDs.** `probeId` and `editId` are `'e' + counter + '-' + random base36`,
satisfying `EDIT_ID_PATTERN`.

### Tests (`main/__tests__/miniAppEditShim.test.ts`)

Mirror `miniAppSelectionShim.test.ts`: a JSDOM per case, the **real shipped
string**, and `window.parent` stubbed to capture posts. Deliver host messages
with `window.dispatchEvent(new window.MessageEvent('message', { data }))`.

Cover each of these:
- installs once and posts `ready`
- mode off: app click handlers fire
- mode on:
  - posts state with the right `stamped` count
  - the app's click, mousedown and pointerdown handlers do **not** fire
  - its document-level keydown listener does **not** fire
- click on stamped text → exact `probe` target, including ancestor dedup
- probeResult editable:
  - the span is in place with the right attributes
  - the original node is detached
  - typing then Enter restores the **same** Text node object with the new
    value and posts `commit`
- Escape restores and posts nothing
- unchanged text posts nothing
- applyResult ok:false reverts
- applyResult ok with `sameElementScope` updates siblings with the same stamp
- revert restores (`reverted ok:true`); an unknown id gives `ok:false`
- editable:false → amber editor; Enter posts `suggest` and keeps the old text
- a stale probeId is ignored
- shortcuts for Escape and ⌘Z
- mode off with an open editor commits first, then posts state `on:false`
- stamped 0 → final:false, then final:true after the timeout (fake timers)
  and, in a separate case, after stamps appear
- text in input, textarea, svg, script and whitespace-only text is never
  probed
- nbsp and newlines folded

---

## T4 — Host: Edit text in the tool viewer

Branch `poc-edit/t4-host`. Owns:
- `src/cobuilding/renderer/components/miniAppEditSession.ts` (new, pure)
- its test
- `src/cobuilding/renderer/components/MiniAppViewer.tsx`
- the edit-mode block appended to `src/cobuilding/renderer/phaseB.css`

`MiniAppViewer.tsx` cannot be imported under jest. `@assistant-ui/react` pulls
in ESM-only `assistant-stream`. So every decision goes in the pure module and
is tested there.

### `miniAppEditSession.ts` (pure, no React, no `window`)

```ts
export type EditBarTone = 'info' | 'success' | 'warning' | 'error';
export interface EditBarState { tone: EditBarTone; text: string; detail?: string;
  /** Present → the bar shows "Ask Claude"; filling the composer with askClaudePrompt(...). */
  ask?: { oldText: string; newText: string } }
export const EDIT_HINT: EditBarState;   // info: "Click any text to change it. Enter saves, Esc cancels."
export function barForProbeRefusal(r: { reason: TextEditRefusal; message: string }): EditBarState;
export function barForApply(r: TextEditApplyResult, oldText: string, newText: string): EditBarState;
export function barForUndo(r: TextEditUndoResult): EditBarState;
export function barForSuggestion(): EditBarState;
export function askClaudePrompt(oldText: string, newText: string): string;
export function parseFrameEditMessage(data: unknown): FrameEditMessage | null;
export function contentKey(o: { editing: boolean; heldNonce: number; reloadNonce: number; localReload: number }): string;
```

**`barForProbeRefusal`** returns a warning: the refusal message, then
*"Type the new text anyway and press Enter — it will go to the chat as a
request."*

**`barForApply`.**
- ok → success: `"Saved"`, with detail `"src/App.tsx · line 42"`.
- Refusals `computed`, `ambiguous`, `used-by-code` and `outside-tool` → warning
  with the message, plus `ask: {oldText, newText}`.
- `invalid`, `changed` and `build-failed` → error with the message, no `ask`.

**`barForUndo`.** ok → info: *"Undid the last change."*, with the detail of its
location. Not ok → error with the message.

**`barForSuggestion`.** info: *"Your change is in the chat as a request.
Review it and press Enter to send."*

**`askClaudePrompt`.**
`In this tool, change the text "${old}" to "${new}".` Use curly quotes.

**`parseFrameEditMessage`** validates one of the frame-to-host `EDIT_MSG` types
with the right field types:
- ids match `EDIT_ID_PATTERN`
- `target` matches `TextEditTarget`, with length limits as in T2
- `newText` and `oldText` are strings ≤ 10,000 chars
- `action` is `'undo'` or `'done'`
- `stamped` is a non-negative integer

It returns a typed union, or null for anything else. Frame data is untrusted.

**`contentKey`** returns `` `bundle-${editing ? heldNonce : reloadNonce}-${localReload}` ``.

### `MiniAppViewer.tsx`

**Header.**
- Hidden for preBuilt tools, the source view, BUILD FAILED and STILL WRITING.
- **Not editing:** an `Edit text` button (`MSymbol edit`, `cdBtnXs cdBtnXs--sm`)
  just before Rebuild.
- **Editing:**
  - The status chip reads `EDITING` with a blue dot (`cdDot--unread`).
  - Rebuild is hidden.
  - `Undo` (`MSymbol undo`) is disabled at `undoDepth === 0`, titled
    "Undo the last text change (⌘Z)".
  - `Done` (`MSymbol check`) uses `cdBtnPrimary cdBtnPrimary--sm`. Add that
    size to `phaseB.css`, at the same height as `cdBtnXs--sm`.
  - "View source" in the more menu is disabled.

**Edit bar.** While editing, render `.cdEditBar` between the header and the
body:
- a mono uppercase label `EDITING TEXT` in `--cd-blue`
- the bar text, with tone classes `--success` (`--cd-success`), `--warning`
  (`--cd-busy`) and `--error` (`--cd-error`)
- the detail in mono `--cd-text2`
- `Ask Claude`, a text button, when `ask` is set
- background `--cd-pale`, a bottom border `--cd-border`, 34 px tall

Tokens only. No raw hex, no inline styles.

**State** in `MiniAppViewer`:
- `editing`
- `heldNonce`: follows `reloadNonce` while not editing
- `localReload`
- `undoDepth`
- `bar`
- `dirty`: any applied or undone edit this session
- `stampsRebuildTried`

Key `<MiniAppContent>` with `contentKey(...)`, instead of the current
`` `bundle-${reloadNonce ?? 0}` ``. On entering edit mode, read
`textEdit.undoDepth(dirName)`.

**`MiniAppContent`** gets these props:
- `editing`
- `onEditEvent(evt)`: one callback taking a small union of `probe-refused`,
  `applied`, `refused`, `suggest`, `shortcut`, `needs-stamps`, `revert-failed`,
  `mode-off-acked` and `inflight-change`
- a ref or handle with `postToFrame(msg)`, which the viewer uses for `revert`

`MiniAppContent` handles the frame messages:
- In `handleBridgeMessage`, after the `event.source` check and **before** the
  `{type, id}` dispatch (which drops messages without an `id`), run
  `parseFrameEditMessage`.
- `ready` → if editing, post `mode {on:true}`.
- `state`:
  - `on && final && stamped === 0` → `needs-stamps`
  - `on === false` → `mode-off-acked`
- **`probe`** (editing only):
  1. `await window.miniAppsAPI.textEdit.probe(dirName, target)`.
  2. Post `probeResult {probeId, editable}`.
  3. On refusal, report it.
- **`commit`** (editing only):
  1. Track the in-flight count.
  2. `await textEdit.apply(dirName, {...target, editId, newText})`.
  3. Post `applyResult {editId, ok, sameElementScope}`.
  4. Report the result.
- `suggest` (editing only) → report.
- `shortcut` (editing only) → report.
- `reverted {ok:false}` → `revert-failed`.
- Post `mode` to the frame whenever `editing` changes and on iframe `load`.

**Viewer reactions.**

| Event | Reaction |
|---|---|
| `needs-stamps` (first time) | Bar *"Preparing this tool for editing…"*; `await window.miniAppsAPI.build(dirName)`; then bump `localReload`. |
| `needs-stamps` (second time) | Error bar: *"This tool's text can't be traced to its code, so it can't be edited here."* |
| `applied` / `refused` | Bar from `barForApply`; update `undoDepth`; set `dirty` on ok. |
| `probe-refused` | Bar from `barForProbeRefusal`. |
| `suggest` | Open the chat if closed (`onToggleChat`); `composerRuntime.setText(askClaudePrompt(...))`, with no `send()`; `barForSuggestion()`. |
| Ask Claude button | Same as `suggest`, from `bar.ask`. |
| `shortcut undo` / Undo button | `textEdit.undo(dirName)`. On ok: post `revert {editId}`, set `dirty`, update `undoDepth`. Show `barForUndo`. |
| `revert-failed` | Bump `localReload`. |
| `shortcut done` / Done button | Post `mode {on:false}`. Wait for `mode-off-acked` **and** in-flight 0 (timeout 3 s), then `editing = false`. If `dirty` and `reloadNonce === heldNonce`, bump `localReload` so the tool always reloads onto its rebuilt bundle. Reset `bar` and `dirty`. |

### Tests (`renderer/components/__tests__/miniAppEditSession.test.ts`)

- every bar function, for every reason
- `askClaudePrompt` exact text
- `contentKey` while editing and not editing
- `parseFrameEditMessage` accepts each valid type
- it rejects:
  - wrong types and missing fields
  - bad ids, including `"../x"`, an empty string and 65 characters
  - an oversized text
  - ancestorSrcs over the limit
  - non-objects
  - an unknown `type`
  - a host-to-frame type such as `acabox:edit:mode`

Acceptance: gate passes. Run `npm start` and check that the edit bar renders.
A screenshot is the reviewer's job; do not leave a dev instance running.

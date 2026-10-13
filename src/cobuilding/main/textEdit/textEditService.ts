/**
 * Edit a tool's text in place (POC; docs/design/mini-app-text-edit-poc.md, T2):
 * the part that touches the disk. It reads a tool's source, asks the resolver
 * which literal a clicked text came from, rewrites that one literal, proves the
 * tool still builds, and keeps an undo stack. Zero model calls.
 *
 * Electron-free on purpose (the build and the workspace are injected), so it
 * runs under jest against a real directory. The TypeScript parser is loaded on
 * first use rather than at startup: it is the heaviest module in the app and
 * most launches never edit a word.
 *
 * Everything that arrives over IPC is untrusted, so every input is validated
 * here, and every failure is a typed refusal with a plain message, never a throw.
 */
import { randomUUID } from 'crypto';
import type { Dirent } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  EDIT_ID_PATTERN,
  MAX_ANCESTOR_SRCS,
  MAX_EDIT_TEXT_CHARS,
  type TextEditApplyResult,
  type TextEditLocation,
  type TextEditProbeResult,
  type TextEditRefusal,
  type TextEditTarget,
  type TextEditUndoResult,
} from '../../shared/miniAppTextEdit';
import type { AppSource } from './resolveTextEdit';

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

const DIR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_TARGET_TEXT_CHARS = 10_000;
const MAX_STAMP_CHARS = 400;
const MAX_TAG_CHARS = 40;

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.tsx', '.ts', '.jsx', '.js']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 300;
/** Parsed files kept between clicks, keyed by path; the oldest go first. */
const MAX_CACHED_FILES = 600;

/** Undo is in memory only: it resets with the app, which is deliberate for a POC. */
const UNDO_DEPTH_CAP = 50;
/** Backstop against a few huge files filling memory with before/after copies. */
const UNDO_CHARS_CAP = 20_000_000;

const MESSAGES = {
  badTool: "That isn't a valid tool name.",
  noWorkspace: 'No workspace is open.',
  noSource: "This tool has no source code folder that can be edited.",
  noText: 'There is no text to change.',
  textTooLong: 'That text is too long to change here.',
  badLocation: "The text's place in the tool's code is not valid.",
  badEditId: 'That edit has no valid id.',
  noNewText: 'The new text is missing.',
  newTextTooLong: `The new text is too long. The limit is ${MAX_EDIT_TEXT_CHARS} characters.`,
  unsafe: "Couldn't apply this change safely.",
  changed: "The tool's code changed while this edit was being made, so nothing was saved. Try again.",
  writeFailed: "Couldn't save the change to the tool's code.",
  internal: 'Something went wrong while changing this text.',
  nothingToUndo: 'Nothing to undo.',
  undoStale: "The file has changed since that edit, so it can't be undone automatically.",
} as const;

type Failure = { reason: TextEditRefusal; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateDirName(value: unknown): { ok: true; dirName: string } | { ok: false; failure: Failure } {
  if (typeof value !== 'string' || !DIR_NAME_PATTERN.test(value)) {
    return { ok: false, failure: { reason: 'invalid', message: MESSAGES.badTool } };
  }
  return { ok: true, dirName: value };
}

function validateTarget(value: unknown): { ok: true; target: TextEditTarget } | { ok: false; failure: Failure } {
  const bad = (message: string) => ({ ok: false as const, failure: { reason: 'invalid' as const, message } });
  if (!isRecord(value)) return bad(MESSAGES.noText);
  const { text, elementSrc, tagName, ancestorSrcs } = value;
  if (typeof text !== 'string' || text.trim() === '') return bad(MESSAGES.noText);
  if (text.length > MAX_TARGET_TEXT_CHARS) return bad(MESSAGES.textTooLong);
  if (elementSrc !== null && (typeof elementSrc !== 'string' || elementSrc.length > MAX_STAMP_CHARS)) return bad(MESSAGES.badLocation);
  if (typeof tagName !== 'string' || tagName.length > MAX_TAG_CHARS) return bad(MESSAGES.badLocation);
  if (!Array.isArray(ancestorSrcs) || ancestorSrcs.length > MAX_ANCESTOR_SRCS) return bad(MESSAGES.badLocation);
  for (const stamp of ancestorSrcs) {
    if (typeof stamp !== 'string' || stamp.length > MAX_STAMP_CHARS) return bad(MESSAGES.badLocation);
  }
  return { ok: true, target: { text, elementSrc, tagName, ancestorSrcs: [...(ancestorSrcs as string[])] } };
}

/** Newlines and tabs cannot be typed into one line of source, so they become single spaces. */
function foldNewText(text: string): string {
  return text.replace(/\r\n|\r|\n|\t/g, ' ');
}

function validateApply(value: unknown):
  | { ok: true; editId: string; target: TextEditTarget; newText: string }
  | { ok: false; editId: string; failure: Failure } {
  const editIdForReply = isRecord(value) && typeof value.editId === 'string' ? value.editId.slice(0, 64) : '';
  const bad = (message: string) => ({ ok: false as const, editId: editIdForReply, failure: { reason: 'invalid' as const, message } });
  if (!isRecord(value)) return bad(MESSAGES.noText);
  const target = validateTarget(value);
  if (!target.ok) return { ok: false, editId: editIdForReply, failure: target.failure };
  if (typeof value.editId !== 'string' || !EDIT_ID_PATTERN.test(value.editId)) return bad(MESSAGES.badEditId);
  if (typeof value.newText !== 'string') return bad(MESSAGES.noNewText);
  const newText = foldNewText(value.newText);
  if (newText.length > MAX_EDIT_TEXT_CHARS) return bad(MESSAGES.newTextTooLong);
  return { ok: true, editId: value.editId, target: target.target, newText };
}

// ── Source files ───────────────────────────────────────────────────────

interface ToolFile {
  source: AppSource;
  abs: string;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  source: AppSource;
}

/** One-based line of a character offset, counting \r\n, \r and \n as one break each. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
    if (c === 0x0a || c === 0x0d) line++;
  }
  return line;
}

function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The first line of a build error, without terminal colours, short enough for one line of UI. */
function firstErrorLine(error: string | undefined): string {
  const colour = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const line = (error ?? '').replace(colour, '').split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > 200 ? line.slice(0, 200) + '...' : line;
}

/** Writes a file so a reader sees the old text or the new text, never half of it, and keeps its permissions. */
async function writeFileAtomic(abs: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await fsp.stat(abs)).mode & 0o7777;
  } catch {
    mode = undefined;
  }
  try {
    await fsp.writeFile(tmp, text, { encoding: 'utf8', mode: mode ?? 0o644 });
    if (mode !== undefined) await fsp.chmod(tmp, mode); // writeFile's mode is trimmed by the umask
    await fsp.rename(tmp, abs);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads a file as UTF-8 text, keeping a byte order mark; null when it is missing or not valid UTF-8. */
async function readUtf8(abs: string): Promise<string | null> {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fsp.readFile(abs));
  } catch {
    return null;
  }
}

interface UndoEntry {
  editId: string;
  absFile: string;
  before: string;
  after: string;
  location: TextEditLocation;
}

export function createTextEditService(deps: TextEditServiceDeps): TextEditService {
  const queues = new Map<string, Promise<unknown>>();
  const undoStacks = new Map<string, UndoEntry[]>();
  const fileCache = new Map<string, CachedFile>();
  let resolverModule: Promise<typeof import('./resolveTextEdit')> | null = null;

  function loadResolver(): Promise<typeof import('./resolveTextEdit')> {
    if (!resolverModule) {
      resolverModule = import('./resolveTextEdit').catch((error) => {
        resolverModule = null; // let the next click try again
        throw error;
      });
    }
    return resolverModule;
  }

  /** Runs jobs for one tool one at a time, so two edits to a tool never interleave. */
  function enqueue<T>(dirName: string, job: () => Promise<T>): Promise<T> {
    const previous = queues.get(dirName) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(job);
    queues.set(dirName, next);
    next.catch(() => undefined).finally(() => {
      if (queues.get(dirName) === next) queues.delete(dirName);
    });
    return next;
  }

  function stackFor(dirName: string): UndoEntry[] {
    let stack = undoStacks.get(dirName);
    if (!stack) {
      stack = [];
      undoStacks.set(dirName, stack);
    }
    return stack;
  }

  function depthOf(dirName: string): number {
    return undoStacks.get(dirName)?.length ?? 0;
  }

  function pushUndo(dirName: string, entry: UndoEntry): number {
    const stack = stackFor(dirName);
    stack.push(entry);
    let chars = stack.reduce((sum, e) => sum + e.before.length + e.after.length, 0);
    while (stack.length > UNDO_DEPTH_CAP || (stack.length > 1 && chars > UNDO_CHARS_CAP)) {
      const dropped = stack.shift() as UndoEntry;
      chars -= dropped.before.length + dropped.after.length;
    }
    return stack.length;
  }

  async function collectFiles(dir: string, relDir: string, out: ToolFile[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await collectFiles(abs, `${relDir}${entry.name}/`, out);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;

      let stat;
      try {
        stat = await fsp.lstat(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

      const cached = fileCache.get(abs);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        out.push({ source: cached.source, abs });
        continue;
      }
      const text = await readUtf8(abs);
      if (text === null) continue;
      const source: AppSource = { path: `${relDir}${entry.name}`, text };
      fileCache.delete(abs);
      fileCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, source });
      while (fileCache.size > MAX_CACHED_FILES) fileCache.delete(fileCache.keys().next().value as string);
      out.push({ source, abs });
    }
  }

  /** Every source file under the tool's src/, or why there are none to read. */
  async function readTool(dirName: string): Promise<{ ok: true; files: ToolFile[] } | { ok: false; failure: Failure }> {
    const workspace = deps.getWorkspacePath();
    if (!workspace) return { ok: false, failure: { reason: 'invalid', message: MESSAGES.noWorkspace } };
    const appsDir = path.join(workspace, '.applications');
    const srcDir = path.join(appsDir, dirName, 'src');
    try {
      const stat = await fsp.lstat(srcDir);
      if (!stat.isDirectory()) throw new Error('src is not a plain directory');
      // A tool folder that leads out of .applications is not ours to write into.
      if (!isInside(await fsp.realpath(appsDir), await fsp.realpath(srcDir))) throw new Error('src leaves the workspace');
    } catch {
      return { ok: false, failure: { reason: 'invalid', message: MESSAGES.noSource } };
    }
    const files: ToolFile[] = [];
    await collectFiles(srcDir, 'src/', files);
    return { ok: true, files };
  }

  async function runBuild(dirName: string): Promise<{ ok: boolean; error?: string; reason?: 'source-missing' }> {
    try {
      return await deps.build(dirName);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── probe ────────────────────────────────────────────────────────────

  async function probe(dirNameIn: unknown, targetIn: unknown): Promise<TextEditProbeResult> {
    const dir = validateDirName(dirNameIn);
    if (!dir.ok) return { editable: false, ...dir.failure };
    const target = validateTarget(targetIn);
    if (!target.ok) return { editable: false, ...target.failure };
    try {
      const tool = await readTool(dir.dirName);
      if (!tool.ok) return { editable: false, ...tool.failure };

      const resolver = await loadResolver();
      const resolution = resolver.resolveTextEdit({ dirName: dir.dirName, files: tool.files.map((f) => f.source), target: target.target });
      if (!resolution.ok) return { editable: false, reason: resolution.reason, message: resolution.message };
      const file = tool.files.find((f) => f.source.path === resolution.file) as ToolFile;
      return { editable: true, location: { file: resolution.file, line: lineOf(file.source.text, resolution.start), kind: resolution.kind } };
    } catch {
      return { editable: false, reason: 'invalid', message: MESSAGES.internal };
    }
  }

  // ── apply ────────────────────────────────────────────────────────────

  async function applyEdit(
    dirName: string,
    editId: string,
    target: TextEditTarget,
    newText: string,
  ): Promise<TextEditApplyResult> {
    const refuse = (reason: TextEditRefusal, message: string): TextEditApplyResult => ({
      ok: false, editId, reason, message, undoDepth: depthOf(dirName),
    });

    const tool = await readTool(dirName);
    if (!tool.ok) return refuse(tool.failure.reason, tool.failure.message);
    const resolver = await loadResolver();
    const resolution = resolver.resolveTextEdit({ dirName, files: tool.files.map((f) => f.source), target });
    if (!resolution.ok) return refuse(resolution.reason, resolution.message);

    const file = tool.files.find((f) => f.source.path === resolution.file) as ToolFile;
    const before = file.source;
    const location: TextEditLocation = { file: resolution.file, line: lineOf(before.text, resolution.start), kind: resolution.kind };
    // Typing the same text back is not an edit; leave the file alone.
    if (newText === target.text) {
      return { ok: true, editId, location, undoDepth: depthOf(dirName), sameElementScope: resolution.sameElementScope };
    }

    const plan = resolver.planTextEdit(before, resolution, newText);
    const afterText = before.text.slice(0, plan.start) + plan.replacement + before.text.slice(plan.end);
    if (!resolver.verifyPlannedEdit(before, afterText, plan, newText)) return refuse('invalid', MESSAGES.unsafe);

    // Someone else (the agent, an editor) may have written the file since we read it.
    if ((await readUtf8(file.abs)) !== before.text) return refuse('changed', MESSAGES.changed);

    try {
      await writeFileAtomic(file.abs, afterText);
    } catch {
      return refuse('invalid', MESSAGES.writeFailed);
    }

    const built = await runBuild(dirName);
    if (!built.ok && built.reason !== 'source-missing') {
      let restored = true;
      try {
        await writeFileAtomic(file.abs, before.text);
      } catch {
        restored = false;
      }
      await runBuild(dirName); // bring dist/ back in line with the source; the result does not matter here
      const why = firstErrorLine(built.error);
      const lead = restored
        ? 'That change stopped the tool from building, so it was put back.'
        : `That change stopped the tool from building, and the old text could not be put back. Check ${resolution.file}.`;
      return refuse('build-failed', why === '' ? lead : `${lead} ${why}`);
    }

    const undoDepth = pushUndo(dirName, { editId, absFile: file.abs, before: before.text, after: afterText, location });
    return { ok: true, editId, location, undoDepth, sameElementScope: resolution.sameElementScope };
  }

  async function apply(dirNameIn: unknown, reqIn: unknown): Promise<TextEditApplyResult> {
    const req = validateApply(reqIn);
    const dir = validateDirName(dirNameIn);
    if (!req.ok) return { ok: false, editId: req.editId, ...req.failure, undoDepth: dir.ok ? depthOf(dir.dirName) : 0 };
    if (!dir.ok) return { ok: false, editId: req.editId, ...dir.failure, undoDepth: 0 };
    return enqueue(dir.dirName, () => applyEdit(dir.dirName, req.editId, req.target, req.newText)).catch((): TextEditApplyResult => ({
      ok: false, editId: req.editId, reason: 'invalid', message: MESSAGES.internal, undoDepth: depthOf(dir.dirName),
    }));
  }

  // ── undo ─────────────────────────────────────────────────────────────

  async function undoLatest(dirName: string): Promise<TextEditUndoResult> {
    const entry = undoStacks.get(dirName)?.pop();
    if (!entry) return { ok: false, message: MESSAGES.nothingToUndo, undoDepth: depthOf(dirName) };
    if ((await readUtf8(entry.absFile)) !== entry.after) {
      return { ok: false, message: MESSAGES.undoStale, undoDepth: depthOf(dirName) };
    }
    try {
      await writeFileAtomic(entry.absFile, entry.before);
    } catch {
      return { ok: false, message: MESSAGES.writeFailed, undoDepth: depthOf(dirName) };
    }
    const built = await runBuild(dirName);
    if (!built.ok && built.reason !== 'source-missing') {
      const why = firstErrorLine(built.error);
      const message = `The text was put back in the tool's code, but the tool did not rebuild.${why === '' ? '' : ` ${why}`}`;
      return { ok: false, message, undoDepth: depthOf(dirName) };
    }
    return { ok: true, editId: entry.editId, location: entry.location, undoDepth: depthOf(dirName) };
  }

  async function undo(dirNameIn: unknown): Promise<TextEditUndoResult> {
    const dir = validateDirName(dirNameIn);
    if (!dir.ok) return { ok: false, message: dir.failure.message, undoDepth: 0 };
    return enqueue(dir.dirName, () => undoLatest(dir.dirName)).catch((): TextEditUndoResult => ({
      ok: false, message: MESSAGES.internal, undoDepth: depthOf(dir.dirName),
    }));
  }

  function undoDepth(dirNameIn: unknown): number {
    const dir = validateDirName(dirNameIn);
    return dir.ok ? depthOf(dir.dirName) : 0;
  }

  return { probe, apply, undo, undoDepth };
}

/**
 * Every decision "Edit text" makes in the tool viewer, as pure functions
 * (POC: docs/design/mini-app-text-edit-poc.md, ticket T4).
 *
 * `MiniAppViewer.tsx` renders the edit bar and relays messages between the
 * tool's frame and main, but it cannot be imported under jest as it stands:
 * `@assistant-ui/react` pulls in the ESM-only `assistant-stream` package, which
 * is not in jest's `transformIgnorePatterns` whitelist (the same constraint
 * that put `classifyBuildResult` in `miniAppBuildState.tsx`). So anything that
 * is a rule rather than plumbing lives here and is tested here: what the bar
 * says for each outcome, which frame messages are believable, what key the
 * iframe mounts under, and when a stage of the Done handshake is complete.
 * (`MiniAppViewer.edit.test.tsx` tests the plumbing that joins them, with that
 * one package stubbed.)
 *
 * No React, no `window`, no `electron`.
 */

import { EDIT_ID_PATTERN, EDIT_MSG, MAX_ANCESTOR_SRCS } from '../../shared/miniAppTextEdit';
import type {
  TextEditApplyResult,
  TextEditLocation,
  TextEditRefusal,
  TextEditTarget,
  TextEditUndoResult,
} from '../../shared/miniAppTextEdit';

// ── The edit bar ─────────────────────────────────────────────────────────────

export type EditBarTone = 'info' | 'success' | 'warning' | 'error';

export interface EditBarState {
  tone: EditBarTone;
  text: string;
  /** Mono, quieter: where an edit landed (`src/App.tsx · line 42`) or the first line of an error. */
  detail?: string;
  /**
   * Present: the bar offers "Ask Claude", which fills the chat composer with
   * `askClaudePrompt(oldText, newText)`. It only fills it; the user sends.
   */
  ask?: { oldText: string; newText: string };
}

export const EDIT_HINT: EditBarState = {
  tone: 'info',
  text: 'Click any text to change it. Enter saves, Esc cancels.',
};

/** Shown while a tool built without source stamps is rebuilt so it can be edited. */
export const EDIT_PREPARING: EditBarState = {
  tone: 'info',
  text: 'Preparing this tool for editing…',
};

/** The rebuild already happened and the text still cannot be traced to its code. */
export const EDIT_UNTRACEABLE: EditBarState = {
  tone: 'error',
  text: "This tool's text can't be traced to its code, so it can't be edited here.",
};

const TYPE_ANYWAY = 'Type the new text anyway and press Enter — it will go to the chat as a request.';

/** `src/App.tsx · line 42` */
function describeLocation(location: TextEditLocation): string {
  return `${location.file} · line ${location.line}`;
}

/**
 * The user clicked text that cannot be changed directly. The frame opens its
 * amber editor for any refusal, so the invitation to type anyway holds for
 * every reason.
 */
export function barForProbeRefusal(r: { reason: TextEditRefusal; message: string }): EditBarState {
  return { tone: 'warning', text: `${r.message} ${TYPE_ANYWAY}` };
}

/**
 * What an `apply` came back with. Four refusals mean "the text is real but
 * lives where a direct edit would be unsafe", and those can still become a
 * request to Claude, so they carry `ask`. The other three mean the change did
 * not happen for a reason a request cannot fix (bad input, a stale source, a
 * build that broke), so they are errors with nothing to offer.
 */
export function barForApply(r: TextEditApplyResult, oldText: string, newText: string): EditBarState {
  if (r.ok) return { tone: 'success', text: 'Saved', detail: describeLocation(r.location) };
  switch (r.reason) {
    case 'computed':
    case 'ambiguous':
    case 'used-by-code':
    case 'outside-tool':
      return { tone: 'warning', text: r.message, ask: { oldText, newText } };
    case 'invalid':
    case 'changed':
    case 'build-failed':
      return { tone: 'error', text: r.message };
    default: {
      // Compile-time exhaustiveness: a new refusal reason in the contract
      // fails the build here instead of silently reading as an error.
      const unhandled: never = r.reason;
      void unhandled;
      return { tone: 'error', text: r.message };
    }
  }
}

export function barForUndo(r: TextEditUndoResult): EditBarState {
  return r.ok
    ? { tone: 'info', text: 'Undid the last change.', detail: describeLocation(r.location) }
    : { tone: 'error', text: r.message };
}

export function barForSuggestion(): EditBarState {
  return { tone: 'info', text: 'Your change is in the chat as a request. Review it and press Enter to send.' };
}

/** The rebuild that adds source stamps failed, so the tool cannot be edited. */
export function barForPrepareFailure(error: string | undefined): EditBarState {
  const firstLine = (error ?? '').split(/\r\n|\n|\r/).map((l) => l.trim()).find((l) => l !== '');
  return {
    tone: 'error',
    text: "Couldn't prepare this tool for editing.",
    ...(firstLine ? { detail: firstLine } : {}),
  };
}

/** What the composer is filled with for text that cannot be edited in source. Curly quotes. */
export function askClaudePrompt(oldText: string, newText: string): string {
  return `In this tool, change the text “${oldText}” to “${newText}”.`;
}

// ── Frame → host messages ────────────────────────────────────────────────────

/**
 * A frame message that passed validation: the same shape the shim posts (the
 * fields `EDIT_MSG` documents), discriminated by `type`. Rebuilt field by field
 * rather than passed through, so a valid message comes out equal to what was
 * sent and nothing the frame added on top survives.
 */
export type FrameEditMessage =
  | { type: typeof EDIT_MSG.ready }
  | { type: typeof EDIT_MSG.state; on: boolean; stamped: number; final: boolean }
  | { type: typeof EDIT_MSG.probe; probeId: string; target: TextEditTarget }
  | { type: typeof EDIT_MSG.commit; editId: string; target: TextEditTarget; newText: string }
  | { type: typeof EDIT_MSG.suggest; oldText: string; newText: string }
  | { type: typeof EDIT_MSG.shortcut; action: 'undo' | 'done' }
  | { type: typeof EDIT_MSG.reverted; editId: string; ok: boolean };

/**
 * Longest text the host will relay. Main enforces its own, tighter limit on
 * the replacement (`MAX_EDIT_TEXT_CHARS`) and answers `invalid`; this one only
 * keeps a runaway message out of IPC.
 */
const MAX_FRAME_TEXT_CHARS = 10_000;
const MAX_SRC_CHARS = 400;
const MAX_TAG_CHARS = 40;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEditId(v: unknown): v is string {
  return typeof v === 'string' && EDIT_ID_PATTERN.test(v);
}

function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}

/**
 * Re-built field by field rather than passed through, so a frame cannot
 * smuggle extra properties across the IPC boundary inside `target`.
 */
function parseTarget(v: unknown): TextEditTarget | null {
  if (!isRecord(v)) return null;
  const { text, elementSrc, tagName, ancestorSrcs } = v;
  if (!isBoundedString(text, MAX_FRAME_TEXT_CHARS) || text.trim() === '') return null;
  if (elementSrc !== null && !isBoundedString(elementSrc, MAX_SRC_CHARS)) return null;
  if (!isBoundedString(tagName, MAX_TAG_CHARS)) return null;
  if (!Array.isArray(ancestorSrcs) || ancestorSrcs.length > MAX_ANCESTOR_SRCS) return null;
  // Array.from, not the array itself: `every` skips the holes of a sparse
  // array, and a hole is not a string.
  const srcs: unknown[] = Array.from(ancestorSrcs);
  if (!srcs.every((s): s is string => isBoundedString(s, MAX_SRC_CHARS))) return null;
  return { text, elementSrc, tagName, ancestorSrcs: srcs };
}

/**
 * Validate one message the injected edit shim posted to the host. Frame data is
 * untrusted: the shim is injected into a document whose own code the host does
 * not control, and the host cannot tell the shim's messages from that code's.
 * Anything that is not exactly one of the seven frame → host shapes in
 * `EDIT_MSG` returns null. That includes the host → frame types (`mode`,
 * `probeResult`, `applyResult`, `revert`), which a frame has no business
 * sending.
 */
export function parseFrameEditMessage(data: unknown): FrameEditMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case EDIT_MSG.ready:
      return { type: EDIT_MSG.ready };

    case EDIT_MSG.state: {
      const { on, stamped, final } = data;
      if (typeof on !== 'boolean' || typeof final !== 'boolean') return null;
      if (typeof stamped !== 'number' || !Number.isSafeInteger(stamped) || stamped < 0) return null;
      return { type: EDIT_MSG.state, on, stamped, final };
    }

    case EDIT_MSG.probe: {
      const { probeId } = data;
      const target = parseTarget(data.target);
      if (!isEditId(probeId) || !target) return null;
      return { type: EDIT_MSG.probe, probeId, target };
    }

    case EDIT_MSG.commit: {
      const { editId, newText } = data;
      const target = parseTarget(data.target);
      if (!isEditId(editId) || !target) return null;
      if (!isBoundedString(newText, MAX_FRAME_TEXT_CHARS)) return null;
      return { type: EDIT_MSG.commit, editId, target, newText };
    }

    case EDIT_MSG.suggest: {
      const { oldText, newText } = data;
      if (!isBoundedString(oldText, MAX_FRAME_TEXT_CHARS) || !isBoundedString(newText, MAX_FRAME_TEXT_CHARS)) return null;
      return { type: EDIT_MSG.suggest, oldText, newText };
    }

    case EDIT_MSG.shortcut: {
      const { action } = data;
      if (action !== 'undo' && action !== 'done') return null;
      return { type: EDIT_MSG.shortcut, action };
    }

    case EDIT_MSG.reverted: {
      const { editId, ok } = data;
      if (!isEditId(editId) || typeof ok !== 'boolean') return null;
      return { type: EDIT_MSG.reverted, editId, ok };
    }

    default:
      return null;
  }
}

// ── Reloads and the Done handshake ───────────────────────────────────────────

/**
 * The key the tool's iframe mounts under.
 *
 * While editing it uses `heldNonce`, the reload nonce as it stood when edit
 * mode began, instead of the live one. Every save rebuilds the tool and main
 * announces each build, which bumps `reloadNonce`; keyed on that, the iframe
 * would remount after every keystroke-save and throw away the very editor the
 * user is typing in. Done releases the key, so the tool reloads once.
 * `localReload` is the viewer's own bump, for reloads that no build asked for.
 */
export function contentKey(o: { editing: boolean; heldNonce: number; reloadNonce: number; localReload: number }): string {
  return `bundle-${o.editing ? o.heldNonce : o.reloadNonce}-${o.localReload}`;
}

/** How long Done waits for the frame to confirm and for saves to land before it closes anyway. */
export const DONE_WAIT_MS = 3000;

/**
 * Done may close edit mode once the frame has confirmed it left edit mode (any
 * open editor was committed first) and no save is still in flight. Closing
 * earlier would reload the tool before the last edit was written.
 */
export function isDoneSettled(s: { acked: boolean; inFlight: number }): boolean {
  return s.acked && s.inFlight <= 0;
}

/**
 * Leaving edit mode releases the iframe key, so an edit that moved the reload
 * nonce reloads the tool by itself. When edits were made but the nonce never
 * moved (nothing announced the build), the key would stay put and the tool
 * would keep showing the pre-edit bundle; a local bump covers that case.
 */
export function needsLocalReload(o: { dirty: boolean; reloadNonce: number; heldNonce: number }): boolean {
  return o.dirty && o.reloadNonce === o.heldNonce;
}

/**
 * The frame reported, finally, that its bundle has no source stamps (the agent
 * built it with bare esbuild). One rebuild per edit session adds them; a second
 * report after that means the stamps are not coming, and looping would never
 * end.
 */
export function stampsAction(alreadyRebuilt: boolean): 'rebuild' | 'give-up' {
  return alreadyRebuilt ? 'give-up' : 'rebuild';
}

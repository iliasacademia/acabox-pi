/**
 * The pure half of "Edit text" in the tool viewer: what the edit bar says, which
 * frame messages are believed, what key the iframe mounts under, and when the
 * Done handshake may close. Imported from `miniAppEditSession.ts`, not from
 * `MiniAppViewer.tsx` (that file imports `@assistant-ui/react`, whose
 * ESM-only `assistant-stream` dependency jest cannot load).
 */

import {
  DONE_WAIT_MS,
  EDIT_HINT,
  EDIT_PREPARING,
  EDIT_UNTRACEABLE,
  askClaudePrompt,
  barForApply,
  barForPrepareFailure,
  barForProbeRefusal,
  barForSuggestion,
  barForUndo,
  contentKey,
  isDoneSettled,
  needsLocalReload,
  parseFrameEditMessage,
  stampsAction,
} from '../miniAppEditSession';
import { EDIT_MSG, MAX_ANCESTOR_SRCS } from '../../../shared/miniAppTextEdit';
import type {
  TextEditApplyResult,
  TextEditLocation,
  TextEditRefusal,
  TextEditTarget,
  TextEditUndoResult,
} from '../../../shared/miniAppTextEdit';

const LOCATION: TextEditLocation = { file: 'src/App.tsx', line: 42, kind: 'jsx-text' };

/**
 * Typed as a Record over the contract's refusal reasons, so adding a reason to
 * `TextEditRefusal` fails compilation here until the bar's behaviour for it has
 * been decided and listed.
 */
const MESSAGES: Record<TextEditRefusal, string> = {
  computed: "This text is produced by the tool's code while it runs, so it can't be changed here directly.",
  ambiguous: "This exact text appears in several places in the tool's code, so it isn't clear which one to change.",
  'used-by-code': "The tool's code also uses this text to look things up, so changing it here could break the tool.",
  'outside-tool': 'This text comes from a part that is shared between tools.',
  invalid: "Couldn't apply this change safely.",
  changed: "The tool's code changed since it was last built. Rebuild it and try again.",
  'build-failed': 'The tool stopped building after this change, so it was put back.',
};
const ALL_REASONS = Object.keys(MESSAGES) as TextEditRefusal[];
/** Refusals where the text is real but unsafe to edit directly: a request to Claude is still possible. */
const ASKABLE: TextEditRefusal[] = ['computed', 'ambiguous', 'used-by-code', 'outside-tool'];
const NOT_ASKABLE: TextEditRefusal[] = ['invalid', 'changed', 'build-failed'];

function refused(reason: TextEditRefusal, undoDepth = 3): TextEditApplyResult {
  return { ok: false, editId: 'e1-abc', reason, message: MESSAGES[reason], undoDepth };
}

describe('EDIT_HINT', () => {
  it('is the info line shown on entering edit mode', () => {
    expect(EDIT_HINT).toEqual({ tone: 'info', text: 'Click any text to change it. Enter saves, Esc cancels.' });
  });
});

describe('barForProbeRefusal', () => {
  it.each(ALL_REASONS)('is a warning that says why and invites typing anyway (%s)', (reason) => {
    const bar = barForProbeRefusal({ reason, message: MESSAGES[reason] });
    expect(bar.tone).toBe('warning');
    expect(bar.text).toBe(
      `${MESSAGES[reason]} Type the new text anyway and press Enter — it will go to the chat as a request.`,
    );
    // The request itself is made by the amber editor in the frame, not by a bar button.
    expect(bar.ask).toBeUndefined();
    expect(bar.detail).toBeUndefined();
  });
});

describe('barForApply', () => {
  it('reads Saved with where the edit landed', () => {
    const ok: TextEditApplyResult = {
      ok: true, editId: 'e1-abc', location: LOCATION, undoDepth: 1, sameElementScope: true,
    };
    expect(barForApply(ok, 'Old', 'New')).toEqual({
      tone: 'success',
      text: 'Saved',
      detail: 'src/App.tsx · line 42',
    });
  });

  it('names the file as given, including folders, and the line', () => {
    const ok: TextEditApplyResult = {
      ok: true, editId: 'e1-abc', location: { file: 'src/components/Card.tsx', line: 7, kind: 'object-property' },
      undoDepth: 2, sameElementScope: false,
    };
    expect(barForApply(ok, 'Old', 'New').detail).toBe('src/components/Card.tsx · line 7');
  });

  it('never offers Ask Claude for a saved edit', () => {
    const ok: TextEditApplyResult = {
      ok: true, editId: 'e1-abc', location: LOCATION, undoDepth: 1, sameElementScope: false,
    };
    expect(barForApply(ok, 'Old', 'New').ask).toBeUndefined();
  });

  it.each(ASKABLE)('%s: a warning that carries the request for Claude', (reason) => {
    expect(barForApply(refused(reason), 'Showing 312 genes', 'Showing 400 genes')).toEqual({
      tone: 'warning',
      text: MESSAGES[reason],
      ask: { oldText: 'Showing 312 genes', newText: 'Showing 400 genes' },
    });
  });

  it.each(NOT_ASKABLE)('%s: an error with nothing to ask Claude', (reason) => {
    const bar = barForApply(refused(reason), 'Old', 'New');
    expect(bar).toEqual({ tone: 'error', text: MESSAGES[reason] });
    expect('ask' in bar).toBe(false);
  });

  it('covers every refusal the contract defines', () => {
    expect([...ASKABLE, ...NOT_ASKABLE].sort()).toEqual([...ALL_REASONS].sort());
  });
});

describe('barForUndo', () => {
  it('says what was undone and where', () => {
    const ok: TextEditUndoResult = { ok: true, editId: 'e1-abc', location: LOCATION, undoDepth: 0 };
    expect(barForUndo(ok)).toEqual({
      tone: 'info',
      text: 'Undid the last change.',
      detail: 'src/App.tsx · line 42',
    });
  });

  it("is an error carrying main's message when nothing could be undone", () => {
    const no: TextEditUndoResult = { ok: false, message: 'Nothing to undo.', undoDepth: 0 };
    expect(barForUndo(no)).toEqual({ tone: 'error', text: 'Nothing to undo.' });
  });

  it('keeps the file-changed explanation intact', () => {
    const msg = "The file has changed since that edit, so it can't be undone automatically.";
    expect(barForUndo({ ok: false, message: msg, undoDepth: 2 })).toEqual({ tone: 'error', text: msg });
  });
});

describe('barForSuggestion', () => {
  it('tells the user the request is in the chat and still unsent', () => {
    expect(barForSuggestion()).toEqual({
      tone: 'info',
      text: 'Your change is in the chat as a request. Review it and press Enter to send.',
    });
  });
});

describe('the two fixed bars for a tool without stamps', () => {
  it('says it is preparing while the tool is rebuilt', () => {
    expect(EDIT_PREPARING).toEqual({ tone: 'info', text: 'Preparing this tool for editing…' });
  });

  it('says plainly that the text cannot be traced when the rebuild did not help', () => {
    expect(EDIT_UNTRACEABLE).toEqual({
      tone: 'error',
      text: "This tool's text can't be traced to its code, so it can't be edited here.",
    });
  });
});

describe('barForPrepareFailure', () => {
  it('is an error whose detail is the first non-blank line of the build output', () => {
    const bar = barForPrepareFailure('\n  \n✘ [ERROR] Could not resolve "./Foo"\n    src/App.tsx:3:7:\n');
    expect(bar).toEqual({
      tone: 'error',
      text: "Couldn't prepare this tool for editing.",
      detail: '✘ [ERROR] Could not resolve "./Foo"',
    });
  });

  it('has no detail when there is no output to quote', () => {
    expect(barForPrepareFailure(undefined)).toEqual({ tone: 'error', text: "Couldn't prepare this tool for editing." });
    expect(barForPrepareFailure('  \n ')).toEqual({ tone: 'error', text: "Couldn't prepare this tool for editing." });
  });
});

describe('askClaudePrompt', () => {
  it('uses the exact sentence with curly quotes', () => {
    expect(askClaudePrompt('Showing 312 genes', 'Showing 400 genes')).toBe(
      'In this tool, change the text “Showing 312 genes” to “Showing 400 genes”.',
    );
  });

  it('leaves the text exactly as typed, straight quotes and all', () => {
    expect(askClaudePrompt('He said "hi"', "It's  done")).toBe(
      'In this tool, change the text “He said "hi"” to “It\'s  done”.',
    );
  });

  it('does not use straight quotes of its own', () => {
    expect(askClaudePrompt('a', 'b')).not.toMatch(/"/);
  });
});

describe('contentKey', () => {
  it('follows the live reload nonce when not editing', () => {
    expect(contentKey({ editing: false, heldNonce: 2, reloadNonce: 5, localReload: 0 })).toBe('bundle-5-0');
  });

  it('holds the nonce captured at the start of editing while editing, however far the live one moves', () => {
    const held = { editing: true, heldNonce: 2, localReload: 0 };
    const before = contentKey({ ...held, reloadNonce: 2 });
    expect(contentKey({ ...held, reloadNonce: 3 })).toBe(before);
    expect(contentKey({ ...held, reloadNonce: 9 })).toBe(before);
    expect(before).toBe('bundle-2-0');
  });

  it('does not remount when edit mode starts', () => {
    const idle = contentKey({ editing: false, heldNonce: 0, reloadNonce: 4, localReload: 1 });
    const started = contentKey({ editing: true, heldNonce: 4, reloadNonce: 4, localReload: 1 });
    expect(started).toBe(idle);
  });

  it('changes when the viewer asks for its own reload, in either mode', () => {
    expect(contentKey({ editing: true, heldNonce: 2, reloadNonce: 2, localReload: 1 })).toBe('bundle-2-1');
    expect(contentKey({ editing: false, heldNonce: 2, reloadNonce: 7, localReload: 3 })).toBe('bundle-7-3');
  });

  it('reloads once on Done when saves moved the nonce while it was held', () => {
    const during = contentKey({ editing: true, heldNonce: 2, reloadNonce: 5, localReload: 0 });
    const after = contentKey({ editing: false, heldNonce: 2, reloadNonce: 5, localReload: 0 });
    expect(after).not.toBe(during);
  });
});

describe('the Done handshake', () => {
  it('waits for the frame to confirm and for every save to land', () => {
    expect(isDoneSettled({ acked: false, inFlight: 0 })).toBe(false);
    expect(isDoneSettled({ acked: true, inFlight: 1 })).toBe(false);
    expect(isDoneSettled({ acked: false, inFlight: 2 })).toBe(false);
    expect(isDoneSettled({ acked: true, inFlight: 0 })).toBe(true);
  });

  it('does not stay stuck on a counter that dipped below zero', () => {
    expect(isDoneSettled({ acked: true, inFlight: -1 })).toBe(true);
  });

  it('gives up waiting after three seconds', () => {
    expect(DONE_WAIT_MS).toBe(3000);
  });

  it('forces a reload only when edits were made and the nonce never moved', () => {
    expect(needsLocalReload({ dirty: true, reloadNonce: 4, heldNonce: 4 })).toBe(true);
    expect(needsLocalReload({ dirty: true, reloadNonce: 5, heldNonce: 4 })).toBe(false);
    expect(needsLocalReload({ dirty: false, reloadNonce: 4, heldNonce: 4 })).toBe(false);
    expect(needsLocalReload({ dirty: false, reloadNonce: 5, heldNonce: 4 })).toBe(false);
  });
});

describe('stampsAction', () => {
  it('rebuilds the first time and gives up the second', () => {
    expect(stampsAction(false)).toBe('rebuild');
    expect(stampsAction(true)).toBe('give-up');
  });
});

describe('parseFrameEditMessage', () => {
  const target: TextEditTarget = {
    text: 'Gene explorer',
    elementSrc: '.applications/geneExplorer/src/App.tsx:42:7',
    tagName: 'h1',
    ancestorSrcs: [
      '.applications/geneExplorer/src/App.tsx:40:5',
      '.applications/_reusable/Header.tsx:12:9',
    ],
  };

  describe('accepts each frame-to-host message, and hands it back as it was sent', () => {
    /** A valid message comes out equal to what went in, and as a new object. */
    const accepts = (message: Record<string, unknown>) => {
      const parsed = parseFrameEditMessage(message);
      expect(parsed).toEqual(message);
      expect(parsed).not.toBe(message);
    };

    it('ready', () => {
      accepts({ type: EDIT_MSG.ready });
    });

    it('state', () => {
      accepts({ type: EDIT_MSG.state, on: true, stamped: 12, final: true });
      accepts({ type: EDIT_MSG.state, on: false, stamped: 0, final: true });
      accepts({ type: EDIT_MSG.state, on: true, stamped: 0, final: false });
    });

    it('probe', () => {
      accepts({ type: EDIT_MSG.probe, probeId: 'e3-k9x2', target });
    });

    it('probe with a target that has no stamped element', () => {
      accepts({
        type: EDIT_MSG.probe, probeId: 'p1',
        target: { text: 'Plain', elementSrc: null, tagName: 'p', ancestorSrcs: [] },
      });
    });

    it('commit', () => {
      accepts({ type: EDIT_MSG.commit, editId: 'e4-a1b2', target, newText: 'Gene browser' });
    });

    it('commit that deletes the text', () => {
      accepts({ type: EDIT_MSG.commit, editId: 'e4', target, newText: '' });
    });

    it('suggest', () => {
      accepts({ type: EDIT_MSG.suggest, oldText: 'Showing 312 genes', newText: 'Showing 400 genes' });
    });

    it('shortcut undo and done', () => {
      accepts({ type: EDIT_MSG.shortcut, action: 'undo' });
      accepts({ type: EDIT_MSG.shortcut, action: 'done' });
    });

    it('reverted, either way', () => {
      accepts({ type: EDIT_MSG.reverted, editId: 'e4-a1b2', ok: true });
      accepts({ type: EDIT_MSG.reverted, editId: 'e4-a1b2', ok: false });
    });
  });

  describe('keeps the boundary tight', () => {
    it('hands on only the fields it validated, so a frame cannot smuggle more over IPC', () => {
      const parsed = parseFrameEditMessage({
        type: EDIT_MSG.commit, editId: 'e1', newText: 'x', extra: 'nope',
        target: { ...target, injected: '../../etc/passwd' },
      });
      expect(parsed).toEqual({ type: EDIT_MSG.commit, editId: 'e1', newText: 'x', target });
      expect(Object.keys((parsed as { target: object }).target).sort()).toEqual(
        ['ancestorSrcs', 'elementSrc', 'tagName', 'text'],
      );
    });

    it("copies the ancestor list instead of sharing the frame's array", () => {
      const msg = { type: EDIT_MSG.probe, probeId: 'p1', target: { ...target, ancestorSrcs: [...target.ancestorSrcs] } };
      const parsed = parseFrameEditMessage(msg);
      expect(parsed && parsed.type === EDIT_MSG.probe && parsed.target.ancestorSrcs).not.toBe(msg.target.ancestorSrcs);
    });

    it('accepts exactly the ancestor limit and text at the length limits', () => {
      const atLimit = { ...target, ancestorSrcs: Array.from({ length: MAX_ANCESTOR_SRCS }, (_, i) => `a:${i}:1`) };
      expect(parseFrameEditMessage({ type: EDIT_MSG.probe, probeId: 'p1', target: atLimit })).not.toBeNull();
      expect(parseFrameEditMessage({ type: EDIT_MSG.probe, probeId: 'p1', target: { ...target, text: 'x'.repeat(10_000) } })).not.toBeNull();
      expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: 'e1', target, newText: 'y'.repeat(10_000) })).not.toBeNull();
      expect(parseFrameEditMessage({ type: EDIT_MSG.probe, probeId: 'x'.repeat(64), target })).not.toBeNull();
    });
  });

  describe('rejects', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'acabox:edit:ready'],
      ['a number', 7],
      ['an array', [{ type: EDIT_MSG.ready }]],
      ['an empty object', {}],
    ])('a non-message: %s', (_name, data) => {
      expect(parseFrameEditMessage(data)).toBeNull();
    });

    it('an unknown type', () => {
      expect(parseFrameEditMessage({ type: 'acabox:edit:explode' })).toBeNull();
      expect(parseFrameEditMessage({ type: 'quoteSelection', selection: null })).toBeNull();
      expect(parseFrameEditMessage({ type: 'readFile', id: 'r1', path: '/etc/hosts' })).toBeNull();
      expect(parseFrameEditMessage({ type: 7 })).toBeNull();
    });

    it.each([
      ['mode', { on: true }],
      ['probeResult', { probeId: 'p1', editable: true }],
      ['applyResult', { editId: 'e1', ok: true, sameElementScope: true }],
      ['revert', { editId: 'e1' }],
    ] as const)('the host-to-frame type %s, which a frame has no business sending', (key, body) => {
      expect(parseFrameEditMessage({ type: EDIT_MSG[key], ...body })).toBeNull();
    });

    describe('state', () => {
      it.each([
        ['missing on', { stamped: 1, final: true }],
        ['missing stamped', { on: true, final: true }],
        ['missing final', { on: true, stamped: 1 }],
        ['on not a boolean', { on: 'yes', stamped: 1, final: true }],
        ['final not a boolean', { on: true, stamped: 1, final: 1 }],
        ['stamped a string', { on: true, stamped: '3', final: true }],
        ['stamped negative', { on: true, stamped: -1, final: true }],
        ['stamped fractional', { on: true, stamped: 1.5, final: true }],
        ['stamped NaN', { on: true, stamped: NaN, final: true }],
        ['stamped Infinity', { on: true, stamped: Infinity, final: true }],
      ])('%s', (_name, body) => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.state, ...body })).toBeNull();
      });
    });

    describe('ids', () => {
      it.each([
        ['a path', '../x'],
        ['an empty string', ''],
        ['65 characters', 'a'.repeat(65)],
        ['a space', 'e 1'],
        ['a slash', 'e/1'],
        ['a newline', 'e1\n'],
        ['non-ASCII', 'e\u00E91'],
      ])('a probeId or editId that is %s', (_name, id) => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.probe, probeId: id, target })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: id, target, newText: 'x' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.reverted, editId: id, ok: true })).toBeNull();
      });

      it('an id that is not a string, or absent', () => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.probe, probeId: 7, target })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.probe, target })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: ['e1'], target, newText: 'x' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.reverted, editId: null, ok: true })).toBeNull();
      });
    });

    describe('target', () => {
      const probe = (t: unknown) => parseFrameEditMessage({ type: EDIT_MSG.probe, probeId: 'p1', target: t });

      it('that is missing or not an object', () => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.probe, probeId: 'p1' })).toBeNull();
        expect(probe(null)).toBeNull();
        expect(probe('Gene explorer')).toBeNull();
        expect(probe([target])).toBeNull();
      });

      it.each(['text', 'elementSrc', 'tagName', 'ancestorSrcs'] as const)('with %s missing', (field) => {
        const { [field]: _omitted, ...rest } = target;
        expect(probe(rest)).toBeNull();
      });

      it('with wrong field types', () => {
        expect(probe({ ...target, text: 7 })).toBeNull();
        expect(probe({ ...target, elementSrc: 7 })).toBeNull();
        expect(probe({ ...target, elementSrc: undefined })).toBeNull();
        expect(probe({ ...target, tagName: null })).toBeNull();
        expect(probe({ ...target, ancestorSrcs: 'a' })).toBeNull();
        expect(probe({ ...target, ancestorSrcs: [7] })).toBeNull();
        expect(probe({ ...target, ancestorSrcs: [null] })).toBeNull();
      });

      it('with empty or whitespace-only text', () => {
        expect(probe({ ...target, text: '' })).toBeNull();
        expect(probe({ ...target, text: '   \n\t ' })).toBeNull();
        expect(probe({ ...target, text: '\u00A0\u00A0' })).toBeNull();
      });

      it('with oversized fields', () => {
        expect(probe({ ...target, text: 'x'.repeat(10_001) })).toBeNull();
        expect(probe({ ...target, elementSrc: 'a'.repeat(401) })).toBeNull();
        expect(probe({ ...target, tagName: 't'.repeat(41) })).toBeNull();
        expect(probe({ ...target, ancestorSrcs: ['a'.repeat(401)] })).toBeNull();
      });

      it('with more ancestors than the limit', () => {
        const tooMany = Array.from({ length: MAX_ANCESTOR_SRCS + 1 }, (_, i) => `a:${i}:1`);
        expect(probe({ ...target, ancestorSrcs: tooMany })).toBeNull();
      });

      it('with a hole in the ancestor list, which `every` alone would skip', () => {
        // eslint-disable-next-line no-sparse-arrays
        expect(probe({ ...target, ancestorSrcs: ['a:1:1', , 'a:3:1'] })).toBeNull();
      });
    });

    describe('commit', () => {
      it('with newText missing, not a string, or oversized', () => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: 'e1', target })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: 'e1', target, newText: 5 })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: 'e1', target, newText: null })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: 'e1', target, newText: 'x'.repeat(10_001) })).toBeNull();
      });

      it('with a bad target', () => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: 'e1', newText: 'x' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.commit, editId: 'e1', newText: 'x', target: { ...target, text: '' } })).toBeNull();
      });
    });

    describe('suggest', () => {
      it('with either text missing, not a string, or oversized', () => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.suggest, newText: 'b' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.suggest, oldText: 'a' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.suggest, oldText: 1, newText: 'b' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.suggest, oldText: 'a', newText: {} })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.suggest, oldText: 'a'.repeat(10_001), newText: 'b' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.suggest, oldText: 'a', newText: 'b'.repeat(10_001) })).toBeNull();
      });
    });

    describe('shortcut', () => {
      it.each([
        ['missing', undefined],
        ['an unknown action', 'save'],
        ['the wrong case', 'Undo'],
        ['not a string', 1],
      ])('with an action that is %s', (_name, action) => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.shortcut, action })).toBeNull();
      });
    });

    describe('reverted', () => {
      it('with ok missing or not a boolean', () => {
        expect(parseFrameEditMessage({ type: EDIT_MSG.reverted, editId: 'e1' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.reverted, editId: 'e1', ok: 'true' })).toBeNull();
        expect(parseFrameEditMessage({ type: EDIT_MSG.reverted, editId: 'e1', ok: 1 })).toBeNull();
      });
    });
  });
});

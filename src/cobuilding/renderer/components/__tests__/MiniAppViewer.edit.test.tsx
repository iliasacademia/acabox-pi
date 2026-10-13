/**
 * "Edit text" as the user meets it in `MiniAppViewer`: the header, the edit
 * bar, and the plumbing between the tool's frame and main. Every rule is tested
 * on its own in `miniAppEditSession.test.ts`; this file is the wiring that
 * joins them, which is where a stale closure or a message handled in the wrong
 * order would hide.
 *
 * `MiniAppViewer.tsx` cannot be imported as it stands: `@assistant-ui/react`
 * pulls in the ESM-only `assistant-stream`. Here that module (and the handful of
 * other heavyweight imports the edit path never touches) is replaced by a stub,
 * which is enough to mount the real component. The frame is jsdom's own iframe,
 * so what the shim would post is dispatched by hand, with `source` set to the
 * iframe's window, and what the viewer posts back is read off a spy on that
 * window's `postMessage`. Main is a set of `jest.fn`s on `window.miniAppsAPI`.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EDIT_MSG } from '../../../shared/miniAppTextEdit';
import type {
  TextEditApplyRequest,
  TextEditApplyResult,
  TextEditLocation,
  TextEditProbeResult,
  TextEditTarget,
  TextEditUndoResult,
} from '../../../shared/miniAppTextEdit';

const mockComposer = { setText: jest.fn(), send: jest.fn(), getState: jest.fn(() => ({ text: '' })) };
jest.mock('@assistant-ui/react', () => ({ useComposerRuntime: () => mockComposer }));
jest.mock('../CodeView', () => ({ CodeView: () => null, languageForPath: () => null }));
jest.mock('../notebook/NotebookViewer', () => ({ NotebookViewer: () => null }));
jest.mock('../notebook/useKernel', () => ({ useKernel: () => ({ connect: jest.fn(), executeCode: jest.fn() }) }));
jest.mock('../../coscientistAnalytics', () => ({ track: jest.fn() }));
jest.mock('../../../shared/telemetry', () => ({ captureError: jest.fn() }));
jest.mock('../share/ToolShareHeaderControls', () => ({
  ToolShareChip: () => null,
  ToolShareHeaderControls: () => null,
}));

import { MiniAppViewer } from '../MiniAppViewer';
import { beginToolActivity, __resetToolStatusStore } from '../../toolStatusStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ViewerProps = React.ComponentProps<typeof MiniAppViewer>;
type BuildResult = { ok: boolean; outfile?: string; error?: string; exitCode: number; reason?: 'source-missing' };

const LOCATION: TextEditLocation = { file: 'src/App.tsx', line: 42, kind: 'jsx-text' };
const TARGET: TextEditTarget = {
  text: 'Gene explorer',
  elementSrc: '.applications/demo/src/App.tsx:42:7',
  tagName: 'h1',
  ancestorSrcs: ['.applications/demo/src/App.tsx:40:5'],
};

const okResult = (editId: string, undoDepth = 1, sameElementScope = true): TextEditApplyResult => ({
  ok: true, editId, location: LOCATION, undoDepth, sameElementScope,
});

const probeMsg = (probeId = 'p1') => ({ type: EDIT_MSG.probe, probeId, target: TARGET });
const commitMsg = (editId = 'e1', newText = 'Gene browser') => ({ type: EDIT_MSG.commit, editId, target: TARGET, newText });
const stateMsg = (o: Partial<{ on: boolean; stamped: number; final: boolean }> = {}) => (
  { type: EDIT_MSG.state, on: true, stamped: 3, final: true, ...o }
);

let container: HTMLDivElement;
let root: Root;
let props: ViewerProps;
let onToggleChat: jest.Mock;
let api: ReturnType<typeof installApis>;

function installApis() {
  const textEdit = {
    probe: jest.fn<Promise<TextEditProbeResult>, [string, TextEditTarget]>(
      async () => ({ editable: true, location: LOCATION }),
    ),
    apply: jest.fn<Promise<TextEditApplyResult>, [string, TextEditApplyRequest]>(
      async (_dir, req) => okResult(req.editId),
    ),
    undo: jest.fn<Promise<TextEditUndoResult>, [string]>(
      async () => ({ ok: true, editId: 'e1', location: LOCATION, undoDepth: 0 }),
    ),
    undoDepth: jest.fn<Promise<number>, [string]>(async () => 0),
  };
  const miniAppsAPI = {
    build: jest.fn<Promise<BuildResult>, [string]>(async () => ({ ok: true, exitCode: 0 })),
    exportApp: jest.fn(),
    textEdit,
  };
  const filesAPI = {
    fileExists: jest.fn(async () => true),
    readFile: jest.fn(async () => ({ error: 'unused' })),
    readDirectory: jest.fn(async () => []),
  };
  const w = window as any;
  w.miniAppsAPI = miniAppsAPI;
  w.filesAPI = filesAPI;
  w.jobsAPI = { acknowledge: jest.fn(async () => {}), list: jest.fn(async () => []) };
  w.toolAnalyticsAPI = { opened: jest.fn(async () => ({ tool_id: 't1' })) };
  w.nativeToolsAPI = { getUrl: jest.fn(async () => 'http://127.0.0.1:1/tool') };
  w.containerAPI = {
    status: jest.fn(async () => ({ running: true })),
    onProgress: jest.fn(() => () => {}),
    onSetupProgress: jest.fn(() => () => {}),
    getAppInstallRequests: jest.fn(async () => []),
    getEnvironmentInfo: jest.fn(async () => ({})),
    onPackageState: jest.fn(() => () => {}),
    onPackageLine: jest.fn(() => () => {}),
    appDepsReady: jest.fn(async () => true),
    ensureAppDeps: jest.fn(async () => {}),
  };
  w.miniAppMcpAPI = {
    register: jest.fn(),
    unregisterByRoute: jest.fn(),
    onInvoke: jest.fn(() => () => {}),
    sendResult: jest.fn(),
  };
  return { textEdit, miniAppsAPI, filesAPI };
}

/** Let every promise chain the viewer started run to completion. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

async function render(next: Partial<ViewerProps> = {}): Promise<void> {
  props = { ...props, ...next };
  await act(async () => {
    root.render(<MiniAppViewer {...props} />);
  });
  await flush();
}

const iframe = () => container.querySelector('iframe') as HTMLIFrameElement;

/** The frame's window, with `postMessage` spied on so what the viewer says to it can be read back. */
function frameWindow(): Window {
  const win = iframe().contentWindow as Window;
  if (!jest.isMockFunction(win.postMessage)) jest.spyOn(win, 'postMessage');
  return win;
}

/** What the viewer has posted to the current frame, oldest first, optionally only one type. */
function posted(type?: string): Array<Record<string, unknown>> {
  const calls = (frameWindow().postMessage as jest.Mock).mock.calls;
  return calls.map((c) => c[0]).filter((m) => !type || m?.type === type);
}

/** Say something as the frame (by default) or as anyone else. */
async function fromFrame(data: unknown, source: Window | null = frameWindow()): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  });
  await flush();
}

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

const buttonLabelled = (label: string): HTMLButtonElement | null =>
  (Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.endsWith(label)) ?? null) as HTMLButtonElement | null;
const editText = () => buttonLabelled('Edit text');
const undoButton = () => container.querySelector<HTMLButtonElement>('button[title^="Undo the last text change"]');
const doneButton = () => container.querySelector<HTMLButtonElement>('.cdBtnPrimary--sm');
const bar = () => container.querySelector('.cdEditBar');
const barText = () => container.querySelector('.cdEditBar__text')?.textContent ?? null;
const chip = () => container.querySelector('.cdStatusChip')?.textContent ?? null;

/** Edit mode on, and the frame has reported stamped elements, so it is ready. */
async function startEditing(): Promise<void> {
  await startEditingNotReady();
  await fromFrame(stateMsg({ stamped: 3, final: true }));
}

/** Edit mode on, nothing heard from the frame yet: not ready. */
async function startEditingNotReady(): Promise<void> {
  await click(editText());
  expect(bar()).not.toBeNull();
}

/**
 * Give the (empty) iframe a real document, so a `load` event reads as a tool
 * that opened. Without one the viewer takes the load for a failed page, as it
 * should: jsdom does not fetch a `local-file://` src, so the frame has no
 * document element at all.
 */
function giveFrameADocument(): void {
  const doc = iframe().contentDocument as Document;
  const html = doc.createElement('html');
  const head = doc.createElement('head');
  const title = doc.createElement('title');
  title.textContent = 'Demo tool';
  head.appendChild(title);
  html.appendChild(head);
  html.appendChild(doc.createElement('body'));
  doc.appendChild(html);
}

beforeEach(async () => {
  api = installApis();
  mockComposer.setText.mockClear();
  mockComposer.send.mockClear();
  onToggleChat = jest.fn();
  props = {
    dirName: 'demo', workspacePath: '/ws', reloadNonce: 0, appName: 'Demo', appIcon: null,
    chatOpen: true, onToggleChat,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
  frameWindow(); // spy from the start, so nothing the viewer posts is missed
});

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('the header', () => {
  it('offers Edit text, just before Rebuild, on a built tool', () => {
    const labels = Array.from(container.querySelectorAll('.cdToolHeader button')).map((b) => b.textContent);
    const edit = labels.indexOf('editEdit text');
    const rebuild = labels.indexOf('refreshRebuild');
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBe(edit + 1);
    expect(editText()?.className).toBe('cdBtnXs cdBtnXs--sm');
    expect(chip()).toBe('IDLE');
  });

  it('does not offer it for a pre-built tool', async () => {
    await render({ preBuilt: true });
    expect(editText()).toBeNull();
  });

  it('does not offer it while the build has failed', async () => {
    api.filesAPI.fileExists.mockResolvedValue(false);
    api.miniAppsAPI.build.mockResolvedValue({ ok: false, error: 'boom', exitCode: 1 });
    await render({ dirName: 'broken' });
    expect(chip()).toBe('BUILD FAILED');
    expect(editText()).toBeNull();
  });

  it('switches it off, with Rebuild, while the tool is being built', async () => {
    api.filesAPI.fileExists.mockResolvedValue(false);
    api.miniAppsAPI.build.mockImplementation(() => new Promise<BuildResult>(() => {}));
    await render({ dirName: 'building' });
    expect(chip()).toBe('BUILDING');
    expect(editText()?.disabled).toBe(true);
    expect(buttonLabelled('Rebuild')?.disabled).toBe(true);
  });

  it('does not offer it while Claude is still writing the tool', async () => {
    api.filesAPI.fileExists.mockResolvedValue(false);
    api.miniAppsAPI.build.mockResolvedValue({ ok: false, reason: 'source-missing', error: 'x', exitCode: 1 });
    await render({ dirName: 'unwritten' });
    expect(chip()).toBe('STILL WRITING');
    expect(editText()).toBeNull();
  });

  it('does not offer it in the source view', async () => {
    await click(container.querySelector('button[title="More"]'));
    await click(container.querySelector('.cdMenu__item'));
    expect(container.querySelector('.sourceViewer')).not.toBeNull();
    expect(editText()).toBeNull();
  });
});

describe('entering edit mode', () => {
  it('shows EDITING, the hint, Undo and Done, and drops Rebuild', async () => {
    await startEditing();
    expect(chip()).toBe('EDITING');
    expect(container.querySelector('.cdStatusChip .cdDot--unread')).not.toBeNull();
    expect(container.querySelector('.cdEditBar__label')?.textContent).toBe('EDITING TEXT');
    expect(barText()).toBe('Click any text to change it. Enter saves, Esc cancels.');
    expect(bar()?.className).toContain('cdEditBar--info');
    expect(undoButton()).not.toBeNull();
    expect(undoButton()?.title).toBe('Undo the last text change (⌘Z)');
    expect(doneButton()?.textContent).toBe('checkDone');
    expect(editText()).toBeNull();
    expect(buttonLabelled('Rebuild')).toBeNull();
  });

  it('puts the bar between the header and the tool', async () => {
    await startEditing();
    const viewer = container.querySelector('.miniAppViewer')!;
    expect(Array.from(viewer.children).map((c) => c.className.split(' ')[0])).toEqual([
      'cdToolHeader', 'cdEditBar', 'miniAppBody',
    ]);
  });

  it('tells the frame, and does not reload it', async () => {
    const before = iframe();
    await startEditing();
    expect(iframe()).toBe(before);
    expect(posted(EDIT_MSG.mode)).toEqual([{ type: EDIT_MSG.mode, on: true }]);
  });

  it('does not reload a tool that was already reloaded before edit mode began', async () => {
    await render({ reloadNonce: 3 });
    const before = iframe();
    await startEditing();
    expect(iframe()).toBe(before);
  });

  it('starts Undo disabled when there is nothing to undo, enabled when earlier edits remain', async () => {
    await startEditing();
    expect(api.textEdit.undoDepth).toHaveBeenCalledWith('demo');
    expect(undoButton()?.disabled).toBe(true);

    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    api.textEdit.undoDepth.mockResolvedValue(2);
    await startEditing();
    expect(undoButton()?.disabled).toBe(false);
  });

  it('copes with main having no handler yet', async () => {
    api.textEdit.undoDepth.mockRejectedValue(new Error('No handler registered'));
    await startEditing();
    expect(undoButton()?.disabled).toBe(true);
  });

  it('switches View source off while editing', async () => {
    await startEditing();
    await click(container.querySelector('button[title="More"]'));
    const viewSource = container.querySelector<HTMLButtonElement>('.cdMenu__item');
    expect(viewSource?.textContent).toContain('View source');
    expect(viewSource?.disabled).toBe(true);
  });
});

describe('what the frame says', () => {
  it('is ignored when it comes from anywhere but the tool’s own frame', async () => {
    await startEditing();
    await fromFrame(probeMsg(), window);
    await fromFrame(commitMsg(), null);
    expect(api.textEdit.probe).not.toHaveBeenCalled();
    expect(api.textEdit.apply).not.toHaveBeenCalled();
    expect(posted(EDIT_MSG.probeResult)).toEqual([]);
  });

  it('does nothing about probes, commits, suggestions and shortcuts while not editing', async () => {
    frameWindow();
    await fromFrame(probeMsg());
    await fromFrame(commitMsg());
    await fromFrame({ type: EDIT_MSG.suggest, oldText: 'a', newText: 'b' });
    await fromFrame({ type: EDIT_MSG.shortcut, action: 'undo' });
    await fromFrame(stateMsg({ stamped: 0 }));
    expect(api.textEdit.probe).not.toHaveBeenCalled();
    expect(api.textEdit.apply).not.toHaveBeenCalled();
    expect(api.textEdit.undo).not.toHaveBeenCalled();
    expect(api.miniAppsAPI.build).not.toHaveBeenCalled();
    expect(mockComposer.setText).not.toHaveBeenCalled();
    expect(posted()).toEqual([]);
  });

  it('drops malformed edit messages without touching main', async () => {
    await startEditing();
    await fromFrame({ type: EDIT_MSG.probe, probeId: '../x', target: TARGET });
    await fromFrame({ type: EDIT_MSG.commit, editId: 'e1', target: { ...TARGET, text: '' }, newText: 'x' });
    await fromFrame({ type: EDIT_MSG.commit, editId: 'e1', target: TARGET, newText: 7 });
    await fromFrame({ type: EDIT_MSG.shortcut, action: 'nuke' });
    await fromFrame({ type: EDIT_MSG.mode, on: true });
    expect(api.textEdit.probe).not.toHaveBeenCalled();
    expect(api.textEdit.apply).not.toHaveBeenCalled();
    expect(posted(EDIT_MSG.probeResult)).toEqual([]);
    expect(posted(EDIT_MSG.applyResult)).toEqual([]);
  });

  it('still routes the bridge’s ordinary requests', async () => {
    await startEditing();
    (window as any).filesAPI.readFile.mockResolvedValue({ type: 'text', content: 'hello' });
    await fromFrame({ type: 'readFile', id: 'r1', path: '/ws/data.csv' });
    expect((window as any).filesAPI.readFile).toHaveBeenCalledWith('/ws/data.csv');
    expect(posted('response')).toEqual([
      { type: 'response', id: 'r1', result: { type: 'text', content: 'hello' }, error: undefined },
    ]);
  });

  it('answers ready with edit mode, but only while editing', async () => {
    frameWindow();
    await fromFrame({ type: EDIT_MSG.ready });
    expect(posted(EDIT_MSG.mode)).toEqual([]);

    await startEditing();
    await fromFrame({ type: EDIT_MSG.ready });
    expect(posted(EDIT_MSG.mode)).toEqual([
      { type: EDIT_MSG.mode, on: true },
      { type: EDIT_MSG.mode, on: true },
    ]);
  });

  it('puts a document that loads mid-edit back into edit mode, and leaves others alone', async () => {
    giveFrameADocument();
    await act(async () => {
      iframe().dispatchEvent(new Event('load'));
    });
    expect(posted('init')).toHaveLength(1);
    expect(posted(EDIT_MSG.mode)).toEqual([]);

    await startEditing();
    await act(async () => {
      iframe().dispatchEvent(new Event('load'));
    });
    expect(posted(EDIT_MSG.mode)).toEqual([
      { type: EDIT_MSG.mode, on: true },
      { type: EDIT_MSG.mode, on: true },
    ]);
  });

  describe('probe', () => {
    it('asks main about the exact target and says yes', async () => {
      await startEditing();
      await fromFrame(probeMsg('p7'));
      expect(api.textEdit.probe).toHaveBeenCalledWith('demo', TARGET);
      expect(posted(EDIT_MSG.probeResult)).toEqual([{ type: EDIT_MSG.probeResult, probeId: 'p7', editable: true }]);
      expect(barText()).toBe('Click any text to change it. Enter saves, Esc cancels.');
    });

    it('says no with a warning that invites typing a request instead', async () => {
      api.textEdit.probe.mockResolvedValueOnce({
        editable: false, reason: 'computed',
        message: "This text is produced by the tool's code while it runs, so it can't be changed here directly.",
      });
      await startEditing();
      await fromFrame(probeMsg('p8'));
      expect(posted(EDIT_MSG.probeResult)).toEqual([{ type: EDIT_MSG.probeResult, probeId: 'p8', editable: false }]);
      expect(bar()?.className).toContain('cdEditBar--warning');
      expect(barText()).toBe(
        "This text is produced by the tool's code while it runs, so it can't be changed here directly. "
        + 'Type the new text anyway and press Enter — it will go to the chat as a request.',
      );
      expect(container.querySelector('.cdEditBar__ask')).toBeNull();
    });

    it('answers no, rather than never, when main cannot be asked', async () => {
      api.textEdit.probe.mockRejectedValueOnce(new Error('No handler registered'));
      await startEditing();
      await fromFrame(probeMsg('p9'));
      expect(posted(EDIT_MSG.probeResult)).toEqual([{ type: EDIT_MSG.probeResult, probeId: 'p9', editable: false }]);
      expect(bar()?.className).toContain('cdEditBar--warning');
    });
  });

  describe('commit', () => {
    it('sends main the target with the edit id and new text, and reports where it landed', async () => {
      await startEditing();
      await fromFrame(commitMsg('e5', 'Gene browser'));
      expect(api.textEdit.apply).toHaveBeenCalledWith('demo', { ...TARGET, editId: 'e5', newText: 'Gene browser' });
      expect(posted(EDIT_MSG.applyResult)).toEqual([
        { type: EDIT_MSG.applyResult, editId: 'e5', ok: true, sameElementScope: true },
      ]);
      expect(bar()?.className).toContain('cdEditBar--success');
      expect(barText()).toBe('Saved');
      expect(container.querySelector('.cdEditBar__detail')?.textContent).toBe('src/App.tsx · line 42');
      expect(container.querySelector('.cdEditBar__ask')).toBeNull();
    });

    it('relays sameElementScope as main gave it', async () => {
      api.textEdit.apply.mockResolvedValueOnce(okResult('e6', 1, false));
      await startEditing();
      await fromFrame(commitMsg('e6'));
      expect(posted(EDIT_MSG.applyResult)[0]).toMatchObject({ editId: 'e6', ok: true, sameElementScope: false });
    });

    it('enables Undo from the depth main reports', async () => {
      await startEditing();
      expect(undoButton()?.disabled).toBe(true);
      await fromFrame(commitMsg('e1'));
      expect(undoButton()?.disabled).toBe(false);
    });

    it('turns a refusal that Claude could act on into a warning with Ask Claude, and the frame reverts', async () => {
      api.textEdit.apply.mockResolvedValueOnce({
        ok: false, editId: 'e2', reason: 'computed', undoDepth: 0,
        message: "This text is produced by the tool's code while it runs, so it can't be changed here directly.",
      });
      await startEditing();
      await fromFrame(commitMsg('e2', 'Showing 400 genes'));
      expect(posted(EDIT_MSG.applyResult)).toEqual([{ type: EDIT_MSG.applyResult, editId: 'e2', ok: false }]);
      expect(bar()?.className).toContain('cdEditBar--warning');
      expect(barText()).toBe("This text is produced by the tool's code while it runs, so it can't be changed here directly.");
      expect(container.querySelector('.cdEditBar__ask')?.textContent).toBe('Ask Claude');
      expect(undoButton()?.disabled).toBe(true);
    });

    it('turns a refusal Claude cannot help with into an error with no Ask Claude', async () => {
      api.textEdit.apply.mockResolvedValueOnce({
        ok: false, editId: 'e3', reason: 'build-failed', undoDepth: 1,
        message: 'The tool stopped building after this change, so it was put back.',
      });
      await startEditing();
      await fromFrame(commitMsg('e3'));
      expect(bar()?.className).toContain('cdEditBar--error');
      expect(barText()).toBe('The tool stopped building after this change, so it was put back.');
      expect(container.querySelector('.cdEditBar__ask')).toBeNull();
      // A refusal still carries the depth main holds; here, an earlier edit remains to undo.
      expect(undoButton()?.disabled).toBe(false);
    });

    it('tells the frame no when main cannot be reached, so it puts the old text back', async () => {
      api.textEdit.apply.mockRejectedValueOnce(new Error('No handler registered'));
      await startEditing();
      await fromFrame(commitMsg('e4'));
      expect(posted(EDIT_MSG.applyResult)).toEqual([{ type: EDIT_MSG.applyResult, editId: 'e4', ok: false }]);
      expect(bar()?.className).toContain('cdEditBar--error');
      expect(barText()).toBe("Couldn't save this change. Nothing was changed.");
    });
  });

  describe('suggest', () => {
    it('fills the composer with the request, opens the chat if it was closed, and never sends', async () => {
      await render({ chatOpen: false });
      await startEditing();
      await fromFrame({ type: EDIT_MSG.suggest, oldText: 'Showing 312 genes', newText: 'Showing 400 genes' });
      expect(onToggleChat).toHaveBeenCalledTimes(1);
      expect(mockComposer.setText).toHaveBeenCalledWith(
        'In this tool, change the text “Showing 312 genes” to “Showing 400 genes”.',
      );
      expect(mockComposer.send).not.toHaveBeenCalled();
      expect(bar()?.className).toContain('cdEditBar--info');
      expect(barText()).toBe('Your change is in the chat as a request. Review it and press Enter to send.');
    });

    it('leaves an open chat open', async () => {
      await startEditing();
      await fromFrame({ type: EDIT_MSG.suggest, oldText: 'a', newText: 'b' });
      expect(onToggleChat).not.toHaveBeenCalled();
      expect(mockComposer.setText).toHaveBeenCalledTimes(1);
    });

    it('does the same from the Ask Claude button after a refused save', async () => {
      await render({ chatOpen: false });
      api.textEdit.apply.mockResolvedValueOnce({
        ok: false, editId: 'e2', reason: 'ambiguous', undoDepth: 0, message: 'Several places.',
      });
      await startEditing();
      await fromFrame(commitMsg('e2', 'Gene browser'));
      await click(container.querySelector('.cdEditBar__ask'));
      expect(onToggleChat).toHaveBeenCalledTimes(1);
      expect(mockComposer.setText).toHaveBeenCalledWith(
        'In this tool, change the text “Gene explorer” to “Gene browser”.',
      );
      expect(mockComposer.send).not.toHaveBeenCalled();
      expect(barText()).toBe('Your change is in the chat as a request. Review it and press Enter to send.');
      expect(container.querySelector('.cdEditBar__ask')).toBeNull();
    });
  });
});

describe('undo', () => {
  it('asks main, tells the frame to put the old text back, and says what it undid', async () => {
    api.textEdit.undoDepth.mockResolvedValue(1);
    api.textEdit.undo.mockResolvedValueOnce({ ok: true, editId: 'e9', location: LOCATION, undoDepth: 0 });
    await startEditing();
    await click(undoButton());
    expect(api.textEdit.undo).toHaveBeenCalledWith('demo');
    expect(posted(EDIT_MSG.revert)).toEqual([{ type: EDIT_MSG.revert, editId: 'e9' }]);
    expect(bar()?.className).toContain('cdEditBar--info');
    expect(barText()).toBe('Undid the last change.');
    expect(container.querySelector('.cdEditBar__detail')?.textContent).toBe('src/App.tsx · line 42');
    expect(undoButton()?.disabled).toBe(true);
  });

  it('shows main’s reason as an error when nothing could be undone, and tells the frame nothing', async () => {
    api.textEdit.undoDepth.mockResolvedValue(1);
    api.textEdit.undo.mockResolvedValueOnce({ ok: false, message: 'Nothing to undo.', undoDepth: 0 });
    await startEditing();
    await click(undoButton());
    expect(posted(EDIT_MSG.revert)).toEqual([]);
    expect(bar()?.className).toContain('cdEditBar--error');
    expect(barText()).toBe('Nothing to undo.');
  });

  it('says so when main cannot be reached', async () => {
    api.textEdit.undoDepth.mockResolvedValue(1);
    api.textEdit.undo.mockRejectedValueOnce(new Error('No handler registered'));
    await startEditing();
    await click(undoButton());
    expect(barText()).toBe("Couldn't undo that change.");
  });

  it('counts as a change: Done reloads the tool onto the reverted bundle', async () => {
    api.textEdit.undoDepth.mockResolvedValue(1);
    await startEditing();
    const before = iframe();
    await click(undoButton());
    expect(iframe()).toBe(before);
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    expect(iframe()).not.toBe(before);
  });

  it('is what ⌘Z in the frame does', async () => {
    api.textEdit.undo.mockResolvedValueOnce({ ok: true, editId: 'e8', location: LOCATION, undoDepth: 0 });
    await startEditing();
    await fromFrame({ type: EDIT_MSG.shortcut, action: 'undo' });
    expect(api.textEdit.undo).toHaveBeenCalledTimes(1);
    expect(posted(EDIT_MSG.revert)).toEqual([{ type: EDIT_MSG.revert, editId: 'e8' }]);
  });

  it('reloads the tool when the frame could not put the old text back, but not when it could', async () => {
    await startEditing();
    const before = iframe();
    await fromFrame({ type: EDIT_MSG.reverted, editId: 'e1', ok: true });
    expect(iframe()).toBe(before);
    await fromFrame({ type: EDIT_MSG.reverted, editId: 'e1', ok: false });
    expect(iframe()).not.toBe(before);
    // Still editing, on the new document.
    expect(chip()).toBe('EDITING');
  });
});

describe('Done', () => {
  it('asks the frame to leave edit mode and closes once the frame has confirmed', async () => {
    await startEditing();
    await click(doneButton());
    expect(posted(EDIT_MSG.mode).slice(-1)).toEqual([{ type: EDIT_MSG.mode, on: false }]);
    expect(chip()).toBe('EDITING');
    expect(bar()).not.toBeNull();

    await fromFrame(stateMsg({ on: false, final: true }));
    expect(chip()).toBe('IDLE');
    expect(bar()).toBeNull();
    expect(editText()).not.toBeNull();
    expect(buttonLabelled('Rebuild')).not.toBeNull();
    expect(undoButton()).toBeNull();
  });

  it('does not reload a tool nothing was changed in', async () => {
    await startEditing();
    const before = iframe();
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    expect(iframe()).toBe(before);
  });

  it('reloads the tool onto its rebuilt bundle after a change, even if no build was announced', async () => {
    await startEditing();
    const before = iframe();
    await fromFrame(commitMsg('e1'));
    expect(iframe()).toBe(before);
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    expect(iframe()).not.toBe(before);
    expect(chip()).toBe('IDLE');
  });

  it('keeps the tool from reloading under the caret while builds are announced, then reloads once', async () => {
    await startEditing();
    const before = iframe();
    await fromFrame(commitMsg('e1'));
    // Each save is a build, and main announces each one.
    await render({ reloadNonce: 1 });
    await render({ reloadNonce: 2 });
    expect(iframe()).toBe(before);

    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    const after = iframe();
    expect(after).not.toBe(before);

    // And exactly once: the reload was the nonce's, not also a local one.
    await render({});
    expect(iframe()).toBe(after);
  });

  it('reloads for a build the agent made while editing, even if nothing was edited', async () => {
    await startEditing();
    const before = iframe();
    await render({ reloadNonce: 1 });
    expect(iframe()).toBe(before);
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    expect(iframe()).not.toBe(before);
  });

  it('waits for a save that is still in flight, and the tool then reloads onto it', async () => {
    let finish: () => void = () => {};
    api.textEdit.apply.mockImplementationOnce(
      (_dir, req) => new Promise<TextEditApplyResult>((resolve) => {
        finish = () => resolve(okResult(req.editId));
      }),
    );
    await startEditing();
    const before = iframe();
    // The order the shim uses when Done finds an open editor: commit, then confirm.
    await click(doneButton());
    await fromFrame(commitMsg('e1'));
    await fromFrame(stateMsg({ on: false }));
    expect(chip()).toBe('EDITING');

    await act(async () => {
      finish();
    });
    await flush();
    expect(chip()).toBe('IDLE');
    expect(barText()).toBeNull();
    expect(iframe()).not.toBe(before);
    expect(posted(EDIT_MSG.applyResult)).toEqual([]); // the old frame is gone; the answer went to it
  });

  it('answers the frame about a save that finished while Done was waiting', async () => {
    let finish: () => void = () => {};
    api.textEdit.apply.mockImplementationOnce(
      (_dir, req) => new Promise<TextEditApplyResult>((resolve) => {
        finish = () => resolve(okResult(req.editId));
      }),
    );
    await startEditing();
    await fromFrame(commitMsg('e1'));
    await click(doneButton());
    // Not yet confirmed by the frame, so nothing closes even after the save lands.
    await act(async () => {
      finish();
    });
    await flush();
    expect(posted(EDIT_MSG.applyResult)).toEqual([
      { type: EDIT_MSG.applyResult, editId: 'e1', ok: true, sameElementScope: true },
    ]);
    expect(chip()).toBe('EDITING');
    await fromFrame(stateMsg({ on: false }));
    expect(chip()).toBe('IDLE');
  });

  it('closes after three seconds if the frame never confirms', async () => {
    jest.useFakeTimers();
    await startEditing();
    await click(doneButton());
    expect(chip()).toBe('EDITING');
    await act(async () => {
      jest.advanceTimersByTime(2900);
    });
    expect(chip()).toBe('EDITING');
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(chip()).toBe('IDLE');
    expect(bar()).toBeNull();
    // Told once when Done was pressed, and again as edit mode closed, in case a
    // frame that was slow to answer missed the first.
    expect(posted(EDIT_MSG.mode).filter((m) => m.on === false)).toHaveLength(2);
  });

  it('closes at once when there is no frame to ask', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {}); // the viewer logs a page that failed to open
    await startEditing();
    // A tool whose page could not open has no iframe, and so nothing to confirm.
    await act(async () => {
      iframe().dispatchEvent(new Event('load')); // no title, no text: a page that failed to open
    });
    expect(container.querySelector('iframe')).toBeNull();
    await click(doneButton());
    expect(chip()).toBe('IDLE');
    expect(bar()).toBeNull();
  });

  it('is also what Esc in the frame does', async () => {
    await startEditing();
    await fromFrame({ type: EDIT_MSG.shortcut, action: 'done' });
    expect(posted(EDIT_MSG.mode).slice(-1)).toEqual([{ type: EDIT_MSG.mode, on: false }]);
    await fromFrame(stateMsg({ on: false }));
    expect(chip()).toBe('IDLE');
  });

  it('starts one handshake however many times it is pressed', async () => {
    await startEditing();
    await click(doneButton());
    await click(doneButton());
    await fromFrame({ type: EDIT_MSG.shortcut, action: 'done' });
    expect(posted(EDIT_MSG.mode).filter((m) => m.on === false)).toHaveLength(1);
  });

  it('starts a fresh session each time: the hint is back and a stale confirmation closes nothing', async () => {
    await startEditing();
    await fromFrame(commitMsg('e1'));
    expect(barText()).toBe('Saved');
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));

    await startEditing();
    expect(barText()).toBe('Click any text to change it. Enter saves, Esc cancels.');
    // A confirmation arriving with no Done pending must not end the new session.
    await fromFrame(stateMsg({ on: false }));
    expect(chip()).toBe('EDITING');
  });
});

describe('a tool built without source stamps', () => {
  it('is rebuilt once, quietly, and then reloaded', async () => {
    await startEditingNotReady();
    const before = iframe();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    expect(api.miniAppsAPI.build).toHaveBeenCalledTimes(1);
    expect(api.miniAppsAPI.build).toHaveBeenCalledWith('demo');
    expect(iframe()).not.toBe(before);
    expect(chip()).toBe('EDITING');
    // The fresh frame decides readiness again.
    expect(barText()).toBe('Preparing this tool for editing…');
    await fromFrame(stateMsg({ stamped: 4, final: true }));
    expect(barText()).toBe('Click any text to change it. Enter saves, Esc cancels.');
  });

  it('says it is preparing while the rebuild runs', async () => {
    let finish: () => void = () => {};
    api.miniAppsAPI.build.mockImplementationOnce(() => new Promise<BuildResult>((resolve) => {
      finish = () => resolve({ ok: true, exitCode: 0 });
    }));
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    expect(barText()).toBe('Preparing this tool for editing…');
    await act(async () => {
      finish();
    });
    await flush();
    await fromFrame(stateMsg({ stamped: 4, final: true }));
    expect(barText()).toBe('Click any text to change it. Enter saves, Esc cancels.');
  });

  it('gives up with a plain explanation if the rebuilt tool still has no stamps', async () => {
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    expect(api.miniAppsAPI.build).toHaveBeenCalledTimes(1);
    expect(bar()?.className).toContain('cdEditBar--error');
    expect(barText()).toBe("This tool's text can't be traced to its code, so it can't be edited here.");
  });

  it('gets one more try in the next edit session', async () => {
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));

    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    expect(api.miniAppsAPI.build).toHaveBeenCalledTimes(2);
  });

  it('reports a failed rebuild with the first line of the build output and keeps the tool as it is', async () => {
    api.miniAppsAPI.build.mockResolvedValueOnce({ ok: false, error: '✘ [ERROR] Could not resolve "./Foo"\n  more', exitCode: 1 });
    await startEditingNotReady();
    const before = iframe();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    expect(iframe()).toBe(before);
    expect(bar()?.className).toContain('cdEditBar--error');
    expect(barText()).toBe("Couldn't prepare this tool for editing.");
    expect(container.querySelector('.cdEditBar__detail')?.textContent).toBe('✘ [ERROR] Could not resolve "./Foo"');
  });

  it('reports a rebuild that threw', async () => {
    api.miniAppsAPI.build.mockRejectedValueOnce(new Error('spawn esbuild ENOENT'));
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    expect(barText()).toBe("Couldn't prepare this tool for editing.");
    expect(container.querySelector('.cdEditBar__detail')?.textContent).toBe('spawn esbuild ENOENT');
  });

  it('is not triggered by a zero that is not final, or by a final count above zero', async () => {
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: false }));
    await fromFrame(stateMsg({ stamped: 5, final: true }));
    await fromFrame(stateMsg({ stamped: 0, final: true, on: false }));
    expect(api.miniAppsAPI.build).not.toHaveBeenCalled();
  });
});

describe('readiness: nothing is editable until the frame has stamps', () => {
  it('starts on the preparing bar and ignores probe and commit while not ready', async () => {
    await startEditingNotReady();
    expect(barText()).toBe('Preparing this tool for editing…');
    await fromFrame(probeMsg());
    await fromFrame(commitMsg());
    expect(api.textEdit.probe).not.toHaveBeenCalled();
    expect(api.textEdit.apply).not.toHaveBeenCalled();
    expect(posted(EDIT_MSG.probeResult)).toEqual([]);
    expect(posted(EDIT_MSG.applyResult)).toEqual([]);
  });

  it('answers probes once the first stamped report arrives, and not on a non-final zero', async () => {
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: false }));
    await fromFrame(probeMsg('p1'));
    expect(api.textEdit.probe).not.toHaveBeenCalled();
    await fromFrame(stateMsg({ stamped: 2, final: false }));
    expect(barText()).toBe('Click any text to change it. Enter saves, Esc cancels.');
    await fromFrame(probeMsg('p2'));
    expect(api.textEdit.probe).toHaveBeenCalledTimes(1);
    expect(posted(EDIT_MSG.probeResult)).toEqual([{ type: EDIT_MSG.probeResult, probeId: 'p2', editable: true }]);
  });

  it('stays not ready after the give-up, so probes still get no reply', async () => {
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    await fromFrame(probeMsg());
    expect(api.textEdit.probe).not.toHaveBeenCalled();
  });

  it('does not reload a second time at Done after the prepare rebuild', async () => {
    let finish: () => void = () => {};
    api.miniAppsAPI.build.mockImplementationOnce(() => new Promise<BuildResult>((resolve) => {
      finish = () => resolve({ ok: true, exitCode: 0 });
    }));
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    await render({ reloadNonce: 1 }); // main announces the build; the held iframe stays put
    await act(async () => {
      finish();
    });
    await flush();
    const reloaded = iframe();
    await fromFrame(stateMsg({ stamped: 3, final: true }));
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    expect(container.querySelector('.cdEditBar')).toBeNull();
    expect(iframe()).toBe(reloaded);
  });

  it('does not reload if edit mode ended before the prepare build finished', async () => {
    let finish: () => void = () => {};
    api.miniAppsAPI.build.mockImplementationOnce(() => new Promise<BuildResult>((resolve) => {
      finish = () => resolve({ ok: true, exitCode: 0 });
    }));
    await startEditingNotReady();
    await fromFrame(stateMsg({ stamped: 0, final: true }));
    await click(doneButton());
    await fromFrame(stateMsg({ on: false }));
    expect(container.querySelector('.cdEditBar')).toBeNull();
    const after = iframe();
    await act(async () => {
      finish();
    });
    await flush();
    expect(iframe()).toBe(after);
  });
});

describe('Stop while editing', () => {
  it('keeps the tool Stop control reachable next to the EDITING chip', async () => {
    await startEditing();
    expect(buttonLabelled('Stop')).toBeNull();
    let end: () => void = () => {};
    await act(async () => {
      end = beginToolActivity('demo');
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(chip()).toBe('EDITING');
    expect(buttonLabelled('Stop')).not.toBeNull();
    await act(async () => {
      end();
    });
    __resetToolStatusStore();
  });
});

describe('suggestions append to a chat draft', () => {
  const PROMPT = 'In this tool, change the text “Gene explorer” to “Gene browser”.';

  it('keeps what the user already typed, after a blank line, and never sends', async () => {
    mockComposer.getState.mockReturnValue({ text: 'my draft' });
    await startEditing();
    await fromFrame({ type: EDIT_MSG.suggest, oldText: 'Gene explorer', newText: 'Gene browser' });
    expect(mockComposer.setText).toHaveBeenCalledWith(`my draft\n\n${PROMPT}`);
    expect(mockComposer.send).not.toHaveBeenCalled();
    mockComposer.getState.mockReturnValue({ text: '' });
  });

  it('fills an empty composer with just the prompt', async () => {
    mockComposer.getState.mockReturnValue({ text: '  ' });
    await startEditing();
    await fromFrame({ type: EDIT_MSG.suggest, oldText: 'Gene explorer', newText: 'Gene browser' });
    expect(mockComposer.setText).toHaveBeenCalledWith(PROMPT);
    mockComposer.getState.mockReturnValue({ text: '' });
  });
});

describe('host shortcuts while editing', () => {
  const key = async (init: KeyboardEventInit, target: EventTarget = document.body) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
    await flush();
  };

  it('undoes on Cmd+Z and Ctrl+Z, not on Shift+Cmd+Z', async () => {
    await startEditing();
    await key({ key: 'z', metaKey: true, shiftKey: true });
    expect(api.textEdit.undo).not.toHaveBeenCalled();
    await key({ key: 'z', metaKey: true });
    expect(api.textEdit.undo).toHaveBeenCalledTimes(1);
    await key({ key: 'z', ctrlKey: true });
    expect(api.textEdit.undo).toHaveBeenCalledTimes(2);
  });

  it('finishes on Esc', async () => {
    await startEditing();
    await key({ key: 'Escape' });
    expect(posted(EDIT_MSG.mode)).toContainEqual({ type: EDIT_MSG.mode, on: false });
  });

  it('stands aside for a textarea, an input and a contenteditable', async () => {
    await startEditing();
    const ta = document.createElement('textarea');
    const input = document.createElement('input');
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    container.append(ta, input, ce);
    for (const el of [ta, input, ce]) {
      await key({ key: 'z', metaKey: true }, el);
      await key({ key: 'Escape' }, el);
    }
    expect(api.textEdit.undo).not.toHaveBeenCalled();
    expect(posted(EDIT_MSG.mode)).not.toContainEqual({ type: EDIT_MSG.mode, on: false });
  });

  it('does nothing when not editing', async () => {
    await key({ key: 'z', metaKey: true });
    await key({ key: 'Escape' });
    expect(api.textEdit.undo).not.toHaveBeenCalled();
  });
});

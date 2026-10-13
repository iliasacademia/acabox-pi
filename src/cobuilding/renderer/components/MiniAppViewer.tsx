import React, { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { prepareQuoteText } from '../../shared/quotes';
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from 'lucide-react';
import { useComposerRuntime } from '@assistant-ui/react';
import { CodeView, languageForPath } from './CodeView';
import { useKernel } from './notebook/useKernel';
import { NotebookViewer } from './notebook/NotebookViewer';
import type { CellOutput } from './notebook/types';
import { track as trackAnalytics } from '../coscientistAnalytics';
import { captureError } from '../../shared/telemetry';
import { MSymbol } from './command-desk/MSymbol';
import { resolveToolIcon } from './command-desk/toolIcon';
import { setToolLifecycle, clearToolStatus, useToolStatus, beginToolActivity } from '../toolStatusStore';
import { toolStatusLabel, toolStatusDetail } from './command-desk/toolStatusDisplay';
import { ToolShareChip, ToolShareHeaderControls } from './share/ToolShareHeaderControls';
import { classifyBuildResult, APP_SOURCE_RELATIVE_PATH, AWAITING_SOURCE_POLL_MS, AwaitingSourceView } from './miniAppBuildState';
import { EDIT_MSG } from '../../shared/miniAppTextEdit';
import type { TextEditApplyResult, TextEditProbeResult, TextEditRefusal } from '../../shared/miniAppTextEdit';
import {
  DONE_WAIT_MS,
  EDIT_HINT,
  EDIT_PREPARING,
  EDIT_UNTRACEABLE,
  composeComposerText,
  editReadiness,
  hostShortcutFor,
  isTextEntryTarget,
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
} from './miniAppEditSession';
import type { EditBarState, FrameEditMessage } from './miniAppEditSession';

interface RequestFixError {
  kind: string;
  message: string;
  stack?: string;
  source?: string;
  timestamp: number;
}

/**
 * Bridge operations that mean the tool is genuinely computing, and so drive
 * the WORKING status. Kernel code and Claude calls are reported to the host's
 * job registry, so the status outlives this viewer being unmounted.
 *
 * `executeCommand` is deliberately NOT here: main registers those itself, from
 * inside the exec handler, because it owns the child process — and that child
 * outlives the app entirely. Registering it here as well would double-count.
 *
 * Everything else the bridge brokers (file reads/writes, dialogs,
 * `mcp:callTool`) is sub-second plumbing and would just strobe the chip.
 */
const JOB_BRIDGE_KINDS: Record<string, { kind: 'kernel' | 'claude'; label: string }> = {
  executeCode: { kind: 'kernel', label: 'Running a step' },
  'anthropic:complete': { kind: 'claude', label: 'Writing with Acabox' },
  'anthropic:stream': { kind: 'claude', label: 'Writing with Acabox' },
};

function buildFixPrompt(appName: string, err: RequestFixError): string {
  const lines: string[] = [
    `An error occurred in mini-app \`${appName}\`. Please fix or explain it.`,
    '',
    `**Error type:** ${err.kind}`,
    `**Message:** ${err.message}`,
  ];
  if (err.source) lines.push(`**Source:** ${err.source}`);
  if (err.stack) {
    lines.push('', '**Stack trace:**', '```', err.stack, '```');
  }
  lines.push(
    '',
    'Before changing any code, first determine whether this error was caused by:',
    '1. **Bad input or user action** — in which case explain the problem to me clearly without changing the app code, OR',
    '2. **A bug in the app code** — in which case fix it.',
  );
  return lines.join('\n');
}

type RebuildState =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'error'; message: string; at: number }
  | { kind: 'awaiting-source'; since: number };

/**
 * What `MiniAppContent` tells the viewer about edit-mode traffic with the
 * frame. The content owns the conversation with the frame and with main; the
 * viewer owns what the user sees (the bar, Undo's state, the Done handshake),
 * so this is the whole seam between them.
 */
type EditEvent =
  | { kind: 'probe-refused'; reason: TextEditRefusal; message: string }
  | { kind: 'applied'; result: Extract<TextEditApplyResult, { ok: true }>; oldText: string; newText: string }
  | { kind: 'refused'; result: Extract<TextEditApplyResult, { ok: false }>; oldText: string; newText: string }
  | { kind: 'suggest'; oldText: string; newText: string }
  | { kind: 'shortcut'; action: 'undo' | 'done' }
  | { kind: 'frame-state'; stamped: number; final: boolean }
  | { kind: 'revert-failed' }
  | { kind: 'mode-off-acked' }
  /** A save started (+1) or finished (-1). The viewer keeps the count: it survives the content remounting. */
  | { kind: 'inflight-change'; delta: 1 | -1 };

/** The one thing the viewer needs from the tool's frame besides the events above. */
interface MiniAppContentHandle {
  /** Post to the tool's frame. False, with nothing sent, while no frame is mounted. */
  postToFrame(message: unknown): boolean;
}

interface MiniAppViewerProps {
  dirName: string;
  workspacePath: string;
  reloadNonce?: number;
  preBuilt?: boolean;
  /** Display name from the app's manifest; falls back to dirName. */
  appName?: string | null;
  /** Lucide icon name from the app's manifest. */
  appIcon?: string | null;
  /** Whether the chat side panel is currently open (header toggle state). */
  chatOpen?: boolean;
  onToggleChat?: () => void;
  onBack?: () => void;
}

export const MiniAppViewer: FC<MiniAppViewerProps> = ({ dirName, workspacePath, reloadNonce, preBuilt, appName, appIcon, chatOpen, onToggleChat, onBack }) => {
  const [viewingSource, setViewingSource] = useState(false);
  const [rebuildState, setRebuildState] = useState<RebuildState>({ kind: 'idle' });
  const appDir = `${workspacePath}/.applications/${dirName}`;
  const composerRuntime = useComposerRuntime();

  // A bumped reloadNonce means an external actor — the agent's
  // build_and_open_mini_application / open_mini_application tool — is asserting
  // that a fresh bundle is on disk. Drop any latched build error so the
  // nonce-keyed <MiniAppContent> below can actually mount and re-read it.
  //
  // Without this, `rebuildState` is a one-way latch: `showBuildError` gates
  // AHEAD of the nonce-keyed content, so the whole forceReload pipeline
  // re-keys an element that isn't in the tree. The agent would fix the app,
  // rebuild it successfully, and the user would keep staring at the stale
  // BUILD FAILED screen until the viewer unmounted (quitting the app, closing
  // the tab, or navigating away) — and the fix-it-in-chat flow keeps you
  // inside the tool's side panel, so it never unmounts on its own.
  //
  // No-op on mount (state is already idle) and only touches 'error' /
  // 'awaiting-source', so an in-flight build can't be stomped. An external
  // actor asserting a fresh bundle is on disk should clear the waiting
  // screen too — it means the source has landed and a build already ran.
  useEffect(() => {
    setRebuildState((s) => (s.kind === 'error' || s.kind === 'awaiting-source' ? { kind: 'idle' } : s));
  }, [reloadNonce]);

  // Surface build state to the shared tool-status store (tab dots, etc.).
  // 'awaiting-source' reads as idle here deliberately: an idle tool shows no
  // chip on the home grid, which is correct while Claude is still writing
  // it — the chat that is writing it is the thing carrying the activity.
  useEffect(() => {
    if (rebuildState.kind === 'building') {
      setToolLifecycle(dirName, { kind: 'building' });
    } else if (rebuildState.kind === 'error') {
      setToolLifecycle(dirName, { kind: 'buildFailed', message: rebuildState.message, at: rebuildState.at });
    } else {
      setToolLifecycle(dirName, { kind: 'idle' });
    }
  }, [dirName, rebuildState]);
  useEffect(() => () => clearToolStatus(dirName), [dirName]);

  // Opening the tool is the user acknowledging whatever the last session left
  // behind — they can now see its output for themselves, so drop the
  // interrupted / ran-while-closed notice.
  useEffect(() => {
    window.jobsAPI.acknowledge(dirName).catch(() => { /* non-critical */ });
  }, [dirName]);

  // Telemetry: register the open with main (which mints tool_id if missing,
  // increments open_count, and fires tool.created / tool.opened events).
  // Stash the resolved tool_id in a ref so subsequent build events can attach it.
  const toolIdRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.toolAnalyticsAPI
      .opened(dirName)
      .then((info) => {
        if (cancelled) return;
        if (info?.tool_id) toolIdRef.current = info.tool_id;
      })
      .catch(() => {
        // Analytics failures are non-blocking — silently ignore.
      });
    return () => {
      cancelled = true;
    };
  }, [dirName]);

  // For pre-built apps, resolve the webpack-served URL
  const [nativeToolUrl, setNativeToolUrl] = useState<string | null>(null);
  useEffect(() => {
    if (preBuilt) {
      window.nativeToolsAPI.getUrl(dirName).then((url) => {
        if (url) setNativeToolUrl(url);
      });
    }
  }, [preBuilt, dirName]);

  const handleRebuild = useCallback(async () => {
    setRebuildState({ kind: 'building' });
    const buildStartMs = Date.now();
    const toolIdForBuild = toolIdRef.current;
    if (toolIdForBuild) {
      trackAnalytics({
        name: 'tool.build_started',
        metadata: { tool_id: toolIdForBuild },
      });
    }
    try {
      const result = await window.miniAppsAPI.build(dirName);
      const outcome = classifyBuildResult(result);
      if (outcome.kind === 'awaiting-source') {
        // Not a failure — the source simply hasn't been written yet. No
        // analytics, no captureError: those are for genuine build problems.
        setRebuildState({ kind: 'awaiting-source', since: Date.now() });
        return;
      }
      if (outcome.kind === 'error') {
        const errorMsg = outcome.message;
        if (toolIdForBuild) {
          trackAnalytics({
            name: 'tool.build_failed',
            metadata: {
              tool_id: toolIdForBuild,
              duration_ms: Date.now() - buildStartMs,
              error_class: 'esbuild_exit_nonzero',
              error_message: errorMsg.slice(0, 500),
            },
          });
        }
        captureError(new Error(`tool build failed: ${errorMsg}`), {
          subsystem: 'tool_build',
          extra: {
            tool_id: toolIdForBuild,
            dirName,
            error_class: 'esbuild_exit_nonzero',
            exit_code: result.exitCode,
            duration_ms: Date.now() - buildStartMs,
          },
        });
        setRebuildState({ kind: 'error', message: errorMsg, at: Date.now() });
        return;
      }
      if (toolIdForBuild) {
        trackAnalytics({
          name: 'tool.build_completed',
          metadata: {
            tool_id: toolIdForBuild,
            duration_ms: Date.now() - buildStartMs,
          },
        });
      }
      setRebuildState({ kind: 'idle' });
      // No local remount here: main broadcasts `miniApps:built` on every
      // successful build (whoever triggered it), and ChatView answers by
      // bumping this tab's `reloadNonce`, which is the iframe's key below.
      // Bumping a second key as well remounted the iframe twice per click.
      setViewingSource(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorClass = err instanceof Error ? err.constructor.name : 'unknown';
      if (toolIdForBuild) {
        trackAnalytics({
          name: 'tool.build_failed',
          metadata: {
            tool_id: toolIdForBuild,
            duration_ms: Date.now() - buildStartMs,
            error_class: errorClass,
            error_message: errorMessage.slice(0, 500),
          },
        });
      }
      captureError(err, {
        subsystem: 'tool_build',
        extra: {
          tool_id: toolIdForBuild,
          dirName,
          error_class: errorClass,
          duration_ms: Date.now() - buildStartMs,
        },
      });
      setRebuildState({ kind: 'error', message: errorMessage, at: Date.now() });
    }
  }, [dirName]);

  useEffect(() => {
    if (preBuilt) return;
    window.filesAPI.fileExists(`${appDir}/dist/bundle.js`).then((exists) => {
      if (!exists) handleRebuild();
    }).catch(() => handleRebuild());
  }, [appDir, handleRebuild, preBuilt]);

  // While waiting for Claude to finish writing the app, poll for its source
  // file rather than making the user come back and click "Check again"
  // themselves. Guarded with `cancelled` like the other effects in this file
  // so a state change or unmount mid-check can't apply a stale result.
  useEffect(() => {
    if (rebuildState.kind !== 'awaiting-source') return;
    let cancelled = false;
    const interval = setInterval(() => {
      window.filesAPI.fileExists(`${appDir}/${APP_SOURCE_RELATIVE_PATH}`).then((exists) => {
        if (cancelled || !exists) return;
        handleRebuild();
      }).catch(() => { /* keep polling */ });
    }, AWAITING_SOURCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [rebuildState.kind, appDir, handleRebuild]);

  const handleShowInFinder = useCallback(async () => {
    await window.filesAPI.showInFinder(appDir);
  }, [appDir]);

  // "Ask me to fix it": opens the panel and posts the build
  // output as a user message in the tool's chat.
  const handleSendErrorToChat = useCallback(() => {
    if (rebuildState.kind !== 'error') return;
    if (!chatOpen) onToggleChat?.();
    composerRuntime.setText(
      `The build for \`${dirName}\` failed. Diagnose and fix it.\n\nBuild output:\n\`\`\`\n${rebuildState.message}\n\`\`\``,
    );
    composerRuntime.send();
  }, [rebuildState, chatOpen, onToggleChat, composerRuntime, dirName]);

  // ── Edit text ───────────────────────────────────────────────────────────────
  // The user clicks text in the running tool and types over it; main writes the
  // change into the tool's source. Every rule lives in `miniAppEditSession.ts`
  // (pure, and tested on its own); this block is state and plumbing.
  // Design: docs/design/mini-app-text-edit-poc.md.
  const [editing, setEditing] = useState(false);
  // The reload nonce as it stood when edit mode began. While editing, the iframe
  // is keyed on this instead of the live nonce (see `contentKey`), so the build
  // that every save triggers does not remount the tool under the user's caret.
  const [heldNonce, setHeldNonce] = useState(reloadNonce ?? 0);
  // The viewer's own reload, for when no build asked for one.
  const [localReload, setLocalReload] = useState(0);
  const [undoDepth, setUndoDepth] = useState(0);
  const [bar, setBar] = useState<EditBarState>(EDIT_HINT);
  // Edit mode starts not ready: the frame's probes and commits are ignored until
  // it reports stamped elements (see `editReadiness`).
  const [editReady, setEditReady] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const contentRef = useRef<MiniAppContentHandle>(null);
  // These are read by callbacks that outlive the render that made them (frame
  // events, the Done timer), so they are refs rather than state.
  /** An edit was applied or undone this session, so the tool must reload onto the rebuilt bundle. */
  const dirtyRef = useRef(false);
  const stampsRebuildTriedRef = useRef(false);
  /** Saves started and not yet answered, across content remounts. */
  const inFlightRef = useRef(0);
  /** Set while Done waits for the frame to confirm and for in-flight saves to land. */
  const doneRef = useRef<{ acked: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const reloadNonceRef = useRef(reloadNonce ?? 0);
  reloadNonceRef.current = reloadNonce ?? 0;
  const heldNonceRef = useRef(heldNonce);
  heldNonceRef.current = heldNonce;

  /** The one way out of edit mode: Done, its timeout, and a frame that went away all end here. */
  const completeEditing = useCallback(() => {
    if (doneRef.current) {
      clearTimeout(doneRef.current.timer);
      doneRef.current = null;
    }
    const reload = needsLocalReload({
      dirty: dirtyRef.current,
      reloadNonce: reloadNonceRef.current,
      heldNonce: heldNonceRef.current,
    });
    dirtyRef.current = false;
    setEditing(false);
    setEditReady(false);
    // Batched with the line above: one remount, onto the rebuilt bundle.
    if (reload) setLocalReload((n) => n + 1);
    setBar(EDIT_HINT);
  }, []);

  const settleDone = useCallback(() => {
    const done = doneRef.current;
    if (done && isDoneSettled({ acked: done.acked, inFlight: inFlightRef.current })) completeEditing();
  }, [completeEditing]);

  // Done: ask the frame to leave edit mode (it commits an open editor first),
  // then close once it has confirmed and every save has landed. A frame that
  // never answers cannot trap the user here, hence the timeout; and with no
  // frame on screen at all (the tool's page failed to open, or the container
  // is still starting) there is nobody to wait for.
  const finishEditing = useCallback(() => {
    if (doneRef.current) return;
    if (!contentRef.current?.postToFrame({ type: EDIT_MSG.mode, on: false })) {
      completeEditing();
      return;
    }
    doneRef.current = { acked: false, timer: setTimeout(completeEditing, DONE_WAIT_MS) };
  }, [completeEditing]);

  useEffect(() => () => {
    if (doneRef.current) clearTimeout(doneRef.current.timer);
  }, []);

  // Edit mode needs the tool itself on screen. If the content is replaced by the
  // build-failed or still-writing screens, or by the source view, there is no
  // frame left to edit and no Done button to press (the header hides them), so
  // edit mode ends on its own. A backstop: none of these is reachable while
  // editing today, since Rebuild and View source are disabled then.
  useEffect(() => {
    if (!editing) return;
    if (rebuildState.kind === 'error' || rebuildState.kind === 'awaiting-source' || viewingSource) {
      completeEditing();
    }
  }, [editing, rebuildState.kind, viewingSource, completeEditing]);

  const handleStartEdit = useCallback(() => {
    stampsRebuildTriedRef.current = false;
    dirtyRef.current = false;
    setHeldNonce(reloadNonce ?? 0);
    setEditReady(false);
    setBar(EDIT_PREPARING);
    setEditing(true);
    // Edits from an earlier session are still undoable (main keeps the stack
    // until the app quits), so Undo must start out enabled when there are any.
    window.miniAppsAPI.textEdit.undoDepth(dirName).then(setUndoDepth).catch(() => setUndoDepth(0));
  }, [dirName, reloadNonce]);

  const undoLast = useCallback(async () => {
    try {
      const result = await window.miniAppsAPI.textEdit.undo(dirName);
      setUndoDepth(result.undoDepth);
      setBar(barForUndo(result));
      if (result.ok) {
        dirtyRef.current = true;
        // The frame put the new text on screen itself; tell it to put the old back.
        contentRef.current?.postToFrame({ type: EDIT_MSG.revert, editId: result.editId });
      }
    } catch {
      setBar({ tone: 'error', text: "Couldn't undo that change." });
    }
  }, [dirName]);

  // Text that cannot be edited in source (the tool computes it while it runs)
  // becomes a request to Claude instead. It fills the composer and stops there:
  // sending is the user's decision, so this path costs no model call by itself.
  const sendRequestToChat = useCallback((oldText: string, newText: string) => {
    if (!chatOpen) onToggleChat?.();
    // Appended to a draft, never over it.
    composerRuntime.setText(composeComposerText(composerRuntime.getState().text ?? '', askClaudePrompt(oldText, newText)));
    setBar(barForSuggestion());
  }, [chatOpen, onToggleChat, composerRuntime]);

  // The frame reported, finally, that this bundle carries no source stamps: it
  // was built with bare esbuild. One rebuild per session adds them. The frame
  // cannot have an editor open (it is not ready, so its probes get no answer),
  // which is what makes the reload below safe.
  const prepareForEditing = useCallback(async () => {
    stampsRebuildTriedRef.current = true;
    setBar(EDIT_PREPARING);
    try {
      const result = await window.miniAppsAPI.build(dirName);
      if (!result.ok) {
        if (editingRef.current) setBar(barForPrepareFailure(result.error));
        return;
      }
    } catch (err) {
      if (editingRef.current) setBar(barForPrepareFailure(err instanceof Error ? err.message : String(err)));
      return;
    }
    // Edit mode ended while the build ran: Done already released the key.
    if (!editingRef.current) return;
    // Main announces the build, but the iframe is held while editing, so the
    // new bundle only arrives if the viewer asks for it. The held nonce adopts
    // the live one so Done does not reload a second time.
    setHeldNonce(reloadNonceRef.current);
    setLocalReload((n) => n + 1);
  }, [dirName]);

  const handleFrameState = useCallback((stamped: number, final: boolean) => {
    switch (editReadiness({ stamped, final, alreadyRebuilt: stampsRebuildTriedRef.current })) {
      case 'ready':
        setEditReady(true);
        setBar((b) => (b === EDIT_PREPARING ? EDIT_HINT : b));
        return;
      case 'rebuild':
        void prepareForEditing();
        return;
      case 'give-up':
        setBar(EDIT_UNTRACEABLE);
        return;
      case 'wait':
        return;
    }
  }, [prepareForEditing]);

  const handleEditEvent = useCallback((evt: EditEvent) => {
    switch (evt.kind) {
      case 'probe-refused':
        setBar(barForProbeRefusal(evt));
        return;
      case 'applied':
      case 'refused':
        setBar(barForApply(evt.result, evt.oldText, evt.newText));
        setUndoDepth(evt.result.undoDepth);
        if (evt.result.ok) dirtyRef.current = true;
        return;
      case 'suggest':
        sendRequestToChat(evt.oldText, evt.newText);
        return;
      case 'shortcut':
        if (evt.action === 'undo') void undoLast();
        else finishEditing();
        return;
      case 'frame-state':
        handleFrameState(evt.stamped, evt.final);
        return;
      case 'revert-failed':
        // The text node the edit lived in is gone; reload to show what is on disk.
        // The fresh frame reports its own readiness.
        setEditReady(false);
        setLocalReload((n) => n + 1);
        return;
      case 'mode-off-acked':
        if (doneRef.current) {
          doneRef.current.acked = true;
          settleDone();
        }
        return;
      case 'inflight-change':
        inFlightRef.current = Math.max(0, inFlightRef.current + evt.delta);
        settleDone();
        return;
    }
  }, [sendRequestToChat, undoLast, finishEditing, handleFrameState, settleDone]);

  // Host-level shortcuts while editing (the frame has its own for when it has
  // focus). Typing into the chat composer or any field is left alone.
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntryTarget(e.target as HTMLElement | null)) return;
      const action = hostShortcutFor(e);
      if (!action) return;
      e.preventDefault();
      if (action === 'undo') void undoLast();
      else finishEditing();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editing, undoLast, finishEditing]);

  const showBuildError = rebuildState.kind === 'error' && !viewingSource;
  const showAwaitingSource = rebuildState.kind === 'awaiting-source' && !viewingSource;

  return (
    <div className="miniAppViewer">
      <MiniAppHeader
        dirName={dirName}
        appName={appName ?? dirName}
        appIcon={appIcon ?? null}
        viewingSource={viewingSource}
        onToggleSource={() => setViewingSource((v) => !v)}
        onRebuild={handleRebuild}
        onShowInFinder={handleShowInFinder}
        rebuildState={rebuildState}
        preBuilt={preBuilt}
        chatOpen={chatOpen}
        onToggleChat={onToggleChat}
        nativeToolUrl={nativeToolUrl}
        onBack={onBack}
        editing={editing}
        undoDepth={undoDepth}
        onStartEdit={handleStartEdit}
        onUndo={undoLast}
        onDone={finishEditing}
      />
      {editing && (
        <EditBar bar={bar} onAskClaude={(ask) => sendRequestToChat(ask.oldText, ask.newText)} />
      )}
      <div className="miniAppBody">
        {showBuildError ? (
          <BuildErrorView
            message={rebuildState.kind === 'error' ? rebuildState.message : ''}
            at={rebuildState.kind === 'error' ? rebuildState.at : Date.now()}
            onRebuild={handleRebuild}
            onSendToChat={handleSendErrorToChat}
          />
        ) : showAwaitingSource ? (
          <AwaitingSourceView
            since={rebuildState.kind === 'awaiting-source' ? rebuildState.since : Date.now()}
            onRebuild={handleRebuild}
            onOpenChat={chatOpen ? undefined : onToggleChat}
          />
        ) : preBuilt && nativeToolUrl ? (
          <MiniAppContent
            key={`prebuilt-${reloadNonce ?? 0}`}
            dirName={dirName}
            workspacePath={workspacePath}
            preBuilt
            nativeToolUrl={nativeToolUrl}
            appName={appName}
          />
        ) : preBuilt ? (
          <CenteredMonoStatus label="STARTING" />
        ) : (
          <ContainerGate dirName={dirName}>
            {viewingSource ? (
              <SourceViewer
                appDir={appDir}
                dirName={dirName}
                rebuildState={rebuildState}
              />
            ) : (
              <MiniAppContent
                ref={contentRef}
                key={contentKey({ editing, heldNonce, reloadNonce: reloadNonce ?? 0, localReload })}
                dirName={dirName}
                workspacePath={workspacePath}
                appName={appName}
                editing={editing}
                editReady={editReady}
                onEditEvent={handleEditEvent}
              />
            )}
          </ContainerGate>
        )}
      </div>
    </div>
  );
};

const MiniAppHeader: FC<{
  dirName: string;
  appName: string;
  appIcon: string | null;
  viewingSource: boolean;
  onToggleSource: () => void;
  onRebuild: () => void;
  onShowInFinder: () => void;
  rebuildState: RebuildState;
  preBuilt?: boolean;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  nativeToolUrl: string | null;
  onBack?: () => void;
  /** Edit text (POC): the user is changing the tool's text in place. */
  editing: boolean;
  /** Edits `onUndo` can take back; 0 disables the button. */
  undoDepth: number;
  onStartEdit: () => void;
  onUndo: () => void;
  onDone: () => void;
}> = ({ dirName, appName, appIcon, viewingSource, onToggleSource, onRebuild, onShowInFinder, rebuildState, preBuilt, chatOpen, onToggleChat, nativeToolUrl, onBack, editing, undoDepth, onStartEdit, onUndo, onDone }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const handleExport = useCallback(async () => {
    setMenuOpen(false);
    await window.miniAppsAPI.exportApp(dirName);
  }, [dirName]);

  /**
   * Stop everything this tool has in flight. Confirmation is asked only when
   * something has been running long enough that losing it would hurt — a prompt
   * on every stop trains people to click through it.
   */
  const handleStop = useCallback(async () => {
    const running = (await window.jobsAPI.list())
      .filter((j) => j.dirName === dirName && j.status === 'running');
    if (running.length === 0) return;

    const longest = Math.max(...running.map((j) => Date.now() - j.startedAt));
    if (longest > 60_000) {
      const mins = Math.round(longest / 60_000);
      const ok = window.confirm(
        `Stop this tool?\n\nIt has been working for ${mins} minute${mins === 1 ? '' : 's'}. ` +
        'Anything it has half-written will be left as it is.',
      );
      if (!ok) return;
    }
    await Promise.all(running.map((j) => window.jobsAPI.cancel(j.id)));
  }, [dirName]);

  const status = useToolStatus(dirName);
  // `rebuildState` is read directly rather than through the store for these
  // two so the header flips on the same render as the build starts/fails; the
  // store is one effect behind.
  const isBuilding = rebuildState.kind === 'building';
  const failed = rebuildState.kind === 'error';
  const awaiting = rebuildState.kind === 'awaiting-source';
  const installing = status.kind === 'installing';
  const working = status.kind === 'working';
  const interrupted = status.kind === 'interrupted' ? status : null;
  // Edit text needs the tool itself on screen, built, with source to write to.
  // Not offered for the pre-built tools, the source view, or the screens that
  // stand in for the tool while it is broken or not written yet.
  const canEditText = !preBuilt && !viewingSource && !failed && !awaiting;
  const ToolIcon = resolveToolIcon(appIcon);

  return (
    <div className="cdToolHeader">
      {onBack && (
        <button type="button" className="cdIconBtn" title="Back to Tools" onClick={onBack}>
          <MSymbol name="arrow_back" size={18} />
        </button>
      )}
      {failed ? (
        <MSymbol name="error" size={18} className="cdToolHeader__icon cdToolHeader__icon--error" />
      ) : (
        <ToolIcon className="cdToolHeader__icon" style={{ width: 18, height: 18 }} />
      )}
      <span className="cdToolHeader__name">{appName}</span>
      {failed ? (
        <span className="cdStatusChip cdStatusChip--error">
          <span className="cdDot cdDot--error" />
          BUILD FAILED
        </span>
      ) : awaiting ? (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--busy cdDot--pulse" />
          STILL WRITING
        </span>
      ) : isBuilding ? (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--busy cdDot--pulse" />
          BUILDING
        </span>
      ) : installing ? (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--busy cdDot--pulse" />
          SETTING UP
        </span>
      ) : editing ? (
        <>
          <span className="cdStatusChip">
            <span className="cdDot cdDot--unread" />
            EDITING
          </span>
          {/* Edit mode must not hide the brake on work the tool is doing. */}
          {working && (
            <button
              type="button"
              className="cdBtnXs cdBtnXs--sm"
              title="Stop what this tool is doing"
              onClick={handleStop}
            >
              <MSymbol name="stop_circle" size={15} />
              Stop
            </button>
          )}
        </>
      ) : working ? (
        <>
          <span className="cdStatusChip">
            <span className="cdDot cdDot--busy cdDot--pulse" />
            WORKING
          </span>
          {/* The only stop control that sits where the user notices the work. */}
          <button
            type="button"
            className="cdBtnXs cdBtnXs--sm"
            title="Stop what this tool is doing"
            onClick={handleStop}
          >
            <MSymbol name="stop_circle" size={15} />
            Stop
          </button>
        </>
      ) : interrupted ? (
        <span className="cdStatusChip" title={toolStatusDetail(interrupted) ?? undefined}>
          <span className="cdDot cdDot--busy" />
          {toolStatusLabel(interrupted)}
        </span>
      ) : (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--sleeping" />
          IDLE
        </span>
      )}
      {!preBuilt && <ToolShareChip dirName={dirName} />}
      <span className="cdToolHeader__spacer" />
      {canEditText && (editing ? (
        <>
          <button
            type="button"
            className="cdBtnXs cdBtnXs--sm"
            title="Undo the last text change (⌘Z)"
            onClick={onUndo}
            disabled={undoDepth === 0}
          >
            <MSymbol name="undo" size={15} />
            Undo
          </button>
          <button
            type="button"
            className="cdBtnPrimary cdBtnPrimary--sm"
            title="Leave edit mode"
            onClick={onDone}
          >
            <MSymbol name="check" size={15} />
            Done
          </button>
        </>
      ) : (
        <button
          type="button"
          className="cdBtnXs cdBtnXs--sm"
          title="Click any text in the tool to change it"
          onClick={onStartEdit}
          disabled={isBuilding || installing}
        >
          <MSymbol name="edit" size={15} />
          Edit text
        </button>
      ))}
      {!preBuilt && !editing && (
        <button
          type="button"
          className="cdBtnXs cdBtnXs--sm"
          onClick={onRebuild}
          disabled={isBuilding || installing}
        >
          <MSymbol name="refresh" size={15} />
          Rebuild
        </button>
      )}
      {onToggleChat && (
        <button
          type="button"
          className={`cdIconBtn cdIconBtn--30${chatOpen ? ' cdIconBtn--active' : ''}`}
          title="Chat panel"
          onClick={onToggleChat}
        >
          <MSymbol name="forum" size={18} />
        </button>
      )}
      {!preBuilt && <ToolShareHeaderControls dirName={dirName} appName={appName} />}
      {preBuilt && nativeToolUrl && (
        <button
          type="button"
          className="cdIconBtn cdIconBtn--30"
          title="Open in browser"
          onClick={() => (window as any).electronAPI.invoke('shell:openExternal', nativeToolUrl)}
        >
          <MSymbol name="open_in_new" size={18} />
        </button>
      )}
      {!preBuilt && (
        <div className="cdMenuWrap" ref={menuRef}>
          <button
            type="button"
            className={`cdIconBtn cdIconBtn--30${menuOpen ? ' cdIconBtn--active' : ''}`}
            title="More"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MSymbol name="more_horiz" size={18} />
          </button>
          {menuOpen && (
            <div className="cdMenu">
              <button
                type="button"
                className="cdMenu__item"
                onClick={() => { setMenuOpen(false); onToggleSource(); }}
                disabled={editing}
              >
                <MSymbol name="code" size={16} />
                {viewingSource ? 'View tool' : 'View source'}
              </button>
              <button
                type="button"
                className="cdMenu__item"
                onClick={() => { setMenuOpen(false); onShowInFinder(); }}
              >
                <MSymbol name="folder_open" size={16} />
                Reveal in Finder
              </button>
              <button type="button" className="cdMenu__item" onClick={handleExport}>
                <MSymbol name="download" size={16} />
                Download
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * The strip under the header while the user is editing text: what to do, then
 * what just happened. The wording is all in `miniAppEditSession.ts`; this only
 * lays it out. The whole message is also the tooltip, since the line is clamped.
 */
const EditBar: FC<{
  bar: EditBarState;
  onAskClaude: (ask: { oldText: string; newText: string }) => void;
}> = ({ bar, onAskClaude }) => {
  const { ask } = bar;
  return (
    <div className={`cdEditBar cdEditBar--${bar.tone}`} role="status" title={bar.detail ? `${bar.text} ${bar.detail}` : bar.text}>
      <span className="cdEditBar__label">EDITING TEXT</span>
      <span className="cdEditBar__dot" />
      <span className="cdEditBar__text">{bar.text}</span>
      {bar.detail && <span className="cdEditBar__detail">{bar.detail}</span>}
      {ask && (
        <button type="button" className="cdTextLink cdEditBar__ask" onClick={() => onAskClaude(ask)}>
          Ask Claude
        </button>
      )}
    </div>
  );
};

/** Centered mono placeholder line (pre-boot / waiting states). */
const CenteredMonoStatus: FC<{ label: string; pulse?: boolean }> = ({ label, pulse = true }) => (
  <div className="cdInstallWrap">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className={`cdDot cdDot--busy${pulse ? ' cdDot--pulse' : ''}`} />
      <span className="cdWorking__label">{label}</span>
    </div>
  </div>
);

/** Build error state — replaces the iframe content (Phase B spec). */
const BuildErrorView: FC<{
  message: string;
  at: number;
  onRebuild: () => void;
  onSendToChat: () => void;
}> = ({ message, at, onRebuild, onSendToChat }) => {
  const time = new Date(at);
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  return (
    <div className="cdBuildErr">
      <div className="cdBuildErr__col">
        <span className="cdBuildErr__eyebrow">BUILD FAILED · {hh}:{mm}</span>
        <span className="cdBuildErr__title">This tool won't open right now.</span>
        <span className="cdBuildErr__sub">
          Something in its code needs fixing. The quickest fix is to let me do it.
        </span>
        <div className="cdBuildErr__actions">
          <button type="button" className="cdBtnPrimary cdBtnPrimary--36" onClick={onSendToChat}>
            <MSymbol name="forum" size={16} />
            Ask me to fix it
          </button>
          <button type="button" className="cdBtnXs cdBtnXs--sm" onClick={onRebuild}>
            <MSymbol name="refresh" size={15} />
            Try again
          </button>
        </div>
        <details className="cdBuildErr__details">
          <summary>Show details</summary>
          <pre className="cdBuildErr__out">{message}</pre>
          <button
            type="button"
            className="cdTextLink"
            onClick={() => navigator.clipboard.writeText(message)}
          >
            Copy details
          </button>
        </details>
      </div>
    </div>
  );
};

interface AppPackage {
  registry: PackageRegistry;
  package: string;
  state: PackageState | 'unknown';
  line: string;
}

/** "pandas==2.2.3" / "left-pad@1.3.0" → name + version for the install rows. */
function splitPackageSpec(pkg: AppPackage): { name: string; version: string } {
  switch (pkg.registry) {
    case 'npm': {
      const at = pkg.package.lastIndexOf('@');
      if (at > 0) return { name: pkg.package.slice(0, at), version: pkg.package.slice(at + 1) };
      return { name: pkg.package, version: '' };
    }
    case 'manual':
      return { name: pkg.package.split('/').pop() ?? pkg.package, version: '' };
    default: {
      const m = pkg.package.match(/^([^=<>~!\s]+)\s*(?:(?:==|>=|<=|~=|!=)\s*(.+))?$/);
      return { name: m?.[1] ?? pkg.package, version: m?.[2] ?? '' };
    }
  }
}

const InstallPackageRow: FC<{ pkg: AppPackage }> = ({ pkg }) => {
  const { name, version } = splitPackageSpec(pkg);
  const state = pkg.state;
  const rowClass =
    state === 'failed' ? ' cdInstall__row--failed'
      : state === 'queued' || state === 'unknown' ? ' cdInstall__row--queued'
      : '';
  return (
    <div className={`cdInstall__row${rowClass}`}>
      <span className="cdInstall__pkg">{name}</span>
      {version && <span className="cdInstall__ver">{version}</span>}
      <span className="cdInstall__rowSpacer" />
      {state === 'installed' && (
        <>
          <span className="cdDot cdDot--running" />
          <span className="cdInstall__state">DONE</span>
        </>
      )}
      {state === 'installing' && (
        <>
          <span className="cdDot cdDot--busy cdDot--pulse" />
          <span className="cdInstall__state">INSTALLING…</span>
        </>
      )}
      {(state === 'queued' || state === 'unknown') && (
        <>
          <span className="cdDot cdDot--sleeping" />
          <span className="cdInstall__state cdInstall__state--queued">QUEUED</span>
        </>
      )}
      {state === 'failed' && (
        <>
          <span className="cdDot cdDot--error" />
          <span className="cdInstall__state cdInstall__state--failed">FAILED</span>
        </>
      )}
    </div>
  );
};

/** First-boot dependency interstitial — replaces the iframe (Phase B spec). */
const PackageChecklistView: FC<{ packages: AppPackage[] }> = ({ packages }) => {
  const total = packages.length;
  const done = packages.filter((p) => p.state === 'installed').length;
  const liveLine = packages.find((p) => p.state === 'installing')?.line ?? '';
  return (
    <div className="cdInstallWrap">
      <div className="cdInstall">
        <div className="cdInstall__header">
          <span className="cdInstall__title">SETTING UP — {total} THING{total === 1 ? '' : 'S'} TO INSTALL</span>
          <span className="cdInstall__count">{done}/{total}</span>
        </div>
        {packages.map((p) => (
          <InstallPackageRow key={`${p.registry}:${p.package}`} pkg={p} />
        ))}
        <div className="cdInstall__footer">
          <div className="cdProgress">
            <div className="cdProgress__fill" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
          </div>
          <span className="cdInstall__footerCount">{done}/{total}</span>
        </div>
      </div>
      {liveLine && <span className="cdInstall__log">▸ {liveLine}</span>}
    </div>
  );
};

const ContainerGate: FC<{ dirName: string; children: React.ReactNode }> = ({ dirName, children }) => {
  const [containerReady, setContainerReady] = useState<boolean | null>(null);
  const [depsReady, setDepsReady] = useState<boolean | null>(null);
  const statusMessage = 'Starting Acabox…';

  // The tool's package list + each one's current state/line, used for the
  // per-package checklist while deps are installing.
  const [packages, setPackages] = useState<AppPackage[] | null>(null);

  // Check container status
  useEffect(() => {
    let cancelled = false;
    window.containerAPI.status().then(({ running }) => {
      if (!cancelled) setContainerReady(running);
    });
    return () => { cancelled = true; };
  }, []);

  // Wait for container to start
  useEffect(() => {
    if (containerReady) return;

    const cleanups = [
      window.containerAPI.onProgress((progress) => {
        if (progress.stage === 'ready') {
          setContainerReady(true);
        }
      }),
      window.containerAPI.onSetupProgress((progress) => {
        // Only react to 'ready' — 'setup-done' fires before container.start(),
        // so the container isn't running yet.
        if (progress.stage === 'ready') {
          setContainerReady(true);
        }
      }),
    ];

    const interval = setInterval(async () => {
      const { running } = await window.containerAPI.status();
      if (running) setContainerReady(true);
    }, 3000);

    return () => {
      cleanups.forEach((fn) => fn());
      clearInterval(interval);
    };
  }, [containerReady]);

  // Fetch this app's install requests so we know which packages to track.
  // Subscribe to per-package state/line events filtered to those packages.
  // Seed initial state from the installer's snapshot so mid-wave opens don't
  // show stale `queued` for packages that already transitioned.
  useEffect(() => {
    if (!containerReady) return;
    let cancelled = false;

    Promise.all([
      window.containerAPI.getAppInstallRequests(dirName),
      window.containerAPI.getEnvironmentInfo(),
    ]).then(([requests, envInfo]) => {
      if (cancelled) return;
      const stateSnapshot = envInfo?.packageStates;
      const lineSnapshot = envInfo?.packageLines;
      const initial: AppPackage[] = [];
      for (const r of requests) {
        for (const p of r.packages) {
          const state = (stateSnapshot?.[r.registry]?.[p] as PackageState | undefined) ?? 'unknown';
          const line = lineSnapshot?.[r.registry]?.[p] ?? '';
          initial.push({ registry: r.registry, package: p, state, line });
        }
      }
      setPackages(initial);
    });

    return () => { cancelled = true; };
  }, [containerReady, dirName]);

  // Live updates: when a package this app cares about changes state or
  // streams a line, update the matching row. The subscriptions only need to
  // attach once per (containerReady, dirName); per-package filtering reads
  // from the latest `packages` via setState's updater.
  useEffect(() => {
    if (!containerReady) return;
    const cleanups = [
      window.containerAPI.onPackageState((e) => {
        setPackages((prev) => {
          if (!prev) return prev;
          let changed = false;
          const next = prev.map((p) => {
            if (p.registry === e.registry && p.package === e.package) {
              changed = true;
              return { ...p, state: e.state };
            }
            return p;
          });
          return changed ? next : prev;
        });
      }),
      window.containerAPI.onPackageLine((e) => {
        setPackages((prev) => {
          if (!prev) return prev;
          let changed = false;
          const next = prev.map((p) => {
            if (p.registry === e.registry && p.package === e.package) {
              changed = true;
              return { ...p, line: e.line };
            }
            return p;
          });
          return changed ? next : prev;
        });
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [containerReady]);

  // Once container is ready, ensure app deps are installed
  useEffect(() => {
    if (!containerReady) return;
    let cancelled = false;

    const attemptEnsureDeps = () => {
      window.containerAPI.appDepsReady(dirName).then((ready) => {
        if (cancelled) return;
        if (ready) {
          setDepsReady(true);
          return;
        }
        // Flip from `null` to `false` so the gate renders the install checklist
        // instead of a blank screen during the install wait.
        setDepsReady(false);
        window.containerAPI.ensureAppDeps(dirName)
          .then(() => { if (!cancelled) setDepsReady(true); })
          .catch((err) => {
            console.error(`[MiniAppViewer] Failed to install deps for ${dirName}:`, err);
            if (!cancelled) setTimeout(attemptEnsureDeps, 3000);
          });
      });
    };
    attemptEnsureDeps();

    return () => { cancelled = true; };
  }, [containerReady, dirName]);

  // Surface first-boot progress to the shared status store (tab dots, header).
  useEffect(() => {
    if (depsReady === false) {
      const done = packages?.filter((p) => p.state === 'installed').length ?? 0;
      const total = packages?.length ?? 0;
      setToolLifecycle(dirName, { kind: 'installing', done, total });
    } else if (depsReady === true) {
      setToolLifecycle(dirName, { kind: 'idle' });
    }
  }, [depsReady, packages, dirName]);

  if (containerReady === null) return null;
  if (!containerReady) return <CenteredMonoStatus label={statusMessage} />;
  if (depsReady === null) return null;
  if (!depsReady) {
    if (packages === null) return null;  // still fetching the install plan
    if (packages.length === 0) return <CenteredMonoStatus label="SETTING UP — INSTALLING" />;
    return <PackageChecklistView packages={packages} />;
  }

  return <>{children}</>;
};

const MiniAppContent = React.forwardRef<MiniAppContentHandle, {
  dirName: string;
  workspacePath: string;
  preBuilt?: boolean;
  nativeToolUrl?: string;
  appName?: string | null;
  /** Edit text (POC): the user is changing the tool's text in place. Off when omitted. */
  editing?: boolean;
  /** The frame has stamped elements; until then probes and commits get no reply. */
  editReady?: boolean;
  /** Everything the frame and main say about editing; see `EditEvent`. */
  onEditEvent?: (evt: EditEvent) => void;
}>(({ dirName, workspacePath, preBuilt, nativeToolUrl, appName, editing = false, editReady = false, onEditEvent }, ref) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Reads the iframe at call time, not at mount: the element is replaced when a
  // load error clears, and a handle that captured the first one would post into
  // a detached frame.
  const postToFrame = useCallback((message: unknown): boolean => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) return false;
    frameWindow.postMessage(message, '*');
    return true;
  }, []);
  React.useImperativeHandle(ref, () => ({ postToFrame }), [postToFrame]);
  // Frame messages arrive on a listener that outlives renders, so what it needs
  // to know about edit mode is read through refs and the listener stays put.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const editReadyRef = useRef(editReady);
  editReadyRef.current = editReady;
  const onEditEventRef = useRef(onEditEvent);
  onEditEventRef.current = onEditEvent;
  const [loadError, setLoadError] = useState(false);
  const appDir = `${workspacePath}/.applications/${dirName}`;
  const { connect, executeCode } = useKernel(`miniapp::${dirName}`);
  const composerRuntime = useComposerRuntime();
  const iframeRouteKey = React.useMemo(() => `${dirName}::${Math.random().toString(36).slice(2)}`, [dirName]);
  const registeredServerRef = useRef<string | null>(null);
  /** invocationId -> the activity-episode closer for that agent MCP call. */
  const mcpActivityEndsRef = useRef(new Map<string, () => void>());

  // Register MCP server from manifest.json on mount; tear down on unmount.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const manifest = await window.filesAPI.readFile(`${appDir}/manifest.json`);
        if (cancelled || !manifest || 'error' in manifest || manifest.type !== 'text') return;
        let parsed: any;
        try { parsed = JSON.parse(manifest.content); } catch { return; }
        const mcp = parsed?.mcp;
        if (!mcp || typeof mcp.server_name !== 'string' || !Array.isArray(mcp.tools)) return;
        const tools = mcp.tools.filter((t: any) =>
          t && typeof t.name === 'string' && typeof t.description === 'string' && t.input_schema && typeof t.input_schema === 'object',
        );
        if (tools.length === 0) return;
        await window.miniAppMcpAPI.register({
          serverName: mcp.server_name,
          dirName,
          tools,
          iframeRouteKey,
        });
        registeredServerRef.current = mcp.server_name;
      } catch (err) {
        console.warn('[MiniAppContent] Failed to register MCP server:', err);
      }
    })();
    return () => {
      cancelled = true;
      window.miniAppMcpAPI.unregisterByRoute(iframeRouteKey);
      registeredServerRef.current = null;
    };
  }, [appDir, dirName, iframeRouteKey]);

  // Route agent / other-mini-app invocations to this iframe and relay results.
  // An invocation is an activity episode for this tool: it opens here and is
  // closed by the matching `mcp:result` in handleBridgeMessage below.
  React.useEffect(() => {
    const unsubscribe = window.miniAppMcpAPI.onInvoke((payload) => {
      if (payload.iframeRouteKey !== iframeRouteKey) return;
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) {
        window.miniAppMcpAPI.sendResult({ invocationId: payload.invocationId, error: 'iframe is not mounted' });
        return;
      }
      mcpActivityEndsRef.current.set(payload.invocationId, beginToolActivity(dirName));
      iframe.contentWindow.postMessage(
        { type: 'mcp:invoke', invocationId: payload.invocationId, toolName: payload.toolName, args: payload.args },
        '*',
      );
    });
    return unsubscribe;
  }, [iframeRouteKey, dirName]);

  // An iframe that never answers would otherwise leak a held-open episode.
  // Main times the invocation out at 60s; release ours on unmount.
  React.useEffect(() => {
    const pending = mcpActivityEndsRef.current;
    return () => {
      for (const end of pending.values()) end();
      pending.clear();
    };
  }, []);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      // If the iframe loaded an error page or about:blank, the contentDocument may be inaccessible
      const doc = iframe.contentDocument;
      if (doc && doc.title === '') {
        // Check if the body is essentially empty (failed load)
        const bodyText = doc.body?.innerText?.trim() ?? '';
        if (bodyText === 'Not Found' || bodyText === 'Forbidden' || (bodyText === '' && !nativeToolUrl)) {
          console.warn('[MiniAppContent] Iframe loaded but content appears missing for:', dirName);
          setLoadError(true);
          return;
        }
      }
    } catch {
      // Cross-origin — content loaded from a real page, which is fine
    }
    setLoadError(false);
    iframe.contentWindow?.postMessage(
      { type: 'init', workspacePath },
      '*',
    );
    // A fresh document starts out of edit mode. When the tool was reloaded
    // mid-session (a held build landing, a revert that lost its text node) put
    // it back. The shim also asks, with `ready`, in case it installs after this.
    if (editingRef.current) postToFrame({ type: EDIT_MSG.mode, on: true });
  }, [workspacePath, dirName, nativeToolUrl, postToFrame]);

  // Tell the frame when edit mode starts or stops. Changes only: a mount is not
  // one, and the load handler above covers a document that arrives later.
  const lastModeRef = useRef(editing);
  useEffect(() => {
    if (lastModeRef.current === editing) return;
    lastModeRef.current = editing;
    postToFrame({ type: EDIT_MSG.mode, on: editing });
  }, [editing, postToFrame]);

  /**
   * One validated message from the edit shim in the frame. Probing and applying
   * go to main; answers go back to the frame; what the user should see goes to
   * the viewer. Messages that act on the tool are ignored unless edit mode is
   * on: the frame's own code can post anything, and the host is the boundary.
   */
  const handleEditMessage = useCallback(async (msg: FrameEditMessage) => {
    const emit = (evt: EditEvent) => onEditEventRef.current?.(evt);
    switch (msg.type) {
      case EDIT_MSG.ready:
        if (editingRef.current) postToFrame({ type: EDIT_MSG.mode, on: true });
        return;

      case EDIT_MSG.state:
        if (msg.on === false) emit({ kind: 'mode-off-acked' });
        // Only a FINAL zero means the bundle has no stamps: the shim keeps
        // watching for a while, because React may not have rendered yet.
        else if (editingRef.current) emit({ kind: 'frame-state', stamped: msg.stamped, final: msg.final });
        return;

      case EDIT_MSG.probe: {
        if (!editingRef.current || !editReadyRef.current) return;
        let result: TextEditProbeResult;
        try {
          result = await window.miniAppsAPI.textEdit.probe(dirName, msg.target);
        } catch {
          // Unanswered, the frame would wait for ever. Answering "not editable"
          // still lets the user type a request for Claude.
          result = { editable: false, reason: 'invalid', message: "Couldn't check whether this text can be changed." };
        }
        postToFrame({ type: EDIT_MSG.probeResult, probeId: msg.probeId, editable: result.editable });
        if (!result.editable) emit({ kind: 'probe-refused', reason: result.reason, message: result.message });
        return;
      }

      case EDIT_MSG.commit: {
        if (!editingRef.current || !editReadyRef.current) return;
        // Counted before the first await, so Done (which waits for this count to
        // reach zero) can never see the frame's `state` ahead of this save.
        emit({ kind: 'inflight-change', delta: 1 });
        try {
          const { target, editId, newText } = msg;
          let result: TextEditApplyResult;
          try {
            result = await window.miniAppsAPI.textEdit.apply(dirName, { ...target, editId, newText });
          } catch {
            // The frame is showing the new text and waiting to hear whether it
            // stuck; a failure to ask is a "no", and it puts the old text back.
            const undoDepth = await window.miniAppsAPI.textEdit.undoDepth(dirName).catch(() => 0);
            result = { ok: false, editId, reason: 'invalid', message: "Couldn't save this change. Nothing was changed.", undoDepth };
          }
          postToFrame({
            type: EDIT_MSG.applyResult,
            editId,
            ok: result.ok,
            ...(result.ok ? { sameElementScope: result.sameElementScope } : {}),
          });
          if (result.ok) emit({ kind: 'applied', result, oldText: target.text, newText });
          else emit({ kind: 'refused', result, oldText: target.text, newText });
        } finally {
          // After the result event, so the viewer knows the edit was applied
          // (and the tool is dirty) by the time Done sees nothing in flight.
          emit({ kind: 'inflight-change', delta: -1 });
        }
        return;
      }

      case EDIT_MSG.suggest:
        if (editingRef.current) emit({ kind: 'suggest', oldText: msg.oldText, newText: msg.newText });
        return;

      case EDIT_MSG.shortcut:
        if (editingRef.current) emit({ kind: 'shortcut', action: msg.action });
        return;

      case EDIT_MSG.reverted:
        if (!msg.ok) emit({ kind: 'revert-failed' });
        return;
    }
  }, [dirName, postToFrame]);

  const handleBridgeMessage = useCallback(
    async (event: MessageEvent) => {
      const iframe = iframeRef.current;
      // event.source check is the correct origin-validation mechanism for local-file:// pages.
      // event.origin is unreliable on local-file:// in Electron (reported as "null" or "file://").
      if (!iframe || event.source !== iframe.contentWindow) return;

      // A selection report from the injected shim. It is a notification, not a
      // request — there is no `id` and nothing to post back — so it has to be
      // handled ahead of the dispatch below, which drops anything unpaired.
      //
      // The rect arrives in the FRAME's viewport coordinates and is useless
      // until offset by where the frame sits in ours. Everything else about
      // the toolbar (positioning, dismissal, the click) is the host's ordinary
      // path, so a quote taken from a tool is indistinguishable from any other.
      if (event.data?.type === 'quoteSelection') {
        const selection = event.data.selection as
          | { text: string; rect: { top: number; left: number; width: number } }
          | null;
        if (!selection) {
          window.dispatchEvent(new CustomEvent('cd:frame-selection', { detail: null }));
          return;
        }
        const prepared = prepareQuoteText(selection.text);
        if (!prepared) {
          window.dispatchEvent(new CustomEvent('cd:frame-selection', { detail: null }));
          return;
        }
        const frameBox = iframe.getBoundingClientRect();
        window.dispatchEvent(new CustomEvent('cd:frame-selection', {
          detail: {
            text: prepared.text,
            truncated: prepared.truncated,
            messageId: `src:miniapp:${dirName}`,
            source: { kind: 'miniapp', appDirName: dirName, appName: appName || dirName },
            rect: {
              top: frameBox.top + selection.rect.top,
              left: frameBox.left + selection.rect.left,
              width: selection.rect.width,
            },
          },
        }));
        return;
      }

      // Mini-app MCP responses follow a separate protocol: the iframe is
      // returning a result for an invocation main initiated, so the id field
      // is `invocationId` instead of `id` and there's no response postback.
      if (event.data?.type === 'mcp:result' && typeof event.data?.invocationId === 'string') {
        const endActivity = mcpActivityEndsRef.current.get(event.data.invocationId);
        if (endActivity) {
          mcpActivityEndsRef.current.delete(event.data.invocationId);
          endActivity();
        }
        window.miniAppMcpAPI.sendResult({
          invocationId: event.data.invocationId,
          result: event.data.result,
          error: event.data.error,
        });
        return;
      }

      // Edit-mode traffic from the injected edit shim. Notifications too, with
      // no `id`, so they are claimed here, ahead of the dispatch below that
      // would drop them. Validated first: the frame's code can post anything.
      const editMessage = parseFrameEditMessage(event.data);
      if (editMessage) {
        void handleEditMessage(editMessage);
        return;
      }

      const { type, id, ...args } = event.data;
      if (!type || !id) return;

      let result: unknown;
      let error: string | undefined;
      let skipResponse = false;

      // Register long-running work with the HOST, not with this component, so
      // the status survives the viewer being unmounted. `beginToolActivity` is
      // not called here — the store picks the job up from the host's list.
      const jobSpec = JOB_BRIDGE_KINDS[type];
      let jobId: string | null = null;
      if (jobSpec) {
        jobId = await window.jobsAPI
          .begin({ dirName, kind: jobSpec.kind, label: jobSpec.label })
          .catch(() => null);
      }
      let endActivity: (() => void) | null = jobId
        ? () => { void window.jobsAPI.end(jobId!).catch(() => {}); }
        : null;
      let activityEndsAsync = false;

      try {
        switch (type) {
          case 'readFile':
            result = await window.filesAPI.readFile(args.path);
            break;
          case 'writeFile':
            if (preBuilt) { error = 'Write operations are disabled for pre-built apps'; break; }
            await window.filesAPI.writeFile(args.path, args.content);
            result = { ok: true };
            break;
          case 'copyFile': {
            const copyResult = await window.filesAPI.copyToWorkspace(
              [args.sourcePath as string],
              args.destinationDir as string,
            );
            result = copyResult;
            break;
          }
          case 'deleteFile':
            if (preBuilt) { error = 'Delete operations are disabled for pre-built apps'; break; }
            await window.filesAPI.deleteFile(args.path as string);
            result = { ok: true };
            break;
          case 'selectFile':
            result = await window.filesAPI.selectFile(args.filters);
            break;
          case 'downloadFile':
            result = await window.filesAPI.downloadFile(args.filename as string, args.content as string);
            break;
          case 'showInFinder':
            result = await window.filesAPI.showInFinder(args.path as string);
            break;
          case 'selectDirectory':
            result = await window.filesAPI.selectDirectory();
            break;
          case 'readDirectory':
            result = await window.filesAPI.readDirectory(args.path);
            break;
          case 'executeCommand':
            result = await window.containerAPI.execLogged(
              [args.command as string, ...(args.args as string[])],
              { source: 'iframe', appDirName: dirName },
            );
            break;
          case 'connectKernel':
            await connect(args.kernelName as string);
            result = { ok: true };
            break;
          case 'jobs:listForApp': {
            // A tool can outlive its own UI, so let it ask what ran while it
            // was closed and recover the results it never got to record.
            const all = await window.jobsAPI.list();
            result = all.filter((j) => j.dirName === dirName);
            break;
          }
          case 'api:request': {
            // The tool's identity comes from the viewer, which owns this
            // iframe and validated `event.source` above — never from the
            // message. Main re-reads the grant from the manifest, so a lie
            // here still cannot invent access.
            const { apiId, method, path: apiPath, headers, body } = args as {
              apiId: string; method?: string; path?: string;
              headers?: Record<string, string>; body?: string;
            };
            result = await window.apisAPI.request(dirName, { apiId, method, path: apiPath, headers, body });
            break;
          }
          case 'mcp:listServers':
            result = await window.miniAppMcpAPI.list();
            break;
          case 'mcp:callTool': {
            const { serverName, toolName, args: callArgs } = args as { serverName: string; toolName: string; args: unknown };
            result = await window.miniAppMcpAPI.callTool(serverName, toolName, callArgs);
            break;
          }
          case 'executeCode': {
            const outputs: CellOutput[] = [];
            await executeCode(args.code as string, (output) => outputs.push(output));
            result = outputs;
            break;
          }
          case 'requestFix': {
            const prompt = buildFixPrompt(dirName, args.error as RequestFixError);
            composerRuntime.setText(prompt);
            composerRuntime.send();
            result = { ok: true };
            break;
          }
          case 'setComposerText': {
            composerRuntime.setText(args.text as string);
            result = { ok: true };
            break;
          }
          case 'openExternal': {
            await (window as any).electronAPI.invoke('shell:openExternal', args.url as string);
            result = { ok: true };
            break;
          }
          case 'academia:fetch': {
            result = await (window as any).academiaAPI.fetch(args.method, args.endpoint, args.data);
            break;
          }
          case 'anthropic:complete': {
            result = await (window as any).anthropicAPI.complete(args);
            break;
          }
          case 'anthropic:stream': {
            // streamKey is generated here (in the trusted renderer) rather than
            // using the iframe's request id. This ensures no iframe-controlled
            // string is used as an IPC routing key or channel name in the main
            // process. The iframe's original `id` is used only to route the
            // postMessage responses back to the correct pending promise.
            const streamKey = crypto.randomUUID();
            // A stream outlives this handler, so its activity episode closes
            // on done/error rather than in the finally below.
            const finishStream = () => { endActivity?.(); endActivity = null; };
            (window as any).anthropicAPI.stream(
              streamKey,
              args,
              (text: string) =>
                iframe.contentWindow?.postMessage({ type: 'anthropic:chunk', requestId: id, text }, '*'),
              (message: unknown) => {
                finishStream();
                iframe.contentWindow?.postMessage({ type: 'anthropic:done', requestId: id, message }, '*');
              },
              (err: string) => {
                finishStream();
                iframe.contentWindow?.postMessage({ type: 'anthropic:error', requestId: id, error: err }, '*');
              },
            );
            // skipResponse is set AFTER setup so that if anthropicAPI.stream()
            // throws synchronously, the outer catch can send the error back to
            // the iframe rather than leaving its promise hanging forever. The
            // same ordering means a synchronous throw still closes the episode
            // in the finally, since activityEndsAsync is not yet set.
            activityEndsAsync = true;
            skipResponse = true;
            break;
          }
          default:
            error = `Unknown bridge message type: ${type}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        if (!activityEndsAsync) endActivity?.();
      }

      if (!skipResponse) {
        iframe.contentWindow?.postMessage(
          { type: 'response', id, result, error },
          '*',
        );
      }
    },
    [connect, executeCode, composerRuntime, dirName, preBuilt, appName, handleEditMessage],
  );

  useEffect(() => {
    window.addEventListener('message', handleBridgeMessage);
    return () => window.removeEventListener('message', handleBridgeMessage);
  }, [handleBridgeMessage]);

  // The quote has been taken. A host-document button cannot drop a selection
  // living in the frame's document, so clearing has to travel back in.
  useEffect(() => {
    const clear = () => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'clearQuoteSelection' }, '*');
    };
    window.addEventListener('cd:clear-frame-selection', clear);
    return () => window.removeEventListener('cd:clear-frame-selection', clear);
  }, []);

  // A frame selection outlives the viewer being unmounted otherwise: the
  // toolbar lives in the host's body and would be left pointing at a tool that
  // is no longer on screen.
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('cd:frame-selection', { detail: null }));
  }, []);

  const iframeSrc = nativeToolUrl || `local-file://${encodeURI(appDir)}/src/index.html`;

  if (loadError) {
    return (
      <div style={{ padding: 24, color: '#888' }}>
        <p>This tool's page couldn't be opened. Try Rebuild, or ask me to fix it.</p>
        <details style={{ fontSize: 13, marginTop: 8 }}>
          <summary>Details</summary>
          Expected: <code>{nativeToolUrl || `${appDir}/src/index.html`}</code>
        </details>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      className="miniAppIframe"
      sandbox="allow-scripts allow-same-origin allow-downloads"
      onLoad={handleIframeLoad}
      onError={() => {
        console.error('[MiniAppContent] Iframe error for:', dirName);
        setLoadError(true);
      }}
    />
  );
});

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

const SOURCE_TREE_SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git']);

async function loadAppTree(dirPath: string): Promise<TreeNode[]> {
  const entries = await window.filesAPI.readDirectory(dirPath);
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    if (e.isDirectory) {
      if (SOURCE_TREE_SKIP_DIRS.has(e.name)) continue;
      const children = await loadAppTree(e.path).catch(() => []);
      nodes.push({ name: e.name, path: e.path, isDirectory: true, children });
    } else {
      nodes.push({ name: e.name, path: e.path, isDirectory: false });
    }
  }
  return nodes;
}

function collectAllDirPaths(nodes: TreeNode[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.isDirectory) {
      out.add(n.path);
      if (n.children) collectAllDirPaths(n.children, out);
    }
  }
  return out;
}

const SourceViewer: FC<{
  appDir: string;
  dirName: string;
  rebuildState: RebuildState;
}> = ({ appDir, rebuildState }) => {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load the full app directory tree once
  useEffect(() => {
    let stale = false;
    setTreeLoaded(false);
    loadAppTree(appDir).then((nodes) => {
      if (stale) return;
      setTree(nodes);
      setExpanded(collectAllDirPaths(nodes));
      setTreeLoaded(true);
      setActivePath((current) => current ?? `${appDir}/src/App.tsx`);
    }).catch(() => {
      if (stale) return;
      setTree([]);
      setTreeLoaded(true);
    });
    return () => { stale = true; };
  }, [appDir]);

  const isNotebook = activePath?.endsWith('.ipynb') ?? false;

  // Load content for the active file (skip for notebooks — NotebookViewer handles them)
  useEffect(() => {
    if (!activePath || isNotebook) {
      setContent(null);
      return;
    }
    let stale = false;
    setLoading(true);
    setContent(null);

    window.filesAPI.readFile(activePath).then((res) => {
      if (stale) return;
      if ('error' in res) {
        setContent('File too large to display.');
      } else if ('content' in res) {
        setContent(res.content);
      } else {
        setContent('(binary file)');
      }
      setLoading(false);
    }).catch(() => {
      if (stale) return;
      setContent('Could not read file.');
      setLoading(false);
    });

    return () => { stale = true; };
  }, [activePath, isNotebook]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const activeFileName = useMemo(() => activePath?.split('/').pop() ?? null, [activePath]);
  const activeLanguage = useMemo(() => (activePath ? languageForPath(activePath) : null), [activePath]);

  return (
    <div className="sourceViewer">
      {rebuildState.kind === 'error' && (
        <div className="sourceViewerRebuildError">
          <div className="sourceViewerRebuildErrorTitle">This tool couldn't be built</div>
          <pre className="sourceViewerRebuildErrorMessage">{rebuildState.message}</pre>
        </div>
      )}
      <div className="sourceViewerSplit">
        <div className="sourceViewerTree">
          {!treeLoaded ? (
            <div className="sourceViewerTreeMessage">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="sourceViewerTreeMessage">Empty directory.</div>
          ) : (
            <SourceTree
              nodes={tree}
              depth={0}
              expanded={expanded}
              activePath={activePath}
              onToggle={toggleDir}
              onSelect={setActivePath}
            />
          )}
        </div>
        <div className="sourceViewerPane">
          {!activePath ? (
            <div className="sourceViewerMessage">Select a file to view its contents.</div>
          ) : isNotebook ? (
            <NotebookViewer filePath={activePath} />
          ) : (
            <>
              <div className="sourceViewerPaneHeader">{activeFileName}</div>
              <div className="sourceViewerContent">
                {loading ? (
                  <p className="sourceViewerMessage">Loading...</p>
                ) : (
                  <CodeView
                    content={content ?? ''}
                    language={activeLanguage}
                    fallbackClassName="sourceViewerPre"
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const SourceTree: FC<{
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}> = ({ nodes, depth, expanded, activePath, onToggle, onSelect }) => (
  <>
    {nodes.map((node) => (
      <SourceTreeNode
        key={node.path}
        node={node}
        depth={depth}
        expanded={expanded}
        activePath={activePath}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    ))}
  </>
);

const SourceTreeNode: FC<{
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}> = ({ node, depth, expanded, activePath, onToggle, onSelect }) => {
  const paddingLeft = 8 + depth * 12;
  if (node.isDirectory) {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <button
          className="sourceViewerTreeRow sourceViewerTreeRow--dir"
          style={{ paddingLeft }}
          onClick={() => onToggle(node.path)}
        >
          {isOpen ? (
            <ChevronDownIcon className="sourceViewerTreeChevron" />
          ) : (
            <ChevronRightIcon className="sourceViewerTreeChevron" />
          )}
          {isOpen ? (
            <FolderOpenIcon className="sourceViewerTreeIcon" />
          ) : (
            <FolderIcon className="sourceViewerTreeIcon" />
          )}
          <span className="sourceViewerTreeLabel">{node.name}</span>
        </button>
        {isOpen && node.children && (
          <SourceTree
            nodes={node.children}
            depth={depth + 1}
            expanded={expanded}
            activePath={activePath}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        )}
      </>
    );
  }
  const isActive = activePath === node.path;
  return (
    <button
      className={`sourceViewerTreeRow${isActive ? ' sourceViewerTreeRow--active' : ''}`}
      style={{ paddingLeft }}
      onClick={() => onSelect(node.path)}
    >
      <span className="sourceViewerTreeChevron" />
      <FileIcon className="sourceViewerTreeIcon" />
      <span className="sourceViewerTreeLabel">{node.name}</span>
    </button>
  );
};

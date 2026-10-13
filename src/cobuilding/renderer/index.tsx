import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { FOCUS_CHAT_SEARCH_EVENT } from './chatSearchFocus';
import { createRoot } from 'react-dom/client';
import {
  useLocalRuntime,
  useRemoteThreadListRuntime,
  AssistantRuntimeProvider,
  useThreadList,
  useAssistantToolUI,
  useAssistantRuntime,
  useAuiState,
} from '@assistant-ui/react';
import { TooltipProvider } from './components/ui/tooltip';
import { Thread } from './components/assistant-ui/thread';
import { ThreadList } from './components/assistant-ui/thread-list';
import { FilesTab } from './components/FilesTab';
import { DebugSidebar, DebugContent, type DebugSection } from './components/debug/DebugPanel';
import { FileViewer } from './components/FileViewer';
import { CopyFileButton } from './components/fileViewers/CopyFileButton';
import { MiniAppViewer } from './components/MiniAppViewer';
import { MiniAppsTab } from './components/MiniAppsTab';
import { ToolsPage } from './components/ToolsPage';
import { PaperMonitorView } from './components/PaperMonitorView';
import { ChromeBar } from './components/command-desk/ChromeBar';
import { Rail, type RailTab } from './components/command-desk/Rail';
import { StatusBar } from './components/command-desk/StatusBar';
import { CommandDesk } from './components/command-desk/CommandDesk';
import { ActivityPanel } from './components/command-desk/ActivityPanel';
import { KnowledgePage } from './components/knowledge/KnowledgePage';
import { ServersPage } from './components/servers/ServersPage';
import { useHomeData } from './components/command-desk/useHomeData';
import { railToolLists } from './components/command-desk/railTools';
import { findShortcutAction } from './components/command-desk/findShortcut';
import { resolveWorkspacePath } from './utils/resolveWorkspacePath';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useElectronChatAdapter } from './chatAdapter';
import { sessionListAdapter } from './sessionListAdapter';
import { useThreadHistoryAdapter } from './threadHistoryAdapter';
import { createAttachmentAdapter } from './attachmentAdapter';
import { installScreenshotGrab } from './screenshotGrab';
import { createHostDictationAdapter } from './hostDictationAdapter';
import { useSessionSubscription } from './useSessionSubscription';
import { reloadThreadHistory } from './reloadThreadHistory';
import DirectoryPermissions from './components/DirectoryPermissions';
import { ChatHeader } from './components/command-desk/ChatHeader';
import { ToolWorkspace } from './components/command-desk/ToolWorkspace';
import { ChatViewingReporter } from './components/command-desk/ChatViewingReporter';
import { ToolFallback } from './components/assistant-ui/tool-fallback';
import { OPEN_CHAT_EVENT } from './components/assistant-ui/chat-link-chip';
import { SetupBanner } from './components/SetupBanner';
import { GlobalComposer } from './components/GlobalComposer';
import { QuoteToolbar } from './components/command-desk/QuoteToolbar';
import { useTabs } from './tabs/useTabs';
import type { TabDescriptor } from './tabs/types';
import { kernelRegistry } from './components/notebook/kernelRegistry';
import { applyHostJobs, applyBuildHealth } from './toolStatusStore';
import { applyHostedServers, applyConnectorConfigs, applyConnectorStatus, applyMiniAppServers } from './mcpServerStore';
import type { Workspace, WorkspaceDirectory } from '../shared/types';
import { trackEvent } from './utils/fullstory';
import { initSentryRenderer } from './sentry';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initAnalytics as initCoScientistAnalytics } from './coscientistAnalytics';
import './App.css';
import './commandDesk.css';
import './phaseB.css';

// Initialize Sentry before any other code runs so unhandled errors during
// React tree construction are captured. No-op when SENTRY_DSN is empty.
initSentryRenderer();

// Bootstrap CoScientist analytics — fetches telemetry context from main
// and subscribes to auth-state changes. Fire-and-forget; track() calls
// before init resolves are no-ops, which is correct (we're pre-login anyway).
initCoScientistAnalytics();
// Main calls this for screenshots taken outside Acabox (see screenshotGrab.ts).
installScreenshotGrab();

/** Listens for notification:navigate IPC and navigates to the specified target. */
type SidebarTab = 'home' | 'tools' | 'knowledge' | 'servers' | 'files' | 'chats' | 'activity' | 'debug' | 'settings';

function NotificationNavigator({
  setSidebarTab,
  setChatViewMode,
  setToolsViewMode,
  deactivateAllTabs,
}: {
  setSidebarTab: (tab: SidebarTab) => void;
  setChatViewMode: (mode: 'list' | 'detail') => void;
  setToolsViewMode: (mode: 'listing' | 'detail' | 'paper-monitor') => void;
  deactivateAllTabs: () => void;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    const handler = async (_event: unknown, navigation: { type: string; threadId?: string; tab?: SidebarTab; sidebarTab?: SidebarTab }) => {
      if (navigation.type === 'thread' && navigation.threadId) {
        const session = await window.sessionsAPI.get(navigation.threadId);
        setSidebarTab(navigation.sidebarTab ?? 'chats');
        setChatViewMode('detail');
        deactivateAllTabs();
        try {
          runtime.threads.switchToThread(navigation.threadId);
        } catch (err) {
          console.error('[NotificationNav] switchToThread error:', err);
        }
      } else if (navigation.type === 'sidebar' && navigation.tab) {
        setSidebarTab(navigation.tab);
      }
    };
    window.electronAPI.on('notification:navigate', handler);
    return () => window.electronAPI.removeListener('notification:navigate', handler);
  }, [runtime, setSidebarTab, setChatViewMode, setToolsViewMode, deactivateAllTabs]);

  return null;
}

/** Listens for navigate-to-page IPC (from Word overlay) and shows the chat view. */
function OverlayNavigationHandler({
  setSidebarTab,
  setChatViewMode,
  deactivateAllTabs,
}: {
  setSidebarTab: (tab: SidebarTab) => void;
  setChatViewMode: (mode: 'list' | 'detail') => void;
  deactivateAllTabs: () => void;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    const handler = (_event: unknown, payload: { page: string; projectId?: number; conversationId?: number; sessionId?: string }) => {
      console.log('[OverlayNav] Received navigate-to-page:', JSON.stringify(payload));
      setSidebarTab('chats');
      setChatViewMode('detail');
      deactivateAllTabs();
      if (payload.sessionId) {
        try {
          runtime.threads.switchToThread(payload.sessionId);
        } catch (err) {
          console.error('[OverlayNav] Failed to switch to session:', err);
        }
      }
    };
    window.electronAPI.on('navigate-to-page', handler);
    return () => window.electronAPI.removeListener('navigate-to-page', handler);
  }, [runtime, setSidebarTab, setChatViewMode, deactivateAllTabs]);

  return null;
}

/** Subscribes to running agent sessions when a thread is opened. */
function SessionSubscriber() {
  useSessionSubscription();
  return null;
}

/** Esc stops the active generation — same as the composer's stop button. */
function EscStopsRun() {
  const runtime = useAssistantRuntime();
  const isRunningRef = useRef(false);
  isRunningRef.current = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isRunningRef.current) return;
      try {
        runtime.thread.cancelRun();
      } catch {
        // No active run — nothing to stop.
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [runtime]);

  return null;
}

/** Listen for auto-generated session titles from the main process and update the thread list. */
function SessionTitleUpdater() {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    return window.sessionsAPI.onTitleUpdated((sessionId, title) => {
      try {
        const item = runtime.threads.getItemById(sessionId);
        item.rename(title);
      } catch {
        // Thread not in list yet — title will appear on next list refresh
      }
    });
  }, [runtime]);

  return null;
}


/**
 * Refresh the thread list when main broadcasts `sessions:changed`
 * (e.g. overlay creates a chat or sends a message that re-sorts).
 *
 * assistant-ui's RemoteThreadListAdapter caches its `list()` result in
 * a private `_loadThreadsPromise` and exposes no public refresh API.
 * We clear that cache and re-trigger the internal load so new/renamed
 * threads merge in and `threadIds` re-sorts — without remounting the
 * runtime or interrupting an active conversation.
 */
function SessionsListRefresher() {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      const core: any = (runtime as any)?._core?.threads;
      if (!core) return;
      core._loadThreadsPromise = null;
      core.__internal_load?.();
    };
    const unsubscribe = window.sessionsAPI.onSessionsChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [runtime]);

  return null;
}

/**
 * Symmetric counterpart to the overlay's `ForeignTurnWatcher`: when a turn
 * completes for the active desktop chat in a *different* surface (e.g.
 * the user typed and sent from the Word overlay), the IPC `chat:event`
 * forwarding only delivers the assistant's streamed reply — the
 * overlay-typed user message is never streamed, only persisted to the
 * SQLite messages table by `agentSession.sendMessage`. So the desktop
 * displays the assistant bubble but no user bubble preceding it; even
 * leaving the conversation and reopening doesn't help because the
 * runtime's per-thread history is cached.
 *
 * We hack the same internal cache the SessionsListRefresher already uses
 * (private `_loadThreadsPromise` / `__internal_load`) for the active
 * thread, plus a `switchToThread(id)` poke so the runtime re-reads its
 * per-thread state. Suppressed when our own thread is currently running
 * (the in-flight desktop send is already populating the runtime in
 * real time, no remount needed).
 */
function ForeignTurnWatcherDesktop() {
  const runtime = useAssistantRuntime();
  // The active thread's REMOTE id (DB session UUID) is the right
  // identifier to compare against the foreign sessionId. assistant-ui's
  // `mainThreadId` is its internal thread ID — for fresh threads that
  // haven't been claimed by a remote yet, it looks like
  // `__LOCALID_xxx` and never equals the server's session UUID. Logs
  // confirmed this is why every "first message from a new overlay
  // session" was hitting gate=mismatch on the desktop.
  const activeRemoteIdRef = useRef<string | undefined>(undefined);
  const isRunningRef = useRef(false);

  const activeRemoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  activeRemoteIdRef.current = activeRemoteId;
  const isRunning = useAuiState((s: any) => s.thread?.isRunning ?? false);
  isRunningRef.current = isRunning;

  useEffect(() => {
    const unsubscribe = window.sessionsAPI.onForeignTurnDone((sessionId: string) => {
      const activeId = activeRemoteIdRef.current;
      const running = isRunningRef.current;
      window.debugAPI.log(`[ForeignTurnWatcher] received sessionId=${sessionId} activeRemoteId=${activeId ?? 'null'} isRunning=${running}`);
      if (sessionId !== activeId) {
        window.debugAPI.log('[ForeignTurnWatcher] gate=mismatch — returning');
        return;
      }
      if (running) {
        window.debugAPI.log('[ForeignTurnWatcher] gate=running — returning');
        return;
      }
      window.debugAPI.log('[ForeignTurnWatcher] gate=proceed');
      // The previous implementation here targeted `__internal_loadHistory` /
      // `_loadHistoryPromise`, which don't exist on this assistant-ui
      // version — the real internals are `__internal_load` /
      // `_loadPromise`, used by `reloadThreadHistory`.
      void reloadThreadHistory(runtime, sessionId);
    });
    return unsubscribe;
  }, [runtime]);

  return null;
}

/**
 * Reloads the active thread's history from SQLite when entering chat detail
 * or switching threads. Skips when a turn is in flight — `import` resets the
 * message tree, which orphans the in-flight assistant message and silences
 * `ProcessingIndicator`.
 *
 * Two signals together: `thread.isRunning` covers the just-sent window
 * before the agent loop has flipped `turnState.turnInProgress`;
 * `isTurnInProgress` covers reattach after the local run has ended but
 * the server-side turn continues. Both checked so each window is caught.
 */
function RefreshOnEnterChatDetail({ isInChatDetail }: { isInChatDetail: boolean }) {
  const runtime = useAssistantRuntime();
  const activeRemoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  const isRunningRef = useRef(false);
  isRunningRef.current = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;

  useEffect(() => {
    if (!isInChatDetail || !activeRemoteId) return;
    let cancelled = false;
    void (async () => {
      if (isRunningRef.current) return;
      const inProgress = await window.chatAPI.isTurnInProgress(activeRemoteId);
      if (cancelled || isRunningRef.current || inProgress) return;
      void reloadThreadHistory(runtime, activeRemoteId);
    })();
    return () => { cancelled = true; };
  }, [isInChatDetail, activeRemoteId, runtime]);

  return null;
}

/**
 * Catches every turn-complete (fired as a window event by preload's
 * chat:event handler) and pulls SQLite if the renderer isn't already
 * driving a local run.
 *
 * Belt-and-braces: `useSessionSubscription`'s driving-path post-turn reload
 * covers the case where the subscription itself fed the run, but doesn't
 * help when chatAdapter was the driver (its run already ended) and an
 * out-of-band sync is still needed — e.g. a foreign turn slipped in
 * between turns and we want SQLite to be the visible truth. Gating on
 * `thread.isRunning` skips the local-driver case where the in-memory
 * state is already current and a reload would just move messages into
 * an orphan branch.
 */
function RefreshOnTurnEnd({ isInChatDetail }: { isInChatDetail: boolean }) {
  const runtime = useAssistantRuntime();
  const activeRemoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  const isRunningRef = useRef(false);
  isRunningRef.current = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;

  useEffect(() => {
    if (!isInChatDetail || !activeRemoteId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { threadId?: string } | undefined;
      if (detail?.threadId !== activeRemoteId) return;
      if (isRunningRef.current) return;
      void reloadThreadHistory(runtime, activeRemoteId);
    };
    window.addEventListener('chat:turn-end', handler);
    return () => window.removeEventListener('chat:turn-end', handler);
  }, [isInChatDetail, activeRemoteId, runtime]);

  return null;
}

/** When the user picks a different thread, deactivate tabs so chat is shown.
 *  Suppressed when the switch is app-initiated (e.g. opening a miniapp tab). */
function ShowChatOnThreadSelect({ onShowChat, suppressRef }: { onShowChat: () => void; suppressRef: React.RefObject<boolean> }) {
  const mainThreadId = useThreadList((s) => s.mainThreadId);
  const prevRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (mainThreadId == null) return;
    const prev = prevRef.current;
    if (prev !== undefined && prev !== mainThreadId) {
      if (suppressRef.current) {
        console.debug('[ShowChatOnThreadSelect] Thread changed (suppressed):', prev, '->', mainThreadId);
        suppressRef.current = false;
      } else {
        console.debug('[ShowChatOnThreadSelect] Thread changed:', prev, '->', mainThreadId, '— deactivating tabs');
        onShowChat();
      }
    }
    prevRef.current = mainThreadId;
  }, [mainThreadId, onShowChat, suppressRef]);

  return null;
}

/**
 * Ensures the GlobalComposer always targets a fresh thread by switching to
 * a new thread whenever the user transitions *into* a state where the
 * GlobalComposer is visible and they're not viewing a specific chat.
 *
 * Watching only the chat-detail edge wasn't enough: other components
 * (`AppSessionSwitcher`, notification navigation) call
 * `switchToThread(existingId)` from views where the GlobalComposer is
 * hidden, leaving `mainThreadId` pinned to that session. When the user
 * navigates from one of those views back to home / files / chats-list,
 * `mainThreadId` is still the existing session and the next GlobalComposer
 * send routes there. Triggering on `(globalComposerVisible && !isInChatDetail)`
 * catches every such transition; views that legitimately pin a thread
 * (miniapp, paper-monitor) all hide the GlobalComposer, so the
 * reset only fires when the user actually surfaces it again.
 */
function ResetThreadWhenComposerVisible({
  globalComposerVisible,
  isInChatDetail,
  suppressRef,
  suppressResetRef,
}: {
  globalComposerVisible: boolean;
  isInChatDetail: boolean;
  suppressRef: React.MutableRefObject<boolean>;
  suppressResetRef: React.MutableRefObject<boolean>;
}) {
  const runtime = useAssistantRuntime();
  const shouldHaveFreshThread = globalComposerVisible && !isInChatDetail;
  const prevRef = useRef(shouldHaveFreshThread);

  useEffect(() => {
    if (!prevRef.current && shouldHaveFreshThread) {
      if (suppressResetRef.current) {
        suppressResetRef.current = false;
      } else {
        suppressRef.current = true;
        runtime.switchToNewThread();
      }
    }
    prevRef.current = shouldHaveFreshThread;
  }, [shouldHaveFreshThread, runtime, suppressRef, suppressResetRef]);

  return null;
}

/** When a miniapp tab becomes active, switch to its associated chat session. */
function AppSessionSwitcher({
  activeDirName,
  cacheRef,
  suppressRef,
}: {
  activeDirName: string | null;
  cacheRef: React.RefObject<Map<string, string>>;
  suppressRef: React.MutableRefObject<boolean>;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    if (!activeDirName) return;

    const cached = cacheRef.current.get(activeDirName);
    if (cached) {
      suppressRef.current = true;
      try {
        runtime.threads.switchToThread(cached);
      } catch {
        // Session may have been deleted — clear cache and retry via IPC
        cacheRef.current.delete(activeDirName);
      }
      return;
    }

    // Look up (or create) the session via main process
    let cancelled = false;
    window.sessionsAPI.findForApp(activeDirName).then((sessionId) => {
      if (cancelled || !sessionId) return;
      cacheRef.current.set(activeDirName, sessionId);
      suppressRef.current = true;
      try {
        runtime.threads.switchToThread(sessionId);
      } catch (err) {
        console.error('[AppSessionSwitcher] Failed to switch thread:', err);
      }
    });

    return () => { cancelled = true; };
  }, [activeDirName, runtime, cacheRef, suppressRef]);

  return null;
}

function OpenMiniAppToolUI({
  args,
  status,
  onOpen,
}: {
  args: { dir_name?: string };
  status: { type: string };
  onOpen: (dirName: string, opts?: { forceReload?: boolean }) => void;
}) {
  const openedRef = useRef<string | null>(null);

  useEffect(() => {
    const dirName = args?.dir_name;
    // Only open for tool calls that are actively running — not completed history
    if (dirName && status.type === 'running' && dirName !== openedRef.current) {
      openedRef.current = dirName;
      onOpen(dirName, { forceReload: true });
    }
  }, [args?.dir_name, status.type, onOpen]);

  return null;
}

/**
 * Variant for `build_and_open_mini_application`: the host runs esbuild during
 * the tool call, so we must NOT open/switch to the tool until the build has
 * succeeded — otherwise the user lands on the pre-build (stale) view. Fires
 * onOpen only on a successful complete transition.
 *
 * `isError` is load-bearing, not belt-and-braces: a FAILED build does not
 * arrive as `incomplete`. assistant-ui's toMessagePartStatus marks any
 * tool-call part with a truthy result as complete and never inspects isError,
 * and the host's fail() always returns non-empty content — so without this
 * check a failed build passes the guard below and opens the tool onto exactly
 * the stale bundle this component exists to avoid.
 *
 * No `forceReload` here: a successful build now also broadcasts
 * `miniApps:built` (main/index.ts) to every window, which bumps the reload
 * nonce for an already-open tab regardless of which chat is on screen (T4,
 * 2026-09-18) — `handleSelectApp` still bumps it itself when the tab isn't
 * open yet. Passing forceReload too would just double-bump the nonce here.
 */
function BuildAndOpenMiniAppToolUI({
  args,
  status,
  isError,
  onOpen,
}: {
  args: { dir_name?: string };
  status: { type: string };
  isError?: boolean;
  onOpen: (dirName: string, opts?: { forceReload?: boolean }) => void;
}) {
  const openedRef = useRef<string | null>(null);
  // Guards against opening when loading historical chat messages that mount
  // already at status === 'complete' (we never observe a 'running' transition).
  const sawRunningRef = useRef(false);

  useEffect(() => {
    if (status.type === 'running') {
      sawRunningRef.current = true;
      return;
    }
    const dirName = args?.dir_name;
    if (
      dirName &&
      status.type === 'complete' &&
      !isError &&
      sawRunningRef.current &&
      dirName !== openedRef.current
    ) {
      openedRef.current = dirName;
      onOpen(dirName);
    }
  }, [args?.dir_name, status.type, isError, onOpen]);

  return null;
}

function OpenMiniAppHandler({ onOpen }: { onOpen: (dirName: string, opts?: { forceReload?: boolean }) => void }) {
  useAssistantToolUI({
    toolName: 'mcp__mini-apps__open_mini_application',
    render: (props: any) => (
      <>
        <OpenMiniAppToolUI args={props.args} status={props.status} onOpen={onOpen} />
        <ToolFallback {...props} />
      </>
    ),
  });
  useAssistantToolUI({
    toolName: 'mcp__mini-apps__build_and_open_mini_application',
    render: (props: any) => (
      <>
        <BuildAndOpenMiniAppToolUI args={props.args} status={props.status} isError={props.isError} onOpen={onOpen} />
        <ToolFallback {...props} />
      </>
    ),
  });

  return null;
}


/** File extensions that need full-width viewing (tables, PDFs). */
const WIDE_VIEWER_RE = /\.(csv|tsv|xlsx?|pdf)$/i;

function ChatView({ workspace, onWorkspaceUpdated }: { workspace: Workspace; onWorkspaceUpdated: (ws: Workspace) => void }) {
  useEffect(() => {
    trackEvent('Cobuilding Session');
  }, []);

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('home');
  const [chatViewMode, setChatViewMode] = useState<'list' | 'detail'>('list');
  const [toolsViewMode, setToolsViewMode] = useState<'listing' | 'detail' | 'paper-monitor'>('listing');
  const [toolChatOpen, setToolChatOpen] = useState(true);
  const [filesViewMode, setFilesViewMode] = useState<'listing' | 'detail'>('listing');
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  // The open file's text for the header's Copy button; null while loading or for files with none.
  const [activeFileText, setActiveFileText] = useState<string | null>(null);
  const [fileOpenedFrom, setFileOpenedFrom] = useState<'files' | 'chat'>('files');
  const [fileReturnThreadId, setFileReturnThreadId] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState(0);
  const [userDirectories, setUserDirectories] = useState<WorkspaceDirectory[]>([]);
  useEffect(() => {
    window.workspacesAPI.listDirectories().then(setUserDirectories).catch((err) => console.error('[ChatView] listDirectories failed:', err));
  }, [workspace.id]);
  const [debugSection, setDebugSection] = useState<DebugSection>(() => {
    const saved = localStorage.getItem('debug-section');
    return (saved as DebugSection) || 'apps';
  });

  const { tabs, activeTabId, openTab, closeTab, activateTab, deactivateAllTabs } = useTabs({
    onBeforeClose: (id) => {
      kernelRegistry.shutdown(id).catch(() => {});
    },
  });

  // Closing the last tool tab drops back to the Tools listing.
  const closeToolTab = useCallback((id: string) => {
    closeTab(id);
    const remaining = tabsRef.current.filter((t) => t.kind === 'miniapp' && t.id !== id);
    if (remaining.length === 0) setToolsViewMode('listing');
  }, [closeTab]);
  const [autoSelectFirstApp, setAutoSelectFirstApp] = useState(false);
  // Per-mini-app reload nonce — bumped each time the app is (re-)opened so the
  // iframe remounts and picks up a freshly built bundle. Without this, calling
  // open_mini_application on an already-open tab just activates it without
  // reloading the iframe contents.
  const [miniAppReloadNonces, setMiniAppReloadNonces] = useState<Record<string, number>>({});
  const [preBuiltApps, setPreBuiltApps] = useState<Set<string>>(new Set());

  // Latest tabs ref so handleSelectApp's identity doesn't change on every tab
  // mutation (it would otherwise re-render sidebar components on each close/open).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // A build's success reaches every window over IPC (main/index.ts), not just
  // whichever chat's tool-call card happens to be on screen — see
  // BuildAndOpenMiniAppToolUI's comment for the incident this fixes. If the
  // built tool already has a tab open, bump its reload nonce so the iframe
  // remounts onto the fresh bundle. Never opens a tab, switches sidebar tab,
  // or navigates — that stays chat-driven (open_mini_application / handleSelectApp).
  useEffect(() => {
    const unsubscribe = window.miniAppsAPI.onBuilt(({ dirName }) => {
      const tabId = `miniapp::${dirName}`;
      if (tabsRef.current.some((t) => t.id === tabId)) {
        setMiniAppReloadNonces((prev) => ({ ...prev, [dirName]: (prev[dirName] ?? 0) + 1 }));
      }
    });
    return unsubscribe;
  }, []);

  // Clear kernel registry when the workspace directory changes — the Jupyter
  // gateway container is restarted on workspace switch, so any cached kernels
  // are stale handles to a dead container.
  const prevWorkspacePathRef = useRef<string>(workspace.directory_path);
  useEffect(() => {
    if (prevWorkspacePathRef.current !== workspace.directory_path) {
      kernelRegistry.clearAll().catch(() => {});
      prevWorkspacePathRef.current = workspace.directory_path;
    }
  }, [workspace.directory_path]);


  // Held in a ref so the chatAdapter's onSend callback always reads the
  // latest setters without invalidating the adapter's memoized identity.
  const navigateToChatDetailRef = useRef<() => void>(() => {});

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => {
      const chatAdapter = useElectronChatAdapter(() => navigateToChatDetailRef.current());
      const history = useThreadHistoryAdapter();
      const attachments = useMemo(
        () => createAttachmentAdapter(workspace.directory_path),
        [workspace.directory_path]
      );
      // On-device dictation. Registering the adapter is also what enables
      // ComposerPrimitive.Dictate — without it the mic button disables itself,
      // which is the correct outcome where the helper isn't available.
      // Errors surface through DictationButton's own event subscription, so
      // this callback only needs to keep them out of the console silently.
      const dictation = useMemo(
        () => createHostDictationAdapter({ onError: (msg) => console.warn('[Dictation]', msg) }),
        []
      );
      return useLocalRuntime(chatAdapter, {
        adapters: { history, attachments, dictation },
      });
    },
    adapter: sessionListAdapter,
  });

  // Refresh on every render so we always close over the current state setters
  // and view flags. Cheap — assigning a function reference.
  //
  // Skip navigation when the user is already typing into a side-panel chat
  // (rendered as `<Thread />` inside one of the tools detail views). In those
  // modes the GlobalComposer is hidden, so the only composer available is the
  // side-panel one — and the chat the user is sending to is already on
  // screen. Switching tabs would close the miniapp/paper-monitor
  // view the user was looking at.
  navigateToChatDetailRef.current = () => {
    const inToolsSidePanel = sidebarTab === 'tools' && (
      (toolsViewMode === 'detail' && activeTab?.kind === 'miniapp') ||
      toolsViewMode === 'paper-monitor'
    );
    if (inToolsSidePanel) return;

    setSidebarTab('chats');
    setChatViewMode('detail');
    deactivateAllTabs();
  };

  const handleSelectFile = useCallback((filePath: string, from?: 'files' | 'chat') => {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if ((ext === 'docx' || ext === 'doc') && from !== 'chat') {
      const fileUrl = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
      window.fileMonitorAPI.openFile(fileUrl, 'com.microsoft.Word');
      window.fileMonitorAPI.setDockRightForDocument(filePath, true);
      return;
    }
    setSidebarTab('files');
    setActiveFilePath(filePath);
    setFileOpenedFrom(from ?? 'files');
    setFilesViewMode('detail');
  }, []);

  // Open file tabs from clickable paths in chat messages
  useEffect(() => {
    const handler = (e: CustomEvent<{ filePath: string; lineNumber?: number }>) => {
      const absolutePath = resolveWorkspacePath(e.detail.filePath, workspace.directory_path, workspace.user_directory_paths ?? []);
      // Capture the current thread ID so "Back to chat" can restore it
      const threadId = runtime.threads.getState().mainThreadId;
      setFileReturnThreadId(threadId ?? null);
      suppressThreadResetRef.current = true;
      handleSelectFile(absolutePath, 'chat');
    };
    window.addEventListener('open-file-tab', handler);
    return () => window.removeEventListener('open-file-tab', handler);
  }, [workspace.directory_path, workspace.user_directory_paths, handleSelectFile, runtime]);

  const handleSelectApp = useCallback((dirName: string, opts?: { forceReload?: boolean; preBuilt?: boolean }) => {
    console.debug('[handleSelectApp] Opening mini app tab:', dirName, opts);
    // Fire-and-forget: record this open in the app's manifest so the Tools page
    // can sort by recency. Failures are non-fatal and shouldn't block opening.
    window.miniAppsAPI.touch(dirName).catch(() => {});
    setSidebarTab('tools');
    setToolsViewMode('detail');
    const tabId = `miniapp::${dirName}`;
    // Only force an iframe reload when the tab doesn't already exist. Re-clicking
    // an already-open mini app should just activate it — remounting the viewer
    // would tear down its kernel connection bookkeeping and the iframe state.
    // However, when forceReload is set (e.g. agent tool call after a rebuild),
    // always bump the nonce so the iframe picks up the new bundle.
    const alreadyOpen = tabsRef.current.some((t) => t.id === tabId);
    if (!alreadyOpen || opts?.forceReload) {
      setMiniAppReloadNonces((prev) => ({ ...prev, [dirName]: (prev[dirName] ?? 0) + 1 }));
    }
    if (opts?.preBuilt) {
      setPreBuiltApps((prev) => new Set(prev).add(dirName));
    }
    const descriptor: TabDescriptor = {
      id: tabId,
      kind: 'miniapp',
      label: dirName,
      pinned: true, // mini apps are always pinned
      data: { kind: 'miniapp', dirName },
    };
    openTab(descriptor);
  }, [openTab]);

  const handleFilesClick = useCallback(() => {
    setSidebarTab('files');
    setFilesViewMode('listing');
    setActiveFilePath(null);
  }, []);

  const handleToolsClick = useCallback(() => {
    setSidebarTab('tools');
    setToolsViewMode('listing');
  }, []);

  // Live data for the Command Desk home + rail (sessions, mini-apps, drive).
  const { sessions, apps, driveFiles, refreshApps, refreshDrive } = useHomeData();

  // Archived tools only appear in the Tools page's "Archived" section — the
  // home grid, rail badge, and pinned list all show active tools only.
  const activeApps = useMemo(() => apps.filter((a) => !a.archived), [apps]);

  // Apps/drive have no change events from the host — refresh when the user
  // lands somewhere that displays them.
  useEffect(() => {
    if (sidebarTab === 'home') {
      refreshApps();
      refreshDrive();
    } else if (sidebarTab === 'tools') {
      refreshApps();
    }
  }, [sidebarTab, refreshApps, refreshDrive]);

  // The host owns every long-running thing a tool does, so the host's job list
  // — not any mounted component — decides what is working. Subscribing here,
  // at the app shell, means the status is correct on the home grid and the
  // rail, survives navigating away from a tool, and is already right on the
  // first paint after a restart (main reconciles the list before we render).
  useEffect(() => {
    let stale = false;
    window.jobsAPI.list()
      .then((jobs) => { if (!stale) applyHostJobs(jobs); })
      .catch((err) => console.error('[Jobs] initial list failed:', err));
    const unsubscribe = window.jobsAPI.onChanged((jobs) => {
      applyHostJobs(jobs);
      // A finished job means the manifest's lastRun just moved; refresh so the
      // card's "LAST RUN" is current. Main does the writing.
      refreshApps();
    });
    return () => { stale = true; unsubscribe(); };
  }, [refreshApps]);

  // Which tools currently fail to build. Kept at the shell for the same reason
  // as jobs: it must be true on the home grid with no viewer mounted.
  useEffect(() => {
    let stale = false;
    window.buildHealthAPI.list()
      .then((all) => { if (!stale) applyBuildHealth(all); })
      .catch((err) => console.error('[BuildHealth] initial list failed:', err));
    const unsubscribe = window.buildHealthAPI.onChanged(applyBuildHealth);
    return () => { stale = true; unsubscribe(); };
  }, []);

  // Servers page live status (docs/design/mcp-hosting.md, Increment 3 —
  // "Live status — pattern A, mandatory"). Same reasoning as the jobs/build
  // health effects just above: `sidebarTab === 'servers'` is a `display:none`
  // sibling that stays mounted forever, so fetching on ITS mount would be
  // correct once and wrong on every later push; and the rail badge + status
  // bar segment need this data with no Servers viewer ever having been open.
  // Three independent feeds, snapshot-then-subscribe, each feeding
  // `mcpServerStore`'s own `applyX` writer — never fetched or merged here.
  useEffect(() => {
    let stale = false;
    window.mcpServersAPI.list()
      .then((all) => { if (!stale) applyHostedServers(all); })
      .catch((err) => console.error('[McpServers] initial list failed:', err));
    const unsubscribe = window.mcpServersAPI.onChanged(applyHostedServers);
    return () => { stale = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    let stale = false;
    window.connectorsAPI.list()
      .then((data) => { if (!stale) applyConnectorConfigs(data.connectors); })
      .catch((err) => console.error('[McpServers] initial connector list failed:', err));
    window.connectorsAPI.getStatus()
      .then((status) => { if (!stale) applyConnectorStatus(status); })
      .catch((err) => console.error('[McpServers] initial connector status failed:', err));
    const unsubscribe = window.connectorsAPI.onStatusChanged(applyConnectorStatus);
    return () => { stale = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    let stale = false;
    window.miniAppMcpAPI.list()
      .then((servers) => { if (!stale) applyMiniAppServers(servers); })
      .catch((err) => console.error('[McpServers] initial mini-app server list failed:', err));
    const unsubscribe = window.miniAppMcpAPI.onChanged(applyMiniAppServers);
    return () => { stale = true; unsubscribe(); };
  }, []);

  // Main can kill a shell command itself, but kernel work only stops if the
  // renderer driving it interrupts the kernel. Handled at the shell so it works
  // whether or not the tool's viewer happens to be mounted.
  useEffect(() => {
    return window.jobsAPI.onCancelRequested((req) => {
      if (req.kind !== 'kernel') return;
      kernelRegistry.interrupt(`miniapp::${req.dirName}`).catch((err) => {
        console.error('[Jobs] kernel interrupt failed:', err);
      });
    });
  }, []);

  const handleChatsClick = useCallback(() => {
    setSidebarTab('chats');
    setChatViewMode('list');
    deactivateAllTabs();
  }, [deactivateAllTabs]);

  // ⌘K and the Home search box: show the chat list AND put the caret in its
  // search input. The focus is announced from an effect on the nonce, because
  // the Chats tab stays mounted behind display:none and can only take focus
  // once this render has made it visible.
  const [chatSearchFocusNonce, setChatSearchFocusNonce] = useState(0);
  const handleSearchChats = useCallback(() => {
    handleChatsClick();
    setChatSearchFocusNonce((n) => n + 1);
  }, [handleChatsClick]);
  useEffect(() => {
    if (chatSearchFocusNonce > 0) window.dispatchEvent(new Event(FOCUS_CHAT_SEARCH_EVENT));
  }, [chatSearchFocusNonce]);

  const openChatById = useCallback((sessionId: string) => {
    setSidebarTab('chats');
    setChatViewMode('detail');
    deactivateAllTabs();
    try {
      runtime.threads.switchToThread(sessionId);
    } catch (err) {
      console.error('[CommandDesk] switchToThread failed:', err);
    }
  }, [runtime, deactivateAllTabs]);

  // A chat-link chip (pasted into a message, or an agent reply naming a
  // chat) dispatches this on click rather than calling `openChatById`
  // directly — `chat-link-chip.tsx` deliberately imports nothing from
  // `@assistant-ui/react` so it can render under jest, which rules out
  // reaching this runtime-bound callback any other way.
  useEffect(() => {
    const handler = (e: Event) => {
      const sessionId = (e as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (sessionId) openChatById(sessionId);
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, handler);
  }, [openChatById]);

  const handleRailNavigate = useCallback((tab: RailTab) => {
    switch (tab) {
      case 'home':
        setSidebarTab('home');
        deactivateAllTabs();
        break;
      case 'chats':
        handleChatsClick();
        break;
      case 'tools':
        handleToolsClick();
        break;
      case 'knowledge':
        setSidebarTab('knowledge');
        deactivateAllTabs();
        break;
      case 'servers':
        setSidebarTab('servers');
        deactivateAllTabs();
        break;
      case 'files':
        handleFilesClick();
        break;
      case 'activity':
        setSidebarTab('activity');
        deactivateAllTabs();
        break;
      case 'debug':
        setSidebarTab('debug');
        break;
      case 'settings':
        setSidebarTab('settings');
        break;
    }
  }, [deactivateAllTabs, handleChatsClick, handleToolsClick, handleFilesClick]);

  // ⌘K — interim: routes to the chat list and focuses its search until a
  // real command palette exists.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = findShortcutAction(e);
      if (action) {
        e.preventDefault();
        if (action === 'open') void window.findAPI?.open();
        else window.findAPI?.next(action === 'next');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handleSearchChats();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSearchChats]);

  // Find results are a snapshot of the visible surface (Chromium does not
  // re-run a find when the DOM changes), so ask main to re-run the active
  // query whenever the visible tab changes.
  useEffect(() => {
    window.findAPI?.refresh();
  }, [sidebarTab, activeTabId]);

  // Suppress ShowChatOnThreadSelect when switching threads for a miniapp
  const suppressThreadDeactivateRef = useRef(false);

  // Suppress thread reset when opening a file from chat (so we can return to the same thread)
  const suppressThreadResetRef = useRef(false);

  // Which of a tool's chats its side panel is currently showing: dirName →
  // sessionId. Populated lazily from sessions:findForApp (most recently active)
  // and updated whenever the user picks a different chat from the switcher, so
  // the choice survives switching between tool tabs.
  const appSessionCacheRef = useRef<Map<string, string>>(new Map());

  /** Point a tool's side panel at one of its existing chats. */
  const handleSelectAppChat = useCallback((dirName: string, sessionId: string) => {
    appSessionCacheRef.current.set(dirName, sessionId);
    suppressThreadDeactivateRef.current = true;
    try {
      runtime.threads.switchToThread(sessionId);
    } catch (err) {
      console.error('[AppChat] switchToThread failed:', err);
    }
  }, [runtime]);

  /** Start a new chat for a tool (the host reuses an unused one if present). */
  const handleNewAppChat = useCallback((dirName: string) => {
    window.sessionsAPI.createForApp(dirName).then((sessionId) => {
      if (sessionId) handleSelectAppChat(dirName, sessionId);
    }).catch((err) => {
      console.error('[AppChat] createForApp failed:', err);
    });
  }, [handleSelectAppChat]);

  // Determine the active miniapp tab (for chat session switching)
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeMiniAppDirName = activeTab?.kind === 'miniapp' && activeTab.data.kind === 'miniapp' ? activeTab.data.dirName : null;

  // The rail's "Pinned tools" and "Recent tools" sections (railTools.ts).
  const railTools = useMemo(() => railToolLists(apps), [apps]);
  const pinnedDirNames = useMemo(() => new Set(railTools.pinned.map((t) => t.dirName)), [railTools]);

  // Every pin and unpin goes through here, whichever control it came from, so
  // the shell's app list (and with it the rail, the viewer's menu and the
  // Tools page) is re-read once the manifest is written.
  const handleSetToolPinned = useCallback(async (dirName: string, pinned: boolean) => {
    try {
      const result = await window.miniAppsAPI.setPinned(dirName, pinned);
      if (!result.ok) console.error(`[Rail] Could not ${pinned ? 'pin' : 'unpin'} ${dirName}:`, result.error);
    } catch (err) {
      console.error(`[Rail] Could not ${pinned ? 'pin' : 'unpin'} ${dirName}:`, err);
    }
    refreshApps();
  }, [refreshApps]);

  // The tool on screen, for the rail's highlight; null on any other page.
  const toolOnScreen =
    sidebarTab === 'tools' && toolsViewMode === 'detail' ? activeMiniAppDirName : null;

  const workspaceName = workspace.directory_path.split('/').filter(Boolean).pop() ?? 'workspace';

  const isInChatDetail = sidebarTab === 'chats' && chatViewMode === 'detail';
  // Views with their own side-panel composer hide the global composer; only
  // pages where the user could plausibly initiate a *new* conversation count.
  const globalComposerVisible =
    sidebarTab !== 'settings' &&
    sidebarTab !== 'debug' &&
    !(sidebarTab === 'tools' && toolsViewMode === 'detail' && activeTab?.kind === 'miniapp') &&
    !(sidebarTab === 'tools' && toolsViewMode === 'paper-monitor');

  // The selection toolbar is mounted wherever a quote has somewhere to land.
  // That is a WIDER set than `globalComposerVisible`: mini-app detail hides the
  // docked composer but the tool's own side-panel chat is right there, and the
  // thread composer holding the quote exists whether or not that panel happens
  // to be expanded — quoting expands it. Settings and Debug have no chat at
  // all, and a control that cannot do anything is worse than no control, so
  // there the toolbar simply never appears.
  const quoteToolbarEnabled =
    sidebarTab !== 'settings' &&
    sidebarTab !== 'debug' &&
    !(sidebarTab === 'tools' && toolsViewMode === 'paper-monitor');

  // Toggle a body class while dragging any panel divider so iframes/webviews
  // don't swallow the mousemove/mouseup events. CSS pairs this with
  // `pointer-events: none` on iframes during drag.
  const handleDragging = useCallback((isDragging: boolean) => {
    document.body.classList.toggle('cobuild-resizing', isDragging);
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionTitleUpdater />
      <SessionsListRefresher />
      <ForeignTurnWatcherDesktop />
      <SessionSubscriber />
      <EscStopsRun />
      <ShowChatOnThreadSelect onShowChat={() => { deactivateAllTabs(); setChatViewMode('detail'); }} suppressRef={suppressThreadDeactivateRef} />
      <AppSessionSwitcher activeDirName={activeMiniAppDirName} cacheRef={appSessionCacheRef} suppressRef={suppressThreadDeactivateRef} />
      <OpenMiniAppHandler onOpen={handleSelectApp} />
      <ResetThreadWhenComposerVisible globalComposerVisible={globalComposerVisible} isInChatDetail={isInChatDetail} suppressRef={suppressThreadDeactivateRef} suppressResetRef={suppressThreadResetRef} />
      <RefreshOnEnterChatDetail isInChatDetail={isInChatDetail} />
      <RefreshOnTurnEnd isInChatDetail={isInChatDetail} />
      <NotificationNavigator setSidebarTab={setSidebarTab} setChatViewMode={setChatViewMode} setToolsViewMode={setToolsViewMode} deactivateAllTabs={deactivateAllTabs} />
      <OverlayNavigationHandler setSidebarTab={setSidebarTab} setChatViewMode={setChatViewMode} deactivateAllTabs={deactivateAllTabs} />
      <TooltipProvider>
        <div className="appRoot">
          <ChromeBar />
          <SetupBanner />
          <div className="cdBody">
            <Rail
              activeTab={sidebarTab}
              chatCount={sessions.length}
              toolCount={activeApps.length}
              recents={sessions.slice(0, 5).map((s) => ({ id: s.id, title: s.title }))}
              pinned={railTools.pinned}
              recentTools={railTools.recent}
              activeToolDirName={toolOnScreen}
              onNavigate={handleRailNavigate}
              onOpenChat={openChatById}
              onOpenTool={handleSelectApp}
              onSetToolPinned={handleSetToolPinned}
            />
            <div className="cdMain">
          <div className="contentArea">
            {/* Home tab — Command Desk */}
            <div style={{ display: sidebarTab === 'home' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
              <CommandDesk
                sessions={sessions}
                apps={activeApps}
                driveFiles={driveFiles}
                workspaceName={workspaceName}
                onOpenChat={openChatById}
                onOpenTool={handleSelectApp}
                onNavigateChats={handleSearchChats}
                onNavigateTools={handleToolsClick}
                onNavigateFiles={handleFilesClick}
                onOpenFile={handleSelectFile}
              />
            </div>

            {/* Activity tab — the briefings feed (formerly the Home screen) */}
            <div style={{ display: sidebarTab === 'activity' ? 'flex' : 'none', flex: 1, overflow: 'auto' }}>
              <ActivityPanel
                apps={activeApps}
                onOpenTool={handleSelectApp}
                onSwitchToChat={() => {
                  setSidebarTab('chats');
                  setChatViewMode('detail');
                  deactivateAllTabs();
                }}
              />
            </div>

            {/* Knowledge tab — skills and memories, the two durable stores */}
            <div style={{ display: sidebarTab === 'knowledge' ? 'flex' : 'none', flex: 1, overflow: 'auto' }}>
              <KnowledgePage
                onSwitchToChat={() => {
                  setSidebarTab('chats');
                  setChatViewMode('detail');
                  deactivateAllTabs();
                }}
                onOpenChat={openChatById}
                onOpenSettings={() => setSidebarTab('settings')}
              />
            </div>

            {/* Servers tab — local MCP servers Acabox hosts on this machine */}
            <div style={{ display: sidebarTab === 'servers' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}>
              <ServersPage
                active={sidebarTab === 'servers'}
                onSwitchToChat={() => {
                  setSidebarTab('chats');
                  setChatViewMode('detail');
                  deactivateAllTabs();
                }}
                onOpenSettings={() => setSidebarTab('settings')}
                onOpenSchedule={() => setSidebarTab('activity')}
              />
            </div>

            {/* Tools tab */}
            <div style={{ display: sidebarTab === 'tools' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}>
              {toolsViewMode === 'detail' && activeTab?.kind === 'miniapp' ? (
                <ToolWorkspace
                  active={sidebarTab === 'tools'}
                  tabs={tabs}
                  activeTabId={activeTabId}
                  apps={apps}
                  workspacePath={workspace.directory_path}
                  miniAppReloadNonces={miniAppReloadNonces}
                  preBuiltApps={preBuiltApps}
                  onSelectTab={activateTab}
                  onCloseTab={closeToolTab}
                  onBack={() => setToolsViewMode('listing')}
                  onExpandChat={() => {
                    setSidebarTab('chats');
                    setChatViewMode('detail');
                  }}
                  onSelectAppChat={handleSelectAppChat}
                  onNewAppChat={handleNewAppChat}
                  onSetToolPinned={handleSetToolPinned}
                />
              ) : toolsViewMode === 'paper-monitor' ? (
                <div className="toolDetailContent">
                  {toolChatOpen ? (
                    <PanelGroup direction="horizontal" autoSaveId="cobuild.paperMonitorLayout" className="appPanelGroup">
                      <Panel id="paperMonitorMain" order={1} defaultSize={65} minSize={30}>
                        <div className="mainPanel">
                          <PaperMonitorView onBack={() => setToolsViewMode('listing')} />
                        </div>
                      </Panel>
                      <div className="panelBorder">
                        <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                        <button
                          className="panelCollapseBtn"
                          onClick={() => setToolChatOpen(false)}
                          title="Close chat panel"
                        />
                      </div>
                      <Panel id="paperMonitorChat" order={2} defaultSize={35} minSize={18} maxSize={50}>
                        <div className="chatSidePanel">
                          <Thread />
                        </div>
                      </Panel>
                    </PanelGroup>
                  ) : (
                    <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
                      <div className="mainPanel" style={{ flex: 1 }}>
                        <PaperMonitorView onBack={() => setToolsViewMode('listing')} />
                      </div>
                      <button
                        className="panelExpandBtn"
                        onClick={() => setToolChatOpen(true)}
                        title="Open chat panel"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <ToolsPage
                  workspacePath={workspace.directory_path}
                  onSelectApp={handleSelectApp}
                  onSwitchToChat={() => setSidebarTab('chats')}
                  onAppsChanged={refreshApps}
                  pinnedDirNames={pinnedDirNames}
                  onSetPinned={handleSetToolPinned}
                />
              )}
            </div>

            {/* Files tab */}
            <div style={{ display: sidebarTab === 'files' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}>
              {filesViewMode === 'detail' && activeFilePath ? (
                <>
                  <div className="detailHeader detailHeader--sticky">
                    <button
                      className="detailBackBtn"
                      onClick={() => {
                        if (fileOpenedFrom === 'chat' && fileReturnThreadId) {
                          suppressThreadDeactivateRef.current = true;
                          runtime.threads.switchToThread(fileReturnThreadId);
                          setSidebarTab('chats');
                          setChatViewMode('detail');
                        }
                        setFilesViewMode('listing');
                        setActiveFilePath(null);
                        setFileOpenedFrom('files');
                        setFileReturnThreadId(null);
                      }}
                    >
                      &larr; {fileOpenedFrom === 'chat' ? 'Back to chat' : 'Back to files'}
                    </button>
                    <span className="fileDetailFileName">{activeFilePath.split('/').pop() ?? activeFilePath}</span>
                    <span className="fileDetailSpacer" />
                    <CopyFileButton text={activeFileText} />
                  </div>
                  <div className={`fileDetailContent${WIDE_VIEWER_RE.test(activeFilePath) ? ' fileDetailContent--wide' : ''}`} style={{ flex: 1, minHeight: 0 }}>
                    <FileViewer filePath={activeFilePath} onCopyableText={setActiveFileText} />
                  </div>
                </>
              ) : (
                <div className="pageShell">
                  <div className="pageShell__inner">
                    <div className="pageShell__headerBlock">
                      <div className="pageShell__stats">{fileCount.toLocaleString()} FILES</div>
                      <h1 className="pageShell__title">Files</h1>
                    </div>
                    <div className="filesPage__explorerCard">
                      <FilesTab
                        workspacePath={workspace.directory_path}
                        userDirectories={userDirectories}
                        onSelectFile={handleSelectFile}
                        onFileCount={setFileCount}
                        onDirectoriesChanged={setUserDirectories}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Chats tab */}
            <div style={{ display: sidebarTab === 'chats' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}>
              {chatViewMode === 'detail' ? (
                <>
                  <ChatViewingReporter surface="chats" visible={sidebarTab === 'chats'} />
                  <ChatHeader
                    onBack={() => { setChatViewMode('list'); }}
                    onOpenTool={handleSelectApp}
                  />
                  <Thread variant="full" hideComposer />
                </>
              ) : (
                <ThreadList onSelectThread={() => setChatViewMode('detail')} />
              )}
            </div>

            {/* Debug tab — dev builds only (see Rail's SHOW_DEBUG) */}
            {window.authAPI?.isDev === true && (
            <div style={{ display: sidebarTab === 'debug' ? 'flex' : 'none', flex: 1 }}>
              <PanelGroup direction="horizontal" autoSaveId="cobuild.debugLayout" className="appPanelGroup">
                <Panel id="debugSidebar" order={1} defaultSize={18} minSize={12} maxSize={40}>
                  <div className="sidebarPanel">
                    <div className="sidebarContent">
                      <DebugSidebar activeSection={debugSection} onSelect={(s) => { setDebugSection(s); localStorage.setItem('debug-section', s); }} />
                    </div>
                  </div>
                </Panel>
                <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                <Panel id="debugMain" order={2} defaultSize={82} minSize={30}>
                  <div className="mainPanel">
                    <DebugContent activeSection={debugSection} />
                  </div>
                </Panel>
              </PanelGroup>
            </div>
            )}

            {/* Settings tab */}
            <div style={{ display: sidebarTab === 'settings' ? 'flex' : 'none', flex: 1 }}>
              <DirectoryPermissions
                active={sidebarTab === 'settings'}
                workspace={workspace}
                userDirectories={userDirectories}
                onClose={() => setSidebarTab('home')}
                onSaved={(ws) => {
                  onWorkspaceUpdated(ws);
                  setSidebarTab('home');
                }}
                onDirectoriesChanged={setUserDirectories}
                onOpenKnowledge={() => setSidebarTab('knowledge')}
                inline
              />
            </div>
          </div>
          {/* Global composer — shown on all pages except settings, debug, tool detail view */}
          {globalComposerVisible && <GlobalComposer />}
          <QuoteToolbar enabled={quoteToolbarEnabled} />
          <StatusBar />
            </div>
          </div>
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    // No onboarding: the main process guarantees an active workspace exists
    // (it creates a blank one at boot when needed), so this resolves on the
    // first try. A missing API key just degrades chat/scans with a
    // "add one in Settings" error — the app still boots.
    window.workspacesAPI
      .getActive()
      .then((ws) => {
        if (ws) setWorkspace(ws);
        else console.error('[App] No active workspace — main should have created one');
      })
      .catch((err) => console.error('[App] getActive failed:', err));
  }, []);

  if (!workspace) {
    // Momentary boot frame — one IPC round-trip. The window has no native
    // title bar (titleBarStyle: 'hiddenInset'), so keep the chrome bar as
    // the drag region.
    return (
      <div className="appRoot">
        <ChromeBar />
        <StatusBar />
      </div>
    );
  }

  return <ChatView workspace={workspace} onWorkspaceUpdated={setWorkspace} />;
}

// Wrap ResizeObserver callbacks in requestAnimationFrame so they never fire
// synchronously inside the browser's delivery loop. This is the canonical fix
// for "ResizeObserver loop completed with undelivered notifications" — the
// loop guard only trips when callbacks mutate layout during the same delivery
// cycle they were dispatched in, so deferring by one frame eliminates it.
const NativeResizeObserver = window.ResizeObserver;
if (NativeResizeObserver) {
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => {
          if (!Array.isArray(entries) || !entries.length) return;
          callback(entries, observer);
        });
      });
    }
  };
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

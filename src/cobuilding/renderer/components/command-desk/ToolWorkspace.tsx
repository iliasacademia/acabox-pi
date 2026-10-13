import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { DropdownMenu } from 'radix-ui';
import { MSymbol } from './MSymbol';
import { resolveToolIcon } from './toolIcon';
import { relTimeShort } from './format';
import { ModelSelector } from '../ModelSelector';
import { ChatMarkDot } from './ChatMarkDot';
import { ChatViewingReporter } from './ChatViewingReporter';
import { MiniAppViewer } from '../MiniAppViewer';
import { Thread } from '../assistant-ui/thread';
import { useToolStatuses } from '../../toolStatusStore';
import { toolStatusDotClass } from './toolStatusDisplay';
import { dateFromSessionStoredAt } from '../../sessionTimestamps';
import type { TabDescriptor } from '../../tabs/types';
import type { FC } from 'react';

/**
 * Tool viewer (Phase B): tab bar → per-tool viewer (header + iframe/install/
 * build-error) → optional chat side panel (the narrow thread variant) with a
 * drag divider and a collapsed 44px strip. Panel width is persisted per user;
 * open/collapsed state per tool.
 */

const PANEL_WIDTH_KEY = 'cd.toolPanel.width';
const PANEL_OPEN_KEY = 'cd.toolPanel.open';
const PANEL_MIN = 320;
const PANEL_MAX = 560;

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return 380;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, raw));
}

function loadPanelOpenMap(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_OPEN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}


export interface ToolWorkspaceProps {
  /** Whether the Tools tab is the one on screen. Every tab stays mounted, so this is not implied. */
  active: boolean;
  tabs: TabDescriptor[];
  activeTabId: string | null;
  apps: MiniAppEntry[];
  workspacePath: string;
  miniAppReloadNonces: Record<string, number>;
  preBuiltApps: Set<string>;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onBack: () => void;
  onExpandChat: () => void;
  /** Show an existing chat of this tool in the side panel. */
  onSelectAppChat: (dirName: string, sessionId: string) => void;
  /** Start (or reuse an unused) chat for this tool and show it. */
  onNewAppChat: (dirName: string) => void;
  /** Pin a tool to the rail, or unpin it. */
  onSetToolPinned: (dirName: string, pinned: boolean) => void;
}

export const ToolWorkspace: FC<ToolWorkspaceProps> = ({
  active,
  tabs,
  activeTabId,
  apps,
  workspacePath,
  miniAppReloadNonces,
  preBuiltApps,
  onSelectTab,
  onCloseTab,
  onBack,
  onExpandChat,
  onSelectAppChat,
  onNewAppChat,
  onSetToolPinned,
}) => {
  const statuses = useToolStatuses();
  const miniappTabs = tabs.filter((t) => t.kind === 'miniapp' && t.data.kind === 'miniapp');
  const activeTab = miniappTabs.find((t) => t.id === activeTabId) ?? null;
  const activeDirName =
    activeTab?.data.kind === 'miniapp' ? activeTab.data.dirName : null;
  const appByDir = new Map(apps.map((a) => [a.dirName, a]));
  const activeApp = activeDirName ? appByDir.get(activeDirName) : undefined;
  const activeName = activeApp?.name ?? activeDirName ?? '';

  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [panelOpenMap, setPanelOpenMap] = useState<Record<string, boolean>>(loadPanelOpenMap);

  const panelOpen = activeDirName ? panelOpenMap[activeDirName] ?? true : true;

  const setPanelOpen = useCallback((dirName: string, open: boolean) => {
    setPanelOpenMap((prev) => {
      const next = { ...prev, [dirName]: open };
      localStorage.setItem(PANEL_OPEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const togglePanel = useCallback(() => {
    if (activeDirName) setPanelOpen(activeDirName, !panelOpen);
  }, [activeDirName, panelOpen, setPanelOpen]);

  // Quoting from inside a tool puts the excerpt on the thread composer, which
  // exists whether or not this panel is expanded — so with the panel collapsed
  // the quote would land somewhere the user cannot see, and the gesture would
  // read as having done nothing. Taking a quote is an unambiguous "I want to
  // say something about this", so the panel opens itself.
  useEffect(() => {
    const expand = () => {
      if (activeDirName) setPanelOpen(activeDirName, true);
    };
    window.addEventListener('cd:expand-tool-panel', expand);
    return () => window.removeEventListener('cd:expand-tool-panel', expand);
  }, [activeDirName, setPanelOpen]);

  // ── Divider drag (320–560, persisted) ──
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.classList.add('cobuild-resizing');
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startX - ev.clientX;
      const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, dragState.current.startWidth + delta));
      setPanelWidth(next);
    };
    const onUp = () => {
      dragState.current = null;
      document.body.classList.remove('cobuild-resizing');
      setPanelWidth((w) => {
        localStorage.setItem(PANEL_WIDTH_KEY, String(w));
        return w;
      });
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  return (
    <div className="cdToolWorkspace">
      {/* Tab bar */}
      <div className="cdTabBar">
        {miniappTabs.map((tab) => {
          const dirName = tab.data.kind === 'miniapp' ? tab.data.dirName : '';
          const app = appByDir.get(dirName);
          const Icon = resolveToolIcon(app?.icon ?? null);
          const isActive = tab.id === activeTabId;
          const status = statuses.get(dirName) ?? { kind: 'idle' as const };
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className={`cdTab${isActive ? ' cdTab--active' : ''}`}
              onClick={() => onSelectTab(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) onCloseTab(tab.id); }}
            >
              <Icon className="cdTab__icon" style={{ width: 15, height: 15 }} />
              {app?.name ?? dirName}
              <span className={`cdTab__dot cdDot ${toolStatusDotClass(status)}`} style={{ width: 5, height: 5 }} />
              <button
                type="button"
                className="cdTab__close"
                title="Close tab"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              >
                <MSymbol name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Body: viewer(s) + chat panel */}
      <div className="cdToolBody">
        <div className="cdToolMain">
          {miniappTabs.map((tab) => {
            const dirName = tab.data.kind === 'miniapp' ? tab.data.dirName : '';
            const app = appByDir.get(dirName);
            return (
              <div
                key={tab.id}
                className="tabPanel"
                style={{ display: tab.id === activeTabId ? 'flex' : 'none', flex: 1, minHeight: 0 }}
              >
                <MiniAppViewer
                  dirName={dirName}
                  workspacePath={workspacePath}
                  reloadNonce={miniAppReloadNonces[dirName] ?? 0}
                  preBuilt={preBuiltApps.has(dirName)}
                  appName={app?.name ?? dirName}
                  appIcon={app?.icon ?? null}
                  pinned={app?.pinned === true}
                  onSetPinned={(pinned) => onSetToolPinned(dirName, pinned)}
                  chatOpen={panelOpen}
                  onToggleChat={togglePanel}
                  onBack={onBack}
                />
              </div>
            );
          })}
        </div>

        {activeDirName && panelOpen && (
          <>
            <div
              className="cdPanelDivider"
              title="Drag to resize (320–560)"
              onMouseDown={handleDividerMouseDown}
            >
              <MSymbol name="drag_indicator" size={13} />
            </div>
            <div className="cdSidePanel" style={{ width: panelWidth }}>
              <ChatViewingReporter surface="tool-panel" visible={active} />
              <SidePanelHeader
                dirName={activeDirName}
                onSelectChat={(sessionId) => onSelectAppChat(activeDirName, sessionId)}
                onNewChat={() => onNewAppChat(activeDirName)}
                onExpand={onExpandChat}
                onCollapse={() => setPanelOpen(activeDirName, false)}
              />
              <Thread variant="panel" />
            </div>
          </>
        )}

        {activeDirName && !panelOpen && (
          <div className="cdPanelCollapsed">
            <button
              type="button"
              className="cdPanelCollapsed__btn"
              title="Expand chat panel"
              onClick={() => setPanelOpen(activeDirName, true)}
            >
              <MSymbol name="keyboard_double_arrow_left" size={17} />
            </button>
            <button
              type="button"
              className="cdPanelCollapsed__btn"
              title={`Chat — ${activeName}`}
              onClick={() => setPanelOpen(activeDirName, true)}
            >
              <MSymbol name="forum" size={17} />
              <CollapsedChatMark />
            </button>
            <span className="cdPanelCollapsed__spacer" />
            <span className="cdPanelCollapsed__label">CHAT — {activeName.toUpperCase()}</span>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Panel header: two rows. Row one is the chat title as a dropdown trigger over
 * this tool's other chats, the WORKING chip, and new-chat / pop-out /
 * collapse actions. Row two is the mono model · effort line for the chat the
 * panel is showing.
 */
const SidePanelHeader: FC<{
  dirName: string;
  onSelectChat: (sessionId: string) => void;
  onNewChat: () => void;
  onExpand: () => void;
  onCollapse: () => void;
}> = ({ dirName, onSelectChat, onNewChat, onExpand, onCollapse }) => {
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  const title = useAuiState((s: any) => s.threadListItem?.title) as string | undefined;
  const isRunning = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;

  const [chats, setChats] = useState<AppSessionData[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  // Refetched when the menu opens and when a turn ends — a turn is what
  // generates a new chat's title and moves it to the top of the ordering.
  useEffect(() => {
    let cancelled = false;
    window.sessionsAPI.listForApp(dirName)
      .then((rows) => { if (!cancelled) setChats(rows); })
      .catch(() => { if (!cancelled) setChats([]); });
    return () => { cancelled = true; };
  }, [dirName, menuOpen, isRunning]);

  return (
    <div className="cdSidePanel__header">
      <div className="cdSidePanel__headerRow">
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="cdSidePanel__titleBtn" title="Switch chat">
              <span className="cdSidePanel__title">{title || 'New chat'}</span>
              <MSymbol name="expand_more" size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="cdChatMenu" align="start" sideOffset={4}>
              <div className="cdChatMenu__label">Chats for this tool</div>
              {chats.map((chat) => (
                <DropdownMenu.Item
                  key={chat.id}
                  className={`cdChatMenu__item${chat.id === remoteId ? ' cdChatMenu__item--active' : ''}`}
                  onSelect={() => onSelectChat(chat.id)}
                >
                  <ChatMenuMark sessionId={chat.id} />
                  <span className="cdChatMenu__itemTitle">{chat.title || 'New chat'}</span>
                  <span className="cdChatMenu__itemTime">
                    {chat.last_message_at
                      ? relTimeShort(dateFromSessionStoredAt(chat.last_message_at).getTime())
                      : 'EMPTY'}
                  </span>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="cdChatMenu__sep" />
              <DropdownMenu.Item className="cdChatMenu__item cdChatMenu__item--new" onSelect={onNewChat}>
                <MSymbol name="add" size={16} />
                New chat
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {isRunning && (
          <span className="cdStatusChip">
            <span className="cdDot cdDot--busy cdDot--pulse" />
            WORKING
          </span>
        )}
        <button type="button" className="cdIconBtn cdIconBtn--26" title="New chat for this tool" onClick={onNewChat}>
          <MSymbol name="add" size={16} />
        </button>
        <button type="button" className="cdIconBtn cdIconBtn--26" title="Open as full chat" onClick={onExpand}>
          <MSymbol name="open_in_full" size={15} />
        </button>
        <button type="button" className="cdIconBtn cdIconBtn--26" title="Collapse panel" onClick={onCollapse}>
          <MSymbol name="keyboard_double_arrow_right" size={16} />
        </button>
      </div>
      {/* Row two is the model line, and it is the PICKER — this panel hides the
          docked composer, so without it a tool chat could never choose a
          model. It locks itself once the chat is pinned, so the row still
          reads as the truthful "what this chat runs on" line it replaced. */}
      <div className="cdSidePanel__meta"><ModelSelector /></div>
    </div>
  );
};

/**
 * The collapsed strip's badge for the chat the panel would show. It reads the
 * shared activity store, so it agrees with every other chat list: amber while
 * that chat works, blue once a reply lands unseen. It clears itself when the
 * panel opens, because an open panel reports the chat as on screen.
 */
const CollapsedChatMark: FC = () => {
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  return <ChatMarkDot sessionId={remoteId} className="cdPanelCollapsed__mark" />;
};

/**
 * Every row reserves the dot's slot, so titles in the switcher stay aligned
 * whether or not a row carries a mark. The dot is the ONLY unread cue here:
 * bold already means "the chat you are on" in this menu, and giving one style
 * two meanings is exactly the ambiguity the sidebar count was kept free of.
 */
const ChatMenuMark: FC<{ sessionId: string }> = ({ sessionId }) => (
  <span className="cdChatMenu__itemMark"><ChatMarkDot sessionId={sessionId} /></span>
);


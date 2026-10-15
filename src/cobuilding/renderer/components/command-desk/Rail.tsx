import React, { useState } from 'react';
import { PRODUCT_DISPLAY_NAME } from '../../../shared/product';
import { MSymbol } from './MSymbol';
import { AcaboxMark } from './AcaboxMark';
import { resolveToolIcon } from './toolIcon';
import { useToolStatuses } from '../../toolStatusStore';
import { toolStatusDotClass } from './toolStatusDisplay';
import { useServerCounts } from '../../mcpServerStore';
import { useHasUnreadChats } from '../../chatActivityStore';
import { ChatMarkDot } from './ChatMarkDot';
import type { RailTool } from './railTools';
import type { ToolRuntimeStatus } from '../../toolStatusStore';

// The Debug tab is a developer tool (hard reset, raw DB views); a packaged
// user has no use for it and one click on Hard Reset wipes their workspace.
const SHOW_DEBUG = typeof window !== 'undefined' && window.authAPI?.isDev === true;

export type RailTab = 'home' | 'chats' | 'tools' | 'knowledge' | 'servers' | 'files' | 'activity' | 'debug' | 'settings';

export interface RailRecentChat {
  id: string;
  title: string;
}


const NAV_ITEMS: { tab: RailTab; label: string; icon: string }[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'chats', label: 'Chats', icon: 'forum' },
  { tab: 'tools', label: 'Tools', icon: 'grid_view' },
  { tab: 'knowledge', label: 'Knowledge', icon: 'book_2' },
  { tab: 'servers', label: 'Servers', icon: 'dns' },
  { tab: 'files', label: 'Files', icon: 'folder_open' },
  { tab: 'activity', label: 'Activity', icon: 'monitoring' },
];

const RAIL_OPEN_KEY = 'cd.railOpen';

/**
 * Left rail — expanded (236px) and collapsed (64px) states, toggle persisted.
 */
export function Rail({
  activeTab,
  chatCount,
  toolCount,
  recents,
  pinned,
  recentTools,
  activeToolDirName,
  onNavigate,
  onOpenChat,
  onOpenTool,
  onSetToolPinned,
}: {
  activeTab: RailTab | string;
  chatCount: number;
  toolCount: number;
  recents: RailRecentChat[];
  /** Tools the user pinned, in pin order (railTools.ts). */
  pinned: RailTool[];
  /** Recently opened tools that are not pinned (railTools.ts). */
  recentTools: RailTool[];
  /** The tool on screen, or null when no tool is. */
  activeToolDirName: string | null;
  onNavigate: (tab: RailTab) => void;
  onOpenChat: (sessionId: string) => void;
  onOpenTool: (dirName: string) => void;
  onSetToolPinned: (dirName: string, pinned: boolean) => void;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(RAIL_OPEN_KEY) !== 'false');
  const toolStatuses = useToolStatuses();
  // A failing server is news; a count of running servers is not — so the
  // rail badge is a bare red dot, gated on `down > 0`, never a number
  // (design: docs/design/mcp-hosting.md, Increment 3). Called directly here,
  // the same way `useToolStatuses()` already is, so `Rail` stays prop-free.
  const serverCounts = useServerCounts();
  // Unread chats get a dot beside the total, never a second number and never a
  // replacement for it: the count keeps meaning "how many chats you have" in
  // every state, and the dot is what catches the eye anyway (the user's pick).
  const hasUnreadChats = useHasUnreadChats();

  // The tool on screen is highlighted in its own row, and Tools stops being
  // highlighted, so a pinned tool reads as its own place in the menu. A tool
  // the rail doesn't list leaves Tools highlighted as before. Collapsed, the
  // rail lists pinned tools only.
  const isPinned = (dirName: string | null) => !!dirName && pinned.some((t) => t.dirName === dirName);
  const isListedExpanded = isPinned(activeToolDirName) || recentTools.some((t) => t.dirName === activeToolDirName);
  const navActive = (tab: RailTab, toolListed: boolean) => activeTab === tab && !(tab === 'tools' && toolListed);

  const toggle = () => {
    setOpen((prev) => {
      localStorage.setItem(RAIL_OPEN_KEY, String(!prev));
      return !prev;
    });
  };

  if (!open) {
    return (
      <div className="cdRail cdRail--collapsed">
        <div className="cdRail__logo">
          <AcaboxMark size={28} />
        </div>
        <button className="cdIconBtn" title="Expand" onClick={toggle}>
          <MSymbol name="keyboard_double_arrow_right" size={18} />
        </button>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.tab}
            className={`cdRail__bigIconBtn${navActive(item.tab, isPinned(activeToolDirName)) ? ' cdRail__bigIconBtn--active' : ''}`}
            title={item.label}
            onClick={() => onNavigate(item.tab)}
          >
            <MSymbol name={item.icon} size={20} />
            {item.tab === 'chats' && hasUnreadChats && (
              <span className="cdRail__badgeDot cdRail__badgeDot--unread" role="img" aria-label="Unread chats" />
            )}
            {item.tab === 'servers' && serverCounts.down > 0 && <span className="cdRail__badgeDot" />}
          </button>
        ))}
        {pinned.length > 0 && (
          <div className="cdRail__pinnedIcons">
            {pinned.map((tool) => {
              const Icon = resolveToolIcon(tool.icon);
              const status = toolStatuses.get(tool.dirName);
              return (
                <button
                  key={tool.dirName}
                  className={`cdRail__bigIconBtn${tool.dirName === activeToolDirName ? ' cdRail__bigIconBtn--active' : ''}`}
                  title={tool.name}
                  onClick={() => onOpenTool(tool.dirName)}
                >
                  <Icon style={{ width: 20, height: 20 }} />
                  {status && <span className={`cdDot ${toolStatusDotClass(status)} cdRail__iconDot`} />}
                </button>
              );
            })}
          </div>
        )}
        <span className="cdRail__spacer" />
        {SHOW_DEBUG && (
          <button className="cdRail__bigIconBtn" title="Debug" onClick={() => onNavigate('debug')}>
            <MSymbol name="bug_report" size={20} />
          </button>
        )}
        <button className="cdRail__bigIconBtn" title="Settings" onClick={() => onNavigate('settings')}>
          <MSymbol name="settings" size={20} />
        </button>
      </div>
    );
  }

  return (
    <div className="cdRail">
      <div className="cdRail__header">
        <div className="cdRail__logo">
          <AcaboxMark size={28} />
        </div>
        <span className="cdRail__wordmark">{PRODUCT_DISPLAY_NAME.toUpperCase()}</span>
        <span className="cdRail__spacer" />
        <button className="cdIconBtn" title="Collapse" onClick={toggle}>
          <MSymbol name="keyboard_double_arrow_left" size={18} />
        </button>
      </div>

      <nav className="cdRail__nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.tab}
            className={`cdRail__navItem${navActive(item.tab, isListedExpanded) ? ' cdRail__navItem--active' : ''}`}
            onClick={() => onNavigate(item.tab)}
          >
            <MSymbol name={item.icon} size={18} />
            {item.label}
            <span className="cdRail__spacer" />
            {item.tab === 'chats' && hasUnreadChats && (
              <span
                className="cdDot cdDot--unread cdRail__unreadDot"
                role="img"
                aria-label="Unread chats"
                title="Some chats have replies you haven't seen"
              />
            )}
            {item.tab === 'chats' && chatCount > 0 && (
              <span className="cdRail__navCount">{chatCount}</span>
            )}
            {item.tab === 'tools' && toolCount > 0 && (
              <span className="cdRail__navCount">{toolCount}</span>
            )}
            {item.tab === 'servers' && serverCounts.down > 0 && <span className="cdRail__badgeDot" />}
          </button>
        ))}
      </nav>

      {/* Everything between the menu and the footer scrolls, so a long list of
          pins can never push Settings off the bottom of the window. */}
      <div className="cdRail__scroll">
        {pinned.length > 0 && (
          <>
            <div className="cdRail__sectionLabel">Pinned tools</div>
            <div className="cdRail__list">
              {pinned.map((tool) => (
                <RailToolRow
                  key={tool.dirName}
                  tool={tool}
                  pinned
                  active={tool.dirName === activeToolDirName}
                  status={toolStatuses.get(tool.dirName)}
                  onOpen={() => onOpenTool(tool.dirName)}
                  onTogglePin={() => onSetToolPinned(tool.dirName, false)}
                />
              ))}
            </div>
          </>
        )}

        {recents.length > 0 && (
          <>
            <div className="cdRail__sectionLabel">Recent chats</div>
            <div className="cdRail__list">
              {recents.map((chat) => (
                <button key={chat.id} className="cdRail__row" onClick={() => onOpenChat(chat.id)}>
                  <MSymbol name="chat_bubble" size={16} />
                  <span className="cdRail__rowTitle">{chat.title}</span>
                  <ChatMarkDot sessionId={chat.id} className="cdRail__rowMark" />
                </button>
              ))}
              <button className="cdRail__row cdRail__row--more" onClick={() => onNavigate('chats')}>
                <MSymbol name="more_horiz" size={16} />
                More
              </button>
            </div>
          </>
        )}

        {recentTools.length > 0 && (
          <>
            <div className="cdRail__sectionLabel">Recent tools</div>
            <div className="cdRail__list">
              {recentTools.map((tool) => (
                <RailToolRow
                  key={tool.dirName}
                  tool={tool}
                  pinned={false}
                  active={tool.dirName === activeToolDirName}
                  status={toolStatuses.get(tool.dirName)}
                  onOpen={() => onOpenTool(tool.dirName)}
                  onTogglePin={() => onSetToolPinned(tool.dirName, true)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="cdRail__footer">
        {SHOW_DEBUG && (
          <button className="cdRail__row" onClick={() => onNavigate('debug')}>
            <MSymbol name="bug_report" size={16} />
            Debug
          </button>
        )}
        <button className="cdRail__row" onClick={() => onNavigate('settings')}>
          <MSymbol name="settings" size={16} />
          Settings
        </button>
      </div>
    </div>
  );
}

/**
 * One tool in the rail. The pin button sits beside the row, not inside it (a
 * button cannot hold a button), and shows on hover or keyboard focus.
 */
function RailToolRow({
  tool,
  pinned,
  active,
  status,
  onOpen,
  onTogglePin,
}: {
  tool: RailTool;
  pinned: boolean;
  active: boolean;
  status: ToolRuntimeStatus | undefined;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  const Icon = resolveToolIcon(tool.icon);
  const action = pinned ? 'Unpin from sidebar' : 'Pin to sidebar';
  return (
    <div className="cdRail__rowWrap">
      <button className={`cdRail__row${active ? ' cdRail__row--active' : ''}`} onClick={onOpen}>
        <Icon style={{ width: 16, height: 16, color: active ? 'var(--cd-blue)' : 'var(--cd-text3)', flex: 'none' }} />
        <span className="cdRail__rowTitle">{tool.name}</span>
        {/* Idle tools carry no dot at all — a dot here means the tool is
            busy or broken, not merely that it exists. */}
        {status && <span className={`cdDot ${toolStatusDotClass(status)}`} />}
      </button>
      <button
        type="button"
        className="cdRail__rowAction"
        title={action}
        aria-label={`${action}: ${tool.name}`}
        onClick={onTogglePin}
      >
        <MSymbol name={pinned ? 'keep_off' : 'keep'} size={15} />
      </button>
    </div>
  );
}

/**
 * Renders the real `<Rail/>` with pinned and recent tools.
 *
 * "Pinned tools" used to be the three most recently opened tools, so a tool
 * dropped out of it whenever three others were opened. Now pins are the
 * user's, the recency list is labelled for what it is, and the pin control
 * on a row must never also open the tool underneath it.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Rail } from '../Rail';
import type { RailTool } from '../railTools';

jest.mock('../../../chatActivityStore', () => ({
  __esModule: true,
  useHasUnreadChats: () => false,
}));
jest.mock('../ChatMarkDot', () => ({ __esModule: true, ChatMarkDot: () => null }));
jest.mock('../AcaboxMark', () => ({ __esModule: true, AcaboxMark: () => null }));
jest.mock('../MSymbol', () => ({
  __esModule: true,
  MSymbol: ({ name }: { name: string }) => require('react').createElement('span', { 'data-icon': name }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const notes: RailTool = { dirName: 'notes', name: 'Notes', icon: 'NotebookPen' };
const spend: RailTool = { dirName: 'spend', name: 'Spend Explorer', icon: null };
const visibility: RailTool = { dirName: 'visibility', name: 'Scholar Visibility', icon: null };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(over: Partial<React.ComponentProps<typeof Rail>> = {}) {
  const props: React.ComponentProps<typeof Rail> = {
    activeTab: 'home',
    chatCount: 2,
    toolCount: 3,
    recents: [{ id: 'c1', title: 'A chat' }],
    pinned: [notes],
    recentTools: [spend, visibility],
    activeToolDirName: null,
    onNavigate: jest.fn(),
    onOpenChat: jest.fn(),
    onOpenTool: jest.fn(),
    onSetToolPinned: jest.fn(),
    ...over,
  };
  act(() => root.render(<Rail {...props} />));
  return props;
}

const labels = () => [...container.querySelectorAll('.cdRail__sectionLabel')].map((el) => el.textContent);
const rowTitles = () => [...container.querySelectorAll('.cdRail__rowWrap .cdRail__rowTitle')].map((el) => el.textContent);
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const navItem = (text: string) =>
  [...container.querySelectorAll('.cdRail__navItem')].find((el) => el.textContent?.includes(text))!;

describe('Rail tool sections', () => {
  it('shows pinned tools under the menu, then recent chats, then recent tools', () => {
    render();
    expect(labels()).toEqual(['Pinned tools', 'Recent chats', 'Recent tools']);
    expect(rowTitles()).toEqual(['Notes', 'Spend Explorer', 'Scholar Visibility']);
  });

  it('leaves out a section with nothing in it', () => {
    render({ pinned: [], recentTools: [] });
    expect(labels()).toEqual(['Recent chats']);
  });

  it('unpins from a pinned row without opening the tool', () => {
    const props = render();
    click(button('Unpin from sidebar: Notes'));
    expect(props.onSetToolPinned).toHaveBeenCalledWith('notes', false);
    expect(props.onOpenTool).not.toHaveBeenCalled();
  });

  it('pins from a recent row without opening the tool', () => {
    const props = render();
    click(button('Pin to sidebar: Spend Explorer'));
    expect(props.onSetToolPinned).toHaveBeenCalledWith('spend', true);
    expect(props.onOpenTool).not.toHaveBeenCalled();
  });

  it('opens the tool from the row itself', () => {
    const props = render();
    click(container.querySelector('.cdRail__rowWrap .cdRail__row')!);
    expect(props.onOpenTool).toHaveBeenCalledWith('notes');
    expect(props.onSetToolPinned).not.toHaveBeenCalled();
  });

  it('highlights the tool on screen instead of Tools when the rail lists it', () => {
    render({ activeTab: 'tools', activeToolDirName: 'notes' });
    const active = [...container.querySelectorAll('.cdRail__row--active .cdRail__rowTitle')].map((el) => el.textContent);
    expect(active).toEqual(['Notes']);
    expect(navItem('Tools').className).not.toContain('cdRail__navItem--active');
  });

  it('keeps Tools highlighted for a tool the rail does not list', () => {
    render({ activeTab: 'tools', activeToolDirName: 'somethingElse' });
    expect(container.querySelector('.cdRail__row--active')).toBeNull();
    expect(navItem('Tools').className).toContain('cdRail__navItem--active');
  });
});

describe('collapsed rail', () => {
  beforeEach(() => localStorage.setItem('cd.railOpen', 'false'));

  it('keeps pinned tools as icons and drops recent ones', () => {
    render({ activeTab: 'tools', activeToolDirName: 'notes' });
    const icons = [...container.querySelectorAll('.cdRail__pinnedIcons button')];
    expect(icons.map((b) => b.getAttribute('title'))).toEqual(['Notes']);
    expect(icons[0].className).toContain('cdRail__bigIconBtn--active');
    expect(container.querySelector('button[title="Spend Explorer"]')).toBeNull();
    expect(container.querySelector('button[title="Tools"]')!.className).not.toContain('--active');
  });

  it('opens a pinned tool from its icon', () => {
    const props = render();
    click(container.querySelector('button[title="Notes"]')!);
    expect(props.onOpenTool).toHaveBeenCalledWith('notes');
  });

  it('shows no pinned area when nothing is pinned', () => {
    render({ pinned: [] });
    expect(container.querySelector('.cdRail__pinnedIcons')).toBeNull();
  });
});

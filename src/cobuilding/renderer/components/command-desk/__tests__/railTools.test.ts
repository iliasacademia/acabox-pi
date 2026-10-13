import { railToolLists, RECENT_TOOLS_LIMIT, type RailToolSource } from '../railTools';

function app(dirName: string, over: Partial<RailToolSource> = {}): RailToolSource {
  return { dirName, name: dirName, icon: null, lastOpened: null, archived: false, pinned: false, pinnedAt: null, ...over };
}

const at = (minute: number) => `2026-10-13T10:${String(minute).padStart(2, '0')}:00.000Z`;
const dirs = (tools: { dirName: string }[]) => tools.map((t) => t.dirName);

describe('railToolLists', () => {
  it('lists pinned tools in the order they were pinned, not by name or last opened', () => {
    const { pinned } = railToolLists([
      app('zeta', { pinned: true, pinnedAt: at(1), lastOpened: at(50) }),
      app('alpha', { pinned: true, pinnedAt: at(30), lastOpened: at(59) }),
      app('mid', { pinned: true, pinnedAt: at(10) }),
    ]);
    expect(dirs(pinned)).toEqual(['zeta', 'mid', 'alpha']);
  });

  it('puts a pin without a readable time last, ordered by name', () => {
    const { pinned } = railToolLists([
      app('b', { pinned: true }),
      app('a', { pinned: true }),
      app('timed', { pinned: true, pinnedAt: at(5) }),
    ]);
    expect(dirs(pinned)).toEqual(['timed', 'a', 'b']);
  });

  it('shows every pinned tool, with no cap', () => {
    const many = Array.from({ length: 8 }, (_, i) => app(`t${i}`, { pinned: true, pinnedAt: at(i) }));
    expect(railToolLists(many).pinned).toHaveLength(8);
  });

  it('lists recent tools newest first, at most RECENT_TOOLS_LIMIT, and never a pinned one', () => {
    const { recent } = railToolLists([
      app('notes', { pinned: true, pinnedAt: at(0), lastOpened: at(59) }),
      app('a', { lastOpened: at(10) }),
      app('b', { lastOpened: at(40) }),
      app('c', { lastOpened: at(20) }),
      app('d', { lastOpened: at(30) }),
    ]);
    expect(RECENT_TOOLS_LIMIT).toBe(3);
    expect(dirs(recent)).toEqual(['b', 'd', 'c']);
  });

  it('leaves out tools that were never opened, rather than padding the list', () => {
    const { recent } = railToolLists([app('opened', { lastOpened: at(1) }), app('never'), app('bad', { lastOpened: 'not a date' })]);
    expect(dirs(recent)).toEqual(['opened']);
  });

  it('shows archived tools in neither list, even when pinned', () => {
    const lists = railToolLists([
      app('gone', { archived: true, pinned: true, pinnedAt: at(1), lastOpened: at(59) }),
      app('old', { archived: true, lastOpened: at(58) }),
    ]);
    expect(lists).toEqual({ pinned: [], recent: [] });
  });

  it('passes only what the rail renders', () => {
    const { pinned } = railToolLists([app('notes', { name: 'Notes', icon: 'NotebookPen', pinned: true, pinnedAt: at(1) })]);
    expect(pinned).toEqual([{ dirName: 'notes', name: 'Notes', icon: 'NotebookPen' }]);
  });
});

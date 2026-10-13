import { readToolPin, withToolPin } from '../toolPin';

describe('readToolPin', () => {
  it('reads a pinned manifest with its time', () => {
    expect(readToolPin({ pinned: true, pinnedAt: '2026-10-13T10:00:00.000Z' }))
      .toEqual({ pinned: true, pinnedAt: '2026-10-13T10:00:00.000Z' });
  });

  it('reads anything but a literal true as unpinned', () => {
    for (const manifest of [null, undefined, {}, { pinned: 'true' }, { pinned: 1 }, { pinned: false, pinnedAt: '2026-10-13T10:00:00.000Z' }]) {
      expect(readToolPin(manifest as Record<string, unknown> | null | undefined)).toEqual({ pinned: false, pinnedAt: null });
    }
  });

  it('keeps a pin whose time is missing or unreadable, without the time', () => {
    expect(readToolPin({ pinned: true })).toEqual({ pinned: true, pinnedAt: null });
    expect(readToolPin({ pinned: true, pinnedAt: 'yesterday-ish' })).toEqual({ pinned: true, pinnedAt: null });
  });
});

describe('withToolPin', () => {
  const now = new Date('2026-10-13T12:00:00.000Z');

  it('pins with the current time and keeps every other field', () => {
    const manifest = { name: 'Notes', icon: 'NotebookPen', archived: true, custom: { a: 1 } };
    expect(withToolPin(manifest, true, now)).toEqual({
      name: 'Notes',
      icon: 'NotebookPen',
      archived: true,
      custom: { a: 1 },
      pinned: true,
      pinnedAt: '2026-10-13T12:00:00.000Z',
    });
  });

  it('pinning again keeps the original time, so the tool does not move', () => {
    const manifest = { name: 'Notes', pinned: true, pinnedAt: '2026-10-01T08:00:00.000Z' };
    expect(withToolPin(manifest, true, now).pinnedAt).toBe('2026-10-01T08:00:00.000Z');
  });

  it('repairs a pin with an unreadable time', () => {
    expect(withToolPin({ pinned: true, pinnedAt: 'garbage' }, true, now).pinnedAt).toBe('2026-10-13T12:00:00.000Z');
  });

  it('unpinning removes both fields and nothing else', () => {
    const manifest = { name: 'Notes', pinned: true, pinnedAt: '2026-10-01T08:00:00.000Z', lastOpened: 'x' };
    expect(withToolPin(manifest, false, now)).toEqual({ name: 'Notes', lastOpened: 'x' });
  });
});

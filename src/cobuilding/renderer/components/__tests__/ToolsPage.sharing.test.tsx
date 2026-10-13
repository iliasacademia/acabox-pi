/**
 * Tools page sharing block (`docs/design/sharing-tickets.md`, ticket U4).
 * Rendered through real React (`react-dom/client` + `act`, matching
 * `FilesTab.test.tsx` / `SharePublishDialog.test.tsx` — this repo has no
 * `@testing-library/react`).
 *
 * `window.shareAPI` covers both `useToolShare`'s own calls (`statusApp`,
 * `onChanged`) — used unconditionally by every row's chip, per U4 — and
 * `SharePublishDialog`'s own calls (`planApp`, `publishApp`, `unpublishApp`,
 * `onProgress`), since clicking Publish…/Refresh…/Unpublish mounts that
 * dialog. `@assistant-ui/react` is mocked the same way `ServersPage.test.tsx`
 * does it — `ToolsPage` calls both `useAssistantRuntime` and
 * `useComposerRuntime` for the "Ask me to do something" flow, unrelated to
 * sharing but required for the component to render at all.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolsPage } from '../ToolsPage';
import { __resetShareStoreForTests } from '../../shareStore';
import type { PublishedInfo } from '../../../shared/share';

jest.mock('@assistant-ui/react', () => ({
  useAssistantRuntime: () => ({ switchToNewThread: jest.fn() }),
  useComposerRuntime: () => ({ setText: jest.fn(), send: jest.fn() }),
}));

// ToolsPage pulls in FileViewer for the "Saved data" preview modal, which
// drags in `react-markdown` (ESM-only, not in jest's transform allowlist —
// unrelated to sharing and pre-existing). None of these tests open that
// modal, so a stub keeps the import graph out of this file's way.
jest.mock('../FileViewer', () => ({ FileViewer: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sampleApp(overrides: Partial<MiniAppEntry> = {}): MiniAppEntry {
  return {
    dirName: 'dnaToolkit',
    name: 'DNA Toolkit',
    description: 'Reverse-complements a sequence.',
    icon: null,
    lastOpened: null,
    lastRun: null,
    preBuilt: false,
    archived: false,
    pinned: false,
    pinnedAt: null,
    apis: [],
    hasManifest: true,
    published: null,
    ...overrides,
  };
}

function samplePublished(overrides: Partial<PublishedInfo> = {}): PublishedInfo {
  return {
    id: 'abc123xyz0',
    kind: 'app',
    url: 'https://acabox-share.acct.workers.dev/a/abc123xyz0/',
    hash: 'a'.repeat(64),
    publishedAt: '2026-09-15T00:00:00.000Z',
    includeInput: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

let listMock: jest.Mock;
let statusAppMock: jest.Mock;
let planAppMock: jest.Mock;

function installApis(apps: MiniAppEntry[]): void {
  listMock = jest.fn(async () => apps);
  (window as any).miniAppsAPI = {
    list: listMock,
    exportApp: jest.fn(),
    importApp: jest.fn(),
    touch: jest.fn(),
    setArchived: jest.fn(async () => ({ ok: true })),
    setApis: jest.fn(async () => ({ ok: true })),
    delete: jest.fn(async () => ({ ok: true })),
    build: jest.fn(),
  };
  (window as any).toolDataAPI = {
    list: jest.fn(async () => []),
    delete: jest.fn(async () => ({ ok: true })),
  };
  (window as any).apisAPI = {
    list: jest.fn(async () => ({ apis: [] })),
  };
}

function installShareApi(opts: { published?: PublishedInfo | null; behind?: boolean } = {}): void {
  const published = opts.published ?? null;
  const behind = opts.behind ?? false;

  statusAppMock = jest.fn(async () => ({ published, behind }));
  planAppMock = jest.fn(async () => ({
    ok: true,
    summary: {
      code: { count: 1, bytes: 100 },
      output: { count: 0, bytes: 0 },
      input: { count: 0, bytes: 0 },
      vendor: { count: 0, bytes: 0 },
      total: { count: 1, bytes: 100 },
    },
    hash: 'b'.repeat(64),
    published,
    behind,
  }));

  (window as any).shareAPI = {
    getSettings: jest.fn(),
    saveSettings: jest.fn(),
    test: jest.fn(),
    planApp: planAppMock,
    publishApp: jest.fn(),
    unpublishApp: jest.fn(async () => ({ ok: true })),
    statusApp: statusAppMock,
    publishFile: jest.fn(),
    unpublishFile: jest.fn(),
    statusFile: jest.fn(),
    onChanged: jest.fn(() => () => {}),
    onProgress: jest.fn(() => () => {}),
  };
  (window as any).electronAPI = { invoke: jest.fn(async () => undefined) };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button with text "${text}"`);
  return btn as HTMLButtonElement;
}

function queryButton(text: string): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement) ?? null
  );
}

async function renderToolsPage(): Promise<void> {
  await act(async () => {
    root.render(
      <ToolsPage
        workspacePath="/workspace"
        onSelectApp={jest.fn()}
        onSwitchToChat={jest.fn()}
      />,
    );
  });
  await flush();
  await flush();
}

async function openSettings(): Promise<void> {
  act(() => {
    findButton('Settings').click();
  });
  await flush();
}

beforeEach(() => {
  __resetShareStoreForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  __resetShareStoreForTests();
  delete (window as any).miniAppsAPI;
  delete (window as any).toolDataAPI;
  delete (window as any).apisAPI;
  delete (window as any).shareAPI;
  delete (window as any).electronAPI;
  jest.clearAllMocks();
});

describe('ToolsPage — sharing block (U4)', () => {
  it('shows a SHARED · OUT OF DATE row chip and Refresh…/Copy link/Open/Unpublish in the panel for a published+behind tool', async () => {
    installApis([sampleApp()]);
    installShareApi({ published: samplePublished(), behind: true });

    await renderToolsPage();
    expect(statusAppMock).toHaveBeenCalledWith('dnaToolkit');

    const chip = container.querySelector('.cdStatusChip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('SHARED · OUT OF DATE');
    expect(chip!.querySelector('.cdDot')).not.toBeNull();

    await openSettings();

    expect(container.querySelector('.toolRow__sharing')?.textContent).toContain('SHARED · OUT OF DATE');
    expect(queryButton('Refresh…')).not.toBeNull();
    expect(queryButton('Copy link')).not.toBeNull();
    expect(queryButton('Open')).not.toBeNull();
    expect(queryButton('Unpublish')).not.toBeNull();
    expect(queryButton('Publish…')).toBeNull();
  });

  it('shows no row chip and a Publish… button (no chip, no Refresh/Unpublish) for an unpublished tool', async () => {
    installApis([sampleApp()]);
    installShareApi({ published: null, behind: false });

    await renderToolsPage();
    expect(statusAppMock).toHaveBeenCalledWith('dnaToolkit');

    expect(container.querySelector('.cdStatusChip')).toBeNull();

    await openSettings();

    expect(container.querySelector('.toolRow__sharing')?.textContent).toContain('NOT SHARED');
    expect(queryButton('Publish…')).not.toBeNull();
    expect(queryButton('Refresh…')).toBeNull();
    expect(queryButton('Copy link')).toBeNull();
    expect(queryButton('Open')).toBeNull();
    expect(queryButton('Unpublish')).toBeNull();
  });

  it('clicking Publish… mounts the SharePublishDialog for that row', async () => {
    installApis([sampleApp()]);
    installShareApi({ published: null, behind: false });

    await renderToolsPage();
    await openSettings();

    act(() => {
      findButton('Publish…').click();
    });
    await flush();
    await flush();
    await flush();

    expect(container.querySelector('.sharePublishDialog')).not.toBeNull();
    expect(container.textContent).toContain('Publish "DNA Toolkit"');
  });
});

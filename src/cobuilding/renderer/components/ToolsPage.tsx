import React, { useState, useEffect, useCallback } from 'react';
import * as LucideIcons from 'lucide-react';
import {
  LayoutGridIcon,
  UploadIcon,
  ChevronRightIcon,
  PlayIcon,
  TrashIcon,
  SparklesIcon,
  ArrowRightIcon,
  FileTextIcon,
  FolderOpenIcon,
  XIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  DatabaseIcon,
  PinIcon,
  PinOffIcon,
} from 'lucide-react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';
import { FileViewer } from './FileViewer';
import { useToolShare } from '../shareStore';
import { SharePublishDialog } from './share/SharePublishDialog';

type ToolsPageMiniApp = MiniAppEntry;

// Resolve a Lucide icon by manifest name. Lucide exports each icon under both
// `Foo` and `FooIcon`; the agent typically writes the PascalCase form (e.g.
// "FlaskConical"), but we accept either. Falls back to the generic grid icon.
function resolveLucideIcon(name: string | null): React.ComponentType<{ style?: React.CSSProperties }> {
  if (!name) return LayoutGridIcon;
  const registry = LucideIcons as unknown as Record<string, React.ComponentType<{ style?: React.CSSProperties }>>;
  return registry[`${name}Icon`] ?? registry[name] ?? LayoutGridIcon;
}

function formatLastUsed(lastOpened: string | null): string | null {
  if (!lastOpened) return null;
  const then = Date.parse(lastOpened);
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'used just now';

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'used just now';
  if (diffMs < hour) {
    const m = Math.floor(diffMs / minute);
    return `used ${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const h = Math.floor(diffMs / hour);
    return `used ${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (diffMs < 30 * day) {
    const d = Math.floor(diffMs / day);
    return d === 1 ? 'used yesterday' : `used ${d} days ago`;
  }
  if (diffMs < 365 * day) {
    const months = Math.floor(diffMs / (30 * day));
    return `used ${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(diffMs / (365 * day));
  return `used ${years} year${years === 1 ? '' : 's'} ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1000;
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/** A file inside a tool-data folder, gathered recursively for the browse view. */
interface SavedFile {
  /** Workspace-relative path, e.g. `tool-data/myApp/output/plot.png`. */
  relPath: string;
  /** Display label relative to the tool-data folder, e.g. `output/plot.png`. */
  label: string;
}

async function listSavedFiles(dirName: string): Promise<SavedFile[]> {
  const root = `tool-data/${dirName}`;
  const out: SavedFile[] = [];
  async function walk(relDir: string): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await window.filesAPI.readDirectory(relDir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = `${relDir}/${e.name}`;
      if (e.isDirectory) {
        await walk(childRel);
      } else {
        out.push({ relPath: childRel, label: childRel.slice(root.length + 1) });
      }
    }
  }
  await walk(root);
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/**
 * Per-row sharing UI (`docs/design/sharing-tickets.md`, ticket U4). A `.map()`
 * callback in the parent can't call hooks itself — every iteration runs
 * inside the SAME component instance, so the hook count would vary with the
 * app list's length — so this is a real child component, giving each row its
 * own `useToolShare` subscription. It is mounted twice per row (`mode="chip"`
 * next to the row's status text, always; `mode="panel"` inside the settings
 * panel, only while open) — both reads land on the same module-level cache in
 * `shareStore.ts`, so the two never disagree.
 */
function ToolRowSharing({
  app,
  mode,
  onOpenDialog,
}: {
  app: ToolsPageMiniApp;
  mode: 'chip' | 'panel';
  /** Only used by `mode="panel"` — opens the publish/refresh/unpublish dialog for this row. */
  onOpenDialog?: (dirName: string, appName: string) => void;
}): React.ReactElement | null {
  const { published, behind, loading } = useToolShare(app.dirName);

  if (mode === 'chip') {
    // No-mocks rule: nothing renders until we actually know the tool is
    // published, rather than guessing from a stale/idle default.
    if (loading || !published) return null;
    return (
      <span className="cdStatusChip">
        {behind && <span className="cdDot cdDot--busy" />}
        {behind ? 'SHARED · OUT OF DATE' : 'SHARED'}
      </span>
    );
  }

  const label = loading
    ? null
    : !published
      ? 'NOT SHARED'
      : behind
        ? 'SHARED · OUT OF DATE'
        : 'SHARED · UP TO DATE';

  const openDialog = () => onOpenDialog?.(app.dirName, app.name);
  const handleCopyLink = () => {
    if (published) void navigator.clipboard.writeText(published.url);
  };
  const handleOpen = () => {
    if (published) void (window as any).electronAPI.invoke('shell:openExternal', published.url);
  };

  return (
    <div className="toolRow__sharing">
      {label && <div className="toolRow__grantsLabel">{label}</div>}
      {!loading && (
        <div className="toolRow__settingsActions">
          {!published && (
            <button type="button" className="toolRow__secondaryBtn" onClick={openDialog}>
              Publish…
            </button>
          )}
          {published && behind && (
            <button type="button" className="toolRow__secondaryBtn" onClick={openDialog}>
              Refresh…
            </button>
          )}
          {published && (
            <>
              <button type="button" className="toolRow__secondaryBtn" onClick={handleCopyLink}>
                Copy link
              </button>
              <button type="button" className="toolRow__secondaryBtn" onClick={handleOpen}>
                Open
              </button>
              <button type="button" className="toolRow__deleteBtn" onClick={openDialog}>
                Unpublish
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolsPage({
  workspacePath,
  onSelectApp,
  onSwitchToChat,
  onAppsChanged,
  pinnedDirNames,
  onSetPinned,
}: {
  workspacePath: string;
  onSelectApp: (dirName: string, opts?: { preBuilt?: boolean }) => void;
  onSwitchToChat: () => void;
  /** Notify the shell (rail badge, rail tool lists, home grid) that the app list changed. */
  onAppsChanged?: () => void;
  /**
   * Which tools are pinned to the rail. Read from the shell rather than this
   * page's own list, because a pin made in the rail or a tool's menu does not
   * reload this page; the shell re-reads after every pin, wherever it came from.
   */
  pinnedDirNames?: ReadonlySet<string>;
  onSetPinned?: (dirName: string, pinned: boolean) => void;
}) {
  const [apps, setApps] = useState<ToolsPageMiniApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  const [toolData, setToolData] = useState<ToolDataEntry[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const miniApps = await window.miniAppsAPI.list();
      // Most-recently-opened first; never-opened apps fall to the bottom,
      // tie-broken by name so the order is stable.
      miniApps.sort((a, b) => {
        const aTs = a.lastOpened ? Date.parse(a.lastOpened) : 0;
        const bTs = b.lastOpened ? Date.parse(b.lastOpened) : 0;
        if (aTs !== bTs) return bTs - aTs;
        return a.name.localeCompare(b.name);
      });
      setApps(miniApps);
    } catch {
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  const refreshToolData = useCallback(async () => {
    try {
      setToolData(await window.toolDataAPI.list());
    } catch {
      setToolData([]);
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshToolData();
  }, [refresh, refreshToolData]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createToolText, setCreateToolText] = useState('');

  const handleCreateTool = useCallback(() => {
    const text = createToolText.trim();
    if (!text) return;
    setShowCreateModal(false);
    setCreateToolText('');
    assistantRuntime.switchToNewThread();
    setTimeout(() => {
      composerRuntime.setText(`Create a tool for me that does the following:\n\n${text}`);
      composerRuntime.send();
      onSwitchToChat();
    }, 0);
  }, [createToolText, assistantRuntime, composerRuntime, onSwitchToChat]);

  const handleImportTool = useCallback(async () => {
    setImporting(true);
    try {
      const result = await window.miniAppsAPI.importApp();
      if (result.ok && result.dirName) {
        await refresh();
        onAppsChanged?.();
        onSelectApp(result.dirName);
        window.containerAPI.ensureAppDeps(result.dirName).catch(() => {});
      } else if (!result.canceled) {
        console.error('Import failed:', result.error);
      }
    } finally {
      setImporting(false);
    }
  }, [refresh, onSelectApp, onAppsChanged]);

  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ToolsPageMiniApp | null>(null);
  /** The one sharing dialog open at a time (Publish…/Refresh…/Unpublish), U3/U4. */
  const [shareDialog, setShareDialog] = useState<{ dirName: string; appName: string } | null>(null);
  /** Configured APIs, for the per-tool grant checklist. Empty until loaded. */
  const [configuredApis, setConfiguredApis] = useState<Array<{ id: string; label: string; allowWrites: boolean }>>([]);
  const [deleting, setDeleting] = useState(false);

  // Saved-data browse/delete state
  const [browseOpen, setBrowseOpen] = useState<string | null>(null);
  const [browseFiles, setBrowseFiles] = useState<SavedFile[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [viewFile, setViewFile] = useState<{ path: string; label: string } | null>(null);
  const [confirmDataDelete, setConfirmDataDelete] = useState<ToolDataEntry | null>(null);
  const [deletingData, setDeletingData] = useState(false);

  const handleDelete = useCallback(async (app: ToolsPageMiniApp) => {
    setDeleting(true);
    try {
      // Removes the tool's code only — its input/output files are preserved
      // under tool-data and surface below in "Saved data".
      const result = await window.miniAppsAPI.delete(app.dirName);
      if (!result.ok) throw new Error(result.error);
      setConfirmDelete(null);
      setSettingsOpen(null);
      await refresh();
      await refreshToolData();
      onAppsChanged?.();
    } catch (err) {
      console.error('Failed to delete tool:', err);
    } finally {
      setDeleting(false);
    }
  }, [refresh, refreshToolData, onAppsChanged]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await window.apisAPI.list();
        setConfiguredApis(data.apis
          .filter((a) => a.enabled)
          .map((a) => ({ id: a.id, label: a.label, allowWrites: a.allowWrites })));
      } catch { /* Settings -> APIs will show the real reason */ }
    })();
  }, []);

  const handleToggleApiGrant = useCallback(async (app: ToolsPageMiniApp, apiId: string) => {
    const next = app.apis.includes(apiId)
      ? app.apis.filter((a) => a !== apiId)
      : [...app.apis, apiId];
    const result = await window.miniAppsAPI.setApis(app.dirName, next);
    if (!result.ok) console.error('Failed to update API grants:', result.error);
    await refresh();
    onAppsChanged?.();
  }, [refresh, onAppsChanged]);

  const handleSetArchived = useCallback(async (app: ToolsPageMiniApp, archived: boolean) => {
    const result = await window.miniAppsAPI.setArchived(app.dirName, archived);
    if (!result.ok) console.error('Failed to update archive state:', result.error);
    setSettingsOpen(null);
    await refresh();
    onAppsChanged?.();
  }, [refresh, onAppsChanged]);

  const handleToggleBrowse = useCallback(async (entry: ToolDataEntry) => {
    if (browseOpen === entry.dirName) {
      setBrowseOpen(null);
      return;
    }
    setBrowseOpen(entry.dirName);
    setBrowseLoading(true);
    setBrowseFiles([]);
    try {
      setBrowseFiles(await listSavedFiles(entry.dirName));
    } finally {
      setBrowseLoading(false);
    }
  }, [browseOpen]);

  const handleDeleteData = useCallback(async (entry: ToolDataEntry) => {
    setDeletingData(true);
    try {
      const result = await window.toolDataAPI.delete(entry.dirName);
      if (!result.ok) throw new Error(result.error);
      setConfirmDataDelete(null);
      if (browseOpen === entry.dirName) setBrowseOpen(null);
      await refreshToolData();
    } catch (err) {
      console.error('Failed to delete saved data:', err);
    } finally {
      setDeletingData(false);
    }
  }, [browseOpen, refreshToolData]);

  const activeApps = apps.filter((a) => !a.archived);
  const archivedApps = apps.filter((a) => a.archived);
  // "Saved data" = working files that outlived their tool (deleted tools).
  const savedData = toolData.filter((d) => d.orphaned && d.fileCount > 0);
  const toolCount = activeApps.length;

  return (
    <div className="pageShell">
      <div className="pageShell__inner">
        {/* Page header */}
        <div className="pageShell__headerBlock">
          <div className="pageShell__stats">
            {toolCount} {toolCount === 1 ? 'TOOL' : 'TOOLS'} AVAILABLE
          </div>
          <h1 className="pageShell__title">Tools</h1>
          <p className="pageShell__subtitle">
            Things the workspace can do for you. Ask me to build one, then return to it any time.
          </p>
        </div>

        {/* Ask me CTA */}
        <button className="toolsAskCard" onClick={() => setShowCreateModal(true)}>
          <div className="toolsAskCard__icon">
            <SparklesIcon style={{ width: 20, height: 20 }} />
          </div>
          <div className="toolsAskCard__text">
            <div className="toolsAskCard__title">Ask me to do something or build a tool</div>
            <div className="toolsAskCard__description">Describe what you need &mdash; I&rsquo;ll either do it now as a one-time task, or build it as a tool you can return to.</div>
          </div>
          <ArrowRightIcon className="toolsAskCard__arrow" style={{ width: 18, height: 18 }} />
        </button>

        {/* Tools I've built for you (installed mini-apps) */}
        <section className="toolsSection">
          <h2 className="toolsSection__heading">
            Tools I&rsquo;ve built for you
            <span className="toolsSection__count">{activeApps.length}</span>
          </h2>
          <div className="toolsCard">
            {loading && activeApps.length === 0 ? (
              <div className="toolsSection__empty">Loading...</div>
            ) : (() => {
              if (activeApps.length === 0) {
                return (
                  <div className="toolsSection__empty">
                    {archivedApps.length > 0
                      ? 'All your built tools are archived — restore them from the Archived section below.'
                      : 'You haven’t built any tools yet — describe one above to get started.'}
                  </div>
                );
              }
              return activeApps.map((app, i) => {
                const bordered = i > 0 ? ' toolRow--bordered' : '';
                const Icon = resolveLucideIcon(app.icon);
                return (
                  <div key={`app:${app.dirName}`}>
                    <div className={`toolRow${bordered}`}>
                      <div className="toolRow__icon">
                        <Icon style={{ width: 18, height: 18 }} />
                      </div>
                      <div className="toolRow__info">
                        <div className="toolRow__header">
                          <button
                            className="toolRow__name"
                            onClick={() => onSelectApp(app.dirName, { preBuilt: app.preBuilt })}
                          >
                            {app.name}
                          </button>
                        </div>
                        {app.description && <div className="toolRow__description">{app.description}</div>}
                        {(() => {
                          const status = formatLastUsed(app.lastOpened);
                          return (
                            <div className="toolRow__statusRow">
                              {status && <div className="toolRow__status">{status}</div>}
                              <ToolRowSharing app={app} mode="chip" />
                            </div>
                          );
                        })()}
                      </div>
                      <div className="toolRow__actions">
                        <button
                          className="toolRow__settingsBtn"
                          onClick={() => setSettingsOpen(settingsOpen === app.dirName ? null : app.dirName)}
                        >
                          <ChevronRightIcon style={{ width: 14, height: 14, transform: settingsOpen === app.dirName ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                          Settings
                        </button>
                        <button
                          className="toolRow__primaryBtn"
                          onClick={() => onSelectApp(app.dirName, { preBuilt: app.preBuilt })}
                        >
                          <PlayIcon style={{ width: 14, height: 14 }} />
                          Use
                        </button>
                      </div>
                    </div>
                    {settingsOpen === app.dirName && (
                      <div className="toolRow__settingsPanel">
                        {configuredApis.length > 0 && (
                          <div className="toolRow__grants">
                            <div className="toolRow__grantsLabel">APIs this tool may call</div>
                            {configuredApis.map((api) => (
                              <label key={api.id} className="toolRow__grant">
                                <input
                                  type="checkbox"
                                  checked={app.apis.includes(api.id)}
                                  onChange={() => void handleToggleApiGrant(app, api.id)}
                                />
                                <span>
                                  {api.label}
                                  <span className="toolRow__grantMeta">
                                    {api.allowWrites ? 'read & write' : 'read only'}
                                  </span>
                                </span>
                              </label>
                            ))}
                            <p className="toolRow__grantsHint">
                              Off by default. Acabox attaches the credential, so the
                              tool never sees your key — and it can only do what the
                              API&apos;s own read/write setting already allows.
                            </p>
                          </div>
                        )}
                        <ToolRowSharing
                          app={app}
                          mode="panel"
                          onOpenDialog={(dirName, appName) => setShareDialog({ dirName, appName })}
                        />
                        <div className="toolRow__settingsActions">
                          {onSetPinned && (() => {
                            const isPinned = pinnedDirNames?.has(app.dirName) === true;
                            return (
                              <button
                                className="toolRow__deleteBtn"
                                onClick={() => onSetPinned(app.dirName, !isPinned)}
                              >
                                {isPinned
                                  ? <PinOffIcon style={{ width: 14, height: 14 }} />
                                  : <PinIcon style={{ width: 14, height: 14 }} />}
                                {isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                              </button>
                            );
                          })()}
                          <button
                            className="toolRow__deleteBtn"
                            onClick={() => handleSetArchived(app, true)}
                          >
                            <ArchiveIcon style={{ width: 14, height: 14 }} />
                            Archive tool
                          </button>
                          <button
                            className="toolRow__deleteBtn"
                            onClick={() => setConfirmDelete(app)}
                          >
                            <TrashIcon style={{ width: 14, height: 14 }} />
                            Delete tool
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </section>

        {/* Archived tools — hidden entirely until something is archived */}
        {archivedApps.length > 0 && (
          <section className="toolsSection">
            <h2 className="toolsSection__heading">
              Archived
              <span className="toolsSection__count">{archivedApps.length}</span>
            </h2>
            <div className="toolsCard">
              {archivedApps.map((app, i) => {
                const bordered = i > 0 ? ' toolRow--bordered' : '';
                const Icon = resolveLucideIcon(app.icon);
                return (
                  <div key={`archived:${app.dirName}`} className={`toolRow toolRow--archived${bordered}`}>
                    <div className="toolRow__icon">
                      <Icon style={{ width: 18, height: 18 }} />
                    </div>
                    <div className="toolRow__info">
                      <div className="toolRow__header">
                        <span className="toolRow__name toolRow__name--static">{app.name}</span>
                        <span className="toolRow__tag toolRow__tag--plain">ARCHIVED</span>
                      </div>
                      {app.description && <div className="toolRow__description">{app.description}</div>}
                      {(() => {
                        const status = formatLastUsed(app.lastOpened);
                        return status ? <div className="toolRow__status">{status}</div> : null;
                      })()}
                    </div>
                    <div className="toolRow__actions">
                      <button className="toolRow__settingsBtn" onClick={() => setConfirmDelete(app)}>
                        <TrashIcon style={{ width: 14, height: 14 }} />
                        Delete
                      </button>
                      <button className="toolRow__primaryBtn" onClick={() => handleSetArchived(app, false)}>
                        <ArchiveRestoreIcon style={{ width: 14, height: 14 }} />
                        Restore
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Saved data — input/output files kept from deleted tools */}
        {savedData.length > 0 && (
          <section className="toolsSection">
            <h2 className="toolsSection__heading">
              Saved data
              <span className="toolsSection__count">{savedData.length}</span>
            </h2>
            <p className="toolsSection__note">
              Working files kept from tools you deleted. Delete the data here when you no longer need it.
            </p>
            <div className="toolsCard">
              {savedData.map((entry, i) => {
                const bordered = i > 0 ? ' toolRow--bordered' : '';
                const open = browseOpen === entry.dirName;
                return (
                  <div key={`data:${entry.dirName}`}>
                    <div className={`toolRow${bordered}`}>
                      <div className="toolRow__icon">
                        <DatabaseIcon style={{ width: 18, height: 18 }} />
                      </div>
                      <div className="toolRow__info">
                        <div className="toolRow__header">
                          <span className="toolRow__name toolRow__name--static">{entry.name}</span>
                          <span className="toolRow__tag toolRow__tag--plain">
                            {entry.fileCount} {entry.fileCount === 1 ? 'FILE' : 'FILES'} · {formatBytes(entry.sizeBytes)}
                          </span>
                        </div>
                        {entry.deletedAt && (
                          <div className="toolRow__status">
                            tool deleted {formatLastUsed(entry.deletedAt)?.replace('used ', '') ?? ''}
                          </div>
                        )}
                      </div>
                      <div className="toolRow__actions">
                        <button
                          className="toolRow__settingsBtn"
                          onClick={() => window.filesAPI.revealInFinder(`tool-data/${entry.dirName}`)}
                          title="Show in Finder"
                        >
                          <FolderOpenIcon style={{ width: 14, height: 14 }} />
                          Finder
                        </button>
                        <button className="toolRow__settingsBtn" onClick={() => handleToggleBrowse(entry)}>
                          <ChevronRightIcon style={{ width: 14, height: 14, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                          Browse
                        </button>
                        <button className="toolRow__deleteBtn" onClick={() => setConfirmDataDelete(entry)}>
                          <TrashIcon style={{ width: 14, height: 14 }} />
                          Delete data
                        </button>
                      </div>
                    </div>
                    {open && (
                      <div className="toolRow__settingsPanel">
                        {browseLoading ? (
                          <div className="toolsSection__empty">Loading files…</div>
                        ) : browseFiles.length === 0 ? (
                          <div className="toolsSection__empty">No files found.</div>
                        ) : (
                          <div className="savedFilesList">
                            {browseFiles.map((f) => (
                              <button
                                key={f.relPath}
                                className="savedFilesList__row"
                                onClick={() => setViewFile({ path: f.relPath, label: f.label })}
                              >
                                <FileTextIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
                                <span className="savedFilesList__name">{f.label}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Footer actions */}
        <div className="toolsPage__footer">
          <button className="toolsPage__addBtn" onClick={handleImportTool} disabled={importing}>
            <UploadIcon style={{ width: 16, height: 16 }} />
            {importing ? 'Importing...' : 'Import tool'}
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className="toolsConfirmOverlay" onClick={() => !deleting && setConfirmDelete(null)}>
          <div className="toolsConfirmModal" onClick={(e) => e.stopPropagation()}>
            <h3 className="toolsConfirmModal__title">Delete tool</h3>
            <p className="toolsConfirmModal__message">
              Delete <strong>{confirmDelete.name}</strong>? This removes the tool&rsquo;s code. Any input and output files it saved are kept and stay browsable under <strong>Saved data</strong>.
            </p>
            <div className="toolsConfirmModal__actions">
              <button
                className="toolRow__secondaryBtn"
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="toolRow__deleteBtn"
                onClick={() => handleDelete(confirmDelete)}
                disabled={deleting}
              >
                <TrashIcon style={{ width: 14, height: 14 }} />
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDataDelete && (
        <div className="toolsConfirmOverlay" onClick={() => !deletingData && setConfirmDataDelete(null)}>
          <div className="toolsConfirmModal" onClick={(e) => e.stopPropagation()}>
            <h3 className="toolsConfirmModal__title">Delete saved data</h3>
            <p className="toolsConfirmModal__message">
              Permanently delete the {confirmDataDelete.fileCount} saved file{confirmDataDelete.fileCount === 1 ? '' : 's'} ({formatBytes(confirmDataDelete.sizeBytes)}) from <strong>{confirmDataDelete.name}</strong>? This cannot be undone.
            </p>
            <div className="toolsConfirmModal__actions">
              <button
                className="toolRow__secondaryBtn"
                onClick={() => setConfirmDataDelete(null)}
                disabled={deletingData}
              >
                Cancel
              </button>
              <button
                className="toolRow__deleteBtn"
                onClick={() => handleDeleteData(confirmDataDelete)}
                disabled={deletingData}
              >
                <TrashIcon style={{ width: 14, height: 14 }} />
                {deletingData ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewFile && (
        <div className="toolsConfirmOverlay" onClick={() => setViewFile(null)}>
          <div className="savedFileViewer" onClick={(e) => e.stopPropagation()}>
            <div className="savedFileViewer__header">
              <span className="savedFileViewer__title">{viewFile.label}</span>
              <button className="filePickerModal__close" onClick={() => setViewFile(null)}>
                <XIcon style={{ width: 16, height: 16 }} />
              </button>
            </div>
            <div className="savedFileViewer__body">
              <FileViewer filePath={viewFile.path} />
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <div className="toolsConfirmOverlay" onClick={() => setShowCreateModal(false)}>
          <div className="createToolModal" onClick={(e) => e.stopPropagation()}>
            <button className="createToolModal__close" onClick={() => setShowCreateModal(false)}>&times;</button>
            <h2 className="createToolModal__title">Create a tool</h2>
            <p className="createToolModal__subtitle">
              Describe what you&rsquo;d like your new tool to do and how you want it to work.
            </p>
            <textarea
              className="createToolModal__textarea"
              placeholder="e.g. Analyze scratch assay images and produce closure curves..."
              value={createToolText}
              onChange={(e) => setCreateToolText(e.target.value)}
              rows={5}
              autoFocus
            />
            <div className="createToolModal__actions">
              <button
                className="createToolModal__cancelBtn"
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                className="createToolModal__createBtn"
                onClick={handleCreateTool}
                disabled={!createToolText.trim()}
              >
                Create Tool
              </button>
            </div>
          </div>
        </div>
      )}

      {shareDialog && (
        <SharePublishDialog
          dirName={shareDialog.dirName}
          appName={shareDialog.appName}
          onClose={() => setShareDialog(null)}
        />
      )}
    </div>
  );
}

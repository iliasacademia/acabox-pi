import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crossZip = require('cross-zip');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const extractZip = require('extract-zip');
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { updateManifest, readManifest } from './manifestIO';
import { ensureToolDataLayoutForApp } from './toolDataMigration';
import { APPLICATIONS_DIR, TOOL_DATA_DIR } from '../shared/paths';
import { forgetBuildHealth } from './buildHealth';
import { readToolPin, withToolPin } from './toolPin';
import { isPublishedInfo } from './share/publishedRecord';
import type { PublishedInfo } from '../shared/share';
import {
  IMAGE_EXTENSIONS,
  PDF_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  CSV_EXTENSIONS,
} from '../shared/fileKinds';

const MAX_FILE_SIZE = 10_000_000; // 10 MB
const LATEX_EXTENSIONS = new Set(['tex', 'latex']);
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.config', '.password-store']);

export function assertWithinWorkspace(filePath: string, workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir, filePath);
  if (!resolved.startsWith(workspaceDir + path.sep) && resolved !== workspaceDir) {
    throw new Error('Access denied: path is outside the workspace directory.');
  }
  const relative = path.relative(workspaceDir, resolved);
  const firstSegment = relative.split(path.sep)[0];
  if (SENSITIVE_DIRS.has(firstSegment)) {
    throw new Error('Access denied: cannot access sensitive directories.');
  }
  return resolved;
}

export function assertWithinAllowedDirs(filePath: string, allowedDirs: string[]): string {
  for (const dir of allowedDirs) {
    const resolved = path.resolve(dir, filePath);
    if (!resolved.startsWith(dir + path.sep) && resolved !== dir) continue;
    const relative = path.relative(dir, resolved);
    const firstSegment = relative.split(path.sep)[0];
    if (SENSITIVE_DIRS.has(firstSegment)) continue;
    return resolved;
  }
  throw new Error('Access denied: path is outside allowed directories.');
}

/** True when `resolved` IS one of the allowed roots (workspace or a shared folder). */
export function isAllowedRoot(resolved: string, allowedDirs: string[]): boolean {
  return allowedDirs.some((dir) => path.resolve(dir) === resolved);
}

function validateFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid file name.');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error('File name contains invalid characters.');
  }
  if (trimmed.length > 255) {
    throw new Error('File name is too long.');
  }
  return trimmed;
}

/** A mini-app directory name is a single path segment, never a dotfile. */
function isSafeDirName(dirName: string): boolean {
  return (
    !!dirName &&
    !dirName.includes('/') &&
    !dirName.includes('\\') &&
    !dirName.includes('\0') &&
    !dirName.startsWith('.')
  );
}

/** Recursively count real files (skipping dotfiles) under `dir` with total size. */
function statTree(dir: string): { fileCount: number; sizeBytes: number; lastModified: number } {
  let fileCount = 0;
  let sizeBytes = 0;
  let lastModified = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { fileCount, sizeBytes, lastModified };
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip .tool-meta.json and friends
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = statTree(full);
      fileCount += sub.fileCount;
      sizeBytes += sub.sizeBytes;
      if (sub.lastModified > lastModified) lastModified = sub.lastModified;
    } else {
      try {
        const st = fs.statSync(full);
        fileCount++;
        sizeBytes += st.size;
        if (st.mtimeMs > lastModified) lastModified = st.mtimeMs;
      } catch { /* skip unreadable */ }
    }
  }
  return { fileCount, sizeBytes, lastModified };
}

function requireAllowedPaths(getAllowedPaths: () => string[]): string[] {
  const paths = getAllowedPaths();
  if (paths.length === 0) throw new Error('No active workspace.');
  return paths;
}

export function registerFileHandlers(getAllowedPaths: () => string[], getMainWindow: () => BrowserWindow | null): void {
  let lastDialogDir: string | null = null;

  function getDialogDir(): string | undefined {
    const paths = getAllowedPaths();
    return lastDialogDir ?? paths[0] ?? undefined;
  }

  function updateDialogDir(filePath: string): void {
    lastDialogDir = path.dirname(filePath);
  }

  ipcMain.handle('files:readDirectory', async (_event, dirPath: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const resolved = assertWithinAllowedDirs(dirPath, allowedPaths);

    const entries = await fsPromises.readdir(resolved, { withFileTypes: true });
    return entries
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => ({
        name: e.name,
        path: path.join(resolved, e.name),
        isDirectory: e.isDirectory(),
      }));
  });

  ipcMain.handle(
    'files:findByExtension',
    async (_event, extensions: string[]): Promise<{ relPath: string; mtimeMs: number }[]> => {
      const allowedPaths = requireAllowedPaths(getAllowedPaths);
      const exts = new Set(
        extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()),
      );
      const SKIP = new Set([
        '.git',
        'node_modules',
        '__pycache__',
        '.applications',
        '.academia',
      ]);
      const results: { relPath: string; path: string; mtimeMs: number; size: number }[] = [];
      function walk(dir: string, rootDir: string): void {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
          if (e.name.startsWith('~$')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full, rootDir);
          } else if (exts.has(path.extname(e.name).toLowerCase())) {
            try {
              const st = fs.statSync(full);
              results.push({
                relPath: path.relative(rootDir, full),
                path: full,
                mtimeMs: st.mtimeMs,
                size: st.size,
              });
            } catch { /* ignore */ }
          }
        }
      }
      for (const ap of allowedPaths) {
        walk(ap, ap);
      }
      results.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return results;
    },
  );

  ipcMain.handle('files:exists', async (_event, filePath: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    try {
      const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
      await fsPromises.access(resolved);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('files:findByName', async (_event, filename: string, hintDirs: string[]) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);

    // Try hint directories first (from message context)
    for (const hint of hintDirs) {
      try {
        const candidate = path.join(hint, filename);
        const resolved = assertWithinAllowedDirs(candidate, allowedPaths);
        await fsPromises.access(resolved);
        return candidate;
      } catch { /* continue */ }
    }

    const matches: { rel: string; mtime: number }[] = [];
    for (const ap of allowedPaths) {
      let entries: fs.Dirent[];
      try {
        entries = await fsPromises.readdir(ap, { recursive: true, withFileTypes: true });
      } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name === filename) {
          const full = path.join(entry.parentPath, entry.name);
          const rel = path.relative(ap, full);
          try {
            const stat = await fsPromises.stat(full);
            matches.push({ rel, mtime: stat.mtimeMs });
          } catch { /* skip */ }
        }
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].rel;
  });

  ipcMain.handle('files:readFile', async (_event, filePath: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const resolved = assertWithinAllowedDirs(filePath, allowedPaths);

    const ext = path.extname(resolved).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      return { type: 'image' as const, fileUrl: `local-file://${resolved}` };
    }
    if (PDF_EXTENSIONS.has(ext)) {
      // PDFs render in an iframe via the local-file protocol — no in-process read needed.
      return { type: 'pdf' as const, fileUrl: `local-file://${resolved}` };
    }

    const stats = await fsPromises.stat(resolved);
    if (stats.size > MAX_FILE_SIZE) {
      return { error: 'too-large' as const, size: stats.size };
    }

    if (SPREADSHEET_EXTENSIONS.has(ext)) {
      // Excel/ODS files are binary. Read as a buffer and send base64 over IPC;
      // SheetJS in the renderer parses base64 directly.
      const buffer = await fsPromises.readFile(resolved);
      return { type: 'spreadsheet' as const, base64: buffer.toString('base64'), ext };
    }

    const content = await fsPromises.readFile(resolved, 'utf-8');
    if (MARKDOWN_EXTENSIONS.has(ext)) {
      return { type: 'markdown' as const, content };
    }
    if (CSV_EXTENSIONS.has(ext)) {
      // Empty delimiter triggers Papa Parse auto-detection (handles ',', ';', '|', etc.).
      // For .tsv we force tab since the extension is unambiguous.
      return { type: 'csv' as const, content, delimiter: ext === 'tsv' ? '\t' : '' };
    }
    return { type: 'text' as const, content };
  });

  ipcMain.handle(
    'files:copyToWorkspace',
    async (event, sourcePaths: string[], destinationDir: string) => {
      const allowedPaths = requireAllowedPaths(getAllowedPaths);
      const resolvedDir = assertWithinAllowedDirs(destinationDir, allowedPaths);
      await fsPromises.mkdir(resolvedDir, { recursive: true });

      const total = sourcePaths.length;
      let copied = 0;
      for (const src of sourcePaths) {
        const basename = path.basename(src);
        event.sender.send('files:copyProgress', { copied, total, currentName: basename });
        const dest = path.join(resolvedDir, basename);
        assertWithinAllowedDirs(dest, allowedPaths);
        const stat = await fsPromises.stat(src);
        if (stat.isDirectory()) {
          await fsPromises.cp(src, dest, { recursive: true });
        } else {
          await fsPromises.copyFile(src, dest);
        }
        copied++;
      }
      event.sender.send('files:copyProgress', { copied, total, currentName: null });
      return { copied };
    },
  );

  ipcMain.handle(
    'files:moveFile',
    async (_event, sourcePath: string, destinationDir: string) => {
      const allowedPaths = requireAllowedPaths(getAllowedPaths);
      const resolvedSrc = assertWithinAllowedDirs(sourcePath, allowedPaths);
      const resolvedDir = assertWithinAllowedDirs(destinationDir, allowedPaths);

      const basename = path.basename(resolvedSrc);
      const dest = path.join(resolvedDir, basename);
      assertWithinAllowedDirs(dest, allowedPaths);
      await fsPromises.rename(resolvedSrc, dest);
    },
  );

  ipcMain.handle('files:deleteFile', async (_event, filePath: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
    await fsPromises.rm(resolved, { recursive: true });
  });

  // The user-facing delete. Unlike files:deleteFile (a silent rm the mini-app
  // bridge relies on) this is recoverable, and it refuses the roots themselves:
  // trashing a shared folder's root is not a file operation.
  ipcMain.handle('files:trashFile', async (_event, filePath: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
    if (isAllowedRoot(resolved, allowedPaths)) {
      throw new Error('Cannot move a shared folder or the workspace root to the Trash.');
    }
    await shell.trashItem(resolved);
  });

  ipcMain.handle(
    'files:renameFile',
    async (_event, filePath: string, newName: string) => {
      const allowedPaths = requireAllowedPaths(getAllowedPaths);
      const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
      const validName = validateFileName(newName);
      const newPath = path.join(path.dirname(resolved), validName);
      assertWithinAllowedDirs(newPath, allowedPaths);
      await fsPromises.rename(resolved, newPath);
    },
  );

  ipcMain.handle(
    'files:createFile',
    async (_event, filePath: string) => {
      const allowedPaths = requireAllowedPaths(getAllowedPaths);
      const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
      validateFileName(path.basename(resolved));
      await fsPromises.writeFile(resolved, '', { flag: 'wx' });
    },
  );

  ipcMain.handle(
    'files:createDirectory',
    async (_event, dirPath: string) => {
      const allowedPaths = requireAllowedPaths(getAllowedPaths);
      const resolved = assertWithinAllowedDirs(dirPath, allowedPaths);
      validateFileName(path.basename(resolved));
      await fsPromises.mkdir(resolved);
    },
  );

  ipcMain.handle(
    'files:writeFile',
    async (_event, filePath: string, content: string) => {
      const allowedPaths = requireAllowedPaths(getAllowedPaths);
      const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
      await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
      await fsPromises.writeFile(resolved, content, 'utf-8');
    },
  );

  ipcMain.handle(
    'files:downloadFile',
    async (_event, filename: string, content: string) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return { ok: false, error: 'No main window' };

      const dir = getDialogDir();
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: dir ? path.join(dir, filename) : filename,
      });

      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }

      updateDialogDir(result.filePath);
      await fsPromises.writeFile(result.filePath, content, 'utf-8');
      return { ok: true, savedPath: result.filePath };
    },
  );

  ipcMain.handle('files:showInFinder', async (_event, filePath: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
    await shell.openPath(resolved);
  });

  ipcMain.handle('files:revealInFinder', async (_event, filePath: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const resolved = assertWithinAllowedDirs(filePath, allowedPaths);
    shell.showItemInFolder(resolved);
  });

  ipcMain.handle('files:selectFile', async (_event, filters?: { name: string; extensions: string[] }[]) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getDialogDir(),
      properties: ['openFile'],
      filters: filters ?? undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    updateDialogDir(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('files:selectDirectory', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getDialogDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    updateDialogDir(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('miniApps:list', async () => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const appsDir = path.join(allowedPaths[0], '.applications');

    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(appsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const apps = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map(async (e) => {
          const dirName = e.name;
          const manifestPath = path.join(appsDir, dirName, 'manifest.json');
          let manifest: { name?: unknown; description?: unknown; icon?: unknown; lastOpened?: unknown; lastRun?: unknown; preBuilt?: unknown; archived?: unknown; pinned?: unknown; pinnedAt?: unknown; apis?: unknown; published?: unknown } | null = null;
          try {
            const raw = await fsPromises.readFile(manifestPath, 'utf-8');
            manifest = JSON.parse(raw);
          } catch {
            // missing or unreadable — fall through to dir-name fallback
          }
          const fallbackName = dirName.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
          return {
            dirName,
            name: typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name : fallbackName,
            description: typeof manifest?.description === 'string' ? manifest.description : null,
            icon: typeof manifest?.icon === 'string' ? manifest.icon : null,
            lastOpened: typeof manifest?.lastOpened === 'string' ? manifest.lastOpened : null,
            lastRun: typeof manifest?.lastRun === 'string' ? manifest.lastRun : null,
            preBuilt: manifest?.preBuilt === true,
            archived: manifest?.archived === true,
            // Pinned to the rail by the user; `pinnedAt` keeps pins in the
            // order they were made (main/toolPin.ts).
            ...readToolPin(manifest),
            // Which configured APIs this tool has been GRANTED. Travels with
            // the folder on export, deliberately: a shared tool should declare
            // what it wants to reach. It is not a capability — the grant only
            // matters against the importing user's OWN configured APIs and
            // their own credentials, and an unknown id simply never matches.
            apis: Array.isArray(manifest?.apis)
              ? (manifest.apis as unknown[]).filter((a): a is string => typeof a === 'string')
              : [],
            hasManifest: manifest !== null,
            // Set by `main/share/publishedRecord.ts::writePublished` when the
            // app is shared (docs/design/sharing.md). Same validation the
            // module itself uses on read, so a hand-edited or malformed
            // value here reads as "not published" rather than crashing the
            // Tools page or the SHARED chip.
            published: (isPublishedInfo(manifest?.published) ? manifest.published : null) as PublishedInfo | null,
          };
        }),
    );

    return apps;
  });

  ipcMain.handle('miniApps:touch', async (_event, dirName: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, error: 'Invalid app name' };
    }
    const manifestPath = path.join(allowedPaths[0], '.applications', dirName, 'manifest.json');

    // A missing manifest reaches the mutator as {} — touching just records
    // the lastOpened timestamp; name/description/icon stay missing until the
    // migration job (or skill) writes them.
    try {
      await updateManifest(manifestPath, (manifest) => {
        manifest.lastOpened = new Date().toISOString();
        return manifest;
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Stamped when a tool finishes executing something (kernel/shell/Claude call,
  // or an agent MCP invocation), which is what the home card's "LAST RUN" means
  // — distinct from `lastOpened`, which only records the user looking at it.
  ipcMain.handle('miniApps:markRun', async (_event, dirName: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, error: 'Invalid app name' };
    }
    const manifestPath = path.join(allowedPaths[0], '.applications', dirName, 'manifest.json');
    try {
      await updateManifest(manifestPath, (manifest) => {
        manifest.lastRun = new Date().toISOString();
        return manifest;
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  /**
   * Grant or revoke this tool's access to configured APIs.
   *
   * The grant lives in the tool's own manifest rather than in host settings so
   * it travels with the folder — but it is NOT a capability the folder carries:
   * `apis:request` checks the id against the importing user's own configured
   * APIs, and their credentials never leave the host. An exported tool
   * declaring `["hex"]` gets nothing on a machine with no Hex configured.
   */
  ipcMain.handle('miniApps:setApis', async (_event, dirName: string, apis: string[]) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, error: 'Invalid app name' };
    }
    const manifestPath = path.join(allowedPaths[0], '.applications', dirName, 'manifest.json');
    const clean = [...new Set((Array.isArray(apis) ? apis : []).filter((a) => typeof a === 'string' && a))];
    try {
      await updateManifest(manifestPath, (manifest) => {
        if (clean.length) manifest.apis = clean;
        else delete manifest.apis;
        return manifest;
      });
      return { ok: true, apis: clean };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle('miniApps:setArchived', async (_event, dirName: string, archived: boolean) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, error: 'Invalid app name' };
    }
    const appDir = path.join(allowedPaths[0], '.applications', dirName);
    try {
      await fsPromises.stat(appDir);
    } catch {
      return { ok: false, error: 'App not found' };
    }
    const manifestPath = path.join(appDir, 'manifest.json');

    try {
      await updateManifest(manifestPath, (manifest) => {
        if (archived) {
          manifest.archived = true;
          manifest.archivedAt = new Date().toISOString();
        } else {
          delete manifest.archived;
          delete manifest.archivedAt;
        }
        return manifest;
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Pin or unpin a tool in the rail. Kept in the manifest beside `archived`;
  // an archived tool keeps its pin but the rail shows active tools only.
  ipcMain.handle('miniApps:setPinned', async (_event, dirName: string, pinned: boolean) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    if (!isSafeDirName(dirName)) return { ok: false, error: 'Invalid app name' };
    const appDir = path.join(allowedPaths[0], APPLICATIONS_DIR, dirName);
    try {
      await fsPromises.stat(appDir);
    } catch {
      return { ok: false, error: 'App not found' };
    }
    try {
      await updateManifest(path.join(appDir, 'manifest.json'), (manifest) => withToolPin(manifest, pinned === true));
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Delete a tool's CODE while preserving its working data. The tool's
  // `input`/`output` are symlinks into `tool-data/<dir>/`; removing the code dir
  // leaves that data intact so it survives under "Saved data".
  ipcMain.handle('miniApps:delete', async (_event, dirName: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    if (!isSafeDirName(dirName)) return { ok: false, error: 'Invalid app name' };
    // A deleted tool must not leave a "broken" record behind — a tool created
    // later with the same dir name would inherit it.
    forgetBuildHealth(dirName);

    const workspaceDir = allowedPaths[0];
    const appDir = path.join(workspaceDir, APPLICATIONS_DIR, dirName);
    try {
      await fsPromises.stat(appDir);
    } catch {
      return { ok: false, error: 'App not found' };
    }

    // Preserve working data and label it for the "Saved data" view. If the tool
    // never produced any files, drop the empty data dir instead of leaving litter.
    const dataDir = path.join(workspaceDir, TOOL_DATA_DIR, dirName);
    try {
      if (statTree(dataDir).fileCount > 0) {
        const manifest = await readManifest(path.join(appDir, 'manifest.json'));
        const name =
          typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name : dirName;
        await fsPromises.writeFile(
          path.join(dataDir, '.tool-meta.json'),
          JSON.stringify({ name, deletedAt: new Date().toISOString() }, null, 2) + '\n',
          'utf-8',
        );
      } else {
        await fsPromises.rm(dataDir, { recursive: true, force: true });
      }
    } catch (e) {
      log.warn('[ToolData] Failed to preserve data for', dirName, e);
    }

    // Unlink the data symlinks first, then remove the code dir. fs.rm does not
    // follow symlinks, but unlinking explicitly makes the "data is never
    // touched" guarantee self-evident.
    for (const sub of ['input', 'output']) {
      const linkPath = path.join(appDir, sub);
      try {
        const st = await fsPromises.lstat(linkPath);
        if (st.isSymbolicLink()) await fsPromises.unlink(linkPath);
      } catch { /* absent — fine */ }
    }
    try {
      await fsPromises.rm(appDir, { recursive: true, force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle('miniApps:export', async (_event, dirName: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const mainWindow = getMainWindow();
    if (!mainWindow) return { ok: false, error: 'No main window' };

    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, error: 'Invalid app name' };
    }

    const appDir = path.join(allowedPaths[0], '.applications', dirName);
    try {
      await fsPromises.stat(appDir);
    } catch {
      return { ok: false, error: 'App not found' };
    }

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(os.homedir(), `${dirName}.zip`),
      filters: [{ name: 'Mini App', extensions: ['zip'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { ok: false, canceled: true };

    const outZip = saveResult.filePath.endsWith('.zip') ? saveResult.filePath : `${saveResult.filePath}.zip`;
    const tmpDir = path.join(os.tmpdir(), `academia-export-${Date.now()}`);
    const tmpAppDir = path.join(tmpDir, dirName);

    try {
      await fsPromises.mkdir(tmpAppDir, { recursive: true });

      // Copy full app contents. `dereference` resolves the input/output
      // symlinks so the exported zip carries the real working files rather than
      // dangling links into this machine's tool-data dir.
      await fsPromises.cp(appDir, tmpAppDir, { recursive: true, dereference: true });

      await new Promise<void>((resolve, reject) => {
        crossZip.zip(tmpAppDir, outZip, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      return { ok: true, savedPath: outZip };
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('miniApps:import', async (_event) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const mainWindow = getMainWindow();
    if (!mainWindow) return { ok: false, error: 'No main window' };

    const openResult = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Mini App', extensions: ['zip'] }],
    });
    if (openResult.canceled || openResult.filePaths.length === 0) return { ok: false, canceled: true };

    const zipPath = openResult.filePaths[0];
    const tmpDir = path.join(os.tmpdir(), `academia-import-${Date.now()}`);

    try {
      await fsPromises.mkdir(tmpDir, { recursive: true });
      await extractZip(zipPath, { dir: tmpDir });

      const extracted = await fsPromises.readdir(tmpDir, { withFileTypes: true });
      const appDirs = extracted.filter((e) => e.isDirectory());
      if (appDirs.length === 0) return { ok: false, error: 'No app directory found in zip' };

      const baseName = appDirs[0].name;
      const sourceDir = path.join(tmpDir, baseName);
      const appsDir = path.join(allowedPaths[0], '.applications');
      await fsPromises.mkdir(appsDir, { recursive: true });

      // Find a non-colliding name
      let finalDirName = baseName;
      let suffix = 1;
      for (;;) {
        try {
          await fsPromises.stat(path.join(appsDir, finalDirName));
          finalDirName = `${baseName}_${suffix++}`;
        } catch {
          break;
        }
      }

      await fsPromises.cp(sourceDir, path.join(appsDir, finalDirName), { recursive: true });
      // An imported app carries its input/output as real dirs; split them out to
      // tool-data + symlinks so it matches the rest of the workspace.
      try {
        ensureToolDataLayoutForApp(allowedPaths[0], finalDirName);
      } catch (e) {
        log.warn('[ToolData] Failed to normalize imported app', finalDirName, e);
      }
      return { ok: true, dirName: finalDirName };
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // --- Saved tool data (durable input/output that outlives the tool) ---

  ipcMain.handle('toolData:list', async () => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    const workspaceDir = allowedPaths[0];
    const toolDataDir = path.join(workspaceDir, TOOL_DATA_DIR);

    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(toolDataDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const out = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map(async (e) => {
          const dirName = e.name;
          const dir = path.join(toolDataDir, dirName);
          const { fileCount, sizeBytes, lastModified } = statTree(dir);
          const orphaned = !fs.existsSync(path.join(workspaceDir, APPLICATIONS_DIR, dirName));

          let name = dirName;
          let deletedAt: string | null = null;
          const meta = await readManifest(path.join(dir, '.tool-meta.json'));
          if (meta) {
            if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name;
            if (typeof meta.deletedAt === 'string') deletedAt = meta.deletedAt;
          }
          if (!orphaned) {
            const live = await readManifest(
              path.join(workspaceDir, APPLICATIONS_DIR, dirName, 'manifest.json'),
            );
            if (live && typeof live.name === 'string' && live.name.trim()) name = live.name;
          }

          return {
            dirName,
            name,
            orphaned,
            deletedAt,
            fileCount,
            sizeBytes,
            lastModified: lastModified || null,
          };
        }),
    );

    out.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    return out;
  });

  ipcMain.handle('toolData:delete', async (_event, dirName: string) => {
    const allowedPaths = requireAllowedPaths(getAllowedPaths);
    if (!isSafeDirName(dirName)) return { ok: false, error: 'Invalid name' };
    const dir = path.join(allowedPaths[0], TOOL_DATA_DIR, dirName);
    try {
      await fsPromises.rm(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Re-encodes any image the Messages API cannot read (TIFF, HEIC, BMP, AVIF)
  // to PNG. `sips` identifies the format from the file's contents, not its
  // extension — verified — so the input temp name carries no format claim.
  // It cannot rasterize vector art; an SVG makes this reject, and the caller
  // falls back to handing the agent a workspace path.
  ipcMain.handle('image:convertToPng', async (_event, base64Data: string) => {
    // Unique per call, not per millisecond: attaching several photos at once
    // converts them concurrently, and `Date.now()` alone collides — the two
    // calls would then clobber each other's temp files.
    const stem = path.join(os.tmpdir(), `convert-${randomUUID()}`);
    const tmpInput = `${stem}.img`;
    const tmpOutput = `${stem}.png`;
    try {
      await fsPromises.writeFile(tmpInput, Buffer.from(base64Data, 'base64'));
      await new Promise<void>((resolve, reject) => {
        execFile('sips', ['-s', 'format', 'png', tmpInput, '--out', tmpOutput], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const pngBuffer = await fsPromises.readFile(tmpOutput);
      return pngBuffer.toString('base64');
    } finally {
      fsPromises.rm(tmpInput, { force: true }).catch(() => {});
      fsPromises.rm(tmpOutput, { force: true }).catch(() => {});
    }
  });

  // --- Workspace file watcher ---
  // Watch the workspace directory for changes (files created/deleted by
  // container commands, etc.) and notify the renderer so the file tree
  // refreshes automatically.
  const WATCHER_DEBOUNCE_MS = 1000;
  let watcher: fs.FSWatcher | null = null;
  let watchedPath: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function startWatcher(): void {
    const paths = getAllowedPaths();
    const primaryDir = paths[0];
    if (!primaryDir || watchedPath === primaryDir) return;

    if (watcher) {
      watcher.close();
      watcher = null;
    }
    watchedPath = primaryDir;

    try {
      watcher = fs.watch(primaryDir, { recursive: true }, () => {
        // Debounce: many events fire in rapid succession during a script run
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('files:workspaceChanged');
          }
        }, WATCHER_DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        // Silently ignore watcher errors (e.g., directory deleted)
        if (watcher) { watcher.close(); watcher = null; }
      });
    } catch {
      // fs.watch may not be supported on all platforms/filesystems
    }
  }

  // Start the watcher after a short delay (workspace may not be set yet at registration time)
  setTimeout(startWatcher, 2000);
  // Re-check periodically in case the workspace changes
  setInterval(startWatcher, 10000);
}

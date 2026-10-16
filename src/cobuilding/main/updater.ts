import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { checkSelfUpdateSupported, runSelfUpdate, UpdateFileInfo } from './selfUpdater';
import { ENV_PREFIX, RELEASE_OWNER, RELEASE_REPO } from '../shared/product';

declare const COBUILD_UPDATE_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILD_UPDATE_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// --- Release feed configuration -------------------------------------------
// Acabox publishes packaged binaries + electron-updater metadata to GitHub
// Releases (see scripts/release.mjs). The app SOURCE repo can stay private,
// but for the *installed* app to download updates without shipping a token,
// the RELEASE repo must be PUBLIC. Recommended: a dedicated public repo that
// holds only built artifacts:
//     gh repo create iliasacademia/acabox-pi-releases --public
//
// The baked-in defaults below are what production builds use. The env
// overrides exist only for testing against a different repo.
const UPDATE_OWNER = process.env[`${ENV_PREFIX}_UPDATE_OWNER`] || RELEASE_OWNER;
const UPDATE_REPO = process.env[`${ENV_PREFIX}_UPDATE_REPO`] || RELEASE_REPO;
// Set ONLY if the release repo is PRIVATE — NOT recommended: the token ships
// inside the app bundle and is extractable. Prefer a public release repo.
const UPDATE_TOKEN = process.env[`${ENV_PREFIX}_UPDATE_TOKEN`] || undefined;

let updateWindow: BrowserWindow | null = null;
let updaterConfigured = false;
let isManualCheck = false;
let pendingUpdateVersion: string | null = null;
// The manifest entry for the pending update. electron-updater hands us the
// parsed `latest-mac.yml`; we install from it ourselves (see selfUpdater.ts),
// so we hold onto the payload list rather than letting Squirrel fetch it.
let pendingUpdateFiles: UpdateFileInfo[] = [];

function createUpdateWindow(version: string) {
  if (updateWindow) {
    updateWindow.focus();
    return;
  }

  pendingUpdateVersion = version;

  updateWindow = new BrowserWindow({
    width: 400,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Update Available',
    show: false,
    webPreferences: {
      preload: COBUILD_UPDATE_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  updateWindow.loadURL(COBUILD_UPDATE_WINDOW_WEBPACK_ENTRY);

  updateWindow.once('ready-to-show', () => {
    updateWindow?.show();
  });

  updateWindow.on('closed', () => {
    updateWindow = null;
    pendingUpdateVersion = null;
    pendingUpdateFiles = [];
  });
}

export function setupUpdater(onRebuildTrayMenu: (statusLabel?: string) => void) {
  if (!app.isPackaged) {
    log.info('[UPDATER] Skipping updater setup (not packaged).');
    return;
  }

  if (!UPDATE_OWNER || !UPDATE_REPO) {
    log.warn('[UPDATER] Skipping updater setup (no release repo configured).');
    return;
  }

  autoUpdater.autoDownload = false; // prompt the user before downloading
  // electron-updater is used for DETECTION ONLY. Squirrel.Mac cannot install
  // onto an ad-hoc-signed build (see selfUpdater.ts), so nothing may hand it a
  // payload — including the quit-time install path, which would otherwise fire
  // silently and fail.
  autoUpdater.autoInstallOnAppQuit = false;

  // GitHub Releases feed. The default channel ('latest') matches the
  // `latest-mac.yml` / `latest.yml` metadata that scripts/release.mjs
  // attaches to each release. Fork isolation is inherent — we point at the
  // Acabox release repo, never the upstream Coscientist feed.
  const feed: Parameters<typeof autoUpdater.setFeedURL>[0] = UPDATE_TOKEN
    ? { provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO, private: true, token: UPDATE_TOKEN }
    : { provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO };

  autoUpdater.setFeedURL(feed);
  log.info(`[UPDATER] Configured GitHub Releases feed: ${UPDATE_OWNER}/${UPDATE_REPO}`);

  autoUpdater.on('update-available', (info) => {
    log.info('[UPDATER] Update available:', info.version);
    pendingUpdateFiles = (info.files ?? []) as UpdateFileInfo[];
    createUpdateWindow(info.version);
    onRebuildTrayMenu(`Update available: v${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[UPDATER] No update available.');
    onRebuildTrayMenu('Up to date');

    if (isManualCheck) {
      isManualCheck = false;
      const now = new Date();
      const checkedAt = now.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      dialog.showMessageBox({
        type: 'info',
        title: 'No updates available',
        message: "You're on the latest version",
        detail: `Version: ${app.getVersion()}\nChecked at: ${checkedAt}`,
      });
    }
  });

  // No 'download-progress' / 'update-downloaded' handlers: we never call
  // autoUpdater.downloadUpdate(), so neither ever fires. Progress for the
  // self-update download is emitted from the IPC handler below.

  autoUpdater.on('error', (err) => {
    log.error('[UPDATER] Error:', err.message);
    updateWindow?.webContents.send('cobuild:update-error', { message: err.message });
    onRebuildTrayMenu();
  });

  updaterConfigured = true;

  // Report installability at boot rather than after a user has sat through a
  // ~180MB download. Not fatal — detection still has value if the swap can't run.
  void checkSelfUpdateSupported().then((support) => {
    if (support.ok) log.info(`[UPDATER] Self-update available for ${support.bundlePath}`);
    else log.warn(`[UPDATER] Self-update unavailable: ${support.reason}`);
  });

  // Silent check shortly after launch. Any failure (no release yet, offline,
  // private-repo 404, unsigned-install on macOS) is caught by the 'error'
  // handler above and logged — it never blocks or crashes the app.
  setTimeout(() => checkForUpdates(false), 10_000);
}

export function setupUpdaterIpcHandlers() {
  ipcMain.handle('cobuild:download-and-restart', async () => {
    if (!updaterConfigured || !pendingUpdateVersion) return null;

    log.info(`[UPDATER] Starting self-update to v${pendingUpdateVersion}...`);
    try {
      // Resolves only by quitting the app; a return means it did not install.
      await runSelfUpdate({
        version: pendingUpdateVersion,
        files: pendingUpdateFiles,
        owner: UPDATE_OWNER,
        repo: UPDATE_REPO,
        onProgress: (percent) => {
          updateWindow?.webContents.send('cobuild:download-progress', { percent });
        },
      });
      return null;
    } catch (err) {
      const message = (err as Error).message;
      log.error('[UPDATER] Self-update failed:', message);
      // Reported to the update window rather than thrown: a rejected invoke
      // reaches the renderer wrapped in "Error invoking remote method …",
      // which would put IPC plumbing in front of the actual reason.
      updateWindow?.webContents.send('cobuild:update-error', { message });
      return null;
    }
  });

  ipcMain.handle('cobuild:get-update-version', () => {
    return pendingUpdateVersion;
  });

  ipcMain.handle('cobuild:cancel-update', () => {
    updateWindow?.close();
    return null;
  });
}

export function isUpdaterConfigured(): boolean {
  return updaterConfigured;
}

export function checkForUpdates(manual?: boolean) {
  isManualCheck = !!manual;
  autoUpdater.checkForUpdates();
}

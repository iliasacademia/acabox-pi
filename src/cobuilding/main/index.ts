import { app, BrowserWindow, dialog, globalShortcut, ipcMain, net, protocol, shell, systemPreferences, webContents } from 'electron';
import { WorkspaceController } from './controllers/WorkspaceController';
import { AgentInfrastructureController } from './controllers/AgentInfrastructureController';
import { miniAppMcpRegistry } from './miniAppMcpRegistry';
import { readManifest, updateManifest } from './manifestIO';
import { registerWorkspaceHandlers } from './ipc/workspaceIpc';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { registerFileHandlers, assertWithinAllowedDirs } from './fileHandlers';
import { registerShareHandlers, recomputeAndBroadcastApp } from './share/shareHandlers';
import { migratePlaintextShareToken } from './share/shareStore';
import { setBuildSucceededHandler } from './miniAppBuilder';
import { installExternalLinkGuards } from './externalLinks';
import { registerSystemStatsHandlers } from './systemStats';
import { registerDictationHandlers, stopDictation } from './dictationService';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { createAgentSession } from './agentSession';
import { createCalendarAgentSession } from './calendarAgentSession';
import type { CalendarMutationEvent } from './calendarAgentSession';
import { registerSession, unregisterSession, stopSession, getRegisteredSession, hasSession, destroyAllSessions, addSubscriber, removeSubscriber, onSessionDestroyed } from './sessionRegistry';
import { getChatActivity, onChatActivityChanged, onChatTurnBoundary, setChatWindowFocused, setViewingChat } from './chatActivity';
import type { IPCAttachment } from '../shared/types';
import { parseStoredQuote } from '../shared/quotes';
import { chatTotalCost } from '../shared/turnCost';
import { isPlaceholderTitle } from '../shared/sessionTitle';
import { provisionWorkspace } from './skills';
import {
  createSkill,
  deleteSkill,
  dismissFileUpdate,
  listSkills,
  readSkillFile,
  readSkillsState,
  restoreAllBuiltins,
  revertFile,
  revertSkill,
  setSkillEnabled,
  skillStorePath,
  summarizeBuiltinRestore,
  writeSkillFile,
} from './skillStore';
import { renderSkills } from './skillRender';
import { buildSkillRuntimeConfig, parseSkillFrontmatter, validateSkillId } from '../shared/skills';
import {
  countActiveFindings,
  readLedger,
  setBlastRadiusSearchPaths,
  supersedeFinding,
  LAST_READ_GRANULARITY_NOTE,
} from './knowledge/findingsLedger';
import { dismissKnowledgeReview, listKnowledgeReviews } from './knowledge/omissionWatch';
import {
  commitImport,
  disposeImportCaches,
  loadCatalogue,
  parseImportUrl,
  previewImport,
  type ImportProgress,
  type ImportRequest,
  type ImportUrlTarget,
} from './knowledge/skillImportService';
import { containerService } from './containerService';
import { listBuildHealth, subscribeBuildHealth, forgetBuildHealth, type BuildHealth } from './buildHealth';
import { createTeardown, handleBeforeQuit, handleWillQuit } from './appTeardown';
import * as mcpHost from './mcpHost';
import { reconcileOrphans, registerHostedServer, updateHostedServer, removeHostedServer } from './mcpHost/store';
import {
  beginJob,
  endJob,
  listJobs,
  activeJobs,
  cancelJob,
  cancelAll,
  acknowledgeTool,
  reconcileOnBoot,
  subscribe as subscribeToJobs,
  setRunCompletedHandler,
  setCancelRequestHandler,
  interruptJobsForWebContents,
  type ToolJob,
  type JobKind,
} from './jobRegistry';
import {
  listConnectors,
  listConnectorsWithSecrets,
  migratePlaintextConnectorSecrets,
  upsertConnector,
  removeConnector,
  setConnectorEnabled,
  detectUnmanagedMcpJson,
  removeUnmanagedMcpJson,
  recordConnectorStatus,
  getConnectorStatus,
  subscribeConnectorStatus,
} from './connectorsStore';
import { buildMcpServers, CONNECTOR_CATALOG, type ConnectorConfig } from '../shared/connectors';
import {
  listApis,
  upsertApi,
  removeApi,
  setApiEnabled,
  setApiAllowWrites,
  migratePlaintextApiSecrets,
  getApiCounters,
} from './apiStore';
import { apiProxy, callerWithGrants, performApiRequest, setToolGrantResolver } from './apiProxy';
import { allowedModelIds, BACKGROUND_MODEL, BACKGROUND_REQUEST, DEFAULT_MODEL, mergeModels, messageText } from '../shared/models';
import { discoveredModels, discoveryError, refreshModels } from './modelCatalog';
import { API_CATALOG, interpretApiTest, type ApiConfig } from '../shared/apis';
import { buildApiKeyStatus } from '../shared/apiKeyCheck';
import { checkAnthropicKey } from './apiKeyCheck';
import { decryptSecret, encryptSecret, isEncrypted, isEncryptionAvailable } from './secretStore';
import { convertReferenceFile } from './directoryScanner/agents/fileTagging';
import { getReport, getLatestReport, updateReportData } from './db/reportRepository';
import {
  listBriefings,
  setBriefingStatus,
  type BriefingStatus,
  type ListBriefingsFilter,
} from './db/briefingsRepository';
import { getScannedFilesByType, getScannedFiles, updateFileTag, removeFileTag } from './db/scannedFilesRepository';
import { kernelGatewayService } from './kernelGatewayService';
import { initDatabase, getDatabase, closeDatabase } from './db/database';
import { initObservationsDatabase, getObservationsDatabase, closeObservationsDatabase } from './db/observationsDatabase';
import {
  listSessions,
  listSessionsByDocPathLike,
  setSessionDocumentPath,
  getSession,
  listResultCostRows,
  createSession,
  updateSessionTitle,
  deleteSession,
  listSdkSessionIds,
  getMessages,
  findSessionForApp,
  findMessageByMessageId,
  listSessionsForApp,
  setSessionAppDirName,
  setSessionModelInfo,
  countMessages,
} from './db/chatRepository';
import { listChatPreviews, searchChatProse } from './db/chatSearch';
import { listWorkspaceDirectories } from './db/workspaceRepository';
import { setupUpdater, setupUpdaterIpcHandlers } from './updater';
import { createTray, createDockIcon, rebuildTrayMenu, setShowWindowCallback } from './tray';
import { BriefingsController } from './controllers/BriefingsController';
import { initFileMonitor, startFileMonitor, stopFileMonitor, isFileMonitorRunning } from './fileMonitor';
import { getAllFileSessions, getTodayFileSessions } from './fileMonitor/repository';
import { initActivityQuery } from './activityQuery';
import { initSessionFiles, getAllSessionFiles } from './db/sessionFilesRepository';
import { initSchedulingDatabase, getSchedulingDatabase, closeSchedulingDatabase } from './db/schedulingDatabase';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  setTaskEnabled,
  listTaskRuns,
  onScheduledTasksChanged,
} from './db/scheduledTaskRepository';
import { startScheduledTasks, stopScheduledTasks, getTaskScheduler } from './scheduledTasks';
import { runScheduledTask } from './scheduledTasks/runner';
import type { CreateTaskData, UpdateTaskData, NotificationNavigationAction } from '../shared/types';
import { migrateWorkspaceFiles } from './migrateWorkspaceFiles';
import { ensureToolDataLayout } from './toolDataMigration';
import { deleteTranscript, sweepOrphanTranscripts } from './transcriptStore';
import { BackgroundBuilder } from './backgroundBuilder';
import { getEnvironmentInfo, getInstallSteps } from './environmentGenerator';
import { packageInstaller, installStepsToRequests, type Registry, type PackageState } from './packageInstaller';
import { setBaseUrl, BASE_URL } from '../../apiClient';
import { getDeviceId } from '../../utils/deviceId';
import { destroyTokenManager, getCredentials, setCredentials } from './cobuildingTokenManager';
import { installFindInPage } from './findInPageHost';
import { installScreenshot } from './screenshotHost';
import { registerCalendarHandlers } from './ipc/calendar';
import { registerDebugHandlers } from './ipc/debug';
import { cancelDesignLogin, registerClaudeDesignHandlers } from './claudeDesignLogin';
import { FEATURES, IPC_CHANNELS, NavigateToPagePayload } from '../../shared/types';
import { validateExternalUrl } from '../../utils/urlValidation';
import {
  ACADEMIA_DIR,
  AGENT_MEMORY_DIR,
  AGENT_MEMORY_SUBDIR,
  MEMORY_INDEX_FILE,
  REFERENCES_SUBDIR,
  REFERENCES_INDEX,
} from '../shared/paths';
import { initSentryMain } from './sentry';
import { captureError } from '../shared/telemetry';
import {
  initAnalytics,
  registerAnalyticsIpc,
  startHeartbeat as startAnalyticsHeartbeat,
  track as trackAnalyticsEvent,
} from './coscientistAnalytics';
const isSmokeTest = process.argv.includes('--smoke-test');

// R9 (docs/design/mcp-hosting.md): `--smoke-test` boots the whole app and
// quits right after `startScheduledTasks`, which is BEFORE
// `AgentInfrastructureController.start()` is ever reached — that controller
// is triggered by the RENDERER (see its own two call sites), not by main
// boot. So `--smoke-test` proves nothing about `mcpHost` despite appearing
// to; CLAUDE.md already records that this exact misreading once sent a
// session hunting a non-existent regression. `--smoke-test-mcp` is the
// dedicated signal: it drives `mcpHost.startAll()` directly against a store
// holding only the echo test fixture, waits for readiness, and exits
// non-zero if the fixture never becomes reachable.
const isSmokeTestMcp = process.argv.includes('--smoke-test-mcp');

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const FIND_BAR_WINDOW_WEBPACK_ENTRY: string;
declare const FIND_BAR_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const SCREENSHOT_OVERLAY_WINDOW_WEBPACK_ENTRY: string;
declare const SCREENSHOT_OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

const DEFAULT_MAX_ATTACHMENT_SIZE_MB = 30;

function getMaxAttachmentSizeMB(): number {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return typeof data.maxAttachmentSizeMB === 'number' ? data.maxAttachmentSizeMB : DEFAULT_MAX_ATTACHMENT_SIZE_MB;
  } catch {
    return DEFAULT_MAX_ATTACHMENT_SIZE_MB;
  }
}

function setMaxAttachmentSizeMB(sizeMB: number): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.maxAttachmentSizeMB = sizeMB;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * The saved Anthropic key, decrypted. Stored as an `enc:v1:` envelope
 * (OS keychain); a value written by a build before that is plain text and
 * passes through untouched, then gets encrypted on the next write.
 */
function getCustomAnthropicKey(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    const stored = data.customAnthropicApiKey;
    if (!stored) return null;
    return decryptSecret(stored) || null;
  } catch {
    return null;
  }
}

function setCustomAnthropicKey(key: string, baseURL?: string): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.customAnthropicApiKey = encryptSecret(key);
  data.customAnthropicBaseURL = baseURL || null;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Re-encrypt a legacy plaintext key in place, once, at boot. Without this the
 * key a user saved before this change sits in the clear until they happen to
 * re-enter it — which they never would.
 */
function migratePlaintextApiKey(): void {
  try {
    const settingsPath = getSettingsPath();
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const stored = data.customAnthropicApiKey;
    if (!stored || isEncrypted(stored) || !isEncryptionAvailable()) return;
    data.customAnthropicApiKey = encryptSecret(stored);
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
    log.info('[SecretStore] Encrypted the stored Anthropic API key at rest.');
  } catch {
    // No settings file, or unreadable — nothing to migrate.
  }
}

function getCustomAnthropicBaseURL(): string | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.customAnthropicBaseURL || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Anthropic API key the app should use. There is no login: the key
 * comes from the ANTHROPIC_API_KEY env var (useful for dev via .env.local) if
 * set, otherwise from the key the user saved in Settings (settings.json).
 */
function resolveApiKey(): { apiKey: string | null; baseURL: string | undefined } {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, baseURL: process.env.ANTHROPIC_BASE_URL?.trim() || undefined };
  }
  return { apiKey: getCustomAnthropicKey(), baseURL: getCustomAnthropicBaseURL() };
}

/**
 * Resolve the key (env → settings) and push it into the in-memory credential
 * store that getCredentials() serves. Called at boot before the agent starts,
 * and again whenever the user saves a new key so it takes effect live.
 */
function loadCredentialsIntoStore(): { apiKey: string | null; baseURL: string | undefined } {
  const c = resolveApiKey();
  setCredentials(c.apiKey, c.baseURL);
  return c;
}

// Configure electron-log for cobuilding — write to userData so dev/prod logs are separated
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'cobuilding.log');
log.transports.file.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v' + app.getVersion() + '] [{level}] {text}';
log.transports.console.level = app.isPackaged ? false : 'debug';

import { systemLogger } from './systemLogger';

let _handlingFatalError = false;
process.on('uncaughtException', (error) => {
  if (_handlingFatalError) return;
  _handlingFatalError = true;
  try {
    captureError(error, { subsystem: 'main_uncaught' });
    log.error('[FATAL] Uncaught exception:', error);
  } finally {
    _handlingFatalError = false;
  }
});

process.on('unhandledRejection', (reason) => {
  if (_handlingFatalError) return;
  _handlingFatalError = true;
  try {
    captureError(reason, { subsystem: 'main_unhandled_rejection' });
    log.error('[FATAL] Unhandled rejection:', reason);
  } finally {
    _handlingFatalError = false;
  }
});

app.setName('Acabox');
app.setPath('userData', path.join(app.getPath('appData'), 'acabox', app.isPackaged ? 'production' : 'development'));

// Single instance, and it MUST come after the setPath above: Electron keys the
// lock on userData, and userData is channel-scoped, so a dev run and a packaged
// run still hold different locks and coexist — which this project explicitly
// supports and tests with. Two instances on the SAME channel is the case worth
// refusing: they would share one skill store, one skills-state.json, one
// SQLite file and one 23200-23299 port range, and the store reconciler is
// serialised only within a process.
//
// Exempted under --smoke-test and --smoke-test-mcp. Both smoke runs' whole
// job is to boot a second process alongside whatever the developer already
// has open, and both quit on their own; failing the lock would make either
// exit before proving anything.
const gotSingleInstanceLock = isSmokeTest || isSmokeTestMcp || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log.info('[APP] Another Acabox instance owns this profile — focusing it and exiting.');
  app.quit();
} else if (!isSmokeTest) {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// Init the system logger only after userData is redirected above — it caches
// the log-file path at init time, so initializing earlier would pin it to the
// default (productName) dir instead of acabox/<channel>.
systemLogger.init();

// Initialize Sentry after userData path is set so native minidumps land in the right directory.
// Passing the installation_id puts a stable identity on Sentry's scope so "Users" counts
// are non-zero on every issue. No-op if SENTRY_DSN is empty (e.g. local dev without DSN).
initSentryMain(getDeviceId());

// Electron-level process-gone events. These cover renderer / utility / GPU processes —
// not Podman or the kernel gateway, which are tracked separately at their spawn sites.
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  const err = new Error(
    `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
  );
  captureError(err, {
    subsystem: 'child_process',
    extra: {
      process_type: details.type,
      reason: details.reason,
      exit_code: details.exitCode,
      service_name: details.serviceName,
      name: details.name,
    },
  });
  log.warn('[APP] child-process-gone:', details);
});

app.on('render-process-gone', (_event, _webContents, details) => {
  if (details.reason === 'clean-exit') return;
  const err = new Error(
    `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`
  );
  captureError(err, {
    subsystem: 'render_process',
    extra: { reason: details.reason, exit_code: details.exitCode },
  });
  log.warn('[APP] render-process-gone:', details);
});

let mainWindow: BrowserWindow | null = null;

function sendProgressTo(channel: string) {
  return (stage: string, message: string, percent?: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, { stage, message, percent });
    }
  };
}

// Setup events (pull, install-podman, setup-done) drive both the SetupBanner
// and PodmanDebug's Base Image spinner.
function makeSetupProgress() {
  const toSetup = sendProgressTo('setup:progress');
  const toProgress = sendProgressTo('container:progress');
  return (stage: string, message: string, percent?: number) => {
    toSetup(stage, message, percent);
    toProgress(stage, message, percent);
  };
}

function handleNotificationNavigation(action: NotificationNavigationAction | null): void {
  log.info('[NotificationNav] handleNotificationNavigation called with action:', JSON.stringify(action));
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.info('[NotificationNav] mainWindow is null or destroyed — recreating window');
    createMainWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    if (action) {
      log.info('[NotificationNav] Sending notification:navigate IPC to renderer:', JSON.stringify(action));
      mainWindow.webContents.send('notification:navigate', action);
    }
  }
}
const workspaceController = new WorkspaceController();

let activeApiBaseUrl: string = (() => {
  if (app.isPackaged) return BASE_URL;
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    if (data.apiEndpoint === 'production') {
      const url = 'https://api.academia.edu/';
      setBaseUrl(url);
      return url;
    }
  } catch { }
  return BASE_URL;
})();

// The one user-facing "you have no key" sentence. Acabox has no login, so the
// only correct instruction is Settings — never the bundled Claude Code binary's
// own "Please run /login". Keep it free of "401"/"token"/"unauthorized" so
// agentSession's isAuthError() can't misread it as a retryable auth failure.
const NO_API_KEY_MESSAGE = 'No Anthropic API key configured. Add one in Settings.';

async function refreshCredentialsForSession(): Promise<{ apiKey: string; baseURL?: string }> {
  // Re-read the user's key (env → settings) so a key updated in Settings
  // mid-session is picked up. No academia gateway anymore.
  const { apiKey, baseURL } = loadCredentialsIntoStore();
  if (!apiKey) throw new Error(NO_API_KEY_MESSAGE);
  return { apiKey, baseURL };
}

let inflightCredentialRefresh: Promise<boolean> | null = null;
// The key most recently handed to the agent (seeded with the boot key, updated
// on each successful push). The agent's 401 retry calls refreshAndPushCredentials;
// if the re-resolved key is the SAME one already tried, there is nothing new to
// try, so we report failure and let the caller surface "key rejected" instead of
// restarting the turn forever on the same bad key.
let lastPushedApiKey: string | null = null;

/**
 * `force` is for the one caller that is NOT a retry: the user pressing Save in
 * Settings. The `lastPushedApiKey` short-circuit below is correct for the 401
 * path (re-trying an identical key just loops), but it is wrong for an explicit
 * save — re-entering the same key is exactly what someone does when a push
 * failed the first time, e.g. the agent server was not up yet, in which case
 * `currentConfig` still holds the old key and nothing would ever correct it.
 * Measured 2026-09-01: a correctly-stored key kept returning 401 until restart.
 */
async function refreshAndPushCredentials(opts: { force?: boolean } = {}): Promise<boolean> {
  if (inflightCredentialRefresh && !opts.force) return inflightCredentialRefresh;
  inflightCredentialRefresh = (async () => {
    try {
      const { apiKey, baseURL } = loadCredentialsIntoStore();
      if (!apiKey) return false;
      if (!opts.force && apiKey === lastPushedApiKey) return false; // unchanged → nothing to retry
      const ok = await containerService.updateAgentCredentials(apiKey, baseURL);
      if (ok) lastPushedApiKey = apiKey;
      return ok;
    } catch (err) {
      log.error('[CredentialRefresh] Refresh and push failed:', err);
      return false;
    } finally {
      inflightCredentialRefresh = null;
    }
  })();
  return inflightCredentialRefresh;
}

const briefingsController = new BriefingsController({
  workspaceController,
  getCredentials,
  ensureCredentials: () => { loadCredentialsIntoStore(); return Promise.resolve(); },
  onBriefingsChanged: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('briefings:changed');
    }
  },
  onScannerEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scanner:event', event);
    }
  },
});

const agentInfrastructure = new AgentInfrastructureController({
  workspaceController,
  containerService,
  refreshCredentials: refreshCredentialsForSession,
  onNotificationClick: handleNotificationNavigation,
});

// Shared edit state store — keyed by toolCallId, synced between overlay and desktop
const editStates = new Map<string, string>();

// Tracks IPC forwarding listeners per (threadId, webContentsId) to avoid duplicates.
// Both chat:subscribe and chat:send use this to ensure exactly one forwarding listener
// per session per renderer.
//
// The entry records WHICH AgentSession instance the pipe is bound to. That
// matters because the pipe now outlives the renderer's interest (see
// `removeForwarding`): a bare "already attached" check would short-circuit
// forever against a session that has since been destroyed and replaced,
// leaving the thread permanently deaf. Identity is compared by reference.
const forwardingListeners = new Map<string, { cleanupPipe: () => void; session: object }>();

// ─── Cross-surface chat-event fanout (desktop ↔ overlay) ──────────────
//
// DEPRECATED: The overlay now uses a unified WebSocket for chat events
// (see websocket.ts + overlayHandlers.ts). The SSE fanout below is kept
// as a fallback during migration and will be removed in a future release.
//
// The desktop chat panel receives streaming events via Electron IPC
// (`webContents.send('chat:event', …)`). The Word overlay is a WKWebView
// served over the local HTTP server — it has no `webContents`, so the IPC
// path can't reach it. Without a separate channel, a turn started in the
// desktop never streams to an overlay viewing the same conversation; the
// overlay only hears about it on the next manual refresh.
//
function ensureForwarding(threadId: string, sender: Electron.WebContents): void {
  const key = `${threadId}:${sender.id}`;
  // Always register the renderer's interest in this thread, even before a
  // session exists. The registry tracks pre-session subscribers so a session
  // created later inherits the right count, and visibility-based cleanup
  // doesn't fire on a session that has subscribers waiting in the wings.
  const subscriberKey = `ipc:${sender.id}`;
  addSubscriber(threadId, subscriberKey);

  const session = getRegisteredSession(threadId);
  if (!session) {
    log.debug(`[Forwarding] No session found for ${threadId}, skipping listener attach (subscriber recorded)`);
    return;
  }

  const existing = forwardingListeners.get(key);
  if (existing) {
    // Already piped to this exact session — nothing to do. This is the hot
    // path: chat:subscribe fires on every effect re-run.
    if (existing.session === session) return;
    // Bound to a session that has since been replaced. The registry's destroy
    // hook normally clears these, but drop it defensively rather than let a
    // dead pipe block the live one.
    log.info(`[Forwarding] Replacing stale pipe for ${threadId} (bound to a destroyed session)`);
    existing.cleanupPipe();
  }

  log.debug(`[Forwarding] Setting up IPC forwarding for ${threadId}`);

  const unsubscribe = session.addListener({
    onEvent: async (msg) => {
      if (sender.isDestroyed()) {
        log.debug(`[Forwarding] Dropping event for ${threadId}: sender destroyed`);
        cleanup();
        return;
      }
      if (msg.type === 'turn-complete') {
        log.info(`[Forwarding] Sending ${msg.type} event for ${threadId}`);
      }
      sender.send('chat:event', threadId, msg);
    },
    onDone: () => {
      log.info(`[Forwarding] chat:done for ${threadId}`);
      // Send chat:done but do NOT cleanup — forwarding persists across conversation
      // turns so it doesn't need to be re-established on each message. Cleanup only
      // happens on error or sender destruction.
      if (!sender.isDestroyed()) {
        sender.send('chat:done', threadId);
      } else {
        cleanup();
      }
    },
    onError: (err) => {
      log.debug(`[Forwarding] Session error for ${threadId}: ${err}`);
      if (!sender.isDestroyed()) sender.send('chat:error', threadId, err);
      cleanup();
    },
  });

  let offSessionDestroyed: () => void = () => {};

  // Tears down the PIPE only. Deliberately does not touch the subscriber
  // refcount — the two were fused before, which is what caused the
  // stuck-THINKING bug: the renderer saying "I navigated away" killed the
  // delivery path for a turn that was still running, and since there is no
  // replay on this hop, the rest of that turn (including turn-complete) was
  // emitted into an empty listener set and lost forever.
  const cleanupPipe = () => {
    if (forwardingListeners.get(key)?.cleanupPipe !== cleanupPipe) return; // superseded
    log.debug(`[Forwarding] Tearing down pipe for ${threadId}`);
    unsubscribe();
    forwardingListeners.delete(key);
    sender.removeListener('destroyed', onSenderGone);
    offSessionDestroyed();
  };

  // A destroyed webContents can't receive anything, so this is the one case
  // where the pipe AND the refcount both go.
  const onSenderGone = () => {
    cleanupPipe();
    removeSubscriber(threadId, subscriberKey);
  };

  // Full teardown, used by the error path and by chat:stop.
  const cleanup = () => {
    cleanupPipe();
    removeSubscriber(threadId, subscriberKey);
  };

  forwardingListeners.set(key, { cleanupPipe, session });
  sender.on('destroyed', onSenderGone);
  // The pipe is bound to this session instance; when the instance dies the
  // pipe must go with it, or `ensureForwarding` above would keep matching a
  // corpse. Registered AFTER the map entry so the guard inside cleanupPipe
  // sees itself.
  offSessionDestroyed = onSessionDestroyed(threadId, cleanupPipe);
}

/**
 * The renderer has navigated away from this thread (component unmount, thread
 * change, idle timeout in useSessionSubscription). Drops the subscriber count
 * for the (threadId, sender) pair; once the last surface detaches, the
 * registry's visibility policy decides whether to destroy the agent session
 * now or after the current turn finishes.
 *
 * **This deliberately leaves the event pipe attached.** "I'm not looking" is
 * not "stop sending": the renderer keeps a live run and a live stream iterator
 * across a thread switch (assistant-ui does not evict thread runtimes), so it
 * is still a legitimate consumer. Tearing the pipe down here is what used to
 * strand a running turn — the terminator was emitted into an empty listener
 * set and, with no replay on this hop, the UI waited on THINKING… forever.
 * Measured before the fix: 7 of 31 turns lost their terminator this way.
 *
 * The pipe is now torn down by exactly three things, all of which mean it can
 * no longer deliver anything: the webContents is destroyed, the session errors,
 * or the session itself is destroyed (via the registry's destroy hook).
 */
function removeForwarding(threadId: string, senderId: number): void {
  removeSubscriber(threadId, `ipc:${senderId}`);
}

function createMainWindow(): void {
  log.info('[APP] Creating main window...');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Acabox',
    show: false,
    // The renderer draws its own 40px window-chrome bar (Command Desk design);
    // native traffic lights sit inset inside it. The bar is the drag region.
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  log.info('[APP] Main window created.');

  mainWindow.on('closed', () => {
    mainWindow = null;
    setChatWindowFocused(false);
  });
  // Half of "is this chat being read": a chat on screen behind another app is
  // not. Observed here rather than reported by the renderer, whose own
  // focus/blur events also fire on in-page focus moves.
  mainWindow.on('focus', () => setChatWindowFocused(true));
  mainWindow.on('blur', () => setChatWindowFocused(false));

  const url = COBUILDING_WINDOW_WEBPACK_ENTRY;
  log.info('[APP] Loading URL:', url);
  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    log.info('[APP] Window ready-to-show, calling show().');
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('[APP] Window failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log.info('[APP] Window did-finish-load.');
  });
}

// Route every link to the user's default browser. Registered before
// `whenReady` because `web-contents-created` only sees WebContents created
// after the listener is attached — the main window included.
installExternalLinkGuards();

// A renderer-reported job (a kernel run, a Claude call) can only be completed
// by the renderer that started it. If that WebContents dies first the job would
// otherwise sit "running" forever, so close it out as interrupted. Registered
// alongside the link guards, and for the same reason: the listener has to exist
// before the WebContents it needs to see.
app.on('web-contents-created', (_event, contents) => {
  contents.once('destroyed', () => {
    try { interruptJobsForWebContents(contents.id); } catch { /* shutting down */ }
  });
});

/** Record on the tool's manifest that it finished doing something. */
async function stampToolLastRun(workspacePath: string | null, dirName: string): Promise<void> {
  if (!workspacePath || !dirName || dirName.includes('/') || dirName.includes('\\')) return;
  try {
    await updateManifest(
      path.join(workspacePath, '.applications', dirName, 'manifest.json'),
      (manifest) => { manifest.lastRun = new Date().toISOString(); return manifest; },
    );
  } catch (err) {
    log.warn(`[Jobs] Could not stamp lastRun for ${dirName}: ${(err as Error).message}`);
  }
}

/**
 * R9 (docs/design/mcp-hosting.md) — the only automated end-to-end signal for
 * `mcpHost`. Runs `mcpHost.startAll()` against the real hosted-server store
 * (userData is already redirected to the dev channel above) after
 * registering exactly one record — the echo test fixture — then waits for
 * it to report `ready` and proves a real tool call round-trips before
 * exiting. The fixture registration is removed again in every case (success
 * or failure) so a smoke run never leaves an autostarting server behind for
 * the next ordinary `npm start` to pick up.
 *
 * Dev-only: the fixture lives under `src/cobuilding/main/__tests__/fixtures/`
 * and is not part of any packaged build's `extraResource` list, so this is
 * resolved via `app.getAppPath()` the same way `skillStore.ts:93` locates
 * `src/cobuilding` in dev — which only ever returns the repo root when
 * `!app.isPackaged`.
 */
async function runMcpHostSmokeTest(): Promise<void> {
  const SMOKE_ID = 'smoke-test-echo';
  const say = (msg: string) => {
    log.info(`[SMOKE TEST MCP] ${msg}`);
    console.log(`[SMOKE TEST MCP] ${msg}`);
  };

  const finish = async (ok: boolean, message: string): Promise<void> => {
    say(`${ok ? 'PASS' : 'FAIL'} — ${message}`);
    try {
      await removeHostedServer(SMOKE_ID);
    } catch (err) {
      log.warn('[SMOKE TEST MCP] Cleanup (removeHostedServer) failed:', err);
    }
    app.exit(ok ? 0 : 1);
  };

  if (app.isPackaged) {
    await finish(false, '--smoke-test-mcp is dev-only — the echo fixture is not shipped in a packaged build.');
    return;
  }

  const fixture = path.join(app.getAppPath(), 'src', 'cobuilding', 'main', '__tests__', 'fixtures', 'echoMcpServer.mjs');
  if (!fs.existsSync(fixture)) {
    await finish(false, `echo fixture not found at ${fixture}`);
    return;
  }

  const reg = await registerHostedServer({
    id: SMOKE_ID,
    label: 'Smoke test echo',
    autostart: true,
    install: { kind: 'custom' },
    entry: { command: process.execPath, args: [fixture] },
    // Runs the fixture under the Electron binary as plain node — the same
    // launch shape the agent server and every mcpHost test already use.
    env: { ELECTRON_RUN_AS_NODE: '1' },
    concurrency: 1,
  });
  if (!reg.ok) {
    await finish(false, `could not register the echo fixture: ${reg.error}`);
    return;
  }
  await updateHostedServer(SMOKE_ID, { enabled: true });

  try {
    const readyOrFailed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('timed out waiting for readiness (25s)'));
      }, 25_000);
      const unsub = mcpHost.onInventoryChanged((id) => {
        if (id !== SMOKE_ID) return;
        void mcpHost.list().then((all) => {
          const entry = all.find((e) => e.id === SMOKE_ID);
          if (entry?.state === 'ready') {
            clearTimeout(timer);
            unsub();
            resolve();
          } else if (entry?.state === 'failed') {
            clearTimeout(timer);
            unsub();
            reject(new Error(entry.error ?? 'server reported failed'));
          }
        });
      });
    });

    await mcpHost.startAll();
    await readyOrFailed;

    const result = await mcpHost.invoke(SMOKE_ID, 'echo', { text: 'acabox-mcp-smoke-test' });
    if (!JSON.stringify(result).includes('acabox-mcp-smoke-test')) {
      throw new Error(`unexpected echo result: ${JSON.stringify(result)}`);
    }

    await mcpHost.shutdown({ graceMs: 2000 });
    await finish(true, 'startAll() spawned the echo fixture, it reached ready, and echo() round-tripped.');
  } catch (err) {
    try { await mcpHost.shutdown({ graceMs: 2000 }); } catch { /* best effort */ }
    await finish(false, (err as Error).message);
  }
}

app.whenReady().then(async () => {
  // We lost the single-instance race; `app.quit()` is already in flight and
  // the running instance has been focused. Booting anyway would put two
  // processes on one skill store, one skills-state.json and one SQLite file.
  if (!gotSingleInstanceLock) return;

  // R5 (docs/design/mcp-hosting.md): reap survivors of a SIGKILL'd previous
  // run before anything new can spawn. Deliberately here, at main boot, and
  // not only inside the renderer-triggered AgentInfrastructureController.start()
  // (which also calls this, as part of its own startAll()) — a hosted server
  // orphaned by a crash is running RIGHT NOW, and waiting for the renderer to
  // load and ask is too late. The two calls cannot double-kill anything:
  // reconcileOrphans() clears a record's {lastPid, lastPidSignature} the
  // first time it is checked, so whichever of the two runs first does the
  // real work and the other is a fast no-op.
  try {
    const { killed, spared } = await reconcileOrphans();
    if (killed > 0 || spared > 0) {
      log.info(`[APP] mcpHost boot reconcile: reaped ${killed} orphaned hosted-server process(es), spared ${spared} (pid reused by something else).`);
    }
  } catch (err) {
    log.warn('[APP] mcpHost boot reconcile failed:', err);
  }

  if (isSmokeTestMcp) {
    await runMcpHostSmokeTest();
    return;
  }

  // Encrypt secrets that predate encryption-at-rest. Must run after
  // whenReady (safeStorage throws before it) and before the key is read.
  migratePlaintextApiKey();
  migratePlaintextConnectorSecrets();
  migratePlaintextApiSecrets();
  migratePlaintextShareToken();

  // No login: load the user's Anthropic API key (env → settings) into the
  // credential store before anything spawns the agent, so getCredentials() is
  // populated without any auth flow. If none is set, the renderer routes the
  // user to the Settings key-entry screen.
  const bootCreds = loadCredentialsIntoStore();
  // The agent gets this key directly via its start config, so record it as the
  // last-pushed key — a 401 on this exact key then terminates cleanly instead
  // of looping (see refreshAndPushCredentials).
  lastPushedApiKey = bootCreds.apiKey;
  log.info(
    bootCreds.apiKey
      ? `[Auth] Loaded Anthropic API key from ${process.env.ANTHROPIC_API_KEY ? 'env' : 'settings'}`
      : '[Auth] No Anthropic API key configured — user must add one in Settings',
  );

  // Refresh the model roster in the background. Deliberately not awaited: the
  // curated list in `shared/models.ts` is already a correct answer, so a slow
  // or unreachable models endpoint must not add latency to boot. Callers read
  // whatever has landed by the time they ask.
  void refreshModels(bootCreds);

  // Only in packaged builds: under `npm start` the process runs as the stock
  // Electron dev binary (bundle id com.github.Electron), so this write would
  // land in the shared com.github.Electron preferences domain that every
  // Electron project's dev runs — including the original app's — share.
  if (process.platform === 'darwin' && app.isPackaged) {
    systemPreferences.setUserDefault('NSNavPanelExpandedStateForSaveMode2', 'boolean', true as any);
  }

  // Analytics stays gated off: there is no login to flip the auth gate, so
  // track() is a no-op and nothing is posted to academia. Kept wired so it can
  // be re-enabled later against a fork-owned backend if desired.
  initAnalytics();
  registerAnalyticsIpc();
  startAnalyticsHeartbeat();

  protocol.handle('local-file', async (request) => {
    const filePath = decodeURIComponent(request.url.slice('local-file://'.length));
    const resolved = workspaceController.isPathAllowed(filePath);
    if (!resolved) {
      log.warn(`[local-file] Forbidden: "${filePath}" outside workspace`);
      return new Response('Forbidden', { status: 403 });
    }
    const fileUrl = pathToFileURL(resolved).href;
    try {
      const response = await net.fetch(fileUrl);
      if (!response.ok) {
        log.warn(`[local-file] Fetch failed (${response.status}): ${fileUrl}`);
      }
      // Everything behind this protocol is a live file the agent or a mini-app
      // rewrites in place: dist/bundle.js after a rebuild, output/plot.png
      // after a re-run. Blink caches custom-scheme SUBRESOURCES in memory, so
      // without no-store a remounted iframe re-fetches index.html (a
      // navigation) but keeps serving the OLD bundle.js — the stale content
      // survives webContents.reload() and even session.clearCache(), clearing
      // only on app restart. Headers from net.fetch are immutable, so rebuild
      // the Response.
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-store');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      log.error(`[local-file] Error fetching "${fileUrl}":`, err);
      return new Response('Not Found', { status: 404 });
    }
  });

  initDatabase(app.getPath('userData'));
  initObservationsDatabase(app.getPath('userData'));
  commandLogger.init();
  log.info('[APP] App ready. Version:', app.getVersion(), 'Packaged:', app.isPackaged);
  log.info('[APP] userData path:', app.getPath('userData'));

  try {
    log.info('[APP] Initializing database...');
    initDatabase(app.getPath('userData'));
    initObservationsDatabase(app.getPath('userData'));
    log.info('[APP] Database initialized.');

    // Reclaim SDK transcripts no chat points at any more. Deliberately here:
    // the session table is readable and nothing has started a query yet, so no
    // transcript can be in use. The scanner and title generation both write
    // transcripts mid-run, so this must not be moved onto a timer.
    sweepOrphanTranscripts(listSdkSessionIds());

    log.info('[APP] Loading active workspace...');
    let activeWorkspace = workspaceController.loadActiveWorkspace();
    if (!activeWorkspace) {
      // No onboarding flow: the app always boots straight into the shell, so
      // a workspace must exist. Create a blank one (no shared directories) —
      // the user adds folders and an API key from Settings.
      log.info('[APP] No active workspace — creating a blank one.');
      activeWorkspace = await workspaceController.create([], bootCreds.apiKey ?? '');
    }
    log.info('[APP] Active workspace:', activeWorkspace ? activeWorkspace.name : 'none');

    migrateWorkspaceFiles(workspaceController.workspacePath);
    ensureToolDataLayout(workspaceController.workspacePath);

    // Work a tool started can outlive the app (verified: a mini-app's shell
    // command completes after Acabox has fully quit). Decide, per job, whether
    // it is still running, finished while we were away, or died with us —
    // before any window can render a stale spinner.
    setRunCompletedHandler((dirName) => {
      void stampToolLastRun(workspaceController.workspacePath, dirName);
      void recomputeAndBroadcastApp(dirName);
    });
    // A build changes the snapshot a published app's shared copy was taken
    // from, same as a finished run above — recompute "behind" at that write.
    setBuildSucceededHandler((dirName) => {
      void recomputeAndBroadcastApp(dirName);
      // The reload signal must not ride the chat renderer: the agent's build
      // tool card only reaches whichever chat is on screen, so a build that
      // finishes while a different chat is showing in an already-open tool's
      // side panel left that tool's viewer stuck on the stale bundle (T4,
      // 2026-09-18 incident). Broadcast to every window instead so any open
      // tab for this tool reloads regardless of which chat triggered it.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('miniApps:built', { dirName });
      }
    });
    // Kernel and Claude work can only be interrupted by the renderer driving
    // it, so a cancel is relayed to the window that reported the job.
    setCancelRequestHandler((job) => {
      if (job.ownerWebContentsId === undefined) return false;
      const target = webContents.fromId(job.ownerWebContentsId);
      if (!target || target.isDestroyed()) return false;
      target.send('jobs:cancelRequested', { id: job.id, dirName: job.dirName, kind: job.kind });
      return true;
    });
    reconcileOnBoot();
    subscribeToJobs((allJobs) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('jobs:changed', allJobs);
      }
    });
    subscribeBuildHealth((all) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('buildHealth:changed', all);
      }
    });

    // Servers page live-status plumbing (docs/design/mcp-hosting.md,
    // Increment 3, "Live status — pattern A, mandatory"): every tab stays
    // mounted forever behind `display:none`, so a page that fetches on mount
    // is correct once and wrong thereafter. Three independent feeds, each
    // broadcast to every window the moment it changes rather than polled.

    // Hosted servers: `onInventoryChanged` fires on any status transition for
    // any server; re-read the masked list and broadcast it. `list()` is a
    // cheap store read (no I/O to a live process), so re-fetching per event
    // rather than trying to diff at the source is the simpler correct choice
    // — `mcpServerStore`'s `republish()` on the renderer side is where
    // redundant repaints actually get suppressed.
    // Scheduled tasks: same pattern, same reason. A run started by the
    // scheduler's own clock changes `last_run_at` with no user gesture, so the
    // Activity section polled every 30s to notice. The repository now announces
    // every write (see `onScheduledTasksChanged`), which is strictly better —
    // it fires on the scheduler's timer path too, which no IPC covers.
    // Payload-free on purpose: `scheduledTasks:list` is workspace-scoped and
    // the renderer re-reads it, rather than this block having to know which
    // workspace each window is showing.
    onScheduledTasksChanged(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('scheduledTasks:changed');
      }
    });

    // Which chats are working and which have unseen news. A full snapshot
    // every time rather than a delta: both sets are small, and a renderer that
    // missed one message is simply right again on the next.
    onChatActivityChanged((snapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('chats:activity', snapshot);
      }
    });

    // A turn starting or ending moves its chat to the top of every
    // most-recent-first list: the rail's Recents, Home, the Chats page. They
    // all re-read on `sessions:changed`, which used to fire only on create,
    // rename, delete and title, so a chat you kept talking in stayed where it
    // was when the last NEW chat was made. Tool chats showed it most, being
    // the ones people return to.
    onChatTurnBoundary(() => notifySessionsChanged());

    mcpHost.onInventoryChanged(() => {
      mcpHost.list()
        .then((all) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('mcpServers:changed', all);
          }
        })
        .catch((err) => log.warn(`[McpHost] list() after inventory change failed: ${(err as Error).message}`));
    });

    // Remote connectors: the producer already exists (`agentSession.ts`'s
    // `recordConnectorStatus` on every SDK `init`, and `recordConnectorLiveness`
    // in `sessionRegistry.ts` on last-session teardown) — only the fan-out was
    // missing.
    subscribeConnectorStatus((status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('connectors:statusChanged', status);
      }
    });

    // Mini-app published servers: live only while an iframe is registered.
    miniAppMcpRegistry.subscribe((servers) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('miniAppMcp:changed', servers);
      }
    });

    if (activeWorkspace) {
      await backfillAllAppChatLinks(activeWorkspace.id, workspaceController.workspacePath);
    }
    // Seeds/reconciles the skill store, renders the `.claude/skills` symlinks,
    // reconciles CLAUDE.md / settings.json / hooks, and syncs the mini-app
    // assets. Awaited so the Knowledge surface and the agent both see a
    // settled store; `agentInfrastructure.start()` awaits the same serialised
    // call, so whichever runs second is a cheap no-op rather than a race.
    //
    // Caught, because provisioning is fatal to the AGENT and not to the app.
    // This call sits two lines above createMainWindow(), and letting it throw
    // here is how the old hardcoded SKILLS array produced an app with no
    // window at all when one directory was renamed. The window comes up, the
    // user can reach Settings and the Debug log, and the same serialised call
    // inside agentInfrastructure.start() refuses loudly when a chat is started.
    try {
      await provisionWorkspace(workspaceController.workspacePath);
    } catch (err) {
      log.error(`[APP] Workspace provisioning failed: ${(err as Error).message}`);
    }

    // The findings ledger's blast-radius grep — "the old belief is also written
    // down here" — searches the user's own shared directories. Without this it
    // silently never populates, and an absent list is deliberately rendered as
    // absent rather than as "checked, found nothing". The workspace root itself
    // is excluded: it is mostly Acabox's own dot-directories.
    setBlastRadiusSearchPaths(() => workspaceController.userDirectoryPaths);

    createMainWindow();

    registerFileHandlers(() => workspaceController.allAllowedPaths, () => mainWindow);
    registerShareHandlers({
      getWorkspaceRoot: () => workspaceController.workspacePath ?? null,
      getAllowedPaths: () => workspaceController.allAllowedPaths,
      broadcast: (channel, payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(channel, payload);
        }
      },
    });
    registerSystemStatsHandlers();
    registerDictationHandlers();
    initFileMonitor(() => workspaceController.workspacePath);
    initActivityQuery(() => workspaceController.workspacePath);
    initSessionFiles(() => workspaceController.workspacePath);
    registerCalendarHandlers(() => mainWindow);
    registerDebugHandlers();
    registerClaudeDesignHandlers(() => mainWindow);

    // Mini-app MCP publishing
    ipcMain.handle('miniAppMcp:register', (event, payload: {
      serverName: string;
      dirName: string;
      tools: import('./miniAppMcpRegistry').MiniAppToolDef[];
      iframeRouteKey: string;
    }) => {
      miniAppMcpRegistry.register({
        serverName: payload.serverName,
        dirName: payload.dirName,
        tools: payload.tools,
        iframeRouteKey: payload.iframeRouteKey,
        hostWebContents: event.sender,
      });
    });
    ipcMain.handle('miniAppMcp:unregister', (_event, serverName: string) => {
      miniAppMcpRegistry.unregister(serverName);
    });
    ipcMain.handle('miniAppMcp:unregisterByRoute', (_event, iframeRouteKey: string) => {
      miniAppMcpRegistry.unregisterByRoute(iframeRouteKey);
    });
    ipcMain.handle('miniAppMcp:list', () => miniAppMcpRegistry.list());
    ipcMain.handle('miniAppMcp:callTool', async (_event, serverName: string, toolName: string, args: unknown) => {
      return miniAppMcpRegistry.invoke(serverName, toolName, args);
    });
    ipcMain.on('miniAppMcp:result', (_event, payload: { invocationId: string; result?: unknown; error?: string }) => {
      miniAppMcpRegistry.resolveInvocation(payload.invocationId, { result: payload.result, error: payload.error });
    });
    ipcMain.handle('miniApps:build', async (_event, dirName: string) => {
      const workspacePath = workspaceController.workspacePath;
      if (!workspacePath) {
        return { ok: false, error: 'No active workspace', exitCode: 1 };
      }
      const { buildMiniApp } = await import('./miniAppBuilder');
      return buildMiniApp(workspacePath, dirName);
    });
    registerWorkspaceHandlers(workspaceController, () => mainWindow, containerService);
    setupUpdaterIpcHandlers();
    setupUpdater(rebuildTrayMenu);
    createTray();
    setShowWindowCallback(() => {
      if (!mainWindow) {
        createMainWindow();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    const dock = process.platform === 'darwin' ? app.dock : null;
    if (dock) {
      const dockIcon = createDockIcon();
      if (dockIcon) dock.setIcon(dockIcon);
    }
    log.info('[APP] Updater and tray initialized.');

    installFindInPage({
      getMainWindow: () => mainWindow,
      barEntryUrl: FIND_BAR_WINDOW_WEBPACK_ENTRY,
      barPreloadPath: FIND_BAR_WINDOW_PRELOAD_WEBPACK_ENTRY,
    });
    installScreenshot({
      getMainWindow: () => mainWindow,
      overlayEntryUrl: SCREENSHOT_OVERLAY_WINDOW_WEBPACK_ENTRY,
      overlayPreloadPath: SCREENSHOT_OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY,
    });
    initSchedulingDatabase(app.getPath('userData'));
    startScheduledTasks(handleNotificationNavigation);

    if (isSmokeTest) {
      log.info('[SMOKE TEST] All services started — shutting down');
      console.log('[SMOKE TEST] All services started — shutting down');
      app.quit();
      return;
    }
  } catch (error) {
    log.error('[APP] Fatal error during startup:', error);
    dialog.showErrorBox(
      'Acabox - Startup Error',
      `The application failed to start.\n\n${error instanceof Error ? error.message : String(error)}\n\nCheck the log file for details:\n${log.transports.file.getFile().path}`,
    );
  }
}).catch((error) => {
  log.error('[APP] app.whenReady() rejected:', error);
});

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
  }
});

ipcMain.handle('workspaces:listDirectories', () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  return listWorkspaceDirectories(activeWorkspace.id);
});

// ─── Reports IPC ──────────────────────────────────────────────────

ipcMain.handle('reports:getLatest', (_event, reportType: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return null;
  return getLatestReport(activeWorkspace.id, reportType);
});

ipcMain.handle('reports:get', (_event, reportId: string) => {
  return getReport(reportId);
});

ipcMain.handle('reports:update', (_event, reportId: string, reportData: string) => {
  updateReportData(reportId, reportData);
});

// ─── Briefings IPC ──────────────────────────────────────────────

ipcMain.handle(
  'briefings:list',
  (_event, filter?: ListBriefingsFilter) => {
    const activeWorkspace = workspaceController.activeWorkspace;
    if (!activeWorkspace) return [];
    return listBriefings(activeWorkspace.id, filter ?? {});
  },
);

ipcMain.handle(
  'briefings:setStatus',
  (_event, id: string, status: BriefingStatus) => {
    setBriefingStatus(id, status);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('briefings:changed');
    }
  },
);

// ─── Scanned Files IPC ──────────────────────────────────────────

ipcMain.handle('scannedFiles:getByType', (_event, fileType: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  return getScannedFilesByType(activeWorkspace.id, fileType);
});

ipcMain.handle('scannedFiles:getAll', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  const files = getScannedFiles(activeWorkspace.id);

  let refIndex: Record<string, string> = {};
  try {
    const indexPath = path.join(workspaceController.workspacePath, REFERENCES_SUBDIR, REFERENCES_INDEX);
    const raw = await fsPromises.readFile(indexPath, 'utf-8');
    refIndex = JSON.parse(raw);
  } catch { /* no index yet */ }

  return files.map((f) => ({
    ...f,
    ...(f.file_type === 'reference' && refIndex[f.file_path]
      ? { markdown_path: `${REFERENCES_SUBDIR}/${refIndex[f.file_path]}` }
      : {}),
  }));
});

ipcMain.handle(
  'scannedFiles:updateTag',
  async (_event, filePath: string, fileName: string, fileType: string) => {
    const activeWorkspace = workspaceController.activeWorkspace;
    if (!activeWorkspace) return;
    updateFileTag(activeWorkspace.id, filePath, fileName, fileType);

    if (fileType === 'reference') {
      const sourceDir = workspaceController.userDirectories[0]?.directory_path;
      if (!sourceDir) return;
      let { apiKey, baseURL } = getCredentials();
      if (!apiKey) {
        ({ apiKey, baseURL } = loadCredentialsIntoStore());
        if (!apiKey) return;
      }
      convertReferenceFile({
        filePath,
        sourceDir,
        workspacePath: path.join(workspaceController.workspacePath, ACADEMIA_DIR),
        apiKey: apiKey ?? '',
        baseURL,
      }).catch((err) => log.error('[scannedFiles:updateTag] Reference conversion failed:', err));
    }
  },
);

ipcMain.handle('scannedFiles:removeTag', (_event, filePath: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return;
  removeFileTag(activeWorkspace.id, filePath);
});

// ─── Directory Scanner IPC ──────────────────────────────────────

ipcMain.handle('scanner:start', () => briefingsController.runInitialWorkspaceScan());


// Container IPC handlers
ipcMain.handle('container:start', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  const agentDir = workspaceController.workspacePath;
  await containerService.start(workspaceController.mountMap);
  await agentInfrastructure.start(agentDir);
  backgroundBuilder.startWatching(agentDir, (appName) => {
    ensuredApps.add(appName);
  });
});

ipcMain.handle('container:stop', async () => {
  backgroundBuilder.stopWatching();
  ensuredApps.clear();
  packageInstaller.reset();
  await agentInfrastructure.stop();
  containerService.stop();
});

ipcMain.handle('container:status', () => {
  // `running` keeps its meaning (the service flag; MiniAppViewer reads it).
  // `agentAlive` / `gaveUp` are what the chrome's health chip needs.
  return {
    running: containerService.isRunning(),
    agentAlive: containerService.isAgentAlive(),
    gaveUp: containerService.hasAgentGivenUp(),
  };
});

ipcMain.handle('container:exec', async (_event, command: string[]) => {
  return containerService.exec(command);
});

ipcMain.handle('container:execLogged', async (_event, command: string[], meta?: { source?: string; appDirName?: string | null }) => {
  // A command run on a tool's behalf is a job: it outlives the tool's viewer
  // (and the app itself), so ownership belongs here rather than in the
  // renderer that happened to start it. Builds are excluded — they already
  // have their own BUILDING status and are not the tool "working".
  const dirName = meta?.appDirName ?? null;
  const isToolWork = !!dirName && meta?.source !== 'build';
  if (!isToolWork) {
    return containerService.execLogged(command, meta as any);
  }

  // Held in a box rather than a plain `let`: the assignment happens inside the
  // onSpawn callback, which TypeScript cannot see, so a bare binding narrows
  // to `never` at the use sites below.
  const started: { job: ToolJob | null } = { job: null };
  try {
    const result = await containerService.execLogged(command, {
      ...(meta as any),
      onSpawn: (pid: number) => {
        started.job = beginJob({
          dirName,
          kind: 'command',
          label: command.slice(0, 3).join(' '),
          pid,
        });
      },
    });
    if (started.job) endJob(started.job.id, result.exitCode === 0 ? 'done' : 'failed');
    return result;
  } catch (err) {
    if (started.job) endJob(started.job.id, 'failed');
    throw err;
  }
});

// ── Tool jobs: work reported by a renderer (kernel runs, Claude calls) ──
// These cannot be observed from main the way a spawned command can, so the
// renderer reports them — but the record still lives here, so it survives the
// tool's viewer being unmounted.
ipcMain.handle('jobs:begin', (event, input: { dirName: string; kind: JobKind; label: string }) => {
  if (!input?.dirName || typeof input.dirName !== 'string') return null;
  const job = beginJob({
    dirName: input.dirName,
    kind: input.kind === 'kernel' || input.kind === 'claude' ? input.kind : 'agent-tool',
    label: String(input.label ?? ''),
    ownerWebContentsId: event.sender.id,
  });
  return job.id;
});

ipcMain.handle('jobs:end', (_event, id: string, status?: 'done' | 'failed') => {
  if (typeof id === 'string') endJob(id, status === 'failed' ? 'failed' : 'done');
  return { ok: true };
});

ipcMain.handle('jobs:list', () => listJobs());

ipcMain.handle('buildHealth:list', () => listBuildHealth());

// Hosted MCP servers snapshot — the counterpart to the `mcpServers:changed`
// broadcast above.
ipcMain.handle('mcpServers:list', () => mcpHost.list());

// Mutating IPC for the Servers page (docs/design/mcp-hosting.md, Increment 3).
// A freshly registered/imported server always lands `enabled: false`
// (`registerHostedServer`'s own non-negotiable stance) and the façade's own
// `start()` deliberately refuses an off server ("Turn it on first" — pinned
// by `mcpHostIndex.test.ts`). So "Start" in the UI means "turn it on AND
// start it" — that enabling step happens HERE, at the IPC boundary, exactly
// where `store.ts`'s own header anticipates a future caller reaching it
// directly rather than through the façade.
ipcMain.handle('mcpServers:start', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Bad id.' };
  await updateHostedServer(id, { enabled: true });
  return mcpHost.start(id);
});

// `disable` distinguishes a temporary Stop (façade `stop()`, which does not
// disable — the server stays eligible for Start/Restart) from the
// Increment-3-vocabulary "Off" (façade `pause()`, which disables AND stops).
// Kept as one channel with an option rather than a seventh IPC name.
ipcMain.handle('mcpServers:stop', async (_event, id: unknown, opts?: { disable?: boolean; graceMs?: number }) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Bad id.' };
  return opts?.disable ? mcpHost.pause(id, opts) : mcpHost.stop(id, opts);
});

ipcMain.handle('mcpServers:restart', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Bad id.' };
  return mcpHost.restart(id);
});

ipcMain.handle('mcpServers:remove', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Bad id.' };
  return mcpHost.remove(id);
});

// Increment 7's write gate (docs/design/mcp-hosting.md, DECISION 2026-08-13):
// per-tool selection, not an `allowWrites` boolean. `enabledTools: undefined`
// (renderer sends `null` over IPC — structured clone has no `undefined`, so
// this normalizes it back) means "every tool"; `[]` means none. A dedicated
// channel rather than folded into `mcpServers:save` — see `mcpHost.setEnabledTools`'s
// own comment for why the detail panel's per-tool checkboxes should not have
// to round-trip the Advanced form's full command/args/env draft just to flip
// one tool's selection.
ipcMain.handle('mcpServers:setEnabledTools', async (_event, id: unknown, enabledTools: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Bad id.' };
  if (enabledTools === undefined || enabledTools === null) return mcpHost.setEnabledTools(id, undefined);
  return mcpHost.setEnabledTools(id, normalizeStringArray(enabledTools));
});

function normalizeStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function normalizeStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

ipcMain.handle('mcpServers:save', async (_event, draft: unknown) => {
  const d = (draft && typeof draft === 'object') ? (draft as Record<string, unknown>) : {};
  return mcpHost.save({
    id: typeof d.id === 'string' ? d.id : '',
    label: typeof d.label === 'string' ? d.label : '',
    command: typeof d.command === 'string' ? d.command : '',
    args: normalizeStringArray(d.args),
    cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
    envUpdates: normalizeStringRecord(d.envUpdates),
    envDeletes: normalizeStringArray(d.envDeletes),
    autostart: d.autostart === true,
    concurrency: typeof d.concurrency === 'number' ? d.concurrency : undefined,
  });
});

// Detail-panel reads: tool names (never just a count) and the stderr tail.
// Both are live, in-memory-only facts about the CURRENT session's supervisor
// state — nothing here is persisted or masked beyond what `list()` already
// omits (there is no secret in a tool name or a server's own stdout/stderr).
ipcMain.handle('mcpServers:inventory', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) return undefined;
  return mcpHost.inventory(id);
});

ipcMain.handle('mcpServers:stderrTail', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) return '';
  return mcpHost.stderrTail(id);
});

// The probe. Never registers or persists anything — see `mcpHost.test()`'s
// own comment for why this reuses the supervisor's spawn path rather than a
// second implementation.
ipcMain.handle('mcpServers:test', async (_event, draft: unknown) => {
  const d = (draft && typeof draft === 'object') ? (draft as Record<string, unknown>) : {};
  return mcpHost.test({
    id: typeof d.id === 'string' && d.id ? d.id : undefined,
    command: typeof d.command === 'string' ? d.command : '',
    args: normalizeStringArray(d.args),
    cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
    envUpdates: normalizeStringRecord(d.envUpdates),
    envDeletes: normalizeStringArray(d.envDeletes),
  });
});

// Increment 5 (docs/design/mcp-hosting.md) — agent-authored servers. All
// three are thin passthroughs to `mcpHost`'s own new façade functions
// (`main/mcpHost/index.ts`), which wrap `main/mcpHost/authored.ts`; see that
// module for the design. There is deliberately no MCP tool anywhere that
// reaches these — only a user gesture in the renderer does.

// Adoption already runs once per boot inside `mcpHost.startAll()`; this lets
// the Servers page ask again on demand (e.g. right after a chat where the
// agent said it wrote a server) without the user restarting Acabox.
ipcMain.handle('mcpServers:rescanAuthored', async () => {
  return mcpHost.scanAuthoredServers();
});

ipcMain.handle('mcpServers:listAuthored', async () => {
  return mcpHost.listAuthoredInfo();
});

// Same operation for the first-ever approval ("Review & enable") and every
// later re-promotion ("N changes … Review") — see `approveAuthoredServer`'s
// own comment for why those are one function, not two.
ipcMain.handle('mcpServers:approveAuthored', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Bad id.' };
  return mcpHost.approveAuthoredServer(id);
});

ipcMain.handle('jobs:cancel', (_event, id: string) => {
  if (typeof id !== 'string') return { ok: false, reason: 'bad id' };
  return cancelJob(id);
});

ipcMain.handle('jobs:acknowledge', (_event, dirName: string) => {
  if (typeof dirName === 'string') acknowledgeTool(dirName);
  return { ok: true };
});

ipcMain.handle('settings:getMaxAttachmentSizeMB', () => {
  return getMaxAttachmentSizeMB();
});

ipcMain.handle('settings:setMaxAttachmentSizeMB', (_event, sizeMB: number) => {
  setMaxAttachmentSizeMB(sizeMB);
});

ipcMain.handle('container:ensureSetup', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  const setupAgentDir = workspaceController.workspacePath;
  await containerService.ensureSetup(makeSetupProgress(), setupAgentDir);
  if (activeWorkspace) {
    await containerService.start(workspaceController.mountMap);
    await agentInfrastructure.start(setupAgentDir);
    backgroundBuilder.startWatching(setupAgentDir, (appName) => {
      ensuredApps.add(appName);
    });
  }
});

// ─── Environment IPC ──────────────────────────────────────────────

ipcMain.handle('container:getEnvironmentInfo', async () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return null;
  const info = getEnvironmentInfo(workspaceController.workspacePath!);

  return {
    packageStates: packageInstaller.getPackageStates(),
    packageLines: packageInstaller.getPackageLines(),
    totalPip: info.merged.pipRequirements,
    totalNpm: info.merged.npmPackages,
    totalR: info.merged.rPackages,
    totalApt: info.merged.aptPackages,
    totalSetup: info.merged.setupScripts.map((s) => s.destName),
    apps: info.apps.map((a) => ({
      name: a.appName,
      pip: a.pipPackages,
      npm: a.npmDependencies,
      r: a.rPackages,
      apt: a.aptPackages,
      setup: a.setupScripts,
    })),
  };
});

// Track which apps have had their deps ensured this session.
// Cleared on container stop/restart so deps are re-checked against the new image.
const ensuredApps = new Set<string>();

ipcMain.handle('container:appDepsReady', (_event, dirName: string) => {
  const ready = ensuredApps.has(dirName);
  log.debug(`[appDepsReady] ${dirName}: ${ready}`);
  return ready;
});

ipcMain.handle('container:ensureAppDeps', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  if (!containerService.isRunning()) throw new Error('Acabox is still starting — try again in a moment.');
  if (ensuredApps.has(dirName)) {
    log.debug(`[ensureAppDeps] ${dirName}: already ensured, skipping`);
    return { installed: [] };
  }

  // PackageInstaller dedups against any package currently installing (started
  // by BackgroundBuilder at workspace open, or the agent's install wrapper).
  // Concurrent ensureDeps calls for the same packages share state — no
  // duplicate downloads, no races on /opt/venv.
  const ensureDepsAppsDir = path.join(workspaceController.workspacePath!, '.applications');
  const steps = getInstallSteps(ensureDepsAppsDir, dirName);
  if (steps.length === 0) {
    log.debug(`[ensureAppDeps] ${dirName}: no install steps, marking ready`);
    ensuredApps.add(dirName);
    return { installed: [] };
  }

  log.info(`[ensureAppDeps] ${dirName}: waiting for ${steps.length} install steps`);
  await packageInstaller.ensureDeps(installStepsToRequests(steps, dirName));
  log.info(`[ensureAppDeps] ${dirName}: all deps installed, marking ready`);
  ensuredApps.add(dirName);
  return { installed: steps.map((s) => `${s.registry}: ${s.packages.length} packages`) };
});

// Renderer queries this on mount to know which packages to track in its
// "Installing software..." view. Each package's state and streamed lines
// arrive on installer:packageState and installer:packageLine.
ipcMain.handle('container:getAppInstallRequests', (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  const getAppAppsDir = path.join(workspaceController.workspacePath!, '.applications');
  const steps = getInstallSteps(getAppAppsDir, dirName);
  return installStepsToRequests(steps, dirName);
});

packageInstaller.on('package:state', (e: { registry: Registry; package: string; state: PackageState }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:packageState', e);
  }
});
packageInstaller.on('package:line', (e: { registry: Registry; package: string; line: string }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:packageLine', e);
  }
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('app:relaunch', () => {
  if (app.isPackaged) {
    app.relaunch();
  }
  app.quit();
});

// Jupyter kernel gateway IPC handlers
ipcMain.handle('jupyter:startGateway', async () => {
  try {
    const activeWorkspace = workspaceController.activeWorkspace;
    if (!activeWorkspace) {
      log.warn('[KernelGateway] startGateway called with no active workspace');
      return { error: 'No active workspace' };
    }
    log.info(`[KernelGateway] startGateway requested for workspace: ${activeWorkspace.id}`);
    return await kernelGatewayService.start(workspaceController.workspacePath ?? undefined);
  } catch (err) {
    log.error('[KernelGateway] startGateway failed:', (err as Error).message);
    return { error: (err as Error).message };
  }
});

ipcMain.handle('jupyter:stopGateway', async () => {
  await kernelGatewayService.stop();
});

ipcMain.handle('jupyter:restartGateway', async () => {
  try {
    log.info('[KernelGateway] restartGateway requested');
    return await kernelGatewayService.restart();
  } catch (err) {
    log.error('[KernelGateway] restartGateway failed:', (err as Error).message);
    return { error: (err as Error).message };
  }
});

ipcMain.handle('jupyter:gatewayStatus', () => {
  return kernelGatewayService.getStatus();
});

ipcMain.handle('jupyter:listKernels', () => {
  return kernelGatewayService.listKernels();
});

ipcMain.handle('jupyter:shutdownKernel', (_event, kernelId: string) => {
  return kernelGatewayService.shutdownKernel(kernelId);
});

// Command log IPC handlers
import { commandLogger } from './commandLogger';

ipcMain.handle('commandLog:getAll', () => commandLogger.getAll());
ipcMain.handle('commandLog:getByApp', (_event, appDirName: string) => commandLogger.getByApp(appDirName));
ipcMain.handle('commandLog:getAppNames', () => commandLogger.getAppNames());

const backgroundBuilder = new BackgroundBuilder();

commandLogger.onEntry((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('commandLog:entry', entry);
  }
  // When the install wrapper succeeds, mark the app's deps as ensured
  if (entry.exitCode === 0 && entry.command.join(' ').includes('.applications/install') && entry.appDirName) {
    ensuredApps.add(entry.appDirName);
  }
});

// System log IPC handlers
ipcMain.handle('systemLog:getAll', () => systemLogger.getAll());

systemLogger.onEntry((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('systemLog:entry', entry);
  }
});

// File Monitor IPC handlers
ipcMain.handle('fileMonitor:status', () => ({ running: isFileMonitorRunning() }));
ipcMain.handle('fileMonitor:start', () => { startFileMonitor(); });
ipcMain.handle('fileMonitor:stop', () => { stopFileMonitor(); });
ipcMain.handle('fileMonitor:getTodaySessions', () => getTodayFileSessions());
ipcMain.handle('fileMonitor:openFile', (_event, fileUrl: string, bundleId?: string) => {
  try {
    const filePath = decodeURIComponent(new URL(fileUrl).pathname);
    if (bundleId) {
      return require('child_process').execFileSync('open', ['-b', bundleId, filePath]).toString();
    }
    return shell.openPath(filePath);
  } catch {
    return shell.openPath(fileUrl);
  }
});


// Observations IPC handlers
ipcMain.handle('observations:getFileSessions', () => getAllFileSessions());
ipcMain.handle('observations:getSessionFiles', () => getAllSessionFiles());

function notifySessionsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sessions:changed');
  }
}

// Session IPC handlers
ipcMain.handle('sessions:list', (_event, source?: string) => {
  return listSessions(undefined, source);
});
ipcMain.handle('chats:getActivity', () => getChatActivity());
// The other half of "is this chat being read": which conversation, if any, the
// renderer has on screen. Only the renderer knows — every tab stays mounted
// behind display:none, so nothing main can observe distinguishes them.
ipcMain.on('chats:setViewing', (_event, sessionId: unknown) => {
  setViewingChat(typeof sessionId === 'string' && sessionId ? sessionId : null);
});
ipcMain.handle('sessions:countForDocument', (_event, documentPath: string): number => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return 0;
  return listSessions(activeWorkspace.id, undefined, documentPath).length;
});
ipcMain.handle('sessions:get', (_event, id: string) => getSession(id));
// The chat's running cost for the header: result rows only, never the history.
ipcMain.handle('sessions:cost', (_event, id: string) => chatTotalCost(listResultCostRows(id)));
ipcMain.handle('sessions:setDocumentPath', (_event, id: string, documentPath: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return;
  setSessionDocumentPath(id, activeWorkspace.id, documentPath);
  notifySessionsChanged();
});
ipcMain.handle('sessions:rename', (_event, id: string, title: string) => {
  updateSessionTitle(id, title);
  notifySessionsChanged();
});
ipcMain.handle('sessions:delete', (_event, id: string) => {
  // Read the transcript id BEFORE the row goes: it is the only thing that
  // identifies the SDK's own JSONL history for this chat, and deleting the row
  // first would leave that file (routinely megabytes) stranded forever.
  const sdkSessionId = getSession(id)?.sdk_session_id;
  deleteSession(id);
  deleteTranscript(sdkSessionId);
  if (getRegisteredSession(id)) {
    unregisterSession(id);
  }
  notifySessionsChanged();
});
ipcMain.handle('messages:list', (_event, sessionId: string) => getMessages(sessionId));
// Chat search over message text (docs/design/chat-search.md). Previews back
// the Chats-list preview line; searchProse backs the search box. Both read
// the `message_prose` FTS5 index directly rather than the renderer copying
// message history to compute a preview itself (the defect this shipped to fix).
ipcMain.handle('sessions:previews', () => listChatPreviews());
ipcMain.handle('sessions:searchProse', (_event, query: unknown) => {
  if (typeof query !== 'string') return [];
  return searchChatProse(query.slice(0, 200));
});

/** Rejects path traversal and dotfiles in an agent/renderer-supplied app dir name. */
function isValidAppDirName(dirName: string): boolean {
  return Boolean(dirName) && !dirName.includes('/') && !dirName.includes('\\') && !dirName.startsWith('.');
}

/**
 * Ensures every chat we already know about for `dirName` carries the
 * `sessions.app_dir_name` link, which is the source of truth for the per-tool
 * chat list. Two legacy sources are backfilled: the tool's
 * `manifest.chatSessionId` (the creating chat) and the message-scanning
 * `findSessionForApp` fallback. Idempotent — `setSessionAppDirName` only fills
 * a NULL, so a chat is never re-homed to a different tool.
 *
 * Returns the manifest's creating-chat id when it points at a real session.
 */
function backfillAppChatLinks(
  workspaceId: string,
  dirName: string,
  manifest: Record<string, unknown> | null,
): string | null {
  const manifestSessionId = typeof manifest?.chatSessionId === 'string' ? manifest.chatSessionId : null;
  const creatingId = manifestSessionId && getSession(manifestSessionId) ? manifestSessionId : null;
  if (creatingId) setSessionAppDirName(creatingId, dirName);

  // Only worth scanning messages when nothing is linked yet — this is the
  // pre-manifest path and it is the expensive one.
  if (!creatingId && listSessionsForApp(workspaceId, dirName).length === 0) {
    const legacyId = findSessionForApp(workspaceId, dirName);
    if (legacyId) setSessionAppDirName(legacyId, dirName);
  }
  return creatingId;
}

/**
 * Boot sweep that links every tool's existing chat to it via
 * `sessions.app_dir_name`. Without this the link is only established the first
 * time a tool is opened, so a pre-existing chat opened from the Chats list
 * wouldn't know which tool it belongs to (no "Open tool" button, no chip).
 * Idempotent and bounded by the number of installed tools.
 */
async function backfillAllAppChatLinks(workspaceId: string, workspacePath: string): Promise<void> {
  const appsDir = path.join(workspacePath, '.applications');
  let entries: string[];
  try {
    entries = (await fsPromises.readdir(appsDir, { withFileTypes: true }))
      // `_`-prefixed dirs are shared scaffolding (_bridge, _reusable, _vendor),
      // not tools; they have no manifest and would only log a failed read.
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch {
    return; // No .applications yet — nothing to link.
  }
  // A dir with no manifest.json is not an installed tool (a half-scaffolded
  // or leftover folder), so there is nothing to link.
  entries = (
    await Promise.all(
      entries.map(async (name) =>
        fsPromises.access(path.join(appsDir, name, 'manifest.json')).then(() => name, () => null),
      ),
    )
  ).filter((n): n is string => n !== null);

  let linked = 0;
  for (const dirName of entries) {
    try {
      const manifest = await readManifest(path.join(appsDir, dirName, 'manifest.json'));
      const before = listSessionsForApp(workspaceId, dirName).length;
      backfillAppChatLinks(workspaceId, dirName, manifest);
      linked += listSessionsForApp(workspaceId, dirName).length - before;
    } catch (err) {
      log.warn(`[AppChatLinks] Backfill failed for ${dirName}:`, err);
    }
  }
  if (linked > 0) log.info(`[AppChatLinks] Linked ${linked} existing chat(s) to their tool`);
}

// Resolve which of a mini app's chats to open: the most recently active one,
// creating a first chat if the tool has none.
ipcMain.handle('sessions:findForApp', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return null;
  if (!isValidAppDirName(dirName)) return null;

  const manifestPath = path.join(workspaceController.workspacePath!, '.applications', dirName, 'manifest.json');

  // Missing or unreadable manifest — fall through to legacy search/create.
  const manifest = await readManifest(manifestPath);
  backfillAppChatLinks(activeWorkspace.id, dirName, manifest);

  // Most recently active chat for this tool (ordered by last message).
  const linked = listSessionsForApp(activeWorkspace.id, dirName);
  if (linked.length > 0) return linked[0].id;

  // Tool has no chats yet — create its first one and record it in the manifest
  // as the creating chat (still used for the chat → tool reverse lookup).
  const sessionId = randomUUID();
  const manifestName = typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name.trim() : null;
  const title = manifestName ?? dirName.replace(/[-_]/g, ' ');
  createSession(sessionId, activeWorkspace.id, null, null, dirName);
  updateSessionTitle(sessionId, title);

  if (manifest) {
    try {
      await updateManifest(manifestPath, (m) => {
        m.chatSessionId = sessionId;
        return m;
      });
    } catch (err) {
      log.warn('[sessions:findForApp] Failed to write chatSessionId to manifest:', err);
    }
  }

  notifySessionsChanged();
  return sessionId;
});

// Every chat belonging to a mini app, most recently active first.
ipcMain.handle('sessions:listForApp', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  if (!isValidAppDirName(dirName)) return [];

  const manifestPath = path.join(workspaceController.workspacePath!, '.applications', dirName, 'manifest.json');
  backfillAppChatLinks(activeWorkspace.id, dirName, await readManifest(manifestPath));

  return listSessionsForApp(activeWorkspace.id, dirName);
});

// Start an additional chat for a mini app. An existing chat that has never run
// a turn is reused instead of stacking up empty rows when "New chat" is
// clicked repeatedly.
ipcMain.handle('sessions:createForApp', (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return null;
  if (!isValidAppDirName(dirName)) return null;

  const existing = listSessionsForApp(activeWorkspace.id, dirName);
  const blank = existing.find((s) => s.last_message_at === null);
  if (blank) return blank.id;

  const sessionId = randomUUID();
  createSession(sessionId, activeWorkspace.id, null, null, dirName);
  notifySessionsChanged();
  return sessionId;
});

// Per-thread creation_prompt slots. Indexed by chat thread_id (== sessionId
// in this codebase, see chat:send). Populated by the renderer via
// tool:setThreadCreationPrompt when chatAdapter detects manage_mini_app.mjs
// in the agent's tool-call args, with the user message that triggered it.
// Consumed by tool:opened when creation_pending=true: it resolves the tool's
// creating thread via manifest.chatSessionId (using findSessionForApp as a
// fallback if the manifest doesn't have it yet) and looks up the map by
// that id. Per-thread keying is what makes concurrent background builds work.
//
// 30-min freshness window covers the chat → agent → manifest →
// user-opens-tool path. Stale entries are dropped lazily on read.
const PENDING_TIMEOUT_MS = 30 * 60 * 1000;
interface ThreadPrompt {
  prompt: string;
  set_at: number;
}
const promptByThread = new Map<string, ThreadPrompt>();

function takeFresh<T extends { set_at: number }>(
  map: Map<string, T>,
  key: string,
): T | null {
  const entry = map.get(key);
  if (!entry) return null;
  map.delete(key);
  return Date.now() - entry.set_at <= PENDING_TIMEOUT_MS ? entry : null;
}

const MAX_PROMPT_BYTES = 16 * 1024;
ipcMain.handle('tool:setThreadCreationPrompt', (_event, threadId: string, prompt: string) => {
  if (typeof threadId !== 'string' || !threadId) return;
  if (typeof prompt !== 'string' || prompt.length === 0) return;
  // truncatePayload in analytics trims further if the envelope is still
  // over budget after wrapping. NOTE: slice() counts UTF-16 code units, not
  // bytes — multi-byte chars may yield a slightly larger byte length, but
  // the downstream truncator handles the final 5KB cap.
  const trimmed =
    Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES
      ? prompt.slice(0, MAX_PROMPT_BYTES)
      : prompt;
  promptByThread.set(threadId, { prompt: trimmed, set_at: Date.now() });
});

// Fires tool.created exactly once per tool (gated on the creation_pending
// flag that manage_mini_app.mjs writes at scaffold time) and tool.opened on
// every open. The flag — not "manifest lacks tool_id" — is the positive
// creation signal; the latter conflates fresh tools with tools predating
// instrumentation, which produced spurious tool.created events for old tools
// on their first post-upgrade open. Pre-existing tools now get a lazy-minted
// tool_id silently, no tool.created fired.
//
// The creation prompt is keyed by the creating chat thread_id: tool:opened
// resolves the tool's chatSessionId (== thread_id) by reading the manifest,
// falling back to findSessionForApp (which searches messages for the dirName)
// if the link hasn't been written yet. promptByThread is looked up by that
// id and consumed.
ipcMain.handle('tool:opened', async (_event, dirName: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace || !dirName) return null;
  if (dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) return null;
  if (!workspaceController.workspacePath) return null;

  const manifestPath = path.join(workspaceController.workspacePath, '.applications', dirName, 'manifest.json');

  // The whole mint-and-merge cycle runs inside updateManifest so a concurrent
  // manifest writer (miniApps:touch, sessions:findForApp — both fire around
  // the same open) can't interleave. A missing manifest reaches the mutator
  // as {} — a fresh tool, mint everything.
  let tool_id = '';
  let creationPending = false;
  let createdAtMs = 0;
  let openCountSoFar = 0;
  let chatSessionId: string | null = null;
  let manifest: Record<string, unknown> = {};

  // If the write fails, mint/flag/counter mutations don't persist; emitting
  // analytics anyway would mean the next open re-fires tool.created with a
  // fresh UUID, duplicating the event.
  try {
    manifest = await updateManifest(manifestPath, (m) => {
      const existingToolId = typeof m.tool_id === 'string' ? m.tool_id : null;
      tool_id = existingToolId ?? randomUUID();
      if (!existingToolId) m.tool_id = tool_id;

      // Strip creation_pending synchronously so a race-y second open can't double-fire.
      creationPending = m.creation_pending === true;
      if (creationPending) delete m.creation_pending;

      const existingCreatedAt = typeof m.created_at === 'string' ? m.created_at : null;
      createdAtMs = existingCreatedAt ? new Date(existingCreatedAt).getTime() : Date.now();
      if (!existingCreatedAt) m.created_at = new Date(createdAtMs).toISOString();

      const priorOpenCount = typeof m.open_count === 'number' ? m.open_count : 0;
      openCountSoFar = priorOpenCount + 1;
      m.open_count = openCountSoFar;

      // Resolve chatSessionId for attribution lookup. Prefer manifest, fall
      // back to findSessionForApp (matches assistant open_mini_application
      // messages or synthetic user "connected to the application" markers).
      // Persist the resolved id back so future opens skip the search.
      chatSessionId = typeof m.chatSessionId === 'string' ? m.chatSessionId : null;
      if (!chatSessionId) {
        const found = findSessionForApp(activeWorkspace.id, dirName);
        if (found) {
          chatSessionId = found;
          m.chatSessionId = found;
        }
      }
      return m;
    });
  } catch (err) {
    log.warn('[tool:opened] Failed to write manifest, suppressing analytics:', err);
    return null;
  }

  const daysSinceCreated = Math.max(
    0,
    Math.floor((Date.now() - createdAtMs) / (1000 * 60 * 60 * 24)),
  );

  if (creationPending) {
    const promptEntry = chatSessionId ? takeFresh(promptByThread, chatSessionId) : null;

    const toolType = manifest.preBuilt === true
      ? 'prebuilt'
      : (typeof manifest.tool_type === 'string' ? manifest.tool_type : 'user');

    const creationPrompt = promptEntry?.prompt ?? '';

    trackAnalyticsEvent({
      name: 'tool.created',
      metadata: {
        tool_id,
        creation_source: 'chat',
        name: typeof manifest.name === 'string' ? manifest.name : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        creation_prompt: creationPrompt,
        tool_type: toolType,
      },
    });
  }

  trackAnalyticsEvent({
    name: 'tool.opened',
    metadata: {
      tool_id,
      days_since_created: daysSinceCreated,
      open_count_so_far: openCountSoFar,
    },
  });

  return { tool_id, open_count_so_far: openCountSoFar, days_since_created: daysSinceCreated };
});

async function generateSessionTitle(sessionId: string, firstMessage: string): Promise<void> {
  try {
    const { apiKey, baseURL } = getCredentials();
    log.info(`[TitleGen] sessionId=${sessionId} hasApiKey=${!!apiKey} baseURL=${baseURL ?? '(default)'}`);
    if (!apiKey) return;
    const client = new Anthropic({ apiKey, baseURL });
    const response = await client.messages.create({
      ...BACKGROUND_REQUEST,
      max_tokens: 40,
      messages: [
        {
          role: 'user',
          content: `Give a short title (5 words or less) that summarizes this message. Reply with ONLY the title, no quotes or punctuation.\n\nMessage: ${firstMessage}`,
        },
      ],
    });
    const title = messageText(response).trim();
    log.info(`[TitleGen] sessionId=${sessionId} title="${title}"`);
    if (title) {
      updateSessionTitle(sessionId, title);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sessions:titleUpdated', sessionId, title);
      notifySessionsChanged();
    }
  } catch (err: any) {
    const { apiKey, baseURL } = getCredentials();
    log.warn(`[TitleGen] Failed sessionId=${sessionId} hasApiKey=${!!apiKey} baseURL=${baseURL ?? '(default)'}`);
    log.warn(`[TitleGen] error:`, err);
    if (err?.cause) log.warn(`[TitleGen] cause:`, err.cause);
  }
}

ipcMain.handle('chat:send', (event, { threadId, text, attachments, model, documentPath, messageId, effort, quote }: { threadId: string; text: string; attachments?: IPCAttachment[]; model?: string; documentPath?: string; messageId?: string; effort?: string; quote?: unknown }) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }

  // Re-parsed rather than trusted: this is an IPC boundary, and a renderer
  // mid-upgrade can send a shape this build does not understand. A malformed
  // quote degrades to "no quote" instead of reaching SQLite.
  const parsedQuote = parseStoredQuote(quote);

  log.info(`[chat:send] messageId=${messageId ?? '(none)'} threadId=${threadId} textLen=${text.length}${parsedQuote ? ` quote=${parsedQuote.source.kind}/${parsedQuote.text.length}ch` : ''}`);

  // No key → refuse the turn rather than run it. Without this the agent server
  // is handed anthropicApiKey:'' and the bundled Claude Code binary answers
  // "Not logged in · Please run /login" — nonsense in a build that has no login.
  //
  // Store first (it stays populated even if the settings file was wiped from
  // the Debug tab), then a fresh env → settings resolve so a key added
  // out-of-band still counts. Same two-step as the reference-file converter.
  //
  // Reported over 'chat:error' rather than thrown: Electron wraps a rejected
  // invoke as "Error invoking remote method 'chat:send': …" and preload
  // forwards that message verbatim, which would put IPC plumbing in front of
  // the user's instructions.
  let { apiKey: chatApiKey } = getCredentials();
  if (!chatApiKey) ({ apiKey: chatApiKey } = loadCredentialsIntoStore());
  if (!chatApiKey) {
    log.warn(`[chat:send] Refusing turn for ${threadId} — no Anthropic API key configured`);
    event.sender.send('chat:error', threadId, NO_API_KEY_MESSAGE);
    return { messageId };
  }

  // Dedup: if this messageId has already been persisted for this session, the
  // renderer is re-firing a send that already landed (typical cause: reload
  // with a queued draft). Re-attach forwarding for the new webContents but
  // don't re-run the turn.
  if (messageId) {
    const existingMessage = findMessageByMessageId(threadId, messageId);
    if (existingMessage) {
      log.info(`[chat:send] dedup hit messageId=${messageId} sessionId=${threadId} — re-attaching forwarding only`);
      ensureForwarding(threadId, event.sender);
      return { messageId, deduped: true };
    }
  }

  const existingRunning = getRegisteredSession(threadId);
  if (existingRunning?.isRunning) {
    // Session is already running (e.g. scheduled task or previous user chat).
    // Ensure IPC forwarding is set up (idempotent — won't duplicate).
    ensureForwarding(threadId, event.sender);
    existingRunning.sendMessage(text, attachments, messageId, parsedQuote);
    return { messageId };
  }

  const isCalendarSession = threadId === 'calendar-assistant';
  let isFirstMessage = false;

  if (!hasSession(threadId)) {
    const existingDbSession = getSession(threadId);
    // "First message" is about the conversation, not the row: app chats are
    // pre-created (sessions:findForApp / :createForApp) so a row already
    // exists before the user has said anything. Title generation is also
    // skipped for a row that already carries a real title — that's the
    // tool-named first chat of a mini app, which keeps its name.
    isFirstMessage =
      countMessages(threadId) === 0 &&
      (!existingDbSession || isPlaceholderTitle(existingDbSession.title));

    // Model and effort are pinned to the conversation on its first turn. Once
    // recorded they win over whatever the composer's picker currently says —
    // without this, leaving the chat evicts the in-memory session and the next
    // turn silently adopts a different model than the one the chat displays.
    const pinnedModel = existingDbSession?.model ?? undefined;
    const pinnedEffort = existingDbSession?.effort ?? undefined;
    const effectiveModel = pinnedModel ?? model;
    const effectiveEffort = pinnedEffort ?? effort;

    if (isCalendarSession) {
      const { apiKey: calApiKey, baseURL: calBaseURL } = getCredentials();
      const session = createCalendarAgentSession(
        threadId,
        activeWorkspace.id,
        calApiKey ?? '',
        workspaceController.workspacePath!,
        {
          onEvent: () => { },
          onDone: () => { },
          onError: () => { unregisterSession(threadId); },
        },
        (mutation: CalendarMutationEvent) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('calendar:mutation', mutation);
          }
        },
        calBaseURL,
        refreshCredentialsForSession,
      );
      // Headless agent embedded in the desktop chat — opt out of
      // subscriber-based eviction; lifecycle bound to the renderer.
      registerSession(threadId, session, 'background');
      event.sender.on('destroyed', () => {
        unregisterSession(threadId);
      });
    } else {
      const session = createAgentSession(
        threadId,
        {
          onEvent: () => { },
          onDone: () => { },
          onError: () => { unregisterSession(threadId); },
        },
        activeWorkspace!,
        existingDbSession?.sdk_session_id ?? undefined,
        undefined,
        handleNotificationNavigation,
        effectiveModel,
        undefined,
        documentPath,
        refreshAndPushCredentials,
        effectiveEffort,
      );

      // Default 'ui': subscriber tracking via ensureForwarding handles
      // destroy when every surface detaches.
      registerSession(threadId, session);

      // createAgentSession has now inserted the row, so the pin can be
      // recorded. Write-once: only the first turn's effort sticks. The model
      // is pinned separately from the SDK's init event (the id it actually
      // resolved), which may differ from what we asked for.
      setSessionModelInfo(threadId, { effort: effectiveEffort });
    }
  }

  ensureForwarding(threadId, event.sender);
  getRegisteredSession(threadId)!.sendMessage(text, attachments, messageId, parsedQuote);

  if (isFirstMessage && !isCalendarSession) {
    generateSessionTitle(threadId, text);
  }

  return { messageId };
});

ipcMain.on('chat:subscribe', (event, threadId: string) => {
  ensureForwarding(threadId, event.sender);
});

// Authoritative server-side "is the agent mid-turn on this thread" signal.
// Survives renderer detach/reattach, unlike assistant-ui's `thread.isRunning`
// which is tied to the local run generator's lifetime.
ipcMain.handle('chat:isTurnInProgress', (_event, threadId: string): boolean => {
  return getRegisteredSession(threadId)?.isTurnInProgress ?? false;
});

/**
 * Richer form of the above, for the renderer's stall watchdog. A bare boolean
 * cannot tell "the turn ended and the session was evicted" apart from "there
 * was never a session" — both are false — which is exactly the question a
 * stalled stream needs answered before it decides whether to give up or keep
 * waiting.
 */
ipcMain.handle('chat:turnStatus', (_event, threadId: string): { turnInProgress: boolean; sessionAlive: boolean } => {
  const session = getRegisteredSession(threadId);
  return {
    turnInProgress: session?.isTurnInProgress ?? false,
    sessionAlive: !!session,
  };
});

// Renderer signals it's no longer viewing this thread. Whether the
// session itself is torn down is the registry's decision.
ipcMain.on('chat:unsubscribe', (event, threadId: string) => {
  removeForwarding(threadId, event.sender.id);
});

// Explicit user-initiated stop (Stop button). Ends the session regardless of
// other subscribers — "stop" means stop — but by interrupting the turn first,
// so the CLI closes it itself and what already ran stays in the chat.
ipcMain.on('chat:stop', (event, threadId: string) => {
  removeForwarding(threadId, event.sender.id);
  if (getRegisteredSession(threadId)) {
    void stopSession(threadId, 'user');
  }
});

// =============================================================================
// Edit state sync (desktop ↔ overlay)
// =============================================================================

ipcMain.handle('edit-state:apply', async (_event, _params: any) => {
  return { success: false, error: 'No host apps are registered in this build.' };
});

ipcMain.handle('edit-state:set', (_event, { toolCallId, state }: { toolCallId: string; state: string }) => {
  editStates.set(toolCallId, state);
});

ipcMain.handle('edit-state:get-all', () => {
  return Object.fromEntries(editStates);
});

// =============================================================================
// Anthropic API proxy for mini-app iframes
//
// Mini-apps (agent-generated React apps running in sandboxed iframes) need to
// call Claude for inline AI features. They cannot hold the API key directly —
// it would be visible in the app source the agent writes and in the iframe's
// JS context. Instead, calls flow through this proxy:
//
//   iframe → postMessage → MiniAppViewer.tsx → IPC → here → Anthropic API
//
// The key never leaves this process. The iframe receives only the model's text
// response. All parameters are validated here before the SDK is invoked.
// =============================================================================

// Only these models may be requested. Unrecognised values silently fall back
// to BACKGROUND_MODEL rather than erroring, so agent-written code that omits the field
// always gets a sensible default without breaking.
/**
 * Ids a mini-app may pass to the Claude bridge.
 *
 * Derived, not hardcoded: the built-in roster in `shared/models.ts` plus
 * whatever `GET /v1/models` reports for this account. Read through a function
 * rather than captured in a const because discovery lands asynchronously
 * after boot — a snapshot taken at module load would permanently miss every
 * model the API adds, which is the exact staleness this replaced.
 */
function anthropicAllowedModels(): Set<string> {
  return allowedModelIds(discoveredModels());
}

// Hard limits applied regardless of what the caller sends. The token cap
// prevents a runaway mini-app from exhausting the user's quota in one call.
// The character limits prevent IPC message bloat and are well above anything
// a legitimate mini-app would need.
const ANTHROPIC_MAX_TOKENS_LIMIT = 4096;
const ANTHROPIC_MAX_TEXT_CHARS = 100_000; // ~25k tokens
const ANTHROPIC_MAX_MESSAGES = 50;
const ANTHROPIC_MAX_SYSTEM_CHARS = 10_000;
const ANTHROPIC_MAX_CONTENT_BLOCKS = 20;
const ANTHROPIC_MAX_FILE_SIZE = 10_000_000; // 10 MB per file
const ANTHROPIC_MAX_BASE64_CHARS = 20_000_000; // ~15 MB decoded
const ANTHROPIC_ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Media type lookup for file-path based content blocks. The main process
// determines the type from the extension — the iframe cannot spoof it.
const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

type ValidatedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };

// Resolves a single content block. For file-path sources, reads the file from
// the workspace and base64-encodes it. For base64 sources, validates the data
// in place. Returns a clean, reconstructed block safe to pass to the SDK.
async function resolveContentBlock(
  raw: unknown,
  allowedDirs: string[],
): Promise<ValidatedContentBlock> {
  if (!raw || typeof raw !== 'object') throw new Error('Content block must be an object');
  const block = raw as Record<string, unknown>;
  if (typeof block.type !== 'string') throw new Error('Content block must have a type');

  if (block.type === 'text') {
    if (typeof block.text !== 'string') throw new Error('Text block must have a text field');
    if (block.text.length > ANTHROPIC_MAX_TEXT_CHARS) throw new Error(`Text block exceeds ${ANTHROPIC_MAX_TEXT_CHARS} characters`);
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image') {
    const source = block.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') throw new Error('Image block must have a source');

    if (source.type === 'file') {
      if (typeof source.path !== 'string') throw new Error('Image file source must have a path');
      const resolved = assertWithinAllowedDirs(source.path, allowedDirs);
      const ext = path.extname(resolved).slice(1).toLowerCase();
      const mediaType = EXT_TO_MEDIA_TYPE[ext];
      if (!mediaType || !ANTHROPIC_ALLOWED_IMAGE_TYPES.has(mediaType)) {
        throw new Error(`Unsupported image type: .${ext}`);
      }
      const stats = await fsPromises.stat(resolved);
      if (stats.size > ANTHROPIC_MAX_FILE_SIZE) throw new Error(`Image file exceeds ${ANTHROPIC_MAX_FILE_SIZE} bytes`);
      const buffer = await fsPromises.readFile(resolved);
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: buffer.toString('base64') },
      };
    }

    if (source.type === 'base64') {
      if (typeof source.media_type !== 'string' || !ANTHROPIC_ALLOWED_IMAGE_TYPES.has(source.media_type)) {
        throw new Error('Image base64 source must have a valid media_type (image/jpeg, image/png, image/gif, image/webp)');
      }
      if (typeof source.data !== 'string') throw new Error('Image base64 source must have a data field');
      if (source.data.length > ANTHROPIC_MAX_BASE64_CHARS) throw new Error(`Image base64 data exceeds ${ANTHROPIC_MAX_BASE64_CHARS} characters`);
      return {
        type: 'image',
        source: { type: 'base64', media_type: source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: source.data },
      };
    }

    throw new Error('Image source type must be "file" or "base64"');
  }

  if (block.type === 'document') {
    const source = block.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') throw new Error('Document block must have a source');

    const title = typeof block.title === 'string' ? block.title.slice(0, 1000) : undefined;

    if (source.type === 'file') {
      if (typeof source.path !== 'string') throw new Error('Document file source must have a path');
      const resolved = assertWithinAllowedDirs(source.path, allowedDirs);
      const ext = path.extname(resolved).slice(1).toLowerCase();
      if (ext !== 'pdf') throw new Error('Only PDF documents are supported');
      const stats = await fsPromises.stat(resolved);
      if (stats.size > ANTHROPIC_MAX_FILE_SIZE) throw new Error(`Document file exceeds ${ANTHROPIC_MAX_FILE_SIZE} bytes`);
      const buffer = await fsPromises.readFile(resolved);
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
        ...(title ? { title } : {}),
      };
    }

    if (source.type === 'base64') {
      if (source.media_type !== 'application/pdf') throw new Error('Document base64 source must have media_type "application/pdf"');
      if (typeof source.data !== 'string') throw new Error('Document base64 source must have a data field');
      if (source.data.length > ANTHROPIC_MAX_BASE64_CHARS) throw new Error(`Document base64 data exceeds ${ANTHROPIC_MAX_BASE64_CHARS} characters`);
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: source.data },
        ...(title ? { title } : {}),
      };
    }

    throw new Error('Document source type must be "file" or "base64"');
  }

  throw new Error(`Unsupported content block type: ${block.type}`);
}

type ValidatedMessage = { role: 'user' | 'assistant'; content: string | ValidatedContentBlock[] };

async function validateAnthropicParams(params: unknown, allowedDirs: string[]): Promise<{
  messages: ValidatedMessage[];
  model: string;
  max_tokens: number;
  system?: string;
  /** Set only when the proxy chose the model itself — see the fallback below. */
  thinking?: { type: 'disabled' };
}> {
  if (!params || typeof params !== 'object') throw new Error('Invalid params');
  const p = params as Record<string, unknown>;

  if (!Array.isArray(p.messages) || p.messages.length === 0) throw new Error('messages must be a non-empty array');
  if (p.messages.length > ANTHROPIC_MAX_MESSAGES) throw new Error(`messages exceeds maximum of ${ANTHROPIC_MAX_MESSAGES}`);

  const messages: ValidatedMessage[] = [];
  for (const m of p.messages) {
    if (!m || typeof m !== 'object') throw new Error('Each message must be an object');
    const msg = m as Record<string, unknown>;
    if (msg.role !== 'user' && msg.role !== 'assistant') throw new Error('message role must be user or assistant');

    if (typeof msg.content === 'string') {
      if (msg.content.length > ANTHROPIC_MAX_TEXT_CHARS) throw new Error(`message content exceeds ${ANTHROPIC_MAX_TEXT_CHARS} characters`);
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      if (msg.content.length === 0) throw new Error('content array must not be empty');
      if (msg.content.length > ANTHROPIC_MAX_CONTENT_BLOCKS) throw new Error(`content array exceeds ${ANTHROPIC_MAX_CONTENT_BLOCKS} blocks`);
      const blocks = await Promise.all(msg.content.map((b: unknown) => resolveContentBlock(b, allowedDirs)));
      messages.push({ role: msg.role, content: blocks });
    } else {
      throw new Error('message content must be a string or array of content blocks');
    }
  }

  // Silently clamp model to the allowlist so agent code that specifies a model
  // always works, even if the model name is slightly wrong or has been removed.
  //
  // The fallback sends thinking OFF, because the code that relies on it was
  // written for Haiku 4.5, which never thought unasked: the skill docs taught
  // `msg.content[0].text`, and Haiku 5.5's default thinking puts a thinking
  // block at index 0 and spends the 1024-token default before the answer. A
  // model the app named explicitly is passed through untouched — that choice,
  // thinking included, is the app's.
  const requested = typeof p.model === 'string' && anthropicAllowedModels().has(p.model) ? p.model : null;
  const model = requested ?? BACKGROUND_MODEL;

  // Clamp rather than reject so the call still succeeds with a safe value.
  const max_tokens = typeof p.max_tokens === 'number' && p.max_tokens > 0
    ? Math.min(Math.floor(p.max_tokens), ANTHROPIC_MAX_TOKENS_LIMIT)
    : 1024;

  if (p.system !== undefined && typeof p.system !== 'string') throw new Error('system must be a string');
  if (typeof p.system === 'string' && p.system.length > ANTHROPIC_MAX_SYSTEM_CHARS) throw new Error(`system prompt exceeds ${ANTHROPIC_MAX_SYSTEM_CHARS} characters`);
  const system = typeof p.system === 'string' ? p.system : undefined;

  return { messages, model, max_tokens, system, ...(requested ? {} : { thinking: { type: 'disabled' as const } }) };
}

// Non-streaming completion. Uses ipcMain.handle so the result is automatically
// returned as a promise reply — no manual event sending required.
ipcMain.handle('anthropic:complete', async (_event, params: unknown) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  const { apiKey: completeApiKey, baseURL: completeBaseURL } = getCredentials();
  if (!completeApiKey) throw new Error(NO_API_KEY_MESSAGE);
  if (!activeWorkspace) throw new Error('No active workspace');
  const validated = await validateAnthropicParams(params, workspaceController.allAllowedPaths);
  log.info('[anthropic:complete] workspace=%s model=%s max_tokens=%d messages=%d',
    activeWorkspace.id, validated.model, validated.max_tokens, validated.messages.length);
  const client = new Anthropic({ apiKey: completeApiKey, baseURL: completeBaseURL });
  return client.messages.create({
    model: validated.model,
    max_tokens: validated.max_tokens,
    messages: validated.messages,
    ...(validated.system ? { system: validated.system } : {}),
    ...(validated.thinking ? { thinking: validated.thinking } : {}),
  });
});

// The streamKey is a UUID generated by MiniAppViewer (the trusted renderer),
// never by the iframe itself. This ensures no iframe-controlled string reaches
// IPC channel names or is used as a routing key in the main process.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Streaming completion. Uses ipcMain.on because multiple events need to be
// pushed back to the renderer (chunk, done, error) rather than a single reply.
// All events share one IPC channel name ('anthropic:stream:event') and are
// demultiplexed by streamKey on the renderer side.
ipcMain.on('anthropic:stream', async (event, { streamKey, params }: { streamKey: string; params: unknown }) => {
  if (typeof streamKey !== 'string' || !UUID_RE.test(streamKey)) {
    log.warn('[anthropic:stream] Invalid streamKey');
    return;
  }
  const { apiKey: streamApiKey, baseURL: streamBaseURL } = getCredentials();
  if (!streamApiKey) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: NO_API_KEY_MESSAGE });
    return;
  }
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: 'No active workspace' });
    return;
  }
  const streamAllowedDirs = workspaceController.allAllowedPaths;
  let validated: Awaited<ReturnType<typeof validateAnthropicParams>>;
  try {
    validated = await validateAnthropicParams(params, streamAllowedDirs);
  } catch (err) {
    event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: err instanceof Error ? err.message : String(err) });
    return;
  }
  log.info('[anthropic:stream] workspace=%s model=%s max_tokens=%d messages=%d',
    activeWorkspace.id, validated.model, validated.max_tokens, validated.messages.length);
  const client = new Anthropic({ apiKey: streamApiKey, baseURL: streamBaseURL });
  const stream = client.messages.stream({
    model: validated.model,
    max_tokens: validated.max_tokens,
    messages: validated.messages,
    ...(validated.system ? { system: validated.system } : {}),
    ...(validated.thinking ? { thinking: validated.thinking } : {}),
  });

  // Abort the SDK stream immediately if the renderer is destroyed (e.g. the
  // mini-app is closed mid-stream). Without this, the HTTP connection would
  // stay open and keep consuming tokens until the response finished naturally.
  const abort = () => stream.abort();
  event.sender.once('destroyed', abort);

  try {
    stream.on('text', (text) => {
      if (!event.sender.isDestroyed()) event.sender.send('anthropic:stream:event', { streamKey, type: 'chunk', payload: text });
    });
    const finalMsg = await stream.finalMessage();
    if (!event.sender.isDestroyed()) event.sender.send('anthropic:stream:event', { streamKey, type: 'done', payload: finalMsg });
  } catch (err) {
    // Includes AbortError when the renderer is destroyed — isDestroyed() guard
    // ensures we don't attempt to send to a dead WebContents.
    if (!event.sender.isDestroyed())
      event.sender.send('anthropic:stream:event', { streamKey, type: 'error', payload: err instanceof Error ? err.message : String(err) });
  } finally {
    event.sender.removeListener('destroyed', abort);
  }
});

ipcMain.handle('nativeTools:getUrl', async (_event, _toolId: string) => {
  return null;
});

ipcMain.handle('academia:fetch', async (_event, args: { method: string; endpoint: string; data?: unknown }) => {
  const { callBackendApi } = require('../../apiCall');
  return callBackendApi({ method: args.method as any, endpoint: args.endpoint, data: args.data });
});

// Auth IPC handlers
// Boot gate for the renderer: does a usable Anthropic key exist (env or
// settings)? Never returns the key itself — only `maskedKey`, computed here.
// `source` lets Settings show where the active key comes from (env keys are
// read-only from the UI's view).
ipcMain.handle('auth:getApiKeyStatus', () => {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  const { apiKey, baseURL } = resolveApiKey();
  return buildApiKeyStatus({
    apiKey,
    baseURL,
    source: envKey ? 'env' : (getCustomAnthropicKey() ? 'settings' : null),
  });
});

ipcMain.handle('auth:setApiKey', async (_event, key: string, baseURL?: string) => {
  const trimmed = (key || '').trim();
  if (!trimmed) return { success: false, error: 'API key is required' };
  // An ANTHROPIC_API_KEY env var overrides settings, so saving here would have
  // no visible effect — say so rather than silently no-op.
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      success: false,
      error: 'ANTHROPIC_API_KEY is set in the environment and takes precedence. Unset it to manage the key here.',
    };
  }
  const url = baseURL?.trim() || undefined;
  setCustomAnthropicKey(trimmed, url);
  setCredentials(trimmed, url);
  // Push to an already-running agent server so a pasted key takes effect
  // without an app restart. `force` because this is a deliberate save, not a
  // retry — see refreshAndPushCredentials.
  const pushed = await refreshAndPushCredentials({ force: true })
    .catch((err) => { log.warn('[Auth] push new key to agent failed:', err); return false; });
  log.info(`[Auth] Anthropic API key updated from Settings (pushed to agent: ${pushed})`);
  // Force past the TTL: if discovery previously failed on a bad or missing
  // key, the cached answer is an auth failure, and the whole point of this
  // save is that the key changed.
  void refreshModels({ apiKey: trimmed, baseURL: url }, true);
  // Ask Anthropic whether it accepts the key. The key is already saved, so a
  // rejection or a network failure never loses what the user pasted.
  const check = await checkAnthropicKey(trimmed, url);
  log.info(`[Auth] Key check: ${check.verdict}${check.detail ? ` (${check.detail})` : ''}`);
  // A failed push is not a failed save — the key is on disk and every future
  // session reads it — but it IS the case where a restart is genuinely needed,
  // so say so instead of reporting a clean success the next turn contradicts.
  if (!pushed) {
    return {
      success: true,
      warning: 'Saved. The assistant was not reachable just now, so restart Acabox if the next message still reports a key problem.',
      check,
    };
  }
  return { success: true, check };
});

// ─── Connectors IPC (user-configured MCP servers) ─────────────────
//
// Connectors live in cobuilding-settings.json under userData, NOT in the
// workspace — the agent has Write + Bash on the workspace, so a workspace file
// would let it provision its own remote MCP server. See shared/connectors.ts.

/**
 * Recompute the connector set and push it to the running agent server. Live
 * sessions pick it up immediately (the agent server calls setMcpServers on
 * each one), so a connector added in Settings works in the chat that's already
 * open — no new chat, no app restart.
 *
 * Returns whether the push landed. `false` just means no agent server is up
 * yet; the set is still persisted and every future session reads it.
 */
async function pushConnectorsToAgent(): Promise<boolean> {
  // Secrets must be real here — this is the payload the agent server hands to
  // the SDK. `listConnectors()` is the masked, IPC-safe view and would send
  // empty auth headers.
  const servers = buildMcpServers(listConnectorsWithSecrets());
  const ok = await containerService.updateAgentConnectors(servers);
  log.info(`[Connectors] Pushed ${Object.keys(servers).length} connector(s) to agent server: ${ok ? 'ok' : 'no live agent server'}`);
  return ok;
}

ipcMain.handle('connectors:list', () => {
  const workspacePath = workspaceController.workspacePath;
  return {
    connectors: listConnectors(),
    catalog: CONNECTOR_CATALOG,
    unmanaged: workspacePath ? detectUnmanagedMcpJson(workspacePath) : null,
  };
});

ipcMain.handle('connectors:save', async (_event, connector: ConnectorConfig, originalId?: string) => {
  // Ids share one namespace with hosted MCP servers (docs/design/mcp-hosting.md,
  // Increment 4) — pass the current hosted id set so a connector can't be
  // saved under a name a hosted server already owns. `mcpHost.list()` is a
  // cheap store read (no I/O to a live process, see the comment on
  // `mcpHost.onInventoryChanged` below).
  const hostedIds = (await mcpHost.list()).map((s) => s.id);
  const result = upsertConnector(connector, originalId, hostedIds);
  if (!result.success) return { ...result, pushed: false };
  const pushed = await pushConnectorsToAgent();
  return { ...result, pushed };
});

ipcMain.handle('connectors:remove', async (_event, id: string) => {
  const result = removeConnector(id);
  const pushed = await pushConnectorsToAgent();
  return { ...result, pushed };
});

ipcMain.handle('connectors:setEnabled', async (_event, id: string, enabled: boolean) => {
  const result = setConnectorEnabled(id, enabled);
  if (!result.success) return { ...result, pushed: false };
  const pushed = await pushConnectorsToAgent();
  return { ...result, pushed };
});

// Real connection state from the SDK. `live: false` means no chat session is
// running, so nothing has been observed — the UI shows "unknown" rather than
// inventing a status.
ipcMain.handle('connectors:getStatus', async () => {
  const status = await containerService.getAgentConnectorStatus();
  // Be tolerant of an unexpected response body. An agent server from an older
  // build has no /connectors route and answers `{"error":"Not found"}` — which
  // happens for real when a dev instance latches onto a packaged app's agent
  // server (see the findFreePort hazard in CLAUDE.md). Surfacing that as a
  // thrown IPC error would put plumbing in front of the user.
  const reports = (Array.isArray(status.servers) ? status.servers : []).map((s: any) => ({
    name: s?.name,
    status: s?.status ?? 'unknown',
    error: s?.error,
    toolCount: Array.isArray(s?.tools) ? s.tools.length : undefined,
    scope: s?.scope,
  }));
  if (status.live) recordConnectorStatus(reports);
  const cached = getConnectorStatus();
  return {
    live: status.live,
    reports: status.live ? reports : cached.reports,
    observedAt: cached.observedAt,
  };
});

ipcMain.handle('connectors:removeUnmanaged', () => {
  const workspacePath = workspaceController.workspacePath;
  if (!workspacePath) return { success: false, error: 'No active workspace.' };
  return removeUnmanagedMcpJson(workspacePath);
});

// ─── APIs IPC ─────────────────────────────────────────────────────
//
// Unlike connectors, there is NOTHING to push to the agent server on a change:
// `apiProxy` reads the store on every single request, so an added key, a
// flipped write toggle or a removed API takes effect on the next call with no
// session involvement at all. The one session-scoped piece is the guidance
// block in the system prompt, which is why the UI says a new API is only
// *announced* to the next chat while `mcp__apis__list_apis` reads live state.
//
// `listApis()` is the masked accessor — secrets never cross this boundary.

// ─── Models IPC ───────────────────────────────────────────────────────
//
// The merge happens HERE rather than in the renderer so that the picker, the
// mini-app allowlist and anything else asking "what models are there" all read
// one answer computed one way. `refresh` is fire-and-forget on purpose: the
// reply is whatever is already known, so opening the picker never waits on the
// network, and the next open shows anything the refresh turned up.
ipcMain.handle('models:list', () => {
  void refreshModels(resolveApiKey());
  return {
    models: mergeModels(discoveredModels()),
    defaultModel: DEFAULT_MODEL,
    discoveredCount: discoveredModels().length,
    error: discoveryError(),
  };
});

ipcMain.handle('apis:list', () => ({
  apis: listApis(),
  catalog: API_CATALOG,
  counters: getApiCounters(),
  proxy: {
    running: apiProxy.isRunning(),
    baseUrl: apiProxy.baseUrl(),
    error: apiProxy.error(),
  },
}));

ipcMain.handle('apis:save', (_event, api: ApiConfig, originalId?: string, clearSecret?: boolean) =>
  upsertApi(api, originalId, clearSecret === true));

ipcMain.handle('apis:remove', (_event, id: string) => removeApi(id));

ipcMain.handle('apis:setEnabled', (_event, id: string, enabled: boolean) =>
  setApiEnabled(id, enabled));

ipcMain.handle('apis:setAllowWrites', (_event, id: string, allowWrites: boolean) =>
  setApiAllowWrites(id, allowWrites));

/**
 * Teach the proxy how to read a tool's granted APIs.
 *
 * Registered here because this module owns the workspace path; `apiProxy.ts`
 * stays free of manifest knowledge. Both doors — the postMessage one below and
 * the HTTP one in the proxy — resolve grants through this single function, so
 * a tool's subprocess and its iframe are held to exactly the same list.
 *
 * Read from disk on every call rather than cached: revoking a grant in the UI
 * has to take effect on the next request, not the next launch.
 */
setToolGrantResolver((dirName) => {
  const workspacePath = workspaceController.workspacePath;
  if (!workspacePath) return [];
  // Defence in depth — the HTTP door reaches this with a dirName taken from a
  // token we minted, but the IPC door's comes from the renderer.
  if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
    return [];
  }
  try {
    const manifestPath = path.join(workspacePath, '.applications', dirName, 'manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return Array.isArray(parsed?.apis)
      ? parsed.apis.filter((a: unknown): a is string => typeof a === 'string')
      : [];
  } catch {
    return []; // no manifest, or unreadable — no grants, which is the safe read
  }
});

/**
 * The mini-app door onto the API proxy (Phase 2).
 *
 * WHY THIS EXISTS AT ALL, rather than handing the iframe the loopback URL: the
 * per-app grant needs trustworthy caller identity, and an iframe's fetch has
 * none. A request arriving at the loopback server from a `local-file://`
 * document carries an opaque (`null`) origin, so the proxy could not tell tool
 * A from tool B and the grant the user chose would silently not be enforced.
 * This path does have identity — `MiniAppViewer` validates `event.source`
 * against the iframe it owns and knows that tool's `dirName`, the same
 * mechanism `miniAppLinkShim` and the MCP registry already rely on.
 *
 * The renderer supplies `dirName`; the GRANT is read here, from the manifest on
 * disk, never from the renderer. A compromised renderer can lie about which
 * tool is calling, but it cannot invent a grant.
 *
 * Unlike the HTTP door the response is buffered, not streamed: postMessage
 * cannot carry a stream, and the large-download case belongs to the agent.
 */
ipcMain.handle('apis:request', async (_event, dirName: string, req: {
  apiId: string; method?: string; path?: string;
  headers?: Record<string, string>; body?: string;
}) => {
  try {
    if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
      return { ok: false, status: 400, error: 'Invalid tool name.' };
    }
    const workspacePath = workspaceController.workspacePath;
    if (!workspacePath) return { ok: false, status: 500, error: 'No active workspace.' };

    const outcome = await performApiRequest({
      apiId: String(req?.apiId ?? ''),
      method: req?.method ?? 'GET',
      path: req?.path ?? '',
      headers: req?.headers,
      body: req?.body ? new TextEncoder().encode(req.body) : null,
      // Through the same resolver the HTTP door uses, so the two doors cannot
      // drift into disagreeing about what a tool has been granted.
      caller: callerWithGrants({ kind: 'miniapp', dirName }),
    });

    if (outcome.error || !outcome.body) {
      return { ok: false, status: outcome.status, error: outcome.error ?? null, headers: outcome.headers };
    }
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: outcome.headers,
      body: await new Response(outcome.body).text(),
    };
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * Send one real GET at the API's base URL and report what came back.
 *
 * This exists because "did my key actually work" is otherwise unanswerable
 * without starting a chat and asking the agent to try — and it deliberately
 * goes through `performApiRequest`, the same policy engine the agent uses, so
 * a green result here means the agent's path works rather than merely that the
 * host is reachable.
 *
 * The response body is discarded, but it must be CANCELLED rather than ignored
 * or the socket stays open until GC.
 */
/**
 * "Test" — does this API actually work, and is the KEY actually good?
 *
 * Two GETs, never a write. The second one deliberately withholds the
 * credential, because a single authenticated status cannot answer the
 * question: measured on the real catalog, `api.github.com/` and
 * `api.osf.io/v2/` return 200 with no credential at all, while Hex, Zenodo
 * and Figshare return 404 at their root even with a good one. Comparing the
 * two answers is what makes the verdict honest — see `interpretApiTest`.
 *
 * The unauthenticated probe is skipped when the first answer is already
 * decisive (401/403 is an auth failure however the anonymous request would
 * have gone), so the common failure costs one request, not two.
 */
ipcMain.handle('apis:test', async (_event, id: string) => {
  const probe = async (omitCredential: boolean) => {
    const outcome = await performApiRequest({
      apiId: id,
      method: 'GET',
      // A curated auth-gated endpoint where we have one; the base URL
      // otherwise. `testPathFor` explains why the base URL is a poor test.
      path: testPathFor(id),
      caller: { kind: 'chat' },
      ...(omitCredential ? { omitCredential: true } : {}),
    });
    // Nothing reads the body — cancel it rather than leaving the socket open.
    void outcome.body?.cancel().catch(() => { /* already closed */ });
    return outcome;
  };

  try {
    const authed = await probe(false);
    // A proxy refusal (bad id, disabled, write gate) is our own message and is
    // already the most useful thing we can say — do not second-guess it.
    if (authed.error) {
      return { status: authed.status, ok: false, verdict: 'unauthorized', detail: authed.error };
    }

    const api = listApis().find((a) => a.id === id);
    const hasSecret = api?.hasSecret === true;
    const decisive = authed.status === 401 || authed.status === 403;
    const unauthed = (!decisive && hasSecret) ? await probe(true).catch(() => null) : null;

    const { verdict, detail } = interpretApiTest({
      authedStatus: authed.status,
      ...(unauthed ? { unauthedStatus: unauthed.status } : {}),
      hasSecret,
      secretOptional: API_CATALOG.find((c) => c.id === id)?.secretOptional,
    });
    return { status: authed.status, ok: verdict === 'ok', verdict, detail };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      verdict: 'unreachable' as const,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
});

/**
 * The path "Test" should hit for an API.
 *
 * The bare base URL is a bad test and the catalog measurements say why: most
 * of these APIs have no resource at their root, so it 404s for a correctly
 * configured key, and two of them answer 200 to anyone at all. A curated
 * `testPath` is an endpoint verified to return 401/403 unauthenticated, which
 * is what lets a 2xx mean something. Custom APIs have no curation, so they
 * fall back to the base URL and lean on the unauthenticated comparison
 * instead.
 */
function testPathFor(id: string): string {
  const stored = listApis().find((a) => a.id === id);
  const entry = API_CATALOG.find((c) => c.id === id || c.catalogId === stored?.catalogId);
  return entry?.testPath ?? '';
}

// ─── Skills IPC ───────────────────────────────────────────────────
//
// Every mutation that changes WHICH skills are enabled has to reach three
// places, in this order: the store (the record), the render (the symlinks the
// CLI reads), and the running agent server's roster allowlist. Skipping the
// third is not a cosmetic lag — it is the enable appearing to have worked in
// the UI while the model cannot see the skill.

/**
 * Re-render the symlinks and push the roster to the agent server.
 *
 * Returns whether the agent server took the push. `false` most often means
 * there is no live agent server (the user has not started a chat this run), in
 * which case the next `agentInfrastructure.start()` reads the store anyway —
 * so it is informational, not a failure.
 */
async function applySkillChanges(): Promise<boolean> {
  const workspacePath = workspaceController.workspacePath;
  const state = await readSkillsState();
  if (workspacePath) {
    try {
      await renderSkills(workspacePath, state);
    } catch (err) {
      log.error(`[Skills] Render failed: ${(err as Error).message}`);
    }
  }
  const roster = buildSkillRuntimeConfig(state);
  const pushed = await containerService.updateAgentSkills(roster);
  log.info(`[Skills] Roster now ${roster.length} skill(s); agent server ${pushed ? 'updated' : 'not running'}`);
  return pushed;
}

ipcMain.handle('skills:list', async () => {
  const skills = await listSkills();
  // Findings counts come from the ledger, which is the only thing that knows
  // the file format. `undefined` means "no ledger", which the UI must render
  // as nothing at all rather than as 0 — a skill with an empty ledger and a
  // skill that has never had one are different states.
  return skills.map((s) => ({ ...s, findingsCount: countActiveFindings(s.id) }));
});

ipcMain.handle('skills:read', async (_event, id: string, relPath: string) => {
  try {
    return { ok: true, content: await readSkillFile(id, relPath) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('skills:write', async (_event, id: string, relPath: string, content: string) => {
  const result = await writeSkillFile(id, relPath, content);
  if (result.ok) await applySkillChanges();
  return result;
});

ipcMain.handle('skills:create', async (_event, id: string, description?: string) => {
  const result = await createSkill(id, { description });
  if (result.ok) await applySkillChanges();
  return result;
});

ipcMain.handle('skills:delete', async (_event, id: string) => {
  const result = await deleteSkill(id);
  if (result.ok) await applySkillChanges();
  return result;
});

ipcMain.handle('skills:setEnabled', async (_event, id: string, enabled: boolean) => {
  const result = await setSkillEnabled(id, enabled);
  if (!result.ok) return { ...result, pushed: false };
  const pushed = await applySkillChanges();
  return { ...result, pushed };
});

ipcMain.handle('skills:revertFile', async (_event, id: string, relPath: string) => {
  const result = await revertFile(id, relPath);
  if (result.ok) await applySkillChanges();
  return result;
});

ipcMain.handle('skills:revert', async (_event, id: string) => {
  const result = await revertSkill(id);
  if (result.ok) await applySkillChanges();
  return result;
});

/** "Keep mine" against an upstream change. Writes no bytes, so no re-render. */
ipcMain.handle('skills:dismissUpdate', (_event, id: string, relPath: string) => {
  return dismissFileUpdate(id, relPath);
});

/** Real counts for the Restore-all confirm dialog — never prose, never a guess. */
ipcMain.handle('skills:summarizeRestore', () => summarizeBuiltinRestore());

ipcMain.handle('skills:restoreAll', async () => {
  const result = await restoreAllBuiltins();
  await applySkillChanges();
  return result;
});

ipcMain.handle('skills:reveal', (_event, id: string) => {
  // `skillStorePath` is a bare join, so an unvalidated id walks out of the
  // store — `..` would open userData itself in Finder.
  const idCheck = validateSkillId(id);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };
  const dir = skillStorePath(id);
  if (!fs.existsSync(dir)) return { ok: false, error: 'That skill is not in the store.' };
  shell.showItemInFolder(dir);
  return { ok: true };
});

// ─── Skill import IPC ─────────────────────────────────────────────
//
// Four steps, in the order the user takes them: resolve what they pasted,
// browse it, look at one skill, commit it. They are separate handlers rather
// than one call because every one of them is a decision point the user can
// back out of, and because the service caches between them — the 21 MB
// `openai/plugins` tarball is downloaded once for the whole flow.
//
// Errors are THROWN here rather than returned as `{ ok: false }`, unlike the
// mutation handlers above. These are network and filesystem failures with real
// messages already written for a human ("GitHub's hourly request limit is used
// up … it resets at 18:04"), and the renderer needs exactly that string; the
// `{ ok }` shape exists for store mutations whose failure is a rule, not an
// accident. Electron's `invoke` wrapper prefixes a rejection with "Error
// invoking remote method", so the renderer strips it — see `importError`.

/** Progress for the import modal. Bytes only; codeload sends no total. */
function sendImportProgress(progress: ImportProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('skills:importProgress', progress);
  }
}

ipcMain.handle('skills:parseImportUrl', (_event, input: string) => parseImportUrl(input));

ipcMain.handle('skills:fetchCatalogue', (_event, target: ImportUrlTarget) =>
  loadCatalogue(target, sendImportProgress),
);

ipcMain.handle('skills:previewImport', (_event, request: ImportRequest) =>
  previewImport(request, sendImportProgress),
);

/**
 * Pick a folder to import.
 *
 * Only the picker: the folder then goes through the same `previewImport` and
 * `skills:import` as a GitHub subpath, which is what keeps the disclosure, the
 * safety pass and the provenance record identical for both. A local folder can
 * hold a symlink just as easily as a tarball can.
 */
ipcMain.handle('skills:pickImportFolder', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a skill folder',
    message: 'Pick the folder that contains SKILL.md.',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('skills:import', async (_event, request: ImportRequest, asId?: string) => {
  const result = await commitImport(request, asId, sendImportProgress);
  if (!result.ok) return result;
  // The render has to happen even though the skill is disabled: a disabled
  // skill keeps its symlink so it stays readable and so enabling it later is
  // not a mid-session filesystem change. The roster push is what actually
  // withholds it from the model.
  await applySkillChanges();
  const descriptor = (await listSkills()).find((s) => s.id === result.id);
  return { ...result, skill: descriptor };
});

/** Free the unpacked catalogue and any staged trees. Called when the modal closes. */
ipcMain.handle('skills:cancelImport', () => disposeImportCaches());

// ─── Knowledge IPC ────────────────────────────────────────────────

ipcMain.handle('knowledge:ledger', (_event, skill: string) => {
  const snapshot = readLedger(skill);
  // The blocks are the full entry bodies and a mature ledger is tens of KB;
  // the list view needs the metadata, not the prose. A caller wanting a body
  // reads the bucket file through filesAPI.
  return {
    skill: snapshot.skill,
    dir: snapshot.dir,
    exists: snapshot.exists,
    bytes: snapshot.bytes,
    lastReadNote: LAST_READ_GRANULARITY_NOTE,
    active: snapshot.active.map((f) => ({ ...f.meta, title: f.title, rule: f.rule, file: f.file })),
    archived: snapshot.archived.map((f) => ({ ...f.meta, title: f.title, rule: f.rule, file: f.file })),
  };
});

ipcMain.handle('knowledge:supersede', (_event, skill: string, id: string, bySupersedingId?: string) => {
  const ok = supersedeFinding(skill, id, bySupersedingId);
  return { ok, error: ok ? undefined : `No active finding ${id} in ${skill}.` };
});

ipcMain.handle('knowledge:listReviews', () => listKnowledgeReviews());

ipcMain.handle('knowledge:dismissReview', (_event, id: string) => {
  return { ok: dismissKnowledgeReview(id) };
});

/**
 * The real contents of the agent-memory directory.
 *
 * This exists rather than being assembled in the renderer from `filesAPI`
 * because three of the four facts a memory row needs are not reachable from
 * there. `files:readDirectory` returns name/path/isDirectory only — no size and
 * no mtime — so "3.0 KB · changed 3h ago" would have to be invented; and
 * `originSessionId` is an SDK session id, which `SessionData` does not carry,
 * so the link to the chat that wrote the file can only be resolved against
 * `sessions.sdk_session_id` here.
 *
 * No actor is reported. A file changed in Finder or vim is indistinguishable
 * from one Claude wrote, so the row says `changed`, never `edited by you`. The
 * one attribution that IS evidence-backed is `originSessionId`, which the CLI
 * stamps when it authors the file — that becomes the "from <chat>" link.
 */
ipcMain.handle('knowledge:memories', () => {
  const workspacePath = workspaceController.workspacePath;
  if (!workspacePath) return { dir: null, files: [] };
  const dir = path.join(workspacePath, AGENT_MEMORY_SUBDIR);

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch {
    // No memory directory yet is an ordinary state, not an error: nothing has
    // written a memory in this workspace.
    return { dir, files: [] };
  }

  const indexText = (() => {
    try {
      return fs.readFileSync(path.join(dir, MEMORY_INDEX_FILE), 'utf-8');
    } catch {
      return '';
    }
  })();

  // Resolve origin chats in one pass; `sdk_session_id` is the only join key and
  // it is null for chats that never took a turn.
  const bySdkId = new Map<string, { id: string; title: string }>();
  for (const s of listSessions()) {
    if (s.sdk_session_id) bySdkId.set(s.sdk_session_id, { id: s.id, title: s.title });
  }

  const files = names.map((name) => {
    const abs = path.join(dir, name);
    let bytes = 0;
    let changedAt = 0;
    try {
      const st = fs.statSync(abs);
      bytes = st.size;
      changedAt = st.mtimeMs;
    } catch { /* raced with a delete; the row still renders by name */ }

    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch { /* unreadable — no frontmatter, row renders by filename */ }

    // Same parser the skill roster uses, so a memory with a broken frontmatter
    // fence is reported the same way a skill with one is.
    const fm = parseSkillFrontmatter(text);
    const raw = (fm.raw ?? {}) as Record<string, unknown>;
    const strOf = (k: string): string | undefined => {
      const v = raw[k];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const originSessionId = strOf('originSessionId');

    return {
      file: name,
      /** `.academia`-relative, i.e. what `academiaFile:read/write` takes. */
      academiaPath: `${AGENT_MEMORY_DIR}/${name}`,
      bytes,
      changedAt,
      declaredName: strOf('name'),
      description: fm.description,
      type: strOf('type'),
      originSessionId,
      originChat: originSessionId ? bySdkId.get(originSessionId) ?? null : null,
      // A link anywhere in MEMORY.md is what makes the file reachable; the CLI
      // writes them as `[title](file.md)`, so match the filename, not a format.
      indexed: indexText.includes(name),
      isIndex: name === MEMORY_INDEX_FILE,
      frontmatterOk: fm.ok,
      frontmatterError: fm.error,
    };
  });

  files.sort((a, b) => {
    // The index first — it is the only file always in context — then newest.
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    return b.changedAt - a.changedAt;
  });
  return { dir, files };
});

ipcMain.handle('auth:setEndpoint', (_event, endpoint: string) => {
  if (app.isPackaged) {
    return { success: false, error: 'Endpoint switching is not available in packaged builds' };
  }
  const url = endpoint === 'production' ? 'https://api.academia.edu/' : 'https://api.devdemia.com/';
  activeApiBaseUrl = url;
  setBaseUrl(url);

  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.apiEndpoint = endpoint;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');

  log.info(`[Auth] Switched API endpoint to ${endpoint} (${url})`);
  return { success: true, endpoint };
});

// Scheduled Tasks IPC handlers
ipcMain.handle('scheduledTasks:list', () => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return [];
  return listTasks(activeWorkspace.id);
});

ipcMain.handle('scheduledTasks:get', (_event, id: string) => {
  return getTask(id) ?? null;
});

ipcMain.handle('scheduledTasks:create', (_event, data: CreateTaskData) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = createTask(activeWorkspace.id, data.name, data.description, data.prompt, data.cron_expression, data.session_source ?? null);
  getTaskScheduler()?.scheduleTask(task.id);
  return task;
});

ipcMain.handle('scheduledTasks:update', (_event, id: string, data: UpdateTaskData) => {
  const task = updateTask(id, data);
  if (task) {
    if (task.enabled) {
      getTaskScheduler()?.scheduleTask(id);
    } else {
      getTaskScheduler()?.unscheduleTask(id);
    }
  }
  return task ?? null;
});

ipcMain.handle('scheduledTasks:delete', (_event, id: string) => {
  getTaskScheduler()?.unscheduleTask(id);
  deleteTask(id);
});

ipcMain.handle('scheduledTasks:setEnabled', (_event, id: string, enabled: boolean) => {
  setTaskEnabled(id, enabled);
  if (enabled) {
    getTaskScheduler()?.scheduleTask(id);
  } else {
    getTaskScheduler()?.unscheduleTask(id);
  }
});

ipcMain.handle('scheduledTasks:runNow', async (_event, id: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  await runScheduledTask(task, activeWorkspace, handleNotificationNavigation, refreshAndPushCredentials);
});

ipcMain.handle('scheduledTasks:listRuns', (_event, taskId: string) => {
  return listTaskRuns(taskId);
});

// .academia/ file IPC handlers
ipcMain.handle('academiaFile:read', async (_event, relativePath: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) return { content: '' };
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { content: '' };
  }
  if (containerService.isOverlayEnabled() && containerService.isRunning()) {
    try {
      const { stdout } = await containerService.exec(['cat', `/data/${ACADEMIA_DIR}/${normalized}`]);
      return { content: stdout };
    } catch {
      return { content: '' };
    }
  }
  const filePath = path.join(workspaceController.workspacePath!, ACADEMIA_DIR, normalized);
  try {
    return { content: await fsPromises.readFile(filePath, 'utf-8') };
  } catch {
    return { content: '' };
  }
});

ipcMain.handle('academiaFile:write', async (_event, relativePath: string, content: string) => {
  const activeWorkspace = workspaceController.activeWorkspace;
  if (!activeWorkspace) throw new Error('No active workspace');
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('Invalid path');
  }
  if (containerService.isOverlayEnabled() && containerService.isRunning()) {
    await containerService.writeContentToContainer(content, `/data/${ACADEMIA_DIR}/${normalized}`);
  } else {
    const filePath = path.join(workspaceController.workspacePath!, ACADEMIA_DIR, normalized);
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content, 'utf-8');
  }
});

// Shell IPC handlers
ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new Error('Invalid URL');
  }
  await shell.openExternal(url);
});

ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (_event, url: string) => {
  try {
    const validation = validateExternalUrl(url);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }
    await shell.openExternal(url);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Quitting does NOT stop a tool's work — that is deliberate, so closing the lid
 * at 6pm doesn't destroy a two-hour analysis. But it must never be a surprise:
 * work that outlives the app is invisible until Acabox is reopened, so the user
 * is told, and given the chance to stop it. Set once the user has answered, so
 * the second `before-quit` (after we re-issue the quit) passes straight through.
 */
let quitConfirmed = false;

// See appTeardown.ts's module comment for why the 12 teardown steps live on
// `will-quit` and NOT on this listener: `event.preventDefault()` here does
// not stop a second `before-quit` listener from running to completion, so
// teardown on `before-quit` ran on every emission — including "Cancel", where
// the app was meant to stay open. This listener owns only the dialog now.
app.on('before-quit', (event) => {
  handleBeforeQuit(event, {
    isQuitConfirmed: () => quitConfirmed,
    setQuitConfirmed: (value) => { quitConfirmed = value; },
    // Never block a quit nobody is there to answer: the smoke test drives a
    // headless boot-then-exit, and a modal would hang it forever.
    isSmokeTest: () => process.argv.includes('--smoke-test'),
    allWindowsDestroyed: () => BrowserWindow.getAllWindows().every((w) => w.isDestroyed()),
    activeJobs,
    cancelAll,
    showQuitDialog: (names, count) => dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Quit', 'Stop them and quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: count === 1
        ? '1 tool is still working.'
        : `${count} pieces of work are still running.`,
      detail:
        `${names.join(', ')}\n\n` +
        "This work will keep running in the background and finish on its own. " +
        'Acabox will show you what happened the next time you open it.',
    }),
    quit: () => app.quit(),
  });
});

const appTeardown = createTeardown([
  ['globalShortcut.unregisterAll', () => globalShortcut.unregisterAll()],
  ['stopFileMonitor', stopFileMonitor],
  ['stopDictation', stopDictation],
  // Never leave a CLI child holding a Claude Design browser flow open.
  ['cancelDesignLogin', cancelDesignLogin],
  ['stopScheduledTasks', stopScheduledTasks],
  ['backgroundBuilder.dispose', () => backgroundBuilder.dispose()],
  ['destroyTokenManager', destroyTokenManager],
  ['destroyAllSessions', destroyAllSessions],
  ['containerService.stop', () => containerService.stop()],
  // Fire-and-forget: these steps are synchronous by contract and the app is
  // going away regardless. Closing the listener still matters — an orphaned
  // bind would make the next run pick 23501 and leave a dead port held.
  ['apiProxy.stop', () => { void apiProxy.stop(); }],
  ['closeSchedulingDatabase', closeSchedulingDatabase],
  ['closeObservationsDatabase', closeObservationsDatabase],
  ['closeDatabase', closeDatabase],
]);

// `will-quit` fires only once a `before-quit` emission has run to completion
// with nothing having called `preventDefault()` — i.e. exactly when the app
// is actually going away — and is not re-emitted by the nested `app.quit()`
// above. `handleWillQuit`'s own re-entrancy guard also makes this safe
// however many times `will-quit` ends up firing across the app's lifetime
// (tray quit, ⌘Q, the Debug tab's hard reset). It is async (R14): it awaits
// `mcpHost.shutdown()` — stopping every hosted MCP server's child process —
// behind a hard watchdog, so a wedged stdio child can delay `app.exit(0)` by
// at most ~5s, never forever.
app.on('will-quit', (event) => {
  void handleWillQuit(event, {
    teardown: appTeardown,
    shutdownMcpHost: (opts) => mcpHost.shutdown(opts),
    exit: (code) => app.exit(code),
  });
});

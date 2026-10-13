import type { TextEditTarget, TextEditApplyRequest, TextEditProbeResult, TextEditApplyResult, TextEditUndoResult } from '../shared/miniAppTextEdit';
import type { ChatAPI, Workspace, WorkspaceDirectory, ScheduledTask, ScheduledTaskRun, CreateTaskData, UpdateTaskData, CalendarGroup, CalendarEvent, EventFile, GroupFile, CreateGroupData, UpdateGroupData, CreateEventData, UpdateEventData, EventDependency, CreateDependencyData, UpdateDependencyData, CascadeUpdate, CalendarResource, CalendarResourceType, CreateResourceData, UpdateResourceData, MoveResourceData, ListResourcesOptions, WorkspaceFileEntry } from '../shared/types';

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

type FileContent =
  | { type: 'text'; content: string }
  | { type: 'image'; fileUrl: string }
  | { type: 'pdf'; fileUrl: string }
  | { type: 'markdown'; content: string }
  | { type: 'csv'; content: string; delimiter: string }
  | { error: 'too-large'; size: number };

interface CopyProgress {
  copied: number;
  total: number;
  currentName: string | null;
}

interface FilesAPI {
  readDirectory(dirPath: string): Promise<DirEntry[]>;
  readFile(filePath: string): Promise<FileContent>;
  fileExists(filePath: string): Promise<boolean>;
  findByName(filename: string, hintDirs: string[]): Promise<string | null>;
  findByExtension(extensions: string[]): Promise<{ relPath: string; path: string; mtimeMs: number; size: number }[]>;
  downloadFile(filename: string, content: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
  showInFinder(filePath: string): Promise<void>;
  revealInFinder(filePath: string): Promise<void>;
  copyToWorkspace(sourcePaths: string[], destinationDir: string): Promise<{ copied: number }>;
  moveFile(sourcePath: string, destinationDir: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  trashFile(filePath: string): Promise<void>;
  createFile(filePath: string): Promise<void>;
  createDirectory(dirPath: string): Promise<void>;
  renameFile(filePath: string, newName: string): Promise<void>;
  convertImageToPng(base64Data: string): Promise<string>;
  getPathForFile(file: File): string;
  onCopyProgress(callback: (progress: CopyProgress) => void): () => void;
  onWorkspaceChanged(callback: () => void): () => void;
}

interface WorkspacesAPI {
  getActive(): Promise<Workspace | null>;
  selectDirectory(): Promise<string | undefined>;
  listDirectories(): Promise<WorkspaceDirectory[]>;
}

interface SessionData {
  id: string;
  title: string;
  source: string | null;
  document_path: string | null;
  /** Mini-app this chat belongs to, or null for a general chat. */
  app_dir_name: string | null;
  /** Model the conversation is pinned to; null until its first turn records one. */
  model: string | null;
  /** Reasoning-effort level pinned to the conversation; null on pre-existing chats. */
  effort: string | null;
  created_at: string;
  updated_at: string;
}

/** A chat plus the timestamp of its newest message (null when it has none). */
interface AppSessionData extends SessionData {
  last_message_at: string | null;
}

interface MessageData {
  id: number;
  session_id: string;
  type: string;
  content: string;
  created_at: string;
}

/** Mirrors main/db/chatSearch.ts; contract in docs/design/chat-search.md. */
interface ChatPreviewData { sessionId: string; userText: string; assistantText: string; }
interface ProseHitData { messageId: number; role: 'user' | 'assistant'; createdAt: string; snippet: string; }
interface ChatProseResultData { sessionId: string; total: number; hits: ProseHitData[]; }

interface SessionsAPI {
  list(source?: string): Promise<SessionData[]>;
  get(id: string): Promise<SessionData | undefined>;
  cost(id: string): Promise<number | null>;
  setDocumentPath(id: string, documentPath: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  listMessages(sessionId: string): Promise<MessageData[]>;
  previews(): Promise<ChatPreviewData[]>;
  searchProse(query: string): Promise<ChatProseResultData[]>;
  findForApp(dirName: string): Promise<string | null>;
  listForApp(dirName: string): Promise<AppSessionData[]>;
  createForApp(dirName: string): Promise<string | null>;
  onTitleUpdated(callback: (sessionId: string, title: string) => void): () => void;
  onSessionsChanged(callback: () => void): () => void;
  getActivity(): Promise<{ activeIds: string[]; unreadIds: string[] }>;
  onActivityChanged(callback: (snapshot: { activeIds: string[]; unreadIds: string[] }) => void): () => void;
  setViewing(sessionId: string | null): void;
  onForeignTurnDone(callback: (sessionId: string) => void): () => void;
}

interface ContainerAPI {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ running: boolean; agentAlive: boolean; gaveUp: boolean }>;
  exec(command: string[]): Promise<{ stdout: string; stderr: string }>;
  execLogged(command: string[], meta?: { source?: string; appDirName?: string | null }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  quitApp(): Promise<void>;
  relaunchApp(): Promise<void>;
  ensureSetup(): Promise<void>;
  getEnvironmentInfo(): Promise<EnvironmentInfoPayload | null>;
  appDepsReady(dirName: string): Promise<boolean>;
  ensureAppDeps(dirName: string): Promise<{ installed: string[] }>;
  getAppInstallRequests(dirName: string): Promise<Array<{ registry: PackageRegistry; packages: string[] }>>;
  onSetupProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
  onProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
  onPackageState(callback: (e: { registry: PackageRegistry; package: string; state: PackageState }) => void): () => void;
  onPackageLine(callback: (e: { registry: PackageRegistry; package: string; line: string }) => void): () => void;
}

interface AuthAPI {
  getApiKeyStatus(): Promise<{ hasKey: boolean; source: 'env' | 'settings' | null; baseURL: string | null; maskedKey: string | null }>;
  /** `warning` = saved to disk, but the running assistant could not be told; a restart may be needed. */
  setApiKey(key: string, baseURL?: string): Promise<{ success: boolean; error?: string; warning?: string; check?: { verdict: 'accepted' | 'rejected' | 'unconfirmed'; detail?: string } }>;
  isDev: boolean;
  setEndpoint(endpoint: string): Promise<{ success: boolean; endpoint: string }>;
}

/** Settings → Claude Design. Shapes come from `shared/claudeDesign.ts`. */
type DesignLoginStatusT = import('../shared/claudeDesign').DesignLoginStatus;
type DesignLoginEventT = import('../shared/claudeDesign').DesignLoginEvent;

interface ClaudeDesignAPI {
  getStatus(): Promise<DesignLoginStatusT>;
  signIn(): Promise<{ ok: true } | { ok: false; error: string }>;
  submitCode(code: string): Promise<{ ok: true } | { ok: false; error: string }>;
  reopenPage(): Promise<{ ok: boolean }>;
  cancel(): Promise<void>;
  onEvent(callback: (event: DesignLoginEventT) => void): () => void;
}

/**
 * Settings → Connectors. Shapes come from `shared/connectors.ts`; imported as
 * types only so this ambient file stays declaration-only.
 */
type ConnectorConfigT = import('../shared/connectors').ConnectorConfig;
type CatalogEntryT = import('../shared/connectors').CatalogEntry;
type ConnectorStatusReportT = import('../shared/connectors').ConnectorStatusReport;

interface ConnectorMutationResultT {
  success: boolean;
  error?: string;
  connectors: ConnectorConfigT[];
  /** Whether the new set reached a running agent server (false = none up). */
  pushed: boolean;
}

interface ConnectorsAPI {
  list(): Promise<{
    connectors: ConnectorConfigT[];
    catalog: CatalogEntryT[];
    /** An agent-written `.mcp.json` at the workspace root, if any. */
    unmanaged: { path: string; serverNames: string[] } | null;
  }>;
  save(connector: ConnectorConfigT, originalId?: string): Promise<ConnectorMutationResultT>;
  remove(id: string): Promise<ConnectorMutationResultT>;
  setEnabled(id: string, enabled: boolean): Promise<ConnectorMutationResultT>;
  /** `live: false` means no session is running, so nothing was observed. */
  getStatus(): Promise<{
    live: boolean;
    reports: ConnectorStatusReportT[];
    observedAt: number | null;
  }>;
  removeUnmanaged(): Promise<{ success: boolean; error?: string }>;
  /**
   * Pushed whenever observed connector status changes — every SDK `init`
   * event, and once more when the last registered session is torn down
   * (`live` flips to `false`, demoting any cached "Connected" report to
   * "Not checked" without anyone having to poll). Same shape as `getStatus()`.
   */
  onStatusChanged(callback: (status: {
    live: boolean;
    reports: ConnectorStatusReportT[];
    observedAt: number | null;
  }) => void): () => void;
}

/**
 * Hosted MCP servers (design: `docs/design/mcp-hosting.md`, Increment 3).
 * Shapes mirror `main/mcpHost/index.ts`'s `McpHostListEntry` and
 * `shared/hostedMcp.ts`'s `HostedRunState`/`HostedInstallSource`, imported as
 * types only so this ambient file stays declaration-only.
 */
type HostedRunStateT = import('../shared/hostedMcp').HostedRunState;
type HostedInstallSourceT = import('../shared/hostedMcp').HostedInstallSource;

interface McpHostListEntryT {
  id: string;
  label: string;
  /** Whether this server may run at all — the persisted `enabled` flag. */
  enabled: boolean;
  /** Whether `startAll()` spawns it at boot. */
  autostart: boolean;
  install: HostedInstallSourceT;
  concurrency: number;
  /** Resolved command + argv. Never `env` — a decrypted secret never crosses IPC. */
  command: string;
  args: string[];
  cwd?: string;
  /** Env var NAMES only — never values. */
  envKeys: string[];
  /**
   * Increment 7's write gate (`docs/design/mcp-hosting.md`, DECISION
   * 2026-08-13). `undefined` means every tool is selected (the default, no
   * migration needed for an existing record); an EMPTY array means none —
   * the two are distinct and `ServerDetail` must never collapse them (e.g.
   * `enabledTools?.length` reads `undefined` the same as `0`, which is
   * exactly the bug the decision block warns about).
   */
  enabledTools?: string[];
  state: HostedRunStateT;
  pid?: number;
  startedAt?: number;
  error?: string;
  toolCount?: number;
  restartCount?: number;
}

type HostedServerDraftT = import('../main/mcpHost/index').HostedServerDraft;
type HostedServerTestRequestT = import('../main/mcpHost/index').HostedServerTestRequest;

interface McpServersAPI {
  list(): Promise<McpHostListEntryT[]>;
  /** Pushed on any status transition for any hosted server — no polling. */
  onChanged(callback: (servers: McpHostListEntryT[]) => void): () => void;
  start(id: string): Promise<McpHostActionResultT>;
  /** `disable: true` stops AND turns the server off ("Off" in the Increment 3
   *  vocabulary); omitted/false is a temporary stop that leaves it eligible
   *  for Start/Restart again. */
  stop(id: string, opts?: { disable?: boolean }): Promise<McpHostActionResultT>;
  restart(id: string): Promise<McpHostActionResultT>;
  remove(id: string): Promise<McpHostActionResultT>;
  /**
   * Increment 7's write gate. `undefined` clears back to "every tool"; `[]`
   * selects none. A dedicated channel, not folded into `save()` — see
   * `main/mcpHost/index.ts`'s `setEnabledTools()` for why.
   */
  setEnabledTools(id: string, enabledTools: string[] | undefined): Promise<McpHostActionResultT>;
  save(draft: HostedServerDraftT): Promise<McpHostActionResultT>;
  test(draft: HostedServerTestRequestT): Promise<McpHostProbeResultT>;
  /** `undefined` means "never read" — a real, distinct state from "read, and empty" (`[]`). */
  inventory(id: string): Promise<McpHostToolDescriptorT[] | undefined>;
  stderrTail(id: string): Promise<string>;

  // --- Increment 5: agent-authored servers (docs/design/mcp-hosting.md) ---

  /**
   * Re-scan `<workspace>/.mcp-servers/` for servers Claude has written.
   * Already runs once per boot; exposed so the Servers page can ask again
   * on demand without a restart. Idempotent — see `authored.ts`.
   */
  rescanAuthored(): Promise<AuthoredScanResultT>;
  /**
   * The manifest description + file-drift count for every agent-authored
   * server, on top of what `list()` already returns. A separate call, not
   * folded into `list()`/`onChanged()`: computing drift hashes a directory,
   * and `list()` backs the high-frequency status broadcast.
   */
  listAuthored(): Promise<AuthoredListResultT>;
  /**
   * Promote `.mcp-servers/<id>/` into Acabox's own app-data area and run
   * that copy — the only way an authored server's `enabled` flag becomes
   * true. Same call for the first-ever approval and a later re-promotion.
   */
  approveAuthored(id: string): Promise<McpHostActionResultT>;
}

/**
 * Settings → APIs. `ApiConfigForUi` is the masked shape — it carries
 * `hasSecret: boolean` where the stored config carries the credential, which
 * never crosses this boundary.
 */
type ApiConfigForUiT = import('../shared/apis').ApiConfigForUi;
type ApiConfigT = import('../shared/apis').ApiConfig;
type ApiCatalogEntryT = import('../shared/apis').ApiCatalogEntry;
type ApiCountersT = import('../shared/apis').ApiCounters;

interface ApiMutationResultT {
  success: boolean;
  error?: string;
  apis: ApiConfigForUiT[];
}

interface ApisAPI {
  list(): Promise<{
    apis: ApiConfigForUiT[];
    catalog: ApiCatalogEntryT[];
    /** Per-API usage since launch. An API never called has no entry. */
    counters: Record<string, ApiCountersT>;
    proxy: { running: boolean; baseUrl: string | null; error: string | null };
  }>;
  /**
   * A blank `auth.secret` means "keep the stored credential"; pass
   * `clearSecret: true` to actually remove one.
   */
  save(api: ApiConfigT, originalId?: string, clearSecret?: boolean): Promise<ApiMutationResultT>;
  remove(id: string): Promise<ApiMutationResultT>;
  setEnabled(id: string, enabled: boolean): Promise<ApiMutationResultT>;
  setAllowWrites(id: string, allowWrites: boolean): Promise<ApiMutationResultT>;
  /**
   * Up to two real GETs through the same engine the agent uses — one with the
   * credential, one without — at a curated auth-gated endpoint where the
   * catalog has one. `verdict` is the interpreted answer and `detail` the
   * sentence to show; the raw `status` is kept for logs, not for deciding.
   */
  test(id: string): Promise<{
    status: number;
    ok: boolean;
    verdict?: 'ok' | 'unauthorized' | 'unconfirmed' | 'unreachable';
    detail?: string;
  }>;
  /**
   * Phase 2: a mini-app's call. `dirName` names the calling tool; the grant is
   * read from that tool's manifest in main, never taken from the renderer.
   */
  request(dirName: string, req: {
    apiId: string; method?: string; path?: string;
    headers?: Record<string, string>; body?: string;
  }): Promise<{
    ok: boolean; status: number; headers?: Record<string, string>;
    body?: string; error?: string | null;
  }>;
}

/**
 * Knowledge → Skills. Shapes come from `shared/skills.ts` and the main-side
 * store; imported as types only so this ambient file stays declaration-only.
 */
type SkillDescriptorT = import('../shared/skills').SkillDescriptor;
type SkillMutationResultT = import('../main/skillStore').SkillMutationResult;
type RestoreBuiltinsSummaryT = import('../main/skillStore').RestoreBuiltinsSummary;
type RestoreBuiltinsResultT = import('../main/skillStore').RestoreBuiltinsResult;
type FindingMetaT = import('../main/knowledge/findingsLedger').FindingMeta;
type KnowledgeReviewItemT = import('../main/knowledge/omissionWatch').KnowledgeReviewItem;
type ParsedImportUrlT = import('../main/knowledge/skillImportService').ParsedImportUrl;
type ImportUrlTargetT = import('../main/knowledge/skillImportService').ImportUrlTarget;
type ImportRequestT = import('../main/knowledge/skillImportService').ImportRequest;
type CatalogueResultT = import('../main/knowledge/skillImportService').CatalogueResult;
type SkillImportPreviewT = import('../main/knowledge/skillImportService').SkillImportPreview;
type ImportProgressT = import('../main/knowledge/skillImportService').ImportProgress;

/** One row of the findings index: the meta plus the two human columns. */
type FindingRowT = FindingMetaT & { title: string; rule: string; file: string };

interface SkillsAPI {
  /**
   * Every skill in the store, id-sorted, including ones the user removed.
   * `modified` is UNDEFINED for custom skills — there is nothing to compare
   * against, so render no chip rather than "unmodified". `findingsCount` is
   * undefined when the skill has no ledger at all, which is a different state
   * from an empty one.
   */
  list(): Promise<SkillDescriptorT[]>;
  read(id: string, relPath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  write(id: string, relPath: string, content: string): Promise<SkillMutationResultT>;
  create(id: string, description?: string): Promise<SkillMutationResultT>;
  remove(id: string): Promise<SkillMutationResultT>;
  /**
   * On/off the roster. Not a sandbox — a disabled skill keeps its bytes and its
   * symlink and stays readable; it stops costing roster characters. `pushed`
   * reports whether a running agent server took the new roster; false means
   * none is up, and the next one reads the store anyway.
   */
  setEnabled(id: string, enabled: boolean): Promise<SkillMutationResultT & { pushed: boolean }>;
  /** Take the shipped version of one file. The local copy goes to the trash. */
  revertFile(id: string, relPath: string): Promise<SkillMutationResultT>;
  revert(id: string): Promise<SkillMutationResultT>;
  /** Keep mine: suppress the UPDATE AVAILABLE chip until the NEXT release moves that file. */
  dismissUpdate(id: string, relPath: string): Promise<SkillMutationResultT>;
  /** Measured counts for the confirm dialog, so the copy is never prose. */
  summarizeRestore(): Promise<RestoreBuiltinsSummaryT>;
  restoreAll(): Promise<RestoreBuiltinsResultT>;
  reveal(id: string): Promise<{ ok: boolean; error?: string }>;

  // --- Import -------------------------------------------------------------
  // These REJECT on failure rather than resolving `{ ok: false }`: a rate
  // limit, a 404 and an unreachable host are accidents with messages already
  // written for a human, while the `{ ok }` shape above is for store rules.
  // Electron prefixes a rejection with "Error invoking remote method", so a
  // caller must strip it before showing the string.

  /**
   * Resolve a pasted GitHub link to a 40-char commit SHA and classify it. One
   * `api.github.com` request (zero when the link already names a full SHA);
   * that endpoint is 60/hour for the whole machine, so never call it on a timer.
   */
  parseImportUrl(input: string): Promise<ParsedImportUrlT>;
  /**
   * Every skill in the repository, from ONE tarball and zero further API
   * calls. 21.7 MB and several seconds for `openai/plugins`; cached for the
   * session against the resolved SHA, so a second pick is free. Progress
   * arrives on `skills:importProgress` as bytes received — there is no total,
   * because codeload sends no `content-length`.
   */
  fetchCatalogue(target: ImportUrlTargetT): Promise<CatalogueResultT>;
  /** Stage one skill and describe it, including the `SKILL.md` the model will follow. */
  previewImport(request: ImportRequestT): Promise<SkillImportPreviewT>;
  /** Folder picker. Null when the user cancelled. */
  pickImportFolder(): Promise<string | null>;
  /**
   * Commit a staged import. Always lands `enabled: false` — enforced in main,
   * because an unbudgeted import silently collapses every other skill's roster
   * line. `asId` renames the store entry only; the skill's own files are never
   * rewritten.
   */
  importSkill(
    request: ImportRequestT,
    asId?: string,
  ): Promise<{ ok: boolean; error?: string; id?: string; skill?: SkillDescriptorT }>;
  /** Free the unpacked catalogue and any staged trees. Call when the modal closes. */
  cancelImport(): Promise<void>;
}

interface KnowledgeAPI {
  ledger(skill: string): Promise<{
    skill: string;
    dir: string;
    /** False when the skill has no ledger at all — distinct from an empty one. */
    exists: boolean;
    bytes: number;
    /** Copy any surface showing `last_read` MUST carry: it is bucket-granular. */
    lastReadNote: string;
    active: FindingRowT[];
    archived: FindingRowT[];
  }>;
  supersede(skill: string, id: string, bySupersedingId?: string): Promise<{ ok: boolean; error?: string }>;
  listReviews(): Promise<KnowledgeReviewItemT[]>;
  dismissReview(id: string): Promise<{ ok: boolean }>;
  /**
   * The real agent-memory directory. `dir` is null when no workspace is
   * active; an empty `files` in an active workspace means nothing has written
   * a memory yet, which is an ordinary state and not an error.
   */
  memories(): Promise<{ dir: string | null; files: MemoryFileInfo[] }>;
}

interface ElectronAPI {
  on(channel: string, callback: (...args: any[]) => void): void;
  removeListener(channel: string, callback: (...args: any[]) => void): void;
  invoke(channel: string, ...args: any[]): Promise<any>;
}

/**
 * Shape comes from `shared/share.ts`; imported as a type only so this
 * ambient file stays declaration-only (same pattern as `ConnectorConfigT` /
 * `ApiConfigForUiT` above). Used by `MiniAppEntry.published` below.
 */
type PublishedInfoT = import('../shared/share').PublishedInfo;
/** Per-group file counts/bytes for a snapshot about to be (or already) shared. */
type SnapshotSummaryT = import('../shared/share').SnapshotSummary;
/** The token itself never reaches the renderer — only `hasToken`. */
type ShareSettingsForUiT = import('../main/share/shareStore').ShareSettingsForUi;

declare global {
  /**
   * Hosted MCP servers (design: `docs/design/mcp-hosting.md`, Increment 3).
   * Global — following the `MemoryFileInfo` precedent right below — because
   * `ServersPage`/`ServerDetail`/`ServerConfigForm` (`renderer/components/
   * servers/`) name these types directly rather than only ever consuming
   * `window.mcpServersAPI` through inference.
   */
  interface McpHostToolDescriptorT {
    name: string;
    description?: string;
    inputSchema?: unknown;
  }

  type McpHostProbeResultT = import('../main/mcpHost/supervisor').ProbeResult;

  interface McpHostActionResultT {
    ok: boolean;
    error?: string;
  }

  /**
   * Increment 5 (docs/design/mcp-hosting.md) — agent-authored servers. Global
   * for the same reason as the three types above: `ServersPage.tsx` names
   * `AuthoredListResultT` directly (its own `authoredInfo` state), not only
   * through inference over `window.mcpServersAPI`.
   */
  type AuthoredScanRejectionT = import('../main/mcpHost/authored').AuthoredScanRejection;
  type AuthoredScanResultT = import('../main/mcpHost/authored').AuthoredScanResult;
  type AuthoredServerInfoT = import('../main/mcpHost/authored').AuthoredServerInfo;
  type AuthoredListResultT = import('../main/mcpHost/authored').AuthoredListResult;

  /**
   * One file in `.academia/agent-memory/`. Everything here is measured off the
   * file itself or joined against `sessions.sdk_session_id`; there is
   * deliberately no actor field, because a file changed in Finder is
   * indistinguishable from one Claude wrote.
   *
   * Global (rather than module-scope like the API interfaces above) because the
   * Knowledge components name the type directly, following `MiniAppEntry`.
   */
  interface MemoryFileInfo {
    file: string;
    /** `.academia`-relative, i.e. what `academiaFileAPI.read/write` takes. */
    academiaPath: string;
    bytes: number;
    /** mtime, ms since epoch. */
    changedAt: number;
    /** Frontmatter `name`. Absent on `about_you.md` / `working_on.md`. */
    declaredName?: string;
    description?: string;
    /** Frontmatter `type` — `project` / `reference` / `feedback` in practice. */
    type?: string;
    originSessionId?: string;
    /** The chat that authored it, when its SDK id still resolves to a live chat. */
    originChat: { id: string; title: string } | null;
    /** Whether `MEMORY.md` links to it — i.e. whether it is reachable at all. */
    indexed: boolean;
    /** True for `MEMORY.md` itself, which is the index rather than a memory. */
    isIndex: boolean;
    frontmatterOk: boolean;
    frontmatterError?: string;
  }

  /** Findings-index row, nameable by the components that render the table. */
  type FindingRow = FindingRowT;
  /** A Needs-attention row from the omission watch. */
  type KnowledgeReviewItem = KnowledgeReviewItemT;

  /** Import flow shapes, nameable by the Add-a-skill modal. */
  type ParsedImportUrl = ParsedImportUrlT;
  type ImportRequest = ImportRequestT;
  type CatalogueResult = CatalogueResultT;
  type CatalogueSkill = CatalogueResultT['skills'][number];
  type SkillImportPreview = SkillImportPreviewT;
  type ImportProgress = ImportProgressT;

  type PackageRegistry = 'pip' | 'npm' | 'R' | 'apt' | 'manual';
  type PackageState = 'queued' | 'installing' | 'installed' | 'failed';

  interface EnvironmentInfoPayload {
    packageStates: Record<PackageRegistry, Record<string, PackageState>>;
    packageLines: Record<PackageRegistry, Record<string, string>>;
    totalPip: string[];
    totalNpm: string[];
    totalR: string[];
    totalApt: string[];
    totalSetup: string[];
    apps: Array<{
      name: string;
      pip: string[];
      npm: Record<string, string>;
      r: string[];
      apt: string[];
      setup: string[];
    }>;
  }

  interface DirEntry {
    name: string;
    path: string;
    isDirectory: boolean;
  }

  type FileContent =
    | { type: 'text'; content: string }
    | { type: 'image'; fileUrl: string }
    | { type: 'pdf'; fileUrl: string }
    | { type: 'markdown'; content: string }
    | { type: 'csv'; content: string; delimiter: string }
    | { type: 'latex'; content: string }
    | { type: 'spreadsheet'; base64: string; ext: string }
    | { error: 'too-large'; size: number };

  interface CopyProgress {
    copied: number;
    total: number;
    currentName: string | null;
  }

  interface FilesAPI {
    readDirectory(dirPath: string): Promise<DirEntry[]>;
    readFile(filePath: string): Promise<FileContent>;
    fileExists(filePath: string): Promise<boolean>;
    findByName(filename: string, hintDirs: string[]): Promise<string | null>;
    findByExtension(extensions: string[]): Promise<{ relPath: string; path: string; mtimeMs: number; size: number }[]>;
    writeFile(filePath: string, content: string): Promise<void>;
    downloadFile(filename: string, content: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
    showInFinder(filePath: string): Promise<void>;
    revealInFinder(filePath: string): Promise<void>;
    selectFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
    selectDirectory(): Promise<string | null>;
    copyToWorkspace(sourcePaths: string[], destinationDir: string): Promise<{ copied: number }>;
    moveFile(sourcePath: string, destinationDir: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    trashFile(filePath: string): Promise<void>;
    createFile(filePath: string): Promise<void>;
    createDirectory(dirPath: string): Promise<void>;
    renameFile(filePath: string, newName: string): Promise<void>;
    convertImageToPng(base64Data: string): Promise<string>;
    getPathForFile(file: File): string;
    onCopyProgress(callback: (progress: CopyProgress) => void): () => void;
    onWorkspaceChanged(callback: () => void): () => void;
  }

  interface WorkspacesAPI {
    getActive(): Promise<Workspace | null>;
    selectDirectory(): Promise<string | undefined>;
    listDirectories(): Promise<WorkspaceDirectory[]>;
    addDirectory(directoryPath: string): Promise<WorkspaceDirectory>;
    removeDirectory(directoryId: string): Promise<void>;
    updateDirectoryPermission(directoryId: string, readOnly: boolean): Promise<WorkspaceDirectory>;
  }

  interface SessionData {
    id: string;
    title: string;
    source: string | null;
    document_path: string | null;
    /** Mini-app this chat belongs to, or null for a general chat. */
    app_dir_name: string | null;
    /** Model the conversation is pinned to; null until its first turn records one. */
    model: string | null;
    /** Reasoning-effort level pinned to the conversation; null on pre-existing chats. */
    effort: string | null;
    created_at: string;
    updated_at: string;
  }

  /** A chat plus the timestamp of its newest message (null when it has none). */
  interface AppSessionData extends SessionData {
    last_message_at: string | null;
  }

  interface MessageData {
    id: number;
    session_id: string;
    type: string;
    content: string;
    created_at: string;
  }

  /** Mirrors main/db/chatSearch.ts; contract in docs/design/chat-search.md. */
  interface ChatPreviewData { sessionId: string; userText: string; assistantText: string; }
  interface ProseHitData { messageId: number; role: 'user' | 'assistant'; createdAt: string; snippet: string; }
  interface ChatProseResultData { sessionId: string; total: number; hits: ProseHitData[]; }

  interface SessionsAPI {
    list(source?: string): Promise<SessionData[]>;
    get(id: string): Promise<SessionData | undefined>;
    cost(id: string): Promise<number | null>;
    setDocumentPath(id: string, documentPath: string): Promise<void>;
    countForDocument(documentPath: string): Promise<number>;
    rename(id: string, title: string): Promise<void>;
    delete(id: string): Promise<void>;
    listMessages(sessionId: string): Promise<MessageData[]>;
    previews(): Promise<ChatPreviewData[]>;
    searchProse(query: string): Promise<ChatProseResultData[]>;
    findForApp(dirName: string): Promise<string | null>;
    listForApp(dirName: string): Promise<AppSessionData[]>;
    createForApp(dirName: string): Promise<string | null>;
    onTitleUpdated(callback: (sessionId: string, title: string) => void): () => void;
    onSessionsChanged(callback: () => void): () => void;
    getActivity(): Promise<{ activeIds: string[]; unreadIds: string[] }>;
    onActivityChanged(callback: (snapshot: { activeIds: string[]; unreadIds: string[] }) => void): () => void;
    setViewing(sessionId: string | null): void;
    onForeignTurnDone(callback: (sessionId: string) => void): () => void;
  }

  interface SystemStats {
    cpuPercent: number;
    memUsedBytes: number;
    memTotalBytes: number;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    appUptimeSec: number;
  }

  interface SystemStatsAPI {
    get(): Promise<SystemStats>;
  }

  interface ContainerAPI {
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<{ running: boolean; agentAlive: boolean; gaveUp: boolean }>;
    exec(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    execLogged(command: string[], meta?: { source?: string; appDirName?: string | null }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    quitApp(): Promise<void>;
    relaunchApp(): Promise<void>;
    ensureSetup(): Promise<void>;
    getEnvironmentInfo(): Promise<EnvironmentInfoPayload | null>;
    appDepsReady(dirName: string): Promise<boolean>;
    ensureAppDeps(dirName: string): Promise<{ installed: string[] }>;
    getAppInstallRequests(dirName: string): Promise<Array<{ registry: PackageRegistry; packages: string[] }>>;
    onSetupProgress(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
    onProgress(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
    onPackageState(callback: (e: { registry: PackageRegistry; package: string; state: PackageState }) => void): () => void;
    onPackageLine(callback: (e: { registry: PackageRegistry; package: string; line: string }) => void): () => void;
  }

  interface CommandLogEntry {
    id: number;
    timestamp: string;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number;
    appDirName: string | null;
    source: 'agent' | 'iframe';
  }

  interface CommandLogAPI {
    getAll(): Promise<CommandLogEntry[]>;
    getByApp(appDirName: string): Promise<CommandLogEntry[]>;
    getAppNames(): Promise<string[]>;
    onEntry(callback: (entry: CommandLogEntry) => void): () => void;
  }

  interface SystemLogEntry {
    id: number;
    timestamp: string;
    level: string;
    text: string;
  }

  interface SystemLogAPI {
    getAll(): Promise<SystemLogEntry[]>;
    onEntry(callback: (entry: SystemLogEntry) => void): () => void;
  }

  interface JupyterKernelInfo {
    id: string;
    name: string;
    execution_state: string;
    last_activity: string;
    connections: number;
  }

  interface JupyterAPI {
    startGateway(): Promise<{ url: string } | { error: string }>;
    stopGateway(): Promise<void>;
    restartGateway(): Promise<{ url: string } | { error: string }>;
    gatewayStatus(): Promise<{ running: boolean; url: string | null }>;
    listKernels(): Promise<JupyterKernelInfo[]>;
    shutdownKernel(kernelId: string): Promise<boolean>;
  }

  interface AcademiaFileAPI {
    read(relativePath: string): Promise<{ content: string }>;
    write(relativePath: string, content: string): Promise<void>;
  }

  interface ScheduledTasksAPI {
    list(): Promise<ScheduledTask[]>;
    get(id: string): Promise<ScheduledTask | null>;
    create(data: CreateTaskData): Promise<ScheduledTask>;
    update(id: string, data: UpdateTaskData): Promise<ScheduledTask | null>;
    delete(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    runNow(id: string): Promise<void>;
    listRuns(taskId: string): Promise<ScheduledTaskRun[]>;
    /** Fires on every write, including runs the scheduler's own clock starts. Returns its unsubscribe. */
    onChanged(cb: () => void): () => void;
  }

  interface TodayFileSession {
    id: number;
    document_url: string;
    app_name: string;
    app_bundle_id: string;
    window_title: string | null;
    session_date: string;
    first_seen: string;
    last_seen: string;
    poll_count: number;
    total_dwell: number;
    app_version: string;
    snapshot_ulid: string | null;
    last_modified: string | null;
    diff_ulid: string | null;
  }

  interface FileMonitorAPI {
    status(): Promise<{ running: boolean; agentAlive: boolean; gaveUp: boolean }>;
    start(): Promise<void>;
    stop(): Promise<void>;
    getTodaySessions(): Promise<TodayFileSession[]>;
    openFile(fileUrl: string, bundleId?: string): Promise<string>;
    setDockRightForDocument(documentPath: string, docked: boolean): Promise<void>;
    setOverlayKickoffForDocument(documentPath: string, prompt: string): Promise<void>;
    requestNewOverlayChatForDocument(documentPath: string): Promise<void>;
    navigateOverlayToSession(sessionId: string): Promise<void>;
  }

  interface BrowserMonitorAPI {
    status(): Promise<{ serverRunning: boolean; extensionConnected: boolean }>;
    start(): Promise<void>;
    stop(): Promise<void>;
    downloadExtension(): Promise<{ success: boolean; error?: string; path?: string }>;
  }

  interface DataPathInfo {
    label: string;
    path: string;
  }

  interface DebugAPI {
    getStorageInfo(): Promise<{
      environment: string;
      userData: string;
      podmanPaths: DataPathInfo[];
    }>;
    clearSelected(ids: string[]): Promise<{ cleared: string[]; errors: string[] }>;
    exportLogs(): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
    exportWorkspace(): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean; error?: string }>;
    importWorkspace(): Promise<{ ok: boolean; workspaceName?: string; workspaceDir?: string; workspaceId?: string; canceled?: boolean; error?: string }>;
    hardResetWorkspace(): Promise<{ ok: boolean; error?: string }>;
    pruneImages(): Promise<void>;
    syncOverlay(): Promise<{ durationMs: number }>;
    isOverlayEnabled(): Promise<boolean>;
    /** Pipes a renderer-side log line into electron-log on the main process. */
    log(msg: string): Promise<void>;
    /**
     * Triggers a test error on the main process to verify Sentry wiring.
     * kind: 'uncaught' | 'rejection' | 'capture'
     * subsystem: optional tag applied when kind === 'capture'
     */
    telemetryTest(kind: string, subsystem?: string): Promise<{ ok: boolean; error?: string }>;
  }

  interface SettingsAPI {
    getMaxAttachmentSizeMB(): Promise<number>;
    setMaxAttachmentSizeMB(sizeMB: number): Promise<void>;
  }

  interface MiniAppEntry {
    dirName: string;
    name: string;
    description: string | null;
    icon: string | null;
    lastOpened: string | null;
    /** When the tool last finished executing something. Null if it never has. */
    lastRun: string | null;
    preBuilt: boolean;
    archived: boolean;
    /** Pinned to the rail's "Pinned tools" section by the user. */
    pinned: boolean;
    /** When it was pinned (ISO 8601), which orders the section; null when not pinned. */
    pinnedAt: string | null;
    /** Configured API ids this tool may call through the proxy. */
    apis: string[];
    hasManifest: boolean;
    /** Set when this app has been shared (docs/design/sharing.md); null if never published or unpublished since. */
    published: PublishedInfoT | null;
  }

  /** Work a tool is doing, owned by the host so it outlives the tool's viewer. */
  interface ToolJob {
    id: string;
    dirName: string;
    kind: 'command' | 'kernel' | 'claude' | 'agent-tool';
    label: string;
    startedAt: number;
    endedAt?: number;
    status: 'running' | 'done' | 'failed' | 'interrupted' | 'finishedWhileAway' | 'cancelled';
    pid?: number;
    /** True when this job was carried across an app restart and is still alive. */
    adopted?: boolean;
  }

  /** A tool that does not currently build. Absence means it is fine. */
  interface BuildHealth {
    dirName: string;
    ok: boolean;
    error?: string;
    at: number;
  }

  interface BuildHealthAPI {
    list(): Promise<BuildHealth[]>;
    onChanged(callback: (all: BuildHealth[]) => void): () => void;
  }

  interface DictationCapabilities {
    /** False whenever the mic button must not be shown at all. */
    available: boolean;
    /** 'transcriber' (macOS 26+) or 'sfspeech'. */
    engine?: string;
    locale?: string;
    /** False means the first dictation downloads a model — say so in the UI. */
    modelInstalled?: boolean;
    micAuth?: string;
    speechAuth?: string;
    reason?: string;
  }

  type DictationEvent =
    | { type: 'hello'; pid: number }
    | { type: 'ready'; engine: string; locale: string }
    | { type: 'listening' }
    | { type: 'installing'; locale: string }
    | { type: 'installed'; locale: string }
    | { type: 'partial'; text: string }
    | { type: 'final'; text: string }
    | { type: 'level'; rms: number }
    | { type: 'stopped' }
    | { type: 'error'; code: string; message: string };

  interface DictationAPI {
    /** Prompt-free — never raises a TCC dialog, so it is safe on mount. */
    probe(locale?: string): Promise<DictationCapabilities>;
    start(locale?: string): Promise<{ ok: boolean; error?: string }>;
    stop(): Promise<{ ok: boolean }>;
    onEvent(callback: (event: DictationEvent) => void): () => void;
  }

  interface JobsAPI {
    list(): Promise<ToolJob[]>;
    /** Report work the host can't see for itself (kernel runs, Claude calls). */
    begin(input: { dirName: string; kind: 'kernel' | 'claude'; label: string }): Promise<string | null>;
    end(id: string, status?: 'done' | 'failed'): Promise<{ ok: boolean }>;
    /** Clear a tool's interrupted / finished-while-away notice. */
    acknowledge(dirName: string): Promise<{ ok: boolean }>;
    /** Stop a running job. Kills the process tree, or asks its owner to interrupt. */
    cancel(id: string): Promise<{ ok: boolean; reason?: string }>;
    /** Main asks this window to interrupt work it reported (kernel / Claude). */
    onCancelRequested(
      callback: (req: { id: string; dirName: string; kind: string }) => void,
    ): () => void;
    onChanged(callback: (jobs: ToolJob[]) => void): () => void;
  }

  /**
   * Sharing (design: `docs/design/sharing.md`; contracts:
   * `docs/design/sharing-tickets.md`, C1 + ticket M9). Publishes a mini-app
   * or a single workspace file as a read-only snapshot on the operator's own
   * Cloudflare Workers deployment.
   */
  interface ShareAPI {
    getSettings(): Promise<ShareSettingsForUiT>;
    saveSettings(patch: {
      siteUrl: string;
      apiUrl: string;
      publishToken?: string;
      clearToken?: boolean;
    }): Promise<{ ok: boolean; error?: string }>;
    /** One real GET at `/v1/health`, through the same client a publish uses. */
    test(): Promise<{ ok: boolean; status: number; error: string | null }>;
    planApp(dirName: string, includeInput: boolean): Promise<
      | { ok: true; summary: SnapshotSummaryT; hash: string; published: PublishedInfoT | null; behind: boolean }
      | { ok: false; error: string }
    >;
    publishApp(dirName: string, opts: { includeInput: boolean }): Promise<
      { ok: true; published: PublishedInfoT; unchanged: boolean } | { ok: false; error: string }
    >;
    unpublishApp(dirName: string): Promise<{ ok: boolean; error?: string }>;
    statusApp(dirName: string): Promise<{ published: PublishedInfoT | null; behind: boolean }>;
    /** `filePath` is absolute. */
    publishFile(filePath: string): Promise<
      { ok: true; published: PublishedInfoT; unchanged: boolean } | { ok: false; error: string }
    >;
    unpublishFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
    statusFile(filePath: string): Promise<{ published: PublishedInfoT | null; behind: boolean }>;
    onChanged(callback: (evt: { dirName?: string; filePath?: string }) => void): () => void;
    onProgress(callback: (p: { dirName: string; uploaded: number; total: number }) => void): () => void;
  }

  interface MiniAppsAPI {
    exportApp(dirName: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean; error?: string }>;
    importApp(): Promise<{ ok: boolean; dirName?: string; canceled?: boolean; error?: string }>;
    list(): Promise<MiniAppEntry[]>;
    touch(dirName: string): Promise<{ ok: boolean; error?: string }>;
    setArchived(dirName: string, archived: boolean): Promise<{ ok: boolean; error?: string }>;
    /** Pin a tool to the rail, or unpin it. */
    setPinned(dirName: string, pinned: boolean): Promise<{ ok: boolean; error?: string }>;
    /** Grant/revoke the configured APIs this tool may call. */
    setApis(dirName: string, apis: string[]): Promise<{ ok: boolean; error?: string; apis?: string[] }>;
    /** Delete a tool's code, preserving its input/output under tool-data. */
    delete(dirName: string): Promise<{ ok: boolean; error?: string }>;
    build(dirName: string): Promise<{ ok: boolean; outfile?: string; error?: string; exitCode: number; reason?: 'source-missing' }>;
    /** Fires when a build of this tool succeeded, whoever triggered it (Rebuild button or the agent's build tool). */
    onBuilt(callback: (evt: { dirName: string }) => void): () => void;
    /** Edit mode for a tool's text (POC) — contracts in shared/miniAppTextEdit.ts. */
    textEdit: {
      probe(dirName: string, target: TextEditTarget): Promise<TextEditProbeResult>;
      apply(dirName: string, req: TextEditApplyRequest): Promise<TextEditApplyResult>;
      undo(dirName: string): Promise<TextEditUndoResult>;
      undoDepth(dirName: string): Promise<number>;
    };
  }

  interface ToolDataEntry {
    dirName: string;
    name: string;
    /** True when no tool with this dirName exists anymore (data outlived its tool). */
    orphaned: boolean;
    deletedAt: string | null;
    fileCount: number;
    sizeBytes: number;
    lastModified: number | null;
  }

  interface ToolDataAPI {
    list(): Promise<ToolDataEntry[]>;
    delete(dirName: string): Promise<{ ok: boolean; error?: string }>;
  }

  interface MiniAppToolDef {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }

  interface MiniAppMcpServer {
    serverName: string;
    dirName: string;
    tools: MiniAppToolDef[];
  }

  interface MiniAppMcpAPI {
    register(payload: {
      serverName: string;
      dirName: string;
      tools: MiniAppToolDef[];
      iframeRouteKey: string;
    }): Promise<void>;
    unregister(serverName: string): Promise<void>;
    unregisterByRoute(iframeRouteKey: string): Promise<void>;
    list(): Promise<MiniAppMcpServer[]>;
    callTool(serverName: string, toolName: string, args: unknown): Promise<{ result?: unknown; error?: string }>;
    onInvoke(
      callback: (payload: { invocationId: string; iframeRouteKey: string; toolName: string; args: unknown }) => void,
    ): () => void;
    sendResult(payload: { invocationId: string; result?: unknown; error?: string }): void;
    /** Pushed on every register/unregister/unregisterByRoute — no polling. */
    onChanged(callback: (servers: MiniAppMcpServer[]) => void): () => void;
  }

  interface WritingAgentProject {
    id: number;
    workspace_id: string;
    name: string;
    description: string;
    file_count: number;
    primary_manuscript_id: number | null;
    server_created_at: string;
    server_updated_at: string;
    synced_at: string;
  }

  interface WritingAgentFile {
    id: number;
    project_id: number;
    file_name: string;
    file_type: string;
    rel_path: string | null;
    is_primary_manuscript: number;
    size: number;
    tag: string | null;
    server_created_at: string;
    server_updated_at: string;
  }

  interface WritingAgentSupportingFile {
    id: number;
    workspace_id: string;
    file_name: string;
    file_type: string;
    rel_path: string | null;
    size: number;
    tag: string | null;
    summary: string | null;
    server_created_at: string;
    server_updated_at: string;
  }

  interface WritingAgentConversation {
    id: number;
    project_id: number;
    agent_name: string;
    title: string | null;
    summary: string | null;
    server_created_at: string;
    server_updated_at: string;
  }

  interface WritingAgentAPI {
    isLinked(): Promise<boolean>;
    link(): Promise<{ success: boolean; error?: string }>;
    unlink(): Promise<{ success: boolean }>;
    refresh(): Promise<{ success: boolean; projectCount?: number; error?: string }>;
    listProjects(): Promise<WritingAgentProject[]>;
    getProjectFiles(projectId: number): Promise<WritingAgentFile[]>;
    listConversations(projectId: number): Promise<WritingAgentConversation[]>;
    getConversationDetail(conversationId: number, projectId: number): Promise<any>;
    continueConversation(conversationId: number, projectId: number): Promise<string>;
    listSupportingFiles(): Promise<WritingAgentSupportingFile[]>;
  }

  type CalendarMutationEvent =
    | { type: 'group-created';      group: CalendarGroup }
    | { type: 'group-updated';      group: CalendarGroup }
    | { type: 'group-deleted';      groupId: string }
    | { type: 'event-created';      event: CalendarEvent }
    | { type: 'event-updated';      event: CalendarEvent }
    | { type: 'event-deleted';      eventId: string }
    | { type: 'event-moved';        moved: CalendarEvent; cascaded: CascadeUpdate[] }
    | { type: 'dependency-created'; dependency: EventDependency }
    | { type: 'dependency-updated'; dependency: EventDependency }
    | { type: 'dependency-deleted'; dependencyId: string };

  interface CalendarAPI {
    listGroups(): Promise<CalendarGroup[]>;
    createGroup(data: CreateGroupData): Promise<CalendarGroup>;
    updateGroup(id: string, data: UpdateGroupData): Promise<CalendarGroup | null>;
    deleteGroup(id: string): Promise<void>;
    getGroupTimeRange(id: string): Promise<{ start_at: string; end_at: string } | null>;

    listEvents(opts?: { from?: string; to?: string; groupId?: string }): Promise<CalendarEvent[]>;
    createEvent(data: CreateEventData): Promise<CalendarEvent>;
    updateEvent(id: string, data: UpdateEventData): Promise<CalendarEvent | null>;
    deleteEvent(id: string): Promise<void>;

    addEventFile(eventId: string, filePath: string): Promise<EventFile>;
    listEventFiles(eventId: string): Promise<EventFile[]>;
    removeEventFile(id: number): Promise<void>;
    addGroupFile(groupId: string, filePath: string): Promise<GroupFile>;
    listGroupFiles(groupId: string, includeFromEvents?: boolean): Promise<GroupFile[]>;
    removeGroupFile(id: number): Promise<void>;

    listResources(opts?: ListResourcesOptions): Promise<CalendarResource[]>;
    createResource(data: CreateResourceData): Promise<CalendarResource>;
    updateResource(id: string, data: UpdateResourceData): Promise<CalendarResource | null>;
    deleteResource(id: string): Promise<void>;
    openResourceFile(filePath: string): Promise<string>;
    openResourceUrl(url: string): Promise<void>;
    revealResourceFile(filePath: string): Promise<void>;
    pickResourceFile(): Promise<string[] | null>;
    moveResource(id: string, data: MoveResourceData): Promise<CalendarResource | null>;
    listWorkspaceFiles(): Promise<WorkspaceFileEntry[]>;

    listDependencies(): Promise<EventDependency[]>;
    createDependency(data: CreateDependencyData): Promise<EventDependency | { error: 'cycle' }>;
    updateDependency(id: string, data: UpdateDependencyData): Promise<EventDependency | null>;
    deleteDependency(id: string): Promise<void>;
    moveEventWithCascade(id: string, newStartAt: string, newEndAt: string): Promise<{ moved: CalendarEvent; cascaded: CascadeUpdate[] } | null>;
    adjustBuffer(depId: string, newLagCurrentMs: number): Promise<{ dependency: EventDependency; cascaded: CascadeUpdate[] }>;
    onCalendarMutation(callback: (mutation: CalendarMutationEvent) => void): () => void;

  }

  interface OfficeAddinAPI {
    status(): Promise<{ word: boolean; powerpoint: boolean; excel: boolean; certTrusted: boolean; certExists: boolean; serverRunning: boolean }>;
    startServer(): Promise<{ success: boolean; error?: string }>;
    stopServer(): Promise<{ success: boolean; error?: string }>;
    sideload(): Promise<{ success: boolean; error?: string }>;
    remove(): Promise<{ success: boolean; error?: string }>;
    trustCert(): Promise<{ success: boolean; error?: string }>;
    removeCert(): Promise<{ success: boolean; error?: string }>;
    deleteCert(): Promise<{ success: boolean; error?: string }>;
  }

  interface WorkspaceReport {
    id: string;
    workspace_id: string;
    report_type: string;
    report_data: string;
    in_depth_report: string | null;
    what_youre_working_on: string | null;
    suggested_mini_apps: string | null;
    status: 'pending' | 'running' | 'completed' | 'failed';
    error: string | null;
    created_at: string;
    completed_at: string | null;
  }

  interface ReportsAPI {
    getLatest(reportType: string): Promise<WorkspaceReport | null>;
    get(reportId: string): Promise<WorkspaceReport | null>;
    update(reportId: string, reportData: string): Promise<void>;
  }

  type ScannerEvent =
    | { type: 'progress'; text: string }
    | { type: 'file_activity'; path: string; tool: string }
    | { type: 'complete'; reportId: string; reportData: string }
    | { type: 'error'; error: string };

  interface ScannerAPI {
    start(): Promise<void>;
    onEvent(callback: (event: ScannerEvent) => void): () => void;
  }

  type PaperSource = 'arxiv' | 'pubmed' | 'openalex' | 'biorxiv';

  interface FetchedPaper {
    id: string;
    source: PaperSource;
    externalId: string;
    doi: string | null;
    title: string;
    abstract: string;
    authors: string[];
    authorsLine: string;
    venue: string;
    publishedAt: string;
    url: string;
    pdfUrl: string | null;
    matchedTopic: string;
    sources: PaperSource[];
  }

  interface PapersFetchResult {
    papers: FetchedPaper[];
    fetchedAt: string;
    errors: { source: PaperSource; topic: string; message: string }[];
  }

  interface PapersAPI {
    fetch(input: {
      topics: string[];
      maxPerTopic?: number;
      maxTotal?: number;
      sources?: PaperSource[];
    }): Promise<PapersFetchResult>;
  }

  type BriefingType = 'writing_agent';

  type BriefingStatus = 'new' | 'opened' | 'dismissed';

  interface Briefing {
    id: string;
    workspace_id: string;
    type: BriefingType;
    /** JSON string; shape depends on `type` (see BriefingData* interfaces). */
    briefing_data: string;
    why_im_suggesting_this: string | null;
    status: BriefingStatus;
    source_report_id: string | null;
    created_at: string;
    updated_at: string;
  }

  interface BriefingDataWritingAgent {
    /** Relative path (within workspace) to the DOCX manuscript. */
    file_path: string;
    /** LLM-generated card title contextual to the manuscript. */
    title?: string;
    /** What the user might pick up next on this manuscript. */
    description: string;
    /**
     * Pre-filled user message produced by analyzing the manuscript during
     * onboarding. Auto-sent to the chat when the user opens the briefing.
     */
    chat_prompt: string;
  }

  interface ListBriefingsFilter {
    status?: BriefingStatus[];
    type?: BriefingType[];
    limit?: number;
  }

  interface BriefingsAPI {
    list(filter?: ListBriefingsFilter): Promise<Briefing[]>;
    setStatus(id: string, status: BriefingStatus): Promise<void>;
    /** Subscribe to create/update/status changes. Returns unsubscribe. */
    onChanged(callback: () => void): () => void;
  }

  interface ScannedFile {
    id: string;
    workspace_id: string;
    report_id: string | null;
    file_path: string;
    file_name: string;
    file_type: 'manuscript' | 'grant' | 'presentation' | 'reference';
    created_at: string;
    markdown_path?: string;
  }

  interface ScannedFilesAPI {
    getByType(fileType: 'manuscript' | 'grant' | 'presentation' | 'reference'): Promise<ScannedFile[]>;
    getAll(): Promise<ScannedFile[]>;
    updateTag(filePath: string, fileName: string, fileType: 'manuscript' | 'grant' | 'presentation' | 'reference'): Promise<void>;
    removeTag(filePath: string): Promise<void>;
  }

  interface Window {
    chatAPI: ChatAPI;
    calendarAPI: CalendarAPI;
    filesAPI: FilesAPI;
    workspacesAPI: WorkspacesAPI;
    sessionsAPI: SessionsAPI;
    containerAPI: ContainerAPI;
    systemStatsAPI: SystemStatsAPI;
    settingsAPI: SettingsAPI;
    commandLogAPI: CommandLogAPI;
    systemLogAPI: SystemLogAPI;
    jupyterAPI: JupyterAPI;
    authAPI: AuthAPI;
    connectorsAPI: ConnectorsAPI;
    claudeDesignAPI: ClaudeDesignAPI;
    modelsAPI: {
      list(): Promise<{
        models: { id: string; label: string; description: string; discovered?: boolean }[];
        defaultModel: string;
        discoveredCount: number;
        error: string | null;
      }>;
    };
    apisAPI: ApisAPI;
    skillsAPI: SkillsAPI;
    knowledgeAPI: KnowledgeAPI;
    electronAPI: ElectronAPI;
    academiaFileAPI: AcademiaFileAPI;
    scheduledTasksAPI: ScheduledTasksAPI;
    fileMonitorAPI: FileMonitorAPI;
    debugAPI: DebugAPI;
    miniAppsAPI: MiniAppsAPI;
    toolDataAPI: ToolDataAPI;
    jobsAPI: JobsAPI;
    shareAPI: ShareAPI;
    dictationAPI: DictationAPI;
    screenshotAPI?: { capture(press?: { x: number; y: number }): Promise<import('../shared/screenshot').ScreenshotResult> };
    buildHealthAPI: BuildHealthAPI;
    miniAppMcpAPI: MiniAppMcpAPI;
    mcpServersAPI: McpServersAPI;
    reportsAPI: ReportsAPI;
    scannerAPI: ScannerAPI;
    papersAPI: PapersAPI;
    briefingsAPI: BriefingsAPI;
    scannedFilesAPI: ScannedFilesAPI;
    nativeToolsAPI: { getUrl(toolId: string): Promise<string | null> };
    academiaAPI: {
      fetch(method: string, endpoint: string, data?: unknown): Promise<unknown>;
    };
    toolAnalyticsAPI: {
      opened(dirName: string): Promise<{
        tool_id: string;
        open_count_so_far: number;
        days_since_created: number;
      } | null>;
      setThreadCreationPrompt(threadId: string, prompt: string): Promise<void>;
    };
  }
}

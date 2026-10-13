import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { FIND_IPC } from '../shared/findInPage';
import { TEXT_EDIT_IPC } from '../shared/miniAppTextEdit';
import type { TextEditTarget, TextEditApplyRequest } from '../shared/miniAppTextEdit';

contextBridge.exposeInMainWorld('electronAPI', {
  on: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, callback);
  },
  removeListener: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  },
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
});

contextBridge.exposeInMainWorld('authAPI', {
  getApiKeyStatus: () => ipcRenderer.invoke('auth:getApiKeyStatus'),
  setApiKey: (key: string, baseURL?: string) => ipcRenderer.invoke('auth:setApiKey', key, baseURL),
  isDev: process.env.NODE_ENV === 'development',
  setEndpoint: (endpoint: string) => ipcRenderer.invoke('auth:setEndpoint', endpoint),
});

contextBridge.exposeInMainWorld('connectorsAPI', {
  list: () => ipcRenderer.invoke('connectors:list'),
  save: (connector: unknown, originalId?: string) => ipcRenderer.invoke('connectors:save', connector, originalId),
  remove: (id: string) => ipcRenderer.invoke('connectors:remove', id),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('connectors:setEnabled', id, enabled),
  getStatus: () => ipcRenderer.invoke('connectors:getStatus'),
  removeUnmanaged: () => ipcRenderer.invoke('connectors:removeUnmanaged'),
  // Pushed whenever observed connector status changes (every SDK `init`, and
  // on last-session teardown) — no polling required. Shape mirrors getStatus().
  onStatusChanged: (callback: (status: { live: boolean; reports: unknown[]; observedAt: number | null }) => void) => {
    const handler = (_e: unknown, status: { live: boolean; reports: unknown[]; observedAt: number | null }) => callback(status);
    ipcRenderer.on('connectors:statusChanged', handler);
    return () => ipcRenderer.removeListener('connectors:statusChanged', handler);
  },
});

// Settings → Claude Design. See main/claudeDesignLogin.ts.
contextBridge.exposeInMainWorld('claudeDesignAPI', {
  getStatus: () => ipcRenderer.invoke('claudeDesign:getStatus'),
  signIn: () => ipcRenderer.invoke('claudeDesign:signIn'),
  submitCode: (code: string) => ipcRenderer.invoke('claudeDesign:submitCode', code),
  reopenPage: () => ipcRenderer.invoke('claudeDesign:reopenPage'),
  cancel: () => ipcRenderer.invoke('claudeDesign:cancel'),
  onEvent: (callback: (event: unknown) => void) => {
    const handler = (_e: unknown, event: unknown) => callback(event);
    ipcRenderer.on('claudeDesign:event', handler);
    return () => ipcRenderer.removeListener('claudeDesign:event', handler);
  },
});

contextBridge.exposeInMainWorld('mcpServersAPI', {
  list: () => ipcRenderer.invoke('mcpServers:list'),
  onChanged: (callback: (servers: unknown[]) => void) => {
    const handler = (_e: unknown, servers: unknown[]) => callback(servers);
    ipcRenderer.on('mcpServers:changed', handler);
    return () => ipcRenderer.removeListener('mcpServers:changed', handler);
  },
  start: (id: string) => ipcRenderer.invoke('mcpServers:start', id),
  // `disable: true` is the Increment-3-vocabulary "Off" (stops AND disables);
  // omitted/false is a temporary Stop that leaves the server eligible for
  // Start/Restart again.
  stop: (id: string, opts?: { disable?: boolean }) => ipcRenderer.invoke('mcpServers:stop', id, opts),
  restart: (id: string) => ipcRenderer.invoke('mcpServers:restart', id),
  remove: (id: string) => ipcRenderer.invoke('mcpServers:remove', id),
  // Increment 7's write gate (docs/design/mcp-hosting.md, DECISION 2026-08-13):
  // `undefined` selects every tool (the default); `[]` selects none — the two
  // are distinct and must stay that way all the way to the IPC call.
  setEnabledTools: (id: string, enabledTools: string[] | undefined) =>
    ipcRenderer.invoke('mcpServers:setEnabledTools', id, enabledTools),
  save: (draft: unknown) => ipcRenderer.invoke('mcpServers:save', draft),
  test: (draft: unknown) => ipcRenderer.invoke('mcpServers:test', draft),
  inventory: (id: string) => ipcRenderer.invoke('mcpServers:inventory', id),
  stderrTail: (id: string) => ipcRenderer.invoke('mcpServers:stderrTail', id),
  // Increment 5 (docs/design/mcp-hosting.md) — agent-authored servers.
  rescanAuthored: () => ipcRenderer.invoke('mcpServers:rescanAuthored'),
  listAuthored: () => ipcRenderer.invoke('mcpServers:listAuthored'),
  approveAuthored: (id: string) => ipcRenderer.invoke('mcpServers:approveAuthored', id),
});

contextBridge.exposeInMainWorld('modelsAPI', {
  // One call, no arguments: main owns the roster, the merge and the cache.
  // The reply is always immediately usable — it falls back to the built-in
  // list when discovery has not answered — so the picker never blocks on it.
  list: () => ipcRenderer.invoke('models:list'),
});

contextBridge.exposeInMainWorld('apisAPI', {
  list: () => ipcRenderer.invoke('apis:list'),
  // `clearSecret` is explicit because a blank secret already means "keep the
  // stored one" — without it there would be no way to remove a credential
  // without deleting the whole API.
  save: (api: unknown, originalId?: string, clearSecret?: boolean) =>
    ipcRenderer.invoke('apis:save', api, originalId, clearSecret),
  remove: (id: string) => ipcRenderer.invoke('apis:remove', id),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('apis:setEnabled', id, enabled),
  setAllowWrites: (id: string, allowWrites: boolean) =>
    ipcRenderer.invoke('apis:setAllowWrites', id, allowWrites),
  test: (id: string) => ipcRenderer.invoke('apis:test', id),
  /** Phase 2: a mini-app's call, gated by that tool's manifest grant. */
  request: (dirName: string, req: unknown) => ipcRenderer.invoke('apis:request', dirName, req),
});

contextBridge.exposeInMainWorld('skillsAPI', {
  list: () => ipcRenderer.invoke('skills:list'),
  read: (id: string, relPath: string) => ipcRenderer.invoke('skills:read', id, relPath),
  write: (id: string, relPath: string, content: string) => ipcRenderer.invoke('skills:write', id, relPath, content),
  create: (id: string, description?: string) => ipcRenderer.invoke('skills:create', id, description),
  remove: (id: string) => ipcRenderer.invoke('skills:delete', id),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', id, enabled),
  revertFile: (id: string, relPath: string) => ipcRenderer.invoke('skills:revertFile', id, relPath),
  revert: (id: string) => ipcRenderer.invoke('skills:revert', id),
  dismissUpdate: (id: string, relPath: string) => ipcRenderer.invoke('skills:dismissUpdate', id, relPath),
  summarizeRestore: () => ipcRenderer.invoke('skills:summarizeRestore'),
  restoreAll: () => ipcRenderer.invoke('skills:restoreAll'),
  reveal: (id: string) => ipcRenderer.invoke('skills:reveal', id),
  parseImportUrl: (input: string) => ipcRenderer.invoke('skills:parseImportUrl', input),
  fetchCatalogue: (target: unknown) => ipcRenderer.invoke('skills:fetchCatalogue', target),
  previewImport: (request: unknown) => ipcRenderer.invoke('skills:previewImport', request),
  pickImportFolder: () => ipcRenderer.invoke('skills:pickImportFolder'),
  importSkill: (request: unknown, asId?: string) => ipcRenderer.invoke('skills:import', request, asId),
  cancelImport: () => ipcRenderer.invoke('skills:cancelImport'),
});

contextBridge.exposeInMainWorld('knowledgeAPI', {
  ledger: (skill: string) => ipcRenderer.invoke('knowledge:ledger', skill),
  supersede: (skill: string, id: string, bySupersedingId?: string) =>
    ipcRenderer.invoke('knowledge:supersede', skill, id, bySupersedingId),
  listReviews: () => ipcRenderer.invoke('knowledge:listReviews'),
  dismissReview: (id: string) => ipcRenderer.invoke('knowledge:dismissReview', id),
  memories: () => ipcRenderer.invoke('knowledge:memories'),
});

contextBridge.exposeInMainWorld('workspacesAPI', {
  getActive: () => ipcRenderer.invoke('workspaces:getActive'),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  listDirectories: () => ipcRenderer.invoke('workspaces:listDirectories'),
  addDirectory: (directoryPath: string) => ipcRenderer.invoke('workspaces:addDirectory', directoryPath),
  removeDirectory: (directoryId: string) => ipcRenderer.invoke('workspaces:removeDirectory', directoryId),
  updateDirectoryPermission: (directoryId: string, readOnly: boolean) => ipcRenderer.invoke('workspaces:updateDirectoryPermission', directoryId, readOnly),
});

contextBridge.exposeInMainWorld('filesAPI', {
  readDirectory: (dirPath: string) => ipcRenderer.invoke('files:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('files:readFile', filePath),
  fileExists: (filePath: string) => ipcRenderer.invoke('files:exists', filePath),
  findByName: (filename: string, hintDirs: string[]) => ipcRenderer.invoke('files:findByName', filename, hintDirs),
  findByExtension: (extensions: string[]) => ipcRenderer.invoke('files:findByExtension', extensions),
  copyToWorkspace: (sourcePaths: string[], destinationDir: string) =>
    ipcRenderer.invoke('files:copyToWorkspace', sourcePaths, destinationDir),
  moveFile: (sourcePath: string, destinationDir: string) =>
    ipcRenderer.invoke('files:moveFile', sourcePath, destinationDir),
  deleteFile: (filePath: string) => ipcRenderer.invoke('files:deleteFile', filePath),
  trashFile: (filePath: string) => ipcRenderer.invoke('files:trashFile', filePath),
  createFile: (filePath: string) => ipcRenderer.invoke('files:createFile', filePath),
  createDirectory: (dirPath: string) => ipcRenderer.invoke('files:createDirectory', dirPath),
  renameFile: (filePath: string, newName: string) =>
    ipcRenderer.invoke('files:renameFile', filePath, newName),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('files:writeFile', filePath, content),
  downloadFile: (filename: string, content: string) => ipcRenderer.invoke('files:downloadFile', filename, content),
  showInFinder: (filePath: string) => ipcRenderer.invoke('files:showInFinder', filePath),
  revealInFinder: (filePath: string) => ipcRenderer.invoke('files:revealInFinder', filePath),
  selectFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('files:selectFile', filters),
  selectDirectory: () => ipcRenderer.invoke('files:selectDirectory'),
  convertImageToPng: (base64Data: string) => ipcRenderer.invoke('image:convertToPng', base64Data),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onCopyProgress: (callback: (progress: { copied: number; total: number; currentName: string | null }) => void) => {
    const handler = (_event: unknown, progress: { copied: number; total: number; currentName: string | null }) => callback(progress);
    ipcRenderer.on('files:copyProgress', handler);
    return () => { ipcRenderer.removeListener('files:copyProgress', handler); };
  },
  onWorkspaceChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('files:workspaceChanged', handler);
    return () => { ipcRenderer.removeListener('files:workspaceChanged', handler); };
  },
});

contextBridge.exposeInMainWorld('miniAppsAPI', {
  exportApp: (dirName: string) => ipcRenderer.invoke('miniApps:export', dirName),
  importApp: () => ipcRenderer.invoke('miniApps:import'),
  list: () => ipcRenderer.invoke('miniApps:list'),
  touch: (dirName: string) => ipcRenderer.invoke('miniApps:touch', dirName),
  setApis: (dirName: string, apis: string[]) => ipcRenderer.invoke('miniApps:setApis', dirName, apis),
  setArchived: (dirName: string, archived: boolean) => ipcRenderer.invoke('miniApps:setArchived', dirName, archived),
  delete: (dirName: string) => ipcRenderer.invoke('miniApps:delete', dirName),
  build: (dirName: string): Promise<{ ok: boolean; outfile?: string; error?: string; exitCode: number }> =>
    ipcRenderer.invoke('miniApps:build', dirName),
  onBuilt: (callback: (evt: { dirName: string }) => void) => {
    const handler = (_e: unknown, evt: { dirName: string }) => callback(evt);
    ipcRenderer.on('miniApps:built', handler);
    return () => ipcRenderer.removeListener('miniApps:built', handler);
  },
  // Edit mode for a tool's text (POC) — see shared/miniAppTextEdit.ts.
  textEdit: {
    probe: (dirName: string, target: TextEditTarget) => ipcRenderer.invoke(TEXT_EDIT_IPC.probe, dirName, target),
    apply: (dirName: string, req: TextEditApplyRequest) => ipcRenderer.invoke(TEXT_EDIT_IPC.apply, dirName, req),
    undo: (dirName: string) => ipcRenderer.invoke(TEXT_EDIT_IPC.undo, dirName),
    undoDepth: (dirName: string) => ipcRenderer.invoke(TEXT_EDIT_IPC.undoDepth, dirName),
  },
});

contextBridge.exposeInMainWorld('toolDataAPI', {
  list: () => ipcRenderer.invoke('toolData:list'),
  delete: (dirName: string) => ipcRenderer.invoke('toolData:delete', dirName),
});

contextBridge.exposeInMainWorld('findAPI', {
  open: () => ipcRenderer.invoke(FIND_IPC.open),
  next: (forward: boolean) => ipcRenderer.send(FIND_IPC.next, { forward }),
  refresh: () => ipcRenderer.send(FIND_IPC.refresh),
});

contextBridge.exposeInMainWorld('buildHealthAPI', {
  list: () => ipcRenderer.invoke('buildHealth:list'),
  onChanged: (callback: (all: unknown[]) => void) => {
    const handler = (_e: unknown, all: unknown[]) => callback(all);
    ipcRenderer.on('buildHealth:changed', handler);
    return () => ipcRenderer.removeListener('buildHealth:changed', handler);
  },
});

contextBridge.exposeInMainWorld('jobsAPI', {
  list: () => ipcRenderer.invoke('jobs:list'),
  begin: (input: { dirName: string; kind: string; label: string }) =>
    ipcRenderer.invoke('jobs:begin', input),
  end: (id: string, status?: 'done' | 'failed') => ipcRenderer.invoke('jobs:end', id, status),
  acknowledge: (dirName: string) => ipcRenderer.invoke('jobs:acknowledge', dirName),
  cancel: (id: string) => ipcRenderer.invoke('jobs:cancel', id),
  onCancelRequested: (callback: (req: { id: string; dirName: string; kind: string }) => void) => {
    const handler = (_e: unknown, req: { id: string; dirName: string; kind: string }) => callback(req);
    ipcRenderer.on('jobs:cancelRequested', handler);
    return () => ipcRenderer.removeListener('jobs:cancelRequested', handler);
  },
  onChanged: (callback: (jobs: unknown[]) => void) => {
    const handler = (_e: unknown, jobs: unknown[]) => callback(jobs);
    ipcRenderer.on('jobs:changed', handler);
    return () => ipcRenderer.removeListener('jobs:changed', handler);
  },
});

contextBridge.exposeInMainWorld('shareAPI', {
  getSettings: () => ipcRenderer.invoke('share:getSettings'),
  saveSettings: (patch: { siteUrl: string; apiUrl: string; publishToken?: string; clearToken?: boolean }) =>
    ipcRenderer.invoke('share:saveSettings', patch),
  test: () => ipcRenderer.invoke('share:test'),
  planApp: (dirName: string, includeInput: boolean) =>
    ipcRenderer.invoke('share:planApp', dirName, includeInput),
  publishApp: (dirName: string, opts: { includeInput: boolean }) =>
    ipcRenderer.invoke('share:publishApp', dirName, opts),
  unpublishApp: (dirName: string) => ipcRenderer.invoke('share:unpublishApp', dirName),
  statusApp: (dirName: string) => ipcRenderer.invoke('share:statusApp', dirName),
  publishFile: (filePath: string) => ipcRenderer.invoke('share:publishFile', filePath),
  unpublishFile: (filePath: string) => ipcRenderer.invoke('share:unpublishFile', filePath),
  statusFile: (filePath: string) => ipcRenderer.invoke('share:statusFile', filePath),
  onChanged: (callback: (evt: { dirName?: string; filePath?: string }) => void) => {
    const handler = (_e: unknown, evt: { dirName?: string; filePath?: string }) => callback(evt);
    ipcRenderer.on('share:changed', handler);
    return () => ipcRenderer.removeListener('share:changed', handler);
  },
  onProgress: (callback: (p: { dirName: string; uploaded: number; total: number }) => void) => {
    const handler = (_e: unknown, p: { dirName: string; uploaded: number; total: number }) => callback(p);
    ipcRenderer.on('share:progress', handler);
    return () => ipcRenderer.removeListener('share:progress', handler);
  },
});

contextBridge.exposeInMainWorld('miniAppMcpAPI', {
  register: (payload: {
    serverName: string;
    dirName: string;
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
    iframeRouteKey: string;
  }) => ipcRenderer.invoke('miniAppMcp:register', payload),
  unregister: (serverName: string) => ipcRenderer.invoke('miniAppMcp:unregister', serverName),
  unregisterByRoute: (iframeRouteKey: string) => ipcRenderer.invoke('miniAppMcp:unregisterByRoute', iframeRouteKey),
  list: (): Promise<Array<{ serverName: string; dirName: string; tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> }>> =>
    ipcRenderer.invoke('miniAppMcp:list'),
  callTool: (serverName: string, toolName: string, args: unknown): Promise<{ result?: unknown; error?: string }> =>
    ipcRenderer.invoke('miniAppMcp:callTool', serverName, toolName, args),
  onInvoke: (
    callback: (payload: { invocationId: string; iframeRouteKey: string; toolName: string; args: unknown }) => void,
  ) => {
    const listener = (_event: unknown, payload: { invocationId: string; iframeRouteKey: string; toolName: string; args: unknown }) => callback(payload);
    ipcRenderer.on('miniAppMcp:invoke', listener);
    return () => { ipcRenderer.removeListener('miniAppMcp:invoke', listener); };
  },
  sendResult: (payload: { invocationId: string; result?: unknown; error?: string }) =>
    ipcRenderer.send('miniAppMcp:result', payload),
  // Pushed on every register/unregister/unregisterByRoute — live rather than
  // a one-shot read, so a page mounted behind `display:none` stays correct.
  onChanged: (
    callback: (servers: Array<{ serverName: string; dirName: string; tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> }>) => void,
  ) => {
    const handler = (
      _e: unknown,
      servers: Array<{ serverName: string; dirName: string; tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> }>,
    ) => callback(servers);
    ipcRenderer.on('miniAppMcp:changed', handler);
    return () => { ipcRenderer.removeListener('miniAppMcp:changed', handler); };
  },
});

contextBridge.exposeInMainWorld('settingsAPI', {
  getMaxAttachmentSizeMB: () => ipcRenderer.invoke('settings:getMaxAttachmentSizeMB'),
  setMaxAttachmentSizeMB: (sizeMB: number) => ipcRenderer.invoke('settings:setMaxAttachmentSizeMB', sizeMB),
});

contextBridge.exposeInMainWorld('systemStatsAPI', {
  get: () => ipcRenderer.invoke('stats:get'),
});

contextBridge.exposeInMainWorld('screenshotAPI', {
  /** Runs the whole capture gesture; resolves with the image or a reason. */
  capture: (press?: { x: number; y: number }) => ipcRenderer.invoke('screenshot:capture', press),
});

contextBridge.exposeInMainWorld('dictationAPI', {
  /** Prompt-free capability check — safe to call on mount. */
  probe: (locale?: string) => ipcRenderer.invoke('dictation:probe', locale),
  start: (locale?: string) => ipcRenderer.invoke('dictation:start', locale),
  stop: () => ipcRenderer.invoke('dictation:stop'),
  onEvent: (callback: (event: unknown) => void) => {
    const handler = (_e: unknown, event: unknown) => callback(event);
    ipcRenderer.on('dictation:event', handler);
    return () => ipcRenderer.removeListener('dictation:event', handler);
  },
});

contextBridge.exposeInMainWorld('containerAPI', {
  start: () => ipcRenderer.invoke('container:start'),
  stop: () => ipcRenderer.invoke('container:stop'),
  status: () => ipcRenderer.invoke('container:status'),
  exec: (command: string[]) => ipcRenderer.invoke('container:exec', command),
  execLogged: (command: string[], meta?: { source?: string; appDirName?: string | null }) =>
    ipcRenderer.invoke('container:execLogged', command, meta),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  ensureSetup: () => ipcRenderer.invoke('container:ensureSetup'),
  getEnvironmentInfo: () => ipcRenderer.invoke('container:getEnvironmentInfo'),
  appDepsReady: (dirName: string) => ipcRenderer.invoke('container:appDepsReady', dirName),
  ensureAppDeps: (dirName: string) => ipcRenderer.invoke('container:ensureAppDeps', dirName),
  getAppInstallRequests: (dirName: string) => ipcRenderer.invoke('container:getAppInstallRequests', dirName),
  onSetupProgress: (callback: (progress: { stage: string; message: string; percent?: number }) => void) => {
    const handler = (_event: unknown, progress: { stage: string; message: string }) => callback(progress);
    ipcRenderer.on('setup:progress', handler);
    return () => { ipcRenderer.removeListener('setup:progress', handler); };
  },
  onProgress: (callback: (progress: { stage: string; message: string; percent?: number }) => void) => {
    const handler = (_event: unknown, progress: { stage: string; message: string }) => callback(progress);
    ipcRenderer.on('container:progress', handler);
    return () => { ipcRenderer.removeListener('container:progress', handler); };
  },
  onPackageState: (callback: (e: { registry: string; package: string; state: string }) => void) => {
    const handler = (_event: unknown, e: { registry: string; package: string; state: string }) => callback(e);
    ipcRenderer.on('installer:packageState', handler);
    return () => { ipcRenderer.removeListener('installer:packageState', handler); };
  },
  onPackageLine: (callback: (e: { registry: string; package: string; line: string }) => void) => {
    const handler = (_event: unknown, e: { registry: string; package: string; line: string }) => callback(e);
    ipcRenderer.on('installer:packageLine', handler);
    return () => { ipcRenderer.removeListener('installer:packageLine', handler); };
  },
});

contextBridge.exposeInMainWorld('jupyterAPI', {
  startGateway: () => ipcRenderer.invoke('jupyter:startGateway'),
  stopGateway: () => ipcRenderer.invoke('jupyter:stopGateway'),
  restartGateway: () => ipcRenderer.invoke('jupyter:restartGateway'),
  gatewayStatus: () => ipcRenderer.invoke('jupyter:gatewayStatus'),
  listKernels: () => ipcRenderer.invoke('jupyter:listKernels'),
  shutdownKernel: (kernelId: string) => ipcRenderer.invoke('jupyter:shutdownKernel', kernelId),
});

contextBridge.exposeInMainWorld('commandLogAPI', {
  getAll: () => ipcRenderer.invoke('commandLog:getAll'),
  getByApp: (appDirName: string) => ipcRenderer.invoke('commandLog:getByApp', appDirName),
  getAppNames: () => ipcRenderer.invoke('commandLog:getAppNames'),
  onEntry: (callback: (entry: any) => void) => {
    const handler = (_event: unknown, entry: any) => callback(entry);
    ipcRenderer.on('commandLog:entry', handler);
    return () => { ipcRenderer.removeListener('commandLog:entry', handler); };
  },
});

contextBridge.exposeInMainWorld('systemLogAPI', {
  getAll: () => ipcRenderer.invoke('systemLog:getAll'),
  onEntry: (callback: (entry: any) => void) => {
    const handler = (_event: unknown, entry: any) => callback(entry);
    ipcRenderer.on('systemLog:entry', handler);
    return () => { ipcRenderer.removeListener('systemLog:entry', handler); };
  },
});


contextBridge.exposeInMainWorld('fileMonitorAPI', {
  status: () => ipcRenderer.invoke('fileMonitor:status'),
  start: () => ipcRenderer.invoke('fileMonitor:start'),
  stop: () => ipcRenderer.invoke('fileMonitor:stop'),
  getTodaySessions: () => ipcRenderer.invoke('fileMonitor:getTodaySessions'),
  openFile: (fileUrl: string, bundleId?: string) => ipcRenderer.invoke('fileMonitor:openFile', fileUrl, bundleId),
});

contextBridge.exposeInMainWorld('observationsAPI', {
  getFileSessions: () => ipcRenderer.invoke('observations:getFileSessions'),
  getSessionFiles: () => ipcRenderer.invoke('observations:getSessionFiles'),
});

contextBridge.exposeInMainWorld('debugAPI', {
  getStorageInfo: () => ipcRenderer.invoke('debug:getStorageInfo'),
  clearSelected: (ids: string[]) => ipcRenderer.invoke('debug:clearSelected', ids),
  exportWorkspace: () => ipcRenderer.invoke('debug:exportWorkspace'),
  importWorkspace: () => ipcRenderer.invoke('debug:importWorkspace'),
  hardResetWorkspace: () => ipcRenderer.invoke('debug:hardResetWorkspace'),
  exportLogs: () => ipcRenderer.invoke('debug:exportLogs'),
  pruneImages: () => ipcRenderer.invoke('debug:pruneImages'),
  syncOverlay: () => ipcRenderer.invoke('debug:syncOverlay'),
  isOverlayEnabled: () => ipcRenderer.invoke('debug:isOverlayEnabled'),
  log: (msg: string) => ipcRenderer.invoke('debug:log', msg),
  telemetryTest: (kind: string, subsystem?: string) =>
    ipcRenderer.invoke('debug:telemetry-test', kind, subsystem),
});

contextBridge.exposeInMainWorld('calendarAPI', {
  listGroups: () => ipcRenderer.invoke('calendar:listGroups'),
  createGroup: (data: unknown) => ipcRenderer.invoke('calendar:createGroup', data),
  updateGroup: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateGroup', id, data),
  deleteGroup: (id: string) => ipcRenderer.invoke('calendar:deleteGroup', id),
  getGroupTimeRange: (id: string) => ipcRenderer.invoke('calendar:getGroupTimeRange', id),

  listEvents: (opts?: unknown) => ipcRenderer.invoke('calendar:listEvents', opts),
  createEvent: (data: unknown) => ipcRenderer.invoke('calendar:createEvent', data),
  updateEvent: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateEvent', id, data),
  deleteEvent: (id: string) => ipcRenderer.invoke('calendar:deleteEvent', id),

  addEventFile: (eventId: string, filePath: string) => ipcRenderer.invoke('calendar:addEventFile', eventId, filePath),
  listEventFiles: (eventId: string) => ipcRenderer.invoke('calendar:listEventFiles', eventId),
  removeEventFile: (id: number) => ipcRenderer.invoke('calendar:removeEventFile', id),
  addGroupFile: (groupId: string, filePath: string) => ipcRenderer.invoke('calendar:addGroupFile', groupId, filePath),
  listGroupFiles: (groupId: string, includeFromEvents?: boolean) => ipcRenderer.invoke('calendar:listGroupFiles', groupId, includeFromEvents),
  removeGroupFile: (id: number) => ipcRenderer.invoke('calendar:removeGroupFile', id),

  listResources: (opts?: unknown) => ipcRenderer.invoke('calendar:listResources', opts),
  createResource: (data: unknown) => ipcRenderer.invoke('calendar:createResource', data),
  updateResource: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateResource', id, data),
  deleteResource: (id: string) => ipcRenderer.invoke('calendar:deleteResource', id),
  openResourceFile: (filePath: string) => ipcRenderer.invoke('calendar:openResourceFile', filePath),
  openResourceUrl: (url: string) => ipcRenderer.invoke('calendar:openResourceUrl', url),
  revealResourceFile: (filePath: string) => ipcRenderer.invoke('calendar:revealResourceFile', filePath),
  pickResourceFile: () => ipcRenderer.invoke('calendar:pickResourceFile'),
  moveResource: (id: string, data: unknown) => ipcRenderer.invoke('calendar:moveResource', id, data),
  listWorkspaceFiles: () => ipcRenderer.invoke('calendar:listWorkspaceFiles'),

  listDependencies: () => ipcRenderer.invoke('calendar:listDependencies'),
  createDependency: (data: unknown) => ipcRenderer.invoke('calendar:createDependency', data),
  updateDependency: (id: string, data: unknown) => ipcRenderer.invoke('calendar:updateDependency', id, data),
  deleteDependency: (id: string) => ipcRenderer.invoke('calendar:deleteDependency', id),
  moveEventWithCascade: (id: string, newStartAt: string, newEndAt: string) => ipcRenderer.invoke('calendar:moveEventWithCascade', id, newStartAt, newEndAt),
  adjustBuffer: (depId: string, newLagCurrentMs: number) => ipcRenderer.invoke('calendar:adjustBuffer', depId, newLagCurrentMs),
  onCalendarMutation: (callback: (mutation: unknown) => void): (() => void) => {
    const handler = (_event: unknown, mutation: unknown) => callback(mutation);
    ipcRenderer.on('calendar:mutation', handler);
    return () => { ipcRenderer.removeListener('calendar:mutation', handler); };
  },

});

contextBridge.exposeInMainWorld('scheduledTasksAPI', {
  list: () => ipcRenderer.invoke('scheduledTasks:list'),
  get: (id: string) => ipcRenderer.invoke('scheduledTasks:get', id),
  create: (data: { name: string; description: string; prompt: string; cron_expression: string }) =>
    ipcRenderer.invoke('scheduledTasks:create', data),
  update: (id: string, data: { name?: string; description?: string; prompt?: string; cron_expression?: string; enabled?: number }) =>
    ipcRenderer.invoke('scheduledTasks:update', id, data),
  delete: (id: string) => ipcRenderer.invoke('scheduledTasks:delete', id),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('scheduledTasks:setEnabled', id, enabled),
  runNow: (id: string) => ipcRenderer.invoke('scheduledTasks:runNow', id),
  listRuns: (taskId: string) => ipcRenderer.invoke('scheduledTasks:listRuns', taskId),
  /**
   * Fires on every scheduled-task write, including runs started by the
   * scheduler's own clock. Returns its own unsubscribe closure — do NOT use
   * `removeAllListeners`, which would tear down another component's
   * subscription to the same channel.
   */
  onChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('scheduledTasks:changed', handler);
    return () => ipcRenderer.removeListener('scheduledTasks:changed', handler);
  },
});

contextBridge.exposeInMainWorld('academiaFileAPI', {
  read: (relativePath: string) => ipcRenderer.invoke('academiaFile:read', relativePath),
  write: (relativePath: string, content: string) => ipcRenderer.invoke('academiaFile:write', relativePath, content),
});

contextBridge.exposeInMainWorld('reportsAPI', {
  getLatest: (reportType: string) => ipcRenderer.invoke('reports:getLatest', reportType),
  get: (reportId: string) => ipcRenderer.invoke('reports:get', reportId),
  update: (reportId: string, reportData: string) =>
    ipcRenderer.invoke('reports:update', reportId, reportData),
});

contextBridge.exposeInMainWorld('papersAPI', {
  fetch: (input: { topics: string[]; maxPerTopic?: number; maxTotal?: number }) =>
    ipcRenderer.invoke('papers:fetch', input),
});

contextBridge.exposeInMainWorld('briefingsAPI', {
  list: (filter?: { status?: string[]; limit?: number }) =>
    ipcRenderer.invoke('briefings:list', filter),
  setStatus: (id: string, status: string) =>
    ipcRenderer.invoke('briefings:setStatus', id, status),
  /** Fires whenever briefings are created, updated, or change status. */
  onChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('briefings:changed', handler);
    return () => { ipcRenderer.removeListener('briefings:changed', handler); };
  },
});

contextBridge.exposeInMainWorld('scannedFilesAPI', {
  getByType: (fileType: string) => ipcRenderer.invoke('scannedFiles:getByType', fileType),
  getAll: () => ipcRenderer.invoke('scannedFiles:getAll'),
  updateTag: (filePath: string, fileName: string, fileType: string) =>
    ipcRenderer.invoke('scannedFiles:updateTag', filePath, fileName, fileType),
  removeTag: (filePath: string) => ipcRenderer.invoke('scannedFiles:removeTag', filePath),
});

contextBridge.exposeInMainWorld('scannerAPI', {
  start: () => ipcRenderer.invoke('scanner:start'),
  onEvent: (callback: (event: any) => void) => {
    const handler = (_event: unknown, data: any) => callback(data);
    ipcRenderer.on('scanner:event', handler);
    return () => {
      ipcRenderer.removeListener('scanner:event', handler);
    };
  },
});

contextBridge.exposeInMainWorld('sessionsAPI', {
  list: (source?: string) => ipcRenderer.invoke('sessions:list', source),
  get: (id: string) => ipcRenderer.invoke('sessions:get', id),
  /** Estimated cost of the whole chat so far; null when nothing was measured. */
  cost: (id: string) => ipcRenderer.invoke('sessions:cost', id) as Promise<number | null>,
  setDocumentPath: (id: string, documentPath: string) =>
    ipcRenderer.invoke('sessions:setDocumentPath', id, documentPath),
  countForDocument: (documentPath: string) =>
    ipcRenderer.invoke('sessions:countForDocument', documentPath) as Promise<number>,
  rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
  delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  listMessages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
  /** First user/assistant line of every chat, in one query; see main/db/chatSearch.ts. */
  previews: () => ipcRenderer.invoke('sessions:previews'),
  /** Chats whose message text (prose only, never tool output) matches; see docs/design/chat-search.md. */
  searchProse: (query: string) => ipcRenderer.invoke('sessions:searchProse', query),
  findForApp: (dirName: string) => ipcRenderer.invoke('sessions:findForApp', dirName) as Promise<string | null>,
  listForApp: (dirName: string) => ipcRenderer.invoke('sessions:listForApp', dirName),
  createForApp: (dirName: string) => ipcRenderer.invoke('sessions:createForApp', dirName) as Promise<string | null>,
  onTitleUpdated: (callback: (sessionId: string, title: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, title: string) => callback(sessionId, title);
    ipcRenderer.on('sessions:titleUpdated', handler);
    return () => { ipcRenderer.removeListener('sessions:titleUpdated', handler); };
  },
  onSessionsChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('sessions:changed', handler);
    return () => { ipcRenderer.removeListener('sessions:changed', handler); };
  },
  /** Which chats are working and which have unseen news; see main/chatActivity.ts. */
  getActivity: () =>
    ipcRenderer.invoke('chats:getActivity') as Promise<{ activeIds: string[]; unreadIds: string[] }>,
  onActivityChanged: (callback: (snapshot: { activeIds: string[]; unreadIds: string[] }) => void) => {
    const handler = (_e: unknown, snapshot: { activeIds: string[]; unreadIds: string[] }) => callback(snapshot);
    ipcRenderer.on('chats:activity', handler);
    return () => { ipcRenderer.removeListener('chats:activity', handler); };
  },
  /** The conversation now on screen, or null. Clears its unread mark while the window is focused. */
  setViewing: (sessionId: string | null) => ipcRenderer.send('chats:setViewing', sessionId),
  /**
   * Fires after a turn completes for `sessionId` in any surface (desktop
   * or overlay). Emitted by the main process's SSE fanout (`ensureSseFanout`'s
   * onDone). The desktop chat panel uses this to refetch its history when
   * the active thread matches — closes the gap where an overlay-typed user
   * message stays missing on the desktop because chat:event only carries
   * assistant-side stream events, not the user message that prompted them.
   */
  onForeignTurnDone: (callback: (sessionId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('chat:foreign-done', handler);
    return () => { ipcRenderer.removeListener('chat:foreign-done', handler); };
  },
});

// Track active stream iterators per threadId to clean up stale ones
const activeStreams = new Map<string, () => void>();

// Buffer events that arrive before a stream iterator is created for a threadId.
// This prevents lost events when the overlay sends a message and the main process
// sets up IPC forwarding before the renderer has subscribed.
//
// Capped at EVENT_BUFFER_CAP per thread (drop-oldest) so an abandoned threadId
// — one that gets events but never creates a stream iterator — can't leak
// memory indefinitely. 2000 is comfortably above any plausible single turn
// (a long tool-heavy turn is ~hundreds of events) while staying bounded.
const eventBuffers = new Map<string, { events: any[]; done: boolean; error?: string }>();
const EVENT_BUFFER_CAP = 2000;

ipcRenderer.on('chat:event', (_event: any, threadId: string, token: any) => {
  if (token?.type === 'turn-complete') {
    console.log(`[Preload:buffer] turn-complete arrived, activeStream=${activeStreams.has(threadId)}`);
    // Renderer-side fanout so non-stream consumers (e.g. a post-turn
    // SQLite-resync component) can react regardless of who owned the
    // primary stream. Fires for every turn-complete, including ones
    // chatAdapter consumed itself — listeners are expected to gate on
    // `thread.isRunning` to skip the local-driver case where the
    // in-memory state is already current.
    window.dispatchEvent(new CustomEvent('chat:turn-end', { detail: { threadId } }));
  }
  if (activeStreams.has(threadId)) return; // Active stream handles these
  console.warn(`[Preload:buffer] Buffering event type=${token?.type} for ${threadId} (no active stream)`);
  const buf = eventBuffers.get(threadId) || { events: [], done: false };
  buf.events.push(token);
  if (buf.events.length > EVENT_BUFFER_CAP) {
    buf.events.shift();
  }
  eventBuffers.set(threadId, buf);
});
ipcRenderer.on('chat:done', (_event: any, threadId: string) => {
  console.log(`[Preload:buffer] chat:done arrived, activeStream=${activeStreams.has(threadId)}`);
  if (activeStreams.has(threadId)) return;
  // Only record the terminator if we are already buffering a turn nobody has
  // picked up yet. A LONE chat:done — no buffered events — belongs to a turn
  // that has already been fully consumed and closed; storing it would make the
  // NEXT stream iterator for this thread born done, so the next message would
  // render nothing at all.
  //
  // This was latent until now: chat:done had never once fired in production
  // (the forwarding listener was always removed first). Keeping the pipe alive
  // past a detach makes it fire routinely, so the poison becomes reachable.
  const buf = eventBuffers.get(threadId);
  if (!buf) {
    console.debug(`[Preload:buffer] Dropping stale chat:done for ${threadId} (nothing buffered)`);
    return;
  }
  console.warn(`[Preload:buffer] Buffering chat:done for ${threadId} (no active stream)`);
  buf.done = true;
  eventBuffers.set(threadId, buf);
});
ipcRenderer.on('chat:error', (_event: any, threadId: string, err: string) => {
  if (activeStreams.has(threadId)) return;
  const buf = eventBuffers.get(threadId) || { events: [], done: false };
  buf.done = true;
  buf.error = err;
  eventBuffers.set(threadId, buf);
});

function createStreamIterator(threadId: string, options?: { discardBuffered?: boolean }) {
  // Clean up any existing stream iterator for this threadId
  if (activeStreams.has(threadId)) {
    console.debug(`[StreamIterator] Replacing existing stream for ${threadId}`);
  }
  activeStreams.get(threadId)?.();

  // Drain any buffered events that arrived before this stream was created.
  //
  // `discardBuffered` is passed by sendMessage: a new send starts a new turn,
  // so anything still sitting in the buffer is by definition leftovers from a
  // previous one. Replaying them would prepend stale content to the new
  // message, and a leftover terminator would end the new turn before it began.
  const buffered = options?.discardBuffered ? undefined : eventBuffers.get(threadId);
  if (options?.discardBuffered && eventBuffers.has(threadId)) {
    const stale = eventBuffers.get(threadId);
    console.warn(`[StreamIterator] Discarding ${stale?.events.length ?? 0} stale buffered event(s) for ${threadId} on new send`);
  }
  eventBuffers.delete(threadId);

  const pending: any[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  if (buffered) {
    const types = buffered.events.map((e: any) => e?.type).join(',');
    console.warn(`[StreamIterator] Draining ${buffered.events.length} buffered events for ${threadId}: [${types}] done=${buffered.done}`);
    for (const token of buffered.events) {
      pending.push({ value: token, done: false });
    }
    if (buffered.error) {
      pending.push({ value: null, done: true, error: buffered.error });
      done = true;
    } else if (buffered.done) {
      done = true;
    }
  }

  const notify = () => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  const eventHandler = (_event: any, eventThreadId: string, token: any) => {
    if (eventThreadId !== threadId) return;
    if (token?.type === 'turn-complete') {
      console.log(`[StreamIterator] turn-complete received, pending=${pending.length}, done=${done}`);
    }
    pending.push({ value: token, done: false });
    notify();
  };

  const doneHandler = (_event: any, eventThreadId: string) => {
    if (eventThreadId !== threadId) return;
    console.warn(`[StreamIterator] chat:done received for ${threadId}, pending=${pending.length}`);
    done = true;
    notify();
  };

  const errorHandler = (_event: any, eventThreadId: string, err: string) => {
    if (eventThreadId !== threadId) return;
    console.debug(`[StreamIterator] Stream error for ${threadId}: ${err}`);
    pending.push({ value: null, done: true, error: err });
    done = true;
    notify();
  };

  ipcRenderer.on('chat:event', eventHandler);
  ipcRenderer.on('chat:done', doneHandler);
  ipcRenderer.on('chat:error', errorHandler);

  // Declared with let so cleanup can reference markDone for an ownership check.
  // Without the check, a stale cleanup (e.g. from useSessionSubscription's
  // unsubscribe after sendMessage replaced the stream) would delete the newer
  // stream's activeStreams entry, causing the global buffer listeners to capture
  // events that the live stream should be handling.
  let markDone!: () => void;

  const cleanup = () => {
    ipcRenderer.removeListener('chat:event', eventHandler);
    ipcRenderer.removeListener('chat:done', doneHandler);
    ipcRenderer.removeListener('chat:error', errorHandler);
    if (activeStreams.get(threadId) === markDone) {
      activeStreams.delete(threadId);
    }
  };

  markDone = () => {
    done = true;
    cleanup();
    notify();
  };

  activeStreams.set(threadId, markDone);

  const stream = {
    next: () => {
      if (pending.length > 0) {
        const item = pending.shift();
        if (item.done) cleanup();
        if (item.error) return Promise.reject(new Error(item.error));
        return Promise.resolve(item);
      }

      if (done) {
        cleanup();
        return Promise.resolve({ value: null, done: true });
      }

      return new Promise<any>((r, reject) => {
        resolve = () => {
          if (pending.length > 0) {
            const item = pending.shift();
            if (item.done) cleanup();
            if (item.error) {
              reject(new Error(item.error));
            } else {
              r(item);
            }
          } else if (done) {
            cleanup();
            r({ value: null, done: true });
          }
        };
      });
    },
  };

  return { stream, markDone };
}

contextBridge.exposeInMainWorld('chatAPI', {
  sendMessage: (threadId: string, text: string, attachments?: any[], model?: string, documentPath?: string, messageId?: string, effort?: string, quote?: any) => {
    // Fire-and-forget invoke for the ack/dedup round-trip. We can't await it
    // here because contextBridge doesn't proxy nested methods through a
    // resolved Promise — the renderer would receive a structured-cloned
    // stream whose `next()` is missing and the iterator would hang.
    // Errors are routed to the chat:error IPC channel so the stream iterator
    // (which already listens for that) surfaces them the same way it
    // surfaces in-stream errors.
    ipcRenderer.invoke('chat:send', { threadId, text, attachments, model, documentPath, messageId, effort, quote })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        ipcRenderer.emit('chat:error', null, threadId, message);
      });
    // `release` is bound to THIS iterator's markDone, not the current slot
    // occupant. If a takeover force-subscribes mid-turn (replacing this
    // iterator with a new one), markDone's cleanup ownership check makes
    // this release a harmless no-op on the new iterator instead of killing
    // it. A global `activeStreams.get(threadId)?.()` would clobber the
    // takeover and the takeover's resumeRun would terminate immediately.
    const { stream, markDone } = createStreamIterator(threadId, { discardBuffered: true });
    return { stream, release: markDone };
  },
  subscribe: (threadId: string, options?: { force?: boolean }) => {
    // Always ensure main-process forwarding is set up
    ipcRenderer.send('chat:subscribe', threadId);

    if (!options?.force && activeStreams.has(threadId)) {
      // sendMessage already owns a primary stream for this thread.
      // Return an immediately-done stream so the subscription defers to chatAdapter
      // instead of creating a competing consumer.
      console.debug(`[StreamIterator] subscribe: deferring to existing primary stream for ${threadId}`);
      const noop = () => { };
      return {
        stream: { next: () => Promise.resolve({ value: null, done: true as const }) } as any,
        unsubscribe: noop,
      };
    }

    if (options?.force && activeStreams.has(threadId)) {
      console.debug(`[StreamIterator] subscribe: force-taking over existing primary stream for ${threadId}`);
    }
    // createStreamIterator already calls markDone on any existing entry in
    // activeStreams, so force is implemented by simply not short-circuiting.
    const { stream, markDone } = createStreamIterator(threadId);
    return { stream, unsubscribe: () => { markDone(); } };
  },
  // Tells main this surface has navigated away. Does NOT cancel an
  // in-flight turn (use stopResponding for that) — only drops the
  // visibility refcount so the registry can decide to evict.
  unsubscribe: (threadId: string) => {
    ipcRenderer.send('chat:unsubscribe', threadId);
  },
  stopResponding: (threadId: string) => {
    activeStreams.get(threadId)?.();
    ipcRenderer.send('chat:stop', threadId);
  },
  isTurnInProgress: (threadId: string): Promise<boolean> => {
    return ipcRenderer.invoke('chat:isTurnInProgress', threadId);
  },
  // Used by chatAdapter's stall watchdog to decide whether a silent stream
  // means "still working" or "the turn ended without us hearing about it".
  getTurnStatus: (threadId: string): Promise<{ turnInProgress: boolean; sessionAlive: boolean }> => {
    return ipcRenderer.invoke('chat:turnStatus', threadId);
  },
});

// Edit state API — used by suggestion cards in the desktop app
contextBridge.exposeInMainWorld('editStatesAPI', {
  applyEdit: (params: { toolCallId: string; document_path?: string; search_text: string; replacement_text: string; replace_scope?: string; match_case?: boolean }) =>
    ipcRenderer.invoke('edit-state:apply', params),
  setState: (toolCallId: string, state: string) =>
    ipcRenderer.invoke('edit-state:set', { toolCallId, state }),
  getAll: () =>
    ipcRenderer.invoke('edit-state:get-all'),
});

// All streaming Anthropic responses share a single IPC channel
// ('anthropic:stream:event') and are demultiplexed by streamKey here rather
// than using per-request dynamic channel names (e.g. 'chunk:req-123'). One
// persistent listener is cheaper than registering and cleaning up three
// listeners per request, and eliminates the risk of stale listener accumulation
// if a stream's cleanup path is missed.
const anthropicStreamHandlers = new Map<string, (ev: { type: string; payload: unknown }) => void>();
ipcRenderer.on('anthropic:stream:event', (_event, msg: { streamKey: string; type: string; payload: unknown }) => {
  anthropicStreamHandlers.get(msg.streamKey)?.(msg);
});

contextBridge.exposeInMainWorld('officeAddinAPI', {
  status: () => ipcRenderer.invoke('officeAddin:status'),
  startServer: () => ipcRenderer.invoke('officeAddin:startServer'),
  stopServer: () => ipcRenderer.invoke('officeAddin:stopServer'),
  sideload: () => ipcRenderer.invoke('officeAddin:sideload'),
  remove: () => ipcRenderer.invoke('officeAddin:remove'),
  trustCert: () => ipcRenderer.invoke('officeAddin:trustCert'),
  removeCert: () => ipcRenderer.invoke('officeAddin:removeCert'),
  deleteCert: () => ipcRenderer.invoke('officeAddin:deleteCert'),
});

contextBridge.exposeInMainWorld('academiaAPI', {
  fetch: (method: string, endpoint: string, data?: unknown) =>
    ipcRenderer.invoke('academia:fetch', { method, endpoint, data }),
});

contextBridge.exposeInMainWorld('telemetryAPI', {
  getContext: () => ipcRenderer.invoke('telemetry:getContext'),
  subscribeAuthState: () => ipcRenderer.invoke('telemetry:subscribe-auth-state'),
  track: (eventName: string, metadata: Record<string, unknown>, surface?: string) =>
    ipcRenderer.invoke('telemetry:track', { event_name: eventName, metadata, surface }),
  onAuthStateChanged: (cb: (authenticated: boolean) => void) => {
    const handler = (_event: unknown, value: boolean) => cb(value);
    ipcRenderer.on('telemetry:auth-state-changed', handler);
    return () => ipcRenderer.removeListener('telemetry:auth-state-changed', handler);
  },
});

contextBridge.exposeInMainWorld('toolAnalyticsAPI', {
  opened: (dirName: string) =>
    ipcRenderer.invoke('tool:opened', dirName) as Promise<{
      tool_id: string;
      open_count_so_far: number;
      days_since_created: number;
    } | null>,
  setThreadCreationPrompt: (threadId: string, prompt: string) =>
    ipcRenderer.invoke('tool:setThreadCreationPrompt', threadId, prompt),
});

contextBridge.exposeInMainWorld('nativeToolsAPI', {
  getUrl: (toolId: string) => ipcRenderer.invoke('nativeTools:getUrl', toolId),
});

contextBridge.exposeInMainWorld('anthropicAPI', {
  complete: (params: unknown) => ipcRenderer.invoke('anthropic:complete', params),

  stream: (
    streamKey: string,
    params: unknown,
    onChunk: (text: string) => void,
    onDone: (message: unknown) => void,
    onError: (err: string) => void,
  ) => {
    // cleanup removes the handler from the map once the stream reaches a
    // terminal state (done or error). It is also returned so the caller can
    // abort early if needed (e.g. component unmount before the stream finishes).
    const cleanup = () => anthropicStreamHandlers.delete(streamKey);
    anthropicStreamHandlers.set(streamKey, ({ type, payload }) => {
      if (type === 'chunk') onChunk(payload as string);
      else if (type === 'done') { cleanup(); onDone(payload); }
      else if (type === 'error') { cleanup(); onError(payload as string); }
    });
    ipcRenderer.send('anthropic:stream', { streamKey, params });
    return cleanup;
  },
});

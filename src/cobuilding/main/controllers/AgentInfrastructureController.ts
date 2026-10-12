import { app, Notification as ElectronNotification } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import type { WorkspaceController } from './WorkspaceController';
import type { containerService as containerServiceInstance } from '../containerService';
import { getCredentials } from '../cobuildingTokenManager';
import { updateManifest } from '../manifestIO';
import { getScannedFilesByType, getScannedFiles } from '../db/scannedFilesRepository';
import { getLatestReport } from '../db/reportRepository';
import { AGENT_MEMORY_SUBDIR, REFERENCES_SUBDIR, REFERENCES_INDEX } from '../../shared/paths';
import { queryActivity } from '../activityQuery';
import { readChatForAgent, listChatsForAgent } from '../chatReference';
import { buildMiniApp } from '../miniAppBuilder';
import { ensurePythonVenv } from '../pythonSetup';
import { listConnectorsWithSecrets } from '../connectorsStore';
import { listApis } from '../apiStore';
import { apiProxy } from '../apiProxy';
import { BACKGROUND_REQUEST, DEFAULT_MODEL, messageText } from '../../shared/models';
import {
  API_BASE_ENV,
  API_PROXY_TOKEN_HEADER,
  API_TOKEN_ENV,
  describeAuthStyle,
  effectiveAllowedHosts,
} from '../../shared/apis';
import { buildMcpServers, connectorAllowedTools } from '../../shared/connectors';
import { buildAgentAllowedTools } from '../../shared/agentAllowedTools';
import { buildSkillRuntimeConfig } from '../../shared/skills';
import { readSkillsState } from '../skillStore';
import { provisionWorkspace } from '../skills';
import { recordFinding } from '../knowledge/findingsLedger';
import * as mcpHost from '../mcpHost';
import type { HostedServerPush } from '../../shared/hostedMcp';

export interface AgentInfrastructureDeps {
  workspaceController: WorkspaceController;
  containerService: typeof containerServiceInstance;
  refreshCredentials: () => Promise<{ apiKey: string; baseURL?: string }>;
  onNotificationClick?: (action: any) => void;
}

export class AgentInfrastructureController {
  private _activeNotifications = new Set<any>();
  private deps: AgentInfrastructureDeps;

  // Debounces `mcpHost.onInventoryChanged` so a boot wave of several hosted
  // servers becoming ready together collapses into one `POST /hosted`
  // instead of one per server (docs/design/mcp-hosting.md, Increment 4 / R6).
  // Short enough that a single server's readiness never feels delayed to the
  // user; long enough to coalesce a burst.
  private static readonly HOSTED_PUSH_DEBOUNCE_MS = 200;
  private hostedPushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: AgentInfrastructureDeps) {
    this.deps = deps;

    // Agent reach for hosted MCP servers (docs/design/mcp-hosting.md,
    // Increment 4 / R6). Two triggers push the SAME live inventory, read
    // fresh each time by `pushHostedInventory` — never a remembered
    // snapshot:
    //  - `mcpHost.onInventoryChanged` fires on every status transition of
    //    every server, debounced below so a boot wave doesn't become a burst
    //    of HTTP round-trips.
    //  - `containerService.onAgentServerRestarted` fires once, after an
    //    unexpected agent-server crash-restart. Deliberately NOT debounced:
    //    the fresh agent-server process boots with whatever
    //    `lastAgentServerConfig.hostedServers` was last remembered (which can
    //    be stale — see `pushHostedInventory`'s comment), so this is a single
    //    gap to close as fast as possible, not a burst to coalesce.
    // Subscribed once here, in the constructor, rather than inside `start()`
    // — `start()` has two call sites (a renderer reload re-enters it) and
    // this controller is a single app-lifetime instance, so subscribing here
    // guarantees exactly one listener of each kind for the process's whole
    // life instead of accumulating one pair per `start()` call.
    mcpHost.onInventoryChanged(() => this.scheduleHostedPush());
    this.deps.containerService.onAgentServerRestarted(() => {
      void this.pushHostedInventory();
    });
  }

  private scheduleHostedPush(): void {
    if (this.hostedPushTimer) return;
    this.hostedPushTimer = setTimeout(() => {
      this.hostedPushTimer = null;
      void this.pushHostedInventory();
    }, AgentInfrastructureController.HOSTED_PUSH_DEBOUNCE_MS);
    // Never hold the process open on this timer alone.
    this.hostedPushTimer.unref?.();
  }

  /**
   * Read `mcpHost`'s CURRENT live state and push the whole set to the agent
   * server. Always live, never a replay of what was last remembered in
   * `lastAgentServerConfig.hostedServers` — that remembered copy exists so a
   * crash-restart has SOMETHING to boot with (see `rememberAgentHosted`'s own
   * comment), but it can only ever be as fresh as the last successful push,
   * and this function's whole job is to make that push happen.
   *
   * Never throws: a down agent server (mid-boot, mid-restart) is the normal
   * case this feature has to tolerate, not an error to propagate out of a
   * supervisor status-change callback or a restart listener.
   */
  private async pushHostedInventory(): Promise<void> {
    try {
      const hosted = await mcpHost.readyServersForAgent();
      const ok = await this.deps.containerService.updateAgentHosted(hosted);
      log.info(
        `[AgentInfrastructure] Pushed ${Object.keys(hosted).length} hosted MCP server(s) to agent server: `
        + `${ok ? 'ok' : 'no live agent server'}`,
      );
    } catch (err) {
      log.warn(`[AgentInfrastructure] Hosted MCP push failed: ${(err as Error).message}`);
    }
  }

  private registerHostMcpServers(workspace: { id: string }, agentDir: string, userDirectoryPaths: string[]): void {
    const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

    const onNotificationClick = this.deps.onNotificationClick;
    const activeNotificationsSet = this._activeNotifications;
    const { containerService } = this.deps;

    const handlers: Record<string, Record<string, (args: any) => Promise<any>>> = {
      activity: {
        query_activity: async (args: any) => {
          const result = queryActivity(args);
          if ('error' in result) return fail(result.error);
          const fileCount = result.file_sessions?.length || 0;
          const header = `Activity from ${result.query.since} to ${result.query.until}\nFile sessions: ${fileCount}\n`;
          return ok(header + '\n' + JSON.stringify(result, null, 2));
        },
      },

      notification: {
        show_notification: async (args: any) => {
          try {
            const notification = new ElectronNotification({ title: args.title, body: args.body });
            activeNotificationsSet.add(notification);

            const release = () => {
              activeNotificationsSet.delete(notification);
            };

            if (onNotificationClick) {
              notification.on('click', () => {
                release();
                if (args.navigation) {
                  const nav = args.navigation;
                  if (nav.type === 'thread' && nav.threadId) {
                    onNotificationClick({ type: 'thread', threadId: nav.threadId, sidebarTab: nav.sidebarTab });
                  } else if (nav.type === 'sidebar' && nav.sidebarTab) {
                    onNotificationClick({ type: 'sidebar', tab: nav.sidebarTab });
                  } else {
                    onNotificationClick(null);
                  }
                } else {
                  onNotificationClick(null);
                }
              });
              notification.on('close', () => release());
            } else {
              release();
            }

            notification.show();
            return ok('Notification shown successfully.');
          } catch (err: any) {
            return fail(`Failed to show notification: ${err.message}`);
          }
        },
      },

      'mini-apps': {
        open_mini_application: async (args: any) => {
          const appDir = path.join(agentDir, '.applications', args.dir_name);
          const exists = await fs.promises.access(appDir).then(() => true, () => false);
          if (!exists) return fail(`Mini-application directory not found: .applications/${args.dir_name}`);
          return ok(`Opened mini-application: ${args.dir_name}`);
        },
        build_and_open_mini_application: async (args: any) => {
          const build = await buildMiniApp(agentDir, args.dir_name);
          if (!build.ok) {
            return fail(`Build failed for ${args.dir_name}:\n${build.error}`);
          }
          return ok(`Built and opened mini-application: ${args.dir_name}`);
        },
        list_published_servers: async () => {
          const { miniAppMcpRegistry } = await import('../miniAppMcpRegistry');
          const servers = miniAppMcpRegistry.list();
          return ok(JSON.stringify(servers, null, 2));
        },
        call_published_tool: async (args: any) => {
          const { miniAppMcpRegistry } = await import('../miniAppMcpRegistry');
          const { server_name, tool_name, arguments: toolArgs } = args ?? {};
          if (typeof server_name !== 'string' || typeof tool_name !== 'string') {
            return fail('server_name and tool_name are required strings.');
          }
          const { result, error } = await miniAppMcpRegistry.invoke(server_name, tool_name, toolArgs ?? {});
          if (error) return fail(error);
          return ok(typeof result === 'string' ? result : JSON.stringify(result));
        },
      },

      knowledge: {
        // Never refuses. `recordFinding` sanitizes rather than rejects (a long
        // title truncates, a missing rule falls back to the title, an unknown
        // `supersedes` id is reported rather than thrown), and the only thing
        // that reaches `fail` here is an actual filesystem error. Losing a
        // correction is the failure mode this whole feature exists to prevent.
        record_finding: async (args: any) => {
          try {
            const result = await recordFinding({
              skill: String(args?.skill ?? ''),
              title: String(args?.title ?? ''),
              rule: String(args?.rule ?? ''),
              evidence: String(args?.evidence ?? ''),
              cost_if_unknown: args?.cost_if_unknown,
              scope: args?.scope,
              supersedes: args?.supersedes,
              confirms: args?.confirms,
              blast_radius: args?.blast_radius,
            });
            // The reply is what the model reads back, so it carries the facts
            // that change what it does next: the id (to cite or supersede
            // later), where the entry landed, and — the useful one — the other
            // places the host found the superseded belief still written down.
            const lines = [
              `Recorded ${result.id} in ${result.file} (${result.entry_count} active finding(s), ${result.ledger_bytes} bytes).`,
            ];
            if (result.skill_created) {
              lines.push(`Created a new findings ledger for skill "${args?.skill}".`);
            }
            if (result.superseded?.length) {
              lines.push(`Superseded and archived: ${result.superseded.join(', ')}.`);
            }
            if (result.supersedes_not_found?.length) {
              lines.push(`No such finding(s), nothing archived: ${result.supersedes_not_found.join(', ')}.`);
            }
            if (result.blast_radius?.length) {
              lines.push(
                'The old belief is still written down here — tell the user, they may want these fixed:\n'
                + result.blast_radius.map((h) => `  - ${h}`).join('\n'),
              );
            }
            log.info(`[Knowledge] ${result.id} recorded in ${result.file}`);
            return ok(lines.join('\n'));
          } catch (err: any) {
            log.error(`[Knowledge] record_finding failed: ${err?.message}`);
            return fail(`Failed to record the finding: ${err.message}`);
          }
        },
      },

      workspace: {
        get_scanned_files: async (args: any) => {
          try {
            const files = args.file_type
              ? getScannedFilesByType(workspace.id, args.file_type)
              : getScannedFiles(workspace.id);

            let refIndex: Record<string, string> = {};
            try {
              const indexPath = path.join(agentDir, REFERENCES_SUBDIR, REFERENCES_INDEX);
              const raw = await fsPromises.readFile(indexPath, 'utf-8');
              refIndex = JSON.parse(raw);
            } catch { /* no index yet */ }

            const cleaned = files.map(({ file_path, file_name, file_type }: { file_path: string; file_name: string; file_type: string }) => ({
              file_path, file_name, file_type,
              ...(file_type === 'reference' && refIndex[file_path]
                ? { markdown_path: `${REFERENCES_SUBDIR}/${refIndex[file_path]}` }
                : {}),
            }));
            return ok(JSON.stringify({ files: cleaned, count: cleaned.length }));
          } catch (err: any) {
            return fail(`Failed to get scanned files: ${err.message}`);
          }
        },

        get_research_profile: async () => {
          try {
            const report = getLatestReport(workspace.id, 'directory_scan');
            if (!report) {
              return ok(JSON.stringify({ about_you: null, working_on: null, status: 'not_started' }));
            }
            if (report.status !== 'completed') {
              return ok(JSON.stringify({ about_you: null, working_on: null, status: report.status }));
            }
            let aboutYou: string | null = null;
            let workingOn: string | null = null;
            try {
              const parsed = JSON.parse(report.report_data);
              aboutYou = parsed.about_you ?? null;
              workingOn = parsed.working_on ?? null;
            } catch { /* ignore */ }
            if (!aboutYou || !workingOn) {
              const memoryDir = path.join(agentDir, AGENT_MEMORY_SUBDIR);
              if (!aboutYou) {
                try { aboutYou = await fs.promises.readFile(path.join(memoryDir, 'about_you.md'), 'utf-8'); } catch { /* not available */ }
              }
              if (!workingOn) {
                try { workingOn = await fs.promises.readFile(path.join(memoryDir, 'working_on.md'), 'utf-8'); } catch { /* not available */ }
              }
            }
            return ok(JSON.stringify({ about_you: aboutYou, working_on: workingOn, status: report.status }));
          } catch (err: any) {
            return fail(`Failed to get research profile: ${err.message}`);
          }
        },
      },

      apis: {
        // Reads live store state, so it answers correctly for an API the user
        // added after this session's guidance block was built. Uses `listApis`
        // — the MASKED accessor — not `listApisWithSecrets`: this string goes
        // straight into the model's context.
        list_apis: async () => {
          try {
            if (!apiProxy.isRunning()) {
              return ok(JSON.stringify({
                available: false,
                reason: apiProxy.error()
                  ? `The API proxy could not start: ${apiProxy.error()}`
                  : 'The API proxy is not running.',
                apis: [],
              }));
            }
            const apis = listApis().map((a) => ({
              id: a.id,
              label: a.label,
              base_url: a.baseUrl,
              enabled: a.enabled,
              access: a.allowWrites ? 'read & write' : 'read only',
              allowed_hosts: effectiveAllowedHosts(a),
              auth: describeAuthStyle(a.auth),
              credential_configured: a.hasSecret,
              notes: a.notes ?? null,
              docs_url: a.docsUrl ?? null,
            }));
            return ok(JSON.stringify({
              available: true,
              how_to_call: `curl -sH "${API_PROXY_TOKEN_HEADER}: $${API_TOKEN_ENV}" `
                + `"$${API_BASE_ENV}/<api-id>/<path>"`,
              apis,
            }));
          } catch (err: any) {
            return fail(`Failed to list APIs: ${err.message}`);
          }
        },
      },

      // Read-only access to the user's OTHER chats in this workspace — the
      // Devin-style "paste a link to another conversation" flow. Rendering
      // logic lives in `main/chatReference.ts`; these two handlers are just
      // the workspace-scoping boundary (a chat id resolved to a session in a
      // DIFFERENT workspace must read as nonexistent, never leak).
      chats: {
        list_chats: async (args: any) => {
          try {
            // Never fails (no chat named by the caller to be wrong about) —
            // unlike read_chat there is no error branch to type against.
            const result = listChatsForAgent(workspace.id, args);
            return ok(result.text);
          } catch (err: any) {
            return fail(`Failed to list chats: ${err.message}`);
          }
        },
        read_chat: async (args: any) => {
          try {
            const result = readChatForAgent(workspace.id, args);
            return result.ok ? ok(result.text) : fail(result.error);
          } catch (err: any) {
            return fail(`Failed to read chat: ${err.message}`);
          }
        },
      },
    };

    (globalThis as any).__hostMcpServers = handlers;
    log.info(`[MCP] Registered host MCP handlers: ${Object.keys(handlers).join(', ')}`);
  }

  async start(workspacePath: string): Promise<void> {
    const activeWorkspace = this.deps.workspaceController.activeWorkspace;
    if (!activeWorkspace) return;

    try {
      await this.deps.refreshCredentials();
    } catch (err) {
      log.warn('[AgentInfrastructure] Credential refresh failed, using stored key:', err);
    }

    void migrateMissingManifests(workspacePath);

    // THE RECONCILE GATE. Awaited, the way containerService.start() awaits
    // prewarmLoginShellPath(), and for a sharper reason: the store reconciler
    // copies skill directories and the renderer relinks
    // `<workspace>/.claude/skills`, both under the CLI's feet. Start the agent
    // server first and a turn can read a half-copied SKILL.md, at which point
    // the CLI logs "Failed to load skill" to its own stderr and silently omits
    // it — one chat missing one skill, gone by the next boot, unreproducible.
    // Idempotent and serialised, so the boot call and this one do not race.
    await provisionWorkspace(workspacePath);

    await this.deps.containerService.ensureAgentFilesInWorkspace(workspacePath);

    // BEFORE the agent server is spawned, and that ordering is load-bearing:
    // `buildSubprocessEnv()` only exports ACABOX_API_BASE/TOKEN when the proxy
    // is already listening, and the agent server inherits its env once at
    // spawn. Start it after, and every subprocess for the life of that server
    // has no way to reach the proxy — with no error anywhere, just an agent
    // that reports the variable is empty.
    //
    // Awaited, but it cannot throw: a proxy that fails to bind records the
    // reason and leaves `isRunning()` false, which the env block, the guidance
    // builder and `list_apis` all already handle.
    await apiProxy.start();

    // mcpHost.startAll() (docs/design/mcp-hosting.md, Increment 2 / R10):
    // spawns every enabled+autostart hosted MCP server. Same slot as
    // apiProxy.start() above it — after the proxy, before the agent server
    // — but NOT for the same reason: apiProxy has to be up before the agent
    // server inherits its env at spawn, a one-shot dependency. mcpHost has
    // no such dependency on either neighbour; it only needs to be started
    // reasonably early, and here keeps it next to the app's other
    // renderer-triggered infrastructure boot rather than inventing a new
    // hook elsewhere.
    //
    // NOT awaited for readiness — `startAll()`'s own contract (see its
    // module comment) is that it returns as soon as spawns are issued, with
    // readiness arriving later via `onInventoryChanged`. A slow or hung
    // hosted server must never hold a chat turn hostage the way a missing
    // API key or a down proxy legitimately would. It is also single-flight
    // (R10): this method has two call sites (`main/index.ts`, a renderer
    // reload re-enters it), so a second concurrent call returns the same
    // in-flight promise rather than issuing a second spawn wave.
    //
    // `startAll()` is documented never to throw (a failure is recorded in
    // `mcpHost`'s own `lastStartAllErrorMessage()` and logged there) — the
    // `.catch` below is a second line of defense, not reliance on that
    // contract: a defect in it must not be able to take the rest of boot
    // down with it.
    void mcpHost.startAll().catch((err) => {
      log.error(`[AgentInfrastructure] mcpHost.startAll() rejected unexpectedly: ${(err as Error).message}`);
    });

    this.registerHostMcpServers(activeWorkspace, workspacePath, this.deps.workspaceController.userDirectoryPaths);

    const { apiKey: agentApiKey, baseURL: agentBaseURL } = getCredentials();
    // User-configured MCP connectors (Settings → Connectors). Host-owned, in
    // userData, so the agent can't provision one for itself.
    // Decrypted view: this config is what the agent server hands to the SDK,
    // so auth headers have to be real. The masked `listConnectors()` is for
    // IPC/UI only.
    const connectors = listConnectorsWithSecrets();
    const connectorServers = buildMcpServers(connectors);
    const connectorTools = connectorAllowedTools(connectors);
    if (connectorTools.length) {
      log.info(`[AgentInfrastructure] Connectors enabled: ${Object.keys(connectorServers).join(', ')}`);
    }
    // Which skills go on the roster. The enabled subset of the store, plus the
    // one bundled SDK skill Acabox keeps (`claude-api`). This is the roster
    // budget allocator — a skill left off keeps its bytes and its symlink and
    // is still readable, it just stops costing roster characters.
    const skills = buildSkillRuntimeConfig(await readSkillsState());
    log.info(`[AgentInfrastructure] Skill roster: ${skills.length} skill(s) — ${skills.join(', ')}`);

    // Hosted MCP servers (docs/design/mcp-hosting.md, Increment 4). Usually
    // EMPTY here: `mcpHost.startAll()` above is deliberately not awaited, so
    // by this point nothing has had time to become ready — that is not a bug
    // to fix by awaiting it (see the comment on that call), it is the whole
    // reason the constructor wires an ongoing push (`onInventoryChanged` /
    // `onAgentServerRestarted`) that delivers a server's tools live, the
    // moment it IS ready, without needing a new session. Read fresh here
    // anyway for the warm-start case: a second `start()` call (a renderer
    // reload re-enters it) can find servers already `ready` from the first.
    const hostedInventory: Record<string, HostedServerPush> = await mcpHost.readyServersForAgent();
    const hostedIds = Object.keys(hostedInventory);
    if (hostedIds.length) {
      log.info(`[AgentInfrastructure] Hosted MCP servers ready at boot: ${hostedIds.join(', ')}`);
    }

    const agentConfig = {
      port: 8080,
      mcpServers: connectorServers,
      hostedServers: hostedInventory,
      anthropicApiKey: agentApiKey ?? '',
      ...(agentBaseURL ? { anthropicBaseURL: agentBaseURL } : {}),
      model: DEFAULT_MODEL,
      // Default thinking level; per-turn overrides come from the chat UI via
      // the session-create override (see mergeSessionConfig).
      effort: 'high',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Built by the one shared function so this and containerService's
      // crash-restart config cannot drift — see shared/agentAllowedTools.ts.
      // `mcp__<id>` auto-approves every tool on a user connector AND every
      // hosted MCP server — the two share one id namespace (enforced at save
      // time by connectorsStore.upsertConnector / mcpHost.save), so their ids
      // are unioned into the same array here rather than computed as two
      // lists `replaceConnectorAllowedTools` would have to reconcile later.
      allowedTools: buildAgentAllowedTools([...connectorTools, ...hostedIds.map((id) => `mcp__${id}`)]),
      skills,
      // 'project' loads CLAUDE.md — required. It also makes the SDK read a
      // project `.mcp.json`, which the agent can write, so Settings surfaces
      // any such file via detectUnmanagedMcpJson rather than leaving it
      // invisible. Connectors themselves come from `mcpServers` above.
      settingSources: ['project'],
    };

    await this.deps.containerService.startAgentServer(JSON.stringify(agentConfig, null, 2), workspacePath);

    // Redundant on a cold start (the config we just handed it carries the same
    // array) and load-bearing on a warm one: `startAgentServer` returns early
    // when a healthy server is already up, so without this a roster computed
    // from a store that changed since that server booted would sit in the
    // restart config only — and a crash would be the first thing to apply it.
    await this.deps.containerService.updateAgentSkills(skills);

    // Same "redundant on cold start, load-bearing on warm one" reasoning,
    // applied to hosted MCP servers: on a warm `start()` this catches a
    // server that became ready between an earlier `start()` call and this
    // one, which the boot `agentConfig.hostedServers` above could not have
    // known about.
    await this.deps.containerService.updateAgentHosted(hostedInventory);

    // Bootstrap the Python venv in the background so the agent's install
    // wrapper has a `pip` to call when it first encounters a Python
    // dependency. Best-effort: if the user has no system Python the agent
    // can still operate without Python tooling.
    void ensurePythonVenv().catch((err) => {
      log.warn(`[AgentInfrastructure] Python venv bootstrap deferred: ${(err as Error).message}`);
    });
  }

  async stop(): Promise<void> {
    await this.deps.containerService.stopAgentServer();
    await apiProxy.stop();
    (globalThis as any).__hostMcpServers = null;
  }
}

/**
 * TODO: Remove this migration once most workspaces have been migrated past
 * this version. Added: 2026-05-05. Safe to remove after ~2026-08-05.
 *
 * Every mini-app must have a manifest.json describing its name, description,
 * icon (Lucide name), and lastOpened timestamp — the Tools page reads this to
 * render each app and order by recency. Apps created before this change don't
 * have one. On startup we scan .applications/* for missing manifests and
 * launch a background job per app that asks Claude to generate the metadata
 * from the app's source. Failures are logged and retried on next startup.
 */
async function migrateMissingManifests(agentDir: string): Promise<void> {
  const appsDir = path.join(agentDir, '.applications');

  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(appsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const missing: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const manifestPath = path.join(appsDir, entry.name, 'manifest.json');
    try {
      await fsPromises.access(manifestPath);
    } catch {
      missing.push(entry.name);
    }
  }

  if (missing.length === 0) return;
  log.info(`[ManifestMigration] Generating manifests for ${missing.length} apps: ${missing.join(', ')}`);

  for (const dirName of missing) {
    try {
      await generateManifestForApp(agentDir, dirName);
    } catch (err) {
      log.warn(`[ManifestMigration] Failed for ${dirName}: ${(err as Error).message ?? err}`);
    }
  }
}

async function generateManifestForApp(agentDir: string, dirName: string): Promise<void> {
  const appDir = path.join(agentDir, '.applications', dirName);
  const manifestPath = path.join(appDir, 'manifest.json');

  try {
    await fsPromises.access(manifestPath);
    return;
  } catch { /* keep going */ }

  const { apiKey: manifestApiKey, baseURL: manifestBaseURL } = getCredentials();
  if (!manifestApiKey) {
    log.warn(`[ManifestMigration] No API key — skipping ${dirName}`);
    return;
  }

  let appSource = '';
  try {
    appSource = await fsPromises.readFile(path.join(appDir, 'src', 'App.tsx'), 'utf-8');
  } catch { /* fall back to dir name */ }
  if (appSource.length > 8000) appSource = appSource.slice(0, 8000);

  const client = new Anthropic({ apiKey: manifestApiKey, baseURL: manifestBaseURL });
  const message = await client.messages.create({
    ...BACKGROUND_REQUEST,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `You are generating manifest.json metadata for a mini-app. Return only JSON with these fields:
- name: short user-visible title (≤ 40 chars)
- description: one-sentence summary of what the app does (≤ 80 chars)
- icon: a Lucide icon name in PascalCase (e.g. FlaskConical, LineChart, Microscope, Dna, Beaker, Image, Table, BarChart3) that visually fits

Directory name: ${dirName}

App source (truncated):
${appSource || '(no App.tsx found — infer from the directory name)'}

Output JSON only. No prose, no code fences.`,
    }],
  });

  const text = messageText(message);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in model response');

  const parsed = JSON.parse(jsonMatch[0]) as { name?: unknown; description?: unknown; icon?: unknown };
  const fallbackName = dirName.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const manifest = {
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : fallbackName,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    icon: typeof parsed.icon === 'string' && parsed.icon.trim() ? parsed.icon : 'LayoutGrid',
    lastOpened: null,
  };

  // Merge under the generated fields: anything another writer minted since
  // the missing-manifest check (tool_id, open_count, …) wins over defaults.
  await updateManifest(manifestPath, (m) => ({ ...manifest, ...m }));
  log.info(`[ManifestMigration] Wrote manifest for ${dirName}: ${manifest.name} / ${manifest.icon}`);
}

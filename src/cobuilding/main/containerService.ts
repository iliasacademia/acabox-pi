/**
 * Host process service — replaces the previous Podman-based containerService.
 *
 * The agent server, kernel gateway, and any agent tool invocations all run
 * directly as host child processes. The public surface stays the same as the
 * old `containerService` singleton so call sites elsewhere keep working
 * without modification.
 */

import { getBundledBinDir } from './bundledBin';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import log from 'electron-log';
import { commandLogger, parseAppDirFromArgs, type CommandSource } from './commandLogger';
import { captureError } from '../shared/telemetry';
import { ensurePythonVenv, getVenvDir as getPythonVenvDir } from './pythonSetup';
import { getNpmPrefix, getNpmNodeModulesPath } from './nodeSetup';
import { getLoginShellPath, prewarmLoginShellPath } from './shellPath';
import { getClaudeConfigDir, migrateClaudeConfigDir } from './claudeConfigDir';
import { findFreePort, isPortBindable, LOOPBACK } from './freePort';
import { replaceConnectorAllowedTools } from '../shared/connectors';
import type { HostedServerPush } from '../shared/hostedMcp';
import { API_BASE_ENV, API_TOKEN_ENV } from '../shared/apis';
import { apiProxy, type ProxyCallerRef } from './apiProxy';
import { withErrorDetails } from '../shared/errorDetails';

/** Headline for a notebook whose Python session would not come up; the raw cause rides along as Details. */
const KERNEL_START_FAILED =
  "Acabox couldn't start Python for this notebook. Quit and reopen Acabox; if it still fails, the details may help.";


const execFileAsync = promisify(execFile);

// Port probing lives in ./freePort so it can be unit-tested without electron.

/**
 * Where the agent server's start config is written.
 *
 * userData, NOT the workspace: this file holds the raw Anthropic API key and
 * the decrypted connector auth headers (it is the SDK's own input, so it can't
 * be encrypted the way settings.json is). Leaving it under the agent's cwd
 * would make encrypting settings.json pointless — one `cat` away.
 */
function getAgentConfigPath(): string {
  return path.join(app.getPath('userData'), 'agent.json');
}

/**
 * Delete the pre-2026-07-28 in-workspace copy. Builds before this wrote a live
 * API key to `<workspace>/.academia/agent.json`, so an upgrading install has
 * one sitting there until we remove it.
 */
async function removeLegacyAgentConfig(workspacePath: string): Promise<void> {
  const legacy = path.join(workspacePath, '.academia', 'agent.json');
  try {
    await fs.promises.unlink(legacy);
    log.info(`[HostProcess] Removed legacy ${legacy} (held a plaintext API key inside the workspace)`);
  } catch {
    // Already gone — the normal case after the first run.
  }
}

type ProgressCallback = (stage: string, message: string, percent?: number) => void;

/**
 * Resolve the host Python venv that backs the agent's `python`/`jupyter`
 * invocations. Created on first kernel-gateway start by `ensurePythonVenv`.
 */
function getVenvBin(name: 'python' | 'jupyter' | 'pip'): string {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidate = path.join(getPythonVenvDir(), binDir, `${name}${ext}`);
  if (fs.existsSync(candidate)) return candidate;
  return name;
}

function getAgentServerBundle(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-server.js');
  }
  return path.join(app.getAppPath(), 'dist', 'agent-server.js');
}

/**
 * Build the environment we hand to every host subprocess we spawn (agent
 * server, kernel gateway, esbuild, the agent's Bash tool, the install wrapper,
 * etc). Surfaces the bundled venv + shared npm prefix in three ways:
 *   - COSCIENTIST_VENV_DIR / COSCIENTIST_NPM_PREFIX env vars the install
 *     wrapper reads explicitly
 *   - NODE_PATH so esbuild bundles can resolve modules installed via npm -g
 *   - PATH prepend with the venv bin + npm prefix bin so installed CLIs
 *     (pytest, tsx, etc.) are invocable without a fully-qualified path
 *
 * `caller` decides WHOSE API-proxy token the child gets. It defaults to the
 * chat agent because that is what every path except a mini-app's own
 * `hostAPI.exec()` is; see the API block below for why the distinction is
 * load-bearing rather than tidy.
 */
function buildSubprocessEnv(caller: ProxyCallerRef = { kind: 'chat' }): NodeJS.ProcessEnv {
  const venvDir = getPythonVenvDir();
  const npmPrefix = getNpmPrefix();
  const binSep = process.platform === 'win32' ? ';' : ':';
  const venvBinDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  const npmBinDir = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  // Use the resolved login-shell PATH (Homebrew/nvm/etc.), not the minimal
  // launchd PATH a Finder/Dock launch inherits, so subprocesses can find
  // user-installed npm/node. Warm on a cache hit; see prewarm in start().
  const existingPath = getLoginShellPath();
  return {
    ...process.env,
    COSCIENTIST_VENV_DIR: venvDir,
    COSCIENTIST_NPM_PREFIX: npmPrefix,
    NODE_PATH: getNpmNodeModulesPath(),
    // Bundled rg/fd come first so PI's grep/find find them before trying to download.
    PATH: [getBundledBinDir(), venvBinDir, npmBinDir, existingPath].filter(Boolean).join(binSep),
    // How subprocesses reach configured APIs. Absent when the proxy is down,
    // which is a supported state — `buildApiGuidance` is skipped in the same
    // condition, so the agent is never told about a facility that isn't there.
    //
    // THE TOKEN IS SCOPED TO THE CALLER, and that is the whole point. The chat
    // agent's token reaches every enabled API, which is by design: it already
    // holds the user's Anthropic key and the credentials are safeStorage-
    // encrypted, so the proxy is the only route to a usable secret and the
    // write gate is a real boundary for it.
    //
    // A MINI-APP is a different matter. `hostAPI.exec()` spawns through this
    // same function, so handing every child the chat token let any tool curl
    // the proxy and be served as the agent — reaching APIs the user never
    // granted it, writes included. Passing the caller here is what makes the
    // HTTP door enforce the same grant the postMessage door always did.
    ...(apiProxy.isRunning() ? {
      [API_BASE_ENV]: apiProxy.baseUrl()!,
      [API_TOKEN_ENV]: apiProxy.tokenFor(caller)!,
    } : {}),
  };
}

const NODE_HEAP_MB = 1536;

// Exported (not just the `ContainerService` type alias below) so tests can
// construct a fresh, isolated instance — the module-level singleton is
// shared app-wide and its `agentServerRestartListeners` accumulate for the
// life of the process, which a test suite constructing many instances would
// otherwise leak across cases.
export class HostProcessService {
  private startedFlag = false;
  private isStarting = false;
  private currentAgentDir: string | null = null;

  /** The workspace root the agent server was started in, or null before then. */
  getAgentDir(): string | null {
    return this.currentAgentDir;
  }


  private kernelGatewayProc: ChildProcess | null = null;
  private agentServerProc: ChildProcess | null = null;

  // Identifies agent servers spawned by THIS app run. Echoed by /health so we
  // never adopt another Acabox install's server (or our own orphan from a
  // previous run) just because something answers on the port.
  private readonly instanceToken = randomUUID();

  private agentPort: number | null = null;
  private kernelPort: number | null = null;
  private kernelStartPromise: Promise<void> | null = null;

  private lastAgentServerConfig: string | null = null;
  private lastAgentServerWorkspacePath: string | null = null;
  private lastKernelGatewayError: string | null = null;

  // Crash recovery: when the agent server dies unexpectedly we try to bring
  // it back up. Track recent crash timestamps so an immediate respawn loop
  // gives up rather than spinning forever.
  private agentRestartTimestamps: number[] = [];
  // Set when the supervisor stops restarting; cleared by the next healthy start.
  // Surfaced so the chrome can say OFFLINE and waitForAgent can stop polling.
  private agentGaveUp = false;
  private static readonly MAX_RESTARTS_IN_WINDOW = 3;
  private static readonly RESTART_WINDOW_MS = 60_000;

  // Fired once a crash-restart's own health-poll loop confirms the NEW agent
  // server is up (docs/design/mcp-hosting.md, Increment 4's mandatory guard
  // #2). `mcpHost`'s subscriber (wired in `AgentInfrastructureController`'s
  // constructor) uses this to re-push its LIVE hosted-MCP inventory rather
  // than replaying whatever `lastAgentServerConfig.hostedServers` last
  // remembered — see `onAgentServerRestarted`'s own comment for why that
  // distinction is load-bearing.
  private agentServerRestartListeners = new Set<() => void>();

  async start(mountMap: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>, onProgress?: ProgressCallback): Promise<void> {
    if (this.isStarting) return;
    this.isStarting = true;
    try {
      // Resolve the login-shell PATH off the event loop before start()
      // returns, so the synchronous getLoginShellPath() in buildSubprocessEnv
      // (main thread, reached via agentInfrastructure.start → startAgentServer)
      // is guaranteed a warm cache. Overlapped with the symlink sync since
      // neither depends on the other.
      await Promise.all([
        prewarmLoginShellPath(),
        this.syncWorkspaceSymlinks(mountMap),
      ]);
      onProgress?.('ready', 'Host process service ready', 100);
      this.startedFlag = true;
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Make each user-shared directory visible to the agent under the workspace
   * root via a symlink (e.g. ${workspace}/MyResearch → /Users/x/data/MyResearch).
   * This replaces the bind-mounts the container used to do at /data/<name>, so
   * the agent — whose cwd is the workspace — can address shared directories
   * with relative paths the way the workspace guidance describes.
   *
   * Idempotent: existing correct symlinks are left alone; stale symlinks
   * pointing outside the workspace are removed. Real (non-symlink) entries
   * with the same name are never touched.
   */
  private async syncWorkspaceSymlinks(mountMap: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>): Promise<void> {
    const workspaceEntry = mountMap.find((m) => m.containerPath === '/data');
    if (!workspaceEntry) return;
    const workspacePath = workspaceEntry.hostPath;

    const expected = new Map<string, string>();
    for (const m of mountMap) {
      if (!m.containerPath.startsWith('/data/')) continue;
      const name = m.containerPath.slice('/data/'.length);
      // Only top-level mounts become workspace-level symlinks. The drive
      // cache used to live at /data/google-drive/ — we no longer ship that
      // integration, so skip nested paths.
      if (!name || name.includes('/')) continue;
      expected.set(name, m.hostPath);
    }

    for (const [name, target] of expected) {
      const linkPath = path.join(workspacePath, name);
      try {
        const stats = await fs.promises.lstat(linkPath);
        if (stats.isSymbolicLink()) {
          const existing = await fs.promises.readlink(linkPath);
          if (existing === target) continue;
          await fs.promises.unlink(linkPath);
        } else {
          // Something else (real dir/file) already occupies the name — leave
          // it alone so we don't risk losing user data.
          log.warn(`[HostProcess] ${linkPath} exists and is not a symlink; skipping ${target}`);
          continue;
        }
      } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
          log.warn(`[HostProcess] lstat failed for ${linkPath}: ${err.message}`);
          continue;
        }
      }
      try {
        await fs.promises.symlink(target, linkPath, 'dir');
        log.info(`[HostProcess] Linked ${linkPath} → ${target}`);
      } catch (err) {
        log.warn(`[HostProcess] symlink failed ${linkPath} → ${target}: ${(err as Error).message}`);
      }
    }

    // Reap symlinks that point outside the workspace but no longer correspond
    // to a current user directory. Only touch symlinks; never delete real
    // entries.
    try {
      const entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isSymbolicLink()) continue;
        if (e.name.startsWith('.')) continue;
        if (expected.has(e.name)) continue;
        const linkPath = path.join(workspacePath, e.name);
        let target = '';
        try { target = await fs.promises.readlink(linkPath); } catch { continue; }
        const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(workspacePath, target);
        if (resolvedTarget.startsWith(workspacePath + path.sep) || resolvedTarget === workspacePath) continue;
        try {
          await fs.promises.unlink(linkPath);
          log.info(`[HostProcess] Removed stale workspace symlink ${linkPath}`);
        } catch (err) {
          log.warn(`[HostProcess] Failed to remove stale symlink ${linkPath}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log.warn(`[HostProcess] Symlink cleanup failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.killProc('kernelGatewayProc');
    this.killProc('agentServerProc');
    this.startedFlag = false;
    this.agentGaveUp = false;
    this.currentAgentDir = null;
    this.lastAgentServerConfig = null;
    this.lastAgentServerWorkspacePath = null;
  }

  private killProc(field: 'kernelGatewayProc' | 'agentServerProc'): void {
    const proc = this[field];
    if (!proc) return;
    try {
      proc.kill('SIGTERM');
    } catch { /* already dead */ }
    this[field] = null;
  }

  isRunning(): boolean {
    return this.startedFlag;
  }

  /** The agent server process exists and has not exited. */
  isAgentAlive(): boolean {
    const proc = this.agentServerProc;
    return !!proc && proc.exitCode === null && proc.signalCode === null;
  }

  /** The crash supervisor hit its restart limit and will not try again. */
  hasAgentGivenUp(): boolean {
    return this.agentGaveUp;
  }

  isOverlayEnabled(): boolean {
    return false;
  }

  // ─── Command exec ──────────────────────────────────────────────────

  /**
   * `onSpawn` receives the child's pid as soon as it exists. The job registry
   * uses it to re-adopt work that outlived an app restart — these children are
   * not in the quit teardown path, so they keep running after Acabox exits.
   */
  async exec(
    command: string[],
    options?: { onSpawn?: (pid: number) => void; caller?: ProxyCallerRef },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const [bin, ...args] = command;
    try {
      const pending = execFileAsync(bin, args, {
        cwd: this.currentAgentDir ?? undefined,
        env: this.getExecEnv(options?.caller),
        timeout: 600_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      const pid = (pending as unknown as { child?: { pid?: number } }).child?.pid;
      if (pid !== undefined) {
        try { options?.onSpawn?.(pid); } catch { /* never let a listener break exec */ }
      }
      const { stdout, stderr } = await pending;
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      // A NUMERIC `code` is a real process exit status. A STRING one
      // (ENOENT/EACCES/ENOTDIR) means the process never launched at all — and
      // in that case err.message is the only diagnosis that exists (it names
      // the binary and, inside a packaged build, the asar archive). Dropping it
      // used to turn "the binary isn't there" into a bare `exitCode: 1` that
      // callers rendered as a compiler error. Keep it, and use 127
      // (shell convention for "command not found") so callers can tell the two
      // apart.
      const spawnFailed = typeof err.code !== 'number';
      const stderr: string = err.stderr ?? '';
      const reason = err.killed
        ? `timed out or was killed (signal ${err.signal ?? 'unknown'})`
        : `failed to launch: ${err.message}`;
      return {
        stdout: err.stdout ?? '',
        stderr: spawnFailed && !stderr ? `${bin} ${reason}` : stderr,
        exitCode: spawnFailed ? 127 : err.code,
      };
    }
  }

  execStreaming(command: string[], onLine: (line: string) => void): Promise<{ exitCode: number }> {
    const [bin, ...args] = command;
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: this.currentAgentDir ?? undefined,
        env: this.getExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const handleData = (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      };

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);

      proc.on('close', (code, signal) => {
        if (code === null) {
          log.warn(`[HostProcess] execStreaming killed by signal ${signal}: ${command.join(' ')}`);
          resolve({ exitCode: 1 });
          return;
        }
        resolve({ exitCode: code });
      });

      proc.on('error', (error) => {
        reject(new Error(`exec failed: ${error.message}`));
      });
    });
  }

  async execLogged(
    command: string[],
    meta?: { source?: CommandSource; appDirName?: string | null; onSpawn?: (pid: number) => void },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Only a genuine `source: 'iframe'` call is a mini-app caller.
    //
    // Keying off appDirName alone would be wrong in a way that is easy to miss:
    // the fallback below derives it via `parseAppDirFromArgs`, so the AGENT
    // running `.applications/install pip numpy --app myTool` also carries an
    // appDirName. Treating that as a mini-app would silently downgrade the
    // agent to one tool's grants for that command — a confusing 403 in the
    // middle of an install, and a regression in a path that has nothing to do
    // with APIs. 'build' is likewise ours, not the tool's.
    const caller: ProxyCallerRef = meta?.source === 'iframe' && meta.appDirName
      ? { kind: 'miniapp', dirName: meta.appDirName }
      : { kind: 'chat' };
    const result = await this.exec(command, { onSpawn: meta?.onSpawn, caller });
    commandLogger.log({
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      appDirName: meta?.appDirName ?? parseAppDirFromArgs(command),
      source: meta?.source ?? 'agent',
    });
    return result;
  }

  getAgentPort(): number | null { return this.agentPort; }
  getKernelPort(): number | null { return this.kernelPort; }
  getKernelGatewayUrl(): string | null {
    return this.kernelPort ? `http://localhost:${this.kernelPort}` : null;
  }
  getLastKernelGatewayError(): string | null { return this.lastKernelGatewayError; }

  private getExecEnv(caller?: ProxyCallerRef): NodeJS.ProcessEnv {
    return buildSubprocessEnv(caller);
  }

  // ─── Agent server (host child process) ─────────────────────────────

  async ensureAgentFilesInWorkspace(agentDir: string): Promise<void> {
    const academiaDir = path.join(agentDir, '.academia');
    await fs.promises.mkdir(academiaDir, { recursive: true });
    const dest = path.join(academiaDir, 'agent-server.js');
    const src = getAgentServerBundle();
    try {
      await fs.promises.copyFile(src, dest);
    } catch (err) {
      log.error(`[HostProcess] Failed to copy agent server bundle from ${src} → ${dest}: ${(err as Error).message}`);
      throw err;
    }
  }

  async startAgentServer(configJson: string, agentDir: string): Promise<void> {
    this.lastAgentServerConfig = configJson;
    this.lastAgentServerWorkspacePath = agentDir;
    this.currentAgentDir = agentDir;

    if (!this.agentPort) {
      this.agentPort = await findFreePort(23200, 23299);
    }

    if (await this.isAgentServerHealthy()) {
      log.debug('[HostProcess] Agent server already healthy');
      return;
    }

    await this.stopAgentServer({ preserveCache: true });

    // Our own process is gone but the cached port may since have been taken by
    // something else (commonly the other Acabox install). Spawning onto it
    // would fail to bind, so re-pick rather than start a server that dies.
    if (!(await isPortBindable(this.agentPort))) {
      const previous = this.agentPort;
      this.agentPort = await findFreePort(23200, 23299);
      log.warn(`[HostProcess] Port ${previous} is now taken; moved agent server to ${this.agentPort}`);
    }

    // One-time move of Claude Code's config dir (approved keys, MCP OAuth
    // tokens, transcripts) out of the agent-writable workspace. Must happen
    // before the server starts so it opens the migrated directory.
    migrateClaudeConfigDir(agentDir);
    await fs.promises.mkdir(getClaudeConfigDir(), { recursive: true });

    // The agent config carries the raw Anthropic API key and decrypted
    // connector auth headers — it is the SDK's input, so it cannot be
    // encrypted. It therefore must not live in the workspace, which is the
    // agent's own cwd. The agent server reads it from COSCIENTIST_AGENT_CONFIG
    // (an absolute path), so moving it costs nothing. Written 0600.
    const configPath = getAgentConfigPath();
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, configJson, { encoding: 'utf-8', mode: 0o600 });
    await removeLegacyAgentConfig(agentDir);

    const bundlePath = path.join(agentDir, '.academia', 'agent-server.js');
    // The install wrapper and the agent's Bash tool both inherit these.
    // Setting them here means the agent's subprocesses can find the bundled
    // Python venv and the shared npm prefix without guessing.
    const env = {
      ...buildSubprocessEnv(),
      // Required: spawning process.execPath (Electron) without this flag
      // launches a full Electron runtime in the child. The flag makes
      // Electron behave as a plain Node interpreter, which is what the
      // agent-server bundle expects.
      ELECTRON_RUN_AS_NODE: '1',
      COSCIENTIST_AGENT_PORT: String(this.agentPort),
      COSCIENTIST_AGENT_CONFIG: configPath,
      COSCIENTIST_WORKSPACE: agentDir,
      // Echoed back by /health so we can tell our own server apart from
      // another Acabox install's on the shared 23200-23299 range.
      COSCIENTIST_AGENT_INSTANCE: this.instanceToken,
      // Claude Code's config dir (approved-key list, MCP OAuth tokens, session
      // transcripts). Deliberately in userData, NOT under the workspace: the
      // workspace is the agent's cwd and it has Write + Bash there.
      COSCIENTIST_CLAUDE_CONFIG_DIR: getClaudeConfigDir(),
    };

    const proc = spawn(process.execPath, [
      `--max-old-space-size=${NODE_HEAP_MB}`,
      bundlePath,
    ], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    (proc.stdin as NodeJS.WritableStream | null)?.end();
    this.agentServerProc = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.info(`[AgentServer] ${line}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.error(`[AgentServer] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      log.warn(`[AgentServer] exited (code=${code}, signal=${signal})`);
      if (this.agentServerProc !== proc) return;
      this.agentServerProc = null;
      // Unexpected exit (we didn't call stop): attempt a restart so an
      // OOM or crashed subprocess doesn't strand the renderer's "waiting
      // for agent" spinner. Throttled to avoid a crash-loop.
      const stoppedByUs = code === 0 || signal === 'SIGTERM';
      if (stoppedByUs) return;
      if (!this.lastAgentServerConfig || !this.lastAgentServerWorkspacePath) return;
      const now = Date.now();
      this.agentRestartTimestamps = this.agentRestartTimestamps.filter(
        t => now - t < HostProcessService.RESTART_WINDOW_MS,
      );
      if (this.agentRestartTimestamps.length >= HostProcessService.MAX_RESTARTS_IN_WINDOW) {
        log.error(`[AgentServer] Crashed ${this.agentRestartTimestamps.length} times in ${HostProcessService.RESTART_WINDOW_MS / 1000}s — giving up`);
        this.agentGaveUp = true;
        return;
      }
      this.agentRestartTimestamps.push(now);
      const cfg = this.lastAgentServerConfig;
      const dir = this.lastAgentServerWorkspacePath;
      log.warn('[AgentServer] Restarting after unexpected exit');
      // Restart in a microtask so the exit handler doesn't recurse.
      setImmediate(() => {
        this.startAgentServer(cfg, dir)
          // Only notify once the NEW process is confirmed healthy — firing
          // this before that would tell subscribers "the agent server is
          // back" while it's still spawning, and a hosted-MCP push that
          // lands before the server can answer POST /hosted would just fail
          // silently rather than land on the next successful push.
          .then(() => this.notifyAgentServerRestarted())
          .catch((err) => {
            log.error(`[AgentServer] Restart failed: ${(err as Error).message}`);
          });
      });
    });

    const startTime = Date.now();
    while (Date.now() - startTime < 15_000) {
      if (await this.isAgentServerHealthy(2000)) {
        log.info('[HostProcess] Agent server healthy');
        this.agentGaveUp = false;
        return;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`Agent server exited before becoming healthy (code=${proc.exitCode}, signal=${proc.signalCode})`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    this.killProc('agentServerProc');
    throw new Error('Agent server failed to become healthy within 15s');
  }

  /**
   * Is OUR agent server healthy on the current port?
   *
   * "Ours" is load-bearing. A 200 from /health only proves *some* agent server
   * is listening — and dev and packaged Acabox share the 23200-23299 range on
   * one machine, so it could easily be the other install's. Adopting it means
   * driving the wrong workspace with the wrong API key (observed: a dev
   * instance served chat turns from the packaged app's agent, and its
   * /connectors route 404'd because that build predates it).
   *
   * So the server echoes the instance token we spawned it with, and we only
   * adopt it when the token matches. A stranger's server, or an orphan left by
   * a previous run of this same app, both fail the check and are replaced
   * rather than driven.
   */
  private async isAgentServerHealthy(timeoutMs = 1500): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const req = http.request({
        // Loopback literal, not 'localhost': the latter can resolve to ::1
        // first while the server is bound to 127.0.0.1.
        hostname: LOOPBACK,
        port,
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const mine = body?.instance === this.instanceToken;
            if (!mine) {
              log.warn(
                `[HostProcess] Port ${port} is serving another Acabox instance `
                + `(instance=${body?.instance ?? 'none'}, workspace=${body?.workspace ?? 'unknown'}) — not adopting it.`,
              );
            }
            resolve(mine);
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  async updateAgentCredentials(apiKey: string, baseURL?: string): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      // Field names must match the agent-server's /credentials handler —
      // it reads `anthropicApiKey` / `anthropicBaseURL`. Send baseURL as null
      // (not undefined) when absent so the field survives JSON.stringify and the
      // agent's `'anthropicBaseURL' in body` check clears a previously-set URL.
      const body = JSON.stringify({ anthropicApiKey: apiKey, anthropicBaseURL: baseURL ?? null });
      const req = http.request({
        hostname: LOOPBACK,
        port,
        path: '/credentials',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000,
      }, (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Push the user's MCP connector set to the running agent server. Applies to
   * live sessions immediately, so a connector added in Settings works in the
   * chat the user already has open.
   *
   * `mcpServers` is the SDK-shaped record from
   * `shared/connectors.ts#buildMcpServers`.
   */
  async updateAgentConnectors(mcpServers: Record<string, unknown>): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const body = JSON.stringify({ mcpServers });
      const req = http.request({
        hostname: LOOPBACK,
        port,
        path: '/connectors',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        // Connecting a remote MCP server can involve a network round-trip per
        // server, so allow more than the 2s the credentials push uses.
        timeout: 15000,
      }, (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    }).then((ok) => {
      // Fold the new set into the config we would replay on a crash restart.
      // `lastAgentServerConfig` was only ever written by startAgentServer, so
      // an unexpected exit relaunched the agent server with the connectors as
      // they stood at BOOT — silently deleting every one the user added since,
      // with no log line, no re-push, and Settings still showing them enabled.
      // Only on success: recording a set the server rejected would make the
      // restart config diverge from what is actually running.
      if (ok) this.rememberAgentConnectors(mcpServers);
      return ok;
    });
  }

  /**
   * Push the roster allowlist to the running agent server, so enabling or
   * disabling a skill takes effect without restarting anything.
   *
   * Unlike connectors this cannot reach a session already in flight — `skills`
   * is a `query()` option fixed for the lifetime of the CLI subprocess, and the
   * SDK exposes no setter. It applies to the next session created, which in
   * this app is the next turn (the host destroys the session at every turn
   * end), so the user-visible latency is one message.
   */
  async updateAgentSkills(skills: string[]): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const body = JSON.stringify({ skills });
      const req = http.request({
        hostname: LOOPBACK,
        port,
        path: '/skills',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000,
      }, (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    }).then((ok) => {
      // Same trap as connectors: `lastAgentServerConfig` is only written by
      // startAgentServer, so without this an unexpected exit would relaunch
      // with the roster as it stood at BOOT and silently undo every enable and
      // disable since, with the Knowledge page still showing them applied.
      if (ok) this.rememberAgentSkills(skills);
      return ok;
    });
  }

  /**
   * Subscribe to "the agent server just came back up after an unexpected
   * exit". Fired once the crash-restart's own health-poll loop (inside
   * `startAgentServer`) confirms the NEW process is serving `/health` —
   * never on the app's initial boot start (that call reaches
   * `startAgentServer` directly from `AgentInfrastructureController.start()`,
   * not through this exit handler), and never after a clean, intentional
   * `stop()` (the `stoppedByUs` guard above returns before a restart is even
   * attempted).
   *
   * `mcpHost`'s own subscriber uses this to re-push its LIVE inventory —
   * strictly better than replaying whatever `lastAgentServerConfig
   * .hostedServers` last remembered, because a server that is `failed` at
   * the exact moment of the restart must not be re-registered with the
   * fresh CLI relay just because an earlier snapshot said `ready`
   * (docs/design/mcp-hosting.md, Increment 4's mandatory guard #2).
   */
  onAgentServerRestarted(cb: () => void): () => void {
    this.agentServerRestartListeners.add(cb);
    return () => { this.agentServerRestartListeners.delete(cb); };
  }

  private notifyAgentServerRestarted(): void {
    for (const cb of this.agentServerRestartListeners) {
      try {
        cb();
      } catch (err) {
        // One subscriber's bug must not stop the others from hearing about
        // the restart, the same posture `supervisor.ts`'s onStatusChange
        // takes with its own listener set.
        log.warn(`[HostProcess] onAgentServerRestarted listener threw: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Push the live hosted-MCP inventory to the running agent server (design:
   * `docs/design/mcp-hosting.md`, Increment 4). Modelled on
   * `updateAgentConnectors` immediately below it — same path shape, same
   * never-throws contract (a down agent server during boot/restart is the
   * normal case this exists to tolerate, not an error to propagate), same
   * "fold into the replay config only on success" rule — but a DIFFERENT
   * config field (`hostedServers`, never `mcpServers`): a hosted server is
   * Acabox's own supervised child process, not a connector the CLI
   * subprocess spawns itself, and blurring the two would replay the wrong
   * shape for one of them on the next crash-restart.
   *
   * `hosted` is expected to be the FULL live set — `mcpHost
   * .readyServersForAgent()`'s own shape — never a delta; see
   * `shared/hostedMcp.ts`'s `HostedMcpPushPayload` doc comment for why.
   */
  async updateAgentHosted(hosted: Record<string, HostedServerPush>): Promise<boolean> {
    const port = this.agentPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const body = JSON.stringify({ hosted });
      const req = http.request({
        hostname: LOOPBACK,
        port,
        path: '/hosted',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        // Unlike a connector this never involves a network round-trip — by
        // the time this is called the hosted server is already `ready` (or
        // we are pushing an empty set); the agent server only has to rebuild
        // its in-process relay set, which is local work. Same budget as the
        // skills push below.
        timeout: 5000,
      }, (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    }).then((ok) => {
      // Same trap as connectors and skills: `lastAgentServerConfig` is only
      // written by startAgentServer, so without this a crash-restart would
      // replay the hosted set as it stood at BOOT (usually empty — see
      // AgentInfrastructureController.start()'s own comment on why) and
      // silently undo every server that became ready since, with the
      // Servers page still showing them running.
      if (ok) this.rememberAgentHosted(hosted);
      return ok;
    });
  }

  /**
   * Update the stored restart config in place so a crash-restart preserves
   * the live hosted-MCP set. Mirrors `rememberAgentConnectors` immediately
   * above — including recomputing the `mcp__<id>` auto-approve entries so
   * the replayed config and the running one agree on both halves — applied
   * to the `hostedServers` field instead of `mcpServers`.
   *
   * Without this, an agent-server crash-restart replays the config as it
   * stood at whatever `AgentInfrastructureController.start()` last built —
   * usually zero hosted servers, since `mcpHost.startAll()` is deliberately
   * not awaited there — silently deleting every hosted server that had
   * become ready since, with no log line and the Servers page still showing
   * them running.
   */
  private rememberAgentHosted(hosted: Record<string, HostedServerPush>): void {
    if (!this.lastAgentServerConfig) return;
    try {
      const cfg = JSON.parse(this.lastAgentServerConfig);
      cfg.allowedTools = replaceConnectorAllowedTools(
        cfg.allowedTools ?? [],
        Object.keys(cfg.hostedServers ?? {}),
        Object.keys(hosted),
      );
      cfg.hostedServers = hosted;
      this.lastAgentServerConfig = JSON.stringify(cfg);
    } catch (err) {
      // Never let a bookkeeping failure break a hosted-MCP push that has
      // already been applied to the live server.
      log.warn(`[HostProcess] Could not refresh restart config with hosted servers: ${(err as Error).message}`);
    }
  }

  private rememberAgentSkills(skills: string[]): void {
    if (!this.lastAgentServerConfig) return;
    try {
      const cfg = JSON.parse(this.lastAgentServerConfig);
      cfg.skills = skills;
      this.lastAgentServerConfig = JSON.stringify(cfg);
    } catch (err) {
      log.warn(`[HostProcess] Could not refresh restart config with the new skill roster: ${(err as Error).message}`);
    }
  }

  /**
   * Update the stored restart config in place so a crash-restart preserves the
   * live connector set. Mirrors what the agent server does to its own
   * `currentConfig` on POST /connectors — including recomputing the
   * `mcp__<id>` auto-approve entries, so the replayed config and the running
   * one agree on both halves.
   */
  private rememberAgentConnectors(mcpServers: Record<string, unknown>): void {
    if (!this.lastAgentServerConfig) return;
    try {
      const cfg = JSON.parse(this.lastAgentServerConfig);
      cfg.allowedTools = replaceConnectorAllowedTools(
        cfg.allowedTools ?? [],
        Object.keys(cfg.mcpServers ?? {}),
        Object.keys(mcpServers),
      );
      cfg.mcpServers = mcpServers;
      this.lastAgentServerConfig = JSON.stringify(cfg);
    } catch (err) {
      // Never let a bookkeeping failure break a connector update that has
      // already been applied to the live server.
      log.warn(`[HostProcess] Could not refresh restart config with new connectors: ${(err as Error).message}`);
    }
  }

  /**
   * Ask the agent server for real MCP connection status. Returns `live: false`
   * when no session is running — there is nothing observed to report, and the
   * caller must not substitute a guess.
   */
  async getAgentConnectorStatus(): Promise<{ live: boolean; servers: unknown[] }> {
    const port = this.agentPort;
    if (!port) return { live: false, servers: [] };
    return new Promise((resolve) => {
      const req = http.request({
        hostname: LOOPBACK,
        port,
        path: '/connectors/status',
        method: 'GET',
        timeout: 10000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            // Normalize: an agent server from an older build has no
            // /connectors route and answers `{"error":"Not found"}`, which
            // would otherwise yield `live: undefined` downstream.
            resolve({
              live: parsed?.live === true,
              servers: Array.isArray(parsed?.servers) ? parsed.servers : [],
            });
          } catch {
            resolve({ live: false, servers: [] });
          }
        });
      });
      req.on('error', () => resolve({ live: false, servers: [] }));
      req.on('timeout', () => { req.destroy(); resolve({ live: false, servers: [] }); });
      req.end();
    });
  }

  async stopAgentServer(options?: { preserveCache?: boolean }): Promise<void> {
    this.killProc('agentServerProc');
    if (!options?.preserveCache) {
      this.lastAgentServerConfig = null;
      this.lastAgentServerWorkspacePath = null;
    }
  }

  // ─── Jupyter kernel gateway (host process) ─────────────────────────

  async startKernelGateway(): Promise<void> {
    if (this.kernelStartPromise) return this.kernelStartPromise;
    if (await this.isKernelGatewayHealthy()) {
      this.lastKernelGatewayError = null;
      return;
    }

    this.kernelStartPromise = this._startKernelGateway();
    try {
      await this.kernelStartPromise;
      this.lastKernelGatewayError = null;
    } catch (err) {
      this.lastKernelGatewayError = (err as Error).message;
      throw err;
    } finally {
      this.kernelStartPromise = null;
    }
  }

  private async _startKernelGateway(): Promise<void> {
    await this.stopKernelGateway();

    // Bootstrap the per-app Python venv on first use. Idempotent and fast
    // when already set up. Surfaces a PythonSetupError with installation
    // guidance when the user has no system Python 3.
    await ensurePythonVenv((stage, message) => {
      log.info(`[PythonSetup] ${stage}: ${message}`);
    });

    if (!this.kernelPort) {
      // 23400-23499, disjoint from the original container-era app's host port
      // window (agent 23300-23320, kernel 23330-23350), so both apps running
      // at once don't contend for the same kernel-gateway port.
      this.kernelPort = await findFreePort(23400, 23499);
    }

    const jupyterBin = getVenvBin('jupyter');
    const proc = spawn(jupyterBin, [
      'kernelgateway',
      '--KernelGatewayApp.api=kernel_gateway.jupyter_websocket',
      '--KernelGatewayApp.ip=127.0.0.1',
      `--KernelGatewayApp.port=${this.kernelPort}`,
      '--KernelGatewayApp.allow_origin=*',
      '--KernelGatewayApp.log_level=WARN',
      '--KernelGatewayApp.auth_token=',
      '--ServerApp.token=',
      '--ServerApp.password=',
      '--ServerApp.disable_check_xsrf=True',
    ], {
      env: this.getExecEnv(),
      cwd: this.currentAgentDir ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.kernelGatewayProc = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.info(`[KernelGateway] ${line}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        log.warn(`[KernelGateway] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      log.warn(`[KernelGateway] exited (code=${code}, signal=${signal})`);
      if (this.kernelGatewayProc === proc) this.kernelGatewayProc = null;
    });

    const startTime = Date.now();
    while (Date.now() - startTime < 15_000) {
      if (await this.isKernelGatewayHealthy(2000)) {
        log.info(`[HostProcess] Kernel gateway healthy at http://localhost:${this.kernelPort}`);
        return;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(withErrorDetails(
          KERNEL_START_FAILED,
          `Kernel gateway exited before becoming healthy (code=${proc.exitCode}, signal=${proc.signalCode}). ` +
          `Is jupyter installed in ${getPythonVenvDir()}?`,
        ));
      }
      await new Promise(r => setTimeout(r, 250));
    }

    this.killProc('kernelGatewayProc');
    throw new Error(withErrorDetails(KERNEL_START_FAILED, 'Kernel gateway failed to become healthy within 15s'));
  }

  private async isKernelGatewayHealthy(timeoutMs = 1500): Promise<boolean> {
    const port = this.kernelPort;
    if (!port) return false;
    return new Promise<boolean>((resolve) => {
      const req = http.request({
        hostname: LOOPBACK,
        port,
        path: '/api/kernelspecs',
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  async stopKernelGateway(): Promise<void> {
    this.killProc('kernelGatewayProc');
  }

  // ─── Workspace-rooted file write (used by agent-side academiaFile IPC) ─

  async writeContentToContainer(content: string, targetPath: string): Promise<void> {
    const dest = path.isAbsolute(targetPath)
      ? targetPath
      : path.join(this.currentAgentDir ?? app.getPath('userData'), targetPath);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, content, 'utf-8');
  }

  async ensureSetup(_onProgress?: ProgressCallback, _workspacePath?: string): Promise<void> {
    // No container to set up — process service is always ready.
    this.startedFlag = true;
  }
}

export const containerService = new HostProcessService();
export type ContainerService = HostProcessService;

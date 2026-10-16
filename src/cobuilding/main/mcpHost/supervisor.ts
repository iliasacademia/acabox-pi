import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildHostedEnv, lastHostedPathResolution } from './hostedEnv';
import { killTree, pidSignatureOf } from './processTree';
import { recordSpawn, clearSpawn, hostedServerDir } from './store';
import { ServerCallQueue } from './callQueue';
import { diagnose } from './diagnose';
import type { HostedMcpRecord, HostedRunState, HostedStatus, HostedToolDescriptor } from '../../shared/hostedMcp';
import { PRODUCT_NAME } from '../../shared/product';

/**
 * The supervisor: spawn, readiness, health, restart policy, and teardown for
 * hosted MCP servers (design: `docs/design/mcp-hosting.md`, Increment 2, and
 * annotations R5/R6/R8/R10/R12). One long-lived `Client` per child, connected
 * once via `StdioClientTransport` — never the per-turn CLI subprocess model
 * this replaces.
 *
 * This module owns RUNTIME state only (in-memory `Handle`s below). Persisted
 * config is `store.ts`'s job; the façade in `index.ts` is what reads the
 * store and hands records to `startServer`/`restartServer` here. The two
 * exceptions, both explicitly assigned to "the supervisor" by `store.ts`'s
 * own docstrings: `recordSpawn`/`clearSpawn`, the R5 pid-signature
 * bookkeeping this module calls directly after a spawn / on a clean stop.
 *
 * A finding worth recording for whoever touches this next: **the MCP SDK's
 * `StdioClientTransport` does not expose the child's exit code or signal at
 * all** — `onclose` is a bare, zero-argument callback (verified against the
 * shipped SDK: `_process.on('close', _code => { this._process = undefined;
 * this.onclose?.(); })` discards `_code` before it ever reaches a caller).
 * Without it, `diagnose()`'s exit-127 and "exited immediately, said nothing"
 * cases — the ones R8 names explicitly — could never fire from a REAL crash,
 * only from a hand-built test input. `captureExitInfo` below reaches into
 * `transport`'s TypeScript-private (but JS-public) `_process` field to
 * recover it, wrapped in a try/catch specifically because that field is not
 * part of the SDK's contract and a future version could rename or remove it
 * — if that happens this degrades silently to "no exit code", which is
 * exactly where things stood before this existed, not a crash.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export interface SupervisorTuning {
  /** `initialize` + `tools/list` must return within this long by default. */
  READINESS_DEFAULT_MS: number;
  /** Hard ceiling a per-record `readinessTimeoutMs` is clamped to. */
  READINESS_MAX_MS: number;
  /** How often a ready server is pinged, once ping support is confirmed. */
  PING_INTERVAL_MS: number;
  /** Deadline for a single ping. */
  PING_TIMEOUT_MS: number;
  /** Consecutive ping failures before the server is treated as crashed. */
  PING_FAILURE_THRESHOLD: number;
  /** First restart delay. */
  BACKOFF_INITIAL_MS: number;
  /** Backoff ceiling. */
  BACKOFF_MAX_MS: number;
  /** Consecutive failures before giving up and reporting `failed`. */
  BACKOFF_MAX_ATTEMPTS: number;
  /** Extra randomized delay layered on top of the exponential base, as a fraction of it — a floor, never a reduction. */
  BACKOFF_JITTER_FRACTION: number;
  /** Continuous time in `ready` before the backoff counter resets to 0 — the explicit fix for `containerService.ts`'s never-cleared `agentRestartTimestamps`. */
  HEALTHY_RESET_MS: number;
  /** SIGTERM→SIGKILL grace window for a deliberate stop. */
  STOP_GRACE_MS: number;
  /** Stderr ring buffer size, per server. */
  STDERR_RING_MAX_CHARS: number;
}

const DEFAULT_TUNING: SupervisorTuning = {
  READINESS_DEFAULT_MS: 20_000,
  READINESS_MAX_MS: 60_000,
  PING_INTERVAL_MS: 30_000,
  PING_TIMEOUT_MS: 5_000,
  PING_FAILURE_THRESHOLD: 2,
  BACKOFF_INITIAL_MS: 1_000,
  BACKOFF_MAX_MS: 30_000,
  BACKOFF_MAX_ATTEMPTS: 6,
  BACKOFF_JITTER_FRACTION: 0.3,
  HEALTHY_RESET_MS: 60_000,
  STOP_GRACE_MS: 3_000,
  STDERR_RING_MAX_CHARS: 8192,
};

let tuning: SupervisorTuning = { ...DEFAULT_TUNING };

/** Test seam — production code never calls this. */
export function __setSupervisorTuningForTests(overrides: Partial<SupervisorTuning>): void {
  tuning = { ...tuning, ...overrides };
}

/** Test seam — production code never calls this. */
export function __resetSupervisorTuningForTests(): void {
  tuning = { ...DEFAULT_TUNING };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * What we asked this process to be doing, checked FIRST in the exit handler
 * — never inferred from a signal. `containerService.ts:520` infers "we
 * stopped it" from `signal === 'SIGTERM'`, which is wrong: a real crash (OOM
 * killer, a parent script) can also surface as SIGTERM. `probe` is reserved
 * for a future one-shot "spawn, read tools/list, register disabled" flow
 * (Increment 6) — nothing in this pass sets it, but exit handling already
 * knows what it should mean (no restart, same as `stopped`) so that a future
 * caller only has to set the field.
 */
type Intent = 'running' | 'paused' | 'stopped' | 'probe';

interface Attempt {
  generation: number;
  settled: boolean;
}

interface Handle {
  id: string;
  /**
   * Always assigned before use — every code path that creates a `Handle`
   * (`startServer`/`restartServer`) sets this in the same synchronous call
   * that creates it. Typed non-optional so every OTHER function in this file
   * can read `handle.record.*` without a null check; there is no path that
   * reads it before that assignment.
   */
  record: HostedMcpRecord;
  client: Client | null;
  transport: StdioClientTransport | null;
  state: HostedRunState;
  /**
   * The last state `notify()` wrote a log line for. Purely an
   * observability latch — `notify()` also fires for same-state updates (a
   * refreshed inventory, a pid landing), and without this every one of those
   * would repeat a line that says nothing new.
   */
  loggedState?: HostedRunState;
  pid?: number;
  startedAt?: number;
  /** Plain-language, from `diagnose.ts`. Set only while `state === 'failed'` or mid-backoff; cleared on a fresh successful readiness. */
  error?: string;
  tools: HostedToolDescriptor[];
  /** True once this handle has EVER reached `ready` — distinguishes "0 tools, genuinely" from "never read". */
  everReady: boolean;
  /** Consecutive failures since the last healthy-reset. Drives backoff + the `failed` threshold. */
  restartCount: number;
  intent: Intent;
  /** Detected once at readiness (R6/health design) — null means "not yet determined". A server that errors on ping is downgraded to exit-only health, never restart-looped over a ping it was never going to answer. */
  pingSupported: boolean | null;
  pingFailures: number;
  pingTimer: ReturnType<typeof setInterval> | null;
  healthyResetTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stderrRing: RingBuffer;
  /** The most recent parse/transport error `onerror` observed THIS attempt — see the module comment on why a framing-corruption event does not by itself mean the call failed, but is still worth remembering as a diagnostic fallback if the process then does exit. */
  lastTransportError?: Error;
  queue: ServerCallQueue;
  generation: number;
  currentAttempt: Attempt | null;
  attemptStartedAt?: number;
  /** Serializes concurrent `stopServer`/`pauseServer` calls against the same id — see `stopServer`'s comment. */
  stopInFlight?: Promise<void>;
}

const handles = new Map<string, Handle>();
const changeListeners = new Set<(status: HostedStatus) => void>();

/** A last-~8KB tail buffer. Character-based rather than exactly byte-exact — this is a diagnostic tail, not a transport, so approximate trimming is fine. */
class RingBuffer {
  private buf = '';
  constructor(private readonly maxChars: number) {}
  append(chunk: Buffer | string): void {
    this.buf += chunk.toString();
    if (this.buf.length > this.maxChars) this.buf = this.buf.slice(this.buf.length - this.maxChars);
  }
  tail(): string { return this.buf; }
  clear(): void { this.buf = ''; }
}

function getOrCreateHandle(id: string): Handle {
  let h = handles.get(id);
  if (!h) {
    h = {
      id,
      record: undefined as unknown as HostedMcpRecord, // set by the caller (startServer/restartServer) immediately after this returns
      client: null,
      transport: null,
      state: 'stopped',
      tools: [],
      everReady: false,
      restartCount: 0,
      intent: 'stopped',
      pingSupported: null,
      pingFailures: 0,
      pingTimer: null,
      healthyResetTimer: null,
      restartTimer: null,
      stderrRing: new RingBuffer(tuning.STDERR_RING_MAX_CHARS),
      queue: new ServerCallQueue(id, { concurrency: 1 }),
      generation: 0,
      currentAttempt: null,
    };
    handles.set(id, h);
  }
  return h;
}

function toStatus(handle: Handle): HostedStatus {
  return {
    id: handle.id,
    state: handle.state,
    pid: handle.pid,
    startedAt: handle.startedAt,
    error: handle.error,
    toolCount: handle.everReady ? handle.tools.length : undefined,
    restartCount: handle.restartCount,
  };
}

/**
 * One line per real state transition, on a stable `[McpHostSupervisor]`
 * prefix.
 *
 * It lives in `notify()` — the single funnel every status change already
 * passes through — rather than at each transition site, because scattered log
 * calls are exactly how a subsystem ends up with five of its six states
 * audible and nobody noticing which one is missing.
 *
 * Added after running the real thing: every log call in `main/mcpHost/` was on
 * a FAILURE path, so a healthy `starting → ready → stopped` produced **zero**
 * lines in `cobuilding.log`. Measured on a real session that spawned a server,
 * served two chat turns from it and shut it down at quit: `grep -ci mcphost`
 * returned **0**. That also made `docs/design/mcp-hosting.md`'s own acceptance
 * test — "grep the log for a stable `[McpHost]` prefix on every state
 * transition" — impossible to carry out as written.
 *
 * `info`, not `debug`: the app ships with debug suppressed, and "which local
 * processes did Acabox start on my machine, and when did they die" is a
 * question the default log has to be able to answer.
 */
function logTransition(handle: Handle): void {
  if (handle.loggedState === handle.state) return;
  handle.loggedState = handle.state;

  const detail: string[] = [];
  if (handle.pid !== undefined && (handle.state === 'starting' || handle.state === 'ready')) {
    detail.push(`pid=${handle.pid}`);
  }
  if (handle.state === 'ready') detail.push(`tools=${handle.tools.length}`);
  if (handle.restartCount > 0) detail.push(`restarts=${handle.restartCount}`);
  // Only on the states that actually carry one — `error` lingers on the handle
  // through a backoff, and repeating it on an unrelated transition would
  // misattribute a stale failure to the state we are entering now.
  if (handle.error && (handle.state === 'failed' || handle.state === 'restarting')) {
    detail.push(`error=${handle.error}`);
  }

  const suffix = detail.length ? ` (${detail.join(', ')})` : '';
  log.info(`[McpHostSupervisor] "${handle.id}" → ${handle.state}${suffix}`);
}

function notify(handle: Handle): void {
  logTransition(handle);
  const status = toStatus(handle);
  for (const l of changeListeners) {
    try { l(status); } catch (err) { log.warn(`[McpHostSupervisor] onStatusChange listener threw: ${(err as Error).message}`); }
  }
}

/** Subscribe to every status change for every server. Returns an unsubscribe function. */
export function onStatusChange(cb: (status: HostedStatus) => void): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

function isCurrentAttempt(handle: Handle, attempt: Attempt): boolean {
  return handle.currentAttempt === attempt && !attempt.settled;
}

function clearPingTimer(handle: Handle): void {
  if (handle.pingTimer) { clearInterval(handle.pingTimer); handle.pingTimer = null; }
}
function clearHealthyResetTimer(handle: Handle): void {
  if (handle.healthyResetTimer) { clearTimeout(handle.healthyResetTimer); handle.healthyResetTimer = null; }
}
function clearHealthTimers(handle: Handle): void {
  clearPingTimer(handle);
  clearHealthyResetTimer(handle);
}
function clearRestartTimer(handle: Handle): void {
  if (handle.restartTimer) { clearTimeout(handle.restartTimer); handle.restartTimer = null; }
}

async function clearSpawnSafely(id: string): Promise<void> {
  try { await clearSpawn(id); } catch (err) { log.warn(`[McpHostSupervisor] clearSpawn(${id}) failed: ${(err as Error).message}`); }
}

class DeadlineError extends Error {}
function isDeadlineError(err: unknown): boolean { return err instanceof DeadlineError; }

/** Race `promise` against a timer. On timeout, `promise` itself is left to settle on its own (there is nothing generic to cancel it with) — the caller decides what "on timeout" means for whatever real resource `promise` was doing. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(`Timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function clampReadiness(overrideMs: number | undefined): number {
  if (overrideMs == null || !Number.isFinite(overrideMs)) return tuning.READINESS_DEFAULT_MS;
  return Math.max(1000, Math.min(tuning.READINESS_MAX_MS, overrideMs));
}

/**
 * Jittered exponential backoff. `n` is the 1-indexed consecutive-failure
 * count (the delay BEFORE the n-th retry, i.e. after n failures so far).
 * Deliberately floors rather than centers the jitter — `base` alone is
 * already the non-decreasing schedule callers can assert against; jitter
 * only ever adds on top, which is what keeps the sequence monotonically
 * non-decreasing even in the worst case (the previous attempt's maximum
 * jitter vs. this attempt's minimum) as long as the base at least doubles,
 * which it does up to the cap.
 */
function backoffDelay(n: number): number {
  const base = Math.min(tuning.BACKOFF_MAX_MS, tuning.BACKOFF_INITIAL_MS * Math.pow(2, Math.max(0, n - 1)));
  const jitter = base * tuning.BACKOFF_JITTER_FRACTION * Math.random();
  return Math.round(base + jitter);
}

/**
 * Reach into the transport's private `_process` to capture the real exit
 * code/signal — see the module header comment for why this exists and why
 * it is safe to fail silently. Must be called synchronously, right after
 * `client.connect(transport)` is CALLED (not awaited) — per the S5 spike,
 * that is the instant `_process` exists.
 */
function captureExitInfo(transport: StdioClientTransport, onExit: (code: number | null, signal: NodeJS.Signals | null) => void): void {
  try {
    const raw = (transport as unknown as { _process?: { on?: (event: string, cb: (...args: unknown[]) => void) => void } })._process;
    raw?.on?.('exit', (code: unknown, signal: unknown) => {
      onExit((code as number | null) ?? null, (signal as NodeJS.Signals | null) ?? null);
    });
  } catch (err) {
    log.warn(`[McpHostSupervisor] Could not attach exit-code capture (SDK internals may have changed): ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Spawn / readiness / health / restart
// ---------------------------------------------------------------------------

function spawnAttempt(handle: Handle): void {
  clearRestartTimer(handle);
  const generation = ++handle.generation;
  const attempt: Attempt = { generation, settled: false };
  handle.currentAttempt = attempt;
  handle.state = 'starting';
  handle.error = undefined;
  handle.pid = undefined;
  handle.lastTransportError = undefined;
  handle.stderrRing.clear();
  handle.attemptStartedAt = Date.now();
  notify(handle);

  void runAttempt(handle, attempt);
}

async function runAttempt(handle: Handle, attempt: Attempt): Promise<void> {
  const record = handle.record;
  const usingDefaultCwd = record.entry.cwd == null;
  const cwd = record.entry.cwd ?? hostedServerDir(record.id);
  if (usingDefaultCwd) {
    // Ours to manage — a user/record-supplied cwd that doesn't exist is left
    // to fail loudly at spawn instead, which is a real, diagnosable signal.
    try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* best effort; a real failure surfaces at spawn */ }
  }

  const transport = new StdioClientTransport({
    command: record.entry.command,
    args: record.entry.args,
    cwd,
    env: buildHostedEnv(record),
    stderr: 'pipe',
  });
  const client = new Client({ name: `${PRODUCT_NAME}-mcp-host`, version: '0.0.0' });

  handle.transport = transport;
  handle.client = client;

  transport.stderr?.on('data', (chunk: Buffer) => handle.stderrRing.append(chunk));
  client.onerror = (err: Error) => onTransportError(handle, attempt, err);

  let lastExitCode: number | null = null;
  let lastExitSignal: NodeJS.Signals | null = null;

  const connectPromise = client.connect(transport);
  // Per the S5 spike: populated synchronously the instant connect() is
  // CALLED, not when the promise resolves — so this is safe to read here.
  handle.pid = transport.pid ?? undefined;
  notify(handle); // the pid is real and worth showing even while still "starting"
  if (handle.pid != null) {
    // R5's persisted pointer, written as soon as a REAL pid exists — not
    // gated on reaching `ready`, because a process that hangs before ever
    // answering `initialize` is exactly the kind of orphan a later unclean
    // shutdown would otherwise leave unrecovered. Fire-and-forget: this is a
    // best-effort durability write, not something a spawn should block on.
    const signature = pidSignatureOf(handle.pid);
    if (signature) void recordSpawn(record.id, handle.pid, signature).catch((err) => {
      log.warn(`[McpHostSupervisor] recordSpawn(${record.id}) failed: ${(err as Error).message}`);
    });
  }
  captureExitInfo(transport, (code, signal) => { lastExitCode = code; lastExitSignal = signal; });

  client.onclose = () => onExit(handle, attempt, lastExitCode, lastExitSignal);

  const readinessMs = clampReadiness(record.readinessTimeoutMs);

  try {
    const { tools } = await withDeadline(
      (async () => { await connectPromise; return client.listTools(); })(),
      readinessMs,
    );
    if (!isCurrentAttempt(handle, attempt)) return; // superseded mid-handshake — a later stop/restart already decided this attempt's fate

    handle.tools = tools;
    handle.everReady = true;
    handle.state = 'ready';
    handle.startedAt = Date.now();
    handle.error = undefined;
    notify(handle);

    await detectPingSupport(handle, client);
    if (!isCurrentAttempt(handle, attempt)) return;
    scheduleHealthyReset(handle, attempt);
    if (handle.pingSupported) schedulePing(handle, attempt);
  } catch (err) {
    if (!isCurrentAttempt(handle, attempt)) return;
    const elapsedMs = Date.now() - (handle.attemptStartedAt ?? Date.now());
    const pid = handle.pid;
    const timedOut = isDeadlineError(err);
    handle.pid = undefined;
    if (pid != null && timedOut) {
      // A deadline we imposed, not a process exit — the child is still
      // alive and must be torn down ourselves.
      void killTree(pid, { graceMs: tuning.STOP_GRACE_MS }).catch(() => {});
    }
    handleAttemptFailure(handle, attempt, {
      error: handle.lastTransportError ?? err,
      hadPid: pid != null,
      timedOut,
      elapsedMs,
    });
  }
}

async function detectPingSupport(handle: Handle, client: Client): Promise<void> {
  try {
    await withDeadline(client.ping(), tuning.PING_TIMEOUT_MS);
    handle.pingSupported = true;
  } catch {
    handle.pingSupported = false;
    log.info(`[McpHostSupervisor] "${handle.id}" does not answer ping — downgraded to exit-only health monitoring.`);
  }
}

function schedulePing(handle: Handle, attempt: Attempt): void {
  clearPingTimer(handle);
  handle.pingFailures = 0;
  handle.pingTimer = setInterval(() => { void runPing(handle, attempt); }, tuning.PING_INTERVAL_MS);
  handle.pingTimer.unref?.();
}

async function runPing(handle: Handle, attempt: Attempt): Promise<void> {
  if (!isCurrentAttempt(handle, attempt) || !handle.client) return;
  try {
    await withDeadline(handle.client.ping(), tuning.PING_TIMEOUT_MS);
    handle.pingFailures = 0;
  } catch {
    handle.pingFailures++;
    if (handle.pingFailures < tuning.PING_FAILURE_THRESHOLD) return;
    if (!isCurrentAttempt(handle, attempt)) return;

    log.warn(`[McpHostSupervisor] "${handle.id}" failed ${handle.pingFailures} consecutive pings — treating as crashed.`);
    const pid = handle.pid;
    clearHealthTimers(handle);
    handle.pid = undefined;
    if (pid != null) void killTree(pid, { graceMs: tuning.STOP_GRACE_MS }).catch(() => {});
    handleAttemptFailure(handle, attempt, {
      error: new Error('Server stopped responding to health checks.'),
      hadPid: pid != null,
      timedOut: true,
      elapsedMs: 0,
    });
  }
}

/**
 * `initialize`/`tools/list` returned fine, but the process is now gone
 * (`onclose` fired). `handle.intent` — checked FIRST, never a signal — is
 * what decides whether this is "we asked for this" or a real crash.
 */
function onExit(handle: Handle, attempt: Attempt, exitCode: number | null, signal: NodeJS.Signals | null): void {
  if (!isCurrentAttempt(handle, attempt)) return;
  attempt.settled = true;
  clearHealthTimers(handle);
  const hadPid = handle.pid != null;
  handle.pid = undefined;

  switch (handle.intent) {
    case 'paused':
      handle.state = 'paused';
      handle.queue.drain(`Server "${handle.id}" is paused.`);
      void clearSpawnSafely(handle.id);
      notify(handle);
      return;
    case 'stopped':
      handle.state = 'stopped';
      handle.queue.drain(`Server "${handle.id}" is stopped.`);
      void clearSpawnSafely(handle.id);
      notify(handle);
      return;
    case 'probe':
      handle.state = 'stopped';
      notify(handle);
      return;
    case 'running':
    default: {
      const elapsedMs = Date.now() - (handle.attemptStartedAt ?? Date.now());
      const signalNote = signal ? ` (signal ${signal})` : '';
      const codeNote = exitCode != null ? ` (code ${exitCode})` : '';
      handleAttemptFailure(handle, attempt, {
        error: handle.lastTransportError ?? new Error(`Process exited unexpectedly${codeNote}${signalNote}.`),
        hadPid,
        timedOut: false,
        elapsedMs,
        exitCode,
      });
    }
  }
}

function onTransportError(handle: Handle, _attempt: Attempt, err: Error): void {
  handle.lastTransportError = err;
  // A parse error from stdout pollution does not by itself mean the call in
  // flight failed — diagnose.ts's module comment covers exactly why the
  // noisy fixture's own tool call still succeeds even after this fires.
  // This only logs; whether the server is actually unusable is decided by
  // `onExit` or the ping loop.
  const message = diagnose({ command: handle.record?.entry.command ?? handle.id, error: err, stderrTail: handle.stderrRing.tail() });
  log.warn(`[McpHostSupervisor] "${handle.id}" transport error: ${message}`);
}

interface FailureInfo {
  error: unknown;
  hadPid: boolean;
  timedOut: boolean;
  elapsedMs: number;
  exitCode?: number | null;
}

function handleAttemptFailure(handle: Handle, attempt: Attempt, info: FailureInfo): void {
  attempt.settled = true;
  handle.restartCount++;

  const message = diagnose({
    command: handle.record.entry.command,
    error: info.error,
    exitCode: info.exitCode,
    hadPid: info.hadPid,
    timedOut: info.timedOut,
    elapsedMs: info.elapsedMs,
    stderrTail: handle.stderrRing.tail(),
  });
  handle.error = message;
  handle.queue.drain(`Server "${handle.id}" is unavailable: ${message}`);

  if (handle.restartCount >= tuning.BACKOFF_MAX_ATTEMPTS) {
    handle.state = 'failed';
    log.error(`[McpHostSupervisor] "${handle.id}" failed after ${handle.restartCount} consecutive attempts: ${message}`);
    notify(handle);
    return;
  }

  handle.state = 'restarting';
  notify(handle);
  const delay = backoffDelay(handle.restartCount);
  clearRestartTimer(handle);
  handle.restartTimer = setTimeout(() => {
    handle.restartTimer = null;
    if (handle.intent !== 'running') return; // paused/stopped/removed while we were waiting
    spawnAttempt(handle);
  }, delay);
  handle.restartTimer.unref?.();
}

/** Fires `HEALTHY_RESET_MS` after entering `ready`; only takes effect if THIS attempt is still the current one — a crash in the meantime already moved on. */
function scheduleHealthyReset(handle: Handle, attempt: Attempt): void {
  clearHealthyResetTimer(handle);
  handle.healthyResetTimer = setTimeout(() => {
    handle.healthyResetTimer = null;
    if (!isCurrentAttempt(handle, attempt)) return;
    handle.restartCount = 0;
  }, tuning.HEALTHY_RESET_MS);
  handle.healthyResetTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn one server. Synchronous and fire-and-forget on purpose (R6/R10):
 * callers (`index.ts`'s `startAll`/`start`) must not block on readiness,
 * which arrives later via `onStatusChange`. A no-op if this id is already
 * starting/ready/restarting — callers that want an unconditional fresh spawn
 * should use `restartServer`.
 */
export function startServer(record: HostedMcpRecord): void {
  const handle = getOrCreateHandle(record.id);
  handle.record = record;
  handle.queue.setConcurrency(record.concurrency ?? 1);
  if (handle.state === 'starting' || handle.state === 'ready' || handle.state === 'restarting') {
    return;
  }
  handle.intent = 'running';
  handle.restartCount = 0;
  spawnAttempt(handle);
}

/**
 * Unconditionally respawn, resetting the backoff counter — this is "the
 * user asking again" per the design's stop-trying-until-asked contract.
 * Any previous attempt for this id is invalidated immediately (its own
 * eventual close/timeout becomes a no-op) and its process is killed in the
 * background rather than awaited, so this stays non-blocking like `startServer`.
 */
export function restartServer(record: HostedMcpRecord): void {
  const handle = getOrCreateHandle(record.id);
  handle.record = record;
  handle.queue.setConcurrency(record.concurrency ?? 1);
  clearRestartTimer(handle);
  handle.restartCount = 0;

  const oldPid = handle.pid;
  if (handle.currentAttempt) handle.currentAttempt.settled = true;
  if (oldPid != null) {
    handle.queue.drain(`Server "${handle.id}" is restarting.`);
    void killTree(oldPid, { graceMs: tuning.STOP_GRACE_MS }).catch((err) => {
      log.warn(`[McpHostSupervisor] restart(${handle.id}): failed to kill previous process: ${(err as Error).message}`);
    });
    void clearSpawnSafely(handle.id);
  }
  handle.intent = 'running';
  spawnAttempt(handle);
}

/**
 * Stop (or pause) one server. Idempotent: a second call while the first is
 * still tearing down is queued behind it via `stopInFlight` rather than
 * issuing a second `killTree`, and once `handle.pid` is cleared a later call
 * is a fast no-op — the property the R14/teardown design calls out ("a
 * second call cannot kill a recycled pid") holds because there is nothing
 * left for a second call to signal, not because of a signature re-check at
 * this layer (that check already lives inside `killTree` itself, once per
 * call, which is the layer that actually sends signals).
 */
export async function stopServer(id: string, opts: { graceMs?: number; finalState?: 'stopped' | 'paused' } = {}): Promise<void> {
  const handle = handles.get(id);
  if (!handle) return;
  const finalState = opts.finalState ?? 'stopped';

  const run = async (): Promise<void> => {
    clearRestartTimer(handle);
    handle.intent = finalState;
    const pid = handle.pid;
    if (pid == null) {
      handle.state = finalState;
      notify(handle);
      return;
    }
    if (handle.currentAttempt) handle.currentAttempt.settled = true;
    clearHealthTimers(handle);
    handle.pid = undefined;
    handle.state = finalState;
    handle.queue.drain(`Server "${id}" is ${finalState}.`);
    notify(handle);
    await killTree(pid, { graceMs: opts.graceMs ?? tuning.STOP_GRACE_MS });
    await clearSpawnSafely(id);
  };

  const chained = (handle.stopInFlight ?? Promise.resolve()).catch(() => undefined).then(run);
  handle.stopInFlight = chained.catch(() => undefined);
  return chained;
}

export async function pauseServer(id: string, opts: { graceMs?: number } = {}): Promise<void> {
  return stopServer(id, { ...opts, finalState: 'paused' });
}

/** Stop every known server. Safe to call repeatedly, and touches only ids this supervisor has ever been asked to start — never a process it does not recognize. */
export async function shutdownAll(opts: { graceMs?: number } = {}): Promise<void> {
  const ids = Array.from(handles.keys());
  await Promise.all(ids.map((id) => stopServer(id, { graceMs: opts.graceMs, finalState: 'stopped' }).catch((err) => {
    log.warn(`[McpHostSupervisor] shutdownAll: failed to stop "${id}": ${(err as Error).message}`);
  })));
}

/** Stop (if running) and forget this id entirely — for the façade's `remove()`, after the store record itself is deleted. */
export async function forgetServer(id: string, opts: { graceMs?: number } = {}): Promise<void> {
  await stopServer(id, { ...opts, finalState: 'stopped' });
  handles.delete(id);
}

export function getStatus(id: string): HostedStatus | undefined {
  const handle = handles.get(id);
  return handle ? toStatus(handle) : undefined;
}

export function listStatuses(): HostedStatus[] {
  return Array.from(handles.values()).map(toStatus);
}

/** The tool inventory as of the last successful readiness — `undefined` if this server has never been ready (provenance: "never read" vs. "read, and empty"). */
export function getTools(id: string): HostedToolDescriptor[] | undefined {
  const handle = handles.get(id);
  return handle?.everReady ? handle.tools : undefined;
}

/**
 * Increment 7's write gate, Layer 2 read side: the LIVE in-memory record's
 * tool selection for `id` — never a disk read. This is what
 * `main/agentSession.ts`'s `handleMcpRelay` consults (via `mcpHost.isToolEnabled`)
 * on the hot path of EVERY hosted tool call, so it has to be exactly as cheap
 * as `getStatus`/`isHosted` one screen up: a Map lookup and a field read,
 * nothing that touches `store.ts`'s sealed file.
 *
 * `undefined` for a missing handle (never started this session) — the same
 * "permissive by default" answer as an absent `enabledTools` on the record
 * itself, and deliberately so: `handleMcpRelay`'s own membership check has
 * already separated "not hosted" from "hosted" before this is ever reached,
 * and `invoke()` below will still refuse a call with "server is stopped" for
 * a handle-less id — returning something falser-reading here would
 * misattribute "never started" as "tool deliberately unselected".
 */
export function getEnabledTools(id: string): string[] | undefined {
  return handles.get(id)?.record.enabledTools;
}

/**
 * Refresh an already-known handle's `enabledTools` selection WITHOUT
 * restarting its process — a tool-selection edit is a config-only change
 * (the write gate is enforced host-side, never by the child itself), so
 * there is no reason to tear down and respawn a server just because the user
 * (un)checked a box. A handle that doesn't exist yet (server never started
 * this session) is a silent no-op: the next real `startServer` call reads the
 * fresh, already-updated record straight off disk, so there is nothing here
 * for it to catch up on.
 *
 * Calls `notify()` unconditionally, even though `handle.state` itself has not
 * changed — this is the SAME `onStatusChange` funnel `AgentInfrastructureController`'s
 * constructor already subscribes to via `onInventoryChanged` (re-pushing the
 * live, now-filtered inventory) and `main/index.ts` subscribes to for the
 * Servers page's live broadcast. Reusing it here is the point: a second,
 * bespoke "tool selection changed" event would be a second notification path
 * for the exact same downstream reaction ("go re-read live state and push
 * it"), which is precisely what the design brief warns against.
 */
export function updateEnabledTools(id: string, enabledTools: string[] | undefined): void {
  const handle = handles.get(id);
  if (!handle) return;
  handle.record = { ...handle.record, enabledTools };
  notify(handle);
}

/** The stderr ring buffer's current tail — for the detail panel's log view. `''` for an id with no handle or nothing written yet. */
export function getStderrTail(id: string): string {
  return handles.get(id)?.stderrRing.tail() ?? '';
}

/**
 * Call one tool on one server, through its bounded queue. Rejects
 * immediately — never enters the queue — if the server is not currently
 * `ready`; the queued closure re-checks at RUN time too, in case a restart
 * lands while this call was waiting its turn.
 */
// ---------------------------------------------------------------------------
// Probe — the Servers page's "Test" button (Increment 3)
// ---------------------------------------------------------------------------

export interface ProbeInput {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  /** The absolute path Acabox actually resolved `command` to, or `command`
   *  itself when it already contained a `/` or nothing on PATH matched. */
  resolvedCommand: string;
  /** Mirrors `HostedPathResolution.resolved` — false means the login-shell
   *  PATH lookup failed and Acabox fell back to the bare inherited PATH. */
  pathResolved: boolean;
  toolNames: string[];
  stderrTail: string;
  error?: string;
}

/** Search `pathValue` for an executable named `command`. A command already
 *  containing a `/` (absolute or relative) is returned as-is — there is
 *  nothing to search for. Returns `command` unresolved if nothing on PATH
 *  matches; `diagnose()`'s ENOENT/127 messages already explain that case, so
 *  this does not need to invent a second one. */
function resolveProbeCommandPath(command: string, pathValue: string): string {
  if (!command || command.includes('/')) return command;
  const delim = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(delim)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep searching */ }
  }
  return command;
}

/**
 * One-shot probe run: spawn the SAME command/args/env/cwd a real
 * `startServer` would, through the SAME `spawnAttempt`/`runAttempt`
 * machinery — deliberately not a second, parallel spawn implementation —
 * under a private `__probe__<uuid>` id that is never written to `store.ts`
 * and is deleted from this module's `handles` map the moment the probe
 * settles. `intent: 'probe'` is the field `onExit` already reserved for
 * exactly this: it means "no restart", the same as `stopped`.
 *
 * One real wrinkle: a handshake failure goes through `handleAttemptFailure`'s
 * ordinary backoff path, which sets `state: 'restarting'` unconditionally —
 * it does not itself check `intent` before doing that. But the *scheduled*
 * respawn inside its `setTimeout` DOES check `intent !== 'running'` and
 * returns without spawning, so no second process is ever created; seeing
 * `'restarting'` here is a harmless, momentary label on a handle that is
 * about to be torn down, not a live retry — which is why this treats
 * `restarting` as a terminal (failure) state for a probe, same as `failed`/
 * `stopped`: a probe that reaches it will never actually be retried.
 */
export async function probeServer(input: ProbeInput): Promise<ProbeResult> {
  const id = `__probe__${randomUUID()}`;
  const record: HostedMcpRecord = {
    id,
    label: id,
    enabled: false,
    autostart: false,
    install: { kind: 'custom' },
    entry: { command: input.command, args: input.args, cwd: input.cwd },
    env: input.env,
    concurrency: 1,
    readinessTimeoutMs: input.timeoutMs,
    createdAt: new Date().toISOString(),
  };

  const handle = getOrCreateHandle(id);
  handle.record = record;
  handle.intent = 'probe';
  handle.restartCount = 0;

  return new Promise<ProbeResult>((resolve) => {
    let done = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const finish = async (result: ProbeResult) => {
      if (done) return;
      done = true;
      unsub();
      if (watchdog) clearTimeout(watchdog);
      // Mirrors `stopServer`'s own cleanup idiom: settle the attempt and
      // cancel every timer BEFORE killing, so a late `onclose`/ping/backoff
      // firing on this handle after we've moved on is a guaranteed no-op
      // rather than a stray notify or a leaked recurring timer.
      if (handle.currentAttempt) handle.currentAttempt.settled = true;
      clearHealthTimers(handle);
      clearRestartTimer(handle);
      const pid = handle.pid;
      // Removed from the live map BEFORE the kill even starts, and the kill
      // is AWAITED before resolving — "kill it, and report" (the design's own
      // ordering), and it is what makes "never registers or persists
      // anything" true the instant the caller's `await` returns, not
      // eventually on some later microtask.
      handles.delete(id);
      if (pid != null) {
        await killTree(pid, { graceMs: tuning.STOP_GRACE_MS }).catch(() => {});
      }
      resolve(result);
    };

    const unsub = onStatusChange((status) => {
      if (status.id !== id) return;
      const pathInfo = lastHostedPathResolution();
      const resolvedCommand = resolveProbeCommandPath(input.command, pathInfo?.path ?? input.env.PATH ?? '');
      const pathResolved = pathInfo?.resolved ?? false;
      if (status.state === 'ready') {
        finish({
          ok: true,
          resolvedCommand,
          pathResolved,
          toolNames: (getTools(id) ?? []).map((t) => t.name),
          stderrTail: handle.stderrRing.tail(),
        });
      } else if (status.state === 'restarting' || status.state === 'failed' || status.state === 'stopped') {
        finish({
          ok: false,
          resolvedCommand,
          pathResolved,
          toolNames: [],
          stderrTail: handle.stderrRing.tail(),
          error: status.error ?? handle.error ?? 'Could not start.',
        });
      }
    });

    spawnAttempt(handle);

    // Belt-and-suspenders: every real code path above resolves via a status
    // transition, but an IPC caller should never hang forever on a bug in
    // this wiring, so there is a hard ceiling past the readiness deadline.
    const watchdogMs = clampReadiness(input.timeoutMs) + 5000;
    watchdog = setTimeout(() => {
      const pathInfo = lastHostedPathResolution();
      finish({
        ok: false,
        resolvedCommand: resolveProbeCommandPath(input.command, pathInfo?.path ?? ''),
        pathResolved: pathInfo?.resolved ?? false,
        toolNames: [],
        stderrTail: handle.stderrRing.tail(),
        error: 'Timed out waiting for a result.',
      });
    }, watchdogMs);
    watchdog.unref?.();
  });
}

export async function invoke(id: string, toolName: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  const handle = handles.get(id);
  if (!handle || handle.state !== 'ready' || !handle.client) {
    const state = handle?.state ?? 'stopped';
    throw new Error(`Server "${id}" is ${state}: cannot call "${toolName}".`);
  }
  return handle.queue.enqueue(async () => {
    if (handle.state !== 'ready' || !handle.client) {
      throw new Error(`Server "${id}" is ${handle.state}: cannot call "${toolName}" (it stopped while this call was queued).`);
    }
    return handle.client.callTool({ name: toolName, arguments: args ?? {} });
  });
}

/**
 * Test seam — clears in-memory state with no process teardown. Real cleanup
 * (killing spawned processes) is each test's own responsibility via
 * `stopServer`/`shutdownAll` — this function exists for the R5 orphan
 * scenario specifically, where a test needs to simulate "the app's in-memory
 * state is gone but the OS process is not" without an OS-level kill.
 *
 * Two things this function must do to that end, both found by a real leaked
 * process rather than by inspection:
 *
 * 1. **Cancel every handle's timers.** `pingTimer`/`healthyResetTimer` are
 *    `unref()`'d so they cannot keep a real app process alive, but `unref()`
 *    does not make jest's `--detectOpenHandles` blind to them — a stale
 *    `setInterval` from an orphaned handle is exactly what first produced
 *    "Jest did not exit one second after the test run has completed" here.
 * 2. **Settle every handle's `currentAttempt`.** This is the one that
 *    actually matters for correctness, not just tidiness: the OLD
 *    `client.onclose`/`onerror` closures from a handle's live attempt are
 *    NOT reachable from this map at all (they live inside the SDK's
 *    `Client`/`StdioClientTransport` objects), but Node still owns the real
 *    OS child underneath them and still fires their 'exit'/'close' events
 *    when that child eventually dies — including when killed from
 *    OUTSIDE this process, e.g. by `store.reconcileOrphans()`'s own
 *    `killTree`, exactly the sequence the R5 test drives. Without settling
 *    the attempt first, that late close event reaches a live `onExit`
 *    closure that still believes `intent === 'running'`, which schedules a
 *    genuine THIRD spawn — a "ghost restart" of a handle this function was
 *    supposed to have already erased. Caught by a leaked, untracked
 *    `echoMcpServer.mjs` process surviving an entire test file's `afterAll`,
 *    not by reading the code.
 */
export function __resetSupervisorForTests(): void {
  for (const handle of handles.values()) {
    if (handle.currentAttempt) handle.currentAttempt.settled = true;
    clearHealthTimers(handle);
    clearRestartTimer(handle);
  }
  handles.clear();
  changeListeners.clear();
}

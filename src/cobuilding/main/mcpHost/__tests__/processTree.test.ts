/** @jest-environment node */
/**
 * Real process trees, no mocks — the same doctrine as `jobRegistry.test.ts`
 * (see its header), reused here because `processTree.ts` was extracted from
 * that file and the point stands identically: the whole job of this module is
 * telling the truth about the OS, and a mocked `ps`/`pgrep` would only prove
 * the mock agrees with itself. Unlike `jobRegistry.test.ts`, there is nothing
 * to mock here at all — `processTree.ts` imports neither `electron` nor
 * `electron-log`, so this file imports neither `jest.mock('electron', …)` nor
 * a temp userData dir.
 */
import { itMac } from '../../../../test/platform';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as path from 'path';
import { descendantsOf, pidSignatureOf, killTree } from '../processTree';

const fixture = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'echoMcpServer.mjs');
const children: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A pid that is definitely not running. `execFileSync` waits for and reaps
 * the shell, so unlike a `spawn`ed child this leaves no zombie — a zombie
 * still answers `kill -0` and would look alive. Copied from
 * `jobRegistry.test.ts`'s identical helper.
 */
function deadPid(): number {
  return Number(execFileSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf-8' }).trim());
}

afterEach(async () => {
  for (const c of children.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }
  // Give the OS a moment to actually reap them before the next test's pid
  // arithmetic runs.
  await new Promise((r) => setTimeout(r, 50));
});

describe('descendantsOf / pidSignatureOf — unchanged behaviour, now shared', () => {
  it('pidSignatureOf reports null for a pid that is not running', () => {
    expect(pidSignatureOf(deadPid())).toBeNull();
  });

  it('pidSignatureOf reports a signature for a live process', () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    children.push(child);
    expect(typeof pidSignatureOf(child.pid!)).toBe('string');
  });

  it('descendantsOf finds every descendant of a real 3-level tree', async () => {
    // sh -> sh -> sleep: the top pid is not the one doing the waiting, which
    // is exactly the case a naive single-pid kill would leave running.
    const child = spawn('/bin/sh', ['-c', '/bin/sh -c "sleep 45" & wait'], { stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 400));

    const found = descendantsOf(child.pid!);
    expect(found.length).toBeGreaterThan(0);
    for (const pid of found) expect(alive(pid)).toBe(true);
  });
});

describe('killTree', () => {
  itMac('cloud VM init (PID 1) does not reap, so killed grandchildren stay visible as zombies', 'kills a 3-level tree, including the grandchild', async () => {
    const child = spawn('/bin/sh', ['-c', '/bin/sh -c "sleep 45" & wait'], { stdio: 'ignore' });
    children.push(child);
    const top = child.pid!;
    await new Promise((r) => setTimeout(r, 400));

    const descendants = descendantsOf(top);
    expect(descendants.length).toBeGreaterThan(0); // otherwise this test proves nothing

    await killTree(top, { graceMs: 300 });

    expect(alive(top)).toBe(false);
    for (const pid of descendants) expect(alive(pid)).toBe(false);
  }, 15000);

  it('escalates to SIGKILL after graceMs against the --ignore-sigterm fixture', async () => {
    // Verified by hand before writing this test: killing only the fixture's
    // own pid leaves its `sleep 60` grandchild running, reparented to pid 1 —
    // exactly the orphaning killTree exists to prevent by walking the tree.
    const child = spawn(process.execPath, [fixture, '--ignore-sigterm'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.push(child);
    const pid = child.pid!;
    // Let it install the SIGTERM handler and spawn its own grandchild before
    // we touch it. Polled, not a fixed sleep: the fixture is Electron-as-Node
    // and under load (a parallel jest worker, a build) takes longer than
    // 500 ms to reach its spawn — measured 2026-09-21 as a 1-in-2 flake.
    let grandchildren: number[] = [];
    for (let waited = 0; waited < 5000 && grandchildren.length === 0; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
      grandchildren = descendantsOf(pid);
    }
    expect(grandchildren.length).toBe(1); // the fixture's own `sleep 60`

    const start = Date.now();
    await killTree(pid, { graceMs: 400 });
    const elapsed = Date.now() - start;

    // Proves this actually went through the grace wait rather than the
    // process dying instantly from SIGTERM (which it's built not to).
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(alive(pid)).toBe(false);
    for (const gc of grandchildren) expect(alive(gc)).toBe(false);
  }, 15000);

  it('calling killTree twice does not throw, and a second call against an already-dead pid does not touch an unrelated process spawned in between', async () => {
    const a = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    children.push(a);
    const aPid = a.pid!;

    await killTree(aPid, { graceMs: 200 });
    expect(alive(aPid)).toBe(false);

    // A genuinely different, unrelated process, spawned only after `a` is
    // gone. True OS-level pid recycling can't be forced deterministically
    // from a test — pids are handed out roughly monotonically — so this
    // cannot literally reuse `aPid`. What this DOES prove: calling killTree
    // a second time against a pid that is already dead is a safe no-op, not,
    // say, a fallback that goes hunting for "whatever looks like it might be
    // the target now" and endangers a neighbour. The disk-tampered version of
    // the actual recycled-pid guard — a recorded signature compared against a
    // live one after a real restart — is exercised in
    // `mcpHostStore.test.ts`'s `reconcileOrphans` cases, where the mismatch
    // can be manufactured directly by editing the stored signature.
    const b = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    children.push(b);
    const bPid = b.pid!;

    await expect(killTree(aPid, { graceMs: 100 })).resolves.toBeUndefined();

    expect(alive(bPid)).toBe(true);
  }, 15000);
});

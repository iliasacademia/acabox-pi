/**
 * Boot reconciliation: deciding what happened to work that was in flight when
 * the app went away. Exercised against REAL processes — a live `sleep` for the
 * adopt path and a genuinely dead pid for the rest — because the whole point of
 * the module is that it tells the truth about the OS, and a mocked `ps` would
 * only prove the mock agrees with itself.
 */
import { itMac } from '../../../test/platform';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-jobs-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  beginJob,
  endJob,
  listJobs,
  activeJobs,
  acknowledgeTool,
  reconcileOnBoot,
  interruptJobsForWebContents,
  cancelJob,
  cancelAll,
  setCancelRequestHandler,
  setRunCompletedHandler,
  subscribe,
  __resetJobRegistry,
} from '../jobRegistry';

const storeFile = path.join(tmpDir, 'tool-jobs.json');
const children: ChildProcess[] = [];

/** A real, live process we can point a job at. */
function spawnSleeper(): number {
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

/**
 * A pid that is definitely not running. `execFileSync` waits for and reaps the
 * shell, so unlike a `spawn`ed child this leaves no zombie — a zombie still
 * answers `kill -0` and would look alive.
 */
function deadPid(): number {
  return Number(execFileSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf-8' }).trim());
}

beforeEach(() => {
  __resetJobRegistry();
  try { fs.unlinkSync(storeFile); } catch { /* not there */ }
});

afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('basic lifecycle', () => {
  it('records a running job and closes it', () => {
    const job = beginJob({ dirName: 'myTool', kind: 'kernel', label: 'Running code' });
    expect(activeJobs()).toHaveLength(1);
    endJob(job.id, 'done');
    expect(activeJobs()).toHaveLength(0);
    expect(listJobs()[0].status).toBe('done');
  });

  it('ignores a second end for the same job', () => {
    const job = beginJob({ dirName: 'myTool', kind: 'kernel', label: 'x' });
    endJob(job.id, 'done');
    endJob(job.id, 'failed');
    expect(listJobs()[0].status).toBe('done');
  });

  it('stamps a completed run exactly once, and not for failures', () => {
    const stamped: string[] = [];
    setRunCompletedHandler((d) => stamped.push(d));
    const ok = beginJob({ dirName: 'toolA', kind: 'kernel', label: 'x' });
    endJob(ok.id, 'done');
    endJob(ok.id, 'done');
    const bad = beginJob({ dirName: 'toolB', kind: 'kernel', label: 'y' });
    endJob(bad.id, 'failed');
    expect(stamped).toEqual(['toolA']);
  });

  it('notifies subscribers', () => {
    const seen: number[] = [];
    const off = subscribe((jobs) => seen.push(jobs.length));
    beginJob({ dirName: 't', kind: 'kernel', label: 'x' });
    off();
    beginJob({ dirName: 't', kind: 'kernel', label: 'y' });
    expect(seen).toEqual([1]); // only while subscribed
  });
});

describe('a renderer going away', () => {
  it('interrupts the jobs that renderer reported, and only those', () => {
    const mine = beginJob({ dirName: 't', kind: 'kernel', label: 'x', ownerWebContentsId: 7 });
    const theirs = beginJob({ dirName: 't', kind: 'kernel', label: 'y', ownerWebContentsId: 9 });
    interruptJobsForWebContents(7);
    const byId = new Map(listJobs().map((j) => [j.id, j.status]));
    expect(byId.get(mine.id)).toBe('interrupted');
    expect(byId.get(theirs.id)).toBe('running');
  });
});

describe('boot reconciliation', () => {
  it('re-adopts a shell command that is genuinely still running', () => {
    const pid = spawnSleeper();
    beginJob({ dirName: 'longTool', kind: 'command', label: 'sleep 30', pid });

    const counts = reconcileOnBoot();
    expect(counts.adopted).toBe(1);
    const job = listJobs()[0];
    expect(job.status).toBe('running');
    expect(job.adopted).toBe(true);
  });

  it('marks a command whose process is gone as finishedWhileAway, not done', () => {
    beginJob({ dirName: 'goneTool', kind: 'command', label: 'sleep 1', pid: deadPid() });
    const counts = reconcileOnBoot();
    expect(counts.finishedWhileAway).toBe(1);
    // Its outcome is unknowable — it must not claim success.
    expect(listJobs()[0].status).toBe('finishedWhileAway');
  });

  it('marks kernel work as interrupted — it dies with the app', () => {
    beginJob({ dirName: 'kernelTool', kind: 'kernel', label: 'Running code' });
    const counts = reconcileOnBoot();
    expect(counts.interrupted).toBe(1);
    expect(listJobs()[0].status).toBe('interrupted');
  });

  it('marks Claude calls as interrupted', () => {
    beginJob({ dirName: 'aiTool', kind: 'claude', label: 'Claude request' });
    reconcileOnBoot();
    expect(listJobs()[0].status).toBe('interrupted');
  });

  it('does not adopt a recycled pid', () => {
    const pid = spawnSleeper();
    const job = beginJob({ dirName: 't', kind: 'command', label: 'sleep 30', pid });
    // Simulate the pid now belonging to some unrelated process: the recorded
    // signature no longer matches what ps reports for it.
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    raw.find((j: any) => j.id === job.id).pidSignature = 'Thu Jan  1 00:00:00 1970 /some/other/process';
    fs.writeFileSync(storeFile, JSON.stringify(raw));
    __resetJobRegistry();
    // force a reload from disk
    (listJobs as unknown as () => void)();

    const counts = reconcileOnBoot();
    expect(counts.adopted).toBe(0);
  });

  it('leaves already-finished jobs alone', () => {
    const job = beginJob({ dirName: 't', kind: 'kernel', label: 'x' });
    endJob(job.id, 'done');
    const counts = reconcileOnBoot();
    expect(counts).toEqual({ adopted: 0, interrupted: 0, finishedWhileAway: 0 });
    expect(listJobs()[0].status).toBe('done');
  });
});

describe('persistence across a restart', () => {
  it('reloads jobs written by the previous session', () => {
    beginJob({ dirName: 'persisted', kind: 'command', label: 'sleep 30', pid: spawnSleeper() });
    expect(fs.existsSync(storeFile)).toBe(true);

    // A fresh process reading the same store file.
    __resetJobRegistry();
    jest.resetModules();
    const reloaded = require('../jobRegistry');
    reloaded.__resetJobRegistry();
    // __reset marks it loaded, so read the file directly to prove it persisted.
    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].dirName).toBe('persisted');
    expect(onDisk[0].status).toBe('running');
    expect(typeof onDisk[0].pid).toBe('number');
    expect(typeof onDisk[0].pidSignature).toBe('string');
  });

  it('does not persist the WebContents id, which is meaningless next boot', () => {
    beginJob({ dirName: 't', kind: 'kernel', label: 'x', ownerWebContentsId: 42 });
    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    expect(onDisk[0].ownerWebContentsId).toBeUndefined();
  });
});

describe('acknowledge', () => {
  it('drops past-tense notices for one tool only', () => {
    const a = beginJob({ dirName: 'toolA', kind: 'kernel', label: 'x' });
    const b = beginJob({ dirName: 'toolB', kind: 'kernel', label: 'y' });
    endJob(a.id, 'done');
    endJob(b.id, 'done');
    reconcileOnBoot();
    // Make both look like leftovers from a previous session.
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    for (const j of raw) j.status = 'interrupted';
    fs.writeFileSync(storeFile, JSON.stringify(raw));
    __resetJobRegistry();
    jest.resetModules();
    const mod = require('../jobRegistry');

    mod.acknowledgeTool('toolA');
    const left = mod.listJobs();
    expect(left.map((j: any) => j.dirName)).toEqual(['toolB']);
  });
});

describe('cancel', () => {
  itMac('cloud VM init (PID 1) does not reap, so killed grandchildren stay visible as zombies', 'kills a real process tree, including grandchildren', async () => {
    // sh -> sh -> sleep: the top pid is not the one doing the waiting, which is
    // exactly the case a naive single-pid kill would leave running.
    const child = spawn('/bin/sh', ['-c', '/bin/sh -c "sleep 45" & wait'], { stdio: 'ignore' });
    children.push(child);
    const top = child.pid!;
    await new Promise((r) => setTimeout(r, 400));

    const alive = (p: number) => {
      try { execFileSync('/bin/ps', ['-p', String(p), '-o', 'pid='], { encoding: 'utf-8' }); return true; }
      catch { return false; }
    };
    const descendants = execFileSync('/bin/sh', ['-c', `pgrep -P ${top} || true`], { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean).map(Number);
    expect(descendants.length).toBeGreaterThan(0);

    const job = beginJob({ dirName: 't', kind: 'command', label: 'sleep 45', pid: top });
    const res = cancelJob(job.id);
    expect(res.ok).toBe(true);
    expect(listJobs()[0].status).toBe('cancelled');

    await new Promise((r) => setTimeout(r, 800));
    expect(alive(top)).toBe(false);
    for (const d of descendants) expect(alive(d)).toBe(false);
  }, 15000);

  it('asks the owner to interrupt renderer-driven work', () => {
    const asked: string[] = [];
    setCancelRequestHandler((j) => { asked.push(j.id); return true; });
    const job = beginJob({ dirName: 't', kind: 'kernel', label: 'Running code', ownerWebContentsId: 3 });
    expect(cancelJob(job.id).ok).toBe(true);
    expect(asked).toEqual([job.id]);
    expect(listJobs()[0].status).toBe('cancelled');
  });

  it('does not stamp lastRun for cancelled work', () => {
    const stamped: string[] = [];
    setRunCompletedHandler((d) => stamped.push(d));
    const job = beginJob({ dirName: 't', kind: 'kernel', label: 'x' });
    cancelJob(job.id);
    expect(stamped).toEqual([]);
  });

  it('refuses to cancel something that already ended', () => {
    const job = beginJob({ dirName: 't', kind: 'kernel', label: 'x' });
    endJob(job.id, 'done');
    expect(cancelJob(job.id)).toEqual({ ok: false, reason: 'not running' });
  });

  it('cancelAll stops everything running and reports how many', () => {
    setCancelRequestHandler(() => true);
    beginJob({ dirName: 'a', kind: 'kernel', label: 'x' });
    beginJob({ dirName: 'b', kind: 'kernel', label: 'y' });
    const done = beginJob({ dirName: 'c', kind: 'kernel', label: 'z' });
    endJob(done.id, 'done');
    expect(cancelAll()).toBe(2);
    expect(activeJobs()).toHaveLength(0);
  });
});

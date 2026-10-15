/**
 * The render — `<workspace>/.claude/skills/<id>` -> `<store>/<id>`.
 *
 * The first block pins filesystem semantics that nothing in this codebase
 * currently pins and that the whole architecture rests on. They were measured
 * by hand while the design was written; measured facts that live only in a
 * document are facts a later "tidy up" commit deletes. They live here now.
 */
import { itMac } from '../../../test/platform';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-skillrender-'));
const userData = path.join(tmpRoot, 'userData');
const appRoot = path.join(tmpRoot, 'app');
const pristineRoot = path.join(appRoot, 'src', 'cobuilding', 'skills');
const storeRoot = path.join(userData, 'skills');
const workspaceDir = path.join(userData, 'workspace-data');
const renderDir = path.join(workspaceDir, '.claude', 'skills');

jest.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => appRoot,
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getRenderDir, renderSkills } from '../skillRender';
import {
  createSkill,
  deleteSkill,
  reconcile,
  setSkillEnabled,
  skillStorePath,
} from '../skillStore';

const skillMd = (id: string) => `---\nname: ${id}\ndescription: Does ${id} things.\n---\n\n# ${id}\n`;

function putPristine(id: string, files: Record<string, string> = {}): void {
  const dir = path.join(pristineRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(id));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

beforeEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.mkdirSync(pristineRoot, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('POSIX semantics the design rests on', () => {
  const scratch = path.join(tmpRoot, 'scratch');

  beforeEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(path.join(scratch, 'target'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'target', 'SKILL.md'), 'store bytes');
  });

  /**
   * The fact the old prune loop depended on WITHOUT KNOWING IT.
   * `skills.ts:56-57` filters `entry.isDirectory()`, which is false for a
   * symlink — so today's reaper happens to skip our links. That is luck, not
   * design, and it is why `skillRender` and `skillStore.adoptRenderDirectories`
   * both check `isSymbolicLink()` FIRST rather than relying on it.
   */
  it('a symlink Dirent reports isDirectory() === false', () => {
    fs.symlinkSync(path.join(scratch, 'target'), path.join(scratch, 'link'), 'dir');
    const dirent = fs.readdirSync(scratch, { withFileTypes: true }).find((e) => e.name === 'link')!;
    expect(dirent.isSymbolicLink()).toBe(true);
    expect(dirent.isDirectory()).toBe(false);
    // …while a `stat` (which follows) says the opposite. Both are true; they
    // are answering different questions.
    expect(fs.statSync(path.join(scratch, 'link')).isDirectory()).toBe(true);
  });

  /** Why a repoint uses `unlink` and never `rmSync(link, {recursive:true})`
   *  with a trailing separator. */
  it('rmSync on a link with no trailing slash unlinks it and leaves the target', () => {
    const link = path.join(scratch, 'link');
    fs.symlinkSync(path.join(scratch, 'target'), link, 'dir');
    fs.rmSync(link, { recursive: true, force: true });

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(scratch, 'target', 'SKILL.md'), 'utf-8')).toBe('store bytes');
  });

  /** …and the accepted failure mode from section 3 of the design: WITH the
   *  slash, the delete resolves through the link and empties the store. */
  itMac('BSD rmdir follows a trailing-slash symlink; Linux returns ENOTDIR', 'rm -rf THROUGH a link (trailing separator) does empty the target', () => {
    const link = path.join(scratch, 'link');
    fs.symlinkSync(path.join(scratch, 'target'), link, 'dir');
    fs.rmSync(link + path.sep, { recursive: true, force: true });

    expect(fs.existsSync(path.join(scratch, 'target', 'SKILL.md'))).toBe(false);
  });

  /**
   * What an OLD build does if it is ever run against a rendered workspace.
   * Its prune filters `isDirectory()`, which is false for our links, so the
   * links survive it — and then `copySkillsToWorkspace` does `cpSync` of a
   * pristine directory straight onto one.
   *
   * MEASURED ON THE RUNTIME THAT ACTUALLY RUNS THIS CODE, which is the whole
   * point of this test. Electron 37 ships Node 22.17; the design doc's claim
   * that this throws `ERR_FS_CP_DIR_TO_NON_DIR` was measured on a standalone
   * Node 25 and is WRONG here. On 22.17 the copy silently succeeds and writes
   * THROUGH the link into the store.
   *
   * So the real downgrade behaviour is not a brick — it is quiet data loss:
   * the old build overwrites the store copy with pristine bytes and the user's
   * edits are gone, with the app still starting normally. That is worse than a
   * crash in the way that matters (no signal), and it is the reason the store
   * keeps a trash copy rather than relying on the render being read-only.
   *
   * Both target states are asserted because a dangling link is reachable too:
   * delete a skill from the store and its link outlives it until the next render.
   */
  it('cpSync of a directory onto a symlink writes through it (Node 22 / Electron)', () => {
    fs.mkdirSync(path.join(scratch, 'source'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'source', 'SKILL.md'), 'pristine bytes');

    // Live link: silently writes through into the target.
    const target = path.join(scratch, 'live-target');
    fs.mkdirSync(target, { recursive: true });
    const liveLink = path.join(scratch, 'live-link');
    fs.symlinkSync(target, liveLink, 'dir');

    let liveErr: string | undefined;
    try {
      fs.cpSync(path.join(scratch, 'source'), liveLink, { recursive: true });
    } catch (err: any) {
      liveErr = err.code;
    }
    expect(liveErr).toBeUndefined();
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('pristine bytes');
    // The link itself is untouched — still a link, not replaced by a real dir.
    expect(fs.lstatSync(liveLink).isSymbolicLink()).toBe(true);

    // Dangling link: refuses, and does so catchably.
    const danglingLink = path.join(scratch, 'dangling-link');
    fs.symlinkSync(path.join(scratch, 'no-such-target'), danglingLink, 'dir');

    let danglingErr: string | undefined;
    try {
      fs.cpSync(path.join(scratch, 'source'), danglingLink, { recursive: true });
    } catch (err: any) {
      danglingErr = err.code;
    }
    expect(danglingErr).toBe('EEXIST');
  });

  /**
   * The reason the write-path problem is DISSOLVED rather than solved: every
   * writer resolves the link at `open()` time, so there is no second copy and
   * no sync direction to get backwards.
   */
  it('writing through a link lands in the target, not beside it', () => {
    const link = path.join(scratch, 'link');
    fs.symlinkSync(path.join(scratch, 'target'), link, 'dir');
    fs.writeFileSync(path.join(link, 'SKILL.md'), 'edited by the agent');

    expect(fs.readFileSync(path.join(scratch, 'target', 'SKILL.md'), 'utf-8')).toBe(
      'edited by the agent',
    );
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('renderSkills', () => {
  /** A workspace-ROOT link is unlinked on every containerService.start() by a
   *  reaper that skips dot-prefixed names. The dot-directory is not cosmetic. */
  it('renders under .claude/, never at the workspace root', () => {
    expect(getRenderDir(workspaceDir)).toBe(path.join(workspaceDir, '.claude', 'skills'));
    expect(path.relative(workspaceDir, getRenderDir(workspaceDir)).startsWith('.claude')).toBe(true);
  });

  it('links every skill in the store as an absolute symlink', async () => {
    putPristine('acabox');
    putPristine('xlsx');
    await reconcile();

    const result = await renderSkills(workspaceDir);

    expect(result.linked.sort()).toEqual(['acabox', 'xlsx']);
    for (const id of ['acabox', 'xlsx']) {
      const link = path.join(renderDir, id);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      const target = fs.readlinkSync(link);
      expect(path.isAbsolute(target)).toBe(true);
      expect(target).toBe(skillStorePath(id));
    }
  });

  it('resolves the whole skill through the link, scripts and all', async () => {
    putPristine('xlsx', { 'scripts/recalc.py': 'print("recalc")\n' });
    await reconcile();
    await renderSkills(workspaceDir);

    // Exactly the path `src/cobuilding/CLAUDE.md` teaches the agent.
    expect(
      fs.readFileSync(path.join(renderDir, 'xlsx', 'scripts', 'recalc.py'), 'utf-8'),
    ).toBe('print("recalc")\n');
  });

  it('is idempotent — a second render writes nothing', async () => {
    putPristine('acabox');
    await reconcile();
    await renderSkills(workspaceDir);

    const second = await renderSkills(workspaceDir);
    expect(second.linked).toEqual([]);
    expect(second.unchanged).toEqual(['acabox']);
    expect(second.unlinked).toEqual([]);
  });

  /**
   * THE COUPLING WITH `buildSkillRuntimeConfig`. Disable is a roster-budget
   * decision enforced by the allowlist; the bytes stay reachable. If the
   * render ever skipped disabled skills, a disable would be irreversible
   * mid-session and a re-enabled skill's relative paths would break.
   */
  it('links a DISABLED skill too', async () => {
    putPristine('acabox');
    await reconcile();
    await setSkillEnabled('acabox', false);

    const result = await renderSkills(workspaceDir);
    expect(result.linked).toEqual(['acabox']);
    expect(fs.existsSync(path.join(renderDir, 'acabox', 'SKILL.md'))).toBe(true);
  });

  it('repoints a link that points at the wrong place', async () => {
    putPristine('acabox');
    await reconcile();
    fs.mkdirSync(renderDir, { recursive: true });
    fs.symlinkSync(path.join(tmpRoot, 'somewhere-else'), path.join(renderDir, 'acabox'), 'dir');

    const result = await renderSkills(workspaceDir);
    expect(result.linked).toEqual(['acabox']);
    expect(fs.readlinkSync(path.join(renderDir, 'acabox'))).toBe(skillStorePath('acabox'));
  });

  /** Never a delete. Reconcile adopts it into the store; the render's job is
   *  to be incapable of destroying one. */
  it('leaves a real directory in the render target completely alone', async () => {
    putPristine('acabox');
    await reconcile();
    fs.mkdirSync(path.join(renderDir, 'acabox'), { recursive: true });
    fs.writeFileSync(path.join(renderDir, 'acabox', 'SKILL.md'), 'the agent wrote this');

    const result = await renderSkills(workspaceDir);

    expect(result.adoptable).toEqual(['acabox']);
    expect(result.linked).toEqual([]);
    expect(fs.readFileSync(path.join(renderDir, 'acabox', 'SKILL.md'), 'utf-8')).toBe(
      'the agent wrote this',
    );
  });

  it('leaves an unrelated real file alone', async () => {
    putPristine('acabox');
    await reconcile();
    fs.mkdirSync(renderDir, { recursive: true });
    fs.writeFileSync(path.join(renderDir, 'README.md'), 'notes');

    await renderSkills(workspaceDir);
    expect(fs.existsSync(path.join(renderDir, 'README.md'))).toBe(true);
  });

  it('unlinks the link of a skill that was removed — how a delete reaches the agent', async () => {
    putPristine('acabox');
    putPristine('xlsx');
    await reconcile();
    await renderSkills(workspaceDir);

    await deleteSkill('xlsx');
    const result = await renderSkills(workspaceDir);

    expect(result.unlinked).toEqual(['xlsx']);
    expect(fs.existsSync(path.join(renderDir, 'xlsx'))).toBe(false);
    expect(fs.existsSync(path.join(renderDir, 'acabox'))).toBe(true);
  });

  /** Only links into OUR store are swept. Anything else is somebody's
   *  deliberate work — the same restraint `syncWorkspaceSymlinks` shows. */
  it('does not touch a symlink pointing outside the store', async () => {
    putPristine('acabox');
    await reconcile();
    fs.mkdirSync(path.join(tmpRoot, 'their-skills', 'borrowed'), { recursive: true });
    fs.mkdirSync(renderDir, { recursive: true });
    fs.symlinkSync(
      path.join(tmpRoot, 'their-skills', 'borrowed'),
      path.join(renderDir, 'borrowed'),
      'dir',
    );

    const result = await renderSkills(workspaceDir);
    expect(result.unlinked).toEqual([]);
    expect(fs.lstatSync(path.join(renderDir, 'borrowed')).isSymbolicLink()).toBe(true);
    fs.rmSync(path.join(tmpRoot, 'their-skills'), { recursive: true, force: true });
  });

  it('links a custom skill the same way as a built-in', async () => {
    await createSkill('my-lab-protocol');
    await renderSkills(workspaceDir);
    expect(fs.readlinkSync(path.join(renderDir, 'my-lab-protocol'))).toBe(
      skillStorePath('my-lab-protocol'),
    );
  });

  it('creates the render directory when the workspace has none yet', async () => {
    putPristine('acabox');
    await reconcile();
    expect(fs.existsSync(renderDir)).toBe(false);
    await renderSkills(workspaceDir);
    expect(fs.existsSync(path.join(renderDir, 'acabox'))).toBe(true);
  });

  /** A dangling link is an ABSENT skill to the CLI, not a crash — but there is
   *  no reason to create one, so an index entry with no bytes is reported
   *  rather than linked. */
  it('reports, rather than links, a skill whose store directory is missing', async () => {
    putPristine('acabox');
    await reconcile();
    fs.rmSync(skillStorePath('acabox'), { recursive: true, force: true });

    const result = await renderSkills(workspaceDir);
    expect(result.errors).toEqual([{ id: 'acabox', message: 'no directory in the store' }]);
    expect(fs.existsSync(path.join(renderDir, 'acabox'))).toBe(false);
  });

  /** The round trip the whole feature exists for. */
  it('an edit made through the link lands in the store and survives a reconcile', async () => {
    putPristine('acabox');
    await reconcile();
    await renderSkills(workspaceDir);

    fs.writeFileSync(path.join(renderDir, 'acabox', 'SKILL.md'), 'EDITED VIA THE WORKSPACE');
    expect(fs.readFileSync(path.join(skillStorePath('acabox'), 'SKILL.md'), 'utf-8')).toBe(
      'EDITED VIA THE WORKSPACE',
    );

    await reconcile({ workspaceDir });
    await renderSkills(workspaceDir);
    expect(fs.readFileSync(path.join(renderDir, 'acabox', 'SKILL.md'), 'utf-8')).toBe(
      'EDITED VIA THE WORKSPACE',
    );
  });
});

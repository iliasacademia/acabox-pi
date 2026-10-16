/**
 * @jest-environment node
 *
 * Registration — the step that turns a staged tree into a skill the store owns.
 *
 * `skillImporter.test.ts` already proves the FETCH is safe (real tarballs, real
 * bsdtar, a real absolute symlink that really gets materialised before it is
 * stripped). This file is about what happens after: the provenance record, the
 * roster rule, and the two ways an import can be refused.
 *
 * Nothing below the Electron path lookup is mocked. Real trees, a real state
 * file written through `manifestIO`, a real `/usr/bin/tar` building a real
 * archive — because the properties under test are properties of bytes landing
 * on disk, and the most important one (`enabled: false`) is only meaningful if
 * the thing reading it back is the real `buildSkillRuntimeConfig`.
 *
 * The node environment (not jsdom) matches `skillImporter.test.ts`.
 */
import { itMac } from '../../../test/platform';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-skillimport-'));
const userData = path.join(tmpRoot, 'userData');
const appRoot = path.join(tmpRoot, 'app');
const pristineRoot = path.join(appRoot, 'src', 'cobuilding', 'skills');
const storeRoot = path.join(userData, 'skills');

/** Swapped per test. Named `mock*` so jest's hoisting allows the reference. */
let mockNetFetch: (url: string, init?: unknown) => Promise<unknown> = async () => {
  throw new Error('net.fetch was called by a test that did not expect network access');
};

jest.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getAppPath: () => appRoot,
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
  net: { fetch: (url: string, init?: unknown) => mockNetFetch(url, init) },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { buildSkillRuntimeConfig, HOST_OWNED_SKILL_PATHS } from '../../shared/skills';
import {
  fetchSubtree,
  gitBlobSha,
  importLocalFolder,
  resolveImportId,
} from '../knowledge/skillImporter';
import {
  createSkill,
  listSkills,
  readSkillsState,
  registerImportedSkill,
  setSkillEnabled,
  type ImportRegistration,
} from '../skillStore';

const scratch = (name: string) => path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
  fs.mkdirSync(pristineRoot, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_SHA = 'b'.repeat(40);

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n\n# ${name}\n\nBody.\n`;
}

/** A skill folder on disk, the shape `importLocalFolder` takes. */
function buildFolder(opts: {
  id: string;
  files: Record<string, string>;
  exec?: string[];
  symlinks?: Record<string, string>;
}): string {
  const dir = path.join(scratch('src'), opts.id);
  for (const [rel, contents] of Object.entries(opts.files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  for (const rel of opts.exec ?? []) fs.chmodSync(path.join(dir, rel), 0o755);
  for (const [rel, target] of Object.entries(opts.symlinks ?? {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync(target, abs);
  }
  return dir;
}

/** A codeload-shaped tarball, built by the real bsdtar. */
function buildArchive(opts: {
  repo: string;
  files: Record<string, string>;
  exec?: string[];
  symlinks?: Record<string, string>;
}): string {
  const stage = scratch('archive');
  const root = path.join(stage, `${opts.repo}-${FAKE_SHA}`);
  for (const [rel, contents] of Object.entries(opts.files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  for (const rel of opts.exec ?? []) fs.chmodSync(path.join(root, rel), 0o755);
  for (const [rel, target] of Object.entries(opts.symlinks ?? {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync(target, abs);
  }
  const tarPath = path.join(stage, 'repo.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', stage, `${opts.repo}-${FAKE_SHA}`]);
  return tarPath;
}

/** codeload sends no `content-length`; the stand-in must not either. */
function serveFile(filePath: string) {
  const bytes = fs.readFileSync(filePath);
  let offset = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.length) return { done: true, value: undefined };
          const value = new Uint8Array(bytes.subarray(offset, offset + 8192));
          offset += 8192;
          return { done: false, value };
        },
      }),
    },
  };
}

/** Everything registration needs, from what the importer actually returned. */
function registrationFor(
  fetched: Awaited<ReturnType<typeof importLocalFolder>>,
  overrides: Partial<ImportRegistration> = {},
): ImportRegistration {
  return {
    id: fetched.id,
    stagingDir: fetched.path,
    source: fetched.source,
    declared: fetched.declared,
    aliasOfDirName: fetched.aliasOfDirName,
    upstreamBlobs: fetched.upstreamBlobs,
    fileCount: fetched.fileCount,
    execCount: fetched.execCount,
    importedVia: 'ui',
    importedFrom: 'direct',
    ...overrides,
  };
}

const walk = (dir: string, rel = ''): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) return [`link:${relPath}`];
    return e.isDirectory() ? walk(path.join(dir, e.name), relPath) : [relPath];
  });

// ---------------------------------------------------------------------------

describe('registerImportedSkill — the provenance record', () => {
  it('records everything measurable, and nothing it cannot measure', async () => {
    const before = Date.now();
    const src = buildFolder({
      id: 'lab-protocol',
      files: {
        'SKILL.md': skillMd('lab', 'Run the bench protocol.'),
        'scripts/run.sh': '#!/bin/sh\necho hi\n',
        'references/notes.md': '# notes\n',
      },
      exec: ['scripts/run.sh'],
    });
    const staging = scratch('staged');
    const fetched = await importLocalFolder(src, staging);

    const result = await registerImportedSkill(registrationFor(fetched, { importedFrom: 'local-folder' }));
    expect(result).toMatchObject({ ok: true, id: 'lab-protocol' });

    const entry = (await readSkillsState()).skills['lab-protocol']!;
    expect(entry.origin).toBe('imported');
    expect(entry.importedVia).toBe('ui');
    expect(entry.importedFrom).toBe('local-folder');
    expect(entry.source).toEqual({ kind: 'local-folder', localPath: path.resolve(src) });
    expect(entry.declared).toEqual({ name: 'lab', description: 'Run the bench protocol.', license: 'MIT' });
    // Frontmatter `name` is `lab`, the directory is `lab-protocol`. The file is
    // never rewritten to make them agree, so the disagreement is recorded.
    expect(entry.aliasOfDirName).toBe(true);
    expect(entry.fileCount).toBe(3);
    expect(entry.execCount).toBe(1);
    expect(entry.hostOwnedPaths).toEqual(HOST_OWNED_SKILL_PATHS);
    expect(Date.parse(entry.importedAt!)).toBeGreaterThanOrEqual(before);

    // Two independent hash sets. `upstreamBlobs` is git's own object id, which
    // is what makes the later update check one API call and zero downloads.
    expect(Object.keys(entry.upstreamBlobs!).sort()).toEqual([
      'SKILL.md',
      'references/notes.md',
      'scripts/run.sh',
    ]);
    expect(entry.upstreamBlobs!['SKILL.md']).toBe(
      gitBlobSha(fs.readFileSync(path.join(storeRoot, 'lab-protocol', 'SKILL.md'))),
    );
    // `baseline` is the store's own sha256 set — a different question ("have I
    // changed it") answered by a different algorithm.
    expect(Object.keys(entry.baseline!).sort()).toEqual(Object.keys(entry.upstreamBlobs!).sort());
    expect(entry.baseline!['SKILL.md']).not.toBe(entry.upstreamBlobs!['SKILL.md']);

    // The record is only as good as the bytes it describes.
    expect(walk(path.join(storeRoot, 'lab-protocol')).sort()).toEqual([
      'SKILL.md',
      'references/notes.md',
      'scripts/run.sh',
    ]);
    expect(fs.statSync(path.join(storeRoot, 'lab-protocol', 'scripts/run.sh')).mode & 0o111).not.toBe(0);
    // The staged tree was MOVED, not copied: a second commit must not be able
    // to register the same directory twice.
    expect(fs.existsSync(staging)).toBe(false);

    // A pristine import reads unmodified on arrival — the whole point of not
    // rewriting the frontmatter to match the directory name.
    const descriptor = (await listSkills()).find((s) => s.id === 'lab-protocol')!;
    expect(descriptor.modified).toBe(false);
    expect(descriptor.origin).toBe('imported');
  });
});

describe('registerImportedSkill — imports start off the roster', () => {
  it('writes enabled:false whatever the caller passes, and the roster agrees', async () => {
    const src = buildFolder({
      id: 'off-roster',
      files: { 'SKILL.md': skillMd('off-roster', 'Never on by default.') },
    });
    const fetched = await importLocalFolder(src, scratch('staged'));

    // `ImportRegistration` has no `enabled` field precisely so this cannot be
    // written by mistake. Forcing one through proves the value is a literal in
    // main and not a defaulted parameter a caller could reach.
    const smuggled = { ...registrationFor(fetched), enabled: true } as unknown as ImportRegistration;
    expect(await registerImportedSkill(smuggled)).toMatchObject({ ok: true });

    expect((await readSkillsState()).skills['off-roster']!.enabled).toBe(false);
    // The enforcement that matters: absent from `Options.skills`, so it costs
    // the roster nothing and cannot squeeze another skill's description.
    expect(buildSkillRuntimeConfig(await readSkillsState())).not.toContain('off-roster');

    await setSkillEnabled('off-roster', true);
    expect(buildSkillRuntimeConfig(await readSkillsState())).toContain('off-roster');
  });
});

describe('registerImportedSkill — symlinks never reach the store', () => {
  itMac('bsdtar flags are rejected by GNU tar', 'strips a symlink out of a real archive before the skill is registered', async () => {
    // bsdtar refuses `..` in a path but happily materialises an ABSOLUTE
    // symlink, and Acabox's workspace reaper never looks inside
    // `.claude/skills/<id>/`. So this is a real hole, and the fix has to be
    // proven against a link a real tar really created.
    const tarPath = buildArchive({
      repo: 'evil',
      files: { 'skills/sneaky/SKILL.md': skillMd('sneaky', 'Looks ordinary.') },
      symlinks: {
        'skills/sneaky/link-out': '/etc/passwd',
        'skills/sneaky/nested/rel-out': '../../../../../../etc/hosts',
      },
    });
    mockNetFetch = async () => serveFile(tarPath);

    const staging = scratch('staged');
    const fetched = await fetchSubtree(
      { owner: 'someone', repo: 'evil', sha: FAKE_SHA, subpath: 'skills/sneaky' },
      staging,
    );
    // Reported, not hidden: the confirm screen names what was removed.
    expect(fetched.strippedSymlinks.map((l) => l.path).sort()).toEqual([
      'link-out',
      'nested/rel-out',
    ]);

    expect(await registerImportedSkill(registrationFor(fetched))).toMatchObject({ ok: true, id: 'sneaky' });
    expect(walk(path.join(storeRoot, 'sneaky'))).toEqual(['SKILL.md']);
    expect(fs.existsSync(path.join(storeRoot, 'sneaky', 'link-out'))).toBe(false);
  });

  it('refuses a payload that never went through the safety pass', async () => {
    // The last gate. It refuses rather than stripping quietly, because the user
    // has just been shown a disclosure listing what was removed, and silently
    // removing more would make that list a lie.
    const staging = path.join(scratch('unsafe'), 'skill');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'SKILL.md'), skillMd('unsafe', 'Hand-built.'));
    fs.mkdirSync(path.join(staging, 'nested'));
    fs.symlinkSync('/etc/passwd', path.join(staging, 'nested', 'leak'));

    const result = await registerImportedSkill({
      id: 'unsafe',
      stagingDir: staging,
      source: { kind: 'local-folder', localPath: staging },
      declared: { name: 'unsafe' },
      aliasOfDirName: false,
      upstreamBlobs: {},
      fileCount: 1,
      execCount: 0,
      importedVia: 'ui',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nested/leak');
    expect((await readSkillsState()).skills['unsafe']).toBeUndefined();
    expect(fs.existsSync(path.join(storeRoot, 'unsafe'))).toBe(false);
    // Refused, not consumed: the staged tree is still where the caller left it.
    expect(fs.existsSync(staging)).toBe(true);
  });
});

describe('registerImportedSkill — id collisions', () => {
  /**
   * THE RULE, stated once: a collision REFUSES. It never renames silently and
   * never replaces. §7 of the design doc leaves this open; refusing is the
   * least destructive of the three options, because the id is what the model
   * types into `Skill({skill})` and what the skill's own prose refers to — a
   * silent suffix ships a skill whose body names something that does not
   * exist, and a silent replace destroys an existing skill behind a button
   * labelled "Import". The caller pairs this with `resolveImportId`, which
   * offers a free id the user can accept in one click.
   */
  it('refuses rather than replacing, and offers a free id instead', async () => {
    await createSkill('shared-name', { description: 'Mine, written here.' });
    const mineBefore = fs.readFileSync(path.join(storeRoot, 'shared-name', 'SKILL.md'), 'utf-8');

    const src = buildFolder({
      id: 'shared-name',
      files: { 'SKILL.md': skillMd('shared-name', 'Theirs, from a repository.') },
    });
    const fetched = await importLocalFolder(src, scratch('staged'));

    const refused = await registerImportedSkill(registrationFor(fetched));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('already exists');
    // The existing skill is untouched, and it is still custom rather than
    // silently retagged as an import.
    expect(fs.readFileSync(path.join(storeRoot, 'shared-name', 'SKILL.md'), 'utf-8')).toBe(mineBefore);
    expect((await readSkillsState()).skills['shared-name']!.origin).toBe('custom');

    // What the UI offers instead. `-<owner>` is unavailable for a local folder,
    // so it falls through to the numeric suffix — either way it is a free id
    // the user accepts explicitly, never one applied for them.
    const state = await readSkillsState();
    const decision = resolveImportId(fetched.id, fetched.source, Object.keys(state.skills));
    expect(decision).toMatchObject({ id: 'shared-name', collides: true, suggestedId: 'shared-name-2' });

    const accepted = await registerImportedSkill(
      registrationFor(fetched, { id: decision.suggestedId! }),
    );
    expect(accepted).toMatchObject({ ok: true, id: 'shared-name-2' });
    // Renaming the STORE entry does not rewrite the skill's files, so the
    // import still reads unmodified against its own baseline.
    expect(fs.readFileSync(path.join(storeRoot, 'shared-name-2', 'SKILL.md'), 'utf-8'))
      .toContain('Theirs, from a repository.');
    expect((await listSkills()).find((s) => s.id === 'shared-name-2')!.modified).toBe(false);
  });

  it('refuses against a removed built-in, whose record a restore still needs', async () => {
    // A `removed: true` entry has no directory, so an existence check alone
    // would let an import land on top of it — and quietly forfeit the built-in,
    // because `restoreAllBuiltins` works from exactly that record.
    const stateFile = path.join(userData, 'skills-state.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
      skills: Record<string, unknown>;
    };
    raw.skills['ghost'] = { origin: 'builtin', enabled: true, removed: true };
    fs.writeFileSync(stateFile, JSON.stringify(raw));

    const src = buildFolder({
      id: 'ghost',
      files: { 'SKILL.md': skillMd('ghost', 'Would overwrite a removed built-in.') },
    });
    const fetched = await importLocalFolder(src, scratch('staged'));

    const result = await registerImportedSkill(registrationFor(fetched));
    expect(result.ok).toBe(false);
    const entry = (await readSkillsState()).skills['ghost']!;
    expect(entry.origin).toBe('builtin');
    expect(entry.removed).toBe(true);
  });
});

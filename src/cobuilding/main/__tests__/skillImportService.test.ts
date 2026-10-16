/**
 * @jest-environment node
 *
 * The import FLOW — the layer every IPC handler actually calls.
 *
 * `skillImporter.test.ts` proves the fetch is safe and
 * `skillImportRegistration.test.ts` proves the record is right, but both call
 * their subject directly. Between them sits `skillImportService`, which is what
 * `skills:previewImport` and `skills:import` invoke, and which owns the two
 * caches and the temp-directory lifetime. Its failure modes are its own:
 *
 *  - a preview that throws must not leave anything behind,
 *  - a commit must be the ONE path to `registerImportedSkill` for all three
 *    sources, so the roster rule cannot be reached around,
 *  - and the catalogue cache must never serve one repository's bytes for
 *    another's request.
 *
 * Nothing below `net.fetch` is mocked: real tarballs, a real `/usr/bin/tar`, a
 * real state file through `manifestIO`, and the real `buildSkillRuntimeConfig`
 * reading back what was written.
 */
import { describeMac, itMac } from '../../../test/platform';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-svc-'));
const userData = path.join(tmpRoot, 'userData');
const appRoot = path.join(tmpRoot, 'app');
const storeRoot = path.join(userData, 'skills');

/**
 * The temp directory the service really works in.
 *
 * Not scoped per worker, deliberately, after trying: `os.tmpdir()` here does
 * NOT follow `TMPDIR`, so redirecting it does not move the service's output —
 * it only moves where the assertions look, which turns every leak check into a
 * check that passes because it is reading an empty directory. The isolation is
 * done by choosing race-free observations instead; see `leakedStagingDirs`.
 */
const realTmp = os.tmpdir();

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

import { buildSkillRuntimeConfig } from '../../shared/skills';
import {
  commitImport,
  disposeImportCaches,
  loadCatalogue,
  parseImportUrl,
  previewImport,
  type ImportRequest,
} from '../knowledge/skillImportService';
import { readSkillsState } from '../skillStore';

const scratch = (name: string) => path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
  fs.mkdirSync(path.join(appRoot, 'src', 'cobuilding', 'skills'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
});

afterEach(async () => {
  await disposeImportCaches();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}

function buildFolder(opts: {
  id: string;
  files: Record<string, string>;
  symlinks?: Record<string, string>;
}): string {
  const dir = path.join(scratch('src'), opts.id);
  for (const [rel, contents] of Object.entries(opts.files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
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
  sha: string;
  files: Record<string, string>;
  symlinks?: Record<string, string>;
}): string {
  const stage = scratch('archive');
  const root = path.join(stage, `${opts.repo}-${opts.sha}`);
  for (const [rel, contents] of Object.entries(opts.files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  for (const [rel, target] of Object.entries(opts.symlinks ?? {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync(target, abs);
  }
  const tarPath = path.join(stage, 'repo.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', stage, `${opts.repo}-${opts.sha}`]);
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

/**
 * Everything in a tree, tagged by kind, so an assertion can tell a real file
 * from a directory from a surviving symlink.
 */
function entriesUnder(dir: string, rel = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) return [`link:${relPath}`];
    if (!e.isDirectory()) return [relPath];
    const nested = entriesUnder(path.join(dir, e.name), relPath);
    return nested.length ? nested : [`dir:${relPath}`];
  });
}

/**
 * Staging parents the service has left in tmp.
 *
 * `acabox-import-` is created in exactly one place in the codebase —
 * `skillImportService.stagingDir()` — and this is the only suite that drives
 * the service, so counting these in the shared tmpdir is safe even with jest
 * running suites in parallel. (`acabox-skill-` and `acabox-catalogue-` are NOT
 * safe to count: `skillImporter.test.ts` creates those at the same time in
 * another worker.)
 */
function leakedStagingDirs(): string[] {
  return fs.readdirSync(realTmp).filter((n) => n.startsWith('acabox-import-')).sort();
}

/**
 * The unpacked catalogue holding `rel`, identified by its CONTENTS rather than
 * by counting directories — a count would race with the other suite, whereas
 * "the tree containing my fixture's SKILL.md" is unambiguously mine.
 */
function catalogueDirHolding(rel: string): string | undefined {
  return fs
    .readdirSync(realTmp)
    .filter((n) => n.startsWith('acabox-catalogue-'))
    .map((n) => path.join(realTmp, n))
    .find((d) => fs.existsSync(path.join(d, 'tree', ...rel.split('/'))));
}

// ---------------------------------------------------------------------------

describe('a failed import leaves nothing behind', () => {
  /**
   * The store is the thing that must not be damaged, but the temp directories
   * matter too: nothing else ever cleans them. `disposeImportCaches` walks the
   * staged-skill MAP, and a stage that threw never got into it — so if the
   * failure path does not clean up after itself, no later code can.
   */
  const cases: [string, () => ImportRequest, RegExp][] = [
    [
      'a subpath with no SKILL.md',
      () => {
        mockNetFetch = async () =>
          serveFile(
            buildArchive({
              repo: 'plain',
              sha: SHA_A,
              files: { 'docs/readme.md': '# not a skill\n' },
            }),
          );
        return { kind: 'github-subdir', owner: 'someone', repo: 'plain', sha: SHA_A, subpath: 'docs' } as ImportRequest;
      },
      /not a skill/i,
    ],
    [
      'a subpath that does not exist in the archive',
      () => {
        mockNetFetch = async () =>
          serveFile(
            buildArchive({
              repo: 'plain2',
              sha: SHA_A,
              files: { 'skills/real/SKILL.md': skillMd('real', 'Fine.') },
            }),
          );
        return { kind: 'github-subdir', owner: 'someone', repo: 'plain2', sha: SHA_A, subpath: 'skills/absent' } as ImportRequest;
      },
      /does not exist/i,
    ],
    [
      'a 404 from codeload',
      () => {
        mockNetFetch = async () => ({ ok: false, status: 404, headers: { get: () => null } });
        return { kind: 'github-subdir', owner: 'someone', repo: 'gone', sha: SHA_A, subpath: 'skills/x' } as ImportRequest;
      },
      /has no commit|private/i,
    ],
    [
      'the network being down',
      () => {
        mockNetFetch = async () => {
          throw new Error('getaddrinfo ENOTFOUND codeload.github.com');
        };
        return { kind: 'github-subdir', owner: 'someone', repo: 'offline', sha: SHA_A, subpath: 'skills/x' } as ImportRequest;
      },
      /ENOTFOUND/,
    ],
    [
      'a local folder that is not a skill',
      () => {
        const dir = buildFolder({ id: 'no-skill-md', files: { 'readme.md': 'nope\n' } });
        return { kind: 'local-folder', localPath: dir } as ImportRequest;
      },
      /not a skill/i,
    ],
    [
      'a local folder that does not exist',
      () => ({ kind: 'local-folder', localPath: path.join(tmpRoot, 'nowhere') }) as ImportRequest,
      /not a directory/i,
    ],
  ];
  const run = async ([_label, setup, expected]: [string, () => ImportRequest, RegExp]) => {
    const tempBefore = leakedStagingDirs();
    const storeBefore = fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot).sort() : [];
    const stateBefore = Object.keys((await readSkillsState()).skills).sort();

    const request = setup();
    await expect(previewImport(request)).rejects.toThrow(expected);

    // Committing without a preview stages the same way, so it must fail the
    // same way — a caller that skipped step 3 cannot reach a different outcome.
    await expect(commitImport(request)).rejects.toThrow(expected);

    expect(fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot).sort() : []).toEqual(storeBefore);
    expect(Object.keys((await readSkillsState()).skills).sort()).toEqual(stateBefore);
    expect(leakedStagingDirs()).toEqual(tempBefore);
  };
  // The first two cases extract a real archive with /usr/bin/tar (bsdtar flags).
  for (const c of cases.slice(0, 2)) {
    itMac('bsdtar flags are rejected by GNU tar', `${c[0]}: no store directory, no state entry, no temp directory`, () => run(c));
  }
  for (const c of cases.slice(2)) {
    it(`${c[0]}: no store directory, no state entry, no temp directory`, () => run(c));
  }
});

// ---------------------------------------------------------------------------

describe('one registration path, and the roster rule is behind it', () => {
  /**
   * `enabled: false` is enforced in main. The service builds the
   * `ImportRegistration` literal itself, so there is no field an IPC payload
   * could carry it in — this drives the real `commitImport` with hostile extra
   * keys on the request to prove none of them reach the record.
   */
  itMac('bsdtar flags are rejected by GNU tar', 'a GitHub import lands off the roster, whatever the request carries', async () => {
    mockNetFetch = async () =>
      serveFile(
        buildArchive({
          repo: 'kit',
          sha: SHA_A,
          files: { 'skills/gh-one/SKILL.md': skillMd('gh-one', 'From a repository.') },
        }),
      );

    const hostile = {
      kind: 'github-subdir',
      owner: 'someone',
      repo: 'kit',
      sha: SHA_A,
      subpath: 'skills/gh-one',
      // None of these exist on `ImportRequest`; a renderer can still send them.
      enabled: true,
      origin: 'builtin',
      baseline: {},
    } as unknown as ImportRequest;

    const result = await commitImport(hostile);
    expect(result).toMatchObject({ ok: true, id: 'gh-one' });

    const entry = (await readSkillsState()).skills['gh-one']!;
    expect(entry.enabled).toBe(false);
    expect(entry.origin).toBe('imported');
    // The enforcement that actually matters: absent from the roster the model
    // is given, so it cannot squeeze another skill's description out.
    expect(buildSkillRuntimeConfig(await readSkillsState())).not.toContain('gh-one');
  });

  it('a local-folder import lands off the roster too, by the same code', async () => {
    const dir = buildFolder({
      id: 'local-one',
      files: { 'SKILL.md': skillMd('local-one', 'From this machine.') },
    });

    const result = await commitImport({ kind: 'local-folder', localPath: dir });
    expect(result).toMatchObject({ ok: true, id: 'local-one' });

    const entry = (await readSkillsState()).skills['local-one']!;
    expect(entry.enabled).toBe(false);
    expect(entry.origin).toBe('imported');
    expect(entry.importedVia).toBe('ui');
    expect(entry.source).toEqual({ kind: 'local-folder', localPath: path.resolve(dir) });
    expect(buildSkillRuntimeConfig(await readSkillsState())).not.toContain('local-one');
  });
});

// ---------------------------------------------------------------------------

describe('the safety pass runs on the real import path', () => {
  itMac('bsdtar flags are rejected by GNU tar', 'strips an absolute symlink out of a tarball before anything is registered', async () => {
    mockNetFetch = async () =>
      serveFile(
        buildArchive({
          repo: 'evil',
          sha: SHA_A,
          files: { 'skills/trojan/SKILL.md': skillMd('trojan', 'Looks ordinary.') },
          symlinks: {
            'skills/trojan/home': '/Users',
            'skills/trojan/nested/escape': '../../../../../../etc/hosts',
          },
        }),
      );
    const request: ImportRequest = {
      kind: 'github-subdir',
      owner: 'someone',
      repo: 'evil',
      sha: SHA_A,
      subpath: 'skills/trojan',
    };

    // Disclosed on the confirm screen, by path and by target.
    const preview = await previewImport(request);
    expect(preview.strippedSymlinks.map((l) => l.path).sort()).toEqual(['home', 'nested/escape']);
    expect(preview.strippedSymlinks.find((l) => l.path === 'home')!.target).toBe('/Users');
    // …and the count the user is shown is the count of what is really there.
    expect(preview.fileCount).toBe(1);

    expect(await commitImport(request)).toMatchObject({ ok: true, id: 'trojan' });
    // The property is that no link survives into the store, not that the
    // directory that held one is also gone — `nested/` is left behind empty,
    // which costs nothing and is invisible to every hash and file count.
    expect(entriesUnder(path.join(storeRoot, 'trojan'))).toEqual(['SKILL.md', 'dir:nested']);
    expect(fs.existsSync(path.join(storeRoot, 'trojan', 'home'))).toBe(false);
  });

  /**
   * The local path resolves links instead of deleting them (`fsp.cp`'s
   * `dereference`), so the end state is the same — no link in the store — but
   * the bytes come along. Pinned because the two paths differing is exactly the
   * kind of thing a later edit would "unify" in the wrong direction.
   */
  it('leaves no symlink in the store from a local folder either', async () => {
    const target = path.join(scratch('outside'), 'secret.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'pointed at from outside the folder\n');

    const dir = buildFolder({
      id: 'local-linked',
      files: { 'SKILL.md': skillMd('local-linked', 'Has a link.') },
      symlinks: { 'refs/pulled-in': target },
    });

    const preview = await previewImport({ kind: 'local-folder', localPath: dir });
    // The link's bytes are counted as a file, so the disclosure is not silent
    // about them even though `strippedSymlinks` is empty.
    expect(preview.fileCount).toBe(2);

    expect(await commitImport({ kind: 'local-folder', localPath: dir })).toMatchObject({ ok: true });
    const pulled = path.join(storeRoot, 'local-linked', 'refs', 'pulled-in');
    expect(fs.lstatSync(pulled).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(pulled, 'utf-8')).toContain('pointed at from outside');
  });
});

// ---------------------------------------------------------------------------

describeMac('bsdtar flags are rejected by GNU tar', 'provenance is complete and points at real bytes', () => {
  it('records a 40-char SHA, the subpath, a resolving URL and every blob', async () => {
    const files = {
      'skills/provenanced/SKILL.md': skillMd('provenanced', 'Everything recorded.'),
      'skills/provenanced/scripts/run.py': 'print("hi")\n',
    };
    mockNetFetch = async () => serveFile(buildArchive({ repo: 'pin', sha: SHA_B, files }));

    // A branch name in, a commit SHA out — resolved before anything downloads.
    mockNetFetch = (() => {
      const tar = buildArchive({ repo: 'pin', sha: SHA_B, files });
      return async (url: string) => {
        if (url.startsWith('https://api.github.com/')) {
          return { ok: true, status: 200, headers: { get: () => null }, text: async () => SHA_B };
        }
        return serveFile(tar);
      };
    })();

    const parsed = await parseImportUrl('https://github.com/someone/pin/tree/main/skills/provenanced');
    expect(parsed.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.sha).not.toBe('main');
    expect(parsed.ref).toBe('main');
    expect(parsed.kind).toBe('skill');
    expect(parsed.url).toBe(`https://github.com/someone/pin/tree/${SHA_B}/skills/provenanced`);

    await commitImport({
      kind: 'github-subdir',
      owner: parsed.owner,
      repo: parsed.repo,
      sha: parsed.sha,
      ref: parsed.ref,
      subpath: parsed.subpath,
    });

    const entry = (await readSkillsState()).skills['provenanced']!;
    const src = entry.source!;
    expect(src.kind).toBe('github-subdir');
    expect(src.sha).toBe(SHA_B);
    expect(src.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(src.ref).toBe('main');
    expect(src.subpath).toBe('skills/provenanced');
    // The URL the row links to must name the pinned commit, never the branch —
    // a link to `/tree/main` stops describing what was imported the moment the
    // branch moves.
    expect(src.url).toBe(`https://github.com/someone/pin/tree/${SHA_B}/skills/provenanced`);
    expect(src.url).not.toContain('/main/');

    // Every file has an upstream blob SHA, which is what the update check diffs.
    expect(Object.keys(entry.upstreamBlobs!).sort()).toEqual(['SKILL.md', 'scripts/run.py']);
    for (const sha of Object.values(entry.upstreamBlobs!)) expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------

describeMac('bsdtar flags are rejected by GNU tar', 'the catalogue cache', () => {
  const catalogueTarget = (owner: string, repo: string, sha: string) => ({ owner, repo, sha, subpath: '' });

  it('never serves one repository for another at the same commit', async () => {
    // Forks share commit SHAs, so "same sha" is not "same repository". A cache
    // keyed on the SHA alone would hand the fork's browse the parent's list.
    const upstream = buildArchive({
      repo: 'skills',
      sha: SHA_A,
      files: { 'a-skill/SKILL.md': skillMd('a-skill', 'From upstream.') },
    });
    const fork = buildArchive({
      repo: 'skills',
      sha: SHA_A,
      files: { 'forked-skill/SKILL.md': skillMd('forked-skill', 'From the fork.') },
    });

    mockNetFetch = async () => serveFile(upstream);
    const first = await loadCatalogue(catalogueTarget('upstream-owner', 'skills', SHA_A));
    expect(first.skills.map((s) => s.id)).toEqual(['a-skill']);

    mockNetFetch = async () => serveFile(fork);
    const second = await loadCatalogue(catalogueTarget('fork-owner', 'skills', SHA_A));
    expect(second.owner).toBe('fork-owner');
    expect(second.skills.map((s) => s.id)).toEqual(['forked-skill']);
  });

  it('re-fetches when only the commit moved', async () => {
    const before = buildArchive({
      repo: 'moving',
      sha: SHA_A,
      files: { 'one/SKILL.md': skillMd('one', 'Old.') },
    });
    const after = buildArchive({
      repo: 'moving',
      sha: SHA_B,
      files: { 'one/SKILL.md': skillMd('one', 'New.'), 'two/SKILL.md': skillMd('two', 'Added.') },
    });

    mockNetFetch = async () => serveFile(before);
    expect((await loadCatalogue(catalogueTarget('o', 'moving', SHA_A))).skills).toHaveLength(1);

    mockNetFetch = async () => serveFile(after);
    expect((await loadCatalogue(catalogueTarget('o', 'moving', SHA_B))).skills).toHaveLength(2);
  });

  it('serves a repeat browse with no network, and frees the superseded tree', async () => {
    const first = buildArchive({
      repo: 'cached',
      sha: SHA_A,
      files: { 'one-uniquely-named/SKILL.md': skillMd('one', 'Cached.') },
    });
    mockNetFetch = async () => serveFile(first);
    await loadCatalogue(catalogueTarget('o', 'cached', SHA_A));
    const firstDir = catalogueDirHolding('one-uniquely-named/SKILL.md');
    expect(firstDir).toBeDefined();

    // The payoff: picking a second skill out of a browsed repository is local.
    mockNetFetch = async () => {
      throw new Error('the cache should have answered this without a download');
    };
    const again = await loadCatalogue(catalogueTarget('o', 'cached', SHA_A));
    expect(again.skills.map((s) => s.id)).toEqual(['one-uniquely-named']);
    expect(fs.existsSync(firstDir!)).toBe(true);

    // One unpacked repository at a time — 21 MB each, so browsing a second must
    // free the first rather than accumulate.
    mockNetFetch = async () =>
      serveFile(
        buildArchive({
          repo: 'other',
          sha: SHA_B,
          files: { 'two-uniquely-named/SKILL.md': skillMd('two', 'Second.') },
        }),
      );
    await loadCatalogue(catalogueTarget('o', 'other', SHA_B));
    expect(fs.existsSync(firstDir!)).toBe(false);

    const secondDir = catalogueDirHolding('two-uniquely-named/SKILL.md');
    expect(secondDir).toBeDefined();
    await disposeImportCaches();
    expect(fs.existsSync(secondDir!)).toBe(false);
  });

  it('attributes a pick to the catalogue it really came from', async () => {
    // `importedFrom` is the marketplace the user browsed. A fork at the same
    // commit is a DIFFERENT repository, so its import must not inherit the
    // parent's marketplace name.
    const marketplace = JSON.stringify({ name: 'upstream-curated', plugins: [] });
    mockNetFetch = async () =>
      serveFile(
        buildArchive({
          repo: 'shop',
          sha: SHA_A,
          files: {
            '.claude-plugin/marketplace.json': marketplace,
            'browsed/SKILL.md': skillMd('browsed', 'Picked out of a catalogue.'),
          },
        }),
      );
    const cat = await loadCatalogue(catalogueTarget('upstream-owner', 'shop', SHA_A));
    expect(cat.marketplaceName).toBe('upstream-curated');

    await commitImport({
      kind: 'github-subdir',
      owner: 'upstream-owner',
      repo: 'shop',
      sha: SHA_A,
      subpath: 'browsed',
    });
    expect((await readSkillsState()).skills['browsed']!.importedFrom).toBe('upstream-curated');

    // Same commit, different repository: a direct import, not that marketplace.
    mockNetFetch = async () =>
      serveFile(
        buildArchive({
          repo: 'shop',
          sha: SHA_A,
          files: { 'elsewhere/SKILL.md': skillMd('elsewhere', 'A fork, same commit.') },
        }),
      );
    await commitImport({
      kind: 'github-subdir',
      owner: 'fork-owner',
      repo: 'shop',
      sha: SHA_A,
      subpath: 'elsewhere',
    });
    expect((await readSkillsState()).skills['elsewhere']!.importedFrom).toBe('direct');
  });
});

// ---------------------------------------------------------------------------

describeMac('bsdtar flags are rejected by GNU tar', 'staging is not reused across a rename', () => {
  it('a second commit of the same request re-stages rather than registering nothing', async () => {
    // The staged tree is MOVED into the store, so the map entry it left behind
    // names a directory that no longer exists. Importing the same skill twice
    // under two names is an ordinary thing to do.
    mockNetFetch = (() => {
      const tar = buildArchive({
        repo: 'twice',
        sha: SHA_A,
        files: { 'skills/dup/SKILL.md': skillMd('dup', 'Imported twice.') },
      });
      return async () => serveFile(tar);
    })();
    const request: ImportRequest = {
      kind: 'github-subdir',
      owner: 'o',
      repo: 'twice',
      sha: SHA_A,
      subpath: 'skills/dup',
    };

    expect(await commitImport(request)).toMatchObject({ ok: true, id: 'dup' });
    expect(await commitImport(request, 'dup-again')).toMatchObject({ ok: true, id: 'dup-again' });
    expect(fs.readFileSync(path.join(storeRoot, 'dup-again', 'SKILL.md'), 'utf-8')).toContain('Imported twice.');
    expect((await readSkillsState()).skills['dup-again']!.enabled).toBe(false);
  });

  it('a successful commit leaves no temp directory behind', async () => {

    const before = leakedStagingDirs();
    mockNetFetch = async () =>
      serveFile(
        buildArchive({
          repo: 'tidy',
          sha: SHA_A,
          files: { 'skills/tidy-one/SKILL.md': skillMd('tidy-one', 'Cleans up.') },
        }),
      );
    const request: ImportRequest = {
      kind: 'github-subdir',
      owner: 'o',
      repo: 'tidy',
      sha: SHA_A,
      subpath: 'skills/tidy-one',
    };
    await previewImport(request);
    await commitImport(request);
    await disposeImportCaches();
    expect(leakedStagingDirs()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------

/**
 * The whole flow against real GitHub — the four gestures in order, with real
 * bytes.
 *
 * Everything above hands `net.fetch` a locally built archive, which proves the
 * logic but not that the URLs are the ones GitHub actually serves. This is the
 * only case that can fail if `codeload`'s layout, the tree-URL shape or the
 * `Accept: application/vnd.github.sha` contract ever changes. Skipped rather
 * than failed when the network is unreachable.
 */
describeMac('bsdtar flags are rejected by GNU tar', 'end to end against real GitHub', () => {
  let reachable = false;

  beforeAll(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      reachable = (await fetch('https://codeload.github.com/', { signal: controller.signal })).status > 0;
    } catch {
      reachable = false;
      // eslint-disable-next-line no-console
      console.warn('[skillImportService.test] no network — skipping the live GitHub case');
    } finally {
      // In a `finally`, or a DNS failure leaves a live 5s timer holding the
      // event loop open and jest complains about it after the run.
      clearTimeout(timer);
    }
    mockNetFetch = ((url: string, init?: unknown) =>
      fetch(url, init as RequestInit)) as unknown as typeof mockNetFetch;
  }, 20000);

  it(
    'browses a repository root, imports one skill off the roster, and records a URL that resolves',
    async () => {
      if (!reachable) return;
      const tempBefore = leakedStagingDirs();

      const parsed = await parseImportUrl('https://github.com/anthropics/skills');
      expect(parsed.kind).toBe('catalogue');
      expect(parsed.sha).toMatch(/^[0-9a-f]{40}$/);

      const catalogue = await loadCatalogue(parsed);
      expect(catalogue.skills.length).toBeGreaterThan(5);
      const pick = catalogue.skills.find((s) => s.id === 'pdf');
      expect(pick).toBeDefined();

      const request: ImportRequest = {
        kind: 'github-subdir',
        owner: parsed.owner,
        repo: parsed.repo,
        sha: parsed.sha,
        ref: parsed.ref,
        subpath: pick!.subpath,
      };

      // Picking out of a browsed catalogue is a local copy — asserted by
      // measuring, since "no further API calls" is the design's whole claim.
      const preview = await previewImport(request);
      expect(preview.id).toBe('pdf');
      expect(preview.frontmatterOk).toBe(true);
      expect(preview.skillMd).toContain('---');

      expect(await commitImport(request)).toMatchObject({ ok: true, id: 'pdf' });

      const entry = (await readSkillsState()).skills['pdf']!;
      expect(entry.enabled).toBe(false);
      expect(buildSkillRuntimeConfig(await readSkillsState())).not.toContain('pdf');
      expect(entry.source!.sha).toBe(parsed.sha);
      expect(entry.source!.url).toContain(parsed.sha);
      // A branch name must not survive anywhere in the pin.
      expect(entry.source!.url).not.toMatch(/\/tree\/(main|master|HEAD)\//);

      // The recorded link is the point of recording it: it has to open.
      const res = await fetch(entry.source!.url!, { redirect: 'follow' });
      expect(res.status).toBe(200);

      await disposeImportCaches();
      expect(leakedStagingDirs()).toEqual(tempBefore);
    },
    180000,
  );
});

// ---------------------------------------------------------------------------

/**
 * `asId` is free text from the renderer and it becomes a directory name, so it
 * is the one import input that could reach outside the store. `skillStorePath`
 * is a bare `path.join`, which means the refusal has to come from
 * `validateSkillId` — these pin that it does, at the service boundary rather
 * than in the form.
 */
describeMac('bsdtar flags are rejected by GNU tar', 'the store id is validated in main, not in the form', () => {
  /** A staged, perfectly ordinary skill; only `asId` is hostile. */
  function legitRequest(repo: string): ImportRequest {
    mockNetFetch = (() => {
      const tar = buildArchive({
        repo,
        sha: SHA_A,
        files: { 'skills/legit/SKILL.md': skillMd('legit', 'Ordinary skill.') },
      });
      return async () => serveFile(tar);
    })();
    return { kind: 'github-subdir', owner: 'o', repo, sha: SHA_A, subpath: 'skills/legit' };
  }

  it.each([
    '../../../../tmp/acabox-pwned',
    '..',
    'a/b',
    '/absolute',
    'has space',
    'Upper',
    'trailing-',
    'dot.name',
  ])('refuses %p without writing anything', async (asId) => {
    const request = legitRequest(`idcheck-${asId.replace(/\W/g, '')}`);
    const storeBefore = fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot).sort() : [];

    const result = await commitImport(request, asId);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot).sort() : []).toEqual(storeBefore);
    expect(fs.existsSync('/tmp/acabox-pwned')).toBe(false);
  });

  it('treats a blank override as "use the source directory name"', async () => {
    // Not a refusal: the field is prefilled with the source name, and clearing
    // it must not be a way to reach an unnamed skill.
    const result = await commitImport(legitRequest('idcheck-blank'), '   ');
    expect(result).toMatchObject({ ok: true, id: 'legit' });
    expect((await readSkillsState()).skills['legit']!.enabled).toBe(false);
  });
});

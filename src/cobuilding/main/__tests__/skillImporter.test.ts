/**
 * @jest-environment node
 *
 * The skill importer, exercised against REAL tarballs and a REAL bsdtar.
 *
 * Almost nothing here is mocked below the HTTP boundary, and that is
 * deliberate: every interesting property of this module is a property of what
 * `/usr/bin/tar` does with bytes GitHub produced. A mocked extractor would only
 * prove the mock agrees with itself, and the single most important test in the
 * file — that an absolute symlink planted in an archive does not survive onto
 * the user's disk — is meaningless unless a real tar really did materialise it
 * first.
 *
 * `net.fetch` is the one seam. Offline cases hand it bytes from a locally
 * crafted archive; the end-to-end case forwards it to Node's real `fetch` and
 * skips itself when the network is unreachable, so the suite still passes on a
 * plane.
 *
 * The node environment (not jsdom) is required: jsdom provides no `fetch`,
 * which the end-to-end case needs.
 */
import { describeMac } from '../../../test/platform';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Swapped per test. Named `mock*` so jest's hoisting allows the reference. */
let mockNetFetch: (url: string, init?: unknown) => Promise<unknown> = async () => {
  throw new Error('net.fetch was called by a test that did not expect network access');
};

jest.mock('electron', () => ({
  net: { fetch: (url: string, init?: unknown) => mockNetFetch(url, init) },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  checkForUpdate,
  fetchCatalogue,
  fetchSubtree,
  gitBlobSha,
  importFromCatalogue,
  importLocalFolder,
  parseGithubUrl,
  resolveImportId,
  resolveRef,
  scanTree,
  stripSymlinks,
  validateImportedSkill,
} from '../knowledge/skillImporter';
import { parseSkillFrontmatter, type SkillSource } from '../../shared/skills';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-importer-test-'));
const scratch = (name: string) => path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2)}`);

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures: real tarballs, built the way codeload builds them
// ---------------------------------------------------------------------------

/** codeload roots every entry at `<repo>-<sha>/`. Fixtures must match. */
const FAKE_SHA = 'a'.repeat(40);

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}

/**
 * Build a tarball whose layout matches a codeload archive, from a description
 * of files, exec bits and symlinks. Uses the real `/usr/bin/tar`, so what the
 * importer reads back is what a real archive would give it.
 */
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
  for (const rel of opts.exec ?? []) {
    fs.chmodSync(path.join(root, rel), 0o755);
  }
  for (const [rel, target] of Object.entries(opts.symlinks ?? {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync(target, abs);
  }
  const tarPath = path.join(stage, 'repo.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', stage, `${opts.repo}-${FAKE_SHA}`]);
  return tarPath;
}

/**
 * A minimal stand-in for the `Response` `downloadTarball` consumes: chunked
 * body, no `content-length`. That is not a simplification — codeload really
 * sends no length (measured), which is why progress reports bytes and never a
 * percentage.
 */
function serveFile(filePath: string, chunkSize = 8192) {
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
          const value = new Uint8Array(bytes.subarray(offset, offset + chunkSize));
          offset += chunkSize;
          return { done: false, value };
        },
      }),
    },
  };
}

function serveJson(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------

describe('parseGithubUrl', () => {
  it('reads a plain repository URL', () => {
    expect(parseGithubUrl('https://github.com/openai/plugins')).toEqual({
      owner: 'openai',
      repo: 'plugins',
      ref: undefined,
      subpath: '',
    });
  });

  it('reads a tree URL down to the skill directory', () => {
    expect(
      parseGithubUrl('https://github.com/openai/plugins/tree/a1b2c3d/plugins/airtable/skills/airtable-cli'),
    ).toEqual({
      owner: 'openai',
      repo: 'plugins',
      ref: 'a1b2c3d',
      subpath: 'plugins/airtable/skills/airtable-cli',
    });
  });

  it('walks a /blob/ URL up from SKILL.md to the skill directory', () => {
    // This is what you get by clicking the file in GitHub's UI, and the file
    // is not the skill — its parent is.
    expect(parseGithubUrl('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md')).toMatchObject({
      subpath: 'skills/pdf',
    });
  });

  it('accepts the owner/repo shorthand and a .git suffix', () => {
    expect(parseGithubUrl('anthropics/skills')).toMatchObject({ owner: 'anthropics', repo: 'skills' });
    expect(parseGithubUrl('https://github.com/anthropics/skills.git')).toMatchObject({ repo: 'skills' });
  });

  it('refuses anything that is not GitHub', () => {
    expect(parseGithubUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGithubUrl('https://evil.example/github.com/owner/repo')).toBeNull();
    expect(parseGithubUrl('')).toBeNull();
  });

  it('refuses a path that could escape the archive or confuse tar', () => {
    // bsdtar treats the member argument as a glob; a `*` would select a
    // different subtree than the one displayed to the user.
    expect(() => parseGithubUrl('https://github.com/o/r/tree/main/skills/*')).toThrow(/not allowed/);
    // `new URL` already collapses `..` in a pasted URL, so the traversal case
    // only reaches the guard through the shorthand form.
    expect(() => parseGithubUrl('o/r/tree/main/../../etc')).toThrow(/plain repository path/);
    expect(parseGithubUrl('https://github.com/o/r/tree/main/../../etc')).toBeNull();
  });
});

describe('gitBlobSha', () => {
  // Canonical git object ids. If these three ever disagree the update check is
  // comparing against something that is not a git blob SHA.
  it('reproduces git object ids for known content', () => {
    expect(gitBlobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(gitBlobSha(Buffer.alloc(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(gitBlobSha(Buffer.from('what is up, doc?'))).toBe('bd9dbf5aae1a3862dd1526723246b20206e5fc37');
  });

  it('hashes bytes, not text — a trailing newline changes the id', () => {
    expect(gitBlobSha(Buffer.from('hello'))).not.toBe(gitBlobSha(Buffer.from('hello\n')));
  });
});

describe('stripSymlinks', () => {
  it('removes a symlink and leaves its target alone', async () => {
    const dir = scratch('links');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'real.txt'), 'keep me');
    fs.symlinkSync('/etc/passwd', path.join(dir, 'link-out'));
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'nested', 'link-in'));

    const removed = await stripSymlinks(dir);

    expect(removed.map((r) => r.path).sort()).toEqual(['link-out', 'nested/link-in']);
    expect(fs.existsSync(path.join(dir, 'link-out'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'real.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync('/etc/passwd')).toBe(true);
  });

  it('does not follow a symlink to a directory while walking', async () => {
    // lstat, not stat: following would recurse into — and delete inside — a
    // directory that is not part of the skill.
    const outside = scratch('outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'bystander.txt'), 'untouched');

    const dir = scratch('linkdir');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'elsewhere'));

    await stripSymlinks(dir);

    expect(fs.existsSync(path.join(dir, 'elsewhere'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'bystander.txt'), 'utf8')).toBe('untouched');
  });
});

describe('scanTree', () => {
  it('counts files and exec bits', async () => {
    const dir = scratch('scan');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\n');
    fs.chmodSync(path.join(dir, 'scripts', 'run.sh'), 0o755);

    const scan = await scanTree(dir);

    expect(scan.fileCount).toBe(2);
    expect(scan.execPaths).toEqual(['scripts/run.sh']);
    expect(scan.execCount).toBe(1);
  });
});

describeMac('bsdtar flags are rejected by GNU tar', 'fetchSubtree', () => {
  /** Point net.fetch at a local archive, as if codeload had served it. */
  function serveArchive(tarPath: string): jest.Mock {
    const fetchMock = jest.fn(async (url: string) => {
      if (!url.startsWith('https://codeload.github.com/')) {
        throw new Error(`unexpected URL ${url}`);
      }
      return serveFile(tarPath);
    });
    mockNetFetch = fetchMock as unknown as typeof mockNetFetch;
    return fetchMock;
  }

  it('strips an absolute symlink that bsdtar really did materialise', async () => {
    // THE test this module exists for. bsdtar refuses `..` inside a path but
    // happily creates `link-out -> /etc/passwd`, and Acabox's reaper only ever
    // inspects workspace-ROOT links, so a nested one would survive every boot
    // as a live handle into the user's filesystem.
    const tarPath = buildArchive({
      repo: 'evil',
      files: {
        'skills/trap/SKILL.md': skillMd('trap', 'A skill with a link out of its own directory.'),
        'skills/trap/notes/keep.md': 'ordinary file',
      },
      symlinks: {
        'skills/trap/link-out': '/etc/passwd',
        'skills/trap/notes/rel-out': '../../../../../../etc/hosts',
      },
    });
    serveArchive(tarPath);

    // Prove the fixture is real: a bare extraction DOES produce working links.
    const control = scratch('control');
    fs.mkdirSync(control, { recursive: true });
    execFileSync('/usr/bin/tar', [
      '-xzf', tarPath, '-C', control, '--strip-components=3', `evil-${FAKE_SHA}/skills/trap`,
    ]);
    expect(fs.lstatSync(path.join(control, 'link-out')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(control, 'link-out'), 'utf8').length).toBeGreaterThan(0);

    const dest = scratch('trap');
    const result = await fetchSubtree(
      { owner: 'someone', repo: 'evil', sha: FAKE_SHA, subpath: 'skills/trap' },
      dest,
    );

    expect(result.strippedSymlinks.map((s) => s.path).sort()).toEqual(['link-out', 'notes/rel-out']);
    expect(result.strippedSymlinks.find((s) => s.path === 'link-out')?.target).toBe('/etc/passwd');
    expect(fs.existsSync(path.join(dest, 'link-out'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'notes', 'rel-out'))).toBe(false);
    // The real files survive, and the link targets are untouched.
    expect(result.fileCount).toBe(2);
    expect(fs.existsSync('/etc/passwd')).toBe(true);
  });

  it('extracts the subtree contents at the top level and counts executables', async () => {
    const tarPath = buildArchive({
      repo: 'plugins',
      files: {
        'plugins/airtable/skills/airtable-cli/SKILL.md': skillMd('airtable-cli', 'Query Airtable bases.'),
        'plugins/airtable/skills/airtable-cli/scripts/run.py': 'print("hi")\n',
        'plugins/airtable/skills/airtable-cli/references/api.md': 'reference',
        // A sibling skill that must NOT come along.
        'plugins/airtable/skills/other/SKILL.md': skillMd('other', 'Not this one.'),
      },
      exec: ['plugins/airtable/skills/airtable-cli/scripts/run.py'],
    });
    serveArchive(tarPath);

    const dest = scratch('airtable');
    const result = await fetchSubtree(
      {
        owner: 'openai',
        repo: 'plugins',
        sha: FAKE_SHA,
        subpath: 'plugins/airtable/skills/airtable-cli',
        ref: 'main',
      },
      dest,
    );

    // strip-components arithmetic: contents at the top, no nesting left over.
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'plugins'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'other'))).toBe(false);

    expect(result.id).toBe('airtable-cli');
    expect(result.fileCount).toBe(3);
    expect(result.execCount).toBe(1);
    expect(result.execPaths).toEqual(['scripts/run.py']);
    expect(result.problems).toEqual([]);
    expect(result.source).toMatchObject({
      kind: 'github-subdir',
      owner: 'openai',
      repo: 'plugins',
      ref: 'main',
      sha: FAKE_SHA,
      subpath: 'plugins/airtable/skills/airtable-cli',
    });
    expect(result.source.url).toContain(`/tree/${FAKE_SHA}/plugins/airtable/skills/airtable-cli`);
    // upstreamBlobs is filled from the archive bytes: no extra API call.
    expect(Object.keys(result.upstreamBlobs).sort()).toEqual(['SKILL.md', 'references/api.md', 'scripts/run.py']);
    expect(result.upstreamBlobs['SKILL.md']).toBe(
      gitBlobSha(fs.readFileSync(path.join(dest, 'SKILL.md'))),
    );
  });

  it('adopts the directory name and never rewrites a disagreeing frontmatter name', async () => {
    // 62 of 607 openai/plugins skills disagree. Rewriting the file to make
    // them agree would mark a pristine import MODIFIED the instant it lands.
    const body = skillMd('box-content-api', 'Work with Box content.');
    const tarPath = buildArchive({ repo: 'plugins', files: { 'skills/box/SKILL.md': body } });
    serveArchive(tarPath);

    const dest = scratch('box');
    const result = await fetchSubtree({ owner: 'o', repo: 'plugins', sha: FAKE_SHA, subpath: 'skills/box' }, dest);

    expect(result.id).toBe('box');
    expect(result.declared.name).toBe('box-content-api');
    expect(result.aliasOfDirName).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe(body);
  });

  it('refuses a directory with no SKILL.md, and leaves nothing behind', async () => {
    const tarPath = buildArchive({ repo: 'plugins', files: { 'docs/readme/README.md': 'not a skill' } });
    serveArchive(tarPath);

    const dest = scratch('notaskill');
    await expect(
      fetchSubtree({ owner: 'o', repo: 'plugins', sha: FAKE_SHA, subpath: 'docs/readme' }, dest),
    ).rejects.toThrow(/not a skill/);
    // A half-extracted directory would be adopted by the store's reconciler.
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('refuses a subpath that does not exist in the archive', async () => {
    const tarPath = buildArchive({ repo: 'plugins', files: { 'skills/a/SKILL.md': skillMd('a', 'A.') } });
    serveArchive(tarPath);

    await expect(
      fetchSubtree({ owner: 'o', repo: 'plugins', sha: FAKE_SHA, subpath: 'skills/missing' }, scratch('gone')),
    ).rejects.toThrow(/does not exist in plugins/);
  });

  it('refuses a SHA that has not been resolved', async () => {
    await expect(
      fetchSubtree({ owner: 'o', repo: 'r', sha: 'main', subpath: 'skills/a' }, scratch('unresolved')),
    ).rejects.toThrow(/not a resolved 40-character commit SHA/);
  });

  it('reports bytes received and never a percentage', async () => {
    // codeload sends no content-length, so there is no denominator. Reporting
    // one would be a fabricated status.
    const tarPath = buildArchive({ repo: 'r', files: { 'skills/a/SKILL.md': skillMd('a', 'A.') } });
    serveArchive(tarPath);

    const seen: Array<{ receivedBytes: number; totalBytes?: number }> = [];
    await fetchSubtree(
      { owner: 'o', repo: 'r', sha: FAKE_SHA, subpath: 'skills/a' },
      scratch('progress'),
      { onProgress: (p) => seen.push(p) },
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].receivedBytes).toBe(fs.statSync(tarPath).size);
    expect(seen.every((p) => p.totalBytes === undefined)).toBe(true);
  });
});

describe('importLocalFolder', () => {
  it('copies the folder and puts it through the same safety pass', async () => {
    const src = scratch('localsrc');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), skillMd('localsrc', 'A hand-written skill.'));
    fs.symlinkSync('/etc/hosts', path.join(src, 'sneaky'));

    const dest = scratch('localdest');
    const result = await importLocalFolder(src, dest);

    expect(result.source).toMatchObject({ kind: 'local-folder', localPath: src });
    // dereference: the link's BYTES came along, so there is nothing to strip.
    expect(result.strippedSymlinks).toEqual([]);
    expect(fs.lstatSync(path.join(dest, 'sneaky')).isSymbolicLink()).toBe(false);
    expect(result.fileCount).toBe(2);
  });
});

describe('validateImportedSkill', () => {
  const fm = (extra: Record<string, string> = {}) =>
    parseSkillFrontmatter(
      `---\nname: x\ndescription: ok\n${Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\nbody\n`,
    );

  it('passes a conformant skill', () => {
    expect(validateImportedSkill('airtable-cli', fm())).toEqual([]);
  });

  it('rejects an id the SDK already owns', () => {
    const problems = validateImportedSkill('simplify', fm());
    expect(problems).toEqual([{ level: 'error', message: expect.stringContaining('name of a built-in skill') }]);
  });

  it('rejects an id outside the spec charset', () => {
    expect(validateImportedSkill('Airtable_CLI', fm())[0]).toMatchObject({ level: 'error' });
  });

  it('warns rather than refusing on unreadable frontmatter', () => {
    // The CLI loads such a skill anyway, inventing a description from the
    // first heading. Refusing the import would hide that from the user.
    const broken = parseSkillFrontmatter('no frontmatter here\n');
    expect(broken.ok).toBe(false);
    const problems = validateImportedSkill('thing', broken);
    expect(problems).toHaveLength(1);
    expect(problems[0].level).toBe('warning');
  });

  it('warns when the description is past the spec cap', () => {
    const long = parseSkillFrontmatter(`---\nname: x\ndescription: "${'d'.repeat(1100)}"\n---\nbody\n`);
    expect(validateImportedSkill('thing', long)).toEqual([
      { level: 'warning', message: expect.stringContaining('1100 characters') },
    ]);
  });
});

describe('resolveImportId', () => {
  it('passes a free id straight through', () => {
    expect(resolveImportId('airtable-cli', { kind: 'github-subdir', owner: 'openai' }, ['pdf'])).toEqual({
      id: 'airtable-cli',
      collides: false,
    });
  });

  it('reports the anthropics/skills-vs-builtin collision and suggests an id, without applying it', () => {
    const decision = resolveImportId('pdf', { kind: 'github-subdir', owner: 'anthropics' }, ['pdf', 'docx']);
    expect(decision).toEqual({ id: 'pdf', collides: true, suggestedId: 'pdf-anthropics' });
  });

  it('falls back to a numeric suffix when the owner-suffixed id is taken too', () => {
    const decision = resolveImportId('pdf', { kind: 'github-subdir', owner: 'anthropics' }, ['pdf', 'pdf-anthropics']);
    expect(decision.suggestedId).toBe('pdf-2');
  });
});

describe('resolveRef', () => {
  it('spends no request when the ref is already a full SHA', async () => {
    const fetchMock = jest.fn();
    mockNetFetch = fetchMock as unknown as typeof mockNetFetch;
    // 60 requests per hour is the entire metadata budget; the update flow
    // re-resolves a SHA it already holds.
    expect(await resolveRef('o', 'r', 'B'.repeat(40).replace(/B/g, 'a'))).toBe('a'.repeat(40));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a branch to 40 characters', async () => {
    mockNetFetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => `${'b'.repeat(40)}\n`,
    })) as unknown as typeof mockNetFetch;

    expect(await resolveRef('anthropics', 'skills', 'main')).toBe('b'.repeat(40));
  });

  it('explains a rate limit instead of reporting HTTP 403', async () => {
    mockNetFetch = (async () =>
      serveJson({}, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
      })) as unknown as typeof mockNetFetch;

    await expect(resolveRef('o', 'r', 'main')).rejects.toThrow(/hourly request limit/);
  });
});

describe('checkForUpdate', () => {
  const source: SkillSource = {
    kind: 'github-subdir',
    owner: 'anthropics',
    repo: 'skills',
    ref: 'main',
    sha: 'c'.repeat(40),
    subpath: 'skills/pdf',
  };

  it('gives a per-file verdict from one metadata call', async () => {
    const fetchMock = jest.fn(async (_url: string) =>
      serveJson({
        sha: 'tree-sha',
        truncated: false,
        tree: [
          { path: 'scripts', type: 'tree', mode: '040000', sha: 'ignored' },
          { path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'AAAA' },
          { path: 'reference.md', type: 'blob', mode: '100644', sha: 'CHANGED' },
          { path: 'scripts/new.py', type: 'blob', mode: '100755', sha: 'NEW' },
        ],
      }),
    );
    mockNetFetch = fetchMock as unknown as typeof mockNetFetch;

    const report = await checkForUpdate(source, {
      'SKILL.md': 'aaaa',
      'reference.md': 'original',
      'gone.md': 'deadbeef',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/anthropics/skills/git/trees/main:skills%2Fpdf?recursive=1',
    );
    expect(report.upToDate).toBe(false);
    expect(report.files).toEqual([
      { path: 'SKILL.md', status: 'unchanged', upstreamSha: 'aaaa', pinnedSha: 'aaaa' },
      { path: 'gone.md', status: 'removed', pinnedSha: 'deadbeef' },
      { path: 'reference.md', status: 'changed', upstreamSha: 'changed', pinnedSha: 'original' },
      { path: 'scripts/new.py', status: 'added', upstreamSha: 'new' },
    ]);
    // Code-point order, so the list is the same on every machine.
    expect(report.files.map((f) => f.path)).toEqual([...report.files.map((f) => f.path)].sort());
  });

  it('reports up to date when every blob matches', async () => {
    mockNetFetch = (async () =>
      serveJson({
        sha: 't',
        tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'aaaa' }],
      })) as unknown as typeof mockNetFetch;

    const report = await checkForUpdate(source, { 'SKILL.md': 'aaaa' });
    expect(report.upToDate).toBe(true);
  });

  it('skips upstream symlinks instead of reporting a phantom deletion', async () => {
    // We strip symlinks on import, so a symlink upstream can never match
    // anything locally. Comparing it would report "removed" on every check
    // forever.
    mockNetFetch = (async () =>
      serveJson({
        sha: 't',
        tree: [
          { path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'aaaa' },
          { path: 'link', type: 'blob', mode: '120000', sha: 'linksha' },
        ],
      })) as unknown as typeof mockNetFetch;

    const report = await checkForUpdate(source, { 'SKILL.md': 'aaaa' });
    expect(report.skipped).toEqual(['link']);
    expect(report.upToDate).toBe(true);
  });

  it('refuses a truncated listing rather than diffing half a tree', async () => {
    mockNetFetch = (async () =>
      serveJson({ sha: 't', truncated: true, tree: [] })) as unknown as typeof mockNetFetch;

    await expect(checkForUpdate(source, {})).rejects.toThrow(/truncated/);
  });

  it('refuses a skill that did not come from GitHub', async () => {
    await expect(checkForUpdate({ kind: 'local-folder', localPath: '/tmp/x' }, {})).rejects.toThrow(
      /not imported from GitHub/,
    );
  });
});

describeMac('bsdtar flags are rejected by GNU tar', 'fetchCatalogue', () => {
  /**
   * A repo shaped like `openai/plugins`: a marketplace manifest whose entries
   * name a plugin DIRECTORY, with skills nested underneath.
   */
  function openaiShapedArchive(): string {
    return buildArchive({
      repo: 'plugins',
      files: {
        '.agents/plugins/marketplace.json': JSON.stringify({
          name: 'openai-curated',
          plugins: [
            { name: 'airtable', source: { source: 'local', path: './plugins/airtable' }, category: 'Data' },
            { name: 'linear', source: { source: 'local', path: './plugins/linear' }, category: 'Productivity' },
          ],
        }),
        'plugins/airtable/skills/airtable-cli/SKILL.md': skillMd('airtable-cli', 'Query Airtable bases.'),
        'plugins/airtable/skills/airtable-cli/references/api.md': 'ref',
        'plugins/airtable/skills/airtable-schema/SKILL.md': skillMd('airtable-schema', 'Inspect bases.'),
        'plugins/linear/skills/linear-cli/SKILL.md': skillMd('linear-cli', 'Work with Linear issues.'),
        'plugins/linear/skills/linear-cli/scripts/go.sh': '#!/bin/sh\n',
        // No manifest entry: renders with no plugin chip rather than a guess.
        'extras/orphan/SKILL.md': skillMd('orphan', 'Belongs to no plugin.'),
        'README.md': '# not a skill',
      },
      exec: ['plugins/linear/skills/linear-cli/scripts/go.sh'],
    });
  }

  beforeEach(() => {
    mockNetFetch = (async () => serveFile(openaiShapedArchive())) as unknown as typeof mockNetFetch;
  });

  it('enumerates every skill from one tarball with zero API calls', async () => {
    const fetchMock = jest.fn(async (_url: string) => serveFile(openaiShapedArchive()));
    mockNetFetch = fetchMock as unknown as typeof mockNetFetch;

    const catalogue = await fetchCatalogue({ owner: 'openai', repo: 'plugins', sha: FAKE_SHA, ref: 'main' });
    try {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('codeload.github.com');
      expect(catalogue.marketplaceName).toBe('openai-curated');
      expect(catalogue.skills.map((s) => s.subpath)).toEqual([
        'extras/orphan',
        'plugins/airtable/skills/airtable-cli',
        'plugins/airtable/skills/airtable-schema',
        'plugins/linear/skills/linear-cli',
      ]);
    } finally {
      await catalogue.dispose();
    }
  });

  it('carries the description, file counts and plugin decoration for the picker', async () => {
    const catalogue = await fetchCatalogue({ owner: 'openai', repo: 'plugins', sha: FAKE_SHA });
    try {
      const cli = catalogue.skills.find((s) => s.id === 'airtable-cli');
      expect(cli).toMatchObject({
        description: 'Query Airtable bases.',
        frontmatterOk: true,
        fileCount: 2,
        execCount: 0,
        plugin: 'airtable',
        category: 'Data',
      });
      expect(catalogue.skills.find((s) => s.id === 'linear-cli')).toMatchObject({ execCount: 1 });
      // No manifest entry means no chip — not a fabricated one.
      expect(catalogue.skills.find((s) => s.id === 'orphan')).toMatchObject({
        plugin: undefined,
        category: undefined,
      });
    } finally {
      await catalogue.dispose();
    }
  });

  it('reads the anthropics/skills manifest shape, where skills are listed explicitly', async () => {
    const tarPath = buildArchive({
      repo: 'skills',
      files: {
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'anthropic-agent-skills',
          plugins: [
            { name: 'document-skills', source: './', skills: ['./skills/pdf', './skills/xlsx'] },
            { name: 'example-skills', source: './', skills: ['./skills/mcp-builder'] },
          ],
        }),
        'skills/pdf/SKILL.md': skillMd('pdf', 'Work with PDFs.'),
        'skills/xlsx/SKILL.md': skillMd('xlsx', 'Work with spreadsheets.'),
        'skills/mcp-builder/SKILL.md': skillMd('mcp-builder', 'Build MCP servers.'),
      },
    });
    mockNetFetch = (async () => serveFile(tarPath)) as unknown as typeof mockNetFetch;

    const catalogue = await fetchCatalogue({ owner: 'anthropics', repo: 'skills', sha: FAKE_SHA });
    try {
      expect(catalogue.marketplaceName).toBe('anthropic-agent-skills');
      // `source: './'` would otherwise claim the whole repo for one plugin.
      expect(catalogue.skills.find((s) => s.id === 'pdf')?.plugin).toBe('document-skills');
      expect(catalogue.skills.find((s) => s.id === 'mcp-builder')?.plugin).toBe('example-skills');
    } finally {
      await catalogue.dispose();
    }
  });

  it('does not treat a skill’s own subdirectories as more skills', async () => {
    const tarPath = buildArchive({
      repo: 'r',
      files: {
        'skills/outer/SKILL.md': skillMd('outer', 'Outer.'),
        // skill-creator ships a template SKILL.md; it is documentation.
        'skills/outer/references/template/SKILL.md': skillMd('template', 'A template.'),
      },
    });
    mockNetFetch = (async () => serveFile(tarPath)) as unknown as typeof mockNetFetch;

    const catalogue = await fetchCatalogue({ owner: 'o', repo: 'r', sha: FAKE_SHA });
    try {
      expect(catalogue.skills.map((s) => s.subpath)).toEqual(['skills/outer']);
    } finally {
      await catalogue.dispose();
    }
  });

  it('imports a picked skill out of the staged archive with no further network', async () => {
    const fetchMock = jest.fn(async (_url: string) => serveFile(openaiShapedArchive()));
    mockNetFetch = fetchMock as unknown as typeof mockNetFetch;

    const catalogue = await fetchCatalogue({ owner: 'openai', repo: 'plugins', sha: FAKE_SHA, ref: 'main' });
    try {
      const dest = scratch('picked');
      const imported = await importFromCatalogue(catalogue, 'plugins/airtable/skills/airtable-cli', dest);

      expect(fetchMock).toHaveBeenCalledTimes(1); // still one, for the whole browse
      expect(imported.id).toBe('airtable-cli');
      expect(imported.source.subpath).toBe('plugins/airtable/skills/airtable-cli');
      expect(imported.source.sha).toBe(FAKE_SHA);
      expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'references', 'api.md'))).toBe(true);
    } finally {
      await catalogue.dispose();
    }
  });

  it('strips symlinks across the whole archive, not just the picked skill', async () => {
    // A catalogue is browsed by reading out of the staging tree, so a link
    // planted three directories away is still one we put on the user's disk.
    const tarPath = buildArchive({
      repo: 'r',
      files: { 'skills/a/SKILL.md': skillMd('a', 'A.') },
      symlinks: { 'skills/elsewhere/link': '/etc/passwd' },
    });
    mockNetFetch = (async () => serveFile(tarPath)) as unknown as typeof mockNetFetch;

    const catalogue = await fetchCatalogue({ owner: 'o', repo: 'r', sha: FAKE_SHA });
    try {
      expect(fs.existsSync(path.join(catalogue.stagingDir, 'skills', 'elsewhere', 'link'))).toBe(false);
    } finally {
      await catalogue.dispose();
    }
  });

  it('removes the staging directory on dispose', async () => {
    const catalogue = await fetchCatalogue({ owner: 'openai', repo: 'plugins', sha: FAKE_SHA });
    expect(fs.existsSync(catalogue.stagingDir)).toBe(true);
    await catalogue.dispose();
    expect(fs.existsSync(catalogue.stagingDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// One real fetch, against the real GitHub
// ---------------------------------------------------------------------------

/**
 * Everything above proves the module agrees with a tarball we built. This
 * proves it agrees with GitHub — and in particular that a git blob SHA
 * recomputed from codeload bytes equals the one the tree API reports, which is
 * the assumption the entire per-file update check rests on.
 *
 * Skipped, not failed, without a network. Two API requests per run against a
 * 60/hour unauthenticated budget.
 */
const REAL_OWNER = 'anthropics';
const REAL_REPO = 'skills';
const REAL_SUBPATH = 'skills/pdf';

async function online(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://codeload.github.com/', { signal: controller.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    // In a `finally`, or a DNS failure leaves a live 5s timer holding the
    // event loop open and jest complains about it after the run.
    clearTimeout(timer);
  }
}

describeMac('bsdtar flags are rejected by GNU tar', 'end to end against real GitHub', () => {
  let reachable = false;

  beforeAll(async () => {
    reachable = await online();
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn('[skillImporter.test] no network — skipping the live GitHub case');
    }
    mockNetFetch = ((url: string, init?: unknown) =>
      fetch(url, init as RequestInit)) as unknown as typeof mockNetFetch;
  }, 20000);

  it(
    'resolves a branch, fetches a real skill, and recomputes blob SHAs GitHub agrees with',
    async () => {
      if (!reachable) return;

      const sha = await resolveRef(REAL_OWNER, REAL_REPO, 'main');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      const dest = scratch('real-pdf');
      const skill = await fetchSubtree(
        { owner: REAL_OWNER, repo: REAL_REPO, sha, subpath: REAL_SUBPATH, ref: 'main' },
        dest,
      );

      expect(skill.id).toBe('pdf');
      expect(skill.frontmatter.ok).toBe(true);
      expect(skill.frontmatter.description).toBeTruthy();
      expect(skill.fileCount).toBeGreaterThan(5);
      expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
      expect(skill.problems.filter((p) => p.level === 'error')).toEqual([]);

      // The pin compared against itself must be clean on every file — which is
      // only true if our locally recomputed blob SHAs equal git's own.
      const report = await checkForUpdate(
        { ...skill.source, ref: sha },
        skill.upstreamBlobs,
      );
      expect(report.files.length).toBe(Object.keys(skill.upstreamBlobs).length);
      expect(report.files.filter((f) => f.status !== 'unchanged')).toEqual([]);
      expect(report.upToDate).toBe(true);
    },
    120000,
  );
});

/**
 * @jest-environment node
 *
 * The edit service against a real directory on disk, with a fake build that
 * records its calls and can be told to fail. One test uses the real esbuild.
 */
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import type { TextEditApplyResult, TextEditTarget } from '../../../shared/miniAppTextEdit';
import { createTextEditService } from '../textEditService';

const DIR = 'demo';

const APP = [
  'export default function App({ n }: { n: number }) {',
  '  return (',
  '    <main>',
  '      <h1>Gene explorer</h1>',
  '      <p>Showing <strong>{n}</strong> genes</p>',
  '      <footer>',
  '        Built with care',
  '      </footer>',
  '    </main>',
  '  );',
  '}',
  '',
].join('\n');

type BuildResult = { ok: boolean; error?: string; reason?: 'source-missing' };

let tmpRoot: string;
let workspace: string;
let counter = 0;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-textedit-'));
  workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(path.join(workspace, '.applications'), { recursive: true });
  counter = 0;
});

afterEach(() => {
  // A test may have made a directory read-only.
  const unlock = (dir: string) => {
    try {
      fs.chmodSync(dir, 0o755);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(dir, e.name));
    } catch { /* gone already */ }
  };
  unlock(tmpRoot);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Creates `.applications/<dir>/src/<name>` for each file; returns an absolute-path helper. */
function makeTool(files: Record<string, string>, dir = DIR): (name: string) => string {
  const src = path.join(workspace, '.applications', dir, 'src');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
    fs.writeFileSync(path.join(src, name), text);
  }
  return (name: string) => path.join(src, name);
}

function createFakeBuild() {
  const calls: string[] = [];
  let behaviour: (callNumber: number) => Promise<BuildResult> = async () => ({ ok: true });
  return {
    calls,
    set(fn: (callNumber: number) => Promise<BuildResult>) { behaviour = fn; },
    build: async (dirName: string): Promise<BuildResult> => {
      calls.push(dirName);
      return behaviour(calls.length);
    },
  };
}

function makeService(build = createFakeBuild(), getWorkspacePath: () => string | null = () => workspace) {
  const service = createTextEditService({ getWorkspacePath, build: build.build });
  return { service, build };
}

/** The stamp of the Nth `needle` in `text`, as esbuild would report it. */
function stamp(text: string, needle: string, nth = 1, relFile = 'src/App.tsx', dir = DIR): string {
  let index = -1;
  for (let i = 0; i < nth; i++) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`fixture has no occurrence ${nth} of ${needle}`);
  }
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return `.applications/${dir}/${relFile}:${line}:${index - (before.lastIndexOf('\n') + 1) + 1}`;
}

function nextId(): string {
  counter += 1;
  return `e${counter}-test`;
}

function request(text: string, elementSrc: string | null, tagName: string, ancestorSrcs: string[], newText: string, editId = nextId()) {
  return { text, elementSrc, tagName, ancestorSrcs, editId, newText };
}

/** An apply request for the page heading of APP. */
function headingRequest(newText: string, editId = nextId()) {
  return request('Gene explorer', stamp(APP, '<h1'), 'h1', [stamp(APP, '<main')], newText, editId);
}

function expectOkResult(r: TextEditApplyResult): Extract<TextEditApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.message}`);
  return r;
}

function expectApplyRefused(r: TextEditApplyResult, reason: string): Extract<TextEditApplyResult, { ok: false }> {
  if (r.ok) throw new Error(`expected ${reason}, got ok`);
  expect(r.reason).toBe(reason);
  return r;
}

function tempFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}

describe('apply', () => {
  it('writes exactly the expected file text, then builds once', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    const result = expectOkResult(await service.apply(DIR, headingRequest('Protein explorer', 'edit-1')));
    expect(result).toEqual({
      ok: true, editId: 'edit-1', location: { file: 'src/App.tsx', line: 4, kind: 'jsx-text' }, undoDepth: 1, sameElementScope: true,
    });
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP.replace('Gene explorer', 'Protein explorer'));
    expect(build.calls).toEqual([DIR]);
    expect(tempFilesIn(path.dirname(abs('App.tsx')))).toEqual([]);
  });

  it('keeps indentation, escapes what JSX text cannot hold, and folds newlines and tabs into spaces', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service } = makeService();
    const footer = request('Built with care', stamp(APP, '<footer'), 'footer', [stamp(APP, '<main')], 'Made <with> care\n& more\there');
    expectOkResult(await service.apply(DIR, footer));
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(
      APP.replace('        Built with care\n', '        Made &lt;with&gt; care &amp; more here\n'),
    );
  });

  it('allows deleting the text with an empty replacement', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service } = makeService();
    expectOkResult(await service.apply(DIR, headingRequest('')));
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP.replace('<h1>Gene explorer</h1>', '<h1></h1>'));
  });

  it('leaves the file alone when the same text is typed back', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    const before = fs.statSync(abs('App.tsx')).mtimeMs;
    const result = expectOkResult(await service.apply(DIR, headingRequest('Gene explorer')));
    expect(result.undoDepth).toBe(0);
    expect(fs.statSync(abs('App.tsx')).mtimeMs).toBe(before);
    expect(build.calls).toEqual([]);
  });

  it('preserves a byte order mark and CRLF line endings, changing only the literal', async () => {
    const crlf = String.fromCharCode(0xfeff) + APP.replace(/\n/g, '\r\n');
    const abs = makeTool({ 'App.tsx': crlf });
    const { service } = makeService();
    expectOkResult(await service.apply(DIR, request('Gene explorer', stamp(crlf, '<h1'), 'h1', [], 'Protein explorer')));
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(crlf.replace('Gene explorer', 'Protein explorer'));
  });

  it('keeps the file permissions, including bits the umask would clear', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    fs.chmodSync(abs('App.tsx'), 0o775);
    const { service } = makeService();
    expectOkResult(await service.apply(DIR, headingRequest('Protein explorer')));
    expect(fs.statSync(abs('App.tsx')).mode & 0o777).toBe(0o775);

    fs.chmodSync(abs('App.tsx'), 0o600);
    expectOkResult(await service.apply(DIR, request('Protein explorer', stamp(APP, '<h1'), 'h1', [], 'Gene explorer again')));
    expect(fs.statSync(abs('App.tsx')).mode & 0o777).toBe(0o600);
  });

  it('writes source that the real compiler accepts, and the tool then shows exactly the new text', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service } = makeService();
    const newText = 'Say "hi" & {wave} ' + String.fromCodePoint(0x1f44b);
    expectOkResult(await service.apply(DIR, headingRequest(newText)));
    const written = fs.readFileSync(abs('App.tsx'), 'utf8');
    const out = esbuild.transformSync(written, { loader: 'tsx', jsx: 'transform', jsxFactory: '__h' }).code;
    const __h = (type: string, props: unknown, ...children: unknown[]) => ({ type, children });
    const shown = vm.runInNewContext(out.replace('export default function App', 'function App') + '\nApp({ n: 3 });', { __h }) as {
      children: Array<{ type: string; children: unknown[] }>;
    };
    expect(shown.children[0]).toEqual({ type: 'h1', children: [newText] });
    expect(written).not.toContain('Gene explorer');
  });

  it('reports a refusal as is, with the current undo depth, and writes nothing', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    expectOkResult(await service.apply(DIR, headingRequest('Protein explorer')));
    const before = fs.readFileSync(abs('App.tsx'), 'utf8');
    const refused = expectApplyRefused(await service.apply(DIR, request('312', stamp(APP, '<strong'), 'strong', [], 'x', 'edit-9')), 'computed');
    expect(refused).toMatchObject({ editId: 'edit-9', undoDepth: 1 });
    expect(refused.message).toMatch(/produced by the tool's code while it runs/);
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(before);
    expect(build.calls).toHaveLength(1);
  });

  it('refuses when the text is no longer in the source, and writes nothing', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    const moved = APP.replace('Gene explorer', 'Something else entirely');
    fs.writeFileSync(abs('App.tsx'), moved);
    expectApplyRefused(await service.apply(DIR, headingRequest('Protein explorer')), 'computed');
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(moved);
    expect(build.calls).toEqual([]);
  });

  it('reports changed, and writes nothing, when the file changes between reading and writing', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    const external = APP + '// edited by someone else\n';
    // The service reads through live bindings to the real module, so spy on that, not on this file's namespace copy.
    const realFsp = jest.requireActual('fs/promises') as typeof fsp;
    const real = realFsp.readFile;
    let reads = 0;
    const spy = jest.spyOn(realFsp, 'readFile').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      // The first read of App.tsx finds the tool; the second is the check just before the write.
      if (p === abs('App.tsx') && ++reads === 2) fs.writeFileSync(abs('App.tsx'), external);
      return (real as (...args: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as unknown as typeof fsp.readFile);
    try {
      const refused = expectApplyRefused(await service.apply(DIR, headingRequest('Protein explorer')), 'changed');
      expect(refused.message).toMatch(/changed while this edit was being made/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(external);
    expect(build.calls).toEqual([]);
  });

  it('reports invalid, and builds nothing, when the file cannot be written', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    fs.chmodSync(path.dirname(abs('App.tsx')), 0o555);
    const refused = expectApplyRefused(await service.apply(DIR, headingRequest('Protein explorer')), 'invalid');
    expect(refused.message).toMatch(/Couldn't save the change/);
    fs.chmodSync(path.dirname(abs('App.tsx')), 0o755);
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP);
    expect(build.calls).toEqual([]);
    expect(tempFilesIn(path.dirname(abs('App.tsx')))).toEqual([]);
  });
});

describe('a build that fails', () => {
  it('puts the file back, builds again, and says build-failed with the first line of the error', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const build = createFakeBuild();
    build.set(async (n) => (n === 1 ? { ok: false, error: '\n\u001b[31m' + String.fromCharCode(0x2718) + ' [ERROR] Expected "}" but found end of file\u001b[0m\n  more detail\n' } : { ok: true }));
    const { service } = makeService(build);
    const refused = expectApplyRefused(await service.apply(DIR, headingRequest('Protein explorer', 'edit-1')), 'build-failed');
    expect(refused).toMatchObject({ editId: 'edit-1', undoDepth: 0 });
    expect(refused.message).toContain('stopped the tool from building, so it was put back');
    expect(refused.message).toContain('[ERROR] Expected "}" but found end of file');
    expect(refused.message).not.toContain('more detail');
    expect(refused.message).not.toContain('\u001b');
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP);
    expect(build.calls).toEqual([DIR, DIR]);
  });

  it('treats a build that throws the same way', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const build = createFakeBuild();
    build.set(async (n) => { if (n === 1) throw new Error('esbuild vanished'); return { ok: true }; });
    const { service } = makeService(build);
    const refused = expectApplyRefused(await service.apply(DIR, headingRequest('Protein explorer')), 'build-failed');
    expect(refused.message).toContain('esbuild vanished');
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP);
  });

  it('does not count a build that was never attempted (source-missing) as a failure', async () => {
    makeTool({ 'App.tsx': APP });
    const build = createFakeBuild();
    build.set(async () => ({ ok: false, reason: 'source-missing' }));
    const { service } = makeService(build);
    expect(expectOkResult(await service.apply(DIR, headingRequest('Protein explorer'))).undoDepth).toBe(1);
    expect(build.calls).toHaveLength(1);
  });
});

describe('probe', () => {
  it('answers editable with the location, and never writes or builds', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    const before = fs.statSync(abs('App.tsx'));
    const editable = await service.probe(DIR, { text: 'Gene explorer', elementSrc: stamp(APP, '<h1'), tagName: 'h1', ancestorSrcs: [] });
    expect(editable).toEqual({ editable: true, location: { file: 'src/App.tsx', line: 4, kind: 'jsx-text' } });
    const refused = await service.probe(DIR, { text: '312', elementSrc: stamp(APP, '<strong'), tagName: 'strong', ancestorSrcs: [] });
    expect(refused).toMatchObject({ editable: false, reason: 'computed' });
    const after = fs.statSync(abs('App.tsx'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP);
    expect(tempFilesIn(path.dirname(abs('App.tsx')))).toEqual([]);
    expect(build.calls).toEqual([]);
    expect(service.undoDepth(DIR)).toBe(0);
  });

  it('sees an edit made since the last click, because the file stat changes', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service } = makeService();
    const click = { text: 'Gene explorer', elementSrc: stamp(APP, '<h1'), tagName: 'h1', ancestorSrcs: [] };
    expect(await service.probe(DIR, click)).toMatchObject({ editable: true });
    fs.writeFileSync(abs('App.tsx'), APP.replace('Gene explorer', 'Renamed outside'));
    expect(await service.probe(DIR, click)).toMatchObject({ editable: false, reason: 'computed' });
  });
});

describe('undo', () => {
  it('restores the file exactly, latest edit first, then says there is nothing left', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    expectOkResult(await service.apply(DIR, headingRequest('Protein explorer', 'edit-1')));
    const afterFirst = fs.readFileSync(abs('App.tsx'), 'utf8');
    expectOkResult(await service.apply(DIR, request(' genes', stamp(APP, '<p'), 'p', [], ' proteins', 'edit-2')));
    expect(service.undoDepth(DIR)).toBe(2);

    expect(await service.undo(DIR)).toEqual({
      ok: true, editId: 'edit-2', location: { file: 'src/App.tsx', line: 5, kind: 'jsx-text' }, undoDepth: 1,
    });
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(afterFirst);
    expect(await service.undo(DIR)).toMatchObject({ ok: true, editId: 'edit-1', undoDepth: 0 });
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP);
    expect(build.calls).toHaveLength(4); // two edits, two undos
    expect(await service.undo(DIR)).toEqual({ ok: false, message: 'Nothing to undo.', undoDepth: 0 });
  });

  it('is refused after the file was changed from outside, and keeps their change', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    expectOkResult(await service.apply(DIR, headingRequest('Protein explorer')));
    const theirs = fs.readFileSync(abs('App.tsx'), 'utf8') + '// added by the agent\n';
    fs.writeFileSync(abs('App.tsx'), theirs);
    const result = await service.undo(DIR);
    expect(result).toEqual({
      ok: false, message: "The file has changed since that edit, so it can't be undone automatically.", undoDepth: 0,
    });
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(theirs);
    expect(build.calls).toHaveLength(1);
  });

  it('says so when the rebuild after an undo fails, since the text was put back anyway', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const build = createFakeBuild();
    const { service } = makeService(build);
    expectOkResult(await service.apply(DIR, headingRequest('Protein explorer')));
    build.set(async () => ({ ok: false, error: '[ERROR] disk is full' }));
    const result = await service.undo(DIR);
    expect(result).toMatchObject({ ok: false, undoDepth: 0 });
    expect((result as { message: string }).message).toMatch(/put back .* did not rebuild\. \[ERROR\] disk is full/);
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP);
  });

  it('keeps at most 50 edits', async () => {
    makeTool({ 'App.tsx': APP });
    const { service } = makeService();
    let current = 'Gene explorer';
    for (let i = 0; i < 53; i++) {
      const next = `Title ${i}`;
      expectOkResult(await service.apply(DIR, request(current, stamp(APP, '<h1'), 'h1', [], next)));
      current = next;
    }
    expect(service.undoDepth(DIR)).toBe(50);
  });
});

describe('ordering', () => {
  it('lands two concurrent applies to one tool, one after the other', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const log: string[] = [];
    const build = createFakeBuild();
    build.set(async (n) => {
      log.push(`start ${n}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      log.push(`end ${n}`);
      return { ok: true };
    });
    const { service } = makeService(build);
    const [first, second] = await Promise.all([
      service.apply(DIR, headingRequest('Protein explorer', 'edit-1')),
      service.apply(DIR, request('Built with care', stamp(APP, '<footer'), 'footer', [], 'Made with care', 'edit-2')),
    ]);
    expect(expectOkResult(first).undoDepth).toBe(1);
    expect(expectOkResult(second).undoDepth).toBe(2);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(
      APP.replace('Gene explorer', 'Protein explorer').replace('Built with care', 'Made with care'),
    );
  });

  it('does not let one tool wait for another tool\'s build', async () => {
    makeTool({ 'App.tsx': APP }, 'slowTool');
    makeTool({ 'App.tsx': APP }, 'fastTool');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service } = makeService({
      calls: [],
      set() { /* unused */ },
      build: async (dirName: string) => { if (dirName === 'slowTool') await gate; return { ok: true }; },
    });
    const slow = service.apply('slowTool', request('Gene explorer', stamp(APP, '<h1', 1, 'src/App.tsx', 'slowTool'), 'h1', [], 'Slow title'));
    const fast = await service.apply('fastTool', request('Gene explorer', stamp(APP, '<h1', 1, 'src/App.tsx', 'fastTool'), 'h1', [], 'Fast title'));
    expect(expectOkResult(fast).undoDepth).toBe(1);
    release();
    expect(expectOkResult(await slow).undoDepth).toBe(1);
  });
});

describe('untrusted input', () => {
  const goodTarget: TextEditTarget = { text: 'Gene explorer', elementSrc: '.applications/demo/src/App.tsx:4:7', tagName: 'h1', ancestorSrcs: [] };
  const good = { ...goodTarget, editId: 'edit-1', newText: 'New' };

  it.each([
    ['a path traversal', '../x'], ['a shared folder', '_reusable'], ['a hidden folder', '.hidden'], ['a path with a slash', 'a/b'],
    ['an empty name', ''],
    ['a leading dash', '-demo'], ['too long', 'a'.repeat(101)], ['a number', 42], ['null', null], ['an object', { toString: () => DIR }],
  ])('refuses %s as a tool name, in all four calls, without touching anything', async (_label, bad) => {
    const abs = makeTool({ 'App.tsx': APP });
    // Each name that could be a path gets a real tool folder to point at, so only validation stops it.
    const decoys: string[] = [];
    if (typeof bad === 'string' && bad !== '') {
      const decoy = path.join(workspace, '.applications', bad, 'src', 'App.tsx');
      fs.mkdirSync(path.dirname(decoy), { recursive: true });
      fs.writeFileSync(decoy, APP);
      decoys.push(decoy);
    }
    const { service, build } = makeService();
    expectApplyRefused(await service.apply(bad, good), 'invalid');
    expect(await service.probe(bad, goodTarget)).toMatchObject({ editable: false, reason: 'invalid' });
    expect(await service.undo(bad)).toMatchObject({ ok: false });
    expect(service.undoDepth(bad)).toBe(0);
    for (const file of [abs('App.tsx'), ...decoys]) expect(fs.readFileSync(file, 'utf8')).toBe(APP);
    expect(build.calls).toEqual([]);
  });

  it('refuses every malformed request, with a message, without writing or building', async () => {
    const abs = makeTool({ 'App.tsx': APP });
    const { service, build } = makeService();
    const longText = 'x'.repeat(10_001);
    const cases: Array<[string, unknown]> = [
      ['a missing request', undefined], ['null', null], ['a string', 'text'], ['an array', [good]],
      ['no text', { ...good, text: undefined }], ['empty text', { ...good, text: '' }], ['whitespace-only text', { ...good, text: ' \n\t ' }],
      ['text that is not a string', { ...good, text: 7 }], ['text that is too long', { ...good, text: longText }],
      ['no newText', { ...good, newText: undefined }], ['newText that is not a string', { ...good, newText: 7 }],
      ['newText that is too long', { ...good, newText: 'x'.repeat(2001) }],
      ['no editId', { ...good, editId: undefined }], ['an editId with a slash', { ...good, editId: '../x' }],
      ['an empty editId', { ...good, editId: '' }], ['a 65 character editId', { ...good, editId: 'e'.repeat(65) }],
      ['an editId that is a number', { ...good, editId: 5 }],
      ['elementSrc that is undefined', { ...good, elementSrc: undefined }], ['elementSrc that is a number', { ...good, elementSrc: 5 }],
      ['elementSrc that is too long', { ...good, elementSrc: 'x'.repeat(401) }],
      ['no tagName', { ...good, tagName: undefined }], ['a tagName that is too long', { ...good, tagName: 'x'.repeat(41) }],
      ['no ancestorSrcs', { ...good, ancestorSrcs: undefined }], ['ancestorSrcs that is not an array', { ...good, ancestorSrcs: 'a' }],
      ['17 ancestorSrcs', { ...good, ancestorSrcs: Array.from({ length: 17 }, () => 'a') }],
      ['an ancestor that is not a string', { ...good, ancestorSrcs: [3] }],
      ['an ancestor that is too long', { ...good, ancestorSrcs: ['x'.repeat(401)] }],
    ];
    for (const [label, bad] of cases) {
      const result = await service.apply(DIR, bad);
      if (result.ok || result.reason !== 'invalid' || result.message === '') throw new Error(`${label}: expected a clear invalid refusal, got ${JSON.stringify(result)}`);
      const probed = await service.probe(DIR, bad);
      // A probe has no editId or newText, so only the target fields can fail it.
      if (probed.editable && !/editId|newText/.test(label)) throw new Error(`${label}: the probe accepted it`);
    }
    expect(fs.readFileSync(abs('App.tsx'), 'utf8')).toBe(APP);
    expect(build.calls).toEqual([]);
  });

  it('echoes a string editId even on a refusal, so the frame can match it', async () => {
    makeTool({ 'App.tsx': APP });
    const { service } = makeService();
    expect(await service.apply(DIR, { ...good, text: '' , editId: 'edit-77' })).toMatchObject({ ok: false, editId: 'edit-77' });
    expect(await service.apply(DIR, 'nonsense')).toMatchObject({ ok: false, editId: '' });
  });

  it('refuses when there is no workspace, no such tool, or no src folder', async () => {
    const none = makeService(createFakeBuild(), () => null).service;
    expect(await none.probe(DIR, goodTarget)).toMatchObject({ editable: false, reason: 'invalid', message: 'No workspace is open.' });
    const { service } = makeService();
    expect(await service.probe('ghost', goodTarget)).toMatchObject({ editable: false, reason: 'invalid' });
    fs.mkdirSync(path.join(workspace, '.applications', 'bare'), { recursive: true });
    expectApplyRefused(await service.apply('bare', good), 'invalid');
  });
});

describe('an unexpected failure', () => {
  it('comes back as a typed refusal, never as a rejected call', async () => {
    makeTool({ 'App.tsx': APP });
    const { service, build } = makeService(createFakeBuild(), () => { throw new Error('workspace lookup blew up'); });
    const probed = await service.probe(DIR, { text: 'Gene explorer', elementSrc: null, tagName: 'h1', ancestorSrcs: [] });
    expect(probed).toEqual({ editable: false, reason: 'invalid', message: 'Something went wrong while changing this text.' });
    const applied = await service.apply(DIR, headingRequest('Protein explorer', 'edit-1'));
    expect(applied).toEqual({
      ok: false, editId: 'edit-1', reason: 'invalid', message: 'Something went wrong while changing this text.', undoDepth: 0,
    });
    expect(build.calls).toEqual([]);
  });
});

describe('which files it reads', () => {
  it('ignores a symlinked file under src/, and never writes through it', async () => {
    const outside = path.join(tmpRoot, 'outside.tsx');
    fs.writeFileSync(outside, 'export const X = () => <p>Only in the link</p>;\n');
    const abs = makeTool({ 'App.tsx': APP });
    fs.symlinkSync(outside, abs('Link.tsx'));
    const { service, build } = makeService();
    const click = { text: 'Only in the link', elementSrc: stamp(APP, '<h1'), tagName: 'p', ancestorSrcs: [] };
    expect(await service.probe(DIR, click)).toMatchObject({ editable: false, reason: 'computed' });
    expectApplyRefused(await service.apply(DIR, { ...click, editId: 'e1', newText: 'Changed' }), 'computed');
    expect(fs.readFileSync(outside, 'utf8')).toBe('export const X = () => <p>Only in the link</p>;\n');
    expect(build.calls).toEqual([]);
  });

  it('ignores a symlinked directory, node_modules, dot-directories, other extensions and files that are not UTF-8', async () => {
    const elsewhere = path.join(tmpRoot, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'More.tsx'), 'export const M = () => <p>Hidden text</p>;\n');
    const abs = makeTool({
      'App.tsx': APP,
      'node_modules/pkg/index.js': 'export const a = () => <p>Hidden text</p>;\n',
      '.cache/Old.tsx': 'export const b = () => <p>Hidden text</p>;\n',
      'notes.md': '<p>Hidden text</p>\n',
      'styles.css': '.a::after { content: "Hidden text"; }\n',
    });
    fs.symlinkSync(elsewhere, abs('linked'));
    fs.writeFileSync(abs('Binary.tsx'), Buffer.concat([Buffer.from('export const c = () => <p>Hidden text</p>;\n'), Buffer.from([0xff, 0xfe, 0xfd])]));
    const { service } = makeService();
    const click = { text: 'Hidden text', elementSrc: stamp(APP, '<h1'), tagName: 'p', ancestorSrcs: [] };
    expect(await service.probe(DIR, click)).toMatchObject({ editable: false, reason: 'computed' });
  });

  it('refuses a tool whose src is a symlink, even to a folder inside the workspace', async () => {
    const real = path.join(workspace, '.applications', 'realTool', 'src');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'App.tsx'), APP);
    fs.mkdirSync(path.join(workspace, '.applications', 'linkedTool'), { recursive: true });
    fs.symlinkSync(real, path.join(workspace, '.applications', 'linkedTool', 'src'));
    const { service } = makeService();
    expect(await service.probe('linkedTool', { text: 'Gene explorer', elementSrc: null, tagName: 'h1', ancestorSrcs: [] }))
      .toMatchObject({ editable: false, reason: 'invalid' });
  });

  it('skips files over 2 MB', async () => {
    makeTool({ 'App.tsx': APP, 'Huge.tsx': `export const H = () => <p>Big file text</p>;\n${'// padding\n'.repeat(210_000)}` });
    const { service } = makeService();
    expect(await service.probe(DIR, { text: 'Big file text', elementSrc: stamp(APP, '<h1'), tagName: 'p', ancestorSrcs: [] }))
      .toMatchObject({ editable: false, reason: 'computed' });
  });

  it('reads a .d.ts file, so a literal type there makes a data label used-by-code', async () => {
    const data = 'export const tabs = [{ id: "ov", label: "Overview" }];\n';
    const app = 'import { tabs } from "./data";\nexport const A = () => <nav>{tabs.map((t) => <button key={t.id}>{t.label}</button>)}</nav>;\n';
    makeTool({ 'App.tsx': app, 'data.ts': data });
    const { service } = makeService();
    const click = { text: 'Overview', elementSrc: stamp(app, '<button'), tagName: 'button', ancestorSrcs: [] };
    expect(await service.probe(DIR, click)).toMatchObject({ editable: true, location: { file: 'src/data.ts', kind: 'object-property' } });
    fs.writeFileSync(path.join(workspace, '.applications', DIR, 'src', 'types.d.ts'), 'export type Tab = "Overview" | "Details";\n');
    expect(await service.probe(DIR, click)).toMatchObject({ editable: false, reason: 'used-by-code' });
  });

  it('edits a data label in a nested file and reports its path relative to the tool', async () => {
    const data = 'export const tabs = [{ id: "ov", label: \'Overview\' }];\n';
    const app = 'import { tabs } from "./lib/data";\nexport const A = () => <nav>{tabs.map((t) => <button key={t.id}>{t.label}</button>)}</nav>;\n';
    const abs = makeTool({ 'App.tsx': app, 'lib/data.ts': data });
    const { service } = makeService();
    const result = expectOkResult(await service.apply(DIR, request('Overview', stamp(app, '<button'), 'button', [], "Owner's view")));
    expect(result.location).toEqual({ file: 'src/lib/data.ts', line: 1, kind: 'object-property' });
    expect(fs.readFileSync(abs('lib/data.ts'), 'utf8')).toBe('export const tabs = [{ id: "ov", label: \'Owner\\\'s view\' }];\n');
  });
});

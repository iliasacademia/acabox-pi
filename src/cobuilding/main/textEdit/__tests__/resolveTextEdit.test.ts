/**
 * @jest-environment node
 *
 * Resolving a clicked text node to one literal in a tool's source. Fixtures are
 * in memory; stamps are computed from the fixture text the way esbuild computes
 * them (1-based line, 1-based UTF-16 column of the opening `<`), and one test
 * checks that convention against esbuild's real jsxDEV output.
 */
import * as esbuild from 'esbuild';
import * as tsModule from 'typescript';
import type { TextEditTarget } from '../../../shared/miniAppTextEdit';
import {
  parseSrcLoc,
  planTextEdit,
  resolveTextEdit,
  verifyPlannedEdit,
  type AppSource,
  type Resolution,
} from '../resolveTextEdit';

// Counts parses, so the cache can be tested. Everything else is the real compiler API.
jest.mock('typescript', () => {
  const actual = jest.requireActual('typescript');
  const parses = { count: 0 };
  return {
    ...actual,
    __parses: parses,
    createSourceFile: (...args: unknown[]) => {
      parses.count++;
      return actual.createSourceFile(...args);
    },
  };
});

const DIR = 'demo';
const NBSP = String.fromCharCode(0xa0);

function source(path: string, text: string): AppSource {
  return { path, text };
}

/** The stamp of the Nth occurrence of `needle` (an opening tag such as `<h1`) in `file`. */
function stamp(file: AppSource, needle: string, nth = 1, dir = DIR): string {
  let index = -1;
  for (let i = 0; i < nth; i++) {
    index = file.text.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`fixture has no occurrence ${nth} of ${needle}`);
  }
  const before = file.text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - (before.lastIndexOf('\n') + 1) + 1;
  return `.applications/${dir}/${file.path}:${line}:${col}`;
}

const REUSABLE_STAMP = '.applications/_reusable/Card.tsx:12:5';

function target(text: string, elementSrc: string | null, tagName = 'p', ancestorSrcs: string[] = []): TextEditTarget {
  return { text, elementSrc, tagName, ancestorSrcs };
}

function resolve(files: AppSource[], t: TextEditTarget): Resolution {
  return resolveTextEdit({ dirName: DIR, files, target: t });
}

function expectOk(r: Resolution): Resolution & { ok: true } {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.message}`);
  return r;
}

function expectRefused(r: Resolution, reason: string): Resolution & { ok: false } {
  if (r.ok) throw new Error(`expected ${reason}, got ok at ${r.file}:${r.start}`);
  expect(r.reason).toBe(reason);
  return r;
}

describe('parseSrcLoc', () => {
  it('splits on the last two colons', () => {
    expect(parseSrcLoc('.applications/demo/src/App.tsx:42:7')).toEqual({ file: '.applications/demo/src/App.tsx', line: 42, col: 7 });
    expect(parseSrcLoc('C:/work/App.tsx:3:9')).toEqual({ file: 'C:/work/App.tsx', line: 3, col: 9 });
    expect(parseSrcLoc('weird:name.tsx:1:1:5')).toEqual({ file: 'weird:name.tsx:1', line: 1, col: 5 });
  });

  it('rejects anything that is not file:line:col with positive integers', () => {
    for (const bad of ['', 'x', 'x:1', ':1:1', 'x::1', 'x:1:', 'x:a:b', 'x:0:1', 'x:1:0', 'x:-1:2', 'x:1.5:2', 'x:+1:2', 'x:01:2', 'x:1:2e3',
      'x:99999999999999999999:1', 'x: 1:2']) {
      expect(parseSrcLoc(bad)).toBeNull();
    }
    expect(parseSrcLoc(undefined as unknown as string)).toBeNull();
    expect(parseSrcLoc(42 as unknown as string)).toBeNull();
  });
});

describe('resolveTextEdit: what it can edit', () => {
  it('finds direct JSX text', () => {
    const app = source('src/App.tsx', `export default function App() {\n  return (\n    <main>\n      <h1>Gene explorer</h1>\n    </main>\n  );\n}\n`);
    const r = expectOk(resolve([app], target('Gene explorer', stamp(app, '<h1'), 'h1', [stamp(app, '<main')])));
    expect(r).toMatchObject({ file: 'src/App.tsx', kind: 'jsx-text', sameElementScope: true, original: 'Gene explorer' });
    expect(app.text.slice(r.start, r.end)).toBe('Gene explorer');
  });

  it('finds text on either side of an inline element', () => {
    const app = source('src/App.tsx', `export const A = () => <p>Showing <strong>{n}</strong> genes above threshold</p>;\n`);
    const p = stamp(app, '<p');
    const before = expectOk(resolve([app], target('Showing ', p)));
    const after = expectOk(resolve([app], target(' genes above threshold', p)));
    expect(before).toMatchObject({ kind: 'jsx-text', original: 'Showing ', sameElementScope: true });
    expect(after).toMatchObject({ kind: 'jsx-text', original: ' genes above threshold', sameElementScope: true });
  });

  it('matches multi-line JSX text by its folded value', () => {
    const app = source('src/App.tsx', `export const A = () => (\n  <p>\n    Line one of the text\n    continues here.\n  </p>\n);\n`);
    const r = expectOk(resolve([app], target('Line one of the text continues here.', stamp(app, '<p'))));
    expect(r.kind).toBe('jsx-text');
    expect(r.original).toBe('\n    Line one of the text\n    continues here.\n  ');
  });

  it('matches text through a component: <Card>Text</Card>', () => {
    const app = source('src/App.tsx', `export const A = () => <Card>Plain card text</Card>;\n`);
    const r = expectOk(resolve([app], target('Plain card text', REUSABLE_STAMP, 'div', [stamp(app, '<Card')])));
    expect(r).toMatchObject({ kind: 'jsx-text', original: 'Plain card text', sameElementScope: false });
  });

  it('matches an attribute on a component clicked on a shared element, with an ancestor stamp', () => {
    const app = source('src/App.tsx', `export const A = () => (\n  <section>\n    <Header title="Study overview" />\n  </section>\n);\n`);
    const r = expectOk(resolve([app], target('Study overview', REUSABLE_STAMP, 'h2', [stamp(app, '<section')])));
    expect(r).toMatchObject({ kind: 'jsx-attribute', original: '"Study overview"', sameElementScope: false });
  });

  it('matches either side of a conditional shown as a child', () => {
    const app = source('src/App.tsx', `export const A = ({ ok }) => <span>{ok ? "Ready" : 'Loading'}</span>;\n`);
    const span = stamp(app, '<span');
    expect(expectOk(resolve([app], target('Ready', span, 'span')))).toMatchObject({ kind: 'jsx-expression', original: '"Ready"', sameElementScope: false });
    expect(expectOk(resolve([app], target('Loading', span, 'span')))).toMatchObject({ kind: 'jsx-expression', original: "'Loading'" });
  });

  it('follows || and ?? either side, && on the right only, through parentheses and assertions', () => {
    const app = source('src/App.tsx', [
      'export const A = ({ a, b, ok }) => (',
      '  <div>',
      '    <i>{a || "Untitled"}</i>',
      '    <i>{b ?? ("Unnamed" as string)}</i>',
      '    <i>{ok && "Finished"}</i>',
      '    <i>{"Never shown" && ok}</i>',
      '  </div>',
      ');',
    ].join('\n'));
    expect(expectOk(resolve([app], target('Untitled', stamp(app, '<i', 1), 'i'))).kind).toBe('jsx-expression');
    expect(expectOk(resolve([app], target('Unnamed', stamp(app, '<i', 2), 'i'))).kind).toBe('jsx-expression');
    expect(expectOk(resolve([app], target('Finished', stamp(app, '<i', 3), 'i'))).kind).toBe('jsx-expression');
    expectRefused(resolve([app], target('Never shown', stamp(app, '<i', 4), 'i')), 'used-by-code');
  });

  it('matches a template literal with no substitutions shown as a child', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>{`Just text`}</p>;\n');
    expect(expectOk(resolve([app], target('Just text', stamp(app, '<p')))).original).toBe('`Just text`');
  });

  it('matches a string inside a JSX attribute expression', () => {
    const app = source('src/App.tsx', 'export const A = ({ a }) => <Panel title={a ? "Alpha view" : "Beta view"} />;\n');
    expect(expectOk(resolve([app], target('Beta view', REUSABLE_STAMP, 'h2', [stamp(app, '<Panel')]))).kind).toBe('jsx-attribute');
  });

  it('matches an object property value, which is how most tools write labels', () => {
    const app = source('src/App.tsx', [
      'const tabs = [{ id: "ov", label: "Overview" }, { id: "dt", label: "Details" }];',
      'export const A = () => <nav>{tabs.map((t) => <button key={t.id}>{t.label}</button>)}</nav>;',
    ].join('\n'));
    const r = expectOk(resolve([app], target('Details', stamp(app, '<button'), 'button', [stamp(app, '<nav')])));
    expect(r).toMatchObject({ kind: 'object-property', original: '"Details"', sameElementScope: false });
  });

  it('picks the label, not the id, when both hold the same text', () => {
    const app = source('src/App.tsx', [
      'const tabs = [{ id: "Overview", label: "Overview" }];',
      'export const A = () => <nav>{tabs.map((t) => <button key={t.id}>{t.label}</button>)}</nav>;',
    ].join('\n'));
    const r = expectOk(resolve([app], target('Overview', stamp(app, '<button'), 'button')));
    expect(r.kind).toBe('object-property');
    expect(app.text.slice(r.start - 'label: '.length, r.start)).toBe('label: ');
  });

  it('decodes entities, non-breaking spaces and emoji the way the compiler does', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>Fish &amp; Chips&nbsp;&mdash; &#x1F600; \u00e9\u{1f9ec}</p>;\n');
    const shown = 'Fish & Chips' + NBSP + '\u2014 ' + String.fromCodePoint(0x1f600) + ' \u00e9\u{1f9ec}';
    const r = expectOk(resolve([app], target(shown, stamp(app, '<p'))));
    expect(r.kind).toBe('jsx-text');
  });

  it('finds the element by its UTF-16 column after non-ASCII text on the same line', () => {
    // Two identical <b> on one line, so only an exact column can tell them apart.
    const app = source('src/App.tsx', 'export const A = () => <div><i>\u00e9\u2014\u{1f9ec}</i><b>Dup</b><b>Dup</b></div>;\n');
    const second = stamp(app, '<b', 2);
    const r = expectOk(resolve([app], target('Dup', second, 'b')));
    expect(r.sameElementScope).toBe(true);
    expect(r.start).toBe(app.text.lastIndexOf('Dup'));
  });

  it('reads a data file written in .ts', () => {
    const data = source('src/data.ts', 'export const rows = [{ name: "Alpha gene", count: 3 }];\n');
    const app = source('src/App.tsx', 'import { rows } from "./data";\nexport const A = () => <ul>{rows.map((r) => <li>{r.name}</li>)}</ul>;\n');
    const r = expectOk(resolve([app, data], target('Alpha gene', stamp(app, '<li'), 'li', [stamp(app, '<ul')])));
    expect(r).toMatchObject({ file: 'src/data.ts', kind: 'object-property', original: '"Alpha gene"' });
  });

  it('looks through fragments that are direct children: they make no DOM node', () => {
    const app = source('src/App.tsx', 'export const A = () => <div><>Inside fragment</></div>;\n');
    expect(expectOk(resolve([app], target('Inside fragment', stamp(app, '<div'), 'div'))).sameElementScope).toBe(true);
  });
});

describe('resolveTextEdit: duplicates', () => {
  it('(a) prefers the literal that is a direct child of the clicked element', () => {
    const app = source('src/App.tsx', 'export const A = () => (\n  <div>\n    <h2>Summary</h2>\n    <h3>Summary</h3>\n  </div>\n);\n');
    const second = expectOk(resolve([app], target('Summary', stamp(app, '<h3'), 'h3', [stamp(app, '<div')])));
    expect(second.start).toBe(app.text.lastIndexOf('Summary'));
    const first = expectOk(resolve([app], target('Summary', stamp(app, '<h2'), 'h2', [stamp(app, '<div')])));
    expect(first.start).toBe(app.text.indexOf('Summary'));
  });

  it('(a) a literal in the clicked element beats the same text in an element nested inside it', () => {
    // The enclosing element holds both, so only "direct child" can tell them apart.
    const app = source('src/App.tsx', 'export const A = () => <section><div>Overview<span>Overview</span></div></section>;\n');
    const outer = expectOk(resolve([app], target('Overview', stamp(app, '<div'), 'div', [stamp(app, '<section')])));
    expect(outer.start).toBe(app.text.indexOf('Overview'));
    expect(outer.sameElementScope).toBe(true);
    const inner = expectOk(resolve([app], target('Overview', stamp(app, '<span'), 'span', [stamp(app, '<div')])));
    expect(inner.start).toBe(app.text.lastIndexOf('Overview'));
  });

  it('(a) still resolves when the stamp column is slightly off but one element of that tag starts on the line', () => {
    const app = source('src/App.tsx', 'export const A = () => (\n  <div>\n    <h2>Summary</h2>\n    <h3>Summary</h3>\n  </div>\n);\n');
    const off = stamp(app, '<h3').replace(/:(\d+)$/, (_m, col) => `:${Number(col) + 1}`);
    const r = expectOk(resolve([app], target('Summary', off, 'h3')));
    expect(r.start).toBe(app.text.lastIndexOf('Summary'));
    expect(r.sameElementScope).toBe(true);
  });

  it('does not trust a stamp that now points at an element of a different tag, as after an edit moved the lines', () => {
    const app = source('src/App.tsx', 'export const A = () => (\n  <div>\n    <h2>Summary</h2>\n    <h3>Summary</h3>\n  </div>\n);\n');
    // The click was on the h3, but its stamp (taken before an edit above shortened the file) now lands on the h2.
    const stale = stamp(app, '<h2');
    const lost = expectRefused(resolve([app], target('Summary', stale, 'h3', [stamp(app, '<div')])), 'ambiguous');
    expect(lost.message).toMatch(/several places/);
    // With the right tag the same stamp is trusted, as it always was.
    expect(expectOk(resolve([app], target('Summary', stale, 'h2', [stamp(app, '<div')]))).start).toBe(app.text.indexOf('Summary'));
    // An unknown tag (empty) skips the check rather than distrusting every stamp.
    expect(expectOk(resolve([app], target('Summary', stale, '', [stamp(app, '<div')]))).start).toBe(app.text.indexOf('Summary'));
  });

  it('does NOT fall back to an enclosing element: a tab label from a constant is ambiguous with a Card title below it', () => {
    const app = source('src/App.tsx', [
      "const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'genes', label: 'Gene table' }];",
      'export const A = () => (',
      '  <div>',
      '    <nav>{TABS.map(t => <button key={t.id}>{t.label}</button>)}</nav>',
      '    <Card title="Gene table"><p>rows</p></Card>',
      '  </div>',
      ');',
    ].join('\n'));
    expectRefused(resolve([app], target('Gene table', stamp(app, '<button'), 'button', [stamp(app, '<nav'), stamp(app, '<div')])), 'ambiguous');
  });

  it('refuses a single candidate that is a host element\'s child elsewhere, when the clicked element is a different tool element', () => {
    const app = source('src/App.tsx', [
      'export const A = ({ label }) => (',
      '  <div>',
      '    <h2>Summary</h2>',
      '    <p>{label}</p>',
      '  </div>',
      ');',
    ].join('\n'));
    expectRefused(resolve([app], target('Summary', stamp(app, '<p'), 'p', [stamp(app, '<div')])), 'ambiguous');
    // Clicking the h2 itself is fine.
    expectOk(resolve([app], target('Summary', stamp(app, '<h2'), 'h2')));
    // A clicked element with no stamp in the tool leaves the single candidate allowed.
    expectOk(resolve([app], target('Summary', REUSABLE_STAMP, 'h2')));
    expectOk(resolve([app], target('Summary', null, 'h2')));
  });

  it('still allows a single attribute, object-property or component-children candidate for another clicked element', () => {
    const attr = source('src/App.tsx', 'export const A = () => <div><Card title="Summary" /><p>x</p></div>;\n');
    expect(expectOk(resolve([attr], target('Summary', stamp(attr, '<p'), 'p'))).kind).toBe('jsx-attribute');
    const prop = source('src/App.tsx', 'const T = { label: "Summary" };\nexport const A = () => <div><p>{T.label}</p></div>;\n');
    expect(expectOk(resolve([prop], target('Summary', stamp(prop, '<p'), 'p'))).kind).toBe('object-property');
    const comp = source('src/App.tsx', 'export const A = () => <div><Card>Summary</Card><p>x</p></div>;\n');
    expect(expectOk(resolve([comp], target('Summary', stamp(comp, '<p'), 'p'))).kind).toBe('jsx-text');
  });

  it('sameElementScope is true only for a whole-expression literal, not one branch of ?: || ?? &&', () => {
    const scope = (body: string): boolean => {
      const app = source('src/App.tsx', `export const A = ({ x, y }) => <p>${body}</p>;\n`);
      return expectOk(resolve([app], target('Hi', stamp(app, '<p'), 'p'))).sameElementScope;
    };
    expect(scope('{"Hi"}')).toBe(true);
    expect(scope('{("Hi" as string)!}')).toBe(true);
    expect(scope('{"Hi" satisfies string}')).toBe(true);
    expect(scope('{x ? "Hi" : y}')).toBe(false);
    expect(scope('{x || "Hi"}')).toBe(false);
    expect(scope('{x ?? "Hi"}')).toBe(false);
    expect(scope('{x && "Hi"}')).toBe(false);
  });

  it('is ambiguous when nothing says which duplicate was clicked', () => {
    const app = source('src/App.tsx', 'export const A = () => <main><Panel title="Overview" /><Panel title="Overview" /></main>;\n');
    expectRefused(resolve([app], target('Overview', REUSABLE_STAMP, 'h2')), 'ambiguous');
    // The nearest tool element holds both, so it cannot choose either.
    const both = expectRefused(resolve([app], target('Overview', REUSABLE_STAMP, 'h2', [stamp(app, '<main')])), 'ambiguous');
    expect(both.message).toBe("This exact text appears in several places in the tool's code, so it isn't clear which one to change.");
  });
});

describe('resolveTextEdit: what it refuses, and why', () => {
  it('refuses text that is also used as code: a type, a comparison, a property access', () => {
    const base = [
      'const tabs = [{ id: "Overview", label: "Overview" }];',
      'export const A = () => <nav>{tabs.map((t) => <button key={t.id}>{t.label}</button>)}</nav>;',
    ];
    const lookup = "The tool's code also uses this text to look things up, so changing it here could break the tool.";
    const click = (app: AppSource, text: string) => resolve([app], target(text, stamp(app, '<button'), 'button'));

    const typed = source('src/App.tsx', [...base, 'type Tab = "Overview" | "Details";'].join('\n'));
    expect(expectRefused(click(typed, 'Overview'), 'used-by-code').message).toBe(lookup);

    const compared = source('src/App.tsx', ['const rows = [{ name: "Revenue" }];', 'export const A = () => <ul>{rows.map((d) => <li>{d.name}</li>)}</ul>;', 'export const f = (d) => d.name === "Revenue";'].join('\n'));
    expect(expectRefused(resolve([compared], target('Revenue', stamp(compared, '<li'), 'li')), 'used-by-code').message).toBe(lookup);

    const accessed = source('src/App.tsx', ['const rows = [{ name: "Revenue" }];', 'const colors = { Revenue: "#0645b1" };', 'export const A = () => <ul>{rows.map((d) => <li style={{ color: colors.Revenue }}>{d.name}</li>)}</ul>;'].join('\n'));
    expect(expectRefused(resolve([accessed], target('Revenue', stamp(accessed, '<li'), 'li')), 'used-by-code').message).toBe(lookup);
  });

  it('treats each kind of use as use: switch case, element access, call argument, array element, computed key', () => {
    const view = ['const rows = [{ name: "Revenue" }];', 'export const A = () => <ul>{rows.map((d) => <li>{d.name}</li>)}</ul>;'];
    const uses = [
      'export const f = (x) => { switch (x) { case "Revenue": return 1; } };',
      'export const f = (o) => o["Revenue"];',
      'export const f = (list) => list.includes("Revenue");',
      'export const f = new Set(["Revenue"]);',
      'export const f = { ["Revenue"]: 1 };',
      'export const f = { "Revenue": 1 };',
      'export interface Row { Revenue: number }',
      'export const f = (o) => { const { Revenue } = o; return Revenue; };',
    ];
    for (const use of uses) {
      const app = source('src/App.tsx', [...view, use].join('\n'));
      const r = resolve([app], target('Revenue', stamp(app, '<li'), 'li'));
      if (r.ok || r.reason !== 'used-by-code') throw new Error(`${use} should have made the property label used-by-code, got ${JSON.stringify(r)}`);
    }
  });

  it('does not count a use of the text against display JSX', () => {
    const app = source('src/App.tsx', 'export const A = () => <h1>Revenue</h1>;\nexport const f = (d) => d.name === "Revenue";\n');
    expect(expectOk(resolve([app], target('Revenue', stamp(app, '<h1'), 'h1'))).kind).toBe('jsx-text');
  });

  it("refuses a variable initializer with the 'set in code' message", () => {
    const app = source('src/App.tsx', 'const GREETING = "Welcome back";\nexport const A = () => <p>{GREETING}</p>;\n');
    const r = expectRefused(resolve([app], target('Welcome back', stamp(app, '<p'))), 'used-by-code');
    expect(r.message).toBe("This text is set in the tool's code in a way that isn't safe to change here.");
  });

  it('refuses values of denied attribute and property names', () => {
    const attr = source('src/App.tsx', 'export const A = () => <Select variant="Outline" aria-label="Close" data-tip="Hint" />;\n');
    for (const text of ['Outline', 'Close', 'Hint']) expectRefused(resolve([attr], target(text, REUSABLE_STAMP, 'span')), 'used-by-code');
    const prop = source('src/App.tsx', 'const cols = [{ type: "Numeric", label: "Count" }];\nexport const A = () => <b>{cols[0].type}</b>;\n');
    expectRefused(resolve([prop], target('Numeric', stamp(prop, '<b'), 'b')), 'used-by-code');
  });

  it('says computed when no literal produces the text', () => {
    const app = source('src/App.tsx', 'export const A = ({ n }) => <p>Showing {n} genes{`: ${n} found`}</p>;\n');
    const p = stamp(app, '<p');
    const r = expectRefused(resolve([app], target('312', p)), 'computed');
    expect(r.message).toBe("This text is produced by the tool's code while it runs, so it can't be changed here directly.");
    expectRefused(resolve([app], target(': 312 found', p)), 'computed');
  });

  it('says computed, not used-by-code, when the text only coincides with a DOM element attribute', () => {
    const app = source('src/App.tsx', 'export const A = ({ q }) => <div><input placeholder="Search" title="Search" /><p>{q}</p></div>;\n');
    expectRefused(resolve([app], target('Search', stamp(app, '<p'))), 'computed');
  });

  it('says outside-tool for text that only a shared component or another tool has', () => {
    const app = source('src/App.tsx', 'export const A = () => <Spinner />;\n');
    const shared = expectRefused(resolve([app], target('Loading', '.applications/_reusable/Spinner.tsx:3:5', 'span')), 'outside-tool');
    expect(shared.message).toMatch(/shared component or library/);
    expectRefused(resolve([app], target('Loading', '.applications/other/src/App.tsx:1:1', 'span')), 'outside-tool');
    // A stamp inside this tool means the tool's own code made it.
    expectRefused(resolve([app], target('Loading', stamp(app, '<Spinner'), 'span')), 'computed');
    // No stamp at all says nothing about where it came from.
    expectRefused(resolve([app], target('Loading', null, 'span')), 'computed');
  });

  it('is invalid for blank text', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>x</p>;\n');
    expectRefused(resolve([app], target('   ', null)), 'invalid');
    expectRefused(resolve([app], target('', null)), 'invalid');
  });

  it('never throws on a file with parse errors', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>Hello</p>;\nexport const B = () => <q>>>>{{{ </q>;\n');
    expect(() => resolve([app], target('Hello', stamp(app, '<p')))).not.toThrow();
  });
});

describe('stamps agree with esbuild', () => {
  it('the line and column the fixture helper computes are what jsxDEV reports', () => {
    const text = 'export const A = () => (\n  <div>\n    <i>\u00e9\u2014\u{1f9ec}</i><b>Dup</b>\n    <b>Dup</b>\n  </div>\n);\n';
    const app = source('src/App.tsx', text);
    const out = esbuild.transformSync(text, {
      loader: 'tsx', jsx: 'automatic', jsxDev: true, sourcefile: `.applications/${DIR}/src/App.tsx`,
    }).code;
    const reported = [...out.matchAll(/fileName: "([^"]+)",\s*lineNumber: (\d+),\s*columnNumber: (\d+)/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
    expect(reported).toEqual(expect.arrayContaining([stamp(app, '<div'), stamp(app, '<i'), stamp(app, '<b', 1), stamp(app, '<b', 2)]));

    // And resolution works with exactly what esbuild reported.
    const r = expectOk(resolve([app], target('Dup', stamp(app, '<b', 2), 'b')));
    expect(r.start).toBe(text.lastIndexOf('Dup'));
  });
});

describe('planTextEdit and verifyPlannedEdit', () => {
  function plan(app: AppSource, r: Resolution, newText: string) {
    const ok = expectOk(r);
    const p = planTextEdit(app, ok, newText);
    return { p, after: app.text.slice(0, p.start) + p.replacement + app.text.slice(p.end) };
  }

  it('rewrites JSX text in place and keeps its indentation', () => {
    const app = source('src/App.tsx', 'export const A = () => (\n  <p>\n    Old words here\n  </p>\n);\n');
    const { p, after } = plan(app, resolve([app], target('Old words here', stamp(app, '<p'))), 'New words & more');
    expect(after).toBe('export const A = () => (\n  <p>\n    New words &amp; more\n  </p>\n);\n');
    expect(verifyPlannedEdit(app, after, p, 'New words & more')).toBe(true);
  });

  it('keeps the quote character of a string literal and of a JSX attribute', () => {
    const app = source('src/App.tsx', 'const t = [{ label: \'Old\' }];\nexport const A = () => <Panel title="Old title" />;\n');
    const label = plan(app, resolve([app], target('Old', REUSABLE_STAMP, 'h2')), "it's new");
    expect(label.after).toContain("label: 'it\\'s new'");
    const title = plan(app, resolve([app], target('Old title', REUSABLE_STAMP, 'h2')), 'say "hi"');
    expect(title.after).toContain('title={"say \\"hi\\""}');
    expect(verifyPlannedEdit(app, title.after, title.p, 'say "hi"')).toBe(true);
  });

  it('rewrites a template literal and a conditional branch', () => {
    const app = source('src/App.tsx', 'export const A = ({ ok }) => <p>{ok ? `Yes` : "No"}</p>;\n');
    const yes = plan(app, resolve([app], target('Yes', stamp(app, '<p'))), 'Sure `thing`');
    expect(yes.after).toBe('export const A = ({ ok }) => <p>{ok ? `Sure \\`thing\\`` : "No"}</p>;\n');
    expect(verifyPlannedEdit(app, yes.after, yes.p, 'Sure `thing`')).toBe(true);
  });

  it('the new text compiles and resolves again after every kind of edit', () => {
    const app = source('src/App.tsx', [
      'const rows = [{ name: "Row name" }];',
      'export const A = ({ ok }) => (',
      '  <main>',
      '    <h1>Heading text</h1>',
      '    <p>',
      '      Indented paragraph',
      '    </p>',
      '    <Panel title="Panel title" />',
      '    <i>{ok ? "Yes" : "No"}</i>',
      '    <ul>{rows.map((r) => <li>{r.name}</li>)}</ul>',
      '  </main>',
      ');',
    ].join('\n'));
    const clicks: Array<[string, string, string]> = [
      ['Heading text', stamp(app, '<h1'), 'h1'], ['Indented paragraph', stamp(app, '<p'), 'p'],
      ['Panel title', REUSABLE_STAMP, 'h2'], ['Yes', stamp(app, '<i'), 'i'], ['Row name', stamp(app, '<li'), 'li'],
    ];
    const newTexts = ['Short', ' padded ', 'a & b < c > d {e}', 'say "hi" it\'s `x` ${y}', 'back\\slash\ttab', 'emoji \u{1f9ec} \u00e9', NBSP + 'nb' + NBSP, ''];
    const failures: string[] = [];
    for (const [text, elementSrc, tag] of clicks) {
      for (const newText of newTexts) {
        const r = resolve([app], target(text, elementSrc, tag));
        if (!r.ok) { failures.push(`${text}: ${r.reason}`); continue; }
        const p = planTextEdit(app, r, newText);
        const after = app.text.slice(0, p.start) + p.replacement + app.text.slice(p.end);
        if (!verifyPlannedEdit(app, after, p, newText)) failures.push(`${text} -> ${JSON.stringify(newText)}: not verified`);
        try {
          esbuild.transformSync(after, { loader: 'tsx', jsx: 'automatic' });
        } catch (e) {
          failures.push(`${text} -> ${JSON.stringify(newText)}: does not compile: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('refuses an edit that adds a parse error', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>{"Old"}</p>;\n');
    const ok = expectOk(resolve([app], target('Old', stamp(app, '<p'))));
    const broken = { start: ok.start, end: ok.end, replacement: '"unterminated' };
    const after = app.text.slice(0, broken.start) + broken.replacement + app.text.slice(broken.end);
    expect(verifyPlannedEdit(app, after, broken, 'unterminated')).toBe(false);
  });

  it('refuses an edit after which the new text is not displayed where the edit landed', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>{"Old"}</p>;\n');
    const ok = expectOk(resolve([app], target('Old', stamp(app, '<p'))));
    const wrong = { start: ok.start, end: ok.end, replacement: '"Something else"' };
    const after = app.text.slice(0, wrong.start) + wrong.replacement + app.text.slice(wrong.end);
    expect(verifyPlannedEdit(app, after, wrong, 'The text the user typed')).toBe(false);
  });

  it('refuses a plan that does not match the file it is checked against', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>Old</p>;\n');
    const ok = expectOk(resolve([app], target('Old', stamp(app, '<p'))));
    const p = planTextEdit(app, ok, 'New');
    expect(verifyPlannedEdit(app, app.text, p, 'New')).toBe(false);
  });

  it('accepts deleting the text', () => {
    const app = source('src/App.tsx', 'export const A = () => <p>Old</p>;\n');
    const { p, after } = plan(app, resolve([app], target('Old', stamp(app, '<p'))), '');
    expect(after).toBe('export const A = () => <p></p>;\n');
    expect(verifyPlannedEdit(app, after, p, '')).toBe(true);
  });
});

describe('parse caching', () => {
  it('parses an unchanged file once however many clicks resolve against it', () => {
    const parses = (tsModule as unknown as { __parses: { count: number } }).__parses;
    const app = source('src/App.tsx', 'export const A = () => <h1>Cached</h1>;\n');
    const before = parses.count;
    resolve([app], target('Cached', stamp(app, '<h1'), 'h1'));
    expect(parses.count - before).toBe(1);
    resolve([app], target('Cached', stamp(app, '<h1'), 'h1'));
    resolve([app], target('Nope', null));
    expect(parses.count - before).toBe(1);
    // A file whose text changed is a different object, so it is parsed again.
    resolve([source('src/App.tsx', app.text)], target('Cached', null));
    expect(parses.count - before).toBe(2);
  });
});

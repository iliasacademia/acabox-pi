/**
 * @jest-environment node
 *
 * The JSX text rules against the real compiler. esbuild is the oracle: it is
 * what builds the tools, so what it makes of a piece of JSX is the truth, and
 * every rule in jsxText.ts has to agree with it.
 *
 * Characters that editors tend to mangle are built from code points here, not
 * typed into the file.
 */
import * as esbuild from 'esbuild';
import * as ts from 'typescript';
import * as vm from 'vm';
import {
  cookJsxText,
  decodeJsxEntities,
  encodeJsxAttributeString,
  encodeJsxTextReplacement,
  encodeStringLiteral,
  encodeTemplateLiteral,
} from '../jsxText';

const NBSP = String.fromCharCode(0xa0);
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const EM_SPACE = String.fromCharCode(0x2003);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const BOM = String.fromCharCode(0xfeff);
const NEXT_LINE = String.fromCharCode(0x85);
const LONE_SURROGATE = String.fromCharCode(0xd83d);

/** A string with every character outside printable ASCII written as \uXXXX, for test titles and diffs. */
function show(s: string): string {
  return JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

interface Rendered { type: string; props: Record<string, unknown> | null; children: unknown[] }

/** Compiles JSX with the classic transform and runs it against a factory that records what it is given. */
function render(jsx: string): Rendered {
  const code = esbuild.transformSync(jsx, { loader: 'tsx', jsx: 'transform', jsxFactory: '__h' }).code;
  const __h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Rendered => ({ type, props, children });
  return vm.runInNewContext(code, { __h }) as Rendered;
}

/** What esbuild makes of `<b>raw</b>`: the children joined, '' when there are none. */
function compiledChildText(raw: string): string {
  const { children } = render('<b>' + raw + '</b>');
  for (const child of children) expect(typeof child).toBe('string');
  return children.join('');
}

/** What esbuild makes of a JS literal or any expression, evaluated. */
function evaluate(expression: string): unknown {
  const code = esbuild.transformSync('(' + expression + ')', { loader: 'ts' }).code;
  return vm.runInNewContext(code);
}

/** TypeScript's own verdict: how many parse errors does this tsx text have? */
function tsParseErrors(source: string): number {
  const sf = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
}

describe('decodeJsxEntities', () => {
  it('decodes numeric references, decimal and hex', () => {
    expect(decodeJsxEntities('&#123;')).toBe('{');
    expect(decodeJsxEntities('&#x7B;')).toBe('{');
    expect(decodeJsxEntities('&#x1F600;')).toBe(String.fromCodePoint(0x1f600));
    expect(decodeJsxEntities('a&#65;b&#x42;c')).toBe('aAbBc');
  });

  it('decodes the curated named set', () => {
    expect(decodeJsxEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeJsxEntities('a&nbsp;b')).toBe('a' + NBSP + 'b');
    expect(decodeJsxEntities('&hellip;&mdash;&ndash;')).toBe('\u2026\u2014\u2013');
    expect(decodeJsxEntities('&alpha;&beta;&omega;')).toBe('\u03b1\u03b2\u03c9');
  });

  it('leaves unknown names and malformed references as written', () => {
    for (const s of ['&eacute;', '&foo;', '&amp', '&#;', '&#x;', '&#xZ;', '&#X41;', '&AMP;', '& amp;', '&#1114112;', '&#55357;']) {
      expect(decodeJsxEntities(s)).toBe(s);
    }
  });

  it('agrees with esbuild for every named entity in the set', () => {
    const names = [
      'amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'ndash', 'mdash', 'hellip', 'lsquo', 'rsquo', 'ldquo', 'rdquo',
      'laquo', 'raquo', 'middot', 'bull', 'times', 'divide', 'plusmn', 'deg', 'micro', 'para', 'sect', 'copy', 'reg',
      'trade', 'larr', 'rarr', 'uarr', 'darr', 'harr', 'le', 'ge', 'ne', 'asymp', 'infin', 'minus', 'prime', 'alpha',
      'beta', 'gamma', 'delta', 'epsilon', 'lambda', 'mu', 'pi', 'sigma', 'omega',
    ];
    const mismatches: string[] = [];
    for (const name of names) {
      const raw = 'a&' + name + ';b';
      const expected = compiledChildText(raw);
      if (decodeJsxEntities(raw) !== expected) mismatches.push(`${name}: ${show(decodeJsxEntities(raw))} vs esbuild ${show(expected)}`);
      expect(expected).not.toBe(raw); // the oracle really did decode it
    }
    expect(mismatches).toEqual([]);
  });
});

describe('cookJsxText against esbuild', () => {
  const cases: string[] = [
    'Hello', '  Hello  ', '\n  Hello\n', '\n  Hello  world\n  ', 'a\n  b\n  c', 'a  \n  b', 'a\r\nb', 'a\rb',
    'a\tb', '\ta\t', 'x\t\n\ty', '   ', '\n', '\n\n', 'a\n\n\nb', 'a\n \n b', 'one\t\ttwo', 'a \t \n \t b', '\t\n\t',
    '&amp;', '&nbsp;x', 'x&nbsp;', ' &nbsp; ', '&#32;x', 'x&#32;\ny', '&#10;', 'a&#x41;b', '&hellip;', '&foo;', '&amp',
    '&#;', '&#x;', '&#xZ;', '&#X41;', '&#128512;', '&#x1F600;', 'a &lt; b &gt; c', '&AMP;', '&apos;s', '&times;',
    NBSP + 'x' + NBSP, 'a' + NBSP + '\nb', 'a\n' + NBSP + 'b', NBSP + '\n' + NBSP,
    'a' + LINE_SEP + 'b', 'a' + PARA_SEP + 'b', 'a ' + LINE_SEP + ' b', LINE_SEP + 'a', 'a' + LINE_SEP,
    'a' + BOM + 'b', EM_SPACE + 'a' + EM_SPACE, 'a\n' + EM_SPACE + 'b', 'a\n' + IDEOGRAPHIC_SPACE + 'b',
    'a' + NEXT_LINE + 'b', '\f a \f', 'a\u000bb',
    'e\u2014\u{1f9ec} ok', 'line one\n    line two  \n\n   line three', 'Showing ', ' genes above threshold',
    '  \n  Overview  \n  ', 'Wait&hellip;\n    done',
  ];

  it('covers at least twenty raw cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(cases.map((raw) => [show(raw), raw]))('%s', (_label, raw) => {
    expect(cookJsxText(raw)).toBe(compiledChildText(raw));
  });

  it('trims and breaks lines on exactly the characters esbuild does', () => {
    const codes: number[] = [];
    for (let c = 1; c < 0x20; c++) codes.push(c);
    for (let c = 0x7f; c <= 0xa0; c++) codes.push(c);
    for (const c of [0x1680, 0x180e, 0x3000, 0xfeff]) codes.push(c);
    for (let c = 0x2000; c <= 0x200f; c++) codes.push(c);
    for (let c = 0x2028; c <= 0x202f; c++) codes.push(c);
    for (let c = 0x205f; c <= 0x206f; c++) codes.push(c);

    const mismatches: string[] = [];
    let compared = 0;
    for (const code of codes) {
      const ch = String.fromCharCode(code);
      for (const raw of ['a\n' + ch + 'b', 'a' + ch + '\nb', 'a' + ch + 'b', ch + 'a' + ch]) {
        let expected: string;
        try {
          expected = compiledChildText(raw);
        } catch {
          continue; // esbuild itself refuses this character in JSX text
        }
        compared++;
        if (cookJsxText(raw) !== expected) mismatches.push(`${show(raw)} -> ${show(cookJsxText(raw))}, esbuild ${show(expected)}`);
      }
    }
    expect(compared).toBeGreaterThan(300);
    expect(mismatches).toEqual([]);
  });
});

const NEW_TEXTS: string[] = [
  'Gene explorer', ' leading space', 'trailing space ', ' both ', '  two spaces  ', 'inner  double  space',
  'say "hi" and \'bye\'', 'a & b', 'x < y > z', '{curly} braces', 'AT&amp;T', '&#123; stays text', 'it\'s a `tick` ${x}',
  'nb' + NBSP + 'sp', NBSP + 'lead nbsp', 'trail nbsp' + NBSP, 'emoji \u{1f9ec} \u00e9\u2014', 'back\\slash', 'C:\\path\\n',
  'tab\there', '\tleading tab', 'sep' + LINE_SEP + 'arator', '/* not a comment */ // nor this', ' ', '',
];

describe('encodeJsxTextReplacement', () => {
  const RAW_CONTEXTS: Array<[string, string]> = [
    ['single line', 'Old text'],
    ['padded single line', '  Old text  '],
    ['newline-led', '\n    Old text'],
    ['newline-trailed', 'Old text\n    '],
    ['indented block', '\n      Old text\n    '],
    ['multi-line', '\n      Old text that wraps\n      onto a second line\n    '],
    ['CRLF', '\r\n    Old text\r\n  '],
    ['tabs', '\n\t\tOld text\n\t'],
    ['spaces before the newline', '  \n  Old text  \n  '],
    ['all whitespace', '\n   '],
  ];

  it.each(RAW_CONTEXTS)('round trips every new text through esbuild: %s', (_name, raw) => {
    const failures: string[] = [];
    for (const newText of NEW_TEXTS) {
      const replacement = encodeJsxTextReplacement(raw, newText);
      let compiled: string;
      try {
        compiled = compiledChildText(replacement);
      } catch (e) {
        failures.push(`${show(newText)} -> ${show(replacement)} does not compile: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      if (compiled !== newText) failures.push(`${show(newText)} -> ${show(replacement)} compiles to ${show(compiled)}`);
      if (tsParseErrors('<b>' + replacement + '</b>') !== 0) failures.push(`${show(newText)} -> ${show(replacement)} has parse errors in TypeScript`);
    }
    expect(failures).toEqual([]);
  });

  it('keeps the indentation around the text', () => {
    expect(encodeJsxTextReplacement('\n      Old\n    ', 'New')).toBe('\n      New\n    ');
    expect(encodeJsxTextReplacement('Old', 'New')).toBe('New');
    expect(encodeJsxTextReplacement('  Old  ', 'New')).toBe('New');
    expect(encodeJsxTextReplacement('\r\n  Old\r\n', 'New')).toBe('\r\n  New\r\n');
  });

  it('escapes what JSX text cannot hold, and nothing else', () => {
    expect(encodeJsxTextReplacement('Old', 'a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(encodeJsxTextReplacement('Old', '{x}')).toBe('&#123;x&#125;');
    expect(encodeJsxTextReplacement('Old', 'a' + NBSP + 'b')).toBe('a&nbsp;b');
    expect(encodeJsxTextReplacement('Old', 'say "hi" it\'s')).toBe('say "hi" it\'s');
    expect(encodeJsxTextReplacement('Old', 'back\\slash')).toBe('back\\slash');
  });

  it('writes an expression when indentation would swallow a leading or trailing space', () => {
    expect(encodeJsxTextReplacement('\n  Old\n', ' New')).toBe('\n  {" New"}\n');
    expect(encodeJsxTextReplacement('\n  Old\n', 'New ')).toBe('\n  {"New "}\n');
    // No indentation, nothing to swallow it: plain text keeps the space.
    expect(encodeJsxTextReplacement('Old', ' New ')).toBe(' New ');
  });

  it('an empty new text leaves only the indentation, which compiles to nothing', () => {
    expect(encodeJsxTextReplacement('Old', '')).toBe('');
    expect(encodeJsxTextReplacement('\n  Old\n', '')).toBe('\n  \n');
    expect(compiledChildText(encodeJsxTextReplacement('\n  Old\n', ''))).toBe('');
  });
});

describe('encodeStringLiteral', () => {
  const NEW_STRINGS = [
    ...NEW_TEXTS, 'multi\nline', 'carriage\rreturn', 'crlf\r\nhere', 'ctl' + String.fromCharCode(1) + String.fromCharCode(0x1f),
    'nul' + String.fromCharCode(0) + 'byte', 'para' + PARA_SEP + 'graph', 'lone' + LONE_SURROGATE + 'surrogate',
    'pair \u{1f600}', '"', "'", '\\', '\\"', '\\n literal', '`', '$' + '{',
  ];

  it.each([['double', '"Old"'], ['single', "'Old'"]])('round trips with %s quotes', (_name, original) => {
    const failures: string[] = [];
    for (const newText of NEW_STRINGS) {
      const literal = encodeStringLiteral(original, newText);
      let value: unknown;
      try {
        value = evaluate(literal);
      } catch (e) {
        failures.push(`${show(newText)} -> ${show(literal)} does not evaluate: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      // A lone surrogate is written as an escape, which evaluates back to itself.
      if (value !== newText) failures.push(`${show(newText)} -> ${show(literal)} evaluates to ${show(String(value))}`);
      if (literal.charAt(0) !== original.charAt(0)) failures.push(`${show(newText)} changed the quote character`);
    }
    expect(failures).toEqual([]);
  });

  it('keeps the original quote and escapes only what it must', () => {
    expect(encodeStringLiteral("'Old'", "it's")).toBe("'it\\'s'");
    expect(encodeStringLiteral('"Old"', 'say "hi"')).toBe('"say \\"hi\\""');
    expect(encodeStringLiteral('"Old"', "it's")).toBe('"it\'s"');
    expect(encodeStringLiteral("'Old'", 'say "hi"')).toBe("'say \"hi\"'");
    expect(encodeStringLiteral('"Old"', 'a\\b')).toBe('"a\\\\b"');
    expect(encodeStringLiteral('"Old"', 'a\nb\rc')).toBe('"a\\nb\\rc"');
    expect(encodeStringLiteral('"Old"', 'a' + LINE_SEP + 'b' + PARA_SEP)).toBe('"a\\u2028b\\u2029"');
    expect(encodeStringLiteral('"Old"', 'a' + String.fromCharCode(1) + 'b')).toBe('"a\\u0001b"');
    expect(encodeStringLiteral('"Old"', 'a' + LONE_SURROGATE)).toBe('"a\\ud83d"');
    expect(encodeStringLiteral('"Old"', '')).toBe('""');
  });
});

describe('encodeTemplateLiteral', () => {
  it('round trips awkward text through esbuild', () => {
    const texts = [
      ...NEW_TEXTS, 'multi\nline', 'carriage\rreturn', 'crlf\r\nhere', 'a`b', 'a\\`b', '$' + '{x}', 'cost $5', 'ends with $', '$$' + '{x}',
      'lone' + LONE_SURROGATE + 'surrogate', 'sep' + PARA_SEP, '\\n literal',
    ];
    const failures: string[] = [];
    for (const newText of texts) {
      const literal = encodeTemplateLiteral(newText);
      let value: unknown;
      try {
        value = evaluate(literal);
      } catch (e) {
        failures.push(`${show(newText)} -> ${show(literal)} does not evaluate: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      if (value !== newText) failures.push(`${show(newText)} -> ${show(literal)} evaluates to ${show(String(value))}`);
    }
    expect(failures).toEqual([]);
  });

  it('escapes the three things a template cannot hold', () => {
    expect(encodeTemplateLiteral('a`b')).toBe('`a\\`b`');
    expect(encodeTemplateLiteral('a\\b')).toBe('`a\\\\b`');
    expect(encodeTemplateLiteral('$' + '{x}')).toBe('`\\$' + '{x}`');
    expect(encodeTemplateLiteral('cost $5')).toBe('`cost $5`');
  });
});

describe('encodeJsxAttributeString', () => {
  const ATTR_TEXTS = [
    ...NEW_TEXTS, 'multi\nline', 'carriage\rreturn', 'sep' + PARA_SEP, 'a "quoted" word', "it's", '"', "'", '&', '&amp;', '{x}', 'plain',
  ];

  it.each([['double', '"Old"'], ['single', "'Old'"]])('round trips with %s quotes', (_name, original) => {
    const failures: string[] = [];
    for (const newText of ATTR_TEXTS) {
      const written = encodeJsxAttributeString(original, newText);
      let props: Record<string, unknown> | null;
      try {
        props = render('<b title=' + written + ' />').props;
      } catch (e) {
        failures.push(`${show(newText)} -> ${show(written)} does not compile: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      if (props?.title !== newText) failures.push(`${show(newText)} -> ${show(written)} compiles to ${show(String(props?.title))}`);
      if (tsParseErrors('<b title=' + written + ' />') !== 0) failures.push(`${show(newText)} -> ${show(written)} has parse errors in TypeScript`);
    }
    expect(failures).toEqual([]);
  });

  it('stays a plain attribute string when it can, and uses an expression when it must', () => {
    expect(encodeJsxAttributeString('"Old"', 'New title')).toBe('"New title"');
    expect(encodeJsxAttributeString("'Old'", 'New title')).toBe("'New title'");
    expect(encodeJsxAttributeString('"Old"', "it's")).toBe('"it\'s"');
    expect(encodeJsxAttributeString('"Old"', 'say "hi"')).toBe('{"say \\"hi\\""}');
    expect(encodeJsxAttributeString('"Old"', 'a & b')).toBe('{"a & b"}');
    expect(encodeJsxAttributeString('"Old"', '{x}')).toBe('{"{x}"}');
    expect(encodeJsxAttributeString('"Old"', 'two\nlines')).toBe('{"two\\nlines"}');
    expect(encodeJsxAttributeString('"Old"', '')).toBe('""');
  });
});

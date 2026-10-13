/**
 * String rules for editing text in a tool's JSX source (POC; see
 * docs/design/mini-app-text-edit-poc.md, T2). Pure: no fs, no TypeScript AST.
 *
 * Two directions, and the build is the judge of both:
 *   - `cookJsxText` / `decodeJsxEntities` say what the compiler makes of source
 *     text, so a clicked DOM text node can be matched to the literal that wrote it.
 *   - the `encode*` functions turn the user's new text back into source whose
 *     compiled value is exactly that text.
 * jsxText.test.ts holds every rule here against esbuild's own output.
 *
 * Characters that are invisible or easy to mangle (no-break space, the Unicode
 * line and paragraph separators) are handled by code point, never written into
 * this file, so an editor cannot silently change them.
 */

/**
 * The named entities we decode, by code point. A curated subset of what JSX
 * knows: a name that is not here stays literal, so it never matches rendered
 * text. That is conservative on purpose, since a wrong match would edit the
 * wrong literal.
 */
const NAMED_ENTITIES: Readonly<Record<string, number>> = {
  amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0,
  ndash: 0x2013, mdash: 0x2014, hellip: 0x2026,
  lsquo: 0x2018, rsquo: 0x2019, ldquo: 0x201c, rdquo: 0x201d,
  laquo: 0xab, raquo: 0xbb, middot: 0xb7, bull: 0x2022,
  times: 0xd7, divide: 0xf7, plusmn: 0xb1, deg: 0xb0, micro: 0xb5,
  para: 0xb6, sect: 0xa7, copy: 0xa9, reg: 0xae, trade: 0x2122,
  larr: 0x2190, rarr: 0x2192, uarr: 0x2191, darr: 0x2193, harr: 0x2194,
  le: 0x2264, ge: 0x2265, ne: 0x2260, asymp: 0x2248, infin: 0x221e,
  minus: 0x2212, prime: 0x2032,
  alpha: 0x3b1, beta: 0x3b2, gamma: 0x3b3, delta: 0x3b4, epsilon: 0x3b5,
  lambda: 0x3bb, mu: 0x3bc, pi: 0x3c0, sigma: 0x3c3, omega: 0x3c9,
};

/** True for a code point `String.fromCodePoint` accepts and a UTF-8 source file can hold. */
function isDecodableCodePoint(cp: number): boolean {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

/**
 * Decodes numeric (`&#123;`, `&#x1F;`) and curated named references; anything else stays as
 * written. Hex takes a lowercase `x` only: esbuild leaves `&#X41;` alone.
 */
export function decodeJsxEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(
    /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g,
    (whole: string, dec?: string, hex?: string, name?: string) => {
      let cp: number | undefined;
      if (dec !== undefined) cp = parseInt(dec, 10);
      else if (hex !== undefined) cp = parseInt(hex, 16);
      else if (name !== undefined && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) cp = NAMED_ENTITIES[name];
      return cp !== undefined && isDecodableCodePoint(cp) ? String.fromCodePoint(cp) : whole;
    },
  );
}

/** U+2028 and U+2029: line breaks to a JSX compiler, though not to most editors. */
function isSeparatorBreak(code: number): boolean {
  return code === 0x2028 || code === 0x2029;
}

/**
 * The whitespace a JSX compiler trims where a line meets a newline: ECMAScript
 * WhiteSpace (tab, vertical tab, form feed, space, no-break space, the Unicode
 * space separators, byte order mark). Measured against esbuild 0.25.12; note
 * U+0085 and U+200B are not in it.
 */
function isJsxEdgeSpace(code: number): boolean {
  return code === 0x09 || code === 0x0b || code === 0x0c || code === 0x20 || code === 0xa0
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

function trimJsxStart(s: string): string {
  let i = 0;
  while (i < s.length && isJsxEdgeSpace(s.charCodeAt(i))) i++;
  return s.slice(i);
}

function trimJsxEnd(s: string): string {
  let i = s.length;
  while (i > 0 && isJsxEdgeSpace(s.charCodeAt(i - 1))) i--;
  return s.slice(0, i);
}

/** Splits raw JSX text into lines the way the compiler does. */
function splitJsxLines(raw: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x0d && raw.charCodeAt(i + 1) === 0x0a) {
      lines.push(raw.slice(start, i));
      i++;
      start = i + 1;
    } else if (c === 0x0a || c === 0x0d || isSeparatorBreak(c)) {
      lines.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  lines.push(raw.slice(start));
  return lines;
}

/**
 * What the compiler makes of the raw source of one JsxText node: whitespace
 * folded by the JSX rule, then entities decoded. Folding runs on the raw text,
 * so an entity that decodes to a space is not trimmed, as in the compiler.
 *
 * The rule is Babel's cleanJSXElementLiteralChild as esbuild applies it: split
 * into lines, trim whitespace off the start of every line but the first and the
 * end of every line but the last, drop empty lines, join the rest with one
 * space. Unlike Babel, esbuild leaves a tab inside a line as a tab.
 */
export function cookJsxText(raw: string): string {
  const lines = splitJsxLines(raw);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (i > 0) line = trimJsxStart(line);
    if (i < lines.length - 1) line = trimJsxEnd(line);
    if (line !== '') kept.push(line);
  }
  return decodeJsxEntities(kept.join(' '));
}

function isRunChar(code: number): boolean {
  return isJsxEdgeSpace(code) || code === 0x0a || code === 0x0d || isSeparatorBreak(code);
}

/** The run of JSX whitespace and line breaks at the start (or end) of `raw`. */
function whitespaceRun(raw: string, fromEnd: boolean): string {
  if (!fromEnd) {
    let i = 0;
    while (i < raw.length && isRunChar(raw.charCodeAt(i))) i++;
    return raw.slice(0, i);
  }
  let i = raw.length;
  while (i > 0 && isRunChar(raw.charCodeAt(i - 1))) i--;
  return raw.slice(i);
}

function hasLineBreak(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || isSeparatorBreak(c)) return true;
  }
  return false;
}

/** `&`, `<`, `>`, braces and the no-break space are written as entities in JSX text. */
function escapeJsxTextChar(code: number, ch: string): string {
  switch (code) {
    case 0x26: return '&amp;';
    case 0x3c: return '&lt;';
    case 0x3e: return '&gt;';
    case 0x7b: return '&#123;';
    case 0x7d: return '&#125;';
    case 0xa0: return '&nbsp;';
    default: return ch;
  }
}

/**
 * The new raw text of a JsxText node so that `cookJsxText(result) === newText`.
 *
 * The node's own formatting survives: a leading or trailing run of whitespace
 * that contains a newline is the indentation around the text, and is kept. When
 * the new text starts (or ends) with whitespace that the kept indentation would
 * swallow, the text is written as a `{"..."}` expression instead.
 */
export function encodeJsxTextReplacement(raw: string, newText: string): string {
  const leadRun = whitespaceRun(raw, false);
  const lead = hasLineBreak(leadRun) ? leadRun : '';
  // A raw that is all whitespace has one run, and it is the lead; it must not be counted twice.
  const trailRun = leadRun.length === raw.length ? '' : whitespaceRun(raw, true);
  const trail = hasLineBreak(trailRun) ? trailRun : '';
  if (newText === '') return lead + trail;

  const expression = `{${JSON.stringify(newText)}}`;
  let core = '';
  for (let i = 0; i < newText.length; i++) core += escapeJsxTextChar(newText.charCodeAt(i), newText.charAt(i));
  const candidate = lead + core + trail;
  // Plain text when the compiler would read it back exactly; otherwise (leading or
  // trailing whitespace under an indentation run, a tab or separator that folds) an
  // expression, whose value is exact by construction.
  return cookJsxText(candidate) === newText ? candidate : lead + expression + trail;
}

function hex4(code: number): string {
  return '\\u' + code.toString(16).padStart(4, '0');
}

/** The quote character a literal's source opens with; a double quote when it opens with neither. */
function quoteOf(source: string): '"' | "'" {
  return source.charAt(0) === "'" ? "'" : '"';
}

/**
 * Escapes `s` for the inside of a JS string or template literal. Lone
 * surrogates are written as `\uXXXX`, because they cannot survive being saved
 * to a UTF-8 file.
 */
function escapeJsBody(s: string, quote: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s.charAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + ch;
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || isSeparatorBreak(code)) out += hex4(code);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + s.charAt(i + 1);
        i++;
      } else out += hex4(code);
    } else if (code >= 0xdc00 && code <= 0xdfff) out += hex4(code);
    else if (quote === '`' && ch === '$' && s.charAt(i + 1) === '{') out += '\\$';
    else out += ch;
  }
  return out;
}

/** A JS string literal for `newText`, keeping the quote character the original used. */
export function encodeStringLiteral(originalLiteralSource: string, newText: string): string {
  const quote = quoteOf(originalLiteralSource);
  return quote + escapeJsBody(newText, quote) + quote;
}

/** A template literal (no substitutions) for `newText`. */
export function encodeTemplateLiteral(newText: string): string {
  return '`' + escapeJsBody(newText, '`') + '`';
}

/**
 * Replacement for a string literal written directly as a JSX attribute value
 * (`title="..."`). Those take no backslash escapes, so anything that would need
 * one is written as a `{"..."}` expression instead.
 */
export function encodeJsxAttributeString(originalInitializerSource: string, newText: string): string {
  const quote = quoteOf(originalInitializerSource);
  let needsExpression = newText.includes(quote);
  for (let i = 0; i < newText.length && !needsExpression; i++) {
    const code = newText.charCodeAt(i);
    needsExpression = code === 0x26 || code === 0x7b || code === 0x7d || code === 0x0a || code === 0x0d || isSeparatorBreak(code);
  }
  return needsExpression ? `{${JSON.stringify(newText)}}` : quote + newText + quote;
}

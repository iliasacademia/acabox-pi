/**
 * Resolve a clicked piece of rendered text to the ONE literal in a tool's
 * source that wrote it, and plan the rewrite (POC; docs/design/mini-app-text-edit-poc.md, T2).
 *
 * Pure: source text in, decision out. No fs, no electron. The parser is
 * TypeScript's own, which is the reference parser for .tsx.
 *
 * The rule that keeps this safe is conservative on purpose. A literal is
 * editable only where it is pure display: JSX text, a JSX attribute, a string
 * shown as a JSX child, or an object property that nothing else compares,
 * looks up or types. Anything the code might also be reading as data is
 * refused, because the build cannot catch that kind of break.
 */
import * as ts from 'typescript';
import type { TextEditKind, TextEditRefusal, TextEditTarget } from '../../shared/miniAppTextEdit';
import {
  cookJsxText,
  decodeJsxEntities,
  encodeJsxAttributeString,
  encodeJsxTextReplacement,
  encodeStringLiteral,
  encodeTemplateLiteral,
} from './jsxText';

export interface AppSource {
  /** App-relative, e.g. "src/App.tsx". */
  path: string;
  text: string;
}

export interface ResolveInput {
  /** The tool, e.g. "geneExplorer". */
  dirName: string;
  /** Every source file under the tool's src/. */
  files: AppSource[];
  target: TextEditTarget;
}

export type Resolution =
  | {
    ok: true;
    file: string;
    start: number;
    end: number;
    kind: TextEditKind;
    sameElementScope: boolean;
    /** Source text of the literal / JsxText being replaced, for planning. */
    original: string;
  }
  | { ok: false; reason: TextEditRefusal; message: string };

export interface PlannedEdit { start: number; end: number; replacement: string }

const MESSAGES = {
  computed: "This text is produced by the tool's code while it runs, so it can't be changed here directly.",
  ambiguous: "This exact text appears in several places in the tool's code, so it isn't clear which one to change.",
  usedLookup: "The tool's code also uses this text to look things up, so changing it here could break the tool.",
  usedOther: "This text is set in the tool's code in a way that isn't safe to change here.",
  outside: "This text comes from a shared component or library, not from this tool's own code, so it can't be changed here.",
  noText: 'There is no text to change.',
} as const;

/** JSX attributes whose value is data or configuration, never display text. */
const DENIED_ATTRIBUTES: ReadonlySet<string> = new Set((
  'key ref className class style id href src srcSet type name value defaultValue htmlFor role target rel method action '
  + 'accept pattern autoComplete inputMode lang dir form fill stroke d viewBox xmlns width height color variant size icon '
  + 'kind mode as to path url dataKey accessor field column sortKey format tabIndex min max step'
).split(' '));

/** Object property names that hold data or configuration, never display text. */
const DENIED_PROPERTIES: ReadonlySet<string> = new Set((
  'id key type kind value field column col dataKey accessor accessorKey className cls class style color fill stroke href '
  + 'src url path file icon variant mode status format sort sortKey slug code ref gridTemplateColumns gridArea padding '
  + 'margin flex width height font fontFamily family fontWeight align display position background backgroundColor border '
  + 'cursor transform transition opacity zIndex hovertemplate'
).split(' '));

// ── Parsing ────────────────────────────────────────────────────────────

/**
 * Parses are cached by the AppSource object itself: the service hands back the
 * same object while a file's (mtime, size) is unchanged, so an unchanged file
 * is parsed once however many clicks resolve against it.
 */
const parseCache = new WeakMap<AppSource, ts.SourceFile>();

function parseSource(file: AppSource): ts.SourceFile {
  const cached = parseCache.get(file);
  if (cached) return cached;
  const kind = file.path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
  parseCache.set(file, sf);
  return sf;
}

function parseErrorCount(sf: ts.SourceFile): number {
  return (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
}

/** `"<file>:<line>:<col>"` split on the LAST two colons; line and column must be positive integers. */
export function parseSrcLoc(src: string): { file: string; line: number; col: number } | null {
  if (typeof src !== 'string') return null;
  const last = src.lastIndexOf(':');
  if (last <= 0) return null;
  const second = src.lastIndexOf(':', last - 1);
  if (second <= 0) return null;
  const line = src.slice(second + 1, last);
  const col = src.slice(last + 1);
  if (!/^[1-9][0-9]*$/.test(line) || !/^[1-9][0-9]*$/.test(col)) return null;
  const lineNumber = Number(line);
  const colNumber = Number(col);
  if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(colNumber)) return null;
  return { file: src.slice(0, second), line: lineNumber, col: colNumber };
}

/** The tool-relative path of a stamp that points into this tool's src/, else null. */
function stampPathInTool(loc: { file: string }, dirName: string): string | null {
  const root = `.applications/${dirName}/`;
  return loc.file.startsWith(`${root}src/`) ? loc.file.slice(root.length) : null;
}

// ── Classifying literals ────────────────────────────────────────────────

type LiteralNode = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
type JsxElementLike = ts.JsxElement | ts.JsxSelfClosingElement;

interface Occurrence {
  file: AppSource;
  sf: ts.SourceFile;
  node: ts.Node;
  category: 'display' | 'usage' | 'other';
  /** Present for a display occurrence. */
  kind?: TextEditKind;
  /** jsx-text / jsx-expression: the JsxElement or JsxFragment whose child it is. */
  container?: ts.Node;
  /** Start and end of the span planTextEdit replaces. */
  start: number;
  end: number;
}

type Classification = Pick<Occurrence, 'category' | 'kind' | 'container'>;

const OTHER: Classification = { category: 'other' };
const USAGE: Classification = { category: 'usage' };

/** What an attribute value is: display text, or data. `null` when it cannot reach a text node at all. */
function classifyAttributeValue(attribute: ts.JsxAttribute): Classification | null {
  if (isHostElementAttribute(attribute)) return null;
  return isDeniedAttributeName(attribute.name) ? OTHER : { category: 'display', kind: 'jsx-attribute' };
}

function isJsxAttributeInitializer(node: ts.Node): node is ts.StringLiteral {
  return ts.isStringLiteral(node) && node.parent !== undefined && ts.isJsxAttribute(node.parent) && node.parent.initializer === node;
}

/** A lowercase tag is a DOM element; anything else (`Card`, `Foo.Bar`, `this.X`) is a component. */
function isHostTagName(tag: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tag) ? /^[a-z]/.test(tag.text) : ts.isJsxNamespacedName(tag);
}

/**
 * An attribute written on a DOM element (`<input placeholder="...">`) can never
 * be the source of a rendered text node, so a literal there says nothing about
 * where clicked text came from. On a component it might: the component can
 * render its `title` prop as text.
 */
function isHostElementAttribute(attribute: ts.JsxAttribute): boolean {
  const opening = attribute.parent.parent;
  return isHostTagName(opening.tagName);
}

function isDeniedAttributeName(name: ts.JsxAttributeName): boolean {
  if (!ts.isIdentifier(name)) return true; // a namespaced name such as xlink:href is never display text
  const text = name.text;
  return DENIED_ATTRIBUTES.has(text) || text.startsWith('data-') || text.startsWith('aria-');
}

/** A property name that can hold display text: an identifier or string-literal key, not denied. */
function isEditablePropertyName(name: ts.PropertyName): boolean {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return !DENIED_PROPERTIES.has(name.text);
  return false;
}

const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InKeyword,
]);

/** True when `node` is the NAME of a declaration or member, not a value. */
function isNameOfMember(parent: ts.Node, node: ts.Node): boolean {
  return (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isPropertySignature(parent)
    || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent))
    && parent.name === node;
}

/** An identifier that names a property: written `obj.Revenue`, `{ Revenue: 1 }`, `Revenue: number`, `{ Revenue } = obj`. */
function isPropertyNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isBindingElement(parent)) {
    return parent.propertyName === node || (parent.propertyName === undefined && parent.name === node && ts.isObjectBindingPattern(parent.parent));
  }
  return isNameOfMember(parent, node);
}

/**
 * Decides what a string or template literal is to the program: pure display in
 * one of three places, a use of the text as code, or something else we leave alone.
 */
function classifyLiteral(literal: LiteralNode): Classification | null {
  if (isJsxAttributeInitializer(literal)) return classifyAttributeValue(literal.parent as ts.JsxAttribute);
  let cur: ts.Node = literal;
  for (;;) {
    const parent: ts.Node | undefined = cur.parent;
    if (!parent) return OTHER;

    // Looking through wrappers that do not change the value.
    if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)
      || ((ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)) && parent.expression === cur)) {
      cur = parent;
      continue;
    }
    if (ts.isConditionalExpression(parent)) {
      if (cur === parent.whenTrue || cur === parent.whenFalse) { cur = parent; continue; }
      return OTHER;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) { cur = parent; continue; }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (cur === parent.right) { cur = parent; continue; }
        return OTHER;
      }
      return COMPARISON_OPERATORS.has(op) ? USAGE : OTHER;
    }

    if (ts.isJsxExpression(parent)) {
      const holder = parent.parent;
      if (holder && (ts.isJsxElement(holder) || ts.isJsxFragment(holder))) {
        return { category: 'display', kind: 'jsx-expression', container: holder };
      }
      if (holder && ts.isJsxAttribute(holder)) return classifyAttributeValue(holder);
      return OTHER;
    }
    if (ts.isPropertyAssignment(parent)) {
      if (parent.initializer === cur) {
        return isEditablePropertyName(parent.name) ? { category: 'display', kind: 'object-property' } : OTHER;
      }
      return USAGE; // the literal is the key
    }
    if (ts.isCaseClause(parent)) return parent.expression === cur ? USAGE : OTHER;
    if (ts.isElementAccessExpression(parent)) return parent.argumentExpression === cur ? USAGE : OTHER;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      return parent.arguments !== undefined && parent.arguments.some((a) => a === cur) ? USAGE : OTHER;
    }
    if (ts.isArrayLiteralExpression(parent) || ts.isLiteralTypeNode(parent) || ts.isComputedPropertyName(parent)) return USAGE;
    if (isNameOfMember(parent, cur)) return USAGE;
    return OTHER;
  }
}

/** What a node shows on screen, which is what the clicked text node's value is compared against. */
function displayValue(node: ts.JsxText | LiteralNode, sf: ts.SourceFile): string {
  if (ts.isJsxText(node)) return cookJsxText(sf.text.slice(node.pos, node.end));
  if (isJsxAttributeInitializer(node)) return decodeJsxEntities(node.text);
  return node.text;
}

/** Every JsxText and literal whose display value is exactly `text`, plus identifiers that NAME a property `text`. */
function collectOccurrences(files: AppSource[], text: string): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of files) {
    const sf = parseSource(file);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node)) {
        if (displayValue(node, sf) === text) {
          found.push({ file, sf, node, category: 'display', kind: 'jsx-text', container: node.parent, start: node.pos, end: node.end });
        }
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (displayValue(node, sf) === text) {
          const classified = classifyLiteral(node);
          if (classified) found.push({ file, sf, node, ...classified, start: node.getStart(sf), end: node.end });
        }
      } else if (ts.isIdentifier(node) && node.text === text && isPropertyNameIdentifier(node)) {
        found.push({ file, sf, node, category: 'usage', start: node.getStart(sf), end: node.end });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

// ── Finding elements by stamp ──────────────────────────────────────────

interface FoundElement { file: AppSource; sf: ts.SourceFile; node: JsxElementLike }

function jsxTagText(el: JsxElementLike, sf: ts.SourceFile): string {
  return (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText(sf);
}

/** The first node under `root` (outermost first) for which `pick` answers, skipping subtrees that cannot hold `pos`. */
function findAt<T extends ts.Node>(root: ts.Node, pos: number, pick: (n: ts.Node) => T | undefined): T | undefined {
  const walk = (node: ts.Node): T | undefined => {
    if (pos < node.pos || pos >= node.end) return undefined;
    return pick(node) ?? ts.forEachChild(node, walk);
  };
  return walk(root);
}

/** All JsxElements whose opening `<` sits on a given 0-based line. */
function elementsStartingOnLine(sf: ts.SourceFile, line: number): ts.JsxElement[] {
  const found: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && sf.getLineAndCharacterOfPosition(node.getStart(sf)).line === line) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * The JSX element the CLICKED element's stamp points at, when it points into
 * this tool. The element is the JsxElement or JsxSelfClosingElement whose `<`
 * is at the stamped line and column.
 *
 * `expectedTag` is the clicked element's tag (empty when unknown, which skips
 * the check). A stamp is only ever put on a DOM element, whose tag is the tag
 * written in the JSX, so a different tag at the stamped position means the
 * stamp is stale (a text edit above it moved the lines) and must not be
 * trusted. Then, and when nothing starts at the position at all, the element
 * still resolves if exactly one JsxElement of the right tag starts on that line.
 */
function elementForStamp(stamp: string, input: ResolveInput, expectedTag: string): FoundElement | null {
  const loc = parseSrcLoc(stamp);
  if (!loc) return null;
  const rel = stampPathInTool(loc, input.dirName);
  if (rel === null) return null;
  const file = input.files.find((f) => f.path === rel);
  if (!file) return null;
  const sf = parseSource(file);
  const starts = sf.getLineStarts();
  if (loc.line - 1 >= starts.length) return null;

  const lineStart = starts[loc.line - 1];
  const lineEnd = loc.line < starts.length ? starts[loc.line] : sf.text.length;
  const pos = lineStart + (loc.col - 1);
  if (pos < lineEnd) {
    const node = findAt(sf, pos, (n) => ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && n.getStart(sf) === pos ? n : undefined));
    if (node && (expectedTag === '' || jsxTagText(node, sf).toLowerCase() === expectedTag)) return { file, sf, node };
  }
  if (expectedTag !== '') {
    const sameTag = elementsStartingOnLine(sf, loc.line - 1).filter((el) => jsxTagText(el, sf).toLowerCase() === expectedTag);
    if (sameTag.length === 1) return { file, sf, node: sameTag[0] };
  }
  return null;
}

/**
 * True when the occurrence is a direct child of `element`'s own JSX: a JsxText
 * child, or a literal inside a child JsxExpression, looking through child
 * JsxFragments (they make no DOM node).
 */
function isDirectChild(occ: Occurrence, element: FoundElement | null): boolean {
  if (!element || occ.file !== element.file || occ.container === undefined) return false;
  if (occ.kind !== 'jsx-text' && occ.kind !== 'jsx-expression') return false;
  let holder: ts.Node | undefined = occ.container;
  while (holder !== undefined && holder !== element.node) {
    if (!ts.isJsxFragment(holder)) return false;
    holder = holder.parent;
  }
  return holder !== undefined;
}

/**
 * True when the literal is the WHOLE content of its JsxExpression (looking
 * through parentheses, `as`, `satisfies`, `!`), so it renders as that child
 * whatever the row. One branch of `?:`, `||`, `??` or `&&` is not whole: the
 * other branches may come from data, and sibling rows may differ.
 */
function isWholeExpression(occ: Occurrence): boolean {
  let cur: ts.Node = occ.node;
  for (;;) {
    const parent: ts.Node | undefined = cur.parent;
    if (!parent) return false;
    if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)
      || ((ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)) && parent.expression === cur)) {
      cur = parent;
      continue;
    }
    return ts.isJsxExpression(parent) && parent.expression === cur;
  }
}

function isHostContainer(occ: Occurrence): boolean {
  return occ.container !== undefined && ts.isJsxElement(occ.container) && isHostTagName(occ.container.openingElement.tagName);
}

// ── Resolving ──────────────────────────────────────────────────────────

function refuse(reason: TextEditRefusal, message: string): Resolution {
  return { ok: false, reason, message };
}

function isStampOutsideTool(stamp: string | null, dirName: string): boolean {
  if (stamp === null) return false;
  const loc = parseSrcLoc(stamp);
  return loc !== null && stampPathInTool(loc, dirName) === null;
}

/** Decides which literal in the tool's source a clicked text node came from, or why it cannot be edited here. */
export function resolveTextEdit(input: ResolveInput): Resolution {
  const { dirName, files, target } = input;
  if (typeof target.text !== 'string' || target.text.trim() === '') return refuse('invalid', MESSAGES.noText);

  const all = collectOccurrences(files, target.text);
  const display = all.filter((o) => o.category === 'display');

  // 1. Nothing displays this text. Say why, as precisely as the evidence allows.
  if (display.length === 0) {
    if (all.length === 0 && isStampOutsideTool(target.elementSrc, dirName)) return refuse('outside-tool', MESSAGES.outside);
    if (all.some((o) => o.category === 'usage')) return refuse('used-by-code', MESSAGES.usedLookup);
    if (all.some((o) => o.category === 'other')) return refuse('used-by-code', MESSAGES.usedOther);
    return refuse('computed', MESSAGES.computed);
  }

  const tag = String(target.tagName ?? '').toLowerCase();
  const clicked = target.elementSrc !== null ? elementForStamp(target.elementSrc, input, tag) : null;

  // 2. Pick the candidate. Rule (a) only: exactly one candidate that is a direct child of the
  // clicked element's JSX. No containment rule: the right literal is often outside every DOM ancestor.
  let chosen: Occurrence | undefined;
  if (display.length === 1) {
    chosen = display[0];
    // A child literal of a DOM element renders only inside that element's own node, so it cannot be
    // the source of text clicked in a different element of this tool.
    if ((chosen.kind === 'jsx-text' || chosen.kind === 'jsx-expression') && isHostContainer(chosen)
      && clicked !== null && !isDirectChild(chosen, clicked)) {
      return refuse('ambiguous', MESSAGES.ambiguous);
    }
  } else {
    const direct = display.filter((o) => isDirectChild(o, clicked));
    if (direct.length !== 1) return refuse('ambiguous', MESSAGES.ambiguous);
    chosen = direct[0];
  }

  // 4. A value in a data object is editable only if nothing else treats the text as code.
  if (chosen.kind === 'object-property' && all.some((o) => o.category === 'usage')) {
    return refuse('used-by-code', MESSAGES.usedLookup);
  }

  // 3. The frame may update its other copies when the literal is the clicked element's own child.
  return {
    ok: true,
    file: chosen.file.path,
    start: chosen.start,
    end: chosen.end,
    kind: chosen.kind as TextEditKind,
    sameElementScope: isDirectChild(chosen, clicked) && (chosen.kind === 'jsx-text' || isWholeExpression(chosen)),
    original: chosen.file.text.slice(chosen.start, chosen.end),
  };
}

// ── Planning and verifying ─────────────────────────────────────────────

function findLiteralAt(sf: ts.SourceFile, start: number, end: number): LiteralNode | undefined {
  return findAt<LiteralNode>(sf, start, (n) => (
    (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.getStart(sf) === start && n.end === end ? n : undefined
  ));
}

/** The source text that replaces the resolved span so the tool shows `newText` there. */
export function planTextEdit(file: AppSource, r: Resolution & { ok: true }, newText: string): PlannedEdit {
  const original = file.text.slice(r.start, r.end);
  if (r.kind === 'jsx-text') {
    return { start: r.start, end: r.end, replacement: encodeJsxTextReplacement(original, newText) };
  }
  const literal = findLiteralAt(parseSource(file), r.start, r.end);
  if (!literal) throw new Error(`planTextEdit: no literal at ${file.path}:${r.start}-${r.end}`);
  let replacement: string;
  if (ts.isNoSubstitutionTemplateLiteral(literal)) replacement = encodeTemplateLiteral(newText);
  else if (isJsxAttributeInitializer(literal)) replacement = encodeJsxAttributeString(original, newText);
  else replacement = encodeStringLiteral(original, newText);
  return { start: r.start, end: r.end, replacement };
}

/**
 * Checks a spliced file before it is written: the edit must add no parse
 * errors, and, unless the text was deleted, the tool must now display exactly
 * `newText` where the edit landed.
 */
export function verifyPlannedEdit(before: AppSource, afterText: string, plan: PlannedEdit, newText: string): boolean {
  if (afterText !== before.text.slice(0, plan.start) + plan.replacement + before.text.slice(plan.end)) return false;
  const after: AppSource = { path: before.path, text: afterText };
  if (parseErrorCount(parseSource(after)) > parseErrorCount(parseSource(before))) return false;
  if (newText === '') return true;
  return collectOccurrences([after], newText).some((o) => (
    o.category === 'display' && o.start >= plan.start && o.start <= plan.start + plan.replacement.length
  ));
}

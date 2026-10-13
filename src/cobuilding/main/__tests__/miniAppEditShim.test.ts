/**
 * @jest-environment node
 *
 * Exercises the ACTUAL string injected into mini-app frames, evaluated in a
 * real DOM. A reimplementation of the logic here would keep passing while the
 * shipped shim was broken, and this shim is unusually exposed to that: it is
 * plain ES5 text that never passes through the build or the typechecker.
 *
 * Each case builds its own JSDOM window, matching the app: `did-frame-navigate`
 * injects into a freshly committed document.
 *
 * jsdom has no layout, no `caretRangeFromPoint`, no `isContentEditable`, no
 * `execCommand` and no `Range` rects. Where the shim has a real-browser path
 * for one of those, the case stubs the browser API and drives that path; where
 * it has a fallback (the first text of the clicked element, the attribute walk,
 * a Range splice), the case runs the fallback. Typing is stood in for by
 * setting the editor span's text: jsdom has no editing engine.
 *
 * `@jest-environment node` because every DOM here is built by hand with
 * `require('jsdom')`; the default jsdom environment would only add a second,
 * unused window.
 */
import { MINI_APP_EDIT_SHIM } from '../miniAppEditShim';
import {
  EDIT_ID_PATTERN,
  EDIT_MSG,
  MAX_ANCESTOR_SRCS,
  MINI_APP_SRC_ATTR,
} from '../../shared/miniAppTextEdit';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as typeof import('jsdom');
// acorn is not a direct dependency (webpack brings it in); it is only used here
// to prove the shim is ES5, which nothing else in the toolchain can.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const acorn = require('acorn') as { parse: (src: string, opts: { ecmaVersion: number }) => unknown };

type Msg = Record<string, any>;

interface Clock {
  advance: (ms: number) => void;
  pending: () => number;
}

interface Frame {
  window: any;
  document: any;
  /** Everything the shim posted to its parent, in order. */
  posted: Msg[];
  clock: Clock | null;
  install: () => unknown;
  /** Deliver a host -> frame message. */
  host: (data: unknown) => void;
  /** Dispatch an event and return it, so a case can read `defaultPrevented`. */
  fire: (type: string, target: any, init?: Record<string, unknown>) => any;
  click: (target: any, init?: Record<string, unknown>) => any;
  key: (target: any, key: string, init?: Record<string, unknown>) => any;
  ofType: (type: string) => Msg[];
  /** Forget what has been posted so far. */
  clear: () => void;
}

// A clock the case controls. The shim reads `window.setTimeout` and
// `Date.now()`, both of which resolve against this window, so replacing them
// makes the 30 ms hover throttle and the 4 s stamp watch deterministic.
function installClock(win: any): Clock {
  let now = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  win.Date.now = () => now;
  win.setTimeout = (fn: () => void, ms = 0) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  win.clearTimeout = (id: number) => { timers.delete(id); };
  return {
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        // Earliest first; a timer a callback schedules inside the window still runs.
        const due = Array.from(timers.entries())
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
    },
  };
}

const MOUSE_EVENTS = new Set(['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'mousemove', 'contextmenu']);

const frames: Frame[] = [];
afterEach(() => {
  // Closing the window drops its timers, so a flash that was meant to outlive
  // its case cannot keep the process alive.
  while (frames.length) frames.pop()!.window.close();
});

function makeFrame(bodyHtml: string, opts: { clock?: boolean } = {}): Frame {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    url: 'http://localhost:3000/tools/demo/index.html',
  });
  const w: any = dom.window;
  const posted: Msg[] = [];
  Object.defineProperty(w, 'parent', {
    configurable: true,
    value: { postMessage: (msg: Msg) => posted.push(msg) },
  });
  const clock = opts.clock ? installClock(w) : null;

  const fire = (type: string, target: any, init: Record<string, unknown> = {}) => {
    const base = { bubbles: true, cancelable: true, ...init };
    let ev: any;
    if (MOUSE_EVENTS.has(type)) ev = new w.MouseEvent(type, { clientX: 5, clientY: 5, ...base });
    else if (type.startsWith('key')) ev = new w.KeyboardEvent(type, base);
    else if (type === 'beforeinput' || type === 'input') ev = new w.InputEvent(type, base);
    else if (type.startsWith('focus')) ev = new w.FocusEvent(type, base);
    else ev = new w.Event(type, base);
    target.dispatchEvent(ev);
    return ev;
  };

  const frame: Frame = {
    window: w,
    document: w.document,
    posted,
    clock,
    install: () => w.eval(MINI_APP_EDIT_SHIM),
    host: (data) => { w.dispatchEvent(new w.MessageEvent('message', { data })); },
    fire,
    click: (target, init) => fire('click', target, init),
    key: (target, key, init) => fire('keydown', target, { key, ...init }),
    ofType: (type) => posted.filter((m) => m.type === type),
    clear: () => { posted.length = 0; },
  };
  frames.push(frame);
  return frame;
}

const modeOn = (f: Frame) => f.host({ type: EDIT_MSG.mode, on: true });
const modeOff = (f: Frame) => f.host({ type: EDIT_MSG.mode, on: false });

/** A frame with the shim installed and edit mode on; the install chatter is forgotten. */
function editing(bodyHtml: string, opts: { clock?: boolean } = {}): Frame {
  const f = makeFrame(bodyHtml, opts);
  f.install();
  modeOn(f);
  f.clear();
  return f;
}

/** Real timers, real microtasks: lets a MutationObserver callback land. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const q = (f: Frame, selector: string): any => {
  const el = f.document.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
};

// A page shaped like a real tool: every host element stamped, text split by an
// inline element, a plain heading, a list rendered from one literal.
const APP = `
  <main id="root" data-acabox-src="a.tsx:1:1">
    <section data-acabox-src="a.tsx:2:3">
      <h1 id="title" data-acabox-src="a.tsx:3:5">Gene explorer</h1>
      <p id="sentence" data-acabox-src="a.tsx:4:5">Showing <strong id="count" data-acabox-src="a.tsx:4:20">312</strong> genes above threshold</p>
      <button id="run" data-acabox-src="a.tsx:5:5">Run analysis</button>
    </section>
  </main>`;

/** Click the element, expect exactly one new probe, and return it. */
function probeFor(f: Frame, el: any, init?: Record<string, unknown>): Msg {
  const before = f.ofType(EDIT_MSG.probe).length;
  f.click(el, init);
  const probes = f.ofType(EDIT_MSG.probe);
  if (probes.length !== before + 1) throw new Error(`expected one new probe, got ${probes.length - before}`);
  return probes[probes.length - 1];
}

/** Click, let the host say yes (or no), and return the editor span and the probe. */
function openEditor(f: Frame, selector: string, editable = true): { span: any; probe: Msg } {
  const probe = probeFor(f, q(f, selector));
  f.host({ type: EDIT_MSG.probeResult, probeId: probe.probeId, editable });
  return { span: f.document.querySelector('[data-acabox-editor]'), probe };
}

/** jsdom has no editing engine: setting the span's text stands in for typing. */
function typeInto(span: any, text: string): void {
  span.textContent = text;
}

/** Type, press Enter, and return the commit the shim posted. */
function commit(f: Frame, span: any, text: string): Msg {
  typeInto(span, text);
  f.clear();
  f.key(span, 'Enter');
  const commits = f.ofType(EDIT_MSG.commit);
  if (commits.length !== 1) throw new Error(`expected one commit, got ${commits.length}`);
  return commits[0];
}

/** A non-empty box for every element, so flashes have somewhere to draw. */
function stubElementBoxes(f: Frame): void {
  f.window.Element.prototype.getBoundingClientRect = () => ({
    left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30, x: 10, y: 10,
  });
}

/** What a Range reports for the given node, by its text. */
function stubRangeBoxes(f: Frame, boxFor: (node: any) => { left: number; top: number; width: number; height: number }): void {
  const full = (node: any) => {
    const b = boxFor(node);
    return { ...b, right: b.left + b.width, bottom: b.top + b.height };
  };
  f.window.Range.prototype.getBoundingClientRect = function () { return full(this.startContainer); };
  f.window.Range.prototype.getClientRects = function () { return [full(this.startContainer)]; };
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
/** cssstyle may store a colour as given or normalised to rgb(); compare either. */
const normColor = (c: string) => (c.startsWith('#') ? rgb(c) : c);

describe('MINI_APP_EDIT_SHIM — as shipped text', () => {
  it('is plain ES5, parsed with acorn at ecmaVersion 5', () => {
    // The shim is injected as text into a document Acabox does not control and
    // never passes through a transpiler. An arrow function or `const` slipped
    // into it would still work in today's Chromium and in this test's jsdom;
    // only a parser pinned to ES5 notices.
    expect(() => acorn.parse(MINI_APP_EDIT_SHIM, { ecmaVersion: 5 })).not.toThrow();
  });

  it('carries no template leftovers (a stray dollar-brace or backtick)', () => {
    expect(MINI_APP_EDIT_SHIM).not.toContain('${');
    expect(MINI_APP_EDIT_SHIM).not.toContain('`');
  });

  it('interpolates the contract constants instead of repeating them', () => {
    expect(MINI_APP_EDIT_SHIM).toContain(JSON.stringify(MINI_APP_SRC_ATTR));
    expect(MINI_APP_EDIT_SHIM).toContain(JSON.stringify(EDIT_MSG));
    expect(MINI_APP_EDIT_SHIM).toContain(`var MAX_ANCESTORS = ${MAX_ANCESTOR_SRCS};`);
  });

  it('keeps its regex escapes verbatim (String.raw), so folding really works on the wire', () => {
    // In an ordinary template literal \n would have become a real newline in
    // this text and broken the regex literal.
    expect(MINI_APP_EDIT_SHIM).toContain('/[\\r\\n\\t]+/g');
    expect(MINI_APP_EDIT_SHIM).toContain('/\\u00a0/g');
  });
});

describe('MINI_APP_EDIT_SHIM — install', () => {
  it('installs once and posts ready', () => {
    const f = makeFrame(APP);
    expect(f.install()).toBe('installed');
    expect(f.install()).toBe('already-installed');
    expect(f.posted).toEqual([{ type: EDIT_MSG.ready }]);
  });

  it('adds nothing to the page and leaks no global but its guard', () => {
    const f = makeFrame(APP);
    const before = new Set(Object.getOwnPropertyNames(f.window));
    const htmlBefore = f.document.documentElement.outerHTML;
    f.install();
    const added = Object.getOwnPropertyNames(f.window).filter((n) => !before.has(n));
    expect(added).toEqual(['__acaboxEditShimInstalled']);
    // No style, no layer, no class until the host asks for edit mode.
    expect(f.document.documentElement.outerHTML).toBe(htmlBefore);
  });
});

describe('MINI_APP_EDIT_SHIM — mode off', () => {
  it('leaves the tool alone: its handlers fire and nothing is cancelled or probed', () => {
    const f = makeFrame(APP);
    f.install();
    const run = q(f, '#run');
    const onClick = jest.fn();
    const onKey = jest.fn();
    run.addEventListener('click', onClick);
    f.document.addEventListener('keydown', onKey);
    f.window.addEventListener('click', onClick, true);

    const click = f.click(run);
    const key = f.key(f.document.body, 'Escape');

    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(false);
    expect(key.defaultPrevented).toBe(false);
    // Only the install announcement: no probe, no shortcut.
    expect(f.posted).toEqual([{ type: EDIT_MSG.ready }]);
    expect(f.document.documentElement.className).toBe('');
    expect(f.document.getElementById('__acabox_edit_layer')).toBeNull();
  });

  it('answers a mode-off with an acknowledgement even when it was never on', () => {
    const f = makeFrame(APP);
    f.install();
    f.clear();
    modeOff(f);
    expect(f.posted).toEqual([{ type: EDIT_MSG.state, on: false, stamped: 6, final: true }]);
  });

  it('ignores a mode message that does not say on or off', () => {
    const f = makeFrame(APP);
    f.install();
    f.clear();
    f.host({ type: EDIT_MSG.mode });
    f.host({ type: EDIT_MSG.mode, on: 'yes' });
    expect(f.posted).toEqual([]);
    expect(f.document.documentElement.className).toBe('');
  });
});

describe('MINI_APP_EDIT_SHIM — mode on', () => {
  it('posts a state with the stamped count and marks the page as editing', () => {
    const f = makeFrame(APP);
    f.install();
    f.clear();
    modeOn(f);

    // main, section, h1, p, strong, button.
    expect(f.posted).toEqual([{ type: EDIT_MSG.state, on: true, stamped: 6, final: true }]);
    const html = f.document.documentElement;
    expect(html.classList.contains('__acabox-editing')).toBe(true);
    const style = f.document.getElementById('__acabox_edit_style');
    expect(style.textContent).toContain('html.__acabox-editing, html.__acabox-editing * { cursor: text !important; }');
  });

  it('draws a click-through layer on <html>, never inside #root', () => {
    const f = editing(APP);
    const layer = f.document.getElementById('__acabox_edit_layer');
    expect(layer.parentNode).toBe(f.document.documentElement);
    expect(f.document.getElementById('root').contains(layer)).toBe(false);
    expect(layer.style.position).toBe('fixed');
    expect(layer.style.inset).toBe('0');
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.style.zIndex).toBe('2147483647');
    // The layer is not a tool element, so it never inflates the stamp count.
    expect(layer.hasAttribute(MINI_APP_SRC_ATTR)).toBe(false);
  });

  it('is idempotent: a second mode-on re-reports without a second layer or style', () => {
    const f = editing(APP);
    modeOn(f);
    expect(f.posted).toEqual([{ type: EDIT_MSG.state, on: true, stamped: 6, final: true }]);
    expect(f.document.querySelectorAll('#__acabox_edit_layer')).toHaveLength(1);
    expect(f.document.querySelectorAll('#__acabox_edit_style')).toHaveLength(1);
  });

  it('releases a focused tool control before it starts blocking, so the tool sees a normal blur', () => {
    const f = makeFrame(`${APP}<input id="field">`);
    f.install();
    const field = q(f, '#field');
    const onFocusOut = jest.fn();
    f.document.addEventListener('focusout', onFocusOut);
    field.focus();
    expect(f.document.activeElement).toBe(field);

    modeOn(f);

    expect(f.document.activeElement).not.toBe(field);
    // Before blocking began: the tool's own focusout listener heard it.
    expect(onFocusOut).toHaveBeenCalledTimes(1);
  });

  it('stops a tool control taking focus: blurred at once, and the tool never hears the focusin', () => {
    const f = editing(`${APP}<input id="field">`);
    const field = q(f, '#field');
    const onFocusIn = jest.fn();
    f.document.addEventListener('focusin', onFocusIn);

    field.focus();

    expect(onFocusIn).not.toHaveBeenCalled();
    expect(f.document.activeElement).not.toBe(field);
  });

  it('does not recurse when a tool refocuses itself the moment it is blurred', () => {
    // A focus trap (onblur -> focus()) would otherwise ping-pong with the shim's
    // own blur until the stack ran out. One blur, then the tool is left alone.
    const f = editing(`${APP}<input id="field">`);
    const field = q(f, '#field');
    let blurs = 0;
    field.addEventListener('blur', () => { blurs += 1; field.focus(); });

    expect(() => field.focus()).not.toThrow();

    expect(blurs).toBe(1);
  });

  // Every event the tool must not see while editing, and whether its default
  // action is cancelled as well. pointerdown/up are stopped but not cancelled
  // on purpose: cancelling pointerdown suppresses the compatibility mousedown,
  // and mousedown is the event whose default (focus, selection) has to be
  // cancelled.
  const BLOCKED: Array<[string, boolean]> = [
    ['click', true], ['dblclick', true], ['auxclick', true], ['mousedown', true], ['mouseup', true],
    ['pointerdown', false], ['pointerup', false], ['contextmenu', true], ['submit', true], ['dragstart', true],
    ['touchstart', false], ['touchend', false],
    ['keydown', false], ['keyup', false], ['keypress', false], ['input', false], ['beforeinput', false],
    ['paste', false], ['cut', false], ['focusin', false], ['focusout', false],
  ];

  it.each(BLOCKED)('keeps %s from the tool (default cancelled outside the editor: %s)', (type, cancelled) => {
    const f = editing(`${APP}<form id="form"><button id="inside">go</button></form>`);
    const button = q(f, '#inside');
    const spies = [jest.fn(), jest.fn(), jest.fn(), jest.fn()];
    button.addEventListener(type, spies[0]);
    f.document.addEventListener(type, spies[1]);
    f.document.addEventListener(type, spies[2], true);
    f.window.addEventListener(type, spies[3]);

    const ev = f.fire(type, button);

    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(ev.defaultPrevented).toBe(cancelled);
  });

  it('beats a window-level capture listener the tool registers after the shim', () => {
    // stopImmediatePropagation: the shim registered first, on the same target
    // and phase, so it wins.
    const f = editing(APP);
    const late = jest.fn();
    f.window.addEventListener('click', late, true);
    f.window.addEventListener('keydown', late, true);

    f.click(q(f, '#run'));
    f.key(f.document.body, 'a');

    expect(late).not.toHaveBeenCalled();
  });

  it('does not block hover, wheel or scroll, so the tool stays live', () => {
    const f = editing(APP);
    const seen: string[] = [];
    for (const type of ['mouseover', 'pointermove', 'wheel', 'scroll']) {
      f.document.addEventListener(type, () => seen.push(type), true);
    }
    for (const type of ['mouseover', 'pointermove', 'wheel', 'scroll']) f.fire(type, q(f, '#run'));
    expect(seen).toEqual(['mouseover', 'pointermove', 'wheel', 'scroll']);
  });

  it('lets scroll keys through: only Escape and undo are acted on, nothing else is cancelled', () => {
    const f = editing(APP);
    for (const key of ['ArrowDown', 'PageDown', ' ', 'a', 'Enter', 'Tab']) {
      expect(f.key(f.document.body, key).defaultPrevented).toBe(false);
    }
  });
});

describe('MINI_APP_EDIT_SHIM — what a click probes', () => {
  it('posts the exact target for stamped text, nearest ancestors first', () => {
    const f = editing(APP);
    const probe = probeFor(f, q(f, '#title'));

    expect(probe.probeId).toMatch(EDIT_ID_PATTERN);
    expect(probe.target).toEqual({
      text: 'Gene explorer',
      elementSrc: 'a.tsx:3:5',
      tagName: 'h1',
      ancestorSrcs: ['a.tsx:2:3', 'a.tsx:1:1'],
    });
    expect(Object.keys(probe).sort()).toEqual(['probeId', 'target', 'type']);
  });

  it('takes the first text of the clicked element, and the stamp of its parent', () => {
    const f = editing(APP);
    const probe = probeFor(f, q(f, '#sentence'));
    expect(probe.target.text).toBe('Showing ');
    expect(probe.target.elementSrc).toBe('a.tsx:4:5');
    expect(probe.target.tagName).toBe('p');
  });

  it('reports a null elementSrc for an unstamped parent and still lists stamped ancestors', () => {
    const f = editing('<div data-acabox-src="x.tsx:1:1"><span id="s">plain</span></div>');
    const probe = probeFor(f, q(f, '#s'));
    expect(probe.target).toEqual({ text: 'plain', elementSrc: null, tagName: 'span', ancestorSrcs: ['x.tsx:1:1'] });
  });

  it('treats an empty stamp attribute as no stamp, on the element and on its ancestors', () => {
    const f = editing('<div data-acabox-src="x.tsx:1:1"><div data-acabox-src=""><p id="p" data-acabox-src="">plain</p></div></div>');
    expect(probeFor(f, q(f, '#p')).target).toEqual({
      text: 'plain', elementSrc: null, tagName: 'p', ancestorSrcs: ['x.tsx:1:1'],
    });
  });

  it('drops consecutive duplicate ancestors, and any equal to the clicked element, but keeps a repeat that is not consecutive', () => {
    const f = editing(`
      <section data-acabox-src="s:1:1">
        <div data-acabox-src="s:2:3">
          <div data-acabox-src="s:2:3">
            <div>
              <div data-acabox-src="s:3:5">
                <p id="p" data-acabox-src="s:3:5">Hello</p>
              </div>
            </div>
          </div>
        </div>
      </section>`);
    expect(probeFor(f, q(f, '#p')).target.ancestorSrcs).toEqual(['s:2:3', 's:1:1']);

    // A, B, A reads as a different place each time and must survive.
    const g = editing(`
      <div data-acabox-src="A"><div data-acabox-src="B"><div data-acabox-src="A"><p id="p">x</p></div></div></div>`);
    expect(probeFor(g, q(g, '#p')).target.ancestorSrcs).toEqual(['A', 'B', 'A']);
  });

  it(`sends at most ${MAX_ANCESTOR_SRCS} ancestors, the nearest ones`, () => {
    let html = '<p id="p">deep</p>';
    for (let i = 1; i <= MAX_ANCESTOR_SRCS + 4; i++) html = `<div data-acabox-src="n${i}">${html}</div>`;
    const f = editing(html);
    const sent: string[] = probeFor(f, q(f, '#p')).target.ancestorSrcs;
    expect(sent).toHaveLength(MAX_ANCESTOR_SRCS);
    expect(sent[0]).toBe('n1');
    expect(sent[MAX_ANCESTOR_SRCS - 1]).toBe(`n${MAX_ANCESTOR_SRCS}`);
  });

  it('probes text inside a button, which tools write constantly', () => {
    const f = editing(APP);
    expect(probeFor(f, q(f, '#run')).target.text).toBe('Run analysis');
  });

  const NEVER: Array<[string, string, string]> = [
    ['a textarea', '<textarea id="x">a draft</textarea>', '#x'],
    ['an option', '<select><option id="x">Choice</option></select>', '#x'],
    ['svg text', '<svg><text id="x">Axis label</text></svg>', '#x'],
    ['a script', '<script id="x">var a = 1</script>', '#x'],
    ['a style block', '<style id="x">p { color: red }</style>', '#x'],
    ['canvas fallback', '<canvas id="x">fallback</canvas>', '#x'],
    ['whitespace only', '<p id="x">   \n  </p>', '#x'],
    ['a lone non-breaking space', '<p id="x">&nbsp;</p>', '#x'],
    ['the tool\'s own contenteditable', '<div id="x" contenteditable="true">hello</div>', '#x'],
    ['inside the tool\'s own contenteditable', '<div contenteditable="true"><b id="x">deep</b></div>', '#x'],
    ['a text node past what the host will accept', `<p id="x">${'x'.repeat(10001)}</p>`, '#x'],
    ['an input (no text node at all)', '<input id="x" value="hello">', '#x'],
  ];

  it.each(NEVER)('never probes %s', (_name, html, selector) => {
    const f = editing(html);
    f.click(q(f, selector));
    expect(f.posted).toEqual([]);
  });

  it('trusts the browser\'s own isContentEditable over the attribute walk', () => {
    const f = editing('<div id="a">editable by script</div><div id="b" contenteditable="true">attribute, but the browser says no</div>');
    Object.defineProperty(f.window.HTMLElement.prototype, 'isContentEditable', {
      configurable: true,
      get() { return this.id === 'a'; },
    });

    f.click(q(f, '#a'));
    expect(f.posted).toEqual([]);

    expect(probeFor(f, q(f, '#b')).target.text).toBe('attribute, but the browser says no');
  });

  it('probes text the tool marked contenteditable="false" inside an editable region', () => {
    // The nearest contenteditable attribute decides, as isContentEditable would.
    const f = editing('<div contenteditable="true"><span id="x" contenteditable="false">locked label</span></div>');
    expect(probeFor(f, q(f, '#x')).target.text).toBe('locked label');
  });

  it('does probe text exactly at the limit', () => {
    const f = editing(`<p id="x">${'x'.repeat(10000)}</p>`);
    expect(probeFor(f, q(f, '#x')).target.text).toHaveLength(10000);
  });

  it('never probes while edit mode is off', () => {
    const f = makeFrame(APP);
    f.install();
    f.clear();
    f.click(q(f, '#title'));
    expect(f.posted).toEqual([]);
  });

  describe('with a real browser\'s caret API', () => {
    const TITLE_BOX = [{ left: 0, top: 0, right: 100, bottom: 20 }];

    function caretFrame(rects: unknown[] | 'missing' = TITLE_BOX): { f: Frame; text: any } {
      const f = editing(APP);
      const text = q(f, '#title').firstChild;
      f.document.caretRangeFromPoint = jest.fn(() => ({ startContainer: text, startOffset: 4 }));
      if (rects === 'missing') {
        delete f.window.Range.prototype.getClientRects;
      } else {
        f.window.Range.prototype.getClientRects = () => rects;
      }
      return { f, text };
    }

    it('uses the node it returns, not the clicked element, and asks about the click position', () => {
      const { f, text } = caretFrame();
      // The click lands on the BUTTON's box, but the caret API says the text is
      // the heading's: the API wins, because the element under the pointer is
      // not what was pointed at when text wraps or spans elements.
      const probe = probeFor(f, q(f, '#run'), { clientX: 50, clientY: 10 });
      expect(f.document.caretRangeFromPoint).toHaveBeenCalledWith(50, 10);
      expect(probe.target.text).toBe(text.nodeValue);
      expect(probe.target.elementSrc).toBe('a.tsx:3:5');
    });

    it('refuses a point that is not on the text, with a 2 px tolerance', () => {
      const { f } = caretFrame();
      f.click(q(f, '#title'), { clientX: 150, clientY: 10 });
      expect(f.posted).toEqual([]);
      // 1.5 px past the right edge is inside the tolerance.
      probeFor(f, q(f, '#title'), { clientX: 101.5, clientY: 10 });
      // 2.5 px past is not.
      f.clear();
      f.click(q(f, '#title'), { clientX: 102.5, clientY: 10 });
      expect(f.posted).toEqual([]);
    });

    it('accepts an empty rect list, and a browser that cannot measure at all', () => {
      const empty = caretFrame([]).f;
      probeFor(empty, q(empty, '#title'));

      const blind = caretFrame('missing').f;
      probeFor(blind, q(blind, '#title'), { clientX: 9999, clientY: 9999 });
    });

    it('does not fall back to the clicked element when the API answers null', () => {
      const f = editing(APP);
      f.document.caretRangeFromPoint = () => null;
      f.click(q(f, '#title'));
      expect(f.posted).toEqual([]);
    });

    it('refuses a position that is not inside a text node', () => {
      const f = editing(APP);
      f.document.caretRangeFromPoint = () => ({ startContainer: q(f, '#title'), startOffset: 0 });
      f.click(q(f, '#title'));
      expect(f.posted).toEqual([]);
    });

    it('falls back to caretPositionFromPoint when caretRangeFromPoint is missing', () => {
      const f = editing(APP);
      const text = q(f, '#title').firstChild;
      f.document.caretPositionFromPoint = jest.fn(() => ({ offsetNode: text, offset: 2 }));
      f.window.Range.prototype.getClientRects = () => TITLE_BOX;
      const probe = probeFor(f, q(f, '#run'), { clientX: 40, clientY: 10 });
      expect(f.document.caretPositionFromPoint).toHaveBeenCalledWith(40, 10);
      expect(probe.target.text).toBe('Gene explorer');
    });

    it('puts the caret at the clicked offset, clamped to the text', () => {
      const { f } = caretFrame();
      const { span } = openEditor(f, '#title');
      const sel = f.window.getSelection();
      expect(sel.anchorNode).toBe(span.firstChild);
      expect(sel.anchorOffset).toBe(4);

      // An offset past the end (a caret API reporting the end of a longer node).
      const g = editing(APP);
      const text = q(g, '#title').firstChild;
      g.document.caretRangeFromPoint = () => ({ startContainer: text, startOffset: 999 });
      g.window.Range.prototype.getClientRects = () => TITLE_BOX;
      const opened = openEditor(g, '#title');
      expect(g.window.getSelection().anchorOffset).toBe('Gene explorer'.length);
      expect(opened.span.firstChild.nodeValue).toBe('Gene explorer');
    });
  });
});

describe('MINI_APP_EDIT_SHIM — the host answers a probe', () => {
  it('opens a direct editor in front of the text, whose own node stays in the page, blank', () => {
    const f = editing(APP);
    const title = q(f, '#title');
    const original = title.firstChild;

    const { span } = openEditor(f, '#title');

    expect(span.getAttribute('data-acabox-editor')).toBe('direct');
    expect(span.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(span.getAttribute('spellcheck')).toBe('true');
    expect(span.textContent).toBe('Gene explorer');
    // Editor first, then the original node, still a child of its parent, with
    // its text blanked so the words are not shown twice.
    expect(Array.from(title.childNodes)).toEqual([span, original]);
    expect(original.nodeValue).toBe('');
    expect(f.document.activeElement).toBe(span);
  });

  it('keeps the original text node in the page while editing, so the tool\'s own DOM calls against it still work', () => {
    // What React does when a re-render inserts a sibling before this text, or
    // removes it: calls that name the node it created. With that node taken out
    // of the page they throw NotFoundError and blank the whole tool (measured
    // against React 19.2 in Chromium 138). This is the regression guard.
    const f = editing(APP);
    const title = q(f, '#title');
    const original = title.firstChild;
    openEditor(f, '#title');

    const sibling = f.document.createElement('em');
    expect(() => title.insertBefore(sibling, original)).not.toThrow();
    expect(() => title.removeChild(original)).not.toThrow();
  });

  it.each([
    ['Escape', (f: Frame, span: any) => { f.key(span, 'Escape'); }],
    ['Enter on unchanged text', (f: Frame, span: any) => { f.key(span, 'Enter'); }],
  ])('does not overwrite a newer value the tool wrote into the text while it was open (%s)', (_how, finish) => {
    const f = editing(APP);
    const original = q(f, '#title').firstChild;
    const { span } = openEditor(f, '#title');

    original.nodeValue = 'Written by the tool';
    finish(f, span);

    expect(original.nodeValue).toBe('Written by the tool');
  });

  it('does not overwrite a newer value the tool wrote when a suggestion is sent either', () => {
    const f = editing(APP);
    const original = q(f, '#count').firstChild;
    const { span } = openEditor(f, '#count', false);
    typeInto(span, '500');

    original.nodeValue = '313';
    f.key(span, 'Enter');

    expect(original.nodeValue).toBe('313');
  });

  it('falls back to contenteditable="true" in a browser that does not know plaintext-only', () => {
    const f = editing(APP);
    // What Chromium reports for a value it does not support: 'inherit'.
    Object.defineProperty(f.window.HTMLElement.prototype, 'contentEditable', {
      configurable: true,
      get() { return this.getAttribute('contenteditable') === 'plaintext-only' ? 'inherit' : this.getAttribute('contenteditable'); },
    });
    const { span } = openEditor(f, '#title');
    expect(span.getAttribute('contenteditable')).toBe('true');
  });

  it('keeps plaintext-only in a browser that knows it', () => {
    const f = editing(APP);
    Object.defineProperty(f.window.HTMLElement.prototype, 'contentEditable', {
      configurable: true,
      get() { return this.getAttribute('contenteditable'); },
    });
    expect(openEditor(f, '#title').span.getAttribute('contenteditable')).toBe('plaintext-only');
  });

  it('opens an amber editor when the host says the text cannot be edited directly', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#count', false);
    expect(span.getAttribute('data-acabox-editor')).toBe('suggest');
    expect(span.textContent).toBe('312');
    // The colours live in the injected stylesheet, keyed on that attribute.
    const css = f.document.getElementById('__acabox_edit_style').textContent;
    expect(css).toContain('[data-acabox-editor="suggest"] { outline-color: #b45309');
    expect(css).toContain('[data-acabox-editor] { outline: 2px solid #0645b1');
  });

  it('ignores an answer for a probe that is not the latest', () => {
    const f = editing(APP);
    const first = probeFor(f, q(f, '#title'));
    const second = probeFor(f, q(f, '#run'));

    f.host({ type: EDIT_MSG.probeResult, probeId: first.probeId, editable: true });
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();

    f.host({ type: EDIT_MSG.probeResult, probeId: second.probeId, editable: true });
    expect(f.document.querySelector('[data-acabox-editor]').textContent).toBe('Run analysis');
  });

  it('ignores an answer nobody asked for, a repeated answer, and a malformed one', () => {
    const f = editing(APP);
    f.host({ type: EDIT_MSG.probeResult, probeId: 'e99-nothing', editable: true });
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();

    const probe = probeFor(f, q(f, '#title'));
    f.host({ type: EDIT_MSG.probeResult, probeId: probe.probeId, editable: 'yes' });
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
    // The pending probe was consumed by the malformed answer: a second try is stale.
    f.host({ type: EDIT_MSG.probeResult, probeId: probe.probeId, editable: true });
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
  });

  it('ignores an answer for text the tool has since removed, and leaves no half-open editor behind', () => {
    const f = editing(APP);
    const probe = probeFor(f, q(f, '#title'));
    q(f, '#title').remove();
    f.host({ type: EDIT_MSG.probeResult, probeId: probe.probeId, editable: true });
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();

    // A phantom editor, one that was recorded but never made it into the page,
    // would swallow Escape as a cancel. With nothing open, Escape is the
    // "leave edit mode" shortcut.
    f.clear();
    f.key(f.document.body, 'Escape');
    expect(f.posted).toEqual([{ type: EDIT_MSG.shortcut, action: 'done' }]);
  });

  it('hands focus back to the editor when the tool tries to take it while text is being edited', () => {
    const f = editing(`${APP}<input id="field">`);
    const { span } = openEditor(f, '#title');
    q(f, '#field').focus();
    expect(f.document.activeElement).toBe(span);
  });
});

describe('MINI_APP_EDIT_SHIM — finishing an edit', () => {
  it('gives the SAME text node the new value, leaves it the only child, and posts the commit', () => {
    const f = editing(APP);
    const title = q(f, '#title');
    const original = title.firstChild;
    const { span, probe } = openEditor(f, '#title');

    const posted = commit(f, span, 'Locus explorer');

    expect(title.firstChild).toBe(original);
    expect(title.childNodes).toHaveLength(1);
    expect(original.nodeValue).toBe('Locus explorer');
    expect(span.parentNode).toBeNull();
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
    expect(posted.editId).toMatch(EDIT_ID_PATTERN);
    expect(posted.newText).toBe('Locus explorer');
    expect(posted.target).toEqual(probe.target);
    expect(Object.keys(posted).sort()).toEqual(['editId', 'newText', 'target', 'type']);
  });

  it('keeps Enter from becoming a line break and Shift+Enter from committing', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Changed');
    f.clear();

    expect(f.key(span, 'Enter', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(f.posted).toEqual([]);
    expect(f.document.querySelector('[data-acabox-editor]')).not.toBeNull();

    const enter = f.key(span, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(f.ofType(EDIT_MSG.commit)).toHaveLength(1);
  });

  it('commits on Tab and does not let Tab move focus', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Tabbed');
    f.clear();
    const tab = f.key(span, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(f.ofType(EDIT_MSG.commit)[0].newText).toBe('Tabbed');
  });

  it('leaves Enter, Tab and Escape to an input method that is composing', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'にほん');
    f.clear();
    for (const key of ['Enter', 'Tab', 'Escape']) {
      expect(f.key(span, key, { isComposing: true }).defaultPrevented).toBe(false);
      expect(f.key(span, key, { keyCode: 229 }).defaultPrevented).toBe(false);
    }
    expect(f.posted).toEqual([]);
    expect(f.document.querySelector('[data-acabox-editor]')).not.toBeNull();
  });

  it('cancels on Escape: the node is back, untouched, and nothing is posted', () => {
    const f = editing(APP);
    const title = q(f, '#title');
    const original = title.firstChild;
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Something else');
    f.clear();

    f.key(span, 'Escape');

    expect(f.posted).toEqual([]);
    expect(title.firstChild).toBe(original);
    expect(original.nodeValue).toBe('Gene explorer');
  });

  it('posts nothing when the text is unchanged', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    f.clear();
    f.key(span, 'Enter');
    expect(f.posted).toEqual([]);
    expect(q(f, '#title').textContent).toBe('Gene explorer');
  });

  it('does not mistake an untouched text that holds a line break for an edit', () => {
    const f = editing('<pre id="x" data-acabox-src="p:1:1">line one\nline two</pre>');
    const { span } = openEditor(f, '#x');
    f.clear();
    f.key(span, 'Enter');
    expect(f.posted).toEqual([]);
  });

  it('folds a non-breaking space to a space and a run of newlines or tabs to one space', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    const posted = commit(f, span, 'a\u00a0b\nc\r\n\td');
    expect(posted.newText).toBe('a b c d');
    expect(q(f, '#title').firstChild.nodeValue).toBe('a b c d');
  });

  it('keeps a non-breaking space when the original text used one', () => {
    const f = editing('<p id="x" data-acabox-src="n:1:1">10\u00a0mg</p>');
    const { span } = openEditor(f, '#x');
    const posted = commit(f, span, '20\u00a0mg\u00a0daily');
    expect(posted.newText).toBe('20\u00a0mg\u00a0daily');
  });

  it('sends an empty string when everything was deleted', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    expect(commit(f, span, '').newText).toBe('');
    expect(q(f, '#title').firstChild.nodeValue).toBe('');
  });

  it('refuses text the host would silently drop: old text back, nothing posted', () => {
    const f = editing(APP);
    const original = q(f, '#title').firstChild;
    const { span } = openEditor(f, '#title');
    typeInto(span, 'x'.repeat(10001));
    f.clear();
    f.key(span, 'Enter');
    expect(f.posted).toEqual([]);
    expect(original.nodeValue).toBe('Gene explorer');
    expect(q(f, '#title').firstChild).toBe(original);
  });

  it('commits when the window loses focus to the host, but not when an element does', () => {
    const f = editing(`${APP}<input id="field">`);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'From the host');
    f.clear();

    // An element's blur travels down through window in the capture phase too.
    f.fire('blur', q(f, '#run'), { bubbles: false });
    expect(f.posted).toEqual([]);

    f.window.dispatchEvent(new f.window.Event('blur'));
    expect(f.ofType(EDIT_MSG.commit)).toHaveLength(1);
    expect(f.ofType(EDIT_MSG.commit)[0].newText).toBe('From the host');
  });

  it('ignores a window blur when nothing is being edited', () => {
    const f = editing(APP);
    f.window.dispatchEvent(new f.window.Event('blur'));
    expect(f.posted).toEqual([]);
  });

  it('finishes cleanly when the tool removed the editor from under it', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Orphaned');
    span.remove();
    f.clear();

    expect(() => modeOff(f)).not.toThrow();

    // Still reported: the user did type it, and the host decides what to do.
    expect(f.ofType(EDIT_MSG.commit)[0].newText).toBe('Orphaned');
  });

  it('keeps the editor open for a drag that began inside it and ended outside', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Dragged');
    f.clear();

    f.fire('mousedown', span);
    // The click of a drag that ends elsewhere lands on the common ancestor.
    const click = f.click(q(f, '#root'));

    expect(f.posted).toEqual([]);
    expect(f.document.querySelector('[data-acabox-editor]')).toBe(span);
    // Outside the editor, so the tool still must not act on it.
    expect(click.defaultPrevented).toBe(true);

    // The next ordinary click outside does close it.
    f.click(q(f, '#root'));
    expect(f.ofType(EDIT_MSG.commit)).toHaveLength(1);
  });

  it('lets the browser act inside the editor and cancels it everywhere else', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'dragstart']) {
      expect(f.fire(type, span).defaultPrevented).toBe(false);
    }
    // Typing keys are not cancelled either.
    expect(f.key(span, 'a').defaultPrevented).toBe(false);
    expect(f.key(span, 'z', { metaKey: true }).defaultPrevented).toBe(false);
    // The same events one element over, outside the editor, are all cancelled.
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'dragstart']) {
      expect(f.fire(type, q(f, '#run')).defaultPrevented).toBe(true);
    }
  });

  it('ignores a click inside the editor: nothing posted, editor still open', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    f.clear();
    f.click(span);
    expect(f.posted).toEqual([]);
    expect(f.document.querySelector('[data-acabox-editor]')).toBe(span);
  });

  it('commits the open edit and probes the clicked text in the same click', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Genes');
    f.clear();

    f.click(q(f, '#sentence'));

    expect(f.posted.map((m) => m.type)).toEqual([EDIT_MSG.commit, EDIT_MSG.probe]);
    expect(f.posted[1].target.text).toBe('Showing ');
    // The first editor is gone before the second can open.
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
  });

  it('hit-tests the click BEFORE closing the open editor, against the layout the user saw', () => {
    // jsdom's fallback cannot tell the difference, so ask the caret API itself
    // what the page looked like at the moment it was consulted. Closing the
    // editor first would let the text reflow under a click aimed at the old one.
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Genes');
    const sentence = q(f, '#sentence').firstChild;
    let editorOpenAtHitTest: boolean | null = null;
    f.document.caretRangeFromPoint = () => {
      editorOpenAtHitTest = f.document.querySelector('[data-acabox-editor]') !== null;
      return { startContainer: sentence, startOffset: 3 };
    };
    f.window.Range.prototype.getClientRects = () => [];
    f.clear();

    f.click(q(f, '#root'));

    expect(editorOpenAtHitTest).toBe(true);
    expect(f.posted.map((m) => m.type)).toEqual([EDIT_MSG.commit, EDIT_MSG.probe]);
    expect(f.posted[1].target.text).toBe('Showing ');
  });

  it('commits on a click in empty space and probes nothing', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Genes');
    f.clear();
    f.click(q(f, '#root'));
    expect(f.posted.map((m) => m.type)).toEqual([EDIT_MSG.commit]);
  });

  it('does not probe the editor\'s own text, nor the layer', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    f.clear();
    // jsdom's fallback would otherwise offer the span's text: the click is inside.
    f.click(span);
    f.click(f.document.getElementById('__acabox_edit_layer'));
    expect(f.ofType(EDIT_MSG.probe)).toEqual([]);
  });
});

describe('MINI_APP_EDIT_SHIM — suggesting a change to computed text', () => {
  it('posts a suggestion on Enter and keeps the old text on screen', () => {
    const f = editing(APP);
    const count = q(f, '#count');
    const original = count.firstChild;
    const { span } = openEditor(f, '#count', false);
    typeInto(span, '500');
    f.clear();

    f.key(span, 'Enter');

    expect(f.posted).toEqual([{ type: EDIT_MSG.suggest, oldText: '312', newText: '500' }]);
    expect(count.firstChild).toBe(original);
    expect(original.nodeValue).toBe('312');
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
  });

  it('flashes amber around the element, so the user sees where the request came from', () => {
    const f = editing(APP, { clock: true });
    stubElementBoxes(f);
    const layer = f.document.getElementById('__acabox_edit_layer');
    const { span } = openEditor(f, '#count', false);
    typeInto(span, '500');

    f.key(span, 'Enter');

    expect(layer.children).toHaveLength(2);
    expect(normColor(layer.children[1].style.borderColor)).toBe(rgb('#b45309'));
    f.clock!.advance(900);
    expect(layer.children).toHaveLength(1);
  });

  it('posts nothing on Escape or when the text is unchanged', () => {
    const f = editing(APP);
    const a = openEditor(f, '#count', false);
    typeInto(a.span, '500');
    f.clear();
    f.key(a.span, 'Escape');
    expect(f.posted).toEqual([]);

    const b = openEditor(f, '#count', false);
    f.clear();
    f.key(b.span, 'Enter');
    expect(f.posted).toEqual([]);
  });

  it('is never tracked as an applied edit: a revert for any id answers ok:false and the text stays', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#count', false);
    typeInto(span, '500');
    f.key(span, 'Enter');
    f.clear();
    f.host({ type: EDIT_MSG.revert, editId: 'e1-anything' });
    expect(f.posted).toEqual([{ type: EDIT_MSG.reverted, editId: 'e1-anything', ok: false }]);
    expect(q(f, '#count').textContent).toBe('312');
  });
});

describe('MINI_APP_EDIT_SHIM — paste and line breaks', () => {
  function pasteEvent(f: Frame, text: string | null): any {
    const ev = new f.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: text === null ? null : { getData: (type: string) => (type === 'text/plain' ? text : '') },
    });
    return ev;
  }

  it('inserts plain text with newlines folded, through execCommand when there is one', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    f.document.execCommand = jest.fn(() => true);

    const ev = pasteEvent(f, 'one\ntwo\r\nthree\tfour');
    span.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(f.document.execCommand).toHaveBeenCalledWith('insertText', false, 'one two three four');
  });

  it('splices the text in at the caret when execCommand is missing or refuses', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    span.dispatchEvent(pasteEvent(f, 'A\nB'));
    // The caret was placed at offset 0 when the editor opened.
    expect(span.textContent).toBe('A BGene explorer');

    const g = editing(APP);
    const opened = openEditor(g, '#title');
    g.document.execCommand = jest.fn(() => false);
    opened.span.dispatchEvent(pasteEvent(g, 'X'));
    expect(g.document.execCommand).toHaveBeenCalled();
    expect(opened.span.textContent).toBe('XGene explorer');
  });

  it('survives a paste with no clipboard data, and does nothing for an empty one', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    expect(() => span.dispatchEvent(pasteEvent(f, null))).not.toThrow();
    span.dispatchEvent(pasteEvent(f, ''));
    expect(span.textContent).toBe('Gene explorer');
  });

  it('does not cancel a paste outside the editor (nothing there to paste into)', () => {
    const f = editing(APP);
    const ev = pasteEvent(f, 'text');
    f.document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('cancels a paragraph or line break the browser is about to insert, and nothing else', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    expect(f.fire('beforeinput', span, { inputType: 'insertParagraph' }).defaultPrevented).toBe(true);
    expect(f.fire('beforeinput', span, { inputType: 'insertLineBreak' }).defaultPrevented).toBe(true);
    expect(f.fire('beforeinput', span, { inputType: 'insertText', data: 'x' }).defaultPrevented).toBe(false);
    expect(f.fire('beforeinput', span, { inputType: 'deleteContentBackward' }).defaultPrevented).toBe(false);
  });
});

describe('MINI_APP_EDIT_SHIM — the host answers an edit', () => {
  it('draws a pending outline on commit, swaps it for a green one on ok, and clears it after a moment', () => {
    const f = editing(APP, { clock: true });
    stubElementBoxes(f);
    const layer = f.document.getElementById('__acabox_edit_layer');
    const { span } = openEditor(f, '#title');
    const { editId } = commit(f, span, 'Locus explorer');

    // hover box + the pending outline
    expect(layer.children).toHaveLength(2);
    expect(layer.children[1].style.cssText).toContain('dashed');

    f.host({ type: EDIT_MSG.applyResult, editId, ok: true, sameElementScope: false });

    expect(layer.children).toHaveLength(2);
    const green = layer.children[1];
    expect(green.style.cssText).toContain('solid');
    expect(normColor(green.style.borderColor)).toBe(rgb('#05b01c'));
    expect(q(f, '#title').firstChild.nodeValue).toBe('Locus explorer');

    f.clock!.advance(900);
    expect(layer.children).toHaveLength(1);
  });

  it('on a failed apply puts the old text back and flashes red', () => {
    const f = editing(APP, { clock: true });
    stubElementBoxes(f);
    const layer = f.document.getElementById('__acabox_edit_layer');
    const { span } = openEditor(f, '#title');
    const { editId } = commit(f, span, 'Locus explorer');
    const node = q(f, '#title').firstChild;
    expect(node.nodeValue).toBe('Locus explorer');

    f.host({ type: EDIT_MSG.applyResult, editId, ok: false });

    expect(node.nodeValue).toBe('Gene explorer');
    expect(layer.children).toHaveLength(2);
    expect(normColor(layer.children[1].style.borderColor)).toBe(rgb('#b60000'));
  });

  it('does not overwrite text the tool has changed in the meantime', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    const { editId } = commit(f, span, 'Locus explorer');
    const node = q(f, '#title').firstChild;
    node.nodeValue = 'Written by the tool';

    f.host({ type: EDIT_MSG.applyResult, editId, ok: false });

    expect(node.nodeValue).toBe('Written by the tool');
  });

  it('forgets a failed edit: it cannot be reverted afterwards', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    const { editId } = commit(f, span, 'Locus explorer');
    f.host({ type: EDIT_MSG.applyResult, editId, ok: false });
    f.clear();

    f.host({ type: EDIT_MSG.revert, editId });

    expect(f.posted).toEqual([{ type: EDIT_MSG.reverted, editId, ok: false }]);
  });

  it('ignores an answer for an edit it does not know', () => {
    const f = editing(APP);
    f.host({ type: EDIT_MSG.applyResult, editId: 'e7-unknown', ok: false, sameElementScope: true });
    f.host({ type: EDIT_MSG.applyResult, ok: true });
    expect(f.posted).toEqual([]);
  });

  // One literal, rendered four times, plus decoys: same text under another
  // stamp, and the same stamp showing different text.
  const LIST = `
    <ul data-acabox-src="b.tsx:1:1">
      <li id="first" data-acabox-src="b.tsx:2:3">Gene</li>
      <li id="second" data-acabox-src="b.tsx:2:3">Gene</li>
      <li id="third" data-acabox-src="b.tsx:2:3">Other</li>
      <li id="fourth" data-acabox-src="b.tsx:2:3">Gene</li>
    </ul>
    <h2 id="elsewhere" data-acabox-src="b.tsx:9:1">Gene</h2>`;

  it('with sameElementScope, updates every copy of the literal and only those', () => {
    const f = editing(LIST);
    const { span } = openEditor(f, '#first');
    const { editId } = commit(f, span, 'Locus');

    f.host({ type: EDIT_MSG.applyResult, editId, ok: true, sameElementScope: true });

    expect(q(f, '#first').textContent).toBe('Locus');
    expect(q(f, '#second').textContent).toBe('Locus');
    expect(q(f, '#fourth').textContent).toBe('Locus');
    expect(q(f, '#third').textContent).toBe('Other');
    expect(q(f, '#elsewhere').textContent).toBe('Gene');
  });

  it('without sameElementScope, leaves the other copies alone', () => {
    const f = editing(LIST);
    const { span } = openEditor(f, '#first');
    const { editId } = commit(f, span, 'Locus');

    f.host({ type: EDIT_MSG.applyResult, editId, ok: true, sameElementScope: false });

    expect(q(f, '#second').textContent).toBe('Gene');
  });

  it('does not touch the other copies when the edit has no source stamp to match on', () => {
    const f = editing('<ul><li id="a">Gene</li><li id="b">Gene</li></ul>');
    const { span } = openEditor(f, '#a');
    const { editId } = commit(f, span, 'Locus');
    f.host({ type: EDIT_MSG.applyResult, editId, ok: true, sameElementScope: true });
    expect(q(f, '#b').textContent).toBe('Gene');
  });

  it('reverts the edited text and every copy it brought along', () => {
    const f = editing(LIST);
    const { span } = openEditor(f, '#first');
    const { editId } = commit(f, span, 'Locus');
    f.host({ type: EDIT_MSG.applyResult, editId, ok: true, sameElementScope: true });
    f.clear();

    f.host({ type: EDIT_MSG.revert, editId });

    expect(f.posted).toEqual([{ type: EDIT_MSG.reverted, editId, ok: true }]);
    expect(['#first', '#second', '#fourth'].map((s) => q(f, s).textContent)).toEqual(['Gene', 'Gene', 'Gene']);
    expect(q(f, '#third').textContent).toBe('Other');
  });

  it('reports ok:false for an unknown edit, a repeated revert, and text the tool has since changed', () => {
    const f = editing(APP);
    f.host({ type: EDIT_MSG.revert, editId: 'e42-nope' });
    expect(f.ofType(EDIT_MSG.reverted)).toEqual([{ type: EDIT_MSG.reverted, editId: 'e42-nope', ok: false }]);

    const { span } = openEditor(f, '#title');
    const { editId } = commit(f, span, 'Locus explorer');
    f.host({ type: EDIT_MSG.applyResult, editId, ok: true, sameElementScope: false });
    f.clear();
    f.host({ type: EDIT_MSG.revert, editId });
    f.host({ type: EDIT_MSG.revert, editId });
    expect(f.posted.map((m) => m.ok)).toEqual([true, false]);

    const { span: again } = openEditor(f, '#title');
    const second = commit(f, again, 'Third title');
    f.host({ type: EDIT_MSG.applyResult, editId: second.editId, ok: true, sameElementScope: false });
    q(f, '#title').firstChild.nodeValue = 'Something the tool wrote';
    f.clear();
    f.host({ type: EDIT_MSG.revert, editId: second.editId });
    expect(f.posted).toEqual([{ type: EDIT_MSG.reverted, editId: second.editId, ok: false }]);
    expect(q(f, '#title').firstChild.nodeValue).toBe('Something the tool wrote');
  });

  it('does not answer a revert that carries no usable id', () => {
    const f = editing(APP);
    f.host({ type: EDIT_MSG.revert });
    f.host({ type: EDIT_MSG.revert, editId: 42 });
    expect(f.posted).toEqual([]);
  });

  it('still honours an apply answer that lands after edit mode was switched off', () => {
    // The host sends mode-off and then waits for in-flight applies, so a late
    // answer is normal. Dropping it would leave a failed edit on screen.
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    const { editId } = commit(f, span, 'Locus explorer');
    const node = q(f, '#title').firstChild;
    modeOff(f);
    f.clear();

    f.host({ type: EDIT_MSG.applyResult, editId, ok: false });

    expect(node.nodeValue).toBe('Gene explorer');
  });

  it('still honours a revert after edit mode was switched off', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    const { editId } = commit(f, span, 'Locus explorer');
    f.host({ type: EDIT_MSG.applyResult, editId, ok: true, sameElementScope: false });
    modeOff(f);
    f.clear();

    f.host({ type: EDIT_MSG.revert, editId });

    expect(f.posted).toEqual([{ type: EDIT_MSG.reverted, editId, ok: true }]);
    expect(q(f, '#title').firstChild.nodeValue).toBe('Gene explorer');
  });
});

describe('MINI_APP_EDIT_SHIM — shortcuts in the frame', () => {
  it('asks the host to leave edit mode on Escape when no text is being edited', () => {
    const f = editing(APP);
    f.key(f.document.body, 'Escape');
    expect(f.posted).toEqual([{ type: EDIT_MSG.shortcut, action: 'done' }]);
  });

  it('asks the host to undo on Cmd+Z and Ctrl+Z, and cancels the key so nothing else undoes', () => {
    const f = editing(APP);
    expect(f.key(f.document.body, 'z', { metaKey: true }).defaultPrevented).toBe(true);
    expect(f.key(f.document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(f.key(f.document.body, 'Z', { metaKey: true }).defaultPrevented).toBe(true);
    expect(f.posted).toEqual([
      { type: EDIT_MSG.shortcut, action: 'undo' },
      { type: EDIT_MSG.shortcut, action: 'undo' },
      { type: EDIT_MSG.shortcut, action: 'undo' },
    ]);
  });

  it('does not treat redo, Alt+Cmd+Z or a bare Z as undo', () => {
    const f = editing(APP);
    f.key(f.document.body, 'z', { metaKey: true, shiftKey: true });
    f.key(f.document.body, 'z', { metaKey: true, altKey: true });
    f.key(f.document.body, 'z');
    expect(f.posted).toEqual([]);
  });

  it('inside an open editor Escape cancels only, and Cmd+Z is left to the browser\'s own undo', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    f.clear();
    expect(f.key(span, 'z', { metaKey: true }).defaultPrevented).toBe(false);
    expect(f.posted).toEqual([]);

    f.key(span, 'Escape');
    expect(f.posted).toEqual([]);
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
  });

  it('says nothing about shortcuts while edit mode is off', () => {
    const f = makeFrame(APP);
    f.install();
    f.clear();
    f.key(f.document.body, 'Escape');
    f.key(f.document.body, 'z', { metaKey: true });
    expect(f.posted).toEqual([]);
  });
});

describe('MINI_APP_EDIT_SHIM — leaving edit mode', () => {
  it('commits an open edit first, then acknowledges, then tidies the page', () => {
    const f = editing(APP);
    const { span } = openEditor(f, '#title');
    typeInto(span, 'Typed then Done');
    f.clear();

    modeOff(f);

    // Order matters: the host waits for the commit's answer AND the ack.
    expect(f.posted.map((m) => m.type)).toEqual([EDIT_MSG.commit, EDIT_MSG.state]);
    expect(f.posted[0].newText).toBe('Typed then Done');
    expect(f.posted[1]).toEqual({ type: EDIT_MSG.state, on: false, stamped: 6, final: true });
    expect(q(f, '#title').firstChild.nodeValue).toBe('Typed then Done');
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
    expect(f.document.getElementById('__acabox_edit_layer')).toBeNull();
    expect(f.document.documentElement.classList.contains('__acabox-editing')).toBe(false);
  });

  it('hands the page back: clicks reach the tool again and are no longer cancelled', () => {
    const f = editing(APP);
    modeOff(f);
    const onClick = jest.fn();
    q(f, '#run').addEventListener('click', onClick);
    const click = f.click(q(f, '#run'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(false);
  });

  it('cancels a probe still waiting for the host', () => {
    const f = editing(APP);
    const probe = probeFor(f, q(f, '#title'));
    modeOff(f);
    modeOn(f);
    f.host({ type: EDIT_MSG.probeResult, probeId: probe.probeId, editable: true });
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
  });

  it('can be switched on again and works as before', () => {
    const f = editing(APP);
    modeOff(f);
    modeOn(f);
    f.clear();
    expect(probeFor(f, q(f, '#title')).target.text).toBe('Gene explorer');
    // The stylesheet outlives a mode-off, so a second mode-on must find it.
    expect(f.document.querySelectorAll('#__acabox_edit_layer')).toHaveLength(1);
    expect(f.document.querySelectorAll('#__acabox_edit_style')).toHaveLength(1);
  });
});

describe('MINI_APP_EDIT_SHIM — waiting for stamps', () => {
  const UNSTAMPED = '<main id="root"><h1>Not built with stamps</h1></main>';

  it('reports a non-final zero first and a final zero only after 4 s', () => {
    const f = makeFrame(UNSTAMPED, { clock: true });
    f.install();
    f.clear();

    modeOn(f);
    expect(f.posted).toEqual([{ type: EDIT_MSG.state, on: true, stamped: 0, final: false }]);

    f.clock!.advance(3999);
    expect(f.posted).toHaveLength(1);

    f.clock!.advance(1);
    expect(f.posted).toEqual([
      { type: EDIT_MSG.state, on: true, stamped: 0, final: false },
      { type: EDIT_MSG.state, on: true, stamped: 0, final: true },
    ]);
  });

  it('reports a final count as soon as stamped elements appear, and then goes quiet', async () => {
    const f = makeFrame(UNSTAMPED, { clock: true });
    f.install();
    f.clear();
    modeOn(f);

    // The tool finishes rendering a little after the shim looked.
    const late = f.document.createElement('p');
    late.setAttribute(MINI_APP_SRC_ATTR, 'late.tsx:1:1');
    f.document.getElementById('root').appendChild(late);
    await tick();

    expect(f.posted).toEqual([
      { type: EDIT_MSG.state, on: true, stamped: 0, final: false },
      { type: EDIT_MSG.state, on: true, stamped: 1, final: true },
    ]);

    f.clock!.advance(10000);
    expect(f.posted).toHaveLength(2);
    // Its timer and observer are gone.
    expect(f.clock!.pending()).toBe(0);
  });

  it('does not restart the watch when mode-on repeats, and does not report twice', () => {
    const f = makeFrame(UNSTAMPED, { clock: true });
    f.install();
    f.clear();
    modeOn(f);
    f.clock!.advance(1000);
    modeOn(f);
    // Two non-final reports, one timer still counting from the first.
    expect(f.posted.map((m) => m.final)).toEqual([false, false]);
    f.clock!.advance(3000);
    expect(f.posted.map((m) => m.final)).toEqual([false, false, true]);
  });

  it('stops watching when edit mode is switched off', () => {
    const f = makeFrame(UNSTAMPED, { clock: true });
    f.install();
    modeOn(f);
    f.clear();
    modeOff(f);
    expect(f.posted).toEqual([{ type: EDIT_MSG.state, on: false, stamped: 0, final: true }]);
    // Checked BEFORE time moves: the watch's own callback is also guarded by
    // edit mode, so a leaked timer would stay silent once it fired and hide here.
    expect(f.clock!.pending()).toBe(0);
    f.clock!.advance(10000);
    expect(f.posted).toHaveLength(1);
  });

  it('a stamped page is final at once and starts no watch', () => {
    const f = makeFrame(APP, { clock: true });
    f.install();
    f.clear();
    modeOn(f);
    expect(f.posted).toEqual([{ type: EDIT_MSG.state, on: true, stamped: 6, final: true }]);
    expect(f.clock!.pending()).toBe(0);
  });
});

describe('MINI_APP_EDIT_SHIM — hover', () => {
  const RECTS: Record<string, { left: number; top: number; width: number; height: number }> = {
    'Gene explorer': { left: 10, top: 20, width: 100, height: 16 },
    'Run analysis': { left: 200, top: 300, width: 80, height: 24 },
  };

  function hoverFrame(): { f: Frame; box: any } {
    const f = editing(APP, { clock: true });
    stubRangeBoxes(f, (node) => RECTS[node.nodeValue] ?? { left: 0, top: 0, width: 0, height: 0 });
    const box = f.document.getElementById('__acabox_edit_layer').firstChild;
    return { f, box };
  }

  it('outlines the text under the pointer with a dashed box', () => {
    const { f, box } = hoverFrame();
    expect(box.style.display).toBe('none');

    f.fire('mousemove', q(f, '#title'));

    expect(box.style.display).toBe('block');
    expect(box.style.cssText).toContain('dashed');
    // The text's own rect, widened a little so the outline does not touch glyphs.
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['8px', '19px', '104px', '18px']);
  });

  it('is throttled to 30 ms but never leaves the box on a stale neighbour', () => {
    const { f, box } = hoverFrame();
    f.fire('mousemove', q(f, '#title'));
    expect(box.style.left).toBe('8px');

    // Inside the 30 ms window: held back, then applied by the trailing call.
    f.clock!.advance(10);
    f.fire('mousemove', q(f, '#run'));
    expect(box.style.left).toBe('8px');
    f.clock!.advance(19);
    expect(box.style.left).toBe('8px');
    f.clock!.advance(1);
    expect(box.style.left).toBe('198px');

    // Past the window: immediate again, with no timer left behind.
    f.clock!.advance(100);
    f.fire('mousemove', q(f, '#title'));
    expect(box.style.left).toBe('8px');
    expect(f.clock!.pending()).toBe(0);
  });

  it('hides when the pointer leaves the text and when anything scrolls', () => {
    const { f, box } = hoverFrame();
    f.fire('mousemove', q(f, '#title'));
    expect(box.style.display).toBe('block');

    f.clock!.advance(50);
    f.fire('mousemove', q(f, '#root'));
    expect(box.style.display).toBe('none');

    f.clock!.advance(50);
    f.fire('mousemove', q(f, '#title'));
    expect(box.style.display).toBe('block');
    f.fire('scroll', f.document);
    expect(box.style.display).toBe('none');
  });

  it('shows nothing for text it would not edit, and hides for text it cannot measure', () => {
    const f = editing(`${APP}<textarea id="t">draft</textarea>`, { clock: true });
    stubRangeBoxes(f, () => ({ left: 5, top: 5, width: 50, height: 10 }));
    const box = f.document.getElementById('__acabox_edit_layer').firstChild;
    f.fire('mousemove', q(f, '#t'));
    expect(box.style.display).toBe('none');

    // A zero-sized rect (display:none, or no layout) is not worth outlining.
    f.clock!.advance(50);
    stubRangeBoxes(f, () => ({ left: 0, top: 0, width: 0, height: 0 }));
    f.fire('mousemove', q(f, '#title'));
    expect(box.style.display).toBe('none');
  });

  it('stays off while an editor is open, and the box is hidden when it opens', () => {
    const { f, box } = hoverFrame();
    f.fire('mousemove', q(f, '#title'));
    expect(box.style.display).toBe('block');

    openEditor(f, '#title');
    expect(box.style.display).toBe('none');

    f.clock!.advance(100);
    f.fire('mousemove', q(f, '#run'));
    expect(box.style.display).toBe('none');
  });

  it('does nothing while edit mode is off', () => {
    const f = makeFrame(APP, { clock: true });
    f.install();
    stubRangeBoxes(f, () => ({ left: 5, top: 5, width: 50, height: 10 }));
    f.fire('mousemove', q(f, '#title'));
    expect(f.document.getElementById('__acabox_edit_layer')).toBeNull();
    expect(f.clock!.pending()).toBe(0);
  });
});

describe('MINI_APP_EDIT_SHIM — robustness and the wire contract', () => {
  it('ignores messages that are not edit commands, and survives garbage', () => {
    const f = editing(APP);
    const errors = jest.fn();
    f.window.addEventListener('error', errors);
    for (const data of [null, undefined, 'a string', 42, {}, { type: 7 }, { type: 'init', workspacePath: '/x' }, { type: 'clearQuoteSelection' }, []]) {
      f.host(data);
    }
    expect(errors).not.toHaveBeenCalled();
    expect(f.posted).toEqual([]);
  });

  it('treats its own frame-to-host messages as inert if they ever come back to the frame', () => {
    // A tool opened without a parent window posts to itself. Every message the
    // shim sends carries a host-bound type, none of which it listens for, so an
    // echo can neither switch edit mode on nor answer a probe that is not there.
    const f = makeFrame(APP);
    f.install();
    f.clear();
    for (const type of [EDIT_MSG.ready, EDIT_MSG.state, EDIT_MSG.probe, EDIT_MSG.commit, EDIT_MSG.suggest, EDIT_MSG.shortcut, EDIT_MSG.reverted]) {
      f.host({ type, on: true, probeId: 'e1-x', editId: 'e1-x', editable: true, ok: true });
    }
    expect(f.posted).toEqual([]);
    expect(f.document.querySelector('[data-acabox-editor]')).toBeNull();
    expect(f.document.getElementById('__acabox_edit_layer')).toBeNull();
    expect(f.document.documentElement.className).toBe('');
  });

  it('mints ids that satisfy the contract and never repeat', () => {
    const f = editing(`${APP}<p id="x" data-acabox-src="x:1:1">Alpha</p>`);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { span, probe } = openEditor(f, '#x');
      ids.push(probe.probeId);
      const posted = commit(f, span, `Alpha ${i}`);
      ids.push(posted.editId);
      f.host({ type: EDIT_MSG.applyResult, editId: posted.editId, ok: false });
    }
    expect(ids).toHaveLength(12);
    ids.forEach((id) => expect(id).toMatch(EDIT_ID_PATTERN));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every message it posts has exactly the fields the contract documents', () => {
    // One pass through everything the shim can say, each message validated
    // field by field. The host's parser is written from the same contract; if
    // the two ever disagree this is where it shows, and the final assertion
    // guards against the walk silently skipping a message type.
    const f = makeFrame(`${APP}<ul data-acabox-src="l:1:1"><li id="a" data-acabox-src="l:2:3">Gene</li></ul>`);
    // The helpers below clear `posted` to isolate what each step did; keep a
    // complete record on the side for the validation at the end.
    const everything: Msg[] = [];
    const push = f.posted.push.bind(f.posted);
    f.posted.push = (...items: Msg[]) => { everything.push(...items); return push(...items); };
    f.install();
    modeOn(f);

    const a = openEditor(f, '#title');
    const first = commit(f, a.span, 'Locus explorer');
    f.host({ type: EDIT_MSG.applyResult, editId: first.editId, ok: true, sameElementScope: false });
    f.key(f.document.body, 'z', { metaKey: true });
    f.host({ type: EDIT_MSG.revert, editId: first.editId });
    f.key(f.document.body, 'Escape');
    const b = openEditor(f, '#count', false);
    typeInto(b.span, '500');
    f.key(b.span, 'Enter');
    modeOff(f);

    const FIELDS: Record<string, string[]> = {
      [EDIT_MSG.ready]: ['type'],
      [EDIT_MSG.state]: ['type', 'on', 'stamped', 'final'],
      [EDIT_MSG.probe]: ['type', 'probeId', 'target'],
      [EDIT_MSG.commit]: ['type', 'editId', 'target', 'newText'],
      [EDIT_MSG.suggest]: ['type', 'oldText', 'newText'],
      [EDIT_MSG.shortcut]: ['type', 'action'],
      [EDIT_MSG.reverted]: ['type', 'editId', 'ok'],
    };
    const isTarget = (t: any) => t && typeof t.text === 'string' && t.text.length > 0
      && (t.elementSrc === null || typeof t.elementSrc === 'string')
      && typeof t.tagName === 'string' && Array.isArray(t.ancestorSrcs)
      && t.ancestorSrcs.length <= MAX_ANCESTOR_SRCS && t.ancestorSrcs.every((s: unknown) => typeof s === 'string')
      && Object.keys(t).sort().join() === 'ancestorSrcs,elementSrc,tagName,text';

    for (const m of everything) {
      expect(Object.keys(m).sort()).toEqual([...FIELDS[m.type]].sort());
      if (m.type === EDIT_MSG.state) {
        expect(typeof m.on).toBe('boolean');
        expect(Number.isInteger(m.stamped) && m.stamped >= 0).toBe(true);
        expect(typeof m.final).toBe('boolean');
      }
      if (m.type === EDIT_MSG.probe) { expect(m.probeId).toMatch(EDIT_ID_PATTERN); expect(isTarget(m.target)).toBe(true); }
      if (m.type === EDIT_MSG.commit) {
        expect(m.editId).toMatch(EDIT_ID_PATTERN);
        expect(isTarget(m.target)).toBe(true);
        expect(typeof m.newText).toBe('string');
      }
      if (m.type === EDIT_MSG.suggest) { expect(typeof m.oldText).toBe('string'); expect(typeof m.newText).toBe('string'); }
      if (m.type === EDIT_MSG.shortcut) expect(['undo', 'done']).toContain(m.action);
      if (m.type === EDIT_MSG.reverted) { expect(m.editId).toMatch(EDIT_ID_PATTERN); expect(typeof m.ok).toBe('boolean'); }
    }
    expect(new Set(everything.map((m) => m.type))).toEqual(new Set(Object.keys(FIELDS)));
  });
});

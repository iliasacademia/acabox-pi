/**
 * Script injected into every mini-app frame that turns the running tool into an
 * editable surface: click any text, type over it, and the host writes the change
 * into the tool's source. Edit mode for a tool's text (POC), design and tickets
 * in docs/design/mini-app-text-edit-poc.md, contracts in
 * shared/miniAppTextEdit.ts.
 *
 * WHY THIS IS INJECTED, NOT DONE FROM THE HOST
 * --------------------------------------------
 * Same constraint as `miniAppLinkShim.ts` and `miniAppSelectionShim.ts`: a tool
 * is `local-file://` while the host renderer is `http://localhost:3000` in dev
 * and `file://` when packaged, so `iframe.contentDocument` is null. Only the
 * frame can see its own text nodes, and only main can inject into the frame.
 *
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT
 * -----------------------------------------------
 * The shim owns the DOM half of the feature and nothing else. It finds the text
 * under the pointer, puts an editable span in front of that one Text node, and
 * reports what the user typed. It never learns where the text lives in the
 * source: the host asks main (`probe`), main answers editable-or-not, and the
 * shim only ever hears "yes", "no" or "that edit failed".
 *
 * The original Text node is never taken out of the page: it stays where React
 * put it, blank, while the span is open. The obvious swap (replaceChild, the
 * original kept detached) leaves React holding a node that is no longer a child
 * of its parent, and the first re-render that inserts a sibling before it
 * throws and blanks the whole tool. Measured with React 19.2 in Chromium 138.
 *
 * It stays idle until the host sends `mode {on:true}`; every handler returns
 * immediately before that, so injecting it into every tool costs a user who
 * never edits nothing.
 *
 * HOW IT KEEPS THE TOOL'S OWN BEHAVIOUR OUT OF THE WAY
 * ----------------------------------------------------
 * While edit mode is on, a click must not press the tool's buttons. Every
 * listener sits on `window` in the CAPTURE phase, which is the first stop on an
 * event's path, and stops the event there. Since this runs at navigation commit,
 * before the tool's own scripts, it is also first in line among same-target
 * listeners, so `stopImmediatePropagation` beats a handler the tool registers on
 * `window` later. React's delegated listeners sit on the root container, below
 * `window`, so they never see a blocked event.
 *
 * Two consequences the code has to respect:
 *
 *  1. THE EDITOR'S OWN BEHAVIOUR LIVES IN THESE WINDOW HANDLERS. Stopping an
 *     event at `window` means a listener on the editor span would never run.
 *     Enter, Escape, Tab, paste and the line-break guard are all decided here.
 *     Stopping propagation does not stop the browser's default action, which is
 *     why typing, the caret and selection still work inside the span.
 *  2. POINTER EVENTS ARE STOPPED BUT NOT DEFAULT-PREVENTED. Cancelling
 *     `pointerdown` suppresses the compatibility `mousedown`, and `mousedown` is
 *     the event whose default (focus, text selection) is the one that has to be
 *     cancelled. So `mousedown` and friends are prevented and `pointer*` is only
 *     stopped.
 *
 * `applyResult` and `revert` are handled whether edit mode is on or off. The
 * host sends `mode {on:false}` and then waits for in-flight applies, so an
 * answer routinely lands after the shim has switched itself off. Dropping it
 * would leave a failed edit on screen as if it had been saved.
 *
 * WHY THE SOURCE IS WRITTEN WITH String.raw
 * -----------------------------------------
 * The shim contains regexes and string escapes (`/[\r\n\t]+/g`, `\u00a0`). In
 * an ordinary template literal `\n` becomes a real newline in the output and
 * silently breaks any string it sits inside; with String.raw what is written
 * here is what the frame receives. Do not put a backtick or a dollar-brace
 * inside the text: those still belong to the template. Constants from the
 * shared contract are interpolated with JSON.stringify, so the frame and the
 * host cannot disagree about a message name.
 *
 * Plain ES5-style source: it is injected as text into a document Acabox does
 * not control and never passes through the build's transpiler.
 */

import { EDIT_MSG, MAX_ANCESTOR_SRCS, MINI_APP_SRC_ATTR } from '../shared/miniAppTextEdit';

/**
 * The longest text the host will pass on. MiniAppViewer's `parseFrameEditMessage`
 * drops a probe, commit or suggestion carrying more than this and says nothing,
 * so the shim must not offer to edit such a node or send such a result:
 * otherwise the click would do nothing, or the text on screen would silently
 * differ from what was saved. (The shared contract carries no constant for this,
 * only `MAX_EDIT_TEXT_CHARS`, which is main's tighter limit and is reported to
 * the user as a refusal.)
 */
const FRAME_TEXT_LIMIT = 10000;

/**
 * The host's other limits on a probe/commit target (MiniAppViewer's
 * `parseFrameEditMessage`): a stamp longer than this, or a tag name longer than
 * FRAME_TAG_LIMIT, makes the host drop the message silently, so the frame
 * applies them itself and the user gets a red flash instead of nothing.
 */
const FRAME_SRC_LIMIT = 400;
const FRAME_TAG_LIMIT = 40;
const FRAME_APPLIED_LIMIT = 100;

export const MINI_APP_EDIT_SHIM = String.raw`(function () {
  'use strict';
  if (window.__acaboxEditShimInstalled) return 'already-installed';
  window.__acaboxEditShimInstalled = true;

  var SRC_ATTR = ${JSON.stringify(MINI_APP_SRC_ATTR)};
  var MSG = ${JSON.stringify(EDIT_MSG)};
  var MAX_ANCESTORS = ${MAX_ANCESTOR_SRCS};
  var TEXT_LIMIT = ${FRAME_TEXT_LIMIT};
  var SRC_LIMIT = ${FRAME_SRC_LIMIT};
  var TAG_LIMIT = ${FRAME_TAG_LIMIT};
  var APPLIED_LIMIT = ${FRAME_APPLIED_LIMIT};

  var STAMP_WATCH_MS = 4000;
  var HOVER_THROTTLE_MS = 30;
  var FLASH_MS = 900;
  var PENDING_MS = 10000;
  var LAYER_ID = '__acabox_edit_layer';
  var STYLE_ID = '__acabox_edit_style';
  var EDIT_CLASS = '__acabox-editing';
  var BLUE = '#0645b1';
  var AMBER = '#b45309';
  var GREEN = '#05b01c';
  var RED = '#b60000';
  var NBSP = '\u00a0';

  // Text inside these is never ours to edit: form controls hold values rather
  // than text, svg/canvas text is drawn rather than laid out, and the rest is
  // not content at all.
  var SKIP_TAGS = ' script style textarea input select option noscript svg math canvas iframe video audio ';

  // Stopped before the tool sees them while edit mode is on.
  var BLOCKED = [
    'click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'contextmenu', 'submit', 'dragstart', 'touchstart', 'touchend',
    'keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'cut',
    'focusin', 'focusout'
  ];
  // Of those, the ones whose default action is also cancelled outside the editor.
  // pointerdown/pointerup are left out on purpose: see the header.
  var CANCELLED = ' click dblclick auxclick mousedown mouseup contextmenu submit dragstart ';

  var on = false;            // edit mode
  var layer = null;          // overlay root: inset frame, hover box, flashes
  var hoverBox = null;
  var editor = null;         // { span, node, mode, target, oldText } while text is being edited
  var pendingProbe = null;   // { probeId, node, offset, target } waiting on the host
  var applied = {};          // editId -> { node, oldText, newText, src, siblings, pending }
  var appliedOrder = [];     // editIds, oldest first, to cap the applied map
  var seq = 0;
  var stampWatch = null;     // { observer, timer } while waiting for stamps to appear
  var hoverTimer = null;
  var lastHoverAt = 0;
  var lastHover = null;
  var downInEditor = false;  // the current press began inside the editor
  var blurring = false;

  function post(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (err) { /* the host is gone: nobody to tell */ }
  }

  function newId() {
    seq += 1;
    return 'e' + seq + '-' + (Math.random().toString(36) + '00000000').slice(2, 10);
  }

  function isNode(x) { return !!x && typeof x.nodeType === 'number'; }

  function inEditor(target) {
    return !!editor && isNode(target) && editor.span.contains(target);
  }

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function countStamped() {
    try { return document.querySelectorAll('[' + SRC_ATTR + ']').length; } catch (err) { return 0; }
  }

  // ---- what is under the pointer -------------------------------------------

  function hasText(node) {
    return !!node && node.nodeType === 3 && /\S/.test(node.nodeValue) && node.nodeValue.length <= TEXT_LIMIT;
  }

  function firstTextChild(el) {
    if (!el || el.nodeType !== 1) return null;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (hasText(c)) return c;
    }
    return null;
  }

  // A browser that implements contenteditable reports it on the element itself.
  // Where it does not (jsdom), fall back to the nearest contenteditable attribute.
  function appEditable(el) {
    if (typeof el.isContentEditable === 'boolean') return el.isContentEditable;
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      var v = e.getAttribute('contenteditable');
      if (v !== null) return v.toLowerCase() !== 'false';
    }
    return false;
  }

  function excluded(node) {
    var parent = node.parentNode;
    if (!parent || parent.nodeType !== 1) return true;
    for (var el = parent; el && el.nodeType === 1; el = el.parentNode) {
      if (el === layer) return true;
      if (editor && el === editor.span) return true;
      var tag = (el.localName || el.tagName || '').toLowerCase();
      if (SKIP_TAGS.indexOf(' ' + tag + ' ') !== -1) return true;
    }
    return appEditable(parent);
  }

  // The caret APIs answer with the NEAREST text even when the pointer is over
  // empty space, so require the point to sit on one of the node's own boxes.
  function pointOnNode(node, x, y) {
    var rects;
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      rects = range.getClientRects();
    } catch (err) { return true; }
    if (!rects || rects.length === 0) return true;
    for (var i = 0; i < rects.length; i++) {
      var q = rects[i];
      if (x >= q.left - 2 && x <= q.right + 2 && y >= q.top - 2 && y <= q.bottom + 2) return true;
    }
    return false;
  }

  // -> { node, offset } or null.
  function hitTest(x, y, eventTarget) {
    var node = null;
    var offset = 0;
    var viaCaret = false;
    try {
      if (typeof document.caretRangeFromPoint === 'function') {
        viaCaret = true;
        var range = document.caretRangeFromPoint(x, y);
        if (range) { node = range.startContainer; offset = range.startOffset; }
      } else if (typeof document.caretPositionFromPoint === 'function') {
        viaCaret = true;
        var pos = document.caretPositionFromPoint(x, y);
        if (pos) { node = pos.offsetNode; offset = pos.offset; }
      }
    } catch (err) { node = null; }
    // No caret API (jsdom): the first text of whatever was clicked.
    if (!viaCaret) { node = firstTextChild(eventTarget); offset = 0; }
    if (!hasText(node) || excluded(node)) return null;
    if (viaCaret && !pointOnNode(node, x, y)) return null;
    return { node: node, offset: offset };
  }

  function buildTarget(node) {
    var parent = node.parentNode;
    var elementSrc = parent.getAttribute(SRC_ATTR) || null;
    if (elementSrc && elementSrc.length > SRC_LIMIT) elementSrc = null;
    var ancestors = [];
    var prev = elementSrc;
    for (var el = parent.parentNode; el && el.nodeType === 1 && ancestors.length < MAX_ANCESTORS; el = el.parentNode) {
      var v = el.getAttribute(SRC_ATTR);
      if (v && v.length <= SRC_LIMIT && v !== prev) { ancestors.push(v); prev = v; }
    }
    return {
      text: node.nodeValue,
      elementSrc: elementSrc,
      tagName: parent.tagName.toLowerCase(),
      ancestorSrcs: ancestors
    };
  }

  // ---- overlay: frame, hover box, flashes ----------------------------------

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      'html.' + EDIT_CLASS + ', html.' + EDIT_CLASS + ' * { cursor: text !important; }' +
      '[data-acabox-editor] { outline: 2px solid ' + BLUE + ' !important; outline-offset: 1px !important; ' +
        'background: rgba(6, 69, 177, 0.08) !important; border-radius: 2px !important; ' +
        'white-space: pre-wrap !important; -webkit-user-select: text !important; user-select: text !important; }' +
      '[data-acabox-editor="suggest"] { outline-color: ' + AMBER + ' !important; ' +
        'background: rgba(180, 83, 9, 0.1) !important; }';
    (document.head || document.documentElement).appendChild(st);
  }

  function ensureLayer() {
    if (layer && layer.parentNode) return;
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;' +
      'box-shadow:inset 0 0 0 2px rgba(6,69,177,0.3);';
    hoverBox = document.createElement('div');
    hoverBox.style.cssText = 'position:fixed;display:none;box-sizing:border-box;pointer-events:none;margin:0;padding:0;' +
      'border:1.5px dashed ' + BLUE + ';border-radius:3px;background:rgba(6,69,177,0.06);';
    layer.appendChild(hoverBox);
    // Never inside #root: the tool's own renderer owns that subtree.
    document.documentElement.appendChild(layer);
  }

  function nodeRect(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    } catch (err) { return null; }
  }

  function hideHover() {
    if (hoverBox) hoverBox.style.display = 'none';
  }

  function showHover(node) {
    var rect = nodeRect(node);
    if (!rect || (rect.width === 0 && rect.height === 0)) { hideHover(); return; }
    ensureLayer();
    var s = hoverBox.style;
    s.left = (rect.left - 2) + 'px';
    s.top = (rect.top - 1) + 'px';
    s.width = (rect.width + 4) + 'px';
    s.height = (rect.height + 2) + 'px';
    s.display = 'block';
  }

  // A short outline around an element. keep = a pending edit: dashed, and it
  // stays until the host answers (or PENDING_MS, so a lost answer cannot leave
  // it up forever).
  function flash(el, color, keep) {
    if (!on || !layer || !el || typeof el.getBoundingClientRect !== 'function') return null;
    var rect = el.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;margin:0;padding:0;border-radius:3px;' +
      'border:2px ' + (keep ? 'dashed' : 'solid') + ' ' + color + ';' +
      'left:' + (rect.left - 3) + 'px;top:' + (rect.top - 2) + 'px;' +
      'width:' + (rect.width + 6) + 'px;height:' + (rect.height + 4) + 'px;';
    layer.appendChild(box);
    window.setTimeout(function () { removeEl(box); }, keep ? PENDING_MS : FLASH_MS);
    return box;
  }

  // ---- the editor ----------------------------------------------------------

  function placeCaret(span, offset) {
    try {
      var tn = span.firstChild;
      var sel = window.getSelection();
      if (!tn || !sel) return;
      var range = document.createRange();
      range.setStart(tn, Math.max(0, Math.min(tn.nodeValue.length, offset || 0)));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) { /* the caret just starts where the browser puts it */ }
  }

  function focusEditor() {
    try { editor.span.focus({ preventScroll: true }); } catch (err) {
      try { editor.span.focus(); } catch (err2) { /* nothing to focus */ }
    }
  }

  function openEditor(node, offset, target, mode) {
    var span = document.createElement('span');
    span.setAttribute('data-acabox-editor', mode);
    span.setAttribute('contenteditable', 'plaintext-only');
    // A browser that does not know plaintext-only treats the value as invalid and
    // reports 'inherit'. Where contentEditable is not implemented at all (jsdom)
    // there is nothing to detect, so leave it.
    if (typeof span.contentEditable === 'string' && span.contentEditable !== 'plaintext-only') {
      span.setAttribute('contenteditable', 'true');
    }
    span.setAttribute('spellcheck', 'true');
    span.textContent = node.nodeValue;
    // Set before the swap and the focus call: both dispatch events that the
    // window handlers must already recognise as belonging to the editor.
    editor = { span: span, node: node, mode: mode, target: target, oldText: node.nodeValue };
    hideHover();
    // In FRONT of the original text node, which stays attached and blank until
    // the edit finishes. Taking it out of the page would leave React holding a
    // node that is no longer a child: a re-render that inserts a sibling before
    // this text then calls insertBefore against it, which throws NotFoundError
    // and blanks the whole tool (measured: React 19.2 in Chromium 138). Blank
    // and attached, every call React can make still works.
    node.parentNode.insertBefore(span, node);
    node.nodeValue = '';
    focusEditor();
    placeCaret(span, offset);
  }

  // U+00A0 is what the browser types for a space it cannot leave as one, so it
  // becomes a space again unless the original text really used it.
  function fold(text, oldText) {
    var t = text;
    if (oldText.indexOf(NBSP) === -1) t = t.replace(/\u00a0/g, ' ');
    return t.replace(/[\r\n\t]+/g, ' ');
  }

  function finishEditor(cancel) {
    var ed = editor;
    if (!ed) return;
    // Cleared first: swapping out a focused node can fire events, and they must
    // see no editor rather than a half-finished one.
    editor = null;
    var span = ed.span;
    var node = ed.node;
    var raw = span.textContent || '';
    removeEl(span);
    // The original text goes back, unless the tool wrote something into the node
    // while it was blank: that value is newer than ours and is left alone.
    function restore() { if (node.nodeValue === '') node.nodeValue = ed.oldText; }
    if (cancel) { restore(); return; }
    var newText = fold(raw, ed.oldText);
    // Compared folded on both sides, so an untouched text that happens to hold a
    // line break is not mistaken for an edit.
    if (newText === fold(ed.oldText, ed.oldText)) { restore(); return; }
    var parentEl = node.parentNode;
    if (newText.length > TEXT_LIMIT) { restore(); flash(parentEl, RED); return; }
    if (ed.mode === 'suggest') {
      restore();
      post({ type: MSG.suggest, oldText: ed.oldText, newText: newText });
      flash(parentEl, AMBER);
      return;
    }
    var editId = newId();
    var rec = { node: node, oldText: ed.oldText, newText: newText, src: ed.target.elementSrc, siblings: [], pending: null };
    applied[editId] = rec;
    appliedOrder.push(editId);
    while (appliedOrder.length > APPLIED_LIMIT) delete applied[appliedOrder.shift()];
    // Only while still blank: a newer value React wrote meanwhile stays.
    if (node.nodeValue === '') node.nodeValue = newText;
    post({ type: MSG.commit, editId: editId, target: ed.target, newText: newText });
    rec.pending = flash(parentEl, BLUE, true);
  }

  function insertPlainText(text) {
    var done = false;
    try {
      done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    } catch (err) { done = false; }
    if (done) return;
    // execCommand is missing or refused: splice the text in at the caret.
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount || !editor) return;
    var range = sel.getRangeAt(0);
    if (!editor.span.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    var tn = document.createTextNode(text);
    range.insertNode(tn);
    range.setStartAfter(tn);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---- probing -------------------------------------------------------------

  function startProbe(hit) {
    var target = buildTarget(hit.node);
    if (target.tagName.length > TAG_LIMIT) { flash(hit.node.parentNode, RED); return; }
    var probeId = newId();
    pendingProbe = { probeId: probeId, node: hit.node, offset: hit.offset, target: target };
    post({ type: MSG.probe, probeId: probeId, target: target });
  }

  function onProbeResult(d) {
    var p = pendingProbe;
    if (!p || typeof d.probeId !== 'string' || d.probeId !== p.probeId) return;
    pendingProbe = null;
    if (!on || (d.editable !== true && d.editable !== false)) return;
    if (!p.node.parentNode || !document.contains(p.node)) return;
    // The text changed between the click and the answer: the answer is about other text.
    if (p.node.nodeValue !== p.target.text) return;
    // Two answers cannot cross today; if they ever do, leave nothing half open.
    if (editor) finishEditor(false);
    openEditor(p.node, p.offset, p.target, d.editable === true ? 'direct' : 'suggest');
  }

  // ---- host answers --------------------------------------------------------

  function syncSiblings(rec) {
    var els = document.querySelectorAll('[' + SRC_ATTR + ']');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      if (els[i].getAttribute(SRC_ATTR) !== rec.src) continue;
      for (var c = els[i].firstChild; c; c = c.nextSibling) {
        if (c !== rec.node && c.nodeType === 3 && c.nodeValue === rec.oldText) {
          c.nodeValue = rec.newText;
          out.push(c);
        }
      }
    }
    return out;
  }

  function onApplyResult(d) {
    var rec = typeof d.editId === 'string' ? applied[d.editId] : null;
    if (!rec) return;
    removeEl(rec.pending);
    rec.pending = null;
    var parentEl = rec.node.parentNode;
    if (d.ok === true) {
      flash(parentEl, GREEN);
      // Every rendered copy of one literal (a mapped list) still shows the old
      // text until the tool reloads, so bring them along.
      if (d.sameElementScope === true && rec.src) rec.siblings = rec.siblings.concat(syncSiblings(rec));
    } else {
      if (rec.node.nodeValue === rec.newText) rec.node.nodeValue = rec.oldText;
      flash(parentEl, RED);
      delete applied[d.editId];
    }
  }

  function onRevert(d) {
    if (typeof d.editId !== 'string') return;
    var rec = applied[d.editId];
    var ok = false;
    if (rec && document.contains(rec.node) && rec.node.nodeValue === rec.newText) {
      rec.node.nodeValue = rec.oldText;
      for (var i = 0; i < rec.siblings.length; i++) {
        var s = rec.siblings[i];
        if (document.contains(s) && s.nodeValue === rec.newText) s.nodeValue = rec.oldText;
      }
      removeEl(rec.pending);
      delete applied[d.editId];
      ok = true;
    }
    post({ type: MSG.reverted, editId: d.editId, ok: ok });
  }

  // ---- stamps --------------------------------------------------------------

  function stopStampWatch() {
    if (!stampWatch) return;
    if (stampWatch.observer) stampWatch.observer.disconnect();
    if (stampWatch.timer) window.clearTimeout(stampWatch.timer);
    stampWatch = null;
  }

  function startStampWatch() {
    var watch = { observer: null, timer: null };
    stampWatch = watch;
    function finish() {
      if (stampWatch !== watch) return;
      stopStampWatch();
      if (on) post({ type: MSG.state, on: true, stamped: countStamped(), final: true });
    }
    try {
      watch.observer = new MutationObserver(function () { if (countStamped() > 0) finish(); });
      watch.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) { watch.observer = null; }
    watch.timer = window.setTimeout(finish, STAMP_WATCH_MS);
  }

  // Zero stamps right after load is normal (the tool may not have rendered yet),
  // so only a zero that survives STAMP_WATCH_MS is reported as final.
  function reportStamps() {
    var n = countStamped();
    if (n > 0) {
      stopStampWatch();
      post({ type: MSG.state, on: true, stamped: n, final: true });
      return;
    }
    post({ type: MSG.state, on: true, stamped: 0, final: false });
    if (!stampWatch) startStampWatch();
  }

  // ---- mode ----------------------------------------------------------------

  function enterMode() {
    if (!on) {
      // Before blocking starts, so the tool sees an ordinary blur and not a
      // control that is silently stuck focused.
      try {
        var active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement && typeof active.blur === 'function') active.blur();
      } catch (err) { /* nothing focused worth releasing */ }
      on = true;
      ensureStyle();
      document.documentElement.classList.add(EDIT_CLASS);
      ensureLayer();
    }
    reportStamps();
  }

  function cancelHover() {
    if (hoverTimer) window.clearTimeout(hoverTimer);
    hoverTimer = null;
    lastHover = null;
    hideHover();
  }

  function leaveMode() {
    if (on) {
      // While still on, so the commit is posted BEFORE the acknowledgement below.
      // The host waits for both, in that order.
      finishEditor(false);
      pendingProbe = null;
      stopStampWatch();
      cancelHover();
      downInEditor = false;
      on = false;
      document.documentElement.classList.remove(EDIT_CLASS);
      removeEl(layer);
      layer = null;
      hoverBox = null;
    }
    post({ type: MSG.state, on: false, stamped: countStamped(), final: true });
  }

  // ---- events --------------------------------------------------------------

  function blurTarget(el) {
    if (blurring || !el || el === document.body || typeof el.blur !== 'function') return;
    blurring = true;
    try { el.blur(); } catch (err) { /* nothing to release */ }
    blurring = false;
  }

  // The editor's span left the document without us (React re-rendered over it):
  // what the user typed is not what they would be saving, so it is a cancel.
  // Not applied when leaving edit mode, which still reports what was typed.
  function dropStaleEditor() {
    if (editor && !document.contains(editor.span)) finishEditor(true);
  }

  function onKeyDown(event) {
    var key = event.key;
    if (editor) {
      // An IME uses these keys itself to pick or dismiss a candidate.
      if (event.isComposing || event.keyCode === 229) return;
      if (key === 'Enter') { event.preventDefault(); if (!event.shiftKey) finishEditor(false); return; }
      if (key === 'Tab') { event.preventDefault(); finishEditor(false); return; }
      if (key === 'Escape') { event.preventDefault(); finishEditor(true); }
      return;
    }
    if (key === 'Escape') { post({ type: MSG.shortcut, action: 'done' }); return; }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (key === 'z' || key === 'Z')) {
      event.preventDefault();
      post({ type: MSG.shortcut, action: 'undo' });
    }
    // Anything else was only stopped, so scroll keys still scroll.
  }

  function onPaste(event, isInside) {
    if (!isInside) return;
    event.preventDefault();
    var text = '';
    try {
      var data = event.clipboardData || window.clipboardData;
      text = (data && data.getData('text/plain')) || '';
    } catch (err) { text = ''; }
    text = text.replace(/[\r\n\t]+/g, ' ');
    if (text) insertPlainText(text);
  }

  function onClick(event, isInside) {
    var startedInside = downInEditor;
    downInEditor = false;
    // Always: inside the editor too, a click must not run the enclosing element's
    // default action (<a href> navigation, <summary> toggle, <label> forwarding).
    // The caret is placed on mousedown, which stays allowed there.
    event.preventDefault();
    // A drag that began in the editor and ended outside it clicks on the common
    // ancestor, which is outside; it is still a click on the editor.
    if (isInside || startedInside) return;
    // Hit-tested BEFORE the open editor is closed: the click was aimed at the
    // layout the user was looking at, and closing the editor can reflow it.
    var hit = hitTest(event.clientX, event.clientY, event.target);
    if (editor) finishEditor(false);
    if (hit) startProbe(hit);
  }

  function guard(event) {
    var type = event.type;
    dropStaleEditor();
    var isInside = inEditor(event.target);
    if (type === 'focusin') {
      if (!isInside) {
        blurTarget(event.target);
        // The tool tried to take focus while text was being edited: hand it back.
        if (editor && !blurring) focusEditor();
      }
      return;
    }
    if (type === 'keydown') { onKeyDown(event); return; }
    if (type === 'beforeinput') {
      // Single-line text: a paragraph or line break would be a newline.
      if (editor && (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak')) event.preventDefault();
      return;
    }
    if (type === 'paste') { onPaste(event, isInside); return; }
    if (type === 'mousedown' || type === 'pointerdown') downInEditor = isInside;
    if (type === 'click') { onClick(event, isInside); return; }
    if (type === 'auxclick') { event.preventDefault(); return; }
    // <button> and <summary> activate on the keyup of Space (and Enter), which would
    // click outside the span and close the editor. Typing happens on keypress and
    // beforeinput, so cancelling keyup costs nothing.
    if (type === 'keyup') { if (isInside) event.preventDefault(); return; }
    if (!isInside && CANCELLED.indexOf(' ' + type + ' ') !== -1) event.preventDefault();
  }

  function onBlocked(event) {
    if (!on) return;
    // Stopped before anything that could throw, so a bug below can only cost
    // the shim's own behaviour and never let a click through to the tool.
    event.stopPropagation();
    event.stopImmediatePropagation();
    try { guard(event); } catch (err) { /* never break event dispatch */ }
  }

  function runHover() {
    hoverTimer = null;
    lastHoverAt = Date.now();
    if (!on || editor || !lastHover) { hideHover(); return; }
    var hit = hitTest(lastHover.x, lastHover.y, lastHover.target);
    if (hit) showHover(hit.node); else hideHover();
  }

  // Leading and trailing: the first move is handled at once, and the last one
  // still lands after the pointer stops, so the box never rests on a neighbour.
  function onMouseMove(event) {
    if (!on) return;
    dropStaleEditor();
    if (editor) return;
    lastHover = { x: event.clientX, y: event.clientY, target: event.target };
    var wait = HOVER_THROTTLE_MS - (Date.now() - lastHoverAt);
    if (wait <= 0) { if (hoverTimer) window.clearTimeout(hoverTimer); runHover(); return; }
    if (!hoverTimer) hoverTimer = window.setTimeout(runHover, wait);
  }

  function onScroll() {
    if (on) hideHover();
  }

  // Capture also sees every element's blur on its way down, so only the
  // window's own counts. Focus left for the host (its Done button, say).
  function onWindowBlur(event) {
    if (event.target !== window) return;
    if (on && editor) finishEditor(false);
  }

  function onMessage(event) {
    var d = event.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    try {
      if (d.type === MSG.mode) {
        if (d.on === true) enterMode(); else if (d.on === false) leaveMode();
      } else if (d.type === MSG.probeResult) {
        onProbeResult(d);
      } else if (d.type === MSG.applyResult) {
        onApplyResult(d);
      } else if (d.type === MSG.revert) {
        onRevert(d);
      }
    } catch (err) { /* a malformed message must not break the tool */ }
  }

  for (var i = 0; i < BLOCKED.length; i++) window.addEventListener(BLOCKED[i], onBlocked, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', onWindowBlur, true);
  window.addEventListener('message', onMessage, true);

  post({ type: MSG.ready });
  return 'installed';
})();`;

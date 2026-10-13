/**
 * Every link surfaced anywhere in Acabox opens in the user's default browser.
 *
 * These guards are installed on *every* WebContents the app creates, which
 * makes them the single chokepoint: chat Markdown links, hyperlinks in an
 * .xlsx cell, `<a>` tags inside a mini-app iframe, `window.open`, and any
 * link-rendering code written later all funnel through here without needing
 * their own `onClick` handler.
 *
 * Without them there are two failure modes, both live before this existed:
 *
 *   - A plain `<a href="https://…">` navigates the top-level renderer away
 *     from the app. Acabox draws its own chrome and has no address bar or
 *     back button, so the window is simply stuck on the remote page.
 *   - `target="_blank"` / `window.open` makes Electron spawn a bare
 *     BrowserWindow that inherits our `webPreferences` and preload — remote
 *     content next to the app's IPC surface, with no UI to close it.
 *
 * Chat links additionally go through `AnchorWithDoi`, which calls the
 * `open-external-url` IPC on click; that runs first and this never fires for
 * them. It is kept as the net for every other surface.
 *
 * One surface cannot be handled here at all — links inside a mini-app frame,
 * which the host CSP refuses before any navigation event fires. Those are
 * covered by the script in `miniAppLinkShim.ts`, injected below.
 */

import { app, shell, webFrameMain, type WebContents } from 'electron';
import log from 'electron-log';
import { isInternalUrl } from '../../shared/urlTargets';
import { validateExternalUrl } from '../../utils/urlValidation';
import { MINI_APP_EDIT_SHIM } from './miniAppEditShim';
import { MINI_APP_LINK_SHIM } from './miniAppLinkShim';
import { MINI_APP_SELECTION_SHIM } from './miniAppSelectionShim';

/**
 * Hand a URL to the OS. Reuses `validateExternalUrl` so navigation-guard
 * hand-offs obey exactly the same policy as the explicit `open-external-url`
 * IPC (https always; http only in dev) rather than becoming a second, looser
 * door to `shell.openExternal`.
 */
function openInDefaultBrowser(rawUrl: string, via: string): void {
  const validation = validateExternalUrl(rawUrl);
  if (!validation.isValid) {
    log.warn(`[ExternalLinks] Refused to open "${rawUrl}" (${via}): ${validation.error}`);
    return;
  }
  log.info(`[ExternalLinks] Opening in default browser (${via}): ${rawUrl}`);
  shell.openExternal(rawUrl).catch((err: Error) => {
    log.warn(`[ExternalLinks] shell.openExternal failed for "${rawUrl}": ${err.message}`);
  });
}

/**
 * Register the guards. Must run before any window is created, so call this at
 * module scope / before `app.whenReady()` — `web-contents-created` only fires
 * for WebContents built after the listener is attached.
 */
export function installExternalLinkGuards(): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isInternalUrl(url)) {
        // Nothing in the app opens its own content in a second window; if that
        // changes this is the line to revisit.
        log.warn(`[ExternalLinks] Blocked window.open for internal URL: ${url}`);
      } else {
        openInDefaultBrowser(url, 'window.open');
      }
      return { action: 'deny' };
    });

    // `will-frame-navigate` fires for the main frame *and* subframes, so it
    // covers mini-app iframes too. Deliberately not also listening to
    // `will-navigate`: that one is main-frame-only and would double-fire here,
    // opening the same link in two browser tabs.
    contents.on('will-frame-navigate', (details) => {
      if (isInternalUrl(details.url)) return;
      // Reached by main-frame links (chat Markdown, .xlsx cells) and by
      // subframes whose target the host CSP happens to permit. Mini-app links
      // to the open web never get here — CSP refuses them first, which is what
      // the injected shim below exists for.
      details.preventDefault();
      openInDefaultBrowser(details.url, details.isMainFrame ? 'navigation' : 'iframe navigation');
    });

    // Mini-app frames are `local-file://` and the host CSP refuses any remote
    // frame navigation before the guard above can fire, so links inside a tool
    // need a listener injected into the frame itself. See miniAppLinkShim.ts.
    contents.on(
      'did-frame-navigate',
      (_e, url, _httpResponseCode, _httpStatusText, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame || !url.startsWith('local-file:')) return;
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
        if (!frame) return;
        frame.executeJavaScript(MINI_APP_LINK_SHIM).catch((err: Error) => {
          log.warn(`[ExternalLinks] Could not install mini-app link shim in ${url}: ${err.message}`);
        });
        // Same injection point, same reason (see miniAppSelectionShim.ts):
        // a cross-origin frame's text selection is unreachable from the host.
        // Injected separately rather than concatenated so a failure in one
        // shim cannot take the others down with it.
        frame.executeJavaScript(MINI_APP_SELECTION_SHIM).catch((err: Error) => {
          log.warn(`[ExternalLinks] Could not install mini-app selection shim in ${url}: ${err.message}`);
        });
        // Edit mode for a tool's text (see miniAppEditShim.ts): the same
        // cross-origin constraint again, since only the frame can see its own
        // text nodes. It does nothing until the host sends it `mode {on:true}`,
        // so putting it in every tool frame costs a user who never edits nothing.
        frame.executeJavaScript(MINI_APP_EDIT_SHIM).catch((err: Error) => {
          log.warn(`[ExternalLinks] Could not install mini-app edit shim in ${url}: ${err.message}`);
        });
      },
    );
  });
}

/**
 * @jest-environment node
 *
 * The injection point for the three mini-app shims. Each shim's behaviour is
 * covered by its own test against a real DOM; what nothing else covers is that
 * `externalLinks.ts` actually hands each one to a tool's frame, as its own call
 * with its own failure log, and only to a tool's frame. A typo on that line
 * would leave a shim written, tested and never running.
 */
import { EventEmitter } from 'events';

jest.mock('electron', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter: Emitter } = require('events');
  const app = new Emitter();
  (app as any).isPackaged = false;
  return {
    app,
    shell: { openExternal: jest.fn(() => Promise.resolve()) },
    webFrameMain: { fromId: jest.fn() },
  };
});
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { app, webFrameMain } from 'electron';
import log from 'electron-log';
import { installExternalLinkGuards } from '../externalLinks';
import { MINI_APP_EDIT_SHIM } from '../miniAppEditShim';
import { MINI_APP_LINK_SHIM } from '../miniAppLinkShim';
import { MINI_APP_SELECTION_SHIM } from '../miniAppSelectionShim';

const fromId = webFrameMain.fromId as unknown as jest.Mock;
const warn = log.warn as unknown as jest.Mock;

const TOOL_URL = 'local-file:///ws/.applications/demo/index.html';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeAll(() => { installExternalLinkGuards(); });
afterAll(() => { app.removeAllListeners(); });
beforeEach(() => {
  fromId.mockReset();
  warn.mockReset();
});

/** A WebContents the guards have been attached to, as Electron announces it. */
function newContents(): EventEmitter {
  const contents: any = new EventEmitter();
  contents.setWindowOpenHandler = jest.fn();
  app.emit('web-contents-created', {}, contents);
  return contents;
}

function navigate(contents: EventEmitter, url: string, isMainFrame = false): void {
  contents.emit('did-frame-navigate', {}, url, 200, 'OK', isMainFrame, 11, 22);
}

function frameWith(execute: (script: string) => Promise<unknown>) {
  return { executeJavaScript: jest.fn(execute) };
}

describe('externalLinks — mini-app shim injection', () => {
  it('hands the link, selection and edit shims to a tool frame, each as its own call, in that order', () => {
    const frame = frameWith(() => Promise.resolve('installed'));
    fromId.mockReturnValue(frame);

    navigate(newContents(), TOOL_URL);

    expect(fromId).toHaveBeenCalledWith(11, 22);
    // Exactly the exported constants, one call each: concatenated into one
    // script, a failure in one would take the others down with it.
    expect(frame.executeJavaScript.mock.calls.map((call) => call[0])).toEqual([
      MINI_APP_LINK_SHIM,
      MINI_APP_SELECTION_SHIM,
      MINI_APP_EDIT_SHIM,
    ]);
  });

  it('injects into nothing that is not a tool frame', () => {
    const frame = frameWith(() => Promise.resolve('installed'));
    fromId.mockReturnValue(frame);
    const contents = newContents();

    navigate(contents, TOOL_URL, true); // the app's own page, even on this scheme
    navigate(contents, 'https://example.com/page'); // a subframe the CSP let through
    navigate(contents, 'http://localhost:3000/index.html'); // a dev-server frame

    expect(fromId).not.toHaveBeenCalled();
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
  });

  it('does nothing, and does not throw, when the frame is already gone', () => {
    fromId.mockReturnValue(null);
    expect(() => navigate(newContents(), TOOL_URL)).not.toThrow();
  });

  it('logs a failed edit-shim install by name, and the other two still ran', async () => {
    const frame = frameWith((script) => (script === MINI_APP_EDIT_SHIM
      ? Promise.reject(new Error('frame was destroyed'))
      : Promise.resolve('installed')));
    fromId.mockReturnValue(frame);

    navigate(newContents(), TOOL_URL);
    await flush();

    expect(frame.executeJavaScript).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('edit shim');
    expect(warn.mock.calls[0][0]).toContain(TOOL_URL);
    expect(warn.mock.calls[0][0]).toContain('frame was destroyed');
  });

  it('a failure in one of the older shims does not keep the edit shim out', async () => {
    const frame = frameWith((script) => (script === MINI_APP_LINK_SHIM
      ? Promise.reject(new Error('boom'))
      : Promise.resolve('installed')));
    fromId.mockReturnValue(frame);

    navigate(newContents(), TOOL_URL);
    await flush();

    expect(frame.executeJavaScript).toHaveBeenCalledWith(MINI_APP_EDIT_SHIM);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('link shim');
  });
});

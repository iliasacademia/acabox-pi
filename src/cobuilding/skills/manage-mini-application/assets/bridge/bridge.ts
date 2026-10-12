// Install global error capture (uncaught exceptions, unhandled rejections,
// console.error, failed fetches, resource load failures). Imported for side
// effects — keep this first so handlers are in place before any bridge or
// app code runs.
import "./error-capture";

// Ensures `_vendor/acabox.css` (fonts + design tokens + `ab-*` classes) is
// loaded even in apps whose index.html predates it. See design-system.ts.
import "./design-system";

export {};

interface BridgeFilesAPI {
  readFile(path: string): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  copyFile(sourcePath: string, destinationDir: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
  downloadFile(filename: string, content: string): Promise<unknown>;
  showInFinder(path: string): Promise<unknown>;
  selectFile(filters?: unknown[]): Promise<unknown>;
  selectDirectory(): Promise<unknown>;
  readDirectory(path: string): Promise<unknown>;
}

interface BridgeKernelAPI {
  connect(kernelName: string): Promise<unknown>;
  executeCode(code: string): Promise<unknown>;
}

interface BridgeHostAPI {
  exec(command: string, args: string[]): Promise<unknown>;
  /** Configured HTTP APIs this tool has been granted. See `hostAPI.api.fetch`. */
  api: {
    fetch(apiId: string, path: string, init?: ApiFetchInit): Promise<ApiFetchResponse>;
  };
  /**
   * The ONLY sanctioned way to build a URL for an `<img>`/`<a>`/`<video>` `src`
   * or `href` that points at a file under `.applications/<dir>/...` (e.g. a
   * generated plot in `output/`). Do not hand-build
   * `` `local-file://${workspacePath}/...` `` yourself.
   *
   * Locally this resolves to `local-file://<workspacePath>/<relPath>`. But a
   * mini-app can also be published as a read-only shared snapshot (see the
   * sharing feature) and served over plain HTTP, where `local-file://` cannot
   * resolve and there is no workspace path at all — the shared viewer sends
   * an empty one, and this returns `/<relPath>` instead, which the viewer's
   * own base URL then serves. Routing every such URL through this one
   * function is what makes the same component render correctly in both
   * places with no branching in app code.
   */
  fileUrl(relPath: string): string;
}

interface BridgeErrorAPI {
  // Ask the host to post a fix request for this error into the active chat
  // thread. The host owns the prompt template (it knows the app's dir name).
  requestFix(error: {
    kind: string;
    message: string;
    stack?: string;
    source?: string;
    timestamp: number;
  }): Promise<unknown>;
}

export interface AnthropicMessage {
  id: string;
  /** Models that think put thinking blocks first — find the text by `type`. */
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
  >;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'file'; path: string } | { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'file'; path: string } | { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };

export interface AnthropicParams {
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
  model?: string;
  max_tokens?: number;
  system?: string;
}

/** Options for `hostAPI.api.fetch`. Mirrors the useful half of RequestInit. */
export interface ApiFetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** A string body. Send JSON with `JSON.stringify` and a content-type header. */
  body?: string;
}

export interface ApiFetchResponse {
  /** True for a 2xx from the service. A refusal by Acabox is never ok. */
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Set when ACABOX refused, not the service: no such API, no grant for this
   * tool, a write against a read-only API, or a host off the allow list. The
   * text says which, and what the user would have to change.
   */
  error?: string | null;
}

interface BridgeAcademiaAPI {
  fetch(method: string, endpoint: string, data?: unknown): Promise<unknown>;
}

interface BridgeAnthropicAPI {
  complete(params: AnthropicParams): Promise<AnthropicMessage>;
  stream(params: AnthropicParams, onChunk: (text: string) => void): Promise<AnthropicMessage>;
}

let requestId = 0;
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

window.addEventListener("message", (event) => {
  if (event.data?.type === "response" && event.data.id) {
    const handler = pendingRequests.get(event.data.id);
    if (handler) {
      pendingRequests.delete(event.data.id);
      if (event.data.error) {
        handler.reject(new Error(event.data.error));
      } else {
        handler.resolve(event.data.result);
      }
    }
  }
});

function request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const id = `req-${++requestId}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    window.parent.postMessage({ type, id, ...args }, "*");
  });
}

const filesAPI: BridgeFilesAPI = {
  readFile: (path: string) => request("readFile", { path }),
  writeFile: (path: string, content: string) => request("writeFile", { path, content }),
  copyFile: (sourcePath: string, destinationDir: string) =>
    request("copyFile", { sourcePath, destinationDir }),
  deleteFile: (path: string) => request("deleteFile", { path }),
  downloadFile: (filename: string, content: string) => request("downloadFile", { filename, content }),
  showInFinder: (path: string) => request("showInFinder", { path }),
  selectFile: (filters?: unknown[]) => request("selectFile", { filters }),
  selectDirectory: () => request("selectDirectory"),
  readDirectory: (path: string) => request("readDirectory", { path }),
};

const kernel: BridgeKernelAPI = {
  connect: (kernelName: string) => request("connectKernel", { kernelName }),
  executeCode: (code: string) => request("executeCode", { code }),
};

// Shared by `fileUrl` below: strip a leading `./` (the common relative-path
// form apps already use for `filesAPI`/`hostAPI.exec`), then collapse any
// leading `/` so the result is a bare path with no scheme or root of its own
// — callers may pass either form and get the same URL out.
function normalizeFileUrlPath(relPath: string): string {
  let rel = relPath;
  if (rel.startsWith("./")) rel = rel.slice(2);
  while (rel.startsWith("/")) rel = rel.slice(1);
  return rel;
}

const hostAPI: BridgeHostAPI = {
  exec: (command: string, args: string[]) => request("executeCommand", { command, args }),
  api: {
    // Acabox holds the credential and attaches it — this app never sees it and
    // must never ask the user for one. `apiId` must be an API the user has
    // configured in Settings -> APIs *and* granted to this tool in its Settings
    // panel; without the grant every call comes back 403.
    //
    // The response body is a string. Binary is not supported over this bridge
    // (postMessage cannot carry a stream); ask the agent for a large or binary
    // download instead, which streams straight to disk.
    fetch: (apiId: string, path: string, init: ApiFetchInit = {}) =>
      request("api:request", {
        apiId,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
      }) as Promise<ApiFetchResponse>,
  },
  fileUrl: (relPath: string) => {
    const rel = normalizeFileUrlPath(relPath);
    // `_workspacePath` is set from the `init` message the host sends after
    // load (see below) — empty only in a published shared snapshot, whose
    // viewer shim never sends a workspace path (see M2 in the sharing design:
    // `local-file://` literals are rewritten to a versioned base URL at
    // publish time, and there is no filesystem workspace to resolve against
    // on a viewer's machine).
    return _workspacePath ? `local-file://${_workspacePath}/${rel}` : `/${rel}`;
  },
};

// Deprecated alias. `containerAPI` is the name from before Acabox dropped its
// Podman container; commands now run as host child processes. Kept so an app
// exported from an older build still runs — this file is force-overwritten in
// every workspace on boot, so there is no per-app opt-out. Remove once no
// shared app references it.
const containerAPI = hostAPI;

const errorAPI: BridgeErrorAPI = {
  requestFix: (error) => request("requestFix", { error }),
};

const academiaAPI: BridgeAcademiaAPI = {
  fetch: (method: string, endpoint: string, data?: unknown) =>
    request('academia:fetch', { method, endpoint, data }),
};

const anthropicAPI: BridgeAnthropicAPI = {
  // Delegates to the standard request/response bridge. The main process
  // validates all params and returns the full message once generation finishes.
  complete(params) {
    return request('anthropic:complete', params as Record<string, unknown>) as Promise<AnthropicMessage>;
  },

  // Streaming uses a separate postMessage protocol from the standard
  // request/response pattern because multiple events (chunk, done, error) need
  // to arrive for a single request. The bridge registers its own window message
  // listener keyed by the request id and removes it on terminal events (done or
  // error) to avoid accumulating listeners over the page lifetime.
  stream(params, onChunk) {
    const id = `req-${++requestId}`;
    return new Promise<AnthropicMessage>((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        const { type: t, requestId: rid } = event.data ?? {};
        if (rid !== id) return;
        if (t === 'anthropic:chunk') {
          onChunk(event.data.text);
        } else if (t === 'anthropic:done') {
          window.removeEventListener('message', handler);
          resolve(event.data.message);
        } else if (t === 'anthropic:error') {
          window.removeEventListener('message', handler);
          reject(new Error(event.data.error));
        }
      };
      window.addEventListener('message', handler);
      window.parent.postMessage({ type: 'anthropic:stream', id, ...params }, '*');
    });
  },
};

let _workspacePath = "";
// True when this app is running inside a published, read-only snapshot
// rather than inside Acabox. The share viewer's shim sets it in `init`; the
// real host never sends the field, so it stays false there.
//
// An app should consult this BEFORE attempting to persist anything. The shim
// refuses every write — correctly, a snapshot has nowhere to put them — so a
// hopeful write is not a harmless no-op: it surfaces to the viewer as a
// console error, and it is indistinguishable at the shim from a write the
// user actually asked for.
let _readOnly = false;
window.addEventListener("message", (event) => {
  if (event.data?.type !== "init") return;
  if (event.data.workspacePath) {
    _workspacePath = event.data.workspacePath;
  }
  if (event.data.readOnly === true) {
    _readOnly = true;
  }
});

Object.assign(window, {
  filesAPI,
  kernel,
  hostAPI,
  containerAPI,
  errorAPI,
  academiaAPI,
  anthropicAPI,
  getWorkspacePath: () => _workspacePath,
  isReadOnly: () => _readOnly,
});

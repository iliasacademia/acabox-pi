#!/usr/bin/env node
// Boot probe for the vendored PI (plan D2, F1): imports build/pi by file URL
// under Electron's Node and asserts createAgentSession works offline with an
// in-memory credential store. Run it as
//   ELECTRON_RUN_AS_NODE=1 electron scripts/verify-pi-runtime.mjs
// (build-pi-bundle.mjs does). Prints `pi <version> ok` on success.

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'build', 'pi', 'dist', 'bundle', 'index.js');
const fail = (msg) => {
  console.error(`verify-pi-runtime: ${msg}`);
  process.exit(1);
};
if (!existsSync(BUNDLE)) fail('build/pi is missing; run node scripts/build-pi-bundle.mjs');

const expected = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies['@earendil-works/pi-coding-agent'];
const scratch = mkdtempSync(join(tmpdir(), 'pi-probe-'));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(scratch, 'agent');
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PI_TELEMETRY = '0';

let session;
try {
  const pi = await import(pathToFileURL(BUNDLE).href);
  if (pi.VERSION !== expected) fail(`bundle reports PI ${pi.VERSION}, package.json pins ${expected}`);

  const creds = new Map();
  const store = {
    async read(id) { return creds.get(id); },
    async list() { return [...creds.entries()].map(([providerId, c]) => ({ providerId, type: c.type })); },
    async modify(id, fn) { const next = await fn(creds.get(id)); if (next !== undefined) creds.set(id, next); return next; },
    async delete(id) { creds.delete(id); },
  };
  const modelRuntime = await pi.ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false });
  await modelRuntime.refresh({ allowNetwork: false });

  const cwd = join(scratch, 'cwd');
  const agentDir = join(scratch, 'agent');
  const settingsManager = pi.SettingsManager.inMemory({ cacheWarming: 'off' });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await resourceLoader.reload();
  ({ session } = await pi.createAgentSession({
    cwd, agentDir, modelRuntime, settingsManager, resourceLoader,
    sessionManager: pi.SessionManager.inMemory(cwd),
  }));
  const tools = session.getActiveToolNames();
  if (!tools.includes('read') || !tools.includes('bash')) fail(`unexpected built-in tools: ${tools.join(',')}`);
  console.log(`pi ${pi.VERSION} ok (electron node ${process.versions.node}, tools: ${tools.join(',')})`);
} catch (err) {
  fail(err && err.stack ? err.stack : String(err));
} finally {
  try { session?.dispose?.(); } catch {}
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);

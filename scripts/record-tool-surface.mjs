#!/usr/bin/env node
// Records the model-visible surface of the 12 host-relay tools into
// src/cobuilding/agent-server/__tests__/toolSurface.fixture.json (plan P0-08).
//
//   node scripts/record-tool-surface.mjs          # rewrite the fixture
//   node scripts/record-tool-surface.mjs --check  # fail if the fixture is stale
//
// The real `createMcpRelayServers` from agent-server/index.ts is bundled with
// esbuild (jest cannot load the ESM-only Claude SDK), each relay server is
// connected to a real MCP Client over an in-memory transport, and `tools/list`
// is recorded: exactly the names, descriptions and JSON schemas the SDK
// publishes to the model. Names are the model-facing `mcp__<server>__<tool>`.
// The fixture pins the contract that P1-09 must reproduce on PI customTools.

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'src/cobuilding/agent-server/__tests__/toolSurface.fixture.json');
const tmp = mkdtempSync(join(tmpdir(), 'tool-surface-'));

const harness = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpRelayServers } from ${JSON.stringify(join(ROOT, 'src/cobuilding/agent-server/index.ts'))};

async function main() {
const servers = createMcpRelayServers({ pendingMcpCalls: new Map(), sseClients: new Set() });
const tools = [];
for (const [serverName, server] of Object.entries(servers)) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverT);
  const client = new Client({ name: 'tool-surface', version: '0.0.0' });
  await client.connect(clientT);
  for (const t of (await client.listTools()).tools) {
    tools.push({ name: 'mcp__' + serverName + '__' + t.name, server: serverName, tool: t.name, description: t.description ?? '', inputSchema: t.inputSchema });
  }
  await client.close();
}
tools.sort((a, b) => a.name.localeCompare(b.name));
return tools;
}
module.exports = main();
`;
writeFileSync(join(tmp, 'harness.ts'), harness);

try {
  const out = join(tmp, 'harness.cjs');
  await build({
    entryPoints: [join(tmp, 'harness.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // index.ts boots the HTTP server when it is the entry module; it is not here.
    define: { 'require.main': 'null', 'import.meta.url': JSON.stringify(pathToFileURL(out).href) },
    nodePaths: [join(ROOT, 'node_modules')],
    absWorkingDir: ROOT,
    logLevel: 'error',
  });
  const tools = await createRequire(import.meta.url)(out);
  const fixture = {
    _comment: 'Recorded by scripts/record-tool-surface.mjs from the Claude Agent SDK relay servers. Do not hand-edit.',
    count: tools.length,
    tools,
  };
  const text = JSON.stringify(fixture, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(FIXTURE, 'utf8') !== text) {
      console.error('toolSurface.fixture.json is stale; run node scripts/record-tool-surface.mjs');
      process.exit(1);
    }
    console.log(`tool surface fixture is current (${tools.length} tools)`);
  } else {
    writeFileSync(FIXTURE, text);
    console.log(`wrote ${FIXTURE} (${tools.length} tools)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

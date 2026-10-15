import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const S = process.env.SPIKE_DIR;
const PKG = `${S}/../pi-pkg/node_modules/@earendil-works/pi-coding-agent/dist/index.js`;
const t0 = Date.now();
const pi = await import(pathToFileURL(PKG).href);
console.log('import ms', Date.now() - t0);
const { createAgentSession, ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader } = pi;

// Host-owned credential store (plain object implementing CredentialStore)
const PROVIDER = process.env.SPIKE_PROVIDER; const MODEL_ID = process.env.SPIKE_MODEL;
const creds = new Map([[ PROVIDER, { type: 'api_key', key: process.env.SPIKE_API_KEY } ]]);
const store = {
  async read(id) { return creds.get(id); },
  async list() { return [...creds.entries()].map(([providerId, c]) => ({ providerId, type: c.type })); },
  async modify(id, fn) { const next = await fn(creds.get(id)); if (next === undefined) return creds.get(id); creds.set(id, next); console.log('[store.modify]', id, next.type); return next; },
  async delete(id) { creds.delete(id); },
};
const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false });
await runtime.refresh({ allowNetwork: false });
const model = runtime.getModel(PROVIDER, MODEL_ID);
console.log('using', model.provider + '/' + model.id, 'cost', JSON.stringify(model.cost), 'ctx', model.contextWindow, 'reasoning', model.reasoning);

const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: true, maxRetries: 1, baseDelayMs: 500 } });
const cwd = `${S}/cwd`, agentDir = `${S}/agent`, sessionDir = `${S}/sessions`;
let blocked = [];
const guard = { name: 'acabox-guard', factory: (p) => {
  p.on('tool_call', async (event) => {
    if (event.toolName === 'bash' && /rm -rf/.test(String(event.input.command))) { blocked.push(event.input.command); return { block: true, reason: 'Blocked by the Acabox guard: destructive command.' }; }
    if (event.toolName === 'bash' && /THROW_TEST/.test(String(event.input.command))) { blocked.push('THROW:' + event.input.command); throw new Error('guard crashed on purpose'); }
    return undefined;
  });
}};
const hostTool = {
  name: 'mcp__workspace__get_research_profile', label: 'Research profile', description: 'Get the research profile of the user.',
  promptSnippet: 'Get the user research profile', parameters: { type: 'object', properties: {}, required: [] },
  async execute(id, params) { return { content: [{ type: 'text', text: 'PROFILE: nucleotide sequence analysis lab' }], details: undefined }; },
};
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [guard], appendSystemPrompt: ['You are a test harness. Reply in one short line. When asked to use tools, use them.'] });
await loader.reload();
let sessionManager;
try { sessionManager = SessionManager.create(cwd, sessionDir, { id: 'chat-test-1' }); console.log('custom session id accepted:', sessionManager.getSessionId()); }
catch (e) { console.log('custom id rejected:', e.message); sessionManager = SessionManager.create(cwd, sessionDir); }
const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager, model, thinkingLevel: 'off', customTools: [hostTool] });
console.log('tools:', session.getActiveToolNames().join(','), '| fallback:', modelFallbackMessage ?? 'none', '| ext errors:', JSON.stringify(extensionsResult.errors));
console.log('prompt mentions mcp tool:', session.systemPrompt.includes('mcp__workspace__get_research_profile'));
await session.bindExtensions({ mode: 'print', onError: (e) => console.log('[ext error]', e) });
const counts = {}; const timeline = [];
session.subscribe(ev => {
  counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  if (ev.type === 'message_update') { const k = 'mu:' + ev.assistantMessageEvent.type; counts[k] = (counts[k] ?? 0) + 1; return; }
  if (ev.type === 'tool_execution_start') timeline.push(`tool_start ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 80)}`);
  if (ev.type === 'tool_execution_end') timeline.push(`tool_end ${ev.toolName} isError=${ev.isError} ${JSON.stringify(ev.result?.content?.[0]?.text ?? ev.result).slice(0, 80)}`);
  if (ev.type === 'message_end' && ev.message.role === 'assistant') timeline.push(`assistant_end stop=${ev.message.stopReason} cost=${ev.message.usage?.cost?.total} in=${ev.message.usage?.input} out=${ev.message.usage?.output} err=${ev.message.errorMessage ?? ''}`);
  if (ev.type === 'agent_end') timeline.push(`agent_end willRetry=${ev.willRetry}`);
  if (ev.type === 'agent_settled') timeline.push(`agent_settled aborted=${ev.aborted}`);
  if (ev.type === 'auto_retry_start') timeline.push(`retry ${ev.attempt} ${ev.errorMessage.slice(0,80)}`);
});
const t1 = Date.now();
await session.prompt('Run the bash command `echo SPIKE_OK` with the bash tool, then call the mcp__workspace__get_research_profile tool, then reply in ONE line with both results. Also try to run `rm -rf /tmp/does-not-exist` with bash, and separately run `echo THROW_TEST` with bash; report for each whether it was allowed or blocked.', { expandPromptTemplates: false });
console.log('turn1 ms', Date.now() - t1);
console.log('timeline:\n  ' + timeline.join('\n  '));
console.log('counts:', JSON.stringify(counts));
console.log('blocked:', JSON.stringify(blocked));
console.log('last text:', session.getLastAssistantText());
console.log('stats:', JSON.stringify(session.getSessionStats()));
console.log('session file:', session.sessionFile, 'exists', session.sessionFile && existsSync(session.sessionFile));
// Abort test
timeline.length = 0;
const t2 = Date.now();
const p = session.prompt('Run `sleep 25 && echo SLEPT` with the bash tool, then say DONE.', { expandPromptTemplates: false });
setTimeout(() => { console.log('aborting at', Date.now() - t2, 'ms'); void session.abort(); }, 2500);
await p;
console.log('turn2 ms', Date.now() - t2);
console.log('timeline2:\n  ' + timeline.join('\n  '));
const msgs = session.messages;
console.log('messages roles:', msgs.map(m => m.role + (m.role === 'assistant' ? ':' + m.stopReason : '') + (m.role === 'toolResult' ? ':' + (m.isError ? 'ERR' : 'ok') + ':' + JSON.stringify(m.content?.[0]?.text ?? '').slice(0, 40) : '')).join(' | '));
// Resume test
const file = session.sessionFile; session.dispose();
const sm2 = SessionManager.open(file);
const { session: s2 } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: sm2, model, thinkingLevel: 'off', customTools: [hostTool] });
console.log('resumed messages:', s2.messages.length, 'id', s2.sessionId, 'stats cost', s2.getSessionStats().cost);
s2.dispose();
// Custom bash shadowing test (offline)
const shadow = { name: 'bash', label: 'bash', description: 'SHADOWED BASH', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, async execute() { return { content: [{ type: 'text', text: 'shadow' }], details: undefined }; } };
const { session: s3 } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), model, customTools: [shadow] });
console.log('bash definition description:', s3.getToolDefinition('bash')?.description, '| active:', s3.getActiveToolNames().join(','));
s3.dispose();
console.log('agent dir files:', readdirSync(agentDir));

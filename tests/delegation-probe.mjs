// Probe: engine-mode sessions across delegations on the live gateway.
//
// Sends one message (argv) to a conversation, then reports, from the gateway
// log, every Claude request made meanwhile: thread key (conversation | agent |
// task), session mode, seat and model; and from the CLI transcripts, cache
// write/read per Claude Code session. Costs real quota.
//
//   node tests/delegation-probe.mjs <agentId> <model> "<message>" [conversationId]
//   KEEP=1 keeps the conversation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [agentId, model, message, existing] = process.argv.slice(2);
const BASE = process.env.ALFRED_URL ?? 'http://127.0.0.1:4242';
const LOG = join(homedir(), 'Documents', 'alfred-data', 'logs', 'gateway.log');
const TRANSCRIPTS = join(homedir(), '.claude', 'projects', 'C--Users-fabri-Documents-alfred-agent-apps-gateway');

const { token } = await (await fetch(`${BASE}/api/auth/token`)).json();
const headers = { 'content-type': 'application/json', 'x-alfred-token': token, origin: BASE };
const logStart = statSync(LOG).size;
const started = Date.now();

const res = await fetch(`${BASE}/api/chat/stream`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ conversationId: existing, agentId, providerId: 'claude-code', model, message }),
});
const sse = await res.text();
const id = /"conversationId"\s*:\s*"([^"]+)"/.exec(sse)?.[1] ?? existing;
const reply = [...sse.matchAll(/"type":"done","reply":"((?:[^"\\]|\\.)*)"/g)].pop()?.[1];
console.log(`conversation=${id} status=${res.status} reply=${JSON.stringify(reply ?? '').slice(0, 300)}`);

// Gateway log since the start: one block per `stream request` / `stream served`.
const log = readFileSync(LOG, 'utf8').slice(logStart).replace(/\x1b\[[0-9;]*m/g, '');
const field = (block, name) => new RegExp(`${name}: '?([^',\\n]*)'?`).exec(block)?.[1];
for (const block of log.split('[kernel] [plugin:claude-code] ').slice(1)) {
  if (block.startsWith('stream request')) {
    console.log(
      `request thread=${field(block, 'thread')} session=${field(block, 'session')} seat=${field(block, 'account')} model=${field(block, 'model')} effort=${field(block, 'effort')} blocks=${field(block, 'sentBlocks')}${field(block, 'sessionReason') ? ` reason=${field(block, 'sessionReason')}` : ''}`,
    );
  } else if (block.startsWith('stream served')) {
    console.log(`  served session=${field(block, 'sessionId')} write=${field(block, 'cacheWrite')} read=${field(block, 'cacheRead')}`);
  } else if (block.startsWith('closing Claude engine session')) {
    console.log(`  closed reason=${field(block, 'reason')}`);
  }
}

// Per Claude Code session: requests and cache totals (one usage per API message).
for (const f of readdirSync(TRANSCRIPTS).filter((x) => x.endsWith('.jsonl'))) {
  if (statSync(join(TRANSCRIPTS, f)).mtimeMs < started) continue;
  const seen = new Set();
  let w = 0;
  let r = 0;
  let model = '';
  for (const line of readFileSync(join(TRANSCRIPTS, f), 'utf8').split('\n')) {
    if (!line) continue;
    const d = JSON.parse(line);
    if (d.type !== 'assistant' || !d.message?.usage || d.message.model === '<synthetic>' || d.isSidechain) continue;
    if (seen.has(d.message.id) || new Date(d.timestamp).getTime() < started) continue;
    seen.add(d.message.id);
    w += d.message.usage.cache_creation_input_tokens ?? 0;
    r += d.message.usage.cache_read_input_tokens ?? 0;
    model = d.message.model;
  }
  console.log(`cli-session=${f.slice(0, 8)} model=${model} requests=${seen.size} write=${w} read=${r}`);
}

if (id && !process.env.KEEP) {
  const del = await fetch(`${BASE}/api/chat/${id}`, { method: 'DELETE', headers: { 'x-alfred-token': token, origin: BASE } });
  console.log('deleted test conversation:', del.status);
}

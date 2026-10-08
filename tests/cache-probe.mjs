// Probe: prompt-cache behaviour of engine-mode turns on the live gateway.
//
// Runs one or two real turns (a few cheap tool iterations each) through
// http://127.0.0.1:4242, then prints cache write/read per CLI request from the
// Claude Code transcripts written meanwhile, and deletes the test conversation.
//
//   node tests/cache-probe.mjs [model=haiku] [agent=dev] [turns=2] [conversationId]
//   KEEP=1 keeps the conversation (to continue it in a later run).
//
// Costs real quota: keep the model small.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [model = 'haiku', agentId = 'dev', turnsArg = '2', existing] = process.argv.slice(2);
const BASE = process.env.ALFRED_URL ?? 'http://127.0.0.1:4242';
const TRANSCRIPTS = join(homedir(), '.claude', 'projects', 'C--Users-fabri-Documents-alfred-agent-apps-gateway');

const { token } = await (await fetch(`${BASE}/api/auth/token`)).json();
const headers = { 'content-type': 'application/json', 'x-alfred-token': token, origin: BASE };

async function turn(conversationId, message) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversationId, agentId, providerId: 'claude-code', model, message }),
  });
  if (!res.ok) throw new Error(`stream ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const id = /"conversationId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? conversationId;
  const tools = (text.match(/"type"\s*:\s*"tool_call"/g) ?? []).length;
  return { id, tools, tail: text.slice(-300) };
}

const started = Date.now();
const prompt = (n) =>
  `Cache probe ${n}. Call the list_dir tool on path "." exactly 6 times, ONE call per reply ` +
  `(never two calls in one reply), then answer with the single word DONE. No commentary.`;

let id = existing;
const turns = Number(turnsArg);
for (let i = 1; i <= turns; i++) {
  const r = await turn(id, prompt(i));
  id = r.id;
  console.log(`turn ${i}: conversation=${id} toolEvents=${r.tools}`);
}

// CLI transcripts written during the probe: one file per Claude Code session.
// An API message is logged as several `assistant` entries (one per block):
// usage is counted once per message id.
const files = readdirSync(TRANSCRIPTS)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, t: statSync(join(TRANSCRIPTS, f)).mtimeMs }))
  .filter((x) => x.t >= started)
  .sort((a, b) => a.t - b.t);
let totW = 0;
let totR = 0;
let n = 0;
for (const { f } of files) {
  const seen = new Set();
  for (const line of readFileSync(join(TRANSCRIPTS, f), 'utf8').split('\n')) {
    if (!line) continue;
    const d = JSON.parse(line);
    if (d.type !== 'assistant' || !d.message?.usage || d.message.model === '<synthetic>' || d.isSidechain) continue;
    if (seen.has(d.message.id)) continue;
    seen.add(d.message.id);
    const u = d.message.usage;
    totW += u.cache_creation_input_tokens ?? 0;
    totR += u.cache_read_input_tokens ?? 0;
    n++;
    console.log(`session=${f.slice(0, 8)} ${d.timestamp?.slice(11, 19)} ${d.message.model} write=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens} in=${u.input_tokens} out=${u.output_tokens}`);
  }
}
console.log(`sessions=${files.length} requests=${n} cacheWrite=${totW} cacheRead=${totR} readShare=${((100 * totR) / Math.max(1, totW + totR)).toFixed(1)}%`);

if (id && !process.env.KEEP) {
  const del = await fetch(`${BASE}/api/chat/${id}`, { method: 'DELETE', headers: { 'x-alfred-token': token, origin: BASE } });
  console.log('deleted test conversation:', del.status);
}

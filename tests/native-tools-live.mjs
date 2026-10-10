// Live check of engine-mode tool calls through the running gateway (SSE):
// one turn that calls a tool several times, then the shape of the Claude Code
// transcript it left: messages per tool call, interrupt markers, host notes.
//
//   node tests/native-tools-live.mjs [model=haiku] [agent=dev] [calls=4]
//   KEEP=1 keeps the conversation.
//
// Costs real quota: keep the model small. Also measures an existing
// transcript: node tests/native-tools-live.mjs --shape <file.jsonl>...
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TRANSCRIPTS = join(homedir(), '.claude', 'projects', 'C--Users-fabri-Documents-alfred-agent-apps-gateway');

/** Entries per tool call in one transcript (an API message with several blocks counts once). */
export function shape(file) {
  const entries = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
  let user = 0;
  const assistant = new Set();
  let interrupts = 0;
  let hostNotes = 0;
  let calls = 0;
  for (const e of entries) {
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
    if (e.type === 'user') {
      user++;
      if (text.includes('[Request interrupted by user')) interrupts++;
      if (text.includes('[Host note: the \\"[Request interrupted') || text.includes('[Host note: the "[Request interrupted')) hostNotes++;
    } else {
      assistant.add(e.message?.id ?? e.uuid);
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === 'tool_use') calls++;
        if (b.type === 'text') calls += (b.text.match(/<\/tool_call>/g) ?? []).length;
      }
    }
  }
  return {
    file: file.split(/[\\/]/).pop().slice(0, 8),
    userEntries: user,
    assistantMessages: assistant.size,
    toolCalls: calls,
    interrupts,
    hostNotes,
    messagesPerCall: calls ? +((user + assistant.size) / calls).toFixed(2) : null,
  };
}

if (process.argv[2] === '--shape') {
  for (const f of process.argv.slice(3)) console.log(JSON.stringify(shape(f)));
  process.exit(0);
}
if (process.argv[2] === '--since') {
  // Every engine transcript written since a date, summed.
  const since = Date.parse(process.argv[3]);
  const sum = { sessions: 0, userEntries: 0, assistantMessages: 0, toolCalls: 0, interrupts: 0, hostNotes: 0 };
  for (const f of readdirSync(TRANSCRIPTS)) {
    if (!f.endsWith('.jsonl') || statSync(join(TRANSCRIPTS, f)).mtimeMs < since) continue;
    const s = shape(join(TRANSCRIPTS, f));
    if (!s.toolCalls) continue;
    sum.sessions++;
    for (const k of ['userEntries', 'assistantMessages', 'toolCalls', 'interrupts', 'hostNotes']) sum[k] += s[k];
  }
  console.log(JSON.stringify({ ...sum, messagesPerCall: +((sum.userEntries + sum.assistantMessages) / Math.max(1, sum.toolCalls)).toFixed(2) }));
  process.exit(0);
}

const [model = 'haiku', agentId = 'dev', callsArg = '4'] = process.argv.slice(2);
const BASE = process.env.ALFRED_URL ?? 'http://127.0.0.1:4242';
const { token } = await (await fetch(`${BASE}/api/auth/token`)).json();
const headers = { 'content-type': 'application/json', 'x-alfred-token': token, origin: BASE };
const started = Date.now();
const n = Number(callsArg);
const message =
  `Native tool check. Call list_workspace ${n} times in a row, ONE call per reply, with subPath ` +
  `${Array.from({ length: n }, (_, i) => `"${['.', 'apps', 'packages', 'docs', 'scripts', 'data'][i % 6]}"`).join(', then ')}. ` +
  'After the last result, answer with the single word DONE. No commentary.';
const res = await fetch(`${BASE}/api/chat/stream`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ agentId, providerId: 'claude-code', model, message }),
});
if (!res.ok) throw new Error(`stream ${res.status}: ${await res.text()}`);
const sse = await res.text();
const id = /"conversationId"\s*:\s*"([^"]+)"/.exec(sse)?.[1];
console.log(`conversation=${id} toolCallEvents=${(sse.match(/"type"\s*:\s*"tool_call"/g) ?? []).length} ms=${Date.now() - started}`);
console.log('tail:', sse.slice(-240).replace(/\s+/g, ' '));
for (const f of readdirSync(TRANSCRIPTS)
  .filter((f) => f.endsWith('.jsonl') && statSync(join(TRANSCRIPTS, f)).mtimeMs >= started)
  .map((f) => join(TRANSCRIPTS, f))) {
  console.log(JSON.stringify(shape(f)));
}
if (id && !process.env.KEEP) {
  const del = await fetch(`${BASE}/api/chat/${id}`, { method: 'DELETE', headers: { 'x-alfred-token': token, origin: BASE } });
  console.log('deleted test conversation:', del.status);
}

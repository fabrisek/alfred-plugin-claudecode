// Live probe: does the advisor (settings.advisorModel) apply on each seat?
// Starts one streaming-input SDK session per seat with the plugin's engine
// flags, reads `getSettings().applied.advisor` (the advisor the CLI really
// sends, null when the seat refuses it) and, with --ask, one question that
// makes the model call the advisor, then prints the advisor iterations.
//
//   node tests/advisor-probe.mjs [--ask] [seatId ...]
//
// Uses real quota on every seat named (a few cents without --ask: no model
// call is made then).
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const ACCOUNTS = join(import.meta.dirname, '..', 'state', 'accounts');
const ask = process.argv.includes('--ask');
const seats = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CLI = process.env.CLAUDE_CLI ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

class Queue {
  items = [];
  waiters = [];
  done = false;
  push(v) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        this.items.length
          ? Promise.resolve({ value: this.items.shift(), done: false })
          : this.done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((r) => this.waiters.push(r)),
    };
  }
}

for (const seat of seats.length ? seats : ['claude-premium1', 'claude-standard']) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(ACCOUNTS, seat) };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_GIT_BASH_PATH')) delete env[k];
  const input = new Queue();
  const q = query({
    prompt: input,
    options: {
      model: 'opus',
      settingSources: [],
      settings: { advisorModel: 'fable' },
      env,
      pathToClaudeCodeExecutable: CLI,
      extraArgs: { tools: '', 'strict-mcp-config': null, 'disable-slash-commands': null, effort: 'high' },
    },
  });
  const t0 = Date.now();
  let applied;
  try {
    const s = await Promise.race([q.getSettings(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20_000))]);
    applied = s?.applied;
  } catch (err) {
    applied = `error: ${err.message}`;
  }
  console.log(seat, 'applied:', JSON.stringify(applied), `${Date.now() - t0}ms`);
  if (ask) {
    input.push({
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Call your advisor tool once, then answer in one short sentence: is 2^61-1 prime?' }] },
    });
    for await (const m of q) {
      if (m.type === 'assistant') console.log('  blocks:', m.message.content.map((b) => b.type + (b.name ? `:${b.name}` : '')).join(','));
      if (m.type === 'result') {
        console.log('  result:', JSON.stringify(m.result).slice(0, 120), 'cost', m.total_cost_usd);
        console.log('  iterations:', JSON.stringify(m.usage?.iterations));
        break;
      }
    }
  }
  input.close();
  q.close?.();
}

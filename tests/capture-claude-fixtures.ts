// Records real Agent-SDK message sequences into tests/fixtures/claude-stream/*.jsonl
// for the claudeEventMap replay tests. DEFAULT seat only, tiny haiku prompts.
//
// Run: node --import "file:///C:/Users/fabri/Documents/alfred-agent/node_modules/tsx/dist/esm/index.mjs" tests/capture-claude-fixtures.ts [scenario...]
//
// Each line of a fixture is one SDK message as `query()` yields it. Lines with
// `type: "_fixture"` are harness markers (input pushed, interrupt sent) — the
// mapper ignores unknown types, the replay tests use them to drive the adapter.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveCli } from '../src/accounts/cli.js';

const ROOT = import.meta.dirname;
const OUT = join(ROOT, 'fixtures', 'claude-stream');
const WORK = join(ROOT, 'fixtures-work');
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=';

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

function userMsg(text: string, images: string[] = []): unknown {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
        { type: 'text', text },
      ],
    },
  };
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR' || k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  return env;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g;
function scrub(line: string): string {
  return line.replace(TOKEN_RE, 'sk-ant-REDACTED').replace(EMAIL_RE, 'user@example.com');
}

type Ctx = {
  push(text: string, images?: string[]): void;
  interrupt(): Promise<void>;
  mark(action: string, data?: Record<string, unknown>): void;
};

type Scenario = {
  prompt: string;
  images?: string[];
  model?: string;
  resumeFrom?: string;
  resumeId?: string;
  /** Called on every message; may push input or interrupt. */
  onMessage?: (m: Record<string, unknown>, ctx: Ctx, state: Record<string, unknown>) => void;
  setup?: (cwd: string) => void;
  options?: Record<string, unknown>;
};

const sessions: Record<string, string> = {};

const SCENARIOS: Record<string, Scenario> = {
  plain: { prompt: 'Reply with exactly: hi' },
  tools: {
    setup: (cwd) => writeFileSync(join(cwd, 'a.txt'), 'colour=red\n'),
    prompt:
      'Do these steps with your tools, no commentary: 1) Read a.txt. 2) Run the shell command `echo fixture` with Bash. 3) Edit a.txt replacing red with blue. Then reply "done".',
  },
  subagent: {
    prompt:
      'Use the Agent/Task tool to launch ONE general-purpose sub-agent whose job is: "Reply with the word pong and nothing else, do not use tools." Then tell me what it answered, in one word.',
  },
  todos: {
    prompt:
      'Use your todo/task-list tool to create a 2-item list ("alpha", "beta"), then mark both completed, then reply "ok". No other tools.',
  },
  image: { prompt: 'What colour is this image? One word.', images: [RED_PNG] },
  midturn: {
    prompt: 'Run the Bash command `sleep 6 && echo first` and report its output in one line.',
    onMessage: (m, ctx, st) => {
      if (!st.pushed && m.type === 'assistant' && JSON.stringify(m).includes('"tool_use"')) {
        st.pushed = true;
        ctx.push('Also: what is 2+2? Answer in the same reply.');
      }
    },
  },
  interrupt: {
    prompt:
      'Run exactly this Bash command (it takes 40 seconds, that is expected): node -e "setTimeout(() => console.log(1), 40000)" — then report its output.',
    onMessage: (m, ctx, st) => {
      if (!st.sent && m.type === 'assistant' && JSON.stringify(m).includes('"tool_use"')) {
        st.sent = true;
        setTimeout(() => void ctx.interrupt(), 2_000);
      }
    },
  },
  tasks: {
    prompt:
      'Use your task-list tools, no other tools: create two tasks "alpha" and "beta"; mark alpha in_progress; list the tasks; get task beta; mark both completed. Then reply "ok".',
  },
  parallel: {
    setup: (cwd) => {
      writeFileSync(join(cwd, 'x.txt'), 'x\n');
      writeFileSync(join(cwd, 'y.txt'), 'y\n');
    },
    prompt: 'In ONE message, call the Read tool twice in parallel: x.txt and y.txt. Then reply with their contents joined by a comma.',
  },
  resume: { resumeFrom: 'plain', prompt: 'What exactly did I ask you in my previous message? Quote it.' },
  'error-resume-missing': { resumeId: '00000000-0000-4000-8000-000000000000', prompt: 'hello' },
  'error-model': { model: 'claude-does-not-exist-1', prompt: 'hello' },
};

async function run(name: string, sc: Scenario): Promise<void> {
  const cwd = join(WORK, name);
  mkdirSync(cwd, { recursive: true });
  sc.setup?.(cwd);
  const cli = resolveCli('');
  const input = new Queue<unknown>();
  const lines: string[] = [];
  const t0 = Date.now();
  let inputs = 1;
  let results = 0;
  let echoed = 0;
  const state: Record<string, unknown> = {};
  const options: Record<string, unknown> = {
    model: sc.model ?? 'haiku',
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are being recorded for a test fixture. Be terse.' },
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: true,
    forwardSubagentText: true,
    env: childEnv(),
    effort: 'low',
    extraArgs: { 'replay-user-messages': null, 'system-prompt-snapshot': 'off' },
    stderr: (d: string) => process.stderr.write(`[${name} stderr] ${d.slice(0, 300)}`),
    ...sc.options,
  };
  if (cli.path) options.pathToClaudeCodeExecutable = cli.path;
  const resume = sc.resumeId ?? (sc.resumeFrom ? sessions[sc.resumeFrom] : undefined);
  if (resume) {
    options.resume = resume;
    if (sc.resumeFrom) options.cwd = join(WORK, sc.resumeFrom);
  }
  const mark = (action: string, data: Record<string, unknown> = {}): void => {
    lines.push(JSON.stringify({ type: '_fixture', action, t: Date.now() - t0, ...data }));
  };
  mark('start', { scenario: name, model: options.model, resume: !!resume, cli: cli.source });
  input.push(userMsg(sc.prompt, sc.images));
  const q = query({ prompt: input as never, options: options as never });
  const ctx: Ctx = {
    push: (text, images) => {
      inputs += 1;
      mark('push_input', { text });
      input.push(userMsg(text, images));
    },
    interrupt: async () => {
      mark('interrupt');
      await q.interrupt();
    },
    mark,
  };
  const safety = setTimeout(() => {
    mark('safety_timeout');
    input.close();
    void q.interrupt().catch(() => undefined);
  }, 180_000);
  try {
    for await (const raw of q) {
      const m = raw as Record<string, unknown>;
      lines.push(scrub(JSON.stringify(m)));
      if (typeof m.session_id === 'string' && m.session_id && !sessions[name]) sessions[name] = m.session_id;
      sc.onMessage?.(m, ctx, state);
      if (m.type === 'user' && m.isReplay === true) echoed += 1;
      if (m.type === 'result') {
        results += 1;
        // One result can close several inputs: a message sent mid-turn is
        // folded into the running turn (its replay echo precedes the result).
        if (echoed >= inputs) {
          // Give the CLI a moment to emit anything trailing, then close stdin.
          setTimeout(() => input.close(), 1_500);
        }
      }
    }
    mark('end');
  } catch (err) {
    mark('thrown', { message: String((err as Error).message ?? err).slice(0, 500) });
  } finally {
    clearTimeout(safety);
  }
  writeFileSync(join(OUT, `${name}.jsonl`), lines.join('\n') + '\n');
  console.log(`${name}: ${lines.length} lines, ${results} result(s), ${Math.round((Date.now() - t0) / 1000)}s`);
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await run(name, sc);
}
if (!wanted.length || wanted.includes('cleanup')) rmSync(WORK, { recursive: true, force: true });

// Run: node --import <tsx> --test tests/cutter.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallCutter } from '../src/toolCallCutter.js';

const NS = ['antml', ':'].join('');

/** Feeds `text` in `step`-sized deltas; returns what was forwarded and whether it stopped. */
function run(text: string, step: number): { out: string; stopped: boolean } {
  const { out, stopped } = feed(text, step);
  return { out, stopped };
}

/** Same as {@link run}, plus the cutter's call count. */
function feed(text: string, step: number): { out: string; stopped: boolean; calls: number } {
  const c = new ToolCallCutter();
  let out = '';
  for (let i = 0; i < text.length; i += step) {
    const r = c.push(text.slice(i, i + step));
    out += r.text;
    if (r.stop) return { out, stopped: true, calls: c.callCount };
  }
  return { out: out + c.flush(), stopped: false, calls: c.callCount };
}

const CALL = '<tool_call>{"name": "task_get", "arguments": {"id": "t-1"}}</tool_call>';

describe('ToolCallCutter', () => {
  it('passes plain text through untouched', () => {
    for (const step of [1, 3, 50]) {
      assert.deepEqual(run('Hello <b>world</b>, a < b.', step), { out: 'Hello <b>world</b>, a < b.', stopped: false });
    }
  });

  it('cuts a fabricated tool result after the call', () => {
    const text = `Let me check.\n${CALL}\n*Tool result (task_get):*\nt-1 title: invented`;
    for (const step of [1, 2, 7, 1000]) {
      const r = run(text, step);
      assert.equal(r.stopped, true);
      assert.equal(r.out, `Let me check.\n${CALL}`);
    }
  });

  it('keeps back-to-back calls', () => {
    const text = `${CALL}\n\n${CALL}\nthen chatter`;
    for (const step of [1, 5, 1000]) {
      const r = run(text, step);
      assert.equal(r.stopped, true);
      assert.equal(r.out, `${CALL}\n\n${CALL}`);
    }
  });

  it('lets a reply that ends on its call finish normally', () => {
    assert.deepEqual(run(`ok ${CALL}\n`, 4), { out: `ok ${CALL}`, stopped: false });
  });

  it('closes an open function_calls wrapper on the cut', () => {
    const inv = `<${NS}invoke name="now">\n</${NS}invoke>`;
    const text = `<${NS}function_calls>\n${inv}\nTool result: invented`;
    const r = run(text, 3);
    assert.equal(r.stopped, true);
    assert.equal(r.out, `<${NS}function_calls>\n${inv}\n</${NS}function_calls>`);
  });

  it('accepts a closed wrapper followed by nothing but whitespace', () => {
    const text = `<function_calls>\n<invoke name="now">\n</invoke>\n</function_calls>\n`;
    assert.deepEqual(run(text, 2), { out: text.trimEnd(), stopped: false });
  });
});

describe('ToolCallCutter — close tag quoted inside a call', () => {
  const TC_OPEN = '<tool_call>';
  const TC_CLOSE = '</' + 'tool_call>';
  /** A delegate call whose brief quotes the protocol, as JSON with escaped quotes. */
  const quoting = (brief: string) =>
    `${TC_OPEN}${JSON.stringify({ name: 'delegate', arguments: { agentId: 'dev', taskBody: brief } })}${TC_CLOSE}`;

  it('forwards the whole call and cuts only after its real close', () => {
    // Production, 2026-10-10: briefs quoting the tag were cut mid-JSON.
    const call = quoting(`Tools are invoked as ${TC_OPEN}{"name": "x"}${TC_CLOSE} one per reply.`);
    const text = `Delegating.\n${call}\nTool result (delegate): invented`;
    for (const step of [1, 3, 1000]) {
      assert.deepEqual(feed(text, step), { out: `Delegating.\n${call}`, stopped: true, calls: 1 });
    }
  });

  it('gives the same result one character at a time as in one delta', () => {
    const call = quoting(`Write ${TC_OPEN}{"a": "b\\\\"}${TC_CLOSE} then stop.`);
    const text = `${call}\n\n${CALL}\nchatter`;
    assert.deepEqual(feed(text, 1), feed(text, text.length));
    assert.deepEqual(feed(text, 1), { out: `${call}\n\n${CALL}`, stopped: true, calls: 2 });
  });

  it('keeps a marker right after an escaped quote inside the string', () => {
    const call = quoting(`say "hi"${TC_CLOSE} and "bye"`);
    assert.ok(call.includes(`\\"${TC_CLOSE}`), call);
    for (const step of [1, 2, 1000]) {
      assert.deepEqual(feed(`${call}\n`, step), { out: call, stopped: false, calls: 1 });
    }
  });

  it('ignores a close tag in prose with no open call', () => {
    const prose = `A call ends with ${TC_CLOSE}, then "you" wait. ${TC_CLOSE} again.`;
    for (const step of [1, 4, 1000]) {
      assert.deepEqual(feed(prose, step), { out: prose, stopped: false, calls: 0 });
    }
  });
});

describe('ToolCallCutter — degraded spellings and loops', () => {
  it('treats a named invoke as a call and cuts the invented tail after it', () => {
    // Production, 2026-10-08: the dev agent closed its last call and went on
    // to invent that "every tool returns empty".
    const call = '<invoke_task_blocked>\n<parameter name="id">t-7c981797</parameter>\n</invoke_task_blocked>';
    const text = `<invoke_grep>\n<parameter name="pattern">x</parameter>\n</invoke_grep>\n\n${call}\nIt is impossible to work: my tools return no output.`;
    for (const step of [1, 4, 1000]) {
      const r = run(text, step);
      assert.equal(r.stopped, true);
      assert.equal(r.out, text.slice(0, text.indexOf('\nIt is impossible')));
    }
  });

  it('ends a reply that keeps re-opening an empty wrapper', () => {
    const text = 'Reading.\n\n<function_calls>\n\n\n<function_calls>\n\n\n<function_calls>\n'.repeat(3);
    for (const step of [1, 5, 1000]) {
      const r = run(text, step);
      assert.equal(r.stopped, true);
      assert.ok((r.out.match(/<function_calls>/g) ?? []).length <= 2, r.out);
    }
  });

  it('ends a reply on the third copy of the same call, holding it back', () => {
    const inv = '<function_calls>\n<invoke name="read_file">\n<parameter name="path">/a.ts</parameter>\n</invoke>';
    const text = `${inv}\n\n${inv}\n\n${inv}\n\n${inv}`;
    for (const step of [1, 7, 1000]) {
      const r = run(text, step);
      assert.equal(r.stopped, true);
      assert.equal((r.out.match(/<invoke /g) ?? []).length, 2);
      assert.ok(r.out.trimEnd().endsWith('</function_calls>'));
    }
  });

  it('caps the number of calls in one reply', () => {
    const calls = Array.from({ length: 40 }, (_, i) => `<invoke name="task_get">\n<parameter name="id">t-${i}</parameter>\n</invoke>`);
    const r = run(calls.join('\n'), 50);
    assert.equal(r.stopped, true);
    assert.equal((r.out.match(/<invoke /g) ?? []).length, 25);
  });
});

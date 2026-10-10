/**
 * Stops a reply right after its tool calls — the job a stop sequence does on
 * any other backend, which the Claude Code CLI does not offer.
 *
 * Alfred re-sends the whole conversation as one labelled transcript
 * ("Assistant:", "Tool result (x):" …). Without native tools, nothing stops
 * the model after it writes a tool call: it happily continues the transcript
 * pattern, *inventing* the tool result ("Tool result (task_get): …") and
 * reasoning on it. Seen in production on delegated sub-agents: fabricated task
 * data, then a reply ending in raw markup Alfred never executed.
 *
 * Rule: once a tool-call block has closed, the reply may only go on with
 * whitespace and further tool-call blocks (several calls back to back are
 * legitimate). The first other character ends the reply there; the rest of
 * the generation is dropped and the CLI is stopped.
 *
 * Both syntaxes are watched: Alfred's `<tool_call>{json}</tool_call>` and
 * Claude's own `<invoke name=…>` blocks (optionally inside
 * `<function_calls>`, optionally namespaced), plus the degraded
 * `<invoke_NAME>…</invoke_NAME>` spelling it falls into on long runs. When the
 * cut lands inside an open wrapper, the wrapper is closed so the host's parser
 * sees a well-formed block.
 *
 * Alfred's close tag only counts inside an open call and outside its JSON
 * strings ({@link AlfredCallCloseScanner}): a brief quoting the protocol is
 * not a close. Likewise, an open Alfred call only ends at its own close: a
 * Claude close tag quoted in its arguments is ignored — unless the Alfred
 * opener itself sits inside an unclosed Claude block (a native call quoting
 * Alfred's protocol), which keeps its Claude close.
 *
 * A model can also loop instead of stopping: the same call written hundreds of
 * times, or `<function_calls>` openers with nothing in them (seen: 100 kB of
 * it, until the user pressed Stop). So the reply also ends on an empty
 * wrapper opened twice in a row, on the third copy of one call, and after
 * {@link MAX_CALLS_PER_REPLY} calls.
 */

import { AlfredCallCloseScanner, CALL_CLOSE } from './alfredCallCloseScanner.js';

const NS = ['antml', ':'].join('');
const PREFIXES = ['', NS];

const CLOSES = [
  '</tool_call>',
  ...PREFIXES.flatMap((p) => [`</${p}invoke>`, `</${p}function_calls>`]),
];
/** Closes found by plain search; Alfred's own is left to the scanner. */
const BLOCK_CLOSES = CLOSES.filter((c) => c !== CALL_CLOSE);
/** Close of the named spelling, `</invoke_grep>`. */
const NAMED_CLOSE = /<\/(?:antml:)?invoke_[A-Za-z0-9_.:-]+\s*>/g;
/** What may follow a closed call without ending the reply. */
const CONTINUATIONS = [
  '<tool_call>',
  ...PREFIXES.flatMap((p) => [
    `<${p}invoke `,
    `<${p}invoke_`,
    `<${p}function_calls>`,
    `</${p}function_calls>`,
  ]),
];
const WRAPPER_OPEN = PREFIXES.map((p) => `<${p}function_calls>`);
const WRAPPER_CLOSE = PREFIXES.map((p) => `</${p}function_calls>`);
const MAX_MARKER = Math.max(...CLOSES.map((c) => c.length));
/** Longest named close we wait for when a delta splits it. */
const MAX_NAMED_CLOSE = 80;
/** Start of a Claude-syntax block: `<invoke `, `<invoke_x>`, `<function_calls>`. */
const CLAUDE_OPEN = /<(?:antml:)?(?:invoke[\s_]|function_calls>)/;
/** A wrapper opened again with nothing in between: the model is looping. */
const EMPTY_WRAPPER_REPEAT = /<(?:antml:)?function_calls>\s*(?=<(?:antml:)?function_calls>)/;

/** More calls than this in one reply is a loop, not a plan. */
export const MAX_CALLS_PER_REPLY = 25;
/** A call written this many times in one reply ends it before that copy. */
const MAX_COPIES_OF_A_CALL = 3;

export type CutterOutput = {
  /** Text to forward now. */
  text: string;
  /** True once the reply is complete: stop the CLI, forward nothing more. */
  stop: boolean;
};

export class ToolCallCutter {
  /** All text seen and accepted so far (forwarded or held). */
  private all = '';
  /** How much of `all` has been forwarded. */
  private sent = 0;
  /** Where the next close search starts. */
  private scanFrom = 0;
  /** Where the next empty-wrapper search starts. */
  private loopScanFrom = 0;
  /** A call has closed; `all.slice(sent)` is held until we know what follows. */
  private afterClose = false;
  private stopped = false;
  /** End of the previous closed call block. */
  private lastCloseEnd = 0;
  private calls = 0;
  private readonly copies = new Map<string, number>();
  /**
   * A call that follows another one is held until it closes: it may still be
   * refused (a loop), and half of it must not have reached the host by then.
   */
  private holding = false;
  private readonly alfredCalls = new AlfredCallCloseScanner();

  /** Tool calls closed so far in this reply (0 = a plain answer). */
  get callCount(): number {
    return this.calls;
  }

  push(delta: string): CutterOutput {
    if (this.stopped || !delta) return { text: '', stop: this.stopped };
    this.all += delta;
    let out = '';
    for (;;) {
      if (this.afterClose) {
        const held = this.all.slice(this.sent);
        const body = held.trimStart();
        if (body === '') return { text: out, stop: false };
        const lead = held.length - body.length;
        const full = CONTINUATIONS.find((m) => body.startsWith(m));
        if (full) {
          // Another call follows: forward the whitespace and keep scanning.
          out += held.slice(0, lead);
          this.sent += lead;
          this.afterClose = false;
          this.holding = true;
          this.scanFrom = this.sent;
          continue;
        }
        if (CONTINUATIONS.some((m) => m.startsWith(body))) {
          return { text: out, stop: false }; // could still become a marker
        }
        // Anything else is the model continuing on its own: cut here.
        return this.stop(out);
      }
      const loopAt = this.findEmptyWrapperRepeat();
      const close = this.findClose();
      if (loopAt !== null && (close === null || loopAt < close)) {
        const upto = Math.max(this.sent, loopAt);
        out += this.all.slice(this.sent, upto);
        this.sent = upto;
        return this.stop(out);
      }
      if (close === null) {
        if (!this.holding) {
          out += this.all.slice(this.sent);
          this.sent = this.all.length;
        }
        // Rescan the tail: a close tag may be split across deltas. Never
        // before the last close, which would be found a second time.
        this.scanFrom = Math.max(this.lastCloseEnd, this.all.length - MAX_NAMED_CLOSE);
        return { text: out, stop: false };
      }
      // Drop a refused call: the reply ends with the previous one.
      if (!this.admitCall(close)) return this.stop(out);
      this.holding = false;
      out += this.all.slice(this.sent, close);
      this.sent = close;
      this.scanFrom = close;
      this.lastCloseEnd = close;
      this.afterClose = true;
    }
  }

  /** End of stream: release whatever is held (only ever whitespace after a call). */
  flush(): string {
    if (this.stopped) return '';
    const rest = this.all.slice(this.sent);
    this.sent = this.all.length;
    return this.afterClose ? '' : rest;
  }

  private stop(out: string): CutterOutput {
    this.stopped = true;
    return { text: out + this.closeOpenWrapper(), stop: true };
  }

  /**
   * Counts the call closing at `end`; false when it is one too many (the
   * reply's cap, or a copy of a call already made twice). A wrapper close is
   * not a call of its own.
   */
  private admitCall(end: number): boolean {
    const block = this.all.slice(this.lastCloseEnd, end);
    if (WRAPPER_CLOSE.some((c) => block.trimEnd().endsWith(c)) && !/<(?:antml:)?invoke|<tool_call>/.test(block)) {
      return true;
    }
    const key = block
      .replace(/<\/?(?:antml:)?function_calls>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const seen = (this.copies.get(key) ?? 0) + 1;
    if (seen >= MAX_COPIES_OF_A_CALL || this.calls >= MAX_CALLS_PER_REPLY) return false;
    this.copies.set(key, seen);
    this.calls++;
    return true;
  }

  private findClose(): number | null {
    let best = this.alfredCalls.findClose(this.all, this.lastCloseEnd);
    const mask = this.alfredCallStart();
    // Only the first match of each marker matters: if it is masked, every
    // later one is too (masking runs from `mask` to the Alfred close, if any).
    for (const marker of BLOCK_CLOSES) {
      const at = this.all.indexOf(marker, this.scanFrom);
      if (at >= 0 && at < mask) {
        const end = at + marker.length;
        if (best === null || end < best) best = end;
      }
    }
    NAMED_CLOSE.lastIndex = this.scanFrom;
    const named = NAMED_CLOSE.exec(this.all);
    if (named && named.index < mask) {
      const end = named.index + named[0].length;
      if (best === null || end < best) best = end;
    }
    return best;
  }

  /**
   * Offset from which Claude close tags belong to an open Alfred call and are
   * ignored; Infinity when none is open, or when its opener is itself inside
   * an unclosed Claude block. Call after `alfredCalls.findClose`.
   */
  private alfredCallStart(): number {
    const open = this.alfredCalls.openedAt;
    if (open === null) return Infinity;
    // Any Claude opener since the last close is still unclosed (its close
    // would have moved `lastCloseEnd`).
    if (CLAUDE_OPEN.test(this.all.slice(this.lastCloseEnd, open))) return Infinity;
    return open;
  }

  /** Offset of a wrapper re-opened with nothing inside, if any. */
  private findEmptyWrapperRepeat(): number | null {
    const from = Math.max(this.lastCloseEnd, this.loopScanFrom);
    const match = EMPTY_WRAPPER_REPEAT.exec(this.all.slice(from));
    // The openers may arrive split across deltas: rescan a little behind the end.
    this.loopScanFrom = Math.max(this.lastCloseEnd, this.all.length - 64);
    if (!match) return null;
    return from + match.index + match[0].length;
  }

  /** Closer for a `<function_calls>` wrapper the cut leaves open, if any. */
  private closeOpenWrapper(): string {
    const sent = this.all.slice(0, this.sent);
    for (let i = 0; i < PREFIXES.length; i++) {
      const open = sent.lastIndexOf(WRAPPER_OPEN[i]);
      if (open >= 0 && sent.indexOf(WRAPPER_CLOSE[i], open) < 0) return `\n${WRAPPER_CLOSE[i]}`;
    }
    return '';
  }
}

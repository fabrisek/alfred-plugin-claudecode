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
 * `<function_calls>`, optionally namespaced), which the model sometimes falls
 * back to. When the cut lands inside an open wrapper, the wrapper is closed so
 * the host's parser sees a well-formed block.
 */

const NS = ['antml', ':'].join('');
const PREFIXES = ['', NS];

const CLOSES = [
  '</tool_call>',
  ...PREFIXES.flatMap((p) => [`</${p}invoke>`, `</${p}function_calls>`]),
];
/** What may follow a closed call without ending the reply. */
const CONTINUATIONS = [
  '<tool_call>',
  ...PREFIXES.flatMap((p) => [`<${p}invoke `, `<${p}function_calls>`, `</${p}function_calls>`]),
];
const WRAPPER_OPEN = PREFIXES.map((p) => `<${p}function_calls>`);
const WRAPPER_CLOSE = PREFIXES.map((p) => `</${p}function_calls>`);
const MAX_MARKER = Math.max(...CLOSES.map((c) => c.length));

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
  /** A call has closed; `all.slice(sent)` is held until we know what follows. */
  private afterClose = false;
  private stopped = false;

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
          this.scanFrom = this.sent;
          continue;
        }
        if (CONTINUATIONS.some((m) => m.startsWith(body))) {
          return { text: out, stop: false }; // could still become a marker
        }
        // Anything else is the model continuing on its own: cut here.
        this.stopped = true;
        return { text: out + this.closeOpenWrapper(), stop: true };
      }
      const close = this.findClose();
      if (close === null) {
        out += this.all.slice(this.sent);
        this.sent = this.all.length;
        this.scanFrom = Math.max(0, this.all.length - MAX_MARKER);
        return { text: out, stop: false };
      }
      out += this.all.slice(this.sent, close);
      this.sent = close;
      this.scanFrom = close;
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

  private findClose(): number | null {
    let best: number | null = null;
    for (const marker of CLOSES) {
      const at = this.all.indexOf(marker, this.scanFrom);
      if (at >= 0) {
        const end = at + marker.length;
        if (best === null || end < best) best = end;
      }
    }
    return best;
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

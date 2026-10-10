/**
 * Finds where an Alfred text-protocol tool call (`<tool_call>{json}` + close
 * tag) really closes.
 *
 * The close tag only counts while a call is open and when it sits outside
 * every JSON string of that call: a delegate brief that quotes the protocol
 * must not end the call it is part of. A close tag with no open call (prose
 * naming the tag) never closes anything.
 *
 * Incremental: state is kept between calls, so each character is lexed once.
 * The scan never consumes a position where a tag may still be completing, and
 * the escape state survives across calls, so a tag or an escape sequence split
 * across deltas gives the same result as one big delta.
 */

export const CALL_OPEN = '<tool_call>';
export const CALL_CLOSE = '</' + 'tool_call>';

export class AlfredCallCloseScanner {
  /** Block start the current state belongs to. */
  private from = -1;
  /** Next offset to lex. */
  private pos = 0;
  /** An opener has been seen since `from`. */
  private open = false;
  /** Offset of the first opener since `from`, or -1. */
  private openAt = -1;
  private inString = false;
  /** The previous in-string character was an unescaped backslash. */
  private escaped = false;

  /**
   * End offset (exclusive) of the first real call close in `text` at or after
   * `blockStart`, or null. `text` may only grow between calls with the same
   * `blockStart`; a different `blockStart` restarts the scan there.
   * Idempotent: a found close is returned again until `blockStart` moves.
   */
  findClose(text: string, blockStart: number): number | null {
    if (blockStart !== this.from) this.reset(blockStart);
    while (this.pos < text.length) {
      const i = this.pos;
      const c = text[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.inString = false;
        this.pos++;
        continue;
      }
      if (c === '<') {
        // A tag may still be arriving: wait for the next delta.
        if (isPartial(text, i, CALL_CLOSE) || isPartial(text, i, CALL_OPEN)) return null;
        if (text.startsWith(CALL_CLOSE, i)) {
          if (this.open) return i + CALL_CLOSE.length;
        } else if (text.startsWith(CALL_OPEN, i)) {
          // Outside a string, an opener starts the call afresh.
          if (!this.open) this.openAt = i;
          this.open = true;
          this.pos = i + CALL_OPEN.length;
          continue;
        }
      } else if (c === '"' && this.open) {
        this.inString = true;
      }
      this.pos++;
    }
    return null;
  }

  /**
   * Offset of the opener of the call being scanned (as of the last
   * {@link findClose}), or null when no call is open. Everything from there to
   * the call's close belongs to that call.
   */
  get openedAt(): number | null {
    return this.open ? this.openAt : null;
  }

  private reset(blockStart: number): void {
    this.from = blockStart;
    this.pos = blockStart;
    this.open = false;
    this.openAt = -1;
    this.inString = false;
    this.escaped = false;
  }
}

/** True when `text` ends at `at` with a strict prefix of `tag`. */
function isPartial(text: string, at: number, tag: string): boolean {
  return text.length - at < tag.length && tag.startsWith(text.slice(at));
}

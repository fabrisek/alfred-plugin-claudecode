/**
 * Plumbing of a live CLI turn: an async input queue (the SDK's streaming
 * input), an event channel the turn's pump writes to and the host reads
 * from, and the registry of live turns (killed on deactivate).
 */

/** Async iterable fed by `push`, ended by `close`. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  get closed(): boolean {
    return this.ended;
  }

  push(v: T): boolean {
    if (this.ended) return false;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
    return true;
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/** Process-wide registry of live turns, so deactivate can stop every CLI. */
export class TurnRegistry<T extends { kill(reason: string): void }> {
  private readonly live = new Map<string, T>();

  add(id: string, turn: T): void {
    this.live.set(id, turn);
  }

  get(id: string): T | undefined {
    return this.live.get(id);
  }

  delete(id: string, turn: T): void {
    if (this.live.get(id) === turn) this.live.delete(id);
  }

  get size(): number {
    return this.live.size;
  }

  killAll(reason: string): void {
    for (const t of this.live.values()) {
      try {
        t.kill(reason);
      } catch {
        // already gone
      }
    }
    this.live.clear();
  }
}

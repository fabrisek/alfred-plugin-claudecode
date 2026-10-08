/**
 * Runs a webview page's inline script in `node:vm` over {@link MiniDocument},
 * with a `window.alfred.invoke` the caller supplies and a virtual clock, so a
 * test can count live timers, advance time and click buttons.
 */

import vm from 'node:vm';
import { DomEvent, Element, loadPage, parseIssues, type MiniDocument } from './miniDom.js';

export type Invoke = (action: string, args: Record<string, unknown>) => Promise<unknown>;

type Timer = { id: number; at: number; every: number | null; fn: () => unknown };

export type PageRun = {
  doc: MiniDocument;
  errors: string[];
  calls: Array<{ action: string; args: Record<string, unknown> }>;
  /** Live timers by kind, to spot intervals that pile up. */
  timers(): { intervals: number; timeouts: number };
  /** Advance the virtual clock, firing due timers, and let promises settle. */
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  click(el: Element | null): Promise<void>;
  /** Sets an input's value and fires `input` + `change`. */
  type(el: Element | null, value: string): Promise<void>;
  $(id: string): Element | null;
  text(sel: string): string;
  parseIssues: string[];
};

export async function runPage(html: string, invoke: Invoke, opts: { startAt?: number } = {}): Promise<PageRun> {
  parseIssues.length = 0;
  const { doc, scripts } = loadPage(html);
  const errors: string[] = [];
  const calls: PageRun['calls'] = [];
  let now = opts.startAt ?? Date.now();
  let seq = 0;
  const timers = new Map<number, Timer>();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(now);
      else super(...(a as [number]));
    }
    static now(): number {
      return now;
    }
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const guard = (fn: () => unknown, where: string): void => {
    try {
      const r = fn() as { catch?: (f: (e: unknown) => void) => void } | undefined;
      if (r && typeof r.catch === 'function') r.catch((e) => errors.push(`${where}: ${(e as Error)?.stack ?? e}`));
    } catch (e) {
      errors.push(`${where}: ${(e as Error)?.stack ?? e}`);
    }
  };
  const window: Record<string, unknown> = {
    document: doc,
    Date: FakeDate,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Promise,
    Error,
    RegExp,
    Intl,
    isNaN,
    parseInt,
    parseFloat,
    console: { log: () => {}, warn: (...a: unknown[]) => errors.push('console.warn: ' + a.join(' ')), error: (...a: unknown[]) => errors.push('console.error: ' + a.join(' ')) },
    setTimeout: (fn: () => unknown, ms = 0) => {
      const id = ++seq;
      timers.set(id, { id, at: now + Math.max(0, ms), every: null, fn });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(Number(id)),
    setInterval: (fn: () => unknown, ms = 0) => {
      const id = ++seq;
      timers.set(id, { id, at: now + Math.max(1, ms), every: Math.max(1, ms), fn });
      return id;
    },
    clearInterval: (id: number) => timers.delete(Number(id)),
    requestAnimationFrame: (fn: () => unknown) => {
      const id = ++seq;
      timers.set(id, { id, at: now + 16, every: null, fn });
      return id;
    },
    cancelAnimationFrame: (id: number) => timers.delete(Number(id)),
    get localStorage(): never {
      throw new Error('SecurityError: localStorage is not available in a sandboxed iframe');
    },
    get sessionStorage(): never {
      throw new Error('SecurityError: sessionStorage is not available in a sandboxed iframe');
    },
    alert: () => errors.push('alert() is ignored in the sandbox'),
    confirm: () => {
      errors.push('confirm() is ignored in the sandbox');
      return false;
    },
    prompt: () => {
      errors.push('prompt() is ignored in the sandbox');
      return null;
    },
    fetch: () => {
      errors.push('fetch() has no origin in the sandbox');
      return Promise.reject(new Error('fetch blocked'));
    },
    addEventListener: (type: string, fn: (e: DomEvent) => unknown) => doc.addEventListener(type, fn),
    removeEventListener: (type: string, fn: (e: DomEvent) => unknown) => doc.removeEventListener(type, fn),
    alfred: {
      invoke: (action: string, args: Record<string, unknown>) => {
        // Re-created in this realm, so deepEqual against plain objects works.
        calls.push({ action, args: JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown> });
        return invoke(action, args ?? {});
      },
      on: () => () => {},
      off: () => {},
    },
  };
  window.window = window;
  window.self = window;
  window.parent = window;
  const ctx = vm.createContext(window);
  for (const s of scripts) {
    try {
      vm.runInContext(s, ctx, { filename: 'webview-inline.js' });
    } catch (e) {
      errors.push(`script: ${(e as Error)?.stack ?? e}`);
    }
  }
  await settle();

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      if (due.every) due.at = now + due.every;
      else timers.delete(due.id);
      guard(due.fn, 'timer');
      await settle();
    }
    now = target;
    await settle();
  };
  const fireAll = async (results: unknown[], where: string): Promise<void> => {
    for (const r of results) {
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        await (r as Promise<unknown>).catch((e) => errors.push(`${where}: ${(e as Error)?.stack ?? e}`));
      }
    }
    await settle();
  };
  return {
    doc,
    errors,
    calls,
    parseIssues,
    timers: () => {
      let intervals = 0;
      let timeouts = 0;
      for (const t of timers.values()) (t.every ? intervals++ : timeouts++);
      return { intervals, timeouts };
    },
    advance,
    settle,
    click: async (el) => {
      if (!el) {
        errors.push('click: element not found');
        return;
      }
      try {
        await fireAll(el.click(), 'click');
      } catch (e) {
        errors.push(`click: ${(e as Error)?.stack ?? e}`);
      }
    },
    type: async (el, value) => {
      if (!el) {
        errors.push('type: element not found');
        return;
      }
      el.value = value;
      el.focus();
      await fireAll(el.dispatchEvent(new DomEvent('input')), 'input');
      await fireAll(el.dispatchEvent(new DomEvent('change')), 'change');
    },
    $: (id) => doc.getElementById(id),
    text: (sel) => doc.querySelectorAll(sel).map((e) => e.textContent).join(' | '),
  };
}

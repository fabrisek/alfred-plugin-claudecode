/**
 * A small DOM, enough to run a webview's inline script under `node:vm`.
 *
 * No DOM library ships with the host or the plugin, and the webview has to be
 * checked without a browser: this parses the page's markup (and every
 * `innerHTML` the script writes) into real nodes, so `getElementById`,
 * `closest`, `querySelectorAll` and click bubbling behave as they would in
 * the iframe. Selectors: tag, `#id`, `.class`, `[attr]`, `[attr=value]`,
 * compounds of those, descendant combinator and `,` lists.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', middot: '·', mdash: '—', hellip: '…', times: '×' };

export function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function encodeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type Listener = (e: DomEvent) => unknown;

export class DomEvent {
  target: Element | null = null;
  currentTarget: Node | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  key?: string;
  constructor(
    public type: string,
    public bubbles = true,
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

export class Node {
  parentNode: Element | null = null;
  childNodes: Node[] = [];
  ownerDocument!: MiniDocument;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((x) => x !== fn));
  }
  /** Fires the listeners of this node only; returns their results (promises included). */
  fire(e: DomEvent): unknown[] {
    e.currentTarget = this;
    return (this.listeners.get(e.type) ?? []).slice().map((fn) => fn(e));
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) (this as unknown as Element).appendChild(new Text(String(v), this.ownerDocument));
  }
  get nextSibling(): Node | null {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) + 1] ?? null;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

export class Text extends Node {
  constructor(
    public data: string,
    doc: MiniDocument,
  ) {
    super();
    this.ownerDocument = doc;
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(v: string) {
    this.data = String(v);
  }
  get nodeType(): number {
    return 3;
  }
}

type Simple = { tag?: string; id?: string; classes: string[]; attrs: Array<[string, string | undefined]> };

function parseSimple(s: string): Simple {
  const out: Simple = { classes: [], attrs: [] };
  const re = /([a-z0-9-]+)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1] && m.index === 0) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4].toLowerCase(), m[5]]);
  }
  return out;
}

function matchSimple(el: Element, s: Simple): boolean {
  if (s.tag && s.tag !== '*' && el.tagName.toLowerCase() !== s.tag) return false;
  if (s.id && el.getAttribute('id') !== s.id) return false;
  for (const c of s.classes) if (!el.classList.contains(c)) return false;
  for (const [k, v] of s.attrs) {
    if (!el.hasAttribute(k)) return false;
    if (v !== undefined && el.getAttribute(k) !== v) return false;
  }
  return true;
}

function matches(el: Element, selector: string): boolean {
  return selector.split(',').some((part) => {
    const chain = part.trim().split(/\s+/).map(parseSimple);
    let i = chain.length - 1;
    if (!matchSimple(el, chain[i])) return false;
    let cur = el.parentNode;
    i--;
    while (i >= 0 && cur) {
      if (matchSimple(cur, chain[i])) i--;
      cur = cur.parentNode;
    }
    return i < 0;
  });
}

class ClassList {
  constructor(private el: Element) {}
  private get list(): string[] {
    return (this.el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }
  private set list(v: string[]) {
    this.el.setAttribute('class', v.join(' '));
  }
  contains(c: string): boolean {
    return this.list.includes(c);
  }
  add(...cs: string[]): void {
    const l = this.list;
    for (const c of cs) if (!l.includes(c)) l.push(c);
    this.list = l;
  }
  remove(...cs: string[]): void {
    this.list = this.list.filter((c) => !cs.includes(c));
  }
  toggle(c: string, force?: boolean): boolean {
    const on = force === undefined ? !this.contains(c) : force;
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
}

export class Element extends Node {
  attributes = new Map<string, string>();
  readonly classList: ClassList;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string>;
  value = '';
  checked = false;

  constructor(
    public tagName: string,
    doc: MiniDocument,
  ) {
    super();
    this.ownerDocument = doc;
    this.classList = new ClassList(this);
    const self = this;
    const attrOf = (k: string) => 'data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, k: string) => self.getAttribute(attrOf(k)) ?? undefined,
      set: (_t, k: string, v) => {
        self.setAttribute(attrOf(k), String(v));
        return true;
      },
    });
  }
  get nodeType(): number {
    return 1;
  }
  /** Short form in assertion messages: a node drags its whole tree along otherwise. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    const id = this.getAttribute('id');
    const key = this.getAttribute('data-key');
    return `<${this.tagName.toLowerCase()}${id ? ` id=${id}` : ''}${key ? ` data-key=${key}` : ''}>`;
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  set id(v: string) {
    this.setAttribute('id', v);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(v: string) {
    this.setAttribute('class', v);
  }
  get title(): string {
    return this.getAttribute('title') ?? '';
  }
  set title(v: string) {
    this.setAttribute('title', v);
  }
  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }
  set disabled(v: boolean) {
    if (v) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }
  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }
  get open(): boolean {
    return this.hasAttribute('open');
  }
  set open(v: boolean) {
    if (v) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }
  get children(): Element[] {
    return this.childNodes.filter((c): c is Element => c instanceof Element);
  }
  get firstChild(): Node | null {
    return this.childNodes[0] ?? null;
  }
  get firstElementChild(): Element | null {
    return this.children[0] ?? null;
  }
  getAttribute(k: string): string | null {
    return this.attributes.has(k.toLowerCase()) ? (this.attributes.get(k.toLowerCase()) as string) : null;
  }
  setAttribute(k: string, v: string): void {
    k = k.toLowerCase();
    this.attributes.set(k, String(v));
    if (k === 'value') this.value = String(v);
  }
  removeAttribute(k: string): void {
    this.attributes.delete(k.toLowerCase());
  }
  hasAttribute(k: string): boolean {
    return this.attributes.has(k.toLowerCase());
  }
  appendChild<T extends Node>(n: T): T {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...ns: Node[]): void {
    for (const n of ns) this.appendChild(n);
  }
  insertBefore<T extends Node>(n: T, ref: Node | null): T {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    return n;
  }
  removeChild<T extends Node>(n: T): T {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...ns: Node[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...ns);
  }
  get innerHTML(): string {
    return this.childNodes.map(serialize).join('');
  }
  set innerHTML(html: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    parseInto(this, String(html), this.ownerDocument);
    this.ownerDocument.stats.innerHTMLWrites++;
  }
  get outerHTML(): string {
    return serialize(this);
  }
  matches(sel: string): boolean {
    return matches(this, sel);
  }
  closest(sel: string): Element | null {
    let cur: Element | null = this;
    while (cur) {
      if (matches(cur, sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(sel: string): Element[] {
    const out: Element[] = [];
    const walk = (n: Element): void => {
      for (const c of n.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): Element | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  contains(n: Node | null): boolean {
    let cur: Node | null = n;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  /** Bubbling dispatch. Returns every listener result, so a test can await async handlers. */
  dispatchEvent(e: DomEvent): unknown[] {
    e.target = this;
    const results: unknown[] = [];
    let cur: Node | null = this;
    while (cur && !e.propagationStopped) {
      results.push(...cur.fire(e));
      if (!e.bubbles) break;
      cur = cur.parentNode ?? (cur === this.ownerDocument.documentElement ? this.ownerDocument : null);
    }
    return results;
  }
  click(): unknown[] {
    if (this.disabled) return [];
    return this.dispatchEvent(new DomEvent('click'));
  }
}

function serialize(n: Node): string {
  if (n instanceof Text) return encodeText(n.data);
  const el = n as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = [...el.attributes].map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${el.innerHTML}</${tag}>`;
}

/** Problems the parser met: unclosed or stray tags mean the page wrote broken markup. */
export const parseIssues: string[] = [];

function parseInto(root: Element, html: string, doc: MiniDocument): void {
  const stack: Element[] = [root];
  const top = (): Element => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', i)) {
      i = html.indexOf('>', i) + 1 || html.length;
      continue;
    }
    if (html[i] === '<' && html[i + 1] === '/') {
      const end = html.indexOf('>', i);
      const name = html.slice(i + 2, end).trim().toLowerCase();
      i = end + 1;
      const idx = stack.map((e) => e.tagName.toLowerCase()).lastIndexOf(name);
      if (idx <= 0) {
        parseIssues.push(`stray </${name}>`);
        continue;
      }
      if (idx !== stack.length - 1) parseIssues.push(`unclosed <${top().tagName.toLowerCase()}> before </${name}>`);
      stack.length = idx;
      continue;
    }
    if (html[i] === '<' && /[a-z]/i.test(html[i + 1] ?? '')) {
      const m = /^<([a-z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/i.exec(html.slice(i));
      if (!m) {
        top().appendChild(new Text(html[i], doc));
        i++;
        continue;
      }
      const tag = m[1].toLowerCase();
      const el = new Element(tag.toUpperCase(), doc);
      const are = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = are.exec(m[2]))) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      top().appendChild(el);
      i += m[0].length;
      if (VOID.has(tag) || m[3]) continue;
      if (RAW.has(tag)) {
        const close = html.toLowerCase().indexOf(`</${tag}`, i);
        const end = close < 0 ? html.length : close;
        const raw = html.slice(i, end);
        if (raw) el.appendChild(new Text(tag === 'textarea' || tag === 'title' ? decode(raw) : raw, doc));
        if (tag === 'textarea') el.value = decode(raw);
        i = close < 0 ? html.length : html.indexOf('>', close) + 1;
        continue;
      }
      stack.push(el);
      continue;
    }
    const next = html.indexOf('<', i + 1);
    const end = next < 0 ? html.length : next;
    top().appendChild(new Text(decode(html.slice(i, end)), doc));
    i = end;
  }
  if (stack.length > 1) parseIssues.push(`unclosed <${stack.slice(1).map((e) => e.tagName.toLowerCase()).join('>, <')}> at end of fragment`);
}

export class MiniDocument extends Node {
  documentElement: Element;
  head: Element;
  body: Element;
  activeElement: Element | null = null;
  hidden = false;
  visibilityState = 'visible';
  stats = { innerHTMLWrites: 0 };

  constructor() {
    super();
    this.ownerDocument = this;
    this.documentElement = new Element('HTML', this);
    this.head = new Element('HEAD', this);
    this.body = new Element('BODY', this);
    this.documentElement.append(this.head, this.body);
  }
  getElementById(id: string): Element | null {
    if (this.documentElement.getAttribute('id') === id) return this.documentElement;
    return this.documentElement.querySelector('#' + id);
  }
  querySelectorAll(sel: string): Element[] {
    return this.documentElement.querySelectorAll(sel);
  }
  querySelector(sel: string): Element | null {
    return this.documentElement.querySelector(sel);
  }
  createElement(tag: string): Element {
    return new Element(tag.toUpperCase(), this);
  }
  createTextNode(s: string): Text {
    return new Text(s, this);
  }
}

/** A document from a full page; the inline scripts are returned, not run. */
export function loadPage(html: string): { doc: MiniDocument; scripts: string[] } {
  const doc = new MiniDocument();
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const scripts: string[] = [];
  const markup = body.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_m, s: string) => {
    scripts.push(s);
    return '';
  });
  // Head scripts (the host shim) are not part of the plugin's page.
  doc.body.innerHTML = markup;
  doc.stats.innerHTMLWrites = 0;
  return { doc, scripts };
}

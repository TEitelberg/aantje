type Listener = (event: Record<string, unknown>) => void;

/** The part of a DOM element that the page blocks use; enough to build a page and to fire the events of its controls. */
export class FakeNode {
  static active: FakeNode | undefined;

  children: FakeNode[] = [];
  listeners = new Map<string, Listener[]>();
  className = '';
  title = '';
  tabIndex = -1;
  type = '';
  value = '';
  checked = false;
  disabled = false;
  open = false;
  hidden = false;
  style: Record<string, string> = {};
  private readonly attributeValues = new Map<string, string>();
  private own = '';

  constructor(readonly tag: string) {}

  get textContent(): string {
    return this.own + this.children.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.children = [];
    this.own = text;
  }
  hasClass(name: string): boolean {
    return this.className.split(' ').includes(name);
  }
  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeNode('#text') : node;
      if (typeof node === 'string') child.textContent = node;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributeValues.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributeValues.get(name) ?? null;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  focus(): void {
    FakeNode.active = this;
  }
  /** Fires the listeners; the event gets the node as its target and a `preventDefault` that is counted. */
  fire(type: string, event: Record<string, unknown> = {}): { prevented: boolean } {
    const result = { prevented: false };
    for (const listener of this.listeners.get(type) ?? []) {
      listener({
        target: this,
        preventDefault: () => {
          result.prevented = true;
        },
        ...event,
      });
    }
    return result;
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.find(predicate))].filter(predicate);
  }
  byClass(name: string): FakeNode[] {
    return this.find((node) => node.hasClass(name));
  }
  byTag(tag: string): FakeNode[] {
    return this.find((node) => node.tag === tag);
  }
  buttons(label?: string): FakeNode[] {
    return this.find((node) => node.tag === 'button' && (label === undefined || node.textContent === label));
  }
}

/** Gives `el()` a `document` that makes fake nodes, for the tests that call the page blocks directly. */
export function installFakeDocument(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeNode(tag),
  };
  FakeNode.active = undefined;
}

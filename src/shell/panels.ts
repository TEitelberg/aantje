import { own } from '../guards';
import { STALE_MESSAGE, isShellRequest } from './protocol';

/** What differs between the report kinds that the one page script serves. */
export interface ReportKind<Data, Action, View> {
  readonly viewType: string;
  /** Inlined with the page nonce. */
  readonly css: string;
  /** Carries the data to the page; its type selects the page. */
  readonly message: (data: Data) => unknown;
  /** Guards page requests beyond `ready`, `refresh` and `markdown`, which the extension must not trust. */
  readonly isAction?: (value: unknown) => value is Action;
  /** Guards the user's choices the page sends with Open as Markdown. */
  readonly isView?: (value: unknown) => value is View;
  /** Built from the extension's data and the view the page named (none without one). */
  readonly toMarkdown: (data: Data, view: View | undefined) => string;
}

/** A webview panel as the shell needs it; the VS Code adapter implements it. */
export interface PanelPort {
  setTitle(title: string): void;
  reveal(): void;
  post(message: unknown): void;
  dispose(): void;
  onMessage(listener: (message: unknown) => void): void;
  onDispose(listener: () => void): void;
}

export type PanelFactory = (
  kind: { readonly viewType: string; readonly css: string },
  title: string,
) => PanelPort;

export interface PanelHandlers<Data, Action> {
  /** `data` is what the page was last sent; the action is checked against it. */
  readonly onAction?: (action: Action, data: Data, key: string) => void;
  /** Without it the report shows no Refresh. */
  readonly onRefresh?: (key: string) => void;
  readonly openMarkdown: (markdown: string) => void;
  /** The user closed the panel, so whatever runs for the key can stop. */
  readonly onClose?: (key: string) => void;
}

interface Entry<Data> {
  readonly panel: PanelPort;
  data: Data;
  ready: boolean;
  /** The lake changed after `data` was read; the page says so until new data arrives. */
  stale: boolean;
  /** Counts the requests of the page (not `ready`); true for one too many. */
  readonly overLimit: () => boolean;
}

/** A page may send this many requests (Refresh, actions, Open as Markdown) per `REQUEST_WINDOW_MS`; the rest are dropped. */
export const MAX_REQUESTS_PER_WINDOW = 10;
export const REQUEST_WINDOW_MS = 1000;

/**
 * Counts the requests of one page: a page that floods the host would start a read, open an editor or a dialog for each,
 * so it gets a few per window. The returned function counts one request and says whether it is one too many.
 */
export function requestLimit(now: () => number = Date.now): () => boolean {
  let windowStart = 0;
  let requests = 0;
  return () => {
    const at = now();
    if (at - windowStart >= REQUEST_WINDOW_MS) {
      windowStart = at;
      requests = 0;
    }
    requests++;
    return requests > MAX_REQUESTS_PER_WINDOW;
  };
}

// One panel per key (connection, report kind, subject). The page sends `ready` when built, also after VS Code
// restores a hidden panel, so the data is sent again.
export class ReportPanels<Data, Action, View> {
  private readonly entries = new Map<string, Entry<Data>>();
  private readonly reads = new Map<string, AbortController>();

  constructor(
    private readonly create: PanelFactory,
    private readonly kind: ReportKind<Data, Action, View>,
    private readonly handlers: PanelHandlers<Data, Action>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs the read that fills the key's panel; resolves to `undefined` when a newer read started or the panel closed. */
  async read<T>(key: string, run: (signal: AbortSignal) => PromiseLike<T>): Promise<T | undefined> {
    this.reads.get(key)?.abort();
    const abort = new AbortController();
    this.reads.set(key, abort);
    try {
      const result = await run(abort.signal);
      return abort.signal.aborted ? undefined : result;
    } catch (error) {
      if (abort.signal.aborted) {
        return undefined;
      }
      throw error;
    } finally {
      if (this.reads.get(key) === abort) {
        this.reads.delete(key);
      }
    }
  }

  show(key: string, title: string, data: Data): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.panel.setTitle(title);
      existing.panel.reveal();
      existing.data = data;
      existing.stale = false;
      this.post(existing);
      return;
    }
    const entry: Entry<Data> = {
      panel: this.create(this.kind, title),
      data,
      ready: false,
      stale: false,
      overLimit: requestLimit(this.now),
    };
    this.entries.set(key, entry);
    entry.panel.onMessage((message) => this.receive(key, entry, message));
    entry.panel.onDispose(() => {
      this.entries.delete(key);
      this.reads.get(key)?.abort();
      this.handlers.onClose?.(key);
    });
  }

  /** Tells the page of the key that its data is out of date; it says so until `show` brings new data. */
  markStale(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.stale = true;
      if (entry.ready) {
        entry.panel.post(STALE_MESSAGE);
      }
    }
  }

  /** Replaces the key's data and posts `message` instead of the data, for pages that apply changes (a run reporting as it goes). */
  update(key: string, data: Data, message: unknown): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.data = data;
      if (entry.ready) {
        entry.panel.post(message);
      }
    }
  }

  dispose(): void {
    for (const { panel } of [...this.entries.values()]) {
      panel.dispose();
    }
  }

  private receive(key: string, entry: Entry<Data>, message: unknown): void {
    if (isShellRequest(message, this.kind.isView ?? (() => false))) {
      if (message.type === 'ready') {
        entry.ready = true;
        this.post(entry);
      } else if (entry.overLimit()) {
        return;
      } else if (message.type === 'refresh') {
        this.handlers.onRefresh?.(key);
      } else {
        this.handlers.openMarkdown(
          this.kind.toMarkdown(entry.data, own(message, 'view') as View | undefined),
        );
      }
    } else if (this.kind.isAction?.(message) && !entry.overLimit()) {
      this.handlers.onAction?.(message, entry.data, key);
    }
  }

  private post(entry: Entry<Data>): void {
    if (entry.ready) {
      entry.panel.post(this.kind.message(entry.data));
      if (entry.stale) {
        entry.panel.post(STALE_MESSAGE);
      }
    }
  }
}

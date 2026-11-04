/// <reference lib="dom" />
import type { ActionMessage, ShellRequest } from './protocol';

// Keeps the user's choices while VS Code takes a hidden panel down and restores it.
interface StateStore {
  get(): unknown;
  set(state: unknown): void;
}

/** What the script gives a page it built. */
export interface PageContext {
  readonly app: HTMLElement;
  /** The extension checks the request. */
  post(request: ShellRequest | ActionMessage): void;
  readonly state: StateStore;
  /** Refresh is pressed and the data has not arrived; the page refocuses the button when it does. */
  refreshAsked: boolean;
}

export interface Page<Data> {
  /** Shows new data; keeps the user's choices when it is the same report read again. */
  show(data: Data): void;
  /** Draws again after a theme change. */
  redraw(): void;
  resize(): void;
}

/** One report page; the first message with its `type` creates it, and `isMessage` rejects data it cannot show. */
export interface PageKind<Data> {
  readonly type: string;
  readonly isMessage: (value: unknown) => value is { readonly type: string; readonly data: Data };
  readonly create: (context: PageContext) => Page<Data>;
}

/** The container of every page; the stylesheet gives it the gutter. */
export function createApp(): HTMLElement {
  const app = document.createElement('div');
  app.className = 'app';
  return app;
}

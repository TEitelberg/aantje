import type { PanelPort } from '../../src/shell/panels';

/** A webview panel stand-in: what the extension posted, and the requests that a page would send. */
export class FakePanel implements PanelPort {
  title: string;
  revealed = 0;
  disposed = false;
  posted: unknown[] = [];
  private onMessageListener: (message: unknown) => void = () => undefined;
  private onDisposeListener: () => void = () => undefined;

  constructor(title: string) {
    this.title = title;
  }
  setTitle(title: string): void {
    this.title = title;
  }
  reveal(): void {
    this.revealed++;
  }
  post(message: unknown): void {
    this.posted.push(message);
  }
  dispose(): void {
    this.disposed = true;
    this.onDisposeListener();
  }
  onMessage(listener: (message: unknown) => void): void {
    this.onMessageListener = listener;
  }
  onDispose(listener: () => void): void {
    this.onDisposeListener = listener;
  }
  /** The page sends a request. */
  send(message: unknown): void {
    this.onMessageListener(message);
  }
  /** VS Code takes the page down while the panel is hidden and builds it again: the new page says `ready`. */
  pageReloaded(): void {
    this.send({ type: 'ready' });
  }
}

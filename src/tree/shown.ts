// aantje activates once the window has started, so that its MCP server runs. What it says at start waits until the user
// sees its view, as it did when the view activated it.

/** What a notice at start needs of the view of aantje. */
export interface ShownView {
  readonly visible: boolean;
  onDidChangeVisibility(listener: (event: { readonly visible: boolean }) => unknown): { dispose(): void };
}

/** Runs `run` once the view is visible: at once when it is, else the first time it becomes visible. */
export function whenShown(view: ShownView, run: () => void): { dispose(): void } {
  if (view.visible) {
    run();
    return { dispose: () => undefined };
  }
  const listener = view.onDidChangeVisibility(({ visible }) => {
    if (!visible) return;
    listener.dispose();
    run();
  });
  return listener;
}

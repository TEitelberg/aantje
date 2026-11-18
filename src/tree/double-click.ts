// A VS Code tree has no double-click event: it runs the command of a row on every click and on Enter (with the user's
// `workbench.list.openMode` set to `doubleClick`, only on a double-click and on Enter). A double-click is therefore
// told from two clicks by their time.

/** The longest pause between the two clicks of a double-click, about what the desktops use by default. */
export const DOUBLE_CLICK_MS = 500;

/** The clicks on the rows of a tree; a row is known by a key, its node id. */
export class DoubleClicks {
  private last: { readonly key: string; readonly at: number } | undefined;

  /** `now`: a clock in milliseconds that does not go back, such as `performance.now`. */
  constructor(private readonly now: () => number) {}

  /**
   * Records a click on the row `key`: true when it is the second click on that row within `DOUBLE_CLICK_MS`. A click on
   * another row or a later one starts over, and so does the click after a double-click.
   */
  click(key: string): boolean {
    const at = this.now();
    const elapsed = this.last?.key === key ? at - this.last.at : Number.POSITIVE_INFINITY;
    const double = elapsed >= 0 && elapsed <= DOUBLE_CLICK_MS;
    this.last = double ? undefined : { key, at };
    return double;
  }
}

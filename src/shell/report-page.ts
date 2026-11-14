/// <reference lib="dom" />
import type { Header } from './blocks';
import { chartSet } from './chart-set';
import type { ChartSet } from './chart-set';
import type { PageContext, PageKind } from './page';

/** What `reportPage` gives the builder of a page. */
export interface PageShell {
  readonly context: PageContext;
  /** The charts of the page; they resize with the window. */
  readonly charts: ChartSet;
  /** Puts the header and the blocks into the page, then refocuses Refresh if it asked for the data. */
  readonly mount: (header: Header, ...blocks: readonly HTMLElement[]) => void;
}

/** What the builder returns: how the page shows data, and how it draws again from its state after a theme change. */
interface PageParts<Data> {
  show(data: Data): void;
  /** Called only once data was shown. */
  redraw(): void;
  /** What resizes besides the charts of the set. */
  resize?(): void;
}

/**
 * A report page: the first message with its `type` creates it, and `isMessage` rejects data it cannot show. The shell
 * keeps the charts and resizes them, and redraws the page after a theme change once it shows data.
 */
export function reportPage<Data>(
  type: string,
  isMessage: PageKind<Data>['isMessage'],
  build: (shell: PageShell) => PageParts<Data>,
): PageKind<Data> {
  return {
    type,
    isMessage,
    create(context) {
      const charts = chartSet();
      let shown = false;
      const parts = build({
        context,
        charts,
        mount(header, ...blocks) {
          context.app.replaceChildren(header.element, ...blocks);
          header.settle();
        },
      });
      return {
        show(data) {
          shown = true;
          parts.show(data);
        },
        redraw() {
          if (shown) parts.redraw();
        },
        resize() {
          charts.resize();
          parts.resize?.();
        },
      };
    },
  };
}

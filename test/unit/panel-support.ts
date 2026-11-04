import { ReportPanels } from '../../src/shell/panels';
import type { PanelPort, ReportKind } from '../../src/shell/panels';

/**
 * Whether the report shell does something with a message from the page of a report: it posts the data for `ready`,
 * asks for a read for `refresh`, opens a document for `markdown` and hands an action to its handler. Anything else is
 * ignored. This is the check that production applies, composed from the shell and the kind.
 */
export function shellAccepts<Data, Action, View>(
  kind: ReportKind<Data, Action, View>,
  data: Data,
): (message: unknown) => boolean {
  return (message) => {
    let handled = false;
    let listener: (message: unknown) => void = () => undefined;
    const port: PanelPort = {
      setTitle: () => undefined,
      reveal: () => undefined,
      post: () => void (handled = true),
      dispose: () => undefined,
      onMessage: (next) => void (listener = next),
      onDispose: () => undefined,
    };
    const panels = new ReportPanels(() => port, kind, {
      onAction: () => void (handled = true),
      onRefresh: () => void (handled = true),
      openMarkdown: () => void (handled = true),
    });
    panels.show('key', 'Report', data);
    listener(message);
    return handled;
  };
}

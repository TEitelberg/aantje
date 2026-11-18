import { isObject, isString, own } from '../guards';
import { DEFAULT_VIEW } from './model';
import type { DetailsData, DetailsView } from './model';
import { isDetailsView } from './protocol';

/** The choices the page keeps across a hidden panel or a refresh: the view and the selected row. */
export interface DetailsChoices {
  readonly view: DetailsView;
  readonly selected: string | undefined;
}

/** What the page keeps for VS Code to hand back. */
export const savedState = (data: DetailsData, { view, selected }: DetailsChoices): unknown => ({
  connection: data.connection,
  view,
  ...(selected === undefined ? {} : { selected }),
});

/** The saved choices of the same connection; the defaults for foreign state or another connection. */
export function restoredChoices(saved: unknown, data: DetailsData): DetailsChoices {
  if (
    !isObject(saved) ||
    own(saved, 'connection') !== data.connection ||
    !isDetailsView(own(saved, 'view'))
  ) {
    return { view: DEFAULT_VIEW, selected: undefined };
  }
  const selected = own(saved, 'selected');
  return {
    view: own(saved, 'view') as DetailsView,
    selected: isString(selected) ? (selected as string) : undefined,
  };
}

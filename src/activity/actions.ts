import { planSnapshotAction } from '../snapshot-changes/actions';
import type { SnapshotPlan } from '../snapshot-changes/actions';
import type { ActivityData } from './model';

/** Actions of the detail pane; the page names one by id, never a command. */
export const ACTION_IDS = ['showSnapshotReport', 'showCatalog', 'rowsChanged', 'compareSnapshots'] as const;
export type ActivityActionId = (typeof ACTION_IDS)[number];

/** What a webview may ask for, after the protocol guards checked its shape. */
export interface ActivityActionRequest {
  readonly action: ActivityActionId;
  readonly snapshot?: number | undefined;
  readonly table?: number | undefined;
  readonly against?: 'previous' | 'latest' | undefined;
}

/** What a page request asks for, checked against the data the extension sent. */
export type ActivityPlan =
  | { readonly action: 'showSnapshotReport' }
  | Extract<SnapshotPlan, { readonly action: 'showCatalog' | 'rowsChanged' | 'compareSnapshots' }>;

/** The action for a request; undefined when the data does not offer it. */
export function planActivityAction(
  data: ActivityData,
  request: ActivityActionRequest,
): ActivityPlan | undefined {
  if (!ACTION_IDS.includes(request.action)) {
    return undefined;
  }
  if (request.action === 'showSnapshotReport') {
    return { action: 'showSnapshotReport' };
  }
  const plan = planSnapshotAction(data, { ...request, action: request.action });
  return plan?.action === request.action ? plan : undefined;
}

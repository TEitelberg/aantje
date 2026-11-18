/**
 * The one action of the page, which names it by id, never a command: open the Snapshot report of the connection. What
 * can be done with a single snapshot is offered there, not here.
 */
export const ACTION_IDS = ['showSnapshotReport'] as const;
export type ActivityActionId = (typeof ACTION_IDS)[number];

/** What a webview may ask for, after the protocol guards checked its shape. */
export interface ActivityActionRequest {
  readonly action: ActivityActionId;
}

/** What the extension carries out for a request. */
export interface ActivityPlan {
  readonly action: ActivityActionId;
}

/** The action for a request; undefined for one that the page does not offer. */
export function planActivityAction(request: ActivityActionRequest): ActivityPlan | undefined {
  return ACTION_IDS.includes(request.action) ? { action: request.action } : undefined;
}

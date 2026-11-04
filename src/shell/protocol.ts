import { isObject, isOptional, own } from '../guards';
import type { Test } from '../guards';

/** What a page asks besides its actions; the extension builds the Markdown itself, so page text never lands in a document. */
export type ShellRequest =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'markdown'; readonly view?: unknown };

/** A report action: the page names it by id plus the numbers it needs, never a command. */
export interface ActionMessage {
  readonly type: 'action';
  readonly action: string;
}

/** Accepts `ready`, `refresh` and `markdown` with exactly their fields; a `view` must pass `isView`. */
export function isShellRequest(value: unknown, isView: Test): value is ShellRequest {
  if (!isObject(value)) {
    return false;
  }
  const type = own(value, 'type');
  if (type === 'ready' || type === 'refresh') {
    return Object.keys(value).length === 1;
  }
  return (
    type === 'markdown' &&
    Object.keys(value).every((key) => key === 'type' || key === 'view') &&
    isOptional(isView)(own(value, 'view'))
  );
}

// Guard for a report's actions: `fields` maps each action to its fields and tests. A message must have exactly
// these fields, so a page cannot smuggle extras. Whether the numbers name something sent is the report's planning.
export function actionGuard<Id extends string>(
  fields: Readonly<Record<Id, Readonly<Record<string, Test>>>>,
): (value: unknown) => value is ActionMessage & Readonly<Record<string, unknown>> & { readonly action: Id } {
  return (value): value is ActionMessage & Readonly<Record<string, unknown>> & { readonly action: Id } => {
    if (!isObject(value) || own(value, 'type') !== 'action') {
      return false;
    }
    const action = own(value, 'action');
    if (typeof action !== 'string' || !Object.hasOwn(fields, action)) {
      return false;
    }
    const tests = fields[action as Id];
    return (
      Object.keys(value).every((key) => key === 'type' || key === 'action' || Object.hasOwn(tests, key)) &&
      Object.entries(tests).every(([name, test]) => test(own(value, name)))
    );
  };
}

/** What the extension tells a page besides its data: the lake changed after the data was read. */
export const STALE_MESSAGE = { type: 'stale' } as const;

export const isStaleMessage = (value: unknown): boolean =>
  isObject(value) && own(value, 'type') === 'stale' && Object.keys(value).length === 1;

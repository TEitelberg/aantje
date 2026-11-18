// The messages between the Templates page and the extension. The page names an action and the id of a template that
// it was sent, never a command or a text; the extension checks the id against what it sent.
import {
  isArrayOf,
  isCount,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import { TEMPLATE_SOURCES } from './search';
import type { TemplatesData } from './search';

const isCard = isShape({
  id: isString,
  name: isString,
  description: isString,
  tags: isArrayOf(isString),
  source: isOneOf(...TEMPLATE_SOURCES),
  text: isString,
  uses: isCount,
  lastUsed: isNullOr(isCount),
  created: isNullOr(isCount),
  file: isOptional(isString),
});

const isData = isShape({ logo: isString, templates: isArrayOf(isCard), notes: isArrayOf(isString) });

/** Guard for the message the extension sends to the page. */
export function isTemplatesMessage(value: unknown): value is { type: 'templates'; data: TemplatesData } {
  return isObject(value) && own(value, 'type') === 'templates' && isData(own(value, 'data'));
}

/** The actions on one template (`copy` is Duplicate), and those of the page. */
export type TemplateActionId = 'use' | 'edit' | 'copy' | 'export' | 'delete' | 'import' | 'example';

export type TemplateAction = ActionMessage & { readonly action: TemplateActionId; readonly id?: string };

const one = { id: isString };

/** Guard for what the page asks; the extension checks the id against the templates it sent. */
export const isTemplateAction = actionGuard<TemplateActionId>({
  use: one,
  edit: one,
  copy: one,
  export: one,
  delete: one,
  import: {},
  example: {},
}) as (value: unknown) => value is TemplateAction;

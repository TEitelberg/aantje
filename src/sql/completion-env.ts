// What the modules of completion share: the kinds of items, a draft of an item and the environment of one request.
import type { CallContext, CursorContext } from './context';
import type { Lookup } from './lookup';
import type { FunctionInfo, Vocabulary } from './vocabulary';

export type CompletionKind =
  | 'keyword'
  | 'function'
  | 'type'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'macro'
  | 'snapshot'
  | 'setting'
  | 'snippet'
  | 'parameter'
  | 'hint';

export interface Draft {
  readonly label: string;
  readonly kind: CompletionKind;
  readonly insertText: string;
  readonly snippet?: boolean;
  readonly detail?: string | undefined;
  readonly documentation?: string | undefined;
  readonly filterText?: string | undefined;
  /** Items of a lower group come first. */
  readonly group: number;
  /** Within a group by this, then by the label. */
  readonly rank?: number;
}

export type Quote = (name: string) => string;

export interface Env {
  readonly drafts: Draft[];
  readonly context: CursorContext;
  readonly vocabulary: Vocabulary;
  readonly lookup: Lookup;
  /** The call whose arguments the cursor is in. */
  readonly call: CallContext | undefined;
  readonly quote: Quote;
  /** Keywords in list order; one listed by an earlier group is skipped. */
  keywords(names: readonly string[], group: number): void;
  allKeywords(group: number): void;
  functions(group: number, wanted: (fn: FunctionInfo) => boolean): void;
}

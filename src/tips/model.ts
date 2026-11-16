// The performance tips of a profiled run (Statistics): what the results show in their Tips tab.

/** The kinds of tips, in the order in which the tab lists them. */
export const TIP_KINDS = ['cache', 'spill', 'sort', 'columns', 'maintenance'] as const;
export type TipKind = (typeof TIP_KINDS)[number];

/** One tip: what the profile and the catalog show, what it means, and a script where one applies. */
export interface Tip {
  readonly kind: TipKind;
  /** One sentence: what was measured. */
  readonly title: string;
  /** The facts behind it, one sentence each. */
  readonly facts: readonly string[];
  /** What the user can do. */
  readonly advice: string;
  /** A script that the tip opens unsaved, bound to the connection of the editor; aantje never runs it. */
  readonly script?: string;
}

// Control, format and separator characters of a catalog name would hide or reorder the text around them.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A name from the catalog as the text of a tip shows it. */
export const shownName = (name: string): string => name.replace(INVISIBLE, ' ');

/** `schema.table` as the text of a tip shows it. */
export const shownTable = (schema: string, table: string): string =>
  `${shownName(schema)}.${shownName(table)}`;

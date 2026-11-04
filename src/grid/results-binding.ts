/** An editor group: `group` is its identity, which outlives a change of its view column. */
export interface BindingGroup<G> {
  readonly group: G;
  readonly column: number;
  /** The documents of its text tabs. */
  readonly keys: readonly string[];
}

/** The results of one document. */
export interface BindingEntry<G> {
  readonly key: string;
  /** The group of the editor that the panel was placed for; none when no editor was found, and then nothing is bound. */
  readonly editorGroup?: G;
  /** The column of the panel; none while the panel is made and while the results are collapsed. */
  readonly column?: number;
  /** The results of another document are in front of it in its group; a file or another panel there is the user's choice. */
  readonly covered: boolean;
  readonly collapsed: boolean;
}

export interface BindingSnapshot<G> {
  readonly groups: readonly BindingGroup<G>[];
  readonly activeGroup?: G;
  /** The document whose editor became the active one since the last decision. */
  readonly activated?: string;
  readonly entries: readonly BindingEntry<G>[];
}

/**
 * `close`: no group shows the document any more. `move`: its editor sits in another group now, so the panel goes below
 * that one. `front`: its editor became active while the results of another document cover its results.
 */
export type BindingAction<G> =
  | { readonly kind: 'close'; readonly key: string }
  | { readonly kind: 'move'; readonly key: string; readonly group: G }
  | { readonly kind: 'front'; readonly key: string };

/** The group of the editor of a document: the one the panel was placed for while it still shows it, else the active one, else the first. */
function ownerOf<G>(snapshot: BindingSnapshot<G>, key: string, placedFor?: G): BindingGroup<G> | undefined {
  const showing = snapshot.groups.filter((group) => group.keys.includes(key));
  return (
    showing.find(({ group }) => group === placedFor) ??
    showing.find(({ group }) => group === snapshot.activeGroup) ??
    showing[0]
  );
}

function actionOf<G>(snapshot: BindingSnapshot<G>, entry: BindingEntry<G>): BindingAction<G> | undefined {
  const { key, editorGroup, column } = entry;
  if (editorGroup === undefined) return undefined;
  const owner = ownerOf(snapshot, key, editorGroup);
  if (!owner) return { kind: 'close', key };
  if (entry.collapsed || column === undefined) return undefined;
  if (owner.group !== editorGroup) return { kind: 'move', key, group: owner.group };
  // A panel in the group of its own editor would cover the editor.
  const front = snapshot.activated === key && entry.covered && column !== owner.column;
  return front ? { kind: 'front', key } : undefined;
}

/** What keeps each results panel with its editor after the user changed the editors or their groups. */
export function decide<G>(snapshot: BindingSnapshot<G>): BindingAction<G>[] {
  return snapshot.entries.flatMap((entry) => actionOf(snapshot, entry) ?? []);
}

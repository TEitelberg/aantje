import type { CatalogReader } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';
import type { Level } from '../files/listing';
import type { FilesPort } from '../files/source';
import { groupedPlural } from '../shell/numbers';
import { fileEntryNode, fileRootNode, messageNode } from './nodes';
import type { TreeNode } from './refs';

// The levels below the folder Files: its roots, then one level of a root or folder at a time. They come from the
// storage, not from the catalog, so they do not depend on the snapshot that the tree shows.

/** Whether the node is the folder Files or a folder below it, whose children the storage lists. */
export function listsFiles(node: TreeNode): boolean {
  const { ref } = node;
  return (ref.kind === 'folder' && ref.folder === 'files') || ref.kind === 'fileFolder';
}

// The level is not listed: the storage signs in with values that the connection has not stored yet. A click asks for
// them; the words also serve the import commands, which show them on such a folder.
const NO_SIGN_IN =
  'The connection has no sign-in values for its storage: set them with "Set Storage Sign-in...".';
const SET_SIGN_IN = { id: 'aantje.setStorageSignIn', title: 'Set Storage Sign-in...' } as const;

function omittedText({ omitted, cut }: Level): string {
  return cut
    ? `More than ${groupedPlural(omitted, 'entry', 'entries')} are not shown.`
    : `${groupedPlural(omitted, 'more entry', 'more entries')} ${omitted === 1 ? 'is' : 'are'} not shown.`;
}

/** The children of the folder Files (its roots) or of a root or folder (one level, listed by the storage). */
export async function readFiles(
  files: FilesPort,
  profile: ConnectionProfile,
  reader: CatalogReader,
  node: TreeNode,
  signal: AbortSignal,
): Promise<TreeNode[]> {
  const { ref } = node;
  if (ref.kind === 'folder' && ref.folder === 'files') {
    const { context, roots, empty } = await files.roots(profile, reader, signal);
    if (roots.length === 0) return [messageNode(node, empty ?? 'There is nothing to list.', 'info')];
    return roots.map(({ path, problem }, index) =>
      fileRootNode(node, { root: path, path, context, ...(problem === undefined ? {} : { problem }) }, index),
    );
  }
  if (ref.kind !== 'fileFolder') return [];
  const { place } = ref;
  if (place.problem !== undefined) return [messageNode(node, place.problem, 'error')];
  const level = await files.level(profile, place.context, place.root, place.path, signal);
  if (level.signInMissing) return [messageNode(node, NO_SIGN_IN, 'error', SET_SIGN_IN)];
  const children = level.entries.map((entry) => fileEntryNode(node, place, entry));
  if (level.omitted > 0 || level.cut) children.push(messageNode(node, omittedText(level), 'info'));
  return children.length > 0 ? children : [messageNode(node, 'No folders or files.', 'info')];
}

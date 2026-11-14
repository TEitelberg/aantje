import { AantjeError } from './errors';
import { withoutInvisible } from './markdown';

/** Text from the catalog for a picker or the status bar, which draw `$(name)` as an icon: the `$(` is escaped. */
export const withoutIcons = (text: string): string => text.replaceAll('$(', '\\$(');

/** Catalog text in a row of a picker: on one line, nothing that reorders it, and no `$(name)` drawn as an icon. */
export const pickerLabel = (text: string): string => withoutIcons(withoutInvisible(text));

/** The hint for a command that needs a connected catalog; `goal` completes "Connect to a catalog first to ...". */
export const connectFirstText = (goal: string): string => `Connect to a catalog first to ${goal}.`;

/** The error for an action whose connection closed meanwhile; `goal` completes "Connect again to ...". */
export const connectionClosed = (goal: string, name?: string): AantjeError =>
  new AantjeError(
    'CONNECTION_FAILED',
    `The connection${name === undefined ? '' : ` "${name}"`} is closed. Connect again to ${goal}.`,
  );

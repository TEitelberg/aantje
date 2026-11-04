import { AantjeError } from './errors';

/** Text from the catalog for a picker or the status bar, which draw `$(name)` as an icon: the `$(` is escaped. */
export const withoutIcons = (text: string): string => text.replaceAll('$(', '\\$(');

/** The hint for a command that needs a connected catalog; `goal` completes "Connect to a catalog first to ...". */
export const connectFirstText = (goal: string): string => `Connect to a catalog first to ${goal}.`;

/** The error for an action whose connection closed meanwhile; `goal` completes "Connect again to ...". */
export const connectionClosed = (goal: string): AantjeError =>
  new AantjeError('CONNECTION_FAILED', `The connection is closed. Connect again to ${goal}.`);

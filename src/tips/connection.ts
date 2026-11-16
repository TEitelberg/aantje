// The performance tips of Statistics for the connection of an editor: the catalog through the explorer's reader, a
// Parquet footer through a one-shot read-only session, never the session of the editor (its transaction is the user's).
import type { ConnectionProfile } from '../connections/profile';
import type { DataAccess } from '../data/types';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import { collectTips } from './collect';
import type { ProfileReport, TipsReader } from './collect';
import { footerRanges } from './footers';
import type { Tip } from './model';

/** How long Statistics waits for its tips before it shows the profile without them. */
export const TIPS_LIMIT_MS = 5000;

export interface TipsEnv {
  readonly store: { get(connectionId: string): ConnectionProfile | undefined };
  /** The explorer; its reader is undefined while it is not connected. */
  readonly catalogTree: { reader(connectionId: string): TipsReader | undefined };
  /** Access to the lake that never shows a sign-in. */
  readonly quietAccess: (profile: ConnectionProfile, snapshot: undefined) => Promise<DataAccess>;
}

/** The tips function of the profiler for a connection. A failure is logged and gives no tips. */
export function performanceTips(
  env: TipsEnv,
  logger: Logger,
): (connectionId: string) => (report: ProfileReport) => Promise<readonly Tip[]> {
  return (connectionId) => async (report) => {
    const profile = env.store.get(connectionId);
    const reader = env.catalogTree.reader(connectionId);
    try {
      return await collectTips(
        {
          ...(reader ? { reader } : {}),
          // A Quack server reads the data itself; there is no footer to read here.
          ...(profile && profile.kind !== 'quack'
            ? { rowGroups: footerRanges(() => env.quietAccess(profile, undefined)) }
            : {}),
        },
        report,
        AbortSignal.timeout(TIPS_LIMIT_MS),
      );
    } catch (error) {
      logger.warn(`The performance tips of Statistics could not be read: ${userMessageOf(error)}`);
      return [];
    }
  };
}

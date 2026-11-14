import type { ConnectionProfile } from '../connections/profile';
import { AantjeError } from '../errors';
import { targetOf, trustKey } from './trust';
import type { ViewTrustStore } from './trust';

/** The question to the user, shown as a modal dialog with one button. */
export interface TrustRequest {
  readonly message: string;
  readonly detail: string;
  readonly accept: string;
}

interface ViewConfirmationDeps {
  readonly trust: Pick<ViewTrustStore, 'isTrusted' | 'trust'>;
  /** Resolves to whether the user accepted; closing the dialog declines. */
  ask(request: TrustRequest): Promise<boolean>;
}

/**
 * Asks once per connection (again after its target changed) before a view is resolved, throws `ABORTED` on decline;
 * concurrent views share one question.
 */
export function viewConfirmation(deps: ViewConfirmationDeps): (profile: ConnectionProfile) => Promise<void> {
  const pending = new Map<string, Promise<void>>();

  const decide = async (profile: ConnectionProfile): Promise<void> => {
    const accepted = await deps.ask({
      message: `A view runs the SQL that is stored in the catalog of "${profile.name}", with your rights on this machine: it can read files and use the network. aantje refuses a view that calls the maintenance functions of DuckLake when it shows the rows, resolves the columns or creates a notebook, but this is no sandbox, and a view that SQL of yours touches in the SQL editor is not checked. Resolve views only for catalogs that you trust.`,
      detail: `Catalog: ${targetOf(profile)}\nYou are asked again when the connection points to another place.`,
      accept: 'Trust and Resolve Views',
    });
    if (!accepted) {
      throw new AantjeError(
        'ABORTED',
        `You did not trust the connection "${profile.name}", so its views are not resolved.`,
      );
    }
    await deps.trust.trust(profile);
  };

  return (profile) => {
    if (deps.trust.isTrusted(profile)) {
      return Promise.resolve();
    }
    const key = trustKey(profile);
    let question = pending.get(key);
    if (!question) {
      question = decide(profile).finally(() => pending.delete(key));
      pending.set(key, question);
    }
    return question;
  };
}

/** What `readTrusting` asks: the trust the user gave, and the question that records it or throws `ABORTED`. */
export interface TrustGate {
  readonly viewsTrusted: (profile: ConnectionProfile) => boolean;
  readonly confirmViews: (profile: ConnectionProfile) => Promise<void>;
}

/**
 * Runs a read with the current trust. When the guard refuses an untrusted view that it finds at the snapshot, asks once
 * and reads again trusted. This covers a table node that is a view at an older snapshot, and the snapshot report,
 * which never passes a tree node. A decline is the `ABORTED` error of the question, and nothing is read again.
 */
export async function readTrusting<T>(
  profile: ConnectionProfile,
  gate: TrustGate,
  read: (trusted: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await read(gate.viewsTrusted(profile));
  } catch (error) {
    if (!(error instanceof AantjeError) || error.code !== 'VIEW_UNTRUSTED') {
      throw error;
    }
    await gate.confirmViews(profile);
    return await read(true);
  }
}

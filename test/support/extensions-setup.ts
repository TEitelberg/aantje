import { engineSkipReason } from '../unit/data-support';

/**
 * Installs the DuckDB extensions of the engine tests once, before the workers start. Parallel workers that install
 * into an empty cache directory at the same time fail on Windows ("Could not move file"). Offline the tests skip
 * themselves with a visible reason; with `AANTJE_REQUIRE_ENGINE=1` this throws and stops the run.
 */
export async function setup(): Promise<void> {
  await engineSkipReason();
}

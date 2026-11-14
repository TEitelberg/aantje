import { withLakeSession } from '../data/lake-session';
import { runCatalogGroup } from './catalog-run';
import { checkConnection, connectionFacts, reportSetupFailure, startConnectionGroup } from './connection-run';
import type { ConnectionFacts } from './connection-checks';
import { runDeepGroup } from './deep-run';
import { compareFindings, HEALTH_GROUPS } from './model';
import type { GroupStatus, HealthReport, HealthRequest, HealthSummary } from './model';
import { failureMessageOf } from '../data/lake-session';
import { createRunContext } from './run-context';
import type { CatalogOutcome, HealthDeps, HealthRun, RunContext } from './run-context';
import { runStorageGroup } from './storage-run';

export type { HealthDeps, HealthRun } from './run-context';

/** Runs the checks of `request`; never rejects. A failed check fails its group, a cancel skips unfinished ones. */
export async function runHealthCheck(
  deps: HealthDeps,
  request: HealthRequest,
  run: HealthRun = {},
): Promise<HealthReport> {
  const started = performance.now();
  const ctx = createRunContext(deps, request, run);
  const catalog = await runCatalogGroup(ctx);
  const note = await runLakeGroups(ctx, catalog);
  ctx.state.skipUnfinished(ctx.cancelled() ? 'Cancelled.' : (note ?? 'Not run.'));
  return finish(ctx, catalog, started);
}

// Connection, storage and deep share one engine session. Returns why skipped groups did not run.
async function runLakeGroups(ctx: RunContext, catalog: CatalogOutcome): Promise<string | undefined> {
  const { state } = ctx;
  const facts = connectionFacts(ctx, catalog);
  if (!ctx.cancelled()) await startConnectionGroup(ctx, catalog, facts);
  const catalogNote = catalog.error === undefined ? undefined : 'The catalog database cannot be read.';
  if (ctx.cancelled()) return catalogNote;
  if (catalog.latest === undefined) {
    if (!state.finished('connection')) state.setGroup({ group: 'connection', state: 'done' });
    return catalogNote;
  }
  return (await inSession(ctx, catalog, facts)) ?? catalogNote;
}

// The three engine groups; the note says why they did not all run.
async function inSession(
  ctx: RunContext,
  catalog: CatalogOutcome,
  facts: ConnectionFacts,
): Promise<string | undefined> {
  let note: string | undefined;
  try {
    await withLakeSession(ctx.deps.access, ctx.signal, async (session) => {
      note = await checkConnection(ctx, facts, session);
      if (note !== undefined) return;
      await runStorageGroup(ctx, catalog, session);
      await runDeepGroup(ctx, catalog, session);
    });
  } catch (error) {
    if (!ctx.cancelled()) note = sessionFailed(ctx, error);
  }
  return note;
}

// Before the connection group ends an engine failure is a setup problem; afterwards the later groups fail.
function sessionFailed(ctx: RunContext, error: unknown): string | undefined {
  const { state } = ctx;
  if (!state.finished('connection')) return reportSetupFailure(ctx, error);
  for (const group of ['storage', 'deep'] as const) {
    if (!state.finished(group)) state.setGroup({ group, state: 'failed', message: failureMessageOf(error) });
  }
  return undefined;
}

function finish(ctx: RunContext, catalog: CatalogOutcome, started: number): HealthReport {
  const { state } = ctx;
  const findings = state.findings.toSorted(compareFindings);
  const groups = HEALTH_GROUPS.map(
    (group): GroupStatus => state.statuses.get(group) ?? { group, state: 'skipped', reason: 'Not run.' },
  );
  const summary: HealthSummary = {
    errors: findings.filter((item) => item.severity === 'error').length,
    warnings: findings.filter((item) => item.severity === 'warning').length,
    infos: findings.filter((item) => item.severity === 'info').length,
    omitted: groups.reduce((sum, group) => sum + (group.omitted ?? 0), 0),
    elapsedMs: Math.round(performance.now() - started),
    cancelled: ctx.cancelled(),
  };
  state.emit({ type: 'summary', summary });
  state.close();
  return {
    request: ctx.request,
    ...(catalog.latest === undefined ? {} : { snapshot: catalog.latest }),
    groups,
    findings,
    summary,
  };
}

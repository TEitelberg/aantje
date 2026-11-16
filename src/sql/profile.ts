import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteLiteral } from '../catalog/ddl';
import type { GridValue } from '../data/types';
import type { ProfileReport } from '../tips/collect';
import type { Tip } from '../tips/model';
import type { RunAround } from './editor';
import type { SqlEvent } from './session';

// The settings that Statistics changes and puts back.
const SETTINGS = ['enable_profiling', 'profiling_output', 'profiling_coverage'] as const;

export interface ProfilerOptions {
  /**
   * The performance tips of a profile (in the profile event) or of an analysed plan (a `tips` event after it). A
   * failure gives none: the profile or plan still shows. The memory limit is the session's, read before the run.
   */
  readonly tips?: (report: ProfileReport) => Promise<readonly Tip[]>;
}

// The tips of a profile or an analysed plan; none without the option or after a failure.
const tipsOf = (
  options: ProfilerOptions,
  json: string,
  memoryLimit: string | undefined,
): Promise<readonly Tip[]> =>
  options.tips
    ? options.tips({ json, ...(memoryLimit ? { memoryLimit } : {}) }).catch(() => [])
    : Promise.resolve([]);

/** The plan of `EXPLAIN (ANALYZE, FORMAT JSON)` in a result set, which has the figures of the JSON profiler. */
function analyzedPlanOf(event: SqlEvent): string | undefined {
  if (event.kind !== 'resultSet') return undefined;
  const [key, value] = event.rows[0] ?? [];
  const named = event.columns.map(({ name }) => name).join(',') === 'explain_key,explain_value';
  return named && key === 'analyzed_plan' && typeof value === 'string' ? value : undefined;
}

/**
 * Analysis: `EXPLAIN (ANALYZE, FORMAT JSON)` runs as it is. Before it the memory limit of the session is read, after it
 * the performance tips of the plan that DuckDB returned follow as a `tips` event. No setting changes.
 */
export function analysis(options: ProfilerOptions): RunAround {
  let memoryLimit: string | undefined;
  let plan: { readonly index: number; readonly json: string } | undefined;
  return {
    async before(run) {
      // Only for the tip about spilling: a session that cannot answer (an aborted transaction) still runs Analysis.
      const rows = await run(`SELECT current_setting('memory_limit')`).catch(() => []);
      const limit = rows[0]?.[0];
      memoryLimit = typeof limit === 'string' ? limit : undefined;
    },
    event(event) {
      const json = analyzedPlanOf(event);
      if (json !== undefined) plan = { index: event.index, json };
      return event;
    },
    restore: () => Promise.resolve(true),
    async report(): Promise<SqlEvent[]> {
      if (!plan) return [];
      const tips = await tipsOf(options, plan.json, memoryLimit);
      return tips.length > 0 ? [{ kind: 'tips', index: plan.index, tips }] : [];
    },
    dispose: () => Promise.resolve(),
  };
}

/**
 * Statistics: one run of a statement with DuckDB's profiler. Before it, the session's profiler settings are saved and the
 * profiler writes JSON into a new temporary file; after it they are put back and the profile goes to the results of the
 * statement as a `profile` event, which draws the table, the charts and Text Statistics from it. No profile is shown
 * when the statement wrote none, because it failed or was cancelled.
 */
export function profiler(options: ProfilerOptions = {}): RunAround {
  let folder: string | undefined;
  let saved: readonly GridValue[] | undefined;
  let memoryLimit: string | undefined;
  const file = (): string => join(folder ?? '', 'profile.json');

  return {
    async before(run) {
      // The memory limit is only read, for the tip about spilling; it is not changed.
      const rows = await run(
        `SELECT ${[...SETTINGS, 'memory_limit'].map((name) => `current_setting(${quoteLiteral(name)})`).join(', ')}`,
      );
      const values = rows[0] ?? [];
      saved = values.slice(0, SETTINGS.length);
      const limit = values[SETTINGS.length];
      memoryLimit = typeof limit === 'string' ? limit : undefined;
      folder = await mkdtemp(join(tmpdir(), 'aantje-profile-'));
      // DuckDB takes a .json output file only once the profiler writes JSON. Coverage ALL comes last, so that only the
      // statement itself is profiled, also when it writes.
      await run(
        [
          `SET enable_profiling = 'json'`,
          `SET profiling_output = ${quoteLiteral(file().replaceAll('\\', '/'))}`,
          `SET profiling_coverage = 'ALL'`,
        ].join(';\n'),
      );
      // Coverage ALL profiles that SET too; the file must hold the statement's profile or nothing.
      await rm(file(), { force: true });
    },

    async restore(run) {
      if (!saved) return true;
      const [enable, output, coverage] = saved.map((value) => (value === null ? undefined : String(value)));
      const put = (name: string, value: string | undefined): string =>
        value === undefined ? `RESET ${name}` : `SET ${name} = ${quoteLiteral(value)}`;
      // The output file must suit the profiler's type when it is set: a profiler that was on gets its type first; one
      // that was off gets its file while JSON is still on, then goes off.
      const statements = [
        put('profiling_coverage', coverage),
        ...(enable === undefined
          ? [put('profiling_output', output), put('enable_profiling', enable)]
          : [put('enable_profiling', enable), put('profiling_output', output)]),
      ];
      try {
        await run(statements.join(';\n'));
      } catch {
        return false;
      }
      saved = undefined;
      return true;
    },

    async report() {
      if (!folder) return [];
      let text: string;
      try {
        text = await readFile(file(), 'utf8');
      } catch {
        return [];
      }
      // The results page reads the JSON; a broken one shows as DuckDB wrote it. The tips come with the profile, so that
      // its tabs come in their order at once.
      const tips = await tipsOf(options, text, memoryLimit);
      return [{ kind: 'profile', index: 0, json: text, ...(tips.length > 0 ? { tips } : {}) }];
    },

    async dispose() {
      if (folder) await rm(folder, { recursive: true, force: true });
      folder = undefined;
    },
  };
}

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteLiteral } from '../catalog/ddl';
import type { GridValue } from '../data/types';
import type { RunAround } from './editor';

// The settings that Statistics changes and puts back.
const SETTINGS = ['enable_profiling', 'profiling_output', 'profiling_coverage'] as const;

/**
 * Statistics: one run of a statement with DuckDB's profiler. Before it, the session's profiler settings are saved and the
 * profiler writes JSON into a new temporary file; after it they are put back and the profile goes to the results of the
 * statement as a `profile` event, which draws the table, the charts and Text Statistics from it. No profile is shown
 * when the statement wrote none, because it failed or was cancelled.
 */
export function profiler(): RunAround {
  let folder: string | undefined;
  let saved: readonly GridValue[] | undefined;
  const file = (): string => join(folder ?? '', 'profile.json');

  return {
    async before(run) {
      const rows = await run(
        `SELECT ${SETTINGS.map((name) => `current_setting(${quoteLiteral(name)})`).join(', ')}`,
      );
      saved = rows[0] ?? [];
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
      // The results page reads the JSON; a broken one shows as DuckDB wrote it.
      return [{ kind: 'profile', index: 0, json: text }];
    },

    async dispose() {
      if (folder) await rm(folder, { recursive: true, force: true });
      folder = undefined;
    },
  };
}

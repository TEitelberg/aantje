// The script of a suggested partitioning: a dry run that only reads, then the partitioning and the rewrite of the
// rows the table has, commented out like the destructive Maintenance scripts. Names are quoted identifiers; a statement
// that is a comment is commented line by line, so a line break in a name cannot end the comment.
import { LAKE } from '../data/attach';
import { commented } from '../ddl-script/check';
import { keyExpression, relation } from './measure';
import type { Candidate, PartitionTable } from './model';

/** The script of a candidate; nothing runs when the document opens. */
export function partitionScript(table: PartitionTable, candidate: Candidate, replaces: boolean): string {
  const name = relation(table.schema, table.name);
  const keys = candidate.keys.join(', ');
  const dryRun = candidate.keys.map((key, at) => `${keyExpression(key)} AS key_${at + 1}`);
  return [
    '-- Partitioning suggested by aantje. Nothing ran when this document opened.',
    '-- DuckLake applies a new partitioning to what it writes from then on: step 3 writes the rows that are there again.',
    ...(replaces ? ['-- The new partitioning replaces the one the table has.'] : []),
    '',
    '-- 1. Dry run: the partitions the new keys give, the largest first. It only reads.',
    ...(candidate.keys.some((key) => key.startsWith('bucket('))
      ? [
          '--    A bucket is counted with hash() % n here; DuckLake spreads the values as evenly, into other buckets.',
        ]
      : []),
    `SELECT ${dryRun.join(', ')}, count(*) AS row_count`,
    `FROM ${name}`,
    'GROUP BY ALL',
    'ORDER BY row_count DESC;',
    '',
    '-- 2. The partitioning, for what is written from now on. Remove the "-- " in front of it to run it.',
    commented(`ALTER TABLE ${name} SET PARTITIONED BY (${keys});`),
    '',
    '-- 3. The rows the table has, written again under the new partitioning, in one transaction. Remove the "-- " to run it.',
    '--    The INSERT reads the snapshot the transaction starts from, so it writes back exactly the rows the DELETE removes.',
    '--    The files they are in now stay until Expire Snapshots and Clean Up Old Files remove them.',
    commented('BEGIN TRANSACTION;'),
    commented(`SET VARIABLE aantje_snapshot = (SELECT id FROM ${LAKE}.current_snapshot());`),
    commented(`DELETE FROM ${name};`),
    commented(`INSERT INTO ${name} SELECT * FROM ${name} AT (VERSION => getvariable('aantje_snapshot'));`),
    commented('COMMIT;'),
    commented('RESET VARIABLE aantje_snapshot;'),
    '',
  ].join('\n');
}

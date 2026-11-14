import type { MetadataEntry } from '../catalog/model';
import { quoteLiteral } from '../catalog/ddl';
import { LAKE } from '../data/attach';
import { capFindings, finding, qualified, tableScope } from './finding';
import type { TableNames } from './finding';
import type { HealthFinding, HealthScope } from './model';

/** The facts of the check: the metadata rows, the schemas and tables of the newest snapshot, and the scope of the run. */
interface AutoCompactFacts {
  readonly metadata: readonly MetadataEntry[];
  readonly schemas: ReadonlyMap<number, string>;
  readonly tables: TableNames;
  readonly scope: HealthScope;
  readonly limit: number;
}

interface Off {
  readonly object: string;
  readonly finding: Pick<HealthFinding, 'scope' | 'title' | 'detail' | 'fixSql'>;
}

const SKIPPED =
  'ducklake_merge_adjacent_files, ducklake_rewrite_data_files, ducklake_flush_inlined_data and CHECKPOINT skip';

const setTrue = (target: string): string =>
  `CALL ducklake_set_option('${LAKE}', 'auto_compact', true${target});`;

const isOff = (entry: MetadataEntry): boolean =>
  entry.key === 'auto_compact' && entry.value.toLowerCase() === 'false';

const lakeOff = (): Off => ({
  object: 'lake',
  finding: {
    scope: { kind: 'lake' },
    title: 'auto_compact is off for the whole lake',
    detail: `${SKIPPED} every table that does not set auto_compact to true itself, even when it is named, and ducklake_delete_orphaned_files does nothing.`,
    fixSql: setTrue(''),
  },
});

const schemaOff = (id: number, name: string): Off => ({
  object: `schema:${id}`,
  finding: {
    scope: { kind: 'schema', id, name },
    title: `auto_compact is off for the schema ${name}`,
    detail: `${SKIPPED} the tables of the schema ${name} that do not set auto_compact to true themselves, even when they are named.`,
    fixSql: setTrue(`, schema => ${quoteLiteral(name)}`),
  },
});

function tableOff(id: number, names: TableNames): Off {
  const scope = tableScope(id, names);
  const { schema, name } = scope.kind === 'table' ? scope : { schema: '', name: '' };
  return {
    object: `table:${id}`,
    finding: {
      scope,
      title: 'auto_compact is off for the table',
      detail: `${SKIPPED} ${qualified(scope)}, even when it is named.`,
      fixSql: setTrue(`, schema => ${quoteLiteral(schema)}, table_name => ${quoteLiteral(name)}`),
    },
  };
}

// The schema that covers the scope: the schema itself, or the schema of the table.
function coveringSchema(facts: AutoCompactFacts): string | undefined {
  const { scope, schemas, tables } = facts;
  if (scope.kind === 'schema') return schemas.get(scope.schemaId);
  return scope.kind === 'table' ? tables.get(scope.tableId)?.schema : undefined;
}

// A narrower scope keeps what covers it: the lake, its schema, and its table or the tables of its schema.
function offLevels(facts: AutoCompactFacts): Off[] {
  const { tables, schemas, scope } = facts;
  const covering = coveringSchema(facts);
  const inScope = (id: number): boolean =>
    scope.kind === 'lake' ||
    (scope.kind === 'table' ? scope.tableId === id : tables.get(id)?.schema === covering);
  const result: Off[] = [];
  for (const entry of facts.metadata.filter(isOff)) {
    const id = entry.scopeId;
    if (entry.scope === null) {
      result.push(lakeOff());
    } else if (entry.scope === 'schema' && id !== null && schemas.has(id)) {
      const name = schemas.get(id) ?? '';
      if (scope.kind === 'lake' || covering === name) result.push(schemaOff(id, name));
    } else if (entry.scope === 'table' && id !== null && tables.has(id) && inScope(id)) {
      result.push(tableOff(id, tables));
    }
  }
  return result;
}

export function autoCompactFindings(facts: AutoCompactFacts): { findings: HealthFinding[]; omitted: number } {
  const { shown, omitted } = capFindings(offLevels(facts), facts.limit);
  return {
    findings: shown.map(({ object, finding: found }) =>
      finding('catalog.auto-compact-off', {
        severity: 'info',
        fixStep: 'option',
        object,
        ...found,
        cause:
          'An option of the lake, the schema or the table was set to false (set_option, ALTER TABLE ... SET, or a writer).',
        fix: 'Set the option back to true with the script below, or leave it when the maintenance of these tables is meant to be off.',
        inspectSql: `SELECT * FROM ducklake_options('${LAKE}') WHERE option_name = 'auto_compact';`,
      }),
    ),
    omitted,
  };
}

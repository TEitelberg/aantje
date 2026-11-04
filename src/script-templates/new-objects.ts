import { qualifiedName } from '../catalog/ddl';
import type { SchemaInfo } from '../catalog/model';
import { commented } from '../script';
import { byName } from '../tree/model';
import { blocks, dropColumnStatement, dropStatement } from './common';

export function schemaBlock(): string[] {
  const name = qualifiedName('new_schema');
  return [
    '-- A schema',
    `CREATE SCHEMA ${name};`,
    '-- Drop it',
    commented(dropStatement('SCHEMA', 'new_schema')),
  ];
}

export function tableBlock(schemaName: string): string[] {
  const name = qualifiedName(schemaName, 'new_table');
  return [
    '-- A table',
    `CREATE TABLE ${name} (`,
    '  "id" BIGINT,',
    '  "name" VARCHAR',
    ');',
    '-- Drop it',
    commented(dropStatement('TABLE', schemaName, 'new_table')),
  ];
}

export function viewBlock(schemaName: string): string[] {
  const name = qualifiedName(schemaName, 'new_view');
  return [
    '-- A view',
    `CREATE VIEW ${name} AS SELECT 1 AS id, 'example' AS name;`,
    '-- Drop it',
    commented(dropStatement('VIEW', schemaName, 'new_view')),
  ];
}

/** Plain `CREATE`, so the script never replaces an existing macro. */
export function scalarMacroBlock(schemaName: string): string[] {
  const scalar = qualifiedName(schemaName, 'add_one');
  return [
    '-- A scalar macro: an expression with parameters',
    `CREATE MACRO ${scalar}(x) AS x + 1;`,
    '-- Call it',
    commented(`SELECT ${scalar}(1);`),
    '-- Drop it',
    commented(`DROP MACRO ${scalar};`),
  ];
}

export function tableMacroBlock(schemaName: string): string[] {
  const table = qualifiedName(schemaName, 'first_rows');
  return [
    '-- A table macro: a query, used like a table. The parameter has a default.',
    `CREATE MACRO ${table}(n := 10) AS TABLE SELECT 42 AS answer FROM range(n);`,
    '-- Call it',
    commented(`SELECT * FROM ${table}(3);`),
    '-- Drop it',
    commented(`DROP MACRO TABLE ${table};`),
  ];
}

/** Template of **Script as CREATE** on a Macros folder; the schema name appears only inside quotes. */
export function macroTemplate(schemaName: string): string {
  return blocks([
    [
      '-- Two examples of a macro in this schema. They run as they are in a read/write SQL session; replace them with your own.',
      '-- A macro is a named SQL expression or query. DuckLake stores no Python or compiled functions.',
      '-- CREATE MACRO fails when the schema has a macro of that name; the script of an existing macro uses CREATE OR REPLACE.',
    ],
    scalarMacroBlock(schemaName),
    tableMacroBlock(schemaName),
  ]);
}

export function columnBlock(schemaName: string, tableName: string): string[] {
  const table = qualifiedName(schemaName, tableName);
  return [
    '-- A column',
    `ALTER TABLE ${table} ADD COLUMN "new_column" VARCHAR;`,
    '-- Drop it',
    commented(dropColumnStatement(schemaName, tableName, ['new_column'])),
  ];
}

/** `main` if present, else the first schema by name, else `new_schema`. */
export function defaultSchema(schemas: readonly SchemaInfo[]): string {
  const names = schemas.toSorted(byName).map(({ name }) => name);
  return names.includes('main') ? 'main' : (names[0] ?? 'new_schema');
}

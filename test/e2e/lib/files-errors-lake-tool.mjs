// Not imported by a spec: the files-errors spec copies this program into the code-server container and runs it there
// with the Node of code-server. It plays the other applications that touch a catalog file: a script that edits it, a
// notebook that has it open for writing, a SQLite writer in WAL mode. Python is not in that container, so the tools
// are Node: node:sqlite for SQLite and the bundled @duckdb/node-api beside the installed extension for DuckDB.
//
//   node lake-tool.mjs sqlite <file> <sql>          run SQL on a SQLite file and close it
//   node lake-tool.mjs duckdb <file> <sql>          run SQL on a DuckDB file (read-write) and close it
//   node lake-tool.mjs duckdb-open <file> rw|ro     open a DuckDB file, print "opened" or the error of DuckDB
//   node lake-tool.mjs hold-duckdb <file> <ready>   open a DuckDB file read-write and keep it open until SIGTERM
//   node lake-tool.mjs hold-wal <file> <ready>      commit to a SQLite file in WAL mode, leave the log un-checkpointed
//                                                   and keep the file open until SIGTERM (then the log is checkpointed)
// The ready file is created once the file is open, so that the spec knows when the other application is "running".
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readdirSync, writeFileSync } from 'node:fs';
import { setInterval } from 'node:timers';

const [mode, file, argument] = process.argv.slice(2);

function duckdb() {
  const root = '/home/coder/extensions';
  const extension = readdirSync(root).find((name) => name.startsWith('teitelberg.aantje-'));
  return createRequire(`${root}/${extension}/`)('./duckdb-api.cjs');
}

async function holdUntilTerminated(ready, release) {
  process.once('SIGTERM', () => {
    release();
    process.exit(0);
  });
  writeFileSync(ready, String(process.pid));
  await new Promise(() => setInterval(() => undefined, 1_000));
}

if (mode === 'sqlite') {
  const db = new DatabaseSync(file);
  db.exec(argument);
  db.close();
} else if (mode === 'duckdb') {
  const instance = await duckdb().DuckDBInstance.create(file);
  const connection = await instance.connect();
  await connection.run(argument);
  connection.closeSync();
  instance.closeSync();
} else if (mode === 'duckdb-open') {
  try {
    const instance = await duckdb().DuckDBInstance.create(file, {
      access_mode: argument === 'ro' ? 'READ_ONLY' : 'READ_WRITE',
    });
    const connection = await instance.connect();
    await connection.run('SELECT 1');
    connection.closeSync();
    instance.closeSync();
    console.log('opened');
  } catch (error) {
    console.log(error.message);
  }
} else if (mode === 'hold-duckdb') {
  const instance = await duckdb().DuckDBInstance.create(file);
  await holdUntilTerminated(argument, () => instance.closeSync());
} else if (mode === 'hold-wal') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  db.exec("INSERT INTO ducklake_metadata (key, value) VALUES ('e2e-writer', 'open')");
  await holdUntilTerminated(argument, () => db.close());
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

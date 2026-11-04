// Not imported by a spec: the data-features spec copies this program into the code-server container and runs it there
// with the Node of code-server (Python is not in that container). It uses the DuckDB of the installed extension, the
// same engine and version that aantje reads table data with.
//
//   node data-features-tool.mjs prefetch                download the DuckDB extensions ducklake, sqlite and httpfs
//   node data-features-tool.mjs sqlite <file> <sql>      run SQL on a SQLite file and close it
//   node data-features-tool.mjs ducklake <catalog> <sql>...  run SQL on a DuckLake with SQLite metadata, read-write (a new snapshot)
//   node data-features-tool.mjs s3-lake                  create a DuckLake whose data is in an S3 bucket
//
// s3-lake reads its parameters from the environment: TOOL_S3_ENDPOINT (host:port, plain HTTP), TOOL_S3_REGION,
// TOOL_S3_KEY_ID, TOOL_S3_SECRET, TOOL_S3_BUCKET and TOOL_CATALOG (the SQLite file for the metadata). The data path is
// s3://<bucket>/ducklake/. The tables are small and DATA_INLINING_ROW_LIMIT 0 makes DuckLake write Parquet files, so a
// read of the rows has to go to the S3 server.
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);

function duckdb() {
  const root = '/home/coder/extensions';
  const extension = readdirSync(root).find((name) => name.startsWith('teitelberg.aantje-'));
  return createRequire(`${root}/${extension}/`)('./duckdb-api.cjs');
}

const literal = (text) => `'${text.replaceAll("'", "''")}'`;

async function withConnection(run) {
  const instance = await duckdb().DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await run(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

if (mode === 'prefetch') {
  await withConnection(async (connection) => {
    for (const extension of ['ducklake', 'sqlite', 'httpfs']) {
      await connection.run(`INSTALL ${extension}`);
      await connection.run(`LOAD ${extension}`);
      console.log(`${extension} loaded`);
    }
  });
} else if (mode === 'sqlite') {
  const [file, sql] = rest;
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
} else if (mode === 'ducklake') {
  const [catalog, ...statements] = rest;
  await withConnection(async (connection) => {
    for (const sql of ['INSTALL ducklake', 'LOAD ducklake', 'INSTALL sqlite', 'LOAD sqlite']) {
      await connection.run(sql);
    }
    await connection.run(
      `ATTACH ${literal(`ducklake:sqlite:${catalog}`)} AS lake (DATA_INLINING_ROW_LIMIT 0)`,
    );
    for (const sql of statements) {
      await connection.run(sql);
    }
    await connection.run('DETACH lake');
  });
} else if (mode === 's3-lake') {
  const env = process.env;
  await withConnection(async (connection) => {
    const statements = [
      ...['ducklake', 'sqlite', 'httpfs'].flatMap((extension) => [
        `INSTALL ${extension}`,
        `LOAD ${extension}`,
      ]),
      `CREATE SECRET (TYPE s3, KEY_ID ${literal(env.TOOL_S3_KEY_ID)}, SECRET ${literal(env.TOOL_S3_SECRET)}, REGION ${literal(env.TOOL_S3_REGION)}, ENDPOINT ${literal(env.TOOL_S3_ENDPOINT)}, URL_STYLE 'path', USE_SSL false)`,
      `ATTACH ${literal(`ducklake:sqlite:${env.TOOL_CATALOG}`)} AS lake (DATA_PATH ${literal(`s3://${env.TOOL_S3_BUCKET}/ducklake/`)}, DATA_INLINING_ROW_LIMIT 0)`,
      'CREATE SCHEMA lake.shop',
      'CREATE TABLE lake.shop.items (id INTEGER NOT NULL, label VARCHAR, price DECIMAL(10,2))',
      "INSERT INTO lake.shop.items VALUES (1, 'apple', 0.50), (2, 'pear', 0.75), (3, NULL, 1.20)",
      'DETACH lake',
    ];
    for (const sql of statements) {
      await connection.run(sql);
    }
    console.log('lake created');
  });
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

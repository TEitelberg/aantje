import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { URL, fileURLToPath } from 'node:url';

/** The file name of the bundled API beside the installed extension. */
export const DUCKDB_API = 'duckdb-api.cjs';

const BUNDLE = new URL('../out/duckdb-api.cjs', import.meta.url);

/**
 * Bundles the JavaScript API of DuckDB for the helper programs that run in the container (the extension carries its
 * own copy inside `dist/extension.js`). Runs on the host before the runner starts: `esbuild` is not in the runner.
 */
export async function buildDuckdbApi() {
  const { buildSync } = await import('esbuild');
  buildSync({
    entryPoints: [createRequire(import.meta.url).resolve('@duckdb/node-api')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    minify: true,
    external: ['@duckdb/node-bindings*'],
    outfile: fileURLToPath(BUNDLE),
    logLevel: 'silent',
  });
}

/**
 * Puts the bundle next to the installed extension, where it finds the native binding in `node_modules`. The control
 * API takes the content as one command line argument, which is limited to 128 KB, so the bundle travels compressed.
 */
export async function installDuckdbApi(server) {
  const { dir } = await server.installedExtension('teitelberg.aantje');
  const encoded = gzipSync(readFileSync(BUNDLE)).toString('base64');
  const { code, stderr } = await server.exec(
    `printf %s '${encoded}' | base64 -d | gunzip > '${dir}/${DUCKDB_API}'`,
  );
  if (code !== 0) {
    throw new Error(`Cannot install the DuckDB API: ${stderr.trim()}`);
  }
}

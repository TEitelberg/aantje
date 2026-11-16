// Bundles the extension into dist/extension.js. Everything is bundled except the `vscode` API and the
// native DuckDB bindings, which ship as regular node_modules inside the (platform specific) VSIX.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { writeNotices } from './scripts/notices.mjs';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });
// sql.js loads its WebAssembly binary from disk; the SQLite driver reads it from dist/.
copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), 'dist/sql-wasm.wasm');
// The certificate authorities of Amazon RDS, for the TLS check of a PostgreSQL catalog on RDS.
copyFileSync('deploy/aws/rds-ca-bundle.pem', 'dist/rds-ca-bundle.pem');

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  minify: !watch,
  external: ['vscode', '@duckdb/node-bindings*', 'pg-native'],
  // The CloudFormation template of the AWS lake goes into the bundle as text.
  loader: { '.yaml': 'text' },
  logLevel: 'info',
};

// The script of the data grid webview. It bundles only our own code, so it adds nothing to the notices.
const gridClientOptions = {
  entryPoints: ['src/grid/client.ts'],
  outfile: 'dist/grid-client.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  logLevel: 'info',
};

// The script of all report pages (statistics, snapshot report, properties). It bundles ECharts and zrender, whose licences go into the notices.
const reportClientOptions = {
  ...gridClientOptions,
  entryPoints: ['src/shell/client.ts'],
  outfile: 'dist/report-client.js',
  sourcemap: true,
};

// The plans of the results page (Explain, Analysis), apart from grid-client.js: ECharts writes its tooltips as markup.
const planClientOptions = {
  ...gridClientOptions,
  entryPoints: ['src/grid/plan-client.ts'],
  outfile: 'dist/plan-client.js',
  sourcemap: true,
};

// The stdio bridge that Claude Code starts; Node only, nothing of the extension's dependencies.
const bridgeOptions = {
  ...options,
  entryPoints: ['src/mcp/bridge.ts'],
  outfile: 'dist/mcp-bridge.js',
  sourcemap: false,
  external: [],
};

// The AWS SDK, apart from extension.js: it is loaded only when an AWS command runs, so it does not slow every start.
const awsOptions = {
  ...options,
  entryPoints: ['src/aws/sdk.ts'],
  outfile: 'dist/aws-sdk.js',
};

const bundles = [
  options,
  gridClientOptions,
  reportClientOptions,
  planClientOptions,
  bridgeOptions,
  awsOptions,
];

if (watch) {
  await Promise.all(bundles.map(async (config) => (await esbuild.context(config)).watch()));
} else {
  await Promise.all(bundles.map((config) => esbuild.build(config)));
  writeNotices({
    mapFiles: [
      'dist/extension.js.map',
      'dist/report-client.js.map',
      'dist/plan-client.js.map',
      'dist/aws-sdk.js.map',
    ],
    outFile: 'THIRD-PARTY-NOTICES.md',
  });
}

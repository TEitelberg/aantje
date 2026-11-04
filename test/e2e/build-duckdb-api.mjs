// Run on the host by run.ps1: bundles the JavaScript API of DuckDB for the helper programs of the specs.
import { buildDuckdbApi } from './lib/duckdb-api.mjs';

await buildDuckdbApi();

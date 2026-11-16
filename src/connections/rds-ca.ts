// The certificate authorities of Amazon RDS. They are not in the system trust store, so a PostgreSQL server on RDS is
// checked against the bundle that the build copies to `dist/rds-ca-bundle.pem` (from `deploy/aws/rds-ca-bundle.pem`).
// No file access here: the report pages bundle the DuckDB statements that ask for the path.

let bundlePath: string | undefined;

/** Set once when aantje starts; until then an RDS host is checked against the system trust store like any other. */
export function useRdsCaBundle(path: string): void {
  bundlePath = path;
}

/** Whether the host is the endpoint of an Amazon RDS instance or cluster (`*.rds.amazonaws.com`). */
export function isRdsHost(host: string): boolean {
  return /\.rds\.amazonaws\.com\.?$/i.test(host.trim());
}

/** The file of the RDS certificate authorities for an RDS host; undefined for any other host. */
export function rdsCaPathFor(host: string): string | undefined {
  return isRdsHost(host) ? bundlePath : undefined;
}

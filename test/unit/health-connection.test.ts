import { describe, expect, it } from 'vitest';
import {
  configFindings,
  endpointNotSet,
  storeFailure,
  suggestEndpoint,
} from '../../src/health/connection-checks';
import type { ConnectionFacts } from '../../src/health/connection-checks';

// What DuckDB 2.0.0 says when the object store refuses or does not answer, as reproduced against RustFS 1.0.4 with a
// listing of the data path (the statement that echoes the failed statement is cut off, as the engine does).
const AUTH =
  'Authentication Failure - this is usually caused by invalid or missing credentials.\n* Credentials are provided, but they did not work.\n* See https://duckdb.org/docs/stable/extensions/httpfs/s3api.html';
const REAL = {
  noSuchBucket:
    "HTTP Error: HTTP GET error listing 's3://nosuchbucket/ducklake/' (HTTP 404 Not Found)\n\nNoSuchBucket: The specified bucket does not exist",
  wrongSecret: `HTTP Error: HTTP GET error listing 's3://hc-lake/ducklake/' (HTTP 403 Forbidden)\n\nSignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your AWS secret access key and signing method. For more information, see REST Authentication and SOAP Authentication for details.\n\n${AUTH}`,
  wrongKeyId: `HTTP Error: HTTP GET error listing 's3://hc-lake/ducklake/' (HTTP 403 Forbidden)\n\nInvalidAccessKeyId: The Access Key Id you provided does not exist in our records.\n\n${AUTH}`,
  noCredentials:
    "HTTP Error: HTTP GET error listing 's3://hc-lake/ducklake/' (HTTP 403 Forbidden)\n\nAccessDenied: Access Denied\n\nAuthentication Failure - this is usually caused by invalid or missing credentials.\n* No credentials are provided.\n* See https://duckdb.org/docs/stable/extensions/httpfs/s3api.html",
  vhostOnIp:
    "IO Error: Could not resolve hostname error for HTTP GET to 'http://hc-lake.127.0.0.1:62778/?encoding-type=url&list-type=2&prefix=ducklake%2F'",
  sslAgainstHttp:
    "IO Error: SSL connect error error for HTTP GET to 'https://127.0.0.1:62778/hc-lake/?encoding-type=url&list-type=2&prefix=ducklake%2F'",
  refused:
    "IO Error: Could not connect to server error for HTTP GET to 'http://127.0.0.1:1/hc-lake/?encoding-type=url&list-type=2&prefix=ducklake%2F'",
  awsWithOtherKeys: `HTTP Error: HTTP GET error listing 's3://hc-lake/ducklake/' (HTTP 403 Forbidden)\n\nInvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records.\nInvalid Access Key: "***"\n\n${AUTH}`,
  proxyWithoutRoute: "HTTP Error: HTTP GET error listing 's3://hc-lake/ducklake/' (HTTP 404 Not Found)",
  timedOut: 'The statement exceeded its time limit of 30 s and was cancelled.',
  unknown: 'IO Error: something new happened',
};

const facts = (extra: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  dataPath: 's3://hc-lake/ducklake/',
  s3: { endpoint: 'http://127.0.0.1:9000', urlStyle: 'path' },
  credentials: 'stored',
  env: {},
  ...extra,
});

const idsOf = (list: readonly { id: string }[]): string[] => list.map((item) => item.id);

describe('what a failed request to the object store means', () => {
  it('tells the check from the text of the engine, as an error of the lake', () => {
    const meanings: [string, boolean, string][] = [
      [REAL.wrongSecret, false, 'connection.store-access-denied'],
      [REAL.wrongKeyId, false, 'connection.store-access-denied'],
      [REAL.noCredentials, false, 'connection.store-access-denied'],
      [REAL.noSuchBucket, false, 'connection.store-bucket-missing'],
      [REAL.vhostOnIp, false, 'connection.store-host-unresolved'],
      [REAL.sslAgainstHttp, false, 'connection.store-ssl-mismatch'],
      [REAL.refused, false, 'connection.store-unreachable'],
      [REAL.timedOut, true, 'connection.store-unreachable'],
      [REAL.proxyWithoutRoute, false, 'connection.store-not-found'],
      [REAL.unknown, false, 'connection.store-failed'],
    ];

    for (const [text, timedOut, check] of meanings) {
      const found = storeFailure(
        text,
        timedOut,
        facts({ s3: { endpoint: '127.0.0.1:9000', urlStyle: 'vhost' } }),
      );

      expect(found, text).toMatchObject({
        id: check,
        check,
        severity: 'error',
        group: 'connection',
        scope: { kind: 'lake' },
      });
      expect(found.cause, text).not.toBe('');
      expect(found.fix, text).not.toBe('');
    }
  });

  it('puts the answer of the store into the detail without the name of the probe, and names the bucket that is missing', () => {
    const probed = storeFailure(
      REAL.wrongKeyId.replace("ducklake/'", "ducklake/aantje-health-probe-'"),
      false,
      facts(),
    );
    const bucket = storeFailure(REAL.noSuchBucket, false, facts({ dataPath: 's3://nosuchbucket/ducklake/' }));

    expect(probed.detail).toContain('InvalidAccessKeyId');
    expect(probed.detail).not.toContain('aantje-health-probe');
    expect(probed.detail).not.toContain(AUTH);
    expect(bucket.cause).toContain('"nosuchbucket"');
    expect(bucket.cause).toContain('"http://127.0.0.1:9000"');
  });

  it('points at the endpoint setting when the keys of a self-hosted store went to AWS', () => {
    const found = storeFailure(REAL.awsWithOtherKeys, false, facts({ s3: {}, credentials: 'environment' }));

    expect(found.settingKey).toBe('s3.endpoint');
    expect(found.cause).toContain('AWS_ACCESS_KEY_ID');
  });
});

describe('the setup problems that show without asking the store', () => {
  it('has nothing to say about a sound setup, on S3 or on the disk', () => {
    expect(configFindings(facts(), undefined)).toEqual([]);
    expect(configFindings(facts({ dataPath: '/data/lake/' }), true)).toEqual([]);
    expect(configFindings(facts({ dataPath: 'C:/data/lake/' }), true)).toEqual([]);
    expect(configFindings(facts({ dataPath: '/data/', credentials: undefined }), true)).toEqual([]);
  });

  it('warns about a lake on s3:// or s3a:// without credentials', () => {
    expect(idsOf(configFindings(facts({ credentials: undefined }), undefined))).toEqual([
      'connection.credentials-missing',
    ]);
    expect(
      idsOf(
        configFindings(facts({ dataPath: 's3a://hc-lake/ducklake/', credentials: undefined }), undefined),
      ),
    ).toEqual(['connection.credentials-missing']);
  });

  it('is an error when a local data path does not exist here, and a warning when it is relative', () => {
    const missing = configFindings(facts({ dataPath: '/data/lake/' }), false);
    const relative = configFindings(facts({ dataPath: 'files/' }), true);

    expect(missing.map((item) => [item.id, item.severity, item.objectKey])).toEqual([
      ['connection.local-path-missing', 'error', '/data/lake/'],
    ]);
    expect(relative.map((item) => [item.id, item.severity])).toEqual([
      ['connection.relative-data-path', 'warning'],
    ]);
  });

  it('warns about the virtual-host style on an IP address or localhost, and about a path in the endpoint, with the setting to change', () => {
    const s3 = (endpoint: string, urlStyle?: 'vhost' | 'path') =>
      configFindings(facts({ s3: { endpoint, urlStyle }, credentials: undefined }), undefined).filter(
        (item) => item.id !== 'connection.credentials-missing',
      );

    for (const endpoint of ['127.0.0.1:9000', 'http://10.0.0.5:9000', 'localhost:9000']) {
      expect(s3(endpoint, 'vhost').map((item) => [item.id, item.settingKey])).toEqual([
        ['connection.url-style-vhost-ip', 's3.urlStyle'],
      ]);
    }
    expect(s3('s3.example.com', 'vhost')).toEqual([]);
    expect(s3('127.0.0.1:9000', 'path')).toEqual([]);
    expect(s3('http://minio.local:9000/example-lake').map((item) => [item.id, item.settingKey])).toEqual([
      ['connection.endpoint-with-path', 's3.endpoint'],
    ]);
    expect(s3('http://minio.local:9000/')).toEqual([]);
  });

  it('warns when stored or environment credentials go to an endpoint in cleartext, not to a local one, TLS or a bare host, and not without credentials', () => {
    const cleartext = (endpoint: string, credentials: ConnectionFacts['credentials']): string[] =>
      idsOf(configFindings(facts({ s3: { endpoint }, credentials }), undefined)).filter(
        (id) => id !== 'connection.credentials-missing',
      );

    for (const endpoint of ['http://minio.local:9000', 'HTTP://10.0.0.5:9000', 'http://store.example.com']) {
      expect(cleartext(endpoint, 'stored'), endpoint).toEqual(['connection.endpoint-cleartext']);
      expect(cleartext(endpoint, 'environment'), endpoint).toEqual(['connection.endpoint-cleartext']);
    }
    for (const endpoint of [
      'http://localhost:9000',
      'http://127.0.0.1:9000',
      'http://[::1]:9000',
      'https://minio.local:9000',
      'minio.local:9000',
    ]) {
      expect(cleartext(endpoint, 'stored'), endpoint).toEqual([]);
    }
    expect(cleartext('http://minio.local:9000', undefined)).toEqual([]);
    const [stored] = configFindings(facts({ s3: { endpoint: 'http://minio.local:9000' } }), undefined);
    expect(stored).toMatchObject({ severity: 'warning', settingKey: 's3.endpoint' });
    expect(stored?.detail).toContain('"http://minio.local:9000"');
  });

  it('leaves the S3 settings alone for a lake whose data is not on S3, as an Azure DuckLake next to a local RustFS', () => {
    // The settings belong to the machine: an endpoint in cleartext, the virtual-host style on an IP, a path.
    const s3 = { endpoint: 'http://10.0.0.5:9000/bucket', urlStyle: 'vhost' } as const;
    for (const dataPath of [
      'abfss://lake@account.dfs.core.windows.net/data/',
      'az://lake/data/',
      'gs://lake/data/',
      '/data/lake/',
      null,
    ]) {
      expect(
        configFindings(facts({ dataPath, s3, credentials: 'environment' }), true),
        String(dataPath),
      ).toEqual([]);
    }
    expect(idsOf(configFindings(facts({ s3, credentials: 'environment' }), undefined)).toSorted()).toEqual([
      'connection.endpoint-cleartext',
      'connection.endpoint-with-path',
      'connection.url-style-vhost-ip',
    ]);
  });
});

describe('the endpoint that the environment suggests', () => {
  it('takes the S3 variable before the general one, trims and strips the slash, gives a store that is not AWS the path style', () => {
    const both = { AWS_ENDPOINT_URL: 'http://general:9000', AWS_ENDPOINT_URL_S3: 'http://s3-only:9000' };

    expect(suggestEndpoint({ AWS_ENDPOINT_URL_S3: ' http://rustfs:9000/ ' })).toEqual({
      endpoint: 'http://rustfs:9000',
      urlStyle: 'path',
      source: 'AWS_ENDPOINT_URL_S3',
    });
    expect(suggestEndpoint(both)?.source).toBe('AWS_ENDPOINT_URL_S3');
    expect(suggestEndpoint({ ...both, AWS_ENDPOINT_URL_S3: '  ' })?.source).toBe('AWS_ENDPOINT_URL');
    expect(suggestEndpoint({ AWS_ENDPOINT_URL_S3: 'rustfs:9000' })?.endpoint).toBe('rustfs:9000');
    expect(suggestEndpoint({ AWS_ENDPOINT_URL: 'https://s3.eu-west-1.amazonaws.com' })).toEqual({
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      source: 'AWS_ENDPOINT_URL',
    });
    expect(
      suggestEndpoint({ AWS_ENDPOINT_URL: 'https://s3.cn-north-1.amazonaws.com.cn:443' })?.urlStyle,
    ).toBeUndefined();
    expect(suggestEndpoint({ AWS_ENDPOINT_URL_S3: 'http://notamazonaws.com' })?.urlStyle).toBe('path');
    expect(suggestEndpoint({})).toBeUndefined();
    expect(suggestEndpoint({ PATH: '/usr/bin', AWS_ENDPOINT_URL_S3: '' })).toBeUndefined();
  });

  it('does not suggest a value with a path, a query, credentials, another scheme, white space, quotes, markup or a bad port, and goes on to the next variable', () => {
    for (const value of [
      'http://rustfs:9000/example-lake',
      'http://rustfs:9000?x=1',
      'http://key:secret@rustfs:9000',
      'ftp://rustfs:9000',
      'http://rus tfs:9000',
      'http://rustfs:9000\nhttp://evil',
      "http://rustfs'9000",
      'http://<b>rustfs</b>:9000',
      'http://rustfs:port',
    ]) {
      expect(suggestEndpoint({ AWS_ENDPOINT_URL_S3: value }), value).toBeUndefined();
      expect(
        suggestEndpoint({ AWS_ENDPOINT_URL_S3: value, AWS_ENDPOINT_URL: 'http://fallback:9000' })?.source,
        value,
      ).toBe('AWS_ENDPOINT_URL');
    }
  });
});

describe('the finding that goes with a request that went to AWS', () => {
  const unset = (extra: Partial<ConnectionFacts> = {}): ConnectionFacts =>
    facts({ s3: {}, credentials: undefined, env: { AWS_ENDPOINT_URL_S3: 'http://rustfs:9000' }, ...extra });
  const failure = (text: string, timedOut = false, given = unset()) => storeFailure(text, timedOut, given);

  it('is an error with the suggested endpoint for an answer that only AWS gives, also without a suggestion and for s3a://', () => {
    const given = unset({ dataPath: 's3://example-lake/ducklake/' });

    expect(endpointNotSet(failure(REAL.noSuchBucket, false, given), given)).toMatchObject({
      id: 'connection.endpoint-not-set',
      check: 'connection.endpoint-not-set',
      severity: 'error',
      group: 'connection',
      scope: { kind: 'lake' },
      settingKey: 's3.endpoint',
      suggestion: { endpoint: 'http://rustfs:9000', urlStyle: 'path', source: 'AWS_ENDPOINT_URL_S3' },
    });
    for (const text of [REAL.noSuchBucket, REAL.awsWithOtherKeys, REAL.noCredentials, REAL.vhostOnIp]) {
      expect(endpointNotSet(failure(text), unset())?.severity, text).toBe('error');
      expect(endpointNotSet(failure(text), unset({ env: {} }))?.severity, text).toBe('error');
    }
    const silent = unset({ env: { PATH: '/usr/bin' } });
    expect(endpointNotSet(failure(REAL.noSuchBucket, false, silent), silent)?.suggestion).toBeUndefined();
    const s3a = unset({ dataPath: 's3a://example-lake/ducklake/' });
    expect(endpointNotSet(failure(REAL.noSuchBucket, false, s3a), s3a)?.severity).toBe('error');
  });

  it('is a warning for another failure when the environment names an endpoint, and nothing when it does not', () => {
    for (const [text, timedOut] of [
      [REAL.refused, false],
      [REAL.timedOut, true],
      [REAL.sslAgainstHttp, false],
      [REAL.proxyWithoutRoute, false],
      [REAL.unknown, false],
    ] as const) {
      expect(endpointNotSet(failure(text, timedOut), unset()), text).toMatchObject({
        severity: 'warning',
        suggestion: { endpoint: 'http://rustfs:9000' },
      });
      expect(endpointNotSet(failure(text, timedOut), unset({ env: {} })), text).toBeUndefined();
    }
  });

  it('does not exist when the endpoint is set or the data path is not on S3', () => {
    const set = facts({ env: { AWS_ENDPOINT_URL_S3: 'http://rustfs:9000' } });
    for (const text of [REAL.noSuchBucket, REAL.wrongSecret, REAL.vhostOnIp, REAL.refused]) {
      expect(endpointNotSet(failure(text, false, set), set), text).toBeUndefined();
    }
    for (const dataPath of ['gs://bucket/lake/', null]) {
      const given = unset({ dataPath });
      expect(
        endpointNotSet(failure(REAL.noSuchBucket, false, given), given),
        String(dataPath),
      ).toBeUndefined();
    }
  });
});

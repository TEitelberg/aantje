import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTeardown } from './support';

export interface S3Request {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

export interface FakeS3 {
  readonly endpoint: string;
  /** Every request that arrived, in order. */
  readonly requests: S3Request[];
}

/**
 * An S3 endpoint that answers every request with "access denied" and keeps what it was asked. It shows where the
 * engine sends its requests (path or virtual-host style, which region it signs for) and with which key id.
 */
export function startFakeS3(): Promise<FakeS3> {
  const requests: S3Request[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    response.writeHead(403, { 'content-type': 'application/xml' });
    response.end(
      '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
    );
  });
  onTeardown(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ endpoint: `http://127.0.0.1:${port}`, requests });
    });
  });
}

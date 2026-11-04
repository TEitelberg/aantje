import { X509Certificate } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { certificateFingerprint } from '../../src/connections/fingerprint';
import { normalizeFingerprint } from '../../src/connections/profile';
import { AantjeError } from '../../src/errors';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from '../support/tls-fixture';

const servers: Server[] = [];
const sockets: Socket[] = [];

// `close` waits for the open connections, so they are ended first.
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listening(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket: Socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('certificateFingerprint', () => {
  it('reads the SHA-256 fingerprint of a self-signed certificate in the form the profile stores and DuckDB pins', async () => {
    const port = await listening(createTlsServer({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }));

    const fingerprint = await certificateFingerprint('127.0.0.1', port);

    expect(fingerprint).toBe(new X509Certificate(SELF_SIGNED_CERT).fingerprint256);
    expect(normalizeFingerprint(fingerprint)).toBe(fingerprint);
    expect(normalizeFingerprint(fingerprint.replaceAll(':', '').toLowerCase())).toBe(fingerprint);
  });

  it('fails with CONNECTION_FAILED for a server without TLS, one that never answers and a closed port', async () => {
    const plain = await listening(
      createTcpServer((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')),
    );
    const silent = await listening(createTcpServer(() => undefined));
    const closed = await listening(createTcpServer());
    await new Promise((resolve) => servers.pop()?.close(resolve));

    for (const [port, timeout] of [
      [plain, 5000],
      [silent, 300],
      [closed, 5000],
    ] as const) {
      const error = await certificateFingerprint('127.0.0.1', port, timeout).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(AantjeError);
      expect((error as AantjeError).code).toBe('CONNECTION_FAILED');
    }
  });
});

import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { AantjeError, isErrnoException, messageOf, networkReason } from '../errors';

const TIMEOUT_MS = 10_000;

/**
 * The SHA-256 fingerprint (`AB:CD:...`) of the certificate that the TLS server at `host:port` presents. The
 * certificate is read without being checked and nothing is sent: the user compares the fingerprint and confirms it
 * before it is pinned (trust on first use).
 */
export function certificateFingerprint(host: string, port: number, timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      // SNI takes a name only; an IP address there is refused by RFC 6066.
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: false,
    });
    const fail = (reason: string, cause?: unknown): void => {
      socket.destroy();
      reject(
        new AantjeError(
          'CONNECTION_FAILED',
          `Cannot read the TLS certificate of ${host}:${port}: ${reason}.`,
          {
            cause,
          },
        ),
      );
    };
    socket.setTimeout(timeoutMs, () => fail(`no answer within ${timeoutMs / 1000} s`));
    socket.on('error', (error: Error) => fail(reasonOf(error), error));
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      const { fingerprint256 } = socket.getPeerCertificate();
      socket.end();
      if (fingerprint256) {
        resolve(fingerprint256);
      } else {
        fail('the server presented no certificate');
      }
    });
  });
}

function reasonOf(error: Error): string {
  const network = networkReason(error);
  if (network !== undefined) return network;
  const code = isErrnoException(error) ? error.code : undefined;
  // A server without TLS answers the handshake with plain HTTP.
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'ERR_SSL_PACKET_LENGTH_TOO_LONG') {
    return 'the server does not speak TLS on this port; turn off TLS for this connection, or check the port';
  }
  return messageOf(error);
}

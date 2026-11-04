import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { onTeardown } from './support';

export const RIGHT_PASSWORD = 'right';

/**
 * A PostgreSQL server for the password prompt: it asks every client for a clear text password and then
 * refuses the session. The password `right` gets past the login and fails because the database does not
 * exist (3D000); any other password fails the login (28P01). It returns the port it listens on.
 */
export function startFakePostgres(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    let pending = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!started) {
        // The startup message has no type byte: its length comes first.
        if (pending.length < 4 || pending.length < pending.readInt32BE(0)) return;
        pending = pending.subarray(pending.readInt32BE(0));
        started = true;
        socket.write(message('R', int32(3)));
      }
      // The password message is 'p', its length (which counts itself) and the password with a terminating NUL.
      if (pending.length >= 5 && pending.length > pending.readInt32BE(1)) {
        const password = pending.toString('utf8', 5, pending.readInt32BE(1));
        const [code, text] =
          password === RIGHT_PASSWORD
            ? ['3D000', 'database "ducklake" does not exist']
            : ['28P01', 'password authentication failed for user "catalog_user"'];
        socket.end(message('E', fields(['S', 'FATAL'], ['C', code], ['M', text])));
      }
    });
  });
  onTeardown(() => {
    server.close();
    sockets.forEach((socket) => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function message(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}

function fields(...entries: [string, string][]): Buffer {
  return Buffer.concat([
    ...entries.map(([code, text]) => Buffer.from(`${code}${text}\0`)),
    Buffer.from('\0'),
  ]);
}

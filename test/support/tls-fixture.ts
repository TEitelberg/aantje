import { generateKeyPairSync, sign } from 'node:crypto';

/*
 * A throw-away self-signed EC certificate (CN=localhost, valid for one day) for tests with a fake TLS server. Key and
 * certificate are generated when the module loads, so that no key is stored in the repository. Node.js cannot sign
 * certificates, hence the few lines of DER below: a version 1 certificate with only the fields a TLS server needs.
 */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 128
      ? Buffer.from([body.length])
      : Buffer.from([0x80 | 2, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const SEQUENCE = 0x30;
const ECDSA_SHA256 = der(SEQUENCE, der(0x06, Buffer.from('2a8648ce3d040302', 'hex')));
const NAME = der(
  SEQUENCE,
  der(0x31, der(SEQUENCE, der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('localhost')))),
);

function utcTime(date: Date): Buffer {
  return der(
    0x17,
    Buffer.from(
      date
        .toISOString()
        .replace(/[-:T]|\.\d+/g, '')
        .slice(2),
    ),
  );
}

function pem(label: string, content: Buffer): string {
  const lines = content.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const now = Date.now();
const tbs = der(
  SEQUENCE,
  der(0x02, Buffer.from([1])),
  ECDSA_SHA256,
  NAME,
  der(SEQUENCE, utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
  NAME,
  publicKey.export({ type: 'spki', format: 'der' }),
);
const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });

export const SELF_SIGNED_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
export const SELF_SIGNED_CERT = pem(
  'CERTIFICATE',
  der(SEQUENCE, tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), signature]))),
);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import {
  copyDataFixture,
  gridTabs,
  observeWebviews,
  requireEngine,
  setSetting,
  useExtensionCache,
} from './data';
import { Desktop, input } from './desktop';
import { startFakeS3 } from './fake-s3';
import type { FakeS3, S3Request } from './fake-s3';
import {
  activate,
  nodeAt,
  onTeardown,
  readOutputChannel,
  sandboxDir,
  setConnections,
  waitFor,
} from './support';

// The key id and the secret are also the bucket and the folder of the data, so the engine quotes them in its
// error messages: that is what makes "the secret does not leak" a test that can fail.
const BUCKET = 'aantje-test-key';
const FOLDER = 'aantje-test-secret';
const KEY_ID = BUCKET;
const SECRET = FOLDER;
const REGION = 'eu-test-1';

const STORED = 'The S3 credentials are stored in the secret storage.';
const CLEARED =
  'The stored S3 credentials were removed. Credentials from the environment, if any, still apply.';

/** The requests for the Parquet files of sales.orders. */
function dataRequests(s3: FakeS3): S3Request[] {
  return s3.requests.filter(({ url }) => url.startsWith(`/${BUCKET}/${FOLDER}/sales/orders/`));
}

describe('reading data from S3', function () {
  before(async function () {
    await requireEngine(this);
  });

  let tree: CatalogTree;
  let desktop: Desktop;
  let s3: FakeS3;
  let name: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    observeWebviews();
    // The environment of the developer must not provide credentials.
    for (const variable of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      const previous = process.env[variable];
      delete process.env[variable];
      onTeardown(() => {
        if (previous !== undefined) process.env[variable] = previous;
      });
    }
    await useExtensionCache();
    s3 = await startFakeS3();
    await setSetting('s3.endpoint', s3.endpoint);
    await setSetting('s3.region', REGION);
    await setSetting('s3.urlStyle', 'path');
    const fixture = await copyDataFixture('sqlite', () => `s3://${BUCKET}/${FOLDER}/`);
    name = fixture.profile.name;
    await setConnections([fixture.profile]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /** Clicks "Select Top 1000 Rows"; the endpoint refuses, so the command ends with an error message. */
  async function preview(): Promise<string> {
    const before = desktop.errors.length;
    await vscode.commands.executeCommand(
      'aantje.previewTable',
      await nodeAt(tree, name, 'sales', 'Tables', 'orders'),
    );
    assert.equal(desktop.errors.length, before + 1, 'the endpoint refuses the request');
    assert.deepEqual(gridTabs(), []);
    return desktop.errors[before] ?? '';
  }

  /** The signed `Authorization` headers of the requests for the data files. */
  const signatures = (): (string | undefined)[] =>
    dataRequests(s3).map(({ headers }) => headers.authorization);

  it('sends the request in path style to the endpoint and region of the settings, without credentials', async () => {
    const message = await preview();

    assert.ok(dataRequests(s3).length > 0, 'the data file was requested from the endpoint of the settings');
    assert.deepEqual(new Set(signatures()), new Set([undefined]));
    assert.match(message, /^Cannot read the data of "sales\.orders": /);
    assert.match(message, /aantje\.s3\.\*/);
    assert.match(message, /aantje: Set S3 Credentials\.\.\./);
    // Without credentials nothing is hidden: the bucket and the folder are part of the quoted URL.
    assert.ok(message.includes(`/${BUCKET}/${FOLDER}/sales/orders/`), message);
  });

  it('stores the credentials in the secret storage, signs the requests with them and keeps them out of messages, settings and the log', async () => {
    // The log is shared by all tests of the run: an earlier test (without credentials) logged the bucket as it is.
    const logged = readOutputChannel().length;
    desktop.answer(input(KEY_ID), input(SECRET));
    await vscode.commands.executeCommand('aantje.setS3Credentials');

    assert.deepEqual(
      desktop.inputs.map(({ title, prompt, password }) => ({ title, prompt, password: password === true })),
      [
        {
          title: 'Set S3 Credentials (1/2)',
          prompt: 'Access key id for the S3 storage that holds the data of the catalogs',
          password: false,
        },
        {
          title: 'Set S3 Credentials (2/2)',
          prompt: 'Secret access key. It is kept in the secret storage, not in the settings.',
          password: true,
        },
      ],
    );
    assert.ok(
      desktop.inputs.every(({ validate }) => validate('') && !validate('x')),
      'an empty value is refused',
    );
    assert.deepEqual(desktop.infos, [STORED]);

    const message = await preview();

    // The secret storage survived the round trip to the engine: the request carries the key id and the region.
    const [signature] = signatures();
    assert.ok(signature !== undefined, 'the data file was requested');
    assert.ok(signature.includes(`Credential=${KEY_ID}/`), `signed with the key id: ${signature}`);
    assert.ok(signature.includes(`/${REGION}/s3/aws4_request`), `signed for the region: ${signature}`);
    assert.ok(signatures().every((value) => value?.includes(`Credential=${KEY_ID}/`)));
    assert.match(message, /\*\*\*/);
    for (const secret of [KEY_ID, SECRET]) {
      assert.ok(!message.includes(secret), `the message shows ${secret}: ${message}`);
    }

    const newLog = await waitFor('the failure in the output channel', () => {
      const text = readOutputChannel().slice(logged);
      return text.includes('The command aantje.previewTable failed.') ? text : undefined;
    });
    assert.match(newLog, /\*\*\*/, 'the failure is in the log, masked');
    const settings = readFileSync(join(sandboxDir(), 'user-data', 'User', 'settings.json'), 'utf8');
    const config = vscode.workspace.getConfiguration('aantje');
    for (const secret of [KEY_ID, SECRET]) {
      assert.ok(!newLog.includes(secret), `the output channel shows ${secret}`);
      assert.ok(!settings.includes(secret), `the user settings contain ${secret}`);
    }
    assert.ok(settings.includes(s3.endpoint), 'the settings file is the one the extension reads');
    assert.deepEqual([config.get('s3.keyId'), config.get('s3.secretKey')], [undefined, undefined]);
  });

  it('removes both values with "Clear S3 Credentials": the next request is anonymous again', async () => {
    desktop.answer(input(KEY_ID), input(SECRET));
    await vscode.commands.executeCommand('aantje.setS3Credentials');
    await preview();
    const signed = dataRequests(s3).length;
    assert.ok(signed > 0 && signatures().every((value) => value !== undefined));

    await vscode.commands.executeCommand('aantje.clearS3Credentials');
    const message = await preview();

    assert.deepEqual(desktop.infos, [STORED, CLEARED]);
    assert.deepEqual(new Set(signatures().slice(signed)), new Set([undefined]));
    assert.ok(message.includes(`/${BUCKET}/${FOLDER}/`), 'nothing is scrubbed any more');
  });

  it('stores nothing when the user cancels one of the two boxes', async () => {
    desktop.answer(input(undefined));
    await vscode.commands.executeCommand('aantje.setS3Credentials');
    desktop.answer(input(KEY_ID), input(undefined));
    await vscode.commands.executeCommand('aantje.setS3Credentials');

    await preview();

    assert.deepEqual(desktop.infos, []);
    assert.deepEqual(new Set(signatures()), new Set([undefined]));
  });

  it('uses AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY of the environment when nothing is stored', async () => {
    process.env.AWS_ACCESS_KEY_ID = KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = SECRET;

    const message = await preview();

    assert.ok(signatures().every((value) => value?.includes(`Credential=${KEY_ID}/`)));
    assert.ok(!message.includes(KEY_ID), message);
  });
});

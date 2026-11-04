import { describe, expect, it } from 'vitest';
import type { PostgresProfile } from '../../src/connections/profile';
import { viewConfirmation } from '../../src/data/confirm';
import type { TrustRequest } from '../../src/data/confirm';
import { ViewTrustStore } from '../../src/data/trust';
import { AantjeError } from '../../src/errors';

const warehouse: PostgresProfile = {
  id: 'wh',
  name: 'Warehouse',
  kind: 'postgres',
  host: 'db.example.org',
  port: 5432,
  database: 'lake',
  user: 'etl',
};
const local = { id: 'local', name: 'Local', kind: 'sqlite', path: 'D:\\data\\lake.sqlite' } as const;

function setup(answer: (request: TrustRequest) => Promise<boolean> = () => Promise.resolve(true)) {
  let keys: readonly string[] = [];
  const trust = new ViewTrustStore({
    get: () => keys,
    update: (value) => {
      keys = value;
      return Promise.resolve();
    },
  });
  const asked: TrustRequest[] = [];
  const confirm = viewConfirmation({
    trust,
    ask: (request) => {
      asked.push(request);
      return answer(request);
    },
  });
  return { trust, asked, confirm };
}

/** An answer the test gives later. */
function later() {
  let answer!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

describe('the confirmation before views are resolved', () => {
  it('asks once per connection target, names the connection and its target, remembers the answer, and asks again when the target moved', async () => {
    const { confirm, trust, asked } = setup();

    await confirm(warehouse);
    await confirm(warehouse);
    await confirm(local);
    await confirm({ ...warehouse, host: 'other.example.org' });

    expect(asked).toHaveLength(3);
    expect(asked[0]?.message).toContain('"Warehouse"');
    expect(asked[0]?.detail).toContain('db.example.org:5432/lake');
    expect(asked[1]?.detail).toContain('D:\\data\\lake.sqlite');
    expect(trust.isTrusted(warehouse)).toBe(true);
    expect(trust.isTrusted(local)).toBe(true);
  });

  it('is declined with ABORTED that names the connection, stores no trust, and asks again the next time', async () => {
    let calls = 0;
    const { confirm, asked, trust } = setup(() => Promise.resolve(++calls > 1));

    const error = await confirm(warehouse).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AantjeError);
    expect(error).toMatchObject({ code: 'ABORTED' });
    expect((error as AantjeError).userMessage).toContain('"Warehouse"');
    expect(trust.isTrusted(warehouse)).toBe(false);

    await confirm(warehouse);
    expect(asked).toHaveLength(2);
    expect(trust.isTrusted(warehouse)).toBe(true);
  });

  it('asks once when several views of one connection are read at the same time (all get the answer, a decline fails them all), and separately for different connections', async () => {
    const accepted = later();
    const first = setup(() => accepted.promise);
    const reads = [
      first.confirm(warehouse),
      first.confirm(warehouse),
      first.confirm({ ...warehouse, name: 'Renamed' }),
    ];
    expect(first.asked).toHaveLength(1);
    accepted.answer(true);
    await Promise.all(reads);
    expect(first.asked).toHaveLength(1);
    expect(first.trust.isTrusted(warehouse)).toBe(true);

    const declined = later();
    const second = setup(() => declined.promise);
    const waiting = [second.confirm(warehouse), second.confirm(warehouse)].map((read) =>
      read.catch((error: unknown) => error),
    );
    declined.answer(false);
    expect(await Promise.all(waiting)).toEqual([
      expect.objectContaining({ code: 'ABORTED' }),
      expect.objectContaining({ code: 'ABORTED' }),
    ]);
    expect(second.asked).toHaveLength(1);

    const one = later();
    const two = later();
    const answers = [one.promise, two.promise];
    const third = setup(() => answers.shift() ?? Promise.resolve(false));
    const both = [third.confirm(warehouse), third.confirm(local)];
    expect(third.asked).toHaveLength(2);
    one.answer(true);
    two.answer(true);
    await Promise.all(both);
  });
});

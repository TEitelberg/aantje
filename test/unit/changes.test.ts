import { describe, expect, it } from 'vitest';
import { parseChanges } from '../../src/catalog/changes';
import type { ChangeEntry } from '../../src/catalog/changes';
import { HISTORY_CHANGES } from '../support/expected-history';

const named = (
  token: string,
  action: ChangeEntry['action'],
  object: ChangeEntry['object'],
  name: string[],
  raw: string,
): ChangeEntry => ({ token, action, object, id: null, name, raw });
const withId = (
  token: string,
  action: ChangeEntry['action'],
  object: ChangeEntry['object'],
  id: number,
): ChangeEntry => ({ token, action, object, id, name: null, raw: `${token}:${id}` });
const unknown = (raw: string, token = raw.split(':')[0] ?? ''): ChangeEntry => ({
  token,
  action: 'unknown',
  object: null,
  id: null,
  name: null,
  raw,
});

describe('parseChanges', () => {
  it('structures every snapshot of the history fixture without leaving an entry unknown', () => {
    for (const [snapshot, changes] of HISTORY_CHANGES.entries()) {
      const entries = parseChanges(changes);
      expect(entries.length, `snapshot ${snapshot}`).toBeGreaterThan(0);
      expect(
        entries.filter(({ action }) => action === 'unknown'),
        `snapshot ${snapshot}`,
      ).toEqual([]);
      // Nothing is lost or invented: the entries give back the stored text.
      expect(entries.map(({ raw }) => raw).join(','), `snapshot ${snapshot}`).toBe(changes);
    }
  });

  it('understands every token of the vocabulary as an action on an object, with names as paths and ids as numbers, in stored order', () => {
    expect(parseChanges('created_table:"shop"."audit",inserted_into_table:11')).toEqual([
      named('created_table', 'created', 'table', ['shop', 'audit'], 'created_table:"shop"."audit"'),
      withId('inserted_into_table', 'inserted', 'table', 11),
    ]);
    expect(parseChanges('inlined_insert:10,inlined_delete:10')).toEqual([
      withId('inlined_insert', 'inlined_insert', 'table', 10),
      withId('inlined_delete', 'inlined_delete', 'table', 10),
    ]);

    const tokens: [string, string, string][] = [
      ['created_schema:"main"', 'created', 'schema'],
      ['created_view:"shop"."v"', 'created', 'view'],
      ['created_scalar_macro:"shop"."m"', 'created', 'scalar_macro'],
      ['created_table_macro:"shop"."m"', 'created', 'table_macro'],
      ['created_tag:"release"', 'created', 'snapshot_tag'],
      ['dropped_tag:"release"', 'dropped', 'snapshot_tag'],
      ['dropped_schema:1', 'dropped', 'schema'],
      ['dropped_table:1', 'dropped', 'table'],
      ['dropped_view:1', 'dropped', 'view'],
      ['dropped_scalar_macro:1', 'dropped', 'scalar_macro'],
      ['dropped_table_macro:1', 'dropped', 'table_macro'],
      ['altered_table:1', 'altered', 'table'],
      ['altered_view:1', 'altered', 'view'],
      ['deleted_from_table:1', 'deleted', 'table'],
      ['flushed_inlined:1', 'flushed_inlined', 'table'],
      ['inline_flush:1', 'flushed_inlined', 'table'],
      ['compacted_table:1', 'compacted', 'table'],
      ['merge_adjacent:1', 'merged', 'table'],
      ['rewrite_delete:1', 'rewritten', 'table'],
      ['expired_snapshot:1', 'expired', 'snapshot'],
    ];
    for (const [raw, action, object] of tokens) {
      expect(parseChanges(raw), raw).toMatchObject([{ raw, action, object }]);
    }
  });

  it('reads a name that contains a comma, a quote, a dot, a colon, a line break, a token or several parts', () => {
    const names: [string, string[]][] = [
      ['created_table:"sales"."orders, 2026",inserted_into_table:9', ['sales', 'orders, 2026']],
      ['created_table:"sales"."say ""hi"""', ['sales', 'say "hi"']],
      ['created_view:"sales"."v1.2"', ['sales', 'v1.2']],
      ['created_table:"sales"."a"".""b"', ['sales', 'a"."b']],
      ['created_table:"main"."a:b"', ['main', 'a:b']],
      ['created_table:"main"."a\nb"', ['main', 'a\nb']],
      ['created_table:"main"."inserted_into_table:7"', ['main', 'inserted_into_table:7']],
      ['created_table:"sales"."europe"."orders"', ['sales', 'europe', 'orders']],
      ['created_table:"sales".""', ['sales', '']],
    ];
    for (const [raw, name] of names) {
      const [first, ...rest] = parseChanges(raw);
      expect(first?.name, raw).toEqual(name);
      expect(first?.id, raw).toBeNull();
      // Only the comma case has a second entry, and it is the one after the name.
      expect(rest.map((entry) => entry.raw)).toEqual(
        raw.includes('orders, 2026') ? ['inserted_into_table:9'] : [],
      );
    }
  });

  it('keeps an entry it does not understand, or one with an unusable argument, in its place as unknown', () => {
    expect(parseChanges('inserted_into_table:2,frobnicated:7,dropped_table:3')).toEqual([
      withId('inserted_into_table', 'inserted', 'table', 2),
      unknown('frobnicated:7', 'frobnicated'),
      withId('dropped_table', 'dropped', 'table', 3),
    ]);

    const unusable = [
      'inserted_into_table:abc',
      'inserted_into_table:',
      'inserted_into_table:-4',
      'inserted_into_table:1.5',
      'inserted_into_table:99999999999999999999',
      'altered_view:4x',
      'dropped_table',
      'created_schema:',
      'created_table:sales.orders',
      'created_table:"sales"."orders',
      'created_table:x"a"."b"',
      'created_table:"a"x"b"',
      'created_schema:""',
    ];
    for (const raw of unusable) {
      const entries = parseChanges(raw);
      expect(entries, raw).toHaveLength(1);
      expect(entries[0], raw).toMatchObject({ raw, action: 'unknown', object: null, id: null, name: null });
    }
    for (const raw of ['constructor:1', 'toString:2', '__proto__:3']) {
      expect(parseChanges(raw), raw).toEqual([unknown(raw)]);
    }
    expect(parseChanges(null)).toEqual([]);
    expect(parseChanges('')).toEqual([]);
    expect(parseChanges(',altered_table:1,,').map(({ raw }) => raw)).toEqual(['altered_table:1']);
  });
});

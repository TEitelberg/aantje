import { describe, expect, it } from 'vitest';
import {
  isArrayOf,
  isCount,
  isExactShape,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  isTrue,
  own,
} from '../../src/guards';

describe('the building blocks of the message guards', () => {
  it('takes a plain object as an object, and neither a list, null nor a primitive', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject('x')).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });

  it('reads a field of the object itself and nothing that it inherits', () => {
    expect(own({ a: 1 }, 'a')).toBe(1);
    expect(own({ a: 1 }, 'b')).toBeUndefined();
    expect(own(Object.create({ a: 1 }) as Record<string, unknown>, 'a')).toBeUndefined();
    expect(own({}, 'toString')).toBeUndefined();
  });

  it('takes a count as a whole number from zero up, and nothing else', () => {
    expect([0, 1, 41].every(isCount)).toBe(true);
    expect([-1, 1.5, NaN, Infinity, '3', null, undefined].some(isCount)).toBe(false);
  });

  it('combines tests: null or, optional, list of, one of', () => {
    expect([isNullOr(isString)(null), isNullOr(isString)('x'), isNullOr(isString)(1)]).toEqual([
      true,
      true,
      false,
    ]);
    expect([isOptional(isCount)(undefined), isOptional(isCount)(2), isOptional(isCount)(null)]).toEqual([
      true,
      true,
      false,
    ]);
    expect([isArrayOf(isCount)([]), isArrayOf(isCount)([1, 2]), isArrayOf(isCount)([1, 'a'])]).toEqual([
      true,
      true,
      false,
    ]);
    expect(isArrayOf(isCount)({ length: 0 })).toBe(false);
    expect([isOneOf('a', 'b')('a'), isOneOf('a', 'b')('c')]).toEqual([true, false]);
    expect([isTrue(true), isTrue(false), isTrue('true')]).toEqual([true, false, false]);
  });

  it('tests the fields of a shape by their own values, and looks at no other field', () => {
    const shape = isShape({ name: isString, size: isOptional(isCount) });
    expect(shape({ name: 'a' })).toBe(true);
    expect(shape({ name: 'a', size: 3, more: {} })).toBe(true);
    expect(shape({ size: 3 })).toBe(false);
    expect(shape({ name: 'a', size: -3 })).toBe(false);
    expect(shape([])).toBe(false);
    expect(shape(Object.create({ name: 'inherited' }))).toBe(false);
  });

  it('accepts from an exact shape only the fields that it names', () => {
    const exact = isExactShape({ filter: isString, size: isOptional(isCount) });
    expect(exact({ filter: 'a' })).toBe(true);
    expect(exact({ filter: 'a', size: 2 })).toBe(true);
    expect(exact({ filter: 'a', size: undefined })).toBe(true);
    expect(exact({ filter: 'a', command: 'quit' })).toBe(false);
    expect(exact({ filter: 'a', toString: 'x' })).toBe(false);
    expect(exact({ filter: 4 })).toBe(false);
    expect(exact({})).toBe(false);
  });
});

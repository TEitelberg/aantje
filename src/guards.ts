// Building blocks of the guards for webview and extension messages.

export type Test = (value: unknown) => boolean;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A field of the object itself; inherited prototype fields were not posted. */
export const own = (value: Record<string, unknown>, name: string): unknown =>
  Object.hasOwn(value, name) ? value[name] : undefined;
export const isCount: Test = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
export const isFiniteNumber: Test = (value) => typeof value === 'number' && Number.isFinite(value);
export const isString: Test = (value) => typeof value === 'string';
export const isBoolean: Test = (value) => typeof value === 'boolean';
export const isNullOr =
  (test: Test): Test =>
  (value) =>
    value === null || test(value);
export const isOptional =
  (test: Test): Test =>
  (value) =>
    value === undefined || test(value);
export const isArrayOf =
  (test: Test): Test =>
  (value) =>
    Array.isArray(value) && value.every(test);
export const isOneOf =
  (...values: readonly unknown[]): Test =>
  (value) =>
    values.includes(value);
export const isTrue: Test = (value) => value === true;

/** Tests the object's own fields; a field outside `fields` is ignored. */
export const isShape =
  (fields: Record<string, Test>): Test =>
  (value) =>
    isObject(value) && Object.entries(fields).every(([name, test]) => test(own(value, name)));

/** `isShape` for page messages: the object has no field besides `fields`. */
export const isExactShape =
  (fields: Record<string, Test>): Test =>
  (value) =>
    isShape(fields)(value) && Object.keys(value as object).every((name) => Object.hasOwn(fields, name));

import { DECIMAL } from '../catalog/ddl';

// The column type changes that Script as Update writes. DuckLake changes a column only to a wider type; these are the
// changes that DuckDB 2.0 with its ducklake extension accepted and after which every stored value read back. DuckLake
// accepts a few more (any type to JSON, HUGEINT to DECIMAL, a DECIMAL of width 38 with a smaller scale), after which
// reading the table can fail or round the values: the script keeps those as a comment (docs/en/compare.md).

const BITS = [8, 16, 32, 64, 128] as const;
const signed = BITS.map((bits) => `int${bits}`);
const unsigned = BITS.map((bits) => `uint${bits}`);
const FLOATS = ['float32', 'float64'];

// Digits of the largest value: the integer digits that a DECIMAL needs to hold every value.
const DIGITS: ReadonlyMap<string, number> = new Map([
  ['int8', 3],
  ['int16', 5],
  ['int32', 10],
  ['int64', 19],
  ['uint8', 3],
  ['uint16', 5],
  ['uint32', 10],
  ['uint64', 20],
]);

const TIMESTAMPS = ['timestamp', 'timestamp_s', 'timestamp_ms', 'timestamp_ns', 'timestamptz'];

// A Map, not an object: a type name from the catalog must not match an object property.
const WIDER: ReadonlyMap<string, readonly string[]> = new Map([
  ['boolean', [...signed, ...unsigned]],
  ...BITS.map((bits, at) => [`int${bits}`, [...signed.slice(at + 1), ...FLOATS]] as const),
  ...BITS.map(
    (bits, at) => [`uint${bits}`, [...signed.slice(at + 1), ...unsigned.slice(at + 1), ...FLOATS]] as const,
  ),
  ['float32', ['float64']],
  ['date', TIMESTAMPS],
  ['timestamp_s', ['timestamp', 'timestamp_ms', 'timestamp_ns', 'timestamptz']],
  ['timestamp_ms', ['timestamp', 'timestamp_ns', 'timestamptz']],
  ['timestamp', ['timestamp_ns', 'timestamptz']],
]);

const decimal = (type: string): { precision: number; scale: number } | undefined => {
  const match = DECIMAL.exec(type);
  return match ? { precision: Number(match[1]), scale: Number(match[2]) } : undefined;
};

/** True when Script as Update changes a column of the DuckLake type `from` to `to` (both as the catalog names them). */
export function typeChangeAllowed(from: string, to: string): boolean {
  const target = decimal(to);
  const source = decimal(from);
  if (source) {
    // A DECIMAL keeps its digits after the point and before it.
    return target
      ? target.scale >= source.scale && target.precision - target.scale >= source.precision - source.scale
      : FLOATS.includes(to);
  }
  if (target) {
    const digits = DIGITS.get(from);
    return digits !== undefined && target.precision - target.scale >= digits;
  }
  return WIDER.get(from)?.includes(to) === true;
}

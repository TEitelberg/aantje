// What parsing alone tells about a text: its syntax errors, from the `json_serialize_sql` document of DuckDB.
import { utf16Offsets } from './script';
import type { Range } from './script';

export interface Diagnostic extends Range {
  readonly message: string;
}

/** The syntax errors that a `json_serialize_sql` document of the text reports. */
export function syntaxErrorsOf(serialized: string, text: string): Diagnostic[] {
  const json = JSON.parse(serialized) as {
    error?: boolean;
    error_type?: string;
    error_message?: string;
    position?: string;
    location?: string;
  };
  // A valid non-SELECT statement answers with a serialization error, which is no syntax error.
  if (!json.error || json.error_type !== 'parser' || json.position === undefined) return [];
  const unitOf = utf16Offsets(text);
  const [start = Number(json.position), bytes = 1] = json.location
    ? (JSON.parse(json.location) as number[])
    : [];
  const offset = unitOf(start);
  const message = json.error_message ?? 'Syntax error';
  return [
    {
      offset,
      length: Math.max(unitOf(start + bytes) - offset, 1),
      message: message.charAt(0).toUpperCase() + message.slice(1),
    },
  ];
}

// The files of Import and Export: a `.sql` file holds one template, a `.json` bundle several, each with its whole text:
//
//   { "aantje-templates": 1, "templates": [ { "text": "-- aantje-template: 1\n-- name: ...\nSELECT 1;" } ] }
//
// Import reads text only and runs nothing. Pure.
import { isObject, own } from '../guards';
import { MAX_TEMPLATE_BYTES, normalizedText } from './model';

/** The key and value that mark a bundle. */
export const BUNDLE_KEY = 'aantje-templates';
export const BUNDLE_FORMAT = 1;

/** The most templates that a bundle may hold, and the largest file Import reads (a bundle of them). */
export const MAX_BUNDLE_TEMPLATES = 500;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** A template text that Import read, and where it came from, for a message. */
export interface ImportedText {
  readonly from: string;
  readonly text: string;
}

/** The kinds of file that Import reads. */
export const IMPORT_EXTENSIONS = ['sql', 'json'] as const;

/** The template texts of a file; a problem when it cannot hold templates. `name` is the file name, for the messages. */
export function importedTexts(
  name: string,
  content: string,
): { texts: ImportedText[] } | { problem: string } {
  if (!/\.json$/i.test(name)) return { texts: [{ from: name, text: normalizedText(content) }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    return { problem: `${name} is no JSON file.` };
  }
  const templates = isObject(parsed) ? own(parsed, 'templates') : undefined;
  if (!isObject(parsed) || own(parsed, BUNDLE_KEY) !== BUNDLE_FORMAT || !Array.isArray(templates)) {
    return {
      problem: `${name} is no bundle of templates: it needs "${BUNDLE_KEY}": ${BUNDLE_FORMAT} and a list "templates".`,
    };
  }
  if (templates.length > MAX_BUNDLE_TEMPLATES) {
    return { problem: `${name} holds more than ${MAX_BUNDLE_TEMPLATES} templates.` };
  }
  const texts: ImportedText[] = [];
  for (const [index, entry] of templates.entries()) {
    const text = isObject(entry) ? own(entry, 'text') : undefined;
    if (typeof text !== 'string') {
      return { problem: `Template ${index + 1} of ${name} has no "text".` };
    }
    texts.push({ from: `${name}, template ${index + 1}`, text: normalizedText(text) });
  }
  return { texts };
}

/** Whether a file is too large for Import: a template file over the size of a template, a bundle over its limit. */
export function tooLarge(name: string, bytes: number): boolean {
  return bytes > (/\.json$/i.test(name) ? MAX_IMPORT_BYTES : MAX_TEMPLATE_BYTES + 3);
}

/** A file name for a template: its name without what a file system refuses, `template` when nothing is left. */
export function fileNameOf(name: string): string {
  const base = name
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '');
  return `${base === '' ? 'template' : base}.sql`;
}

/** The text of an exported template file: as kept, ending with a line break. */
export const exportedText = (text: string): string => text.replace(/\n*$/, '\n');

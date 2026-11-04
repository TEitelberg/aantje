import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Heading {
  readonly text: string;
}

interface Outline {
  readonly headings: Heading[];
  /** Line of a fenced code block that is never closed. */
  readonly unclosed: number[];
  /** Everything outside fenced code blocks, with the number of the line. */
  readonly prose: { readonly line: number; readonly text: string }[];
}

// UTF-8 text that was decoded with another encoding and saved again: the replacement character, or the
// double-encoded form of typographic punctuation and of umlauts.
const DAMAGED_TEXT = /\u{fffd}|\xc3[\xa4\xb6\xbc\u{178}\u{201e}\u{2013}\u{153}]|\xe2\u{20ac}/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const LINK = /\]\(([^)\s]+)/g;
const EMPTY: Outline = { headings: [], unclosed: [], prose: [] };

/** The README and every page of `docs/en` (also in subfolders), as paths relative to `root` with '/' separators. */
export function docPages(root: string): string[] {
  const dir = join(root, 'docs', 'en');
  const pages = existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.md'))
        .map((name) => `docs/en/${name.replaceAll('\\', '/')}`)
        .sort()
    : [];
  return ['README.md', ...pages];
}

/**
 * Everything wrong with one page: the file is missing, is not UTF-8 without BOM, uses CR line endings,
 * contains text damaged by a wrong encoding, or opens a fenced code block that is never closed.
 */
export function pageProblems(root: string, path: string): string[] {
  const bytes = read(root, path);
  if (!bytes) {
    return [`${path} is missing`];
  }
  const problems: string[] = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push(`${path} starts with a byte order mark (BOM); save it as UTF-8 without BOM`);
  }
  let text: string;
  try {
    // Strips a BOM, which is reported above.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [...problems, `${path} is not valid UTF-8`];
  }
  const cr = text.indexOf('\r');
  if (cr >= 0) {
    problems.push(`${path} uses a CR or CRLF line ending in line ${lineOf(text, cr)}; use LF`);
  }
  const damaged = DAMAGED_TEXT.exec(text);
  if (damaged) {
    const line = lineOf(text, damaged.index);
    problems.push(
      `${path} contains text damaged by a wrong encoding in line ${line}: ` +
        JSON.stringify(text.split('\n')[line - 1]?.trim() ?? ''),
    );
  }
  for (const line of outline(text.replace(/\r\n?/g, '\n')).unclosed) {
    problems.push(`${path} opens a code block in line ${line} that is never closed`);
  }
  return problems;
}

/** The pages of `docs/en` that `docs/en/index.md` does not link to. */
export function pagesNotInIndex(root: string): string[] {
  const linked = new Set(
    linkTargets(outlineOf(root, 'docs/en/index.md') ?? EMPTY).map((target) =>
      join('docs/en', fileOf(target)).replaceAll('\\', '/'),
    ),
  );
  return docPages(root).filter(
    (page) => page !== 'README.md' && page !== 'docs/en/index.md' && !linked.has(page),
  );
}

/**
 * Whether `path` (relative to `root`, '/' separators) exists with exactly this letter case in every segment.
 * The directory listings make a difference in letter case a mismatch on case-insensitive file systems, too.
 */
export function existsExactCase(root: string, path: string): boolean {
  let current = root;
  for (const segment of path.split('/')) {
    try {
      if (!readdirSync(current).includes(segment)) {
        return false;
      }
    } catch {
      return false;
    }
    current = join(current, segment);
  }
  return true;
}

function read(root: string, path: string): Buffer | undefined {
  return existsExactCase(root, path) ? readFileSync(join(root, path)) : undefined;
}

function outlineOf(root: string, path: string): Outline | undefined {
  const bytes = read(root, path);
  return bytes ? outline(bytes.toString('utf8').replace(/\r\n?/g, '\n')) : undefined;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function outline(text: string): Outline {
  const result: Outline = { headings: [], unclosed: [], prose: [] };
  let open: { marker: string; line: number } | undefined;
  // The newline that ends the file is not an empty last line.
  for (const [index, line] of text.replace(/\n$/, '').split('\n').entries()) {
    const number = index + 1;
    if (open) {
      if (closesFence(line, open.marker)) {
        open = undefined;
      }
      continue;
    }
    const marker = openingFence(line);
    if (marker) {
      open = { marker, line: number };
      continue;
    }
    result.prose.push({ line: number, text: line });
    if (HEADING.test(line)) {
      result.headings.push({ text: line.trim() });
    }
  }
  if (open) {
    result.unclosed.push(open.line);
  }
  return result;
}

function openingFence(line: string): string | undefined {
  const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
  const marker = match?.[2];
  // A backtick in the info string means an inline code span, not a fence.
  return marker && !(marker.startsWith('`') && (match?.[3] ?? '').includes('`')) ? marker : undefined;
}

/** A closing fence uses the same character as the opening one, at least as often, and carries no text. */
function closesFence(line: string, marker: string): boolean {
  const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return closing !== undefined && closing.startsWith(marker.charAt(0)) && closing.length >= marker.length;
}

/** Targets (with any #anchor) of the links and images in the prose, in order. */
function linkTargets({ prose }: Outline): string[] {
  return prose.flatMap(({ text }) =>
    [...text.replace(/`[^`]*`/g, '').matchAll(LINK)].map((match) => match[1] ?? ''),
  );
}

/** The file part of a link target; empty for a link within the page. */
const fileOf = (target: string): string => target.replace(/#.*$/, '');

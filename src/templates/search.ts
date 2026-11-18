// What the Templates page shows and finds: the cards it gets, the rows it shows before anything is typed, the search
// while typing, and the list of Browse. Pure and free of Node, so that the page script runs it too.

/** Where a template comes from: shipped with aantje, written or imported by the user, or a file of a folder. */
export type TemplateSource = 'builtin' | 'mine' | 'imported' | 'folder';

export const TEMPLATE_SOURCES: readonly TemplateSource[] = ['builtin', 'mine', 'imported', 'folder'];

/** The word for a source on a card; the search finds a template by it too. */
export const SOURCE_LABEL: Readonly<Record<TemplateSource, string>> = {
  builtin: 'built-in',
  mine: 'mine',
  imported: 'imported',
  folder: 'folder',
};

/** A template as the page gets it. */
export interface TemplateCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly source: TemplateSource;
  /** The whole text, for the preview and the search. */
  readonly text: string;
  /** How often it was used on this machine, and when last (milliseconds since 1970). */
  readonly uses: number;
  readonly lastUsed: number | null;
  /**
   * When it was created (milliseconds since 1970): an own or imported template when it was kept first, a built-in or
   * folder one at the start of the day of its field `created` (UTC); null for one without.
   */
  readonly created: number | null;
  /** The file of a template of a folder. */
  readonly file?: string;
}

/** What the page gets: the logo, every template, and notes on what could not be read. */
export interface TemplatesData {
  /** The webview URI of the logo of aantje. */
  readonly logo: string;
  readonly templates: readonly TemplateCard[];
  readonly notes: readonly string[];
}

/** The tiles of a row before anything is typed: one line of the four tiles of the page. */
export const ROW_SIZE = 4;
/** The templates created last that the list below the tiles shows. */
export const NEWEST_ROWS = 10;

/** The most cards that a search shows; a narrower search finds the others. */
export const MAX_RESULTS = 60;

/** The rows of a page of the list of Browse; a row is taller than a line, with its tags and buttons. */
export const BROWSE_PAGE_ROWS = 25;

/** Own and imported templates can be edited, exported and deleted; the others can be duplicated as own ones. */
export const isEditable = (source: TemplateSource): boolean => source === 'mine' || source === 'imported';

const byName = (a: TemplateCard, b: TemplateCard): number =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });

/**
 * The rows before anything is typed: the most used and the last used templates (a row of tiles each), and the
 * `NEWEST_ROWS` created last of every source, newest first, equal times by name (a list; a template without a time of
 * creation is left out). With no use at all, the first built-in templates are the start; an empty row is left out by
 * the page.
 */
export function templateRows(cards: readonly TemplateCard[]): {
  mostUsed: TemplateCard[];
  recent: TemplateCard[];
  newest: TemplateCard[];
  start: TemplateCard[];
} {
  const used = cards.filter(({ uses }) => uses > 0);
  return {
    mostUsed: used
      .toSorted((a, b) => b.uses - a.uses || (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || byName(a, b))
      .slice(0, ROW_SIZE),
    recent: used
      .filter(({ lastUsed }) => lastUsed !== null)
      .toSorted((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || byName(a, b))
      .slice(0, ROW_SIZE),
    newest: cards
      .filter(({ created }) => created !== null)
      .toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0) || byName(a, b))
      .slice(0, NEWEST_ROWS),
    start: used.length > 0 ? [] : cards.filter(({ source }) => source === 'builtin').slice(0, ROW_SIZE),
  };
}

/**
 * The templates that match every word of the query, in the name, a tag, the description, the SQL text or the word of
 * the source, case ignored; the best first: a word in the name counts most, then in a tag, the description, the rest.
 * Equal ones by use, then by name. Empty for an empty query.
 */
export function searchTemplates(cards: readonly TemplateCard[], query: string): TemplateCard[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return cards
    .map((card) => ({ card, score: scoreOf(card, words) }))
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score || b.card.uses - a.card.uses || byName(a.card, b.card))
    .map(({ card }) => card);
}

interface Lowered {
  readonly name: string;
  readonly tags: readonly string[];
  readonly description: string;
  readonly rest: string;
}

// The search runs at every key: the texts of a card are lowered once, while the page keeps the card.
const lowered = new WeakMap<TemplateCard, Lowered>();

function loweredOf(card: TemplateCard): Lowered {
  let known = lowered.get(card);
  if (!known) {
    known = {
      name: card.name.toLowerCase(),
      tags: card.tags.map((tag) => tag.toLowerCase()),
      description: card.description.toLowerCase(),
      rest: `${card.text}\n${SOURCE_LABEL[card.source]}`.toLowerCase(),
    };
    lowered.set(card, known);
  }
  return known;
}

/** What Browse narrows the list to besides its filter box: one tag and one source; undefined for all. */
export interface BrowseFilter {
  /** The text of the search field of the page: the words that a template must match, as the search of the tiles. */
  readonly query?: string | undefined;
  readonly tag?: string | undefined;
  readonly source?: TemplateSource | undefined;
}

/** Every tag of the templates once, case ignored, in its first spelling; sorted by name. */
export function allTags(cards: readonly TemplateCard[]): string[] {
  const tags = new Map<string, string>();
  for (const tag of cards.flatMap((card) => card.tags)) {
    if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
}

/** The sources that the templates come from, in the order of `TEMPLATE_SOURCES`. */
export const sourcesOf = (cards: readonly TemplateCard[]): TemplateSource[] =>
  TEMPLATE_SOURCES.filter((source) => cards.some((card) => card.source === source));

/** The list of Browse: every template that has the tag (case ignored) and comes from the source, sorted by name. */
export function browseTemplates(cards: readonly TemplateCard[], filter: BrowseFilter): TemplateCard[] {
  const tag = filter.tag?.toLowerCase();
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return cards
    .filter(
      (card) =>
        (tag === undefined || card.tags.some((other) => other.toLowerCase() === tag)) &&
        (filter.source === undefined || card.source === filter.source) &&
        (words.length === 0 || scoreOf(card, words) > 0),
    )
    .toSorted(byName);
}

function scoreOf(card: TemplateCard, words: readonly string[]): number {
  const { name, tags, description, rest } = loweredOf(card);
  let score = 0;
  for (const word of words) {
    const weight = name.includes(word)
      ? 8
      : tags.some((tag) => tag.includes(word))
        ? 4
        : description.includes(word)
          ? 2
          : rest.includes(word)
            ? 1
            : 0;
    if (weight === 0) return 0;
    score += weight;
  }
  return score;
}

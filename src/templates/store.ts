// Where the templates come from besides aantje itself: the own and imported ones and the use of every template, in
// the global state of VS Code (per user, for all workspaces, never synchronised), and the read-only templates of the
// folders of `aantje.templates.folders`. No VS Code API: the memento and the tokens come in.
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { messageOf } from '../errors';
import { isCount, isFiniteNumber, isObject, isOneOf, isShape, isString } from '../guards';
import type { SqlToken } from '../sql/tokens';
import { checkTemplate, fieldsOf, MAX_TEMPLATE_BYTES, normalizedText, problemText } from './model';
import type { Template } from './model';

/** The global state keys: the own and imported templates, and the use of each template by id. */
export const TEMPLATES_KEY = 'aantje.templates';
export const TEMPLATE_USES_KEY = 'aantje.templateUses';

/** The most own and imported templates that aantje keeps. */
export const MAX_STORED_TEMPLATES = 500;

/** The most `.sql` files read of one folder of `aantje.templates.folders`. */
export const MAX_FOLDER_FILES = 200;

/** The part of VS Code's `Memento` that the store uses. */
export interface TemplateMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * An own or imported template as kept: `created` is when it was kept first (saved or imported), `updated` when it was
 * saved last, in milliseconds since 1970. A save and the import of a newer version keep `created`, and it wins over the
 * field `created` of the header.
 */
export interface StoredTemplate {
  readonly id: string;
  readonly source: 'mine' | 'imported';
  readonly text: string;
  readonly created: number;
  readonly updated: number;
}

/** How often a template was used, and when last. */
export interface TemplateUse {
  readonly count: number;
  readonly last: number;
}

// `created` is not checked: a template kept before aantje stored it has none and counts from the field `created` of
// its header, else from its last save.
const isStored = isShape({
  id: isString,
  source: isOneOf('mine', 'imported'),
  text: isString,
  updated: isFiniteNumber,
}) as (value: unknown) => value is Omit<StoredTemplate, 'created'> & { readonly created?: unknown };

const isUse = isShape({ count: isCount, last: isFiniteNumber }) as (value: unknown) => value is TemplateUse;

/** What an addition did: the id of the template, or why it was not kept. */
export type Added = { readonly id: string; readonly replaced: boolean } | { readonly problem: string };

/** The own and imported templates and the use of all templates. A write that fails rejects, so the user hears of it. */
export class TemplateStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly memento: TemplateMemento,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** The own and imported templates, with the fields of their headers and the time they were kept first. */
  templates(): Template[] {
    return this.stored().map(({ id, source, text, created }) => ({
      id,
      source,
      text,
      ...fieldsOf(text),
      created,
    }));
  }

  get(id: string): StoredTemplate | undefined {
    return this.stored().find((entry) => entry.id === id);
  }

  /** Keeps a new template under a new id; refused when the store is full. */
  async add(source: StoredTemplate['source'], text: string): Promise<Added> {
    const id = this.newId();
    const problem = await this.put(id, source, text);
    return problem === undefined ? { id, replaced: false } : { problem };
  }

  /** Keeps the text of a template under its id: replaces it, or adds it (a new template saved the first time). */
  async save(id: string, source: StoredTemplate['source'], text: string): Promise<string | undefined> {
    return this.put(id, source, text);
  }

  /**
   * Keeps an imported template: it replaces an imported one of the same name, which then keeps its id and its use (an
   * imported template that was edited is one of the user's own and stays); otherwise it is added.
   */
  async addImported(text: string, name: string): Promise<Added> {
    const same = this.templates().find(
      (template) => template.source === 'imported' && template.name === name,
    );
    if (!same) return this.add('imported', text);
    const problem = await this.put(same.id, 'imported', text);
    return problem === undefined ? { id: same.id, replaced: true } : { problem };
  }

  /** Deletes a template and its use. */
  async remove(id: string): Promise<void> {
    await this.memento.update(
      TEMPLATES_KEY,
      this.stored().filter((entry) => entry.id !== id),
    );
    const { [id]: _gone, ...rest } = this.useRecord();
    await this.memento.update(TEMPLATE_USES_KEY, rest);
    this.fire();
  }

  /** The use of every template that was used on this machine, by id. */
  uses(): ReadonlyMap<string, TemplateUse> {
    return new Map(
      Object.entries(this.useRecord()).filter((entry): entry is [string, TemplateUse] => isUse(entry[1])),
    );
  }

  /** Counts a use of the template, now. */
  async used(id: string): Promise<void> {
    const before = this.uses().get(id);
    await this.memento.update(TEMPLATE_USES_KEY, {
      ...this.useRecord(),
      [id]: { count: (before?.count ?? 0) + 1, last: this.now() },
    });
    this.fire();
  }

  /** The listener hears of every change of the templates or of their use. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private async put(id: string, source: StoredTemplate['source'], text: string): Promise<string | undefined> {
    const stored = this.stored();
    const known = stored.find((entry) => entry.id === id);
    if (!known && stored.length >= MAX_STORED_TEMPLATES) {
      return `aantje keeps at most ${MAX_STORED_TEMPLATES} templates of your own. Delete some first.`;
    }
    const now = this.now();
    const entry: StoredTemplate = {
      id,
      source,
      text: normalizedText(text),
      created: known?.created ?? now,
      updated: now,
    };
    await this.memento.update(
      TEMPLATES_KEY,
      known ? stored.map((other) => (other.id === id ? entry : other)) : [...stored, entry],
    );
    this.fire();
    return undefined;
  }

  private stored(): StoredTemplate[] {
    const value = this.memento.get(TEMPLATES_KEY);
    return Array.isArray(value)
      ? value.filter(isStored).map((entry) => ({
          ...entry,
          created:
            typeof entry.created === 'number' && Number.isFinite(entry.created)
              ? entry.created
              : (fieldsOf(entry.text).created ?? entry.updated),
        }))
      : [];
  }

  private useRecord(): Record<string, unknown> {
    const value = this.memento.get(TEMPLATE_USES_KEY);
    return isObject(value) ? value : {};
  }

  private fire(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The id of the template of a file: the same for the same path, also across windows. */
export const folderTemplateId = (file: string): string =>
  `folder-${createHash('sha256').update(file).digest('hex').slice(0, 16)}`;

/**
 * The templates of the folders of `aantje.templates.folders`: the `.sql` files directly in each folder that are marked
 * as a template (`-- aantje-template: 1`); other `.sql` files are passed over. A folder or file that cannot be read,
 * or a template that aantje would refuse to keep, is left out with a note. `~` at the start means the home folder.
 */
export async function readFolderTemplates(
  folders: readonly string[],
  tokenize: (text: string) => Promise<readonly SqlToken[]>,
): Promise<{ templates: Template[]; notes: string[] }> {
  const templates: Template[] = [];
  const notes: string[] = [];
  for (const configured of new Set(folders)) {
    const folder = configured.replace(/^~(?=$|[\\/])/, homedir());
    if (!isAbsolute(folder)) {
      notes.push(`The templates folder "${configured}" is no absolute path; it is left out.`);
      continue;
    }
    let names: string[];
    try {
      names = (await readdir(folder, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.sql$/i.test(entry.name))
        .map(({ name }) => name)
        .sort();
    } catch (error) {
      notes.push(`The templates folder "${configured}" cannot be read: ${messageOf(error)}`);
      continue;
    }
    if (names.length > MAX_FOLDER_FILES) {
      notes.push(
        `The templates folder "${configured}" has more than ${MAX_FOLDER_FILES} .sql files; the first ${MAX_FOLDER_FILES} are read.`,
      );
    }
    for (const name of names.slice(0, MAX_FOLDER_FILES)) {
      const file = join(folder, name);
      const read = await folderTemplate(file, tokenize).catch(
        (error: unknown) => `cannot be read: ${messageOf(error)}`,
      );
      if (typeof read === 'string') notes.push(`${file} ${read}`);
      else if (read && !templates.some((known) => known.id === read.id)) templates.push(read);
    }
  }
  return { templates, notes };
}

// The template of one file; null for a `.sql` file that is no template, a text for why it is left out.
async function folderTemplate(
  file: string,
  tokenize: (text: string) => Promise<readonly SqlToken[]>,
): Promise<Template | string | null> {
  if ((await stat(file)).size > MAX_TEMPLATE_BYTES + 3) {
    return `is larger than ${MAX_TEMPLATE_BYTES / 1024} KB and is left out.`;
  }
  const text = normalizedText(await readFile(file, 'utf8'));
  const check = checkTemplate(text, await tokenize(text));
  if (!check.marked) return null;
  if (check.problems.length > 0) return `is left out: ${problemText(check.problems)}`;
  return { id: folderTemplateId(file), source: 'folder', text, file, ...check.fields };
}

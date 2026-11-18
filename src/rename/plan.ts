// The rename of a table, a view or a column of a table together with the views and macros that name it: which SQL
// changes, at which tokens, and what cannot be changed safely. DuckDB parses and tokenizes; nothing runs. The new SQL of
// each view and macro is parsed again and read with the names after the rename, so a change that would make a text read
// something else, or break it, is left out and listed instead. A column rename follows the column through the views at
// any depth: a view column that carries the name of the renamed column (`SELECT a`, `*`) is renamed with it.
import { foldIdentifier } from '../catalog/ddl';
import { groupBy } from '../order';
import type { MacroInfo, ViewInfo } from '../catalog/model';
import { mentions as namesWord } from '../ddl-script/names';
import { indexNodes, macroOf, relationOf } from '../dependencies/graph';
import type { CatalogObjects, DependencyGraph, DependencyNode, GraphKey, Names } from '../dependencies/graph';
import { itemNames, lineageEnv, readingMacros } from '../dependencies/lake-lineage';
import { bodyLineage } from '../dependencies/lineage';
import type { BodyLineage, LineageEnv } from '../dependencies/lineage';
import { dependencyOrder } from '../dependencies/order';
import type { SqlParser, SqlTokenizer } from '../dependencies/parser';
import { parsedStatement } from '../dependencies/references';
import { unquote, isWord } from '../sql/tokens';
import { editedText } from './edit';
import type { NameEdit } from './edit';

/** What is renamed: a table or view, or a top-level column of a table; `node` is an index into the graph. */
export type RenameTarget =
  | { readonly kind: 'table' | 'view'; readonly node: number }
  | { readonly kind: 'column'; readonly node: number; readonly column: string };

/** A view or macro with its changed SQL. */
export type RenameChange =
  | { readonly kind: 'view'; readonly node: number; readonly view: ViewInfo }
  | { readonly kind: 'macro'; readonly node: number; readonly macro: MacroInfo };

/** Why a view or macro is left as it is. */
export type LeftReason = 'unread' | 'dynamic' | 'fixed' | 'unresolved' | 'changes' | 'captures' | 'notFound';

export interface LeftAlone {
  readonly node: number;
  readonly reason: LeftReason;
}

/** A column of a view that gets another name with the rename; `star` when the view's SQL stays as it is. */
export interface RenamedColumn {
  readonly node: number;
  readonly from: string;
  readonly to: string;
  readonly star: boolean;
}

export interface RenamePlan {
  /** In the order to run: each after what it reads. */
  readonly changes: readonly RenameChange[];
  readonly left: readonly LeftAlone[];
  readonly columns: readonly RenamedColumn[];
}

export interface RenameInput {
  readonly objects: CatalogObjects;
  /** Built from `objects` with the columns of the tables, without a limit. */
  readonly graph: DependencyGraph;
  readonly target: RenameTarget;
  readonly name: string;
}

type Parser = Pick<SqlParser, 'serialize' | 'names'> & SqlTokenizer;

// One text of a view or macro as it is parsed: a scalar macro as the item of a SELECT.
interface Body {
  readonly text: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly params: ReadonlySet<string>;
  readonly aliases: readonly string[];
}

// What a rename has done so far: the renamed table or view, the renamed columns of tables and views by `columnKey`,
// the columns of the objects that got new ones, and the objects and the index of their names after the rename.
interface State {
  readonly relation: { readonly node: number; readonly old: string; readonly name: string } | undefined;
  readonly renamed: Map<string, string>;
  readonly after: Map<number, readonly string[]>;
  readonly nodes: readonly DependencyNode[];
  readonly names: Names;
}

interface Owner {
  readonly view: ViewInfo | undefined;
  readonly macro: MacroInfo | undefined;
  readonly bodies: readonly Body[];
}

// The reasons under Not followed that leave a text unread.
const UNREAD = new Set(['dialect', 'syntax', 'unsupported', 'tooLong']);

const columnKey = (node: number, name: string): string => `${node}\u0000${foldIdentifier(name)}`;

function ownerOf(node: DependencyNode | undefined, objects: CatalogObjects): Owner {
  if (node?.kind === 'view') {
    const view = objects.views.find(({ id }) => id === node.id);
    const bodies = view
      ? [{ text: view.sql, prefix: '', suffix: '', params: new Set<string>(), aliases: view.columnAliases }]
      : [];
    return { view, macro: undefined, bodies };
  }
  const macro = node && node.kind !== 'table' ? objects.macros.find(({ id }) => id === node.id) : undefined;
  const scalar = macro?.kind === 'scalar';
  return {
    view: undefined,
    macro,
    bodies: (macro?.implementations ?? []).map(({ sql, parameters }) => ({
      text: sql,
      prefix: scalar ? 'SELECT (' : '',
      suffix: scalar ? '\n)' : '',
      params: new Set(parameters.map(({ name }) => foldIdentifier(name))),
      aliases: [],
    })),
  };
}

// A body, parsed and read with `env`; undefined when DuckDB cannot read it.
async function readBody(
  text: string,
  aliases: readonly string[],
  parser: Parser,
  env: (names: ReadonlyMap<object, string | undefined>) => LineageEnv,
): Promise<BodyLineage | undefined> {
  const parsed = parsedStatement(await parser.serialize(text));
  if ('reason' in parsed) return undefined;
  try {
    return bodyLineage(parsed.statement, env(await itemNames([parsed.statement], parser)), aliases);
  } catch {
    return undefined;
  }
}

// What a text resolves after a change that should change nothing of what it reads.
const relationsOf = (lineage: BodyLineage): string =>
  lineage.mentions
    .flatMap((mention) => (mention.kind === 'relation' ? [mention.node] : []))
    .sort((a, b) => a - b)
    .join(',');

const unresolvedCount = (lineage: BodyLineage): number =>
  lineage.mentions.filter(({ kind }) => kind === 'unresolved').length;

// A change made it worse: no column list any more, other columns, a name two relations offer, a name nothing has.
function worse(before: BodyLineage, after: BodyLineage): boolean {
  return (
    (before.columns !== undefined && after.columns === undefined) ||
    (before.columns?.length ?? 0) !== (after.columns?.length ?? 0) ||
    after.ambiguous > before.ambiguous ||
    unresolvedCount(after) > unresolvedCount(before)
  );
}

class Planner {
  private readonly nodes: readonly DependencyNode[];
  private readonly names: Names;
  private readonly reading: ReadonlySet<number>;
  private readonly columnsBefore = new Map<number, string[]>();
  // What each object reads or calls, and what reads or calls it.
  private readonly uses: ReadonlyMap<number, number[]>;
  private readonly users: ReadonlyMap<number, number[]>;
  readonly changes: RenameChange[] = [];
  readonly left: LeftAlone[] = [];
  readonly columns: RenamedColumn[] = [];

  constructor(
    private readonly input: RenameInput,
    private readonly parser: Parser,
  ) {
    const { graph } = input;
    this.nodes = graph.nodes;
    this.names = indexNodes(graph.nodes);
    this.reading = readingMacros(graph.nodes, graph.edges);
    this.uses = groupBy(
      graph.edges,
      ({ from }) => from,
      ({ to }) => to,
    );
    this.users = groupBy(
      graph.edges,
      ({ to }) => to,
      ({ from }) => from,
    );
    for (const { node, name } of graph.lineage?.columns ?? []) {
      this.columnsBefore.set(node, [...(this.columnsBefore.get(node) ?? []), name]);
    }
  }

  // The lake as a body reads it: before the rename, or after it (`state`), with the names and columns of then.
  env(
    node: number,
    params: ReadonlySet<string>,
    state: State | undefined,
  ): (items: ReadonlyMap<object, string | undefined>) => LineageEnv {
    const names = state?.names ?? this.names;
    const columns = (at: number): readonly string[] | undefined => state?.after.get(at) ?? this.before(at);
    const lookup = {
      nodes: state?.nodes ?? this.nodes,
      relation: (owner: number, reference: Parameters<typeof relationOf>[2]) => {
        const at = this.nodes[owner];
        return at && relationOf(names, at, reference);
      },
      macro: (owner: number, reference: Parameters<typeof macroOf>[2]) => {
        const at = this.nodes[owner];
        return at && macroOf(this.names, at, reference);
      },
    };
    return (items) => lineageEnv(lookup, node, columns, items, this.reading, params);
  }

  before(node: number): readonly string[] | undefined {
    return this.columnsBefore.get(node);
  }

  // The tokens of the texts that the parser could not read, or that look a name up at run time, which may name `old`.
  async unread(old: readonly string[]): Promise<void> {
    const { graph, objects } = this.input;
    const unread = new Set(
      graph.unresolved.filter(({ reason }) => UNREAD.has(reason)).map(({ node }) => node),
    );
    const dynamic = new Set(
      graph.unresolved.filter(({ reason }) => reason === 'dynamic').map(({ node }) => node),
    );
    const folded = new Set(old.map(foldIdentifier));
    for (const node of [...new Set([...unread, ...dynamic])].sort((a, b) => a - b)) {
      for (const body of ownerOf(this.nodes[node], objects).bodies) {
        const tokens = await this.parser.tokenize(body.text);
        const named = unread.has(node)
          ? tokens.some((token) => isWord(token) && folded.has(foldIdentifier(unquote(token.word))))
          : tokens.some(
              ({ type, word }) => type === 'STRING_LITERAL' && old.some((name) => namesWord(word, name)),
            );
        if (named) {
          this.leave(node, unread.has(node) ? 'unread' : 'dynamic');
          break;
        }
      }
    }
  }

  leave(node: number, reason: LeftReason): void {
    if (!this.left.some((entry) => entry.node === node)) this.left.push({ node, reason });
  }

  change(node: number, owner: Owner, texts: readonly string[]): void {
    if (owner.view) {
      this.changes.push({ kind: 'view', node, view: { ...owner.view, sql: texts[0] ?? owner.view.sql } });
    } else if (owner.macro) {
      const implementations = owner.macro.implementations.map((implementation, index) => ({
        ...implementation,
        sql: texts[index] ?? implementation.sql,
      }));
      this.changes.push({ kind: 'macro', node, macro: { ...owner.macro, implementations } });
    }
  }

  /**
   * Every view and macro that uses `start` at any depth, after what they read, and `more`: the names of a renamed
   * table or view change where they name it, and the names of renamed columns where they name those; a view column
   * that changes its name with it is renamed for the views after it.
   */
  async follow(start: number, state: State, more: ReadonlySet<number> = new Set()): Promise<void> {
    const { graph } = this.input;
    const reached = new Set<number>(more);
    for (let level = [start], seen = new Set([start]); level.length > 0;) {
      const next = [...new Set(level.flatMap((node) => this.users.get(node) ?? []))];
      level = next.filter((node) => !seen.has(node));
      for (const node of level) {
        seen.add(node);
        reached.add(node);
      }
    }
    reached.delete(start);
    const keyOf = (node: number): GraphKey => this.nodes[node] ?? { kind: 'view', id: -1 };
    for (const node of dependencyOrder(
      [...reached].sort((a, b) => a - b),
      keyOf,
      graph,
      'usedFirst',
    )) {
      await this.one(node, state);
    }
  }

  // The names of the renamed object or columns that one view or macro uses, the new names, and the check of them.
  private async one(node: number, state: State): Promise<void> {
    const owner = ownerOf(this.nodes[node], this.input.objects);
    const reads = new Set(this.uses.get(node));
    const user = state.relation !== undefined && reads.has(state.relation.node);
    const old = new Set(
      [...state.renamed.keys()].flatMap((key) => {
        const [at = '', name = ''] = key.split('\u0000');
        return reads.has(Number(at)) ? [name] : [];
      }),
    );
    const texts: string[] = [];
    let outputs: readonly [BodyLineage, BodyLineage] | undefined;
    let changed = false;
    for (const body of owner.bodies) {
      const done = await this.body(node, body, state, old);
      if (typeof done === 'string') return this.leave(node, done === 'changes' && !user ? 'captures' : done);
      texts.push(done.text);
      changed ||= done.changed;
      outputs = [done.before, done.after];
    }
    if (changed) this.change(node, owner, texts);
    if (this.nodes[node]?.kind !== 'view' || !outputs) return;
    const [before, after] = outputs;
    const names = (after.columns ?? []).map((column) => column.name);
    (before.columns ?? []).forEach((column, index) => {
      const to = names[index];
      if (to === undefined || to === column.name) return;
      state.renamed.set(columnKey(node, column.name), to);
      this.columns.push({ node, from: column.name, to, star: !changed });
    });
    state.after.set(node, names);
  }

  // One text: read it, change its names, read it again with the names after the rename; a reason when it is left.
  private async body(
    node: number,
    body: Body,
    state: State,
    old: ReadonlySet<string>,
  ): Promise<{ text: string; changed: boolean; before: BodyLineage; after: BodyLineage } | LeftReason> {
    const text = `${body.prefix}${body.text}${body.suffix}`;
    const before = await readBody(text, body.aliases, this.parser, this.env(node, body.params, undefined));
    if (!before) return 'unread';
    // Its columns cannot be told (`*` over a table function): whether the rename changes them is unknown.
    if (!before.columns && old.size > 0) return 'unresolved';
    const edits = editsOf(before, state, old);
    if (typeof edits === 'string') return edits;
    const edited =
      edits.length === 0 ? text : await editedText(text, edits, (sql) => this.parser.tokenize(sql));
    if (edited === undefined) return 'notFound';
    const after = await readBody(edited, body.aliases, this.parser, this.env(node, body.params, state));
    if (!after || worse(before, after) || relationsOf(after) !== relationsOf(before)) return 'changes';
    return {
      text: edited.slice(body.prefix.length, edited.length - body.suffix.length),
      changed: edits.length > 0,
      before,
      after,
    };
  }
}

// The places of a text that name the renamed table or view, or a renamed column; a reason when one cannot change.
function editsOf(lineage: BodyLineage, state: State, old: ReadonlySet<string>): NameEdit[] | LeftReason {
  const edits: NameEdit[] = [];
  const { relation } = state;
  for (const mention of lineage.mentions) {
    const renamed =
      mention.kind === 'column' || mention.kind === 'fixed'
        ? state.renamed.get(columnKey(mention.key.node, mention.key.name))
        : undefined;
    if (mention.kind === 'fixed' && renamed !== undefined) return 'fixed';
    if (mention.kind === 'unresolved' && old.has(foldIdentifier(mention.name))) return 'unresolved';
    if (mention.kind === 'column' && renamed !== undefined) {
      edits.push({ location: mention.location, part: mention.part, from: mention.key.name, to: renamed });
    }
    if ((mention.kind === 'relation' || mention.kind === 'qualifier') && mention.node === relation?.node) {
      const part = mention.kind === 'relation' ? -1 : mention.part;
      edits.push({ location: mention.location, part, from: relation.old, to: relation.name });
    }
  }
  return edits;
}

/** What a rename changes in the views and macros of the lake, and what it leaves for the user to check. */
export async function planRename(input: RenameInput, parser: Parser): Promise<RenamePlan> {
  const planner = new Planner(input, parser);
  const { target, graph, name } = input;
  const nodes = graph.nodes;
  if (target.kind === 'column') {
    const columns = (planner.before(target.node) ?? []).map((own) =>
      foldIdentifier(own) === foldIdentifier(target.column) ? name : own,
    );
    await planner.follow(target.node, {
      relation: undefined,
      renamed: new Map([[columnKey(target.node, target.column), name]]),
      after: new Map([[target.node, columns]]),
      nodes,
      names: indexNodes(nodes),
    });
    await planner.unread([target.column]);
  } else {
    const old = nodes[target.node]?.name ?? '';
    const renamedNodes = nodes.map((node, index) => (index === target.node ? { ...node, name } : node));
    // Views and macros whose names may read the renamed object afterwards: they read an object of the new name, in
    // `main` or elsewhere, or name one that the lake does not have.
    const fold = foldIdentifier(name);
    const near = new Set([
      ...graph.edges
        .filter(({ to }) => foldIdentifier(nodes[to]?.name ?? '') === fold)
        .map(({ from }) => from),
      ...graph.broken
        .filter((broken) => broken.kind === 'relation' && foldIdentifier(broken.name) === fold)
        .map(({ from }) => from),
    ]);
    await planner.follow(
      target.node,
      {
        relation: { node: target.node, old, name },
        renamed: new Map(),
        after: new Map(),
        nodes: renamedNodes,
        names: indexNodes(renamedNodes),
      },
      near,
    );
    await planner.unread([old]);
  }
  const changes = dependencyOrder(
    planner.changes,
    (change) => nodes[change.node] ?? { kind: 'view', id: -1 },
    graph,
    'usedFirst',
  );
  return { changes, left: planner.left, columns: planner.columns };
}

import { SMALL_FILE_BYTES } from '../catalog/thresholds';
import { count, files, formatBytes, formatUtc, groupedPlural, tableLabel } from '../shell/model';
import { lakeWide } from '../shell/scope';
import { floorText, rewriteFloor, advisorShareText, sizeText } from './model';
import type { AdvisorData, AdvisorTable, FileMeasure } from './model';

type Level = 'low' | 'medium' | 'high';

// How a table is named in a title: plain on the page, as a code span in the document.
type NameOf = (table: AdvisorTable) => string;

/** The script a recommendation opens; the Maintenance menu has the same entries. */
export type RecommendationKind = 'expire' | 'cleanup' | 'orphans' | 'merge' | 'rewrite' | 'flush';

export interface Recommendation {
  /** `cleanup`, `merge:12`: the kind, and the catalog id of the table where it concerns one. */
  readonly id: string;
  readonly kind: RecommendationKind;
  readonly table?: AdvisorTable;
  readonly title: string;
  /** One paragraph each. */
  readonly explanation: readonly string[];
  readonly figures: readonly (readonly [label: string, value: string])[];
  readonly impact: Level;
  /** How much the user has to do or check. */
  readonly effort: Level;
  /** What can go wrong, or what cannot be undone. */
  readonly risk: Level;
  /** The gain in the unit of the kind; among equal kinds and levels the larger comes first. */
  readonly weight: number;
}

// Equal in impact, risk and effort: the space that is freed comes first, then the speed of reads.
const KIND_ORDER: readonly RecommendationKind[] = [
  'cleanup',
  'orphans',
  'expire',
  'rewrite',
  'merge',
  'flush',
];

// The recommendations about snapshots and files act on the whole lake, whatever the scope of the report.
const LAKE_KINDS: ReadonlySet<RecommendationKind> = new Set(['expire', 'cleanup', 'orphans']);

const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

// The tiers of impact; the first of bytes, files, snapshots or rows that reaches one decides.
const TIERS = {
  bytes: [100 * 1024 * 1024, 1024 * 1024 * 1024],
  files: [100, 1000],
  snapshots: [100, 1000],
  rows: [100_000, 1_000_000],
} as const;

function tier(value: number, [medium, high]: readonly [number, number]): Level {
  return value >= high ? 'high' : value >= medium ? 'medium' : 'low';
}

const higher = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

/** `high ▲▲▲`: the word and the symbol both say it. */
export const levelText = (level: Level): string =>
  `${level} ${level === 'high' ? '▲▲▲' : level === 'medium' ? '▲▲△' : '▲△△'}`;

/** Risk reads `⚠ high` for the levels that need a second look. */
export const riskText = (level: Level): string =>
  level === 'low' ? levelText(level) : `⚠ ${levelText(level)}`;

function measureImpact(measure: FileMeasure): Level {
  return higher(tier(measure.bytes, TIERS.bytes), tier(measure.files, TIERS.files));
}

function cleanup(data: AdvisorData, measure: FileMeasure): Recommendation[] {
  if (measure.files === 0) return [];
  const waiting = Math.max(0, data.scheduled.count - measure.files);
  return [
    {
      id: 'cleanup',
      kind: 'cleanup',
      title: `Clean up ${files(measure.files)} that no snapshot needs (${sizeText(measure)})`,
      explanation: [
        'Expiring snapshots and merging or rewriting files leave the replaced files in the store. DuckLake lists them as scheduled for deletion and deletes them only when Clean Up Old Files runs. No query reads them.',
        `The dry run lists the files that are old enough by the rule of the lake.${waiting > 0 ? ` ${groupedPlural(waiting, 'more file is', 'more files are')} scheduled but too young.` : ''} Deleting them frees the space in the store and cannot be undone.`,
      ],
      figures: [
        ['Files', count(measure.files)],
        ['Size', sizeText(measure)],
        ['Scheduled but too young', count(waiting)],
      ],
      impact: measureImpact(measure),
      effort: 'low',
      risk: 'medium',
      weight: measure.bytes || measure.files,
    },
  ];
}

function orphans(measure: FileMeasure): Recommendation[] {
  if (measure.files === 0) return [];
  return [
    {
      id: 'orphans',
      kind: 'orphans',
      title: `Delete ${files(measure.files)} that the catalog does not know (${sizeText(measure)})`,
      explanation: [
        'These files are in the data path, but no table, no snapshot and no scheduled deletion refers to them: leftovers of a write that failed or of files copied there.',
        'A writer that is running at the moment, such as Sail, may have uploaded files that it has not committed yet; deleting them breaks its commit. Run it when nothing writes, or keep older_than later than the longest write.',
      ],
      figures: [
        ['Files', count(measure.files)],
        ['Size', sizeText(measure)],
      ],
      impact: measureImpact(measure),
      effort: 'medium',
      risk: 'high',
      weight: measure.bytes || measure.files,
    },
  ];
}

function expire(
  data: AdvisorData,
  snapshots: { expiring: number; oldest: string | null; newest: string | null; total: number },
): Recommendation[] {
  if (snapshots.expiring === 0) return [];
  return [
    {
      id: 'expire',
      kind: 'expire',
      title: `Expire ${groupedPlural(snapshots.expiring, 'snapshot', 'snapshots')} older than ${data.policy.expire.text}`,
      explanation: [
        'An expired snapshot is gone from the catalog: there is no time travel to it, and no way back. The files that only expired snapshots needed are scheduled for deletion; Clean Up Old Files frees them, so run it afterwards.',
        `The dry run lists ${count(snapshots.expiring)} of the ${count(snapshots.total)} snapshots${snapshots.oldest === null || snapshots.newest === null ? '' : `, from ${formatUtc(snapshots.oldest)} to ${formatUtc(snapshots.newest)}`}. The newest snapshot is never expired.`,
      ],
      figures: [
        ['Snapshots to expire', count(snapshots.expiring)],
        ['Snapshots in the catalog', count(snapshots.total)],
        ['Older than', data.policy.expire.text],
        ['Oldest', snapshots.oldest === null ? '–' : formatUtc(snapshots.oldest)],
        ['Newest', snapshots.newest === null ? '–' : formatUtc(snapshots.newest)],
      ],
      impact: tier(snapshots.expiring, TIERS.snapshots),
      effort: 'low',
      risk: 'high',
      weight: snapshots.expiring,
    },
  ];
}

function merge(data: AdvisorData, name: NameOf): Recommendation[] {
  return data.merge.map(({ table, files: total, smallFiles, smallBytes, estimatedAfter }) => ({
    id: `merge:${table.id}`,
    kind: 'merge',
    table,
    title: `Merge ${groupedPlural(smallFiles, 'small file', 'small files')} of ${name(table)}`,
    explanation: [
      `${count(smallFiles)} of its ${groupedPlural(total, 'data file', 'data files')} are below ${formatBytes(SMALL_FILE_BYTES)}. Many small files make every scan open and read many files; merging adjacent files joins them.`,
      `The number after the merge is an estimate: the small files add up to ${formatBytes(smallBytes)} and become files of about ${formatBytes(data.policy.target.bytes)}, the other files stay. A merge joins only adjacent files of one partition and leaves a file with a delete file alone, so the real number can be higher. The replaced files wait for Clean Up Old Files.`,
    ],
    figures: [
      ['Data files', count(total)],
      ['Small files', count(smallFiles)],
      ['Estimated after the merge', `about ${count(estimatedAfter)}`],
      ['Estimated fewer files', `about ${count(total - estimatedAfter)}`],
    ],
    impact: tier(total - estimatedAfter, TIERS.files),
    effort: 'low',
    risk: 'low',
    weight: total - estimatedAfter,
  }));
}

function rewrite(data: AdvisorData, name: NameOf): Recommendation[] {
  const threshold = advisorShareText(data.policy.rewrite.share);
  const floor = floorText(rewriteFloor(data.policy));
  return data.rewrite.map((item) => {
    const { table, files: heavy, atThreshold, records, deleted, sizeBytes } = item;
    const reclaim = records === 0 ? 0 : Math.round((sizeBytes * deleted) / records);
    const due = atThreshold > 0;
    return {
      id: `rewrite:${table.id}`,
      kind: 'rewrite',
      table,
      title: due
        ? `Rewrite ${groupedPlural(atThreshold, 'data file', 'data files')} of ${name(table)} in which ${threshold} of the rows are deleted`
        : `Data files of ${name(table)} have lost at least ${floor} of their rows`,
      explanation: [
        `${groupedPlural(heavy, 'data file has', 'data files have')} at least ${floor} of the rows deleted: ${count(deleted)} of ${count(records)} rows (${advisorShareText(deleted / records)}). A delete does not shrink the file; a delete file marks the rows, and every read has to apply it. Rewriting the file removes the rows and the delete file.`,
        due
          ? `Rewrite Data Files rewrites a file from ${threshold} deleted (${data.policy.rewrite.source === 'option' ? 'the option rewrite_delete_threshold of the lake' : 'the default of DuckLake'}); ${groupedPlural(atThreshold, 'file reaches', 'files reach')} it. About ${formatBytes(reclaim)} of the ${formatBytes(sizeBytes)} are deleted rows (an estimate from the shares). The replaced files wait for Clean Up Old Files.`
          : `Rewrite Data Files rewrites a file only from ${threshold} deleted, and none reaches it, so the plain script changes nothing. Add delete_threshold => 0.5 to the call, or set the option rewrite_delete_threshold, to rewrite these files.`,
      ],
      figures: [
        [`Files with at least ${floor} deleted`, count(heavy)],
        ['Files a rewrite rewrites', count(atThreshold)],
        ['Deleted rows', `${count(deleted)} of ${count(records)} (${advisorShareText(deleted / records)})`],
        ['Size of these files', formatBytes(sizeBytes)],
        ['Estimated deleted share of the size', `about ${formatBytes(reclaim)}`],
      ],
      impact: due ? tier(reclaim, TIERS.bytes) : 'low',
      effort: due ? 'low' : 'medium',
      risk: 'low',
      weight: reclaim,
    };
  });
}

function flush(data: AdvisorData, name: NameOf): Recommendation[] {
  return data.flush.map(({ table, rows }) => ({
    id: `flush:${table.id}`,
    kind: 'flush',
    table,
    title: `Flush ${groupedPlural(rows, 'inlined row', 'inlined rows')} of ${name(table)} to Parquet`,
    explanation: [
      'Small inserts stay inside the catalog database while they are below the inlining row limit of the table; nothing writes them out by itself. A large amount makes the catalog heavier and reads slower.',
      'Flush Inlined Data writes the rows to a Parquet file. The inlined rows stay in the catalog until they expire with their snapshots.',
    ],
    figures: [['Inlined rows', count(rows)]],
    impact: tier(rows, TIERS.rows),
    effort: 'low',
    risk: 'low',
    weight: rows,
  }));
}

/** The advice, most worthwhile first: impact, then risk, effort, kind and gain. `name` writes a table in a title. */
export function recommendationsOf(data: AdvisorData, name: NameOf = tableLabel): Recommendation[] {
  const all = [
    ...(data.cleanup.state === 'measured' ? cleanup(data, data.cleanup.value) : []),
    ...(data.orphans.state === 'measured' ? orphans(data.orphans.value) : []),
    ...(data.expiry.state === 'measured'
      ? expire(data, { ...data.expiry.value, total: data.expiry.value.snapshots })
      : []),
    ...merge(data, name),
    ...rewrite(data, name),
    ...flush(data, name),
  ];
  return all
    .map((item) => (LAKE_KINDS.has(item.kind) ? { ...item, title: lakeWide(data.scope, item.title) } : item))
    .toSorted(
      (a, b) =>
        RANK[b.impact] - RANK[a.impact] ||
        RANK[a.risk] - RANK[b.risk] ||
        RANK[a.effort] - RANK[b.effort] ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        b.weight - a.weight ||
        a.id.localeCompare(b.id, 'en', { numeric: true }),
    );
}

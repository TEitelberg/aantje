import type { ConnectionProfile } from '../connections/profile';
import type { CatalogProperties, MetadataEntry } from '../catalog/model';
import { count, formatUtc } from '../shell/model';
import type { Card } from '../shell/model';

/** The actions of the page that the extension may offer; the report offers those that the data names. */
export const PROPERTIES_ACTIONS = ['showStorage'] as const;
export type PropertiesActionId = (typeof PROPERTIES_ACTIONS)[number];

/** What the extension sends to the page. */
export interface PropertiesData {
  readonly connection: string;
  readonly properties: CatalogProperties;
  /** The actions the page shows as buttons, and the only ones the extension runs. */
  readonly actions: readonly PropertiesActionId[];
}

/** What the user chose on the page: the text of the filter box. */
export interface PropertiesView {
  readonly filter: string;
}

/** How many metadata entries the page and the document list; the filter reaches the others. */
export const METADATA_ROWS = 500;

/** `global`, `table 10`: where a metadata entry applies. */
export const scopeText = ({ scope, scopeId }: Pick<MetadataEntry, 'scope' | 'scopeId'>): string =>
  scope === null ? 'global' : scopeId === null ? scope : `${scope} ${scopeId}`;

/** The entries with the text in the key, value or scope (`table 10`), ignoring case; all for an empty filter. */
export function matchingMetadata(metadata: readonly MetadataEntry[], filter: string): MetadataEntry[] {
  const wanted = filter.trim().toLowerCase();
  return metadata.filter(
    (entry) =>
      wanted === '' ||
      [entry.key, entry.value, scopeText(entry)].some((text) => text.toLowerCase().includes(wanted)),
  );
}

const NOT_SET = 'not set';

/** One line of the summary of the catalog. */
export interface SummaryLine {
  readonly label: string;
  readonly value: string;
  /** The value is text of the catalog, which the document writes as code. */
  readonly fromCatalog: boolean;
  /** Only in the document: the page shows the data path in the metadata table, not as a card. */
  readonly documentOnly?: boolean;
}

/** The summary that the cards of the page and the table of the document both show. */
export function propertiesSummary(properties: CatalogProperties): SummaryLine[] {
  const time = (value: string | null): string => (value === null ? 'none' : formatUtc(value));
  const fromCatalog = (label: string, value: string | null, documentOnly = false): SummaryLine => ({
    label,
    value: value ?? NOT_SET,
    fromCatalog: value !== null,
    ...(documentOnly ? { documentOnly } : {}),
  });
  return [
    fromCatalog('DuckLake version', properties.specVersion),
    fromCatalog('Created by', properties.createdBy),
    fromCatalog('Data path', properties.dataPath, true),
    { label: 'Encrypted', value: properties.encrypted ? 'yes' : 'no', fromCatalog: false },
    { label: 'Snapshots', value: count(properties.snapshotCount), fromCatalog: false },
    { label: 'First snapshot', value: time(properties.firstSnapshotTime), fromCatalog: false },
    { label: 'Latest snapshot', value: time(properties.latestSnapshotTime), fromCatalog: false },
  ];
}

export function propertiesCards(properties: CatalogProperties): Card[] {
  return propertiesSummary(properties)
    .filter((line) => line.documentOnly !== true)
    .map(({ label, value }) => ({ label, value, severity: 'ok' }));
}

/** The Properties report of a connection, as the commands that offer it use it. */
export interface PropertiesReport {
  /** Reads the properties of the connection and shows them in its panel. */
  show(profile: ConnectionProfile): Promise<void>;
  dispose(): void;
}

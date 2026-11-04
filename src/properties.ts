import type { CatalogProperties } from './catalog/model';
import { capRows, code, markdownTable, reportTitle } from './markdown';
import { METADATA_ROWS, matchingMetadata, propertiesSummary, scopeText } from './properties-report/model';

/** The Markdown of a connection's Properties document: catalog summary and `ducklake_metadata` rows; all values are escaped. */
export function propertiesMarkdown(
  connectionName: string,
  properties: CatalogProperties,
  filter = '',
): string {
  const summary = propertiesSummary(properties).map(({ label, value, fromCatalog }) => [
    label,
    fromCatalog ? code(value) : value,
  ]);
  const matching = matchingMetadata(properties.metadata, filter);
  const { shown, omitted } = capRows(matching, METADATA_ROWS);
  const metadata = shown.map((entry) => [
    code(entry.key),
    code(entry.value),
    entry.scope === null ? 'global' : code(scopeText(entry)),
  ]);
  return [
    reportTitle('Properties of', connectionName),
    '',
    ...markdownTable(['Property', 'Value'], summary),
    '',
    '## Metadata',
    '',
    ...(filter.trim() === ''
      ? []
      : [`Filter: ${code(filter)}. ${matching.length} of ${properties.metadata.length} entries match.`, '']),
    ...markdownTable(['Key', 'Value', 'Scope'], metadata),
    ...omitted,
    '',
  ].join('\n');
}

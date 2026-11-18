import type { ReportPalette } from '../shell/house-colors';
import type { PointKind } from './model';

/**
 * The colour of a kind of change in the charts: the first four colours of aantje, maintenance in the muted colour. A
 * chart that marks the kinds by shape too says so with them.
 */
export function colorOf(kind: PointKind, palette: ReportPalette): string {
  switch (kind) {
    case 'insert':
      return palette.series[0];
    case 'update':
      return palette.series[1];
    case 'delete':
      return palette.series[2];
    case 'ddl':
      return palette.series[3];
    case 'maintenance':
      return palette.muted;
  }
}

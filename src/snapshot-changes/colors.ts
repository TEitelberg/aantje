import type { Palette } from '../shell/palette';
import type { PointKind } from './model';

/** The colour of a kind of change in the charts; a chart that marks the kinds by shape too says so with them. */
export function colorOf(kind: PointKind, palette: Palette): string {
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
      return palette.foreground;
  }
}

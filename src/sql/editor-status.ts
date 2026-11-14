// The status bar item and the session menu of a SQL editor, as text.
import type { SessionMode, TransactionState } from './session';

/** The status bar text of an associated editor, e.g. `$(aantje-duck) Fixture · read/write`, plus the transaction state. */
export function queryStatusContent(state: {
  readonly connectionName: string;
  readonly mode: SessionMode;
  readonly inTransaction: TransactionState;
}): { text: string; tooltip: string } {
  const mode = state.mode === 'read-only' ? 'read-only' : 'read/write';
  const transaction = state.inTransaction === 'none' ? '' : ` · transaction ${state.inTransaction}`;
  const note =
    state.inTransaction === 'none'
      ? ''
      : ` A transaction is ${state.inTransaction}; closing the editor rolls it back.`;
  return {
    text: `$(aantje-duck) ${state.connectionName} · ${mode}${transaction}`,
    tooltip: `The SQL session of this editor runs on ${state.connectionName} (${mode}).${note} Click for the session menu.`,
  };
}

type QueryMenuAction = 'select' | 'toggle' | 'cancel' | 'close';

/** The menu entries behind the editor's status bar item. */
export function queryMenuItems(state: {
  readonly mode: SessionMode;
  readonly switchable: boolean;
  readonly running: boolean;
  readonly sessionOpen: boolean;
}): { label: string; action: QueryMenuAction }[] {
  return [
    { label: 'Select Connection...', action: 'select' as const },
    ...(state.switchable
      ? [
          {
            label:
              state.mode === 'read-only' ? 'Switch to a Read/Write Session' : 'Switch to a Read-only Session',
            action: 'toggle' as const,
          },
        ]
      : []),
    ...(state.running ? [{ label: 'Cancel Query', action: 'cancel' as const }] : []),
    ...(state.sessionOpen && !state.running ? [{ label: 'Close Session', action: 'close' as const }] : []),
  ];
}

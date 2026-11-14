import type { ConnectionState } from './tree/refs';

/** The tree's state of one connection, plus the name to show. */
export interface StatusBarState extends ConnectionState {
  readonly connectionName: string;
}

interface StatusBarContent {
  /** May contain codicons (`$(name)`). */
  readonly text: string;
  readonly tooltip: string;
}

/** Text and tooltip of the status bar item; the caller decides whether a connection shows. */
export function statusBarContent(state: StatusBarState): StatusBarContent {
  const name = state.connectionName;
  switch (state.status) {
    case 'connecting':
      return { text: `$(sync~spin) ${name} · connecting…`, tooltip: `Connecting to ${name}…` };
    case 'disconnected':
      return { text: `$(debug-disconnect) ${name} · disconnected`, tooltip: `${name} is not connected.` };
    case 'error':
      return {
        text: `$(error) ${name} · connection failed`,
        tooltip: `The connection to ${name} failed. See the "aantje" output channel for details.`,
      };
    case 'connected':
      return connectedContent(name, state);
  }
}

/** The connection for node-less commands: the one in use unless disconnected, else the first open, else the first. */
export function activeProfile<Profile extends { readonly id: string }>(
  profiles: readonly Profile[],
  inUse: string | undefined,
  statusOf: (profile: Profile) => ConnectionState['status'],
): Profile | undefined {
  return (
    profiles.find((profile) => profile.id === inUse && statusOf(profile) !== 'disconnected') ??
    profiles.find((profile) => statusOf(profile) === 'connected') ??
    profiles[0]
  );
}

function connectedContent(name: string, state: StatusBarState): StatusBarContent {
  const latest = state.latestSnapshot === undefined ? '' : ` (@${state.latestSnapshot})`;
  const version = state.specVersion === undefined ? [] : [`DuckLake ${state.specVersion}`];
  const [shown, tooltip] =
    state.snapshot === 'latest'
      ? [`latest${latest}`, `Following the latest snapshot${latest}`]
      : [
          `@${state.snapshot} (pinned)`,
          `Pinned to snapshot @${state.snapshot}, not following the latest${latest}`,
        ];
  return {
    text: [`$(aantje-duck) ${name}`, ...version, shown].join(' · '),
    tooltip: `Select snapshot. ${tooltip}.`,
  };
}

import { HEALTH_GROUPS } from './model';
import type { CheckId, GroupStatus, HealthEvent, HealthFinding, HealthGroup } from './model';

/** The outcome of a group, without its name. */
export type GroupResult = Omit<GroupStatus, 'group'>;

/** The findings and group states of one run; nothing is emitted after `close`. */
export interface RunState {
  readonly findings: HealthFinding[];
  readonly statuses: ReadonlyMap<HealthGroup, GroupStatus>;
  emit(event: HealthEvent): void;
  setGroup(status: GroupStatus): void;
  add(list: readonly HealthFinding[]): void;
  has(check: CheckId): boolean;
  finished(group: HealthGroup): boolean;
  skip(group: HealthGroup, reason: string): void;
  skipUnfinished(reason: string): void;
  /** A cancel frees the caller while the run winds down, which must not report after the summary. */
  close(): void;
}

export function createRunState(onEvent: ((event: HealthEvent) => void) | undefined): RunState {
  const findings: HealthFinding[] = [];
  const statuses = new Map<HealthGroup, GroupStatus>();
  let closed = false;
  const state: RunState = {
    findings,
    statuses,
    emit(event) {
      if (!closed) onEvent?.(event);
    },
    setGroup(status) {
      statuses.set(status.group, status);
      state.emit({ type: 'group', status });
    },
    add(list) {
      for (const item of list) {
        findings.push(item);
        state.emit({ type: 'finding', finding: item });
      }
    },
    has: (check) => findings.some((item) => item.check === check),
    finished(group) {
      const current = statuses.get(group)?.state;
      return current !== undefined && current !== 'running';
    },
    skip: (group, reason) => state.setGroup({ group, state: 'skipped', reason }),
    skipUnfinished(reason) {
      for (const group of HEALTH_GROUPS) {
        if (!state.finished(group)) state.skip(group, reason);
      }
    },
    close() {
      closed = true;
    },
  };
  return state;
}

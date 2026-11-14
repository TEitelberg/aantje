/// <reference lib="dom" />
// Browser side of the Health check: state and events; the DOM is built in render.ts, the texts and lists in model.ts.
import { isArrayOf, isCount, isOneOf, isShape, isString } from '../guards';
import { reportPage } from '../shell/report-page';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import { DEFAULT_DEEP_FILES, DEFAULT_FILTER, MAX_DEEP_FILES, applyEvents, healthScopeLabel } from './model';
import type { HealthData, HealthFilter, PanelEvent } from './model';
import { isHealthMessage, isHealthView, isWholeData } from './protocol';
import type { HealthMessage } from './protocol';
import {
  countFilters,
  filterBar,
  headerParts,
  listChildren,
  markFilters,
  pageRegions,
  settleFocus,
  statusChildren,
} from './render';

// A run can find thousands of findings; the list shows this many before "Show more".
const PAGE_SIZE = 100;

interface Saved {
  readonly identity: string;
  readonly depth: 'quick' | 'deep';
  readonly deepFiles: number;
  readonly filter: HealthFilter;
  readonly expanded: readonly string[];
}

const isSaved = isShape({
  identity: isString,
  depth: isOneOf('quick', 'deep'),
  deepFiles: isCount,
  filter: isHealthView,
  expanded: isArrayOf(isString),
}) as (value: unknown) => value is Saved;

type Choices = Pick<Saved, 'depth' | 'deepFiles' | 'filter'> & { readonly expanded: Set<string> };

const identityOf = (data: HealthData): string => `${data.connection}\n${healthScopeLabel(data.scope)}`;

// A running check shows its own choice; otherwise the saved state of this connection and scope wins.
function restoredChoices(message: HealthData, saved: unknown): Choices {
  if (isSaved(saved) && saved.identity === identityOf(message)) {
    const { depth, deepFiles } = message.status === 'running' ? message : saved;
    return { filter: saved.filter, expanded: new Set(saved.expanded), depth, deepFiles };
  }
  return { filter: DEFAULT_FILTER, expanded: new Set(), depth: message.depth, deepFiles: message.deepFiles };
}

const toggle = <T extends string>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

const savedOf = (data: HealthData, choices: Choices): Saved => ({
  identity: identityOf(data),
  depth: choices.depth,
  deepFiles: choices.deepFiles,
  filter: choices.filter,
  expanded: [...choices.expanded],
});

export const healthPage = reportPage<HealthMessage['data']>('health', isHealthMessage, ({ context }) => {
  let data: HealthData | undefined;
  let filter: HealthFilter = DEFAULT_FILTER;
  let depth: 'quick' | 'deep' = 'quick';
  let deepFiles = DEFAULT_DEEP_FILES;
  let expanded = new Set<string>();
  let limit = PAGE_SIZE;
  let theme: Theme;
  /** Where the focus goes when the buttons of the header are built anew: the run changes which of them exist. */
  let focusNext: 'run' | 'cancel' | undefined;
  let invalid = false;

  const regions = pageRegions();
  const filterButtons = new Map<string, HTMLElement>();

  function requireData(): HealthData {
    if (!data) throw new Error('The page has no data.');
    return data;
  }

  function save(): void {
    if (data) context.state.set(savedOf(data, { depth, deepFiles, filter, expanded }));
  }

  const act = (action: string, finding?: string): void =>
    context.post({ type: 'action', action, ...(finding === undefined ? {} : { finding }) });

  function run(): void {
    if (!Number.isInteger(deepFiles) || deepFiles < 1 || deepFiles > MAX_DEEP_FILES) {
      invalid = true;
      header(requireData());
      return;
    }
    invalid = false;
    focusNext = 'cancel';
    const request = { type: 'action' as const, action: 'run', depth, deepFiles };
    context.post(request);
  }

  function header(current: HealthData): void {
    const running = current.status === 'running';
    const parts = headerParts(
      context,
      { data: current, filter: () => filter, depth, deepFiles, invalid },
      {
        onRun: run,
        onCancel(button) {
          focusNext = 'run';
          button.disabled = true;
          act('cancel');
        },
        onScript: () => act('maintenanceScript'),
        onDepth(choice) {
          depth = choice;
          save();
          header(requireData());
        },
        onFiles(count) {
          deepFiles = count;
          invalid = false;
          save();
        },
      },
    );
    regions.header.replaceChildren(parts.top.element, parts.depthBar);
    parts.top.settle();
    focusNext = settleFocus(focusNext, running, parts);
  }

  function status(current: HealthData): void {
    regions.status.replaceChildren(...statusChildren(current, theme));
  }

  function filters(current: HealthData): void {
    const changed = (next: HealthFilter): void => {
      filter = next;
      markFilters(filterButtons, filter);
      list(requireData());
      save();
    };
    regions.filters.replaceChildren(
      filterBar(filter, filterButtons, {
        onSeverity(severity) {
          changed({ ...filter, severities: toggle(filter.severities, severity) });
        },
        onGroup(group) {
          changed({ ...filter, groups: toggle(filter.groups, group) });
        },
        onText(text) {
          filter = { ...filter, text };
          limit = PAGE_SIZE;
          list(requireData());
          save();
        },
      }),
    );
    markFilters(filterButtons, filter);
    countFilters(filterButtons, current.findings);
  }

  function list(current: HealthData): void {
    regions.list.replaceChildren(
      ...listChildren(
        { data: current, filter, limit, expanded },
        {
          onToggle(id, open) {
            if (open) expanded.add(id);
            else expanded.delete(id);
            save();
          },
          onAction: act,
          onMore() {
            limit += PAGE_SIZE;
            list(requireData());
          },
        },
      ),
    );
  }

  function renderAll(current: HealthData): void {
    theme = readTheme();
    context.app.replaceChildren(regions.header, regions.status, regions.filters, regions.list);
    header(current);
    status(current);
    filters(current);
    list(current);
  }

  function applyBatch(events: readonly PanelEvent[]): void {
    if (!data) return;
    const before = data;
    data = applyEvents(data, events);
    if (data.status !== before.status || data.snapshot !== before.snapshot) header(data);
    status(data);
    if (data.findings.length !== before.findings.length || data.status !== before.status) {
      countFilters(filterButtons, data.findings);
      list(data);
    }
  }

  return {
    show(message) {
      if (!isWholeData(message)) {
        applyBatch(message.events);
        return;
      }
      const previous = data;
      data = message;
      ({ filter, expanded, depth, deepFiles } = restoredChoices(message, context.state.get()));
      if (previous && message.status === 'running' && previous.status !== 'running') {
        // A new run replaces the results of the last one.
        limit = PAGE_SIZE;
      }
      invalid = false;
      renderAll(message);
    },
    // A batch of events can come before the data: it is applied to nothing.
    redraw() {
      if (data) renderAll(data);
    },
  };
});

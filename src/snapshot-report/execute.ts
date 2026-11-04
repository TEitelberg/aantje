import type { CatalogReader, SnapshotId } from '../catalog/model';
import { compareSchema, snapshotsReport } from '../compare';
import { selectAtSnapshot } from '../script';
import { changesOfSnapshot, chooseQueryAction, subjectLabel } from '../time-travel';
import type { Subject, TimeTravelUi } from '../time-travel';
import type { ReportPort } from '../shell/report-port';
import type { SnapshotReportPlan } from './actions';
import { connectionClosed } from '../messages';

// A missing table gets a message instead of an empty result.
async function existsAt(
  reader: CatalogReader,
  ui: TimeTravelUi,
  subject: Subject,
  snapshot: SnapshotId,
  goal: string,
): Promise<boolean> {
  const exists = (await reader.entries(snapshot)).some(
    (entry) => entry.kind === 'table' && entry.id === subject.id,
  );
  if (!exists) {
    ui.info(
      `"${subjectLabel(subject)}" does not exist at snapshot @${snapshot} (it was dropped before or is not created yet), so there is nothing to ${goal}.`,
    );
  }
  return exists;
}

/** Runs a plan through the existing command implementations, which still ask their questions. */
export async function performSnapshotReportAction(plan: SnapshotReportPlan, port: ReportPort): Promise<void> {
  const reader = port.reader();
  if (!reader) {
    throw connectionClosed('use the snapshot report');
  }
  switch (plan.action) {
    case 'showCatalog':
      port.showCatalog(plan.snapshot);
      return;
    case 'showLatest':
      if (port.showsLatest()) {
        port.ui.info(`"${port.connectionName}" already shows the latest snapshot.`);
      } else {
        port.showCatalog('latest');
      }
      return;
    case 'rowsChanged': {
      const choice = await changesOfSnapshot(port.ui, reader, { snapshot: plan.snapshot, table: plan.table });
      if (choice) {
        await port.showChanges(choice);
      }
      return;
    }
    case 'compareSchema': {
      if (
        (await existsAt(reader, port.ui, plan.subject, plan.from, 'compare')) &&
        (await existsAt(reader, port.ui, plan.subject, plan.to, 'compare'))
      ) {
        await port.showSchema(
          await compareSchema(reader, port.connectionId, plan.subject, plan.from, plan.to),
        );
      }
      return;
    }
    case 'compareSnapshots':
      await port.showReport(
        await snapshotsReport(reader, port.connectionName, await reader.snapshots(), plan.from, plan.to),
      );
      return;
    case 'query': {
      if (!(await existsAt(reader, port.ui, plan.subject, plan.snapshot, 'query'))) {
        return;
      }
      const choice = await chooseQueryAction(port.ui, reader, plan.subject, plan.snapshot);
      if (choice?.action === 'rows') {
        await port.showRows(choice.table, choice.snapshot);
      } else if (choice?.action === 'sql') {
        await port.openSql(await selectAtSnapshot(reader, plan.subject, choice.table, choice.snapshot));
      } else if (choice) {
        await port.createNotebook(choice.table, choice.snapshot);
      }
    }
  }
}

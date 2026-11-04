import * as vscode from 'vscode';
import { observeStatusBar, observeTreeView, resetHost } from './support';

let stopObservingStatusBar: (() => void) | undefined;
let stopObservingTreeView: (() => void) | undefined;

before(() => {
  const { electron, node } = process.versions;
  console.log(
    `VS Code ${vscode.version} (Electron ${electron}, Node ${node}, ${process.platform}-${process.arch}) at ${vscode.env.appRoot}`,
  );
  stopObservingStatusBar = observeStatusBar();
  stopObservingTreeView = observeTreeView();
});

afterEach(async () => {
  await resetHost();
});

after(() => {
  stopObservingStatusBar?.();
  stopObservingTreeView?.();
});

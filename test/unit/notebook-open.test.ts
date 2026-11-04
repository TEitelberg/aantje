import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AantjeError } from '../../src/errors';
import type { NotebookCell } from '../../src/notebook/build';

// The test host has no Jupyter extension, so the editor is a stub that records what the adapter asks of it.
const editor = vi.hoisted(() => {
  class NotebookCellData {
    constructor(
      readonly kind: number,
      readonly value: string,
      readonly languageId: string,
    ) {}
  }
  class NotebookData {
    constructor(readonly cells: NotebookCellData[]) {}
  }
  return {
    NotebookCellData,
    NotebookData,
    installed: new Set<string>(),
    opened: [] as { type: string; data: NotebookData }[],
    shown: [] as unknown[],
  };
});

vi.mock('vscode', () => ({
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookCellData: editor.NotebookCellData,
  NotebookData: editor.NotebookData,
  extensions: { getExtension: (id: string) => (editor.installed.has(id) ? { id } : undefined) },
  workspace: {
    openNotebookDocument: (type: string, data: InstanceType<typeof editor.NotebookData>) => {
      editor.opened.push({ type, data });
      return Promise.resolve({ document: type });
    },
  },
  window: {
    showNotebookDocument: (document: unknown) => {
      editor.shown.push(document);
      return Promise.resolve();
    },
  },
}));

const { openNotebook } = await import('../../src/notebook/open.vscode');

const CELLS: NotebookCell[] = [
  { kind: 'markdown', language: 'markdown', source: '# `sales.orders`' },
  { kind: 'code', language: 'python', source: '%pip install "duckdb>=2.0.0" pandas' },
  { kind: 'code', language: 'python', source: 'con.sql(QUERY).df()' },
];

describe('openNotebook', () => {
  beforeEach(() => {
    editor.installed.clear();
    editor.opened.length = 0;
    editor.shown.length = 0;
  });

  it('opens the cells as a Jupyter notebook: markdown becomes a markup cell, code a Python code cell', async () => {
    editor.installed.add('ms-toolsai.jupyter');

    await openNotebook(CELLS);

    expect(editor.opened).toHaveLength(1);
    expect(editor.opened[0]?.type).toBe('jupyter-notebook');
    expect(editor.opened[0]?.data.cells).toEqual([
      { kind: 1, value: '# `sales.orders`', languageId: 'markdown' },
      { kind: 2, value: '%pip install "duckdb>=2.0.0" pandas', languageId: 'python' },
      { kind: 2, value: 'con.sql(QUERY).df()', languageId: 'python' },
    ]);
  });

  it('shows the document it opened', async () => {
    editor.installed.add('ms-toolsai.jupyter');

    await openNotebook(CELLS);

    expect(editor.shown).toEqual([{ document: 'jupyter-notebook' }]);
  });

  it('tells the user to install the Jupyter extension and opens nothing without it', async () => {
    const failure = await openNotebook(CELLS).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AantjeError);
    expect(failure).toMatchObject({
      code: 'CONNECTION_FAILED',
      userMessage:
        'Creating a notebook needs the Jupyter extension (ms-toolsai.jupyter). Install it and try again.',
    });
    expect(editor.opened).toEqual([]);
    expect(editor.shown).toEqual([]);
  });
});

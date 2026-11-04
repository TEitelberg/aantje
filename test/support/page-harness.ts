import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as esbuild from 'esbuild';
import { FakeNode } from './fake-dom';

type Listener = (event: Record<string, unknown>) => void;

/** A chart that the page asked the stand-in for ECharts to draw (see shell-charts-stub.ts). */
export interface DrawnChart {
  element: FakeNode;
  theme: Record<string, unknown>;
  option: Record<string, unknown>;
  onItemClick: ((index: number) => void) | undefined;
  disposed: boolean;
  resized: number;
  updates: Record<string, unknown>[];
}

/**
 * The real browser bundle of the report pages (`src/shell/client.ts`) with ECharts replaced by a stand-in (a canvas
 * is needed to draw), to run against a stand-in for the DOM.
 */
export async function buildClientBundle(): Promise<string> {
  const stub = fileURLToPath(new URL('./shell-charts-stub.ts', import.meta.url));
  const result = await esbuild.build({
    entryPoints: ['src/shell/client.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    plugins: [
      {
        name: 'charts-stand-in',
        setup: (build) => build.onResolve({ filter: /\/charts$/ }, () => ({ path: stub })),
      },
    ],
  });
  return result.outputFiles[0]?.text ?? '';
}

export const DARK_VARIABLES: Record<string, string> = {
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-charts-foreground': '#cccccc',
  '--vscode-charts-lines': 'rgba(204, 204, 204, 0.5)',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-font-family': 'Segoe UI',
  '--vscode-font-size': '13px',
};

/** Runs the bundle in a sandbox; `saved` is the state that VS Code hands to a page that was taken down and comes back. */
export function startPage(bundle: string, saved?: unknown) {
  FakeNode.active = undefined;
  const body = new FakeNode('body');
  body.className = 'vscode-dark';
  const posted: unknown[] = [];
  const windowListeners = new Map<string, Listener[]>();
  let state = saved;
  let themeChanged: (() => void) | undefined;
  let frame: (() => void) | undefined;
  const sandbox = {
    document: {
      body,
      documentElement: new FakeNode('html'),
      createElement: (tag: string) => new FakeNode(tag),
    },
    window: {
      addEventListener: (type: string, listener: Listener) =>
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]),
    },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => DARK_VARIABLES[name] ?? '' }),
    MutationObserver: class {
      constructor(callback: () => void) {
        themeChanged = callback;
      }
      observe(): void {}
    },
    requestAnimationFrame: (callback: () => void) => {
      frame = callback;
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => posted.push(message),
      getState: () => state,
      setState: (next: unknown) => {
        // VS Code keeps the state as JSON.
        state = JSON.parse(JSON.stringify(next));
      },
    }),
    drawn: [] as DrawnChart[],
  };
  runInNewContext(bundle, sandbox);
  // Every page lives in the one container of the shell, which is what the gutter of the stylesheet applies to.
  const app = (): FakeNode => {
    const [container] = body.children;
    if (body.children.length !== 1 || container?.className !== 'app') {
      throw new Error('The body must hold the one .app container and nothing else.');
    }
    return container;
  };
  return {
    posted,
    drawn: sandbox.drawn,
    app,
    send: (message: unknown) => (windowListeners.get('message') ?? []).forEach((l) => l({ data: message })),
    saved: () => state,
    /** The window changes its size. */
    resize: () => (windowListeners.get('resize') ?? []).forEach((l) => l({})),
    /** VS Code changes the theme: the observed attributes change and the next animation frame runs. */
    changeTheme: () => {
      themeChanged?.();
      frame?.();
    },
  };
}

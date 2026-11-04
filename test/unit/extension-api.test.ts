import { expect, it, vi } from 'vitest';
import type { ExtensionApi } from '../../src/extension';

// The values of the editor API; the extension compares with `Test` only.
vi.mock('vscode', () => ({ ExtensionMode: { Production: 1, Development: 2, Test: 3 } }));

it('hands the API out only when the extension host runs a test, not in production or development', async () => {
  const api = { tree: {}, editors: {} } as unknown as ExtensionApi;
  const { exportsFor } = await import('../../src/extension');

  expect(exportsFor(3, api)).toBe(api);
  expect(exportsFor(1, api)).toBeUndefined();
  expect(exportsFor(2, api)).toBeUndefined();
});

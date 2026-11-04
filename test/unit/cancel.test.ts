import { describe, expect, it } from 'vitest';
import { runCancellable } from '../../src/cancel';

/** A token like the one of the editor: it counts what is listening. */
function token() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    cancel: () => listeners.forEach((listener) => listener()),
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

describe('runCancellable', () => {
  it('listens to the token only while the run is going, and passes the result or the failure on', async () => {
    const cancelling = token();

    const result = await runCancellable(cancelling, () => {
      expect(cancelling.listeners.size).toBe(1);
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(cancelling.listeners.size).toBe(0);

    await expect(runCancellable(cancelling, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cancelling.listeners.size).toBe(0);
  });

  it('aborts the signal of the run when the token is cancelled', async () => {
    const cancelling = token();
    let seen: AbortSignal | undefined;

    await runCancellable(cancelling, (signal) => {
      seen = signal;
      expect(signal.aborted).toBe(false);
      cancelling.cancel();
      return Promise.resolve();
    });

    expect(seen?.aborted).toBe(true);
  });

  it('aborts the signal of the run when the outer signal fires, and not before', async () => {
    const outer = new AbortController();

    const during = await runCancellable(
      token(),
      (signal) => {
        const before = signal.aborted;
        outer.abort();
        return Promise.resolve([before, signal.aborted]);
      },
      outer.signal,
    );

    expect(during).toEqual([false, true]);
  });
});

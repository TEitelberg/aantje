interface CancelToken {
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Runs `run` with a signal that aborts when the token is cancelled or `outer` fires; stops listening afterwards. */
export async function runCancellable<T>(
  token: CancelToken,
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  const abort = new AbortController();
  const subscription = token.onCancellationRequested(() => abort.abort());
  try {
    return await run(outer ? AbortSignal.any([abort.signal, outer]) : abort.signal);
  } finally {
    subscription.dispose();
  }
}

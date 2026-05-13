export const delay = (ms, signal = null) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason || new Error('Operation aborted'));
    return;
  }

  const timeout = setTimeout(resolve, ms);
  timeout.unref?.();

  if (signal) {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason || new Error('Operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

export const withTimeout = async (operation, timeoutMs, message = 'Operation timed out') => {
  const controller = new AbortController();
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(message));
      reject(new Error(message));
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      operation(controller.signal),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
};


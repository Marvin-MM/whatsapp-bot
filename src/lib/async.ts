/**
 * Races `promise` against a deadline. The losing promise keeps running (JS cannot cancel it), so a late
 * rejection is swallowed to avoid an unhandled-rejection crash.
 */
export async function withDeadline<T>(promise: PromiseLike<T>, ms: number, onTimeout: () => Error): Promise<T> {
  const pending = Promise.resolve(promise);
  pending.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

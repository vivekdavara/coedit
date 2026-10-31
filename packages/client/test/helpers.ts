// Shared by the client's tests.

/** Waits until `condition` holds, checking every 5 ms, for up to `ms`. */
export async function eventually(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

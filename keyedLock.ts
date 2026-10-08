/**
 * Runs tasks with the same key one at a time, within this process. A key is kept only while a task with it runs
 * or waits, so keys taken by many different callers do not pile up in memory.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    // The next task with this key waits for this one even when it fails.
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

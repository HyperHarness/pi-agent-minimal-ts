export interface KeyedTaskQueue {
  enqueue(key: string, task: () => Promise<void>): void;
}

export function createPerKeyQueue(): KeyedTaskQueue {
  const queues = new Map<string, Array<() => Promise<void>>>();
  const activeKeys = new Set<string>();

  const processKey = async (key: string): Promise<void> => {
    if (activeKeys.has(key)) {
      return;
    }

    activeKeys.add(key);
    try {
      while (true) {
        const queue = queues.get(key);
        const task = queue?.shift();
        if (!task) {
          queues.delete(key);
          break;
        }
        await task();
      }
    } finally {
      activeKeys.delete(key);
      if ((queues.get(key)?.length ?? 0) > 0) {
        setTimeout(() => {
          void processKey(key);
        }, 0);
      }
    }
  };

  return {
    enqueue(key: string, task: () => Promise<void>): void {
      const queue = queues.get(key) ?? [];
      queue.push(task);
      queues.set(key, queue);
      void processKey(key);
    },
  };
}

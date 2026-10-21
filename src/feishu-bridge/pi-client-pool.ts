import type { PiRpcClient } from './pi-client.js';

export interface PiClientPoolOptions {
  idleTtlMs: number;
  maxClients: number;
  now?: () => number;
}

interface PoolEntry {
  client: PiRpcClient;
  lastUsedAt: number;
  activePrompts: number;
}

export interface PiClientLease {
  client: PiRpcClient;
  release(): void;
}

/**
 * Owns the set of PI child processes used by the bridge.
 *
 * It coalesces in-flight startup per key (so two concurrent messages never
 * spawn two processes for the same client key), serializes prompts per key
 * and keeps full message leases active between prompts. Both ready clients and
 * in-flight startups count toward capacity; a full busy pool waits for a release.
 * Only idle clients are evicted by TTL or LRU. Chat isolation is supplied by the key.
 */
export class PiClientPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly startupPromises = new Map<string, Promise<PiRpcClient>>();
  private readonly promptTails = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, number>();
  private readonly capacityWaiters = new Set<() => void>();
  private closed = false;
  private readonly idleTtlMs: number;
  private readonly maxClients: number;
  private readonly now: () => number;

  constructor(options: PiClientPoolOptions) {
    if (!Number.isFinite(options.idleTtlMs) || options.idleTtlMs <= 0) {
      throw new Error('idleTtlMs 必须是正数');
    }
    if (!Number.isInteger(options.maxClients) || options.maxClients <= 0) {
      throw new Error('maxClients 必须是正整数');
    }
    this.idleTtlMs = options.idleTtlMs;
    this.maxClients = options.maxClients;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): PiRpcClient | undefined {
    return this.entries.get(key)?.client;
  }

  async getOrCreate(key: string, createAndStart: () => Promise<PiRpcClient>): Promise<PiRpcClient> {
    while (true) {
      if (this.closed) throw new Error('PI 客户端池已关闭');
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.client.isProcessReady()) {
          existing.lastUsedAt = this.now();
          return existing.client;
        }
        this.dropEntry(key, existing);
      }
      const inFlight = this.startupPromises.get(key);
      if (inFlight) return inFlight;
      this.evictIdle();
      this.evictLruIdleToFit();
      if (this.entries.size + this.startupPromises.size < this.maxClients) {
        const startup = this.startClient(key, createAndStart);
        this.startupPromises.set(key, startup);
        return startup;
      }
      // Starting clients consume capacity too. Busy clients retain their slot;
      // wait for a release instead of overshooting the cap or killing a turn.
      await new Promise<void>(resolve => this.capacityWaiters.add(resolve));
    }
  }

  async acquire(key: string, createAndStart: () => Promise<PiRpcClient>): Promise<PiClientLease> {
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(key) ?? 1) - 1;
      if (count > 0) this.leases.set(key, count);
      else this.leases.delete(key);
      const entry = this.entries.get(key);
      if (entry) entry.lastUsedAt = this.now();
      this.notifyCapacity();
    };
    try { return { client: await this.getOrCreate(key, createAndStart), release }; }
    catch (error) { release(); throw error; }
  }

  runPrompt(key: string, client: PiRpcClient, message: string): Promise<string> {
    const entry = this.entries.get(key);
    const tracked = entry?.client === client ? entry : undefined;
    if (this.closed || !tracked) return Promise.reject(new Error('PI 客户端已关闭或已回收'));
    if (tracked) {
      tracked.activePrompts += 1;
      tracked.lastUsedAt = this.now();
    }

    const previous = this.promptTails.get(key) ?? Promise.resolve();
    const run = previous.then(() => {
      if (this.closed || this.entries.get(key)?.client !== client) throw new Error('PI 客户端已关闭或已回收');
      return client.prompt(message);
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.promptTails.set(key, tail);
    void tail.then(() => {
      if (this.promptTails.get(key) === tail) {
        this.promptTails.delete(key);
      }
    });

    return run.finally(() => {
      if (tracked) {
        if (tracked.activePrompts > 0) {
          tracked.activePrompts -= 1;
        }
        tracked.lastUsedAt = this.now();
      }
      this.notifyCapacity();
    });
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.dropEntry(key, entry);
    }
  }

  evictIdle(): void {
    const now = this.now();
    const expired: Array<[string, PoolEntry]> = [];
    for (const [key, entry] of this.entries) {
      if (this.isIdle(key, entry) && now - entry.lastUsedAt > this.idleTtlMs) {
        expired.push([key, entry]);
      }
    }
    for (const [key, entry] of expired) {
      if (this.entries.get(key) === entry) {
        this.dropEntry(key, entry);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.notifyCapacity();

    const remaining = [...this.entries.values()];
    this.entries.clear();
    for (const entry of remaining) {
      entry.client.stop();
    }

    const inFlight = [...this.startupPromises.values()];
    this.startupPromises.clear();
    for (const promise of inFlight) {
      try {
        const client = await promise;
        client.stop();
      } catch {
        // Startup failed or the pool was closed mid-start; failed attempts are
        // already stopped by the retry helper and late clients are stopped by
        // startClient when it observes the pool is closed.
      }
    }
  }

  private async startClient(key: string, createAndStart: () => Promise<PiRpcClient>): Promise<PiRpcClient> {
    try {
      const client = await Promise.resolve().then(createAndStart);
      if (this.closed) {
        client.stop();
        throw new Error('PI 客户端池已关闭');
      }
      this.entries.set(key, { client, lastUsedAt: this.now(), activePrompts: 0 });
      return client;
    } finally {
      this.startupPromises.delete(key);
      this.notifyCapacity();
    }
  }

  private evictLruIdleToFit(): void {
    while (this.entries.size + this.startupPromises.size >= this.maxClients) {
      let oldestKey: string | undefined;
      let oldestEntry: PoolEntry | undefined;
      for (const [key, entry] of this.entries) {
        if (this.isIdle(key, entry) && (!oldestEntry || entry.lastUsedAt < oldestEntry.lastUsedAt)) {
          oldestKey = key;
          oldestEntry = entry;
        }
      }
      if (oldestKey === undefined || !oldestEntry) {
        return;
      }
      this.dropEntry(oldestKey, oldestEntry);
    }
  }

  private dropEntry(key: string, entry: PoolEntry): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
    entry.client.stop();
    this.notifyCapacity();
  }

  private isIdle(key: string, entry: PoolEntry): boolean {
    return entry.activePrompts === 0 && (this.leases.get(key) ?? 0) === 0;
  }

  private notifyCapacity(): void {
    const waiters = [...this.capacityWaiters];
    this.capacityWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly options: { ttlMs: number; maxEntries: number; now?: () => number },
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

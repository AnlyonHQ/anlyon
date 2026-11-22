import { AsyncLocalStorage } from "node:async_hooks";

const tenantOfTransaction = new AsyncLocalStorage<string>();

export function asTransactionTenant<T>(tenant: string, work: () => T): T {
  return tenantOfTransaction.run(tenant, work);
}

export function transactionTenant(): string | undefined {
  return tenantOfTransaction.getStore();
}

interface Waiter {
  tenant: string | undefined;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TransactionGate {
  private active = 0;
  private readonly activeByTenant = new Map<string, number>();
  private readonly waiting: Waiter[] = [];
  readonly perTenant: number;

  constructor(readonly permits: number, private readonly maxWaitMs: number, perTenant: number = permits) {
    if (!Number.isInteger(permits) || permits < 1) throw new Error("A transaction gate needs at least one permit.");
    if (!Number.isInteger(perTenant) || perTenant < 1 || perTenant > permits) {
      throw new Error("A tenant's share of a transaction gate is between one permit and all of them.");
    }
    this.perTenant = perTenant;
  }

  get state(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  private underShare(tenant: string | undefined): boolean {
    return tenant === undefined || (this.activeByTenant.get(tenant) ?? 0) < this.perTenant;
  }

  private count(tenant: string | undefined, by: 1 | -1): void {
    if (tenant === undefined) return;
    const next = (this.activeByTenant.get(tenant) ?? 0) + by;
    if (next > 0) this.activeByTenant.set(tenant, next);
    else this.activeByTenant.delete(tenant);
  }

  private acquire(tenant: string | undefined): Promise<void> {
    if (this.active < this.permits && this.underShare(tenant)) {
      this.active++;
      this.count(tenant, 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        tenant,
        grant: () => {
          clearTimeout(entry.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error(`The database is busy: a transaction waited ${this.maxWaitMs} ms to begin and was not started.`));
        }, this.maxWaitMs),
      };
      this.waiting.push(entry);
    });
  }

  private release(tenant: string | undefined): void {
    this.active--;
    this.count(tenant, -1);
    while (this.active < this.permits) {
      const index = this.waiting.findIndex((entry) => this.underShare(entry.tenant));
      if (index < 0) return;
      const [next] = this.waiting.splice(index, 1);
      this.active++;
      this.count(next.tenant, 1);
      next.grant();
    }
  }

  async run<T>(work: () => Promise<T>, tenant: string | undefined = transactionTenant()): Promise<T> {
    await this.acquire(tenant);
    try {
      return await work();
    } finally {
      this.release(tenant);
    }
  }
}

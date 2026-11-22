import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import dotenv from "dotenv";
import { TransactionGate } from "./transaction-gate.ts";

dotenv.config();

const POOL_MAX = 15;
const POOL_RESERVED_FOR_READS = 5;
const PERMITS_KEPT_FROM_ONE_TENANT = 3;
const TRANSACTION_WAIT_MS = 15_000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: POOL_MAX,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
  allowExitOnIdle: false,
  statement_timeout: 5000,
  query_timeout: 5000,
});

export const db = drizzle(pool);

export const transactionGate = new TransactionGate(
  POOL_MAX - POOL_RESERVED_FOR_READS,
  TRANSACTION_WAIT_MS,
  POOL_MAX - POOL_RESERVED_FOR_READS - PERMITS_KEPT_FROM_ONE_TENANT,
);
const beginTransaction = db.transaction.bind(db);
db.transaction = ((work: Parameters<typeof beginTransaction>[0], config?: Parameters<typeof beginTransaction>[1]) =>
  transactionGate.run(() => beginTransaction(work, config))) as typeof db.transaction;

export { pool };

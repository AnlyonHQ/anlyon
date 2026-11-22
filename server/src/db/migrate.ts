import { Pool } from 'pg';
import dotenv from 'dotenv';
import { migrateDatabase } from './migration-streams.ts';

dotenv.config();

const LOCK_KEY_SQL = "hashtext('anlyon_migrate')";
const LOCK_POLL_MS = 2_000;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;

async function runMigrations() {
  const connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL!;
  const lockTimeoutMs = Number(process.env.MIGRATE_LOCK_TIMEOUT_MS) || DEFAULT_LOCK_TIMEOUT_MS;

  const pool = new Pool({ connectionString });

  console.log('⏳ Running migrations...');

  const client = await pool.connect();
  try {
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      const { rows } = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS locked`,
      );
      if (rows[0]?.locked) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `Could not take the migration lock within ${Math.round(lockTimeoutMs / 1000)} s: another ` +
            'migrator holds it, or a session leaked it. Find the holder with ' +
            "SELECT l.pid, a.application_name, a.backend_start, a.state FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.locktype = 'advisory'; " +
            'and, if it is not a running migration, end it with SELECT pg_terminate_backend(<pid>).',
        );
      }
      console.log('⏳ Another migrator holds the migration lock; waiting...');
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    const report = await migrateDatabase(pool);
    console.log(
      `⏳ Earlier history: ${report.history}` +
        (report.historyApplied ? `, ${report.historyApplied} of its migrations applied` : '') +
        (report.adopted.length ? `; baselines recorded without running: ${report.adopted.join(', ')}` : ''),
    );
    console.log(`⏳ Applied: ${Object.entries(report.applied).map(([stream, n]) => `${stream} ${n}`).join(', ')}`);
    console.log('✅ Migrations completed successfully');
    await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
    client.release();
  } catch (error) {
    client.release(true);
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();

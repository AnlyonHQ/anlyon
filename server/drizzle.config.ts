import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './src/db/migrations',
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  migrations: { table: '__core_migrations', schema: 'drizzle' },
  tablesFilter: [
    '!message_execution_logs*',
  ],
});

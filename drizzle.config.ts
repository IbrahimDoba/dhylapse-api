import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    /**
     * Migrations need DDL rights, so they use the privileged connection.
     * DATABASE_URL is the unprivileged app role and cannot alter tables it
     * does not own — pointing drizzle-kit at it fails with permission errors.
     */
    url:
      process.env.DATABASE_MIGRATION_URL ??
      'postgres://dhylapse:dhylapse@localhost:5432/dhylapse',
  },
  strict: true,
  verbose: true,
} satisfies Config;

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Environment is validated once, at boot, and the process refuses to start if
 * anything is missing. A server that boots with a half-configured environment
 * and fails on the first request is far harder to diagnose than one that never
 * came up.
 */
const EnvSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  LOG_LEVEL: Type.String({ default: 'info' }),

  /**
   * The application connects as an UNPRIVILEGED role (dhylapse_app).
   *
   * This is load-bearing, not a preference: Postgres exempts superusers and
   * table owners from row-level security, so pointing this at the migration
   * role silently disables every tenant-isolation policy in the database.
   */
  DATABASE_URL: Type.String({ minLength: 1 }),

  /** Superuser connection, used only by drizzle-kit. Never by the server. */
  DATABASE_MIGRATION_URL: Type.Optional(Type.String()),

  DATABASE_POOL_MAX: Type.Integer({ default: 10, minimum: 1 }),

  /** Comma-separated list, or "*" in development. */
  CORS_ORIGIN: Type.String({ default: 'http://localhost:5173' }),

  /** Signs session cookies. Rotating it logs everyone out. */
  BETTER_AUTH_SECRET: Type.String({ minLength: 32 }),
  BETTER_AUTH_URL: Type.String({ default: 'http://localhost:4000' }),

  /** Google OAuth is optional — omit both to run with email+password only. */
  GOOGLE_CLIENT_ID: Type.Optional(Type.String()),
  GOOGLE_CLIENT_SECRET: Type.Optional(Type.String()),

  /**
   * Transactional email. Without a key the sender logs instead of sending, so
   * the whole delivery path — queueing, retry, status — still runs in
   * development rather than being skipped and untested until launch day.
   */
  RESEND_API_KEY: Type.Optional(Type.String()),
  EMAIL_FROM: Type.String({ default: 'Dhylapse <alerts@dhylapse.app>' }),
  /** Absolute base for links in emails; falls back to the auth URL. */
  PUBLIC_APP_URL: Type.Optional(Type.String()),
});

function load() {
  const raw = {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    HOST: process.env.HOST,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  };

  // Drop unset keys so schema defaults apply, then coerce numeric strings.
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''),
  );
  const coerced = Value.Convert(EnvSchema, present);
  const withDefaults = Value.Default(EnvSchema, coerced);

  if (!Value.Check(EnvSchema, withDefaults)) {
    const problems = [...Value.Errors(EnvSchema, withDefaults)]
      .map((e) => `  ${e.path || '/'} — ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }

  return withDefaults;
}

export const env = load();
export type Env = typeof env;

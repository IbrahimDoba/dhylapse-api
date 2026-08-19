import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/client.ts';
import { env } from '../env.ts';
import { appUser, authAccount, authSession, authVerification } from '../db/schema/auth-tables.ts';

/**
 * better-auth owns the credential plane: sessions, OAuth links, verification
 * tokens, password hashes. It does NOT own tenancy — a session tells us who
 * the person is, and `membership` tells us which organizations they can act
 * for. Those are resolved separately, per request (see src/auth/context.ts).
 */
export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: appUser,
      session: authSession,
      account: authAccount,
      verification: authVerification,
    },
  }),

  /**
   * Let Postgres mint ids via the uuidv7() column default rather than having
   * better-auth generate its own string ids — the columns are `uuid`, and a
   * nanoid would fail to insert.
   */
  advanced: {
    database: { generateId: false },
    cookiePrefix: 'dhylapse',
  },

  /**
   * No `modelName` overrides: the adapter resolves models against the keys of
   * the `schema` map above, and the real table names (app_user, auth_session,
   * …) already come from the drizzle definitions themselves.
   */
  user: {
    // better-auth's field name -> our column property.
    fields: { image: 'avatarUrl' },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24,      // refresh at most daily
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    // Flip on once transactional email is wired (Phase 4).
    requireEmailVerification: false,
  },

  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {},

  trustedOrigins: env.CORS_ORIGIN === '*' ? [] : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
});

export type Auth = typeof auth;

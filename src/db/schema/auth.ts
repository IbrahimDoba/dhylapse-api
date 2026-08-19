import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { fk, pk } from './_shared.ts';
import { appUser } from './tenancy.ts';

/**
 * Tables owned by better-auth.
 *
 * These are credential-plane storage — sessions, OAuth links, verification
 * tokens — and their shape is dictated by the library, not by us. Do not add
 * application columns here; the application-side profile is `app_user`
 * (tenancy.ts), which better-auth is configured to use as its `user` model.
 *
 * Deliberately NOT under RLS: they are keyed by user, not organization, and a
 * session must be readable before we know which tenant the request belongs to.
 */

export const authSession = pgTable(
  'auth_session',
  {
    id: pk(),
    userId: fk('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_session_token_key').on(t.token),
    index('auth_session_user_idx').on(t.userId),
    index('auth_session_expiry_idx').on(t.expiresAt),
  ],
);

export const authAccount = pgTable(
  'auth_account',
  {
    id: pk(),
    userId: fk('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    /** OIDC issuer, when the provider supplies one. Added in better-auth 1.7. */
    issuer: text('issuer'),
    /** Provider's own id for the user, or the local user id for credentials. */
    accountId: text('account_id').notNull(),
    /** 'credential' | 'google' | … */
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true, mode: 'date' }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true, mode: 'date' }),
    scope: text('scope'),
    /** Argon2/scrypt hash for email+password accounts. Never a plaintext secret. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_account_provider_key').on(t.providerId, t.accountId),
    index('auth_account_user_idx').on(t.userId),
  ],
);

export const authVerification = pgTable(
  'auth_verification',
  {
    id: pk(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('auth_verification_identifier_idx').on(t.identifier, t.expiresAt)],
);


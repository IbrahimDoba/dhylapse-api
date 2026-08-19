import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { actors, fk, metadata, pk, timestamps, version } from './_shared.ts';

/**
 * TENANCY
 *
 * The single most consequential decision in this schema: the tenant is an
 * ORGANIZATION, not a pharmacy. A pharmacy that grows a second branch is the
 * normal success case, and retrofitting a branch layer onto a flat tenant
 * model means rewriting every query, every permission check, and every report.
 *
 * organization  -> the paying account ("Greenline Pharmacy Ltd")
 *   location    -> a physical outlet or store ("Greenline Lekki")
 *
 * A single-shop customer simply has one location and never sees the concept.
 * Every tenant-scoped table carries `organization_id` (the RLS key) and, where
 * the row describes something physical, `location_id`.
 */

export const organization = pgTable(
  'organization',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),

    /** Alerts fire on wall-clock time in the pharmacy's own timezone. */
    timezone: varchar('timezone', { length: 64 }).notNull().default('Africa/Lagos'),
    /** Default currency for new locations; individual locations may differ. */
    defaultCurrency: varchar('default_currency', { length: 3 }).notNull().default('NGN'),
    /** ISO 3166-1 alpha-2. Drives which regulator's fields apply (NAFDAC, MHRA…). */
    countryCode: varchar('country_code', { length: 2 }).notNull().default('NG'),
    locale: varchar('locale', { length: 16 }).notNull().default('en-NG'),

    /** 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled' */
    billingStatus: text('billing_status', {
      enum: ['trialing', 'active', 'past_due', 'suspended', 'cancelled'],
    })
      .notNull()
      .default('trialing'),
    planCode: varchar('plan_code', { length: 32 }).notNull().default('free'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true, mode: 'date' }),
    /** Soft caps enforced in app code so a plan change never needs a migration. */
    limits: jsonb('limits').notNull().default(sql`'{}'::jsonb`),

    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [uniqueIndex('organization_slug_key').on(t.slug).where(sql`${t.deletedAt} IS NULL`)],
);

export const location = pgTable(
  'location',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    code: varchar('code', { length: 32 }).notNull(),
    /** 'retail' | 'warehouse' | 'clinic' | 'dispensary' */
    kind: text('kind', { enum: ['retail', 'warehouse', 'clinic', 'dispensary'] })
      .notNull()
      .default('retail'),

    email: text('email'),
    phone: varchar('phone', { length: 32 }),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: varchar('postal_code', { length: 16 }),
    countryCode: varchar('country_code', { length: 2 }),

    /** Overrides the org default; a chain may operate across currencies. */
    currency: varchar('currency', { length: 3 }),
    /** Overrides the org timezone for multi-region chains. */
    timezone: varchar('timezone', { length: 64 }),

    /** Pharmacy premises licence / regulator registration for this outlet. */
    licenceNumber: varchar('licence_number', { length: 64 }),
    licenceExpiresAt: timestamp('licence_expires_at', { withTimezone: true, mode: 'date' }),

    isActive: boolean('is_active').notNull().default(true),

    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('location_org_code_key')
      .on(t.organizationId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('location_org_idx').on(t.organizationId),
  ],
);

/**
 * A person, globally. Deliberately NOT scoped to an organization: a locum
 * pharmacist working two chains, or a consultant onboarding several clients,
 * must be one login with two memberships. Modelling users inside the tenant
 * forces duplicate accounts and breaks SSO later.
 *
 * better-auth owns the credential tables (account, session, verification). This
 * table is the application-side profile it points at.
 */
export const appUser = pgTable(
  'app_user',
  {
    id: pk(),
    email: text('email').notNull(),
    /**
     * Boolean, not a timestamp — better-auth owns this table as its `user`
     * model and expects `emailVerified: boolean`. The verification *time* is
     * recoverable from auth_verification if it is ever needed.
     */
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('name').notNull(),
    /** Mapped from better-auth's `image` field; see src/auth/config.ts. */
    avatarUrl: text('avatar_url'),
    phone: varchar('phone', { length: 32 }),

    /** Professional registration — pharmacists are licensed individuals. */
    professionalTitle: varchar('professional_title', { length: 32 }),
    registrationNumber: varchar('registration_number', { length: 64 }),

    locale: varchar('locale', { length: 16 }),
    timezone: varchar('timezone', { length: 64 }),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    metadata: metadata(),
    version: version(),
    ...timestamps,
  },
  (t) => [uniqueIndex('app_user_email_key').on(t.email).where(sql`${t.deletedAt} IS NULL`)],
);

/**
 * Membership binds a user to an organization with a role.
 *
 * `role` is a coarse preset. `permissions` is an additive override array so a
 * customer asking for "Tomi can approve disposals but not invite staff" is a
 * data change, not a release. Custom roles can be layered on later by reading
 * the same permission strings from a role table.
 */
export const membership = pgTable(
  'membership',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: fk('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),

    role: text('role', { enum: ['owner', 'admin', 'pharmacist', 'staff', 'viewer'] })
      .notNull()
      .default('staff'),
    /** Additive grants beyond the role preset, e.g. ['disposal.approve']. */
    permissions: jsonb('permissions').notNull().default(sql`'[]'::jsonb`),

    status: text('status', { enum: ['active', 'invited', 'suspended'] })
      .notNull()
      .default('active'),

    /**
     * NULL = access to every location in the org (the common case, and what a
     * single-shop tenant always gets). Rows in membership_location narrow it.
     */
    allLocations: boolean('all_locations').notNull().default(true),

    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('membership_org_user_key')
      .on(t.organizationId, t.userId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('membership_user_idx').on(t.userId),
  ],
);

/** Per-location grants for members whose `allLocations` is false. */
export const membershipLocation = pgTable(
  'membership_location',
  {
    membershipId: fk('membership_id')
      .notNull()
      .references(() => membership.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.locationId] }),
    index('membership_location_location_idx').on(t.locationId),
  ],
);

/**
 * Invitations are separate from membership so an invite can be resent, revoked,
 * or expire without leaving a phantom "Invited" user in the staff list forever
 * — which is exactly what the current mock data does.
 */
export const invitation = pgTable(
  'invitation',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'pharmacist', 'staff', 'viewer'] })
      .notNull()
      .default('staff'),
    /** Hash only — the raw token is emailed and never stored. */
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    invitedBy: fk('invited_by').references(() => appUser.id, { onDelete: 'set null' }),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invitation_token_key').on(t.tokenHash),
    index('invitation_org_email_idx').on(t.organizationId, t.email),
  ],
);

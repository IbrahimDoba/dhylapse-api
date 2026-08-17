import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { actors, fk, metadata, moneyMinor, pk, qty, timestamps, version } from './_shared.ts';
import { product, productCategory } from './catalog.ts';
import { batch } from './inventory.ts';
import { appUser, location, organization } from './tenancy.ts';

/**
 * ALERTS & NOTIFICATIONS
 *
 * Four concerns, deliberately kept in four tables. Collapsing any two of them
 * produces a complaint we can already predict:
 *
 *   alertRule            "I want 60 days, not 90"  /  "cold-chain needs earlier warning"
 *   alertEvent           "it alerted me twice for the same batch"
 *   notification         "I want a daily digest, not 50 separate emails"
 *   notificationDelivery "you say you sent it — did it actually arrive?"
 */

/**
 * A configurable threshold. Seeded with 180/90/30/7 per organization, but the
 * values, channels, and scope are all data. Hardcoding the ladder is the single
 * most common thing customers ask to change.
 *
 * Scope resolution is most-specific-wins:
 *   product > category > location > organization
 */
export const alertRule = pgTable(
  'alert_rule',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /** 'expiry' | 'low_stock' | 'out_of_stock' | 'licence_expiry' | 'no_movement' */
    kind: text('kind', {
      enum: ['expiry', 'low_stock', 'out_of_stock', 'licence_expiry', 'no_movement'],
    })
      .notNull()
      .default('expiry'),

    /** Days before expiry for kind='expiry'. NULL for stock-level rules. */
    thresholdDays: integer('threshold_days'),
    /** Ranks alerts in the UI without a second lookup. 1 = most urgent. */
    severity: smallint('severity').notNull().default(3),

    /** NULL on all three = organization-wide default. */
    locationId: fk('location_id').references(() => location.id, { onDelete: 'cascade' }),
    categoryId: fk('category_id').references(() => productCategory.id, { onDelete: 'cascade' }),
    productId: fk('product_id').references(() => product.id, { onDelete: 'cascade' }),

    /**
     * Extra predicates without new columns, e.g.
     * {"storageCondition":"cold_chain"} or {"minValueMinor": 500000}.
     * Lets us answer "only alert me if it's worth more than ₦5,000".
     */
    conditions: jsonb('conditions').notNull().default(sql`'{}'::jsonb`),

    /** ['in_app','email','push','sms','whatsapp'] */
    channels: jsonb('channels').notNull().default(sql`'["in_app","email"]'::jsonb`),
    /** 'immediate' | 'daily_digest' | 'weekly_digest' */
    cadence: text('cadence', { enum: ['immediate', 'daily_digest', 'weekly_digest'] })
      .notNull()
      .default('daily_digest'),

    isEnabled: boolean('is_enabled').notNull().default(true),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    index('alert_rule_org_kind_idx')
      .on(t.organizationId, t.kind)
      .where(sql`${t.isEnabled} = true AND ${t.deletedAt} IS NULL`),
    index('alert_rule_product_idx').on(t.productId),
    index('alert_rule_category_idx').on(t.categoryId),
  ],
);

/**
 * One row per (batch, rule) crossing. The unique index is the idempotency
 * guarantee: a threshold fires exactly once per batch, ever — no matter how
 * many times the scan job runs, restarts, or is replayed after an outage.
 *
 * This is also the acknowledgement surface. Without it there is no way to
 * express "I've seen this one, stop showing it to me".
 */
export const alertEvent = pgTable(
  'alert_event',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'cascade' }),
    alertRuleId: fk('alert_rule_id')
      .notNull()
      .references(() => alertRule.id, { onDelete: 'cascade' }),

    /** Nullable: low-stock alerts are about a product, not a specific lot. */
    batchId: fk('batch_id').references(() => batch.id, { onDelete: 'cascade' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),

    kind: text('kind', {
      enum: ['expiry', 'low_stock', 'out_of_stock', 'licence_expiry', 'no_movement'],
    }).notNull(),
    thresholdDays: integer('threshold_days'),
    severity: smallint('severity').notNull().default(3),

    /**
     * Snapshot at fire time. An alert that silently re-reads live data tells a
     * different story a week later and destroys trust in the audit trail.
     */
    daysRemaining: integer('days_remaining'),
    quantityAtAlert: qty('quantity_at_alert'),
    valueAtRiskMinor: moneyMinor('value_at_risk_minor'),
    currency: varchar('currency', { length: 3 }),

    status: text('status', {
      enum: ['open', 'acknowledged', 'actioned', 'dismissed', 'auto_resolved'],
    })
      .notNull()
      .default('open'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
    acknowledgedBy: fk('acknowledged_by').references(() => appUser.id, { onDelete: 'set null' }),
    /** Who owns doing something about it. Answers "nobody actioned this". */
    assignedTo: fk('assigned_to').references(() => appUser.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolutionNote: text('resolution_note'),

    firedAt: timestamp('fired_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    metadata: metadata(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    /** Exactly-once per batch per rule. */
    uniqueIndex('alert_event_dedupe_key')
      .on(t.alertRuleId, t.batchId)
      .where(sql`${t.batchId} IS NOT NULL`),
    index('alert_event_open_idx')
      .on(t.organizationId, t.locationId, t.severity, t.firedAt)
      .where(sql`${t.status} = 'open'`),
    index('alert_event_batch_idx').on(t.batchId),
    index('alert_event_assigned_idx').on(t.assignedTo).where(sql`${t.status} = 'open'`),
  ],
);

/**
 * The logical message sent to one recipient. A digest bundles many alertEvents
 * into one notification — which is why this is separate from alertEvent.
 */
export const notification = pgTable(
  'notification',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    recipientUserId: fk('recipient_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),

    /** 'expiry_digest' | 'expiry_urgent' | 'low_stock' | 'invitation' | 'system' */
    template: varchar('template', { length: 64 }).notNull(),
    subject: text('subject').notNull(),
    body: text('body'),
    /** Template variables, so the message can be re-rendered per channel. */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    /** alertEvent ids bundled into this notification. */
    alertEventIds: jsonb('alert_event_ids').notNull().default(sql`'[]'::jsonb`),

    /** In-app read state, distinct from per-channel delivery state. */
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    /** Deep link the notification points at. */
    actionUrl: text('action_url'),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    index('notification_recipient_idx')
      .on(t.recipientUserId, t.createdAt)
      .where(sql`${t.readAt} IS NULL`),
    index('notification_org_idx').on(t.organizationId, t.createdAt),
  ],
);

/**
 * One attempt per channel, with real provider state.
 *
 * "I never got the email" is the single hardest support ticket to answer
 * without this table. Store the provider's message id so a bounce webhook can
 * find its way back to the row.
 */
export const notificationDelivery = pgTable(
  'notification_delivery',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    notificationId: fk('notification_id')
      .notNull()
      .references(() => notification.id, { onDelete: 'cascade' }),

    channel: text('channel', {
      enum: ['in_app', 'email', 'push', 'sms', 'whatsapp', 'webhook'],
    }).notNull(),
    /** Resolved address at send time — users change emails and phone numbers. */
    destination: text('destination'),

    status: text('status', {
      enum: ['queued', 'sending', 'sent', 'delivered', 'failed', 'bounced', 'suppressed'],
    })
      .notNull()
      .default('queued'),
    attempts: smallint('attempts').notNull().default(0),
    provider: varchar('provider', { length: 32 }),
    providerMessageId: varchar('provider_message_id', { length: 128 }),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),

    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    /** One attempt record per channel per notification. */
    uniqueIndex('notification_delivery_key').on(t.notificationId, t.channel),
    index('notification_delivery_retry_idx')
      .on(t.nextRetryAt)
      .where(sql`${t.status} IN ('queued','failed')`),
    index('notification_delivery_provider_idx').on(t.providerMessageId),
  ],
);

/**
 * Per-user, per-channel preferences with quiet hours.
 *
 * "Stop emailing me at 3am" and "only send me the 7-day ones" are preference
 * changes, not code changes. Absence of a row means the org default applies.
 */
export const notificationPreference = pgTable(
  'notification_preference',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: fk('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),

    channel: text('channel', {
      enum: ['in_app', 'email', 'push', 'sms', 'whatsapp'],
    }).notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Only notify at or above this severity on this channel. */
    minSeverity: smallint('min_severity').notNull().default(5),
    cadence: text('cadence', { enum: ['immediate', 'daily_digest', 'weekly_digest', 'off'] })
      .notNull()
      .default('daily_digest'),
    /** Local time in the user's timezone, e.g. '08:00'. */
    digestSendAt: varchar('digest_send_at', { length: 5 }).notNull().default('08:00'),
    quietHoursStart: varchar('quiet_hours_start', { length: 5 }),
    quietHoursEnd: varchar('quiet_hours_end', { length: 5 }),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [uniqueIndex('notification_preference_key').on(t.organizationId, t.userId, t.channel)],
);

/** Web-push endpoints. One user, many devices. */
export const pushSubscription = pgTable(
  'push_subscription',
  {
    id: pk(),
    userId: fk('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    failureCount: smallint('failure_count').notNull().default(0),
    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('push_subscription_endpoint_key').on(t.endpoint),
    index('push_subscription_user_idx').on(t.userId),
  ],
);

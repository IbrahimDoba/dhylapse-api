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
import { actors, fk, metadata, pk, timestamps } from './_shared.ts';
import { appUser, organization } from './tenancy.ts';

/**
 * PLATFORM
 *
 * Cross-cutting infrastructure. None of it is glamorous; all of it is what
 * customers ask for the moment they take the product seriously.
 */

/**
 * Immutable audit trail. Append-only, partitioned by month.
 *
 * "Who changed this quantity?" and "prove this batch was destroyed" are
 * regulatory questions, not nice-to-haves. Recording before/after as JSONB
 * means new entity types need no schema change.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    organizationId: fk('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),

    /** 'batch' | 'disposition' | 'membership' | … */
    entityType: varchar('entity_type', { length: 48 }).notNull(),
    entityId: fk('entity_id'),
    /** 'create' | 'update' | 'delete' | 'approve' | 'login' | … */
    action: varchar('action', { length: 32 }).notNull(),

    /** Only the changed keys, not the whole row — keeps the table small. */
    changes: jsonb('changes').notNull().default(sql`'{}'::jsonb`),

    actorId: fk('actor_id').references(() => appUser.id, { onDelete: 'set null' }),
    /** 'user' | 'system' | 'api_key' | 'job' | 'webhook' */
    actorType: varchar('actor_type', { length: 16 }).notNull().default('user'),
    actorLabel: text('actor_label'),

    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    requestId: varchar('request_id', { length: 64 }),

    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId, t.occurredAt),
    index('audit_log_org_time_idx').on(t.organizationId, t.occurredAt),
    index('audit_log_actor_idx').on(t.actorId, t.occurredAt),
  ],
);

/**
 * Polymorphic file attachments: OCR photos, destruction certificates, supplier
 * credit notes, import source files. One table beats an `*_url` column on
 * every entity that eventually needs two of them.
 */
export const attachment = pgTable(
  'attachment',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),

    entityType: varchar('entity_type', { length: 48 }).notNull(),
    entityId: fk('entity_id').notNull(),

    filename: text('filename').notNull(),
    contentType: varchar('content_type', { length: 128 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    storageKey: text('storage_key').notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    /** 'evidence' | 'photo' | 'source_file' | 'certificate' | 'credit_note' */
    purpose: varchar('purpose', { length: 32 }),

    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    index('attachment_entity_idx').on(t.entityType, t.entityId),
    index('attachment_org_idx').on(t.organizationId),
  ],
);

/**
 * Namespaced key/value settings instead of forty boolean columns on
 * `organization`. Adding a toggle becomes a write, not a migration — which is
 * the entire point of calling this schema "adjustable".
 */
export const orgSetting = pgTable(
  'org_setting',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** e.g. 'inventory', 'alerts', 'branding', 'export' */
    namespace: varchar('namespace', { length: 32 }).notNull(),
    key: varchar('key', { length: 64 }).notNull(),
    value: jsonb('value').notNull(),
    ...timestamps,
    ...actors,
  },
  (t) => [uniqueIndex('org_setting_key').on(t.organizationId, t.namespace, t.key)],
);

/** Programmatic access for integrations (POS systems, ERPs, custom scripts). */
export const apiKey = pgTable(
  'api_key',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Short non-secret prefix shown in the UI so keys are identifiable. */
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    keyHash: varchar('key_hash', { length: 128 }).notNull(),
    scopes: jsonb('scopes').notNull().default(sql`'[]'::jsonb`),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),

    /** Per-key throttle so one runaway integration can't starve the tenant. */
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(120),

    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('api_key_hash_key').on(t.keyHash),
    index('api_key_org_idx').on(t.organizationId),
  ],
);

/** Outbound webhooks, so integrators don't have to poll. */
export const webhookEndpoint = pgTable(
  'webhook_endpoint',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** ['batch.expiring','batch.expired','disposition.completed', …] */
    events: jsonb('events').notNull().default(sql`'[]'::jsonb`),
    signingSecret: varchar('signing_secret', { length: 128 }).notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Auto-disable after sustained failure; surfaced in the UI. */
    disabledReason: text('disabled_reason'),
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [index('webhook_endpoint_org_idx').on(t.organizationId)],
);

export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    endpointId: fk('endpoint_id')
      .notNull()
      .references(() => webhookEndpoint.id, { onDelete: 'cascade' }),

    eventType: varchar('event_type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),

    status: text('status', { enum: ['queued', 'delivered', 'failed', 'abandoned'] })
      .notNull()
      .default('queued'),
    attempts: smallint('attempts').notNull().default(0),
    responseStatus: smallint('response_status'),
    responseBody: text('response_body'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),

    ...timestamps,
  },
  (t) => [
    index('webhook_delivery_endpoint_idx').on(t.endpointId, t.createdAt),
    index('webhook_delivery_retry_idx')
      .on(t.nextRetryAt)
      .where(sql`${t.status} IN ('queued','failed')`),
  ],
);

/**
 * Idempotency keys for unsafe API calls. A flaky connection retrying a
 * "receive 500 units" request must not double the stock — the classic way
 * inventory systems silently corrupt themselves.
 */
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 128 }).notNull(),
    /** Hash of method+path+body — a reused key with a different body is an error. */
    requestFingerprint: varchar('request_fingerprint', { length: 64 }).notNull(),
    responseStatus: smallint('response_status'),
    responseBody: jsonb('response_body'),
    /** 'in_progress' | 'completed' — guards concurrent duplicate submissions. */
    state: text('state', { enum: ['in_progress', 'completed'] })
      .notNull()
      .default('in_progress'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('idempotency_key_unique').on(t.organizationId, t.key),
    index('idempotency_key_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Record of scheduled job runs. Answers "did last night's expiry scan actually
 * run?" — which is the first question when a pharmacy says alerts stopped.
 */
export const jobRun = pgTable(
  'job_run',
  {
    id: pk(),
    organizationId: fk('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    jobName: varchar('job_name', { length: 64 }).notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed'] })
      .notNull()
      .default('running'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    durationMs: integer('duration_ms'),
    /** Counters: {scanned: 12000, alertsCreated: 43, notificationsQueued: 12} */
    stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`),
    error: text('error'),
  },
  (t) => [
    index('job_run_name_time_idx').on(t.jobName, t.startedAt),
    index('job_run_org_idx').on(t.organizationId, t.startedAt),
  ],
);

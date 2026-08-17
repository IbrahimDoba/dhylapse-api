import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
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
import {
  actors,
  currency,
  fk,
  metadata,
  moneyMinor,
  pk,
  qty,
  timestamps,
  version,
} from './_shared.ts';
import { alertEvent } from './alerts.ts';
import { drugCatalog, product, supplier } from './catalog.ts';
import { batch } from './inventory.ts';
import { appUser, location, organization } from './tenancy.ts';

/**
 * WORKFLOWS
 *
 * Everything that happens *because of* an expiry alert. This is where the
 * product stops being a warning system and starts recovering money — the part
 * a pharmacy can put a number on at the end of the month.
 */

/**
 * What was decided about at-risk stock, and what it was worth.
 *
 * One table rather than separate return/destroy/discount tables: the lifecycle
 * (propose → approve → execute → settle) is identical, and a unified table
 * makes "total recovered this quarter" a single query instead of a union.
 */
export const disposition = pgTable(
  'disposition',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),
    batchId: fk('batch_id')
      .notNull()
      .references(() => batch.id, { onDelete: 'restrict' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),

    reference: varchar('reference', { length: 32 }).notNull(),

    /**
     * 'return_to_supplier' — credit note expected
     * 'destroy'            — regulated destruction, evidence required
     * 'discount'           — sell through at a markdown
     * 'donate'             — write-off with a paper trail
     * 'transfer'           — move to a branch that will use it
     * 'write_off'          — pure loss, nothing recovered
     */
    action: text('action', {
      enum: ['return_to_supplier', 'destroy', 'discount', 'donate', 'transfer', 'write_off'],
    }).notNull(),

    status: text('status', {
      enum: ['proposed', 'approved', 'rejected', 'in_progress', 'completed', 'cancelled'],
    })
      .notNull()
      .default('proposed'),

    quantity: qty('quantity').notNull(),

    /** Book value of the stock being disposed. */
    costValueMinor: moneyMinor('cost_value_minor'),
    /** What we actually got back: credit note, discounted sale, or zero. */
    recoveredValueMinor: moneyMinor('recovered_value_minor'),
    currency: currency(),

    supplierId: fk('supplier_id').references(() => supplier.id, { onDelete: 'set null' }),
    /** Supplier's credit note reference once settled. */
    creditNoteReference: varchar('credit_note_reference', { length: 64 }),
    creditReceivedAt: timestamp('credit_received_at', { withTimezone: true, mode: 'date' }),
    /** Destruction certificate number where the regulator requires one. */
    certificateReference: varchar('certificate_reference', { length: 64 }),
    /** Second signature — destruction of controlled stock needs a witness. */
    witnessedBy: fk('witnessed_by').references(() => appUser.id, { onDelete: 'set null' }),

    /** Links back to the alert that prompted this, for attribution reporting. */
    alertEventId: fk('alert_event_id').references(() => alertEvent.id, { onDelete: 'set null' }),

    proposedBy: fk('proposed_by').references(() => appUser.id, { onDelete: 'set null' }),
    approvedBy: fk('approved_by').references(() => appUser.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),

    reason: text('reason'),
    notes: text('notes'),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('disposition_org_reference_key').on(t.organizationId, t.reference),
    index('disposition_batch_idx').on(t.batchId),
    index('disposition_org_status_idx').on(t.organizationId, t.status, t.createdAt),
    index('disposition_supplier_idx').on(t.supplierId),
    /** Outstanding supplier credits — money owed to the pharmacy. */
    index('disposition_pending_credit_idx')
      .on(t.organizationId, t.supplierId)
      .where(sql`${t.action} = 'return_to_supplier' AND ${t.creditReceivedAt} IS NULL`),
  ],
);

/**
 * Manufacturer or regulator recall. Legally distinct from expiry and always
 * urgent — a recall must be able to sweep every affected batch across every
 * location in one action, including stock already dispensed.
 */
export const recall = pgTable(
  'recall',
  {
    id: pk(),
    /** NULL = a global recall we ingested and fan out to affected tenants. */
    organizationId: fk('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    catalogId: fk('catalog_id').references(() => drugCatalog.id, { onDelete: 'set null' }),

    reference: varchar('reference', { length: 64 }).notNull(),
    /** 'nafdac' | 'manufacturer' | 'internal' | 'who' */
    issuedBy: varchar('issued_by', { length: 32 }).notNull(),
    /** Class I is life-threatening; drives how loudly we alert. */
    classification: varchar('classification', { length: 16 }),
    title: text('title').notNull(),
    description: text('description'),
    /** Lot numbers as published; matched against batch.batchNumber. */
    affectedBatchNumbers: jsonb('affected_batch_numbers').notNull().default(sql`'[]'::jsonb`),
    affectedExpiryFrom: date('affected_expiry_from'),
    affectedExpiryTo: date('affected_expiry_to'),

    status: text('status', { enum: ['open', 'acknowledged', 'closed'] })
      .notNull()
      .default('open'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    sourceUrl: text('source_url'),

    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    index('recall_org_status_idx').on(t.organizationId, t.status),
    index('recall_catalog_idx').on(t.catalogId),
  ],
);

/** Which of a tenant's batches a recall actually hit, and what was done. */
export const recallBatch = pgTable(
  'recall_batch',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    recallId: fk('recall_id')
      .notNull()
      .references(() => recall.id, { onDelete: 'cascade' }),
    batchId: fk('batch_id')
      .notNull()
      .references(() => batch.id, { onDelete: 'cascade' }),

    quantityAffected: qty('quantity_affected'),
    status: text('status', { enum: ['identified', 'quarantined', 'returned', 'destroyed'] })
      .notNull()
      .default('identified'),
    actionedAt: timestamp('actioned_at', { withTimezone: true, mode: 'date' }),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('recall_batch_key').on(t.recallId, t.batchId),
    index('recall_batch_batch_idx').on(t.batchId),
  ],
);

/**
 * Bulk import. Rows land in a staging table first so the user reviews errors
 * before anything touches inventory — "your import silently created 400 wrong
 * batches" is unrecoverable.
 */
export const importJob = pgTable(
  'import_job',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),

    filename: text('filename').notNull(),
    /** 'csv' | 'xlsx' */
    format: varchar('format', { length: 8 }).notNull(),
    byteSize: integer('byte_size'),
    /** Content hash — lets us catch "they uploaded the same file twice". */
    contentHash: varchar('content_hash', { length: 64 }),
    storageKey: text('storage_key'),

    /** Which spreadsheet column maps to which field, remembered per tenant. */
    columnMapping: jsonb('column_mapping').notNull().default(sql`'{}'::jsonb`),

    status: text('status', {
      enum: ['uploaded', 'parsing', 'review', 'committing', 'completed', 'failed', 'cancelled'],
    })
      .notNull()
      .default('uploaded'),

    rowCount: integer('row_count').notNull().default(0),
    validCount: integer('valid_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    committedCount: integer('committed_count').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),

    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [index('import_job_org_status_idx').on(t.organizationId, t.status, t.createdAt)],
);

export const importRow = pgTable(
  'import_row',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    importJobId: fk('import_job_id')
      .notNull()
      .references(() => importJob.id, { onDelete: 'cascade' }),

    lineNumber: integer('line_number').notNull(),
    /** Exactly what was in the file, so the user can see their own data back. */
    raw: jsonb('raw').notNull(),
    /** After parsing and normalisation. */
    normalized: jsonb('normalized'),

    status: text('status', { enum: ['pending', 'valid', 'invalid', 'committed', 'skipped'] })
      .notNull()
      .default('pending'),
    /** [{field, code, message}] — per-field so the UI can highlight cells. */
    errors: jsonb('errors').notNull().default(sql`'[]'::jsonb`),

    createdBatchId: fk('created_batch_id').references(() => batch.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('import_row_key').on(t.importJobId, t.lineNumber),
    index('import_row_status_idx').on(t.importJobId, t.status),
  ],
);

/**
 * An OCR capture and what the model read off it.
 *
 * Kept as its own table rather than folded into batch creation for three
 * reasons: the human correction is the training signal for measuring accuracy
 * over time; a low-confidence scan needs a review queue; and a disputed expiry
 * date needs the original photo alongside it.
 */
export const scan = pgTable(
  'scan',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),

    /** Object-storage key for the captured image. */
    imageKey: text('image_key').notNull(),
    imageWidth: integer('image_width'),
    imageHeight: integer('image_height'),

    /** Model + version, so accuracy can be compared across upgrades. */
    provider: varchar('provider', { length: 32 }),
    model: varchar('model', { length: 64 }),

    /** Raw structured output from the vision model. */
    extraction: jsonb('extraction').notNull().default(sql`'{}'::jsonb`),
    extractedDrugName: text('extracted_drug_name'),
    extractedExpiryDate: date('extracted_expiry_date'),
    extractedBatchNumber: varchar('extracted_batch_number', { length: 64 }),
    confidence: text('confidence', { enum: ['high', 'medium', 'low'] }),

    status: text('status', {
      enum: ['pending', 'extracted', 'needs_review', 'accepted', 'rejected', 'failed'],
    })
      .notNull()
      .default('pending'),

    /** What the human changed it to. The delta is the accuracy metric. */
    correctedFields: jsonb('corrected_fields').notNull().default(sql`'{}'::jsonb`),
    reviewedBy: fk('reviewed_by').references(() => appUser.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),

    createdBatchId: fk('created_batch_id').references(() => batch.id, { onDelete: 'set null' }),

    /** Cost tracking — per-scan spend adds up and needs to be visible. */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),

    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    index('scan_org_status_idx').on(t.organizationId, t.status, t.createdAt),
    index('scan_review_queue_idx')
      .on(t.organizationId, t.createdAt)
      .where(sql`${t.status} = 'needs_review'`),
  ],
);

/**
 * Purchase orders. Not day-one scope, but modelled now because receiving stock
 * against a PO is how batches get created in any pharmacy past a certain size,
 * and bolting it on later means rewriting the receipt path.
 */
export const purchaseOrder = pgTable(
  'purchase_order',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),
    supplierId: fk('supplier_id')
      .notNull()
      .references(() => supplier.id, { onDelete: 'restrict' }),

    reference: varchar('reference', { length: 32 }).notNull(),
    status: text('status', {
      enum: ['draft', 'submitted', 'confirmed', 'partially_received', 'received', 'cancelled'],
    })
      .notNull()
      .default('draft'),

    expectedAt: date('expected_at'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),

    subtotalMinor: moneyMinor('subtotal_minor'),
    taxMinor: moneyMinor('tax_minor'),
    totalMinor: moneyMinor('total_minor'),
    currency: currency(),

    notes: text('notes'),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('purchase_order_org_reference_key').on(t.organizationId, t.reference),
    index('purchase_order_supplier_idx').on(t.supplierId, t.status),
  ],
);

export const purchaseOrderLine = pgTable(
  'purchase_order_line',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    purchaseOrderId: fk('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id, { onDelete: 'cascade' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),

    quantityOrdered: qty('quantity_ordered').notNull(),
    quantityReceived: qty('quantity_received').notNull().default(0),
    unitCostMinor: moneyMinor('unit_cost_minor'),
    currency: currency(),

    /**
     * Reject deliveries that arrive too close to expiry. Pharmacies get dumped
     * on with short-dated stock constantly, and this is the contractual lever.
     */
    minimumShelfLifeDays: integer('minimum_shelf_life_days'),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [index('purchase_order_line_po_idx').on(t.purchaseOrderId)],
);

/** Dispensing / sale, so FEFO picking and depletion have somewhere to record. */
export const dispense = pgTable(
  'dispense',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),
    batchId: fk('batch_id')
      .notNull()
      .references(() => batch.id, { onDelete: 'restrict' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),

    quantity: qty('quantity').notNull(),
    unitPriceMinor: moneyMinor('unit_price_minor'),
    currency: currency(),

    /** Did staff take the batch the system recommended (earliest expiry)? */
    wasFefoCompliant: boolean('was_fefo_compliant'),
    /** Non-compliance is the leading indicator of avoidable expiry waste. */
    fefoOverrideReason: text('fefo_override_reason'),

    prescriptionReference: varchar('prescription_reference', { length: 64 }),
    dispensedBy: fk('dispensed_by').references(() => appUser.id, { onDelete: 'set null' }),
    dispensedAt: timestamp('dispensed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    index('dispense_org_time_idx').on(t.organizationId, t.dispensedAt),
    index('dispense_batch_idx').on(t.batchId),
    index('dispense_product_idx').on(t.productId, t.dispensedAt),
  ],
);

/** Rolling demand signal, refreshed nightly. Turns "180 days of stock left at
 *  current velocity" into a query instead of a scan of every movement. */
export const productDemandStat = pgTable(
  'product_demand_stat',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'cascade' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),

    windowDays: smallint('window_days').notNull().default(90),
    unitsDispensed: qty('units_dispensed').notNull().default(0),
    averageDailyDemand: integer('average_daily_demand_milli').notNull().default(0),
    daysOfCoverRemaining: integer('days_of_cover_remaining'),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('product_demand_stat_key').on(t.locationId, t.productId, t.windowDays)],
);

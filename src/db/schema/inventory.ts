import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  pgTable,
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
import { product, supplier } from './catalog.ts';
import { appUser, location, organization } from './tenancy.ts';

/**
 * INVENTORY
 *
 * Two rules govern everything here:
 *
 * 1. Expiry is a property of a BATCH, never of a product. One product has many
 *    lots with different expiry dates. Collapsing them is why the current
 *    frontend has two contradictory data models.
 *
 * 2. Stock quantity is a LEDGER, not a column. `batch.quantityOnHand` is a
 *    cached balance maintained inside the same transaction as the movement
 *    that changed it. stockMovement is the source of truth. Every "the count
 *    is wrong and nobody knows why" support ticket is a system that skipped
 *    this.
 */

export const batch = pgTable(
  'batch',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),
    supplierId: fk('supplier_id').references(() => supplier.id, { onDelete: 'set null' }),

    /** Lot number as printed. Nullable — plenty of local stock has none. */
    batchNumber: varchar('batch_number', { length: 64 }),

    /**
     * Always a real date, so every comparison and index is simple.
     *
     * Labels routinely print only "EXP 06/2026". We normalise to the last day
     * of that month and record the precision, so the UI can render "Jun 2026"
     * instead of inventing a day and making the pharmacist distrust the record.
     */
    expiryDate: date('expiry_date').notNull(),
    expiryPrecision: text('expiry_precision', { enum: ['day', 'month'] })
      .notNull()
      .default('day'),
    /** True when the date came from OCR and has not been confirmed by a human. */
    expiryIsEstimated: boolean('expiry_is_estimated').notNull().default(false),
    manufacturedDate: date('manufactured_date'),

    /**
     * Multi-dose containers expire twice: the printed date, and N days after
     * first opening. When broached, the job computes the effective date and
     * alerting switches to whichever comes first.
     */
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }),
    effectiveExpiryDate: date('effective_expiry_date'),

    /** Cached balance in base units. Source of truth is stockMovement. */
    quantityOnHand: qty('quantity_on_hand').notNull().default(0),
    /** Reserved by a pending order/dispense but not yet deducted. */
    quantityReserved: qty('quantity_reserved').notNull().default(0),
    /** Denormalised from movements for cheap "as received" reporting. */
    quantityReceived: qty('quantity_received').notNull().default(0),

    /**
     * Cost basis. Without it you cannot answer "how much money is about to
     * expire", which is the number that makes this product worth paying for.
     */
    unitCostMinor: moneyMinor('unit_cost_minor'),
    currency: currency(),

    /**
     * 'active'      — sellable
     * 'quarantined' — pulled from sale pending a decision (recall, damage)
     * 'depleted'    — sold/used down to zero
     * 'disposed'    — destroyed, returned, or written off (see disposition)
     */
    status: text('status', { enum: ['active', 'quarantined', 'depleted', 'disposed'] })
      .notNull()
      .default('active'),

    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Where this row came from: manual, import, ocr, api, purchase_order. */
    sourceKind: text('source_kind', {
      enum: ['manual', 'import', 'ocr', 'api', 'purchase_order', 'transfer'],
    })
      .notNull()
      .default('manual'),
    sourceId: fk('source_id'),

    notes: text('notes'),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    /**
     * The index the whole product runs on: "what is expiring at this location".
     * Partial, because expired/disposed lots are dead weight in the hot path.
     */
    index('batch_expiry_scan_idx')
      .on(t.organizationId, t.locationId, t.expiryDate)
      .where(sql`${t.status} = 'active' AND ${t.deletedAt} IS NULL`),
    index('batch_product_idx').on(t.productId, t.expiryDate),
    index('batch_location_idx').on(t.locationId),
    index('batch_supplier_idx').on(t.supplierId),
    /** Same lot received twice into the same place is a duplicate, not a new batch. */
    uniqueIndex('batch_natural_key')
      .on(t.locationId, t.productId, t.batchNumber, t.expiryDate)
      .where(sql`${t.batchNumber} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * Append-only ledger of every quantity change. Never updated, never deleted.
 *
 * Partition by month on `occurredAt` (see docs/SCHEMA.md) — this is the table
 * that grows without bound, and monthly partitions keep both the hot path and
 * the retention policy cheap.
 */
export const stockMovement = pgTable(
  'stock_movement',
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

    /** Signed. Positive adds stock, negative removes it. */
    quantityDelta: qty('quantity_delta').notNull(),
    /** Running balance after this movement — makes audit reconstruction trivial. */
    balanceAfter: qty('balance_after').notNull(),

    reason: text('reason', {
      enum: [
        'receipt',
        'dispense',
        'sale',
        'return_from_customer',
        'adjustment',
        'stock_count',
        'transfer_out',
        'transfer_in',
        'disposal',
        'return_to_supplier',
        'recall',
        'damage',
        'expiry_writeoff',
      ],
    }).notNull(),

    /** Polymorphic pointer to whatever caused this (order, disposition, count). */
    referenceType: varchar('reference_type', { length: 48 }),
    referenceId: fk('reference_id'),

    unitCostMinor: moneyMinor('unit_cost_minor'),
    currency: currency(),

    /** When it happened in the real world, which is not always when it was recorded. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    recordedAt: timestamps.createdAt,
    actorId: fk('actor_id').references(() => appUser.id, { onDelete: 'set null' }),

    notes: text('notes'),
    metadata: metadata(),
  },
  (t) => [
    index('stock_movement_batch_idx').on(t.batchId, t.occurredAt),
    index('stock_movement_org_time_idx').on(t.organizationId, t.occurredAt),
    index('stock_movement_product_idx').on(t.productId, t.occurredAt),
    index('stock_movement_reference_idx').on(t.referenceType, t.referenceId),
  ],
);

/**
 * Physical stock counts. A pharmacy that cannot reconcile the system against
 * the shelf stops trusting the system, and a count without a recorded variance
 * is just an unexplained adjustment.
 */
export const stockCount = pgTable(
  'stock_count',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),

    reference: varchar('reference', { length: 32 }).notNull(),
    /** 'full' | 'cycle' | 'spot' */
    kind: text('kind', { enum: ['full', 'cycle', 'spot'] })
      .notNull()
      .default('cycle'),
    status: text('status', { enum: ['draft', 'counting', 'review', 'applied', 'cancelled'] })
      .notNull()
      .default('draft'),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
    appliedBy: fk('applied_by').references(() => appUser.id, { onDelete: 'set null' }),

    notes: text('notes'),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('stock_count_org_reference_key').on(t.organizationId, t.reference),
    index('stock_count_location_idx').on(t.locationId, t.status),
  ],
);

export const stockCountLine = pgTable(
  'stock_count_line',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    stockCountId: fk('stock_count_id')
      .notNull()
      .references(() => stockCount.id, { onDelete: 'cascade' }),
    batchId: fk('batch_id')
      .notNull()
      .references(() => batch.id, { onDelete: 'restrict' }),

    /** Balance at the moment the count sheet was generated. */
    expectedQuantity: qty('expected_quantity').notNull(),
    countedQuantity: qty('counted_quantity'),
    varianceReason: text('variance_reason'),
    countedBy: fk('counted_by').references(() => appUser.id, { onDelete: 'set null' }),
    countedAt: timestamp('counted_at', { withTimezone: true, mode: 'date' }),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('stock_count_line_key').on(t.stockCountId, t.batchId),
    index('stock_count_line_batch_idx').on(t.batchId),
  ],
);

/**
 * Inter-branch transfer — the cheapest way to rescue expiring stock in a chain,
 * and impossible to model at all without the location tier.
 */
export const stockTransfer = pgTable(
  'stock_transfer',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    reference: varchar('reference', { length: 32 }).notNull(),
    fromLocationId: fk('from_location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),
    toLocationId: fk('to_location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'restrict' }),

    status: text('status', {
      enum: ['draft', 'in_transit', 'received', 'partially_received', 'cancelled'],
    })
      .notNull()
      .default('draft'),

    dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),
    notes: text('notes'),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('stock_transfer_org_reference_key').on(t.organizationId, t.reference),
    index('stock_transfer_from_idx').on(t.fromLocationId, t.status),
    index('stock_transfer_to_idx').on(t.toLocationId, t.status),
  ],
);

export const stockTransferLine = pgTable(
  'stock_transfer_line',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    stockTransferId: fk('stock_transfer_id')
      .notNull()
      .references(() => stockTransfer.id, { onDelete: 'cascade' }),
    /** Batch at the origin location. */
    batchId: fk('batch_id')
      .notNull()
      .references(() => batch.id, { onDelete: 'restrict' }),
    /** Batch row created at the destination on receipt. */
    destinationBatchId: fk('destination_batch_id').references(() => batch.id, {
      onDelete: 'set null',
    }),

    quantitySent: qty('quantity_sent').notNull(),
    quantityReceived: qty('quantity_received'),

    metadata: metadata(),
    ...timestamps,
  },
  (t) => [index('stock_transfer_line_transfer_idx').on(t.stockTransferId)],
);

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  pgTable,
  text,
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
import { location, organization } from './tenancy.ts';

/**
 * CATALOG
 *
 * Three tiers, and the split is load-bearing:
 *
 *   drugCatalog -> shared reference data ("Metformin 500mg film-coated tablet")
 *   product     -> one tenant's sellable item, with their SKU and pack size
 *   batch       -> a physical lot with an expiry date (see inventory.ts)
 *
 * Without the catalog tier, every pharmacy types the drug name five different
 * ways and no cross-tenant intelligence is possible — no "this NAFDAC number
 * was recalled", no barcode lookup, no autocomplete that improves with use.
 * Without the product tier, one pharmacy's renaming would mutate shared data.
 */

/**
 * Global, cross-tenant reference data. `organization_id` is NULL for rows we
 * curate; a tenant that adds an unknown drug gets a private row scoped to them,
 * which we can later promote to global after review.
 */
export const drugCatalog = pgTable(
  'drug_catalog',
  {
    id: pk(),
    organizationId: fk('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),

    genericName: text('generic_name').notNull(),
    brandName: text('brand_name'),
    strength: varchar('strength', { length: 64 }),
    /** tablet, capsule, syrup, injection, inhaler, cream… */
    dosageForm: varchar('dosage_form', { length: 48 }),
    route: varchar('route', { length: 32 }),
    manufacturer: text('manufacturer'),

    /** WHO Anatomical Therapeutic Chemical code — the portable classifier. */
    atcCode: varchar('atc_code', { length: 16 }),
    /** Nigeria's regulator. Generalise per-country via `regulatoryIds`. */
    nafdacNumber: varchar('nafdac_number', { length: 32 }),
    /** Other regulators keyed by scheme, e.g. {"rxcui": "...", "dmd": "..."}. */
    regulatoryIds: metadata(),
    /** GS1 barcode. Nullable — a lot of local stock simply has none. */
    gtin: varchar('gtin', { length: 14 }),

    /** Controlled-substance schedule. Drives stricter alerting and audit. */
    controlledSchedule: varchar('controlled_schedule', { length: 16 }),
    /** 'ambient' | 'cold_chain' | 'frozen' | 'controlled_room' */
    storageCondition: text('storage_condition', {
      enum: ['ambient', 'cold_chain', 'frozen', 'controlled_room'],
    })
      .notNull()
      .default('ambient'),

    /**
     * How long the drug stays usable after opening. A multi-dose vial with a
     * 2027 expiry is worthless 28 days after it is broached — pharmacies lose
     * real money here and no expiry tracker that ignores it is trusted twice.
     */
    shelfLifeAfterOpeningDays: integer('shelf_life_after_opening_days'),

    isActive: boolean('is_active').notNull().default(true),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    index('drug_catalog_generic_idx').on(t.genericName),
    index('drug_catalog_org_idx').on(t.organizationId),
    uniqueIndex('drug_catalog_nafdac_key')
      .on(t.nafdacNumber)
      .where(sql`${t.nafdacNumber} IS NOT NULL AND ${t.organizationId} IS NULL`),
    uniqueIndex('drug_catalog_gtin_key')
      .on(t.gtin)
      .where(sql`${t.gtin} IS NOT NULL AND ${t.organizationId} IS NULL`),
  ],
);

/**
 * Tenant-extensible lookup rather than a pgEnum. Pharmacies categorise stock
 * their own way ("Antimalarial", "OTC front-of-shop") and adding a value must
 * never require a deploy.
 */
export const productCategory = pgTable(
  'product_category',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Self-reference for sub-categories; kept shallow in the UI. */
    parentId: fk('parent_id').references((): AnyPgColumn => productCategory.id, {
      onDelete: 'set null',
    }),
    colorHex: varchar('color_hex', { length: 7 }),
    sortOrder: integer('sort_order').notNull().default(0),
    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('product_category_org_name_key')
      .on(t.organizationId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * Unit of measure, with a conversion factor to the base unit tracked in stock.
 *
 * This is the answer to "my supplier sells cartons, I dispense tablets".
 * Quantities are always persisted in base units; UOM is a presentation and
 * data-entry concern.
 */
export const unitOfMeasure = pgTable(
  'unit_of_measure',
  {
    id: pk(),
    /** NULL = system-provided unit available to every tenant. */
    organizationId: fk('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    /** How many base units one of these contains. A carton of 24 => 24. */
    baseUnitsPer: integer('base_units_per').notNull().default(1),
    metadata: metadata(),
    ...timestamps,
  },
  (t) => [uniqueIndex('unit_of_measure_org_code_key').on(t.organizationId, t.code)],
);

export const supplier = pgTable(
  'supplier',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: varchar('code', { length: 32 }),
    email: text('email'),
    phone: varchar('phone', { length: 32 }),
    addressLine1: text('address_line1'),
    city: text('city'),
    countryCode: varchar('country_code', { length: 2 }),

    /**
     * The commercial terms that decide whether expiring stock is recoverable
     * value or a write-off. Surfacing "returnable until 90 days before expiry"
     * next to an alert is the difference between a warning and a saved sale.
     */
    acceptsReturns: boolean('accepts_returns').notNull().default(false),
    returnWindowDaysBeforeExpiry: integer('return_window_days_before_expiry'),
    returnPolicyNotes: text('return_policy_notes'),
    creditRatePercent: integer('credit_rate_percent'),
    leadTimeDays: integer('lead_time_days'),

    isActive: boolean('is_active').notNull().default(true),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    index('supplier_org_idx').on(t.organizationId),
    uniqueIndex('supplier_org_code_key')
      .on(t.organizationId, t.code)
      .where(sql`${t.code} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * A tenant's sellable item. Stock levels, reorder points, and pricing live
 * here; expiry lives on the batch.
 */
export const product = pgTable(
  'product',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Optional link to shared reference data. Nullable so entry is never blocked. */
    catalogId: fk('catalog_id').references(() => drugCatalog.id, { onDelete: 'set null' }),
    categoryId: fk('category_id').references(() => productCategory.id, { onDelete: 'set null' }),

    name: text('name').notNull(),
    sku: varchar('sku', { length: 64 }),
    barcode: varchar('barcode', { length: 32 }),

    /** Unit stock is counted in (tablets, vials, bottles). */
    baseUomId: fk('base_uom_id').references(() => unitOfMeasure.id, { onDelete: 'set null' }),
    /** Unit purchasing usually happens in (carton, pack). */
    purchaseUomId: fk('purchase_uom_id').references(() => unitOfMeasure.id, {
      onDelete: 'set null',
    }),

    /** Denormalised from catalog so per-product overrides are possible. */
    storageCondition: text('storage_condition', {
      enum: ['ambient', 'cold_chain', 'frozen', 'controlled_room'],
    })
      .notNull()
      .default('ambient'),
    isControlled: boolean('is_controlled').notNull().default(false),
    requiresPrescription: boolean('requires_prescription').notNull().default(false),

    /** Nullable so "we don't track reorder for this" is distinct from zero. */
    reorderPoint: qty('reorder_point'),
    reorderQuantity: qty('reorder_quantity'),
    /** Feeds the Dashboard's `stock / max` progress bars honestly. */
    targetStockLevel: qty('target_stock_level'),

    defaultCostMinor: moneyMinor('default_cost_minor'),
    defaultPriceMinor: moneyMinor('default_price_minor'),
    currency: currency(),

    isActive: boolean('is_active').notNull().default(true),
    metadata: metadata(),
    version: version(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    index('product_org_idx').on(t.organizationId),
    index('product_catalog_idx').on(t.catalogId),
    uniqueIndex('product_org_sku_key')
      .on(t.organizationId, t.sku)
      .where(sql`${t.sku} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index('product_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

/**
 * Per-location overrides. A chain's Lekki branch and Ikeja branch stock the
 * same product at very different volumes; one global reorder point produces
 * alerts nobody trusts.
 */
export const productLocationSetting = pgTable(
  'product_location_setting',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    locationId: fk('location_id')
      .notNull()
      .references(() => location.id, { onDelete: 'cascade' }),

    reorderPoint: qty('reorder_point'),
    reorderQuantity: qty('reorder_quantity'),
    targetStockLevel: qty('target_stock_level'),
    priceMinor: moneyMinor('price_minor'),
    isStocked: boolean('is_stocked').notNull().default(true),

    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('product_location_setting_key').on(t.productId, t.locationId),
    index('product_location_setting_location_idx').on(t.locationId),
  ],
);

/** Which suppliers can supply a product, and on what terms. */
export const productSupplier = pgTable(
  'product_supplier',
  {
    id: pk(),
    organizationId: fk('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    productId: fk('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    supplierId: fk('supplier_id')
      .notNull()
      .references(() => supplier.id, { onDelete: 'cascade' }),

    supplierSku: varchar('supplier_sku', { length: 64 }),
    lastCostMinor: moneyMinor('last_cost_minor'),
    currency: currency(),
    leadTimeDays: integer('lead_time_days'),
    minimumOrderQuantity: qty('minimum_order_quantity'),
    isPreferred: boolean('is_preferred').notNull().default(false),

    metadata: metadata(),
    ...timestamps,
    ...actors,
  },
  (t) => [
    uniqueIndex('product_supplier_key').on(t.productId, t.supplierId),
    index('product_supplier_supplier_idx').on(t.supplierId),
  ],
);

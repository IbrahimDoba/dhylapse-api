import { sql } from 'drizzle-orm';
import { bigint, jsonb, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Shared column conventions.
 *
 * Every choice here is about keeping the schema adjustable later without a
 * painful migration. See docs/SCHEMA.md for the rationale behind each one.
 */

/**
 * UUIDv7 primary key. Time-ordered, so inserts append to the right of the
 * B-tree instead of scattering across it the way UUIDv4 does — this matters
 * a lot once stock_movement is in the tens of millions of rows.
 *
 * `uuidv7()` is native in Postgres 18. On 17 or earlier, either install the
 * pg_uuidv7 extension or drop the `.default()` and generate IDs in the app.
 */
export const pk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

/** Foreign-key column to another table's UUID pk. */
export const fk = (name: string) => uuid(name);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Soft delete. Nothing a pharmacy touches is ever hard-deleted — regulators,
 * disputes, and "who removed this batch?" all need the row to still exist.
 * Every read path must filter `deleted_at IS NULL`.
 */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true, mode: 'date' });

export const timestamps = {
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
};

/**
 * Actor columns. Nullable because rows can originate from a job, an import, or
 * a webhook rather than a person. FK is declared at the table level to avoid a
 * circular import with the user table.
 */
export const actors = {
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
};

/**
 * Escape hatch for per-tenant fields we haven't modelled yet.
 *
 * When a pharmacy asks for "just one more field", it goes here first. If three
 * tenants ask for the same one, it graduates to a real column. This is the
 * difference between a two-day turnaround and a schema migration every time.
 */
export const metadata = () => jsonb('metadata').notNull().default(sql`'{}'::jsonb`);

/**
 * Optimistic concurrency. Two staff editing the same batch on the shop floor is
 * routine; last-write-wins silently destroying a stock correction is not.
 * Bump on every write; reject the write if the client's version is stale.
 */
export const version = () => bigint('version', { mode: 'number' }).notNull().default(1);

/**
 * Money is stored as integer minor units (kobo, cents) plus an explicit
 * currency. Never floats — 0.1 + 0.2 problems in a stock-valuation report
 * destroy trust in the whole product. `bigint` in minor units comfortably
 * covers any realistic pharmacy inventory value.
 */
export const moneyMinor = (name: string) => bigint(name, { mode: 'number' });
export const currency = (name = 'currency') => varchar(name, { length: 3 });

/**
 * Quantities are integers in the product's smallest tracked unit (see
 * catalog.unitOfMeasure). Storing "1.5 packs" is how inventory systems start
 * disagreeing with the physical shelf.
 */
export const qty = (name: string) => bigint(name, { mode: 'number' });

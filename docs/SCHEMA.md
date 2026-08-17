# Dhylapse — Data Model

Design rationale for `src/db/schema`. Read this before changing a table.

The schema is built backwards from complaints. Every non-obvious decision below
exists because a pharmacy would otherwise hit a wall we'd have to migrate out
of. Where a choice was between "simple now" and "adjustable later", adjustable
won — but only where the later migration would have been genuinely painful.

---

## 1. The five structural decisions

Everything else follows from these. They are the ones that are expensive to
reverse.

### 1.1 The tenant is an organization, not a pharmacy

```
organization ─┬─ location (Lekki)
              └─ location (Ikeja)
```

A pharmacy opening a second branch is the success case, not the edge case. A
flat `pharmacy_id` tenant model means that when it happens you rewrite every
query, every permission check, and every report — and you do it under time
pressure, for your best customer.

A single-shop tenant gets exactly one location and never sees the concept.
`organization_id` is on every tenant table and is the RLS key; `location_id` is
on anything physical.

This also unlocks inter-branch transfer, which is the cheapest way to rescue
expiring stock and impossible to model without it.

### 1.2 Expiry belongs to a batch, never to a product

```
product (Metformin 500mg)
  ├─ batch  MET-2024-A   exp 2026-06-19   qty 40
  └─ batch  MET-2024-B   exp 2027-01-30   qty 200
```

One product, many lots, different dates. The current frontend collapses these,
which is why `Dashboard.tsx` and `mock/pharma.ts` disagree about what a row is.
Stock level for a product is `SUM(quantity_on_hand)` over its active batches —
derived, not stored twice.

### 1.3 Quantity is a ledger, not a column

`stock_movement` is append-only and immutable. `batch.quantity_on_hand` is a
cached balance maintained by a trigger inside the same transaction, so no code
path can change stock without writing a ledger row. Corrections are compensating
entries, never edits.

Every "the count is wrong and nobody knows why" support ticket comes from a
system that stored quantity as a mutable integer. Once trust in the number goes,
the product is dead — pharmacists go back to the spreadsheet.

### 1.4 Alert thresholds are data, not constants

The 180/90/30/7 ladder is seeded rows in `alert_rule`, scoped by
organization → location → category → product, with most-specific-wins
resolution. "We want 60 days" and "cold-chain needs earlier warning" are
settings changes.

`alert_event` has a unique index on `(alert_rule_id, batch_id)`, which is the
exactly-once guarantee: a threshold fires once per batch, ever, no matter how
many times the scan job runs, crashes mid-way, or is replayed after an outage.

### 1.5 Nothing is hard-deleted

`deleted_at` everywhere, plus `audit_log` recording before/after on every
mutation. Regulators, disputes, and "who removed this batch?" all need the row
to still exist. Every read path filters `deleted_at IS NULL`.

---

## 2. What users will complain about, and where it lands

| Complaint | Schema answer |
|---|---|
| "We opened a second branch" | `location`, `membership_location`, `stock_transfer` |
| "The label only says 06/2026" | `batch.expiry_precision`, normalised to last-of-month |
| "This vial expires 28 days after opening, not in 2027" | `batch.opened_at` + `drug_catalog.shelf_life_after_opening_days` → `effective_expiry_date` trigger |
| "Your count doesn't match my shelf" | `stock_movement` ledger + `stock_count` / `stock_count_line` with recorded variance |
| "Who changed this?" | `audit_log`, `created_by` / `updated_by` on every table |
| "It emailed me 50 times" | `notification_preference` cadence, quiet hours, digest bundling via `notification.alert_event_ids` |
| "I never got the alert" | `notification_delivery` with provider message id, status, bounce tracking |
| "I want WhatsApp alerts" | `channel` is a value, not a column; add to the enum + a sender |
| "Alert me at 60 days, not 90" | `alert_rule.threshold_days` |
| "Only alert me if it's worth over ₦5,000" | `alert_rule.conditions` JSONB predicate |
| "Stop alerting me about this one" | `alert_event.status` = `dismissed`, `acknowledged_by` |
| "Nobody actioned the alert" | `alert_event.assigned_to`, `resolved_at` |
| "How much did we lose last quarter?" | `batch.unit_cost_minor` + `disposition.cost_value_minor` / `recovered_value_minor` |
| "Can I return this to the supplier?" | `supplier.accepts_returns`, `return_window_days_before_expiry`, `disposition` |
| "Where's my credit note?" | `disposition.credit_note_reference`, `credit_received_at`, partial index on pending credits |
| "The regulator wants destruction evidence" | `disposition.certificate_reference`, `witnessed_by`, `attachment` |
| "There's a recall on this lot" | `recall` + `recall_batch`, sweeps every location at once |
| "My supplier sells cartons, I dispense tablets" | `unit_of_measure.base_units_per`, `product.base_uom_id` / `purchase_uom_id` |
| "The same drug is in here five different ways" | `drug_catalog` shared tier + `product.catalog_id` |
| "Lekki needs a different reorder point to Ikeja" | `product_location_setting` |
| "They shipped us short-dated stock" | `purchase_order_line.minimum_shelf_life_days` |
| "Staff keep grabbing the newest box" | `dispense.was_fefo_compliant`, `fefo_override_reason` |
| "Tomi can approve disposals but not invite staff" | `membership.permissions` additive grants |
| "That staff member left months ago" | `membership.status`, `invitation` lifecycle with expiry and revocation |
| "I work for two pharmacies" | `app_user` is global; `membership` is the join |
| "Two of us edited it at once" | `version` column, optimistic concurrency |
| "The import created 400 wrong batches" | `import_job` → `import_row` staging with per-cell errors, review before commit |
| "OCR read the date wrong" | `scan.corrected_fields`, `confidence`, review queue, original image retained |
| "My double-tap created two receipts" | `idempotency_key` |
| "Did last night's scan even run?" | `job_run` with stats and error |
| "I need this in my POS" | `api_key`, `webhook_endpoint`, `webhook_delivery` |
| "Can you add just one field?" | `metadata` JSONB on every major entity |
| "Can you add a toggle?" | `org_setting` namespaced key/value |

---

## 3. Column conventions

Defined once in `_shared.ts`, applied everywhere.

| Convention | Choice | Why |
|---|---|---|
| Primary keys | UUIDv7 | Time-ordered, so inserts append to the right of the B-tree. UUIDv4 scatters writes and destroys insert performance once `stock_movement` is large. Native `uuidv7()` in PG18. |
| Money | `bigint` minor units + `currency` char(3) | Never floats. A stock-valuation report that's off by a kobo because of `0.1 + 0.2` costs you the customer's trust in every other number. |
| Quantities | `bigint` in base units | "1.5 packs" is how a system starts disagreeing with the shelf. |
| Enums | `text` + TS union + CHECK | Not `pgEnum`. Postgres enum values can be added but never removed or reordered without a type rewrite. A CHECK constraint is a one-line migration. |
| Extensible sets | Lookup tables | `product_category`, `unit_of_measure` — tenants invent their own; adding one must never need a deploy. |
| Timestamps | `timestamptz` | Always. A Lagos pharmacy and a UTC server disagreeing about "today" silently shifts every expiry calculation by a day. |
| Dates | `date` for expiry | Expiry is a calendar day, not an instant. No timezone should apply. |
| Soft delete | `deleted_at` + partial unique indexes | Uniqueness applies only to live rows, so a deleted SKU can be recreated. |
| Extension | `metadata` JSONB | Ask goes here first; graduates to a real column when three tenants want it. |

### Occurred vs recorded

`stock_movement` has both `occurred_at` and `recorded_at`. Stock received on
Friday and entered on Monday is normal, and reports keyed to the wrong one are
wrong in a way nobody can explain.

---

## 4. Tenant isolation

Two locks:

1. **Application** — every query scoped by `organization_id`.
2. **Database** — RLS policies keyed on `current_org_id()`, read from
   `app.organization_id`, set with `SET LOCAL` per request transaction.

`SET LOCAL` matters: it is scoped to the transaction, so a pooled connection
cannot leak the setting into the next request. Policies use `FORCE ROW LEVEL
SECURITY` so the table owner is subject to them too.

`drug_catalog`, `recall`, `audit_log`, and `job_run` allow `organization_id IS
NULL` for shared reference data — readable by all, writable only as owned rows.

A missing `WHERE` clause should be a bug, not a breach.

---

## 5. Scale

The three tables that grow without bound:

| Table | Growth | Plan |
|---|---|---|
| `stock_movement` | every quantity change | Monthly RANGE partitions on `occurred_at` |
| `audit_log` | every mutation | Monthly RANGE partitions on `occurred_at` |
| `webhook_delivery` | every outbound call | Monthly partitions + short retention |

Not needed on day one; the DDL is in `sql/0003_partitioning.sql` so the cutover
is planned rather than discovered. Do it before the first table passes ~50M
rows — converting a large table to partitioned requires a full rewrite and an
outage. Retention then becomes `DETACH` + `DROP` of one partition (instant)
rather than a `DELETE` over millions of rows.

### The index the product runs on

```sql
CREATE INDEX batch_expiry_scan_idx
  ON batch (organization_id, location_id, expiry_date)
  WHERE status = 'active' AND deleted_at IS NULL;
```

Partial, because expired and disposed lots are dead weight in the nightly scan
— the single hottest query in the system.

---

## 6. Table map

**Tenancy** — `organization`, `location`, `app_user`, `membership`,
`membership_location`, `invitation`

**Catalog** — `drug_catalog`, `product`, `product_category`, `unit_of_measure`,
`supplier`, `product_supplier`, `product_location_setting`

**Inventory** — `batch`, `stock_movement`, `stock_count`, `stock_count_line`,
`stock_transfer`, `stock_transfer_line`

**Alerts** — `alert_rule`, `alert_event`, `notification`,
`notification_delivery`, `notification_preference`, `push_subscription`

**Workflows** — `disposition`, `recall`, `recall_batch`, `import_job`,
`import_row`, `scan`, `purchase_order`, `purchase_order_line`, `dispense`,
`product_demand_stat`

**Platform** — `audit_log`, `attachment`, `org_setting`, `api_key`,
`webhook_endpoint`, `webhook_delivery`, `idempotency_key`, `job_run`

better-auth owns its own credential tables (`account`, `session`,
`verification`) and points at `app_user`.

---

## 7. Deliberately deferred

Not built, but the schema leaves room:

- **Custom role definitions** — `membership.permissions` carries the strings; a
  `role` table can supply presets later without changing the check.
- **Cold-chain excursion logging** — `product.storage_condition` exists; the
  temperature event stream is a separate table when a customer needs it.
- **Multi-currency reporting** — amounts carry their currency; an FX rate table
  is additive.
- **Full POS / dispensing** — `dispense` records the minimum needed for FEFO
  compliance and demand stats, not a till.
- **Prescription management** — `dispense.prescription_reference` is a pointer,
  not a model.

---

## 8. Build order

1. `sql/0001_extensions.sql`
2. `pnpm db:generate && pnpm db:migrate`
3. `sql/0002_rls.sql`, `sql/0004_derived.sql`
4. Seed: system units of measure, default alert rules per new organization
5. `sql/0003_partitioning.sql` — when volume warrants it

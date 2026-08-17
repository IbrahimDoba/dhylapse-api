# dhylapse-api

Backend for [Dhylapse](../dhylapse) — pharmacy expiry management.

Fastify + TypeScript + Postgres + Drizzle. Companion repo to the React frontend.

## Status

Schema design complete. No API routes yet — the data model is being reviewed
before the backend is built.

## Setup

```sh
pnpm install
cp .env.example .env
pnpm db:up          # postgres 18 in docker
psql "$DATABASE_URL" -f src/db/sql/0001_extensions.sql
pnpm db:generate    # drizzle-kit: schema -> migration
pnpm db:migrate
psql "$DATABASE_URL" -f src/db/sql/0002_rls.sql
psql "$DATABASE_URL" -f src/db/sql/0004_derived.sql
```

## Layout

```
src/db/schema/     Drizzle table definitions
  _shared.ts       column conventions (ids, money, timestamps, soft delete)
  tenancy.ts       organization, location, user, membership
  catalog.ts       drug catalog, product, supplier, UOM
  inventory.ts     batch, stock ledger, counts, transfers
  alerts.ts        alert rules, events, notifications, deliveries
  workflows.ts     disposition, recall, import, OCR scan, purchasing
  platform.ts      audit, attachments, settings, API keys, webhooks, jobs

src/db/sql/        what Drizzle can't express — RLS, triggers, partitioning
docs/SCHEMA.md     design rationale — read before changing a table
```

## Design

See [docs/SCHEMA.md](docs/SCHEMA.md). Five decisions drive everything:

1. The tenant is an **organization** with many **locations**, not a single pharmacy.
2. Expiry belongs to a **batch**, never a product.
3. Quantity is an append-only **ledger**; the balance on `batch` is a cache.
4. Alert thresholds are **data** (`alert_rule`), not constants.
5. Nothing is hard-deleted; everything is audited.

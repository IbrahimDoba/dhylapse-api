# dhylapse-api

Backend for [Dhylapse](../dhylapse) — pharmacy expiry management.

Fastify + TypeScript + Postgres + Drizzle. Companion repo to the React frontend.

## Status

Schema verified against Postgres 18. Fastify skeleton runs with tenant-scoped
database access, boot-time configuration checks, and health endpoints. Auth,
inventory, and the expiry engine are next.

## Setup

Postgres **18+** is required — the schema uses native `uuidv7()`.

```sh
pnpm install
cp .env.example .env
```

Start Postgres, either with Docker:

```sh
pnpm db:up
```

or with Homebrew, if you don't run Docker:

```sh
brew install postgresql@18 && brew services start postgresql@18
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
createuser -s dhylapse && createdb -O dhylapse dhylapse
```

Then apply the schema **in this order**:

```sh
export DATABASE_URL=postgres://dhylapse:dhylapse@localhost:5432/dhylapse

psql "$DATABASE_URL" -f src/db/sql/0001_extensions.sql   # pg_trgm, citext, uuidv7 check
pnpm db:migrate                                          # 43 tables
psql "$DATABASE_URL" -f src/db/sql/0002_rls.sql          # tenant isolation
psql "$DATABASE_URL" -f src/db/sql/0004_derived.sql      # ledger triggers + constraints
psql "$DATABASE_URL" -f src/db/sql/0005_app_role.sql     # unprivileged app role
psql "$DATABASE_URL" -f src/db/verify.sql                # prove it works
```

Then run it:

```sh
cp .env.example .env      # DATABASE_URL must point at dhylapse_app
pnpm dev                  # http://localhost:3001/health
pnpm check:tenant         # prove isolation holds through the app, not just the DB
```

> **Do not stop after `db:migrate`.** That leaves you with a schema that has
> **no tenant isolation and no ledger enforcement**, and nothing will tell you.
> Steps 3 and 4 are what make the guarantees real. `verify.sql` prints ten
> `PASS` lines when the database is set up correctly.

Tenant isolation is enforced for unprivileged roles only — superusers bypass
RLS. The app must connect as `dhylapse_app`, never as the migration role. The
server checks this at boot and refuses to start otherwise, so a misconfigured
deploy fails loudly instead of serving one tenant's stock to another.

Every tenant-scoped query goes through `withTenant(orgId, fn)`, which opens a
transaction and sets `app.organization_id` for its duration. Forgetting it
returns zero rows, never another tenant's data.

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

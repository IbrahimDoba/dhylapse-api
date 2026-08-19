# dhylapse-api

Backend for [Dhylapse](../dhylapse) — pharmacy expiry management.

Fastify + TypeScript + Postgres + Drizzle. Companion repo to the React frontend.

## Status

Schema verified against Postgres 18. Fastify runs with tenant-scoped database
access, boot-time configuration checks, and authentication: sign-up, sessions,
workspace bootstrapping, and membership resolution work end to end. Inventory
and the expiry engine are next.

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
psql "$DATABASE_URL" -f src/db/sql/0006_bootstrap.sql    # signup bootstrap function
psql "$DATABASE_URL" -f src/db/verify.sql                # prove it works
```

Or run the whole sequence:

```sh
./scripts/db-setup.sh --reset
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

Every tenant-scoped query goes through `withTenant({ organizationId, userId })`,
which opens a transaction and sets both values for its duration. Forgetting it
returns zero rows, never another tenant's data.

RLS has two dimensions. `app.organization_id` scopes tenant data; `app.user_id`
is what lets someone see which organizations they belong to *before* one is
selected — otherwise an org switcher is impossible without a hole in the policy.
`withUser(userId, fn)` sets identity only.

`organization` cannot be inserted by the app role at all, so signup goes through
the `bootstrap_organization` SECURITY DEFINER function, which creates the org,
its first location, an owner membership, and the default alert ladder in one
transaction.

## Auth

better-auth owns the credential plane (`app_user`, `auth_session`,
`auth_account`, `auth_verification`) and is mounted at `/api/auth/*`. It does
not own tenancy: a session says who someone is, `membership` says which
organizations they may act for.

```
POST /api/auth/sign-up/email    { email, password, name }
POST /api/auth/sign-in/email    { email, password }
GET  /api/me                    identity + memberships + active org
POST /api/workspaces            { name } -> org, location, alert rules
```

Requests select a workspace with the `X-Organization-Id` header. A header naming
an organization the caller is not a member of is ignored, not honoured.

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

# dhylapse-api

Backend for [Dhylapse](../dhylapse) — pharmacy expiry management.

Fastify + TypeScript + Postgres + Drizzle. Companion repo to the React frontend.

## Status

Schema verified against Postgres 18. Fastify runs with tenant-scoped database
access, boot-time configuration checks, and authentication: sign-up, sessions,
workspace bootstrapping, and membership resolution work end to end. Inventory
is in: products, batches, and a ledger-backed stock trail. CSV import and the
expiry engine are next.

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

## Suppliers and recovery

```
GET  /api/suppliers                    with return terms
POST /api/suppliers
GET  /api/batches/:id/options          is this returnable, and for how much?
GET  /api/dispositions                 + recovery summary
POST /api/dispositions                 propose
POST /api/dispositions/:id/approve
POST /api/dispositions/:id/complete    moves stock, records what came back
```

This is the half that recovers money rather than reporting loss. An expiry
alert says something bad is coming; a disposition records what was done about
it and how much came back.

`/options` answers the question the alert raises but cannot: a lot 40 days from
expiry against a supplier with a 90-day return window has already missed it,
and saying so before someone wastes a phone call is the point. Expired stock is
reported as expired rather than as out-of-window — the window test is trivially
true once a date has passed, and "discount or dispose" is wrong advice for
stock that must be destroyed with a certificate.

Proposing needs `inventory.write`; approving and completing need
`disposal.approve`, so counter staff can raise a write-off and cannot sign it
off. Only completion moves stock, and it moves through the ledger like
everything else. A discount is a pricing decision, so it records the decision
without removing units — those leave later through ordinary dispensing.

## Import

```
POST /api/imports              multipart CSV or XLSX -> staged, nothing applied
GET  /api/imports/:id          staged rows with per-field errors
POST /api/imports/:id/commit   apply the valid rows, in one transaction
GET  /api/imports
```

Nothing touches inventory on upload. Rows land in `import_row` with per-field
errors so the pharmacist reviews their own data first — "your import silently
created 400 wrong batches" is unrecoverable.

Real files are messy, and that is normal input rather than user error. Column
headings are matched by synonym (`Exp. Date`, `LOT NO`, `qty` all work), dates
are read in seven formats including the `06/27` printed on blister packs,
`"1,200"` and `₦110.00` parse, trailing blank rows are ignored, and a bad row
is listed rather than failing the file. `31/06/2027` is rejected — June has
30 days.

Committed rows post a `receipt` to the ledger exactly as a manual entry does.
Re-uploading an identical file is detected by content hash and warned about,
because lots *with* a lot number are caught by the batch natural key but rows
without one cannot be.

## Expiry alerts

```
GET  /api/alerts                  ?status=open|acknowledged|all
POST /api/alerts/:id/acknowledge
GET  /api/notifications           in-app feed for the signed-in user
POST /api/alerts/scan             run the scan on demand (owner only)
```

The scan runs hourly and does real work at most once a day, guarded by a
Postgres advisory lock so only one instance scans when several are deployed.
`POST /api/alerts/scan` exists because "wait until tonight" is a miserable way
to verify alerting.

**One rung per batch per scan.** A batch fires the narrowest threshold it has
entered — 5 days out fires the 7-day rule, not 180/90/30/7 all at once. As it
ages it climbs the ladder, one alert per rung, each exactly once. The unique
index on `(alert_rule_id, batch_id)` is what guarantees that: a crash mid-run,
a retry, or two workers racing all converge on the same result.

**Scope is most-specific-wins.** A rule on one product replaces the
organization ladder for that product rather than adding a second alert.

The scan is cross-tenant, which RLS forbids — so it enumerates organizations
through a SECURITY DEFINER function that returns nothing else, then processes
each tenant through the normal `withTenant` path. A worker role with
`BYPASSRLS` would be simpler and much worse: every query it ran would be
unprotected forever, for the convenience of one enumeration.

## Workspace, staff, alerts

```
GET  /api/dashboard         summary counts + value at risk, one query
GET  /api/workspace         org profile + locations
GET  /api/staff             everyone with access
GET  /api/alert-rules       the configured expiry ladder
```

## Inventory

```
GET  /api/locations
GET  /api/products                 ?q= &limit= &cursor=
POST /api/products                 { name, sku?, reorderPoint?, ... }
GET  /api/batches                  ?withinDays= &locationId= &productId=
POST /api/batches                  { productId, expiryDate, quantity, ... }
POST /api/batches/:id/adjust       { quantityDelta, reason }
GET  /api/batches/:id/movements    full ledger history
```

Three things worth knowing:

**Stock only ever moves through the ledger.** `POST /api/batches` creates the
row with a zero balance and applies the quantity as a `receipt` movement; a
trigger maintains `quantity_on_hand`. There is no endpoint that writes a
quantity directly, and corrections are compensating entries, never edits.

**`expiryDate` accepts `YYYY-MM`.** Labels routinely print only a month, so
`2026-11` is stored as `2026-11-30` with `expiryPrecision: "month"` — the UI can
render "Nov 2026" instead of inventing a day.

**Product quantity is derived**, summed across active batches. It is never
stored in two places.

Capabilities are checked per action, not per role — see `src/lib/permissions.ts`.
Counter `staff` can receive stock and acknowledge alerts but cannot adjust
balances or approve write-offs.

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md). One container, one Postgres 18 database.
`Dockerfile`, `render.yaml` and `railway.json` are here.

The one thing to get right: the app must connect as `dhylapse_app`, never the
database owner, or RLS is silently disabled. The server refuses to boot
otherwise, which makes the first deploy a two-pass process — documented.

## Demo data

```sh
./scripts/db-setup.sh --reset
pnpm dev            # in one terminal
pnpm seed:demo      # in another
```

Creates Greenline Pharmacy with 15 products, 37 batches across every alert
band (including some already expired), dispensing history, and alerts already
raised. Log in as `demo@greenline.ng` / `demo-pharmacy-2026`.

It drives the HTTP API rather than writing rows directly, so the data lands
exactly as a real user's would — batches post to the ledger, alerts come from
the real scan. A fixture that bypasses the app hides the bugs a demo should
surface.

## Checks

```sh
pnpm test           # everything below, in order
pnpm check          # typecheck
pnpm test:unit      # 36 unit tests, no database
pnpm db:verify      # 10 schema invariants (rolls back, safe on a live db)
pnpm check:tenant   # tenant isolation through the app's own code path
pnpm check:api      # 18 end-to-end API assertions via fastify inject()
```

### Performance

```sh
pnpm seed:perf 200000   # 3 orgs x 200k batches (~600k rows, 367 MB, ~20s)
pnpm perf               # hot-path timings + query-plan assertions
```

Every measurement runs through `withTenant` as the unprivileged role, so RLS is
active — timing raw SQL as a superuser would flatter all of it. Three tenants,
not one, because an isolation predicate costs nothing when there is no other
tenant's data to filter out.

Each check asserts a wall-clock budget **and** the query plan. The plan
assertion is the one that matters: a query that is fast on 20k rows while
sequential-scanning is a query that falls over at 600k, and it passes a timing
test right up until it doesn't. At 600k batches:

| query | p50 | budget |
|---|---|---|
| expiry scan, 90-day window | 0.7ms | 8ms |
| inventory list, first page (FEFO) | 0.6ms | 8ms |
| inventory list, page 200 (keyset) | 0.9ms | 8ms |
| product rollup (LATERAL per page) | 8.1ms | 25ms |
| value at risk, 30-day window | 28ms | 40ms |
| ledger write (row-locked) | 0.7ms | 25ms |

Three problems the perf suite found that the correctness tests could not:

1. **The expiry index was never used.** It was keyed on `expiry_date` while
   every read ordered by `COALESCE(effective_expiry_date, expiry_date)`.
   Postgres filtered the whole tenant and top-N sorted the remainder.
   `effective_expiry_date` is now `NOT NULL` (the trigger always sets it) and
   indexed directly.
2. **Keyset pagination degraded to O(offset).** A row-wise cursor comparison
   only becomes an `Index Cond` when the leading key is a plain column and the
   types match exactly. One implicit `date` → `timestamp` coercion pushed it
   into a `Filter`: 0.03ms → 46ms, same results. `perf-check` now asserts the
   cursor appears in `Index Cond`.
3. **The product rollup aggregated every batch before applying LIMIT.**
   Rewritten as a `LATERAL` over the already-paginated page: 150ms → 8.1ms.

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

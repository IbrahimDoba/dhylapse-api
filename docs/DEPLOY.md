# Deploying Dhylapse

Nothing here is exotic: one container, one Postgres 18 database. The only step
that needs care is the database role the app connects as.

## What you need

| | |
|---|---|
| Host | Render, Railway, or Fly — anything that runs a Dockerfile |
| Database | **Postgres 18+** (the schema uses native `uuidv7()`) |
| Email | A [Resend](https://resend.com) account and a verified sending domain |

## The one thing that is easy to get wrong

The app must connect as **`dhylapse_app`**, never as the database owner.

Postgres exempts superusers and table owners from row-level security. Point
`DATABASE_URL` at the owner connection and every tenant-isolation policy is
silently disabled — the app works perfectly and one pharmacy can read
another's stock. There is no error, no warning, nothing in a log.

The server runs a preflight check at boot and **refuses to start** if it is
connected as a privileged role, so a misconfigured deploy fails loudly instead.

Because of that, deployment is a two-pass process the first time:

1. Deploy with `DATABASE_MIGRATION_URL` set to the owner connection and
   `DATABASE_URL` set to the same thing. The migration runs, creating the
   `dhylapse_app` role — then the server refuses to boot. **This is expected.**
2. Set `DATABASE_URL` to the `dhylapse_app` connection string and redeploy.

```
postgres://dhylapse_app:<password>@<host>:5432/<database>
```

Change the role's password first — `0005_app_role.sql` creates it with a
development default:

```sql
ALTER ROLE dhylapse_app PASSWORD '<something from a password manager>';
```

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | **Unprivileged** `dhylapse_app` connection |
| `DATABASE_MIGRATION_URL` | yes | Owner connection; used only by migrations |
| `BETTER_AUTH_SECRET` | yes | 32+ bytes. Rotating it signs everyone out |
| `BETTER_AUTH_URL` | yes | Public origin, e.g. `https://app.dhylapse.com` |
| `CORS_ORIGIN` | yes | Where the frontend is served from |
| `PUBLIC_APP_URL` | no | Base for links in emails; defaults to `BETTER_AUTH_URL` |
| `RESEND_API_KEY` | no | Without it, email is logged rather than sent |
| `EMAIL_FROM` | no | Must be on a domain verified with Resend |
| `GOOGLE_CLIENT_ID` / `_SECRET` | no | Omit both for email+password only |

`CORS_ORIGIN` is also better-auth's trusted-origin list. If the frontend is on
a different host than the API, it must be listed here or **sign-in returns 403
from a browser while working fine from curl** — curl sends no `Origin` header.

## Migrations

`node dist/db/migrate.js` runs on container start, before the server. It
applies the drizzle migrations and then the hand-written SQL (RLS policies,
ledger triggers, the app role, the SECURITY DEFINER functions).

Every step is idempotent, so it runs safely on every deploy, and a Postgres
advisory lock means a rolling deploy cannot run two migrations at once.

Partitioning (`0003_partitioning.sql`) is deliberately **not** applied
automatically — see `docs/SCHEMA.md`. Do it before `stock_movement` or
`audit_log` passes roughly 50M rows.

## Frontend

The frontend is a separate repo and builds to static files.

Deploy it anywhere static and rewrite `/api/*` to the API host, which keeps the
session cookie first-party and avoids `SameSite=None` entirely. On Vercel:

```json
{ "rewrites": [{ "source": "/api/:path*", "destination": "https://<api-host>/api/:path*" }] }
```

Then `CORS_ORIGIN` and `BETTER_AUTH_URL` are the **frontend's** origin, not the
API's.

## After the first deploy

```sh
curl https://<host>/health         # {"status":"ok"}
curl https://<host>/health/ready   # {"status":"ready","database":"up"}
```

Check the logs for `preflight ok — RLS enforced, ledger triggers present`. If
it is missing, the server did not start and the message above it says why.

## Scheduling

The expiry scan and email delivery run inside the app process — hourly and
every two minutes respectively, each guarded by an advisory lock so only one
instance does the work. No external cron, no worker dyno.

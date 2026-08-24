# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-slim AS build
WORKDIR /app

RUN corepack enable

# Dependencies first, so a source-only change does not re-resolve the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN pnpm build

# Drop dev dependencies from the tree that gets copied into the runtime image.
RUN pnpm prune --prod

# ---------- runtime ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runs as the image's built-in unprivileged user. A pharmacy's data is not
# somewhere to be casually running containers as root.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# The hand-written SQL is read at runtime by the migration step, so it has to
# be in the image — tsc only emits the compiled TypeScript.
COPY --from=build --chown=node:node /app/src/db/sql ./dist/db/sql
COPY --from=build --chown=node:node /app/src/db/migrations ./dist/db/migrations

EXPOSE 4000

# Node's own healthcheck, so the image needs neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run before the server, in the same container, guarded by an
# advisory lock so a rolling deploy cannot run two at once.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]

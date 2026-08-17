-- Run before the first drizzle migration.

-- Trigram index support for fuzzy product-name search
-- (product.name uses a gin_trgm_ops index).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Case-insensitive comparison helpers.
CREATE EXTENSION IF NOT EXISTS citext;

-- Postgres 18 ships uuidv7() natively. On 17 or earlier, either install
-- pg_uuidv7 or remove the DEFAULT from the `pk()` helper and generate UUIDv7
-- in the application instead.
DO $$
BEGIN
  PERFORM uuidv7();
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION
    'uuidv7() is unavailable. Use Postgres 18+, install pg_uuidv7, or generate IDs in the app.';
END $$;

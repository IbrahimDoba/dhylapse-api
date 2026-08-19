-- Schema invariant tests. Run after migrations + 0002_rls + 0004_derived.
--
--   psql "$DATABASE_URL" -f src/db/verify.sql
--
-- Every check RAISEs on failure, so a clean run means the guarantees the
-- application relies on are actually enforced by the database. Run as a
-- superuser; RLS is verified separately (superusers bypass it) by
-- scripts/tenant-check.ts.
--
-- The whole run is rolled back, so it leaves no fixtures behind and can be run
-- as often as you like against a live database.

\set ON_ERROR_STOP on
\timing off
BEGIN;

-- ---------------------------------------------------------------- fixtures
INSERT INTO organization (id, name, slug) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'Greenline Pharmacy', 'greenline'),
  ('00000000-0000-7000-8000-0000000000b1', 'Rival Pharmacy',     'rival');

INSERT INTO location (id, organization_id, name, code) VALUES
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000000a1', 'Lekki',  'LEK'),
  ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000b1', 'Ikoyi',  'IKY');

INSERT INTO drug_catalog (id, generic_name, strength, dosage_form, shelf_life_after_opening_days)
VALUES ('00000000-0000-7000-8000-0000000000c1', 'Insulin Glargine', '100IU/mL', 'injection', 28);

INSERT INTO product (id, organization_id, catalog_id, name, sku) VALUES
  ('00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a1',
   '00000000-0000-7000-8000-0000000000c1', 'Insulin Glargine', 'INS-GLA-V'),
  ('00000000-0000-7000-8000-0000000000b3', '00000000-0000-7000-8000-0000000000b1',
   NULL, 'Rival Product', 'RIV-001');

INSERT INTO batch (id, organization_id, location_id, product_id, batch_number, expiry_date) VALUES
  ('00000000-0000-7000-8000-0000000000a4', '00000000-0000-7000-8000-0000000000a1',
   '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000000a3', 'INS-24-A', '2026-11-30'),
  ('00000000-0000-7000-8000-0000000000b4', '00000000-0000-7000-8000-0000000000b1',
   '00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000b3', 'RIV-24-A', '2026-12-31');

-- ------------------------------------------------- 1. ledger maintains balance
INSERT INTO stock_movement (organization_id, location_id, batch_id, product_id, quantity_delta, balance_after, reason)
VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
        '00000000-0000-7000-8000-0000000000a4','00000000-0000-7000-8000-0000000000a3', 100, 0, 'receipt');

DO $$
DECLARE q bigint; b bigint;
BEGIN
  SELECT quantity_on_hand INTO q FROM batch WHERE id='00000000-0000-7000-8000-0000000000a4';
  SELECT balance_after   INTO b FROM stock_movement WHERE batch_id='00000000-0000-7000-8000-0000000000a4';
  IF q <> 100 THEN RAISE EXCEPTION 'FAIL 1a: cached balance is %, expected 100', q; END IF;
  IF b <> 100 THEN RAISE EXCEPTION 'FAIL 1b: balance_after is %, expected 100', b; END IF;
  RAISE NOTICE 'PASS 1  ledger maintains batch.quantity_on_hand and stamps balance_after';
END $$;

-- ------------------------------------------------------ 2. deduction and FEFO
INSERT INTO stock_movement (organization_id, location_id, batch_id, product_id, quantity_delta, balance_after, reason)
VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
        '00000000-0000-7000-8000-0000000000a4','00000000-0000-7000-8000-0000000000a3', -30, 0, 'dispense');

DO $$
DECLARE q bigint;
BEGIN
  SELECT quantity_on_hand INTO q FROM batch WHERE id='00000000-0000-7000-8000-0000000000a4';
  IF q <> 70 THEN RAISE EXCEPTION 'FAIL 2: balance is %, expected 70', q; END IF;
  RAISE NOTICE 'PASS 2  deductions apply correctly';
END $$;

-- --------------------------------------------- 3. cannot drive stock negative
DO $$
BEGIN
  INSERT INTO stock_movement (organization_id, location_id, batch_id, product_id, quantity_delta, balance_after, reason)
  VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
          '00000000-0000-7000-8000-0000000000a4','00000000-0000-7000-8000-0000000000a3', -500, 0, 'dispense');
  RAISE EXCEPTION 'FAIL 3: oversell was allowed';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'FAIL 3%' THEN RAISE; END IF;
  -- Must be the trigger's readable message, not the bare CHECK constraint.
  IF SQLERRM NOT LIKE 'insufficient stock%' THEN
    RAISE EXCEPTION 'FAIL 3: rejected, but with an unhelpful error: %', SQLERRM;
  END IF;
  RAISE NOTICE 'PASS 3  oversell rejected with a readable message';
END $$;

-- ------------------------------------------------------ 4. ledger is immutable
DO $$
BEGIN
  UPDATE stock_movement SET quantity_delta = 999
   WHERE batch_id='00000000-0000-7000-8000-0000000000a4';
  RAISE EXCEPTION 'FAIL 4a: ledger UPDATE was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL 4a%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 4a ledger UPDATE rejected';
END $$;

DO $$
BEGIN
  DELETE FROM stock_movement WHERE batch_id='00000000-0000-7000-8000-0000000000a4';
  RAISE EXCEPTION 'FAIL 4b: ledger DELETE was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL 4b%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 4b ledger DELETE rejected';
END $$;

-- ------------------------------------------------- 5. depletion flips status
INSERT INTO stock_movement (organization_id, location_id, batch_id, product_id, quantity_delta, balance_after, reason)
VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
        '00000000-0000-7000-8000-0000000000a4','00000000-0000-7000-8000-0000000000a3', -70, 0, 'dispense');

DO $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM batch WHERE id='00000000-0000-7000-8000-0000000000a4';
  IF s <> 'depleted' THEN RAISE EXCEPTION 'FAIL 5: status is %, expected depleted', s; END IF;
  RAISE NOTICE 'PASS 5  zero balance marks batch depleted (drops out of expiry scan)';
END $$;

-- restore stock for later checks
INSERT INTO stock_movement (organization_id, location_id, batch_id, product_id, quantity_delta, balance_after, reason)
VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
        '00000000-0000-7000-8000-0000000000a4','00000000-0000-7000-8000-0000000000a3', 50, 0, 'receipt');

-- ------------------------------- 6. opening a vial shortens effective expiry
UPDATE batch SET opened_at = '2026-08-01T09:00:00Z'
 WHERE id='00000000-0000-7000-8000-0000000000a4';

DO $$
DECLARE eff date; printed date;
BEGIN
  SELECT effective_expiry_date, expiry_date INTO eff, printed
    FROM batch WHERE id='00000000-0000-7000-8000-0000000000a4';
  IF eff <> DATE '2026-08-29' THEN
    RAISE EXCEPTION 'FAIL 6: effective expiry is %, expected 2026-08-29 (28d after opening)', eff;
  END IF;
  RAISE NOTICE 'PASS 6  broached vial expires % not % (28-day post-opening life)', eff, printed;
END $$;

-- ------------------------------------------- 7. alert fires once per batch
INSERT INTO alert_rule (id, organization_id, name, kind, threshold_days)
VALUES ('00000000-0000-7000-8000-0000000000a5','00000000-0000-7000-8000-0000000000a1','90 day','expiry',90);

INSERT INTO alert_event (organization_id, location_id, alert_rule_id, batch_id, product_id, kind, threshold_days)
VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
        '00000000-0000-7000-8000-0000000000a5','00000000-0000-7000-8000-0000000000a4',
        '00000000-0000-7000-8000-0000000000a3','expiry',90);

DO $$
BEGIN
  INSERT INTO alert_event (organization_id, location_id, alert_rule_id, batch_id, product_id, kind, threshold_days)
  VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
          '00000000-0000-7000-8000-0000000000a5','00000000-0000-7000-8000-0000000000a4',
          '00000000-0000-7000-8000-0000000000a3','expiry',90);
  RAISE EXCEPTION 'FAIL 7: duplicate alert was allowed';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS 7  duplicate alert blocked (job replay is safe)';
END $$;

-- ------------------------------------------- 8. duplicate lot is not a new batch
DO $$
BEGIN
  INSERT INTO batch (organization_id, location_id, product_id, batch_number, expiry_date)
  VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
          '00000000-0000-7000-8000-0000000000a3','INS-24-A','2026-11-30');
  RAISE EXCEPTION 'FAIL 8: duplicate lot was allowed';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS 8  re-importing the same lot is rejected, not duplicated';
END $$;

-- --------------------------------------------------- 9. expiry sanity check
DO $$
BEGIN
  INSERT INTO batch (organization_id, location_id, product_id, batch_number, expiry_date, manufactured_date)
  VALUES ('00000000-0000-7000-8000-0000000000a1','00000000-0000-7000-8000-0000000000a2',
          '00000000-0000-7000-8000-0000000000a3','BAD-1','2024-01-01','2025-01-01');
  RAISE EXCEPTION 'FAIL 9: expiry before manufacture was allowed';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS 9  expiry-before-manufacture rejected';
END $$;

ROLLBACK;

-- RLS itself is verified separately: superusers bypass row-level security, so
-- it must be exercised as dhylapse_app. See README.

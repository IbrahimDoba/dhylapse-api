-- Derived state kept correct by the database rather than by discipline.

-- 1. batch.quantity_on_hand is a cached balance. stock_movement is the truth.
--    Maintaining it in a trigger means no code path can update stock without
--    writing a ledger row — the invariant is structural, not conventional.

CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_balance bigint;
BEGIN
  UPDATE batch
     SET quantity_on_hand = quantity_on_hand + NEW.quantity_delta,
         updated_at       = now()
   WHERE id = NEW.batch_id
  RETURNING quantity_on_hand INTO new_balance;

  IF new_balance IS NULL THEN
    RAISE EXCEPTION 'stock_movement references unknown batch %', NEW.batch_id;
  END IF;

  IF new_balance < 0 THEN
    RAISE EXCEPTION 'stock_movement would drive batch % negative (%).',
      NEW.batch_id, new_balance;
  END IF;

  NEW.balance_after := new_balance;

  -- Auto-close depleted lots so the expiry scan stops considering them.
  IF new_balance = 0 THEN
    UPDATE batch SET status = 'depleted'
     WHERE id = NEW.batch_id AND status = 'active';
  ELSIF new_balance > 0 THEN
    UPDATE batch SET status = 'active'
     WHERE id = NEW.batch_id AND status = 'depleted';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER stock_movement_apply
  BEFORE INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- The ledger is immutable. Corrections are new compensating rows, never edits.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movement is append-only; insert a compensating movement instead';
END $$;

CREATE TRIGGER stock_movement_immutable
  BEFORE UPDATE OR DELETE ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();


-- 2. Effective expiry = the earlier of the printed date and the
--    post-opening shelf life. A broached multi-dose vial expires on the
--    earlier date, and alerting must follow whichever comes first.

CREATE OR REPLACE FUNCTION compute_effective_expiry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  after_open date;
  shelf_days int;
BEGIN
  IF NEW.opened_at IS NULL THEN
    NEW.effective_expiry_date := NEW.expiry_date;
    RETURN NEW;
  END IF;

  SELECT c.shelf_life_after_opening_days
    INTO shelf_days
    FROM product p
    LEFT JOIN drug_catalog c ON c.id = p.catalog_id
   WHERE p.id = NEW.product_id;

  IF shelf_days IS NULL THEN
    NEW.effective_expiry_date := NEW.expiry_date;
  ELSE
    after_open := (NEW.opened_at + (shelf_days || ' days')::interval)::date;
    NEW.effective_expiry_date := LEAST(NEW.expiry_date, after_open);
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER batch_effective_expiry
  BEFORE INSERT OR UPDATE OF expiry_date, opened_at, product_id ON batch
  FOR EACH ROW EXECUTE FUNCTION compute_effective_expiry();


-- 3. Guard rails the application must not be trusted to remember.
ALTER TABLE batch
  ADD CONSTRAINT batch_quantity_non_negative CHECK (quantity_on_hand >= 0),
  ADD CONSTRAINT batch_reserved_within_hand  CHECK (quantity_reserved BETWEEN 0 AND quantity_on_hand),
  ADD CONSTRAINT batch_expiry_after_manufacture
    CHECK (manufactured_date IS NULL OR expiry_date > manufactured_date);

ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_delta_non_zero CHECK (quantity_delta <> 0);

ALTER TABLE alert_rule
  ADD CONSTRAINT alert_rule_expiry_needs_threshold
    CHECK (kind <> 'expiry' OR threshold_days IS NOT NULL);

ALTER TABLE stock_transfer
  ADD CONSTRAINT stock_transfer_distinct_locations
    CHECK (from_location_id <> to_location_id);

-- Partitioning for the three append-only tables that grow without bound.
--
-- Not needed on day one. Do it before the first table crosses ~50M rows —
-- converting a large table to partitioned later requires a full rewrite and
-- an outage, so the DDL lives here from the start and the cutover is planned.
--
-- stock_movement    every quantity change, forever
-- audit_log         every mutation, forever
-- webhook_delivery  every outbound call, high churn
--
-- Monthly RANGE partitions. Retention then becomes DETACH + DROP of one
-- partition (instant) instead of a DELETE over millions of rows (hours, plus
-- bloat and an autovacuum storm).

-- Partitioned tables require the partition key in every unique constraint,
-- so the primary key becomes (id, occurred_at) rather than (id) alone.

-- Example for stock_movement:
--
-- CREATE TABLE stock_movement_partitioned (LIKE stock_movement INCLUDING ALL)
--   PARTITION BY RANGE (occurred_at);
-- ALTER TABLE stock_movement_partitioned
--   DROP CONSTRAINT stock_movement_pkey,
--   ADD PRIMARY KEY (id, occurred_at);
--
-- CREATE TABLE stock_movement_2026_08 PARTITION OF stock_movement_partitioned
--   FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--
-- INSERT INTO stock_movement_partitioned SELECT * FROM stock_movement;
-- BEGIN;
--   ALTER TABLE stock_movement RENAME TO stock_movement_legacy;
--   ALTER TABLE stock_movement_partitioned RENAME TO stock_movement;
-- COMMIT;

-- Roll partitions forward monthly. Run from the same scheduler as the expiry
-- scan, keeping three months ahead so a missed run never blocks an insert.
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(
  parent text,
  months_ahead int DEFAULT 3
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  i int;
  start_date date;
  end_date date;
  part_name text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    start_date := date_trunc('month', CURRENT_DATE)::date + (i || ' month')::interval;
    end_date   := start_date + interval '1 month';
    part_name  := format('%s_%s', parent, to_char(start_date, 'YYYY_MM'));

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent, start_date, end_date
      );
    END IF;
  END LOOP;
END $$;

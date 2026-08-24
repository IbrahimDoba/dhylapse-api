import { createHash } from 'node:crypto';
import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { withTenant, type TenantTx } from '../db/tenant.ts';
import { AppError } from '../lib/errors.ts';
import {
  detectColumns, isBlankRow, validateRow, type ImportField,
} from '../lib/import-parse.ts';
import { scopeWith } from '../lib/scope.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20_000;

/** Reads a CSV or XLSX buffer into a header row plus data rows. */
async function readSheet(
  filename: string,
  buffer: Buffer,
): Promise<{ format: 'csv' | 'xlsx'; headers: string[]; rows: unknown[][] }> {
  const isExcel = /\.xlsx?$/i.test(filename);

  if (!isExcel) {
    const records = parseCsv(buffer, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];
    const [headers = [], ...rows] = records;
    return { format: 'csv', headers, rows };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError(422, 'empty_file', 'That spreadsheet has no sheets.');

  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    // ExcelJS pads index 0; a cell can be a rich-text or formula object.
    rows.push(
      values.slice(1).map((v) => {
        if (v && typeof v === 'object' && 'text' in v) return (v as { text: string }).text;
        if (v && typeof v === 'object' && 'result' in v) return (v as { result: unknown }).result;
        return v;
      }),
    );
  });

  const headers = (rows.shift() ?? []).map((h) => String(h ?? ''));
  return { format: 'xlsx', headers, rows };
}

const RowSchema = Type.Object({
  lineNumber: Type.Integer(),
  status: Type.String(),
  raw: Type.Unknown(),
  normalized: Type.Unknown(),
  errors: Type.Array(Type.Object({ field: Type.String(), code: Type.String(), message: Type.String() })),
});

const JobSchema = Type.Object({
  /** Set when this exact file has been committed before. */
  duplicateOf: Type.Optional(
    Type.Union([Type.Object({ id: Type.String(), committedAt: Type.String() }), Type.Null()]),
  ),
  id: Type.String(),
  filename: Type.String(),
  format: Type.String(),
  status: Type.String(),
  rowCount: Type.Integer(),
  validCount: Type.Integer(),
  errorCount: Type.Integer(),
  committedCount: Type.Integer(),
  columnMapping: Type.Unknown(),
  createdAt: Type.String(),
});

export const importRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Upload and stage.
   *
   * Nothing touches inventory here. Rows land in import_row with per-field
   * errors so the pharmacist reviews their own data before committing —
   * "your import silently created 400 wrong batches" is unrecoverable.
   */
  app.post(
    '/api/imports',
    { preHandler: app.requireOrg },
    async (req, reply) => {
      const scope = scopeWith(req, 'inventory.write');
      const file = await req.file({ limits: { fileSize: MAX_BYTES } });
      if (!file) throw new AppError(422, 'no_file', 'Attach a .csv or .xlsx file.');

      const buffer = await file.toBuffer();
      if (buffer.length === 0) throw new AppError(422, 'empty_file', 'That file is empty.');

      const { format, headers, rows } = await readSheet(file.filename, buffer);
      if (rows.length === 0) throw new AppError(422, 'empty_file', 'No rows found below the header.');
      if (rows.length > MAX_ROWS) {
        throw new AppError(422, 'too_large', `That file has ${rows.length} rows; the limit is ${MAX_ROWS}.`);
      }

      const mapping = detectColumns(headers);
      const missing = (['name', 'quantity', 'expiryDate'] as ImportField[]).filter((f) => mapping[f] == null);
      if (missing.length > 0) {
        throw new AppError(
          422,
          'missing_columns',
          `Could not find ${missing.join(', ')}. Found: ${headers.filter(Boolean).join(', ') || 'no headers'}.`,
        );
      }

      const contentHash = createHash('sha256').update(buffer).digest('hex');

      return withTenant(scope, async (tx) => {
        /*
         * Warn if this exact file has already been committed.
         *
         * Rows carrying a lot number are caught by the batch natural key, but
         * rows without one cannot be — and two undated deliveries of the same
         * drug genuinely are two batches, so the database is right to allow
         * it. The only thing that distinguishes "another delivery" from "I
         * clicked upload twice" is the file itself.
         */
        const [previous] = await tx.execute<{ id: string; completed_at: string }>(raw`
          SELECT id, completed_at::text FROM import_job
           WHERE content_hash = ${contentHash} AND status = 'completed'
           ORDER BY completed_at DESC LIMIT 1`);

        const [job] = await tx.execute<{ id: string }>(raw`
          INSERT INTO import_job (
            organization_id, location_id, filename, format, byte_size,
            content_hash, column_mapping, status, created_by
          )
          SELECT ${scope.organizationId}, l.id, ${file.filename}, ${format}, ${buffer.length},
                 ${contentHash}, ${JSON.stringify(mapping)}::jsonb, 'review', ${scope.userId}
            FROM location l
           WHERE l.deleted_at IS NULL AND l.is_active
           ORDER BY l.created_at LIMIT 1
          RETURNING id`);
        if (!job) throw new AppError(422, 'no_location', 'This workspace has no location.');

        let valid = 0;
        let invalid = 0;
        const values: string[] = [];

        rows.forEach((cells, i) => {
          if (isBlankRow(cells)) return; // trailing padding, not an error
          const { normalized, errors } = validateRow(cells, mapping);
          if (errors.length === 0) valid++;
          else invalid++;
          values.push(
            JSON.stringify({
              lineNumber: i + 2, // +1 for the header, +1 for 1-based rows
              raw: cells.map((c) => (c == null ? null : String(c))),
              normalized,
              status: errors.length === 0 ? 'valid' : 'invalid',
              errors,
            }),
          );
        });

        // One insert for the whole file — a statement per row is thousands of
        // round trips for a file a pharmacist expects to take a moment.
        await tx.execute(raw`
          INSERT INTO import_row (organization_id, import_job_id, line_number, raw, normalized, status, errors)
          SELECT ${scope.organizationId}, ${job.id},
                 (r->>'lineNumber')::int, r->'raw', r->'normalized', r->>'status', r->'errors'
            FROM jsonb_array_elements(${JSON.stringify(values.map((v) => JSON.parse(v)))}::jsonb) AS r`);

        await tx.execute(raw`
          UPDATE import_job
             SET row_count = ${valid + invalid}, valid_count = ${valid}, error_count = ${invalid}
           WHERE id = ${job.id}`);

        const [saved] = await tx.execute<Record<string, unknown>>(raw`
          SELECT id, filename, format, status,
                 row_count::int AS "rowCount", valid_count::int AS "validCount",
                 error_count::int AS "errorCount", committed_count::int AS "committedCount",
                 column_mapping AS "columnMapping", created_at::text AS "createdAt"
            FROM import_job WHERE id = ${job.id}`);

        return reply.code(201).send({
          ...saved,
          duplicateOf: previous
            ? { id: previous.id, committedAt: previous.completed_at }
            : null,
        } as never);
      });
    },
  );

  /** Review: the staged rows and what is wrong with them. */
  app.get(
    '/api/imports/:id',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({
          only: Type.Optional(Type.Union([Type.Literal('valid'), Type.Literal('invalid')])),
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
        }),
        response: { 200: Type.Object({ job: JobSchema, rows: Type.Array(RowSchema) }) },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      return withTenant(scope, async (tx) => {
        const [job] = await tx.execute<Record<string, unknown>>(raw`
          SELECT id, filename, format, status,
                 row_count::int AS "rowCount", valid_count::int AS "validCount",
                 error_count::int AS "errorCount", committed_count::int AS "committedCount",
                 column_mapping AS "columnMapping", created_at::text AS "createdAt"
            FROM import_job WHERE id = ${req.params.id}`);
        if (!job) throw new AppError(404, 'not_found', 'Import not found.');

        const rows = await tx.execute<Record<string, unknown>>(raw`
          SELECT line_number::int AS "lineNumber", status, raw, normalized, errors
            FROM import_row
           WHERE import_job_id = ${req.params.id}
             AND (${req.query.only ?? null}::text IS NULL OR status = ${req.query.only ?? null}::text)
           ORDER BY (status = 'invalid') DESC, line_number
           LIMIT ${req.query.limit}`);

        return { job, rows: [...rows] } as never;
      });
    },
  );

  /**
   * Commit the valid rows.
   *
   * One transaction: a half-applied import leaves a pharmacist unable to tell
   * what landed and what did not. Invalid rows are simply skipped — they were
   * shown at review time and the user chose to proceed.
   */
  app.post(
    '/api/imports/:id/commit',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({
            committed: Type.Integer(),
            skipped: Type.Integer(),
            productsCreated: Type.Integer(),
            duplicates: Type.Integer(),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.write');

      return withTenant(scope, async (tx) => {
        const [job] = await tx.execute<{ id: string; status: string; location_id: string }>(raw`
          SELECT id, status, location_id FROM import_job WHERE id = ${req.params.id} FOR UPDATE`);
        if (!job) throw new AppError(404, 'not_found', 'Import not found.');
        if (job.status === 'completed') {
          throw new AppError(409, 'conflict', 'This import has already been committed.');
        }
        if (job.status !== 'review') {
          throw new AppError(422, 'invalid_state', `Import is ${job.status}, not ready to commit.`);
        }

        const rows = await tx.execute<{ line_number: number; normalized: Record<string, unknown> }>(raw`
          SELECT line_number, normalized FROM import_row
           WHERE import_job_id = ${job.id} AND status = 'valid'
           ORDER BY line_number`);

        let committed = 0;
        let productsCreated = 0;
        let duplicates = 0;

        for (const row of rows) {
          const n = row.normalized as {
            name: string; sku: string | null; quantity: number;
            expiryDate: string; expiryPrecision: string;
            batchNumber: string | null; unitCostMinor: number | null;
          };

          // Match on SKU when the file supplies one, otherwise on name. A file
          // listing the same drug twice must add two lots to one product, not
          // create the product twice.
          const [existing] = await tx.execute<{ id: string }>(raw`
            SELECT id FROM product
             WHERE deleted_at IS NULL
               AND (${n.sku}::text IS NOT NULL AND sku = ${n.sku}::text
                    OR ${n.sku}::text IS NULL AND lower(name) = lower(${n.name}))
             LIMIT 1`);

          let productId = existing?.id;
          if (!productId) {
            const [created] = await tx.execute<{ id: string }>(raw`
              INSERT INTO product (organization_id, name, sku, created_by)
              VALUES (${scope.organizationId}, ${n.name}, ${n.sku}, ${scope.userId})
              RETURNING id`);
            productId = created!.id;
            productsCreated++;
          }

          const [batch] = await tx.execute<{ id: string }>(raw`
            INSERT INTO batch (
              organization_id, location_id, product_id, batch_number,
              expiry_date, expiry_precision, quantity_received,
              unit_cost_minor, source_kind, source_id, created_by
            ) VALUES (
              ${scope.organizationId}, ${job.location_id}, ${productId}, ${n.batchNumber},
              ${n.expiryDate}::date, ${n.expiryPrecision}, ${n.quantity},
              ${n.unitCostMinor}, 'import', ${job.id}, ${scope.userId}
            )
            ON CONFLICT DO NOTHING
            RETURNING id`);

          if (!batch) {
            // Same lot, same product, same location, same date — already held.
            duplicates++;
            await tx.execute(raw`
              UPDATE import_row SET status = 'skipped',
                     errors = '[{"field":"batchNumber","code":"duplicate","message":"This lot is already recorded."}]'::jsonb
               WHERE import_job_id = ${job.id} AND line_number = ${row.line_number}`);
            continue;
          }

          // Quantity goes through the ledger, exactly as a manual receipt does.
          await tx.execute(raw`
            INSERT INTO stock_movement (
              organization_id, location_id, batch_id, product_id,
              quantity_delta, balance_after, reason, unit_cost_minor, actor_id, notes
            ) VALUES (
              ${scope.organizationId}, ${job.location_id}, ${batch.id}, ${productId},
              ${n.quantity}, 0, 'receipt', ${n.unitCostMinor}, ${scope.userId}, 'Imported'
            )`);

          await tx.execute(raw`
            UPDATE import_row SET status = 'committed', created_batch_id = ${batch.id}
             WHERE import_job_id = ${job.id} AND line_number = ${row.line_number}`);
          committed++;
        }

        const [counts] = await tx.execute<{ skipped: number }>(raw`
          SELECT count(*)::int AS skipped FROM import_row
           WHERE import_job_id = ${job.id} AND status IN ('invalid', 'skipped')`);

        await tx.execute(raw`
          UPDATE import_job
             SET status = 'completed', committed_count = ${committed}, completed_at = now()
           WHERE id = ${job.id}`);

        return { committed, skipped: counts?.skipped ?? 0, productsCreated, duplicates };
      });
    },
  );

  /** Recent imports. */
  app.get(
    '/api/imports',
    {
      preHandler: app.requireOrg,
      schema: { response: { 200: Type.Object({ imports: Type.Array(JobSchema) }) } },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const imports = await withTenant(scope, (tx) =>
        tx.execute<Record<string, unknown>>(raw`
          SELECT id, filename, format, status,
                 row_count::int AS "rowCount", valid_count::int AS "validCount",
                 error_count::int AS "errorCount", committed_count::int AS "committedCount",
                 column_mapping AS "columnMapping", created_at::text AS "createdAt"
            FROM import_job ORDER BY created_at DESC LIMIT 20`),
      );
      return { imports: [...imports] } as never;
    },
  );
};

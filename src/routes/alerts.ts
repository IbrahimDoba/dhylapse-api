import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { runExpiryScan } from '../jobs/expiry-scan.ts';
import { AppError } from '../lib/errors.ts';
import { scopeWith } from '../lib/scope.ts';

const AlertSchema = Type.Object({
  id: Type.String(),
  batchId: Type.Union([Type.String(), Type.Null()]),
  productName: Type.String(),
  batchNumber: Type.Union([Type.String(), Type.Null()]),
  locationName: Type.String(),
  thresholdDays: Type.Union([Type.Integer(), Type.Null()]),
  severity: Type.Integer(),
  daysRemaining: Type.Union([Type.Integer(), Type.Null()]),
  quantityAtAlert: Type.Union([Type.Integer(), Type.Null()]),
  valueAtRiskMinor: Type.Union([Type.Integer(), Type.Null()]),
  status: Type.String(),
  firedAt: Type.String(),
  acknowledgedBy: Type.Union([Type.String(), Type.Null()]),
  /** Recomputed now, so a stale alert shows today's number, not the snapshot. */
  currentDaysRemaining: Type.Union([Type.Integer(), Type.Null()]),
});

export const alertRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** The alert inbox. */
  app.get(
    '/api/alerts',
    {
      preHandler: app.requireOrg,
      schema: {
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union([Type.Literal('open'), Type.Literal('acknowledged'), Type.Literal('all')]),
          ),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
        }),
        response: {
          200: Type.Object({
            alerts: Type.Array(AlertSchema),
            counts: Type.Object({ open: Type.Integer(), acknowledged: Type.Integer() }),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const status = req.query.status ?? 'open';

      return withTenant(scope, async (tx) => {
        const alerts = await tx.execute<Record<string, unknown>>(raw`
          SELECT ae.id, ae.batch_id AS "batchId",
                 p.name AS "productName", b.batch_number AS "batchNumber",
                 l.name AS "locationName",
                 ae.threshold_days AS "thresholdDays", ae.severity,
                 ae.days_remaining  AS "daysRemaining",
                 ae.quantity_at_alert::int   AS "quantityAtAlert",
                 ae.value_at_risk_minor::int AS "valueAtRiskMinor",
                 ae.status, ae.fired_at::text AS "firedAt",
                 u.name AS "acknowledgedBy",
                 (b.effective_expiry_date - CURRENT_DATE)::int AS "currentDaysRemaining"
            FROM alert_event ae
            JOIN product  p ON p.id = ae.product_id
            JOIN location l ON l.id = ae.location_id
            LEFT JOIN batch b ON b.id = ae.batch_id
            LEFT JOIN app_user u ON u.id = ae.acknowledged_by
           WHERE (${status}::text = 'all' OR ae.status = ${status}::text)
           ORDER BY ae.severity, ae.fired_at DESC
           LIMIT ${req.query.limit}
        `);

        const [counts] = await tx.execute<{ open: number; acknowledged: number }>(raw`
          SELECT count(*) FILTER (WHERE status = 'open')::int         AS open,
                 count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged
            FROM alert_event`);

        return {
          alerts: [...alerts],
          counts: { open: counts?.open ?? 0, acknowledged: counts?.acknowledged ?? 0 },
        } as never;
      });
    },
  );

  /** Acknowledge — "I have seen this", distinct from having acted on it. */
  app.post(
    '/api/alerts/:id/acknowledge',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({ id: Type.String(), status: Type.String() }) },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'alerts.acknowledge');
      return withTenant(scope, async (tx) => {
        const rows = await tx.execute<{ id: string; status: string }>(raw`
          UPDATE alert_event
             SET status = 'acknowledged',
                 acknowledged_at = now(),
                 acknowledged_by = ${scope.userId}
           WHERE id = ${req.params.id} AND status = 'open'
          RETURNING id, status`);
        if (!rows[0]) throw new AppError(404, 'not_found', 'Alert not found, or already actioned.');
        return rows[0];
      });
    },
  );

  /** In-app notification feed for the signed-in user. */
  app.get(
    '/api/notifications',
    {
      preHandler: app.requireOrg,
      schema: {
        response: {
          200: Type.Object({
            notifications: Type.Array(
              Type.Object({
                id: Type.String(),
                subject: Type.String(),
                template: Type.String(),
                payload: Type.Unknown(),
                readAt: Type.Union([Type.String(), Type.Null()]),
                createdAt: Type.String(),
              }),
            ),
            unread: Type.Integer(),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      return withTenant(scope, async (tx) => {
        const notifications = await tx.execute<Record<string, unknown>>(raw`
          SELECT id, subject, template, payload,
                 read_at::text AS "readAt", created_at::text AS "createdAt"
            FROM notification
           WHERE recipient_user_id = ${scope.userId}
           ORDER BY created_at DESC LIMIT 50`);
        const [c] = await tx.execute<{ n: number }>(raw`
          SELECT count(*)::int AS n FROM notification
           WHERE recipient_user_id = ${scope.userId} AND read_at IS NULL`);
        return { notifications: [...notifications], unread: c?.n ?? 0 } as never;
      });
    },
  );

  /**
   * Run the scan on demand.
   *
   * Owner-only, and it exists because "wait until tonight" is a miserable way
   * to verify that alerting works — for us now, and for support later.
   */
  app.post(
    '/api/alerts/scan',
    {
      preHandler: app.requireOrg,
      schema: {
        response: {
          200: Type.Object({
            organizationsScanned: Type.Integer(),
            organizationsFailed: Type.Integer(),
            alertsCreated: Type.Integer(),
            notificationsQueued: Type.Integer(),
            errors: Type.Array(Type.String()),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'org.manage');
      req.log.info({ actor: scope.userId }, 'manual expiry scan requested');
      const result = await runExpiryScan();
      if (result.organizationsFailed > 0) {
        req.log.error({ errors: result.errors }, 'expiry scan had failures');
      }
      return {
        organizationsScanned: result.organizationsScanned,
        organizationsFailed: result.organizationsFailed,
        alertsCreated: result.alertsCreated,
        notificationsQueued: result.notificationsQueued,
        errors: result.errors.slice(0, 5).map((e) => e.message.slice(0, 200)),
      };
    },
  );
};

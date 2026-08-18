/**
 * Translates Postgres errors into HTTP responses.
 *
 * The database enforces real invariants — tenant isolation, stock balance,
 * lot uniqueness — so a lot of user-facing errors originate there. Without
 * this layer a pharmacist trying to record a duplicate lot sees
 * "duplicate key value violates unique constraint batch_natural_key",
 * which tells them nothing about what to do next.
 */

export class AppError extends Error {
  /**
   * Fields are declared and assigned explicitly rather than using TypeScript
   * parameter properties. Node's native type stripping erases types without
   * generating code, and `constructor(readonly x: T)` needs codegen — it fails
   * at load with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
   */
  readonly statusCode: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(statusCode: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

/** SQLSTATE codes we expect to surface to users. */
const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

/**
 * Constraint name -> what the user should actually be told. Anything not
 * listed falls back to a generic message rather than leaking schema internals.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  batch_natural_key:
    'This lot number and expiry date are already recorded for this product at this location.',
  alert_event_dedupe_key: 'This alert has already been raised for this batch.',
  organization_slug_key: 'That workspace URL is already taken.',
  app_user_email_key: 'An account with that email already exists.',
  product_org_sku_key: 'That SKU is already in use.',
  location_org_code_key: 'That location code is already in use.',
  supplier_org_code_key: 'That supplier code is already in use.',
  membership_org_user_key: 'That person is already a member of this workspace.',
  notification_delivery_key: 'This notification has already been queued for that channel.',
  idempotency_key_unique: 'This request has already been submitted.',
  batch_quantity_non_negative: 'That would take stock below zero.',
  batch_reserved_within_hand: 'Reserved quantity cannot exceed the quantity on hand.',
  batch_expiry_after_manufacture: 'Expiry date must be after the manufacture date.',
  stock_transfer_distinct_locations: 'A transfer must be between two different locations.',
  alert_rule_expiry_needs_threshold: 'An expiry rule needs a threshold in days.',
};

interface PgError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  detail?: string;
  message?: string;
  hint?: string;
}

function isPgError(e: unknown): e is PgError {
  return typeof e === 'object' && e !== null && 'code' in e;
}

export function toHttpError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (!isPgError(err) || !err.code) return null;

  const constraint = err.constraint_name ?? err.constraint ?? '';
  const friendly = CONSTRAINT_MESSAGES[constraint];

  switch (err.code) {
    case SQLSTATE.UNIQUE_VIOLATION:
      return new AppError(409, 'conflict', friendly ?? 'That record already exists.', constraint);

    case SQLSTATE.CHECK_VIOLATION:
      // The ledger trigger raises check_violation with a written-out message;
      // prefer it over the constraint lookup when there is no named constraint.
      return new AppError(
        422,
        'invalid_state',
        friendly ?? err.message ?? 'That change is not allowed.',
        constraint,
      );

    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return new AppError(422, 'invalid_reference', 'A referenced record does not exist.', constraint);

    case SQLSTATE.NOT_NULL_VIOLATION:
      return new AppError(422, 'missing_field', 'A required field is missing.', constraint);

    case SQLSTATE.INSUFFICIENT_PRIVILEGE:
      // Row-level security refusals land here. Treat as not-found-shaped: never
      // confirm to a caller that another tenant's record exists.
      return new AppError(404, 'not_found', 'Not found.');

    case SQLSTATE.SERIALIZATION_FAILURE:
    case SQLSTATE.DEADLOCK_DETECTED:
      return new AppError(409, 'retry', 'Conflicting concurrent update — please retry.');

    default:
      return null;
  }
}

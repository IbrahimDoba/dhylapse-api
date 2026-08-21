import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, toHttpError } from './errors.ts';

/** Shaped like a postgres.js error. */
const pgError = (code: string, constraint?: string, message = 'db said no') =>
  Object.assign(new Error(message), { code, constraint_name: constraint });

/** Shaped like DrizzleQueryError, which wraps the driver error in `cause`. */
const wrapped = (inner: Error) =>
  Object.assign(new Error('Failed query: INSERT ...'), { cause: inner });

describe('toHttpError', () => {
  it('passes AppError through untouched', () => {
    const original = new AppError(418, 'teapot', 'short and stout');
    assert.equal(toHttpError(original), original);
  });

  it('returns null for a non-database error', () => {
    assert.equal(toHttpError(new Error('kaboom')), null);
    assert.equal(toHttpError('a string'), null);
    assert.equal(toHttpError(null), null);
  });

  it('maps a unique violation to 409 with a written-out message', () => {
    const mapped = toHttpError(pgError('23505', 'batch_natural_key'));
    assert.equal(mapped?.statusCode, 409);
    assert.match(mapped!.message, /already recorded/);
  });

  it('unwraps DrizzleQueryError to find the SQLSTATE', () => {
    // Regression: drizzle wraps driver errors, so a top-level `code` check
    // missed every constraint violation and returned a bare 500.
    const mapped = toHttpError(wrapped(pgError('23505', 'batch_natural_key')));
    assert.equal(mapped?.statusCode, 409);
  });

  it('unwraps a nested cause chain', () => {
    const mapped = toHttpError(wrapped(wrapped(pgError('23505', 'app_user_email_key'))));
    assert.equal(mapped?.statusCode, 409);
    assert.match(mapped!.message, /already exists/);
  });

  it('gives up on an unreasonably deep chain rather than recursing forever', () => {
    let e: Error = pgError('23505', 'batch_natural_key');
    for (let i = 0; i < 10; i++) e = wrapped(e);
    assert.equal(toHttpError(e), null);
  });

  it('surfaces the trigger message for a check violation', () => {
    const mapped = toHttpError(
      wrapped(pgError('23514', undefined, 'insufficient stock: batch X has 200')),
    );
    assert.equal(mapped?.statusCode, 422);
    assert.match(mapped!.message, /insufficient stock/);
  });

  it('reports an RLS refusal as 404, never 403', () => {
    // A 403 would confirm the row exists in someone else's tenant.
    const mapped = toHttpError(wrapped(pgError('42501')));
    assert.equal(mapped?.statusCode, 404);
    assert.equal(mapped?.message, 'Not found.');
  });

  it('marks serialization failures as retryable', () => {
    assert.equal(toHttpError(pgError('40001'))?.statusCode, 409);
    assert.equal(toHttpError(pgError('40P01'))?.statusCode, 409);
  });

  it('falls back to a generic message for an unmapped constraint', () => {
    const mapped = toHttpError(pgError('23505', 'some_index_nobody_documented'));
    assert.equal(mapped?.statusCode, 409);
    assert.equal(mapped?.message, 'That record already exists.');
    // Never leak the raw constraint name into the user-facing message.
    assert.doesNotMatch(mapped!.message, /some_index/);
  });

  it('returns null for an unrecognised SQLSTATE so it surfaces as a 500', () => {
    assert.equal(toHttpError(pgError('99999')), null);
  });
});

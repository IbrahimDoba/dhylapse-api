import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeExpiry } from './expiry.ts';
import { AppError } from './errors.ts';

describe('normalizeExpiry', () => {
  it('keeps a full date as-is with day precision', () => {
    assert.deepEqual(normalizeExpiry('2026-11-19'), {
      expiryDate: '2026-11-19',
      precision: 'day',
    });
  });

  it('expands YYYY-MM to the LAST day of the month', () => {
    // Last day, not first: stock printed "EXP 11/2026" is usable all month.
    assert.deepEqual(normalizeExpiry('2026-11'), {
      expiryDate: '2026-11-30',
      precision: 'month',
    });
  });

  it('handles 31-day months', () => {
    assert.equal(normalizeExpiry('2026-12').expiryDate, '2026-12-31');
  });

  it('handles February in a non-leap year', () => {
    assert.equal(normalizeExpiry('2026-02').expiryDate, '2026-02-28');
  });

  it('handles February in a leap year', () => {
    assert.equal(normalizeExpiry('2028-02').expiryDate, '2028-02-29');
  });

  it('handles a century non-leap year', () => {
    // 1900 and 2100 are not leap years; 2000 is. Naive %4 logic gets this wrong.
    assert.equal(normalizeExpiry('2100-02').expiryDate, '2100-02-28');
    assert.equal(normalizeExpiry('2000-02').expiryDate, '2000-02-29');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(normalizeExpiry('  2026-11-19  ').expiryDate, '2026-11-19');
  });

  it('rejects month 13', () => {
    assert.throws(() => normalizeExpiry('2026-13'), (e: unknown) =>
      e instanceof AppError && e.statusCode === 422);
  });

  it('rejects month 00', () => {
    assert.throws(() => normalizeExpiry('2026-00'), AppError);
  });

  it('rejects a day that does not exist in that month', () => {
    // Date() would silently roll 2026-02-30 forward to March 2nd.
    assert.throws(() => normalizeExpiry('2026-02-30'), (e: unknown) =>
      e instanceof AppError && /not a real date/.test(e.message));
  });

  it('rejects 2026-04-31', () => {
    assert.throws(() => normalizeExpiry('2026-04-31'), AppError);
  });

  it('rejects free text', () => {
    for (const bad of ['', 'soon', 'Nov 2026', '11/2026', '2026', '26-11', '2026-1-1']) {
      assert.throws(() => normalizeExpiry(bad), AppError, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

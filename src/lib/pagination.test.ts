import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCursor, encodeCursor } from './pagination.ts';

describe('cursors', () => {
  it('round-trips values', () => {
    const parts = ['2026-11-30', '01a02387-707e-748f-974b-c46a882234e0'];
    assert.deepEqual(decodeCursor(encodeCursor(parts)), parts);
  });

  it('round-trips mixed types', () => {
    assert.deepEqual(decodeCursor(encodeCursor(['name', 42])), ['name', 42]);
  });

  it('is URL-safe', () => {
    // base64url, so a cursor can sit in a query string unescaped.
    const cursor = encodeCursor(['Ünïcode ??? / + =', 'x']);
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCursor(cursor)?.[0], 'Ünïcode ??? / + =');
  });

  it('returns null for garbage rather than throwing', () => {
    // A hand-edited cursor must degrade to "start from the beginning",
    // never crash the endpoint.
    for (const bad of ['', 'not-base64!!', 'eyJhIjox', Buffer.from('"str"').toString('base64url')]) {
      assert.equal(decodeCursor(bad), null, `should reject ${bad}`);
    }
  });

  it('does not leak internals in plain text', () => {
    assert.doesNotMatch(encodeCursor(['2026-11-30', 'abc']), /2026/);
  });
});

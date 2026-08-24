import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectColumns, isBlankRow, parseExpiry, parseMoneyMinor, parseQuantity, validateRow,
} from './import-parse.ts';

describe('detectColumns', () => {
  it('maps a tidy header row', () => {
    const m = detectColumns(['Drug Name', 'Quantity', 'Expiry Date', 'Batch Number']);
    assert.deepEqual(m, { name: 0, quantity: 1, expiryDate: 2, batchNumber: 3 });
  });

  it('is case and punctuation insensitive', () => {
    const m = detectColumns(['DRUG_NAME', 'qty.', 'Exp-Date', 'LOT NO']);
    assert.deepEqual(m, { name: 0, quantity: 1, expiryDate: 2, batchNumber: 3 });
  });

  it('prefers the more specific header', () => {
    // "Expiry Date" must not be claimed by a looser synonym, and "Unit Price"
    // must not be swallowed by the "price" in a different column.
    const m = detectColumns(['Item', 'Unit Price', 'Expiry Date', 'Stock']);
    assert.equal(m.name, 0);
    assert.equal(m.unitCost, 1);
    assert.equal(m.expiryDate, 2);
    assert.equal(m.quantity, 3);
  });

  it('never assigns one column to two fields', () => {
    const m = detectColumns(['Product', 'Product Code', 'Qty', 'Exp']);
    const used = Object.values(m);
    assert.equal(new Set(used).size, used.length);
  });

  it('ignores columns it does not recognise', () => {
    const m = detectColumns(['Drug', 'Shelf', 'Supplier Rep', 'Qty', 'Exp']);
    assert.equal(m.name, 0);
    assert.equal(m.quantity, 3);
    assert.equal(m.expiryDate, 4);
  });

  it('returns nothing usable for a headerless sheet', () => {
    assert.deepEqual(detectColumns(['A', 'B', 'C']), {});
  });
});

describe('parseExpiry', () => {
  const cases: [string, string, 'day' | 'month'][] = [
    ['2027-06-30', '2027-06-30', 'day'],
    ['2027-6-3',   '2027-06-03', 'day'],
    ['2027-06',    '2027-06-30', 'month'],
    ['2027-02',    '2027-02-28', 'month'],
    ['2028-02',    '2028-02-29', 'month'],
    ['30/06/2027', '2027-06-30', 'day'],
    ['30.06.2027', '2027-06-30', 'day'],
    ['06/2027',    '2027-06-30', 'month'],
    ['06/27',      '2027-06-30', 'month'],  // MM/YY, as printed on a blister pack
    ['Jun 2027',   '2027-06-30', 'month'],
    ['June 2027',  '2027-06-30', 'month'],
    ['30 Jun 2027','2027-06-30', 'day'],
    ['Jun-27',     '2027-06-30', 'month'],
  ];
  for (const [input, date, precision] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseExpiry(input), { date, precision });
    });
  }

  it('reads ambiguous slash dates day-first', () => {
    // Nigerian and UK convention: 03/04/2027 is 3 April, not 4 March.
    assert.equal(parseExpiry('03/04/2027')?.date, '2027-04-03');
  });

  it('falls back to month-first when day-first is impossible', () => {
    // 13 cannot be a month, so 06/13/2027 can only be 13 June.
    assert.equal(parseExpiry('06/13/2027')?.date, '2027-06-13');
  });

  it('accepts a real Date from Excel', () => {
    assert.equal(parseExpiry(new Date(Date.UTC(2027, 5, 30)))?.date, '2027-06-30');
  });

  it('trims whitespace', () => {
    assert.equal(parseExpiry('  2027-06-30 ')?.date, '2027-06-30');
  });

  it('rejects dates that do not exist', () => {
    for (const bad of ['2027-02-30', '2027-13-01', '2027-00', '31/06/2027', '2027-06-00']) {
      assert.equal(parseExpiry(bad), null, `should reject ${bad}`);
    }
  });

  it('rejects unparseable text rather than guessing', () => {
    for (const bad of ['', '   ', 'soon', 'N/A', '-', 'ask supplier', '2027', null, undefined]) {
      assert.equal(parseExpiry(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseQuantity', () => {
  it('reads plain and formatted numbers', () => {
    assert.equal(parseQuantity('40'), 40);
    assert.equal(parseQuantity(' 40 '), 40);
    assert.equal(parseQuantity('1,200'), 1200);
    assert.equal(parseQuantity(240), 240);
  });

  it('rounds a spreadsheet float to a whole unit', () => {
    // Excel hands back 40.000000001 for a cell that reads 40.
    assert.equal(parseQuantity(40.000000001), 40);
    assert.equal(parseQuantity('40.0'), 40);
  });

  it('rejects text', () => {
    for (const bad of ['', 'many', 'N/A', '4o', null]) {
      assert.equal(parseQuantity(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseMoneyMinor', () => {
  it('converts to minor units', () => {
    assert.equal(parseMoneyMinor('1500'), 150000);
    assert.equal(parseMoneyMinor('1500.50'), 150050);
    assert.equal(parseMoneyMinor('₦1,500.50'), 150050);
    assert.equal(parseMoneyMinor(1500.5), 150050);
  });

  it('avoids float drift', () => {
    // 19.99 * 100 is 1998.9999999999998 in binary floating point.
    assert.equal(parseMoneyMinor('19.99'), 1999);
    assert.equal(parseMoneyMinor('0.07'), 7);
  });

  it('returns null for blanks', () => {
    assert.equal(parseMoneyMinor(''), null);
    assert.equal(parseMoneyMinor(null), null);
  });
});

describe('validateRow', () => {
  const mapping = { name: 0, quantity: 1, expiryDate: 2, batchNumber: 3 };

  it('accepts a good row', () => {
    const r = validateRow(['Metformin 500mg', '240', '2027-06', 'MET-24-A'], mapping);
    assert.deepEqual(r.errors, []);
    assert.equal(r.normalized?.expiryDate, '2027-06-30');
    assert.equal(r.normalized?.expiryPrecision, 'month');
    assert.equal(r.normalized?.quantity, 240);
  });

  it('treats a missing batch number as fine', () => {
    // Plenty of local stock genuinely has no lot number printed.
    const r = validateRow(['Paracetamol', '10', '2027-06-30', ''], mapping);
    assert.deepEqual(r.errors, []);
    assert.equal(r.normalized?.batchNumber, null);
  });

  it('reports every problem at once, not just the first', () => {
    // Fixing one error, re-uploading, and finding another is miserable.
    const r = validateRow(['', 'lots', 'sometime', ''], mapping);
    assert.equal(r.errors.length, 3);
    assert.deepEqual(r.errors.map((e) => e.field).sort(), ['expiryDate', 'name', 'quantity']);
  });

  it('quotes the offending value back', () => {
    const r = validateRow(['Drug', '4o', '2027-06-30', ''], mapping);
    assert.match(r.errors[0]!.message, /"4o"/);
  });

  it('distinguishes missing from unreadable', () => {
    assert.match(validateRow(['Drug', '', '2027-06-30', ''], mapping).errors[0]!.message, /missing/i);
    assert.match(validateRow(['Drug', 'xx', '2027-06-30', ''], mapping).errors[0]!.message, /not a number/i);
  });

  it('rejects zero and negative quantities', () => {
    assert.equal(validateRow(['Drug', '0', '2027-06-30', ''], mapping).errors.length, 1);
    assert.equal(validateRow(['Drug', '-5', '2027-06-30', ''], mapping).errors.length, 1);
  });
});

describe('isBlankRow', () => {
  it('spots trailing spreadsheet padding', () => {
    assert.equal(isBlankRow(['', '  ', null, undefined]), true);
    assert.equal(isBlankRow(['Drug', '', '', '']), false);
  });
});

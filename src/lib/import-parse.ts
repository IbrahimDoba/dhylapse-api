/**
 * Turning a pharmacy's spreadsheet into batches.
 *
 * Real files are not clean. Headers are capitalised differently every time,
 * dates arrive in half a dozen formats, quantities carry thousands separators,
 * and a third of the rows are blank padding at the bottom of the sheet. All of
 * that is normal input, not user error, and rejecting the whole file because
 * of it is how an import feature goes unused.
 */

export type ImportField = 'name' | 'quantity' | 'expiryDate' | 'batchNumber' | 'sku' | 'unitCost';

/**
 * Header synonyms, lowercased and stripped of punctuation before matching.
 * Ordered most specific first: "expiry date" must win over "date".
 */
const HEADER_SYNONYMS: [ImportField, string[]][] = [
  ['expiryDate', ['expiry date', 'expirydate', 'expiry', 'exp date', 'exp', 'expires', 'expiration', 'expiration date', 'best before', 'use by']],
  ['batchNumber', ['batch number', 'batchno', 'batch no', 'batch', 'lot number', 'lot no', 'lotno', 'lot']],
  ['unitCost', ['unit cost', 'cost', 'unit price', 'price', 'cost price', 'buying price', 'purchase price']],
  ['quantity', ['quantity', 'qty', 'stock', 'units', 'count', 'amount', 'quantity in stock', 'stock qty']],
  ['sku', ['sku', 'code', 'product code', 'item code', 'drug code']],
  ['name', ['drug name', 'drug', 'product name', 'product', 'item name', 'item', 'description', 'medicine', 'name']],
];

const normalizeHeader = (h: string) =>
  h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Maps a sheet's header row onto our fields. Unrecognised columns are ignored. */
export function detectColumns(headers: string[]): Partial<Record<ImportField, number>> {
  const mapping: Partial<Record<ImportField, number>> = {};
  const taken = new Set<number>();

  for (const [field, synonyms] of HEADER_SYNONYMS) {
    for (const synonym of synonyms) {
      const index = headers.findIndex(
        (h, i) => !taken.has(i) && normalizeHeader(h) === synonym,
      );
      if (index !== -1) {
        mapping[field] = index;
        taken.add(index);
        break;
      }
    }
  }
  return mapping;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface ParsedExpiry {
  date: string;
  precision: 'day' | 'month';
}

/**
 * Parses the expiry formats that actually turn up in pharmacy spreadsheets.
 *
 * Day-first is assumed for ambiguous slash dates (03/04/2027 is 3 April),
 * because these are Nigerian and UK-convention files. Where the day exceeds 12
 * the order is unambiguous and detected regardless.
 *
 * A month-only value resolves to the LAST day of that month: stock printed
 * "EXP 06/2027" is usable throughout June.
 */
export function parseExpiry(input: unknown): ParsedExpiry | null {
  if (input == null) return null;

  // Excel gives real Dates for date-formatted cells; trust them.
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return { date: input.toISOString().slice(0, 10), precision: 'day' };
  }

  const raw = String(input).trim();
  if (!raw) return null;

  const lastOfMonth = (y: number, m: number) =>
    new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const valid = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d
      ? date.toISOString().slice(0, 10)
      : null;
  };

  // ISO: 2027-06-30 / 2027-06
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(raw);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null];
    if (mo < 1 || mo > 12) return null;
    if (d == null) return { date: lastOfMonth(y, mo), precision: 'month' };
    const iso = valid(y, mo, d);
    return iso ? { date: iso, precision: 'day' } : null;
  }

  // Slash or dot: 30/06/2027, 30.06.2027, 6/2027, 06/27
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(raw);
  if (m) {
    let [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
    // Day-first unless that is impossible and month-first works.
    const dayFirst = valid(y, b, a);
    if (dayFirst) return { date: dayFirst, precision: 'day' };
    const monthFirst = valid(y, a, b);
    return monthFirst ? { date: monthFirst, precision: 'day' } : null;
  }

  /*
   * Two parts is month and year, never day and month: an expiry with no year
   * is meaningless. A two-digit year is the commonest form printed on a blister
   * pack — "EXP 06/27" — so it has to work, not merely not crash.
   */
  m = /^(\d{1,2})[/.](\d{2}|\d{4})$/.exec(raw);
  if (m) {
    const mo = Number(m[1]);
    let y = Number(m[2]);
    if (y < 100) y += 2000;
    return mo >= 1 && mo <= 12 ? { date: lastOfMonth(y, mo), precision: 'month' } : null;
  }

  // Named month: Jun 2027, June 2027, 30 Jun 2027, Jun-27
  m = /^(?:(\d{1,2})\s+)?([a-z]{3,9})[\s\-/]+(\d{2,4})$/i.exec(raw);
  if (m) {
    const mo = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    if (!mo) return null;
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (m[1]) {
      const iso = valid(y, mo, Number(m[1]));
      return iso ? { date: iso, precision: 'day' } : null;
    }
    return { date: lastOfMonth(y, mo), precision: 'month' };
  }

  return null;
}

/** Quantities arrive as "1,200", " 40 ", "40.0", or a real number from Excel. */
export function parseQuantity(input: unknown): number | null {
  if (input == null || input === '') return null;
  if (typeof input === 'number') return Number.isInteger(input) ? input : Math.round(input);
  const cleaned = String(input).replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Money as minor units. "₦1,500.50" and "1500.5" both become 150050. */
export function parseMoneyMinor(input: unknown): number | null {
  if (input == null || input === '') return null;
  if (typeof input === 'number') return Math.round(input * 100);
  const cleaned = String(input).replace(/[^\d.-]/g, '');
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export interface RowError {
  field: string;
  code: string;
  message: string;
}

export interface NormalizedRow {
  name: string;
  quantity: number;
  expiryDate: string;
  expiryPrecision: 'day' | 'month';
  batchNumber: string | null;
  sku: string | null;
  unitCostMinor: number | null;
}

export interface ValidatedRow {
  normalized: NormalizedRow | null;
  errors: RowError[];
}

/** True when every cell is blank — trailing padding, not a row to complain about. */
export const isBlankRow = (cells: unknown[]) =>
  cells.every((c) => c == null || String(c).trim() === '');

export function validateRow(
  cells: unknown[],
  mapping: Partial<Record<ImportField, number>>,
): ValidatedRow {
  const errors: RowError[] = [];
  const at = (field: ImportField) => {
    const i = mapping[field];
    return i == null ? undefined : cells[i];
  };

  const name = String(at('name') ?? '').trim();
  if (!name) errors.push({ field: 'name', code: 'required', message: 'Drug name is missing.' });

  const rawQty = at('quantity');
  const quantity = parseQuantity(rawQty);
  if (quantity == null) {
    errors.push({
      field: 'quantity',
      code: 'invalid',
      message: rawQty == null || rawQty === '' ? 'Quantity is missing.' : `"${String(rawQty)}" is not a number.`,
    });
  } else if (quantity < 1) {
    errors.push({ field: 'quantity', code: 'invalid', message: 'Quantity must be at least 1.' });
  }

  const rawExpiry = at('expiryDate');
  const expiry = parseExpiry(rawExpiry);
  if (!expiry) {
    errors.push({
      field: 'expiryDate',
      code: 'invalid',
      message:
        rawExpiry == null || rawExpiry === ''
          ? 'Expiry date is missing.'
          : `Could not read "${String(rawExpiry)}" as a date.`,
    });
  }

  if (errors.length > 0) return { normalized: null, errors };

  const batch = String(at('batchNumber') ?? '').trim();
  const sku = String(at('sku') ?? '').trim();

  return {
    normalized: {
      name,
      quantity: quantity!,
      expiryDate: expiry!.date,
      expiryPrecision: expiry!.precision,
      batchNumber: batch || null,
      sku: sku || null,
      unitCostMinor: parseMoneyMinor(at('unitCost')),
    },
    errors: [],
  };
}

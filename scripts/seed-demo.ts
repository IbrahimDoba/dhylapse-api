/**
 * Seeds a demo pharmacy you can actually log into and explore.
 *
 *   ./scripts/db-setup.sh --reset && pnpm seed:demo
 *
 * Goes through the HTTP API rather than writing rows directly, so everything
 * lands the same way a real user's data would — batches post to the ledger,
 * alerts come from the real scan. A fixture that bypasses the app can hide
 * exactly the bugs a demo is supposed to surface.
 */
const API = process.env.DEMO_API ?? 'http://localhost:4000';
/*
 * better-auth rejects auth requests with no Origin as a CSRF guard, and Node's
 * fetch sends none. Presenting a trusted origin is what a browser does; it has
 * to match CORS_ORIGIN or the request is refused.
 */
const ORIGIN = process.env.DEMO_ORIGIN ?? 'http://localhost:5174';
const EMAIL = 'demo@greenline.ng';
const PASSWORD = 'demo-pharmacy-2026';

let cookie = '';

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return parsed;
}

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** name, sku, reorder point, unit cost in kobo, cold chain */
const CATALOGUE: [string, string, number, number, boolean][] = [
  ['Coartem 20/120mg',          'COA-20120', 40,   185000, false],
  ['Amoxicillin 500mg',         'AMO-500',   60,    12000, false],
  ['Paracetamol 500mg',         'PAR-500',  200,     2500, false],
  ['Metformin 500mg',           'MET-500',   80,    15000, false],
  ['Amlodipine 5mg',            'AML-005',   50,     9500, false],
  ['Lisinopril 10mg',           'LIS-010',   50,    11000, false],
  ['Insulin Glargine 100IU',    'INS-GLA',   10,   420000, true ],
  ['Augmentin 625mg',           'AUG-625',   30,    98000, false],
  ['Ciprofloxacin 500mg',       'CIP-500',   40,    28000, false],
  ['ORS Sachets',               'ORS-001',  150,     3000, false],
  ['Ventolin Inhaler 100mcg',   'VEN-100',   15,   145000, false],
  ['Omeprazole 20mg',           'OME-020',   60,    18000, false],
  ['Artesunate Injection 60mg', 'ART-060',   20,   240000, false],
  ['Ceftriaxone 1g',            'CEF-1G',    25,   165000, false],
  ['Metronidazole 400mg',       'MET-400',   80,     7500, false],
];

/**
 * Expiry offsets per product, in days. Deliberately uneven: a few lots already
 * expired and unnoticed, a cluster inside each alert window, and a long tail.
 * A tidy spread would make the dashboard look calmer than a real shelf.
 */
const LOTS: [number, number][] = [
  [-12, 18], [-3, 40],                        // already gone
  [4, 24], [6, 12],                           // 7-day rung
  [11, 60], [19, 140], [27, 35],              // 30-day rung
  [44, 220], [61, 90], [78, 310],             // 90-day rung
  [104, 180], [141, 260], [166, 95],          // 180-day rung
  [212, 400], [287, 150], [365, 500],         // clear
  [430, 240], [520, 320],
];

console.log(`seeding demo pharmacy at ${API}`);

try {
  await call('POST', '/api/auth/sign-up/email', { email: EMAIL, password: PASSWORD, name: 'Aria Devani' });
  console.log('  account created');
} catch (err) {
  // Only an existing account is worth recovering from. Swallowing everything
  // here turned a CSRF rejection into a misleading "account exists".
  const message = err instanceof Error ? err.message : String(err);
  if (!/USER_ALREADY_EXISTS|already exists|422|409/i.test(message)) throw err;
  console.log('  account exists — signing in');
  await call('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
}

const me = await call('GET', '/api/me');
if (me.memberships.length === 0) {
  await call('POST', '/api/workspaces', { name: 'Greenline Pharmacy' });
  console.log('  workspace created');
}

let batches = 0;
for (const [i, [name, sku, reorderPoint, cost, cold]] of CATALOGUE.entries()) {
  const product = await call('POST', '/api/products', {
    name, sku, reorderPoint,
    ...(cold ? { storageCondition: 'cold_chain' as const } : {}),
  });

  // Two or three lots each, so the batch-level model is visible rather than
  // implied — one product genuinely holding stock with different expiry dates.
  const count = 2 + (i % 2);
  for (let n = 0; n < count; n++) {
    const lot = LOTS[(i * 3 + n) % LOTS.length]!;
    const [offset, qty] = lot;
    // A fifth of labels print month only, as they do in reality.
    const expiry = (i + n) % 5 === 0 ? day(offset).slice(0, 7) : day(offset);
    await call('POST', '/api/batches', {
      productId: product.id,
      batchNumber: `${sku.split('-')[1]}-${String(2400 + i * 7 + n)}`,
      expiryDate: expiry,
      quantity: qty,
      unitCostMinor: cost,
      currency: 'NGN',
    });
    batches++;
  }
}
console.log(`  ${CATALOGUE.length} products, ${batches} batches`);

// Some stock has moved, so the ledger has a story to tell.
const list = await call('GET', '/api/batches?limit=200');
let dispensed = 0;
for (const b of list.batches.slice(0, 10)) {
  const take = Math.max(1, Math.floor(b.quantityOnHand * 0.3));
  await call('POST', `/api/batches/${b.id}/adjust`, {
    quantityDelta: -take, reason: 'dispense', notes: 'Counter sale',
  });
  dispensed++;
}
console.log(`  ${dispensed} batches dispensed against`);

const scan = await call('POST', '/api/alerts/scan', {});
console.log(`  scan raised ${scan.alertsCreated} alerts (${scan.organizationsFailed} orgs failed)`);

// Acknowledge a couple so both inbox tabs have content.
const alerts = await call('GET', '/api/alerts?limit=100');
for (const a of alerts.alerts.slice(-2)) {
  await call('POST', `/api/alerts/${a.id}/acknowledge`, {});
}

const dash = await call('GET', '/api/dashboard');
console.log('\n  ready');
console.log(`  email:    ${EMAIL}`);
console.log(`  password: ${PASSWORD}`);
console.log(`  expiring: ${JSON.stringify(dash.expiring)}`);
console.log(`  at risk:  ₦${(dash.valueAtRiskMinor.within90 / 100).toLocaleString()} within 90 days`);

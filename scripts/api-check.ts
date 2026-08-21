/**
 * End-to-end API regression test.
 *
 * Uses fastify's inject() rather than a live port, so it needs no running
 * server and cannot collide with whatever else is bound locally.
 *
 *   pnpm check:api
 *
 * Requires a database that has been through ./scripts/db-setup.sh.
 */
import { buildApp } from '../src/app.ts';
import { closeDb } from '../src/db/client.ts';

const app = await buildApp();
await app.ready();

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${detail}`);
  if (!ok) failures++;
};

const stamp = Date.now();
let cookie = '';
const json = { 'content-type': 'application/json' };

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { ...json, ...(cookie ? { cookie } : {}) },
    ...(payload ? { payload: payload as object } : {}),
  });
  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookie = list.map((c) => c.split(';')[0]).join('; ');
  }
  let body: any = null;
  try { body = res.json(); } catch { /* empty body */ }
  return { status: res.statusCode, body };
}

// --- auth + workspace -------------------------------------------------------
const signup = await call('POST', '/api/auth/sign-up/email', {
  email: `check-${stamp}@example.test`,
  password: 'correct-horse-battery-staple',
  name: 'Check User',
});
check('sign up', signup.status === 200, `HTTP ${signup.status}`);

const ws = await call('POST', '/api/workspaces', { name: `Check Pharmacy ${stamp}` });
check('create workspace', ws.status === 201, `${ws.body?.alertRules} alert rules seeded`);
check('default alert ladder seeded', ws.body?.alertRules === 5);

const me = await call('GET', '/api/me');
check('membership resolved as owner', me.body?.memberships?.[0]?.role === 'owner');

// --- catalog ----------------------------------------------------------------
const product = await call('POST', '/api/products', {
  name: 'Metformin 500mg', sku: `MET-${stamp}`, reorderPoint: 50,
});
check('create product', product.status === 201);
const productId = product.body?.id;

// --- receiving stock --------------------------------------------------------
const batch = await call('POST', '/api/batches', {
  productId, batchNumber: `LOT-${stamp}`,
  expiryDate: '2026-11', quantity: 240, unitCostMinor: 15000, currency: 'NGN',
});
check('receive stock', batch.status === 201, `qty ${batch.body?.quantityOnHand}`);
check('month-only expiry -> last of month', batch.body?.expiryDate === '2026-11-30',
  `${batch.body?.expiryDate} (${batch.body?.expiryPrecision})`);
check('value at risk computed', batch.body?.valueAtRiskMinor === 240 * 15000,
  `₦${(batch.body?.valueAtRiskMinor / 100).toLocaleString()}`);
const batchId = batch.body?.id;

// --- the ledger -------------------------------------------------------------
const dispense = await call('POST', `/api/batches/${batchId}/adjust`, {
  quantityDelta: -40, reason: 'dispense',
});
check('dispense updates balance', dispense.body?.quantityOnHand === 200);

const oversell = await call('POST', `/api/batches/${batchId}/adjust`, {
  quantityDelta: -5000, reason: 'dispense',
});
check('oversell rejected as 422', oversell.status === 422, oversell.body?.error);
check('oversell message is readable',
  String(oversell.body?.message ?? '').startsWith('insufficient stock'));

const dupe = await call('POST', '/api/batches', {
  productId, batchNumber: `LOT-${stamp}`, expiryDate: '2026-11', quantity: 10,
});
check('duplicate lot rejected as 409', dupe.status === 409, dupe.body?.error);
check('duplicate message is readable',
  String(dupe.body?.message ?? '').includes('already recorded'));

const movements = await call('GET', `/api/batches/${batchId}/movements`);
check('ledger records both movements', movements.body?.movements?.length === 2,
  movements.body?.movements?.map((m: any) => `${m.reason} ${m.quantityDelta}`).join(', '));

// --- derived rollups --------------------------------------------------------
const products = await call('GET', '/api/products');
const p = products.body?.products?.find((x: any) => x.id === productId);
check('product quantity derived from batches', p?.quantityOnHand === 200, `qty ${p?.quantityOnHand}`);

const soon = await call('GET', '/api/batches?withinDays=1');
check('expiry window filters correctly', soon.body?.batches?.length === 0, 'nothing due in 1 day');

// --- authorization ----------------------------------------------------------
const anon = await app.inject({ method: 'GET', url: '/api/products' });
check('anonymous read rejected', anon.statusCode === 401, `HTTP ${anon.statusCode}`);

const badExpiry = await call('POST', '/api/batches', {
  productId, expiryDate: '2026-13', quantity: 1,
});
check('impossible month rejected', badExpiry.status === 422, badExpiry.body?.error);

await app.close();
await closeDb();
console.log(failures === 0 ? '\nall API checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

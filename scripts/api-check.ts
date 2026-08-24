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
  /*
   * Only send content-type when there is a body. Declaring JSON with an empty
   * body is a 400 from Fastify, which is correct — but it made the harness
   * fail on every POST that takes no input.
   */
  const res = await app.inject({
    method,
    url,
    headers: { ...(payload ? json : {}), ...(cookie ? { cookie } : {}) },
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

// --- expiry alert engine ----------------------------------------------------
// A batch per band, so threshold selection is unambiguous.
const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const alertProduct = (await call('POST', '/api/products', { name: `Insulin ${stamp}` })).body?.id;
for (const [days, lot] of [[5, 'B5'], [20, 'B20'], [60, 'B60'], [150, 'B150'], [400, 'B400']] as const) {
  await call('POST', '/api/batches', {
    productId: alertProduct, batchNumber: `${lot}-${stamp}`,
    expiryDate: inDays(days), quantity: 10, unitCostMinor: 100000, currency: 'NGN',
  });
}

const scan1 = await call('POST', '/api/alerts/scan');
check('scan raises alerts', scan1.body?.alertsCreated >= 4, `${scan1.body?.alertsCreated} created`);
/*
 * A scan where every organization threw was previously reported as a success
 * with zero alerts — the worst possible failure for an alerting system,
 * because nothing looks wrong. Assert on failures, not just on the count.
 */
check('scan reports no organization failures', scan1.body?.organizationsFailed === 0,
  (scan1.body?.errors ?? []).join(' | ').slice(0, 90) || 'clean');

const scan2 = await call('POST', '/api/alerts/scan');
check('scan is exactly-once on rerun', scan2.body?.alertsCreated === 0, `${scan2.body?.alertsCreated} created`);

const inbox = await call('GET', '/api/alerts?limit=200');
// Only the band fixtures — the Metformin lot from the inventory section shares
// this run's timestamp and legitimately raises an alert of its own.
const mine = (inbox.body?.alerts ?? []).filter((a: any) =>
  /^B\d+-/.test(String(a.batchNumber ?? '')) && String(a.batchNumber).endsWith(String(stamp)));
const rung = (lot: string) => mine.find((a: any) => a.batchNumber?.startsWith(lot))?.thresholdDays;

check('5 days out fires the 7-day rung', rung('B5') === 7, `got ${rung('B5')}`);
check('20 days out fires the 30-day rung', rung('B20') === 30, `got ${rung('B20')}`);
check('60 days out fires the 90-day rung', rung('B60') === 90, `got ${rung('B60')}`);
check('150 days out fires the 180-day rung', rung('B150') === 180, `got ${rung('B150')}`);
check('400 days out fires nothing', rung('B400') === undefined, 'outside every band');
/*
 * The property that matters most: one alert per batch per scan. Firing every
 * threshold whose window has passed would deliver 180/90/30/7 the same night
 * for short-dated stock — the fatigue the ladder exists to prevent.
 */
check('one alert per batch, not one per threshold', mine.length === 4, `${mine.length} alerts for 5 batches`);

const bundle = await call('GET', '/api/notifications');
check('alerts bundle into one notification', (bundle.body?.notifications ?? []).length >= 1,
  bundle.body?.notifications?.[0]?.subject);

const firstAlert = mine[0];
const ack = await call('POST', `/api/alerts/${firstAlert.id}/acknowledge`);
check('acknowledge succeeds', ack.body?.status === 'acknowledged');
const ackTwice = await call('POST', `/api/alerts/${firstAlert.id}/acknowledge`);
check('acknowledging twice is rejected', ackTwice.status === 404, ackTwice.body?.error);

// --- CSV import -------------------------------------------------------------
/** Builds a multipart body by hand; inject() takes no FormData. */
function multipart(filename: string, content: string) {
  const boundary = `----check${stamp}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { boundary, body };
}

async function upload(filename: string, content: string) {
  const { boundary, body } = multipart(filename, content);
  const res = await app.inject({
    method: 'POST',
    url: '/api/imports',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie },
    payload: body,
  });
  let parsed: any = null;
  try { parsed = res.json(); } catch { /* empty */ }
  return { status: res.statusCode, body: parsed };
}

/*
 * Deliberately messy, because real files are: a thousands separator, a naira
 * sign, four date formats, a June 31st, a missing name, and trailing blank
 * padding. Rejecting a file over any of these is how an import goes unused.
 */
const messy = [
  'Drug Name,QTY,Exp. Date,Lot No,Unit Price',
  `Lisinopril ${stamp},240,30/06/2027,LIS-${stamp},₦110.00`,
  `Amlodipine ${stamp},"1,200",06/27,AML-${stamp},95.50`,
  `Chloroquine ${stamp},60,Jun 2027,CHL-${stamp},45`,
  `Zinc ${stamp},,2027-05-31,ZIN-${stamp},15`,
  `Rifampicin ${stamp},80,sometime next year,RIF-${stamp},300`,
  `,40,2027-08-31,XXX-${stamp},50`,
  `Folic ${stamp},90,31/06/2027,FOL-${stamp},12`,
  ',,,,',
  ',,,,',
].join('\n');

const up = await upload('stock.csv', messy);
check('import accepts a messy CSV', up.status === 201, `HTTP ${up.status}`);
check('blank padding is not counted as rows', up.body?.rowCount === 7, `${up.body?.rowCount} rows`);
check('good rows validate', up.body?.validCount === 3, `${up.body?.validCount} valid`);
check('bad rows are flagged, not fatal', up.body?.errorCount === 4, `${up.body?.errorCount} errors`);

const review = await call('GET', `/api/imports/${up.body?.id}?only=valid&limit=50`);
const byName = (frag: string) =>
  review.body?.rows?.find((r: any) => String(r.normalized?.name ?? '').startsWith(frag))?.normalized;
check('day-first slash date', byName('Lisinopril')?.expiryDate === '2027-06-30');
check('MM/YY reads as a month', byName('Amlodipine')?.expiryDate === '2027-06-30'
  && byName('Amlodipine')?.expiryPrecision === 'month');
check('thousands separator parses', byName('Amlodipine')?.quantity === 1200);
check('currency symbol strips to minor units', byName('Lisinopril')?.unitCostMinor === 11000);

const bad = await call('GET', `/api/imports/${up.body?.id}?only=invalid&limit=50`);
const messages = (bad.body?.rows ?? []).flatMap((r: any) => r.errors.map((e: any) => e.message)).join(' | ');
check('June 31st is rejected', /31\/06\/2027/.test(messages), 'impossible date caught');
check('errors quote the offending value', /sometime next year/.test(messages));

const commit = await call('POST', `/api/imports/${up.body?.id}/commit`);
check('commit applies only valid rows', commit.body?.committed === 3, JSON.stringify(commit.body));
const recommit = await call('POST', `/api/imports/${up.body?.id}/commit`);
check('committing twice is refused', recommit.status === 409, recommit.body?.error);

// Imported stock must arrive through the ledger like anything else.
const imported = await call('GET', `/api/batches?q=Lisinopril ${stamp}`);
const impBatch = imported.body?.batches?.[0];
check('imported batch has the right quantity', impBatch?.quantityOnHand === 240);
const impMoves = await call('GET', `/api/batches/${impBatch?.id}/movements`);
check('imported stock posts a receipt to the ledger',
  impMoves.body?.movements?.[0]?.reason === 'receipt', `${impMoves.body?.movements?.length} movement(s)`);

const again = await upload('stock.csv', messy);
check('re-uploading the same file warns', !!again.body?.duplicateOf, 'identical content hash');
const againCommit = await call('POST', `/api/imports/${again.body?.id}/commit`);
check('known lots are skipped, not duplicated', againCommit.body?.duplicates === 3,
  `${againCommit.body?.duplicates} duplicates, ${againCommit.body?.committed} committed`);

const noCols = await upload('bad.csv', 'Foo,Bar,Baz\n1,2,3');
check('a file with no usable columns is rejected clearly', noCols.status === 422
  && /Could not find/.test(noCols.body?.message ?? ''), noCols.body?.message?.slice(0, 60));

// --- email delivery ---------------------------------------------------------
const deliver = await call('POST', '/api/alerts/deliver');
check('email queue drains', deliver.status === 200 && deliver.body?.sent >= 1,
  `${deliver.body?.sent} sent via ${deliver.body?.provider}`);
check('nothing abandoned on a good address', deliver.body?.abandoned === 0);

const drained = await call('POST', '/api/alerts/deliver');
check('drained queue is a no-op', drained.body?.attempted === 0, `${drained.body?.attempted} attempted`);

/*
 * The subject claims a 7-day count; the body reports the total across every
 * band. Reusing one number for both put "17 batches expiring within 7 days"
 * on an email listing 25 — a wrong figure in an alert discredits every other
 * number in it.
 */
const notif = await call('GET', '/api/notifications');
const payload = notif.body?.notifications?.[0]?.payload;
check('digest separates critical from total', payload?.critical <= payload?.total,
  `critical ${payload?.critical} of ${payload?.total}`);

// --- suppliers and disposition (the money loop) -----------------------------
const supplier = await call('POST', '/api/suppliers', {
  name: `Emzor ${stamp}`, acceptsReturns: true,
  returnWindowDaysBeforeExpiry: 90, creditRatePercent: 80,
});
check('create supplier with return terms', supplier.status === 201);

const dispProduct = (await call('POST', '/api/products', { name: `Coartem ${stamp}` })).body?.id;
const made: Record<string, string> = {};
for (const [days, lot] of [[150, 'RETURNABLE'], [40, 'PASTWINDOW'], [-5, 'EXPIRED']] as const) {
  const b = await call('POST', '/api/batches', {
    productId: dispProduct, supplierId: supplier.body?.id,
    batchNumber: `${lot}-${stamp}`, expiryDate: inDays(days),
    quantity: 100, unitCostMinor: 185000, currency: 'NGN',
  });
  made[lot] = b.body?.id;
}

const optReturnable = await call('GET', `/api/batches/${made['RETURNABLE']}/options`);
check('in-window stock is returnable', optReturnable.body?.returnable === true);
check('credit is estimated at the agreed rate',
  optReturnable.body?.estimatedCreditMinor === Math.round(185000 * 100 * 0.8),
  `₦${(optReturnable.body?.estimatedCreditMinor / 100).toLocaleString()} of ₦185,000`);

const optPast = await call('GET', `/api/batches/${made['PASTWINDOW']}/options`);
check('stock past the return window is not returnable', optPast.body?.returnable === false);
check('and says why', /return window/.test(optPast.body?.recommendation ?? ''),
  optPast.body?.recommendation?.slice(0, 55));

/*
 * Expired must be reported as expired, not as "past the window". The window
 * test is trivially true once a date has passed, and "discount or dispose" is
 * wrong advice for stock that has to be destroyed with a certificate.
 */
const optExpired = await call('GET', `/api/batches/${made['EXPIRED']}/options`);
check('expired stock is called expired, not out-of-window',
  /Already expired/.test(optExpired.body?.recommendation ?? ''),
  optExpired.body?.recommendation?.slice(0, 50));

const disp = await call('POST', '/api/dispositions', {
  batchId: made['RETURNABLE'], action: 'return_to_supplier', quantity: 100,
});
check('propose a return', disp.status === 201 && disp.body?.status === 'proposed');
check('book value is captured at proposal', disp.body?.costValueMinor === 18500000);

const earlyComplete = await call('POST', `/api/dispositions/${disp.body?.id}/complete`, {});
check('cannot complete before approval', earlyComplete.status === 422, earlyComplete.body?.error);

await call('POST', `/api/dispositions/${disp.body?.id}/approve`);
const completed = await call('POST', `/api/dispositions/${disp.body?.id}/complete`, {
  recoveredValueMinor: 14800000, creditNoteReference: `CN-${stamp}`, creditReceived: true,
});
check('complete records the credit', completed.body?.recoveredValueMinor === 14800000);

const dispMoves = await call('GET', `/api/batches/${made['RETURNABLE']}/movements`);
check('disposal leaves through the ledger',
  dispMoves.body?.movements?.some((m: any) => m.reason === 'return_to_supplier' && m.quantityDelta === -100),
  dispMoves.body?.movements?.map((m: any) => `${m.reason} ${m.quantityDelta}`).join(', '));
check('batch is emptied, not deleted',
  dispMoves.body?.movements?.at(-1)?.balanceAfter === 0);

const over = await call('POST', '/api/dispositions', {
  batchId: made['RETURNABLE'], action: 'destroy', quantity: 500,
});
check('cannot dispose more than is on hand', over.status === 422, over.body?.message?.slice(0, 45));

const ledger = await call('GET', '/api/dispositions');
check('recovery is reported against book value',
  ledger.body?.summary?.recoveredValueMinor === 14800000
  && ledger.body?.summary?.costValueMinor === 18500000,
  `₦${(ledger.body?.summary?.recoveredValueMinor / 100).toLocaleString()} of ₦${(ledger.body?.summary?.costValueMinor / 100).toLocaleString()}`);

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

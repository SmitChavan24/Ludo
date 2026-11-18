import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { CoinShop } from '../src/shop/CoinShop.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';

// A fake BillTrack Pay integration API. Tests flip `payments[id].status` to
// simulate the customer paying on pay.billtrack.me.
function fakePay() {
  const payments = {};
  let n = 0;
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(opts.headers.Authorization, `Bearer ${config.shop.payApiKey}`);
    const path = new URL(url).pathname;
    if (opts.method === 'POST' && path === '/api/integrations/orders') {
      const body = JSON.parse(opts.body);
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      payments[id] = { paymentId: id, externalRef: body.externalRef, amount: body.amount, currency: 'INR', status: 'created', checkoutUrl: `https://pay.test/checkout/${id}` };
      return new Response(JSON.stringify(payments[id]), { status: 201 });
    }
    const m = /^\/api\/integrations\/orders\/(.+)$/.exec(path);
    if (opts.method === 'GET' && m && payments[m[1]]) return new Response(JSON.stringify(payments[m[1]]), { status: 200 });
    return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
  };
  return { payments, calls, fetchImpl };
}

let pay;
let shop;
let seq = 0;
const user = () => ({ id: `shopuser${++seq}`, name: 'Asha', email: 'a@example.com' });

beforeEach(() => {
  config.shop.payApiUrl = 'http://127.0.0.1:4000';
  config.shop.payApiKey = 'k'.repeat(40);
  config.shop.publicUrl = 'https://ludo.test';
  config.shop.packs = [{ id: 'starter', coins: 500, priceInr: 49 }];
  pay = fakePay();
  shop = new CoinShop({ fetchImpl: pay.fetchImpl });
});

test('creating an order asks pay for the server-side price and a return URL to us', async () => {
  const u = user();
  const order = await shop.createOrder(u, 'starter');
  assert.equal(order.status, 'pending');
  assert.match(order.checkoutUrl, /^https:\/\/pay\.test\/checkout\//);
  const sent = JSON.parse(pay.calls[0].opts.body);
  assert.equal(sent.amount, 4900);
  assert.equal(sent.externalRef, order.id);
  assert.equal(sent.returnUrl, `https://ludo.test/?coinOrder=${order.id}`);
});

test('unknown packs are refused', async () => {
  await assert.rejects(shop.createOrder(user(), 'free-money'), { code: 'BAD_PACK' });
});

test('an unpaid order credits nothing', async () => {
  const u = user();
  const order = await shop.createOrder(u, 'starter');
  const after = await shop.sync(order.id);
  assert.equal(after.status, 'pending');
  assert.equal(await wallet.getBalance(u.id), 0);
});

test('a paid order credits the coins exactly once, however often it is synced', async () => {
  const u = user();
  const order = await shop.createOrder(u, 'starter');
  pay.payments[order.payPaymentId].status = 'paid';
  // Return page, poller and a double click all at once.
  await Promise.all([shop.sync(order.id), shop.sync(order.id), shop.syncPending(), shop.sync(order.id)]);
  await shop.sync(order.id);
  assert.equal(await wallet.getBalance(u.id), 500);
  assert.equal((await store.getCoinOrder(order.id)).status, 'credited');
});

test('a payment whose amount does not match is never credited', async () => {
  const u = user();
  const order = await shop.createOrder(u, 'starter');
  Object.assign(pay.payments[order.payPaymentId], { status: 'paid', amount: 100 });
  const after = await shop.sync(order.id);
  assert.equal(after.status, 'mismatch');
  assert.equal(await wallet.getBalance(u.id), 0);
});

test('a payment refunded before we saw it is not credited', async () => {
  const u = user();
  const order = await shop.createOrder(u, 'starter');
  pay.payments[order.payPaymentId].status = 'refunded';
  assert.equal((await shop.sync(order.id)).status, 'refunded');
  assert.equal(await wallet.getBalance(u.id), 0);
});

test('players can only sync their own orders', async () => {
  const order = await shop.createOrder(user(), 'starter');
  await assert.rejects(shop.syncForUser(user(), order.id), { code: 'NOT_FOUND' });
});

test('stale unpaid orders expire', async () => {
  const u = user();
  const order = await shop.createOrder(u, 'starter');
  await store.updateCoinOrder(order.id, {});
  const stored = await store.getCoinOrder(order.id);
  // Backdate it past the TTL (memory store returns copies, so patch the source).
  const ttl = config.shop.orderTtlMs;
  config.shop.orderTtlMs = -1;
  try {
    assert.equal((await shop.sync(stored.id)).status, 'expired');
  } finally {
    config.shop.orderTtlMs = ttl;
  }
});

test('if the pay server is down the order fails instead of hanging around', async () => {
  const down = new CoinShop({ fetchImpl: async () => new Response('{"error":"down"}', { status: 503 }) });
  await assert.rejects(down.createOrder(user(), 'starter'), { code: 'PAY_API' });
});

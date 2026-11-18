import { nanoid } from 'nanoid';
import { store } from '../db/store.js';
import { wallet } from '../wallet/Wallet.js';
import { config } from '../config.js';

export class ShopError extends Error {
  constructor(message, code = 'SHOP_ERROR', status = 400) {
    super(message);
    this.name = 'ShopError';
    this.code = code;
    this.status = status;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CoinShop — players buy coin packs through BillTrack Pay (pay.billtrack.me).
//
//   1. createOrder: we pick the price from OUR pack list, ask the pay server to
//      create a payment, and hand the player its checkout URL.
//   2. The player pays on pay.billtrack.me (Razorpay) and is sent back here.
//   3. sync: we ask the pay server, server-to-server with our secret key, what
//      the payment's status is. Only "paid" with the exact amount credits coins.
//
// The browser's "I paid" redirect is never trusted. Crediting goes through
// wallet.creditOnce keyed on the order id, so polling, the return page and a
// double click can all race and the coins still land exactly once.
//
// Coins bought here are game currency only: they cannot be withdrawn,
// transferred or exchanged for money.
// ──────────────────────────────────────────────────────────────────────────
export class CoinShop {
  constructor({ fetchImpl = (...a) => fetch(...a) } = {}) {
    this.fetch = fetchImpl;
    this.timer = null;
  }

  get enabled() {
    return config.shop.enabled;
  }

  packs() {
    return config.shop.packs.map((p) => ({ ...p }));
  }

  async _pay(method, path, body) {
    const res = await this.fetch(`${config.shop.payApiUrl}/api/integrations${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.shop.payApiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ShopError(data.error || `Payment server error (${res.status})`, 'PAY_API', 502);
    }
    return data;
  }

  async createOrder(user, packId) {
    if (!this.enabled) throw new ShopError('The coin shop is not available right now', 'SHOP_DISABLED', 503);
    const pack = config.shop.packs.find((p) => p.id === packId);
    if (!pack) throw new ShopError('Unknown coin pack', 'BAD_PACK');

    const now = Date.now();
    const order = await store.createCoinOrder({
      id: nanoid(16),
      userId: user.id,
      packId: pack.id,
      coins: pack.coins,
      amountInr: pack.priceInr,
      payPaymentId: null,
      checkoutUrl: null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    let payment;
    try {
      payment = await this._pay('POST', '/orders', {
        amount: pack.priceInr * 100,
        purpose: `CoinLudo: ${pack.coins.toLocaleString('en-IN')} coins`,
        externalRef: order.id,
        returnUrl: `${config.shop.publicUrl}/?coinOrder=${order.id}`,
        customer: { name: user.name || undefined, email: user.email || undefined },
      });
    } catch (err) {
      await store.updateCoinOrder(order.id, { status: 'failed' });
      throw err;
    }

    return store.updateCoinOrder(order.id, {
      payPaymentId: payment.paymentId,
      checkoutUrl: payment.checkoutUrl,
    });
  }

  // Ask the pay server about one order and credit the coins if it is paid.
  // Safe to call any number of times, from anywhere, concurrently.
  async sync(orderId) {
    const order = await store.getCoinOrder(orderId);
    if (!order || order.status !== 'pending' || !order.payPaymentId) return order;

    const payment = await this._pay('GET', `/orders/${order.payPaymentId}`);
    // Refunded before we ever credited it: nothing to give.
    if (payment.status === 'refunded') return store.updateCoinOrder(order.id, { status: 'refunded' });

    if (payment.status === 'paid' || payment.status === 'partially_refunded') {
      if (payment.externalRef !== order.id || payment.amount !== order.amountInr * 100 || payment.currency !== 'INR') {
        // Never credit a payment that doesn't match what we asked for.
        console.error(`[shop] order ${order.id} does not match pay record`, payment);
        return store.updateCoinOrder(order.id, { status: 'mismatch' });
      }
      await wallet.creditOnce(`coin_order:${order.id}`, order.userId, order.coins, 'coin_purchase', order.id);
      return store.updateCoinOrder(order.id, { status: 'credited' });
    }

    if (Date.now() - order.createdAt > config.shop.orderTtlMs) {
      return store.updateCoinOrder(order.id, { status: 'expired' });
    }
    return order;
  }

  // For the player's own order only.
  async syncForUser(user, orderId) {
    const order = await store.getCoinOrder(orderId);
    if (!order || order.userId !== user.id) throw new ShopError('Order not found', 'NOT_FOUND', 404);
    return this.sync(orderId);
  }

  // Catch payments whose player closed the tab before coming back.
  async syncPending() {
    const since = Date.now() - config.shop.orderTtlMs - 60 * 60_000;
    const pending = await store.listCoinOrders({ status: 'pending', since, limit: 200 });
    for (const o of pending) {
      try {
        await this.sync(o.id);
      } catch (err) {
        console.error(`[shop] sync ${o.id} failed: ${err.message}`);
      }
    }
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.syncPending().catch(() => {}), config.shop.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

export const shop = new CoinShop();

export const publicOrder = (o) =>
  o && {
    id: o.id,
    packId: o.packId,
    coins: o.coins,
    amountInr: o.amountInr,
    status: o.status,
    checkoutUrl: o.status === 'pending' ? o.checkoutUrl : null,
    createdAt: o.createdAt,
  };

'use strict';
// A tiny pretend Stripe for the tests: just the few calls Outpost makes for auction charges and payment pages.
// It can also hold a reply back or crash the app at the worst moment, to check what happens then.
const http = require('node:http');

function startFakeStripe() {
  const st = { intents: [], sessions: new Map(), calls: [], keys: new Map(), n: 0, delayIntentMs: 0, hangIntent: false, onIntentCreated: null, declineNext: false, taxPercent: 10, refunds: [], failSessions: false, failRefund: false, customers: [], sessionDelayMs: 0, hangRefund: false, onRefundCreated: null, refundDelayMs: 0 };
  const parse = (body) => { const o = {}; for (const [k, v] of new URLSearchParams(body)) o[k] = v; return o; };
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'request-id': 'req_fake' }); res.end(JSON.stringify(obj)); };
  const err = (res, code, type, message) => send(res, code, { error: { type, message, code: type === 'card_error' ? 'card_declined' : undefined } });
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x'); const p = url.pathname; const b = parse(raw);
      st.calls.push(`${req.method} ${p}`);
      if (req.method === 'POST' && p === '/v1/tax/calculations') {
        const sub = Number(b['line_items[0][amount]'] || 0), ship = Number(b['shipping_cost[amount]'] || 0), tax = Math.round((sub + ship) * st.taxPercent / 100);
        return send(res, 200, { id: 'taxcalc_' + (++st.n), object: 'tax.calculation', amount_total: sub + ship + tax, tax_amount_exclusive: tax });
      }
      if (req.method === 'POST' && p === '/v1/customers') {
        const key = req.headers['idempotency-key'];
        if (key && st.keys.has(key)) return send(res, 200, st.keys.get(key).pi);
        const c = { id: 'cus_' + (++st.n), object: 'customer' }; st.customers.push(c); if (key) st.keys.set(key, { body: raw, pi: c });
        await new Promise((r) => setTimeout(r, 200));   // a little thinking time, so two taps at once overlap
        return send(res, 200, c);
      }
      if (req.method === 'DELETE' && /^\/v1\/customers\/[^/]+$/.test(p)) {
        const id = p.split('/').pop();
        if (st.failCustomerDelete) return err(res, 500, 'api_error', 'boom');
        st.customers = st.customers.filter((c) => c.id !== id); (st.deletedCustomers || (st.deletedCustomers = [])).push(id);
        return send(res, 200, { id, object: 'customer', deleted: true });
      }
      if (req.method === 'POST' && p === '/v1/payment_intents') {
        const key = req.headers['idempotency-key'];
        if (key && st.keys.has(key)) {
          const prev = st.keys.get(key);
          if (prev.body !== raw) return err(res, 400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters they were first used with.');
          return send(res, 200, prev.pi);
        }
        if (st.declineNext) { st.declineNext = false; return err(res, 402, 'card_error', 'Your card was declined.'); }
        if (st.hangIntent) { if (st.onIntentCreated) st.onIntentCreated(null); return; }   // never answers (and nothing was charged)
        const pi = { id: 'pi_' + (++st.n), object: 'payment_intent', status: 'succeeded', amount: Number(b.amount), customer: b.customer, created: Math.floor(Date.now() / 1000), metadata: { order_id: b['metadata[order_id]'], auction_id: b['metadata[auction_id]'] } };
        st.intents.push(pi); if (key) st.keys.set(key, { body: raw, pi });
        if (st.onIntentCreated) st.onIntentCreated(pi);   // the charge now exists; a test may crash the app before the reply
        if (st.delayIntentMs) await new Promise((r) => setTimeout(r, st.delayIntentMs));
        return send(res, 200, pi);
      }
      if (req.method === 'GET' && p === '/v1/payment_intents') {
        const cust = url.searchParams.get('customer');
        return send(res, 200, { object: 'list', has_more: false, data: st.intents.filter((i) => !cust || i.customer === cust) });
      }
      if (req.method === 'POST' && p === '/v1/refunds') {
        if (st.failRefund) return err(res, 400, 'invalid_request_error', 'No such payment_intent: pi_secret_account_acct_1ABC');
        const key = req.headers['idempotency-key'];
        if (key && st.keys.has(key)) { const prev = st.keys.get(key); if (prev.body !== raw) return err(res, 400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters they were first used with.'); return send(res, 200, prev.pi); }
        if (st.hangRefund) { if (st.onRefundCreated) st.onRefundCreated(null); return; }   // never answers; nothing was refunded
        const rf = { id: 're_' + (++st.n), object: 'refund', status: 'succeeded', amount: Number(b.amount), payment_intent: b.payment_intent, created: Math.floor(Date.now() / 1000) };
        st.refunds.push(rf); if (key) st.keys.set(key, { body: raw, pi: rf });
        if (st.onRefundCreated) st.onRefundCreated(rf);
        if (st.refundDelayMs) await new Promise((r) => setTimeout(r, st.refundDelayMs));
        return send(res, 200, rf);
      }
      if (req.method === 'GET' && p === '/v1/refunds') {
        const pi = url.searchParams.get('payment_intent');
        return send(res, 200, { object: 'list', has_more: false, data: st.refunds.filter((r) => !pi || r.payment_intent === pi) });
      }
      if (req.method === 'POST' && p === '/v1/checkout/sessions') {
        if (st.failSessions) return err(res, 400, 'invalid_request_error', 'Invalid API Key provided: sk_live_****WXYZ for account acct_1ABC');
        const cs = { id: 'cs_' + (++st.n), object: 'checkout.session', status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/cs_' + st.n, expires_at: Number(b.expires_at) || Math.floor(Date.now() / 1000) + 2100 };
        st.sessions.set(cs.id, cs); return send(res, 200, cs);
      }
      const m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/);
      if (m) {
        const cs = st.sessions.get(m[1]);
        if (!cs) return err(res, 404, 'invalid_request_error', 'No such checkout session');
        if (m[2]) { if (cs.status !== 'open') return err(res, 400, 'invalid_request_error', 'Only Checkout Sessions with a status of `open` can be expired.'); cs.status = 'expired'; return send(res, 200, cs); }
        if (st.sessionDelayMs) await new Promise((r) => setTimeout(r, st.sessionDelayMs));
        return send(res, 200, cs);
      }
      err(res, 404, 'invalid_request_error', 'Unrecognized request URL: ' + req.method + ' ' + p);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, port: server.address().port, close: () => server.close() })));
}

module.exports = { startFakeStripe };

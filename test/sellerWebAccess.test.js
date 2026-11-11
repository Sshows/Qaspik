const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { request } = require('node:http');
const test = require('node:test');
const express = require('express');
const { createSellerRouter } = require('../src/sellerRoutes');
const { createSellerWebAccess } = require('../src/sellerWebAccess');

const host = 'qaspik.example';
const origin = `https://${host}`;
const vercelIp = '203.0.113.10';
const forwardedIp = '198.51.100.10';
const token = 'fake-kaspi-seller-token';
const orderQuery = { token, startDate: '2026-02-10', endDate: '2026-02-11', state: 'NEW' };
const env = {
  VERCEL: '1',
  QASPIK_WEB_ORIGIN: origin,
  QASPIK_LIMITER_SECRET: 'a'.repeat(64),
  SUPABASE_URL: 'https://qaspiktest.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'fake-publishable-key'
};

async function startHostedSellerApi(t, fetchBudget, fetchKaspi) {
  const app = express();
  app.use('/api/seller', createSellerRouter(false, fetchKaspi, createSellerWebAccess(env, fetchBudget)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  // node:http lets the tests set the production Host while connecting to loopback.
  return (path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: `/api/seller${path}`,
      method: body ? 'POST' : 'GET',
      headers: { host, 'content-type': 'application/json', ...headers }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body && JSON.stringify(body));
  });
}

test('enables hosted seller access only for the configured host and requires its exact POST origin', async (t) => {
  const fetchBudget = t.mock.fn();
  const fetchKaspi = t.mock.fn();
  const send = await startHostedSellerApi(t, fetchBudget, fetchKaspi);

  const capability = await send('/capabilities');
  assert.equal(capability.status, 200);
  assert.deepEqual(JSON.parse(capability.text), { enabled: true });

  const otherHost = await send('/capabilities', {
    headers: { host: 'other.example', 'x-forwarded-host': host }
  });
  assert.equal(otherHost.status, 200);
  assert.deepEqual(JSON.parse(otherHost.text), { enabled: false });

  for (const headers of [{}, { origin: `http://${host}` }, { origin: 'https://other.example' }]) {
    const response = await send('/orders', {
      body: orderQuery,
      headers: { 'x-vercel-forwarded-for': vercelIp, ...headers }
    });
    assert.equal(response.status, 403);
  }
  assert.equal(fetchBudget.mock.callCount(), 0);
  assert.equal(fetchKaspi.mock.callCount(), 0);
});

test('requires a single Vercel client IP before contacting the limiter or Kaspi', async (t) => {
  const fetchBudget = t.mock.fn();
  const fetchKaspi = t.mock.fn();
  const send = await startHostedSellerApi(t, fetchBudget, fetchKaspi);

  for (const headers of [{}, { 'x-vercel-forwarded-for': `${vercelIp}, ${forwardedIp}` }]) {
    const response = await send('/orders', {
      body: orderQuery,
      headers: { origin, 'x-forwarded-for': forwardedIp, ...headers }
    });
    assert.equal(response.status, 503);
  }
  assert.equal(fetchBudget.mock.callCount(), 0);
  assert.equal(fetchKaspi.mock.callCount(), 0);
});

test('reserves costs 1 and 21 using only a keyed hash of the Vercel client IP', async (t) => {
  const events = [];
  const fetchBudget = t.mock.fn(async () => {
    events.push('budget');
    return Response.json(true);
  });
  const fetchKaspi = t.mock.fn(async () => {
    events.push('kaspi');
    return Response.json({ data: [] });
  });
  const send = await startHostedSellerApi(t, fetchBudget, fetchKaspi);
  const headers = { origin, 'x-vercel-forwarded-for': vercelIp, 'x-forwarded-for': forwardedIp };

  assert.equal((await send('/orders', { body: orderQuery, headers })).status, 200);
  assert.equal((await send('/order-items', { body: { token, orderId: 'ORDER1' }, headers })).status, 200);
  assert.deepEqual(events, ['budget', 'kaspi', 'budget', 'kaspi']);

  const expectedHash = createHmac('sha256', env.QASPIK_LIMITER_SECRET).update(vercelIp).digest('hex');
  const costs = fetchBudget.mock.calls.map(({ arguments: [url, options] }) => {
    assert.equal(url.href, `${env.SUPABASE_URL}/rest/v1/rpc/qaspik_consume_seller_budget`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    const { p_cost, ...identifiers } = JSON.parse(options.body);
    assert.deepEqual(identifiers, { p_secret: env.QASPIK_LIMITER_SECRET, p_client: expectedHash });
    return p_cost;
  });
  assert.deepEqual(costs, [1, 21]);
});

test('blocks Kaspi when the hosted limiter rejects or cannot verify the reservation', async (t) => {
  const fetchBudget = t.mock.fn(async () => Response.json(false));
  fetchBudget.mock.mockImplementationOnce(async () => new Response(null, { status: 503 }), 1);
  fetchBudget.mock.mockImplementationOnce(async () => Response.json('true'), 2);
  fetchBudget.mock.mockImplementationOnce(async () => { throw new Error('Limiter unavailable'); }, 3);
  const fetchKaspi = t.mock.fn();
  const send = await startHostedSellerApi(t, fetchBudget, fetchKaspi);

  for (const status of [429, 503, 503, 503]) {
    const response = await send('/orders', {
      body: orderQuery,
      headers: { origin, 'x-vercel-forwarded-for': vercelIp }
    });
    assert.equal(response.status, status);
    if (status === 429) assert.equal(response.headers['retry-after'], '60');
  }
  assert.equal(fetchBudget.mock.callCount(), 4);
  assert.equal(fetchKaspi.mock.callCount(), 0);
});

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const express = require('express');
const { createSellerRouter } = require('../src/sellerRoutes');

const token = 'fake-kaspi-seller-token-for-test-only';
const orderId = 'MTAwMDEwMA==';
const orderQuery = {
  token,
  page: 1,
  startDate: '2026-02-10',
  endDate: '2026-02-11',
  state: 'NEW'
};

async function startSellerApi(t, enabled, upstream, reserve = null) {
  const app = express();
  const webAccess = reserve ? { reserve } : null;
  app.use('/api/seller', createSellerRouter(enabled, upstream, webAccess));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const host = `127.0.0.1:${server.address().port}`;
  const origin = `http://${host}`;
  if (webAccess) Object.assign(webAccess, { host, origin });
  const base = `${origin}/api/seller`;
  return {
    origin,
    get: (path) => fetch(base + path),
    post: (path, body, headers = {}) => fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  };
}

test('reads the requested Kaspi order page and omits private buyer data', async (t) => {
  const creationDate = Date.parse('2026-02-10T05:00:00Z');
  const upstream = t.mock.fn(async () => Response.json({
    data: [{
      type: 'orders',
      id: orderId,
      attributes: {
        code: '123456789',
        state: 'NEW',
        status: 'APPROVED_BY_BANK',
        creationDate,
        totalPrice: 21900,
        customer: { firstName: 'PrivateBuyer', cellPhone: '7001234567' },
        deliveryAddress: { formattedAddress: 'PrivateAddress' },
        unexpected: token
      }
    }],
    meta: { pageCount: 3, totalCount: 45 }
  }));
  const api = await startSellerApi(t, true, upstream);

  const capability = await api.get('/capabilities');
  assert.equal(capability.status, 200);
  assert.deepEqual(await capability.json(), { enabled: true });

  const response = await api.post('/orders', orderQuery);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /\bno-store\b/);
  const raw = await response.text();
  for (const privateValue of ['PrivateBuyer', '7001234567', 'PrivateAddress', token]) {
    assert.equal(raw.includes(privateValue), false);
  }
  const result = JSON.parse(raw);
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 3);
  assert.equal(result.totalOrders, 45);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].id, orderId);
  assert.equal(result.orders[0].code, '123456789');

  assert.equal(upstream.mock.callCount(), 1);
  const [requestUrl, options] = upstream.mock.calls[0].arguments;
  const url = new URL(requestUrl);
  assert.equal(url.origin + url.pathname, 'https://kaspi.kz/shop/api/v2/orders');
  assert.equal(url.searchParams.get('page[number]'), '1');
  assert.equal(url.searchParams.get('page[size]'), '20');
  assert.equal(url.searchParams.get('filter[orders][state]'), 'NEW');
  assert.equal(url.searchParams.get('filter[orders][creationDate][$ge]'), String(Date.parse('2026-02-09T19:00:00Z')));
  assert.equal(url.searchParams.get('filter[orders][creationDate][$le]'), String(Date.parse('2026-02-11T18:59:59.999Z')));
  assert.equal(url.searchParams.has('include[orders]'), false);
  assert.equal(url.search.includes(token), false);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  const headers = new Headers(options.headers);
  assert.equal(headers.get('x-auth-token'), token);
  assert.equal(headers.get('content-type'), 'application/vnd.api+json');
});

test('looks up the exact Kaspi order code and returns only the order summary', async (t) => {
  const code = '000123456';
  const creationDate = Date.parse('2026-02-10T05:00:00Z');
  const order = {
    code, state: 'ARCHIVE', status: 'COMPLETED', creationDate, totalPrice: 21900
  };
  const upstream = t.mock.fn(async () => Response.json({
    data: [
      { id: 'OTHERORDER', attributes: { code: '123456' } },
      { id: orderId, attributes: { ...order, customer: { firstName: 'PrivateBuyer' }, unexpected: token } }
    ]
  }));
  const api = await startSellerApi(t, true, upstream);

  const response = await api.post('/order-by-code', { token, code });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /\bno-store\b/);
  assert.deepEqual(await response.json(), { order: { id: orderId, ...order } });

  assert.equal(upstream.mock.callCount(), 1);
  const [url, options] = upstream.mock.calls[0].arguments;
  assert.equal(url.origin + url.pathname, 'https://kaspi.kz/shop/api/v2/orders');
  assert.deepEqual([...url.searchParams], [['filter[orders][code]', code]]);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(new Headers(options.headers).get('x-auth-token'), token);
});

test('distinguishes a missing order from an upstream auth failure', async (t) => {
  const upstream = t.mock.fn(async () => Response.json({ data: [] }));
  upstream.mock.mockImplementationOnce(async () => Response.json({
    data: [{ id: orderId, attributes: { code: '0001234560' } }]
  }), 1);
  upstream.mock.mockImplementationOnce(async () => new Response(`Private diagnostics ${token}`, { status: 401 }), 2);
  const api = await startSellerApi(t, true, upstream);
  const body = { token, code: '000123456' };

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await api.post('/order-by-code', body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { order: null });
  }
  const rejected = await api.post('/order-by-code', body);
  assert.equal(rejected.status, 401);
  assert.match((await rejected.json()).error, /^Kaspi отклонил API-ключ\./);
});

test('validates lookup input and reserves one hosted request before contacting Kaspi', async (t) => {
  const events = [];
  const reserve = t.mock.fn(async () => {
    events.push('reserve');
    return events.length === 1;
  });
  const upstream = t.mock.fn(async () => {
    events.push('kaspi');
    return Response.json({ data: [] });
  });
  const api = await startSellerApi(t, false, upstream, reserve);
  const body = { token, code: '000123456' };
  const ip = '203.0.113.10';
  const headers = { origin: api.origin, 'x-vercel-forwarded-for': ip };

  for (const invalidBody of [
    { ...body, token: '' }, { token }, { token, code: 123456 },
    { token, code: 'x'.repeat(65) }, { token, code: '123&456' }
  ]) {
    assert.equal((await api.post('/order-by-code', invalidBody, headers)).status, 400);
  }
  assert.equal((await api.post('/order-by-code', body)).status, 403);
  assert.equal((await api.post('/order-by-code', body, { origin: 'https://foreign.example' })).status, 403);
  assert.deepEqual(events, []);

  assert.equal((await api.post('/order-by-code', body, headers)).status, 200);
  assert.equal((await api.post('/order-by-code', body, headers)).status, 429);
  assert.deepEqual(events, ['reserve', 'kaspi', 'reserve']);
  assert.deepEqual(reserve.mock.calls.map(({ arguments: args }) => args), [[ip, 1], [ip, 1]]);
});

test('loads order entries from a fixed Kaspi endpoint and paginates them locally', async (t) => {
  const data = Array.from({ length: 21 }, (_, index) => ({
    type: 'orderentries',
    id: `ENTRY${index}`,
    attributes: {
      entryNumber: index + 1,
      quantity: 2,
      basePrice: 1500,
      totalPrice: 3000,
      unexpected: 'PrivateEntryValue'
    },
    relationships: {
      product: {
        data: { type: 'masterproducts', id: 'PRODUCT123' },
        links: { related: 'https://foreign.example/related-product' }
      }
    }
  }));
  const upstream = t.mock.fn(async () => Response.json({ data }));
  upstream.mock.mockImplementationOnce(async () => Response.json({
    data: {
      type: 'masterproducts',
      id: 'PRODUCT123',
      attributes: { code: '900123', name: 'Test product', unexpected: 'PrivateProductValue' }
    }
  }), 1);
  const api = await startSellerApi(t, true, upstream);

  const response = await api.post('/order-items', { token, orderId, page: 1 });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes('PrivateEntryValue'), false);
  assert.equal(raw.includes('PrivateProductValue'), false);
  const result = JSON.parse(raw);
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 2);
  assert.equal(result.totalItems, 21);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].totalPrice, 3000);
  assert.equal(result.items[0].name, 'Test product');
  assert.equal(result.items[0].code, '900123');

  assert.equal(upstream.mock.callCount(), 2);
  const endpoints = upstream.mock.calls.map(({ arguments: [requestUrl, options] }) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('x-auth-token'), token);
    const url = new URL(requestUrl);
    return url.origin + decodeURIComponent(url.pathname) + url.search;
  });
  assert.deepEqual(endpoints, [
    `https://kaspi.kz/shop/api/v2/orders/${orderId}/entries`,
    'https://kaspi.kz/shop/api/v2/orderentries/ENTRY20/product'
  ]);
});

test('rejects invalid requests and cross-origin posts before contacting Kaspi', async (t) => {
  const upstream = t.mock.fn(() => assert.fail('Unexpected call to Kaspi'));
  const api = await startSellerApi(t, true, upstream);

  for (const payload of [
    { ...orderQuery, token: '' },
    { ...orderQuery, page: -1 },
    { ...orderQuery, state: 'INVALID' },
    { ...orderQuery, startDate: '2026-02-30', endDate: '2026-03-01' },
    { ...orderQuery, startDate: '2026-02-12' },
    { ...orderQuery, endDate: '2026-02-24' }
  ]) {
    const response = await api.post('/orders', payload);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }

  let response = await api.post('/order-items', { token, orderId: '../accounts', page: 0 });
  assert.equal(response.status, 400);
  await response.json();

  response = await api.post('/orders', orderQuery, { origin: 'https://foreign.example' });
  assert.equal(response.status, 403);
  await response.json();
  assert.equal(upstream.mock.callCount(), 0);
});

test('reports disabled seller access without contacting Kaspi', async (t) => {
  const upstream = t.mock.fn(() => assert.fail('Unexpected call to Kaspi'));
  const api = await startSellerApi(t, false, upstream);

  const capability = await api.get('/capabilities');
  assert.equal(capability.status, 200);
  assert.deepEqual(await capability.json(), { enabled: false });

  const response = await api.post('/orders', orderQuery);
  assert.equal(response.status, 503);
  assert.equal(typeof (await response.json()).error, 'string');
  assert.equal(upstream.mock.callCount(), 0);
});

test('passes on authentication and throttling statuses with sanitized messages', async (t) => {
  const upstream = t.mock.fn(async () => new Response(`upstream diagnostics ${token}`, { status: 401 }));
  upstream.mock.mockImplementationOnce(async () => new Response(`upstream diagnostics ${token}`, {
    status: 429,
    headers: { 'Retry-After': '25' }
  }), 1);
  const api = await startSellerApi(t, true, upstream);

  for (const status of [401, 429]) {
    const response = await api.post('/orders', orderQuery);
    assert.equal(response.status, status);
    if (status === 429) assert.equal(response.headers.get('retry-after'), '25');
    const raw = await response.text();
    assert.equal(raw.includes(token), false);
    assert.equal(raw.includes('upstream diagnostics'), false);
    assert.equal(typeof JSON.parse(raw).error, 'string');
  }
});

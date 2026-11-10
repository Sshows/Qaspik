const assert = require('node:assert/strict');
const { test } = require('node:test');
const axios = require('axios');
const { createDemoMerchant, getDb } = require('../src/db');
const {
  runRepricerCycle,
  syncMerchantWithKaspi,
  triggerCompetitorPriceChange,
  updateRepricerDefaults,
  updateProductLimits
} = require('../src/kaspiService');

test('manual demo repricing stays within limits without network or live merchant mutations', (t) => {
  const post = t.mock.method(axios, 'post', () => assert.fail('Demo made a network call'));
  const merchant = createDemoMerchant();
  const product = merchant.products.find((item) => item.botEnabled && item.status === 'Published');
  const activePrice = product.minPrice + 100;
  product.price = activePrice;
  product.competitors = [{ name: 'Демо-конкурент', price: activePrice }];
  const otherPrices = merchant.products.filter((item) => item !== product).map((item) => item.price);

  const underThreshold = triggerCompetitorPriceChange(merchant.id, product.id, product.minPrice - 1, 10);
  assert.equal(underThreshold.ok, true);
  assert.deepEqual(underThreshold.events, []);
  assert.equal(product.price, activePrice);
  assert.equal(product.dampingStatus, 'MIN_PRICE_REACHED');

  const atThreshold = triggerCompetitorPriceChange(merchant.id, product.id, product.minPrice + 5, 10);
  assert.equal(atThreshold.events[0].demo, true);
  assert.equal(atThreshold.events[0].step, 1);
  assert.equal(product.price, product.minPrice + 4);
  assert.deepEqual(merchant.products.filter((item) => item !== product).map((item) => item.price), otherPrices);
  assert.equal(getDb().logs[0].type, 'DEMO_PRICE_CHANGE');

  const oldStep = product.step;
  const invalid = updateProductLimits(merchant.id, product.id, { step: 42, minPrice: product.maxPrice + 1 });
  assert.equal(invalid.ok, false);
  assert.equal(product.step, oldStep);

  merchant.demo = false;
  assert.deepEqual(runRepricerCycle(merchant.id), []);
  assert.equal(updateRepricerDefaults(merchant.id, merchant.repricerDefaults).ok, false);
  assert.equal(updateProductLimits(merchant.id, product.id, { price: 100 }).ok, false);
  assert.equal(triggerCompetitorPriceChange(merchant.id, product.id, 100).ok, false);
  assert.equal(product.price, product.minPrice + 4);
  assert.equal(post.mock.callCount(), 0);
});

test('repricer defaults reject invalid payloads without changing settings', () => {
  const merchant = createDemoMerchant();
  const defaults = { standardStep: 10, nearFloorWindow: 200, atFloor: 'hold', autoRaise: true };
  assert.deepEqual(merchant.repricerDefaults, defaults);

  for (const invalid of [
    null,
    { standardStep: 100 },
    { ...defaults, unexpected: false },
    { ...defaults, standardStep: 0 },
    { ...defaults, standardStep: '10' },
    { ...defaults, nearFloorWindow: -1 },
    { ...defaults, nearFloorWindow: 1.5 },
    { ...defaults, atFloor: 'other' },
    { ...defaults, autoRaise: 1 }
  ]) {
    assert.equal(updateRepricerDefaults(merchant.id, invalid).ok, false);
    assert.deepEqual(merchant.repricerDefaults, defaults);
  }
});

test('seeded products inherit store defaults and can override or reset either field', () => {
  const merchant = createDemoMerchant();
  const product = merchant.products[0];
  const floor = product.minPrice;
  assert.equal(product.step, undefined);
  assert.equal(product.nearFloorWindow, undefined);

  const defaults = { standardStep: 40, nearFloorWindow: 100, atFloor: 'hold', autoRaise: false };
  assert.deepEqual(updateRepricerDefaults(merchant.id, defaults), { ok: true, defaults });
  product.price = floor + 600;
  product.competitors = [{ name: 'Конкурент', price: floor + 600 }];
  assert.equal(runRepricerCycle(merchant.id, product.id)[0].step, 40);
  assert.equal(product.price, floor + 560);

  const override = updateProductLimits(merchant.id, product.id, {
    step: 25,
    nearFloorWindow: 0
  });
  assert.equal(override.ok, true);
  const invalid = updateProductLimits(merchant.id, product.id, { step: null, nearFloorWindow: -1 });
  assert.equal(invalid.ok, false);
  assert.equal(product.step, 25);

  const next = triggerCompetitorPriceChange(merchant.id, product.id, floor + 60);
  assert.equal(next.events[0].step, 25);
  assert.equal(product.price, floor + 35);

  const inherited = updateProductLimits(merchant.id, product.id, {
    price: floor + 600,
    step: null,
    nearFloorWindow: null
  });
  assert.equal(inherited.ok, true);
  assert.equal(inherited.product.step, null);
  assert.equal(inherited.product.nearFloorWindow, null);
  assert.equal(inherited.events[0].step, 1);
  assert.equal(product.price, floor + 59);
});

test('floor rules use the cheapest offer and the auto-raise switch controls increases', () => {
  const merchant = createDemoMerchant();
  const product = merchant.products[0];
  const floor = product.minPrice;
  product.price = floor + 300;
  product.competitors = [
    { name: 'Дешёвый конкурент', price: floor },
    { name: 'Другой конкурент', price: floor + 100 }
  ];
  assert.deepEqual(runRepricerCycle(merchant.id, product.id), []);
  assert.equal(product.price, floor + 300);
  assert.equal(product.dampingStatus, 'MIN_PRICE_REACHED');

  const defaults = { ...merchant.repricerDefaults, atFloor: 'minimum', autoRaise: false };
  assert.equal(updateRepricerDefaults(merchant.id, defaults).ok, true);
  assert.equal(runRepricerCycle(merchant.id, product.id)[0].newPrice, floor);
  assert.deepEqual(runRepricerCycle(merchant.id, product.id), []);

  product.price = floor + 250;
  assert.equal(triggerCompetitorPriceChange(merchant.id, product.id, floor - 1).events[0].newPrice, floor);
  product.competitors = [{ name: 'Другой конкурент', price: floor + 500 }];
  assert.deepEqual(runRepricerCycle(merchant.id, product.id), []);
  assert.equal(product.price, floor);

  assert.equal(updateRepricerDefaults(merchant.id, { ...defaults, autoRaise: true }).ok, true);
  assert.equal(runRepricerCycle(merchant.id, product.id)[0].newPrice, floor + 490);
  product.competitors = [];
  assert.deepEqual(runRepricerCycle(merchant.id, product.id), []);
});

test('optional catalog diagnostic classifies errors and stops without changing prices', async (t) => {
  const merchant = createDemoMerchant();
  const flag = 'QASPIK_KASPI_CATALOG_READ';
  const beforeFlag = process.env[flag];
  const beforeVercel = process.env.VERCEL;
  t.after(() => {
    if (beforeFlag === undefined) delete process.env[flag];
    else process.env[flag] = beforeFlag;
    if (beforeVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = beforeVercel;
  });

  let outcome;
  const post = t.mock.method(axios, 'post', (_url, _body, options) => {
    assert.equal(options.maxRedirects, 0);
    assert.deepEqual(options.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const prices = merchant.products.map((product) => product.price);

  delete process.env[flag];
  assert.equal((await syncMerchantWithKaspi(merchant.id)).code, 'KASPI_CATALOG_DISABLED');
  process.env[flag] = '1';
  process.env.VERCEL = '1';
  assert.equal((await syncMerchantWithKaspi(merchant.id)).code, 'KASPI_CATALOG_DISABLED');
  assert.equal(post.mock.callCount(), 0);
  delete process.env.VERCEL;

  for (const [response, code] of [
    [{ status: 401 }, 'KASPI_CATALOG_ACCESS_BLOCKED'],
    [{ status: 403 }, 'KASPI_CATALOG_ACCESS_BLOCKED'],
    [{ status: 302 }, 'KASPI_CATALOG_ACCESS_BLOCKED'],
    [{ status: 200, data: '<html>challenge</html>' }, 'KASPI_CATALOG_CHALLENGE'],
    [{ status: 200, data: 'invalid JSON' }, 'KASPI_CATALOG_INVALID_RESPONSE'],
    [{ status: 200, data: { offers: [{}] } }, 'KASPI_CATALOG_INVALID_RESPONSE'],
    [Object.assign(new Error(), { code: 'ECONNABORTED' }), 'KASPI_CATALOG_TIMEOUT'],
    [{ status: 503 }, 'KASPI_CATALOG_HTTP_ERROR']
  ]) {
    outcome = response;
    const callsBefore = post.mock.callCount();
    assert.equal((await syncMerchantWithKaspi(merchant.id)).code, code);
    assert.equal(post.mock.callCount(), callsBefore + 1);
  }

  outcome = { status: 200, data: { offers: [] } };
  assert.deepEqual(await syncMerchantWithKaspi(merchant.id), { ok: true, checkedCount: merchant.products.length });

  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const delay of [12, 30]) {
    const retryAfter = delay === 12 ? '12' : new Date(Math.floor(now / 1000) * 1000 + delay * 1000).toUTCString();
    outcome = { status: 429, headers: { 'retry-after': retryAfter } };
    const callsBefore = post.mock.callCount();
    const limited = await syncMerchantWithKaspi(merchant.id);
    assert.equal(limited.code, 'KASPI_CATALOG_RATE_LIMITED');
    assert.equal(limited.retryAfterSeconds, delay);
    assert.deepEqual(await syncMerchantWithKaspi(merchant.id), limited);
    assert.equal(post.mock.callCount(), callsBefore + 1);
    now += limited.retryAfterSeconds * 1000;
  }

  assert.deepEqual(merchant.products.map((product) => product.price), prices);
});

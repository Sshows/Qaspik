const assert = require('node:assert/strict');
const { test } = require('node:test');
const axios = require('axios');
const { createDemoMerchant, getDb } = require('../src/db');
const {
  runRepricerCycle,
  syncMerchantWithKaspi,
  triggerCompetitorPriceChange,
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
  assert.equal(updateProductLimits(merchant.id, product.id, { price: 100 }).ok, false);
  assert.equal(triggerCompetitorPriceChange(merchant.id, product.id, 100).ok, false);
  assert.equal(product.price, product.minPrice + 4);
  assert.equal(post.mock.callCount(), 0);
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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { planPilotPrices } = require('../src/kaspiPilot');
const { applyFeedPrices } = require('../src/priceFeed');

const catalog = fs.readFileSync(path.join(__dirname, '../examples/pilot/catalog.xml'), 'utf8');
const now = Date.parse('2026-11-10T12:00:00Z');
const observationTime = new Date(now).toISOString();
const city = { sku: 'DEMO100', cityId: '750000000' };
const general = { sku: 'DEMO200' };
const merchantId = '123456';

function configWith(defaults) {
  return {
    merchantId,
    subscription: { enabled: true, expiresAt: '2099-01-01T00:00:00Z' },
    maxObservationAgeSeconds: 900,
    defaults,
    products: [{ ...city, minPrice: 24_000 }, { ...general, minPrice: 12_000 }]
  };
}

function observations(cityPrice, generalPrice, observedAt = observationTime) {
  const offers = [];
  if (cityPrice !== undefined) offers.push({ ...city, competitorPrice: cityPrice, observedAt });
  if (generalPrice !== undefined) offers.push({ ...general, competitorPrice: generalPrice, observedAt });
  return { merchantId, offers };
}

test('store-wide price step and near-floor window are inherited unless the SKU overrides them', () => {
  const config = configWith({ standardStep: 110, nearFloorWindow: 200 });
  config.products[0].standardStep = 250;
  const input = observations(25_500, 12_200);
  const planned = planPilotPrices(catalog, config, input, now);
  assert.deepEqual(planned.changes, [{ ...city, price: 25_250 }, { ...general, cityId: undefined, price: 12_199 }]);
  assert.deepEqual(planned.decisions.map(({ step }) => step), [250, 1]);

  config.products[1].nearFloorWindow = 0;
  assert.equal(planPilotPrices(catalog, config, input, now).changes[1].price, 12_090);
});

test('the minimum strategy lowers to the floor once and a SKU may override it with hold', () => {
  const config = configWith({ standardStep: 110, nearFloorWindow: 200, atFloor: 'minimum' });
  config.products[1].atFloor = 'hold';
  const input = observations(24_000, 11_999);
  const planned = planPilotPrices(catalog, config, input, now);
  assert.deepEqual(planned.changes, [{ ...city, price: 24_000 }]);
  assert.deepEqual(planned.decisions.map(({ code }) => code), ['FLOOR_MINIMUM', 'FLOOR_GUARD']);

  const atFloor = applyFeedPrices(catalog, { merchantId: config.merchantId, changes: planned.changes });
  assert.deepEqual(planPilotPrices(atFloor, config, input, now).changes, []);
  const belowFloor = applyFeedPrices(catalog, { merchantId: config.merchantId, changes: [{ ...city, price: 23_999 }] });
  assert.deepEqual(planPilotPrices(belowFloor, config, input, now).changes, []);
});

test('auto-raise uses fresh competitor prices, SKU overrides, undercut steps and explicit ceilings', () => {
  const config = configWith({ standardStep: 110, nearFloorWindow: 200, autoRaise: true });
  config.products[0].maxPrice = 26_700;
  config.products[1].autoRaise = false;
  const planned = planPilotPrices(catalog, config, observations(27_100, 13_500), now);
  assert.deepEqual(planned.changes, [{ ...city, price: 26_700 }]);
  assert.deepEqual(planned.decisions.map(({ code }) => code), ['AUTO_RAISE', 'ALREADY_BELOW_COMPETITOR']);

  config.defaults.autoRaise = false;
  config.products[1].autoRaise = true;
  config.products[1].maxPrice = 14_000;
  const belowCompetitor = planPilotPrices(catalog, config, observations(27_100, 13_500), now);
  assert.deepEqual(belowCompetitor.changes, [{ ...general, cityId: undefined, price: 13_390 }]);
  assert.equal(belowCompetitor.decisions[1].step, 110);
  const noSpread = planPilotPrices(catalog, config, observations(undefined, 12_800), now);
  assert.deepEqual(noSpread.changes, []);
  assert.equal(noSpread.decisions[1].code, 'NO_ROOM_TO_RAISE');
  config.products[1].maxPrice = 12_600;
  assert.deepEqual(planPilotPrices(catalog, config, observations(undefined, 13_500), now).changes, []);
});

test('auto-raise and floor policies leave the feed alone without fresh observations', () => {
  const config = configWith({ standardStep: 110, nearFloorWindow: 200, atFloor: 'minimum', autoRaise: true });
  for (const rule of config.products) rule.maxPrice = 30_000;
  for (const [observedAt, expectedCode] of [
    [new Date(now - 901_000).toISOString(), 'OBSERVATION_OUT_OF_DATE'],
    [new Date(now + 1_000).toISOString(), 'OBSERVATION_OUT_OF_DATE']
  ]) {
    const planned = planPilotPrices(catalog, config, observations(27_100, 11_999, observedAt), now);
    assert.deepEqual(planned.changes, []);
    assert.deepEqual(planned.decisions.map(({ code }) => code), [expectedCode, expectedCode]);
  }
  const missing = planPilotPrices(catalog, config, observations(undefined, undefined), now);
  assert.deepEqual(missing.changes, []);
  assert.deepEqual(missing.decisions.map(({ code }) => code), ['NO_OBSERVATION', 'NO_OBSERVATION']);
});

test('rejects invalid store settings and requires maxPrice for every SKU that enables auto-raise', () => {
  for (const defaults of [null, [], { standardStep: 0 }, { nearFloorWindow: -1 }, { atFloor: 'other' }, { autoRaise: 'true' }]) {
    const config = configWith(defaults);
    assert.throws(() => planPilotPrices(catalog, config, observations(27_100, 13_500), now), /defaults/);
  }
  const config = configWith({ standardStep: 110, nearFloorWindow: 200, autoRaise: true });
  assert.throws(() => planPilotPrices(catalog, config, observations(27_100, 13_500), now), /maxPrice/);
  config.defaults.autoRaise = false;
  config.products[1].autoRaise = true;
  assert.throws(() => planPilotPrices(catalog, config, observations(27_100, 13_500), now), /maxPrice/);
});

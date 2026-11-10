const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { planPilotPrices } = require('../src/kaspiPilot');

const catalog = fs.readFileSync(path.join(__dirname, '../examples/pilot/catalog.xml'), 'utf8');
const now = Date.parse('2026-11-10T12:00:00Z');
const merchantId = '123456';
const product = { sku: 'DEMO100', cityId: '750000000' };
const filters = {
  excludedMerchantIds: ['200001'],
  minRating: 4.5,
  minReviews: 10,
  maxPreorderDays: 2,
  deliveryCategories: ['express', 'standard']
};

function config(defaults = {}) {
  return {
    merchantId,
    subscription: { enabled: true, expiresAt: '2099-01-01T00:00:00Z' },
    maxObservationAgeSeconds: 900,
    defaults: { standardStep: 110, nearFloorWindow: 200, ...defaults },
    products: [{ ...product, minPrice: 24_000, maxPrice: 27_000 }]
  };
}

function observations(offer, observedAt = new Date(now).toISOString()) {
  return { merchantId, offers: [{ ...product, observedAt, ...offer }] };
}

function candidate(merchantId, price, updates = {}) {
  return { merchantId, price, rating: 4.5, reviewCount: 10, preorderDays: 2, deliveryCategory: 'express', ...updates };
}

test('selects the cheapest eligible competitor after excluding the shop and applying all configured filters', () => {
  const competitors = [
    candidate(merchantId, 23_000),
    candidate('200001', 24_000),
    candidate('200002', 24_500, { rating: 4.4 }),
    candidate('200003', 24_600, { reviewCount: 9 }),
    candidate('200004', 24_700, { preorderDays: 3 }),
    candidate('200005', 24_800, { deliveryCategory: 'pickup' }),
    candidate('200006', 24_900, { deliveryCategory: undefined }),
    candidate('200007', 25_600, { deliveryCategory: 'standard' }),
    candidate('200008', 25_500)
  ];
  const planned = planPilotPrices(catalog, config({ filters }), observations({ competitors }), now);

  assert.deepEqual(planned.changes, [{ ...product, price: 25_390 }]);
  assert.equal(planned.decisions[0].competitorPrice, 25_500);
});

test('legacy aggregate observations work with inactive filters and cannot bypass active filters', () => {
  const market = observations({ competitorPrice: 25_500 });
  const inactive = planPilotPrices(catalog, config({ filters: { excludedMerchantIds: [], deliveryCategories: [] } }), market, now);
  assert.deepEqual(inactive.changes, [{ ...product, price: 25_390 }]);

  const active = planPilotPrices(catalog, config({ filters }), market, now);
  assert.deepEqual(active.changes, []);
  assert.equal(active.decisions[0].code, 'COMPETITOR_DETAILS_REQUIRED');
});

test('skips detailed observations when no competitor can be used', () => {
  for (const competitors of [[], [candidate(merchantId, 25_500), { merchantId: '200002', price: 25_600 }]]) {
    const planned = planPilotPrices(catalog, config({ filters, autoRaise: true }), observations({ competitors }), now);
    assert.deepEqual(planned.changes, []);
    assert.equal(planned.decisions[0].code, 'NO_ELIGIBLE_COMPETITORS');
  }

  const onlyOwnOffer = observations({ competitors: [{ merchantId, price: 25_500 }] });
  const planned = planPilotPrices(catalog, config(), onlyOwnOffer, now);
  assert.deepEqual(planned.changes, []);
  assert.equal(planned.decisions[0].code, 'NO_ELIGIBLE_COMPETITORS');
});

test('applies the price rules only to the cheapest fresh eligible observation', () => {
  const priceConfig = config({ filters, atFloor: 'minimum', autoRaise: true });
  const competitors = [candidate('200001', 20_000), candidate('200002', 27_100)];
  const stale = observations({ competitors }, new Date(now - 901_000).toISOString());
  const planned = planPilotPrices(catalog, priceConfig, stale, now);
  assert.deepEqual(planned.changes, []);
  assert.equal(planned.decisions[0].code, 'OBSERVATION_OUT_OF_DATE');

  const fresh = planPilotPrices(catalog, priceConfig, observations({ competitors }), now);
  assert.deepEqual(fresh.changes, [{ ...product, price: 26_990 }]);
  assert.equal(fresh.decisions[0].code, 'AUTO_RAISE');

  competitors.push(candidate('200003', 24_000));
  const atFloor = planPilotPrices(catalog, priceConfig, observations({ competitors }), now);
  assert.deepEqual(atFloor.changes, [{ ...product, price: 24_000 }]);
  assert.equal(atFloor.decisions[0].code, 'FLOOR_MINIMUM');
});

test('rejects malformed filters and observations', () => {
  for (const badFilters of [null, [], { minRating: 5.1 }, { minReviews: 2.5 }, { maxPreorderDays: -1 },
    { deliveryCategories: [' '] }, { excludedMerchantIds: [1] }, { minReview: 10 }]) {
    assert.throws(() => planPilotPrices(catalog, config({ filters: badFilters }), observations({ competitors: [] }), now), /defaults\.filters/);
  }

  for (const invalidOffer of [
    { competitorPrice: 25_000, competitors: [] },
    { competitors: {} },
    { competitors: [candidate('200002', 0)] },
    { competitors: [candidate(200002, 25_000)] },
    { competitors: [candidate('200002', 25_000, { rating: null })] }
  ]) {
    assert.throws(() => planPilotPrices(catalog, config(), observations(invalidOffer), now), /competitors/);
  }
});

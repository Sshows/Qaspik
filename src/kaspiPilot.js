const { readFeed } = require('./priceFeed');
const { getUndercutStep } = require('./pricePolicy');

const PILOT_MONTHLY_FEE_KZT = 10_000;
const MAX_OBSERVATION_AGE_SECONDS = 3600;

function utcMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error('Дата должна быть в формате UTC ISO 8601');
  }
  const milliseconds = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw new Error('Некорректная дата UTC');
  }
  return milliseconds;
}

function checkPilotAccess(config, nowMs) {
  if (typeof config?.subscription?.enabled !== 'boolean' || !Number.isFinite(nowMs)) {
    throw new Error('В pilot.json укажите subscription.enabled и subscription.expiresAt');
  }
  if (!config.subscription.enabled) return { active: false, code: 'DISABLED' };
  if (nowMs >= utcMillis(config.subscription.expiresAt)) return { active: false, code: 'EXPIRED' };
  return { active: true, code: 'ACTIVE' };
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function offerKey(sku, cityId) {
  if (typeof sku !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(sku)) {
    throw new Error('Укажите корректный артикул продавца');
  }
  if (cityId !== undefined && (typeof cityId !== 'string' || !/^[0-9]{9}$/.test(cityId))) {
    throw new Error('Код города должен содержать 9 цифр');
  }
  return [sku, cityId || ''].join('/');
}

function planPilotPrices(xml, config, observations, nowMs) {
  const access = checkPilotAccess(config, nowMs);
  if (!access.active) return { changes: [], decisions: [] };

  const { merchantId, maxObservationAgeSeconds, products } = config;
  if (typeof merchantId !== 'string' || !/^[0-9]+$/.test(merchantId)) {
    throw new Error('Укажите merchantId из полного прайс-листа');
  }
  if (!isPositiveInteger(maxObservationAgeSeconds) || maxObservationAgeSeconds > MAX_OBSERVATION_AGE_SECONDS) {
    throw new Error('maxObservationAgeSeconds должен быть от 1 до 3600');
  }
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('В pilot.json укажите хотя бы один товар');
  }
  if (observations?.merchantId !== merchantId || !Array.isArray(observations.offers)) {
    throw new Error('observations.json должен содержать merchantId пилота и массив offers');
  }

  const { offers } = readFeed(xml, { merchantId });
  const feedPrices = new Map();
  for (const offer of offers) {
    if (Array.isArray(offer.cityPrices)) {
      for (const cityPrice of offer.cityPrices) {
        feedPrices.set(offerKey(offer.sku, cityPrice.cityId), cityPrice.price);
      }
    } else {
      feedPrices.set(offerKey(offer.sku), offer.price);
    }
  }

  const market = new Map();
  for (const offer of observations.offers) {
    const key = offerKey(offer?.sku, offer?.cityId);
    if (market.has(key) || !isPositiveInteger(offer.competitorPrice)) {
      throw new Error('Укажите одну целую положительную цену конкурента для каждого артикула и города');
    }
    market.set(key, { price: offer.competitorPrice, timestamp: utcMillis(offer.observedAt) });
  }

  const tracked = new Set();
  const changes = [];
  const decisions = [];
  for (const rule of products) {
    const key = offerKey(rule?.sku, rule?.cityId);
    const { sku, cityId, minPrice, maxPrice, standardStep, nearFloorWindow } = rule;
    if (
      tracked.has(key) || !feedPrices.has(key) || ![minPrice, standardStep].every(isPositiveInteger) ||
      (maxPrice !== undefined && (!isPositiveInteger(maxPrice) || maxPrice < minPrice)) ||
      !Number.isSafeInteger(nearFloorWindow) || nearFloorWindow < 0
    ) {
      throw new Error('Неверная или повторная настройка для артикула и города ' + key);
    }
    tracked.add(key);
    const current = feedPrices.get(key);
    const observed = market.get(key);
    const decision = { sku, cityId, current, minPrice };

    if (!observed) {
      decision.code = 'NO_OBSERVATION';
    } else if (observed.timestamp > nowMs || nowMs - observed.timestamp > maxObservationAgeSeconds * 1000) {
      decision.code = 'OBSERVATION_OUT_OF_DATE';
    } else if (observed.price <= minPrice || current < minPrice) {
      decision.code = 'FLOOR_GUARD';
    } else if (current < observed.price) {
      decision.code = 'ALREADY_BELOW_COMPETITOR';
    } else {
      const step = getUndercutStep(observed.price, minPrice, standardStep, nearFloorWindow);
      const price = Math.min(maxPrice ?? current, observed.price - step);
      decision.code = 'PROPOSED';
      decision.competitorPrice = observed.price;
      decision.step = step;
      decision.price = price;
      changes.push({ sku, cityId, price });
    }
    decisions.push(decision);
  }
  return { changes, decisions };
}

module.exports = { checkPilotAccess, planPilotPrices, PILOT_MONTHLY_FEE_KZT };

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

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFloorStrategy(value) {
  return value === 'hold' || value === 'minimum';
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

  const { merchantId, maxObservationAgeSeconds, products, defaults = {} } = config;
  if (typeof merchantId !== 'string' || !/^[0-9]+$/.test(merchantId)) {
    throw new Error('Укажите merchantId из полного прайс-листа');
  }
  if (!isPositiveInteger(maxObservationAgeSeconds) || maxObservationAgeSeconds > MAX_OBSERVATION_AGE_SECONDS) {
    throw new Error('maxObservationAgeSeconds должен быть от 1 до 3600');
  }
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('В pilot.json укажите хотя бы один товар');
  }
  if (
    !defaults || typeof defaults !== 'object' || Array.isArray(defaults) ||
    (defaults.standardStep !== undefined && !isPositiveInteger(defaults.standardStep)) ||
    (defaults.nearFloorWindow !== undefined && !isNonNegativeInteger(defaults.nearFloorWindow)) ||
    (defaults.atFloor !== undefined && !isFloorStrategy(defaults.atFloor)) ||
    (defaults.autoRaise !== undefined && typeof defaults.autoRaise !== 'boolean')
  ) {
    throw new Error('Проверьте настройки defaults в pilot.json');
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
    const {
      sku, cityId, minPrice, maxPrice,
      standardStep = defaults.standardStep,
      nearFloorWindow = defaults.nearFloorWindow,
      atFloor = defaults.atFloor ?? 'hold',
      autoRaise = defaults.autoRaise ?? false
    } = rule;
    if (
      tracked.has(key) || !feedPrices.has(key) || ![minPrice, standardStep].every(isPositiveInteger) ||
      (maxPrice !== undefined && (!isPositiveInteger(maxPrice) || maxPrice < minPrice)) ||
      !isNonNegativeInteger(nearFloorWindow) || !isFloorStrategy(atFloor) || typeof autoRaise !== 'boolean'
    ) {
      throw new Error('Неверная или повторная настройка для артикула и города ' + key);
    }
    if (autoRaise && maxPrice === undefined) {
      throw new Error('Для автоподъёма укажите maxPrice для артикула и города ' + key);
    }
    tracked.add(key);
    const current = feedPrices.get(key);
    const observed = market.get(key);
    const decision = { sku, cityId, current, minPrice };
    const alreadyBelowCompetitor = observed && current < observed.price;

    if (!observed) {
      decision.code = 'NO_OBSERVATION';
    } else if (observed.timestamp > nowMs || nowMs - observed.timestamp > maxObservationAgeSeconds * 1000) {
      decision.code = 'OBSERVATION_OUT_OF_DATE';
    } else if (observed.price <= minPrice || current < minPrice) {
      decision.code = 'FLOOR_GUARD';
      if (atFloor === 'minimum' && current > minPrice) {
        decision.code = 'FLOOR_MINIMUM';
        decision.competitorPrice = observed.price;
        decision.price = minPrice;
      }
    } else if (alreadyBelowCompetitor && !autoRaise) {
      decision.code = 'ALREADY_BELOW_COMPETITOR';
    } else {
      const step = getUndercutStep(observed.price, minPrice, standardStep, nearFloorWindow);
      const price = Math.min(maxPrice ?? current, observed.price - step);
      if (alreadyBelowCompetitor && price <= current) {
        decision.code = 'NO_ROOM_TO_RAISE';
      } else {
        decision.code = alreadyBelowCompetitor ? 'AUTO_RAISE' : 'PROPOSED';
        decision.competitorPrice = observed.price;
        decision.step = step;
        decision.price = price;
      }
    }
    if (decision.price !== undefined) changes.push({ sku, cityId, price: decision.price });
    decisions.push(decision);
  }
  return { changes, decisions };
}

module.exports = { checkPilotAccess, planPilotPrices, PILOT_MONTHLY_FEE_KZT };

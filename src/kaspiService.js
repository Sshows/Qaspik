const axios = require('axios');
const { getUndercutStep } = require('./pricePolicy');
const { DEFAULT_REPRICER_SETTINGS, getDb, buildStandingsForProduct, addLog } = require('./db');

let catalogRetryAt = 0;
let catalogCheckInProgress = false;

function demoMerchantOnly(merchantId) {
  const merchant = getDb().merchants[merchantId];
  return merchant?.demo === true ? merchant : null;
}

function refreshProductStandings(merchant, product) {
  const minPrice = Number(product.minPrice);
  const competitors = (product.competitors || []).filter((offer) => {
    const price = Number(offer.price);
    return Number.isSafeInteger(price) && price > 0;
  });
  const standings = buildStandingsForProduct(merchant.name, product.price, competitors).map((entry) => ({
    ...entry,
    isFraudTrap: !entry.isYou && (
      entry.price < minPrice ||
      competitors.some((offer) =>
        offer.noStockFraud && offer.name === entry.merchantName && Number(offer.price) === entry.price
      )
    )
  }));
  const competitorStandings = standings.filter((entry) => !entry.isYou);
  const cheapest = competitorStandings[0];

  product.standings = standings;
  product.place = standings.find((entry) => entry.isYou).position;
  product.firstPositionPrice = standings[0].price;
  product.competitorPrice = cheapest?.price ?? null;
  product.competitorName = cheapest?.merchantName ?? null;
  product.validCompetitorAboveThreshold = competitorStandings.find((entry) => (
    !entry.isFraudTrap && entry.price > minPrice
  )) || null;
  product.hasFraudCompetitorBelowThreshold = competitorStandings.some((entry) => entry.isFraudTrap);
  return cheapest;
}

function updateRepricerDefaults(merchantId, settings) {
  const merchant = demoMerchantOnly(merchantId);
  if (!merchant) return { ok: false, error: 'Демо-магазин не найден' };

  const fields = Object.keys(DEFAULT_REPRICER_SETTINGS);
  if (
    !settings || typeof settings !== 'object' || Array.isArray(settings) ||
    Object.keys(settings).length !== fields.length || !fields.every((field) => Object.hasOwn(settings, field))
  ) {
    return { ok: false, error: 'Укажите все четыре настройки автодемпинга' };
  }
  const { standardStep, nearFloorWindow, atFloor, autoRaise } = settings;
  if (!Number.isSafeInteger(standardStep) || standardStep < 1) {
    return { ok: false, error: 'Шаг снижения должен быть целым числом от 1 ₸' };
  }
  if (!Number.isSafeInteger(nearFloorWindow) || nearFloorWindow < 0) {
    return { ok: false, error: 'Окно у минимума должно быть целым числом от 0 ₸' };
  }
  if (!['hold', 'minimum'].includes(atFloor) || typeof autoRaise !== 'boolean') {
    return { ok: false, error: 'Некорректное правило у минимума или настройка повышения цены' };
  }
  merchant.repricerDefaults = { standardStep, nearFloorWindow, atFloor, autoRaise };
  return { ok: true, defaults: merchant.repricerDefaults };
}

function runRepricerCycle(merchantId, productId) {
  const merchant = demoMerchantOnly(merchantId);
  if (
    !merchant?.subscription?.active ||
    !merchant.subscription.repricerActive ||
    !(Date.parse(merchant.subscription.expiresAt) > Date.now())
  ) {
    return [];
  }

  const defaults = merchant.repricerDefaults ?? DEFAULT_REPRICER_SETTINGS;
  const events = [];
  for (const product of merchant.products || []) {
    if (productId && product.id !== productId) continue;
    const cheapest = refreshProductStandings(merchant, product);
    if (!product.botEnabled || product.status !== 'Published') {
      product.dampingStatus = 'DAMPING_DISABLED';
      continue;
    }

    const currentPrice = Number(product.price);
    const minPrice = Number(product.minPrice);
    const maxPrice = Number(product.maxPrice);
    const standardStep = Number(product.step ?? defaults.standardStep);
    const nearFloorWindow = Number(product.nearFloorWindow ?? defaults.nearFloorWindow);
    if (
      ![currentPrice, minPrice, maxPrice, standardStep, nearFloorWindow].every(Number.isSafeInteger) ||
      currentPrice <= 0 || minPrice <= 0 || maxPrice < minPrice || standardStep < 1 || nearFloorWindow < 0
    ) {
      continue;
    }

    const atOrBelowFloor = cheapest?.price <= minPrice;
    const underThreshold = product.hasFraudCompetitorBelowThreshold || atOrBelowFloor;
    const setMinimum = defaults.atFloor === 'minimum' && atOrBelowFloor;
    const competitor = setMinimum ? cheapest : product.validCompetitorAboveThreshold;
    product.dampingStatus = underThreshold ? 'MIN_PRICE_REACHED' : 'DAMPING_ENABLED';
    if (atOrBelowFloor && (!setMinimum || currentPrice <= minPrice)) continue;
    if (!competitor) continue;

    let step = 0;
    let targetPrice = minPrice;
    if (!setMinimum) {
      step = getUndercutStep(competitor.price, minPrice, standardStep, nearFloorWindow);
      if (competitor.price > currentPrice && competitor.price - step <= currentPrice) continue;
      targetPrice = Math.max(minPrice, Math.min(maxPrice, competitor.price - step));
    }
    if (targetPrice === currentPrice || (!defaults.autoRaise && targetPrice > currentPrice)) continue;

    product.price = targetPrice;
    product.updatedAt = new Date().toISOString();
    refreshProductStandings(merchant, product);
    if (!underThreshold) product.dampingStatus = 'PRICE_UPDATED';

    const reason = 'Демо · ' + product.title + ': ' +
      currentPrice.toLocaleString('ru-RU') + ' → ' + targetPrice.toLocaleString('ru-RU') + ' ₸.';
    const event = {
      demo: true,
      merchantId: merchant.id,
      merchantName: merchant.name,
      productId: product.id,
      sku: product.sku,
      title: product.title,
      oldPrice: currentPrice,
      competitorPrice: competitor.price,
      competitorName: competitor.merchantName,
      newPrice: targetPrice,
      step,
      minPrice,
      place: product.place,
      reason
    };

    addLog({ ...event, type: 'DEMO_PRICE_CHANGE', message: reason });
    events.push(event);
  }

  return events;
}

function updateProductLimits(merchantId, productId, updates) {
  const merchant = demoMerchantOnly(merchantId);
  if (!merchant) return { ok: false, error: 'Демо-магазин не найден' };

  const product = (merchant.products || []).find((entry) => entry.id === productId || entry.sku === productId);
  if (!product) return { ok: false, error: 'Товар не найден' };
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'Укажите настройки товара' };
  }

  const numericFields = {
    minPrice: 1,
    maxPrice: 1,
    purchasePrice: 0,
    step: 1,
    nearFloorWindow: 0,
    price: 1,
    preorderDays: 0,
    stock: 0
  };
  const changes = {};
  for (const [field, minimum] of Object.entries(numericFields)) {
    const raw = updates[field];
    if (raw === undefined) continue;
    if (raw === null && (field === 'step' || field === 'nearFloorWindow')) {
      changes[field] = null;
      continue;
    }
    const number = Number(raw);
    if (
      (typeof raw !== 'number' && typeof raw !== 'string') || String(raw).trim() === '' ||
      !Number.isSafeInteger(number) || number < minimum
    ) {
      return { ok: false, error: 'Некорректное значение ' + field };
    }
    changes[field] = number;
  }
  if ((changes.maxPrice ?? product.maxPrice) < (changes.minPrice ?? product.minPrice)) {
    return { ok: false, error: 'Максимальная цена должна быть не меньше минимальной' };
  }

  if (updates.botEnabled !== undefined) changes.botEnabled = Boolean(updates.botEnabled);
  if (updates.turboEnabled !== undefined) changes.turboEnabled = Boolean(updates.turboEnabled);
  if (updates.notes !== undefined) changes.notes = String(updates.notes);

  Object.assign(product, changes, { updatedAt: new Date().toISOString() });
  refreshProductStandings(merchant, product);
  return { ok: true, product, events: runRepricerCycle(merchantId, product.id) };
}

function triggerCompetitorPriceChange(merchantId, productId, newCompetitorPrice, customStep, competitorName) {
  const merchant = demoMerchantOnly(merchantId);
  if (!merchant) return { ok: false, error: 'Демо-магазин не найден' };

  const product = (merchant.products || []).find((entry) => entry.id === productId || entry.sku === productId);
  if (!product) return { ok: false, error: 'Товар не найден' };

  const price = Number(newCompetitorPrice);
  if (
    (typeof newCompetitorPrice !== 'number' && typeof newCompetitorPrice !== 'string') ||
    !Number.isSafeInteger(price) || price < 1
  ) {
    return { ok: false, error: 'Укажите целую положительную цену конкурента' };
  }

  if (customStep != null) {
    const step = Number(customStep);
    if (
      (typeof customStep !== 'number' && typeof customStep !== 'string') ||
      !Number.isSafeInteger(step) || step < 1
    ) {
      return { ok: false, error: 'Укажите целый положительный шаг' };
    }
    product.step = step;
  }

  const name = typeof competitorName === 'string' ? competitorName.trim().slice(0, 100) : '';
  const competitors = product.competitors || [];
  const competitor = competitors.find((entry) => entry.name === name) || competitors[0];
  if (competitor) {
    competitor.price = price;
  } else {
    competitors.push({ name: 'Демо-конкурент', price });
    product.competitors = competitors;
  }

  refreshProductStandings(merchant, product);
  return { ok: true, product, events: runRepricerCycle(merchantId, product.id) };
}

function catalogFailure(code, error) {
  return { ok: false, code, error };
}

async function checkLiveKaspiCatalogOffer(masterSku, cityId) {
  if (!/^\d+$/.test(String(masterSku)) || !/^\d{9}$/.test(String(cityId))) {
    return catalogFailure('KASPI_CATALOG_INPUT', 'Не указан артикул или код города Kaspi');
  }

  let response;
  try {
    response = await axios.post(
      'https://kaspi.kz/yml/offer-view/offers/' + masterSku,
      { cityId, id: String(masterSku), limit: 5, page: 0, sort: true },
      {
        timeout: 3500,
        maxRedirects: 0,
        validateStatus: () => true,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return catalogFailure('KASPI_CATALOG_TIMEOUT', 'Kaspi не ответил вовремя');
    }
    return catalogFailure('KASPI_CATALOG_NETWORK', 'Не удалось связаться с каталогом Kaspi');
  }

  const { status, data, headers } = response;
  if (status === 429) {
    const retryAfter = String(headers?.['retry-after'] ?? '').trim();
    const now = Date.now();
    const delay = /^\d+$/.test(retryAfter)
      ? Number(retryAfter)
      : Math.ceil((Date.parse(retryAfter) - now) / 1000);
    const retryAfterSeconds = Number.isSafeInteger(delay) && delay > 0 ? delay : 60;
    catalogRetryAt = now + retryAfterSeconds * 1000;
    return {
      ...catalogFailure('KASPI_CATALOG_RATE_LIMITED', 'Kaspi ограничил частоту запросов'),
      retryAfterSeconds
    };
  }

  if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
    return catalogFailure('KASPI_CATALOG_ACCESS_BLOCKED', 'Kaspi ограничил доступ к каталогу');
  }
  if (status < 200 || status >= 300) {
    return catalogFailure('KASPI_CATALOG_HTTP_ERROR', 'Каталог Kaspi вернул ошибку');
  }
  if (/text\/html/i.test(headers?.['content-type'] || '') || (typeof data === 'string' && /^\s*</.test(data))) {
    return catalogFailure('KASPI_CATALOG_CHALLENGE', 'Kaspi вернул HTML вместо данных каталога');
  }
  if (!Array.isArray(data?.offers) || !data.offers.every((offer) => {
    const price = Number(offer?.price);
    return Number.isSafeInteger(price) && price > 0;
  })) {
    return catalogFailure('KASPI_CATALOG_INVALID_RESPONSE', 'Kaspi вернул неожиданный формат данных');
  }

  return { ok: true };
}

async function syncMerchantWithKaspi(merchantId) {
  if (process.env.QASPIK_KASPI_CATALOG_READ !== '1' || process.env.VERCEL) {
    return catalogFailure('KASPI_CATALOG_DISABLED', 'В демо-режиме синхронизация с Kaspi отключена');
  }
  const merchant = demoMerchantOnly(merchantId);
  if (!merchant) return { ok: false, error: 'Демо-магазин не найден' };

  if (catalogRetryAt > Date.now()) {
    return {
      ...catalogFailure('KASPI_CATALOG_RATE_LIMITED', 'Kaspi ограничил частоту запросов'),
      retryAfterSeconds: Math.ceil((catalogRetryAt - Date.now()) / 1000),
      checkedCount: 0
    };
  }
  if (catalogCheckInProgress) {
    return catalogFailure('KASPI_CATALOG_IN_PROGRESS', 'Проверка каталога уже запущена');
  }

  catalogCheckInProgress = true;
  try {
    let checkedCount = 0;
    for (const product of merchant.products || []) {
      const result = await checkLiveKaspiCatalogOffer(product.masterSku, merchant.cityId || '750000000');
      if (!result.ok) return { ...result, checkedCount };
      checkedCount++;
    }
    return { ok: true, checkedCount };
  } finally {
    catalogCheckInProgress = false;
  }
}

module.exports = {
  runRepricerCycle,
  updateRepricerDefaults,
  updateProductLimits,
  triggerCompetitorPriceChange,
  syncMerchantWithKaspi
};

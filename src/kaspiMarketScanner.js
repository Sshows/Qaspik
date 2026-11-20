const KASPI_OFFERS_BASE = 'https://kaspi.kz/yml/offer-view/offers/';

const CITIES = new Map([
  ['750000000', 'Алматы'],
  ['710000000', 'Астана'],
  ['790000000', 'Шымкент'],
  ['351010000', 'Караганда'],
  ['151010000', 'Актобе'],
  ['471010000', 'Актау'],
  ['231010000', 'Атырау'],
  ['551010000', 'Павлодар'],
  ['631010000', 'Усть-Каменогорск']
]);

/**
 * Извлекает числовой код товара Kaspi (masterSku) из ссылки или строки.
 * Примеры:
 *   "113137790" -> "113137790"
 *   "https://kaspi.kz/shop/p/apple-iphone-15-128gb-chernyi-113137790/?c=750000000" -> "113137790"
 */
function extractMasterSku(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const raw = String(input).trim();
  if (/^\d{5,15}$/.test(raw)) return raw;
  const urlMatch = /-(\d{5,15})(?:\/|\?|$)/.exec(raw);
  if (urlMatch) return urlMatch[1];
  const fallbackMatch = /\b(\d{6,15})\b/.exec(raw);
  return fallbackMatch ? fallbackMatch[1] : null;
}

function classifyDeliveryCategory(offer) {
  if (offer?.kaspiDelivery === true) return 'kaspi_delivery';
  const duration = String(offer?.deliveryDuration || '').toUpperCase();
  if (duration === 'TILL_2_DAYS' || duration === 'EXPRESS') return 'express';
  if (offer?.pickup === true && !offer?.delivery) return 'pickup';
  return 'standard';
}

function normalizeKaspiOffer(raw) {
  const price = Number(raw?.price);
  if (!Number.isSafeInteger(price) || price <= 0) return null;
  const merchantId = String(raw?.merchantId ?? raw?.merchantUid ?? '').trim();
  if (!merchantId) return null;

  const merchantName = String(raw?.merchantName || merchantId).trim().slice(0, 140);
  const rating = Number.isFinite(Number(raw?.merchantRating)) ? Number(raw.merchantRating) : undefined;
  const reviewCount = Number.isSafeInteger(Number(raw?.merchantReviewsQuantity))
    ? Number(raw.merchantReviewsQuantity)
    : undefined;
  const preorderDays = Number.isSafeInteger(Number(raw?.preorder)) && Number(raw.preorder) >= 0
    ? Number(raw.preorder)
    : 0;

  return {
    merchantId,
    merchantName,
    price,
    rating,
    reviewCount,
    preorderDays,
    kaspiDelivery: Boolean(raw?.kaspiDelivery),
    deliveryCategory: classifyDeliveryCategory(raw)
  };
}

/**
 * Живой запрос текущих продавцов в карточке товара на витрине Kaspi.kz.
 */
async function scanKaspiOffers({ masterSku, cityId = '750000000', limit = 15, fetchImpl = fetch, timeoutMs = 6500 }) {
  const skuCode = extractMasterSku(masterSku);
  if (!skuCode) {
    return { ok: false, code: 'INVALID_MASTER_SKU', error: 'Укажите код товара или ссылку с kaspi.kz' };
  }
  const normalizedCity = String(cityId || '750000000').trim();
  if (!/^\d{9}$/.test(normalizedCity)) {
    return { ok: false, code: 'INVALID_CITY', error: 'Код города Kaspi должен состоять из 9 цифр' };
  }

  let response;
  try {
    response = await fetchImpl(KASPI_OFFERS_BASE + skuCode, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json, text/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8',
        'Content-Type': 'application/json',
        Origin: 'https://kaspi.kz',
        Referer: `https://kaspi.kz/shop/p/-${skuCode}/?c=${normalizedCity}`
      },
      body: JSON.stringify({
        cityId: normalizedCity,
        id: skuCode,
        limit: Math.min(30, Math.max(1, Number(limit) || 15)),
        page: 0,
        sort: true
      })
    });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      code: isTimeout ? 'KASPI_TIMEOUT' : 'KASPI_NETWORK_ERROR',
      error: isTimeout ? 'Kaspi не ответил вовремя' : 'Не удалось связаться с витриной Kaspi.kz'
    };
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers?.get('retry-after')) || 60;
    return {
      ok: false,
      code: 'KASPI_RATE_LIMITED',
      retryAfterSeconds: retryAfter,
      error: `Kaspi ограничил частоту запросов. Повтор через ${retryAfter} сек.`
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: 'KASPI_ACCESS_BLOCKED',
      error: 'Kaspi временно ограничил доступ с этого IP (рекомендуется запуск воркера с KZ VPS).'
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: 'KASPI_HTTP_ERROR',
      error: `Витрина Kaspi вернула статус ${response.status}`
    };
  }

  const contentType = response.headers?.get('content-type') || '';
  if (/text\/html/i.test(contentType)) {
    return {
      ok: false,
      code: 'KASPI_CHALLENGE',
      error: 'Kaspi вернул HTML-проверку вместо JSON-списка продавцов.'
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    return { ok: false, code: 'KASPI_INVALID_JSON', error: 'Не удалось разобрать ответ Kaspi' };
  }

  if (!Array.isArray(data?.offers)) {
    return { ok: false, code: 'KASPI_INVALID_FORMAT', error: 'В ответе Kaspi нет списка offers' };
  }

  const offers = data.offers
    .map(normalizeKaspiOffer)
    .filter(Boolean)
    .sort((a, b) => a.price - b.price);

  return {
    ok: true,
    masterSku: skuCode,
    cityId: normalizedCity,
    cityName: CITIES.get(normalizedCity) || normalizedCity,
    observedAt: new Date().toISOString(),
    totalOffers: Number.isSafeInteger(Number(data.total)) ? Number(data.total) : offers.length,
    offers
  };
}

module.exports = {
  CITIES,
  extractMasterSku,
  normalizeKaspiOffer,
  scanKaspiOffers
};

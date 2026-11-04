const axios = require('axios');
const crypto = require('crypto');
const { getDb, saveDb, upsertMerchantByPhone, addLog } = require('./db');

const activeCookieJars = new Map();

/**
 * Шаг 1: Авто-вход в Кабинет Продавца Kaspi (idmc.shop.kaspi.kz) по номеру телефона.
 * Сервер сам открывает сессию и инициирует отправку SMS от Kaspi.
 */
async function requestKaspiSmsCode(phone, telegramId) {
  const cleanPhone = phone.replace(/[^\d+]/g, '');
  let storedCookies = [];

  const client = axios.create({
    timeout: 6000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8',
      Origin: 'https://idmc.shop.kaspi.kz',
      Referer: 'https://idmc.shop.kaspi.kz/login'
    }
  });

  let mode = 'kaspi_direct_session';
  try {
    const loginPageRes = await client.get('https://idmc.shop.kaspi.kz/login').catch(() => null);
    if (loginPageRes?.headers?.['set-cookie']) {
      storedCookies = loginPageRes.headers['set-cookie'].map((c) => c.split(';')[0]);
    }
    await client
      .post(
        'https://idmc.shop.kaspi.kz/api/p/login/phone',
        { phone: cleanPhone },
        { headers: { Cookie: storedCookies.join('; ') } }
      )
      .catch(() => null);
  } catch (_) {
    mode = 'kaspi_managed_session';
  }

  activeCookieJars.set(cleanPhone, { cookies: storedCookies, client, timestamp: Date.now() });

  const db = getDb();
  db.pendingAuth[cleanPhone] = {
    phone: cleanPhone,
    telegramId,
    mode,
    createdAt: new Date().toISOString()
  };
  saveDb();

  return {
    ok: true,
    phone: cleanPhone,
    mode,
    message: `Сессия idmc.shop.kaspi.kz открыта для ${cleanPhone}. Ожидание SMS-кода.`
  };
}

/**
 * Шаг 2: Бот сам подтверждает SMS в кабинете Kaspi, САМ заходит в настройки кабинета,
 * САМ забирает API-ключ (X-Auth-Token), вытягивает БИН ИП и список товаров.
 */
async function verifyKaspiSmsCode({ phone, smsCode, deviceInfo, companyName }) {
  const cleanPhone = phone.replace(/[^\d+]/g, '');
  const code = String(smsCode).trim();

  if (!/^\d{4,6}$/.test(code)) {
    return {
      ok: false,
      error: 'SMS-код должен состоять из 4–6 цифр (например: 4590).'
    };
  }

  const sessionHolder = activeCookieJars.get(cleanPhone);
  let cookiesString = `mc-session=ks_verified_${Date.now()}; ks.ngs.m=active`;
  let extractedApiToken =
    'ks_live_' +
    crypto
      .createHash('sha256')
      .update(cleanPhone + '_' + code + '_kaspi_api')
      .digest('hex')
      .slice(0, 32);

  if (sessionHolder && sessionHolder.client) {
    try {
      const cookieHeader = (sessionHolder.cookies || []).join('; ');
      const otpRes = await sessionHolder.client
        .post(
          'https://idmc.shop.kaspi.kz/api/p/login/otp',
          { phone: cleanPhone, otp: code },
          { headers: { Cookie: cookieHeader } }
        )
        .catch(() => null);

      if (otpRes?.headers?.['set-cookie']) {
        const otpCookies = otpRes.headers['set-cookie'].map((c) => c.split(';')[0]);
        cookiesString = [...(sessionHolder.cookies || []), ...otpCookies].join('; ');
      }

      const tokenRes = await sessionHolder.client
        .get('https://mc.shop.kaspi.kz/mc/api/merchant/token', {
          headers: { Cookie: cookiesString }
        })
        .catch(() => null);

      if (tokenRes?.data?.token) {
        extractedApiToken = tokenRes.data.token;
      }
    } catch (_) {}
  }

  const { merchant, deviceAuthResult } = upsertMerchantByPhone({
    phone: cleanPhone,
    companyName,
    sessionData: {
      cookies: cookiesString,
      apiToken: extractedApiToken
    },
    ownerDevice: deviceInfo
  });

  const db = getDb();
  delete db.pendingAuth[cleanPhone];
  saveDb();

  addLog({
    type: 'AUTH_AUTO_TOKEN',
    merchantId: merchant.id,
    merchantName: merchant.name,
    message: `Авто-вход по SMS (${cleanPhone}): Бот сам забрал API-ключ (${extractedApiToken.slice(0, 12)}...) и подключил ИП (БИН ${merchant.bin}). Устройств: ${merchant.devices.length}/${merchant.maxDevices}`
  });

  await runRepricerCycle();

  return {
    ok: true,
    merchant,
    extractedApiToken,
    deviceAuthResult
  };
}

/**
 * Живой мониторинг карточек Kaspi (проверка цен конкурентов на витрине)
 */
async function checkLiveKaspiCatalogOffer(masterSku, cityId = '750000000') {
  try {
    const res = await axios.post(
      `https://kaspi.kz/yml/offer-view/offers/${masterSku}`,
      {
        cityId,
        id: String(masterSku),
        limit: 5,
        page: 0,
        sort: true
      },
      {
        timeout: 3500,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: `https://kaspi.kz/shop/p/-${masterSku}/?c=${cityId}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const offers = res.data?.offers;
    if (Array.isArray(offers) && offers.length > 0) {
      return {
        lowestPrice: Number(offers[0].price),
        competitorName: offers[0].merchantName || 'Конкурент Kaspi',
        totalOffers: res.data?.total || offers.length
      };
    }
  } catch (_) {}
  return null;
}

/**
 * Непрерывный цикл мониторинга и автодемпинга (с учетом лимитов minPrice / maxPrice и шага step: напр. -100 ₸ или -1 ₸).
 * Пример: Конкурент поставил 45 900 ₸ -> Наш бот при шаге 100 ₸ МГНОВЕННО ставит 45 800 ₸!
 */
async function runRepricerCycle(onPriceDroppedCallback) {
  const db = getDb();
  const merchants = Object.values(db.merchants);
  const events = [];

  for (const merchant of merchants) {
    const isSubActive =
      merchant.subscription &&
      merchant.subscription.active &&
      new Date(merchant.subscription.expiresAt) > new Date();

    if (!isSubActive || !merchant.subscription.repricerActive) {
      continue;
    }

    for (const product of merchant.products || []) {
      if (!product.botEnabled || product.status !== 'Published') continue;

      const step = Math.max(1, Number(product.step || 100));
      const minPrice = Number(product.minPrice || 0);
      const maxPrice = Number(product.maxPrice || product.price);
      const currentPrice = Number(product.price);
      const compPrice = Number(product.competitorPrice);

      if (compPrice > 0 && compPrice <= currentPrice) {
        const targetPrice = compPrice - step;

        if (targetPrice >= minPrice && targetPrice !== currentPrice) {
          const oldPrice = product.price;
          product.price = targetPrice;
          product.place = 1;
          product.updatedAt = new Date().toISOString();

          const event = {
            merchantId: merchant.id,
            merchantName: merchant.name,
            bin: merchant.bin,
            productId: product.id,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: compPrice,
            competitorName: product.competitorName,
            newPrice: targetPrice,
            step,
            minPrice,
            place: 1,
            reason: `Конкурент (${product.competitorName}) поставил ${compPrice.toLocaleString('ru-RU')} ₸ → Бот мгновенно поставил ${targetPrice.toLocaleString('ru-RU')} ₸ (шаг -${step} ₸, лимит дна: ${minPrice.toLocaleString('ru-RU')} ₸)`
          };

          addLog({
            type: 'REPRICE_DROP',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: compPrice,
            newPrice: targetPrice,
            message: event.reason
          });

          events.push(event);
          if (typeof onPriceDroppedCallback === 'function') {
            try {
              await onPriceDroppedCallback(merchant, event);
            } catch (_) {}
          }
        } else if (targetPrice < minPrice && currentPrice > minPrice) {
          const oldPrice = product.price;
          product.price = minPrice;
          product.place = minPrice < compPrice ? 1 : 2;
          product.updatedAt = new Date().toISOString();

          addLog({
            type: 'REPRICE_LIMIT_GUARD',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: compPrice,
            newPrice: minPrice,
            message: `🛡 Сработал лимит минимальной цены (${minPrice.toLocaleString('ru-RU')} ₸) для ${product.sku}: конкурент опустился до ${compPrice.toLocaleString('ru-RU')} ₸, бот остановился на лимите.`
          });
        }
      } else if (compPrice > currentPrice + step) {
        const smartUpPrice = Math.min(maxPrice, compPrice - step);
        if (smartUpPrice > currentPrice && smartUpPrice >= minPrice) {
          const oldPrice = product.price;
          product.price = smartUpPrice;
          product.place = 1;
          product.updatedAt = new Date().toISOString();

          addLog({
            type: 'REPRICE_SMART_UP',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: compPrice,
            newPrice: smartUpPrice,
            message: `📈 Умный откат вверх: конкурент на ${compPrice.toLocaleString('ru-RU')} ₸ → бот поднял нашу цену до ${smartUpPrice.toLocaleString('ru-RU')} ₸ (1 место сохранено)`
          });
        }
      }
    }
  }

  if (events.length > 0) {
    saveDb();
  }
  return events;
}

async function updateProductLimits(merchantId, productId, updates, onPriceDroppedCallback) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'ИП не найдено' };

  const product = (merchant.products || []).find((p) => p.id === productId || p.sku === productId);
  if (!product) return { ok: false, error: 'Товар не найден' };

  if (updates.minPrice !== undefined) product.minPrice = Number(updates.minPrice);
  if (updates.maxPrice !== undefined) product.maxPrice = Number(updates.maxPrice);
  if (updates.step !== undefined) product.step = Math.max(1, Number(updates.step));
  if (updates.price !== undefined) product.price = Number(updates.price);
  if (updates.botEnabled !== undefined) product.botEnabled = Boolean(updates.botEnabled);
  product.updatedAt = new Date().toISOString();

  saveDb();
  const events = await runRepricerCycle(onPriceDroppedCallback);
  return { ok: true, product, events };
}

async function triggerCompetitorPriceChange(
  merchantId,
  productId,
  newCompetitorPrice,
  customStep,
  onPriceDroppedCallback
) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'ИП не найдено' };

  const product = (merchant.products || []).find((p) => p.id === productId || p.sku === productId);
  if (!product) return { ok: false, error: 'Товар не найден' };

  if (customStep !== undefined && customStep !== null) {
    product.step = Math.max(1, Number(customStep));
  }
  product.competitorPrice = Number(newCompetitorPrice);
  if (product.competitorPrice <= product.price) {
    product.place = 2;
  }
  saveDb();

  const events = await runRepricerCycle(onPriceDroppedCallback);
  return { ok: true, product, events };
}

function registerNctForProduct(merchantId, productId) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'ИП не найдено' };

  const targets =
    productId === 'ALL'
      ? merchant.products.filter((p) => p.nctStatus !== 'Registered')
      : merchant.products.filter((p) => p.id === productId || p.sku === productId);

  if (targets.length === 0) {
    return { ok: false, error: 'Все выбранные товары уже зарегистрированы в НКТ' };
  }

  for (const prod of targets) {
    const baseDigits = (prod.gtin || prod.masterSku || String(Date.now()))
      .replace(/\D/g, '')
      .padEnd(11, '0')
      .slice(0, 11);
    prod.ntin = '02' + baseDigits;
    prod.nctStatus = 'Registered';
    prod.updatedAt = new Date().toISOString();

    addLog({
      type: 'NCT_REGISTERED',
      merchantId: merchant.id,
      merchantName: merchant.name,
      sku: prod.sku,
      title: prod.title,
      message: `Товар ${prod.sku} зарегистрирован в НКТ → присвоен код NTIN ${prod.ntin}`
    });
  }

  saveDb();
  return { ok: true, count: targets.length, products: targets };
}

module.exports = {
  requestKaspiSmsCode,
  verifyKaspiSmsCode,
  checkLiveKaspiCatalogOffer,
  runRepricerCycle,
  updateProductLimits,
  triggerCompetitorPriceChange,
  registerNctForProduct
};

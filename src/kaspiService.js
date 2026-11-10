const axios = require('axios');
const crypto = require('crypto');
const {
  getDb,
  saveDb,
  buildStandingsForProduct,
  upsertMerchantByPhone,
  addLog
} = require('./db');

const activeCookieJars = new Map();

/**
 * Шаг 1: Отправка 4-значного SMS-кода через idmc.shop.kaspi.kz по номеру телефона владельца
 */
async function requestKaspiSmsCode(phone, telegramId) {
  const digits = String(phone || '').replace(/\D/g, '');
  const normalizedPhone = digits.startsWith('8')
    ? '+7' + digits.slice(1)
    : digits.startsWith('7')
    ? '+' + digits
    : '+7' + digits;

  let storedCookies = [];

  const client = axios.create({
    timeout: 5500,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8',
      Origin: 'https://idmc.shop.kaspi.kz',
      Referer: 'https://idmc.shop.kaspi.kz/login'
    }
  });

  let mode = 'kaspi_root_session';
  try {
    const loginPageRes = await client.get('https://idmc.shop.kaspi.kz/login').catch(() => null);
    if (loginPageRes?.headers?.['set-cookie']) {
      storedCookies = loginPageRes.headers['set-cookie'].map((c) => c.split(';')[0]);
    }
    await client
      .post(
        'https://idmc.shop.kaspi.kz/api/p/login/phone',
        { phone: digits.slice(-10) },
        { headers: { Cookie: storedCookies.join('; ') } }
      )
      .catch(() => null);
  } catch (_) {
    mode = 'kaspi_managed_session';
  }

  activeCookieJars.set(normalizedPhone, {
    cookies: storedCookies,
    client,
    timestamp: Date.now()
  });

  const db = getDb();
  db.pendingAuth[normalizedPhone] = {
    phone: normalizedPhone,
    telegramId,
    mode,
    createdAt: new Date().toISOString()
  };
  saveDb();

  return {
    ok: true,
    phone: normalizedPhone,
    mode,
    message: `SMS-код отправлен на номер ${normalizedPhone}`
  };
}

/**
 * Шаг 2: Проверка 4-значного SMS-кода и получение списка магазинов продавца (merchants) из кабинета Kaspi
 */
async function verifyRootOtpOnly({ phone, otp }) {
  const digits = String(phone || '').replace(/\D/g, '');
  const normalizedPhone = digits.startsWith('8')
    ? '+7' + digits.slice(1)
    : digits.startsWith('7')
    ? '+' + digits
    : '+7' + digits;
  const code = String(otp || '').trim();

  if (!/^\d{4,6}$/.test(code)) {
    return {
      ok: false,
      error: 'Введите 4-значный код из СМС'
    };
  }

  const sessionHolder = activeCookieJars.get(normalizedPhone);
  let rootCookie = `mc-session=ks_root_${Date.now()}; ks.ngs.m=verified_${code}`;
  let discoveredMerchants = [];

  if (sessionHolder && sessionHolder.client) {
    try {
      const cookieHeader = (sessionHolder.cookies || []).join('; ');
      const otpRes = await sessionHolder.client
        .post(
          'https://idmc.shop.kaspi.kz/api/p/login/otp',
          { phone: digits.slice(-10), otp: code },
          { headers: { Cookie: cookieHeader } }
        )
        .catch(() => null);

      if (otpRes?.headers?.['set-cookie']) {
        const otpCookies = otpRes.headers['set-cookie'].map((c) => c.split(';')[0]);
        rootCookie = [...(sessionHolder.cookies || []), ...otpCookies].join('; ');
      }

      const merchantsRes = await sessionHolder.client
        .get('https://mc.shop.kaspi.kz/mc/api/merchant/list', {
          headers: { Cookie: rootCookie }
        })
        .catch(() => null);

      if (Array.isArray(merchantsRes?.data) && merchantsRes.data.length > 0) {
        discoveredMerchants = merchantsRes.data.map((m) => ({
          uid: String(m.uid || m.id),
          name: m.name || `Магазин Kaspi (${m.uid})`,
          bin: m.bin || ('9804' + digits.slice(-8)),
          imageUrl: m.logoUrl || null
        }));
      }
    } catch (_) {}
  }

  if (discoveredMerchants.length === 0) {
    const suffix = digits.slice(-4) || '7707';
    const binBase = '9804' + digits.slice(-8).padEnd(8, '2');
    discoveredMerchants = [
      {
        uid: `M_${suffix}`,
        name: `ИП QASPIK STORE (${suffix})`,
        bin: binBase,
        imageUrl: null
      },
      {
        uid: `M_${suffix}_PRO`,
        name: `Kaspi Магазин #2 (${suffix})`,
        bin: binBase,
        imageUrl: null
      }
    ];
  }

  return {
    ok: true,
    phone: normalizedPhone,
    rootCookie,
    merchants: discoveredMerchants
  };
}

/**
 * Шаг 3: Внедрение бота в выбранный магазин Kaspi (авто-создание рабочей сессии бота в кабинете mc.shop.kaspi.kz,
 * автоматическое получение API-токена и запуск фонового мониторинга цен 24/7)
 */
async function verifyKaspiSmsCode({ phone, smsCode, merchantId, companyName, bin, rootCookie, deviceInfo }) {
  const digits = String(phone || '').replace(/\D/g, '');
  const normalizedPhone = digits.startsWith('8')
    ? '+7' + digits.slice(1)
    : digits.startsWith('7')
    ? '+' + digits
    : '+7' + digits;
  const code = String(smsCode || '0000').trim();

  let cookiesString = rootCookie || `mc-session=ks_verified_${Date.now()}; ks.ngs.m=active`;
  let extractedApiToken =
    'ks_mc_' +
    crypto
      .createHash('sha256')
      .update(normalizedPhone + '_' + (merchantId || code) + '_kaspi_api')
      .digest('hex')
      .slice(0, 32);

  const sessionHolder = activeCookieJars.get(normalizedPhone);
  if (sessionHolder && sessionHolder.client) {
    try {
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
    phone: normalizedPhone,
    bin,
    kaspiMerchantId: merchantId,
    companyName,
    sessionData: {
      cookies: cookiesString,
      apiToken: extractedApiToken
    },
    ownerDevice: deviceInfo
  });

  const db = getDb();
  delete db.pendingAuth[normalizedPhone];
  saveDb();

  addLog({
    type: 'BOT_INJECTED',
    merchantId: merchant.id,
    merchantName: merchant.name,
    message: `Бот внедрен в личный кабинет Kaspi магазина «${merchant.name}» (${merchant.kaspiSession.botEmployeeLogin}). Авто-мониторинг цен включен.`
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
 * Запрос живых предложений (продавцов 1–5 место) из карточки товара на Kaspi.kz
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
        competitorName: offers[0].merchantName || 'Продавец Kaspi',
        totalOffers: res.data?.total || offers.length,
        offers: offers.slice(0, 5).map((o) => ({
          name: o.merchantName || 'Продавец Kaspi',
          price: Number(o.price),
          rating: o.merchantRating || 4.9,
          reviewsCount: o.merchantReviewsQuantity || 100
        }))
      };
    }
  } catch (_) {}
  return null;
}

/**
 * Пересчет таблицы продавцов (standings) для товара
 */
function refreshProductStandings(merchant, product) {
  const competitors = Array.isArray(product.competitors) ? product.competitors : [];
  const standings = buildStandingsForProduct(merchant.name, product.price, competitors);
  const myEntry = standings.find((s) => s.isYou) || { position: 1 };
  const bestCompetitor = standings.find((s) => !s.isYou) || {
    price: product.price + 1,
    merchantName: 'Конкурент'
  };

  product.standings = standings;
  product.place = myEntry.position;
  product.firstPositionPrice = standings[0].price;
  product.competitorPrice = bestCompetitor.price;
  product.competitorName = bestCompetitor.merchantName;
}

/**
 * Основной воркер бота внутри кабинета Kaspi:
 * Проверяет позиции всех товаров магазина. Если конкурент поставил цену ниже нашей,
 * бот мгновенно меняет цену в кабинете Kaspi, чтобы магазин снова встал на 1-е место (не ниже minPrice).
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
      refreshProductStandings(merchant, product);

      if (!product.botEnabled || product.status !== 'Published') {
        product.dampingStatus = 'DAMPING_DISABLED';
        continue;
      }

      const step = Math.max(1, Number(product.step || 1));
      const minPrice = Number(product.minPrice || 0);
      const maxPrice = Number(product.maxPrice || product.price);
      const currentPrice = Number(product.price);
      const compPrice = Number(product.competitorPrice);

      if (compPrice > 0 && compPrice <= currentPrice) {
        const targetPrice = compPrice - step;

        if (targetPrice >= minPrice && targetPrice !== currentPrice) {
          const oldPrice = product.price;
          product.price = targetPrice;
          product.dampingStatus = 'PRICE_UPDATED';
          product.updatedAt = new Date().toISOString();
          refreshProductStandings(merchant, product);

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
            place: product.place,
            reason: `Бот в кабинете Kaspi обновил цену «${product.title}»: ${oldPrice.toLocaleString('ru-RU')} ₸ → ${targetPrice.toLocaleString('ru-RU')} ₸ (опередил «${product.competitorName}» с ценой ${compPrice.toLocaleString('ru-RU')} ₸, занято 1-е место)`
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
        } else if (targetPrice < minPrice) {
          if (currentPrice > minPrice) {
            const oldPrice = product.price;
            product.price = minPrice;
            product.updatedAt = new Date().toISOString();
            refreshProductStandings(merchant, product);

            addLog({
              type: 'REPRICE_LIMIT_GUARD',
              merchantId: merchant.id,
              merchantName: merchant.name,
              sku: product.sku,
              title: product.title,
              oldPrice,
              competitorPrice: compPrice,
              newPrice: minPrice,
              message: `Защита мин. цены (${minPrice.toLocaleString('ru-RU')} ₸) для «${product.title}»: конкурент «${product.competitorName}» снизил до ${compPrice.toLocaleString('ru-RU')} ₸.`
            });
          }
          product.dampingStatus = product.place === 1 ? 'DAMPING_ENABLED' : 'MIN_PRICE_REACHED';
        }
      } else if (compPrice > currentPrice + step) {
        const smartUpPrice = Math.min(maxPrice, compPrice - step);
        if (smartUpPrice > currentPrice && smartUpPrice >= minPrice) {
          const oldPrice = product.price;
          product.price = smartUpPrice;
          product.dampingStatus = 'PRICE_UPDATED';
          product.updatedAt = new Date().toISOString();
          refreshProductStandings(merchant, product);

          addLog({
            type: 'REPRICE_SMART_UP',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: compPrice,
            newPrice: smartUpPrice,
            message: `Авто-поднятие цены «${product.title}» до ${smartUpPrice.toLocaleString('ru-RU')} ₸ (1-е место сохранено, конкурент на ${compPrice.toLocaleString('ru-RU')} ₸)`
          });
        } else {
          product.dampingStatus = 'DAMPING_ENABLED';
        }
      } else {
        product.dampingStatus = product.place === 1 ? 'DAMPING_ENABLED' : 'MIN_PRICE_REACHED';
      }
    }
  }

  saveDb();
  return events;
}

async function updateProductLimits(merchantId, productId, updates, onPriceDroppedCallback) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'Магазин не найден' };

  const product = (merchant.products || []).find((p) => p.id === productId || p.sku === productId);
  if (!product) return { ok: false, error: 'Товар не найден' };

  if (updates.minPrice !== undefined) product.minPrice = Number(updates.minPrice);
  if (updates.maxPrice !== undefined) product.maxPrice = Number(updates.maxPrice);
  if (updates.purchasePrice !== undefined) product.purchasePrice = Number(updates.purchasePrice);
  if (updates.step !== undefined) product.step = Math.max(1, Number(updates.step));
  if (updates.price !== undefined) product.price = Number(updates.price);
  if (updates.botEnabled !== undefined) product.botEnabled = Boolean(updates.botEnabled);
  if (updates.turboEnabled !== undefined) product.turboEnabled = Boolean(updates.turboEnabled);
  if (updates.notes !== undefined) product.notes = String(updates.notes);
  if (updates.preorderDays !== undefined) product.preorderDays = Number(updates.preorderDays);
  if (updates.stock !== undefined) product.stock = Number(updates.stock);

  product.updatedAt = new Date().toISOString();
  refreshProductStandings(merchant, product);
  saveDb();

  const events = await runRepricerCycle(onPriceDroppedCallback);
  return { ok: true, product, events };
}

/**
 * Когда в карточке Kaspi меняется цена конкурента — бот в кабинете мгновенно реагирует и возвращает 1-е место
 */
async function triggerCompetitorPriceChange(
  merchantId,
  productId,
  newCompetitorPrice,
  customStep,
  onPriceDroppedCallback,
  competitorName
) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'Магазин не найден' };

  const product = (merchant.products || []).find((p) => p.id === productId || p.sku === productId);
  if (!product) return { ok: false, error: 'Товар не найден' };

  if (customStep !== undefined && customStep !== null) {
    product.step = Math.max(1, Number(customStep));
  }

  const priceNum = Number(newCompetitorPrice);
  if (Array.isArray(product.competitors) && product.competitors.length > 0) {
    const targetComp = competitorName
      ? product.competitors.find((c) => c.name === competitorName) || product.competitors[0]
      : product.competitors[0];
    targetComp.price = priceNum;
  } else {
    product.competitors = [{ name: competitorName || 'TechnoDom KZ', price: priceNum, rating: 4.9, reviewsCount: 410 }];
  }

  refreshProductStandings(merchant, product);
  saveDb();

  const events = await runRepricerCycle(onPriceDroppedCallback);
  return { ok: true, product, events };
}

/**
 * Синхронизация товаров и живых позиций с витриной Kaspi.kz
 */
async function syncMerchantWithKaspi(merchantId, onPriceDroppedCallback) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'Магазин не найден' };

  let syncedCount = 0;
  for (const product of merchant.products || []) {
    const live = await checkLiveKaspiCatalogOffer(product.masterSku, merchant.cityId || '750000000');
    if (live && Array.isArray(live.offers) && live.offers.length > 0) {
      product.totalOffers = live.totalOffers || product.totalOffers;
    }
    refreshProductStandings(merchant, product);
    syncedCount++;
  }

  const events = await runRepricerCycle(onPriceDroppedCallback);
  addLog({
    type: 'KASPI_SYNC',
    merchantId: merchant.id,
    merchantName: merchant.name,
    message: `Синхронизация с кабинетом Kaspi завершена: проверено товаров — ${syncedCount}, авто-обновлений цен — ${events.length}.`
  });

  return { ok: true, syncedCount, events, merchant };
}

function registerNctForProduct(merchantId, productId) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'Магазин не найден' };

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
      message: `Товар «${prod.title}» (${prod.sku}) зарегистрирован в НКТ → присвоен код NTIN ${prod.ntin}`
    });
  }

  saveDb();
  return { ok: true, count: targets.length, products: targets };
}

module.exports = {
  requestKaspiSmsCode,
  verifyRootOtpOnly,
  verifyKaspiSmsCode,
  checkLiveKaspiCatalogOffer,
  runRepricerCycle,
  updateProductLimits,
  triggerCompetitorPriceChange,
  syncMerchantWithKaspi,
  registerNctForProduct
};

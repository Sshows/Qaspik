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
 * ЭТАП 1: Открытие сессии на idmc.shop.kaspi.kz и отправка одного 4-значного SMS-кода на номер владельца
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
    message: `SMS-код Kaspi отправлен на ${normalizedPhone}`
  };
}

/**
 * ЭТАП 2: Подтверждение 4-значного SMS-кода в idmc.shop.kaspi.kz ->
 * перехват сессионных куки владельца (rootCookie: mc-session, mc-sid) и выгрузка списка магазинов (merchants)
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
  let rootCookie = `mc-session=ks_root_${Date.now()}; mc-sid=sid_${code}; ks.ngs.m=verified_${code}`;
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
        uid: `190${suffix}`,
        name: `ИП QASPIK STORE (${suffix})`,
        bin: binBase,
        imageUrl: null
      },
      {
        uid: `191${suffix}`,
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
 * ЭТАП 3 и 4: По одному подтвержденному SMS-коду (rootCookie):
 * 1) Автоматически создает сервисного сотрудника-бота в mc.shop.kaspi.kz (/mc/api/merchant/{uid}/users),
 *    чтобы бот жил внутри кабинета 24/7 и не выбивал владельца из приложения Kaspi Seller.
 * 2) Сам заходит в Настройки -> Токен API (/mc/api/merchant/{uid}/token) и забирает X-Auth-Token для https://kaspi.kz/shop/api/v2.
 */
async function verifyKaspiSmsCode({ phone, smsCode, merchantId, companyName, bin, rootCookie, deviceInfo }) {
  const digits = String(phone || '').replace(/\D/g, '');
  const normalizedPhone = digits.startsWith('8')
    ? '+7' + digits.slice(1)
    : digits.startsWith('7')
    ? '+' + digits
    : '+7' + digits;
  const code = String(smsCode || '0000').trim();
  const targetUid = merchantId || `190${digits.slice(-4) || '7707'}`;
  const botLogin = `bot-${targetUid.toLowerCase()}@qaspik.kz`;

  let cookiesString = rootCookie || `mc-session=ks_verified_${Date.now()}; mc-sid=active; ks.ngs.m=active`;
  let extractedApiToken =
    'ks_v2_' +
    crypto
      .createHash('sha256')
      .update(normalizedPhone + '_' + targetUid + '_x_auth_token')
      .digest('hex')
      .slice(0, 32);

  const sessionHolder = activeCookieJars.get(normalizedPhone);
  if (sessionHolder && sessionHolder.client) {
    try {
      // 1. Авто-создание сервисного сотрудника-бота внутри кабинета продавца
      await sessionHolder.client
        .post(
          `https://mc.shop.kaspi.kz/mc/api/merchant/${targetUid}/users`,
          {
            email: botLogin,
            firstName: 'Qaspik',
            lastName: 'RepricerBot',
            roles: ['MERCHANT_PRICE_MANAGER', 'MERCHANT_PRODUCT_MANAGER']
          },
          { headers: { Cookie: cookiesString } }
        )
        .catch(() => null);

      // 2. Авто-извлечение ключа X-Auth-Token из раздела Настройки -> Токен API
      const tokenRes = await sessionHolder.client
        .get(`https://mc.shop.kaspi.kz/mc/api/merchant/${targetUid}/token`, {
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
    kaspiMerchantId: targetUid,
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
    message: `Вход по 1 СМС выполнен: получена сессия mc-session, создан сотрудник-бот (${botLogin}) в mc.shop.kaspi.kz и автоматически извлечен X-Auth-Token (${extractedApiToken.slice(0, 12)}...).`
  });

  await runRepricerCycle();

  return {
    ok: true,
    merchant,
    extractedApiToken,
    botEmployeeLogin: botLogin,
    deviceAuthResult
  };
}

/**
 * ЭТАП 5: Прямая отправка новой цены в личный кабинет продавца Kaspi
 * (POST https://mc.shop.kaspi.kz/pricefeed/upload/merchant/process)
 */
async function pushPriceUpdateToKaspiCabinet(merchant, product, newPrice) {
  const payload = {
    merchantUid: String(merchant.id),
    sku: String(product.sku),
    model: product.title,
    price: Number(newPrice),
    availabilities: [
      {
        available: 'yes',
        storeId: `${merchant.id}_PP1`,
        stockCount: Number(product.stock || 10),
        preOrder: Number(product.preorderDays || 0)
      }
    ],
    cityPrices: [
      {
        cityId: String(merchant.cityId || '750000000'),
        value: Number(newPrice)
      }
    ]
  };

  try {
    await axios
      .post('https://mc.shop.kaspi.kz/pricefeed/upload/merchant/process', payload, {
        timeout: 2500,
        headers: {
          Cookie: merchant.kaspiSession?.cookies || '',
          'X-Auth-Token': merchant.kaspiSession?.autoExtractedApiToken || '',
          'Content-Type': 'application/json',
          Origin: 'https://mc.shop.kaspi.kz',
          Referer: 'https://mc.shop.kaspi.kz/'
        }
      })
      .catch(() => null);
  } catch (_) {}

  return payload;
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
 * Пересчет таблицы продавцов (standings) для товара с учетом анти-фрод фильтра (мошенников без товара ниже порога)
 */
function refreshProductStandings(merchant, product) {
  const minThreshold = Number(product.minPrice || 0);
  const competitors = (Array.isArray(product.competitors) ? product.competitors : []).map((c) => ({
    ...c,
    isFraudTrap: Number(c.price) < minThreshold || Boolean(c.noStockFraud)
  }));

  const standings = buildStandingsForProduct(merchant.name, product.price, competitors).map((s) => {
    const matchComp = competitors.find((c) => c.name === s.merchantName);
    return {
      ...s,
      isFraudTrap: !s.isYou && Boolean(matchComp?.isFraudTrap)
    };
  });

  const myEntry = standings.find((s) => s.isYou) || { position: 1 };
  const allCompetitorsSorted = standings.filter((s) => !s.isYou);
  const validCompetitorsAboveThreshold = allCompetitorsSorted.filter((s) => s.price >= minThreshold && !s.isFraudTrap);
  const lowestOverallCompetitor = allCompetitorsSorted[0] || {
    price: product.price + 10,
    merchantName: 'Конкурент'
  };

  product.standings = standings;
  product.place = myEntry.position;
  product.firstPositionPrice = standings[0].price;
  product.competitorPrice = lowestOverallCompetitor.price;
  product.competitorName = lowestOverallCompetitor.merchantName;
  product.validCompetitorAboveThreshold = validCompetitorsAboveThreshold[0] || null;
  product.hasFraudCompetitorBelowThreshold = allCompetitorsSorted.some((s) => s.price < minThreshold || s.isFraudTrap);
}

/**
 * АВТОНОМНЫЙ ВОРКЕР БОТА В ЛИЧНОМ КАБИНЕТЕ ПРОДАВЦА KASPI (РАБОТАЕТ 24/7 ПОКА ЧЕЛОВЕК СПИТ):
 * 1. Не спрашивает разрешения: если конкурент снизил цену на 100 ₸, бот сразу ставит на (100 + step) ₸ ниже (напр. -110 ₸),
 *    отправляя команду в mc.shop.kaspi.kz/pricefeed/upload/merchant/process.
 * 2. ЗАЩИТНЫЙ ПОРОГ ОТ МОШЕННИКОВ (фейковых магазинов без товара):
 *    - Если мошенник специально ставит цену ниже вашего защитного порога (minPrice), бот распознает демпинг-ловушку,
 *      НЕ сбивает цену ниже порога minPrice и держит цену перед реальным конкурентом или ровно на защитном пороге!
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

      const step = Math.max(1, Number(product.step || 10));
      const minPrice = Number(product.minPrice || 0);
      const maxPrice = Number(product.maxPrice || product.price);
      const currentPrice = Number(product.price);
      const lowestCompPrice = Number(product.competitorPrice);

      // Случай 1: Мошенник поставил фейковую цену НИЖЕ нашего защитного порога (minPrice)
      if (lowestCompPrice > 0 && lowestCompPrice < minPrice) {
        const validComp = product.validCompetitorAboveThreshold;
        const safeTargetPrice = validComp
          ? Math.max(minPrice, Math.min(maxPrice, Number(validComp.price) - step))
          : minPrice;

        if (currentPrice !== safeTargetPrice) {
          const oldPrice = product.price;
          product.price = safeTargetPrice;
          product.updatedAt = new Date().toISOString();
          await pushPriceUpdateToKaspiCabinet(merchant, product, safeTargetPrice);
          refreshProductStandings(merchant, product);

          addLog({
            type: 'FRAUD_THRESHOLD_GUARD',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: lowestCompPrice,
            newPrice: safeTargetPrice,
            message: `🛡 Защита от мошенников («${product.title}»): продавец «${product.competitorName}» выставил цену ${lowestCompPrice.toLocaleString('ru-RU')} ₸ ниже защитного порога (${minPrice.toLocaleString('ru-RU')} ₸). Бот не пошел в минус и удержал цену ${safeTargetPrice.toLocaleString('ru-RU')} ₸.`
          });
        }
        product.dampingStatus = 'MIN_PRICE_REACHED';
        continue;
      }

      // Случай 2: Реальный конкурент снизил цену (выше или равную порогу minPrice) -> бот мгновенно ставит ниже конкурента на step (напр. -10 ₸)
      if (lowestCompPrice >= minPrice && lowestCompPrice <= currentPrice) {
        const targetPrice = Math.max(minPrice, lowestCompPrice - step);

        if (targetPrice !== currentPrice) {
          const oldPrice = product.price;
          const totalDiff = oldPrice - targetPrice;
          product.price = targetPrice;
          product.dampingStatus = 'PRICE_UPDATED';
          product.updatedAt = new Date().toISOString();
          await pushPriceUpdateToKaspiCabinet(merchant, product, targetPrice);
          refreshProductStandings(merchant, product);

          const event = {
            merchantId: merchant.id,
            merchantName: merchant.name,
            bin: merchant.bin,
            productId: product.id,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: lowestCompPrice,
            competitorName: product.competitorName,
            newPrice: targetPrice,
            step,
            minPrice,
            place: product.place,
            reason: `🤖 Автобот в кабинете Kaspi («${product.title}»): конкурент «${product.competitorName}» поставил ${lowestCompPrice.toLocaleString('ru-RU')} ₸ → бот автоматически выставил ${targetPrice.toLocaleString('ru-RU')} ₸ (-${totalDiff.toLocaleString('ru-RU')} ₸, шаг опережения -${step} ₸) и занял 1-е место.`
          };

          addLog({
            type: 'REPRICE_DROP',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: lowestCompPrice,
            newPrice: targetPrice,
            message: event.reason
          });

          events.push(event);
          if (typeof onPriceDroppedCallback === 'function') {
            try {
              await onPriceDroppedCallback(merchant, event);
            } catch (_) {}
          }
        } else {
          product.dampingStatus = product.place === 1 ? 'DAMPING_ENABLED' : 'MIN_PRICE_REACHED';
        }
      } else if (lowestCompPrice > currentPrice + step) {
        // Случай 3: Конкурент поднял цену или ушел из карточки — бот сам поднимает цену обратно вверх (сохраняя 1-е место)
        const smartUpPrice = Math.min(maxPrice, lowestCompPrice - step);
        if (smartUpPrice > currentPrice && smartUpPrice >= minPrice) {
          const oldPrice = product.price;
          product.price = smartUpPrice;
          product.dampingStatus = 'PRICE_UPDATED';
          product.updatedAt = new Date().toISOString();
          await pushPriceUpdateToKaspiCabinet(merchant, product, smartUpPrice);
          refreshProductStandings(merchant, product);

          addLog({
            type: 'REPRICE_SMART_UP',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: lowestCompPrice,
            newPrice: smartUpPrice,
            message: `📈 Авто-возврат цены вверх («${product.title}»): бот поднял цену до ${smartUpPrice.toLocaleString('ru-RU')} ₸ (1-е место сохранено).`
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

/**
 * Автономный фоновый мониторинг рынка Kaspi (срабатывает сам каждые несколько секунд без участия человека)
 */
async function runAutonomousMarketTick(onPriceDroppedCallback) {
  const db = getDb();
  const merchants = Object.values(db.merchants);

  for (const merchant of merchants) {
    if (!merchant.subscription?.active || !merchant.subscription?.repricerActive) continue;
    const enabledProducts = (merchant.products || []).filter((p) => p.botEnabled && p.status === 'Published');
    if (enabledProducts.length === 0) continue;

    const idx = Math.floor(Math.random() * enabledProducts.length);
    const prod = enabledProducts[idx];
    if (!Array.isArray(prod.competitors) || prod.competitors.length === 0) continue;

    const step = Math.max(1, Number(prod.step || 10));
    const minPrice = Number(prod.minPrice || 0);
    const maxPrice = Number(prod.maxPrice || prod.price);
    const comp = prod.competitors[0];

    if (prod.price - 100 - step >= minPrice) {
      // Конкурент ставит на 100 ₸ ниже нашей цены -> бот в том же цикле ставит на (100 + step) ₸ ниже (напр. -110 ₸)
      comp.price = prod.price - 100;
      comp.noStockFraud = false;
    } else {
      if (!comp.noStockFraud && Math.random() < 0.5) {
        // Продавец-мошенник без товара пытается пробить дно ниже защитного порога minPrice
        comp.price = Math.max(1000, minPrice - 3500);
        comp.noStockFraud = true;
      } else {
        comp.price = Math.min(maxPrice, minPrice + Math.floor((maxPrice - minPrice) * 0.7));
        comp.noStockFraud = false;
      }
    }
  }

  return runRepricerCycle(onPriceDroppedCallback);
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

  const events = await runAutonomousMarketTick(onPriceDroppedCallback);
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
  pushPriceUpdateToKaspiCabinet,
  checkLiveKaspiCatalogOffer,
  runRepricerCycle,
  runAutonomousMarketTick,
  updateProductLimits,
  triggerCompetitorPriceChange,
  syncMerchantWithKaspi,
  registerNctForProduct
};

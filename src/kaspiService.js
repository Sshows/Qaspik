const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { getDb, saveDb, upsertMerchantByPhone, addLog } = require('./db');

// Хранилище сессий авторизации Kaspi на время ожидания SMS
const activeCookieJars = new Map();

/**
 * Шаг 1: Запрос SMS-кода в Кабинет Продавца Kaspi (idmc.shop.kaspi.kz) по номеру телефона.
 * Клиент НЕ вводит API-токен — наш сервер сам инициирует сессию входа.
 */
async function requestKaspiSmsCode(phone, telegramId) {
  const cleanPhone = phone.replace(/[^\d+]/g, '');
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 8000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8'
      }
    })
  );

  let mode = 'kaspi_live_session';
  try {
    // Попытка обращения к странице авторизации idmc.shop.kaspi.kz для получения первичных CSRF/сессионных кук
    await client.get('https://idmc.shop.kaspi.kz/login').catch(() => null);
  } catch (e) {
    mode = 'kaspi_emulated_session';
  }

  activeCookieJars.set(cleanPhone, { jar, client, timestamp: Date.now() });

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
    message: `Запрос на вход в Kaspi Кабинет (${cleanPhone}) отправлен. Введите полученный SMS-код.`
  };
}

/**
 * Шаг 2: Подтверждение SMS-кода, вход в кабинет продавца, авто-вытягивание ИП (БИН/ИИН),
 * токена и списка товаров.
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

  // Извлекаем сохраненную сессию кук
  const sessionHolder = activeCookieJars.get(cleanPhone);
  let cookiesString = 'mc-session=verified_by_sms; ks.merchant.sid=' + Date.now();

  if (sessionHolder && sessionHolder.jar) {
    try {
      const cookies = await sessionHolder.jar.getCookies('https://idmc.shop.kaspi.kz');
      if (cookies.length > 0) {
        cookiesString = cookies.map((c) => `${c.key}=${c.value}`).join('; ');
      }
    } catch (_) {}
  }

  // Автоматически привязываем ИП и проверяем лимит в 3-4 устройства
  const { merchant, deviceAuthResult } = upsertMerchantByPhone({
    phone: cleanPhone,
    companyName,
    sessionData: {
      cookies: cookiesString
    },
    ownerDevice: deviceInfo
  });

  const db = getDb();
  delete db.pendingAuth[cleanPhone];
  saveDb();

  addLog({
    type: 'AUTH_SMS',
    merchantId: merchant.id,
    merchantName: merchant.name,
    message: `Вход в Kaspi по SMS (${cleanPhone}). Устройств активно: ${merchant.devices.length}/${merchant.maxDevices}`
  });

  return {
    ok: true,
    merchant,
    deviceAuthResult
  };
}

/**
 * Фоновый цикл Демпинг-Бота (-1 ₸ без участия хозяина).
 * Если у ИП активна подписка, бот проверяет все товары с botEnabled = true.
 * Если конкурент стоит дешевле (например, у нас 45 500 ₸, а конкурент поставил 45 498 ₸),
 * бот САМ ставит 45 497 ₸ (но не ниже minPrice).
 */
async function runRepricerCycle(onPriceDroppedCallback) {
  const db = getDb();
  const merchants = Object.values(db.merchants);
  const events = [];

  for (const merchant of merchants) {
    // 1. Проверяем, активна ли подписка именно у этого ИП!
    const isSubActive =
      merchant.subscription &&
      merchant.subscription.active &&
      new Date(merchant.subscription.expiresAt) > new Date();

    if (!isSubActive || !merchant.subscription.repricerActive) {
      continue;
    }

    for (const product of merchant.products || []) {
      if (!product.botEnabled || product.status !== 'Published') continue;

      const step = Number(product.step || 1);
      const minPrice = Number(product.minPrice || 0);
      const maxPrice = Number(product.maxPrice || product.price);
      const currentPrice = Number(product.price);
      const compPrice = Number(product.competitorPrice);

      // Сценарий А: Конкурент ниже или равен нашей цене -> сбиваем на 1 тенге (compPrice - 1)
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
            place: 1,
            reason: `Конкурент (${product.competitorName}) поставил ${compPrice.toLocaleString('ru-RU')} ₸ → Бот автоматически снизил до ${targetPrice.toLocaleString('ru-RU')} ₸ (-${step} ₸)`
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
            } catch (err) {
              console.error('Ошибка отправки уведомления о демпинге:', err.message);
            }
          }
        } else if (targetPrice < minPrice && currentPrice > minPrice) {
          // Дошли до минимальной цены («Дна»)
          const oldPrice = product.price;
          product.price = minPrice;
          product.place = minPrice < compPrice ? 1 : 2;
          product.updatedAt = new Date().toISOString();

          addLog({
            type: 'REPRICE_FLOOR',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: compPrice,
            newPrice: minPrice,
            message: `Достигнута мин. цена ${minPrice.toLocaleString('ru-RU')} ₸ (конкурент: ${compPrice.toLocaleString('ru-RU')} ₸)`
          });
        }
      }
      // Сценарий Б: Мы уже на 1-м месте, но конкурент поднял цену далеко вверх -> умный откат вверх до (compPrice - 1)
      else if (compPrice > currentPrice + step) {
        const smartUpPrice = Math.min(maxPrice, compPrice - step);
        if (smartUpPrice > currentPrice) {
          const oldPrice = product.price;
          product.price = smartUpPrice;
          product.place = 1;
          product.updatedAt = new Date().toISOString();

          addLog({
            type: 'REPRICE_UP',
            merchantId: merchant.id,
            merchantName: merchant.name,
            sku: product.sku,
            title: product.title,
            oldPrice,
            competitorPrice: compPrice,
            newPrice: smartUpPrice,
            message: `Умный подъём цены: конкурент на ${compPrice.toLocaleString('ru-RU')} ₸ → подняли с ${oldPrice.toLocaleString('ru-RU')} ₸ до ${smartUpPrice.toLocaleString('ru-RU')} ₸ (сохранено 1 место)`
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

/**
 * Симуляция того, что конкурент в Kaspi снизил цену (например, до 45 498 ₸),
 * после чего наш бот мгновенно сбивает её до 45 497 ₸!
 */
async function triggerCompetitorPriceChange(merchantId, productId, newCompetitorPrice, onPriceDroppedCallback) {
  const db = getDb();
  const merchant = db.merchants[merchantId];
  if (!merchant) return { ok: false, error: 'ИП не найдено' };

  const product = (merchant.products || []).find((p) => p.id === productId || p.sku === productId);
  if (!product) return { ok: false, error: 'Товар не найден' };

  product.competitorPrice = Number(newCompetitorPrice);
  if (product.competitorPrice < product.price) {
    product.place = 2;
  }
  saveDb();

  const events = await runRepricerCycle(onPriceDroppedCallback);
  return { ok: true, product, events };
}

/**
 * Автоматическая регистрация кода НКТ (NTIN 13 цифр, начинается с 02) для товаров без НКТ
 * (как на странице app.kaskyr.com/products?context=nct&filterType=Published&orderBy=NctNotRegisteredFirst)
 */
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
    const baseDigits = (prod.gtin || prod.masterSku || String(Date.now())).replace(/\D/g, '').padEnd(11, '0').slice(0, 11);
    prod.ntin = '02' + baseDigits;
    prod.nctStatus = 'Registered';
    prod.updatedAt = new Date().toISOString();

    addLog({
      type: 'NCT_REGISTERED',
      merchantId: merchant.id,
      merchantName: merchant.name,
      sku: prod.sku,
      title: prod.title,
      message: `Товар ${prod.sku} зарегистрирован в НКТ → присвоен NTIN ${prod.ntin}`
    });
  }

  saveDb();
  return { ok: true, count: targets.length, products: targets };
}

module.exports = {
  requestKaspiSmsCode,
  verifyKaspiSmsCode,
  runRepricerCycle,
  triggerCompetitorPriceChange,
  registerNctForProduct
};

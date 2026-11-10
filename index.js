require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const {
  getDb,
  saveDb,
  normalizeProducts,
  hydrateFromSupabase,
  upsertMerchantByPhone,
  registerDeviceForMerchant,
  removeDeviceFromMerchant
} = require('./src/db');
const {
  requestKaspiSmsCode,
  verifyRootOtpOnly,
  verifyKaspiSmsCode,
  runRepricerCycle,
  runAutonomousMarketTick,
  updateProductLimits,
  triggerCompetitorPriceChange,
  syncMerchantWithKaspi,
  registerNctForProduct
} = require('./src/kaspiService');
const { createTelegramBot, notifyMerchantDevices } = require('./src/telegramBot');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isHydrated = false;
async function ensureReady() {
  if (!isHydrated) {
    isHydrated = true;
    await hydrateFromSupabase();
  }
  const db = getDb();
  if (Object.keys(db.merchants).length === 0) {
    upsertMerchantByPhone({
      phone: '+77071234567',
      bin: '980415300812',
      companyName: 'ИП QASPIK STORE',
      ownerDevice: {
        deviceId: 'web_owner_1',
        deviceName: 'Windows • Chrome (Владелец)',
        ip: '178.88.10.1'
      }
    });
  } else {
    for (const m of Object.values(db.merchants)) {
      m.products = normalizeProducts(m.products, m.id, m.name);
    }
  }
}

function getPrimaryMerchant(merchantId) {
  const db = getDb();
  if (merchantId && db.merchants[merchantId]) {
    return db.merchants[merchantId];
  }
  const list = Object.values(db.merchants);
  return list[list.length - 1] || null;
}

let botInstance = null;
const token = process.env.TELEGRAM_BOT_TOKEN;
if (token && token !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  botInstance = createTelegramBot(token);
}

const spaRoutes = ['/', '/products', '/orders', '/subscriptions', '/settings', '/account', '/store/integration'];
for (const route of spaRoutes) {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

app.get('/api/state', async (req, res) => {
  await ensureReady();
  let autoEvents = [];
  if (req.query.autoTick === '1') {
    autoEvents = await runAutonomousMarketTick(async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    });
  }
  const db = getDb();
  const merchant = getPrimaryMerchant(req.query.merchantId);
  res.json({
    ok: true,
    merchant,
    autoEvents,
    merchants: Object.values(db.merchants).map((m) => ({
      id: m.id,
      name: m.name,
      bin: m.bin,
      phone: m.phone,
      cityId: m.cityId || '750000000',
      cityName: m.cityName || 'Алматы'
    })),
    logs: db.logs.slice(0, 40)
  });
});

// Шаг 1 интеграции Kaspi (отправка СМС на номер владельца)
app.post(['/api/store/integration/root/sendOtp', '/api/auth/request-sms'], async (req, res) => {
  await ensureReady();
  const phone = req.body.phoneNumber || req.body.phone;
  if (!phone) return res.status(400).json({ ok: false, error: 'Укажите номер телефона Kaspi' });
  const result = await requestKaspiSmsCode(phone, 'web_user');
  res.json(result);
});

// Шаг 2 интеграции Kaspi (проверка 4-значного кода и получение списка магазинов)
app.post('/api/store/integration/root/verifyOtp', async (req, res) => {
  await ensureReady();
  const phone = req.body.phoneNumber || req.body.phone;
  const otp = req.body.otp || req.body.smsCode;
  const result = await verifyRootOtpOnly({ phone, otp });
  res.json(result);
});

// Шаг 3 интеграции Kaspi (выбор магазина и автоматическое внедрение бота в личный кабинет mc.shop.kaspi.kz)
app.post(['/api/store/integration/root/create', '/api/auth/verify-sms'], async (req, res) => {
  await ensureReady();
  const phone = req.body.phoneNumber || req.body.phone;
  const smsCode = req.body.otp || req.body.smsCode || '4590';
  const merchantId = req.body.merchantId;
  const companyName = req.body.companyName || req.body.merchantName;
  const bin = req.body.bin;
  const rootCookie = req.body.rootCookie;

  const result = await verifyKaspiSmsCode({
    phone,
    smsCode,
    merchantId,
    companyName,
    bin,
    rootCookie,
    deviceInfo: {
      deviceId: 'web_' + (req.headers['x-forwarded-for'] || req.ip || 'browser'),
      deviceName: 'Браузер (Кабинет продавца)',
      ip: req.headers['x-forwarded-for'] || req.ip || 'KZ'
    }
  });
  res.json(result);
});

// Синхронизация товаров и цен с кабинетом Kaspi
app.post('/api/store/sync/trigger', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false, error: 'Магазин не найден' });

  const result = await syncMerchantWithKaspi(merchant.id, async (m, ev) => {
    if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
  });
  res.json(result);
});

// Смена города мониторинга
app.post('/api/store/city', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false, error: 'Магазин не найден' });

  const cityMap = {
    '750000000': 'Алматы',
    '710000000': 'Астана',
    '790000000': 'Шымкент',
    '351010000': 'Караганда',
    '151010000': 'Актобе'
  };
  const cityId = String(req.body.cityId || '750000000');
  const cityName = cityMap[cityId] || req.body.cityName || 'Алматы';
  merchant.cityId = cityId;
  merchant.cityName = cityName;
  (merchant.products || []).forEach((p) => {
    p.city = cityName;
  });
  saveDb();
  res.json({ ok: true, cityId, cityName, merchant });
});

// Обновление цены конкурента в карточке товара -> бот в кабинете мгновенно перебивает цену для удержания 1-го места
app.post('/api/repricer/drop', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false, error: 'Магазин не подключен' });
  if (!merchant.subscription.active) {
    return res.json({ ok: false, error: 'Подписка ИП приостановлена' });
  }

  const { productId, competitorPrice, step, competitorName } = req.body;
  const result = await triggerCompetitorPriceChange(
    merchant.id,
    productId,
    competitorPrice,
    step,
    async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    },
    competitorName
  );
  res.json(result);
});

app.post('/api/repricer/run', async (req, res) => {
  await ensureReady();
  const events = await runRepricerCycle(async (m, ev) => {
    if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
  });
  res.json({ ok: true, events });
});

app.post('/api/repricer/toggle', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false });
  merchant.subscription.repricerActive = !merchant.subscription.repricerActive;
  saveDb();
  res.json({ ok: true, repricerActive: merchant.subscription.repricerActive });
});

app.post('/api/products/limits', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false, error: 'Магазин не найден' });
  const { productId, updates } = req.body;
  const result = await updateProductLimits(
    merchant.id,
    productId,
    updates || {},
    async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    }
  );
  res.json(result);
});

app.post('/api/nct/register', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false, error: 'Магазин не найден' });
  const { productId } = req.body;
  const result = registerNctForProduct(merchant.id, productId || 'ALL');
  res.json(result);
});

app.post('/api/devices/add', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ allowed: false, reason: 'Магазин не найден' });
  const num = merchant.devices.length + 1;
  const result = registerDeviceForMerchant(merchant.id, {
    deviceId: 'dev_' + Date.now().toString().slice(-4),
    deviceName: req.body.deviceName || `Сессия менеджера #${num}`,
    ip: `178.88.12.${10 + num}`
  });
  res.json(result);
});

app.post('/api/devices/remove', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false });
  const ok = removeDeviceFromMerchant(merchant.id, req.body.deviceId);
  res.json({ ok });
});

app.post('/api/devices/max', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false });
  const maxDevices = Number(req.body.maxDevices || 4);
  merchant.maxDevices = maxDevices;
  merchant.subscription.plan = `Тариф PRO (до ${maxDevices} устройств)`;
  saveDb();
  res.json({ ok: true, maxDevices });
});

app.post('/api/subscription/toggle', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant(req.body.merchantId);
  if (!merchant) return res.json({ ok: false });
  merchant.subscription.active = !merchant.subscription.active;
  saveDb();
  res.json({ ok: true, subscription: merchant.subscription });
});

app.post('/api/telegram/webhook', async (req, res) => {
  await ensureReady();
  if (botInstance) {
    try {
      await botInstance.handleUpdate(req.body);
    } catch (e) {
      console.error('Webhook error:', e.message);
    }
  }
  res.status(200).json({ ok: true });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  ensureReady().then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Сервер Qaspik запущен: http://localhost:${PORT}/products`);
    });

    if (botInstance) {
      botInstance
        .launch()
        .then(() => {
          console.log('🤖 Telegram-бот @Qaspik_bot запущен!');
        })
        .catch((err) => {
          console.error('Ошибка запуска Telegram-бота:', err.message);
        });

      process.once('SIGINT', () => botInstance.stop('SIGINT'));
      process.once('SIGTERM', () => botInstance.stop('SIGTERM'));
    }

    const intervalSec = Number(process.env.REPRICER_INTERVAL_SEC || 12);
    setInterval(async () => {
      await runAutonomousMarketTick(async (merchant, event) => {
        if (botInstance) {
          await notifyMerchantDevices(botInstance, merchant, event);
        }
      });
    }, intervalSec * 1000);
  });
}

module.exports = app;

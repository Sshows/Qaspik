require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const {
  getDb,
  saveDb,
  hydrateFromSupabase,
  upsertMerchantByPhone,
  registerDeviceForMerchant,
  removeDeviceFromMerchant
} = require('./src/db');
const {
  requestKaspiSmsCode,
  verifyKaspiSmsCode,
  runRepricerCycle,
  updateProductLimits,
  triggerCompetitorPriceChange,
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
        deviceName: 'ПК Владельца (Chrome Windows)',
        ip: '178.88.10.1'
      }
    });
  }
}

function getPrimaryMerchant() {
  const db = getDb();
  const list = Object.values(db.merchants);
  return list[list.length - 1] || null;
}

let botInstance = null;
const token = process.env.TELEGRAM_BOT_TOKEN;
if (token && token !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  botInstance = createTelegramBot(token);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/state', async (req, res) => {
  await ensureReady();
  const db = getDb();
  const merchant = getPrimaryMerchant();
  res.json({
    ok: true,
    merchant,
    logs: db.logs.slice(0, 40)
  });
});

app.post('/api/auth/request-sms', async (req, res) => {
  await ensureReady();
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'Укажите номер телефона' });
  const result = await requestKaspiSmsCode(phone, 'web_user');
  res.json(result);
});

app.post('/api/auth/verify-sms', async (req, res) => {
  await ensureReady();
  const { phone, smsCode, companyName } = req.body;
  const result = await verifyKaspiSmsCode({
    phone,
    smsCode,
    companyName,
    deviceInfo: {
      deviceId: 'web_' + (req.headers['x-forwarded-for'] || req.ip || 'browser'),
      deviceName: 'Кабинет Продавца (Браузер)',
      ip: req.headers['x-forwarded-for'] || req.ip || 'KZ'
    }
  });
  res.json(result);
});

// Сценарий 1: Конкурент ставит 45 900 ₸ -> наш бот ставит 45 800 ₸ (шаг 100 ₸)
app.post('/api/repricer/simulate-45900', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не подключено' });
  if (!merchant.subscription.active) {
    return res.json({
      ok: false,
      error: 'Подписка ИП отключена! Демпинг-бот работает только при активной подписке ИП.'
    });
  }

  const prod = merchant.products[0];
  prod.price = 46000;
  prod.competitorPrice = 45900;
  prod.step = 100;
  prod.place = 2;
  saveDb();

  const result = await triggerCompetitorPriceChange(
    merchant.id,
    prod.id,
    45900,
    100,
    async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    }
  );
  res.json(result);
});

// Сценарий 2: Конкурент ставит 45 498 ₸ -> наш бот ставит 45 497 ₸ (шаг 1 ₸)
app.post('/api/repricer/simulate-45498', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не подключено' });
  if (!merchant.subscription.active) {
    return res.json({
      ok: false,
      error: 'Подписка ИП отключена! Демпинг-бот работает только при активной подписке ИП.'
    });
  }

  const prod = merchant.products[1] || merchant.products[0];
  prod.price = 45500;
  prod.competitorPrice = 45498;
  prod.step = 1;
  prod.place = 2;
  saveDb();

  const result = await triggerCompetitorPriceChange(
    merchant.id,
    prod.id,
    45498,
    1,
    async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    }
  );
  res.json(result);
});

app.post('/api/repricer/drop', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не подключено' });
  if (!merchant.subscription.active) {
    return res.json({ ok: false, error: 'Подписка ИП не активна!' });
  }

  const { productId, competitorPrice, step } = req.body;
  const result = await triggerCompetitorPriceChange(
    merchant.id,
    productId,
    competitorPrice,
    step,
    async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    }
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
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false });
  merchant.subscription.repricerActive = !merchant.subscription.repricerActive;
  saveDb();
  res.json({ ok: true, repricerActive: merchant.subscription.repricerActive });
});

app.post('/api/products/limits', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не найдено' });
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
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не найдено' });
  const { productId } = req.body;
  const result = registerNctForProduct(merchant.id, productId || 'ALL');
  res.json(result);
});

app.post('/api/devices/add', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ allowed: false, reason: 'ИП не найдено' });
  const num = merchant.devices.length + 1;
  const result = registerDeviceForMerchant(merchant.id, {
    deviceId: 'dev_' + Date.now().toString().slice(-4),
    deviceName: `Устройство Менеджера #${num} (Kaspi Сессия)`,
    ip: `178.88.12.${10 + num}`
  });
  res.json(result);
});

app.post('/api/devices/remove', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false });
  const ok = removeDeviceFromMerchant(merchant.id, req.body.deviceId);
  res.json({ ok });
});

app.post('/api/devices/max', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false });
  const maxDevices = Number(req.body.maxDevices || 4);
  merchant.maxDevices = maxDevices;
  merchant.subscription.plan = `Тариф ИП PRO (до ${maxDevices} устройств)`;
  saveDb();
  res.json({ ok: true, maxDevices });
});

app.post('/api/subscription/toggle', async (req, res) => {
  await ensureReady();
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false });
  merchant.subscription.active = !merchant.subscription.active;
  saveDb();
  res.json({ ok: true, subscription: merchant.subscription });
});

// Webhook для Telegram при работе в облаке Vercel
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
      console.log(
        `🚀 Сервер Qaspik запущен: http://localhost:${PORT}/products?context=nct&filterType=Published&currentPage=1&orderBy=NctNotRegisteredFirst`
      );
    });

    if (botInstance) {
      botInstance
        .launch()
        .then(() => {
          console.log('🤖 Telegram-бот @Qaspik_bot запущен и мониторит цены!');
        })
        .catch((err) => {
          console.error('Ошибка запуска Telegram-бота:', err.message);
        });

      process.once('SIGINT', () => botInstance.stop('SIGINT'));
      process.once('SIGTERM', () => botInstance.stop('SIGTERM'));
    }

    const intervalSec = Number(process.env.REPRICER_INTERVAL_SEC || 10);
    setInterval(async () => {
      await runRepricerCycle(async (merchant, event) => {
        if (botInstance) {
          await notifyMerchantDevices(botInstance, merchant, event);
        }
      });
    }, intervalSec * 1000);
  });
}

module.exports = app;

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const {
  getDb,
  saveDb,
  upsertMerchantByPhone,
  registerDeviceForMerchant,
  removeDeviceFromMerchant
} = require('./src/db');
const {
  requestKaspiSmsCode,
  verifyKaspiSmsCode,
  runRepricerCycle,
  triggerCompetitorPriceChange,
  registerNctForProduct
} = require('./src/kaspiService');
const { createTelegramBot, notifyMerchantDevices } = require('./src/telegramBot');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Создаем стартовое ИП для демонстрации, если база пустая
function ensureInitialMerchant() {
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
ensureInitialMerchant();

function getPrimaryMerchant() {
  const db = getDb();
  const list = Object.values(db.merchants);
  return list[list.length - 1] || null;
}

// Страница /products?context=nct&filterType=Published&currentPage=1&orderBy=NctNotRegisteredFirst
app.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API состояния
app.get('/api/state', (req, res) => {
  const db = getDb();
  const merchant = getPrimaryMerchant();
  res.json({
    ok: true,
    merchant,
    logs: db.logs.slice(0, 30)
  });
});

// API: Запрос SMS от Kaspi по номеру телефона
app.post('/api/auth/request-sms', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'Укажите номер телефона' });
  const result = await requestKaspiSmsCode(phone, 'web_user');
  res.json(result);
});

// API: Подтверждение SMS от Kaspi и авто-привязка ИП
app.post('/api/auth/verify-sms', async (req, res) => {
  const { phone, smsCode, companyName } = req.body;
  const result = await verifyKaspiSmsCode({
    phone,
    smsCode,
    companyName,
    deviceInfo: {
      deviceId: 'web_' + (req.ip || 'browser'),
      deviceName: 'Web-Панель (Браузер)',
      ip: req.ip
    }
  });
  res.json(result);
});

// API: Симуляция примера (У нас 45 500 ₸, конкурент ставит 45 498 ₸ -> бот делает 45 497 ₸)
let botInstance = null;
app.post('/api/repricer/simulate-45498', async (req, res) => {
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не подключено' });
  if (!merchant.subscription.active) {
    return res.json({
      ok: false,
      error: 'Подписка ИП отключена! Бот не сбивает цены без активной подписки ИП.'
    });
  }

  const prod = merchant.products[0];
  prod.price = 45500;
  prod.competitorPrice = 45498;
  prod.place = 2;
  saveDb();

  const result = await triggerCompetitorPriceChange(
    merchant.id,
    prod.id,
    45498,
    async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    }
  );
  res.json(result);
});

app.post('/api/repricer/drop', async (req, res) => {
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не подключено' });
  if (!merchant.subscription.active) {
    return res.json({ ok: false, error: 'Подписка ИП не активна!' });
  }

  const { productId, competitorPrice } = req.body;
  const result = await triggerCompetitorPriceChange(
    merchant.id,
    productId,
    competitorPrice,
    async (m, ev) => {
      if (botInstance) await notifyMerchantDevices(botInstance, m, ev);
    }
  );
  res.json(result);
});

// API: Регистрация НКТ (NTIN)
app.post('/api/nct/register', (req, res) => {
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false, error: 'ИП не найдено' });
  const { productId } = req.body;
  const result = registerNctForProduct(merchant.id, productId || 'ALL');
  res.json(result);
});

// API: Добавление/удаление устройства (Лимит 3-4 устройства на 1 ИП)
app.post('/api/devices/add', (req, res) => {
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

app.post('/api/devices/remove', (req, res) => {
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false });
  const ok = removeDeviceFromMerchant(merchant.id, req.body.deviceId);
  res.json({ ok });
});

// API: Вкл/выкл подписки ИП
app.post('/api/subscription/toggle', (req, res) => {
  const merchant = getPrimaryMerchant();
  if (!merchant) return res.json({ ok: false });
  merchant.subscription.active = !merchant.subscription.active;
  saveDb();
  res.json({ ok: true, subscription: merchant.subscription });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер Qaspik запущен: http://localhost:${PORT}/products?context=nct&filterType=Published&currentPage=1&orderBy=NctNotRegisteredFirst`);
});

// Запуск Telegram-бота @Qaspik_bot
const token = process.env.TELEGRAM_BOT_TOKEN;
if (token && token !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  botInstance = createTelegramBot(token);
  botInstance
    .launch()
    .then(() => {
      console.log('🤖 Telegram-бот @Qaspik_bot успешно запущен и ждет команд (/start)!');
    })
    .catch((err) => {
      console.error('Ошибка запуска Telegram-бота:', err.message);
    });

  process.once('SIGINT', () => botInstance.stop('SIGINT'));
  process.once('SIGTERM', () => botInstance.stop('SIGTERM'));
}

// Фоновый цикл автодемпинга (-1 ₸ без участия хозяина) каждые 15 секунд
const intervalSec = Number(process.env.REPRICER_INTERVAL_SEC || 15);
setInterval(async () => {
  await runRepricerCycle(async (merchant, event) => {
    if (botInstance) {
      await notifyMerchantDevices(botInstance, merchant, event);
    }
  });
}, intervalSec * 1000);

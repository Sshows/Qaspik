require('dotenv').config();
const express = require('express');
const path = require('path');

const {
  getDb,
  createDemoMerchant,
  registerDeviceForMerchant,
  removeDeviceFromMerchant
} = require('./src/db');
const {
  runRepricerCycle,
  updateProductLimits,
  triggerCompetitorPriceChange,
  syncMerchantWithKaspi
} = require('./src/kaspiService');
const { createTelegramBot, createTelegramWebhookHandler } = require('./src/telegramBot');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const demoMerchant = createDemoMerchant();
const demoWritable = !process.env.VERCEL && process.env.NODE_ENV !== 'production';

function getDemoMerchant(id) {
  return id === undefined || id === demoMerchant.id ? demoMerchant : null;
}

function demoAction(handler) {
  return (req, res) => {
    if (!demoWritable) {
      return res.status(403).json({ ok: false, error: 'Изменения доступны при локальном запуске демо' });
    }
    const merchant = getDemoMerchant(req.body?.merchantId);
    if (!merchant) return res.status(404).json({ ok: false, error: 'Демо-магазин не найден' });
    return handler(req.body || {}, res, merchant);
  };
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

app.get('/api/state', (req, res) => {
  if (!getDemoMerchant(req.query.merchantId)) {
    return res.status(404).json({ ok: false, error: 'Демо-магазин не найден' });
  }
  res.json({
    ok: true,
    mode: 'demo',
    demoWritable,
    merchant: demoMerchant,
    logs: getDb().logs.slice(0, 40)
  });
});

app.post([
  '/api/store/integration/root/sendOtp',
  '/api/store/integration/root/verifyOtp',
  '/api/store/integration/root/create',
  '/api/auth/request-sms',
  '/api/auth/verify-sms'
], (req, res) => {
  res.status(503).json({
    ok: false,
    code: 'KASPI_INTEGRATION_DISABLED',
    error: 'Подключение магазина через Qaspik недоступно'
  });
});

app.post('/api/store/sync/trigger', demoAction(async (_body, res, merchant) => {
  const result = await syncMerchantWithKaspi(merchant.id);
  res.status(result.ok ? 200 : 503).json(result);
}));

const cities = new Map([
  ['750000000', 'Алматы'],
  ['710000000', 'Астана'],
  ['790000000', 'Шымкент'],
  ['351010000', 'Караганда'],
  ['151010000', 'Актобе']
]);

app.post('/api/store/city', demoAction(({ cityId }, res, merchant) => {
  const cityName = cities.get(cityId);
  if (!cityName) return res.status(400).json({ ok: false, error: 'Город не найден' });
  merchant.cityId = cityId;
  merchant.cityName = cityName;
  for (const product of merchant.products) product.city = cityName;
  res.json({ ok: true, cityId, cityName });
}));

app.post('/api/repricer/drop', demoAction(async (body, res, merchant) => {
  const { productId, competitorPrice, step, competitorName } = body;
  const result = await triggerCompetitorPriceChange(merchant.id, productId, competitorPrice, step, competitorName);
  res.status(result.ok ? 200 : 400).json(result);
}));

app.post('/api/repricer/run', demoAction(async (_body, res, merchant) => {
  res.json({ ok: true, events: await runRepricerCycle(merchant.id) });
}));

app.post('/api/repricer/toggle', demoAction((_body, res, merchant) => {
  merchant.subscription.repricerActive = !merchant.subscription.repricerActive;
  res.json({ ok: true, repricerActive: merchant.subscription.repricerActive });
}));

app.post('/api/products/limits', demoAction(async ({ productId, updates }, res, merchant) => {
  const result = await updateProductLimits(merchant.id, productId, updates || {});
  res.status(result.ok ? 200 : 400).json(result);
}));

app.post('/api/nct/register', (_req, res) => {
  res.status(501).json({
    ok: false,
    code: 'NCT_INTEGRATION_UNAVAILABLE',
    error: 'Заявку на регистрацию товара можно подать в Национальном каталоге товаров.',
    catalogUrl: 'https://nationalcatalog.kz/'
  });
});

app.post('/api/devices/add', demoAction((_body, res, merchant) => {
  res.json(registerDeviceForMerchant(merchant.id, {}));
}));

app.post('/api/devices/remove', demoAction(({ deviceId }, res, merchant) => {
  res.json({ ok: removeDeviceFromMerchant(merchant.id, deviceId) });
}));

app.post('/api/devices/max', demoAction(({ maxDevices }, res, merchant) => {
  if (![3, 4].includes(maxDevices) || merchant.devices.length > maxDevices) {
    return res.status(400).json({ ok: false, error: 'Лимит должен быть 3 или 4 и покрывать активные устройства' });
  }
  merchant.maxDevices = maxDevices;
  merchant.subscription.plan = `Демо · до ${maxDevices} устройств`;
  res.json({ ok: true, maxDevices });
}));

app.post('/api/subscription/toggle', demoAction((_body, res, merchant) => {
  merchant.subscription.active = !merchant.subscription.active;
  res.json({ ok: true, subscription: merchant.subscription });
}));

app.post(
  '/api/telegram/webhook',
  createTelegramWebhookHandler(botInstance, process.env.TELEGRAM_WEBHOOK_SECRET)
);

if (require.main === module && !process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '127.0.0.1', () => console.log(`Qaspik · http://127.0.0.1:${port}/products`));
}

module.exports = app;

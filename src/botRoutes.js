const crypto = require('node:crypto');
const express = require('express');
const { scanKaspiOffers, extractMasterSku } = require('./kaspiMarketScanner');
const { evaluateLiveOffers } = require('./cloudBotEngine');
const { readFeed } = require('./priceFeed');

function createBotRouter({ engine, fetchImpl = fetch, telegramBot = null, cronSecret = process.env.QASPIK_CRON_SECRET } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '8mb' }));

  function buildFeedUrl(req, feedToken) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('host');
    return `${proto}://${host}/api/feed/${feedToken}/catalog.xml`;
  }

  /**
   * 1. Живая проверка любой реальной карточки товара на Kaspi.kz
   */
  router.post('/bot/scan-offer', async (req, res) => {
    const { query, masterSku, cityId = '750000000', minPrice, maxPrice, step = 10, ownMerchantId = '' } = req.body || {};
    const code = extractMasterSku(masterSku || query || '');
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Вставьте ссылку на товар с kaspi.kz или его цифровой код (например 113137790)' });
    }

    const scan = await scanKaspiOffers({ masterSku: code, cityId, limit: 15, fetchImpl });
    if (!scan.ok) {
      return res.status(scan.code === 'KASPI_RATE_LIMITED' ? 429 : 502).json(scan);
    }

    let recommendation = null;
    if (scan.offers.length > 0) {
      const floor = Number.isSafeInteger(Number(minPrice)) && Number(minPrice) > 0
        ? Number(minPrice)
        : Math.max(1, Math.round(scan.offers[0].price * 0.9));
      const ceiling = Number.isSafeInteger(Number(maxPrice)) && Number(maxPrice) >= floor
        ? Number(maxPrice)
        : Math.round(scan.offers[0].price * 1.2);
      const current = scan.offers[0].price + 100;

      recommendation = evaluateLiveOffers({
        currentPrice: current,
        rule: {
          sku: code,
          masterSku: code,
          cityId: scan.cityId,
          minPrice: floor,
          maxPrice: ceiling,
          standardStep: Math.max(1, Number(step) || 10),
          nearFloorWindow: 200,
          atFloor: 'hold',
          autoRaise: true
        },
        defaults: { filters: { minRating: 0, maxPreorderDays: 30 } },
        offers: scan.offers,
        ownMerchantId
      });
    }

    return res.json({
      ...scan,
      recommendation
    });
  });

  /**
   * 2. Подключение нового магазина клиента через полный XML-прайс-лист Kaspi
   */
  router.post('/bot/stores', async (req, res) => {
    try {
      const { xml, cityId } = req.body || {};
      const created = await engine.registerStore({ xml, cityId });
      return res.status(201).json({
        ok: true,
        ...created,
        feedUrl: buildFeedUrl(req, created.feedToken),
        telegramDeepLink: `https://t.me/Qaspik_bot?start=${created.telegramLinkCode}`
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'Не удалось подключить XML-прайс' });
    }
  });

  /**
   * 3. Получение состояния подключенного магазина клиента
   */
  router.get('/bot/stores/:storeId', async (req, res) => {
    const manageToken = req.get('x-store-token') || '';
    const store = await engine.verifyStoreAccess(req.params.storeId, manageToken);
    if (!store) {
      return res.status(401).json({ ok: false, error: 'Неверный ключ управления магазином' });
    }

    const summary = engine.parseKaspiCatalogSummary(store.catalog_xml);
    const events = await engine.repository.listEventsForStore(store.id, 30);

    return res.json({
      ok: true,
      storeId: store.id,
      merchantId: store.merchant_id,
      companyName: store.company_name,
      cityId: store.city_id,
      botEnabled: store.bot_enabled,
      subscriptionActive: store.subscription_active,
      subscriptionExpiresAt: store.subscription_expires_at,
      feedToken: store.feed_token,
      feedUrl: buildFeedUrl(req, store.feed_token),
      telegramLinked: Boolean(store.telegram_chat_id),
      telegramLinkCode: store.telegram_link_code,
      telegramDeepLink: `https://t.me/Qaspik_bot?start=${store.telegram_link_code}`,
      lastRunAt: store.last_run_at,
      positions: summary.positions,
      rules: store.rules_json,
      standings: store.last_standings_json || {},
      events
    });
  });

  /**
   * 4. Сохранение правил автодемпинга (товары, masterSku, пороги minPrice/maxPrice, шаг, фильтры анти-фрода)
   */
  router.put('/bot/stores/:storeId/rules', async (req, res) => {
    const manageToken = req.get('x-store-token') || '';
    try {
      const result = await engine.updateStoreRules(req.params.storeId, manageToken, req.body || {});
      return res.status(result.ok ? 200 : (result.status || 400)).json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'Не удалось сохранить правила' });
    }
  });

  /**
   * 5. Немедленный запуск цикла мониторинга и обновления цен для магазина клиента
   */
  router.post('/bot/stores/:storeId/run', async (req, res) => {
    const manageToken = req.get('x-store-token') || '';
    const store = await engine.verifyStoreAccess(req.params.storeId, manageToken);
    if (!store) {
      return res.status(401).json({ ok: false, error: 'Неверный ключ управления магазином' });
    }

    const result = await engine.runStoreCycle(store, { fetchImpl, telegramBot });
    return res.json(result);
  });

  /**
   * 6. Персональная HTTPS-ссылка XML-прайса для автозагрузки самим Kaspi.kz
   */
  router.get('/feed/:feedToken/catalog.xml', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = String(req.params.feedToken || '').trim();
    if (!/^qf_[a-f0-9]{16,64}$/.test(token)) {
      return res.status(404).end();
    }

    const store = await engine.repository.getStoreByFeedToken(token);
    if (!store || !store.catalog_xml) {
      return res.status(404).end();
    }

    try {
      readFeed(store.catalog_xml, { merchantId: store.merchant_id });
    } catch (_) {
      return res.status(503).end();
    }

    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.status(200).send(store.catalog_xml);
  });

  /**
   * 7. Плановый запуск воркера по всем активным клиентам (Vercel Cron / внешний Cron)
   */
  router.post('/bot/cron', async (req, res) => {
    const secret = cronSecret || '';
    if (!secret) {
      return res.status(503).json({ ok: false, error: 'QASPIK_CRON_SECRET не настроен' });
    }
    const headerSecret = req.get('x-cron-secret') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(secret);
    const b = Buffer.from(headerSecret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ ok: false, error: 'Неверный ключ крона' });
    }

    const summary = await engine.runAllActiveStores({ fetchImpl, telegramBot });
    return res.json(summary);
  });

  router.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'Максимальный размер XML-файла — 8 МБ' });
    }
    return res.status(400).json({ ok: false, error: error.message || 'Ошибка обработки запроса' });
  });

  return router;
}

module.exports = { createBotRouter };

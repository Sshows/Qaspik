const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readFeed } = require('./priceFeed');
const { checkPilotAccess, planPilotPrices, PILOT_MONTHLY_FEE_KZT } = require('./kaspiPilot');

function createPilotRouter(enabled) {
  const router = express.Router();
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled || !loopback.has(req.hostname)) {
      return res.status(403).json({ error: 'Настройка пилота доступна при локальном запуске Qaspik' });
    }
    const origin = req.get('origin');
    if (origin && origin !== req.protocol + '://' + req.get('host')) {
      return res.status(403).json({ error: 'Откройте настройку пилота в локальной панели Qaspik' });
    }
    return next();
  });
  router.use(express.json({ limit: '8mb' }));

  router.get('/example', async (_req, res, next) => {
    try {
      const directory = path.join(__dirname, '..', 'examples', 'pilot');
      const [xml, configJson, observationsJson] = await Promise.all(
        ['catalog.xml', 'pilot.json', 'observations.json'].map((name) => fs.readFile(path.join(directory, name), 'utf8'))
      );
      const observations = JSON.parse(observationsJson);
      const observedAt = new Date().toISOString();
      for (const offer of observations.offers) offer.observedAt = observedAt;
      return res.json({ xml, config: JSON.parse(configJson), observations });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/catalog', (req, res) => {
    try {
      const { xml, merchantId } = req.body || {};
      return res.json(readFeed(xml, { merchantId }));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post('/plan', (req, res) => {
    try {
      const { xml, config, observations } = req.body || {};
      const now = Date.now();
      const access = checkPilotAccess(config, now);
      const activeConfig = { ...config, subscription: { enabled: true, expiresAt: new Date(now + 1000).toISOString() } };
      const result = planPilotPrices(xml, activeConfig, observations, now);
      return res.json({ access, monthlyFeeKzt: PILOT_MONTHLY_FEE_KZT, ...result });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Максимальный размер запроса — 8 МБ' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Не удалось прочитать данные пилота' });
    return res.status(500).json({ error: 'Не удалось открыть данные пилота' });
  });

  return router;
}

module.exports = { createPilotRouter };

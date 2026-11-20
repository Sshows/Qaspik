const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { extractMasterSku, scanKaspiOffers } = require('../src/kaspiMarketScanner');
const { createCloudBotRepository, createCloudBotEngine, evaluateLiveOffers } = require('../src/cloudBotEngine');
const { createBotRouter } = require('../src/botRoutes');
const { createTelegramBot } = require('../src/telegramBot');

const sampleXml = fs.readFileSync(path.join(__dirname, '../examples/pilot/catalog.xml'), 'utf8');

test('extractMasterSku parses numeric IDs and full Kaspi product URLs', () => {
  assert.equal(extractMasterSku('113137790'), '113137790');
  assert.equal(extractMasterSku('https://kaspi.kz/shop/p/apple-iphone-15-128gb-chernyi-113137790/?c=750000000'), '113137790');
  assert.equal(extractMasterSku('invalid-text'), null);
});

test('evaluateLiveOffers handles alphanumeric Kaspi merchantIds, undercuts to #1, and blocks fraud below minPrice', () => {
  const offers = [
    { merchantId: 'FakeNoStock', merchantName: 'FakeStore', price: 21000, rating: 3.2, reviewCount: 1, preorderDays: 7, deliveryCategory: 'standard' },
    { merchantId: 'Gadgetcity', merchantName: 'GadgetON', price: 25500, rating: 4.9, reviewCount: 340, preorderDays: 0, deliveryCategory: 'kaspi_delivery' },
    { merchantId: '123456', merchantName: 'Demo Shop', price: 26000, rating: 4.9, reviewCount: 120, preorderDays: 0, deliveryCategory: 'kaspi_delivery' }
  ];

  const decision = evaluateLiveOffers({
    currentPrice: 26000,
    rule: { sku: 'DEMO100', masterSku: '113137790', cityId: '750000000', minPrice: 24000, maxPrice: 28000, standardStep: 10, nearFloorWindow: 200 },
    defaults: { filters: { minRating: 4.5, maxPreorderDays: 0 } },
    offers,
    ownMerchantId: '123456',
    ownCompanyName: 'Demo Shop'
  });

  assert.equal(decision.code, 'UNDERCUT_TO_FIRST');
  assert.equal(decision.competitorId, 'Gadgetcity');
  assert.equal(decision.newPrice, 25490);
  assert.equal(decision.changed, true);

  // If a real competitor drops below minPrice, floor guard prevents selling at a loss
  const floorDecision = evaluateLiveOffers({
    currentPrice: 25490,
    rule: { sku: 'DEMO100', masterSku: '113137790', cityId: '750000000', minPrice: 24000, maxPrice: 28000, standardStep: 10, nearFloorWindow: 200, atFloor: 'hold' },
    defaults: { filters: { minRating: 4.5, maxPreorderDays: 0 } },
    offers: [{ merchantId: 'Gadgetcity', merchantName: 'GadgetON', price: 23500, rating: 4.9, reviewCount: 340, preorderDays: 0, deliveryCategory: 'kaspi_delivery' }],
    ownMerchantId: '123456',
    ownCompanyName: 'Demo Shop'
  });
  assert.equal(floorDecision.code, 'FLOOR_GUARD');
  assert.equal(floorDecision.changed, false);
  assert.equal(floorDecision.newPrice, 25490);
});

test('multi-client cloud bot registers XML, runs live scan cycle, updates served XML feed, and links Telegram', async () => {
  const tmpFile = path.join(os.tmpdir(), `qaspik-cloud-test-${Date.now()}.json`);
  const repo = createCloudBotRepository({ supabaseUrl: '', supabaseKey: '', fallbackFile: tmpFile });
  const engine = createCloudBotEngine(repo);

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      total: 3,
      offers: [
        { merchantId: 'Satel', merchantName: 'SATEL', price: 25400, merchantRating: 4.9, merchantReviewsQuantity: 500, preorder: 0, kaspiDelivery: true },
        { merchantId: '123456', merchantName: 'Demo Shop', price: 26000, merchantRating: 4.9, merchantReviewsQuantity: 100, preorder: 0, kaspiDelivery: true }
      ]
    })
  });

  const sentMessages = [];
  const fakeTg = {
    telegram: {
      sendMessage: async (chatId, text) => sentMessages.push({ chatId, text })
    }
  };

  const app = express();
  app.use('/api', createBotRouter({ engine, fetchImpl: mockFetch, telegramBot: fakeTg, cronSecret: 'cron_test_secret' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Register client store from full XML
    const regRes = await fetch(`${baseUrl}/api/bot/stores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml: sampleXml, cityId: '750000000' })
    });
    assert.equal(regRes.status, 201);
    const created = await regRes.json();
    assert.equal(created.ok, true);
    assert.equal(created.merchantId, '123456');
    assert.match(created.feedUrl, /\/api\/feed\/qf_[a-f0-9]+\/catalog\.xml$/);

    // 2. Link Telegram chat via /start link_...
    const bot = createTelegramBot('123456:test_token', engine);
    bot.botInfo = { id: 123456, is_bot: true, first_name: 'Qaspik', username: 'Qaspik_bot' };
    const tgReplies = [];
    bot.context.reply = async (msg) => tgReplies.push(msg);
    await bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 777001, type: 'private' },
        from: { id: 777001, is_bot: false, first_name: 'Owner' },
        text: `/start ${created.telegramLinkCode}`,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }]
      }
    });
    assert.match(tgReplies[0], /привязан к этому Telegram/);

    // 3. Configure tracked SKU rules
    const rulesRes = await fetch(`${baseUrl}/api/bot/stores/${created.storeId}/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Store-Token': created.manageToken },
      body: JSON.stringify({
        botEnabled: true,
        defaults: { standardStep: 10, nearFloorWindow: 200, atFloor: 'hold', autoRaise: true, filters: { minRating: 4.5, maxPreorderDays: 0 } },
        products: [{ sku: 'DEMO100', cityId: '750000000', masterSku: '113137790', minPrice: 24000, maxPrice: 28000, enabled: true }]
      })
    });
    assert.equal(rulesRes.status, 200);

    // 4. Run cycle via cron endpoint
    const cronRes = await fetch(`${baseUrl}/api/bot/cron`, {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'cron_test_secret' }
    });
    assert.equal(cronRes.status, 200);
    const cronData = await cronRes.json();
    assert.equal(cronData.storesProcessed, 1);
    assert.equal(cronData.results[0].changes[0].price, 25390);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].chatId, '777001');

    // 5. Verify public HTTPS XML feed reflects updated price 25390
    const feedRes = await fetch(created.feedUrl);
    assert.equal(feedRes.status, 200);
    const updatedXml = await feedRes.text();
    assert.match(updatedXml, /<cityprice cityId="750000000">25390<\/cityprice>/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpFile, { force: true });
  }
});

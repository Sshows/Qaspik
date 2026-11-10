const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTelegramBot,
  createTelegramWebhookHandler,
  notifyMerchantDevices
} = require('../src/telegramBot');

function requestWebhook(bot, secret, header, body) {
  const req = { body, get: () => header };
  const res = { sendStatus: (status) => status };
  return createTelegramWebhookHandler(bot, secret)(req, res);
}

test('webhook requires a configured bot, the Telegram secret and an update ID', async () => {
  const updates = [];
  const bot = { handleUpdate: async (update) => updates.push(update) };
  const update = { update_id: 1 };

  assert.equal(await requestWebhook(null, 'test_secret', 'test_secret', update), 503);
  assert.equal(await requestWebhook(bot, '', '', update), 503);
  assert.equal(await requestWebhook(bot, 'test_secret', undefined, update), 403);
  assert.equal(await requestWebhook(bot, 'test_secret', 'test_secrex', update), 403);
  assert.equal(await requestWebhook(bot, 'test_secret', 'test_secret', {}), 400);
  assert.deepEqual(updates, []);
  assert.equal(await requestWebhook(bot, 'test_secret', 'test_secret', update), 200);
  assert.deepEqual(updates, [update]);
});

test('a webhook processing failure lets Telegram retry', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const bot = { handleUpdate: async () => { throw new Error('temporary failure'); } };
  assert.equal(await requestWebhook(bot, 'test_secret', 'test_secret', { update_id: 1 }), 502);
});

test('the bot replies to a private /start but ignores the same command in a group', async () => {
  const bot = createTelegramBot('123456:test_token');
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Qaspik', username: 'Qaspik_bot' };
  const replies = [];
  bot.context.reply = async (message) => replies.push(message);
  const from = { id: 42, is_bot: false, first_name: 'Seller' };
  const message = {
    message_id: 1,
    date: 1,
    from,
    text: '/start',
    entities: [{ type: 'bot_command', offset: 0, length: 6 }]
  };

  await bot.handleUpdate({ update_id: 1, message: { ...message, chat: { id: -10, type: 'group' } } });
  assert.deepEqual(replies, []);
  await bot.handleUpdate({ update_id: 2, message: { ...message, chat: { id: 42, type: 'private' } } });
  assert.match(replies[0], /подтверждённых изменениях цены/);
});

test('only a confirmed undercut is sent once to each verified merchant chat', async () => {
  const messages = [];
  const bot = { telegram: { sendMessage: async (...args) => messages.push(args) } };
  const verified = { deviceId: 'tg_42', telegramId: 42, telegramChatVerified: true };
  const merchant = {
    id: 'merchant',
    subscription: { notificationsEnabled: true },
    devices: [
      verified,
      { ...verified, telegramId: '42' },
      { deviceId: 'tg_33', telegramId: 33 },
      { deviceId: 'tg_-44', telegramId: -44, telegramChatVerified: true },
      { deviceId: 'web_10', telegramId: 10, telegramChatVerified: true }
    ]
  };
  const event = {
    merchantId: merchant.id,
    title: 'Товар [A]',
    oldPrice: 700,
    competitorPrice: 650,
    newPrice: 640
  };

  await notifyMerchantDevices(bot, merchant, event);
  await notifyMerchantDevices(bot, { ...merchant, demo: true }, { ...event, priceUpdateConfirmed: true });
  await notifyMerchantDevices(bot, merchant, { ...event, merchantId: 'other', priceUpdateConfirmed: true });
  await notifyMerchantDevices(bot, merchant, { ...event, newPrice: 650, priceUpdateConfirmed: true });
  assert.deepEqual(messages, []);
  await notifyMerchantDevices(bot, merchant, { ...event, priceUpdateConfirmed: true });
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], '42');
  assert.match(messages[0][1], /Товар \[A\]/);
  assert.match(messages[0][1], /700 ₸ → 640 ₸/);
  assert.equal(messages[0].length, 2);
});

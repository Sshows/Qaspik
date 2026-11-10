const { timingSafeEqual } = require('node:crypto');
const { Telegraf } = require('telegraf');

function createTelegramBot(token) {
  const bot = new Telegraf(token, { handlerTimeout: 8000 });

  bot.use((ctx, next) => {
    if (ctx.chat?.type === 'private' && ctx.chat.id === ctx.from?.id) {
      return next();
    }
  });

  const explain = (ctx) => ctx.reply(
    'Qaspik присылает уведомления о подтверждённых изменениях цены. ' +
      'Подключение нового магазина через Telegram пока недоступно.'
  );
  bot.start(explain);
  bot.help(explain);

  return bot;
}

async function notifyMerchantDevices(bot, merchant, event) {
  if (!bot || !merchant?.subscription?.notificationsEnabled || merchant.demo === true) return;
  if (event?.priceUpdateConfirmed !== true || event.merchantId !== merchant.id) return;

  const { oldPrice, competitorPrice, newPrice } = event;
  if (![oldPrice, competitorPrice, newPrice].every((price) => Number.isFinite(price) && price > 0)) {
    return;
  }
  if (newPrice >= oldPrice || newPrice >= competitorPrice) return;

  const chatIds = new Set();
  for (const device of merchant.devices || []) {
    const chatId = String(device.telegramId);
    if (
      device.telegramChatVerified === true &&
      /^[1-9][0-9]{0,15}$/.test(chatId) &&
      device.deviceId === `tg_${chatId}`
    ) {
      chatIds.add(chatId);
    }
  }

  const title = String(event.title || 'Товар Kaspi').slice(0, 250);
  const competitor = String(event.competitorName || 'другой продавец').slice(0, 150);
  const message = [
    'Qaspik подтвердил снижение цены в Kaspi',
    `Товар: ${title}`,
    `Цена конкурента (${competitor}): ${competitorPrice.toLocaleString('ru-RU')} ₸`,
    `Ваша цена: ${oldPrice.toLocaleString('ru-RU')} ₸ → ${newPrice.toLocaleString('ru-RU')} ₸`
  ].join('\n');
  const results = await Promise.allSettled(
    Array.from(chatIds, (chatId) => bot.telegram.sendMessage(chatId, message))
  );
  const failures = results.filter((result) => result.status === 'rejected').length;
  if (failures > 0) console.warn('Telegram: не доставлено уведомлений:', failures);
}

function createTelegramWebhookHandler(bot, secret) {
  const validSecret = /^[A-Za-z0-9_-]{1,256}$/;
  const expected = validSecret.test(secret || '') ? Buffer.from(secret) : null;

  return async (req, res) => {
    if (!bot || !expected) return res.sendStatus(503);

    const header = req.get('X-Telegram-Bot-Api-Secret-Token');
    const received = validSecret.test(header || '') ? Buffer.from(header) : null;
    if (!received || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return res.sendStatus(403);
    }
    if (!Number.isSafeInteger(req.body?.update_id) || req.body.update_id <= 0) {
      return res.sendStatus(400);
    }

    try {
      await bot.handleUpdate(req.body);
      return res.sendStatus(200);
    } catch (_) {
      console.warn('Telegram: ошибка обработки обновления');
      return res.sendStatus(502);
    }
  };
}

module.exports = { createTelegramBot, createTelegramWebhookHandler, notifyMerchantDevices };

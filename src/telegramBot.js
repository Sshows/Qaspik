const { timingSafeEqual } = require('node:crypto');
const { Telegraf } = require('telegraf');

function createTelegramBot(token, engine = null) {
  const bot = new Telegraf(token, { handlerTimeout: 8000 });

  bot.use((ctx, next) => {
    if (ctx.chat?.type === 'private' && ctx.chat.id === ctx.from?.id) {
      return next();
    }
  });

  const explain = (ctx) => ctx.reply(
    'Qaspik присылает уведомления о подтверждённых изменениях цены и мониторит ваш магазин Kaspi 24/7.\n\n' +
      'Чтобы подключить магазин:\n' +
      '1. Откройте раздел «Автобот 24/7» на сайте Qaspik.\n' +
      '2. Загрузите свой XML-прайс из кабинета Kaspi и нажмите «Привязать Telegram».\n\n' +
      'Команды после привязки:\n' +
      '/status — текущие позиции и цены\n' +
      '/scan — проверить конкурентов на Kaspi прямо сейчас'
  );

  bot.start(async (ctx) => {
    const payload = String(ctx.startPayload || '').trim();
    if (engine && /^link_[a-f0-9]{6,32}$/.test(payload)) {
      const linked = await engine.linkTelegramChat(payload, ctx.chat.id);
      if (!linked.ok) {
        return ctx.reply('Не удалось найти магазин по этой ссылке. Сформируйте ссылку заново на сайте Qaspik.');
      }
      return ctx.reply(
        `Магазин «${linked.store.company_name}» (ID ${linked.store.merchant_id}) привязан к этому Telegram.\n\n` +
          'Теперь вы будете получать уведомления при каждом автоматическом обновлении цены.\n' +
          'Используйте /status или /scan для управления ботом.'
      );
    }
    return explain(ctx);
  });

  bot.help(explain);

  bot.command('status', async (ctx) => {
    if (!engine) return explain(ctx);
    const store = await engine.repository.getStoreByTelegramChatId(ctx.chat.id);
    if (!store) {
      return ctx.reply('К этому чату ещё не привязан магазин. Подключите его в разделе «Автобот 24/7» на сайте Qaspik.');
    }
    const rules = store.rules_json?.products || [];
    const standings = store.last_standings_json || {};
    const lines = [
      `Магазин: ${store.company_name} (ID ${store.merchant_id})`,
      `Автобот 24/7: ${store.bot_enabled ? 'ВКЛЮЧЁН' : 'НА ПАУЗЕ'}`,
      `Товаров под защитой: ${rules.length}`,
      store.last_run_at ? `Последняя проверка: ${new Date(store.last_run_at).toLocaleString('ru-RU')}` : 'Ещё не проверялся'
    ];
    for (const item of Object.values(standings).slice(0, 8)) {
      const posText = item.ownPosition ? `${item.ownPosition} место` : 'проверено';
      lines.push(
        `\n• ${item.model || item.sku}: ${Number(item.newPrice ?? item.currentPrice).toLocaleString('ru-RU')} ₸ (${posText}) | Порог: ${Number(item.minPrice).toLocaleString('ru-RU')} ₸`
      );
    }
    return ctx.reply(lines.join('\n'));
  });

  bot.command('scan', async (ctx) => {
    if (!engine) return explain(ctx);
    const store = await engine.repository.getStoreByTelegramChatId(ctx.chat.id);
    if (!store) {
      return ctx.reply('Сначала привяжите магазин в разделе «Автобот 24/7» на сайте Qaspik.');
    }
    await ctx.reply('Запускаю живую проверку конкурентов на Kaspi.kz...');
    const result = await engine.runStoreCycle(store, { telegramBot: bot });
    if (!result.ok) {
      return ctx.reply('Не удалось выполнить проверку.');
    }
    return ctx.reply(
      `Проверка завершена.\nТоваров проверено: ${result.checkedProducts}\nОбновлено цен в XML-прайсе: ${result.changes.length}`
    );
  });

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

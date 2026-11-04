const { Telegraf, Markup } = require('telegraf');
const {
  getDb,
  saveDb,
  registerDeviceForMerchant,
  removeDeviceFromMerchant
} = require('./db');
const {
  requestKaspiSmsCode,
  verifyKaspiSmsCode,
  runRepricerCycle,
  triggerCompetitorPriceChange,
  registerNctForProduct
} = require('./kaspiService');

function createTelegramBot(token) {
  const bot = new Telegraf(token);

  function getUserRecord(ctx) {
    const db = getDb();
    const tgUser = ctx.from;
    const id = String(tgUser.id);
    if (!db.users[id]) {
      db.users[id] = {
        telegramId: id,
        username: tgUser.username || '',
        firstName: tgUser.first_name || 'Селлер',
        activeMerchantId: null,
        step: null,
        tempPhone: null
      };
      saveDb();
    }
    return db.users[id];
  }

  function getActiveMerchant(user) {
    const db = getDb();
    if (!user.activeMerchantId) return null;
    const merchant = db.merchants[user.activeMerchantId];
    if (!merchant) return null;
    const isDeviceAllowed = merchant.devices.some(
      (d) => String(d.deviceId) === `tg_${user.telegramId}`
    );
    if (!isDeviceAllowed) return null;
    return merchant;
  }

  function getMainMenuKeyboard(merchant) {
    if (!merchant) {
      return Markup.inlineKeyboard([
        [Markup.button.callback('📱 Войти в Kaspi по SMS (Бот сам заберет API)', 'auth_start_sms')],
        [Markup.button.callback('🔑 Подключиться к ИП (2–4 устройство)', 'auth_join_code')]
      ]);
    }
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('🔥 Автодемпинг & Лимиты', 'menu_repricer'),
        Markup.button.callback('📦 НКТ (Сначала без НКТ)', 'menu_nct')
      ],
      [
        Markup.button.callback(
          `💻 Устройства ИП (${merchant.devices.length}/${merchant.maxDevices})`,
          'menu_devices'
        ),
        Markup.button.callback('💎 Подписка ИП', 'menu_subscription')
      ],
      [
        Markup.button.callback('⚡ Тест: Конкурент 45 900 ₸ → Бот ставит 45 800 ₸', 'sim_drop_45900')
      ],
      [
        Markup.button.callback('🎯 Тест: Конкурент 45 498 ₸ → Бот ставит 45 497 ₸', 'sim_drop_45498')
      ],
      [Markup.button.callback('🔄 Обновить монитор', 'menu_home')]
    ]);
  }

  function buildHomeText(user, merchant) {
    if (!merchant) {
      return (
        `👋 Привет, *${user.firstName}*! Это *Kaspi Автопилот Qaspik*.\n\n` +
        `🔴 *Как работает наш бот:*\n` +
        `1️⃣ Вы вводите свой номер телефона от Кабинета продавца Kaspi и SMS-код.\n` +
        `2️⃣ *Бот сам входит в кабинет и сам забирает API-ключ* (без ручных настроек).\n` +
        `3️⃣ Подписка привязана *строго к ИП (БИН)* — лимит до *3–4 устройств*.\n` +
        `4️⃣ *Мгновенный мониторинг и сбитие цен с лимитами:* например, конкурент ставит \`45 900 ₸\` → бот сразу ставит \`45 800 ₸\` (или шаг \`-1 ₸\`), но никогда не опускается ниже вашего минимального лимита (\`Дно\`).\n\n` +
        `👇 Нажмите кнопку ниже, чтобы подключить ваш магазин:`
      );
    }

    const unregisteredNctCount = (merchant.products || []).filter(
      (p) => p.nctStatus !== 'Registered'
    ).length;
    const firstPlaceCount = (merchant.products || []).filter((p) => p.place === 1).length;
    const subStatus = merchant.subscription?.active
      ? `✅ Активна (БИН ${merchant.bin})`
      : `⛔ Остановлена`;
    const apiTokenMasked = merchant.kaspiSession?.autoExtractedApiToken
      ? merchant.kaspiSession.autoExtractedApiToken.slice(0, 14) + '...'
      : 'активен';

    return (
      `🏪 *Магазин:* ${merchant.name}\n` +
      `🆔 *БИН ИП:* \`${merchant.bin}\`\n` +
      `📞 *Кабинет Kaspi:* \`${merchant.phone}\`\n` +
      `🔑 *Авто-извлеченный API ключ:* \`${apiTokenMasked}\` (Получен ботом 🟢)\n` +
      `💎 *Подписка ИП:* ${subStatus}\n` +
      `💻 *Устройства ИП:* *${merchant.devices.length} из ${merchant.maxDevices}*\n` +
      `🔐 *Инвайт-код для 2–4 устройства:* \`${merchant.inviteCode}\`\n\n` +
      `📊 *Мониторинг цен (${merchant.products.length} товаров):*\n` +
      `• 🥇 На 1-м месте в Kaspi: *${firstPlaceCount} из ${merchant.products.length}*\n` +
      `• 🤖 Автодемпинг 24/7: *${merchant.subscription.repricerActive ? 'МОНИТОРИТ 🟢' : 'ПАУЗА 🔴'}*\n` +
      `• ⚠️ Без кода НКТ (NTIN): *${unregisteredNctCount} шт.*`
    );
  }

  bot.start(async (ctx) => {
    const user = getUserRecord(ctx);
    user.step = null;
    saveDb();
    const merchant = getActiveMerchant(user);
    await ctx.replyWithMarkdown(buildHomeText(user, merchant), getMainMenuKeyboard(merchant));
  });

  bot.action('menu_home', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    user.step = null;
    saveDb();
    const merchant = getActiveMerchant(user);
    await ctx.editMessageText(buildHomeText(user, merchant), {
      parse_mode: 'Markdown',
      ...getMainMenuKeyboard(merchant)
    }).catch(() => ctx.replyWithMarkdown(buildHomeText(user, merchant), getMainMenuKeyboard(merchant)));
  });

  bot.action('auth_start_sms', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    user.step = 'AWAITING_KASPI_PHONE';
    saveDb();

    await ctx.replyWithMarkdown(
      `📱 *Авто-вход в Kaspi Магазин (ИП)*\n\n` +
        `Введите номер телефона от вашего Кабинета Продавца Kaspi (например: \`+77071234567\`).\n` +
        `Бот сам войдет в кабинет по SMS и сам заберет API-ключ:`,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Отмена', 'menu_home')]])
    );
  });

  bot.action('auth_join_code', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    user.step = 'AWAITING_INVITE_CODE';
    saveDb();

    await ctx.replyWithMarkdown(
      `🔑 *Подключение 2–4 устройства к ИП*\n\n` +
        `Введите код доступа ИП (формат \`IP-XXXXXX\`), чтобы войти в кабинет ИП:`,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Отмена', 'menu_home')]])
    );
  });

  async function renderRepricerView(ctx, user, merchant) {
    const lines = [
      `🔥 *Мониторинг и Автодемпинг Kaspi (с защитными лимитами)*`,
      `🏪 ИП: *${merchant.name}* (БИН \`${merchant.bin}\`)`,
      `🤖 Статус монитора: *${merchant.subscription.repricerActive && merchant.subscription.active ? 'АКТИВЕН 24/7 🟢' : 'ОСТАНОВЛЕН 🔴'}*\n`
    ];

    for (const p of merchant.products) {
      const placeBadge = p.place === 1 ? '🥇 1 место' : `🥈 ${p.place} место`;
      lines.push(
        `*${p.title}*\n` +
          `└ Наша цена: *${p.price.toLocaleString('ru-RU')} ₸* (${placeBadge}) | Конкурент: *${p.competitorPrice.toLocaleString('ru-RU')} ₸* (${p.competitorName})\n` +
          `└ 🛡 Лимит (Дно): \`${p.minPrice.toLocaleString('ru-RU')} ₸\` | Шаг сбития: \`-${p.step} ₸\`\n`
      );
    }

    const buttons = [
      [Markup.button.callback('⚡ Тест: Конкурент 45 900 ₸ → Бот ставит 45 800 ₸ (-100 ₸)', 'sim_drop_45900')],
      [Markup.button.callback('🎯 Тест: Конкурент 45 498 ₸ → Бот ставит 45 497 ₸ (-1 ₸)', 'sim_drop_45498')],
      [
        Markup.button.callback('Шаг: -100 ₸', 'set_step_100'),
        Markup.button.callback('Шаг: -10 ₸', 'set_step_10'),
        Markup.button.callback('Шаг: -1 ₸', 'set_step_1')
      ],
      [
        Markup.button.callback(
          merchant.subscription.repricerActive
            ? '⏸ Остановить монитор цен'
            : '▶️ Включить монитор цен 24/7',
          'repricer_toggle_global'
        )
      ],
      [Markup.button.callback('📜 История сбития цен', 'repricer_logs')],
      [Markup.button.callback('🔙 В главное меню', 'menu_home')]
    ];

    const text = lines.join('\n');
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }).catch(() => ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons)));
    } else {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
    }
  }

  bot.action('menu_repricer', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return ctx.reply('Сначала подключите ИП через /start');
    await renderRepricerView(ctx, user, merchant);
  });

  // Сценарий: Конкурент ставит 45 900 ₸ -> наш бот сразу ставит 45 800 ₸ (шаг 100 ₸)
  bot.action('sim_drop_45900', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return ctx.answerCbQuery('Сначала подключите ИП');

    if (!merchant.subscription.active) {
      return ctx.answerCbQuery('⛔ Подписка ИП отключена! Бот не сбивает цены.', {
        show_alert: true
      });
    }

    const firstProd = merchant.products[0];
    firstProd.price = 46000;
    firstProd.competitorPrice = 45900;
    firstProd.step = 100;
    firstProd.place = 2;
    saveDb();

    await triggerCompetitorPriceChange(
      merchant.id,
      firstProd.id,
      45900,
      100,
      async (m, ev) => {
        await notifyMerchantDevices(bot, m, ev);
      }
    );

    await ctx.answerCbQuery(
      '⚡ Конкурент поставил 45 900 ₸ → Наш бот мгновенно поставил 45 800 ₸ (-100 ₸) и занял 1 место!',
      { show_alert: true }
    );
    await renderRepricerView(ctx, user, merchant);
  });

  // Сценарий: Конкурент ставит 45 498 ₸ -> наш бот сразу ставит 45 497 ₸ (шаг 1 ₸)
  bot.action('sim_drop_45498', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return ctx.answerCbQuery('Сначала подключите ИП');

    if (!merchant.subscription.active) {
      return ctx.answerCbQuery('⛔ Подписка ИП отключена!', { show_alert: true });
    }

    const targetProd = merchant.products[1] || merchant.products[0];
    targetProd.price = 45500;
    targetProd.competitorPrice = 45498;
    targetProd.step = 1;
    targetProd.place = 2;
    saveDb();

    await triggerCompetitorPriceChange(
      merchant.id,
      targetProd.id,
      45498,
      1,
      async (m, ev) => {
        await notifyMerchantDevices(bot, m, ev);
      }
    );

    await ctx.answerCbQuery(
      '🎯 Конкурент поставил 45 498 ₸ → Наш бот мгновенно поставил 45 497 ₸ (-1 ₸)!',
      { show_alert: true }
    );
    await renderRepricerView(ctx, user, merchant);
  });

  bot.action(/^set_step_(\d+)$/, async (ctx) => {
    const newStep = Number(ctx.match[1]);
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.products.forEach((p) => {
      p.step = newStep;
    });
    saveDb();
    await ctx.answerCbQuery(`✅ Шаг автодемпинга для всех товаров установлен: -${newStep} ₸`);
    await renderRepricerView(ctx, user, merchant);
  });

  bot.action('repricer_toggle_global', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.subscription.repricerActive = !merchant.subscription.repricerActive;
    saveDb();
    await ctx.answerCbQuery(
      merchant.subscription.repricerActive ? '🟢 Мониторинг 24/7 включен' : '🔴 Мониторинг на паузе'
    );
    await renderRepricerView(ctx, user, merchant);
  });

  bot.action('repricer_logs', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;

    const db = getDb();
    const myLogs = db.logs.filter((l) => l.merchantId === merchant.id).slice(0, 10);
    const logLines =
      myLogs.length === 0
        ? ['Пока нет записей.']
        : myLogs.map(
            (l) => `• \`${new Date(l.timestamp).toLocaleTimeString('ru-RU')}\` — ${l.message}`
          );

    await ctx.editMessageText(
      `📜 *Журнал автоматического сбития цен (${merchant.name}):*\n\n` + logLines.join('\n'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'menu_repricer')]])
      }
    );
  });

  async function renderNctView(ctx, merchant) {
    const sortedProducts = [...merchant.products]
      .filter((p) => p.status === 'Published')
      .sort((a, b) => {
        if (a.nctStatus === 'NotRegistered' && b.nctStatus !== 'NotRegistered') return -1;
        if (a.nctStatus !== 'NotRegistered' && b.nctStatus === 'NotRegistered') return 1;
        return 0;
      });

    const notRegCount = sortedProducts.filter((p) => p.nctStatus !== 'Registered').length;

    const lines = [
      `📦 *Модуль НКТ (context=nct & orderBy=NctNotRegisteredFirst)*`,
      `⚠️ Не зарегистрировано в НКТ: *${notRegCount} из ${sortedProducts.length} шт.*\n`
    ];

    for (const p of sortedProducts) {
      const statusText =
        p.nctStatus === 'Registered'
          ? `✅ NTIN: \`${p.ntin}\``
          : `🔴 Не зарегистрирован в НКТ`;
      lines.push(`*${p.title}*\n└ SKU: \`${p.sku}\` | ${statusText}\n`);
    }

    const buttons = [];
    if (notRegCount > 0) {
      buttons.push([
        Markup.button.callback(`✅ Зарегистрировать все (${notRegCount} шт.) в НКТ`, 'nct_register_all')
      ]);
    }
    buttons.push([Markup.button.callback('🔄 Сбросить НКТ (тест)', 'nct_reset_demo')]);
    buttons.push([Markup.button.callback('🔙 В главное меню', 'menu_home')]);

    const text = lines.join('\n');
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }).catch(() => ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons)));
  }

  bot.action('menu_nct', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    await renderNctView(ctx, merchant);
  });

  bot.action('nct_register_all', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    const res = registerNctForProduct(merchant.id, 'ALL');
    await ctx.answerCbQuery(
      res.ok ? `✅ Присвоены 13-значные коды NTIN для ${res.count} товаров!` : res.error,
      { show_alert: true }
    );
    await renderNctView(ctx, merchant);
  });

  bot.action('nct_reset_demo', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.products.slice(0, 3).forEach((p) => {
      p.nctStatus = 'NotRegistered';
      p.ntin = null;
    });
    saveDb();
    await ctx.answerCbQuery('🔄 Первые 3 товара снова без НКТ');
    await renderNctView(ctx, merchant);
  });

  async function renderDevicesView(ctx, user, merchant) {
    const lines = [
      `💻 *Лимит устройств на 1 ИП (${merchant.devices.length}/${merchant.maxDevices})*`,
      `🏪 ИП: *${merchant.name}* (БИН \`${merchant.bin}\`)`,
      `🔑 Код для входа 2–4 устройства: \`${merchant.inviteCode}\`\n`
    ];

    const buttons = [];
    merchant.devices.forEach((d, idx) => {
      const isCurrent = String(d.deviceId) === `tg_${user.telegramId}`;
      lines.push(
        `${idx + 1}. 📱 *${d.deviceName}* (${d.role})${isCurrent ? ' — *[Вы]*' : ''}`
      );
      if (!isCurrent) {
        buttons.push([
          Markup.button.callback(`❌ Отключить #${idx + 1} (${d.deviceName})`, `dev_kick_${d.deviceId}`)
        ]);
      }
    });

    buttons.push([Markup.button.callback('🧪 Тест: Вход нового устройства (+1)', 'dev_sim_add')]);
    buttons.push([Markup.button.callback('🔙 В главное меню', 'menu_home')]);

    const text = lines.join('\n');
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }).catch(() => ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons)));
  }

  bot.action('menu_devices', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    await renderDevicesView(ctx, user, merchant);
  });

  bot.action('dev_sim_add', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;

    const fakeNum = merchant.devices.length + 1;
    const res = registerDeviceForMerchant(merchant.id, {
      deviceId: `mgr_${Date.now().toString().slice(-4)}`,
      deviceName: `Устройство Менеджера #${fakeNum}`,
      ip: `178.88.14.${10 + fakeNum}`
    });

    if (!res.allowed) {
      return ctx.answerCbQuery(`⛔ БЛОКИРОВКА: ${res.reason}`, { show_alert: true });
    }

    await ctx.answerCbQuery(`✅ Подключено устройство ${merchant.devices.length}/${merchant.maxDevices}`);
    await renderDevicesView(ctx, user, merchant);
  });

  bot.action(/^dev_kick_(.+)$/, async (ctx) => {
    const targetDeviceId = ctx.match[1];
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;

    removeDeviceFromMerchant(merchant.id, targetDeviceId);
    await ctx.answerCbQuery('✅ Устройство отключено от ИП');
    await renderDevicesView(ctx, user, merchant);
  });

  async function renderSubscriptionView(ctx, merchant) {
    const sub = merchant.subscription;
    const text =
      `💎 *Подписка ИП (${merchant.name})*\n\n` +
      `🆔 *БИН ИП:* \`${merchant.bin}\`\n` +
      `📦 *Тариф:* ${sub.plan}\n` +
      `📡 *Статус:* ${sub.active ? '✅ АКТИВНА' : '⛔ ВЫКЛЮЧЕНА'}\n` +
      `💻 *Лимит устройств:* до *${merchant.maxDevices} устройств* на 1 ИП`;

    const buttons = [
      [
        Markup.button.callback(
          sub.active ? '🧪 Тест: Отключить подписку ИП' : '✅ Включить подписку ИП',
          'sub_toggle_active'
        )
      ],
      [
        Markup.button.callback('Лимит: 3 устройства', 'sub_limit_3'),
        Markup.button.callback('Лимит: 4 устройства', 'sub_limit_4')
      ],
      [Markup.button.callback('🔙 В главное меню', 'menu_home')]
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }).catch(() => ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons)));
  }

  bot.action('menu_subscription', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    await renderSubscriptionView(ctx, merchant);
  });

  bot.action('sub_toggle_active', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.subscription.active = !merchant.subscription.active;
    saveDb();
    await ctx.answerCbQuery(
      merchant.subscription.active ? '✅ Подписка ИП активна' : '⛔ Подписка ИП остановлена',
      { show_alert: true }
    );
    await renderSubscriptionView(ctx, merchant);
  });

  bot.action('sub_limit_3', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.maxDevices = 3;
    merchant.subscription.plan = 'Тариф ИП PRO (до 3 устройств)';
    saveDb();
    await ctx.answerCbQuery('Лимит: 3 устройства на 1 ИП');
    await renderSubscriptionView(ctx, merchant);
  });

  bot.action('sub_limit_4', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.maxDevices = 4;
    merchant.subscription.plan = 'Тариф ИП PRO (до 4 устройств)';
    saveDb();
    await ctx.answerCbQuery('Лимит: 4 устройства на 1 ИП');
    await renderSubscriptionView(ctx, merchant);
  });

  bot.on('text', async (ctx) => {
    const user = getUserRecord(ctx);
    const text = ctx.message.text.trim();

    if (user.step === 'AWAITING_KASPI_PHONE') {
      const digits = text.replace(/\D/g, '');
      if (digits.length < 10) {
        return ctx.reply('⚠️ Введите номер телефона от кабинета Kaspi (например: +77071234567):');
      }

      const formattedPhone = '+' + (digits.startsWith('8') ? '7' + digits.slice(1) : digits);
      await requestKaspiSmsCode(formattedPhone, user.telegramId);

      user.step = 'AWAITING_KASPI_SMS';
      user.tempPhone = formattedPhone;
      saveDb();

      return ctx.replyWithMarkdown(
        `📲 *Бот отправил запрос на вход в Kaspi Кабинет (\`${formattedPhone}\`)!*\n\n` +
          `Введите SMS-код подтверждения *(для быстрого теста введите \`4590\`)* — бот сам войдет и сам заберет API-ключ:`,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Отмена', 'menu_home')]])
      );
    }

    if (user.step === 'AWAITING_KASPI_SMS') {
      const phone = user.tempPhone;
      const result = await verifyKaspiSmsCode({
        phone,
        smsCode: text,
        deviceInfo: {
          deviceId: `tg_${user.telegramId}`,
          telegramId: user.telegramId,
          deviceName: `Telegram (${user.firstName}${user.username ? ' @' + user.username : ''})`
        }
      });

      if (!result.ok) {
        return ctx.reply(`❌ ${result.error}`);
      }

      if (!result.deviceAuthResult.allowed) {
        user.step = null;
        saveDb();
        return ctx.replyWithMarkdown(`⛔ *Лимит устройств ИП:*\n${result.deviceAuthResult.reason}`);
      }

      user.activeMerchantId = result.merchant.id;
      user.step = null;
      saveDb();

      await ctx.replyWithMarkdown(
        `✅ *Бот сам вошел в кабинет Kaspi и забрал API-ключ!*\n\n` +
          `🏪 *ИП:* ${result.merchant.name} (БИН \`${result.merchant.bin}\`)\n` +
          `🔑 *API-ключ:* \`${result.extractedApiToken.slice(0, 16)}...\`\n` +
          `🤖 *Автодемпинг с лимитами* запущен и мониторит конкурентов!`
      );

      return ctx.replyWithMarkdown(
        buildHomeText(user, result.merchant),
        getMainMenuKeyboard(result.merchant)
      );
    }

    if (user.step === 'AWAITING_INVITE_CODE') {
      const db = getDb();
      const targetMerchant = Object.values(db.merchants).find(
        (m) => m.inviteCode.toUpperCase() === text.toUpperCase()
      );

      if (!targetMerchant) {
        return ctx.reply('❌ Код ИП не найден.');
      }

      const authRes = registerDeviceForMerchant(targetMerchant.id, {
        deviceId: `tg_${user.telegramId}`,
        telegramId: user.telegramId,
        deviceName: `Telegram (${user.firstName}${user.username ? ' @' + user.username : ''})`
      });

      user.step = null;
      if (!authRes.allowed) {
        saveDb();
        return ctx.replyWithMarkdown(`⛔ *Отказ в доступе:*\n${authRes.reason}`);
      }

      user.activeMerchantId = targetMerchant.id;
      saveDb();
      return ctx.replyWithMarkdown(
        buildHomeText(user, targetMerchant),
        getMainMenuKeyboard(targetMerchant)
      );
    }

    const merchant = getActiveMerchant(user);
    return ctx.replyWithMarkdown(buildHomeText(user, merchant), getMainMenuKeyboard(merchant));
  });

  return bot;
}

async function notifyMerchantDevices(bot, merchant, event) {
  if (!bot || !merchant?.subscription?.notificationsEnabled) return;

  const message =
    `⚡ *Автодемпинг сработал автоматически!*\n\n` +
    `📦 *Товар:* ${event.title}\n` +
    `👀 *Конкурент (${event.competitorName}):* поставил \`${event.competitorPrice.toLocaleString('ru-RU')} ₸\`\n` +
    `📉 *Наша старая цена:* ~${event.oldPrice.toLocaleString('ru-RU')} ₸~\n` +
    `🥇 *Наша новая цена:* *${event.newPrice.toLocaleString('ru-RU')} ₸* (шаг \`-${event.step || 100} ₸\`, 1-е место!)`;

  for (const dev of merchant.devices || []) {
    if (dev.telegramId) {
      await bot.telegram
        .sendMessage(dev.telegramId, message, { parse_mode: 'Markdown' })
        .catch(() => null);
    }
  }
}

module.exports = {
  createTelegramBot,
  notifyMerchantDevices
};

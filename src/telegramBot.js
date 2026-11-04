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
    // Проверяем, что это устройство все еще в списке разрешенных (до 4 устройств)
    const isDeviceAllowed = merchant.devices.some(
      (d) => String(d.deviceId) === `tg_${user.telegramId}`
    );
    if (!isDeviceAllowed) return null;
    return merchant;
  }

  function getMainMenuKeyboard(merchant) {
    if (!merchant) {
      return Markup.inlineKeyboard([
        [Markup.button.callback('📱 Подключить Kaspi ИП (по SMS)', 'auth_start_sms')],
        [Markup.button.callback('🔑 Подключиться к ИП (2–4 устройство)', 'auth_join_code')]
      ]);
    }
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('🔥 Автодемпинг (-1 ₸)', 'menu_repricer'),
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
        Markup.button.callback('🎯 Тест: Конкурент 45 498 ₸ → Мы 45 497 ₸', 'sim_drop_45498')
      ],
      [Markup.button.callback('🔄 Обновить панель', 'menu_home')]
    ]);
  }

  function buildHomeText(user, merchant) {
    if (!merchant) {
      return (
        `👋 Привет, *${user.firstName}*! Добро пожаловать в *Qaspik Bot* (аналог Kaskyr).\n\n` +
        `🔒 *Как это работает:*\n` +
        `1️⃣ Вы вводите свой номер телефона от Кабинета продавца Kaspi.\n` +
        `2️⃣ Вводите SMS-код (без ручного поиска API-ключей — бот сам заходит в кабинет).\n` +
        `3️⃣ Подписка привязывается *строго к вашему ИП (БИН)*.\n` +
        `4️⃣ На 1 ИП доступно до *4 устройств/менеджеров*.\n` +
        `5️⃣ Бот 24/7 без вашего участия держит *1-е место*, сбивая цену конкурентов на *-1 ₸* (напр. 45 498 ₸ → 45 497 ₸), и регистрирует коды *НКТ (NTIN)*.\n\n` +
        `👇 Нажмите кнопку ниже, чтобы подключить Kaspi Магазин:`
      );
    }

    const unregisteredNctCount = (merchant.products || []).filter(
      (p) => p.nctStatus !== 'Registered'
    ).length;
    const firstPlaceCount = (merchant.products || []).filter((p) => p.place === 1).length;
    const subStatus = merchant.subscription?.active
      ? `✅ Активна (привязана к ИП ${merchant.bin})`
      : `⛔ Приостановлена (Бот на паузе)`;

    return (
      `🏪 *Магазин:* ${merchant.name}\n` +
      `🆔 *БИН/ИИН ИП:* \`${merchant.bin}\` (ID: \`${merchant.id}\`)\n` +
      `📞 *Кабинет Kaspi:* \`${merchant.phone}\` (Сессия активна 🟢)\n` +
      `💎 *Подписка ИП:* ${subStatus}\n` +
      `💻 *Активные устройства:* *${merchant.devices.length} из ${merchant.maxDevices}*\n` +
      `🔑 *Код для 2–4 устройства:* \`${merchant.inviteCode}\`\n\n` +
      `📊 *Сводка по товарам (${merchant.products.length} шт.):*\n` +
      `• 🥇 На 1-м месте в Kaspi: *${firstPlaceCount} из ${merchant.products.length}*\n` +
      `• 🤖 Автодемпинг (-1 ₸): *${merchant.subscription.repricerActive ? 'ВКЛЮЧЕН 24/7 🟢' : 'ВЫКЛЮЧЕН 🔴'}*\n` +
      `• ⚠️ Не зарегистрировано в НКТ: *${unregisteredNctCount} шт.*`
    );
  }

  // Команда /start
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

  // ============================================================================
  // 1. ВХОД В KASPI ПО НОМЕРУ ТЕЛЕФОНА И SMS (БЕЗ ЗАПРОСА API КЛЮЧА)
  // ============================================================================
  bot.action('auth_start_sms', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    user.step = 'AWAITING_KASPI_PHONE';
    saveDb();

    await ctx.replyWithMarkdown(
      `📱 *Подключение Kaspi Магазина (ИП)*\n\n` +
        `Введите основной номер телефона от вашего Кабинета Продавца Kaspi (например: \`+77071234567\`):`,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Отмена', 'menu_home')]])
    );
  });

  // Вход для 2, 3, 4-го устройства по коду ИП
  bot.action('auth_join_code', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserRecord(ctx);
    user.step = 'AWAITING_INVITE_CODE';
    saveDb();

    await ctx.replyWithMarkdown(
      `🔑 *Подключение дополнительного устройства к ИП (Лимит: до 4 устройств)*\n\n` +
        `Введите код доступа ИП (например: \`IP-A1B2C3\`), который указан в главном меню у владельца ИП:`,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Отмена', 'menu_home')]])
    );
  });

  // ============================================================================
  // 2. РАЗДЕЛ АВТОДЕМПИНГА (-1 ₸ БЕЗ СПРОСА ХОЗЯИНА)
  // ============================================================================
  async function renderRepricerView(ctx, user, merchant) {
    const lines = [
      `🔥 *Автодемпинг цен Kaspi (-1 ₸ без участия хозяина)*`,
      `🏪 ИП: *${merchant.name}* (БИН \`${merchant.bin}\`)`,
      `🤖 Статус бота: *${merchant.subscription.repricerActive && merchant.subscription.active ? 'РАБОТАЕТ 24/7 🟢' : 'ОСТАНОВЛЕН 🔴'}*\n`
    ];

    for (const p of merchant.products) {
      const placeBadge = p.place === 1 ? '🥇 1 место' : `🥈 ${p.place} место`;
      const botBadge = p.botEnabled ? '🟢 Авто -1₸' : '⚪ Выкл';
      lines.push(
        `*${p.title}*\n` +
          `└ Мы: *${p.price.toLocaleString('ru-RU')} ₸* (${placeBadge}) | Конкурент: *${p.competitorPrice.toLocaleString('ru-RU')} ₸* (${p.competitorName})\n` +
          `└ Мин. цена (дно): \`${p.minPrice.toLocaleString('ru-RU')} ₸\` | Режим: ${botBadge}\n`
      );
    }

    const buttons = [
      [Markup.button.callback('⚡ Сбить цены конкурентов сейчас (-1 ₸)', 'repricer_run_now')],
      [Markup.button.callback('🎯 Тест: Конкурент ставит 45 498 ₸ → Бот делает 45 497 ₸', 'sim_drop_45498')],
      [
        Markup.button.callback(
          merchant.subscription.repricerActive
            ? '⏸ Поставить Автодемпинг на паузу'
            : '▶️ Включить Автодемпинг 24/7',
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

  bot.action('repricer_run_now', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return ctx.answerCbQuery('ИП не подключено');

    if (!merchant.subscription.active) {
      return ctx.answerCbQuery('⛔ Подписка ИП не активна! Бот остановлен.', { show_alert: true });
    }

    const events = await runRepricerCycle();
    await ctx.answerCbQuery(
      events.length > 0
        ? `✅ Бот снизил цены по ${events.length} товарам на -1 ₸ и занял 1 место!`
        : '🥇 Вы уже на 1-м месте по всем товарам!'
    );
    await renderRepricerView(ctx, user, merchant);
  });

  // Наглядный тест из примера пользователя: у нас 45 500, конкурент ставит 45 498 -> бот сам делает 45 497!
  bot.action('sim_drop_45498', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return ctx.answerCbQuery('Сначала подключите ИП');

    if (!merchant.subscription.active) {
      return ctx.answerCbQuery('⛔ У этого ИП отключена подписка! Демпинг-бот не сбивает цены без подписки.', {
        show_alert: true
      });
    }

    const firstProd = merchant.products[0];
    firstProd.price = 45500;
    firstProd.competitorPrice = 45498;
    firstProd.place = 2;
    saveDb();

    const { events } = await triggerCompetitorPriceChange(
      merchant.id,
      firstProd.id,
      45498,
      async (m, ev) => {
        await notifyMerchantDevices(bot, m, ev);
      }
    );

    await ctx.answerCbQuery('⚡ Конкурент поставил 45 498 ₸ → Бот автоматически поставил 45 497 ₸!', {
      show_alert: true
    });
    await renderRepricerView(ctx, user, merchant);
  });

  bot.action('repricer_toggle_global', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.subscription.repricerActive = !merchant.subscription.repricerActive;
    saveDb();
    await ctx.answerCbQuery(
      merchant.subscription.repricerActive ? '🟢 Автодемпинг 24/7 включен' : '🔴 Автодемпинг на паузе'
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
      `📜 *Последние действия бота (${merchant.name}):*\n\n` + logLines.join('\n'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад к демпингу', 'menu_repricer')]])
      }
    );
  });

  // ============================================================================
  // 3. РАЗДЕЛ НКТ (context=nct & filterType=Published & orderBy=NctNotRegisteredFirst)
  // ============================================================================
  async function renderNctView(ctx, merchant) {
    // Сортируем точь-в-точь как orderBy=NctNotRegisteredFirst в Kaskyr
    const sortedProducts = [...merchant.products]
      .filter((p) => p.status === 'Published')
      .sort((a, b) => {
        if (a.nctStatus === 'NotRegistered' && b.nctStatus !== 'NotRegistered') return -1;
        if (a.nctStatus !== 'NotRegistered' && b.nctStatus === 'NotRegistered') return 1;
        return 0;
      });

    const notRegCount = sortedProducts.filter((p) => p.nctStatus !== 'Registered').length;

    const lines = [
      `📦 *Модуль НКТ (Национальный каталог товаров)*`,
      `🔍 Фильтр: \`Опубликованные (Published)\``,
      `⇅ Сортировка: \`Сначала без НКТ (NctNotRegisteredFirst)\``,
      `⚠️ Требуют регистрации NTIN: *${notRegCount} из ${sortedProducts.length} шт.*\n`
    ];

    for (const p of sortedProducts) {
      const statusText =
        p.nctStatus === 'Registered'
          ? `✅ Зарегистрирован (NTIN: \`${p.ntin}\`)`
          : `🔴 НЕ ЗАРЕГИСТРИРОВАН В НКТ`;
      lines.push(
        `*${p.title}*\n` +
          `└ Артикул: \`${p.sku}\` | Штрихкод: \`${p.gtin}\`\n` +
          `└ Статус НКТ: ${statusText}\n`
      );
    }

    const buttons = [];
    if (notRegCount > 0) {
      buttons.push([
        Markup.button.callback(
          `✅ Авто-регистрация всех (${notRegCount} шт.) в НКТ`,
          'nct_register_all'
        )
      ]);
    }
    buttons.push([Markup.button.callback('🔄 Сбросить НКТ (для теста)', 'nct_reset_demo')]);
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
      res.ok
        ? `✅ Зарегистрировано ${res.count} товаров в НКТ! Присвоены 13-значные коды NTIN.`
        : res.error,
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
    await ctx.answerCbQuery('🔄 Первые 3 товара снова помечены как «Без НКТ»');
    await renderNctView(ctx, merchant);
  });

  // ============================================================================
  // 4. ЛИМИТ 3–4 УСТРОЙСТВА НА 1 ИП (УПРАВЛЕНИЕ СЕССИЯМИ)
  // ============================================================================
  async function renderDevicesView(ctx, user, merchant) {
    const lines = [
      `💻 *Устройства, подключенные к ИП*`,
      `🏪 ИП: *${merchant.name}* (БИН \`${merchant.bin}\`)`,
      `🛡 Лимит по подписке ИП: *${merchant.devices.length} из ${merchant.maxDevices} устройств*`,
      `🔑 Код для входа со 2–4 устройства: \`${merchant.inviteCode}\`\n`,
      `*Список активных устройств:*`
    ];

    const buttons = [];
    merchant.devices.forEach((d, idx) => {
      const isCurrent = String(d.deviceId) === `tg_${user.telegramId}`;
      lines.push(
        `${idx + 1}. 📱 *${d.deviceName}* (${d.role})${isCurrent ? ' — *[Вы сейчас]*' : ''}\n` +
          `   └ ID: \`${d.deviceId}\` | Вход: ${new Date(d.connectedAt).toLocaleTimeString('ru-RU')}`
      );
      if (!isCurrent) {
        buttons.push([
          Markup.button.callback(
            `❌ Отключить устройство #${idx + 1} (${d.deviceName})`,
            `dev_kick_${d.deviceId}`
          )
        ]);
      }
    });

    buttons.push([
      Markup.button.callback(
        '🧪 Тест: Добавить устройство менеджера (+1 слот)',
        'dev_sim_add'
      )
    ]);
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
      deviceId: `mgr_device_${Date.now().toString().slice(-4)}`,
      deviceName: `Ноутбук Менеджера #${fakeNum} (Chrome)`,
      ip: `178.88.14.${10 + fakeNum}`
    });

    if (!res.allowed) {
      return ctx.answerCbQuery(`⛔ БЛОКИРОВКА: ${res.reason}`, { show_alert: true });
    }

    await ctx.answerCbQuery(
      `✅ Подключено устройство ${merchant.devices.length}/${merchant.maxDevices}`
    );
    await renderDevicesView(ctx, user, merchant);
  });

  bot.action(/^dev_kick_(.+)$/, async (ctx) => {
    const targetDeviceId = ctx.match[1];
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;

    removeDeviceFromMerchant(merchant.id, targetDeviceId);
    await ctx.answerCbQuery('✅ Устройство отключено от ИП! Слот освобожден.');
    await renderDevicesView(ctx, user, merchant);
  });

  // ============================================================================
  // 5. ПОДПИСКА СТРОГО НА ИП (БИН / MERCHANT ID)
  // ============================================================================
  async function renderSubscriptionView(ctx, merchant) {
    const sub = merchant.subscription;
    const text =
      `💎 *Подписка привязана строго к ИП*\n\n` +
      `🏪 *ИП:* ${merchant.name}\n` +
      `🆔 *БИН / ИИН:* \`${merchant.bin}\`\n` +
      `📦 *Тариф:* ${sub.plan}\n` +
      `📡 *Статус подписки:* ${sub.active ? '✅ АКТИВНА (Бот сбивает цены 24/7)' : '⛔ ИСТЕКЛА / ВЫКЛЮЧЕНА (Демпинг остановлен)'}\n` +
      `📅 *Действует до:* \`${new Date(sub.expiresAt).toLocaleDateString('ru-RU')}\`\n` +
      `🛡 *Защита от мультиаккаунтов:* Повторный тестовый период для БИН \`${merchant.bin}\` заблокирован (\`trialUsed = true\`).\n` +
      `💻 *Лимит устройств на это ИП:* до *${merchant.maxDevices} устройств* одновременно.`;

    const buttons = [
      [
        Markup.button.callback(
          sub.active
            ? '🧪 Тест: Отключить подписку ИП (проверить остановку бота)'
            : '✅ Активировать / Продлить подписку ИП (+30 дней)',
          'sub_toggle_active'
        )
      ],
      [
        Markup.button.callback('🔢 Лимит: 3 устройства', 'sub_limit_3'),
        Markup.button.callback('🔢 Лимит: 4 устройства', 'sub_limit_4')
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
    if (merchant.subscription.active) {
      merchant.subscription.expiresAt = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString();
    }
    saveDb();

    await ctx.answerCbQuery(
      merchant.subscription.active
        ? '✅ Подписка ИП активирована! Бот снова сбивает цены 24/7.'
        : '⛔ Подписка ИП отключена! Демпинг-бот автоматически остановлен.',
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
    await ctx.answerCbQuery('Лимит установлен: 3 устройства на 1 ИП');
    await renderSubscriptionView(ctx, merchant);
  });

  bot.action('sub_limit_4', async (ctx) => {
    const user = getUserRecord(ctx);
    const merchant = getActiveMerchant(user);
    if (!merchant) return;
    merchant.maxDevices = 4;
    merchant.subscription.plan = 'Тариф ИП PRO (до 4 устройств)';
    saveDb();
    await ctx.answerCbQuery('Лимит установлен: 4 устройства на 1 ИП');
    await renderSubscriptionView(ctx, merchant);
  });

  // ============================================================================
  // ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ (НОМЕР ТЕЛЕФОНА -> SMS КОД -> ВХОД В KASPI)
  // ============================================================================
  bot.on('text', async (ctx) => {
    const user = getUserRecord(ctx);
    const text = ctx.message.text.trim();

    if (user.step === 'AWAITING_KASPI_PHONE') {
      const digits = text.replace(/\D/g, '');
      if (digits.length < 10) {
        return ctx.reply(
          '⚠️ Введите корректный номер телефона от кабинета Kaspi (например: +77071234567):'
        );
      }

      const formattedPhone = '+' + (digits.startsWith('8') ? '7' + digits.slice(1) : digits);
      await requestKaspiSmsCode(formattedPhone, user.telegramId);

      user.step = 'AWAITING_KASPI_SMS';
      user.tempPhone = formattedPhone;
      saveDb();

      return ctx.replyWithMarkdown(
        `📲 *Запрос отправлен в Kaspi Кабинет на номер \`${formattedPhone}\`!*\n\n` +
          `Введите 4-значный или 6-значный *SMS-код*, который пришел на телефон\n` +
          `*(для быстрого теста можете ввести любой 4-значный код, например \`4590\`)*:`,
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
        return ctx.replyWithMarkdown(
          `⛔ *Доступ заблокирован лимитом устройств ИП!*\n\n${result.deviceAuthResult.reason}`
        );
      }

      user.activeMerchantId = result.merchant.id;
      user.step = null;
      saveDb();

      await ctx.replyWithMarkdown(
        `✅ *Кабинет Kaspi успешно подключен по SMS!*\n\n` +
          `🏪 *ИП:* ${result.merchant.name}\n` +
          `🆔 *БИН/ИИН:* \`${result.merchant.bin}\`\n` +
          `🔑 *Сессия кабинета и товары загружены автоматически* (без ручного ввода API-ключа).\n` +
          `🤖 *Демпинг-бот (-1 ₸)* уже запущен и следит за ценами конкурентов!`
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
        return ctx.reply('❌ Код ИП не найден. Проверьте код (формат IP-XXXXXX) и попробуйте снова:');
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

      await ctx.replyWithMarkdown(
        `✅ *Устройство успешно привязано к ${targetMerchant.name} (БИН \`${targetMerchant.bin}\`)!*\n` +
          `💻 Занято слотов устройств: *${targetMerchant.devices.length} из ${targetMerchant.maxDevices}*`
      );
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

/**
 * Рассылка уведомлений в Telegram всем подключенным устройствам ИП,
 * когда бот автоматически сбил цену конкурента на -1 ₸.
 */
async function notifyMerchantDevices(bot, merchant, event) {
  if (!bot || !merchant?.subscription?.notificationsEnabled) return;

  const message =
    `⚡ *Автодемпинг (-1 ₸) сработал автоматически!*\n\n` +
    `📦 *Товар:* ${event.title}\n` +
    `👀 *Конкурент (${event.competitorName}):* поставил \`${event.competitorPrice.toLocaleString('ru-RU')} ₸\`\n` +
    `📉 *Наша старая цена:* ~${event.oldPrice.toLocaleString('ru-RU')} ₸~\n` +
    `🥇 *Наша новая цена:* *${event.newPrice.toLocaleString('ru-RU')} ₸* (1-е место в Kaspi!)`;

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

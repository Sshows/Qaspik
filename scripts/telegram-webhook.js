require('dotenv').config({ quiet: true });

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret } = process.env;
const command = process.argv[2] || 'status';

function readTargetUrl() {
  const value = process.env.TELEGRAM_WEBHOOK_URL;
  if (!value && command === 'status') return null;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('Укажите полный HTTPS-адрес в TELEGRAM_WEBHOOK_URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/api/telegram/webhook' ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error('TELEGRAM_WEBHOOK_URL должен указывать на HTTPS-маршрут /api/telegram/webhook.');
  }
  return url.href;
}

async function botApi(method, body = {}) {
  let response;
  let payload;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    payload = await response.json();
  } catch (_) {
    throw new Error(`Telegram API недоступен (${method}).`);
  }
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Telegram API отклонил ${method} (HTTP ${response.status}).`);
  }
  return payload.result;
}

async function main() {
  if (!['status', 'set'].includes(command)) {
    throw new Error('Использование: node scripts/telegram-webhook.js status|set');
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '')) {
    throw new Error('Настройте TELEGRAM_BOT_TOKEN.');
  }
  const target = readTargetUrl();
  if (command === 'set' && !/^[A-Za-z0-9_-]{1,256}$/.test(secret || '')) {
    throw new Error('Настройте TELEGRAM_WEBHOOK_SECRET для Vercel и регистрации вебхука.');
  }
  const bot = await botApi('getMe');
  if (bot.username?.toLowerCase() !== 'qaspik_bot') {
    throw new Error('TELEGRAM_BOT_TOKEN принадлежит другому боту.');
  }

  if (command === 'set') {
    await botApi('setWebhook', {
      url: target,
      secret_token: secret,
      allowed_updates: ['message'],
      drop_pending_updates: false
    });
  }

  const info = await botApi('getWebhookInfo');
  console.log(JSON.stringify({
    bot: '@Qaspik_bot',
    configured: Boolean(info.url),
    matchesTarget: target ? info.url === target : null,
    pendingUpdates: info.pending_update_count,
    lastErrorAt: info.last_error_date
      ? new Date(info.last_error_date * 1000).toISOString()
      : null
  }));
  if (command === 'set' && info.url !== target) {
    throw new Error('Telegram не подтвердил адрес вебхука.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

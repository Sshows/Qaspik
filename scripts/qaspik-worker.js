require('dotenv').config();
const { setTimeout: sleep } = require('node:timers/promises');
const { createCloudBotEngine } = require('../src/cloudBotEngine');
const { createTelegramBot } = require('../src/telegramBot');

async function main() {
  const intervalSeconds = Number(process.env.QASPIK_WORKER_INTERVAL_SECONDS || 60);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3600) {
    throw new Error('QASPIK_WORKER_INTERVAL_SECONDS должен быть целым числом от 10 до 3600.');
  }

  const engine = createCloudBotEngine();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const telegramBot = token && token !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE' ? createTelegramBot(token, engine) : null;

  const controller = new AbortController();
  const stop = () => {
    console.log('[Qaspik Worker] Получен сигнал остановки, завершаем цикл...');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(`[Qaspik Worker 24/7] Запущен. Интервал проверки Kaspi: каждые ${intervalSeconds} сек.`);

  while (!controller.signal.aborted) {
    const startedAt = new Date().toISOString();
    try {
      const summary = await engine.runAllActiveStores({ telegramBot });
      const totalChanges = summary.results.reduce((acc, r) => acc + (r.changes?.length || 0), 0);
      console.log(
        `[Qaspik Worker] ${startedAt} | Магазинов проверено: ${summary.storesProcessed} | Изменено цен: ${totalChanges}`
      );
    } catch (error) {
      console.error(`[Qaspik Worker] Ошибка цикла (${startedAt}):`, error.message);
    }

    try {
      await sleep(intervalSeconds * 1000, undefined, { signal: controller.signal });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[Qaspik Worker] Критическая ошибка:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };

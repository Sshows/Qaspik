const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { checkPilotAccess, planPilotPrices, PILOT_MONTHLY_FEE_KZT } = require('../src/kaspiPilot');
const { applyFeedPrices } = require('../src/priceFeed');

const CATALOG_FILE = 'catalog.xml';
const CONFIG_FILE = 'pilot.json';
const OBSERVATIONS_FILE = 'observations.json';
const LOCK_FILE = '.qaspik-pilot.lock';

async function readInput(directory, name) {
  const file = path.join(directory, name);
  try {
    const stats = await fs.lstat(file);
    if (!stats.isFile()) throw new Error(`${name} должен быть обычным файлом.`);
    return { data: await fs.readFile(file), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Файл ${name} не найден в папке пилота.`);
    throw error;
  }
}

function parseJson(input, name) {
  try {
    return JSON.parse(input.data.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new Error(`Проверьте синтаксис JSON в ${name}.`);
  }
}

async function withWriterLock(directory, run) {
  const lock = path.join(directory, LOCK_FILE);
  let handle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Папка пилота занята. Проверьте, что другой процесс завершён, прежде чем убирать ${LOCK_FILE}.`);
    }
    throw error;
  }
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() }) + '\n';
  try {
    await handle.writeFile(owner);
    return await run(async () => {
      if (await fs.readFile(lock, 'utf8') !== owner) {
        throw new Error('Владение блокировкой потеряно. XML не изменён.');
      }
    });
  } finally {
    await handle.close();
    if (await fs.readFile(lock, 'utf8').catch(() => null) === owner) await fs.unlink(lock);
  }
}

function report(result) {
  console.log(JSON.stringify(result));
}

async function runCycle(command, directory, signal, checkLock) {
  const configInput = await readInput(directory, CONFIG_FILE);
  const config = parseJson(configInput, CONFIG_FILE);
  let access = checkPilotAccess(config, Date.now());
  if (!access.active) return { status: 'inactive', code: access.code };

  const [catalog, observationsInput] = await Promise.all([
    readInput(directory, CATALOG_FILE),
    readInput(directory, OBSERVATIONS_FILE)
  ]);
  const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(catalog.data);
  const observations = parseJson(observationsInput, OBSERVATIONS_FILE);
  const now = Date.now();
  access = checkPilotAccess(config, now);
  if (!access.active) return { status: 'inactive', code: access.code };
  const result = planPilotPrices(xml, config, observations, now);
  if (command === 'plan') return { status: 'planned', ...result };
  if (result.changes.length === 0) return { status: 'unchanged', ...result };

  const updatedXml = applyFeedPrices(xml, { merchantId: config.merchantId, changes: result.changes });
  const temporaryFile = path.join(directory, `.${CATALOG_FILE}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryFile, 'wx', catalog.mode);
  try {
    try {
      await handle.writeFile(updatedXml, 'utf8');
      await handle.chmod(catalog.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const [latestConfig, latestCatalog, latestObservations] = await Promise.all([
      readInput(directory, CONFIG_FILE),
      readInput(directory, CATALOG_FILE),
      readInput(directory, OBSERVATIONS_FILE)
    ]);
    access = checkPilotAccess(parseJson(latestConfig, CONFIG_FILE), Date.now());
    if (!access.active) return { status: 'inactive', code: access.code };
    if (
      !latestConfig.data.equals(configInput.data) ||
      !latestObservations.data.equals(observationsInput.data) ||
      !latestCatalog.data.equals(catalog.data) ||
      latestCatalog.mode !== catalog.mode
    ) {
      throw new Error('Входные файлы изменились во время расчёта. XML оставлен без изменений.');
    }
    await checkLock();
    const rechecked = planPilotPrices(xml, config, observations, Date.now());
    if (JSON.stringify(rechecked.changes) !== JSON.stringify(result.changes)) {
      throw new Error('Наблюдения устарели во время расчёта. XML оставлен без изменений.');
    }
    access = checkPilotAccess(config, Date.now());
    if (!access.active) return { status: 'inactive', code: access.code };
    if (signal.aborted) return { status: 'stopped' };
    await fs.rename(temporaryFile, path.join(directory, CATALOG_FILE));
    return { status: 'saved', ...rechecked };
  } finally {
    await fs.unlink(temporaryFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function main() {
  const [command, pilotDirectory, extra] = process.argv.slice(2);
  if (!['plan', 'apply', 'watch'].includes(command) || !pilotDirectory || extra) {
    throw new Error('Использование: node scripts/kaspi-pilot.js <plan|apply|watch> <папка-пилота>');
  }
  const directory = await fs.realpath(pilotDirectory);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('Укажите папку пилота.');

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (command === 'plan') {
      const result = await runCycle(command, directory, controller.signal);
      return report({ monthlyFeeKzt: PILOT_MONTHLY_FEE_KZT, ...result });
    }
    if (command === 'apply') {
      return await withWriterLock(directory, async (checkLock) => {
        const result = await runCycle(command, directory, controller.signal, checkLock);
        report({ monthlyFeeKzt: PILOT_MONTHLY_FEE_KZT, ...result });
      });
    }

    const intervalSeconds = Number(process.env.QASPIK_PILOT_INTERVAL_SECONDS ?? '60');
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 86400) {
      throw new Error('QASPIK_PILOT_INTERVAL_SECONDS должен быть целым числом от 5 до 86400.');
    }
    await withWriterLock(directory, async (checkLock) => {
      report({ status: 'watching', monthlyFeeKzt: PILOT_MONTHLY_FEE_KZT, intervalSeconds });
      while (!controller.signal.aborted) {
        await checkLock();
        try {
          const result = await runCycle(command, directory, controller.signal, checkLock);
          report(result);
          if (result.status === 'inactive') break;
        } catch (error) {
          report({ status: 'retry', error: error.message });
        }
        try {
          await sleep(intervalSeconds * 1000, undefined, { signal: controller.signal });
        } catch (error) {
          if (error.name !== 'AbortError') throw error;
        }
      }
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

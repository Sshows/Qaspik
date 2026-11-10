const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { readFeed } = require('../src/priceFeed');

const HOST = '127.0.0.1';
const FEED_PATH = '/catalog.xml';

async function readRegularFile(file) {
  if (!(await fs.lstat(file)).isFile()) throw new Error('Ожидается обычный файл');
  return fs.readFile(file);
}

function createFeedServer(directory, merchantId) {
  if (typeof merchantId !== 'string' || !/^[0-9]+$/.test(merchantId)) {
    throw new Error('Укажите merchantId в pilot.json');
  }

  const catalogFile = path.join(directory, 'catalog.xml');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url !== FEED_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    let catalog;
    try {
      catalog = await readRegularFile(catalogFile);
      readFeed(decoder.decode(catalog), { merchantId });
    } catch {
      res.writeHead(503).end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': catalog.length,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'GET' ? catalog : undefined);
  });
}

async function main() {
  const [pilotDirectory, extra] = process.argv.slice(2);
  if (!pilotDirectory || extra) {
    throw new Error('Использование: node scripts/serve-kaspi-feed.js <папка-пилота>');
  }

  const port = Number(process.env.QASPIK_FEED_PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('QASPIK_FEED_PORT должен быть целым числом от 1 до 65535');
  }

  let directory;
  let config;
  try {
    directory = await fs.realpath(pilotDirectory);
    const data = await readRegularFile(path.join(directory, 'pilot.json'));
    config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new Error('Проверьте папку пилота и файл pilot.json');
  }

  const server = createFeedServer(directory, config?.merchantId);
  server.once('error', () => {
    console.error('Сервер прайса не запустился. Проверьте порт QASPIK_FEED_PORT.');
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => console.log(`Прайс-лист: http://${HOST}:${port}${FEED_PATH}`));
  const stop = () => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createFeedServer };

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFeedServer } = require('../scripts/serve-kaspi-feed');
const { applyFeedPrices } = require('../src/priceFeed');

test('serves only the full XML for the configured seller and reflects atomic price changes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qaspik-serve-'));
  const catalogFile = path.join(directory, 'catalog.xml');
  const temporaryFile = path.join(directory, 'catalog.tmp');
  const original = await fs.readFile(path.join(__dirname, '../examples/pilot/catalog.xml'));
  const merchantId = '123456';
  const server = createFeedServer(directory, merchantId);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (options) => fetch(base + '/catalog.xml', options);

  assert.equal((await get()).status, 503);
  await fs.writeFile(catalogFile, original);
  let response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);

  response = await get({ method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get('content-length')), original.length);
  assert.equal(await response.text(), '');
  assert.equal((await get({ method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/pilot.json')).status, 404);

  const updated = applyFeedPrices(original.toString('utf8'), {
    merchantId,
    changes: [{ sku: 'DEMO100', cityId: '750000000', price: 25000 }]
  });
  await fs.writeFile(temporaryFile, updated);
  await fs.rename(temporaryFile, catalogFile);
  assert.equal(await (await get()).text(), updated);

  for (const invalid of ['<not-a-catalog/>', updated.replace('<merchantid>123456', '<merchantid>123457')]) {
    await fs.writeFile(catalogFile, invalid);
    response = await get();
    assert.equal(response.status, 503);
    assert.equal(await response.text(), '');
  }
});

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { readFeed } = require('../src/priceFeed');

const execFileAsync = promisify(execFile);
const examples = path.join(__dirname, '../examples/pilot');
const script = path.join(__dirname, '../scripts/kaspi-pilot.js');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qaspik-pilot-'));
  t.after(async () => {
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  });
  await fs.copyFile(path.join(examples, 'pilot.json'), path.join(directory, 'pilot.json'));
  const catalogFile = path.join(directory, 'catalog.xml');
  await fs.copyFile(path.join(examples, 'catalog.xml'), catalogFile);
  return { directory, catalogFile };
}

async function run(command, directory) {
  const { stdout } = await execFileAsync(process.execPath, [script, command, directory]);
  return stdout.trim().split('\n').map((line) => JSON.parse(line)).at(-1);
}

test('plan leaves the catalog intact and apply updates only the targeted complete feed', async (t) => {
  const { directory, catalogFile } = await fixture(t);
  const observations = JSON.parse(await fs.readFile(path.join(examples, 'observations.json'), 'utf8'));
  for (const offer of observations.offers) offer.observedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'observations.json'), JSON.stringify(observations));
  const before = await fs.readFile(catalogFile, 'utf8');

  const plan = await run('plan', directory);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.monthlyFeeKzt, 10000);
  assert.equal(await fs.readFile(catalogFile, 'utf8'), before);
  assert.deepEqual(plan.changes, [
    { sku: 'DEMO100', cityId: '750000000', price: 25390 },
    { sku: 'DEMO200', price: 12079 }
  ]);

  const applied = await run('apply', directory);
  assert.equal(applied.status, 'saved');
  const after = await fs.readFile(catalogFile, 'utf8');
  assert.deepEqual(readFeed(after, { merchantId: '123456' }).offers, [
    {
      sku: 'DEMO100',
      cityPrices: [{ cityId: '750000000', price: 25390 }, { cityId: '710000000', price: 26800 }]
    },
    { sku: 'DEMO200', price: 12079 },
    { sku: 'DEMO300', price: 17900 }
  ]);
  assert.match(after, /storeId="PP1" preOrder="3" stockCount="5"/);
  assert.equal((await run('apply', directory)).status, 'unchanged');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['catalog.xml', 'observations.json', 'pilot.json']);
});

test('apply respects a writer lock and an expired watch leaves the catalog in place', async (t) => {
  const { directory, catalogFile } = await fixture(t);
  const lock = path.join(directory, '.qaspik-pilot.lock');
  const before = await fs.readFile(catalogFile);
  await fs.writeFile(lock, 'existing owner');
  await assert.rejects(run('apply', directory), /Папка пилота занята/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'existing owner');
  await fs.unlink(lock);

  const configFile = path.join(directory, 'pilot.json');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  config.subscription.expiresAt = '2000-01-01T00:00:00Z';
  await fs.writeFile(configFile, JSON.stringify(config));

  assert.deepEqual(await run('watch', directory), { status: 'inactive', code: 'EXPIRED' });
  assert.deepEqual(await fs.readFile(catalogFile), before);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('stale observations and prices at or below the floor leave the XML intact', async (t) => {
  const { directory, catalogFile } = await fixture(t);
  const observations = JSON.parse(await fs.readFile(path.join(examples, 'observations.json'), 'utf8'));
  const [stale, floor] = observations.offers;
  stale.observedAt = new Date(Date.now() - 901_000).toISOString();
  floor.observedAt = new Date().toISOString();
  floor.competitorPrice = 12000;
  const observationsFile = path.join(directory, 'observations.json');
  await fs.writeFile(observationsFile, JSON.stringify(observations));
  const before = await fs.readFile(catalogFile);

  const result = await run('apply', directory);
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.decisions.map(({ code }) => code), ['OBSERVATION_OUT_OF_DATE', 'FLOOR_GUARD']);
  assert.deepEqual(await fs.readFile(catalogFile), before);

  observations.merchantId = '123457';
  await fs.writeFile(observationsFile, JSON.stringify(observations));
  await assert.rejects(run('apply', directory), /merchantId пилота/);
  assert.deepEqual(await fs.readFile(catalogFile), before);
});

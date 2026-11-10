const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFeed, applyFeedPrices } = require('../src/priceFeed');

const merchantId = 'Seller001';
const source = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<?catalog keep-me?>',
  '<kaspi_catalog date="2026-11-10" xmlns="kaspiShopping" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
  ' xsi:schemaLocation="kaspiShopping http://kaspi.kz/kaspishopping.xsd">',
  ' <company>Қаспи &amp; Co</company><merchantid>Seller001</merchantid>',
  ' <offers>',
  '  <!-- Keep this comment. -->',
  '  <offer sku="TEST001">',
  '   <model>Телефон 🧪</model><brand>Brand A</brand>',
  '   <availabilities><availability available="yes" storeId="PP1" stockCount="9" preOrder="2"/></availabilities>',
  '   <price> 95000 </price>',
  '  </offer>',
  '  <offer sku="TEST002">',
  '   <model>Планшет</model><brand>Brand B</brand>',
  '   <availabilities><availability available="no" storeId="PP1" stockCount="0"/></availabilities>',
  '   <cityprices><cityprice cityId="750000000">95000</cityprice>',
  '    <cityprice cityId="710000000">99000</cityprice></cityprices>',
  '  </offer>',
  ' </offers>',
  '</kaspi_catalog>',
  ''
].join('\r\n');

test('reads general and city prices from a complete merchant feed', () => {
  assert.deepEqual(readFeed(source, { merchantId }), {
    merchantId,
    offers: [
      { sku: 'TEST001', price: 95_000 },
      { sku: 'TEST002', cityPrices: [{ cityId: '750000000', price: 95_000 }, { cityId: '710000000', price: 99_000 }] }
    ]
  });
});

test('replaces only requested price digits while preserving all remaining XML', () => {
  const updated = applyFeedPrices(source, {
    merchantId,
    changes: [{ sku: 'TEST002', cityId: '750000000', price: 87_000 }, { sku: 'TEST001', price: 94_000 }]
  });
  assert.equal(updated, source
    .replace('<price> 95000 </price>', '<price> 94000 </price>')
    .replace('<cityprice cityId="750000000">95000', '<cityprice cityId="750000000">87000')
  );
  assert.equal(applyFeedPrices(updated, { merchantId, changes: [{ sku: 'TEST001', price: 94_000 }] }), updated);
  assert.equal(applyFeedPrices(source, { merchantId, changes: [] }), source);
});

test('preserves BOM, prefixed namespaces and price formatting on the original lines', () => {
  const original = '\uFEFF' + source
    .replace('xmlns="kaspiShopping"', 'xmlns:k="kaspiShopping"')
    .replace(/<(\/?)([a-z_]+)(?=[\s/>])/g, '<$1k:$2')
    .replace('<k:price> 95000 </k:price>', '<k:price>\r\n     95000\r\n   </k:price>');
  const updated = applyFeedPrices(original, { merchantId, changes: [{ sku: 'TEST001', price: 94_999 }] });
  assert.equal(updated, original.replace('     95000\r\n', '     94999\r\n'));
});

test('rejects invalid, partial, ambiguous and wrong-seller feeds', () => {
  assert.throws(() => readFeed(source, { merchantId: 'OtherSeller' }), /другому продавцу/);
  assert.throws(() => readFeed(source.replace('UTF-8', 'windows-1251'), { merchantId }), /UTF-8/);
  assert.throws(() => readFeed(source.replace('</offer>', '</not-offer>'), { merchantId }), /Некорректный XML/);
  assert.throws(() => readFeed(source.replace('<kaspi_catalog', '<!DOCTYPE kaspi_catalog SYSTEM "file:///fake.dtd"><kaspi_catalog'), { merchantId }), /без DTD/);
  assert.throws(() => readFeed(source.replace('<offer sku="TEST002">', '<offer sku="TEST001">'), { merchantId }), /SKU/);
  assert.throws(() => readFeed(source.replace('710000000', '750000000'), { merchantId }), /повторяющаяся цена/);
  assert.throws(() => readFeed(source.replace('<cityprices>', '<price>100000</price><cityprices>'), { merchantId }), /либо/);
  assert.throws(() => readFeed(source.replace('<price> 95000 </price>', '<price>95.01</price>'), { merchantId }), /некорректная цена/);
  assert.throws(() => readFeed(source.replace('<price> 95000 </price>', '<price>95<!--x-->000</price>'), { merchantId }), /числом/);
  assert.throws(() => readFeed(source.replace(/<availabilities>.*?<\/availabilities>/, ''), { merchantId }), /availabilities/);
  assert.throws(() => readFeed(source.replace(/<offers>[\s\S]*?<\/offers>/, '<offers/>'), { merchantId }), /список позиций/);
});

test('rejects absent or duplicate targets and invalid prices', () => {
  const badChanges = [
    [{ sku: 'missing', price: 1 }],
    [{ sku: 'TEST001', cityId: '750000000', price: 1 }],
    [{ sku: 'TEST002', price: 1 }],
    [{ sku: 'TEST002', cityId: '123456789', price: 1 }],
    [{ sku: 'TEST001', price: 1 }, { sku: 'TEST001', price: 2 }],
    [{ sku: 'TEST001', price: 0 }],
    [{ sku: 'TEST001', price: '10000' }],
    [{ sku: 'TEST001', price: Number.MAX_SAFE_INTEGER + 1 }]
  ];
  for (const changes of badChanges) {
    assert.throws(() => applyFeedPrices(source, { merchantId, changes }));
  }
});

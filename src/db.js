const crypto = require('node:crypto');

const db = {
  merchants: Object.create(null),
  logs: []
};

function buildStandingsForProduct(merchantName, yourPrice, competitors) {
  const list = [
    {
      merchantName,
      price: Number(yourPrice),
      isYou: true,
      rating: 4.9,
      reviewsCount: 342
    },
    ...competitors.map((c) => ({
      merchantName: c.name,
      price: Number(c.price),
      isYou: false,
      rating: c.rating || 4.8,
      reviewsCount: c.reviewsCount || 120
    }))
  ];
  list.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return a.isYou ? -1 : 1;
  });
  return list.map((item, idx) => ({
    ...item,
    position: idx + 1
  }));
}

function normalizeProducts(products, merchantId, merchantName) {
  if (!Array.isArray(products) || products.length === 0) {
    return generateDefaultProducts(merchantId, merchantName);
  }
  return products.map((p, idx) => {
    const defaults = generateDefaultProducts(merchantId, merchantName);
    const fallback = defaults[idx % defaults.length];
    const baseCompetitors = p.competitors || fallback.competitors;
    const price = Number(p.price || fallback.price);
    const standings = buildStandingsForProduct(merchantName || 'Ваш Магазин', price, baseCompetitors);
    const myEntry = standings.find((s) => s.isYou) || { position: 1 };
    const bestCompetitor = standings.find((s) => !s.isYou) || { price: price + 100, merchantName: 'Конкурент' };
    const firstPlaceEntry = standings[0] || { price };
    const ntin = p.ntin ?? null;
    let nctStatus = 'Unknown';
    if (ntin !== null && ntin !== '') {
      nctStatus = typeof ntin === 'string' && ntin.length === 13 && /^02[0-9]{11}$/.test(ntin)
        ? 'Unverified'
        : 'InvalidFormat';
    }

    return {
      ...fallback,
      ...p,
      ntin,
      nctStatus,
      price,
      firstPositionPrice: firstPlaceEntry.price,
      competitorPrice: bestCompetitor.price,
      competitorName: bestCompetitor.merchantName,
      place: myEntry.position,
      totalOffers: p.totalOffers || standings.length + 9,
      standings,
      competitors: baseCompetitors,
      purchasePrice: p.purchasePrice !== undefined ? Number(p.purchasePrice) : fallback.purchasePrice,
      nearFloorWindow: p.nearFloorWindow ?? 200,
      turboEnabled: p.turboEnabled !== undefined ? Boolean(p.turboEnabled) : true,
      dampingStatus: p.dampingStatus || (p.botEnabled ? 'DAMPING_ENABLED' : 'DAMPING_DISABLED')
    };
  });
}

function generateDefaultProducts(merchantId, merchantName = 'ИП QASPIK STORE') {
  const raw = [
    {
      id: 'prod_1',
      merchantId,
      sku: '10849201',
      masterSku: '113128015',
      title: 'Смартфон Apple iPhone 15 128GB Черный',
      category: 'Смартфоны',
      imageUrl: 'https://resources.cdn-kaspi.kz/img/m/p/h1d/hfc/86303745998878.jpg?format=preview-small',
      kaspiUrl: 'https://kaspi.kz/shop/p/apple-iphone-15-128gb-chernyi-113128015/',
      status: 'Published',
      price: 424890,
      minPrice: 412000,
      maxPrice: 449900,
      purchasePrice: 385000,
      step: 10,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 14,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '0195949035944',
      nctStatus: 'Unknown',
      ntin: null,
      notes: 'Хит продаж',
      competitors: [
        { name: 'TechnoDom KZ', price: 424891, rating: 4.9, reviewsCount: 1240 },
        { name: 'Sulpak Official', price: 425500, rating: 4.8, reviewsCount: 980 },
        { name: 'iPoint Store', price: 426900, rating: 5.0, reviewsCount: 410 },
        { name: 'Alser KZ', price: 428000, rating: 4.7, reviewsCount: 620 }
      ]
    },
    {
      id: 'prod_2',
      merchantId,
      sku: '10423199',
      masterSku: '114887914',
      title: 'Наушники Apple AirPods Pro 2 USB-C Белый',
      category: 'Наушники',
      imageUrl: 'https://resources.cdn-kaspi.kz/img/m/p/ha3/h07/84108189630494.jpg?format=preview-small',
      kaspiUrl: 'https://kaspi.kz/shop/p/apple-airpods-pro-2-with-magsafe-usb-c-belyi-114887914/',
      status: 'Published',
      price: 114890,
      minPrice: 109000,
      maxPrice: 124900,
      purchasePrice: 96000,
      step: 10,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 22,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '0195949052484',
      nctStatus: 'Unknown',
      ntin: null,
      notes: '',
      competitors: [
        { name: 'Sulpak Official', price: 114891, rating: 4.9, reviewsCount: 840 },
        { name: 'MobileCity Almaty', price: 115200, rating: 4.8, reviewsCount: 310 },
        { name: 'AppleRoom KZ', price: 115990, rating: 4.9, reviewsCount: 520 },
        { name: 'Belyi Veter', price: 116500, rating: 4.9, reviewsCount: 740 }
      ]
    },
    {
      id: 'prod_3',
      merchantId,
      sku: '11094821',
      masterSku: '102298236',
      title: 'Пылесос Dyson V15 Detect Absolute Серебристый',
      category: 'Пылесосы',
      imageUrl: 'https://resources.cdn-kaspi.kz/img/m/p/h4f/h29/85838152335390.jpg?format=preview-small',
      kaspiUrl: 'https://kaspi.kz/shop/p/dyson-v15-detect-absolute-serebristyi-102298236/',
      status: 'Published',
      price: 314899,
      minPrice: 298000,
      maxPrice: 339000,
      purchasePrice: 265000,
      step: 10,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 6,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '5025155073193',
      nctStatus: 'Unknown',
      ntin: null,
      notes: 'Официальная гарантия',
      competitors: [
        { name: 'EuroTech Almaty', price: 314900, rating: 4.9, reviewsCount: 290 },
        { name: 'Dyson Center KZ', price: 315500, rating: 5.0, reviewsCount: 185 },
        { name: 'HomeTech Store', price: 317900, rating: 4.8, reviewsCount: 94 }
      ]
    },
    {
      id: 'prod_4',
      merchantId,
      sku: '10293847',
      masterSku: '104339154',
      title: 'Кофемашина DeLonghi Magnifica Evo ECAM290.81.TB',
      category: 'Кофемашины',
      imageUrl: 'https://resources.cdn-kaspi.kz/img/m/p/h7c/h91/64434864750622.jpg?format=preview-small',
      kaspiUrl: 'https://kaspi.kz/shop/p/delonghi-magnifica-evo-ecam290-81-tb-chernyi-104339154/',
      status: 'Published',
      price: 264799,
      minPrice: 252000,
      maxPrice: 285000,
      purchasePrice: 221000,
      step: 10,
      turboEnabled: false,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 5,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '8004399021396',
      nctStatus: 'Unknown',
      ntin: null,
      notes: '',
      competitors: [
        { name: 'CoffeeHome KZ', price: 264800, rating: 4.9, reviewsCount: 412 },
        { name: 'TechnoDom KZ', price: 266900, rating: 4.9, reviewsCount: 830 },
        { name: 'Barista Shop', price: 268000, rating: 4.8, reviewsCount: 150 }
      ]
    },
    {
      id: 'prod_5',
      merchantId,
      sku: '10998877',
      masterSku: '114732981',
      title: 'Умная колонка Яндекс Станция Миди с Zigbee Черный',
      category: 'Умный дом',
      imageUrl: 'https://resources.cdn-kaspi.kz/img/m/p/h6b/h30/84530104565790.jpg?format=preview-small',
      kaspiUrl: 'https://kaspi.kz/shop/p/jandeks-stantsija-midi-chernyi-114732981/',
      status: 'Published',
      price: 69889,
      minPrice: 65000,
      maxPrice: 74990,
      purchasePrice: 56000,
      step: 10,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 19,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '4607161627811',
      nctStatus: 'Unknown',
      ntin: null,
      notes: '',
      competitors: [
        { name: 'SmartDevice KZ', price: 69890, rating: 4.9, reviewsCount: 615 },
        { name: 'Yandex Store KZ', price: 70500, rating: 5.0, reviewsCount: 910 },
        { name: 'GadgetPro', price: 71900, rating: 4.7, reviewsCount: 204 }
      ]
    }
  ];

  return raw.map((item) => {
    const standings = buildStandingsForProduct(merchantName, item.price, item.competitors);
    const myEntry = standings.find((s) => s.isYou) || { position: 1 };
    const bestCompetitor = standings.find((s) => !s.isYou) || { price: item.price + 1, merchantName: 'Конкурент' };
    return {
      ...item,
      firstPositionPrice: standings[0].price,
      competitorPrice: bestCompetitor.price,
      competitorName: bestCompetitor.merchantName,
      place: myEntry.position,
      totalOffers: standings.length + 11,
      standings,
      updatedAt: new Date().toISOString()
    };
  });
}

function createDemoMerchant() {
  const id = 'qaspik-demo';
  const name = 'Демо-магазин Qaspik';
  const maxDevices = 4;
  const merchant = {
    id,
    name,
    demo: true,
    cityId: '750000000',
    cityName: 'Алматы',
    maxDevices,
    devices: [],
    subscription: {
      active: true,
      plan: 'Демо · до 4 устройств',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      repricerActive: true
    },
    products: normalizeProducts(generateDefaultProducts(id, name), id, name)
  };
  db.merchants[id] = merchant;
  registerDeviceForMerchant(id, { deviceId: 'demo-owner', deviceName: 'Демо-владелец' });
  return merchant;
}

function registerDeviceForMerchant(merchantId, { deviceId, deviceName }) {
  const merchant = db.merchants[merchantId];
  if (!merchant?.demo) return { allowed: false, reason: 'Демо-магазин не найден' };

  if (merchant.devices.length >= merchant.maxDevices) {
    return { allowed: false, reason: `Достигнут лимит устройств: ${merchant.maxDevices}.` };
  }

  const now = new Date().toISOString();
  const device = {
    deviceId: deviceId || crypto.randomUUID(),
    deviceName: deviceName || `Демо-устройство №${merchant.devices.length + 1}`,
    role: merchant.devices.length === 0 ? 'Владелец' : 'Менеджер',
    ip: '—',
    connectedAt: now,
    lastActiveAt: now
  };
  merchant.devices.push(device);
  return { allowed: true, device };
}

function removeDeviceFromMerchant(merchantId, deviceId) {
  const merchant = db.merchants[merchantId];
  if (!merchant?.demo) return false;
  const index = merchant.devices.findIndex((device) => device.deviceId === deviceId);
  if (index < 0) return false;
  merchant.devices.splice(index, 1);
  return true;
}

function addLog(entry) {
  const logItem = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry
  };
  db.logs.unshift(logItem);
  if (db.logs.length > 200) {
    db.logs = db.logs.slice(0, 200);
  }
  return logItem;
}

module.exports = {
  getDb: () => db,
  buildStandingsForProduct,
  normalizeProducts,
  createDemoMerchant,
  registerDeviceForMerchant,
  removeDeviceFromMerchant,
  addLog
};

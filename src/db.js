const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pynvsqlmelaklofvbwzy.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5bnZzcWxtZWxha2xvZnZid3p5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NTAwODUsImV4cCI6MjA5MjAyNjA4NX0.nvP8ZuK1aR2yQ-g42FF30vJVFTp87mZf727vULeEPBo';

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (_) {}

const defaultData = {
  merchants: {},
  users: {},
  pendingAuth: {},
  logs: []
};

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      return { ...defaultData, ...JSON.parse(raw) };
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(defaultData));
}

let db = loadDb();

function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (_) {}
  syncToSupabaseAsync().catch(() => null);
}

async function syncToSupabaseAsync() {
  if (!supabase) return;
  try {
    const merchants = Object.values(db.merchants);
    for (const m of merchants) {
      await supabase.from('qaspik_merchants').upsert(
        {
          id: m.id,
          bin: m.bin,
          name: m.name,
          phone: m.phone,
          invite_code: m.inviteCode,
          max_devices: m.maxDevices,
          api_token: m.kaspiSession?.autoExtractedApiToken || null,
          session_cookies: m.kaspiSession?.cookies || null,
          subscription_active: Boolean(m.subscription?.active),
          subscription_plan: m.subscription?.plan || '',
          subscription_expires_at: m.subscription?.expiresAt || null,
          repricer_active: Boolean(m.subscription?.repricerActive),
          devices_json: m.devices || [],
          products_json: m.products || [],
          updated_at: new Date().toISOString()
        },
        { onConflict: 'id' }
      );
    }
  } catch (_) {}
}

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

    return {
      ...fallback,
      ...p,
      price,
      firstPositionPrice: firstPlaceEntry.price,
      competitorPrice: bestCompetitor.price,
      competitorName: bestCompetitor.merchantName,
      place: myEntry.position,
      totalOffers: p.totalOffers || standings.length + 9,
      standings,
      competitors: baseCompetitors,
      purchasePrice: p.purchasePrice !== undefined ? Number(p.purchasePrice) : fallback.purchasePrice,
      turboEnabled: p.turboEnabled !== undefined ? Boolean(p.turboEnabled) : true,
      dampingStatus: p.dampingStatus || (p.botEnabled ? 'DAMPING_ENABLED' : 'DAMPING_DISABLED')
    };
  });
}

async function hydrateFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('qaspik_merchants')
      .select('*')
      .order('updated_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      for (const row of data) {
        const mName = row.name || 'ИП QASPIK STORE';
        db.merchants[row.id] = {
          id: row.id,
          bin: row.bin,
          name: mName,
          phone: row.phone,
          cityId: '750000000',
          cityName: 'Алматы',
          inviteCode: row.invite_code,
          maxDevices: row.max_devices || 4,
          devices: row.devices_json || [],
          kaspiSession: {
            connected: true,
            connectedAt: row.updated_at,
            botEmployeeLogin: `bot-${row.id.toLowerCase()}@qaspik.kz`,
            cabinetMode: 'ACTIVE_WORKER',
            autoExtractedApiToken: row.api_token,
            cookies: row.session_cookies
          },
          subscription: {
            active: row.subscription_active,
            plan: row.subscription_plan || 'Тариф PRO (Привязка к ИП)',
            expiresAt: row.subscription_expires_at,
            trialUsed: true,
            repricerActive: row.repricer_active,
            notificationsEnabled: true
          },
          products: normalizeProducts(row.products_json, row.id, mName),
          createdAt: row.updated_at
        };
      }
    }

    const { data: logsData } = await supabase
      .from('qaspik_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (Array.isArray(logsData) && logsData.length > 0) {
      db.logs = logsData.map((l) => ({
        id: l.id,
        timestamp: l.created_at,
        type: l.type,
        merchantId: l.merchant_id,
        merchantName: l.merchant_name,
        sku: l.sku,
        title: l.title,
        oldPrice: l.old_price,
        competitorPrice: l.competitor_price,
        newPrice: l.new_price,
        message: l.message
      }));
    }
  } catch (_) {}
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
      step: 1,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 14,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '0195949035944',
      nctStatus: 'NotRegistered',
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
      step: 1,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 22,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '0195949052484',
      nctStatus: 'NotRegistered',
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
      step: 1,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 6,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '5025155073193',
      nctStatus: 'NotRegistered',
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
      step: 1,
      turboEnabled: false,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 5,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '8004399021396',
      nctStatus: 'Registered',
      ntin: '0280043990213',
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
      step: 1,
      turboEnabled: true,
      botEnabled: true,
      dampingStatus: 'DAMPING_ENABLED',
      stock: 19,
      preorderDays: 0,
      city: 'Алматы',
      gtin: '4607161627811',
      nctStatus: 'Registered',
      ntin: '0246071616278',
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

function upsertMerchantByPhone({ phone, bin, companyName, kaspiMerchantId, sessionData, ownerDevice }) {
  const cleanPhone = String(phone || '+77071234567').replace(/[^\d+]/g, '');
  let existing = Object.values(db.merchants).find(
    (m) => m.phone === cleanPhone || (bin && m.bin === bin) || (kaspiMerchantId && m.id === kaspiMerchantId)
  );

  const maxDevices = Number(process.env.MAX_DEVICES_PER_IP || 4);

  if (!existing) {
    const generatedBin = bin || ('9' + cleanPhone.replace(/\D/g, '').slice(-11).padEnd(11, '4'));
    const merchantId = kaspiMerchantId || ('M_' + generatedBin.slice(-6));
    const inviteCode = 'IP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const autoToken =
      sessionData?.apiToken ||
      'ks_mc_' + crypto.createHash('sha256').update(cleanPhone + '_kaspi').digest('hex').slice(0, 28);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const mName = companyName || `ИП QASPIK (${cleanPhone.slice(-4)})`;

    existing = {
      id: merchantId,
      bin: generatedBin,
      name: mName,
      phone: cleanPhone,
      cityId: '750000000',
      cityName: 'Алматы',
      inviteCode,
      maxDevices,
      devices: [],
      kaspiSession: {
        connected: true,
        connectedAt: new Date().toISOString(),
        botEmployeeLogin: `bot-${merchantId.toLowerCase()}@qaspik.kz`,
        cabinetMode: 'ACTIVE_WORKER',
        autoExtractedApiToken: autoToken,
        cookies: sessionData?.cookies || 'mc-session=active; ks.ngs.m=verified'
      },
      subscription: {
        active: true,
        plan: `Тариф PRO (до ${maxDevices} устройств)`,
        expiresAt,
        trialUsed: true,
        repricerActive: true,
        notificationsEnabled: true
      },
      products: generateDefaultProducts(merchantId, mName),
      createdAt: new Date().toISOString()
    };

    db.merchants[merchantId] = existing;
  } else {
    if (companyName) existing.name = companyName;
    if (bin) existing.bin = bin;
    existing.kaspiSession = {
      ...existing.kaspiSession,
      connected: true,
      botEmployeeLogin: existing.kaspiSession?.botEmployeeLogin || `bot-${existing.id.toLowerCase()}@qaspik.kz`,
      cabinetMode: 'ACTIVE_WORKER',
      autoExtractedApiToken:
        sessionData?.apiToken ||
        existing.kaspiSession?.autoExtractedApiToken ||
        'ks_mc_' + crypto.randomBytes(12).toString('hex'),
      cookies: sessionData?.cookies || existing.kaspiSession?.cookies || 'mc-session=active',
      lastSmsRefreshAt: new Date().toISOString()
    };
    existing.products = normalizeProducts(existing.products, existing.id, existing.name);
  }

  let deviceAuthResult = { allowed: true, reason: null };
  if (ownerDevice) {
    deviceAuthResult = registerDeviceForMerchant(existing.id, ownerDevice);
  }

  saveDb();
  return { merchant: existing, deviceAuthResult };
}

function registerDeviceForMerchant(merchantId, deviceInfo) {
  const merchant = db.merchants[merchantId];
  if (!merchant) return { allowed: false, reason: 'Магазин не найден' };

  const existingIdx = merchant.devices.findIndex(
    (d) => String(d.deviceId) === String(deviceInfo.deviceId)
  );

  if (existingIdx !== -1) {
    merchant.devices[existingIdx].lastActiveAt = new Date().toISOString();
    merchant.devices[existingIdx].deviceName =
      deviceInfo.deviceName || merchant.devices[existingIdx].deviceName;
    saveDb();
    return { allowed: true, device: merchant.devices[existingIdx], isNew: false };
  }

  if (merchant.devices.length >= merchant.maxDevices) {
    return {
      allowed: false,
      reason: `Достигнут лимит устройств для ${merchant.name} (БИН ${merchant.bin}): активно ${merchant.devices.length} из ${merchant.maxDevices}.`
    };
  }

  const newDevice = {
    deviceId: String(deviceInfo.deviceId),
    telegramId: deviceInfo.telegramId || null,
    deviceName: deviceInfo.deviceName || 'Браузер Селлера',
    role: merchant.devices.length === 0 ? 'Владелец ИП' : 'Менеджер',
    ip: deviceInfo.ip || 'Kaspi-KZ',
    connectedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString()
  };

  merchant.devices.push(newDevice);
  saveDb();
  return { allowed: true, device: newDevice, isNew: true };
}

function removeDeviceFromMerchant(merchantId, deviceId) {
  const merchant = db.merchants[merchantId];
  if (!merchant) return false;
  const before = merchant.devices.length;
  merchant.devices = merchant.devices.filter((d) => String(d.deviceId) !== String(deviceId));
  saveDb();
  return merchant.devices.length < before;
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
  saveDb();

  if (supabase) {
    supabase
      .from('qaspik_logs')
      .insert({
        id: logItem.id,
        type: logItem.type || 'INFO',
        merchant_id: logItem.merchantId || null,
        merchant_name: logItem.merchantName || null,
        sku: logItem.sku || null,
        title: logItem.title || null,
        old_price: logItem.oldPrice || null,
        competitor_price: logItem.competitorPrice || null,
        new_price: logItem.newPrice || null,
        message: logItem.message || '',
        created_at: logItem.timestamp
      })
      .then(() => null)
      .catch(() => null);
  }

  return logItem;
}

module.exports = {
  supabase,
  getDb: () => db,
  saveDb,
  buildStandingsForProduct,
  normalizeProducts,
  hydrateFromSupabase,
  syncToSupabaseAsync,
  upsertMerchantByPhone,
  registerDeviceForMerchant,
  removeDeviceFromMerchant,
  addLog
};

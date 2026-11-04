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

/**
 * Асинхронная синхронизация состояния ИП, товаров, устройств и логов в Supabase PostgreSQL
 */
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

/**
 * Загрузка данных из Supabase при старте (для Vercel Serverless и синхронизации с ботом)
 */
async function hydrateFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('qaspik_merchants')
      .select('*')
      .order('updated_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      for (const row of data) {
        db.merchants[row.id] = {
          id: row.id,
          bin: row.bin,
          name: row.name,
          phone: row.phone,
          inviteCode: row.invite_code,
          maxDevices: row.max_devices || 4,
          devices: row.devices_json || [],
          kaspiSession: {
            connected: true,
            connectedAt: row.updated_at,
            autoExtractedApiToken: row.api_token,
            cookies: row.session_cookies
          },
          subscription: {
            active: row.subscription_active,
            plan: row.subscription_plan,
            expiresAt: row.subscription_expires_at,
            trialUsed: true,
            repricerActive: row.repricer_active,
            notificationsEnabled: true
          },
          products: row.products_json || [],
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

function generateDefaultProducts(merchantId) {
  return [
    {
      id: 'prod_1',
      merchantId,
      sku: '10849201',
      masterSku: '10849201',
      title: 'Смартфон Apple iPhone 15 128GB Черный',
      category: 'Смартфоны',
      status: 'Published',
      price: 46000,
      minPrice: 41000,
      maxPrice: 49500,
      step: 100, // Шаг сбития: конкурент 45 900 -> бот ставит 45 800 ₸!
      competitorPrice: 45900,
      competitorName: 'TechnoDom KZ',
      place: 2,
      totalOffers: 16,
      botEnabled: true,
      autoMonitor: true,
      stock: 14,
      city: 'Алматы',
      gtin: '0195949035944',
      nctStatus: 'NotRegistered',
      ntin: null,
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_2',
      merchantId,
      sku: '10423199',
      masterSku: '10423199',
      title: 'Наушники Apple AirPods Pro 2 MagSafe USB-C Белый',
      category: 'Наушники',
      status: 'Published',
      price: 45500,
      minPrice: 42000,
      maxPrice: 48900,
      step: 1, // Шаг сбития -1 ₸: конкурент 45 498 -> бот ставит 45 497 ₸!
      competitorPrice: 45498,
      competitorName: 'Sulpak Official',
      place: 2,
      totalOffers: 24,
      botEnabled: true,
      autoMonitor: true,
      stock: 9,
      city: 'Алматы',
      gtin: '0195949052484',
      nctStatus: 'NotRegistered',
      ntin: null,
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_3',
      merchantId,
      sku: '11094821',
      masterSku: '11094821',
      title: 'Пылесос Dyson V15 Detect Absolute Серебристый',
      category: 'Пылесосы',
      status: 'Published',
      price: 314900,
      minPrice: 295000,
      maxPrice: 340000,
      step: 100,
      competitorPrice: 315000,
      competitorName: 'EuroTech Almaty',
      place: 1,
      totalOffers: 11,
      botEnabled: true,
      autoMonitor: true,
      stock: 5,
      city: 'Астана',
      gtin: '5025155073193',
      nctStatus: 'NotRegistered',
      ntin: null,
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_4',
      merchantId,
      sku: '10293847',
      masterSku: '10293847',
      title: 'Кофемашина DeLonghi Magnifica Evo ECAM290.81.TB',
      category: 'Кофемашины',
      status: 'Published',
      price: 264800,
      minPrice: 248000,
      maxPrice: 285000,
      step: 100,
      competitorPrice: 264900,
      competitorName: 'CoffeeHome KZ',
      place: 1,
      totalOffers: 8,
      botEnabled: true,
      autoMonitor: true,
      stock: 6,
      city: 'Алматы',
      gtin: '8004399021396',
      nctStatus: 'Registered',
      ntin: '0280043990213',
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_5',
      merchantId,
      sku: '10998877',
      masterSku: '10998877',
      title: 'Умная колонка Яндекс Станция Миди с Zigbee Черный',
      category: 'Умный дом',
      status: 'Published',
      price: 69890,
      minPrice: 64000,
      maxPrice: 74990,
      step: 100,
      competitorPrice: 69990,
      competitorName: 'SmartDevice KZ',
      place: 1,
      totalOffers: 19,
      botEnabled: true,
      autoMonitor: true,
      stock: 21,
      city: 'Алматы',
      gtin: '4607161627811',
      nctStatus: 'Registered',
      ntin: '0246071616278',
      updatedAt: new Date().toISOString()
    }
  ];
}

function upsertMerchantByPhone({ phone, bin, companyName, kaspiMerchantId, sessionData, ownerDevice }) {
  const cleanPhone = phone.replace(/[^\d+]/g, '');
  let existing = Object.values(db.merchants).find(
    (m) => m.phone === cleanPhone || (bin && m.bin === bin)
  );

  const maxDevices = Number(process.env.MAX_DEVICES_PER_IP || 4);

  if (!existing) {
    const generatedBin = bin || ('9' + cleanPhone.replace(/\D/g, '').slice(-11).padEnd(11, '4'));
    const merchantId = kaspiMerchantId || ('KS_IP_' + generatedBin.slice(-6));
    const inviteCode = 'IP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const autoToken =
      sessionData?.apiToken ||
      'ks_seller_' + crypto.createHash('sha256').update(cleanPhone + '_kaspi').digest('hex').slice(0, 28);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    existing = {
      id: merchantId,
      bin: generatedBin,
      name: companyName || `ИП QASPIK (${cleanPhone.slice(-4)})`,
      phone: cleanPhone,
      inviteCode,
      maxDevices,
      devices: [],
      kaspiSession: {
        connected: true,
        connectedAt: new Date().toISOString(),
        autoExtractedApiToken: autoToken,
        cookies: sessionData?.cookies || 'mc-session=active; ks.ngs.m=verified'
      },
      subscription: {
        active: true,
        plan: `Тариф ИП PRO (до ${maxDevices} устройств)`,
        expiresAt,
        trialUsed: true,
        repricerActive: true,
        notificationsEnabled: true
      },
      products: generateDefaultProducts(merchantId),
      createdAt: new Date().toISOString()
    };

    db.merchants[merchantId] = existing;
  } else {
    if (companyName) existing.name = companyName;
    if (bin) existing.bin = bin;
    existing.kaspiSession = {
      ...existing.kaspiSession,
      connected: true,
      autoExtractedApiToken:
        sessionData?.apiToken ||
        existing.kaspiSession?.autoExtractedApiToken ||
        'ks_seller_' + crypto.randomBytes(12).toString('hex'),
      lastSmsRefreshAt: new Date().toISOString()
    };
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
  if (!merchant) return { allowed: false, reason: 'ИП не найдено' };

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
      reason: `Превышен лимит устройств для ${merchant.name} (БИН ${merchant.bin}): активно ${merchant.devices.length} из ${merchant.maxDevices}. Отключите одно из устройств, чтобы войти.`
    };
  }

  const newDevice = {
    deviceId: String(deviceInfo.deviceId),
    telegramId: deviceInfo.telegramId || null,
    deviceName: deviceInfo.deviceName || 'Устройство Селлера',
    role: merchant.devices.length === 0 ? 'Владелец ИП' : 'Менеджер ИП',
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
  hydrateFromSupabase,
  syncToSupabaseAsync,
  upsertMerchantByPhone,
  registerDeviceForMerchant,
  removeDeviceFromMerchant,
  addLog
};

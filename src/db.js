const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultData = {
  merchants: {},      // key: merchantId (привязка строго к ИП / БИН)
  users: {},          // key: telegramId -> { telegramId, username, firstName, activeMerchantId, state }
  pendingAuth: {},    // key: phone -> { phone, smsSessionId, cookies, createdAt, telegramId }
  logs: []            // история автодемпинга (-1 тг) и событий НКТ
};

function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
      return JSON.parse(JSON.stringify(defaultData));
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return { ...defaultData, ...JSON.parse(raw) };
  } catch (err) {
    console.error('Ошибка чтения БД:', err);
    return JSON.parse(JSON.stringify(defaultData));
  }
}

let db = loadDb();

function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка сохранения БД:', err);
  }
}

/**
 * Создает демо-товары при первом подключении ИП (как в реальном кабинете Kaspi),
 * включая пример пользователя (45 500 ₸ vs конкурент 45 498 ₸ -> бот делает 45 497 ₸)
 * и товары со статусом НКТ (Registered / NotRegistered для context=nct).
 */
function generateDefaultProducts(merchantId) {
  return [
    {
      id: 'prod_1',
      merchantId,
      sku: 'KS-10849201',
      masterSku: '10849201',
      title: 'Смартфон Apple iPhone 15 128GB Черный',
      status: 'Published',
      price: 45500,
      minPrice: 41000,
      maxPrice: 48000,
      step: 1,
      competitorPrice: 45498,
      competitorName: 'TechnoDom KZ',
      place: 2,
      totalOffers: 14,
      botEnabled: true,
      stock: 12,
      gtin: '195949035944',
      nctStatus: 'NotRegistered',
      ntin: null,
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_2',
      merchantId,
      sku: 'KS-10423199',
      masterSku: '10423199',
      title: 'Наушники Apple AirPods Pro 2 with MagSafe USB-C',
      status: 'Published',
      price: 98500,
      minPrice: 92000,
      maxPrice: 105000,
      step: 1,
      competitorPrice: 98490,
      competitorName: 'Alser Shop',
      place: 2,
      totalOffers: 23,
      botEnabled: true,
      stock: 8,
      gtin: '195949052484',
      nctStatus: 'NotRegistered',
      ntin: null,
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_3',
      merchantId,
      sku: 'KS-11094821',
      masterSku: '11094821',
      title: 'Пылесос Dyson V15 Detect Absolute серебристый',
      status: 'Published',
      price: 315000,
      minPrice: 295000,
      maxPrice: 340000,
      step: 1,
      competitorPrice: 315500,
      competitorName: 'EuroMebel KZ',
      place: 1,
      totalOffers: 9,
      botEnabled: true,
      stock: 4,
      gtin: '5025155073193',
      nctStatus: 'NotRegistered',
      ntin: null,
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_4',
      merchantId,
      sku: 'KS-10293847',
      masterSku: '10293847',
      title: 'Кофемашина DeLonghi Magnifica Evo ECAM290.81.TB',
      status: 'Published',
      price: 264990,
      minPrice: 250000,
      maxPrice: 285000,
      step: 1,
      competitorPrice: 264985,
      competitorName: 'CoffeeHome Almaty',
      place: 2,
      totalOffers: 11,
      botEnabled: true,
      stock: 5,
      gtin: '8004399021396',
      nctStatus: 'Registered',
      ntin: '0280043990213',
      updatedAt: new Date().toISOString()
    },
    {
      id: 'prod_5',
      merchantId,
      sku: 'KS-10998877',
      masterSku: '10998877',
      title: 'Умная колонка Яндекс Станция Миди с Zigbee черный',
      status: 'Published',
      price: 69990,
      minPrice: 64000,
      maxPrice: 74990,
      step: 1,
      competitorPrice: 70500,
      competitorName: 'SmartHome KZ',
      place: 1,
      totalOffers: 18,
      botEnabled: true,
      stock: 19,
      gtin: '4607161627811',
      nctStatus: 'Registered',
      ntin: '0246071616278',
      updatedAt: new Date().toISOString()
    }
  ];
}

/**
 * Найти или создать ИП по номеру телефона / БИН.
 * Подписка привязывается СТРОГО к ИП (Merchant), а не к отдельному аккаунту!
 */
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

    // Подписка выдается строго на ИП (1 раз тестовый/активный период на БИН)
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
        autoExtractedApiToken: sessionData?.apiToken || ('ks_live_' + crypto.randomBytes(12).toString('hex')),
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
    // Обновляем сессию Kaspi при повторном входе по SMS, но НЕ сбрасываем историю подписки ИП!
    existing.kaspiSession = {
      ...existing.kaspiSession,
      connected: true,
      lastSmsRefreshAt: new Date().toISOString()
    };
  }

  // Проверяем и добавляем устройство в лимит 3-4 устройств этого ИП
  let deviceAuthResult = { allowed: true, reason: null };
  if (ownerDevice) {
    deviceAuthResult = registerDeviceForMerchant(existing.id, ownerDevice);
  }

  saveDb();
  return { merchant: existing, deviceAuthResult };
}

/**
 * Контроль лимита 3-4 устройств на 1 ИП.
 */
function registerDeviceForMerchant(merchantId, deviceInfo) {
  const merchant = db.merchants[merchantId];
  if (!merchant) return { allowed: false, reason: 'ИП не найдено' };

  const existingIdx = merchant.devices.findIndex(
    (d) => String(d.deviceId) === String(deviceInfo.deviceId)
  );

  if (existingIdx !== -1) {
    merchant.devices[existingIdx].lastActiveAt = new Date().toISOString();
    merchant.devices[existingIdx].deviceName = deviceInfo.deviceName || merchant.devices[existingIdx].deviceName;
    saveDb();
    return { allowed: true, device: merchant.devices[existingIdx], isNew: false };
  }

  // Если устройств уже 4 (или maxDevices) — НЕ ПУСКАЕМ 5-е устройство!
  if (merchant.devices.length >= merchant.maxDevices) {
    return {
      allowed: false,
      reason: `Превышен лимит устройств для ${merchant.name} (БИН ${merchant.bin}): активно ${merchant.devices.length} из ${merchant.maxDevices}. Отключите одно из устройств, чтобы войти.`
    };
  }

  const newDevice = {
    deviceId: String(deviceInfo.deviceId),
    telegramId: deviceInfo.telegramId || null,
    deviceName: deviceInfo.deviceName || 'Устройство Telegram',
    role: merchant.devices.length === 0 ? 'Владелец ИП' : 'Менеджер / Устройство',
    ip: deviceInfo.ip || 'Kaspi-Proxy-KZ',
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
  return logItem;
}

module.exports = {
  getDb: () => db,
  saveDb,
  upsertMerchantByPhone,
  registerDeviceForMerchant,
  removeDeviceFromMerchant,
  addLog
};

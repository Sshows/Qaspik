const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DOMParser, onWarningStopParsing } = require('@xmldom/xmldom');
const { readFeed, applyFeedPrices } = require('./priceFeed');
const { getUndercutStep } = require('./pricePolicy');
const { extractMasterSku, scanKaspiOffers, CITIES } = require('./kaspiMarketScanner');

const KASPI_NS = 'kaspiShopping';
const WORKER_ONLINE_WINDOW_MS = 3 * 60 * 1000;

class StorageUnavailableError extends Error {
  constructor(message = 'Хранилище Supabase временно недоступно. Повторите позже.') {
    super(message);
    this.name = 'StorageUnavailableError';
    this.status = 503;
    this.code = 'STORAGE_UNAVAILABLE';
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(prefix, bytes = 16) {
  return prefix + crypto.randomBytes(bytes).toString('hex');
}

function defaultRulesConfig() {
  return {
    defaults: {
      standardStep: 10,
      nearFloorWindow: 200,
      atFloor: 'hold',
      autoRaise: true,
      filters: {
        minRating: 4.0,
        minReviews: 0,
        maxPreorderDays: 0,
        excludedMerchantIds: [],
        deliveryCategories: []
      }
    },
    products: []
  };
}

/**
 * Извлекает merchantId, companyName и подробный список товаров (sku, model, brand, price/cityPrices) из полного XML Kaspi.
 */
function parseKaspiCatalogSummary(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('Загрузите полный XML-прайс-лист из кабинета продавца Kaspi');
  }
  const bomLength = xml.startsWith('\uFEFF') ? 1 : 0;
  let doc;
  try {
    doc = new DOMParser({
      normalizeLineEndings: (source) => source,
      onError: onWarningStopParsing
    }).parseFromString(xml.slice(bomLength), 'application/xml');
  } catch (_) {
    throw new Error('Некорректный XML-прайс-лист');
  }

  const root = doc.documentElement;
  const children = (node) => Array.from(node.childNodes).filter((n) => n.nodeType === 1);
  const byName = (node, name) => children(node).filter((n) => n.namespaceURI === KASPI_NS && n.localName === name);

  const merchantId = byName(root, 'merchantid')[0]?.textContent?.trim();
  const companyName = byName(root, 'company')[0]?.textContent?.trim();
  if (!merchantId) throw new Error('В XML не найден тег <merchantid>');
  if (!companyName) throw new Error('В XML не найден тег <company>');

  // Строгая проверка через проверенный парсер priceFeed
  const validated = readFeed(xml, { merchantId });

  const offersRoot = byName(root, 'offers')[0];
  const metaBySku = new Map();
  for (const offerNode of byName(offersRoot, 'offer')) {
    const sku = offerNode.getAttribute('sku');
    const model = byName(offerNode, 'model')[0]?.textContent?.trim() || sku;
    const brand = byName(offerNode, 'brand')[0]?.textContent?.trim() || '';
    metaBySku.set(sku, { model, brand });
  }

  const positions = [];
  for (const offer of validated.offers) {
    const meta = metaBySku.get(offer.sku) || { model: offer.sku, brand: '' };
    if (Array.isArray(offer.cityPrices)) {
      for (const cp of offer.cityPrices) {
        positions.push({
          sku: offer.sku,
          cityId: cp.cityId,
          cityName: CITIES.get(cp.cityId) || cp.cityId,
          price: cp.price,
          model: meta.model,
          brand: meta.brand
        });
      }
    } else {
      positions.push({
        sku: offer.sku,
        cityId: undefined,
        cityName: 'Общая цена',
        price: offer.price,
        model: meta.model,
        brand: meta.brand
      });
    }
  }

  return { merchantId, companyName, positions };
}

/**
 * Расчёт новой цены для одного товара на основании живых предложений с витрины Kaspi.
 */
function evaluateLiveOffers({
  currentPrice,
  rule,
  defaults,
  offers,
  ownMerchantId,
  ownCompanyName
}) {
  const minPrice = Number(rule.minPrice);
  const maxPrice = rule.maxPrice !== undefined && rule.maxPrice !== null && rule.maxPrice !== ''
    ? Number(rule.maxPrice)
    : undefined;
  const standardStep = Number(rule.standardStep ?? defaults.standardStep ?? 10);
  const nearFloorWindow = Number(rule.nearFloorWindow ?? defaults.nearFloorWindow ?? 200);
  const atFloor = rule.atFloor ?? defaults.atFloor ?? 'hold';
  const autoRaise = rule.autoRaise ?? defaults.autoRaise ?? true;
  const filters = defaults.filters || {};

  const ownIdLower = String(ownMerchantId || '').trim().toLowerCase();
  const ownNameLower = String(ownCompanyName || '').trim().toLowerCase();
  const excludedSet = new Set(
    (filters.excludedMerchantIds || []).map((id) => String(id).trim().toLowerCase()).filter(Boolean)
  );
  const minRating = filters.minRating !== undefined && filters.minRating !== '' ? Number(filters.minRating) : undefined;
  const minReviews = filters.minReviews !== undefined && filters.minReviews !== '' ? Number(filters.minReviews) : undefined;
  const maxPreorderDays = filters.maxPreorderDays !== undefined && filters.maxPreorderDays !== ''
    ? Number(filters.maxPreorderDays)
    : undefined;
  const deliveryCategories = Array.isArray(filters.deliveryCategories)
    ? filters.deliveryCategories.filter(Boolean)
    : [];

  let ownPosition = null;
  const standings = [];
  const eligibleCompetitors = [];
  const ignoredCompetitors = [];

  const sortedOffers = [...(offers || [])].sort((a, b) => a.price - b.price);
  sortedOffers.forEach((offer, idx) => {
    const idLower = String(offer.merchantId || '').trim().toLowerCase();
    const nameLower = String(offer.merchantName || '').trim().toLowerCase();
    const isOwn = (ownIdLower && idLower === ownIdLower) || (ownNameLower && nameLower === ownNameLower);
    if (isOwn && ownPosition === null) {
      ownPosition = idx + 1;
    }

    let ignoreReason = null;
    if (isOwn) {
      ignoreReason = 'OWN_STORE';
    } else if (excludedSet.has(idLower)) {
      ignoreReason = 'EXCLUDED_SELLER';
    } else if (minRating !== undefined && (offer.rating === undefined || offer.rating < minRating)) {
      ignoreReason = 'LOW_RATING';
    } else if (minReviews !== undefined && (offer.reviewCount === undefined || offer.reviewCount < minReviews)) {
      ignoreReason = 'FEW_REVIEWS';
    } else if (maxPreorderDays !== undefined && offer.preorderDays > maxPreorderDays) {
      ignoreReason = 'PREORDER_TRAP';
    } else if (deliveryCategories.length > 0 && !deliveryCategories.includes(offer.deliveryCategory)) {
      ignoreReason = 'DELIVERY_MISMATCH';
    }

    const isBelowFloor = !isOwn && offer.price < minPrice;
    const entry = {
      position: idx + 1,
      merchantId: offer.merchantId,
      merchantName: offer.merchantName,
      price: offer.price,
      rating: offer.rating,
      reviewCount: offer.reviewCount,
      preorderDays: offer.preorderDays,
      deliveryCategory: offer.deliveryCategory,
      isYou: isOwn,
      isFraudTrap: isBelowFloor || ignoreReason === 'PREORDER_TRAP' || ignoreReason === 'LOW_RATING',
      ignoreReason
    };
    standings.push(entry);

    if (!isOwn) {
      if (ignoreReason) ignoredCompetitors.push(entry);
      else eligibleCompetitors.push(entry);
    }
  });

  const decision = {
    sku: rule.sku,
    masterSku: rule.masterSku,
    cityId: rule.cityId,
    currentPrice,
    minPrice,
    maxPrice,
    ownPosition,
    standings: standings.slice(0, 10),
    fraudTrapsDetected: standings.filter((s) => !s.isYou && s.isFraudTrap).length
  };

  if (eligibleCompetitors.length === 0) {
    return { ...decision, code: 'NO_ELIGIBLE_COMPETITORS', newPrice: currentPrice, changed: false };
  }

  const cheapest = eligibleCompetitors[0];
  decision.competitorName = cheapest.merchantName;
  decision.competitorId = cheapest.merchantId;
  decision.competitorPrice = cheapest.price;

  // Анти-фрод защита порога: конкурент опустился на или ниже minPrice
  if (cheapest.price <= minPrice) {
    // Ищем первого конкурента ВЫШЕ порога, если стратегия hold — не пробиваем порог
    if (atFloor === 'minimum' && currentPrice > minPrice) {
      return {
        ...decision,
        code: 'FLOOR_MINIMUM',
        step: currentPrice - minPrice,
        newPrice: minPrice,
        changed: true
      };
    }
    return {
      ...decision,
      code: 'FLOOR_GUARD',
      newPrice: currentPrice,
      changed: false
    };
  }

  const step = getUndercutStep(cheapest.price, minPrice, standardStep, nearFloorWindow);
  const idealPrice = Math.max(minPrice, cheapest.price - step);
  const boundedPrice = maxPrice !== undefined ? Math.min(maxPrice, idealPrice) : idealPrice;

  if (currentPrice < cheapest.price) {
    // Мы уже на 1-м месте среди реальных конкурентов
    if (!autoRaise || maxPrice === undefined) {
      return { ...decision, code: 'ALREADY_FIRST', newPrice: currentPrice, changed: false };
    }
    if (boundedPrice > currentPrice) {
      return {
        ...decision,
        code: 'AUTO_RAISE',
        step,
        newPrice: boundedPrice,
        changed: true
      };
    }
    return { ...decision, code: 'ALREADY_FIRST', newPrice: currentPrice, changed: false };
  }

  if (boundedPrice === currentPrice) {
    return { ...decision, code: 'NO_CHANGE', newPrice: currentPrice, changed: false };
  }

  return {
    ...decision,
    code: 'UNDERCUT_TO_FIRST',
    step,
    newPrice: boundedPrice,
    changed: true
  };
}

function createCloudBotRepository({
  supabaseUrl,
  supabaseServiceKey,
  requireRemote = Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production'),
  fallbackFile,
  fetchImpl = fetch
} = {}) {
  const url = (supabaseUrl ?? process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = supabaseServiceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const hasSupabase = Boolean(url && key);
  const localPath = fallbackFile || path.join(__dirname, '..', 'data', 'cloud-stores.json');

  const memory = { stores: new Map(), events: [], workerHeartbeatAt: null };

  async function rpc(fnName, params = {}) {
    if (!hasSupabase) {
      if (requireRemote) {
        throw new StorageUnavailableError('В production требуется настройка SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY.');
      }
      return { usedRemote: false, data: null };
    }

    let res;
    try {
      res = await fetchImpl(`${url}/rest/v1/rpc/${fnName}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(6000)
      });
    } catch (_) {
      throw new StorageUnavailableError('Не удалось связаться с базой данных Supabase.');
    }

    if (!res.ok) {
      throw new StorageUnavailableError(`Ошибка хранилища Supabase (${res.status}).`);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { usedRemote: true, data };
  }

  function loadLocal() {
    if (requireRemote) return;
    try {
      if (fs.existsSync(localPath)) {
        const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        for (const row of parsed.stores || []) memory.stores.set(row.id, row);
        memory.events = parsed.events || [];
        memory.workerHeartbeatAt = parsed.workerHeartbeatAt || null;
      }
    } catch (_) {}
  }

  function saveLocal() {
    if (requireRemote) return;
    try {
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        localPath,
        JSON.stringify(
          {
            stores: Array.from(memory.stores.values()),
            events: memory.events.slice(0, 200),
            workerHeartbeatAt: memory.workerHeartbeatAt
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (_) {}
  }

  loadLocal();

  async function upsertStore(store) {
    const record = { ...store, updated_at: new Date().toISOString() };
    const remote = await rpc('qaspik_upsert_cloud_store', { p_store: record });
    if (remote.usedRemote) {
      return remote.data;
    }
    memory.stores.set(record.id, record);
    saveLocal();
    return record;
  }

  async function getStoreById(storeId) {
    const remote = await rpc('qaspik_get_cloud_store', { p_id: storeId });
    if (remote.usedRemote) return remote.data || null;
    return memory.stores.get(storeId) || null;
  }

  async function getStoreByFeedToken(feedToken) {
    const remote = await rpc('qaspik_get_cloud_store', { p_feed_token: feedToken });
    if (remote.usedRemote) return remote.data || null;
    for (const store of memory.stores.values()) {
      if (store.feed_token === feedToken) return store;
    }
    return null;
  }

  async function getStoreByTelegramLinkCode(code) {
    const remote = await rpc('qaspik_get_cloud_store', { p_tg_code: code });
    if (remote.usedRemote) return remote.data || null;
    for (const store of memory.stores.values()) {
      if (store.telegram_link_code === code) return store;
    }
    return null;
  }

  async function getStoreByTelegramChatId(chatId) {
    const id = String(chatId);
    const remote = await rpc('qaspik_get_cloud_store', { p_tg_chat_id: id });
    if (remote.usedRemote) return remote.data || null;
    for (const store of memory.stores.values()) {
      if (String(store.telegram_chat_id) === id) return store;
    }
    return null;
  }

  async function listActiveStores() {
    const remote = await rpc('qaspik_list_active_cloud_stores');
    if (remote.usedRemote) return Array.isArray(remote.data) ? remote.data : [];
    const now = Date.now();
    return Array.from(memory.stores.values()).filter(
      (s) => s.bot_enabled && s.subscription_active && Date.parse(s.subscription_expires_at) > now
    );
  }

  async function addPriceEvent(event) {
    const row = {
      id: 'evt_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      created_at: new Date().toISOString(),
      ...event
    };
    const remote = await rpc('qaspik_add_price_event', { p_event: row });
    if (remote.usedRemote) return remote.data;
    memory.events.unshift(row);
    if (memory.events.length > 200) memory.events = memory.events.slice(0, 200);
    saveLocal();
    return row;
  }

  async function listEventsForStore(storeId, limit = 30) {
    const remote = await rpc('qaspik_list_price_events', { p_store_id: storeId, p_limit: limit });
    if (remote.usedRemote) return Array.isArray(remote.data) ? remote.data : [];
    return memory.events.filter((e) => e.store_id === storeId).slice(0, limit);
  }

  async function touchWorkerHeartbeat() {
    const remote = await rpc('qaspik_touch_worker_heartbeat');
    if (remote.usedRemote) return remote.data;
    memory.workerHeartbeatAt = new Date().toISOString();
    saveLocal();
    return memory.workerHeartbeatAt;
  }

  async function getWorkerHeartbeat() {
    const remote = await rpc('qaspik_get_worker_heartbeat');
    if (remote.usedRemote) return remote.data || null;
    return memory.workerHeartbeatAt;
  }

  return {
    upsertStore,
    getStoreById,
    getStoreByFeedToken,
    getStoreByTelegramLinkCode,
    getStoreByTelegramChatId,
    listActiveStores,
    addPriceEvent,
    listEventsForStore,
    touchWorkerHeartbeat,
    getWorkerHeartbeat
  };
}

function createCloudBotEngine(repository = createCloudBotRepository()) {
  async function registerStore({ xml, cityId = '750000000' }) {
    const summary = parseKaspiCatalogSummary(xml);
    const storeId = 'st_' + crypto.randomBytes(8).toString('hex');
    const manageToken = randomToken('qm_', 18);
    const feedToken = randomToken('qf_', 16);
    const telegramLinkCode = 'link_' + crypto.randomBytes(6).toString('hex');

    const normalizedCity = CITIES.has(String(cityId)) ? String(cityId) : '750000000';
    const record = await repository.upsertStore({
      id: storeId,
      merchant_id: summary.merchantId,
      company_name: summary.companyName,
      city_id: normalizedCity,
      feed_token: feedToken,
      manage_token_hash: sha256Hex(manageToken),
      telegram_link_code: telegramLinkCode,
      telegram_chat_id: null,
      catalog_xml: xml,
      rules_json: defaultRulesConfig(),
      last_standings_json: {},
      bot_enabled: true,
      subscription_active: false,
      subscription_expires_at: new Date().toISOString(),
      last_run_at: null,
      created_at: new Date().toISOString()
    });

    return {
      storeId: record.id,
      merchantId: record.merchant_id,
      companyName: record.company_name,
      cityId: record.city_id,
      manageToken,
      feedToken,
      telegramLinkCode,
      positions: summary.positions,
      rules: record.rules_json,
      botEnabled: record.bot_enabled,
      subscriptionActive: record.subscription_active
    };
  }

  async function setStoreSubscription(storeId, { active, expiresAt }) {
    const store = await repository.getStoreById(storeId);
    if (!store) return { ok: false, status: 404, error: 'Магазин не найден' };
    const nextActive = Boolean(active);
    const nextExpires = expiresAt
      ? new Date(expiresAt).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const updated = await repository.upsertStore({
      ...store,
      subscription_active: nextActive,
      subscription_expires_at: nextExpires
    });
    return {
      ok: true,
      storeId: updated.id,
      subscriptionActive: updated.subscription_active,
      subscriptionExpiresAt: updated.subscription_expires_at
    };
  }

  async function touchWorkerHeartbeat() {
    return repository.touchWorkerHeartbeat();
  }

  async function getWorkerStatus() {
    const lastHeartbeatAt = await repository.getWorkerHeartbeat();
    const online = Boolean(
      lastHeartbeatAt && Date.now() - Date.parse(lastHeartbeatAt) <= WORKER_ONLINE_WINDOW_MS
    );
    return { lastHeartbeatAt, online };
  }

  async function verifyStoreAccess(storeId, manageToken) {
    if (!storeId || !manageToken) return null;
    const store = await repository.getStoreById(storeId);
    if (!store) return null;
    const expected = Buffer.from(store.manage_token_hash || '', 'utf8');
    const actual = Buffer.from(sha256Hex(manageToken), 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return null;
    }
    return store;
  }

  async function updateStoreRules(storeId, manageToken, payload) {
    const store = await verifyStoreAccess(storeId, manageToken);
    if (!store) return { ok: false, status: 401, error: 'Неверный ключ доступа к магазину' };

    const summary = parseKaspiCatalogSummary(payload.xml || store.catalog_xml);
    if (summary.merchantId !== store.merchant_id) {
      return { ok: false, status: 400, error: 'XML принадлежит другому merchantId' };
    }

    const existingRules = store.rules_json || defaultRulesConfig();
    const defaults = {
      ...defaultRulesConfig().defaults,
      ...(existingRules.defaults || {}),
      ...(payload.defaults || {}),
      filters: {
        ...defaultRulesConfig().defaults.filters,
        ...(existingRules.defaults?.filters || {}),
        ...(payload.defaults?.filters || {})
      }
    };

    const cleanedProducts = [];
    for (const item of payload.products || []) {
      const sku = String(item?.sku || '').trim();
      const masterSku = extractMasterSku(item?.masterSku || item?.kaspiUrl || '');
      const minPrice = Number(item?.minPrice);
      const maxPrice = item?.maxPrice !== undefined && item?.maxPrice !== null && item?.maxPrice !== ''
        ? Number(item.maxPrice)
        : undefined;
      if (!sku) continue;
      if (!Number.isSafeInteger(minPrice) || minPrice < 1) {
        return { ok: false, status: 400, error: `Укажите корректный нижний порог (minPrice) для SKU ${sku}` };
      }
      if (maxPrice !== undefined && (!Number.isSafeInteger(maxPrice) || maxPrice < minPrice)) {
        return { ok: false, status: 400, error: `maxPrice должен быть не меньше minPrice для SKU ${sku}` };
      }
      cleanedProducts.push({
        sku,
        cityId: item.cityId ? String(item.cityId).trim() : undefined,
        masterSku: masterSku || undefined,
        minPrice,
        maxPrice,
        standardStep: item.standardStep ? Number(item.standardStep) : undefined,
        nearFloorWindow: item.nearFloorWindow !== undefined && item.nearFloorWindow !== '' ? Number(item.nearFloorWindow) : undefined,
        atFloor: item.atFloor || undefined,
        autoRaise: typeof item.autoRaise === 'boolean' ? item.autoRaise : undefined,
        enabled: item.enabled !== false
      });
    }

    const updated = await repository.upsertStore({
      ...store,
      city_id: payload.cityId && CITIES.has(String(payload.cityId)) ? String(payload.cityId) : store.city_id,
      catalog_xml: payload.xml || store.catalog_xml,
      bot_enabled: typeof payload.botEnabled === 'boolean' ? payload.botEnabled : store.bot_enabled,
      rules_json: { defaults, products: cleanedProducts }
    });

    return {
      ok: true,
      storeId: updated.id,
      botEnabled: updated.bot_enabled,
      rules: updated.rules_json,
      positions: summary.positions
    };
  }

  async function runStoreCycle(store, { fetchImpl = fetch, telegramBot = null } = {}) {
    if (!store.bot_enabled || !store.subscription_active) {
      return { ok: true, skipped: true, reason: 'INACTIVE', changes: [], decisions: [] };
    }
    if (Date.parse(store.subscription_expires_at) <= Date.now()) {
      return { ok: true, skipped: true, reason: 'SUBSCRIPTION_EXPIRED', changes: [], decisions: [] };
    }

    const summary = parseKaspiCatalogSummary(store.catalog_xml);
    const priceByKey = new Map();
    const modelBySku = new Map();
    for (const pos of summary.positions) {
      priceByKey.set(`${pos.sku}/${pos.cityId || ''}`, pos.price);
      modelBySku.set(pos.sku, pos.model);
    }

    const rules = store.rules_json || defaultRulesConfig();
    const defaults = rules.defaults || defaultRulesConfig().defaults;
    const products = (rules.products || []).filter((p) => p.enabled !== false && p.masterSku);

    const changes = [];
    const decisions = [];
    const standingsMap = { ...(store.last_standings_json || {}) };

    for (const rule of products) {
      const key = `${rule.sku}/${rule.cityId || ''}`;
      const currentPrice = priceByKey.get(key);
      if (!Number.isSafeInteger(currentPrice)) {
        decisions.push({ sku: rule.sku, cityId: rule.cityId, code: 'SKU_NOT_IN_XML' });
        continue;
      }

      const scanCityId = rule.cityId || store.city_id || '750000000';
      const scan = await scanKaspiOffers({
        masterSku: rule.masterSku,
        cityId: scanCityId,
        limit: 15,
        fetchImpl
      });

      if (!scan.ok) {
        decisions.push({
          sku: rule.sku,
          masterSku: rule.masterSku,
          cityId: rule.cityId,
          currentPrice,
          code: scan.code,
          error: scan.error
        });
        if (scan.code === 'KASPI_RATE_LIMITED' || scan.code === 'KASPI_ACCESS_BLOCKED') {
          break;
        }
        continue;
      }

      const decision = evaluateLiveOffers({
        currentPrice,
        rule,
        defaults,
        offers: scan.offers,
        ownMerchantId: store.merchant_id,
        ownCompanyName: store.company_name
      });

      standingsMap[key] = {
        sku: rule.sku,
        masterSku: rule.masterSku,
        model: modelBySku.get(rule.sku) || rule.sku,
        cityId: scanCityId,
        cityName: scan.cityName,
        observedAt: scan.observedAt,
        totalOffers: scan.totalOffers,
        ...decision
      };

      decisions.push(decision);
      if (decision.changed && Number.isSafeInteger(decision.newPrice) && decision.newPrice >= rule.minPrice) {
        changes.push({ sku: rule.sku, cityId: rule.cityId, price: decision.newPrice });
      }
    }

    let nextXml = store.catalog_xml;
    if (changes.length > 0) {
      nextXml = applyFeedPrices(store.catalog_xml, {
        merchantId: store.merchant_id,
        changes
      });
    }

    await repository.upsertStore({
      ...store,
      catalog_xml: nextXml,
      last_standings_json: standingsMap,
      last_run_at: new Date().toISOString()
    });

    const loggedEvents = [];
    for (const d of decisions) {
      if (!d.changed && d.code !== 'FLOOR_GUARD') continue;
      const model = modelBySku.get(d.sku) || d.sku;
      const msg = d.changed
        ? `📄 XML_PREPARED · ${model}: ${d.currentPrice.toLocaleString('ru-RU')} ₸ → ${d.newPrice.toLocaleString('ru-RU')} ₸ (подготовлено в XML-фиде; конкурент ${d.competitorName}: ${d.competitorPrice?.toLocaleString('ru-RU')} ₸)`
        : `🛡 ${model}: сработал защитный порог ${d.minPrice.toLocaleString('ru-RU')} ₸ (конкурент ${d.competitorName}: ${d.competitorPrice?.toLocaleString('ru-RU')} ₸)`;

      const ev = await repository.addPriceEvent({
        store_id: store.id,
        sku: d.sku,
        master_sku: d.masterSku,
        city_id: d.cityId || store.city_id,
        old_price: d.currentPrice,
        new_price: d.newPrice,
        competitor_name: d.competitorName || null,
        competitor_price: d.competitorPrice || null,
        decision_code: d.changed ? 'XML_PREPARED' : d.code,
        message: msg
      });
      loggedEvents.push(ev);

      if (telegramBot && store.telegram_chat_id && d.changed) {
        await telegramBot.telegram
          .sendMessage(
            store.telegram_chat_id,
            `📄 *Цена подготовлена в XML-прайсе (ожидает автозагрузки Kaspi)*\n\n` +
              `🏪 Магазин: *${store.company_name}*\n` +
              `📦 Товар: *${model}* (\`${d.sku}\`)\n` +
              `👀 Конкурент (${d.competitorName}): \`${d.competitorPrice?.toLocaleString('ru-RU')} ₸\`\n` +
              `💰 Новая цена в XML: ${d.currentPrice.toLocaleString('ru-RU')} ₸ → *${d.newPrice.toLocaleString('ru-RU')} ₸*\n` +
              `🛡 Порог: \`${d.minPrice.toLocaleString('ru-RU')} ₸\``,
            { parse_mode: 'Markdown' }
          )
          .catch(() => null);
      }
    }

    return {
      ok: true,
      storeId: store.id,
      checkedProducts: products.length,
      changes,
      decisions,
      events: loggedEvents
    };
  }

  async function runAllActiveStores({ fetchImpl = fetch, telegramBot = null } = {}) {
    const stores = await repository.listActiveStores();
    const results = [];
    for (const store of stores) {
      const res = await runStoreCycle(store, { fetchImpl, telegramBot });
      results.push(res);
    }
    return { ok: true, storesProcessed: stores.length, results };
  }

  async function linkTelegramChat(linkCode, chatId) {
    const store = await repository.getStoreByTelegramLinkCode(linkCode);
    if (!store) return { ok: false, error: 'Код привязки магазина не найден' };
    const updated = await repository.upsertStore({
      ...store,
      telegram_chat_id: String(chatId)
    });
    return { ok: true, store: updated };
  }

  return {
    repository,
    parseKaspiCatalogSummary,
    evaluateLiveOffers,
    registerStore,
    verifyStoreAccess,
    updateStoreRules,
    setStoreSubscription,
    touchWorkerHeartbeat,
    getWorkerStatus,
    runStoreCycle,
    runAllActiveStores,
    linkTelegramChat
  };
}

module.exports = {
  StorageUnavailableError,
  parseKaspiCatalogSummary,
  evaluateLiveOffers,
  createCloudBotRepository,
  createCloudBotEngine
};

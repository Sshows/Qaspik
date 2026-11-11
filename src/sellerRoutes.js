const express = require('express');

const API_URL = 'https://kaspi.kz/shop/api/v2';
const PAGE_SIZE = 20;
const DAY = 24 * 60 * 60 * 1000;
const ORDER_STATES = new Set(['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE']);
const JSON_API = 'application/vnd.api+json';
const almatyOffset = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Almaty',
  timeZoneName: 'longOffset'
});

function offsetAt(timestamp) {
  const offset = almatyOffset.formatToParts(timestamp).find((part) => part.type === 'timeZoneName').value;
  const [, sign, hours, minutes] = /^GMT([+-])(\d\d):(\d\d)$/.exec(offset) || [];
  return sign ? (sign === '+' ? 1 : -1) * (Number(hours) * 60 + Number(minutes)) * 60_000 : 0;
}

function localMidnight(utcMidnight) {
  const estimate = utcMidnight - offsetAt(utcMidnight);
  return utcMidnight - offsetAt(estimate);
}

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const day = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value ? day : NaN;
}

function pageNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10000;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[^a-zA-Z0-9+/_=-]/.test(value);
}

function safeText(value, length) {
  return typeof value === 'string' ? value.slice(0, length) : null;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function getKaspi(fetchKaspi, path, token, signal, query) {
  try {
    const url = new URL(API_URL + path);
    if (query) url.search = new URLSearchParams(query).toString();
    const response = await fetchKaspi(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        Accept: JSON_API,
        'Content-Type': JSON_API,
        'X-Auth-Token': token
      }
    });
    if (!response.ok) {
      return { status: response.status, retryAfter: response.headers?.get('Retry-After') };
    }
    const document = await response.json();
    return { status: 200, document };
  } catch (_) {
    return { status: signal.aborted ? 504 : 502 };
  }
}

function respondToFailure(res, upstream) {
  if (upstream.status === 401) return res.status(401).json({ error: 'Kaspi отклонил API-ключ. Проверьте ключ в кабинете продавца.' });
  if (upstream.status === 403) return res.status(403).json({ error: 'Kaspi ограничил доступ к данным. Проверьте API-ключ и доступ к магазину.' });
  if (upstream.status === 404) return res.status(404).json({ error: 'Kaspi не нашёл этот заказ.' });
  if (upstream.status === 429) {
    if (/^\d{1,7}$/.test(upstream.retryAfter || '')) res.set('Retry-After', upstream.retryAfter);
    return res.status(429).json({ error: 'Kaspi ограничил число запросов. Попробуйте позже.' });
  }
  if (upstream.status === 504) return res.status(504).json({ error: 'Kaspi не ответил вовремя. Попробуйте ещё раз.' });
  return res.status(502).json({ error: 'Kaspi вернул неожиданный ответ. Попробуйте ещё раз.' });
}

function createSellerRouter(enabled, fetchKaspi = fetch, webAccess = null) {
  const router = express.Router();
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const isLocal = (req) => enabled && loopback.has(req.hostname);
  const isWeb = (req) => Boolean(webAccess && req.get('host') === webAccess.host);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const origin = req.get('origin');
    const allowedOrigin = isWeb(req) ? webAccess.origin : req.protocol + '://' + req.get('host');
    if ((origin && origin !== allowedOrigin) || (isWeb(req) && req.method === 'POST' && !origin)) {
      return res.status(403).json({ error: 'Откройте подключение на сайте Qaspik.' });
    }
    return next();
  });

  router.get('/capabilities', (req, res) => res.json({
    enabled: Boolean(isLocal(req) || isWeb(req))
  }));

  router.use((req, res, next) => {
    if (!isLocal(req) && !isWeb(req)) {
      return res.status(503).json({ error: 'Подключение продавца недоступно на этом адресе.' });
    }
    return next();
  });

  router.use(express.json({ limit: '8kb' }));

  router.use((req, res, next) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 1024 || /[^!-~]/.test(token)) {
      return res.status(400).json({ error: 'Введите API-ключ из кабинета продавца Kaspi.' });
    }
    return next();
  });

  async function reserveWebBudget(req, res, cost) {
    if (!isWeb(req)) return true;
    const allowed = await webAccess.reserve(req.get('x-vercel-forwarded-for'), cost);
    if (allowed === true) return true;
    if (allowed === false) {
      res.set('Retry-After', '60').status(429).json({ error: 'Лимит запросов Qaspik. Повторите через минуту.' });
    } else {
      res.status(503).json({ error: 'Подключение временно недоступно. Повторите позже.' });
    }
    return false;
  }

  router.post('/orders', async (req, res) => {
    const { token, page = 0, startDate, endDate, state } = req.body;
    const firstDay = calendarDay(startDate);
    const lastDay = calendarDay(endDate);
    const now = Date.now();
    if (!pageNumber(page) || !ORDER_STATES.has(state) ||
      !Number.isFinite(firstDay) || !Number.isFinite(lastDay) || lastDay < firstDay ||
      lastDay - firstDay >= 14 * DAY || localMidnight(lastDay) > now) {
      return res.status(400).json({ error: 'Выберите состояние и период до 14 календарных дней.' });
    }
    const from = localMidnight(firstDay);
    const to = Math.min(localMidnight(lastDay + DAY) - 1, now);
    if (!await reserveWebBudget(req, res, 1)) return;
    const upstream = await getKaspi(fetchKaspi, '/orders', token, AbortSignal.timeout(8000), {
      'page[number]': page,
      'page[size]': PAGE_SIZE,
      'filter[orders][state]': state,
      'filter[orders][creationDate][$ge]': from,
      'filter[orders][creationDate][$le]': to
    });

    const { data, meta } = upstream.document || {};
    if (upstream.status !== 200 || !Array.isArray(data) || data.some((item) => !validId(item?.id))) {
      return respondToFailure(res, upstream);
    }

    const orders = data.map(({ id, attributes = {} }) => ({
      id,
      code: safeText(attributes?.code, 100),
      state: safeText(attributes?.state, 60),
      status: safeText(attributes?.status, 60),
      creationDate: safeNumber(attributes?.creationDate),
      totalPrice: safeNumber(attributes?.totalPrice)
    }));
    return res.json({
      orders, page,
      totalPages: nonNegativeInteger(meta?.pageCount) ? meta.pageCount : (orders.length ? page + 1 : page),
      totalOrders: nonNegativeInteger(meta?.totalCount) ? meta.totalCount : orders.length
    });
  });

  router.post('/order-items', async (req, res) => {
    const { token, orderId, page = 0 } = req.body;
    if (!validId(orderId) || !pageNumber(page)) {
      return res.status(400).json({ error: 'Выберите заказ из списка.' });
    }
    if (!await reserveWebBudget(req, res, PAGE_SIZE + 1)) return;
    const signal = AbortSignal.timeout(8000);
    const upstream = await getKaspi(fetchKaspi, '/orders/' + encodeURIComponent(orderId) + '/entries', token, signal);
    const entries = upstream.document?.data;
    if (upstream.status !== 200 || !Array.isArray(entries)) return respondToFailure(res, upstream);

    const pageEntries = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const items = pageEntries.map((entry) => ({
      id: validId(entry?.id) ? entry.id : null,
      name: null,
      code: null,
      quantity: safeNumber(entry?.attributes?.quantity),
      totalPrice: safeNumber(entry?.attributes?.totalPrice)
    }));
    let rateLimited = false;
    for (let index = 0; index < items.length && !signal.aborted && !rateLimited; index += 4) {
      await Promise.all(pageEntries.slice(index, index + 4).map(async (entry, offset) => {
        if (!validId(entry?.id) || !entry.relationships?.product?.data?.id) return;
        const result = await getKaspi(fetchKaspi, '/orderentries/' + encodeURIComponent(entry.id) + '/product', token, signal);
        if (result.status === 429) rateLimited = true;
        const product = result.document?.data?.attributes;
        items[index + offset].name = safeText(product?.name, 300);
        items[index + offset].code = safeText(product?.code, 100);
      }));
    }

    return res.json({
      items, page,
      totalPages: Math.ceil(entries.length / PAGE_SIZE),
      totalItems: entries.length
    });
  });

  router.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Запрос слишком большой.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Не удалось прочитать запрос.' });
    return res.status(502).json({ error: 'Не удалось загрузить данные Kaspi.' });
  });
  return router;
}

module.exports = { createSellerRouter };

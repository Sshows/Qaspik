(() => {
  const byId = (id) => document.getElementById(id);
  const STORAGE_KEY = 'qaspik_cloud_store_v1';

  const scanForm = byId('liveScanForm');
  const scanStatus = byId('liveScanStatus');
  const scanResults = byId('liveScanResults');
  const scanSummary = byId('liveScanSummary');
  const scanBody = byId('liveScanBody');

  const connectBox = byId('cloudStoreConnectBox');
  const dashboardBox = byId('cloudStoreDashboard');
  const connectStatus = byId('cloudConnectStatus');
  const storeNameEl = byId('cloudStoreName');
  const storeMetaEl = byId('cloudStoreMeta');
  const feedUrlInput = byId('cloudFeedUrl');
  const tgLinkBtn = byId('cloudTgLinkBtn');
  const tgStatusEl = byId('cloudTgStatus');
  const botToggleEl = byId('cloudBotEnabled');
  const rulesBody = byId('cloudRulesBody');
  const runStatusEl = byId('cloudRunStatus');
  const eventsListEl = byId('cloudEventsList');

  let credentials = loadCredentials();
  let currentStore = null;

  function loadCredentials() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.storeId && parsed?.manageToken) return parsed;
    } catch (_) {}
    return null;
  }

  function saveCredentials(next) {
    credentials = next;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function fmt(price) {
    return Number.isFinite(Number(price)) ? Number(price).toLocaleString('ru-RU') + ' ₸' : '—';
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 1. Живой сканер любой карточки Kaspi.kz
  async function runLiveScan(event) {
    if (event) event.preventDefault();
    const query = byId('liveScanQuery').value.trim();
    const cityId = byId('liveScanCity').value;
    const step = Number(byId('liveScanStep').value || 10);
    const minPriceRaw = byId('liveScanMinPrice').value.trim();
    const minPrice = minPriceRaw ? Number(minPriceRaw) : undefined;

    if (!query) {
      scanStatus.textContent = 'Вставьте ссылку с kaspi.kz или код товара (например 113137790).';
      return;
    }

    scanStatus.textContent = 'Запрашиваем живых продавцов на Kaspi.kz…';
    scanResults.hidden = true;

    try {
      const res = await fetch('/api/bot/scan-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, cityId, step, minPrice })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        scanStatus.textContent = data.error || 'Не удалось получить предложения Kaspi.';
        return;
      }

      if (!data.offers || data.offers.length === 0) {
        scanStatus.textContent = `По коду ${data.masterSku} в городе ${data.cityName} сейчас нет активных продавцов.`;
        return;
      }

      const leader = data.offers[0];
      const rec = data.recommendation;
      scanSummary.innerHTML =
        `<div><strong>1-е место сейчас:</strong> ${escapeHtml(leader.merchantName)} — <strong>${fmt(leader.price)}</strong> (всего продавцов: ${data.totalOffers})</div>` +
        (rec
          ? `<div style="margin-top:4px; color:var(--green-text);"><strong>Действие бота Qaspik:</strong> выставит <strong>${fmt(rec.newPrice)}</strong> (шаг -${step} ₸, порог защиты: ${fmt(rec.minPrice)}) → <strong>1-е место</strong></div>`
          : '');

      scanBody.innerHTML = data.offers
        .map((offer, idx) => `
          <tr>
            <td><strong>#${idx + 1}</strong></td>
            <td>
              <div style="font-weight:600;">${escapeHtml(offer.merchantName)}</div>
              <div style="font-size:11.5px; color:var(--text-muted);">ID: ${escapeHtml(offer.merchantId)}</div>
            </td>
            <td><strong>${fmt(offer.price)}</strong></td>
            <td>${offer.rating != null ? `★ ${offer.rating} (${offer.reviewCount ?? 0})` : '—'}</td>
            <td>${offer.preorderDays > 0 ? `<span class="status-pill limit">Предзаказ ${offer.preorderDays} дн.</span>` : '<span class="status-pill working">В наличии</span>'}</td>
          </tr>
        `)
        .join('');

      scanStatus.textContent = `Обновлено: ${new Date(data.observedAt).toLocaleTimeString('ru-RU')} · Город: ${data.cityName}`;
      scanResults.hidden = false;
    } catch (_) {
      scanStatus.textContent = 'Ошибка сети при обращении к сканеру.';
    }
  }

  if (scanForm) {
    scanForm.addEventListener('submit', runLiveScan);
  }

  document.querySelectorAll('[data-scan-sample]').forEach((btn) => {
    btn.addEventListener('click', () => {
      byId('liveScanQuery').value = btn.dataset.scanSample;
      runLiveScan();
    });
  });

  // 2. Подключение магазина клиента в облако по XML
  async function connectWithXml(xmlText) {
    connectStatus.textContent = 'Проверяем XML-прайс и создаём облачный магазин…';
    const cityId = byId('cloudConnectCity').value || '750000000';
    try {
      const res = await fetch('/api/bot/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xml: xmlText, cityId })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        connectStatus.textContent = data.error || 'Не удалось подключить XML.';
        return;
      }

      saveCredentials({ storeId: data.storeId, manageToken: data.manageToken });
      connectStatus.textContent = '';
      await refreshCloudStore();
      if (typeof showToast === 'function') showToast('Магазин подключён к Автоботу 24/7');
    } catch (_) {
      connectStatus.textContent = 'Не удалось подключиться к серверу Qaspik.';
    }
  }

  const xmlFileInput = byId('cloudXmlFile');
  if (xmlFileInput) {
    xmlFileInput.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
        await connectWithXml(xml);
      } catch (_) {
        connectStatus.textContent = 'Ожидается XML-файл Kaspi в кодировке UTF-8.';
      }
    });
  }

  const sampleXmlBtn = byId('cloudLoadSampleXml');
  if (sampleXmlBtn) {
    sampleXmlBtn.addEventListener('click', async () => {
      const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
<kaspi_catalog date="string" xmlns="kaspiShopping" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="kaspiShopping http://kaspi.kz/kaspishopping.xsd">
  <company>ИП QASPIK CLOUD</company>
  <merchantid>30049999</merchantid>
  <offers>
    <offer sku="IPHONE15-BLK">
      <model>Смартфон Apple iPhone 15 128GB Черный</model>
      <brand>Apple</brand>
      <availabilities><availability available="yes" storeId="PP1"/></availabilities>
      <cityprices><cityprice cityId="750000000">420000</cityprice></cityprices>
    </offer>
    <offer sku="GALAXY-S24">
      <model>Смартфон Samsung Galaxy</model>
      <brand>Samsung</brand>
      <availabilities><availability available="yes" storeId="PP1"/></availabilities>
      <cityprices><cityprice cityId="750000000">495000</cityprice></cityprices>
    </offer>
  </offers>
</kaspi_catalog>`;
      await connectWithXml(sampleXml);
    });
  }

  // 3. Отображение подключенного облачного магазина
  async function refreshCloudStore() {
    if (!credentials) {
      connectBox.hidden = false;
      dashboardBox.hidden = true;
      return;
    }

    try {
      const res = await fetch('/api/bot/stores/' + encodeURIComponent(credentials.storeId), {
        headers: { 'X-Store-Token': credentials.manageToken }
      });
      if (res.status === 401 || res.status === 404) {
        saveCredentials(null);
        connectBox.hidden = false;
        dashboardBox.hidden = true;
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.ok) return;

      currentStore = data;
      connectBox.hidden = true;
      dashboardBox.hidden = false;

      storeNameEl.textContent = data.companyName;
      storeMetaEl.textContent = `Merchant ID: ${data.merchantId} · Store: ${data.storeId}` +
        (data.lastRunAt ? ` · Проверено: ${new Date(data.lastRunAt).toLocaleTimeString('ru-RU')}` : '');
      feedUrlInput.value = data.feedUrl;
      tgLinkBtn.href = data.telegramDeepLink;
      tgStatusEl.textContent = data.telegramLinked ? 'Telegram привязан' : 'Telegram не привязан';
      tgStatusEl.className = 'status-pill ' + (data.telegramLinked ? 'working' : 'disabled');
      botToggleEl.checked = Boolean(data.botEnabled);

      const defs = data.rules?.defaults || {};
      const flt = defs.filters || {};
      byId('cloudDefaultStep').value = defs.standardStep ?? 10;
      byId('cloudDefaultWindow').value = defs.nearFloorWindow ?? 200;
      byId('cloudDefaultFloor').value = defs.atFloor || 'hold';
      byId('cloudDefaultAutoRaise').checked = defs.autoRaise !== false;
      byId('cloudFilterRating').value = flt.minRating ?? 4.0;
      byId('cloudFilterPreorder').value = flt.maxPreorderDays ?? 0;

      renderCloudRulesTable(data);
      renderCloudEvents(data.events || []);
    } catch (_) {}
  }

  function renderCloudRulesTable(data) {
    const existingByKey = new Map();
    for (const r of data.rules?.products || []) {
      existingByKey.set(`${r.sku}/${r.cityId || ''}`, r);
    }
    const standings = data.standings || {};

    const sampleMasterSkus = ['113137790', '123726722', '102298404'];
    rulesBody.innerHTML = (data.positions || [])
      .map((pos, idx) => {
        const key = `${pos.sku}/${pos.cityId || ''}`;
        const rule = existingByKey.get(key) || {};
        const st = standings[key];
        const defaultMin = Math.max(1, Math.round(pos.price * 0.85));
        const defaultMax = Math.round(pos.price * 1.15);
        const suggestedMaster = rule.masterSku || (data.merchantId === '30049999' ? sampleMasterSkus[idx % sampleMasterSkus.length] : '');

        let liveStatusHtml = '<span class="status-pill disabled">Укажите код Kaspi</span>';
        if (st) {
          if (st.code === 'UNDERCUT_TO_FIRST' || st.code === 'ALREADY_FIRST' || st.code === 'AUTO_RAISE') {
            liveStatusHtml = `<span class="status-pill working">1 место · Конкурент: ${fmt(st.competitorPrice)}</span>`;
          } else if (st.code === 'FLOOR_GUARD' || st.code === 'FLOOR_MINIMUM') {
            liveStatusHtml = `<span class="status-pill limit">🛡 Порог · Конкурент: ${fmt(st.competitorPrice)}</span>`;
          } else {
            liveStatusHtml = `<span class="status-pill disabled">${escapeHtml(st.error || st.code)}</span>`;
          }
        }

        return `
          <tr data-cloud-row="${escapeHtml(key)}" data-sku="${escapeHtml(pos.sku)}" data-city="${escapeHtml(pos.cityId || '')}">
            <td>
              <div style="font-weight:600;">${escapeHtml(pos.model)}</div>
              <div style="font-size:11.5px; color:var(--text-muted);">SKU: ${escapeHtml(pos.sku)} · ${escapeHtml(pos.cityName)}</div>
            </td>
            <td><strong>${fmt(pos.price)}</strong></td>
            <td>
              <input class="cloud-input-master" type="text" value="${escapeHtml(suggestedMaster)}" placeholder="Ссылка или код (напр. 113137790)" style="width:170px; height:32px; padding:0 8px; border:1px solid var(--border); border-radius:6px; font-size:12.5px;" />
            </td>
            <td>
              <input class="cloud-input-min" type="number" min="1" value="${rule.minPrice ?? defaultMin}" style="width:105px; height:32px; padding:0 8px; border:1px solid var(--border); border-radius:6px; font-size:12.5px;" />
            </td>
            <td>
              <input class="cloud-input-max" type="number" min="1" value="${rule.maxPrice ?? defaultMax}" style="width:105px; height:32px; padding:0 8px; border:1px solid var(--border); border-radius:6px; font-size:12.5px;" />
            </td>
            <td>${liveStatusHtml}</td>
          </tr>
        `;
      })
      .join('');
  }

  function renderCloudEvents(events) {
    if (!events.length) {
      eventsListEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Пока нет изменений цен. Нажмите «Сохранить и проверить Kaspi сейчас».</div>';
      return;
    }
    eventsListEl.innerHTML = events
      .map((ev) => `
        <div style="display:flex; justify-content:space-between; gap:12px; padding:9px 12px; border:1px solid var(--border-soft); border-radius:8px; font-size:13px;">
          <div>${escapeHtml(ev.message)}</div>
          <div style="color:var(--text-muted); font-size:11.5px; white-space:nowrap;">${new Date(ev.created_at).toLocaleTimeString('ru-RU')}</div>
        </div>
      `)
      .join('');
  }

  async function saveRulesAndOptionallyRun(runAfterSave) {
    if (!credentials || !currentStore) return;
    runStatusEl.textContent = 'Сохраняем правила автобота…';

    const products = [];
    rulesBody.querySelectorAll('tr[data-cloud-row]').forEach((row) => {
      const sku = row.dataset.sku;
      const cityId = row.dataset.city || undefined;
      const masterSku = row.querySelector('.cloud-input-master')?.value.trim();
      const minPrice = Number(row.querySelector('.cloud-input-min')?.value);
      const maxPriceRaw = row.querySelector('.cloud-input-max')?.value.trim();
      const maxPrice = maxPriceRaw ? Number(maxPriceRaw) : undefined;
      if (sku && Number.isSafeInteger(minPrice) && minPrice > 0) {
        products.push({ sku, cityId, masterSku, minPrice, maxPrice, enabled: true });
      }
    });

    const payload = {
      botEnabled: botToggleEl.checked,
      defaults: {
        standardStep: Number(byId('cloudDefaultStep').value || 10),
        nearFloorWindow: Number(byId('cloudDefaultWindow').value || 200),
        atFloor: byId('cloudDefaultFloor').value || 'hold',
        autoRaise: byId('cloudDefaultAutoRaise').checked,
        filters: {
          minRating: Number(byId('cloudFilterRating').value || 0),
          maxPreorderDays: Number(byId('cloudFilterPreorder').value || 0)
        }
      },
      products
    };

    try {
      const saveRes = await fetch('/api/bot/stores/' + encodeURIComponent(credentials.storeId) + '/rules', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Store-Token': credentials.manageToken
        },
        body: JSON.stringify(payload)
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok || !saveData.ok) {
        runStatusEl.textContent = saveData.error || 'Не удалось сохранить правила.';
        return;
      }

      if (!runAfterSave) {
        runStatusEl.textContent = 'Правила сохранены в облаке.';
        await refreshCloudStore();
        return;
      }

      runStatusEl.textContent = 'Сканируем реальных конкурентов на Kaspi.kz и обновляем ваш XML…';
      const runRes = await fetch('/api/bot/stores/' + encodeURIComponent(credentials.storeId) + '/run', {
        method: 'POST',
        headers: { 'X-Store-Token': credentials.manageToken }
      });
      const runData = await runRes.json();
      if (!runRes.ok || !runData.ok) {
        runStatusEl.textContent = runData.error || 'Не удалось выполнить проверку.';
        return;
      }

      runStatusEl.textContent = `Готово! Проверено товаров: ${runData.checkedProducts}. Обновлено цен в XML: ${runData.changes?.length || 0}.`;
      await refreshCloudStore();
      if (typeof showToast === 'function') {
        showToast(`Проверка Kaspi завершена: обновлено ${runData.changes?.length || 0} цен`);
      }
    } catch (_) {
      runStatusEl.textContent = 'Ошибка соединения при запуске автобота.';
    }
  }

  byId('cloudSaveRulesBtn')?.addEventListener('click', () => saveRulesAndOptionallyRun(false));
  byId('cloudSaveAndRunBtn')?.addEventListener('click', () => saveRulesAndOptionallyRun(true));
  byId('cloudCopyFeedBtn')?.addEventListener('click', async () => {
    if (!feedUrlInput?.value) return;
    await navigator.clipboard?.writeText(feedUrlInput.value).catch(() => null);
    if (typeof showToast === 'function') showToast('HTTPS-ссылка XML скопирована');
  });
  byId('cloudDisconnectBtn')?.addEventListener('click', () => {
    saveCredentials(null);
    currentStore = null;
    connectBox.hidden = false;
    dashboardBox.hidden = true;
  });

  refreshCloudStore();
})();

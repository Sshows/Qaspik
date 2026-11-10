(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId('pilotForm');
  const status = byId('pilotStatus');
  const offersSelect = byId('pilotOffer');
  const rulesElement = byId('pilotRules');
  const downloads = byId('pilotDownloads');
  const rules = new Map();
  let catalog;
  let positions = [];
  let importedObservations;
  let exportFiles;
  let generation = 0;
  let catalogRequest = 0;
  let observationRequest = 0;

  const messages = {
    PROPOSED: 'Новая цена',
    AUTO_RAISE: 'Повышение в пределах максимума',
    FLOOR_MINIMUM: 'Снижение до минимальной цены',
    NO_ROOM_TO_RAISE: 'Без изменения в заданных пределах',
    NO_OBSERVATION: 'Нет наблюдения',
    OBSERVATION_OUT_OF_DATE: 'Наблюдение устарело или датировано будущим',
    FLOOR_GUARD: 'Сработал нижний порог',
    ALREADY_BELOW_COMPETITOR: 'Текущая цена выгоднее',
    COMPETITOR_DETAILS_REQUIRED: 'Для фильтра нужны данные по каждому продавцу',
    NO_ELIGIBLE_COMPETITORS: 'Нет продавцов, подходящих под условия'
  };

  function invalidate() {
    generation++;
    exportFiles = null;
    downloads.hidden = true;
    byId('pilotResults').hidden = true;
    status.textContent = '';
  }

  async function api(route, payload) {
    const options = payload === undefined ? undefined : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
    const response = await fetch('/api/pilot/' + route, options);
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Панель не смогла получить ответ от локального Qaspik');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось обработать запрос');
    return data;
  }

  function localTime(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  const key = ({ sku, cityId }) => sku + '/' + (cityId || '');
  const name = ({ sku, cityId }) => sku + (cityId ? ' · ' + cityId : ' · общая цена');
  const priceText = (price) => price.toLocaleString('ru-RU') + ' ₸';

  function addNumber(parent, labelText, minimum, initial, required = false) {
    const field = document.createElement('label');
    field.className = 'field';
    field.append(labelText);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = minimum;
    input.step = 1;
    input.required = required;
    input.value = initial ?? '';
    field.append(input);
    parent.append(field);
    return input;
  }

  function addRule(offer, rule = {}) {
    const id = key(offer);
    if (rules.has(id)) return;
    const card = document.createElement('fieldset');
    card.className = 'panel settings-fields';
    card.style.gridColumn = '1 / -1';
    const title = document.createElement('legend');
    title.textContent = name(offer) + ' · сейчас ' + priceText(offer.price);
    card.append(title);
    const minPrice = addNumber(card, 'Нижний порог (₸)', 1, rule.minPrice, true);
    const maxPrice = addNumber(card, 'Максимальная цена (₸)', 1, rule.maxPrice);
    const standardStep = addNumber(card, 'Свой шаг (₸, пусто — общий)', 1, rule.standardStep);
    const nearFloorWindow = addNumber(card, 'Своё расстояние до порога (₸)', 0, rule.nearFloorWindow);
    const competitorPrice = addNumber(card, 'Цена конкурента (₸)', 1);
    const timeLabel = document.createElement('label');
    timeLabel.className = 'field';
    timeLabel.append('Время наблюдения (местное)');
    const observedAt = document.createElement('input');
    observedAt.type = 'datetime-local';
    timeLabel.append(observedAt);
    card.append(timeLabel);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'Убрать товар';
    remove.addEventListener('click', () => {
      rules.delete(id);
      card.remove();
      invalidate();
    });
    card.append(remove);
    rulesElement.append(card);
    rules.set(id, { offer, minPrice, maxPrice, standardStep, nearFloorWindow, competitorPrice, observedAt });
  }

  function clearCatalog() {
    catalog = null;
    rules.clear();
    rulesElement.replaceChildren();
    offersSelect.replaceChildren(new Option('Выберите XML', ''));
    offersSelect.disabled = true;
    byId('pilotAddOffer').disabled = true;
    importedObservations = undefined;
    byId('pilotObservations').value = '';
  }

  async function loadCatalog(xml, sample, request) {
    const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
    const merchantId = documentXml.getElementsByTagNameNS('kaspiShopping', 'merchantid')[0]?.textContent.trim();
    if (!merchantId || !/^[0-9]+$/.test(merchantId)) throw new Error('В XML не найден идентификатор продавца Kaspi');
    const data = await api('catalog', { xml, merchantId });
    if (request !== catalogRequest) return;
    catalog = { xml, merchantId };
    positions = data.offers.flatMap(({ sku, cityPrices, price }) => cityPrices
      ? cityPrices.map(({ cityId, price }) => ({ sku, cityId, price }))
      : [{ sku, price }]);
    offersSelect.replaceChildren(...positions.map((offer, index) => new Option(name(offer), index)));
    offersSelect.disabled = false;
    byId('pilotAddOffer').disabled = false;
    if (sample) {
      importedObservations = sample.observations;
      byId('pilotEnabled').checked = sample.config.subscription.enabled;
      for (const rule of sample.config.products) {
        const position = positions.find((offer) => key(offer) === key(rule));
        if (position) addRule(position, rule);
      }
    }
    status.textContent = 'XML проверен. Позиций с ценами: ' + positions.length + '.';
  }

  async function selectCatalog(getSource) {
    const request = ++catalogRequest;
    observationRequest++;
    invalidate();
    clearCatalog();
    try {
      const source = await getSource();
      if (request === catalogRequest && source) await loadCatalog(source.xml, source.sample, request);
    } catch (error) {
      if (request === catalogRequest) status.textContent = error.message;
    }
  }

  byId('pilotXml').addEventListener('change', (event) => {
    const file = event.target.files[0];
    selectCatalog(async () => file && { xml: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) });
  });
  byId('pilotExample').addEventListener('click', () => {
    byId('pilotXml').value = '';
    selectCatalog(async () => {
      const sample = await api('example');
      return { xml: sample.xml, sample };
    });
  });
  byId('pilotAddOffer').addEventListener('click', () => {
    const offer = positions[Number(offersSelect.value)];
    if (offer) addRule(offer);
    invalidate();
  });

  byId('pilotObservations').addEventListener('change', async (event) => {
    const request = ++observationRequest;
    const file = event.target.files[0];
    importedObservations = undefined;
    invalidate();
    try {
      const value = file ? JSON.parse((await file.text()).replace(/^\uFEFF/, '')) : undefined;
      if (request === observationRequest && value) {
        if (!Array.isArray(value.offers) || value.merchantId !== catalog?.merchantId) {
          throw new Error('Файл наблюдений должен относиться к открытому магазину');
        }
        importedObservations = value;
        invalidate();
        status.textContent = 'Файл наблюдений загружен.';
      }
    } catch (error) {
      if (request === observationRequest) status.textContent = error.message;
    }
  });

  form.addEventListener('input', (event) => {
    if (event.target.type !== 'file') invalidate();
  });
  byId('pilotExpiry').value = localTime(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    invalidate();
    const request = generation;
    try {
      if (!catalog || rules.size === 0) throw new Error('Откройте XML и добавьте хотя бы один товар');
      const defaults = {
        standardStep: byId('pilotStep').valueAsNumber,
        nearFloorWindow: byId('pilotWindow').valueAsNumber,
        atFloor: byId('pilotFloor').value,
        autoRaise: byId('pilotAutoRaise').checked
      };
      const filters = {};
      for (const [field, elementId] of [
        ['minRating', 'pilotRating'], ['minReviews', 'pilotReviews'], ['maxPreorderDays', 'pilotPreorder']
      ]) {
        const input = byId(elementId);
        if (input.value) filters[field] = input.valueAsNumber;
      }
      for (const [field, elementId] of [
        ['deliveryCategories', 'pilotDelivery'], ['excludedMerchantIds', 'pilotExcluded']
      ]) {
        const values = byId(elementId).value.split(',').map((item) => item.trim()).filter(Boolean);
        if (values.length) filters[field] = values;
      }
      if (Object.keys(filters).length) defaults.filters = filters;

      const observed = new Map();
      for (const offer of importedObservations?.offers || []) {
        const id = key(offer);
        if (observed.has(id)) throw new Error('В файле наблюдений есть повтор для ' + name(offer));
        observed.set(id, offer);
      }
      const products = Array.from(rules.values(), (row) => {
        const { sku, cityId } = row.offer;
        if (row.competitorPrice.value || row.observedAt.value) {
          if (!row.competitorPrice.value || !row.observedAt.value) {
            throw new Error('Укажите цену конкурента и время наблюдения для ' + sku);
          }
          observed.set(key(row.offer), {
            sku, cityId, competitorPrice: row.competitorPrice.valueAsNumber,
            observedAt: new Date(row.observedAt.value).toISOString()
          });
        }
        const rule = { sku, cityId, minPrice: row.minPrice.valueAsNumber };
        for (const field of ['maxPrice', 'standardStep', 'nearFloorWindow']) {
          if (row[field].value) rule[field] = row[field].valueAsNumber;
        }
        return rule;
      });
      const { xml, merchantId } = catalog;
      const config = {
        merchantId, defaults, products, maxObservationAgeSeconds: 900,
        subscription: {
          enabled: byId('pilotEnabled').checked,
          expiresAt: new Date(byId('pilotExpiry').value).toISOString()
        }
      };
      const observations = { merchantId, offers: Array.from(observed.values()) };
      const data = await api('plan', { xml, config, observations });
      if (request !== generation) return;
      const results = byId('pilotResults');
      results.replaceChildren(...data.decisions.map((decision) => {
        const item = document.createElement('li');
        const outcome = decision.price === undefined
          ? priceText(decision.current)
          : priceText(decision.current) + ' → ' + priceText(decision.price);
        item.textContent = name(decision) + ' · ' + outcome + ' · ' + (messages[decision.code] || 'Расчёт выполнен');
        return item;
      }));
      results.hidden = false;
      status.textContent = 'Предпросмотр готов. Прайс к загрузке в Kaspi не отправлялся.' +
        (data.access.active ? '' : ' Воркер в выгружаемых настройках остановлен.');
      exportFiles = { 'catalog.xml': xml, 'pilot.json': config, 'observations.json': observations };
      downloads.hidden = false;
    } catch (error) {
      if (request === generation) status.textContent = error.message;
    }
  });

  downloads.addEventListener('click', (event) => {
    const filename = event.target.dataset.pilotDownload;
    if (!exportFiles || !Object.hasOwn(exportFiles, filename)) return;
    const file = exportFiles[filename];
    const xml = typeof file === 'string';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([xml ? file : JSON.stringify(file, null, 2) + '\n'], {
      type: xml ? 'application/xml' : 'application/json'
    }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  window.setPilotAvailable = (available) => {
    byId('pilotFields').disabled = !available;
    byId('pilotAvailability').textContent = available ? '' : 'Для настройки XML-пилота запустите Qaspik на своём компьютере.';
  };
  window.setPilotAvailable(appState.demoWritable);
})();

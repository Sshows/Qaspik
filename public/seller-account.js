(() => {
  const byId = (id) => document.getElementById(id);
  const connectForm = byId('sellerConnectForm');
  const connectFields = byId('sellerConnectFields');
  const keyInput = byId('sellerToken');
  const connectionBadge = byId('sellerConnectionBadge');
  const connectionMessage = byId('sellerConnectionMessage');
  const sessionControls = byId('sellerSessionControls');
  const checkOrderForm = byId('sellerCheckOrderForm');
  const checkOrderFields = byId('sellerCheckOrderFields');
  const checkOrderCode = byId('sellerCheckOrderCode');
  const checkOrderMessage = byId('sellerCheckOrderMessage');
  const ordersPanel = byId('sellerOrders');
  const ordersForm = byId('sellerOrdersForm');
  const ordersFields = byId('sellerOrdersFields');
  const ordersMessage = byId('sellerOrdersMessage');
  const startDate = byId('sellerStartDate');
  const endDate = byId('sellerEndDate');
  const orderState = byId('sellerOrderState');
  const ordersTable = byId('sellerOrdersTable');
  const ordersBody = byId('sellerOrdersBody');
  const ordersPagination = {
    root: byId('sellerOrdersPagination'),
    previous: byId('sellerOrdersPrevious'),
    label: byId('sellerOrdersPage'),
    next: byId('sellerOrdersNext')
  };

  const day = 24 * 60 * 60 * 1000;
  const timeZone = 'Asia/Almaty';
  const calendarDate = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const orderDate = new Intl.DateTimeFormat('ru-KZ', {
    timeZone, dateStyle: 'short', timeStyle: 'short'
  });
  const states = Object.fromEntries([...orderState.options].map((option) => [option.value, option.textContent]));
  const statuses = {
    APPROVED_BY_BANK: 'Ожидает принятия',
    ACCEPTED_BY_MERCHANT: 'Принят',
    COMPLETED: 'Завершён',
    CANCELLED: 'Отменён',
    CANCELLING: 'В процессе отмены',
    KASPI_DELIVERY_RETURN_REQUESTED: 'Ожидает возврата',
    RETURNED: 'Возвращён'
  };
  const errors = {
    400: 'Проверьте параметры запроса и повторите попытку.',
    401: 'Kaspi не принял API-ключ. Проверьте его в кабинете продавца.',
    403: 'Kaspi отклонил доступ. Проверьте API-ключ и права доступа.',
    404: 'Kaspi не нашёл заказ. Обновите список заказов.',
    429: 'Слишком много запросов. Подождите немного и попробуйте снова.',
    502: 'Kaspi сейчас не отвечает на запрос. Попробуйте снова чуть позже.',
    503: 'Подключение временно недоступно. Попробуйте снова чуть позже.',
    504: 'Kaspi не ответил вовремя. Попробуйте снова чуть позже.'
  };

  let enabled = false;
  let token = '';
  let session;
  let connected = false;
  let appliedFilters;
  let currentPage = 0;
  let totalPages = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(text) {
    const node = element('button', 'btn', text);
    node.type = 'button';
    return node;
  }

  function price(value) {
    return Number.isFinite(value) ? value.toLocaleString('ru-KZ') + ' ₸' : '—';
  }

  function resetFilters() {
    const date = Object.fromEntries(calendarDate.formatToParts().map(({ type, value }) => [type, value]));
    endDate.value = date.year + '-' + date.month + '-' + date.day;
    startDate.valueAsNumber = endDate.valueAsNumber - 6 * day;
    orderState.value = 'NEW';
  }

  function setConnected(value) {
    connected = value;
    connectForm.hidden = value;
    connectFields.disabled = !enabled || value;
    sessionControls.hidden = !value;
    ordersPanel.hidden = !value;
    connectionBadge.textContent = value ? 'Доступ к заказам' : 'Ключ не подключён';
    connectionBadge.classList.toggle('working', value);
    connectionBadge.classList.toggle('disabled', !value);
  }

  function updatePagination({ root, previous, next, label }, page, count, pending = false) {
    root.hidden = count < 2;
    label.textContent = count > 1 ? 'Страница ' + (page + 1) + ' из ' + count : '';
    previous.disabled = pending || page <= 0;
    next.disabled = pending || page + 1 >= count;
  }

  function disconnect(message = '') {
    session?.abort();
    session = undefined;
    token = '';
    keyInput.value = '';
    appliedFilters = undefined;
    currentPage = 0;
    totalPages = 0;
    setConnected(false);
    checkOrderForm.reset();
    checkOrderFields.disabled = false;
    checkOrderMessage.textContent = '';
    ordersFields.disabled = false;
    ordersBody.replaceChildren();
    ordersTable.hidden = true;
    ordersMessage.textContent = '';
    updatePagination(ordersPagination, 0, 0);
    resetFilters();
    connectionMessage.textContent = message;
  }

  async function sellerRequest(route, body, signal) {
    const response = await fetch('/api/seller/' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
      cache: 'no-store',
      redirect: 'error',
      signal
    });
    if (!response.ok) {
      const error = new Error();
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function orderRows(order, index, signal) {
    const row = element('tr');
    const created = new Date(order.creationDate);
    const date = order.creationDate != null && Number.isFinite(created.getTime()) ? orderDate.format(created) : '—';
    for (const value of [order.code ?? '—', date, states[order.state] || order.state || '—',
      statuses[order.status] || order.status || '—', price(order.totalPrice)]) {
      row.append(element('td', '', value));
    }

    const action = element('td');
    const toggle = button('Показать состав');
    toggle.setAttribute('aria-expanded', 'false');
    action.append(toggle);
    row.append(action);

    const detailRow = element('tr');
    detailRow.id = 'sellerOrderDetails-' + index;
    detailRow.hidden = true;
    toggle.setAttribute('aria-controls', detailRow.id);
    const detailCell = element('td', 'order-items-cell');
    detailCell.colSpan = 6;
    const status = element('p', 'settings-help');
    status.setAttribute('role', 'status');
    const items = element('ul', 'seller-items-list');
    const retry = button('Повторить загрузку');
    retry.hidden = true;
    const pagination = {
      root: element('div', 'seller-pagination'),
      previous: button('Назад'),
      label: element('span', 'settings-help'),
      next: button('Далее')
    };
    pagination.root.append(pagination.previous, pagination.label, pagination.next);
    detailCell.append(status, items, retry, pagination.root);
    detailRow.append(detailCell);
    let loaded = false;
    let pending = false;
    let page = 0;
    let pageCount = 0;
    updatePagination(pagination, page, pageCount);

    async function loadItems(requestedPage) {
      if (pending) return;
      pending = true;
      retry.hidden = true;
      status.textContent = 'Загружаем состав заказа…';
      updatePagination(pagination, page, pageCount, true);
      try {
        const data = await sellerRequest('order-items', { orderId: order.id, page: requestedPage }, signal);
        if (signal.aborted || !detailRow.isConnected) return;
        items.replaceChildren(...data.items.map((item) => {
          const line = element('li');
          line.append(element('strong', '', item.name || 'Товар'), document.createElement('br'));
          const code = item.code ? 'Код ' + item.code + ' · ' : '';
          line.append(element('span', 'settings-help', code + (item.quantity ?? '—') + ' шт. · ' + price(item.totalPrice)));
          return line;
        }));
        loaded = true;
        page = data.page;
        pageCount = data.totalPages;
        status.textContent = data.items.length ? 'Позиций в заказе — ' + data.totalItems : 'Kaspi не вернул позиции для этого заказа.';
      } catch (error) {
        if (signal.aborted || !detailRow.isConnected) return;
        const message = errors[error.status] || 'Не удалось получить состав заказа.';
        if (error.status === 401 || error.status === 403) {
          disconnect(message);
          keyInput.focus();
        } else {
          status.textContent = message;
          retry.hidden = loaded;
        }
      } finally {
        pending = false;
        updatePagination(pagination, page, pageCount);
      }
    }

    toggle.addEventListener('click', () => {
      detailRow.hidden = !detailRow.hidden;
      toggle.setAttribute('aria-expanded', String(!detailRow.hidden));
      toggle.textContent = detailRow.hidden ? 'Показать состав' : 'Скрыть состав';
      if (!detailRow.hidden && !loaded) loadItems(0);
    });
    retry.addEventListener('click', () => loadItems(0));
    pagination.previous.addEventListener('click', () => loadItems(page - 1));
    pagination.next.addEventListener('click', () => loadItems(page + 1));
    return [row, detailRow];
  }

  async function loadOrders(page, filters) {
    const { signal } = session;
    const status = connected ? ordersMessage : connectionMessage;
    ordersFields.disabled = true;
    updatePagination(ordersPagination, currentPage, totalPages, true);
    status.textContent = 'Запрашиваем заказы у Kaspi…';
    try {
      const data = await sellerRequest('orders', { page, ...filters }, signal);
      if (signal.aborted) return;
      ordersBody.replaceChildren(...data.orders.flatMap((order, index) => orderRows(order, index, signal)));
      appliedFilters = filters;
      currentPage = data.page;
      totalPages = data.totalPages;
      ordersTable.hidden = !data.orders.length;
      const selection = states[filters.state] + ' · ' + filters.startDate + ' — ' + filters.endDate;
      ordersMessage.textContent = selection + (data.orders.length
        ? ' · Всего заказов — ' + data.totalOrders
        : ' · Заказов за выбранный период нет.');
      if (!connected) {
        setConnected(true);
        connectionMessage.textContent = 'Kaspi принял ключ. Проверьте его по номеру заказа из нужного магазина.';
        byId('sellerOrdersTitle').focus();
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = errors[error.status] || 'Не удалось получить заказы. Попробуйте снова.';
      if (!connected || error.status === 401 || error.status === 403) {
        disconnect(message);
        keyInput.focus();
      } else {
        ordersMessage.textContent = message + (ordersTable.hidden ? '' : ' Ниже показан предыдущий результат.');
      }
    } finally {
      if (!signal.aborted) {
        ordersFields.disabled = false;
        updatePagination(ordersPagination, currentPage, totalPages);
      }
    }
  }

  function readFilters() {
    return { startDate: startDate.value, endDate: endDate.value, state: orderState.value };
  }

  checkOrderForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!connected || checkOrderFields.disabled) return;
    const code = checkOrderCode.value.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      checkOrderMessage.textContent = 'Введите номер заказа из кабинета Kaspi.';
      checkOrderCode.focus();
      return;
    }

    const { signal } = session;
    checkOrderFields.disabled = true;
    checkOrderMessage.textContent = 'Ищем этот заказ в Kaspi…';
    try {
      const { order } = await sellerRequest('order-by-code', { code }, signal);
      if (signal.aborted) return;
      checkOrderMessage.textContent = order?.code === code
        ? 'Заказ найден. Ключ даёт доступ к заказу из этого кабинета.'
        : 'Заказ не найден для этого ключа. Сверьте номер заказа и проверьте, из какого магазина взят ключ.';
    } catch (error) {
      if (signal.aborted) return;
      const message = errors[error.status] || 'Не удалось проверить заказ. Попробуйте снова.';
      if (error.status === 401 || error.status === 403) {
        disconnect(message);
        keyInput.focus();
      } else {
        checkOrderMessage.textContent = message;
      }
    } finally {
      if (!signal.aborted) checkOrderFields.disabled = false;
    }
  });

  connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!enabled || session) return;
    token = keyInput.value.trim();
    keyInput.value = '';
    if (!token) {
      connectionMessage.textContent = 'Введите API-ключ Kaspi.';
      keyInput.focus();
      return;
    }
    connectFields.disabled = true;
    resetFilters();
    session = new AbortController();
    loadOrders(0, readFilters());
  });

  ordersForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const range = (endDate.valueAsNumber - startDate.valueAsNumber) / day;
    if (range < 0 || range >= 14) {
      ordersMessage.textContent = range < 0 ? 'Дата окончания должна быть не раньше начала.' : 'Выберите период до 14 календарных дней включительно.';
      return;
    }
    if (connected) loadOrders(0, readFilters());
  });

  ordersPagination.previous.addEventListener('click', () => loadOrders(currentPage - 1, appliedFilters));
  ordersPagination.next.addEventListener('click', () => loadOrders(currentPage + 1, appliedFilters));
  byId('sellerDisconnect').addEventListener('click', () => {
    disconnect('Ключ отключён. Заказы удалены из этой вкладки.');
    keyInput.focus();
  });
  window.addEventListener('pagehide', () => {
    if (session || keyInput.value) disconnect();
  });

  async function checkAvailability() {
    try {
      const response = await fetch('/api/seller/capabilities', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      enabled = (await response.json()).enabled === true;
      connectFields.disabled = !enabled;
      connectionMessage.textContent = enabled ? '' : 'Откройте qaspik.vercel.app/orders или запустите Qaspik локально командой npm start.';
    } catch {
      connectionMessage.textContent = 'Не удалось проверить доступность подключения. Обновите страницу.';
    }
  }

  checkAvailability();
})();

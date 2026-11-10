const { DOMParser, onWarningStopParsing } = require('@xmldom/xmldom');

const KASPI_NAMESPACE = 'kaspiShopping';

function elementChildren(parent) {
  return Array.from(parent.childNodes).filter((node) => node.nodeType === 1);
}

function elementsNamed(parent, name) {
  return elementChildren(parent).filter((node) => node.namespaceURI === KASPI_NAMESPACE && node.localName === name);
}

function requireElement(parent, name) {
  const matches = elementsNamed(parent, name);
  if (matches.length !== 1) throw new Error('Прайс-лист должен содержать ровно один элемент ' + name);
  return matches[0];
}

function requiredText(parent, name) {
  const element = requireElement(parent, name);
  const text = element.textContent.trim();
  if (!text || elementChildren(element).length > 0) {
    throw new Error('В прайс-листе отсутствует значение ' + name);
  }
  return text;
}

function parsePrice(node, xml, lineStarts) {
  const text = node.firstChild;
  if (node.childNodes.length !== 1 || text.nodeType !== 3) {
    throw new Error('Цена должна быть записана числом внутри ' + node.localName);
  }

  const match = /^([ \t\r\n]*)([0-9]+)[ \t\r\n]*$/.exec(text.data);
  const price = Number(match?.[2]);
  const textStart = lineStarts[text.lineNumber - 1] + text.columnNumber - 1;
  if (!Number.isSafeInteger(price) || price < 1 || xml.slice(textStart, textStart + text.data.length) !== text.data) {
    throw new Error('В прайс-листе найдена некорректная цена');
  }

  const start = textStart + match[1].length;
  return { price, start, end: start + match[2].length };
}

function parseFeed(xml, merchantId) {
  if (typeof merchantId !== 'string' || !merchantId.trim() || merchantId !== merchantId.trim()) {
    throw new Error('Укажите идентификатор продавца из полного прайс-листа Kaspi');
  }
  if (typeof xml !== 'string' || !xml.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(xml)) {
    throw new Error('Ожидается XML-прайс-лист в UTF-8');
  }
  const encoding = /^\uFEFF?<\?xml\s+[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/.exec(xml)?.[2];
  if (encoding && !/^utf-8$/i.test(encoding)) {
    throw new Error('Ожидается XML-прайс-лист в UTF-8');
  }

  const bomLength = xml.startsWith('\uFEFF') ? 1 : 0;
  let document;
  try {
    document = new DOMParser({
      locator: true,
      // Keep offsets aligned with the original file, including CRLF line endings.
      normalizeLineEndings: (source) => source,
      onError: onWarningStopParsing
    }).parseFromString(xml.slice(bomLength), 'application/xml');
  } catch {
    throw new Error('Некорректный XML-прайс-лист');
  }

  const root = document.documentElement;
  if (document.doctype || root?.namespaceURI !== KASPI_NAMESPACE || root.localName !== 'kaspi_catalog') {
    throw new Error('Ожидается исходный XML-прайс-лист Kaspi без DTD');
  }
  if (requiredText(root, 'merchantid') !== merchantId) {
    throw new Error('Прайс-лист принадлежит другому продавцу');
  }
  requiredText(root, 'company');

  const entries = elementChildren(requireElement(root, 'offers'));
  if (!entries.length || entries.some((entry) => entry.namespaceURI !== KASPI_NAMESPACE || entry.localName !== 'offer')) {
    throw new Error('В полном прайс-листе должен быть список позиций offer');
  }

  const lineStarts = [bomLength];
  for (const newline of xml.matchAll(/\r\n?|\n/g)) {
    lineStarts.push(newline.index + newline[0].length);
  }

  const offers = new Map();
  for (const entry of entries) {
    const sku = entry.getAttribute('sku');
    if (!sku || sku !== sku.trim() || offers.has(sku)) {
      throw new Error('В прайс-листе найден пустой или повторяющийся SKU');
    }
    requiredText(entry, 'model');
    requiredText(entry, 'brand');
    if (!elementsNamed(requireElement(entry, 'availabilities'), 'availability').length) {
      throw new Error('В позиции SKU ' + sku + ' отсутствуют данные о складах');
    }

    const general = elementsNamed(entry, 'price');
    const cityPrices = elementsNamed(entry, 'cityprices');
    if (general.length + cityPrices.length !== 1) {
      throw new Error('В позиции SKU ' + sku + ' должна быть либо общая цена, либо цены по городам');
    }
    if (general.length === 1) {
      offers.set(sku, { general: parsePrice(general[0], xml, lineStarts) });
      continue;
    }

    const pricesByCity = new Map();
    const cityEntries = elementChildren(cityPrices[0]);
    if (cityEntries.length === 0) throw new Error('В позиции SKU ' + sku + ' отсутствуют цены по городам');
    for (const priceNode of cityEntries) {
      const cityId = priceNode.getAttribute('cityId');
      if (priceNode.namespaceURI !== KASPI_NAMESPACE || priceNode.localName !== 'cityprice' ||
        !/^[0-9]+$/.test(cityId || '') || pricesByCity.has(cityId)) {
        throw new Error('В позиции SKU ' + sku + ' найдена некорректная или повторяющаяся цена по городу');
      }
      pricesByCity.set(cityId, parsePrice(priceNode, xml, lineStarts));
    }
    offers.set(sku, { pricesByCity });
  }

  return offers;
}

function readFeed(xml, { merchantId } = {}) {
  const offers = parseFeed(xml, merchantId);
  return {
    merchantId,
    offers: Array.from(offers, ([sku, { general, pricesByCity }]) => general
      ? { sku, price: general.price }
      : { sku, cityPrices: Array.from(pricesByCity, ([cityId, { price }]) => ({ cityId, price })) }
    )
  };
}

function applyFeedPrices(xml, { merchantId, changes } = {}) {
  if (!Array.isArray(changes)) throw new Error('Укажите список изменений цен');
  const offers = parseFeed(xml, merchantId);
  const replacements = new Map();
  for (const change of changes) {
    const { sku, cityId, price } = change || {};
    if (typeof sku !== 'string' || (cityId !== undefined && typeof cityId !== 'string') ||
      !Number.isSafeInteger(price) || price < 1) {
      throw new Error('Каждое изменение должно содержать SKU, применимый город и целую положительную цену');
    }

    const offer = offers.get(sku);
    const target = cityId === undefined ? offer?.general : offer?.pricesByCity?.get(cityId);
    if (!target || replacements.has(target)) {
      throw new Error('Цена для SKU ' + sku + ' отсутствует или указана повторно');
    }
    replacements.set(target, price);
  }

  const changed = Array.from(replacements).filter(([target, price]) => target.price !== price);
  changed.sort(([a], [b]) => a.start - b.start);

  // Rewrite only numeric spans so the complete export stays intact byte-for-byte elsewhere.
  const parts = [];
  let position = 0;
  for (const [{ start, end }, price] of changed) {
    parts.push(xml.slice(position, start), String(price));
    position = end;
  }
  parts.push(xml.slice(position));
  return parts.join('');
}

module.exports = { readFeed, applyFeedPrices };

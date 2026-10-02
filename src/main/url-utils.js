'use strict';

/**
 * Утилиты для работы с URL и адресной строкой.
 */

const { SEARCH_ENGINES, SAFE_SEARCH, HOME_PAGE_ALIASES } = require('../shared/constants');
const { hostnameOf } = require('./adblock');

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HOST_LIKE_RE = /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i;
const LOCALHOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/;
const EXTERNAL_PROTOCOLS = new Set([
  'mailto:', 'tel:', 'sms:', 'tg:', 'telegram:', 'discord:', 'zoommtg:',
  'zoomus:', 'skype:', 'steam:', 'slack:', 'whatsapp:', 'viber:', 'ms-settings:'
]);

/** Это внутренняя страница браузера? */
function isInternalUrl(url) {
  return typeof url === 'string' && url.startsWith('kitsune://');
}

/** Протокол должен быть передан зарегистрированному приложению ОС. */
function isExternalAppUrl(url) {
  if (typeof url !== 'string' || /[\u0000-\u001f\u007f]/.test(url)) return false;
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol.toLowerCase());
  } catch {
    return false;
  }
}

/** Похоже ли, что строка — адрес, а не поисковый запрос */
function looksLikeUrl(input) {
  const s = String(input).trim();
  if (!s) return false;
  if (SCHEME_RE.test(s) && !/\s/.test(s)) return true;
  if (HOST_LIKE_RE.test(s) || LOCALHOST_RE.test(s) || IP_RE.test(s)) return !/\s/.test(s);
  return false;
}

/** Нормализация введённого адреса: добавляет https:// и т.п. */
function normalizeUrl(input) {
  let s = String(input).trim();
  if (!s) return '';
  if (isInternalUrl(s) || HOME_PAGE_ALIASES.includes(s)) return s;
  // localhost:3000 и 192.168.0.1 — это хост с портом, а не схема
  if (LOCALHOST_RE.test(s) || IP_RE.test(s)) return 'http://' + s;
  if (SCHEME_RE.test(s)) return s;
  return 'https://' + s;
}

/** Преобразует ввод в URL для навигации (поиск или адрес) */
function toNavigationUrl(input, searchEngineId = 'duckduckgo', safeSearch = 'moderate') {
  const s = String(input).trim();
  if (!s) return '';
  if (looksLikeUrl(s)) return normalizeUrl(s);
  return searchUrlFor(s, searchEngineId, safeSearch);
}

/** Ссылка на результаты поиска */
function searchUrlFor(query, searchEngineId = 'duckduckgo', safeSearch = 'moderate') {
  const engine = SEARCH_ENGINES[searchEngineId] || SEARCH_ENGINES.duckduckgo;
  const mode = SAFE_SEARCH[safeSearch] || SAFE_SEARCH.moderate;
  const base = engine.searchUrl.replace('%s', encodeURIComponent(query));
  return base.includes('?') ? `${base}&kp=${mode.kp}` : `${base}?kp=${mode.kp}`;
}

/** Человекочитаемое имя хоста */
function prettyUrl(url) {
  if (!url || isInternalUrl(url)) return url || '';
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return u.host + path + u.search;
  } catch {
    return url;
  }
}

/** Одинаковые ли домены (для определения "стороннего" запроса) */
function sameSite(a, b) {
  const ha = hostnameOf(a);
  const hb = hostnameOf(b);
  if (!ha || !hb) return false;
  return ha === hb || ha.endsWith('.' + hb) || hb.endsWith('.' + ha);
}

module.exports = {
  isInternalUrl,
  isExternalAppUrl,
  looksLikeUrl,
  normalizeUrl,
  toNavigationUrl,
  searchUrlFor,
  prettyUrl,
  sameSite
};

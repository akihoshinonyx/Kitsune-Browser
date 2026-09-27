'use strict';

/**
 * AdBlocker — движок блокировки рекламы на правилах формата Adblock Plus.
 *
 * Поддерживаются:
 *   ||example.com^          — блокировка домена и поддоменов
 *   /ads/*.js               — шаблон с *
 *   @@||example.com^        — исключение (белый список)
 *   $third-party            — только сторонние запросы
 *   $script,image           — ограничение по типу ресурса
 *   $~script                — отрицание типа
 *   $important              — блокировать даже при исключении
 *   $domain=a.com|~b.com    — ограничение по хосту страницы
 *   ! комментарий           — игнорируется
 *
 * Для скорости "чисто доменные" правила хранятся в Map и проверяются
 * по суффиксам хоста, остальные — в массиве (generic).
 */

const RESOURCE_TYPES = [
  'script',
  'image',
  'stylesheet',
  'object',
  'xmlhttprequest',
  'subdocument',
  // Типы uBlock Origin: главный документ и всплывающие окна
  'document',
  'popup',
  'font',
  'media',
  'websocket',
  'ping',
  'other'
];

const IGNORED_MODIFIERS = [
  'elemhide', 'genericblock', 'match-case',
  'csp', 'rewrite', 'inline-script', 'inline-font', 'mp4',
  'shide', 'badfilter', 'donottrack', 'webrtc', 'other', 'urlskip'
];

/**
 * Ресурсы для правила `$redirect` — как в uBlock Origin: вместо рекламы
 * отдаём пустышку, чтобы страница не «ломалась» из-за отсутствующего скрипта.
 */
const REDIRECT_RESOURCES = {
  noopjs: 'data:application/javascript;base64,dm9pZCAwOw==',
  noopcss: 'data:text/css,',
  nooptxt: 'data:text/plain,',
  nooptext: 'data:text/plain,',
  noopframe: 'data:text/html,',
  noopvmap: 'data:application/xml,%3Cvmap%2F%3E',
  empty: 'data:,',
  '1x1.gif': 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  '2x2.png':
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAA0BAQH0jY0AAAAASUVORK5CYII='
};

/** Решение «ничего не делать» — общий объект, чтобы не мусорить в куче */
const NO_ACTION = Object.freeze({ block: false, redirect: '', removeParams: null, filter: '' });

/**
 * Убирает из адреса перечисленные параметры (`$removeparam`).
 * Возвращает новый адрес или '' , если менять нечего.
 */
function stripParams(url, names) {
  if (!names || !names.length) return '';
  try {
    const parsed = new URL(url);
    if (!parsed.search) return '';
    const all = names.includes('*');
    let changed = false;
    for (const name of [...parsed.searchParams.keys()]) {
      if (!all && !names.includes(name)) continue;
      parsed.searchParams.delete(name);
      changed = true;
    }
    return changed ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Операторы косметических правил, которые нельзя выразить обычным CSS.
 * Их обрабатывает скрипт на странице (см. proceduralScript в main.js).
 */
const PROCEDURAL_MARKERS = [
  ':has-text(',
  ':contains(',
  ':upward(',
  ':remove(',
  ':style(',
  ':xpath(',
  ':-abp-'
];

/** Все суффиксы хоста: a.b.c → [a.b.c, b.c] */
function hostSuffixes(host) {
  if (!host) return [];
  const parts = String(host).split('.');
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/**
 * Разбирает косметическое правило (скрытие элементов).
 *
 * Поддерживаются формы uBlock Origin / Adblock Plus:
 *   ##.ad-banner                    — на всех сайтах
 *   example.com,news.ru##.promo     — только на этих сайтах
 *   ~example.com##.ad               — на всех, кроме указанных
 *   ##.ad:has-text(Реклама)         — процедурное правило (ищет по тексту)
 *   example.com#@#.ad               — исключение (не скрывать)
 *
 * @returns {{domains: string[], excluded: string[], exception: boolean,
 *            procedural: boolean, body: string}|null}
 */
function parseCosmetic(raw) {
  const line = String(raw);
  if (!line.includes('##') && !line.includes('#@#') && !line.includes('#?#')) return null;

  const match = /^(.*?)#(@)?(\?)?#(.*)$/.exec(line);
  if (!match) return null;

  const [, domainsRaw, exceptionMark, proceduralMark, bodyRaw] = match;
  const body = bodyRaw.trim();
  if (!body) return null;

  const domains = [];
  const excluded = [];
  for (const part of domainsRaw.split(',')) {
    const host = part.trim().toLowerCase();
    if (!host) continue;
    if (host.startsWith('~')) excluded.push(host.slice(1));
    else domains.push(host);
  }

  return {
    domains,
    excluded,
    exception: !!exceptionMark,
    procedural: !!proceduralMark,
    body
  };
}

/** hostname заканчивается на domain (по границе точки) */
function endsWithHost(hostname, domain) {
  if (!hostname || !domain) return false;
  if (hostname === domain) return true;
  return hostname.endsWith('.' + domain);
}

/**
 * Хост из URL.
 *
 * Функция вызывается на каждый сетевой запрос (а то и дважды), поэтому
 * результаты кэшируются: разбор URL через `new URL()` заметно грел CPU.
 */
const HOST_CACHE = new Map();
const HOST_CACHE_LIMIT = 4000;

function hostnameOf(s) {
  if (!s) return '';
  const key = String(s);
  const cached = HOST_CACHE.get(key);
  if (cached !== undefined) return cached;

  const value = computeHostname(key);
  if (HOST_CACHE.size >= HOST_CACHE_LIMIT) HOST_CACHE.clear();
  HOST_CACHE.set(key, value);
  return value;
}

function computeHostname(s) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    return s.replace(/^\/+/, '').split('/')[0].split('?')[0].toLowerCase();
  }
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s);
    return m ? m[1].toLowerCase().split('@').pop().split(':')[0] : '';
  }
}

/** Проверка, что строка принадлежит домену (для правил вида ||domain) */
function domainMatches(s, domain) {
  if (!s || !domain) return false;
  const host = hostnameOf(s);
  if (host && endsWithHost(host, domain)) return true;
  return s.includes(domain);
}

/** Экранирование под регэксп с поддержкой * и ^ */
function patternToRegex(pattern) {
  let out = '';
  for (const c of pattern) {
    if (c === '*') out += '.*';
    else if (c === '^') out += '(?:[^a-zA-Z0-9_.%-]|$)';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function pushToMap(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Electron resourceType -> adblock-тип */
function mapResourceType(type) {
  switch (type) {
    case 'stylesheet':
      return 'stylesheet';
    case 'script':
      return 'script';
    case 'image':
    case 'cspReport':
      return 'image';
    case 'font':
      return 'font';
    case 'object':
      return 'object';
    case 'xhr':
    case 'fetch':
      return 'xmlhttprequest';
    case 'websocket':
      return 'websocket';
    case 'media':
      return 'media';
    case 'ping':
      return 'ping';
    case 'popup':
      return 'popup';
    case 'mainFrame':
      return 'document';
    case 'subFrame':
      return 'subdocument';
    default:
      return 'other';
  }
}

const TYPE_ALIASES = {
  xhr: 'xmlhttprequest',
  doc: 'document',
  frame: 'subdocument',
  css: 'stylesheet',
  // Тип для блокировки всплывающих окон (uBO: $popup)
  popup: 'popup'
};

/** Одно правило блокировки */
class Filter {
  constructor(lineNo, raw) {
    this.lineNo = lineNo;
    this.raw = raw;
    this.exception = false;
    this.important = false;
    this.thirdParty = null; // null = не задано
    this.types = null;
    this.excludedTypes = null;
    this.anchored = false;
    this.domain = ''; // задан для быстрых доменных правил
    this.hostAnchors = [];
    this.excludedHostAnchors = [];
    this.pattern = '';
    this.regex = null;
    this.generic = true;
    this.redirect = ''; // $redirect=noopjs
    this.removeParams = null; // $removeparam=utm_source|fbclid
    this.genericHide = false; // $generichide (отключить общие правила скрытия)
  }

  /**
   * Подходит ли правило под запрос.
   *
   * @param {string[]} strings       URL и хост запроса в нижнем регистре
   * @param {string} type            тип ресурса (adblock-нотация)
   * @param {boolean} isThirdParty   запрос к другому сайту
   * @param {string} hostname        хост запрашиваемого ресурса
   * @param {string} pageHostname    хост страницы (для $domain=)
   */
  matches(strings, type, isThirdParty, hostname, pageHostname = '') {
    if (this.types && !this.types.has(type)) return false;
    if (this.excludedTypes && this.excludedTypes.has(type)) return false;
    if (this.thirdParty !== null && this.thirdParty !== isThirdParty) return false;

    // $domain= — ограничение по хосту СТРАНИЦЫ, а не запрашиваемого ресурса
    if (this.hostAnchors.length) {
      if (!pageHostname) return false;
      if (!this.hostAnchors.some((h) => endsWithHost(pageHostname, h))) return false;
    }
    if (this.excludedHostAnchors.length && pageHostname) {
      if (this.excludedHostAnchors.some((h) => endsWithHost(pageHostname, h))) return false;
    }

    if (this.domain) {
      for (const s of strings) {
        if (s === this.domain || endsWithHost(hostnameOf(s), this.domain)) return true;
      }
      return false;
    }

    // Правило без шаблона (например, $document,removeparam=fbclid)
    // подходит любому адресу — тип и сторона уже проверены выше.
    if (!this.regex && !this.pattern) return true;

    for (const s of strings) {
      if (this.regex) {
        if (this.regex.test(s)) return true;
      } else if (this.pattern && s.includes(this.pattern)) {
        return true;
      }
    }
    return false;
  }
}

class AdBlocker {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.genericFilters = [];
    this.domainFilters = new Map();
    this.exceptions = [];
    this.rulesCount = 0;
    this.skippedCount = 0;
    this.blockedTotal = 0;
    this.blockedByTab = new Map();
    this.blockedHosts = new Map();
    this.recentlyBlocked = [];
    this.lastListName = '';
    this.lists = []; // имена загруженных списков

    // ── Косметические правила (скрытие элементов) ──
    this.genericCosmetics = new Set();
    this.cosmeticByDomain = new Map(); // домен → [{body, excluded}]
    this.genericCosmeticExceptions = new Set();
    this.genericCosmeticsExcluded = []; // `~site##.ad` — везде, кроме сайта
    this.cosmeticExceptionsByDomain = new Map();
    this.procedural = []; // правила с :has-text(...) — их применяет скрипт

    // Сайты, которым разрешено всё: $generichide и ручной белый список
    this.genericHideSites = new Set();
    this.whitelist = new Set();

    // Кэш решений: один и тот же адрес запрашивается по несколько раз
    this.decisionCache = new Map();
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  addFiltersFromText(text, listName = 'inline') {
    let parsed = 0;
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.startsWith('!') || raw.startsWith('[')) continue;
      if (this._addRule(raw, i + 1)) parsed++;
      else this.skippedCount++;
    }
    this.lastListName = listName;
    if (parsed && !this.lists.includes(listName)) this.lists.push(listName);
    // Новые правила могут изменить вердикт для уже встречавшихся адресов
    this.decisionCache.clear();
    return parsed;
  }

  /**
   * Добавляет косметическое правило (скрытие элемента).
   * @param {{domains:string[], excluded:string[], exception:boolean,
   *          procedural:boolean, body:string}} rule
   */
  _addCosmetic(rule) {
    // Процедурные правила (поиск по тексту и прочие «умные» операторы)
    // обычным CSS не выразить — их применяет скрипт на странице.
    if (rule.procedural || PROCEDURAL_MARKERS.some((m) => rule.body.includes(m))) {
      this.procedural.push(rule);
      return;
    }

    const entry = { body: rule.body, excluded: rule.excluded };

    // `~example.com##.ad` — общее правило, которое не действует на сайте
    if (!rule.domains.length && rule.excluded.length) {
      if (rule.exception) this.genericCosmeticExceptions.add(rule.body);
      else this.genericCosmeticsExcluded.push(entry);
      return;
    }

    if (rule.domains.length) {
      const map = rule.exception ? this.cosmeticExceptionsByDomain : this.cosmeticByDomain;
      for (const domain of rule.domains) pushToMap(map, domain, entry);
      return;
    }
    if (rule.exception) this.genericCosmeticExceptions.add(rule.body);
    else this.genericCosmetics.add(rule.body);
  }

  _addRule(raw, lineNo) {
    // ── Косметические правила (скрытие элементов) ──
    const cosmetic = parseCosmetic(raw);
    if (cosmetic) {
      this._addCosmetic(cosmetic);
      this.rulesCount++;
      return true;
    }

    const filter = new Filter(lineNo, raw);
    let line = raw;

    if (line.startsWith('@@')) {
      filter.exception = true;
      line = line.slice(2);
    }

    // Модификаторы отделяются последним `$`. Ноль тоже валиден: правило
    // может начинаться прямо с модификатора — $document,removeparam=fbclid.
    const dollar = line.lastIndexOf('$');
    if (dollar >= 0) {
      const mods = line.slice(dollar + 1);
      if (/^[\w~,=.|&*/-]+$/.test(mods)) {
        line = line.slice(0, dollar);
        if (!this._parseModifiers(filter, mods)) return false;
      }
    }

    if (!line) {
      // Правило без шаблона действует на все адреса — так записывают
      // «почистить utm-метки»: $document,removeparam=fbclid
      const useful = filter.types || filter.excludedTypes || filter.removeParams || filter.redirect;
      if (!useful) return false;
      filter.pattern = '';
      filter.generic = true;
      if (filter.exception) this.exceptions.push(filter);
      else this.genericFilters.push(filter);
      this.rulesCount++;
      return true;
    }

    if (line.startsWith('||')) {
      filter.anchored = true;
      line = line.slice(2);
    } else if (line.startsWith('|')) {
      filter.anchored = true;
      line = line.slice(1);
    }
    if (line.endsWith('|')) line = line.slice(0, -1);

    const domOnly = /^([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^?$/i.exec(line);
    const simpleHost = /^([a-z0-9][a-z0-9.-]*\.[a-z]{2,})$/i.exec(line);

    if (filter.anchored && domOnly && !filter.types && filter.thirdParty === null && !filter.hostAnchors.length) {
      filter.domain = domOnly[1].toLowerCase().replace(/^\./, '');
      filter.generic = false;
    } else if (!filter.anchored && simpleHost) {
      filter.domain = simpleHost[1].toLowerCase();
      filter.generic = false;
    } else {
      filter.pattern = line.toLowerCase();
      if (/[*^]/.test(filter.pattern)) {
        const prefix = filter.anchored ? '(?:^|[^a-z0-9]|//)' : '';
        filter.regex = new RegExp(prefix + patternToRegex(filter.pattern), 'i');
      }
      filter.generic = !filter.anchored && !filter.hostAnchors.length;
    }

    if (filter.exception && filter.genericHide && filter.domain) {
      // @@||site^$generichide — на этом сайте отключаются общие правила скрытия
      this.genericHideSites.add(filter.domain);
      this.rulesCount++;
      return true;
    }

    if (filter.exception) {
      this.exceptions.push(filter);
    } else if (filter.domain) {
      pushToMap(this.domainFilters, filter.domain, filter);
    } else {
      this.genericFilters.push(filter);
    }
    this.rulesCount++;
    return true;
  }

  /**
   * Косметические правила для страницы.
   *
   * @param {string} url
   * @returns {{hide: string[], unhide: string[], procedural: string[],
   *            generichide: boolean}}
   */
  cosmeticsFor(url) {
    const host = hostnameOf(url);
    const genericHide = this.isGenericHide(host);
    // $generichide — общие правила на этом сайте не применяются
    const hide = new Set(genericHide ? [] : this.genericCosmetics);
    const unhide = new Set(this.genericCosmeticExceptions);
    const procedural = [];

    for (const candidate of hostSuffixes(host)) {
      for (const item of this.cosmeticByDomain.get(candidate) || []) {
        if (item.excluded.some((h) => endsWithHost(host, h))) continue;
        hide.add(item.body);
      }
      for (const item of this.cosmeticExceptionsByDomain.get(candidate) || []) {
        unhide.add(item.body);
      }
    }

    for (const item of this.genericCosmeticsExcluded) {
      if (item.excluded.some((h) => endsWithHost(host, h))) continue;
      hide.add(item.body);
    }

    for (const rule of this.procedural) {
      if (rule.domains.length && !rule.domains.some((d) => endsWithHost(host, d))) continue;
      if (rule.excluded.some((d) => endsWithHost(host, d))) continue;
      procedural.push(rule.body);
    }

    for (const selector of unhide) hide.delete(selector);

    return {
      hide: [...hide],
      unhide: [...unhide],
      procedural,
      generichide: genericHide
    };
  }

  /** На сайте отключены общие правила скрытия элементов? */
  isGenericHide(host) {
    if (!host) return false;
    for (const site of this.genericHideSites) {
      if (endsWithHost(host, site)) return true;
    }
    return false;
  }

  /* ─────────────────── Ручной белый список сайтов ─────────────────── */

  isWhitelisted(host) {
    if (!host) return false;
    for (const site of this.whitelist) {
      if (endsWithHost(host, site)) return true;
    }
    return false;
  }

  /** Включает/выключает блокировку для сайта. Возвращает новое состояние. */
  toggleSite(host) {
    const site = hostnameOf(host) || String(host || '').toLowerCase();
    if (!site) return false;
    if (this.whitelist.has(site)) {
      this.whitelist.delete(site);
      this.decisionCache.clear();
      return false;
    }
    this.whitelist.add(site);
    this.decisionCache.clear();
    return true;
  }

  setWhitelist(list) {
    this.whitelist = new Set((list || []).map((h) => String(h).toLowerCase()).filter(Boolean));
    this.decisionCache.clear();
  }

  listWhitelist() {
    return [...this.whitelist];
  }

  /** Полная перезагрузка правил (после обновления списков) */
  reset() {
    this.genericFilters = [];
    this.domainFilters = new Map();
    this.exceptions = [];
    this.genericCosmetics = new Set();
    this.cosmeticByDomain = new Map();
    this.genericCosmeticExceptions = new Set();
    this.genericCosmeticsExcluded = [];
    this.cosmeticExceptionsByDomain = new Map();
    this.procedural = [];
    this.genericHideSites = new Set();
    this.lists = [];
    this.rulesCount = 0;
    this.skippedCount = 0;
    this.decisionCache.clear();
  }

  _parseModifiers(filter, mods) {
    const domainMod = /(^|,)domain=([^,]+)/i.exec(mods);
    if (domainMod) {
      for (const part of domainMod[2].split('|')) {
        const neg = part.startsWith('~');
        const host = part.replace(/^~/, '').trim().toLowerCase();
        if (!host) continue;
        if (neg) filter.excludedHostAnchors.push(host);
        else filter.hostAnchors.push(host);
      }
    }

    for (const tokenRaw of mods.split(',')) {
      const token = tokenRaw.trim().toLowerCase();
      if (!token || token.startsWith('domain=')) continue;
      const negative = token.startsWith('~');

      // ── Модификаторы со значением: $redirect=noopjs, $removeparam=utm_source ──
      const eq = token.indexOf('=');
      if (eq > 0) {
        const key = token.slice(0, eq);
        const value = token.slice(eq + 1);
        if (key === 'redirect' || key === 'redirect-rule') {
          filter.redirect = value.split(':').pop();
          continue;
        }
        if (key === 'removeparam') {
          const names = value
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean);
          filter.removeParams = (filter.removeParams || []).concat(names);
          continue;
        }
        // $csp=, $rewrite=, $urlskip= и прочее со значением просто игнорируем
        continue;
      }

      const name = TYPE_ALIASES[token.replace(/^~/, '')] || token.replace(/^~/, '');
      if (name === 'important') {
        if (!negative) filter.important = true;
        continue;
      }
      if (name === 'third-party' || name === '3p') {
        filter.thirdParty = !negative;
        continue;
      }
      if (name === 'first-party' || name === '1p') {
        filter.thirdParty = negative;
        continue;
      }
      // Правило «не скрывать общие элементы» для сайта: @@||site^$generichide
      if (name === 'generichide' || name === 'ghide') {
        filter.genericHide = true;
        continue;
      }
      // Пустой ответ вместо рекламы
      if (name === 'empty') {
        filter.redirect = 'empty';
        continue;
      }
      if (name === 'all') continue;
      if (IGNORED_MODIFIERS.includes(name)) return false;
      if (!RESOURCE_TYPES.includes(name)) return false;
      if (negative) {
        filter.excludedTypes = filter.excludedTypes || new Set();
        filter.excludedTypes.add(name);
      } else {
        filter.types = filter.types || new Set();
        filter.types.add(name);
      }
    }
    return true;
  }

  /**
   * Что делать с запросом: блокировать, подменить ответ или почистить адрес.
   *
   * Возвращает решение целиком, а не только «да/нет» — так работают
   * `$redirect` (подмена рекламного скрипта пустышкой) и `$removeparam`
   * (удаление utm-меток из адреса).
   *
   * @param {{url:string,type:string,hostname?:string,tabUrl?:string,tabId?:number}} details
   * @returns {{block:boolean, redirect:string, removeParams:string[]|null, filter:string}}
   */
  getAction(details = {}) {
    if (!this.enabled) return NO_ACTION;

    const url = String(details.url || '');
    if (!/^(https?|wss?):/i.test(url)) return NO_ACTION;

    const hostname = details.hostname || hostnameOf(url);
    if (!hostname) return NO_ACTION;

    const pageHost = details.tabUrl ? hostnameOf(details.tabUrl) : '';
    // Сайт в белом списке — блокировка к нему не применяется
    if (pageHost && this.isWhitelisted(pageHost)) return NO_ACTION;

    const key = `${details.type || ''}|${url}|${pageHost}`;
    const cached = this.decisionCache.get(key);
    if (cached) return cached;

    const action = this._decide(url, hostname, details, pageHost);

    // Кэш ограничен: динамические адреса уникальны, чистим целиком
    if (this.decisionCache.size > 5000) this.decisionCache.clear();
    this.decisionCache.set(key, action);
    return action;
  }

  /** @private Решение по одному запросу */
  _decide(url, hostname, details, pageHost) {
    const type = mapResourceType(details.type);

    let isThirdParty = false;
    if (details.tabUrl) {
      const tabHost = hostnameOf(details.tabUrl);
      isThirdParty = !(tabHost && endsWithHost(hostname, tabHost));
    }

    const strings = [url.toLowerCase(), hostname];

    // 1) Ищем блокирующие правила. Правило с $important срабатывает сразу —
    //    исключения его не отменяют.
    let matched = null;
    let important = null;
    // Правила $redirect / $removeparam важнее обычной блокировки: они не
    // оставляют «дырку» в загрузке страницы, а подменяют ответ.
    let modifying = null;
    // Имена параметров собираем со ВСЕХ подошедших правил $removeparam:
    // в списках это отдельные строки (fbclid, gclid, utm_*), и чистятся они
    // вместе, а не по одному.
    let removeParams = null;

    const check = (filter) => {
      if (!filter.matches(strings, type, isThirdParty, hostname, pageHost)) return;
      if (filter.important) {
        if (!important) important = filter;
        return;
      }
      if (filter.redirect || filter.removeParams) {
        if (!modifying) modifying = filter;
        if (filter.removeParams) removeParams = (removeParams || []).concat(filter.removeParams);
      }
      // Правило только с $removeparam ничего не блокирует: оно чистит адрес.
      // Без этой проверки правило вида `$document,removeparam=fbclid`
      // «съедало» бы вообще все переходы по ссылкам.
      if (!filter.redirect && filter.removeParams) return;
      if (!matched) matched = filter;
    };

    for (const candidate of hostSuffixes(hostname)) {
      const list = this.domainFilters.get(candidate);
      if (!list) continue;
      for (const filter of list) check(filter);
    }
    for (const filter of this.genericFilters) check(filter);

    const winner = important || modifying || matched;
    if (!winner) return NO_ACTION;

    // 2) Исключения (белый список) отменяют обычную блокировку
    if (!important) {
      for (const ex of this.exceptions) {
        if (ex.matches(strings, type, isThirdParty, hostname, pageHost)) return NO_ACTION;
      }
    }

    if (winner.redirect) {
      return {
        block: true,
        redirect: REDIRECT_RESOURCES[winner.redirect] || '',
        removeParams: null,
        filter: winner.raw
      };
    }

    // $removeparam: запрос не блокируем, а переходим на адрес без меток
    if (winner.removeParams && winner === modifying) {
      const cleaned = stripParams(url, removeParams || winner.removeParams);
      if (!cleaned) return NO_ACTION;
      return {
        block: false,
        redirect: cleaned,
        removeParams: removeParams || winner.removeParams,
        filter: winner.raw
      };
    }

    return { block: true, redirect: '', removeParams: null, filter: winner.raw };
  }

  /**
   * Нужно ли блокировать запрос (короткая форма getAction).
   * @param {{url:string,type:string,hostname?:string,tabUrl?:string,tabId?:number}} details
   */
  shouldBlock(details) {
    return this.getAction(details).block;
  }

  recordBlocked({ tabId = -1, url = '', type = '' } = {}) {
    const host = hostnameOf(url);
    this.blockedTotal++;
    this.blockedByTab.set(tabId, (this.blockedByTab.get(tabId) || 0) + 1);
    if (host) this.blockedHosts.set(host, (this.blockedHosts.get(host) || 0) + 1);
    this.recentlyBlocked.unshift({ url, host, type, time: Date.now() });
    if (this.recentlyBlocked.length > 200) this.recentlyBlocked.length = 200;
    return host;
  }

  statsForTab(tabId) {
    return this.blockedByTab.get(tabId) || 0;
  }

  clearTabStats(tabId) {
    this.blockedByTab.delete(tabId);
  }

  getStats() {
    const topHosts = [...this.blockedHosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([host, count]) => ({ host, count }));
    return {
      enabled: this.enabled,
      rules: this.rulesCount,
      skipped: this.skippedCount,
      blockedTotal: this.blockedTotal,
      listName: this.lastListName,
      lists: [...this.lists],
      // Сколько правил скрывают элементы на странице (uBO-стиль)
      cosmeticRules: this.genericCosmetics.size + this.cosmeticByDomain.size,
      proceduralRules: this.procedural.length,
      whitelist: this.listWhitelist(),
      topHosts,
      recent: this.recentlyBlocked.slice(0, 120)
    };
  }

  resetStats() {
    this.blockedTotal = 0;
    this.blockedByTab.clear();
    this.blockedHosts.clear();
    this.recentlyBlocked.length = 0;
  }
}

module.exports = {
  AdBlocker,
  Filter,
  hostnameOf,
  endsWithHost,
  domainMatches,
  mapResourceType,
  patternToRegex,
  parseCosmetic,
  stripParams,
  hostSuffixes,
  REDIRECT_RESOURCES,
  NO_ACTION
};

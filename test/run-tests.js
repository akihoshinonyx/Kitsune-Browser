'use strict';

/**
 * run-tests.js — тесты Kitsune Browser без внешних зависимостей.
 *
 * Запуск: npm test
 *
 * Проверяются:
 *   1) движок блокировки рекламы (adblock.js);
 *   2) утилиты URL и адресной строки (url-utils.js);
 *   3) константы и настройки по умолчанию (shared/constants.js);
 *   4) хранилища JSON (store.js) — с подменой модуля electron;
 *   5) генератор иконок (tools/make-icon.js).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/* ─────────────────────────── Мини-фреймворк ─────────────────────────── */

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n\u001b[36m── ${name}\u001b[0m`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ suite: currentSuite, name, error: err });
    console.log(`  \u001b[31m✗\u001b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ suite: currentSuite, name, error: err });
    console.log(`  \u001b[31m✗\u001b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

/* ─────────────────────────── Подмена electron для store.js ─────────────────────────── */

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-test-'));

function stubElectron() {
  const id = require.resolve('electron');
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports: {
      app: {
        getPath: () => TMP_USER_DATA,
        getName: () => 'Kitsune Browser',
        getVersion: () => VERSION,
        isPackaged: false
      },
      shell: { openExternal: () => {} }
    }
  };
}

/* ─────────────────────────── Импорт тестируемых модулей ─────────────────────────── */

const {
  AdBlocker,
  hostnameOf,
  endsWithHost,
  domainMatches,
  mapResourceType,
  patternToRegex,
  parseCosmetic,
  stripParams,
  hostSuffixes,
  REDIRECT_RESOURCES
} = require('../src/main/adblock');

const {
  isInternalUrl,
  looksLikeUrl,
  normalizeUrl,
  toNavigationUrl,
  searchUrlFor,
  prettyUrl,
  sameSite
} = require('../src/main/url-utils');

const constants = require('../src/shared/constants');
const { VERSION } = require('../src/shared/version');
const { drawIcon, encodePng, encodeIco } = require('../tools/make-icon');
const { senderHosts, isTrustedSender, sameHost } = require('../src/main/ipc-guards');

/* ═══════════════════════════ Тесты ═══════════════════════════ */

suite('hostnameOf / endsWithHost / domainMatches');

test('hostnameOf извлекает хост из URL', () => {
  assert.strictEqual(hostnameOf('https://ads.doubleclick.net/pixel.gif'), 'ads.doubleclick.net');
  assert.strictEqual(hostnameOf('http://EXAMPLE.com/A'), 'example.com');
  assert.strictEqual(hostnameOf('example.com/path'), 'example.com');
});

test('hostnameOf устойчив к мусору', () => {
  assert.strictEqual(hostnameOf(''), '');
  assert.strictEqual(hostnameOf(null), '');
  assert.strictEqual(hostnameOf('https://user:pass@host.com:8080/x'), 'host.com');
});

test('endsWithHost учитывает границу домена', () => {
  assert.strictEqual(endsWithHost('ads.example.com', 'example.com'), true);
  assert.strictEqual(endsWithHost('example.com', 'example.com'), true);
  assert.strictEqual(endsWithHost('notexample.com', 'example.com'), false);
  assert.strictEqual(endsWithHost('', 'example.com'), false);
});

test('domainMatches работает по домену и по подстроке', () => {
  assert.strictEqual(domainMatches('https://a.example.com/x', 'example.com'), true);
  assert.strictEqual(domainMatches('https://other.com/example.com.js', 'example.com'), true);
  assert.strictEqual(domainMatches('https://other.com/x', 'example.com'), false);
});

suite('patternToRegex');

test('* превращается в .*', () => {
  const re = new RegExp(patternToRegex('/banner/*.gif'));
  assert.strictEqual(re.test('/banner/wide.gif'), true);
  assert.strictEqual(re.test('/banner/sub/deep.gif'), true);
  assert.strictEqual(re.test('/banner/wide.png'), false);
});

test('^ соответствует разделителю или концу строки', () => {
  const re = new RegExp(patternToRegex('ads^'));
  assert.strictEqual(re.test('https://x.com/ads/'), true);
  assert.strictEqual(re.test('https://x.com/ads'), true);
  assert.strictEqual(re.test('https://x.com/adsbanner'), false);
});

test('спецсимволы экранируются', () => {
  const re = new RegExp(patternToRegex('a.b?c'));
  assert.strictEqual(re.test('a.b?c'), true);
  assert.strictEqual(re.test('axbxc'), false);
});

suite('mapResourceType');

test('типы Electron сопоставляются с adblock-типами', () => {
  assert.strictEqual(mapResourceType('script'), 'script');
  assert.strictEqual(mapResourceType('xhr'), 'xmlhttprequest');
  assert.strictEqual(mapResourceType('fetch'), 'xmlhttprequest');
  assert.strictEqual(mapResourceType('subFrame'), 'subdocument');
  // Главный документ — отдельный тип: иначе $subdocument-правила
  // блокировали бы переходы целиком, а $document-правила не работали бы.
  assert.strictEqual(mapResourceType('mainFrame'), 'document');
  assert.strictEqual(mapResourceType('popup'), 'popup');
  assert.strictEqual(mapResourceType('image'), 'image');
  assert.strictEqual(mapResourceType('нечто'), 'other');
});

suite('AdBlocker — блокировка и исключения');

/** Блокировщик с тестовым набором правил */
function makeBlocker() {
  const blocker = new AdBlocker({ enabled: true });
  blocker.addFiltersFromText(
    [
      '! тестовый набор',
      '||doubleclick.net^',
      '||ads.example.com^$third-party',
      '||tracker.io^$script',
      '/banner/*.gif',
      '||metrics.net^$~image',
      '@@||good.example.com^',
      '@@||doubleclick.net/allowed^',
      '||cdn.site.com^$domain=site.com',
      '||forced.net^$important'
    ].join('\n'),
    'test'
  );
  return blocker;
}

const ctx = (url, type = 'image', tabUrl = 'https://site.com/page') => ({
  url,
  type,
  hostname: hostnameOf(url),
  tabUrl
});

test('блокирует рекламный домен по правилу ||domain^', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://ads.doubleclick.net/pixel.gif')), true);
  assert.strictEqual(b.shouldBlock(ctx('https://doubleclick.net/x.js', 'script')), true);
});

test('не блокирует посторонние домены', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://example.org/main.js', 'script')), false);
});

test('исключение @@ отменяет блокировку', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://good.example.com/logo.png')), false);
  assert.strictEqual(b.shouldBlock(ctx('https://doubleclick.net/allowed/pixel.gif')), false);
});

test('$third-party учитывается', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://ads.example.com/x.gif', 'image', 'https://other.com/')), true);
  assert.strictEqual(b.shouldBlock(ctx('https://ads.example.com/x.gif', 'image', 'https://ads.example.com/')), false);
});

test('ограничение по типу ресурса $script', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://tracker.io/a.js', 'script')), true);
  assert.strictEqual(b.shouldBlock(ctx('https://tracker.io/a.png', 'image')), false);
});

test('отрицание типа $~image блокирует всё кроме картинок', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://metrics.net/a.js', 'script')), true);
  assert.strictEqual(b.shouldBlock(ctx('https://metrics.net/a.png', 'image')), false);
});

test('шаблон с * работает', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://site.com/img/banner/top.gif')), true);
  assert.strictEqual(b.shouldBlock(ctx('https://site.com/img/banner/top.jpg')), false);
});

test('$domain= ограничивает правило хостом страницы', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://cdn.site.com/lib.js', 'script', 'https://site.com/')), true);
  assert.strictEqual(b.shouldBlock(ctx('https://cdn.site.com/lib.js', 'script', 'https://other.com/')), false);
});

test('$important перебивает исключение', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('@@||forced.net^\n||forced.net^$important', 'test');
  assert.strictEqual(b.shouldBlock(ctx('https://forced.net/x.js', 'script')), true);
});

test('комментарии и пустые строки не считаются правилами', () => {
  const b = new AdBlocker({ enabled: true });
  const added = b.addFiltersFromText('! комментарий\n\n   \n||real.net^', 'test');
  assert.strictEqual(added, 1);
  assert.strictEqual(b.rulesCount, 1);
});

test('выключенный блокировщик ничего не блокирует', () => {
  const b = makeBlocker();
  b.setEnabled(false);
  assert.strictEqual(b.shouldBlock(ctx('https://doubleclick.net/x.gif')), false);
  b.setEnabled(true);
  assert.strictEqual(b.shouldBlock(ctx('https://doubleclick.net/x.gif')), true);
});

suite('AdBlocker — статистика');

test('recordBlocked накапливает счётчики по вкладкам и хостам', () => {
  const b = makeBlocker();
  b.recordBlocked({ tabId: 1, url: 'https://ads.doubleclick.net/a.gif', type: 'image' });
  b.recordBlocked({ tabId: 1, url: 'https://ads.doubleclick.net/b.gif', type: 'image' });
  b.recordBlocked({ tabId: 2, url: 'https://tracker.io/t.js', type: 'script' });

  assert.strictEqual(b.blockedTotal, 3);
  assert.strictEqual(b.statsForTab(1), 2);
  assert.strictEqual(b.statsForTab(2), 1);
  assert.strictEqual(b.statsForTab(99), 0);

  const stats = b.getStats();
  assert.strictEqual(stats.blockedTotal, 3);
  assert.strictEqual(stats.topHosts[0].host, 'ads.doubleclick.net');
  assert.strictEqual(stats.topHosts[0].count, 2);
  assert.strictEqual(stats.recent.length, 3);
  assert.strictEqual(stats.enabled, true);
  assert.ok(stats.rules > 0);
});

test('resetStats обнуляет счётчики', () => {
  const b = makeBlocker();
  b.recordBlocked({ tabId: 1, url: 'https://ads.doubleclick.net/a.gif' });
  b.resetStats();
  assert.strictEqual(b.blockedTotal, 0);
  assert.strictEqual(b.statsForTab(1), 0);
  assert.strictEqual(b.getStats().recent.length, 0);
  assert.strictEqual(b.getStats().topHosts.length, 0);
});

test('clearTabStats убирает статистику одной вкладки', () => {
  const b = makeBlocker();
  b.recordBlocked({ tabId: 7, url: 'https://tracker.io/a.js' });
  b.clearTabStats(7);
  assert.strictEqual(b.statsForTab(7), 0);
  assert.strictEqual(b.blockedTotal, 1);
});

suite('AdBlocker — встроенный список Kitsune');

const FILTERS_DIR = path.join(__dirname, '..', 'src', 'main', 'filters');

test('базовый список загружается и содержит сотни правил', () => {
  const { createAdBlocker } = require('../src/main/filters');
  const b = createAdBlocker({ enabled: true, filtersDir: FILTERS_DIR });
  assert.ok(b.rulesCount > 300, `ожидалось > 300 правил, получено ${b.rulesCount}`);
});

test('базовый список блокирует известные рекламные сети', () => {
  const { createAdBlocker } = require('../src/main/filters');
  const b = createAdBlocker({ enabled: true, filtersDir: FILTERS_DIR });
  const cases = [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://ads.doubleclick.net/pixel.gif',
    'https://www.google-analytics.com/analytics.js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://static.criteo.net/js/ld/publishertag.js',
    'https://sb.scorecardresearch.com/beacon.js'
  ];
  for (const url of cases) {
    assert.strictEqual(
      b.shouldBlock(ctx(url, 'script', 'https://news.example.com/')),
      true,
      `должен блокироваться: ${url}`
    );
  }
});

test('базовый список не ломает обычные ресурсы сайта', () => {
  const { createAdBlocker } = require('../src/main/filters');
  const b = createAdBlocker({ enabled: true, filtersDir: FILTERS_DIR });
  const cases = [
    ['https://site.com/js/app.js', 'script'],
    ['https://site.com/css/style.css', 'stylesheet'],
    ['https://site.com/img/hero.jpg', 'image'],
    ['https://fonts.gstatic.com/s/roboto.woff2', 'font']
  ];
  for (const [url, type] of cases) {
    assert.strictEqual(b.shouldBlock(ctx(url, type)), false, `не должен блокироваться: ${url}`);
  }
});

test('пользовательский список из userData подхватывается', () => {
  const { createAdBlocker } = require('../src/main/filters');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-filters-'));
  fs.writeFileSync(path.join(dir, 'my.txt'), '||my-custom-ads.test^\n', 'utf8');

  const b = createAdBlocker({ enabled: true, filtersDir: FILTERS_DIR, userDataDir: dir });
  assert.strictEqual(b.shouldBlock(ctx('https://my-custom-ads.test/a.gif')), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('файл-пример extra-example.txt не подключается автоматически', () => {
  const { listFilterFiles } = require('../src/main/filters');
  const files = listFilterFiles(FILTERS_DIR);
  assert.ok(!files.includes('extra-example.txt'), 'extra-example.txt должен пропускаться');
  assert.ok(Array.isArray(files));
});

test('список блокирует и российские рекламные сети', () => {
  const { createAdBlocker } = require('../src/main/filters');
  const b = createAdBlocker({ enabled: true, filtersDir: FILTERS_DIR });
  assert.strictEqual(b.shouldBlock(ctx('https://an.yandex.ru/meta/1')), true);
  assert.strictEqual(b.shouldBlock(ctx('https://mc.yandex.ru/metrika/watch.js', 'script')), true);
});

suite('url-utils');

test('isInternalUrl распознаёт внутренние страницы', () => {
  assert.strictEqual(isInternalUrl('kitsune://home'), true);
  assert.strictEqual(isInternalUrl('kitsune://settings'), true);
  assert.strictEqual(isInternalUrl('https://kitsune.com/'), false);
  assert.strictEqual(isInternalUrl(null), false);
});

test('looksLikeUrl отличает адрес от поискового запроса', () => {
  assert.strictEqual(looksLikeUrl('example.com'), true);
  assert.strictEqual(looksLikeUrl('https://example.com/a/b'), true);
  assert.strictEqual(looksLikeUrl('localhost:3000'), true);
  assert.strictEqual(looksLikeUrl('192.168.0.1/admin'), true);
  assert.strictEqual(looksLikeUrl('как приготовить борщ'), false);
  assert.strictEqual(looksLikeUrl('купить телефон дешево'), false);
});

test('normalizeUrl добавляет схему', () => {
  assert.strictEqual(normalizeUrl('example.com'), 'https://example.com');
  assert.strictEqual(normalizeUrl('localhost:8080'), 'http://localhost:8080');
  assert.strictEqual(normalizeUrl('http://example.com'), 'http://example.com');
  assert.strictEqual(normalizeUrl('kitsune://home'), 'kitsune://home');
  assert.strictEqual(normalizeUrl('  '), '');
});

test('toNavigationUrl: адрес — как есть, запрос — в DuckDuckGo', () => {
  assert.strictEqual(toNavigationUrl('example.com'), 'https://example.com');
  const search = toNavigationUrl('котики', 'duckduckgo', 'moderate');
  assert.ok(search.startsWith('https://duckduckgo.com/?q='), search);
  assert.ok(search.includes(encodeURIComponent('котики')));
  assert.ok(search.includes('kp=-1'));
});

test('searchUrlFor подставляет безопасный поиск и движок', () => {
  assert.ok(searchUrlFor('тест', 'duckduckgo', 'strict').includes('kp=1'));
  assert.ok(searchUrlFor('тест', 'duckduckgo', 'off').includes('kp=-2'));
  assert.ok(searchUrlFor('тест', 'lite', 'moderate').includes('lite.duckduckgo.com'));
  assert.ok(searchUrlFor('тест', 'html', 'moderate').includes('html.duckduckgo.com'));
  // неизвестный движок — падаем на DuckDuckGo
  assert.ok(searchUrlFor('тест', 'неизвестный', 'moderate').includes('duckduckgo.com'));
});

test('поиск безопасно кодирует пробелы и спецсимволы', () => {
  const url = toNavigationUrl(' cats & dogs ', 'duckduckgo', 'moderate');
  assert.ok(url.includes('q=cats%20%26%20dogs'), url);
  assert.ok(url.endsWith('&kp=-1'), url);
});

test('пустой ввод не превращается в поисковый запрос', () => {
  assert.strictEqual(toNavigationUrl('   ', 'duckduckgo', 'moderate'), '');
});

test('prettyUrl убирает схему и хвостовой слеш', () => {
  assert.strictEqual(prettyUrl('https://example.com/'), 'example.com');
  assert.strictEqual(prettyUrl('https://example.com/a/b?x=1'), 'example.com/a/b?x=1');
  assert.strictEqual(prettyUrl('kitsune://settings'), 'kitsune://settings');
  assert.strictEqual(prettyUrl(''), '');
});

test('sameSite определяет одинаковые домены', () => {
  assert.strictEqual(sameSite('https://a.example.com/x', 'https://example.com/y'), true);
  assert.strictEqual(sameSite('https://example.com/x', 'https://other.com/y'), false);
  assert.strictEqual(sameSite('', 'https://example.com'), false);
});

suite('Константы и настройки');

test('основной поисковик — DuckDuckGo', () => {
  assert.ok(constants.SEARCH_ENGINES.duckduckgo);
  assert.ok(constants.SEARCH_ENGINES.duckduckgo.searchUrl.includes('duckduckgo.com'));
  assert.strictEqual(constants.DEFAULT_SETTINGS.searchEngine, 'duckduckgo');
});

test('все поисковики ведут на DuckDuckGo-домены', () => {
  for (const engine of Object.values(constants.SEARCH_ENGINES)) {
    assert.ok(engine.searchUrl.includes('duckduckgo.com'), `${engine.id}: ${engine.searchUrl}`);
    assert.ok(engine.searchUrl.includes('%s'));
    assert.ok(engine.suggestUrl.includes('%s'));
    assert.ok(engine.name);
  }
});

test('безопасный поиск содержит режимы off/moderate/strict', () => {
  assert.strictEqual(constants.SAFE_SEARCH.off.kp, '-2');
  assert.strictEqual(constants.SAFE_SEARCH.moderate.kp, '-1');
  assert.strictEqual(constants.SAFE_SEARCH.strict.kp, '1');
});

test('блокировка рекламы включена по умолчанию', () => {
  assert.strictEqual(constants.DEFAULT_SETTINGS.adblockEnabled, true);
  assert.strictEqual(constants.DEFAULT_SETTINGS.blockPopups, true);
});

test('внутренние страницы указывают на существующие HTML-файлы', () => {
  const pagesDir = path.join(__dirname, '..', 'src', 'renderer', 'pages');
  for (const [url, file] of Object.entries(constants.INTERNAL_PAGES)) {
    assert.ok(fs.existsSync(path.join(pagesDir, file)), `${url} -> ${file} не найден`);
  }
});

test('версия приложения согласована с package.json', () => {
  const pkg = require('../package.json');
  assert.strictEqual(VERSION, pkg.version);
  assert.strictEqual(constants.APP_VERSION, pkg.version);
});

suite('Хранилища (store.js)');

stubElectron();
const { SettingsStore, HistoryStore, BookmarkStore, PasswordStore } = require('../src/main/store');
// updater.js требует electron при загрузке, поэтому подключается после подмены
const { createUpdater, channelForArch, friendlyError, isPortableBuild, RELEASES_PAGE } = require('../src/main/updater');

test('SettingsStore хранит настройки и значения по умолчанию', () => {
  const store = new SettingsStore();
  assert.strictEqual(store.get('searchEngine'), 'duckduckgo');
  assert.strictEqual(store.get('adblockEnabled'), true);

  store.set('searchEngine', 'lite');
  assert.strictEqual(store.get('searchEngine'), 'lite');

  store.setMany({ searchEngine: 'html', safeSearch: 'strict' });
  assert.strictEqual(store.get('searchEngine'), 'html');
  assert.strictEqual(store.get('safeSearch'), 'strict');

  const reloaded = new SettingsStore();
  assert.strictEqual(reloaded.get('searchEngine'), 'html');
  assert.strictEqual(reloaded.get('safeSearch'), 'strict');
});

test('SettingsStore: get возвращает fallback для отсутствующего ключа', () => {
  const store = new SettingsStore();
  assert.strictEqual(store.get('нет-такого', 42), 42);
});

test('HistoryStore добавляет, ищет и удаляет записи', () => {
  const store = new HistoryStore();
  store.clear();

  store.add({ url: 'https://duckduckgo.com/', title: 'DuckDuckGo' });
  store.add({ url: 'https://example.com/page', title: 'Пример' });
  store.add({ url: 'https://another.test/x', title: 'Другой сайт' });

  assert.strictEqual(store.all().length, 3);

  const found = store.search('duck');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].url, 'https://duckduckgo.com/');

  store.remove('https://another.test/x');
  assert.strictEqual(store.all().length, 2);

  store.clear();
  assert.strictEqual(store.all().length, 0);
  assert.strictEqual(store.search('duck').length, 0);
});

test('HistoryStore схлопывает повторные визиты одного адреса', () => {
  const store = new HistoryStore();
  store.clear();
  store.add({ url: 'https://example.com/', title: 'Пример' });
  store.add({ url: 'https://example.com/', title: 'Пример' });
  assert.strictEqual(store.all().length, 1);
  assert.strictEqual(store.all()[0].visits, 2);
  store.clear();
});

test('BookmarkStore: add/has/toggle/remove', () => {
  const store = new BookmarkStore();
  store.list().slice().forEach((b) => store.remove(b.url));

  assert.strictEqual(store.add({ url: 'https://example.com/', title: 'Пример' }), true);
  assert.strictEqual(store.add({ url: 'https://example.com/', title: 'Пример' }), false);
  assert.strictEqual(store.has('https://example.com/'), true);

  assert.strictEqual(store.toggle({ url: 'https://example.com/' }), false);
  assert.strictEqual(store.has('https://example.com/'), false);

  assert.strictEqual(store.toggle({ url: 'https://new.test/', title: 'Новый' }), true);
  assert.strictEqual(store.has('https://new.test/'), true);

  assert.strictEqual(store.remove('https://new.test/'), true);
  assert.strictEqual(store.remove('https://new.test/'), false);
});

test('импорт истории сохраняет разные визиты и не дублирует повторный импорт', () => {
  const store = new HistoryStore();
  store.clear();
  const entries = [
    { url: 'https://visit.test/', title: 'Первый визит', time: 1000, visits: 1 },
    { url: 'https://visit.test/', title: 'Второй визит', time: 2000, visits: 3 }
  ];
  assert.strictEqual(store.importEntries(entries), 2);
  assert.strictEqual(store.importEntries(entries), 0);
  assert.deepStrictEqual(store.all().map((item) => item.time), [1000, 2000]);
  assert.strictEqual(store.all()[1].visits, 3);
  store.clear();
});

test('пакетный импорт закладок сохраняет порядок и пропускает существующие URL', () => {
  const store = new BookmarkStore();
  store.list().slice().forEach((item) => store.remove(item.url));
  const entries = [
    { url: 'https://first.test/', title: 'Первый' },
    { url: 'https://second.test/', title: 'Второй' },
    { url: 'https://first.test/', title: 'Повтор' }
  ];
  assert.strictEqual(store.importEntries(entries), 2);
  assert.strictEqual(store.importEntries(entries), 0);
  assert.deepStrictEqual(store.list().map((item) => item.url), ['https://first.test/', 'https://second.test/']);
  store.list().slice().forEach((item) => store.remove(item.url));
});

test('Store сохраняет резервную копию повреждённого JSON-профиля', () => {
  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'store.js'), 'utf8');
  assert.ok(storeSrc.includes('.corrupt-${Date.now()}'), 'повреждённый JSON должен сохраняться отдельно');
  assert.ok(storeSrc.includes("err.name === 'SyntaxError'"), 'резервная копия нужна только для ошибки разбора JSON');
});

test('перенос закладок и истории использует безопасные переносимые форматы', () => {
  const transfer = require('../src/main/data-transfer');
  const html = transfer.bookmarksToHtml([{ url: 'https://example.com/?a=1&b=2', title: 'Пример' }]);
  assert.ok(html.includes('NETSCAPE-Bookmark-file'), 'закладки должны быть совместимы с Netscape HTML');
  assert.deepStrictEqual(transfer.parseBookmarksHtml(html)[0], { url: 'https://example.com/?a=1&b=2', title: 'Пример' });
  assert.throws(() => transfer.parseBookmarksHtml('<html>нет закладок</html>'), /Netscape/);
  const json = transfer.historyToJson([{ url: 'https://example.com/', title: 'Пример', visits: 2 }]);
  assert.strictEqual(transfer.parseHistoryJson(json)[0].visits, 2);
  assert.throws(() => transfer.parseHistoryJson('{"items":[{"url":"file:///secret"}]}'), /подходящих/);
  assert.deepStrictEqual(transfer.parseBookmarksHtml(transfer.bookmarksToHtml([])), []);
  assert.deepStrictEqual(transfer.parseHistoryJson(transfer.historyToJson([])), []);
  assert.strictEqual(transfer.MAX_IMPORT_BYTES, 8 * 1024 * 1024);
});

suite('Генератор иконок (tools/make-icon.js)');

test('encodePng создаёт валидный PNG', () => {
  const canvas = drawIcon(32);
  const png = encodePng(canvas.data, 32);
  assert.strictEqual(png.readUInt32BE(0), 0x89504e47);
  assert.strictEqual(png.toString('ascii', 12, 16), 'IHDR');
  assert.strictEqual(png.readUInt32BE(16), 32);
  assert.strictEqual(png.readUInt32BE(20), 32);
  assert.strictEqual(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
});

test('drawIcon заполняет центр тёмным, а фон — акцентным', () => {
  const size = 64;
  const canvas = drawIcon(size);
  const at = (x, y) => {
    const i = (y * size + x) * 4;
    return [canvas.data[i], canvas.data[i + 1], canvas.data[i + 2], canvas.data[i + 3]];
  };
  // верхний левый угол закруглён — прозрачный
  assert.strictEqual(at(0, 0)[3], 0);
  // центр головы — тёмный
  const center = at(32, 34);
  assert.ok(center[3] > 200, `альфа центра = ${center[3]}`);
  assert.ok(center[0] < 60 && center[1] < 60, `центр должен быть тёмным: ${center}`);
  // область рядом с головой — акцент
  const accent = at(61, 40);
  assert.ok(accent[0] > 200, `акцент должен быть оранжевым: ${accent}`);
});

test('encodeIco содержит корректный заголовок и все размеры', () => {
  const sizes = [16, 32, 48, 256];
  const rendered = sizes.map((size) => ({ size, data: encodePng(drawIcon(size).data, size) }));
  const ico = encodeIco(rendered);

  assert.strictEqual(ico.readUInt16LE(0), 0);
  assert.strictEqual(ico.readUInt16LE(2), 1);
  assert.strictEqual(ico.readUInt16LE(4), sizes.length);
  assert.strictEqual(ico[6], 16);
  assert.strictEqual(ico[7], 16);
  assert.strictEqual(ico[6 + 16 * 3], 0); // 256 кодируется нулём

  const firstOffset = ico.readUInt32LE(6 + 12);
  assert.strictEqual(firstOffset, 6 + sizes.length * 16);
  assert.strictEqual(ico.readUInt32BE(firstOffset), 0x89504e47);
});

suite('Косметические правила (скрытие элементов)');

test('parseCosmetic разбирает домены, исключения и процедурные правила', () => {
  const generic = parseCosmetic('##.adsbygoogle');
  assert.deepStrictEqual(generic.domains, []);
  assert.strictEqual(generic.body, '.adsbygoogle');
  assert.strictEqual(generic.exception, false);

  const scoped = parseCosmetic('example.com,~sub.example.com##.ad');
  assert.deepStrictEqual(scoped.domains, ['example.com']);
  assert.deepStrictEqual(scoped.excluded, ['sub.example.com']);

  const exception = parseCosmetic('youtube.com#@#.video-ads');
  assert.strictEqual(exception.exception, true);
  assert.deepStrictEqual(exception.domains, ['youtube.com']);

  const procedural = parseCosmetic('site.ru#?#div:has-text(Реклама)');
  assert.strictEqual(procedural.procedural, true);

  assert.strictEqual(parseCosmetic('||ads.example.com^'), null);
});

test('косметические правила собираются для конкретной страницы', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText(
    [
      '##.generic-ad',
      'example.com##.site-ad',
      'other.com##.other-ad',
      'example.com#@#.generic-ad',
      '~example.com##.not-here'
    ].join('\n'),
    'test'
  );

  const onExample = b.cosmeticsFor('https://example.com/page');
  assert.ok(onExample.hide.includes('.site-ad'), 'правило сайта должно применяться');
  assert.ok(!onExample.hide.includes('.generic-ad'), 'исключение #@# должно убирать правило');
  assert.ok(!onExample.hide.includes('.other-ad'), 'чужой сайт не должен попадать');
  assert.ok(!onExample.hide.includes('.not-here'), '~example.com исключает сайт');

  const onOther = b.cosmeticsFor('https://other.com/');
  assert.ok(onOther.hide.includes('.generic-ad'));
  assert.ok(onOther.hide.includes('.other-ad'));
  assert.ok(onOther.hide.includes('.not-here'), '~example.com скрывается везде, кроме example.com');
});

test('процедурные правила не попадают в CSS, а отдаются скрипту', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('site.ru##div:has-text(Реклама)\nsite.ru##.plain', 'test');
  const rules = b.cosmeticsFor('https://site.ru/');
  assert.deepStrictEqual(rules.procedural, ['div:has-text(Реклама)']);
  assert.ok(rules.hide.includes('.plain'));
  assert.ok(!rules.hide.some((s) => s.includes(':has-text(')), 'процедурное правило не должно уходить в CSS');
});

test('$generichide отключает общие правила скрытия для сайта', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('##.generic-ad\nsite.ru##.site-ad\n@@||site.ru^$generichide', 'test');
  const rules = b.cosmeticsFor('https://site.ru/page');
  assert.strictEqual(rules.generichide, true);
  assert.ok(!rules.hide.includes('.generic-ad'));
  assert.ok(rules.hide.includes('.site-ad'), 'правила самого сайта остаются');
});

suite('Правила-модификаторы ($redirect, $removeparam, $popup)');

test('$redirect подменяет рекламный скрипт пустышкой', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('||ads.test/adsbygoogle.js$script,redirect=noopjs', 'test');
  const action = b.getAction({ url: 'https://ads.test/adsbygoogle.js', type: 'script', tabUrl: 'https://site.com/' });
  assert.strictEqual(action.block, true);
  assert.strictEqual(action.redirect, REDIRECT_RESOURCES.noopjs);
});

test('$removeparam чистит метки и НЕ блокирует переход', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('$document,removeparam=utm_source\n$document,removeparam=fbclid', 'test');

  const dirty = b.getAction({
    url: 'https://shop.test/item?utm_source=mail&fbclid=42&id=7',
    type: 'mainFrame',
    tabUrl: 'https://shop.test/item'
  });
  assert.strictEqual(dirty.block, false, 'переход не должен блокироваться');
  assert.strictEqual(dirty.redirect, 'https://shop.test/item?id=7');

  // Чистить нечего — правило не должно «съесть» страницу целиком
  const clean = b.getAction({
    url: 'https://www.youtube.com/',
    type: 'mainFrame',
    tabUrl: 'https://www.youtube.com/'
  });
  assert.strictEqual(clean.block, false);
  assert.strictEqual(clean.redirect, '');
});

test('$removeparam не применяется к обычным ресурсам', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('$document,removeparam=fbclid', 'test');
  const img = b.getAction({ url: 'https://cdn.test/a.png?fbclid=1', type: 'image', tabUrl: 'https://site.test/' });
  assert.strictEqual(img.block, false);
  assert.strictEqual(img.redirect, '');
});

test('$popup блокирует только всплывающие окна', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('||popads.test^$popup', 'test');
  assert.strictEqual(
    b.getAction({ url: 'https://popads.test/x', type: 'popup', tabUrl: 'https://site.com/' }).block,
    true
  );
  assert.strictEqual(
    b.getAction({ url: 'https://popads.test/x.js', type: 'script', tabUrl: 'https://site.com/' }).block,
    false
  );
});

test('stripParams удаляет только перечисленные параметры', () => {
  assert.strictEqual(stripParams('https://a.test/x?utm_source=1&id=2', ['utm_source']), 'https://a.test/x?id=2');
  assert.strictEqual(stripParams('https://a.test/x?id=2', ['utm_source']), '');
  assert.strictEqual(stripParams('https://a.test/x?a=1&b=2', ['*']), 'https://a.test/x');
});

test('hostSuffixes перебирает домен и поддомены', () => {
  assert.deepStrictEqual(hostSuffixes('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com']);
  assert.deepStrictEqual(hostSuffixes(''), []);
});

suite('Белый список сайтов и кэш решений');

test('toggleSite выключает и включает блокировку для сайта', () => {
  const b = makeBlocker();
  assert.strictEqual(b.shouldBlock(ctx('https://doubleclick.net/x.gif')), true);

  assert.strictEqual(b.toggleSite('site.com'), true);
  assert.strictEqual(b.shouldBlock(ctx('https://doubleclick.net/x.gif')), false, 'на сайте из белого списка блокировки нет');
  assert.deepStrictEqual(b.listWhitelist(), ['site.com']);

  assert.strictEqual(b.toggleSite('site.com'), false);
  assert.strictEqual(b.shouldBlock(ctx('https://doubleclick.net/x.gif')), true);
});

test('setWhitelist восстанавливает список после перезапуска', () => {
  const b = makeBlocker();
  b.setWhitelist(['news.ru', 'example.org']);
  assert.strictEqual(b.isWhitelisted('www.news.ru'), true);
  assert.strictEqual(b.isWhitelisted('example.org'), true);
  assert.strictEqual(b.isWhitelisted('other.ru'), false);
});

test('решение по одинаковому запросу берётся из кэша', () => {
  const b = makeBlocker();
  const first = b.getAction(ctx('https://doubleclick.net/x.gif'));
  const second = b.getAction(ctx('https://doubleclick.net/x.gif'));
  assert.strictEqual(first, second, 'повторный запрос не должен пересчитываться');

  b.addFiltersFromText('@@||doubleclick.net^', 'test2');
  assert.strictEqual(
    b.getAction(ctx('https://doubleclick.net/x.gif')).block,
    false,
    'кэш должен сбрасываться при добавлении правил'
  );
});

test('статистика знает про косметические правила и списки', () => {
  const b = new AdBlocker({ enabled: true });
  b.addFiltersFromText('##.ad\nsite.ru##.banner\n||ads.test^', 'test');
  const stats = b.getStats();
  assert.ok(stats.cosmeticRules >= 2, `косметических правил: ${stats.cosmeticRules}`);
  assert.deepStrictEqual(stats.lists, ['test']);
});

suite('Менеджер паролей (PasswordStore)');

test('save/reveal/bestFor работают и не хранят пароль открытым текстом', () => {
  const store = new PasswordStore();
  store.clear();
  const id = store.save({
    url: 'https://example.com/login',
    username: 'user@example.com',
    password: 's3cret'
  });
  assert.ok(id, 'должна появиться запись');

  const item = store.find(id);
  assert.ok(!item.password.includes('s3cret'), 'пароль не должен лежать в открытом виде');

  const revealed = store.reveal(id);
  assert.strictEqual(revealed.password, 's3cret');

  const best = store.bestFor('https://example.com/account');
  assert.strictEqual(best.username, 'user@example.com');
  assert.strictEqual(best.password, 's3cret');
  assert.strictEqual(best.id, id);
});

test('list отдаёт маску вместо пароля', () => {
  const store = new PasswordStore();
  store.clear();
  store.save({ url: 'https://shop.test/', username: 'me', password: 'topsecret' });
  const [entry] = store.list();
  assert.strictEqual(entry.host, 'shop.test');
  assert.ok(!JSON.stringify(entry).includes('topsecret'));
  assert.strictEqual(entry.masked.length, 8);
});

test('повторное сохранение обновляет запись, а не плодит дубли', () => {
  const store = new PasswordStore();
  store.clear();
  const first = store.save({ url: 'https://site.test/login', username: 'u', password: 'one' });
  const second = store.save({ url: 'https://site.test/login', username: 'u', password: 'two' });
  assert.strictEqual(first, second);
  assert.strictEqual(store.count, 1);
  assert.strictEqual(store.reveal(first).password, 'two');
});

test('has/remove/clear управляют хранилищем', () => {
  const store = new PasswordStore();
  store.clear();
  const id = store.save({ url: 'https://a.test/', username: 'x', password: 'p' });
  assert.strictEqual(store.has('https://a.test/', 'x'), true);
  assert.strictEqual(store.has('https://a.test/', 'y'), false);
  assert.strictEqual(store.remove(id), true);
  assert.strictEqual(store.remove(id), false);
  store.save({ url: 'https://b.test/', username: 'y', password: 'p' });
  store.clear();
  assert.strictEqual(store.count, 0);
});

test('save игнорирует записи без адреса или пароля', () => {
  const store = new PasswordStore();
  store.clear();
  assert.strictEqual(store.save({ url: '', username: 'u', password: 'p' }), null);
  assert.strictEqual(store.save({ url: 'https://a.test/', username: 'u', password: '' }), null);
  assert.strictEqual(store.count, 0);
});

suite('Проверки отправителя IPC (ipc-guards)');

const fakeEvent = (tabUrl, frameUrl) => ({
  sender: { getURL: () => tabUrl },
  senderFrame: frameUrl === undefined ? undefined : { url: frameUrl }
});

test('senderHosts собирает хосты вкладки и фрейма', () => {
  assert.deepStrictEqual(senderHosts(fakeEvent('https://a.test/x', 'https://b.test/y')), ['a.test', 'b.test']);
  assert.deepStrictEqual(senderHosts(fakeEvent('', '')), []);
});

test('isTrustedSender пропускает только внутренние страницы', () => {
  assert.strictEqual(isTrustedSender(fakeEvent('file:///C:/app/index.html')), true);
  assert.strictEqual(isTrustedSender(fakeEvent('https://evil.test/')), false);
  assert.strictEqual(isTrustedSender(fakeEvent('https://evil.test/', 'file:///tmp/x.html')), true);
});

test('sameHost сравнивает сайты, а не строки', () => {
  assert.strictEqual(sameHost(['example.com'], 'https://example.com/login'), true);
  assert.strictEqual(sameHost(['www.example.com'], 'https://example.com/'), true);
  assert.strictEqual(sameHost(['example.com'], 'https://evil-example.com/'), false);
  assert.strictEqual(sameHost([], 'https://example.com/'), false);
});

test('менеджер паролей и проверки отправителя на месте', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.ok(/createPasswordVault/.test(main), 'main.js должен подключать менеджер паролей');
  assert.ok(/registerIpc\(ipcMain\)/.test(main), 'каналы паролей должны регистрироваться');
});

suite('Целостность проекта');

test('все ключевые файлы на месте', () => {
  const files = [
    'package.json',
    'README.md',
    'src/main/main.js',
    'src/main/tabs.js',
    'src/main/adblock.js',
    'src/main/store.js',
    'src/main/data-transfer.js',
    'src/main/url-utils.js',
    'src/main/passwords.js',
    'src/main/ipc-guards.js',
    'src/main/filters/index.js',
    'src/main/filters/kitsune-base.txt.js',
    'src/preload/preload.js',
    'src/renderer/index.html',
    'src/renderer/styles.css',
    'src/renderer/renderer.js',
    'src/renderer/pages/home.html',
    'src/renderer/pages/settings.html',
    'src/renderer/pages/blocklist.html',
    'src/renderer/pages/passwords.html',
    'src/renderer/pages/about.html',
    'src/renderer/pages/internal.css',
    'src/renderer/pages/internal.js',
    'src/shared/constants.js',
    'src/shared/version.js',
    'tools/make-icon.js'
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), `нет файла: ${f}`);
  }
});

test('build/icon.png и build/icon.ico созданы и валидны', () => {
  const png = path.join(__dirname, '..', 'build', 'icon.png');
  const ico = path.join(__dirname, '..', 'build', 'icon.ico');
  assert.ok(fs.existsSync(png), 'нет build/icon.png — запустите npm run icon');
  assert.ok(fs.existsSync(ico), 'нет build/icon.ico — запустите npm run icon');
  assert.strictEqual(fs.readFileSync(png).readUInt32BE(0), 0x89504e47);
  assert.strictEqual(fs.readFileSync(ico).readUInt16LE(2), 1);
});

test('preload.js использует contextBridge и не течёт require', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  assert.ok(src.includes('contextBridge.exposeInMainWorld'), 'должен использоваться contextBridge');
  assert.ok(!src.includes('nodeIntegration: true'), 'nodeIntegration не должен включаться');
  assert.ok(!/exposeInMainWorld\([^)]*require\b/.test(src), 'require не должен утекать в renderer');
});

test('renderer общается с движком только через window.kitsune', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(src.includes('window.kitsune'), 'renderer.js должен обращаться к window.kitsune');
  assert.ok(!src.includes("require('electron')"), 'renderer не должен требовать electron напрямую');
});

test('домашняя страница навешивает поиск и быстрые ссылки до фоновых IPC-запросов', () => {
  const internal = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'internal.js'), 'utf8');
  const home = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'home.html'), 'utf8');
  const handlers = internal.indexOf("form.addEventListener('submit'");
  const firstOptionalRequest = internal.indexOf('await api.getAppInfo()');
  assert.ok(handlers >= 0 && handlers < firstOptionalRequest, 'поиск должен быть доступен до getAppInfo');
  assert.ok(internal.includes("btn.type = 'button'"), 'быстрые ссылки не должны отправлять форму');
  assert.ok(home.includes('type="button"'), 'кнопки домашней страницы должны иметь явный type');
  assert.ok(internal.includes('navigateHome(site.url)'), 'быстрые ссылки должны использовать навигацию вкладки');
});

test('JS-файлы проекта синтаксически корректны', () => {
  const targets = [
    'src/main/main.js',
    'src/main/tabs.js',
    'src/main/adblock.js',
    'src/main/store.js',
    'src/main/url-utils.js',
    'src/main/passwords.js',
    'src/main/ipc-guards.js',
    'src/main/updater.js',
    'src/main/filters/index.js',
    'src/main/filters/kitsune-base.txt.js',
    'src/preload/preload.js',
    'src/renderer/renderer.js',
    'src/renderer/pages/internal.js',
    'src/shared/constants.js',
    'src/shared/version.js',
    'tools/make-icon.js',
    'tools/build-installers.js',
    'tools/publish-release.js',
    'test/run-tests.js'
  ];
  const { execFileSync } = require('child_process');
  for (const f of targets) {
    const full = path.join(__dirname, '..', f);
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(`${f}: ${err.stderr ? err.stderr.toString().split('\n')[0] : err.message}`);
    }
  }
});

/* ─────────────────────────── Закрытие вкладок и хоткеи ─────────────────────────── */

suite('Закрытие вкладок и горячие клавиши');

const readMain = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const readTabs = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tabs.js'), 'utf8');
const readRenderer = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

test('по умолчанию окно не остаётся без вкладок', () => {
  assert.strictEqual(constants.DEFAULT_SETTINGS.closeLastTabOpensNewTab, true);
});

test('close() освобождает WebContentsView и не даёт странице заблокировать закрытие', () => {
  const src = readTabs();
  assert.ok(/removeChildView\(/.test(src), 'view должен сниматься с окна');
  assert.ok(/waitForBeforeUnload:\s*false/.test(src), 'beforeunload не должен мешать закрытию');
  assert.ok(/closedStack\.push\(/.test(src), 'адрес закрытой вкладки должен запоминаться');
});

test('closeOthers / closeToRight / reopenClosed реализованы', () => {
  const src = readTabs();
  for (const method of ['closeOthers(', 'closeToRight(', 'reopenClosed(', '_disposeView(']) {
    assert.ok(src.includes(method), `нет метода ${method}`);
  }
});

test('закреплённые вкладки сохраняются, остаются слева и защищены массовым закрытием', () => {
  const tabs = readTabs();
  const main = readMain();
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  assert.ok(tabs.includes('togglePinned(id)'), 'нет переключения закреплённой вкладки');
  assert.ok(tabs.includes('pinned: !!t.pinned'), 'признак закрепления должен попасть в UI-состояние');
  assert.ok(tabs.includes("!this.tabs.get(id)?.pinned"), 'массовое закрытие не должно затрагивать закреплённые вкладки');
  assert.ok(tabs.includes('typeof entry === \'string\''), 'старая сессия из URL должна оставаться совместимой');
  assert.ok(main.includes("handle('tab:toggle-pinned'"), 'действие закрепления должно быть доступно через IPC');
  assert.ok(preload.includes("togglePinned: (id)"), 'preload должен открыть безопасный API закрепления');
});

test('аварийный старт пропускает сессию и оставляет журнал ошибки', () => {
  const main = readMain();
  assert.ok(main.includes("'startup.lock'"), 'нужен marker нештатного завершения');
  assert.ok(main.includes('prepareStartupRecovery()'), 'маркер должен проверяться перед bootstrap');
  assert.ok(main.includes('!safeStart && settings.get'), 'аварийный старт не должен восстанавливать старые вкладки');
  assert.ok(main.includes("'logs', 'main.log'"), 'ошибки main-процесса должны записываться в лог');
});

test('крестик вкладки реагирует на mousedown, а не только на click', () => {
  const src = readRenderer();
  assert.ok(/close\.addEventListener\('mousedown'/.test(src), 'нужен обработчик mousedown');
  assert.ok(
    !/node\.draggable\s*=\s*true/.test(src),
    'HTML5 drag&drop на вкладке ломает клики по крестику'
  );
  assert.ok(/addEventListener\('contextmenu'/.test(src), 'нужно контекстное меню вкладки');
});

test('горячие клавиши обрабатываются в main-процессе', () => {
  const main = readMain();
  const tabs = readTabs();
  assert.ok(/before-input-event/.test(main), 'main.js должен слушать before-input-event');
  assert.ok(/function handleShortcut\(/.test(main), 'нет handleShortcut');
  assert.ok(/before-input-event/.test(tabs), 'вкладки тоже должны перехватывать клавиши');
  assert.ok(/onShortcut/.test(tabs), 'TabManager должен получать обработчик хоткеев');
});

test('меню не дублирует горячие клавиши через accelerator', () => {
  const accelerators = readMain().match(/accelerator:/g) || [];
  assert.strictEqual(
    accelerators.length,
    1,
    'через accelerator должна остаться только Ctrl+Q, иначе хоткей сработает дважды'
  );
});

test('User-Agent не содержит метки Electron и берёт версию Chromium', () => {
  const src = readMain();
  const start = src.indexOf('function buildUserAgent(');
  assert.ok(start > -1, 'нет buildUserAgent');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/process\.versions\.chrome/.test(body), 'версия Chromium должна попадать в UA');
  assert.ok(/Chrome\//.test(body), 'UA должен сообщать о себе как о Chrome');
  assert.ok(!/electron/i.test(body), 'метка Electron в UA ломает часть сайтов');
});

test('адресная строка синхронизируется при смене активной вкладки', () => {
  const src = readRenderer();
  assert.ok(/if \(state\.activeId !== prevActiveId\) ui\.editingAddress = false/.test(src),
    'при переключении вкладки черновик адреса должен сбрасываться');
});

test('Escape отменяет черновик адресной строки и восстанавливает URL вкладки', () => {
  const src = readRenderer();
  assert.ok(/function cancelAddressEdit\(\)/.test(src), 'нужна отдельная отмена редактирования');
  assert.ok(/el\.address\.value = active && active\.url \? active\.url : ''/.test(src),
    'после Escape должен восстанавливаться URL активной вкладки');
  assert.ok(/e\.preventDefault\(\);\s*cancelAddressEdit\(\);/.test(src),
    'Escape адресной строки должен отменять черновик');
});


/* ─────────────────────────── Оптимизация ─────────────────────────── */

suite('Оптимизация и производительность');

test('состояние вкладок отправляется склеенно и без повторов', () => {
  const src = readTabs();
  assert.ok(/this\._lastStateJson/.test(src), 'одинаковое состояние не должно уходить по IPC');
  assert.ok(/emitStateNow\(/.test(src), 'нужен путь для немедленной отправки');
  assert.ok(/did-navigate-in-page[\s\S]{0,400}url === tab\.url/.test(src), 'SPA-переходы без смены адреса не должны перерисовывать UI');
});

test('счётчик блокировок не спамит UI-слой', () => {
  const src = readMain();
  assert.ok(/blockedNotifyTimer/.test(src), 'нужен троттлинг adblock:count');
});

test('косметические правила применяются через insertCSS', () => {
  const src = readMain();
  assert.ok(/function applyCosmetics/.test(src));
  assert.ok(/insertCSS\(/.test(src));
  assert.ok(/removeInsertedCSS\(/.test(src));
});

test('полоса вкладок переиспользует узлы вместо полной пересборки', () => {
  const src = readRenderer();
  assert.ok(/const tabNodes = new Map\(\)/.test(src), 'узлы вкладок должны кэшироваться');
  assert.ok(/function updateTabNode/.test(src));
  assert.ok(!/el\.tabs\.textContent = ''/.test(src), 'полная пересборка полосы вкладок — источник лагов');
});

test('история пишется на диск с задержкой, а не на каждый переход', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'store.js'), 'utf8');
  assert.ok(/saveDebounced\(/.test(src));
  assert.ok(/flush\(\)/.test(src));
});

test('хост запроса кэшируется, а решения — переиспользуются', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'adblock.js'), 'utf8');
  assert.ok(/HOST_CACHE/.test(src), 'разбор URL на каждый запрос греет CPU');
  assert.ok(/decisionCache/.test(src));
});

test('вкладка сдвигается только под выпадающие элементы', () => {
  const src = readTabs();
  assert.ok(/setInsets\(/.test(src));
  assert.ok(/overlayBottom/.test(src));
  assert.ok(/sidebarRight/.test(src));
});

test('меню-«гамбургер» рисует main-процесс (иначе оно под вкладкой)', () => {
  const main = readMain();
  const renderer = readRenderer();
  assert.ok(/function buildAppMenu/.test(main), 'меню должно строиться в main-процессе');
  assert.ok(/menu\.popup\(/.test(main));
  assert.ok(/ui\.appMenu\(/.test(renderer), 'кнопка должна просить меню у main-процесса');
  assert.ok(!/id="app-menu"/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')),
    'HTML-меню не должно вернуться: оно оказывается под нативной вкладкой');
});

test('менеджер паролей шифрует данные средствами системы', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'store.js'), 'utf8');
  assert.ok(/safeStorage/.test(src), 'пароли должны шифроваться через safeStorage');
  assert.ok(/class PasswordStore/.test(src));
});

test('полный API браузера недоступен обычным сайтам', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  assert.ok(/isInternalPage\(\)/.test(src));
  assert.ok(/exposeInMainWorld\('kitsunePage'/.test(src), 'сайтам должен доставаться только узкий API');
  assert.ok(/if \(isInternalPage\(\)\) exposeBrowserApi\(\)/.test(src));
});

test('история, закладки и перенос данных защищены от вызова обычным сайтом', () => {
  const main = readMain();
  assert.ok(/history:list', \(event/.test(main) && /if \(!isTrustedSender\(event\)\) return \[\];/.test(main));
  assert.ok(/bookmarks:list', \(event/.test(main) && /isTrustedSender\(event\) \? bookmarks\.list\(\) : \[\]/.test(main));
  for (const channel of ['history:export', 'history:import', 'bookmarks:export', 'bookmarks:import']) {
    const at = main.indexOf(`'${channel}'`);
    assert.ok(at >= 0, `нет IPC-канала ${channel}`);
    assert.ok(main.slice(at, at + 180).includes('isTrustedSender(event)'), `${channel} не проверяет отправителя`);
  }
});

/* ─────────────────────────── Автообновление ─────────────────────────── */

suite('Загрузки и жизненный цикл вкладок');

test('внутренняя страница загрузок подключена и защищена IPC', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/pages/downloads.html'), 'utf8');
  assert.ok(/kitsune:\/\/downloads/.test(fs.readFileSync(path.join(__dirname, '..', 'src/shared/constants.js'), 'utf8')));
  assert.ok(/downloads:list/.test(preload) && /downloads:open/.test(preload));
  const downloads = fs.readFileSync(path.join(__dirname, '..', 'src/main/downloads.js'), 'utf8');
  assert.ok(/will-download/.test(downloads));
  assert.ok(/isTrustedSender/.test(downloads));
  assert.ok(/download-list/.test(page));
  assert.ok(/createDownloads/.test(main));
});

test('активной считается только прикреплённая и неуничтоженная вкладка', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/tabs.js'), 'utf8');
  assert.ok(/attached: false/.test(src));
  assert.ok(/tab\.attached = true/.test(src));
  assert.ok(/!tab\.attached.*webContents\.isDestroyed/.test(src));
  assert.ok(/activeId: active \? active\.id : null/.test(src));
  assert.ok(/!t\.view\.webContents\.isDestroyed\(\)/.test(src));
});

test('версия 1.5.0 синхронизирована', () => {
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version, '1.5.0');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8')).version, '1.5.0');
  assert.strictEqual(require('../src/shared/version').VERSION, '1.5.0');
});

test('TabManager получает SettingsStore, а не снимок настроек', () => {
  const main = readMain();
  const tabs = fs.readFileSync(path.join(__dirname, '..', 'src/main/tabs.js'), 'utf8');
  const bootstrap = main.slice(main.indexOf('tabs = new TabManager'), main.indexOf('vault = createPasswordVault'));
  assert.ok(/\n\s*settings,\s*\r?\n/.test(bootstrap),
    'смена поисковика должна быть доступна TabManager без перезапуска');
  assert.ok(!/settings:\s*settings\.settings,/.test(bootstrap),
    'снимок настроек ломает создание вкладок и навигацию');
  assert.ok(tabs.includes('return source;'),
    'TabManager должен быть совместим со старым форматом настроек при обновлении');
});

test('чувствительные разрешения требуют выбора пользователя и могут быть отозваны', () => {
  const main = readMain();
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/preload.js'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/pages/settings.html'), 'utf8');
  assert.ok(/Только в этот раз/.test(main) && /Всегда доверять этому сайту/.test(main));
  assert.ok(/geolocation/.test(main) && /media/.test(main) && /permissions:revoke/.test(main));
  assert.ok(/permissions:\s*\{/.test(preload) && /site-permissions/.test(settings));
  assert.ok(/destroyed.*temporarySitePermissions\.delete/.test(main));
});

test('чувствительные разрешения сайтов не выдаются автоматически', () => {
  const main = readMain();
  assert.ok(/setPermissionRequestHandler/.test(main));
  assert.ok(!/allowed\s*=\s*\[[^\]]*geolocation/.test(main));
  assert.ok(!/allowed\s*=\s*\[[^\]]*notifications/.test(main));
  assert.ok(/clipboard-sanitized-write/.test(main));
});

test('popup-ссылки остаются под управлением вкладок Kitsune', () => {
  const tabs = readTabs();
  assert.ok(/setWindowOpenHandler/.test(tabs));
  assert.ok(/return \{ action: 'deny' \}/.test(tabs));
  assert.ok(/this\.create\(\{ url, background: disposition === 'background-tab' \}\)/.test(tabs));
  assert.ok(!/return \{ action: 'allow' \}/.test(tabs));
});

test('интеграция браузера по умолчанию зарегистрирована безопасно', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/pages/settings.html'), 'utf8');
  assert.ok(/default-browser:state/.test(main) && /ms-settings:defaultapps/.test(main));
  assert.ok(/defaultBrowser/.test(preload) && /default-browser-status/.test(html));
  assert.ok(/getApplicationNameForProtocol\('http:'\)/.test(main));
});

test('история закрывается кнопкой, а загрузки доступны из тулбара', () => {
  const renderer = readRenderer();
  const html = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
  assert.ok(/sbClose\.addEventListener\('click', closeSidebar\)/.test(renderer));
  assert.ok(/id="downloads-button"/.test(html) && /downloads:changed/.test(renderer));
});

suite('Автообновление из GitHub Releases');

const readProject = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const readJson = (rel) => JSON.parse(readProject(rel));

test('канал обновлений зависит от разрядности сборки', () => {
  assert.strictEqual(channelForArch('ia32'), 'win32', '32-битной сборке нужен свой файл канала');
  assert.strictEqual(channelForArch('x64'), 'latest');
  assert.strictEqual(channelForArch('arm64'), 'latest');
});

test('ошибки обновления объясняются человеку, а не стектрейсом', () => {
  assert.ok(/релиза/.test(friendlyError(new Error('Cannot find latest.yml in the latest release artifacts'))));
  assert.ok(/интернет/.test(friendlyError(new Error('getaddrinfo ENOTFOUND api.github.com'))));
  assert.ok(/частоту/.test(friendlyError(new Error('API rate limit exceeded'))));
  assert.strictEqual(friendlyError(new Error('что-то пошло не так')), 'что-то пошло не так');
});

test('portable-сборка распознаётся по переменным окружения', () => {
  assert.strictEqual(isPortableBuild(), false);
  const saved = process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\temp\\Kitsune.exe';
  try {
    assert.strictEqual(isPortableBuild(), true);
  } finally {
    if (saved === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = saved;
  }
});

test('движок обновлений в исходниках честно сообщает, что не активен', () => {
  const updater = createUpdater({ send: () => {}, settings: { get: () => true } });
  const state = updater.getState();
  assert.strictEqual(state.supported, false);
  assert.strictEqual(state.reason, 'dev');
  assert.strictEqual(state.currentVersion, VERSION);
  assert.strictEqual(state.channel, channelForArch());
  assert.strictEqual(state.releasesPage, RELEASES_PAGE);
  assert.ok(RELEASES_PAGE.includes('akihoshinonyx/Kitsune-Browser'));
  assert.strictEqual(updater.start(), false, 'в исходниках автопроверка не планируется');
});

testAsync('ручная проверка в исходниках возвращает понятную причину', async () => {
  const events = [];
  const updater = createUpdater({
    send: (channel, payload) => events.push({ channel, payload }),
    settings: { get: () => true }
  });
  const state = await updater.check({ manual: true });
  assert.strictEqual(state.status, 'unsupported');
  assert.ok(/исходников/.test(state.message));
  assert.ok(events.some((e) => e.channel === 'updater:status'), 'состояние должно уходить в UI');
  assert.ok(events.some((e) => e.channel === 'ui:toast'), 'при ручной проверке нужен тост');
});

test('32-битная сборка просит свой файл канала, 64-битная — общий', () => {
  const electron = require('electron');
  const modulePath = require.resolve('electron-updater');
  const savedModule = require.cache[modulePath];
  const savedPackaged = electron.app.isPackaged;

  const fake = {
    autoUpdater: {
      _channel: null,
      on() {},
      get channel() {
        return this._channel;
      },
      // Повторяем поведение electron-updater: установка канала включает откат
      set channel(value) {
        this._channel = value;
        this.allowDowngrade = true;
      },
      allowDowngrade: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: true,
      logger: null
    }
  };

  electron.app.isPackaged = true;
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: fake };

  try {
    const x64 = createUpdater({ send: () => {}, settings: { get: () => true }, arch: 'x64' });
    x64.loadModule();
    assert.strictEqual(x64.getState().supported, true, 'в собранном приложении движок должен загрузиться');
    assert.strictEqual(fake.autoUpdater.channel, 'latest');
    assert.strictEqual(fake.autoUpdater.autoDownload, false);
    assert.strictEqual(
      fake.autoUpdater.allowDowngrade,
      false,
      'канал выставляется до запрета отката: сеттер channel включает allowDowngrade'
    );

    fake.autoUpdater.channel = '';
    const ia32 = createUpdater({ send: () => {}, settings: { get: () => true }, arch: 'ia32' });
    ia32.loadModule();
    assert.strictEqual(
      fake.autoUpdater.channel,
      'win32',
      'app-update.yml не содержит channel, поэтому 32-битной сборке его надо задать в коде'
    );
    assert.strictEqual(fake.autoUpdater.allowDowngrade, false);
    assert.strictEqual(ia32.getState().channel, 'win32');
    assert.strictEqual(ia32.getState().arch, 'ia32');
  } finally {
    if (savedModule) require.cache[modulePath] = savedModule;
    else delete require.cache[modulePath];
    electron.app.isPackaged = savedPackaged;
  }
});

test('обновление не ставится, пока не скачано', () => {
  const updater = createUpdater({ send: () => {}, settings: { get: () => true } });
  assert.strictEqual(updater.install(), false);
});

testAsync('IPC обновлений закрыт для обычных сайтов', async () => {
  const handlers = new Map();
  const updater = createUpdater({ send: () => {}, settings: { get: () => true } });
  updater.registerIpc({ handle: (channel, fn) => handlers.set(channel, fn) });

  for (const channel of ['updater:state', 'updater:check', 'updater:install', 'updater:open-releases']) {
    assert.ok(handlers.has(channel), `канал ${channel} должен быть зарегистрирован`);
  }

  const siteEvent = {
    sender: { getURL: () => 'https://evil.example/' },
    senderFrame: { url: 'https://evil.example/' }
  };
  const pageEvent = {
    sender: { getURL: () => 'file:///Kitsune/src/renderer/index.html' },
    senderFrame: { url: 'file:///Kitsune/src/renderer/index.html' }
  };

  assert.strictEqual(await handlers.get('updater:state')(siteEvent), null, 'сайту состояние не отдаём');
  const state = await handlers.get('updater:state')(pageEvent);
  assert.ok(state && state.currentVersion === VERSION, 'внутренней странице состояние доступно');
});

/* ───────────────────── Установщики, установка и публикация ───────────────────── */

suite('Установщики и публикация релиза');

test('конфиги сборки валидны, наследуют базу и знают про обе архитектуры', () => {
  const base = readJson('build/electron-builder.base.json');
  const x64 = readJson('build/electron-builder.x64.json');
  const ia32 = readJson('build/electron-builder.ia32.json');

  // Путь к родительскому конфигу electron-builder считает от корня проекта,
  // а не от файла с `extends` (см. app-builder-lib/util/config/load.ts).
  assert.strictEqual(x64.extends, 'build/electron-builder.base.json');
  assert.strictEqual(ia32.extends, 'build/electron-builder.base.json');

  assert.strictEqual(x64.electronVersion, '44.4.5');
  assert.strictEqual(ia32.electronVersion, '43.7.5', 'в Electron 44 нет win32-ia32 — 32-битная ветка на 43');

  const archOf = (cfg) => cfg.win.target.flatMap((t) => t.arch);
  assert.deepStrictEqual(archOf(x64), ['x64', 'x64']);
  assert.deepStrictEqual(archOf(ia32), ['ia32', 'ia32']);
  assert.deepStrictEqual(
    x64.win.target.map((t) => t.target),
    ['nsis', 'portable'],
    'должны собираться установщик и portable'
  );

  assert.strictEqual(x64.directories.output, 'release/x64');
  assert.strictEqual(ia32.directories.output, 'release/ia32');
  assert.strictEqual(ia32.publish[0].channel, 'win32', 'у 32-битной сборки свой канал обновлений');
  assert.strictEqual(base.publish[0].channel, undefined, 'у 64-битной — канал по умолчанию (latest)');
  assert.strictEqual(base.publish[0].owner, 'akihoshinonyx');
  assert.strictEqual(base.publish[0].repo, 'Kitsune-Browser');
});

test('базовый конфиг создаёт ярлыки и подключает свой NSIS-скрипт', () => {
  const base = readJson('build/electron-builder.base.json');
  assert.strictEqual(base.nsis.createDesktopShortcut, true, 'ярлык на рабочем столе обязателен');
  assert.strictEqual(base.nsis.createStartMenuShortcut, true);
  assert.strictEqual(base.nsis.oneClick, false, 'пользователь должен видеть выбор каталога');
  assert.strictEqual(base.nsis.perMachine, false, 'по умолчанию без прав администратора');
  assert.strictEqual(base.nsis.include, 'build/installer.nsh');
  assert.ok(base.artifactName.includes('${arch}'), 'имя установщика должно различать архитектуры');
  assert.ok(base.files.includes('src/**/*'));
});

test('NSIS-скрипт создаёт ярлык, регистрирует браузер и убирает всё при удалении', () => {
  const nsh = readProject('build/installer.nsh');
  assert.ok(/!macro customInstall/.test(nsh));
  assert.ok(/!macro customUnInstall/.test(nsh));
  assert.ok(/CreateShortCut "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"/.test(nsh), 'ярлык на рабочем столе');
  assert.ok(/CreateShortCut "\$SMPROGRAMS/.test(nsh), 'ярлык в меню «Пуск»');
  assert.ok(/RegisteredApplications/.test(nsh), 'браузер должен появляться в «Приложениях по умолчанию»');
  assert.ok(/DeleteRegValue HKCU "Software\\RegisteredApplications"/.test(nsh), 'удаление чистит реестр');
  assert.ok(!/[А-Яа-яЁё]/.test(nsh), 'в .nsh только латиница: makensis без BOM не читает UTF-8');
});

test('скрипт установки PowerShell готов к работе', () => {
  const full = path.join(__dirname, '..', 'tools', 'install.ps1');
  const raw = fs.readFileSync(full);
  assert.deepStrictEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'нужен UTF-8 BOM для Windows PowerShell 5.1');
  const src = raw.toString('utf8');
  assert.ok(/DesktopDirectory/.test(src), 'ярлык должен создаваться на реальном рабочем столе (учитывает OneDrive)');
  assert.ok(/New-Shortcut/.test(src) && /WScript\.Shell/.test(src));
  assert.ok(/robocopy\.exe/.test(src), 'копирование должно переживать большие деревья файлов');
  assert.ok(/UninstallString/.test(src), 'запись в «Установка и удаление программ»');
  assert.ok(/\$Uninstall\) \{ Uninstall-Kitsune \} else \{ Install-Kitsune \}/.test(src));
});

test('сборочный скрипт собирает обе архитектуры и проверяет билды', () => {
  const src = readProject('tools/build-installers.js');
  assert.ok(/arch: 'x64'/.test(src) && /arch: 'ia32'/.test(src));
  assert.ok(/win32\.yml/.test(src), 'канал 32-битной сборки должен переименовываться');
  assert.ok(/--kitsune-diagnostics-out=/.test(src), 'собранный билд должен проверяться запуском');
  assert.ok(/SHA256SUMS\.txt/.test(src) && /build-info\.json/.test(src));
  assert.ok(/sha256/.test(src));
});

test('скрипт публикации создаёт релиз и заменяет файлы повторно', () => {
  const src = readProject('tools/publish-release.js');
  assert.ok(/api\.github\.com\/repos\/\$\{OWNER\}\/\$\{REPO\}/.test(src));
  assert.ok(/releases\/tags\//.test(src), 'существующий релиз должен находиться по тегу');
  assert.ok(/releases\/assets\//.test(src), 'повторная публикация должна заменять файлы');
  assert.ok(/GH_TOKEN|GITHUB_TOKEN/.test(src));
  assert.ok(/RELEASE-NOTES\.md/.test(src), 'описание релиза берётся из документации');
  assert.ok(
    /IGNORED_ASSETS/.test(src) && /'builder-debug\.yml'/.test(src),
    'отладочный builder-debug.yml не должен попадать в релиз'
  );
  assert.ok(
    /function verifyRelease/.test(src) && /function pruneAssets/.test(src),
    'после загрузки релиз должен проверяться и чиститься от лишних файлов'
  );
});

test('workflow релиза публикует установщики по тегу', () => {
  const src = readProject('.github/workflows/release.yml');
  assert.ok(/tags:/.test(src) && /'v\*'/.test(src));
  assert.ok(/contents: write/.test(src), 'для создания релиза нужны права на запись');
  assert.ok(/npm run dist/.test(src));
  assert.ok(/publish-release\.js/.test(src));
  assert.ok(/secrets\.GITHUB_TOKEN/.test(src));
});

test('workflow CI прогоняет тесты', () => {
  const src = readProject('.github/workflows/ci.yml');
  assert.ok(/npm ci/.test(src));
  assert.ok(/npm test/.test(src));
});

/* ─────────────────────────── Версии и документация ─────────────────────────── */

suite('Версии и документация');

test('версия совпадает в package.json, constants.js и version.js', () => {
  const pkg = readJson('package.json');
  assert.strictEqual(constants.APP_VERSION, VERSION, 'constants.APP_VERSION должен совпадать с version.js');
  assert.strictEqual(pkg.version, VERSION, 'package.json задаёт версию релиза и обновлений');
  assert.strictEqual(pkg.dependencies['electron-updater'] !== undefined, true, 'electron-updater нужен в рантайме');
  assert.strictEqual(pkg.devDependencies.electron !== undefined, true);
});

test('описание проекта, руководство по установке и заметки к релизу на месте', () => {
  const description = readProject('docs/DESCRIPTION.md');
  const install = readProject('docs/INSTALL.md');
  const notes = readProject('docs/RELEASE-NOTES.md');
  assert.ok(/Kitsune Browser/.test(description) && description.length > 2000);
  assert.ok(/установщик/i.test(install) && /install\.ps1/.test(install));
  assert.ok(/\{\{VERSION\}\}/.test(notes), 'заметки к релизу должны подставлять версию');
  assert.ok(/win32\.yml/.test(install), 'руководство должно объяснять два канала обновлений');
  assert.ok(/SmartScreen/.test(install), 'предупреждение о неподписанной сборке должно быть описано');
});

test('README описывает установку, обновления и архитектуры', () => {
  const readme = readProject('README.md');
  assert.ok(/Kitsune-Browser-Setup/.test(readme), 'в README должны быть имена установщиков');
  assert.ok(/install\.ps1/.test(readme), 'скрипт установки должен быть описан');
  assert.ok(/Автообновление/.test(readme));
  assert.ok(/32-бит/.test(readme));
  assert.ok(/docs\/DESCRIPTION\.md/.test(readme));
});

/* ─────────────────────────── Полоса обновления в UI ─────────────────────────── */

suite('Полоса обновления и отступы UI');

test('полоса обновления есть в разметке, стилях и логике', () => {
  const html = readProject('src/renderer/index.html');
  const css = readProject('src/renderer/styles.css');
  const js = readRenderer();
  assert.ok(/id="update-banner"/.test(html));
  assert.ok(/id="update-action"/.test(html) && /id="update-text"/.test(html));
  assert.ok(/\.update-banner \{/.test(css) && /\.update-bar \{/.test(css));
  assert.ok(/function renderUpdate/.test(js));
  assert.ok(/api\.on\('updater:status'/.test(js));
  assert.ok(/api\.updater\.install\(\)/.test(js));
});

test('вкладка резервирует место под нижние уведомления', () => {
  const tabs = readTabs();
  assert.ok(/footer: 0/.test(tabs), 'в insets должно быть поле footer');
  assert.ok(/h - top - bottom/.test(tabs), 'высота вкладки должна уменьшаться на нижний отступ');
  const js = readRenderer();
  assert.ok(/function applyFooterInsets/.test(js));
  assert.ok(/footer: insets\.footer/.test(js), 'UI должен передавать нижний отступ в main-процесс');
});

test('preload отдаёт API обновлений и событие статуса', () => {
  const src = readProject('src/preload/preload.js');
  assert.ok(/updater: \{/.test(src));
  assert.ok(/invoke\('updater:check'\)/.test(src) && /invoke\('updater:install'\)/.test(src));
  assert.ok(/'updater:status'/.test(src), 'событие статуса должно быть в списке разрешённых');
});

test('main-процесс подключает обновления и умеет режим диагностики', () => {
  const main = readMain();
  assert.ok(/createUpdater\(\{ send, settings \}\)/.test(main));
  assert.ok(/updater\.registerIpc\(ipcMain\)/.test(main));
  assert.ok(/updater\.start\(\)/.test(main));
  assert.ok(/--kitsune-diagnostics/.test(main));
  assert.ok(
    /arg\.startsWith\('--kitsune-diagnostics-out='\)/.test(main),
    'режим диагностики должен включаться и по флагу --kitsune-diagnostics-out='
  );
  assert.ok(/function runDiagnostics/.test(main));
  assert.ok(/updateChannel: channelForArch\(\)/.test(main), 'страница «О браузере» должна знать канал');
});

suite('Видео, fullscreen, пароли и кнопки окна');

test('кнопка новой вкладки стоит в конце полосы и не занимает всё свободное место', () => {
  const html = readProject('src/renderer/index.html');
  const css = readProject('src/renderer/styles.css');
  const js = readRenderer();
  assert.ok(/id="tabs"[\s\S]*?id="new-tab"[\s\S]*?<\/div>/.test(html));
  assert.ok(/lastElementChild !== el\.newTab/.test(js));
  assert.ok(/flex: 0 1 auto/.test(css));
});

test('PiP ожидает результат Chromium, а Windows-окно не дублирует кнопки', () => {
  const main = readMain();
  assert.ok(/frame: process\.platform !== 'win32'/.test(main));
  assert.ok(/await target\.requestPictureInPicture\(\)/.test(main));
  assert.ok(/await document\.exitPictureInPicture\(\)/.test(main));
  assert.ok(/executeJavaScript\(PIP_TOGGLE_SCRIPT, true\)/.test(main));
});

test('HTML fullscreen убирает отступ страницы и возвращает вкладки после выхода', () => {
  const tabs = readTabs();
  const css = readProject('src/renderer/styles.css');
  assert.ok(/const top = fullscreen \? 0 : CHROME_HEIGHT/.test(tabs));
  assert.ok(/leave-html-full-screen/.test(tabs));
  assert.ok(/window:html-fullscreen', \{ value: false \}/.test(tabs));
  assert.ok(/\.html-fullscreen #tabstrip/.test(css));
});

test('менеджер паролей предлагает обновить изменённый пароль и скрывает ввод', () => {
  const pw = readProject('src/main/passwords.js');
  const html = readProject('src/renderer/pages/passwords.html');
  assert.ok(/saved\.password === password/.test(pw));
  assert.ok(/await askToSave\(\{ host, username, password, url \}\)/.test(pw));
  assert.ok(/type="password" id="pw-add-pass"/.test(html));
});

/* ─────────────────────────── Итог ─────────────────────────── */
console.log(`\n\u001b[1mИтого:\u001b[0m ${passed} успешно, ${failed} с ошибкой`);

if (failed > 0) {
  console.log('\n\u001b[31mПровалившиеся тесты:\u001b[0m');
  for (const f of failures) {
    console.log(`  • [${f.suite}] ${f.name}`);
    console.log(`    ${f.error.message.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

try {
  fs.rmSync(TMP_USER_DATA, { recursive: true, force: true });
} catch {
  /* временная папка не критична */
}

process.exit(failed > 0 ? 1 : 0);

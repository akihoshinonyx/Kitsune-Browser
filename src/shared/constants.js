'use strict';

/**
 * Общие константы Kitsune Browser.
 *
 * Файл подключается и в main-процессе (require), и в renderer
 * (обычный <script>, глобальный объект KITSUNE), поэтому используется
 * UMD-обёртка без внешних зависимостей.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.KITSUNE = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const APP_NAME = 'Kitsune Browser';
  const APP_SHORT_NAME = 'Kitsune';
  const APP_TAGLINE = 'Быстрый. Тихий. Без рекламы.';
  const APP_ID = 'com.kitsune.browser';
  const APP_VERSION = '1.5.2';

  /** Поисковые системы: основной поиск — DuckDuckGo */
  const SEARCH_ENGINES = {
    duckduckgo: {
      id: 'duckduckgo',
      name: 'DuckDuckGo',
      searchUrl: 'https://duckduckgo.com/?q=%s&t=kitsune',
      suggestUrl: 'https://duckduckgo.com/ac/?q=%s&type=list',
      home: 'https://duckduckgo.com/',
      description: 'Приватный поиск без слежки (по умолчанию)'
    },
    lite: {
      id: 'lite',
      name: 'DuckDuckGo Lite',
      searchUrl: 'https://lite.duckduckgo.com/lite/?q=%s',
      suggestUrl: 'https://duckduckgo.com/ac/?q=%s&type=list',
      home: 'https://lite.duckduckgo.com/',
      description: 'Максимально лёгкая версия — быстрее на слабом интернете'
    },
    html: {
      id: 'html',
      name: 'DuckDuckGo (без JS)',
      searchUrl: 'https://html.duckduckgo.com/html/?q=%s',
      suggestUrl: 'https://duckduckgo.com/ac/?q=%s&type=list',
      home: 'https://html.duckduckgo.com/',
      description: 'Работает даже при отключённых скриптах'
    }
  };

  /** Безопасный поиск DuckDuckGo: off | moderate | strict */
  const SAFE_SEARCH = {
    off: { id: 'off', name: 'Выключен', kp: '-2' },
    moderate: { id: 'moderate', name: 'Умеренный', kp: '-1' },
    strict: { id: 'strict', name: 'Строгий', kp: '1' }
  };

  const DEFAULT_SETTINGS = {
    searchEngine: 'duckduckgo',
    homePage: 'kitsune://home',
    adblockEnabled: true,
    blockPopups: true,
    safeSearch: 'moderate',
    restoreTabs: true,
    theme: 'dark',
    // Что делать при закрытии последней вкладки: открыть стартовую страницу
    // (true) или оставить пустое окно (false)
    closeLastTabOpensNewTab: true,
    // Менеджер паролей: предлагать сохранять пароли и подставлять их в формы
    savePasswords: true,
    autofillPasswords: true,
    // Автообновление из GitHub Releases (проверка в фоне + установка по кнопке)
    autoUpdate: true,
    // Постоянные разрешения сайтов. Заполняются только явным выбором
    // пользователя «Всегда доверять этому сайту».
    sitePermissions: {}
  };

  /** Внутренние страницы браузера */
  const INTERNAL_PAGES = {
    'kitsune://home': 'home.html',
    'kitsune://newtab': 'home.html',
    'kitsune://settings': 'settings.html',
    'kitsune://blocked': 'blocklist.html',
    'kitsune://passwords': 'passwords.html',
    'kitsune://downloads': 'downloads.html',
    'kitsune://about': 'about.html'
  };

  const HOME_PAGE_ALIASES = ['kitsune://home', 'kitsune://newtab', 'about:home'];

  return {
    APP_NAME,
    APP_SHORT_NAME,
    APP_TAGLINE,
    APP_ID,
    APP_VERSION,
    SEARCH_ENGINES,
    SAFE_SEARCH,
    DEFAULT_SETTINGS,
    INTERNAL_PAGES,
    HOME_PAGE_ALIASES
  };
});

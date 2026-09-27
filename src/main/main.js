'use strict';

/**
 * Kitsune Browser — точка входа main-процесса.
 *
 * Что делает файл:
 *  1) создаёт окно браузера;
 *  2) настраивает сессию: блокировка рекламы через webRequest,
 *     user-agent с меткой браузера, блокировка всплывающих окон;
 *  3) поднимает IPC-канал между UI (renderer) и движком;
 *  4) обрабатывает загрузки файлов, горячие клавиши, меню окна.
 */

const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const { APP_NAME, APP_SHORT_NAME, APP_TAGLINE, SEARCH_ENGINES } = require('../shared/constants');
const { VERSION } = require('../shared/version');
const { SettingsStore, HistoryStore, BookmarkStore, PasswordStore } = require('./store');
const { createAdBlocker, loadFilterLists, downloadFilterLists, USER_FILTER_FILE } = require('./filters');
const { senderHosts, sameHost } = require('./ipc-guards');
const { createUpdater, channelForArch, RELEASES_PAGE } = require('./updater');
const { createPasswordVault } = require('./passwords');
const { TabManager, CHROME_HEIGHT } = require('./tabs');
const { toNavigationUrl, isInternalUrl } = require('./url-utils');
const { hostnameOf } = require('./adblock');
const { searchUrlFor } = require('./url-utils');

const SESSION_PARTITION = 'persist:kitsune';

let mainWindow = null;
let tabs = null;
let adblock = null;
let settings = null;
let history = null;
let bookmarks = null;
let passwords = null;
let vault = null;
let updater = null;
let quitting = false;
let sessionRestored = false;
let findInPageQuery = '';

/** Отправка события в UI-слой */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ────────────────────────── Настройка сессии ────────────────────────── */

function setupSession() {
  const ses = session.fromPartition(SESSION_PARTITION);

  // ── Блокировка рекламы и трекеров ──
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      if (!adblock.enabled) return callback({ cancel: false });
      if (isInternalUrl(details.url)) return callback({ cancel: false });

      const tabForRequest = findTabByWebContentsId(details.webContentsId);
      const tabUrl = tabForRequest ? tabForRequest.url : '';
      const tabId = tabForRequest ? tabForRequest.id : -1;

      const action = adblock.getAction({
        url: details.url,
        type: details.resourceType,
        hostname: hostnameOf(details.url),
        tabUrl,
        tabId
      });

      // $redirect — вместо рекламы отдаём пустышку, чтобы сайт не ломался;
      // $removeparam — переходим на адрес без utm-меток (запрос не блокируем).
      if (action.redirect) {
        if (action.block) {
          adblock.recordBlocked({ tabId, url: details.url, type: details.resourceType });
          if (tabForRequest) tabForRequest.blocked = adblock.statsForTab(tabId);
          notifyBlockedCount(tabForRequest);
        }
        return callback({ redirectURL: action.redirect });
      }

      if (action.block) {
        adblock.recordBlocked({ tabId, url: details.url, type: details.resourceType });
        if (tabForRequest) tabForRequest.blocked = adblock.statsForTab(tabId);
        notifyBlockedCount(tabForRequest);
      }
      return callback({ cancel: action.block });
    } catch (err) {
      console.error('[Kitsune] Ошибка блокировки:', err.message);
      return callback({ cancel: false });
    }
  });

  // ── Заголовки: убираем рекламные идентификаторы и ставим свой UA ──
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = ses.getUserAgent();
    headers['DNT'] = '1';
    callback({ requestHeaders: headers });
  });

  // ── Запрет нежелательных схем и всплывающих окон ──
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['fullscreen', 'clipboard-sanitized-write', 'media', 'geolocation', 'notifications'];
    callback(allowed.includes(permission));
  });

  ses.setUserAgent(buildUserAgent());
}

/**
 * Собирает «чистый» User-Agent браузера.
 *
 * Electron по умолчанию подставляет в строку `Electron/44.4.5` и имя приложения.
 * Из-за этого часть сайтов (Google, Netflix, банки, видеосервисы) считает, что
 * перед ними встроенный движок, и отдаёт упрощённую или сломанную страницу.
 * Поэтому сообщаем ровно то, чем браузер и является: настоящий Chromium
 * (`process.versions.chrome` — актуальная версия движка) плюс метку Kitsune
 * в конце строки, как это делают Edge и Opera.
 */
function buildUserAgent() {
  const chromeVersion = process.versions.chrome || '120.0.0.0';
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return (
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromeVersion} Safari/537.36 ${APP_SHORT_NAME}/${VERSION}`
  );
}

/**
 * Быстрый поиск вкладки по id её webContents.
 *
 * Вызывается на КАЖДЫЙ сетевой запрос, поэтому результат кэшируется:
 * перебор всех вкладок на каждый запрос заметно грел CPU на тяжёлых сайтах.
 */
const tabByWcId = new Map();

function findTabByWebContentsId(webContentsId) {
  if (!tabs || webContentsId === undefined || webContentsId === null) return null;
  const cached = tabByWcId.get(webContentsId);
  if (cached && tabs.tabs.get(cached.id) === cached) return cached;

  for (const tab of tabs.tabs.values()) {
    const wc = tab.view.webContents;
    if (wc && wc.id === webContentsId) {
      tabByWcId.set(webContentsId, tab);
      return tab;
    }
  }
  tabByWcId.delete(webContentsId);
  return null;
}

/**
 * Сообщает UI счётчик заблокированного на активной вкладке.
 *
 * На рекламном сайте таких запросов десятки в секунду — отправляем не чаще
 * 5 раз в секунду, иначе UI-слой захлёбывается перерисовкой.
 */
let blockedNotifyTimer = null;

function notifyBlockedCount(tab) {
  if (!tab || tab.id !== tabs.activeId) return;
  if (blockedNotifyTimer) return;
  blockedNotifyTimer = setTimeout(() => {
    blockedNotifyTimer = null;
    if (!tabs) return;
    const active = tabs.active;
    if (!active) return;
    send('adblock:count', {
      tabId: active.id,
      count: active.blocked,
      total: adblock.blockedTotal
    });
  }, 180);
}

/* ─────────────────────────── Горячие клавиши ─────────────────────────── */

/** Отправляет событие в UI и заодно возвращает фокус полосе браузера */
function focusUi(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.focus();
  mainWindow.webContents.send(channel, payload);
}

/** Открывает/закрывает DevTools активной вкладки (а не окна с UI) */
function toggleTabDevTools(id) {
  const tab = id !== null && id !== undefined && tabs.tabs.has(id) ? tabs.tabs.get(id) : tabs.active;
  const wc = tab && tab.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

/** Возвращает последнюю закрытую вкладку (Ctrl+Shift+T) */
function reopenClosedTab() {
  const tab = tabs.reopenClosed();
  if (!tab) send('ui:toast', { text: 'Нет недавно закрытых вкладок' });
  return tab;
}

/**
 * Единая точка обработки горячих клавиш.
 *
 * Вызывается из `before-input-event`, то есть раньше, чем событие уйдёт
 * в страницу. Именно поэтому Ctrl+W, Ctrl+T, Ctrl+L и Ctrl+Shift+T работают
 * и тогда, когда фокус находится внутри веб-страницы, а не в полосе браузера.
 *
 * @param {Electron.Input} input
 * @param {number} [tabId] вкладка, из которой пришло событие
 * @returns {boolean} true — клавиша обработана и её нужно погасить
 */
function handleShortcut(input, tabId) {
  if (!tabs || !input || input.type !== 'keyDown') return false;

  const key = String(input.key || '').toLowerCase();
  const ctrl = !!(input.control || input.meta);
  const shift = !!input.shift;
  const alt = !!input.alt;
  const id = tabId !== undefined && tabs.tabs.has(tabId) ? tabId : tabs.activeId;

  const run = (fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[Kitsune] Горячая клавиша:', err.message);
    }
    return true;
  };

  // ── Навигация ──
  if (alt && key === 'arrowleft') return run(() => tabs.goBack(id));
  if (alt && key === 'arrowright') return run(() => tabs.goForward(id));
  if (alt && key === 'home') return run(() => tabs.goHome(id));

  // ── Обновление страницы ──
  if (!ctrl && !alt && key === 'f5') return run(() => tabs.reload(id, { ignoreCache: shift }));
  if (ctrl && key === 'r') return run(() => tabs.reload(id, { ignoreCache: shift }));

  // ── Вкладки ──
  if (ctrl && shift && key === 't') return run(() => reopenClosedTab());
  if (ctrl && key === 't') return run(() => tabs.create({ url: settings.get('homePage', 'kitsune://home') }));
  if (ctrl && key === 'w') return run(() => tabs.close(id));
  if (ctrl && key === 'tab') return run(() => cycleTab(shift ? -1 : 1));
  if (ctrl && !shift && /^[1-8]$/.test(key)) {
    return run(() => {
      const target = tabs.order[Number(key) - 1];
      if (target !== undefined) tabs.activate(target);
    });
  }
  if (ctrl && !shift && key === '9') {
    return run(() => {
      const last = tabs.order[tabs.order.length - 1];
      if (last !== undefined) tabs.activate(last);
    });
  }

  // ── Адресная строка и панели ──
  if ((ctrl && (key === 'l' || key === 'k')) || (alt && key === 'd') || key === 'f6') {
    return run(() => focusUi('ui:focus-address'));
  }
  if (ctrl && key === 'f') return run(() => focusUi('ui:focus-find'));
  if (ctrl && key === 'h') return run(() => focusUi('ui:open-history'));
  if (ctrl && key === 'j') return run(() => focusUi('ui:open-bookmarks'));
  if (ctrl && key === 'd') return run(() => send('ui:toggle-bookmark'));

  // ── Масштаб страницы ──
  if (ctrl && (key === '+' || key === '=' || key === 'add')) return run(() => tabs.setZoom(id, 0.5));
  if (ctrl && (key === '-' || key === '_' || key === 'subtract')) return run(() => tabs.setZoom(id, -0.5));
  if (ctrl && key === '0') return run(() => tabs.resetZoom(id));

  // ── Инструменты разработчика ──
  if (key === 'f12' || (ctrl && shift && key === 'i')) return run(() => toggleTabDevTools(id));

  return false;
}

/* ────────────────────────── Окно браузера ────────────────────────── */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    send('app:info', appInfo());

    // Режим разработки: npm run dev
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('resize', () => tabs && tabs.layoutAll());

  // Горячие клавиши для UI-слоя (когда фокус на полосе браузера)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    if (settings.get('restoreTabs', true) && tabs) {
      settings.set('lastSession', tabs.sessionUrls());
    }
    // закрываем все вкладки, чтобы не оставлять процессов
    quitting = true;
    if (tabs) tabs.destroyAll();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  Menu.setApplicationMenu(buildWindowMenu());
}

/** Собственное меню (скрыто по умолчанию, доступно по Alt) */
/**
 * Собственное меню приложения (скрыто по умолчанию, вызывается по Alt).
 *
 * Горячие клавиши здесь намеренно НЕ выставляются через `accelerator`:
 * все они обрабатываются в handleShortcut() через `before-input-event`,
 * иначе одно нажатие срабатывало бы дважды (меню + обработчик).
 * Комбинация просто показана в подписи пункта.
 */
function buildWindowMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая вкладка   (Ctrl+T)', click: () => tabs.create() },
        { label: 'Переоткрыть закрытую вкладку   (Ctrl+Shift+T)', click: () => reopenClosedTab() },
        { type: 'separator' },
        { label: 'Закрыть вкладку   (Ctrl+W)', click: () => tabs.closeActive() },
        { label: 'Закрыть другие вкладки', click: () => tabs.closeOthers(tabs.activeId) },
        { type: 'separator' },
        { label: 'Выход   (Ctrl+Q)', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Вернуть' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
        { type: 'separator' },
        { label: 'Найти на странице   (Ctrl+F)', click: () => focusUi('ui:focus-find') }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Обновить   (Ctrl+R)', click: () => tabs.reload(tabs.activeId) },
        {
          label: 'Обновить без кэша   (Ctrl+Shift+R)',
          click: () => tabs.reload(tabs.activeId, { ignoreCache: true })
        },
        { type: 'separator' },
        { label: 'Увеличить   (Ctrl + «+»)', click: () => tabs.setZoom(tabs.activeId, 0.5) },
        { label: 'Уменьшить   (Ctrl + «−»)', click: () => tabs.setZoom(tabs.activeId, -0.5) },
        { label: 'Обычный масштаб   (Ctrl+0)', click: () => tabs.resetZoom(tabs.activeId) },
        { type: 'separator' },
        { label: 'Инструменты разработчика   (F12)', click: () => toggleTabDevTools(tabs.activeId) },
        { role: 'togglefullscreen', label: 'Полный экран' }
      ]
    },
    {
      label: 'Переход',
      submenu: [
        { label: 'Назад   (Alt+←)', click: () => tabs.goBack(tabs.activeId) },
        { label: 'Вперёд   (Alt+→)', click: () => tabs.goForward(tabs.activeId) },
        { label: 'Домой   (Alt+Home)', click: () => tabs.goHome(tabs.activeId) },
        { type: 'separator' },
        { label: 'Следующая вкладка   (Ctrl+Tab)', click: () => cycleTab(1) },
        { label: 'Предыдущая вкладка   (Ctrl+Shift+Tab)', click: () => cycleTab(-1) }
      ]
    },
    {
      label: 'Инструменты',
      submenu: [
        { label: 'Настройки', click: () => tabs.navigate(tabs.activeId, 'kitsune://settings') },
        { label: 'Заблокированная реклама', click: () => tabs.navigate(tabs.activeId, 'kitsune://blocked') },
        { type: 'separator' },
        { label: 'История   (Ctrl+H)', click: () => focusUi('ui:open-history') },
        { label: 'Закладки   (Ctrl+J)', click: () => focusUi('ui:open-bookmarks') },
        { type: 'separator' },
        {
          label: 'Блокировка рекламы',
          type: 'checkbox',
          checked: true,
          id: 'adblock-toggle',
          click: (item) => setAdblockEnabled(item.checked)
        }
      ]
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'Проверить обновления', click: () => checkForUpdates(true) },
        { label: 'Открыть страницу релизов (GitHub)', click: () => openReleasesPage() },
        { type: 'separator' },
        { label: `О ${APP_NAME}`, click: () => tabs.navigate(tabs.activeId, 'kitsune://about') }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}
/**
 * Меню-«гамбургер» (кнопка с тремя линиями) — показывается нативным
 * `Menu.popup()`, а не HTML-элементом.
 *
 * Причина: WebContentsView вкладки рисуется ПОВЕРХ HTML-слоя окна, поэтому
 * выпадающий список, нарисованный в UI, оказывался под страницей — его было
 * не видно и невозможно нажать. Нативное меню всегда поверх и работает
 * с клавиатуры (стрелки, Enter, Esc).
 */
function buildAppMenu() {
  const adblockOn = adblock ? adblock.enabled : true;
  const canReopen = !!(tabs && tabs.closedStack.length);
  const hasTabs = !!(tabs && tabs.activeId !== null);

  const template = [
    {
      label: 'Новая вкладка   (Ctrl+T)',
      click: () => tabs.create({ url: settings.get('homePage', 'kitsune://home') })
    },
    {
      label: 'Переоткрыть закрытую вкладку   (Ctrl+Shift+T)',
      enabled: canReopen,
      click: () => reopenClosedTab()
    },
    { type: 'separator' },
    { label: 'История   (Ctrl+H)', click: () => focusUi('ui:open-history') },
    { label: 'Закладки   (Ctrl+J)', click: () => focusUi('ui:open-bookmarks') },
    { label: 'Пароли и автозаполнение', click: () => openInternal('kitsune://passwords') },
    { label: 'Найти на странице   (Ctrl+F)', enabled: hasTabs, click: () => focusUi('ui:focus-find') },
    { type: 'separator' },
    {
      label: `Блокировка рекламы: ${adblockOn ? 'включена' : 'выключена'}`,
      type: 'checkbox',
      checked: adblockOn,
      click: (item) => setAdblockEnabled(item.checked)
    },
    {
      label: 'Заблокировать элемент на странице',
      enabled: hasTabs,
      click: () => startElementPicker(tabs.activeId)
    },
    {
      label: 'Отключить блокировку на этом сайте',
      enabled: hasTabs,
      click: () => toggleSiteForActiveTab()
    },
    { label: 'Статистика блокировок', click: () => openInternal('kitsune://blocked') },
    { type: 'separator' },
    {
      label: 'Масштаб страницы',
      enabled: hasTabs,
      submenu: [
        { label: 'Увеличить   (Ctrl + «+»)', click: () => tabs.setZoom(tabs.activeId, 0.5) },
        { label: 'Уменьшить   (Ctrl + «−»)', click: () => tabs.setZoom(tabs.activeId, -0.5) },
        { label: 'Обычный масштаб   (Ctrl+0)', click: () => tabs.resetZoom(tabs.activeId) }
      ]
    },
    { label: 'Инструменты разработчика   (F12)', enabled: hasTabs, click: () => toggleTabDevTools(tabs.activeId) },
    { type: 'separator' },
    { label: 'Настройки', click: () => openInternal('kitsune://settings') },
    { label: updateMenuLabel(), click: () => checkForUpdates(true) },
    { label: `О ${APP_NAME}`, click: () => openInternal('kitsune://about') },
    { type: 'separator' },
    { label: 'Выход   (Ctrl+Q)', click: () => app.quit() }
  ];

  return Menu.buildFromTemplate(template);
}

/** Открывает внутреннюю страницу в активной вкладке (или в новой) */
function openInternal(url) {
  if (!tabs) return;
  if (tabs.activeId !== null) tabs.navigate(tabs.activeId, url);
  else tabs.create({ url });
}

/** Плоский список подписей пунктов меню (для тестов и диагностики) */
function collectMenuLabels(menu) {
  const out = [];
  const walk = (items) => {
    for (const item of items || []) {
      if (item.label) out.push(item.label.replace(/\s+\(.*\)$/, '').replace(/: (включена|выключена)$/, ''));
      if (item.submenu) walk(item.submenu.items);
    }
  };
  walk(menu.items);
  return out;
}

/* ─────────────────────────── Обновления ─────────────────────────── */

/** Подпись пункта меню — меняется вместе с состоянием загрузки */
function updateMenuLabel() {
  const st = updater ? updater.getState() : null;
  if (!st) return 'Проверить обновления';
  if (st.status === 'ready') return `Перезапустить и обновить до ${st.version || 'новой версии'}`;
  if (st.status === 'downloading') return `Скачиваем обновление… ${st.percent}%`;
  if (st.status === 'available') return `Обновление ${st.version || ''} — скачиваем…`;
  if (st.status === 'checking') return 'Проверяем обновления…';
  return 'Проверить обновления';
}

/**
 * Ручная проверка обновлений (меню, настройки, баннер).
 * Если обновление уже скачано — сразу перезапускаемся с установкой.
 */
function checkForUpdates(manual = true) {
  if (!updater) return false;
  if (updater.getState().status === 'ready') return updater.install();
  updater.check({ manual });
  return true;
}

/** Страница релизов на GitHub — на случай ручной загрузки установщика */
function openReleasesPage() {
  if (updater) return updater.openReleasesPage();
  shell.openExternal(RELEASES_PAGE);
  return true;
}


function cycleTab(delta) {
  if (!tabs || tabs.order.length < 2) return;
  const idx = tabs.order.indexOf(tabs.activeId);
  const next = (idx + delta + tabs.order.length) % tabs.order.length;
  tabs.activate(tabs.order[next]);
}

function setAdblockEnabled(enabled) {
  adblock.setEnabled(enabled);
  settings.set('adblockEnabled', enabled);
  const menu = Menu.getApplicationMenu();
  if (menu) {
    const item = menu.getMenuItemById('adblock-toggle');
    if (item) item.checked = enabled;
  }
  // Скрытые элементы нужно вернуть/убрать сразу, не дожидаясь перезагрузки
  if (tabs && tabs.active) applyCosmetics(tabs.active);
  send('adblock:state', { enabled, rules: adblock.rulesCount, blockedTotal: adblock.blockedTotal });
  send('settings:changed', settings.settings);
}

/* ─────────────────── Косметические правила и свои фильтры ───────────────────
   Всё, что ниже, приближает Kitsune к uBlock Origin: реклама не только
   блокируется по сети, но и скрывается на странице, а свои правила и
   «белый список» сайтов сохраняются между запусками. */

/** Файл с правилами пользователя (в userData — подхватывается при запуске) */
function userRulesPath() {
  return path.join(app.getPath('userData'), USER_FILTER_FILE);
}

/** Файл со списком сайтов, где блокировка выключена вручную */
function whitelistPath() {
  return path.join(app.getPath('userData'), 'adblock-whitelist.json');
}

function readUserRules() {
  try {
    const file = userRulesPath();
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('!'));
  } catch {
    return [];
  }
}

function writeUserRules(rules) {
  try {
    fs.writeFileSync(userRulesPath(), rules.join('\n') + '\n', 'utf8');
  } catch (err) {
    console.error('[Kitsune] Не удалось сохранить свои правила:', err.message);
  }
}

function readWhitelist() {
  try {
    const file = whitelistPath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWhitelist() {
  try {
    fs.writeFileSync(whitelistPath(), JSON.stringify(adblock.listWhitelist(), null, 2), 'utf8');
  } catch (err) {
    console.error('[Kitsune] Не удалось сохранить белый список:', err.message);
  }
}

/** Перечитывает все списки (после добавления своих правил или обновления) */
function reloadFilterLists() {
  if (!adblock) return;
  const whitelist = adblock.listWhitelist();
  adblock.reset();
  loadFilterLists(adblock, {
    filtersDir: path.join(__dirname, 'filters'),
    userDataDir: app.getPath('userData'),
    log: false
  });
  adblock.setWhitelist(whitelist);
  if (tabs) {
    tabs.emitState();
    const active = tabs.active;
    if (active) applyCosmetics(active);
  }
  send('adblock:state', {
    enabled: adblock.enabled,
    rules: adblock.rulesCount,
    blockedTotal: adblock.blockedTotal
  });
}

/** Добавляет правило пользователя: в текущую сессию и в файл */
function addUserRule(rule) {
  const text = String(rule || '').trim();
  if (!text) return { added: 0, rules: adblock.rulesCount };
  const added = adblock.addFiltersFromText(text, 'Пользовательские правила');
  if (added) {
    const rules = readUserRules();
    if (!rules.includes(text)) writeUserRules([...rules, text]);
    const active = tabs && tabs.active;
    if (active) applyCosmetics(active);
    send('adblock:state', {
      enabled: adblock.enabled,
      rules: adblock.rulesCount,
      blockedTotal: adblock.blockedTotal
    });
  }
  return { added, rules: adblock.rulesCount };
}

/** Полностью запрещает домен запроса (uBO: «заблокировать домен») */
function blockHostOf(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  const res = addUserRule(`||${host}^`);
  if (res.added) send('ui:toast', { text: `Домен ${host} заблокирован` });
  return res.added > 0;
}

/**
 * Применяет косметические правила к загруженной странице.
 *
 * CSS вставляется через webContents.insertCSS: правило живёт вместе с
 * документом, не требует JS-наблюдения за DOM и ничего не тормозит.
 * Процедурные правила (:has-text) обрабатывает маленький скрипт.
 */
async function applyCosmetics(tab) {
  if (!tab || !adblock) return;
  const wc = tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed() || isInternalUrl(tab.url)) return;

  // Правило от предыдущей страницы больше не нужно
  if (tab.cosmeticKey) {
    try {
      await wc.removeInsertedCSS(tab.cosmeticKey);
    } catch {
      /* документ уже сменился */
    }
    tab.cosmeticKey = null;
  }

  if (!adblock.enabled) return;

  const rules = adblock.cosmeticsFor(tab.url);
  if (!rules.hide.length && !rules.procedural.length) return;

  if (rules.hide.length) {
    // Каждый селектор — отдельное правило: один неверный селектор не должен
    // ломать остальные (в CSS невалидный селектор в списке убивает весь список).
    const css = rules.hide.map((selector) => `${selector} { display: none !important; }`).join('\n');
    try {
      tab.cosmeticKey = await wc.insertCSS(css);
    } catch {
      /* страница закрылась во время вставки */
    }
  }

  if (rules.procedural.length) {
    wc.executeJavaScript(proceduralScript(rules.procedural), true).catch(() => {});
  }
}

/** Скрипт для правил вида `##.block:has-text(Реклама)` */
function proceduralScript(selectors) {
  return `(() => {
    if (window.__kitsuneProcedural) return;
    window.__kitsuneProcedural = true;
    const rules = ${JSON.stringify(selectors)};
    const hide = () => {
      for (const rule of rules) {
        const m = /^(.*):has-text\\((['"]?)(.*?)\\2\\)$/.exec(rule);
        if (!m) continue;
        let nodes;
        try {
          nodes = document.querySelectorAll(m[1] || '*');
        } catch (e) {
          continue;
        }
        for (const node of nodes) {
          if (node.dataset.kitsuneHidden === '1') continue;
          if (String(node.textContent || '').includes(m[3])) {
            node.style.setProperty('display', 'none', 'important');
            node.dataset.kitsuneHidden = '1';
          }
        }
      }
    };
    hide();
    new MutationObserver(hide).observe(document.documentElement, { childList: true, subtree: true });
  })();`;
}

/** Включает/выключает блокировку для сайта активной вкладки */
function toggleSiteForActiveTab() {
  const tab = tabs && tabs.active;
  if (!tab) return false;
  if (isInternalUrl(tab.url)) {
    send('ui:toast', { text: 'Внутренние страницы блокировщик не трогает' });
    return false;
  }
  const host = hostnameOf(tab.url);
  const disabled = adblock.toggleSite(host);
  saveWhitelist();
  applyCosmetics(tab);
  send('adblock:state', {
    enabled: adblock.enabled,
    rules: adblock.rulesCount,
    blockedTotal: adblock.blockedTotal
  });
  send('ui:toast', {
    text: disabled ? `Блокировка отключена на ${host}` : `Блокировка включена на ${host}`
  });
  return disabled;
}

/** Запускает пикер элементов на странице (как «пипетка» в uBO) */
function startElementPicker(tabId) {
  const tab = tabId === undefined || tabId === null ? tabs.active : tabs.tabs.get(tabId);
  if (!tab) return false;
  const wc = tab.view.webContents;
  if (wc.isDestroyed() || isInternalUrl(tab.url)) {
    send('ui:toast', { text: 'Выберите обычную страницу — внутренние не блокируются' });
    return false;
  }
  wc.send('adblock:picker-start');
  send('ui:toast', { text: 'Кликните по рекламному блоку (Esc — отмена)' });
  return true;
}

/** Правило скрытия элемента по CSS-селектору, выбранному на странице */
function addCosmeticRule(url, selector) {
  const host = hostnameOf(url);
  const body = String(selector || '').trim();
  if (!host || !body) return { added: 0, rules: adblock.rulesCount };
  const rule = `${host}##${body}`;
  const added = adblock.addFiltersFromText(rule, 'Пользовательские правила');
  if (added) {
    const rules = readUserRules();
    if (!rules.includes(rule)) writeUserRules([...rules, rule]);
    const tab = tabs && tabs.active;
    if (tab) applyCosmetics(tab);
    send('ui:toast', { text: `Элемент скрыт: ${body.slice(0, 40)}` });
  }
  return { added, rules: adblock.rulesCount };
}

/* ─────────────────────────── IPC с UI-слоем ─────────────────────────── */

/**
 * Контекстное меню вкладки (правый клик по вкладке в полосе браузера).
 * Пункты, которые не имеют смысла (например, «закрыть другие» при одной
 * вкладке), показываются неактивными, а не исчезают — так меню не «прыгает».
 */
function showTabContextMenu(event, id) {
  const tab = id === undefined || id === null ? tabs.active : tabs.tabs.get(id);
  if (!tab) return false;

  const index = tabs.order.indexOf(tab.id);
  const menu = Menu.buildFromTemplate([
    {
      label: 'Переоткрыть закрытую вкладку',
      enabled: tabs.closedStack.length > 0,
      click: () => reopenClosedTab()
    },
    { type: 'separator' },
    { label: 'Обновить', click: () => tabs.reload(tab.id) },
    { label: 'Дублировать вкладку', click: () => tabs.duplicate(tab.id) },
    { type: 'separator' },
    { label: 'Закрыть вкладку', click: () => tabs.close(tab.id) },
    {
      label: 'Закрыть другие вкладки',
      enabled: tabs.order.length > 1,
      click: () => tabs.closeOthers(tab.id)
    },
    {
      label: 'Закрыть вкладки справа',
      enabled: index >= 0 && index < tabs.order.length - 1,
      click: () => tabs.closeToRight(tab.id)
    },
    { type: 'separator' },
    {
      label: 'Копировать адрес',
      enabled: !!tab.url && !isInternalUrl(tab.url),
      click: () => clipboard.writeText(tab.url)
    }
  ]);

  const win = BrowserWindow.fromWebContents(event.sender);
  menu.popup({ window: win || mainWindow });
  return true;
}

/**
 * Контекстное меню страницы (правый клик внутри сайта).
 *
 * Здесь есть то, что нужно каждый день: копирование, открытие ссылки в новой
 * вкладке, проверка элемента и — как в uBlock Origin — «заблокировать
 * элемент» и «заблокировать домен».
 */
function showPageContextMenu(tabId, params = {}) {
  const tab = tabs.tabs.get(tabId);
  if (!tab) return false;
  const wc = tab.view.webContents;
  const template = [];
  const internal = isInternalUrl(tab.url);

  if (params.isEditable) {
    template.push(
      { role: 'undo', label: 'Отменить' },
      { role: 'redo', label: 'Вернуть' },
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' },
      { role: 'selectAll', label: 'Выделить всё' }
    );
  } else if (params.selectionText) {
    template.push({ role: 'copy', label: 'Копировать' });
  }

  if (params.linkURL) {
    if (template.length) template.push({ type: 'separator' });
    template.push(
      {
        label: 'Открыть ссылку в новой вкладке',
        click: () => tabs.create({ url: params.linkURL, background: true })
      },
      {
        label: 'Открыть ссылку в активной новой вкладке',
        click: () => tabs.create({ url: params.linkURL })
      },
      { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(params.linkURL) },
      { label: 'Заблокировать домен ссылки', click: () => blockHostOf(params.linkURL) }
    );
  }

  if (params.srcURL) {
    if (template.length) template.push({ type: 'separator' });
    template.push(
      {
        label: 'Открыть изображение в новой вкладке',
        click: () => tabs.create({ url: params.srcURL, background: true })
      },
      { label: 'Копировать адрес изображения', click: () => clipboard.writeText(params.srcURL) },
      { label: 'Заблокировать домен изображения', click: () => blockHostOf(params.srcURL) }
    );
  }

  if (template.length) template.push({ type: 'separator' });
  template.push(
    { label: 'Назад', enabled: tab.canGoBack, click: () => tabs.goBack(tabId) },
    { label: 'Обновить', click: () => tabs.reload(tabId) },
    { type: 'separator' },
    {
      label: 'Заблокировать элемент на странице',
      enabled: !internal,
      click: () => startElementPicker(tabId)
    },
    {
      label: adblock.isWhitelisted(hostnameOf(tab.url))
        ? 'Включить блокировку на этом сайте'
        : 'Отключить блокировку на этом сайте',
      enabled: !internal,
      click: () => toggleSiteForActiveTab()
    },
    { type: 'separator' },
    {
      label: 'Проверить элемент',
      click: () => {
        try {
          wc.inspectElement(params.x || 0, params.y || 0);
        } catch {
          toggleTabDevTools(tabId);
        }
      }
    },
    { label: 'Инструменты разработчика', click: () => toggleTabDevTools(tabId) }
  );

  Menu.buildFromTemplate(template).popup({ window: mainWindow });
  return true;
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(event, ...args));

  // ── Вкладки и навигация ──
  handle('tab:create', (_e, { url, background } = {}) => tabs.create({ url, background }).id);
  handle('tab:close', (_e, id) => tabs.close(id === undefined ? tabs.activeId : id));
  handle('tab:close-others', (_e, id) => {
    tabs.closeOthers(id === undefined ? tabs.activeId : id);
    return true;
  });
  handle('tab:close-right', (_e, id) => {
    tabs.closeToRight(id === undefined ? tabs.activeId : id);
    return true;
  });
  handle('tab:reopen', () => {
    const tab = tabs.reopenClosed();
    return tab ? tab.id : null;
  });
  handle('tab:context-menu', (event, id) => showTabContextMenu(event, id));
  handle('tab:devtools', (_e, id) => {
    toggleTabDevTools(id === undefined ? tabs.activeId : id);
    return true;
  });
  handle('tab:zoom', (_e, { id, delta } = {}) => tabs.setZoom(id || tabs.activeId, delta || 0));
  handle('tab:zoom-reset', (_e, id) => tabs.resetZoom(id || tabs.activeId));
  handle('tab:activate', (_e, id) => tabs.activate(id === undefined ? tabs.activeId : id));
  handle('tab:reorder', (_e, { from, to }) => tabs.reorder(from, to));
  handle('tab:duplicate', (_e, id) => tabs.duplicate(id === undefined ? tabs.activeId : id));
  handle('tab:navigate', (_e, { id, input }) => tabs.navigate(id || tabs.activeId, input));
  handle('tab:back', (_e, id) => tabs.goBack(id || tabs.activeId));
  handle('tab:forward', (_e, id) => tabs.goForward(id || tabs.activeId));
  handle('tab:reload', (_e, { id, ignoreCache } = {}) => tabs.reload(id || tabs.activeId, { ignoreCache }));
  handle('tab:stop', (_e, id) => tabs.stop(id || tabs.activeId));
  handle('tab:home', (_e, id) => tabs.goHome(id || tabs.activeId));
  handle('tab:cycle', (_e, direction) => cycleTab(direction));

  // ── Состояние ──
  handle('state:get', () => tabs.getState());
  handle('app:info', () => appInfo());

  // ── Адресная строка и подсказки ──
  handle('search:url', (_e, { query }) => {
    const s = settings.settings;
    return toNavigationUrl(query, s.searchEngine, s.safeSearch);
  });
  handle('search:suggest', (_e, { query }) => getSuggestions(query));
}

function appInfo() {
  return {
    name: APP_NAME,
    shortName: APP_SHORT_NAME,
    tagline: APP_TAGLINE,
    version: VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    searchEngines: Object.values(SEARCH_ENGINES),
    settings: settings.settings,
    adblock: {
      rules: adblock.rulesCount,
      enabled: adblock.enabled,
      blockedTotal: adblock.blockedTotal,
      listName: adblock.lastListName
    },
    filtersDir: app.getPath('userData') + path.sep + 'filters',
    userData: app.getPath('userData'),
    // Разрядность и канал обновлений: на странице «О браузере» видно, какая
    // сборка установлена и откуда она ждёт обновления.
    arch: process.arch,
    packaged: app.isPackaged,
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
    updateChannel: channelForArch(),
    update: updater ? updater.getState() : null,
    passwords: {
      count: passwords ? passwords.count : 0,
      secure: passwords ? passwords.secure : false
    }
  };
}

/** Локальные (закладки/история) + удалённые (DuckDuckGo) подсказки */
async function getSuggestions(query) {
  const q = String(query || '').trim();
  const local = [];
  if (!q) return { local, remote: [] };

  for (const b of bookmarks.list()) {
    if (`${b.title} ${b.url}`.toLowerCase().includes(q.toLowerCase())) {
      local.push({ type: 'bookmark', title: b.title, url: b.url });
    }
  }
  for (const h of history.search(q, 6)) {
    if (!local.some((l) => l.url === h.url)) {
      local.push({ type: 'history', title: h.title || h.url, url: h.url });
    }
  }

  let remote = [];
  const engine = SEARCH_ENGINES[settings.settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
  try {
    const { net } = require('electron');
    const url = engine.suggestUrl.replace('%s', encodeURIComponent(q));
    const res = await net.fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    remote = (data || [])
      .map((item) => (typeof item === 'string' ? item : item && item.phrase))
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    remote = [];
  }
  return { local: local.slice(0, 8), remote };
}

/** Настройки, блокировщик, история, закладки, поиск на странице */
function registerIpcExtras() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(event, ...args));

  // ── Настройки ──
  handle('settings:get', () => settings.settings);
  handle('settings:set', (_e, patch) => {
    settings.setMany(patch || {});
    if ('adblockEnabled' in (patch || {})) setAdblockEnabled(!!patch.adblockEnabled);
    send('settings:changed', settings.settings);
    tabs.emitState();
    return settings.settings;
  });
  handle('settings:reset', () => {
    const { DEFAULT_SETTINGS } = require('../shared/constants');
    settings.setMany({ ...DEFAULT_SETTINGS });
    setAdblockEnabled(DEFAULT_SETTINGS.adblockEnabled);
    send('settings:changed', settings.settings);
    tabs.emitState();
    return settings.settings;
  });

  // ── Блокировщик ──
  handle('adblock:stats', () => adblock.getStats());
  handle('adblock:set', (_e, enabled) => {
    setAdblockEnabled(!!enabled);
    return adblock.getStats();
  });
  handle('adblock:reset-stats', () => {
    adblock.resetStats();
    tabs.emitState();
    return adblock.getStats();
  });
  handle('adblock:add-rule', (_e, rule) => {
    const res = addUserRule(rule);
    return { added: res.added, rules: res.rules };
  });
  handle('adblock:reload-page', (_e, id) => tabs.reload(id || tabs.activeId));

  // ── Свои правила, белый список сайтов и пикер элементов ──
  handle('adblock:user-rules', () => readUserRules());
  handle('adblock:remove-rule', (_e, rule) => {
    const text = String(rule || '').trim();
    if (!text) return { removed: false, rules: adblock.rulesCount };
    writeUserRules(readUserRules().filter((r) => r !== text));
    reloadFilterLists();
    return { removed: true, rules: adblock.rulesCount };
  });
  handle('adblock:site-state', () => {
    const tab = tabs.active;
    const host = tab ? hostnameOf(tab.url) : '';
    return {
      host,
      internal: !!(tab && isInternalUrl(tab.url)),
      disabled: !!(host && adblock.isWhitelisted(host)),
      whitelist: adblock.listWhitelist()
    };
  });
  handle('adblock:toggle-site', () => toggleSiteForActiveTab());
  handle('adblock:pick-element', () => startElementPicker(tabs.activeId));
  handle('adblock:pick', (event, { url, selector } = {}) => {
    // Принимаем только от той страницы, с которой пришёл запрос
    if (!sameHost(senderHosts(event), url)) return { added: 0, rules: adblock.rulesCount };
    return addCosmeticRule(url, selector);
  });
  handle('adblock:update-lists', async () => {
    const { net } = require('electron');
    const results = await downloadFilterLists(app.getPath('userData'), async (url) => {
      const res = await net.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    reloadFilterLists();
    return { results, rules: adblock.rulesCount };
  });

  // ── Меню-«гамбургер» и отступы UI ──
  // Меню показывается нативно (см. buildAppMenu), а отступы нужны, чтобы
  // выпадающие списки UI и боковая панель не оказались под вкладкой.
  handle('ui:app-menu', (_e, { x = 0, y = 0 } = {}) => {
    if (!mainWindow) return false;
    const menu = buildAppMenu();
    menu.popup({
      window: mainWindow,
      x: Math.max(0, Math.round(Number(x) || 0)),
      y: Math.max(0, Math.round(Number(y) || 0))
    });
    return true;
  });
  handle('ui:set-insets', (_e, patch) => {
    if (!tabs) return false;
    return tabs.setInsets(patch || {});
  });
  // Состав меню без его показа — используется тестами и диагностикой
  handle('ui:app-menu-items', () => collectMenuLabels(buildAppMenu()));

  // ── История ──
  handle('history:list', (_e, { query, limit } = {}) => {
    if (query) return history.search(query, limit || 50);
    return history.all().slice(-(limit || 300)).reverse();
  });
  handle('history:clear', () => {
    history.clear();
    return true;
  });
  handle('history:remove', (_e, url) => {
    history.remove(url);
    return true;
  });

  // ── Закладки ──
  handle('bookmarks:list', () => bookmarks.list());
  handle('bookmarks:toggle', (_e, payload) => bookmarks.toggle(payload || {}));
  handle('bookmarks:remove', (_e, url) => bookmarks.remove(url));
  handle('bookmarks:has', (_e, url) => bookmarks.has(url));
  handle('bookmarks:open-all', () => {
    for (const b of bookmarks.list()) tabs.create({ url: b.url, background: true });
    return true;
  });

  // ── Поиск на странице ──
  handle('find:start', (_e, { text, forward = true, findNext = false }) => {
    const wc = tabs.activeWebContents;
    if (!wc) return { matches: 0 };
    findInPageQuery = String(text || '');
    if (!findInPageQuery) {
      wc.stopFindInPage('clearSelection');
      return { matches: 0 };
    }
    return { matches: wc.findInPage(findInPageQuery, { forward, findNext }) };
  });
  handle('find:stop', () => {
    const wc = tabs.activeWebContents;
    if (wc) wc.stopFindInPage('clearSelection');
    findInPageQuery = '';
    return true;
  });

  // ── Прочее ──
  handle('shell:open-external', (_e, url) => shell.openExternal(url));
  handle('window:minimize', () => mainWindow && mainWindow.minimize());
  handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  handle('window:close', () => mainWindow && mainWindow.close());
  handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  handle('dialog:confirm', async (_e, { title, message } = {}) => {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Отмена', 'Да'],
      defaultId: 1,
      cancelId: 0,
      title: title || APP_NAME,
      message: message || 'Вы уверены?'
    });
    return res.response === 1;
  });
}

/* ─────────────────────────── Диагностика ─────────────────────────── */

/**
 * `--kitsune-diagnostics` — служебный режим: окно не открывается, отчёт о
 * сборке пишется в JSON-файл, приложение сразу выходит.
 *
 * Зачем: собранный Electron — GUI-приложение, его stdout в консоли Windows не
 * виден. А проверить у конкретного установленного билда нужно многое: версию
 * движка, разрядность, канал обновлений, число загруженных правил блокировки.
 * Отчёт используется сборщиком установщиков и дымовым тестом.
 */
function isDiagnosticsRun() {
  return process.argv.some(
    (arg) => arg === '--kitsune-diagnostics' || arg.startsWith('--kitsune-diagnostics-out=')
  );
}

/** Куда писать отчёт: `--kitsune-diagnostics-out=<файл>` или %TEMP% */
function diagnosticsOutPath() {
  const arg = process.argv.find((a) => a.startsWith('--kitsune-diagnostics-out='));
  const file = arg ? arg.slice('--kitsune-diagnostics-out='.length) : '';
  return file || path.join(app.getPath('temp'), 'kitsune-diagnostics.json');
}

function runDiagnostics() {
  let filterRules = null;
  try {
    const { AdBlocker } = require('./adblock');
    const blocker = new AdBlocker({ enabled: true });
    loadFilterLists(blocker, {
      filtersDir: path.join(__dirname, 'filters'),
      userDataDir: app.getPath('userData'),
      log: false
    });
    filterRules = blocker.rulesCount;
  } catch (err) {
    filterRules = `ошибка: ${err.message}`;
  }

  const report = {
    name: APP_NAME,
    version: VERSION,
    arch: process.arch,
    platform: process.platform,
    packaged: app.isPackaged,
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
    updateChannel: channelForArch(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    filterRules,
    time: new Date().toISOString()
  };

  const json = JSON.stringify(report, null, 2);
  const out = diagnosticsOutPath();
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json, 'utf8');
  } catch (err) {
    console.error('[Kitsune] Не удалось записать отчёт диагностики:', err.message);
  }
  process.stdout.write(json + '\n');
  return report;
}

/* ────────────────────────── Запуск приложения ────────────────────────── */

function bootstrap() {
  settings = new SettingsStore();
  history = new HistoryStore();
  bookmarks = new BookmarkStore();
  passwords = new PasswordStore();

  adblock = createAdBlocker({
    enabled: settings.get('adblockEnabled', true),
    filtersDir: path.join(__dirname, 'filters'),
    userDataDir: app.getPath('userData')
  });
  // Сайты, где блокировка выключена вручную, помним между запусками
  adblock.setWhitelist(readWhitelist());

  setupSession();
  createWindow();

  tabs = new TabManager(mainWindow, {
    settings,
    adblock,
    history,
    bookmarks,
    send,
    onShortcut: handleShortcut,
    onContextMenu: showPageContextMenu,
    onPageReady: applyCosmetics
  });

  vault = createPasswordVault({
    store: passwords,
    settings,
    send,
    tabs,
    dialog,
    getWindow: () => mainWindow
  });

  registerIpc();
  registerIpcExtras();
  vault.registerIpc(ipcMain);

  // Автообновление из GitHub Releases. Проверка запускается с задержкой,
  // чтобы не отнимать сеть и диск у старта браузера.
  updater = createUpdater({ send, settings });
  updater.registerIpc(ipcMain);
  updater.start();

  const lastSession = settings.get('lastSession', []);
  const restored = settings.get('restoreTabs', true) && tabs.restoreSession(lastSession);
  if (!restored) tabs.create({ url: settings.get('homePage', 'kitsune://home') });

  mainWindow.webContents.on('did-finish-load', () => {
    sessionRestored = true;
    tabs.emitStateNow();
  });
}

app.setName(APP_NAME);

// В режиме диагностики единственный экземпляр не нужен: окно не создаётся,
// а запущенный экземпляр браузера не должен мешать проверке собранного файла.
const gotLock = isDiagnosticsRun() ? true : app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      tabs.create();
    }
  });

  app.whenReady().then(() => {
    // Служебный режим проверки собранного приложения — без окна
    if (isDiagnosticsRun()) {
      try {
        runDiagnostics();
        app.exit(0);
      } catch (err) {
        console.error('[Kitsune] Диагностика не удалась:', err.message);
        app.exit(1);
      }
      return;
    }

    bootstrap();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) bootstrap();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (settings && tabs && settings.get('restoreTabs', true)) {
      settings.set('lastSession', tabs.sessionUrls());
    }
    // История и пароли пишутся с задержкой — при выходе сбрасываем на диск
    if (history) history.flush();
    if (passwords) passwords.flush();
  });
}

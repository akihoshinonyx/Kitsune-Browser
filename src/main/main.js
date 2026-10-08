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

const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, clipboard, net } = require('electron');
const path = require('path');
const fs = require('fs');

const { APP_NAME, APP_SHORT_NAME, APP_TAGLINE, SEARCH_ENGINES } = require('../shared/constants');
const { VERSION } = require('../shared/version');
const { SettingsStore, HistoryStore, BookmarkStore, PasswordStore } = require('./store');
const { createAdBlocker, loadFilterLists, downloadFilterLists, USER_FILTER_FILE } = require('./filters');
const { senderHosts, sameHost, isTrustedSender } = require('./ipc-guards');
const { createUpdater, channelForArch, RELEASES_PAGE } = require('./updater');
const { createDownloads } = require('./downloads');
const { createExtensionManager } = require('./extensions');
const { createPasswordVault } = require('./passwords');
const { TabManager, CHROME_HEIGHT } = require('./tabs');
const { toNavigationUrl, isInternalUrl, isExternalAppUrl } = require('./url-utils');
const { hostnameOf } = require('./adblock');
const { searchUrlFor } = require('./url-utils');
const { bookmarksToHtml, parseBookmarksHtml, historyToJson, parseHistoryJson, MAX_IMPORT_BYTES } = require('./data-transfer');

const SESSION_PARTITION = 'persist:kitsune';

let mainWindow = null;
let tabs = null;
const windowContexts = new Map();
let adblock = null;
let settings = null;
let history = null;
let bookmarks = null;
let passwords = null;
let vault = null;
let updater = null;
let downloads = null;
let extensions = null;
let quitting = false;
let sessionRestored = false;
let findInPageQuery = '';
let startupMarker = '';

function writeMainLog(level, message) {
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'main.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8');
  } catch {
    /* журнал не должен мешать запуску */
  }
}

/** Делает копию пользовательского файла перед импортом новых данных. */
function backupDataFile(fileName) {
  const source = path.join(app.getPath('userData'), fileName);
  if (!fs.existsSync(source)) return '';
  const target = `${source}.backup-${Date.now()}`;
  try {
    fs.copyFileSync(source, target);
    return target;
  } catch (err) {
    writeMainLog('WARN', `Не удалось создать резервную копию ${fileName}: ${err.message}`);
    return null;
  }
}

function readImportFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error('Не удалось прочитать выбранный файл');
  }
  if (!stat.isFile()) throw new Error('Выбранный путь не является файлом');
  if (stat.size > MAX_IMPORT_BYTES) {
    throw new Error(`Файл слишком большой. Максимальный размер импорта: ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} МБ`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function prepareStartupRecovery() {
  startupMarker = path.join(app.getPath('userData'), 'startup.lock');
  const recovered = fs.existsSync(startupMarker);
  if (recovered) writeMainLog('WARN', 'Обнаружено нештатное завершение; сессия пропущена.');
  try {
    fs.writeFileSync(startupMarker, String(Date.now()), 'utf8');
  } catch {
    /* безопасный старт остаётся доступным и без marker-файла */
  }
  return recovered;
}

process.on('uncaughtException', (err) => {
  writeMainLog('ERROR', `uncaughtException: ${err && err.stack ? err.stack : err}`);
  // После необработанного исключения состояние main-процесса ненадёжно.
  // Завершаемся, оставляя startup.lock для безопасного следующего запуска.
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  writeMainLog('ERROR', `unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

// Разрешения «только в этот раз» живут только до закрытия вкладки.
const temporarySitePermissions = new Map();
const pendingPermissionRequests = new Map();
const permissionPromptRequests = new Map();
let nextPermissionPromptId = 1;
const SENSITIVE_PERMISSIONS = new Set(['geolocation', 'media', 'microphone', 'camera']);

function permissionOrigin(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function mediaPermissionNames(details) {
  const types = details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  const names = [];
  if (!types.length || types.includes('audio')) names.push('microphone');
  if (!types.length || types.includes('video')) names.push('camera');
  return names;
}

function permissionNames(permission, details) {
  if (permission === 'media') return mediaPermissionNames(details);
  if (permission === 'microphone') return ['microphone'];
  if (permission === 'camera') return ['camera'];
  return [permission];
}

function permissionTitle(names) {
  return names.map((name) => ({
    geolocation: 'геолокации',
    microphone: 'микрофону',
    camera: 'вебкамере'
  }[name] || name)).join(' и ');
}

function permissionSetFor(map, origin) {
  return new Set(Array.isArray(map && map[origin]) ? map[origin] : []);
}

function hasSitePermission(origin, names, wcId) {
  const permanent = permissionSetFor(settings.get('sitePermissions', {}), origin);
  const temporary = temporarySitePermissions.get(wcId) || new Set();
  return names.every((name) => permanent.has(name) || temporary.has(`${origin}:${name}`));
}

function rememberSitePermission(origin, names, wcId, permanent) {
  if (permanent) {
    const grants = settings.get('sitePermissions', {});
    const current = permissionSetFor(grants, origin);
    names.forEach((name) => current.add(name));
    grants[origin] = [...current].sort();
    settings.set('sitePermissions', grants);
    return;
  }
  const current = temporarySitePermissions.get(wcId) || new Set();
  names.forEach((name) => current.add(`${origin}:${name}`));
  temporarySitePermissions.set(wcId, current);
}

async function askSitePermission(wc, origin, names) {
  const key = `${wc.id}:${origin}:${names.slice().sort().join(',')}`;
  if (pendingPermissionRequests.has(key)) return pendingPermissionRequests.get(key);
  if (typeof wc.once === 'function') {
    wc.once('destroyed', () => temporarySitePermissions.delete(wc.id));
  }
  const request = (async () => {
    if (!mainWindow || mainWindow.isDestroyed() || wc.isDestroyed()) return 'deny';
    const site = new URL(origin).hostname;
    const owner = BrowserWindow.fromWebContents(wc) || [...windowContexts.values()]
      .find((context) => context.tabs && [...context.tabs.tabs.values()]
        .some((tab) => tab.view.webContents.id === wc.id))?.window || mainWindow;
    return showPermissionPrompt(owner, site, names);
  })().finally(() => pendingPermissionRequests.delete(key));
  pendingPermissionRequests.set(key, request);
  return request;
}

function showPermissionPrompt(owner, site, names) {
  return new Promise((resolve) => {
    const id = String(nextPermissionPromptId++);
    const prompt = new BrowserWindow({
      width: 470,
      height: 350,
      minWidth: 470,
      minHeight: 350,
      maxWidth: 470,
      maxHeight: 350,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: !!(owner && !owner.isDestroyed()),
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      backgroundColor: '#14161a',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'permission-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    permissionPromptRequests.set(id, { prompt, resolve });
    const finish = (decision) => {
      const pending = permissionPromptRequests.get(id);
      if (!pending) return;
      permissionPromptRequests.delete(id);
      if (!prompt.isDestroyed()) prompt.close();
      resolve(decision);
    };
    prompt.on('closed', () => finish('deny'));
    prompt.webContents.once('did-finish-load', () => {
      if (prompt.isDestroyed()) return;
      prompt.webContents.send('permission:show', { id, site, permissions: names });
      prompt.show();
      prompt.focus();
    });
    prompt.loadFile(path.join(__dirname, '..', 'renderer', 'permission.html'));
  });
}

/** Отправка события в UI-слой */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function contextForEvent(event) {
  for (const context of windowContexts.values()) {
    if (context.window && !context.window.isDestroyed() && context.window.webContents.id === event.sender.id) {
      return context;
    }
    if ([...context.tabs.tabs.values()].some((tab) => tab.view.webContents.id === event.sender.id)) return context;
  }
  return { window: mainWindow, tabs, private: false, send };
}

function privateContextFor(event) {
  const context = contextForEvent(event);
  return context.private ? context : null;
}

/* ────────────────────────── Настройка сессии ────────────────────────── */

function setupSession() {
  const ses = session.fromPartition(SESSION_PARTITION);
  downloads = createDownloads({ send });
  configureSession(ses);
  downloads.attach(ses);
}

/** Настраивает сетевые фильтры и разрешения для любой оконной сессии. */
function configureSession(ses, { privateMode = false } = {}) {

  // ── Блокировка рекламы и трекеров ──
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      if (!adblock.enabled) return callback({ cancel: false });
      if (isInternalUrl(details.url)) return callback({ cancel: false });

      const tabForRequest = findTabByWebContentsId(details.webContentsId, ses);
      const tabUrl = tabForRequest ? tabForRequest.url : '';
      const tabId = tabForRequest ? tabForRequest.id : -1;

      // YouTube: рекламные хосты блокируем всегда — даже если сайт в
      // белом списке. Косметические правила (скрытие баннеров) на
      // исключённых сайтах не работают, а видео-реклама без них
      // продолжает грузиться.
      if (isYouTubeAdUrl(details.url, tabUrl)) {
        adblock.recordBlocked({ tabId, url: details.url, type: details.resourceType });
        if (tabForRequest) tabForRequest.blocked = adblock.statsForTab(tabId);
        notifyBlockedCount(tabForRequest);
        return callback({ cancel: true });
      }

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

  // ── Разрешения сайтов ──
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    const automatic = ['fullscreen', 'clipboard-sanitized-write'];
    if (automatic.includes(permission)) return callback(true);
    if (!SENSITIVE_PERMISSIONS.has(permission)) return callback(false);

    const origin = permissionOrigin((details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()));
    const names = permissionNames(permission, details);
    if (!origin || !names.length) return callback(false);
    if (!privateMode && hasSitePermission(origin, names, wc.id)) return callback(true);

    const decision = await askSitePermission(wc, origin, names);
    if (decision === 'once' || decision === 'always') {
      if (!privateMode) rememberSitePermission(origin, names, wc.id, decision === 'always');
      return callback(true);
    }
    return callback(false);
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (!SENSITIVE_PERMISSIONS.has(permission)) return ['fullscreen', 'clipboard-sanitized-write'].includes(permission);
    const names = permissionNames(permission, details);
    return !privateMode && !!requestingOrigin && hasSitePermission(requestingOrigin, names, wc.id);
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

function findTabByWebContentsId(webContentsId, sourceSession) {
  if (webContentsId === undefined || webContentsId === null) return null;
  const cached = tabByWcId.get(`${sourceSession && sourceSession.getStoragePath ? sourceSession.getStoragePath() : ''}:${webContentsId}`);
  if (cached && cached.manager.tabs.get(cached.id) === cached) return cached;

  const managers = [{ manager: tabs }, ...[...windowContexts.values()].map((context) => ({ manager: context.tabs }))];
  for (const { manager } of managers) {
    if (!manager) continue;
    for (const tab of manager.tabs.values()) {
      const wc = tab.view.webContents;
      if (wc && wc.id === webContentsId && (!sourceSession || wc.session === sourceSession)) {
        const key = `${sourceSession && sourceSession.getStoragePath ? sourceSession.getStoragePath() : ''}:${webContentsId}`;
        tab.manager = manager;
        tabByWcId.set(key, tab);
        return tab;
      }
    }
  }
  tabByWcId.delete(`${sourceSession && sourceSession.getStoragePath ? sourceSession.getStoragePath() : ''}:${webContentsId}`);
  return null;
}

/**
 * YouTube: рекламные хосты блокируем всегда — даже если сайт в белом списке.
 *
 * Косметические правила (скрытие баннеров) на исключённых сайтах не работают,
 * а видео-реклама без них продолжает грузиться. Поэтому для YouTube-страниц
 * проверяем URL запроса на известные рекламные паттерны и блокируем.
 */
const YOUTUBE_AD_HOSTS = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagservices.com',
  'adservice.google.com',
  'pagead2.googlesyndication.com',
  'partner.googleadservices.com',
  'pubads.g.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'static.doubleclick.net',
  'ad.doubleclick.net',
  'stats.g.doubleclick.net',
  'ads.youtube.com',
  'youtube-ad-ssl.googlevideo.com',
  'youtube-ads.g.doubleclick.net'
]);

const YOUTUBE_AD_PATHS = [
  '/ad_status.js',
  '/pagead/js/adsbygoogle.js',
  '/tag/js/gpt.js',
  '/analytics.js',
  '/ga.js',
  '/gtag/js',
  '/instream/ad_status.js'
];

function isYouTubeAdUrl(url, tabUrl) {
  if (!url || !tabUrl) return false;
  const tabHost = hostnameOf(tabUrl);
  if (!tabHost || !/(^|\.)youtube\.com$/.test(tabHost)) return false;

  const host = hostnameOf(url);
  if (!host) return false;

  // Рекламный хост — блокируем
  if (YOUTUBE_AD_HOSTS.has(host)) return true;
  for (const adHost of YOUTUBE_AD_HOSTS) {
    if (host.endsWith('.' + adHost)) return true;
  }

  // Рекламный путь на самом YouTube — блокируем
  const lowerUrl = url.toLowerCase();
  for (const path of YOUTUBE_AD_PATHS) {
    if (lowerUrl.includes(path)) return true;
  }

  return false;
}

/**
 * Сообщает UI счётчик заблокированного на активной вкладке.
 *
 * На рекламном сайте таких запросов десятки в секунду — отправляем не чаще
 * 5 раз в секунду, иначе UI-слой захлёбывается перерисовкой.
 */
let blockedNotifyTimer = null;

function notifyBlockedCount(tab) {
  const manager = tab && tab.manager;
  if (!tab || !manager || tab.id !== manager.activeId) return;
  if (blockedNotifyTimer) return;
  blockedNotifyTimer = setTimeout(() => {
    blockedNotifyTimer = null;
    if (!manager) return;
    const active = manager.active;
    if (!active) return;
    manager.ctx.send('adblock:count', {
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
  if (ctrl && shift && key === 'p') return run(() => createPrivateWindow());
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
  if (ctrl && key === 'j') return run(() => openInternal('kitsune://downloads'));
  if (ctrl && key === 'd') return run(() => send('ui:toggle-bookmark'));

  // ── Масштаб страницы ──
  if (ctrl && (key === '+' || key === '=' || key === 'add')) return run(() => tabs.setZoom(id, 0.5));
  if (ctrl && (key === '-' || key === '_' || key === 'subtract')) return run(() => tabs.setZoom(id, -0.5));
  if (ctrl && key === '0') return run(() => tabs.resetZoom(id));

  // ── Видео в отдельном окне (как в Firefox: Ctrl+Shift+]) ──
  if (ctrl && shift && (key === ']' || key === 'ъ')) return run(() => togglePictureInPicture(id));

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
    // Кастомные кнопки в полосе вкладок заменяют стандартные Windows-кнопки.
    frame: process.platform !== 'win32',
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

/** Создаёт отдельное окно без постоянного профиля и без доступа к профилю. */
function createPrivateWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    title: `${APP_NAME} — Приватное окно`, frame: process.platform !== 'win32',
    backgroundColor: '#14161a', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  const partition = `kitsune-private-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ses = session.fromPartition(partition);
  configureSession(ses, { privateMode: true });
  ses.on('will-download', (_event, item) => item.cancel());
  const context = { window: win, private: true, tabs: null, send: (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  } };
  context.send('app:info', appInfo(true));
  context.tabs = new TabManager(win, {
    settings, adblock, bookmarks, send: context.send, session: ses, private: true,
    onShortcut: (input, id) => handleShortcutFor(context, input, id),
    onPageReady: applyCosmetics
  });
  windowContexts.set(win.webContents.id, context);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('ready-to-show', () => win.show());
  win.on('close', () => { context.tabs.destroyAll(); });
  const windowId = win.webContents.id;
  win.webContents.on('before-input-event', (event, input) => {
    if (handleShortcutFor(context, input)) event.preventDefault();
  });
  win.on('closed', () => {
    windowContexts.delete(windowId);
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
  });
  context.tabs.create({ url: settings.get('homePage', 'kitsune://home') });
  return win;
}

function handleShortcutFor(context, input, tabId) {
  if (!input || input.type !== 'keyDown') return false;
  const t = context.tabs;
  const key = String(input.key || '').toLowerCase();
  const ctrl = input.control || input.meta;
  const id = tabId === undefined ? t.activeId : tabId;
  if (ctrl && input.shift && key === 'p') createPrivateWindow();
  else if (ctrl && key === 't') t.create();
  else if (ctrl && key === 'w') t.close(id);
  else if (ctrl && key === 'r') t.reload(id, { ignoreCache: !!input.shift });
  else if (ctrl && key === 'l') context.send('ui:focus-address');
  else if (ctrl && key === 'f') context.send('ui:focus-find');
  else return false;
  return true;
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
        { label: 'Закладки', click: () => focusUi('ui:open-bookmarks') },
        { label: 'Загрузки   (Ctrl+J)', click: () => openInternal('kitsune://downloads') },
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
    { label: 'Новое приватное окно   (Ctrl+Shift+P)', click: () => createPrivateWindow() },
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
    { label: 'Закладки', click: () => focusUi('ui:open-bookmarks') },
    { label: 'Загрузки   (Ctrl+J)', click: () => openInternal('kitsune://downloads') },
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
      label: 'Смотреть видео в отдельном окне   (Ctrl+Shift+])',
      enabled: hasTabs,
      click: () => togglePictureInPicture(tabs.activeId)
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

function buildPrivateAppMenu(context) {
  return Menu.buildFromTemplate([
    { label: 'Новое приватное окно   (Ctrl+Shift+P)', click: () => createPrivateWindow() },
    { label: 'Новая вкладка   (Ctrl+T)', click: () => context.tabs.create({ url: settings.get('homePage', 'kitsune://home') }) },
    { type: 'separator' },
    { label: 'Найти на странице   (Ctrl+F)', click: () => context.send('ui:focus-find') },
    { label: `Блокировка рекламы: ${adblock.enabled ? 'включена' : 'выключена'}`, enabled: false },
    { type: 'separator' },
    { label: 'Закрыть окно', click: () => context.window.close() }
  ]);
}

/** Открывает внутреннюю страницу в активной вкладке (или в новой) */
function openInternal(url) {
  if (!tabs) return;
  tabs.create({ url });
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

/* ─────────────── «Смотреть в окне» (picture-in-picture) ─────────────── */

/**
 * Скрипт, который находит видео на странице и переключает его в отдельное
 * окно (или возвращает обратно, если оно уже там).
 *
 * Chromium разрешает requestPictureInPicture() только по действию
 * пользователя, поэтому скрипт выполняется через executeJavaScript с
 * userGesture = true — тогда PiP открывается так же, как по кнопке в плеере.
 */
const PIP_TOGGLE_SCRIPT = `(async () => {
  try {
    if (!document.pictureInPictureEnabled) return { ok: false, reason: 'unsupported' };
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return { ok: true, action: 'exit' };
    }
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return { ok: false, reason: 'no-video' };
    const rank = (v) => {
      const rect = v.getBoundingClientRect();
      const area = Math.min(1, Math.max(0, (rect.width * rect.height) / (1280 * 720)));
      const playing = v.currentTime > 0 && !v.paused && !v.ended && v.readyState > 2;
      return (playing ? 1000 : 0) + area * 100;
    };
    const target = videos.sort((a, b) => rank(b) - rank(a))[0];
    if (target.disablePictureInPicture) return { ok: false, reason: 'disabled' };
    await target.requestPictureInPicture();
    return { ok: true, action: 'enter' };
  } catch (err) {
    return { ok: false, reason: 'error', message: String((err && err.message) || err) };
  }
})();`;

/** Переключает picture-in-picture для вкладки (по умолчанию — активной) */
async function togglePictureInPicture(id) {
  const tab = id !== null && id !== undefined && tabs.tabs.has(id) ? tabs.tabs.get(id) : tabs.active;
  const wc = tab && tab.view.webContents;
  if (!wc || wc.isDestroyed() || isInternalUrl(tab.url)) {
    send('ui:toast', { text: 'На этой странице нет видео' });
    return { ok: false, reason: 'no-video' };
  }
  try {
    const result = await wc.executeJavaScript(PIP_TOGGLE_SCRIPT, true);
    if (result && result.ok) {
      send('ui:toast', {
        text:
          result.action === 'exit'
            ? 'Видео возвращено на страницу'
            : 'Видео открыто в отдельном окне'
      });
      return result;
    }
    send('ui:toast', {
      text:
        result && result.reason === 'disabled'
          ? 'Это видео нельзя показать в отдельном окне'
          : 'На этой странице нет видео'
    });
    return result || { ok: false, reason: 'no-video' };
  } catch (err) {
    console.error('[Kitsune] Picture-in-picture:', err.message);
    send('ui:toast', { text: 'Не удалось открыть видео в отдельном окне' });
    return { ok: false, reason: 'error' };
  }
}

/**
 * Запоминает состояние видео вкладки: по нему UI показывает кнопку
 * «смотреть в окне» (как в Firefox — она появляется только на время
 * воспроизведения). Состояние присылает preload обычных сайтов.
 */
function setTabVideoState(event, state = {}) {
  const tab = findTabByWebContentsId(event.sender.id);
  if (!tab) return false;
  const next = {
    available: !!state.available,
    playing: !!state.playing,
    inPip: !!state.inPip
  };
  const prev = tab.pip || {};
  if (
    prev.available === next.available &&
    prev.playing === next.playing &&
    prev.inPip === next.inPip
  ) {
    return true;
  }
  tab.pip = next;
  tabs.emitState();
  return true;
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
    { label: tab.pinned ? 'Открепить вкладку' : 'Закрепить вкладку', click: () => tabs.togglePinned(tab.id) },
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
    // Для <video>/<audio> подписи «изображение» путали: медиа — не картинка
    const isMedia = params.mediaType === 'video' || params.mediaType === 'audio';
    if (template.length) template.push({ type: 'separator' });
    template.push(
      {
        label: isMedia ? 'Открыть медиа в новой вкладке' : 'Открыть изображение в новой вкладке',
        click: () => tabs.create({ url: params.srcURL, background: true })
      },
      {
        label: isMedia ? 'Копировать адрес медиа' : 'Копировать адрес изображения',
        click: () => clipboard.writeText(params.srcURL)
      },
      {
        label: isMedia ? 'Заблокировать домен медиа' : 'Заблокировать домен изображения',
        click: () => blockHostOf(params.srcURL)
      }
    );
    // Как в Firefox: правый клик по видео → «смотреть в отдельном окне»
    if (params.mediaType === 'video') {
      template.push({
        label: 'Смотреть видео в отдельном окне',
        click: () => togglePictureInPicture(tabId)
      });
    }
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
  ipcMain.on('permission:decision', (event, payload = {}) => {
    const pending = permissionPromptRequests.get(String(payload.id || ''));
    if (!pending || event.sender !== pending.prompt.webContents) return;
    const decision = ['once', 'always', 'deny'].includes(payload.decision) ? payload.decision : 'deny';
    pending.resolve(decision);
    permissionPromptRequests.delete(String(payload.id));
    if (!pending.prompt.isDestroyed()) pending.prompt.close();
  });
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) =>
    isTrustedSender(event) ? fn(event, ...args) : null);

  handle('window:private', () => {
    createPrivateWindow();
    return true;
  });

  // ── Вкладки и навигация ──
  handle('tab:create', (event, { url, background } = {}) => { const c = contextForEvent(event); return c.tabs.create({ url, background }).id; });
  handle('tab:close', (event, id) => { const t = contextForEvent(event).tabs; return t.close(id === undefined ? t.activeId : id); });
  handle('tab:close-others', (event, id) => { const t = contextForEvent(event).tabs;
    t.closeOthers(id === undefined ? t.activeId : id);
    return true;
  });
  handle('tab:close-right', (event, id) => { const t = contextForEvent(event).tabs;
    t.closeToRight(id === undefined ? t.activeId : id);
    return true;
  });
  handle('tab:reopen', (event) => {
    const tab = contextForEvent(event).tabs.reopenClosed();
    return tab ? tab.id : null;
  });
  handle('tab:context-menu', (event, id) => privateContextFor(event) ? false : showTabContextMenu(event, id));
  handle('tab:devtools', (event, id) => {
    const t = contextForEvent(event).tabs;
    const tab = t.tabs.get(id === undefined ? t.activeId : id);
    if (tab) tab.view.webContents.toggleDevTools();
    return true;
  });
  handle('tab:zoom', (event, { id, delta } = {}) => { const t = contextForEvent(event).tabs; return t.setZoom(id || t.activeId, delta || 0); });
  handle('tab:zoom-reset', (event, id) => { const t = contextForEvent(event).tabs; return t.resetZoom(id || t.activeId); });
  handle('tab:activate', (event, id) => { const t = contextForEvent(event).tabs; return t.activate(id === undefined ? t.activeId : id); });
  handle('tab:reorder', (event, { from, to }) => contextForEvent(event).tabs.reorder(from, to));
  handle('tab:duplicate', (event, id) => { const t = contextForEvent(event).tabs; return t.duplicate(id === undefined ? t.activeId : id); });
  handle('tab:toggle-pinned', (event, id) => { const t = contextForEvent(event).tabs; return t.togglePinned(id === undefined ? t.activeId : id); });
  handle('tab:navigate', (event, { id, input }) => { const t = contextForEvent(event).tabs; return t.navigate(id || t.activeId, input); });
  handle('tab:back', (event, id) => { const t = contextForEvent(event).tabs; return t.goBack(id || t.activeId); });
  handle('tab:forward', (event, id) => { const t = contextForEvent(event).tabs; return t.goForward(id || t.activeId); });
  handle('tab:reload', (event, { id, ignoreCache } = {}) => { const t = contextForEvent(event).tabs; return t.reload(id || t.activeId, { ignoreCache }); });
  handle('tab:stop', (event, id) => { const t = contextForEvent(event).tabs; return t.stop(id || t.activeId); });
  handle('tab:home', (event, id) => { const t = contextForEvent(event).tabs; return t.goHome(id || t.activeId); });
  handle('tab:cycle', (event, direction) => { const t = contextForEvent(event).tabs; if (t.order.length < 2) return; const i = t.order.indexOf(t.activeId); t.activate(t.order[(i + direction + t.order.length) % t.order.length]); });

  // ── Состояние ──
  handle('state:get', (event) => contextForEvent(event).tabs.getState());
  handle('app:info', (event) => appInfo(!!privateContextFor(event)));

  // ── Адресная строка и подсказки ──
  handle('search:url', (_e, { query }) => {
    const s = settings.settings;
    return toNavigationUrl(query, s.searchEngine, s.safeSearch);
  });
  handle('search:suggest', (event, { query }) => privateContextFor(event) ? { local: [], remote: [] } : getSuggestions(query));
}

function appInfo(privateMode = false) {
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
    sitePermissions: privateMode ? [] : listSitePermissions(),
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
    extensions: privateMode || !extensions ? [] : extensions.list(),
    passwords: privateMode ? { count: 0, secure: false } : {
      count: passwords ? passwords.count : 0,
      secure: passwords ? passwords.secure : false
    },
    defaultBrowser: defaultBrowserState()
  };
}

/** Проверяет назначение HTTP: Windows может менять его только через системный UI. */
function defaultBrowserState() {
  if (process.platform !== 'win32') {
    return { supported: false, current: false, reason: 'Windows only' };
  }
  try {
    const application = app.getApplicationNameForProtocol('http:');
    return { supported: true, current: application === APP_NAME, application: application || '' };
  } catch {
    return { supported: true, current: false, application: '' };
  }
}

function openIncomingUrls(args) {
  const urls = (args || []).map((value) => String(value)).filter((value) =>
    /^https?:\/\//i.test(value) || isExternalAppUrl(value)
  );
  if (!urls.length || !tabs) return false;
  for (const url of urls) {
    if (isExternalAppUrl(url)) Promise.resolve(shell.openExternal(url)).catch((err) =>
      send('ui:toast', { text: `Не удалось открыть приложение: ${err.message}` }));
    else tabs.create({ url });
  }
  return true;
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
    // Подсказки не должны блокировать адресную строку при недоступной сети.
    // AbortController поддерживается Electron/Chromium и также корректно
    // отменяет запрос при медленном или зависшем DNS.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    let res;
    try {
      res = await net.fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res || !res.ok) return { local: local.slice(0, 8), remote: [] };
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
  const pageChannels = new Set(['adblock:pick', 'pip:video-state']);
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    const privateWindow = !!privateContextFor(event);
    const allowed = new Set(['settings:get', 'adblock:stats', 'ui:set-insets', 'find:start', 'find:stop',
      'window:minimize', 'window:maximize', 'window:close']);
    if (privateWindow && !allowed.has(channel)) return null;
    return (isTrustedSender(event) || pageChannels.has(channel)) ? fn(event, ...args) : null;
  });

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
  handle('permissions:list', () => listSitePermissions());
  handle('permissions:revoke', (_e, origin) => {
    const grants = settings.get('sitePermissions', {});
    if (!origin || typeof origin !== 'string') return listSitePermissions();
    delete grants[origin];
    settings.set('sitePermissions', grants);
    send('permissions:changed', listSitePermissions());
    return listSitePermissions();
  });
  handle('permissions:clear', () => {
    settings.set('sitePermissions', {});
    send('permissions:changed', []);
    return [];
  });

  // ── Блокировщик ──
  // ── Расширения Firefox WebExtension ──
  handle('extensions:list', () => extensions ? extensions.list() : []);
  handle('extensions:install-file', () => extensions.installFromFile(session.fromPartition(SESSION_PARTITION)));
  handle('extensions:install-url', (_e, url) => extensions.installFromUrl(url, session.fromPartition(SESSION_PARTITION)));
  handle('extensions:remove', (_e, id) => extensions.remove(id, session.fromPartition(SESSION_PARTITION)));

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

  // ── «Смотреть в окне» (picture-in-picture) ──
  // Состояние видео принимаем только от вкладок браузера: обычный сайт не
  // может «включить» кнопку PiP у чужой страницы (findTabByWebContentsId
  // сверяет webContents отправителя с известными вкладками).
  handle('pip:video-state', (event, state) => setTabVideoState(event, state || {}));
  // Переключение — привилегированное действие, доступно только UI браузера
  handle('pip:toggle', (event, id) => {
    if (!isTrustedSender(event)) return { ok: false, reason: 'forbidden' };
    return togglePictureInPicture(id);
  });

  // ── Меню-«гамбургер» и отступы UI ──
  // Меню показывается нативно (см. buildAppMenu), а отступы нужны, чтобы
  // выпадающие списки UI и боковая панель не оказались под вкладкой.
  handle('ui:app-menu', (event, { x = 0, y = 0 } = {}) => {
    const context = contextForEvent(event);
    if (!context.window || context.window.isDestroyed()) return false;
    const menu = context.private ? buildPrivateAppMenu(context) : buildAppMenu();
    menu.popup({
      window: context.window,
      x: Math.max(0, Math.round(Number(x) || 0)),
      y: Math.max(0, Math.round(Number(y) || 0))
    });
    return true;
  });
  handle('ui:set-insets', (event, patch) => {
    const context = contextForEvent(event);
    return context.tabs ? context.tabs.setInsets(patch || {}) : false;
  });
  // Состав меню без его показа — используется тестами и диагностикой
  handle('ui:app-menu-items', (event) => {
    const context = contextForEvent(event);
    return collectMenuLabels(context.private ? buildPrivateAppMenu(context) : buildAppMenu());
  });

  // ── История ──
  handle('history:list', (event, { query, limit } = {}) => {
    if (!isTrustedSender(event)) return [];
    if (query) return history.search(query, limit || 50);
    return history.all().slice(-(limit || 300)).reverse();
  });
  handle('history:clear', (event) => {
    if (!isTrustedSender(event)) return false;
    history.clear();
    return true;
  });
  handle('history:remove', (event, url) => {
    if (!isTrustedSender(event)) return false;
    history.remove(url);
    return true;
  });
  handle('history:export', async (event) => {
    if (!isTrustedSender(event)) return { canceled: true, reason: 'forbidden' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт истории',
      defaultPath: path.join(app.getPath('documents'), 'kitsune-history.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, historyToJson(history.all()), 'utf8');
    return { canceled: false, filePath: result.filePath, count: history.all().length };
  });
  handle('history:import', async (event) => {
    if (!isTrustedSender(event)) return { canceled: true, reason: 'forbidden' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Импорт истории',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    const entries = parseHistoryJson(readImportFile(filePath));
    if (backupDataFile('history.json') === null) {
      throw new Error('Не удалось создать резервную копию текущей истории');
    }
    const added = history.importEntries(entries);
    history.flush();
    return { canceled: false, count: entries.length, added };
  });

  // ── Закладки ──
  handle('bookmarks:list', (event) => isTrustedSender(event) ? bookmarks.list() : []);
  handle('bookmarks:toggle', (event, payload) => isTrustedSender(event) ? bookmarks.toggle(payload || {}) : false);
  handle('bookmarks:remove', (event, url) => isTrustedSender(event) ? bookmarks.remove(url) : false);
  handle('bookmarks:has', (event, url) => isTrustedSender(event) ? bookmarks.has(url) : false);
  handle('bookmarks:open-all', (event) => {
    if (!isTrustedSender(event)) return false;
    for (const b of bookmarks.list()) tabs.create({ url: b.url, background: true });
    return true;
  });
  handle('bookmarks:export', async (event) => {
    if (!isTrustedSender(event)) return { canceled: true, reason: 'forbidden' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт закладок',
      defaultPath: path.join(app.getPath('documents'), 'kitsune-bookmarks.html'),
      filters: [{ name: 'HTML-закладки', extensions: ['html'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, bookmarksToHtml(bookmarks.list()), 'utf8');
    return { canceled: false, filePath: result.filePath, count: bookmarks.list().length };
  });
  handle('bookmarks:import', async (event) => {
    if (!isTrustedSender(event)) return { canceled: true, reason: 'forbidden' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Импорт закладок',
      properties: ['openFile'],
      filters: [{ name: 'HTML-закладки', extensions: ['html', 'htm'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const entries = parseBookmarksHtml(readImportFile(result.filePaths[0]));
    if (backupDataFile('bookmarks.json') === null) {
      throw new Error('Не удалось создать резервную копию текущих закладок');
    }
    const added = bookmarks.importEntries(entries);
    return { canceled: false, count: entries.length, added };
  });

  // ── Поиск на странице ──
  handle('find:start', (event, { text, forward = true, findNext = false }) => {
    const wc = contextForEvent(event).tabs.activeWebContents;
    if (!wc) return { matches: 0 };
    findInPageQuery = String(text || '');
    if (!findInPageQuery) {
      wc.stopFindInPage('clearSelection');
      return { matches: 0 };
    }
    return { matches: wc.findInPage(findInPageQuery, { forward, findNext }) };
  });
  handle('find:stop', (event) => {
    const wc = contextForEvent(event).tabs.activeWebContents;
    if (wc) wc.stopFindInPage('clearSelection');
    findInPageQuery = '';
    return true;
  });

  // ── Прочее ──
  handle('shell:open-external', (_e, url) => {
    if (!isExternalAppUrl(url) && !/^https?:\/\//i.test(String(url || ''))) return false;
    return shell.openExternal(String(url));
  });
  handle('default-browser:state', () => defaultBrowserState());
  handle('default-browser:open-settings', () => {
    if (process.platform !== 'win32') return false;
    shell.openExternal('ms-settings:defaultapps');
    return true;
  });
  handle('window:minimize', (event) => contextForEvent(event).window && contextForEvent(event).window.minimize());
  handle('window:maximize', (event) => {
    const win = contextForEvent(event).window;
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  handle('window:close', (event) => contextForEvent(event).window && contextForEvent(event).window.close());
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
  const safeStart = prepareStartupRecovery();
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
    // TabManager читает настройки динамически через SettingsStore, чтобы
    // смена поисковика и безопасного поиска применялась без перезапуска.
    settings,
    adblock,
    history,
    bookmarks,
    send,
    session: session.fromPartition(SESSION_PARTITION),
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
    getWindow: () => mainWindow,
    isPrivateSender: (event) => !!privateContextFor(event)
  });

  registerIpc();
  extensions = createExtensionManager({ app, session, net, dialog, send });
  extensions.loadInstalled(session.fromPartition(SESSION_PARTITION)).catch((err) => console.warn('[Kitsune] Расширения:', err.message));
  registerIpcExtras();
  vault.registerIpc(ipcMain);
  downloads.registerIpc(ipcMain, (event) => !!privateContextFor(event));

  // Автообновление из GitHub Releases. Проверка запускается с задержкой,
  // чтобы не отнимать сеть и диск у старта браузера.
  updater = createUpdater({ send, settings });
  updater.registerIpc(ipcMain);
  updater.start();

  const lastSession = settings.get('lastSession', []);
  const restored = !safeStart && settings.get('restoreTabs', true) && tabs.restoreSession(lastSession);
  if (!restored) tabs.create({ url: settings.get('homePage', 'kitsune://home') });
  if (safeStart) send('ui:toast', { text: 'Безопасный запуск: предыдущая сессия не восстановлена' });

  mainWindow.webContents.on('did-finish-load', () => {
    sessionRestored = true;
    tabs.emitStateNow();
  });
}

function listSitePermissions() {
  const grants = settings ? settings.get('sitePermissions', {}) : {};
  return Object.entries(grants || {})
    .filter(([, names]) => Array.isArray(names) && names.length)
    .map(([origin, names]) => ({ origin, permissions: names.slice().sort() }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

app.setName(APP_NAME);

// В режиме диагностики единственный экземпляр не нужен: окно не создаётся,
// а запущенный экземпляр браузера не должен мешать проверке собранного файла.
const gotLock = isDiagnosticsRun() ? true : app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      openIncomingUrls(commandLine);
      if (!commandLine.some((value) => /^https?:\/\//i.test(String(value)) || isExternalAppUrl(String(value)))) tabs.create();
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
    openIncomingUrls(process.argv);
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
    try {
      if (startupMarker) fs.rmSync(startupMarker, { force: true });
    } catch {
      /* ignore */
    }
  });
}

'use strict';

/**
 * TabManager — управление вкладками Kitsune Browser.
 *
 * Каждая вкладка — это WebContentsView (движок Chromium) внутри BrowserWindow.
 * Верхняя часть окна (полоса вкладок + тулбар + внутренние страницы) рисуется
 * renderer'ом, поэтому WebContentsView позиционируется с отступом CHROME_HEIGHT.
 */

const { WebContentsView, session } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const { toNavigationUrl, isInternalUrl, isExternalAppUrl, prettyUrl } = require('./url-utils');
const { isTrustedUrl } = require('./ipc-guards');
const { INTERNAL_PAGES, DEFAULT_SETTINGS } = require('../shared/constants');

const CHROME_HEIGHT = 88; // высота UI-полосы браузера (CSS-пиксели)
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const MAX_CLOSED = 25; // сколько закрытых вкладок помним для Ctrl+Shift+T

let nextTabId = 1;

class TabManager extends EventEmitter {
  /**
   * @param {Electron.BrowserWindow} win
   * @param {{settings: import('./store').SettingsStore,
   *          adblock: import('./adblock').AdBlocker,
   *          history: import('./store').HistoryStore,
   *          bookmarks: import('./store').BookmarkStore,
   *          send: (channel:string, payload:any)=>void,
   *          session: Electron.Session,
   *          private?: boolean}}
   */
  constructor(win, ctx) {
    super();
    this.win = win;
    this.ctx = ctx;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.closedStack = []; // история закрытых вкладок (для «переоткрыть»)
    this.disposing = false; // true во время закрытия окна — новые вкладки не создаём
    // Отступы, которые UI-слой «резервирует» у активной вкладки: под выпадающие
    // списки адресной строки, под боковую панель и под нижнюю полосу
    // (уведомление об обновлении). Нативный WebContentsView рисуется ПОВЕРХ
    // HTML-хрома окна, поэтому выпадающие элементы видны только там, где
    // вкладка сдвинута. См. setInsets().
    this.insets = { overlayBottom: 0, sidebarRight: 0, footer: 0 };
    this.htmlFullscreenId = null;
    this._layoutScheduled = false;
    this._emitTimer = null;
    this._lastStateJson = '';
    this.setMaxListeners(50);
    win.on('resize', () => this.layoutAll());
  }

  /**
   * Резервирует место у активной вкладки, чтобы UI-слой мог показать
   * выпадающие элементы (подсказки адресной строки, боковая панель) и
   * нижнюю полосу уведомления.
   *
   * @param {{overlayBottom?: number, sidebarRight?: number, footer?: number}} patch
   */
  setInsets(patch = {}) {
    const next = {
      overlayBottom: Math.max(0, Math.round(patch.overlayBottom ?? this.insets.overlayBottom)),
      sidebarRight: Math.max(0, Math.round(patch.sidebarRight ?? this.insets.sidebarRight)),
      footer: Math.max(0, Math.round(patch.footer ?? this.insets.footer))
    };
    if (
      next.overlayBottom === this.insets.overlayBottom &&
      next.sidebarRight === this.insets.sidebarRight &&
      next.footer === this.insets.footer
    ) {
      return false;
    }
    this.insets = next;
    this.layoutAll();
    return true;
  }

  get active() {
    return this.activeId ? this.tabs.get(this.activeId) : null;
  }

  get activeWebContents() {
    const tab = this.active;
    return tab ? tab.view.webContents : null;
  }

  get settings() {
    const source = this.ctx && this.ctx.settings;
    // При обновлении приложения старый app.asar может на короткое время
    // смешать новый TabManager со старым bootstrap. Поддерживаем оба формата:
    // SettingsStore и снимок настроек, чтобы ошибка не роняла старт браузера.
    if (!source) return { ...DEFAULT_SETTINGS };
    if (typeof source.get === 'function') return source.settings || { ...DEFAULT_SETTINGS };
    return source;
  }

  create({ url, active = true, background = false, pinned = false } = {}) {
    const settings = this.settings;
    const target = url || settings.homePage || DEFAULT_SETTINGS.homePage;

    const view = new WebContentsView({
      webPreferences: {
        session: this.ctx.session || session.fromPartition('persist:kitsune'),
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: true
      }
    });

    const tab = {
      id: nextTabId++,
      view,
      url: '',
      title: 'Новая вкладка',
      favicon: '',
      internalUrl: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      blocked: 0,
      zoom: 0, // 0 = 100 %, значение хранится как "уровень" Chromium
      error: null,
      createdAt: Date.now(),
      pinned: !!pinned,
      attached: false,
      pip: { available: false, playing: false, inPip: false }
    };

    this.tabs.set(tab.id, tab);
    const firstUnpinned = this.order.findIndex((id) => !this.tabs.get(id)?.pinned);
    if (tab.pinned && firstUnpinned >= 0) this.order.splice(firstUnpinned, 0, tab.id);
    else this.order.push(tab.id);
    this._attachEvents(tab);

    this.win.contentView.addChildView(view);
    tab.attached = true;
    view.setVisible(false);
    view.setBackgroundColor('#ffffff');

    this.navigate(tab.id, target, { replaceHistory: true });

    if (active && !background) this.activate(tab.id);
    this.layoutAll();
    this.emitState();
    return tab;
  }

  _attachEvents(tab) {
    const wc = tab.view.webContents;
    const id = tab.id;
    const sync = () => this._syncTab(tab);

    // Заголовок меняется динамически (SPA, видео, чаты) — держим его актуальным
    wc.on('page-title-updated', (_e, title) => {
      const next = String(title || '').trim();
      if (next && next !== tab.title) {
        tab.title = next;
        this.emitState();
      }
    });

    // Горячие клавиши должны работать и когда фокус находится внутри страницы,
    // поэтому перехватываем их в main-процессе, а не в UI-слое.
    wc.on('before-input-event', (event, input) => {
      if (typeof this.ctx.onShortcut === 'function' && this.ctx.onShortcut(input, id)) {
        event.preventDefault();
      }
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      tab.error = null;
      sync();
      this.emitState();
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      sync();
      this.emitState();
    });

    wc.on('did-finish-load', () => {
      this._maybeRecordHistory(tab);
      sync();
      this.emitState();
    });

    // Страница готова — применяем косметические правила блокировщика
    // (скрытие рекламных блоков средствами CSS).
    wc.on('dom-ready', () => {
      if (typeof this.ctx.onPageReady === 'function') this.ctx.onPageReady(tab);
    });

    // Правый клик по странице — своё меню (копировать, открыть ссылку в
    // новой вкладке, «заблокировать элемент» как в uBlock Origin).
    wc.on('context-menu', (_e, params) => {
      if (typeof this.ctx.onContextMenu === 'function') this.ctx.onContextMenu(id, params);
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons && favicons[0] ? favicons[0] : '';
      this.emitState();
    });

    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      tab.error = null;
      this._syncBlockedCount(id);
      sync();
      this.emitState();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      // SPA-переходы (YouTube, VK, GitHub) стреляют этим событием очень часто,
      // в том числе при скролле бесконечной ленты. Если адрес не изменился —
      // ничего не перерисовываем, иначе UI «залипает» на тяжёлых страницах.
      if (url === tab.url) return;
      tab.url = url;
      sync();
      this.emitState();
    });

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED
      tab.error = { code: errorCode, description: errorDescription, url: validatedURL };
      tab.loading = false;
      this.ctx.send('tab:load-error', { tabId: id, ...tab.error });
      this.emitState();
    });

    const openExternal = (url) => {
      if (!isExternalAppUrl(url)) return false;
      try {
        Promise.resolve(require('electron').shell.openExternal(url)).catch((err) => {
          this.ctx.send('ui:toast', { text: `Не удалось открыть приложение: ${err.message}` });
        });
      } catch (err) {
        this.ctx.send('ui:toast', { text: `Не удалось открыть приложение: ${err.message}` });
      }
      return true;
    };
    const blockUntrustedFile = (event, url) => {
      if (String(url).toLowerCase().startsWith('file:') && !isTrustedUrl(url)) {
        event.preventDefault();
        this.ctx.send('ui:toast', { text: 'Переход к локальному файлу заблокирован' });
        return true;
      }
      return false;
    };
    wc.on('will-navigate', (event, url) => {
      if (!blockUntrustedFile(event, url) && openExternal(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!blockUntrustedFile(event, url) && openExternal(url)) event.preventDefault();
    });

    wc.on('render-process-gone', () => {
      tab.error = { code: 0, description: 'Страница аварийно завершилась', url: tab.url };
      this.emitState();
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^file:/i.test(url)) return { action: 'deny' };
      if (openExternal(url)) return { action: 'deny' };
      // Chromium сообщает foreground-tab/background-tab для обычного открытия
      // ссылки через Ctrl-клик, СКМ и target="_blank". Это не рекламный popup:
      // блокировка всплывающих окон не должна ломать такие пользовательские
      // переходы.
      const tabDisposition = disposition === 'foreground-tab' || disposition === 'background-tab';
      if (tabDisposition) {
        this.create({ url, background: disposition === 'background-tab' });
        return { action: 'deny' };
      }
      // $popup — правило фильтра прямо запрещает настоящее всплывающее окно.
      const action = this.ctx.adblock.getAction({ url, type: 'popup', tabUrl: tab.url, tabId: id });
      if (action.block) {
        this.ctx.adblock.recordBlocked({ tabId: id, url, type: 'popup' });
        return { action: 'deny' };
      }
      if (!this.settings.blockPopups) {
        this.create({ url, background: false });
      }
      // Не разрешаем Chromium создавать отдельные BrowserWindow для сайта:
      // такое окно обходит управление вкладками, preload и жизненный цикл
      // Kitsune. Разрешённые ссылки уже перенаправлены в обычную вкладку.
      return { action: 'deny' };
    });

    wc.on('enter-html-full-screen', () => {
      if (this.activeId !== id) this.activate(id);
      this.htmlFullscreenId = id;
      this.layoutAll();
      this.ctx.send('window:html-fullscreen', { value: true });
    });
    wc.on('leave-html-full-screen', () => {
      if (this.htmlFullscreenId !== id) return;
      this.htmlFullscreenId = null;
      this.layoutAll();
      this.ctx.send('window:html-fullscreen', { value: false });
    });
  }

  _syncTab(tab) {
    const wc = tab.view.webContents;
    try {
      const current = wc.getURL() || '';
      if (current.startsWith('file://')) {
        // Внутренняя страница загружена через loadFile — показываем логический адрес
        tab.url = tab.internalUrl || 'kitsune://home';
      } else {
        tab.internalUrl = '';
        tab.url = current || tab.url;
      }
      const nav = wc.navigationHistory;
      tab.canGoBack = nav ? nav.canGoBack() : wc.canGoBack();
      tab.canGoForward = nav ? nav.canGoForward() : wc.canGoForward();
      // Заголовок всегда берём у самой страницы: иначе при переходе на новый
      // сайт в полосе вкладок оставался заголовок предыдущей страницы.
      const docTitle = String(wc.getTitle() || '').trim();
      if (docTitle) tab.title = docTitle;
      else if (!tab.title || tab.title === 'Новая вкладка') {
        tab.title = prettyUrl(tab.url) || 'Новая вкладка';
      }
    } catch {
      /* webContents уже уничтожен */
    }
  }

  _syncBlockedCount(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.blocked = this.ctx.adblock.statsForTab(id);
  }

  _maybeRecordHistory(tab) {
    if (this.ctx.private || !this.ctx.history || !tab.url || isInternalUrl(tab.url)) return;
    this.ctx.history.add({ url: tab.url, title: tab.title, favicon: tab.favicon });
  }

  /* ─────────────────────────── Навигация ─────────────────────────── */

  /** Перейти по адресу или выполнить поиск. Возвращает итоговый URL. */
  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return '';
    const settings = this.settings;

    let url;
    if (input === null || input === undefined || String(input).trim() === '') {
      url = settings.homePage;
    } else if (String(input).startsWith('kitsune://')) {
      url = String(input);
    } else {
      url = toNavigationUrl(String(input), settings.searchEngine, settings.safeSearch);
    }

    if (isInternalUrl(url)) {
      this._loadInternal(tab, url);
    } else if (/^file:/i.test(url)) {
      this.ctx.send('ui:toast', { text: 'Открытие локального файла заблокировано' });
      return '';
    } else if (isExternalAppUrl(url)) {
      try {
        Promise.resolve(require('electron').shell.openExternal(url)).catch((err) =>
          this.ctx.send('ui:toast', { text: `Не удалось открыть приложение: ${err.message}` }));
      } catch (err) {
        this.ctx.send('ui:toast', { text: `Не удалось открыть приложение: ${err.message}` });
      }
    } else {
      tab.internalUrl = '';
      tab.url = url; // показываем целевой адрес сразу, не дожидаясь ответа сети
      this.ctx.adblock.clearTabStats(tab.id);
      tab.blocked = 0;
      tab.view.webContents.loadURL(url).catch(() => {});
    }
    this.emitState();
    return url;
  }

  _loadInternal(tab, url) {
    const page = INTERNAL_PAGES[url] || INTERNAL_PAGES['kitsune://home'];
    const file = path.join(__dirname, '..', 'renderer', 'pages', page);
    tab.internalUrl = url;
    tab.url = url;
    tab.title = 'Kitsune';
    tab.view.webContents.loadFile(file).catch(() => {});
  }

  goBack(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const wc = tab.view.webContents;
    const nav = wc.navigationHistory;
    if (nav ? nav.canGoBack() : wc.canGoBack()) {
      if (nav) nav.goBack();
      else wc.goBack();
    }
  }

  goForward(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const wc = tab.view.webContents;
    const nav = wc.navigationHistory;
    if (nav ? nav.canGoForward() : wc.canGoForward()) {
      if (nav) nav.goForward();
      else wc.goForward();
    }
  }

  reload(id, { ignoreCache = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.ctx.adblock.clearTabStats(id);
    tab.blocked = 0;
    if (ignoreCache) tab.view.webContents.reloadIgnoringCache();
    else tab.view.webContents.reload();
    this.emitState();
  }

  stop(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.view.webContents.stop();
    tab.loading = false;
    this.emitState();
  }

  goHome(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.navigate(id, this.settings.homePage);
  }

  /* ─────────────────────── Управление вкладками ─────────────────────── */

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.attached || !tab.view || tab.view.webContents.isDestroyed()) return;
    // Уже активна — не перерисовываем UI зря (это же защищает перетаскивание
    // вкладок: перестройка DOM на mousedown ломала бы подсветку drag&drop)
    if (this.activeId === id) return;
    if (this.htmlFullscreenId !== null && this.htmlFullscreenId !== id) {
      const fullscreen = this.tabs.get(this.htmlFullscreenId);
      if (fullscreen && !fullscreen.view.webContents.isDestroyed()) {
        fullscreen.view.webContents.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen()', true).catch(() => {});
      }
      this.htmlFullscreenId = null;
      this.ctx.send('window:html-fullscreen', { value: false });
    }
    for (const t of this.tabs.values()) {
      const visible = t.id === id && t.attached && !t.view.webContents.isDestroyed();
      t.view.setVisible(visible);
      if (!visible && t.pip && !t.pip.inPip && !t.view.webContents.isDestroyed()) {
        t.view.webContents.executeJavaScript('[...document.querySelectorAll("video")].forEach((v) => { if (!v.paused) v.pause(); })', false).catch(() => {});
      }
    }
    this.activeId = id;
    this.layoutAll();
    this.emitState();
  }

  /**
   * Закрывает вкладку и корректно освобождает её WebContentsView.
   *
   * Важные моменты:
   *  • view снимается с окна до уничтожения webContents — иначе вкладка
   *    остаётся висеть поверх страницы;
   *  • `waitForBeforeUnload: false` не даёт сайту заблокировать закрытие
   *    (иначе вкладка «не закрывалась» бы на формах с beforeunload);
   *  • если закрыли последнюю вкладку — открываем новую страницу,
   *    чтобы не оставлять пустое окно без UI.
   *
   * @param {number} id
   * @param {{remember?: boolean, allowEmpty?: boolean}} [opts]
   * @returns {boolean} закрыта ли вкладка
   */
  close(id, { remember = true, allowEmpty = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return false;

    const index = this.order.indexOf(id);
    const wasActive = this.activeId === id;
    if (this.htmlFullscreenId === id) {
      this.htmlFullscreenId = null;
      this.ctx.send('window:html-fullscreen', { value: false });
    }

    // 1) Сначала чистим состояние — UI обновится в любом случае
    this.tabs.delete(id);
    this.order = this.order.filter((t) => t !== id);
    this.ctx.adblock.clearTabStats(id);

    // 2) Запоминаем адрес, чтобы вернуть вкладку по Ctrl+Shift+T
    if (!this.ctx.private && remember && !tab.pinned && tab.url && !isInternalUrl(tab.url)) {
      this.closedStack.push({ url: tab.url, title: tab.title || tab.url });
      if (this.closedStack.length > MAX_CLOSED) this.closedStack.shift();
    }

    // 3) Освобождаем нативный view и renderer-процесс
    this._disposeView(tab);

    // 4) Если закрыли активную — активируем соседнюю (как в Chrome)
    if (wasActive) {
      this.activeId = null;
      const nextId = this.order[Math.min(Math.max(index, 0), this.order.length - 1)];
      if (nextId !== undefined) {
        this.activate(nextId);
        return true;
      }
    }

    // 5) Пустое окно — плохой UX: открываем стартовую страницу
    if (!this.order.length && !allowEmpty && !this.disposing) {
      if (this.settings.closeLastTabOpensNewTab !== false) {
        this.create({ url: this.settings.homePage || DEFAULT_SETTINGS.homePage });
      } else {
        this.layoutAll();
        this.emitState();
        this.emit('empty');
      }
      return true;
    }

    this.layoutAll();
    this.emitState();
    return true;
  }

  /** Снимает view с окна и уничтожает renderer-процесс вкладки */
  _disposeView(tab) {
    const view = tab.view;
    const wc = view && view.webContents;
    tab.attached = false;

    try {
      this.win.contentView.removeChildView(view);
    } catch {
      /* view уже откреплён */
    }

    if (!wc || wc.isDestroyed()) return;

    try {
      // waitForBeforeUnload: false — страница не может помешать закрытию
      wc.close({ waitForBeforeUnload: false });
    } catch {
      /* уже закрывается */
    }

    // Страховка от «зависшего» renderer'а: если через секунду процесс жив —
    // снимаем его принудительно, чтобы не копить зомби-процессы.
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      try {
        wc.forcefullyCrashRenderer();
      } catch {
        /* игнорируем */
      }
    }, 1000).unref?.();
  }

  closeActive() {
    if (this.activeId !== null) this.close(this.activeId);
  }

  /** Закрыть все вкладки, кроме указанной */
  closeOthers(keepId) {
    for (const id of [...this.order]) {
      if (id !== keepId && !this.tabs.get(id)?.pinned) this.close(id);
    }
  }

  /** Закрыть все вкладки справа от указанной */
  closeToRight(id) {
    const index = this.order.indexOf(id);
    if (index < 0) return;
    for (const other of this.order.slice(index + 1)) {
      if (!this.tabs.get(other)?.pinned) this.close(other);
    }
  }

  /**
   * Возвращает последнюю закрытую вкладку.
   * @returns {{url: string, title: string}|null}
   */
  popClosed() {
    return this.closedStack.pop() || null;
  }

  /** Переоткрыть последнюю закрытую вкладку */
  reopenClosed() {
    const last = this.popClosed();
    if (!last) return null;
    return this.create({ url: last.url });
  }

  reorder(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const [moved] = this.order.splice(fromIndex, 1);
    if (moved === undefined) return;
    this.order.splice(toIndex, 0, moved);
    this.emitState();
  }

  duplicate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return this.create({ url: tab.url, background: true, pinned: tab.pinned });
  }

  togglePinned(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    tab.pinned = !tab.pinned;
    this.order = this.order.filter((tabId) => tabId !== id);
    const firstUnpinned = this.order.findIndex((tabId) => !this.tabs.get(tabId)?.pinned);
    if (tab.pinned && firstUnpinned >= 0) this.order.splice(firstUnpinned, 0, id);
    else this.order.push(id);
    this.emitState();
    return tab.pinned;
  }

  /** Масштаб страницы: delta в «шагах» Chromium (-1 = −20 %, +1 = +20 %) */
  setZoom(id, delta) {
    const tab = this.tabs.get(id);
    if (!tab) return 0;
    const wc = tab.view.webContents;
    const current = typeof wc.getZoomLevel === 'function' ? wc.getZoomLevel() : 0;
    const next = Math.max(-5, Math.min(5, Number((current + delta).toFixed(2))));
    wc.setZoomLevel(next);
    tab.zoom = next;
    this.emitState();
    return next;
  }

  /** Сброс масштаба вкладки к 100 % */
  resetZoom(id) {
    const tab = this.tabs.get(id);
    if (!tab) return 0;
    tab.view.webContents.setZoomLevel(0);
    tab.zoom = 0;
    this.emitState();
    return 0;
  }

  /* ─────────────────── Раскладка и состояние (state) ─────────────────── */

  /**
   * Раскладка всех вкладок.
   *
   * Вызовы на каждое событие resize окна дороги (setBounds × N), поэтому
   * реальная работа откладывается до конца текущего кадра.
   */
  layoutAll() {
    if (this._layoutScheduled) return;
    this._layoutScheduled = true;
    setImmediate(() => {
      this._layoutScheduled = false;
      this._layoutNow();
    });
  }

  _layoutNow() {
    if (!this.win || this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    const overlay = this.insets.overlayBottom;
    const sidebar = this.insets.sidebarRight;
    const footer = this.insets.footer;

    for (const tab of this.tabs.values()) {
      // Отступы применяются только к активной вкладке: остальные скрыты,
      // а лишние setBounds заставляют их зря пересчитывать layout.
      const isActive = tab.id === this.activeId;
      const fullscreen = tab.id === this.htmlFullscreenId;
      const top = fullscreen ? 0 : CHROME_HEIGHT + (isActive ? overlay : 0);
      const right = fullscreen ? 0 : isActive ? sidebar : 0;
      const bottom = fullscreen ? 0 : isActive ? footer : 0;
      try {
        tab.view.setBounds({
          x: 0,
          y: top,
          width: Math.max(120, w - right),
          height: Math.max(80, h - top - bottom)
        });
      } catch {
        /* view уже удалён */
      }
    }
  }

  getState() {
    const tabs = this.order
      .map((id) => this.tabs.get(id))
      .filter(Boolean)
      .map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        favicon: t.favicon,
        loading: t.loading,
        blocked: t.blocked,
        pinned: !!t.pinned,
        hasError: !!t.error
      }));

    const active = this.active && this.active.attached && !this.active.view.webContents.isDestroyed()
      ? this.active
      : null;
    return {
      tabs,
      activeId: active ? active.id : null,
      closedCount: this.ctx.private ? 0 : this.closedStack.length,
      lastClosed: this.closedStack.length ? this.closedStack[this.closedStack.length - 1].url : '',
      active: active
        ? {
            id: active.id,
            // id webContents активной вкладки — по нему UI и тесты находят
            // нужный view среди всех открытых (в окне их несколько)
            wcId: active.view.webContents.id,
            url: active.url,
            title: active.title,
            canGoBack: active.canGoBack,
            canGoForward: active.canGoForward,
            loading: active.loading,
            blocked: active.blocked,
            zoom: active.zoom,
            isSecure: String(active.url).startsWith('https://'),
            isInternal: isInternalUrl(active.url),
            error: active.error
          }
        : null,
      adblock: {
        enabled: this.ctx.adblock.enabled,
        rules: this.ctx.adblock.rulesCount,
        blockedTotal: this.ctx.adblock.blockedTotal
      },
      // Состояние picture-in-picture активной вкладки: есть ли на странице
      // видео и играет ли оно. По нему UI показывает кнопку «смотреть в окне»
      // (как в Firefox). Заполняет main-процесс — см. setTabVideoState().
      pip: (active && active.pip) || { available: false, playing: false, inPip: false },
      // Отступы активной вкладки — по ним UI понимает, сколько места он
      // выторговал под выпадающие списки и боковую панель (см. setInsets).
      insets: { ...this.insets },
      chromeHeight: CHROME_HEIGHT
    };
  }

  /**
   * Отправляет состояние UI-слою.
   *
   * События Chromium идут пачками (навигация → заголовок → favicon → стоп
   * загрузки), поэтому отправка склеивается в один кадр, а повторяющееся
   * состояние не уходит по IPC вовсе. Без этого тяжёлые сайты (YouTube,
   * соцсети) заставляли UI перерисовываться десятки раз в секунду.
   */
  emitState() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this._flushState();
    }, 16);
  }

  /** Немедленная отправка состояния (минуя склейку) */
  emitStateNow() {
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    this._flushState();
  }

  _flushState() {
    const state = this.getState();
    const json = JSON.stringify(state);
    if (json === this._lastStateJson) return;
    this._lastStateJson = json;
    this.ctx.send('tabs:state', state);
  }

  restoreSession(entries) {
    if (this.ctx.private) return false;
    if (!Array.isArray(entries) || !entries.length) return false;
    let activeId = null;
    for (const entry of entries) {
      try {
        const value = typeof entry === 'string' ? { url: entry } : entry;
        if (!value || !value.url) continue;
        const tab = this.create({ url: value.url, pinned: value.pinned, active: false, background: true });
        if (value.active) activeId = tab.id;
      } catch {
        /* пропускаем некорректный url */
      }
    }
    if (this.order.length) this.activate(activeId || this.order[this.order.length - 1]);
    return true;
  }

  sessionUrls() {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter((t) => t && t.url && !isInternalUrl(t.url))
      .map((t) => ({ url: t.url, pinned: !!t.pinned, active: t.id === this.activeId }));
  }

  destroyAll() {
    // Закрываем окно: новые вкладки создавать не нужно
    this.disposing = true;
    for (const id of [...this.order]) this.close(id, { remember: false, allowEmpty: true });
    this.disposing = false;
  }
}

module.exports = { TabManager, CHROME_HEIGHT };

'use strict';

/**
 * preload.js — мост между страницами и main-процессом.
 *
 * contextIsolation включён, поэтому страницы не имеют доступа к Node.
 * Скрипт загружается и во внутренние страницы браузера (file://), и в
 * обычные сайты, поэтому API разделён на два уровня:
 *
 *   • window.kitsune      — полный API браузера, ТОЛЬКО для внутренних
 *                           страниц (kitsune://home, settings, …). Раньше он
 *                           отдавался любому сайту, то есть любая страница
 *                           могла прочитать историю и закладки или закрыть
 *                           окно — это закрыто;
 *   • window.kitsunePage  — минимальный мост для обычных сайтов:
 *                           сохранение/автозаполнение паролей и пикер
 *                           элементов для блокировщика.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Обёртка над ipcRenderer.invoke */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** Это внутренняя страница браузера (а не сайт из интернета)? */
function isInternalPage() {
  try {
    return String(location.protocol) === 'file:';
  } catch {
    return false;
  }
}

/* ══════════════════════ Полный API браузера ══════════════════════ */

function exposeBrowserApi() {
  const api = {
    /* ── Информация о приложении ── */
    getAppInfo: () => invoke('app:info'),
    getState: () => invoke('state:get'),

    /* ── Вкладки ── */
    tabs: {
      create: (options) => invoke('tab:create', options || {}),
      close: (id) => invoke('tab:close', id),
      closeOthers: (id) => invoke('tab:close-others', id),
      closeRight: (id) => invoke('tab:close-right', id),
      reopen: () => invoke('tab:reopen'),
      contextMenu: (id) => invoke('tab:context-menu', id),
      devtools: (id) => invoke('tab:devtools', id),
      zoom: (delta, id) => invoke('tab:zoom', { id, delta }),
      zoomReset: (id) => invoke('tab:zoom-reset', id),
      activate: (id) => invoke('tab:activate', id),
      duplicate: (id) => invoke('tab:duplicate', id),
      reorder: (from, to) => invoke('tab:reorder', { from, to }),
      navigate: (input, id) => invoke('tab:navigate', { id, input }),
      back: (id) => invoke('tab:back', id),
      forward: (id) => invoke('tab:forward', id),
      reload: (id, ignoreCache) => invoke('tab:reload', { id, ignoreCache }),
      stop: (id) => invoke('tab:stop', id),
      home: (id) => invoke('tab:home', id),
      cycle: (direction) => invoke('tab:cycle', direction)
    },

    /* ── Адресная строка и поиск ── */
    search: {
      urlFor: (query) => invoke('search:url', { query }),
      suggest: (query) => invoke('search:suggest', { query })
    },

    /* ── Настройки ── */
    settings: {
      get: () => invoke('settings:get'),
      set: (patch) => invoke('settings:set', patch),
      reset: () => invoke('settings:reset')
    },

    /* ── Блокировщик рекламы ── */
    adblock: {
      stats: () => invoke('adblock:stats'),
      setEnabled: (enabled) => invoke('adblock:set', enabled),
      toggle: async () => {
        const stats = await invoke('adblock:stats');
        return invoke('adblock:set', !stats.enabled);
      },
      resetStats: () => invoke('adblock:reset-stats'),
      addRule: (rule) => invoke('adblock:add-rule', rule),
      removeRule: (rule) => invoke('adblock:remove-rule', rule),
      userRules: () => invoke('adblock:user-rules'),
      reloadPage: (id) => invoke('adblock:reload-page', id),
      siteState: () => invoke('adblock:site-state'),
      toggleSite: () => invoke('adblock:toggle-site'),
      pickElement: () => invoke('adblock:pick-element'),
      updateLists: () => invoke('adblock:update-lists')
    },

    /* ── Пароли ── */
    passwords: {
      list: () => invoke('password:list'),
      save: (entry) => invoke('password:save', entry),
      remove: (id) => invoke('password:remove', id),
      reveal: (id) => invoke('password:reveal', id),
      fillActive: (id) => invoke('password:fill-active', id),
      clear: () => invoke('password:clear')
    },

    /* ── «Смотреть в окне» (picture-in-picture) ──
       Кнопка в тулбаре: видео ищет main-процесс на странице активной
       вкладки. Состояние (есть ли видео) приходит в tabs:state → pip. */
    pip: {
      toggle: (id) => invoke('pip:toggle', id)
    },


    downloads: {
      list: () => invoke('downloads:list'),
      cancel: (id) => invoke('downloads:cancel', id),
      open: (id) => invoke('downloads:open', id),
      folder: (id) => invoke('downloads:folder', id)
    },

    /* ── Обновления (GitHub Releases) ── */
    updater: {
      state: () => invoke('updater:state'),
      check: () => invoke('updater:check'),
      install: () => invoke('updater:install'),
      openReleases: () => invoke('updater:open-releases')
    },

    /* ── Интеграция с Windows ── */
    defaultBrowser: {
      state: () => invoke('default-browser:state'),
      openSettings: () => invoke('default-browser:open-settings')
    },

    /* ── История ── */
    history: {
      list: (options) => invoke('history:list', options || {}),
      clear: () => invoke('history:clear'),
      remove: (url) => invoke('history:remove', url)
    },

    /* ── Закладки ── */
    bookmarks: {
      list: () => invoke('bookmarks:list'),
      toggle: (payload) => invoke('bookmarks:toggle', payload),
      remove: (url) => invoke('bookmarks:remove', url),
      has: (url) => invoke('bookmarks:has', url),
      openAll: () => invoke('bookmarks:open-all')
    },

    /* ── Поиск на странице ── */
    find: {
      start: (text, options) => invoke('find:start', { text, ...(options || {}) }),
      stop: () => invoke('find:stop')
    },

    /* ── Интерфейс окна ── */
    ui: {
      // Нативное меню-«гамбургер»: HTML-меню оказывалось ПОД вкладкой,
      // поэтому его рисует main-процесс (см. buildAppMenu в main.js).
      appMenu: (position) => invoke('ui:app-menu', position || {}),
      // Состав меню без показа (тесты, диагностика)
      appMenuItems: () => invoke('ui:app-menu-items'),
      // Резерв места под выпадающие списки и боковую панель
      setInsets: (patch) => invoke('ui:set-insets', patch || {})
    },

    /* ── Системные действия ── */
    openExternal: (url) => invoke('shell:open-external', url),
    copy: (text) => invoke('clipboard:write', text),
    confirm: (title, message) => invoke('dialog:confirm', { title, message }),
    window: {
      minimize: () => invoke('window:minimize'),
      maximize: () => invoke('window:maximize'),
      close: () => invoke('window:close')
    },

    /* ── События из main-процесса ── */
    on: (channel, listener) => {
      const allowed = [
        'tabs:state',
        'app:info',
        'settings:changed',
        'adblock:state',
        'adblock:count',
        'tab:load-error',
        'window:html-fullscreen',
        'ui:focus-find',
        'ui:focus-address',
        'ui:open-history',
        'ui:open-bookmarks',
        'ui:open-passwords',
        'ui:toggle-bookmark',
        'ui:toast',
        'updater:status',
        'downloads:changed'
      ];
      if (!allowed.includes(channel)) return () => {};
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },

    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  };


/* ═══════════════ Обычные сайты: пароли и пикер ═══════════════ */

/** Виден ли элемент (не скрыт и не отключён) */
function isUsable(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.type === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Находит поля логина и пароля в форме */
function findLoginFields(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const passwords = [...root.querySelectorAll('input[type="password"]')].filter(isUsable);
  if (!passwords.length) return null;

  const password = passwords[0];
  const form = password.form || root;
  const inputs = [...form.querySelectorAll('input')];
  const index = inputs.indexOf(password);
  let user = null;

  for (let i = index - 1; i >= 0; i--) {
    const el = inputs[i];
    const type = String(el.type || 'text').toLowerCase();
    if (['text', 'email', 'tel', 'url', ''].includes(type) && isUsable(el)) {
      user = el;
      break;
    }
  }
  if (!user) {
    user = form.querySelector(
      'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[name*="login" i], input[name*="email" i]'
    );
  }

  return { user, password, form };
}

/**
 * Проставляет значение так, чтобы это заметили фреймворки
 * (React/Vue слушают нативный setter и событие input).
 */
function setFieldValue(el, value) {
  if (!el) return false;
  try {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  } catch {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** CSS-селектор для элемента — для правил «скрыть элемент» */
function selectorFor(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;

  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 4) {
    let part = node.tagName.toLowerCase();
    const classes = [...(node.classList || [])]
      .filter((c) => c.length > 2 && !/^(ng|css|jsx|sc)-/.test(c) && !/\d{4,}/.test(c))
      .slice(0, 2);
    if (classes.length) part += '.' + classes.join('.');
    const parent = node.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) break;
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

  contextBridge.exposeInMainWorld('kitsune', api);
}

function exposePageApi() {
  let picking = false;
  let highlight = null;
  let hovered = null;

  function fillCredentials(cred) {
    const fields = findLoginFields(document);
    if (!fields) return false;
    if (cred.username && fields.user) setFieldValue(fields.user, cred.username);
    if (cred.password) setFieldValue(fields.password, cred.password);
    return true;
  }

  /** Читает введённые логин/пароль — для диалога «сохранить пароль?» */
  function readCredentials(scope) {
    const fields = findLoginFields(scope);
    if (!fields) return null;
    const password = String(fields.password.value || '');
    if (!password) return null;
    return {
      url: location.href,
      username: fields.user ? String(fields.user.value || '') : '',
      password
    };
  }

  const page = {
    /** Сохранённые пары для текущей страницы */
    credentials: () => invoke('password:for-url', location.href),
    /** Заполнить форму из хранилища */
    autofill: async () => {
      const cred = await invoke('password:for-url', location.href);
      if (!cred || !cred.found) return false;
      return fillCredentials(cred);
    },
    /** Заполнить форму конкретной парой */
    fill: (cred) => fillCredentials(cred),
    /** Есть ли на странице форма входа */
    hasLoginForm: () => !!findLoginFields(document)
  };

  /* ── Сохранение пароля при отправке формы ── */
  document.addEventListener(
    'submit',
    (event) => {
      try {
        const data = readCredentials(event.target);
        if (data) invoke('password:capture', data);
      } catch {
        /* форма нестандартная — молча пропускаем */
      }
    },
    true
  );

  document.addEventListener(
    'click',
    (event) => {
      try {
        const target = event.target && event.target.closest
          ? event.target.closest('button[type="submit"], input[type="submit"], [data-testid*="login" i]')
          : null;
        if (!target) return;
        const data = readCredentials(target.form || document);
        if (data) invoke('password:capture', data);
      } catch {
        /* игнорируем */
      }
    },
    true
  );

  /* ── Автозаполнение при загрузке страницы ── */
  window.addEventListener('load', async () => {
    try {
      const cred = await invoke('password:for-url', location.href);
      if (!cred || !cred.found || !cred.autofill) return;
      const fields = findLoginFields(document);
      if (!fields) return;
      // не перетираем то, что пользователь уже начал вводить
      if (fields.password.value || (fields.user && fields.user.value)) return;
      fillCredentials(cred);
    } catch {
      /* нет доступа — не критично */
    }
  });

  /* ── Заполнение по запросу из UI браузера ── */
  ipcRenderer.on('password:fill-active', (_event, cred) => {
    if (cred) fillCredentials(cred);
  });

  /* ── Пикер элементов для блокировщика (как в uBlock Origin) ── */
  function moveHighlight(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === highlight) return;
    if (highlight) highlight.style.removeProperty('outline');
    highlight = el;
    hovered = el;
    if (highlight) {
      highlight.style.setProperty('outline', '2px solid #ff7a29', 'important');
      highlight.style.setProperty('outline-offset', '-2px', 'important');
    }
  }

  function onClick(event) {
    if (!picking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selector = selectorFor(hovered);
    stopPicker();
    if (selector) invoke('adblock:pick', { url: location.href, selector });
  }

  function onKey(event) {
    if (picking && event.key === 'Escape') {
      event.preventDefault();
      stopPicker();
    }
  }

  function startPicker() {
    if (picking) return;
    picking = true;
    document.addEventListener('mousemove', moveHighlight, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    if (document.body) document.body.style.cursor = 'crosshair';
  }

  function stopPicker() {
    if (!picking) return;
    picking = false;
    document.removeEventListener('mousemove', moveHighlight, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (document.body) document.body.style.removeProperty('cursor');
    if (highlight) highlight.style.removeProperty('outline');
    highlight = null;
    hovered = null;
  }

  ipcRenderer.on('adblock:picker-start', () => startPicker());
  ipcRenderer.on('adblock:picker-stop', () => stopPicker());

  /* ── «Смотреть в окне»: сообщаем main-процессу, есть ли на странице видео ──
     Кнопка PiP в тулбаре появляется только тогда, когда видео действительно
     играет (как в Firefox). Наблюдаем за DOM страницы, потому что сам UI
     браузера к чужому документу доступа не имеет. */
  let videoStateTimer = null;
  let lastVideoState = '';

  function reportVideoState(force = false) {
    try {
      const videos = [...document.querySelectorAll('video')];
      const playing = videos.some((v) => !v.paused && !v.ended && v.currentTime > 0);
      const inPip = !!document.pictureInPictureElement;
      const key = `${videos.length ? 1 : 0}${playing ? 1 : 0}${inPip ? 1 : 0}`;
      if (!force && key === lastVideoState) return;
      lastVideoState = key;
      clearTimeout(videoStateTimer);
      // play/pause приходят пачками (переключение источника) — склеиваем
      videoStateTimer = setTimeout(() => {
        invoke('pip:video-state', { available: videos.length > 0, playing, inPip });
      }, 150);
    } catch {
      /* страница выгружается */
    }
  }

  function watchVideoState() {
    const events = [
      'play',
      'playing',
      'pause',
      'ended',
      'emptied',
      'loadeddata',
      'enterpictureinpicture',
      'leavepictureinpicture'
    ];
    for (const name of events) {
      document.addEventListener(name, () => reportVideoState(true), true);
    }
    window.addEventListener('pagehide', () => {
      invoke('pip:video-state', { available: false, playing: false, inPip: false });
    });
    reportVideoState(true);
  }

  /* ── YouTube: пропуск рекламы ──
     Косметические правила скрывают баннеры, но пре-ролл и mid-roll играют
     внутри самого плеера. Здесь работает то же, что делает скриптлет
     uBlock Origin: жмём «Пропустить», а рекламу без кнопки проматываем —
     YouTube сам помечает её классом .ad-showing на контейнере плеера. */
  function setupYouTubeAdSkip() {
    try {
      const host = String(location.hostname || '').toLowerCase();
      if (!/(^|\.)youtube\.com$/.test(host)) return;
      if (window.__kitsuneYtAds) return;
      window.__kitsuneYtAds = true;

      const SKIP_SELECTOR = [
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-modern',
        '.ytp-skip-ad-button',
        '.ytp-ad-survey-answer-button'
      ].join(',');

      function skipAd() {
        try {
          if (!document.querySelector('.ad-showing')) return;
          const button = [...document.querySelectorAll(SKIP_SELECTOR)].find(
            (node) => node.offsetParent !== null
          );
          if (button) {
            button.click();
            return;
          }
          // Реклама без кнопки «пропустить» — перематываем её до конца.
          const video = document.querySelector('video');
          if (video && Number.isFinite(video.duration) && video.duration > 0) {
            if (video.currentTime < video.duration - 0.4) {
              video.currentTime = video.duration - 0.1;
            }
            const started = video.play();
            if (started && typeof started.catch === 'function') started.catch(() => {});
          }
        } catch {
          /* плеер ещё не готов */
        }
      }

      function hideOverlays() {
        const selectors = [
          '.ytp-ad-overlay-container',
          '.ytp-ad-text-overlay',
          '.ytp-ad-image-overlay',
          '#player-ads'
        ];
        for (const node of document.querySelectorAll(selectors.join(','))) {
          node.style.setProperty('display', 'none', 'important');
        }
      }

      setInterval(() => {
        skipAd();
        hideOverlays();
      }, 350);
      document.addEventListener('play', skipAd, true);
    } catch {
      /* не YouTube — ничего не делаем */
    }
  }

  watchVideoState();
  setupYouTubeAdSkip();

  contextBridge.exposeInMainWorld('kitsunePage', page);
}

if (isInternalPage()) exposeBrowserApi();
else exposePageApi();

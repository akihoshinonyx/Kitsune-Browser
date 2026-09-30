'use strict';

/**
 * renderer.js — логика UI Kitsune Browser.
 *
 * Отвечает за полосу вкладок, адресную строку с подсказками,
 * меню, боковую панель (история/закладки), поиск на странице
 * и отображение статистики блокировки рекламы.
 *
 * Всё взаимодействие с движком — через window.kitsune (preload).
 */

const api = window.kitsune;
const K = window.KITSUNE;

/* ─────────────────────────── Состояние UI ─────────────────────────── */

const ui = {
  state: {
    tabs: [],
    activeId: null,
    active: null,
    adblock: {},
    // Состояние «смотреть в окне» активной вкладки (заполняет main-процесс
    // через tabs:state — см. pip в TabManager.getState)
    pip: { available: false, playing: false, inPip: false }
  },
  appInfo: null,
  suggestions: [],
  selectedSuggestion: -1,
  editingAddress: false,
  sidebarMode: 'history', // history | bookmarks
  toastTimer: null,
  progressTimer: null,
  bookmarkUrls: new Set(),
  updateState: null,
  updateDismissedFor: '' // какой статус обновления пользователь скрыл
};

/* ─────────────────────────── Ссылки на DOM ─────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
  tabs: $('tabs'),
  newTab: $('new-tab'),
  winMin: $('win-min'),
  winMax: $('win-max'),
  winClose: $('win-close'),

  back: $('nav-back'),
  forward: $('nav-forward'),
  reload: $('nav-reload'),
  home: $('nav-home'),
  address: $('address'),
  security: $('site-security'),
  adblockBadge: $('adblock-badge'),
  adblockCount: $('adblock-count'),
  star: $('bookmark-star'),
  suggestions: $('suggestions'),
  menuButton: $('menu-button'),
  downloadsButton: $('downloads-button'),
  downloadsBadge: $('downloads-badge'),
  zoomBadge: $('zoom-badge'),
  pipButton: $('pip-button'),

  findbar: $('findbar'),
  findInput: $('find-input'),
  findResult: $('find-result'),

  sidebar: $('sidebar'),
  sbTabHistory: $('sb-tab-history'),
  sbTabBookmarks: $('sb-tab-bookmarks'),
  sbSearch: $('sb-search'),
  sbList: $('sb-list'),
  sbClose: $('sb-close'),
  sbClear: $('sb-clear'),

  progress: $('progress'),
  progressBar: $('progress-bar'),
  toast: $('toast'),

  updateBanner: $('update-banner'),
  updateText: $('update-text'),
  updateProgress: $('update-progress'),
  updateBar: $('update-bar'),
  updateAction: $('update-action'),
  updateClose: $('update-close')
};

/* ─────────────────────────── Вспомогательные функции ─────────────────────────── */

/**
 * Всплывающее уведомление.
 *
 * Живёт внизу окна, а нативная страница вкладки рисуется ПОВЕРХ HTML-слоя,
 * поэтому под уведомление освобождается место у вкладки — иначе его просто
 * не было бы видно (см. applyFooterInsets).
 */
function showToast(text, ms = 2200) {
  el.toast.textContent = text;
  el.toast.classList.remove('hidden');
  applyFooterInsets();
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    el.toast.classList.add('hidden');
    applyFooterInsets();
  }, ms);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

function prettyUrl(url) {
  if (!url) return '';
  if (url.startsWith('kitsune://')) return url;
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return (u.host + path + u.search).replace(/\/$/, '') || u.host;
  } catch {
    return url;
  }
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'сейчас';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} д`;
  return new Date(ts).toLocaleDateString('ru-RU');
}

function iconPath(name) {
  const icons = {
    close: 'M3 3l6 6M9 3l-6 6',
    history: 'M10 3.5l2 4.1 4.5.6-3.3 3.2.8 4.5L10 13.8l-4 2.1.8-4.5L3.5 8.2l4.5-.6z'
  };
  return icons[name] || '';
}

/** Похоже ли на адрес, а не на поисковый запрос */
function looksLikeAddress(input) {
  const s = String(input || '').trim();
  if (!s || /\s/.test(s)) return false;
  if (s.startsWith('kitsune://')) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return true;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(s)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return true;
  return false;
}

function svgIcon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 12 12"><path d="${iconPath(name)}" /></svg>`;
}

/* ─────────────────────────── Полоса вкладок ─────────────────────────── */

/**
 * Узлы вкладок переиспользуются между обновлениями состояния.
 *
 * Раньше полоса вкладок полностью пересобиралась (textContent = '') на каждое
 * событие страницы: браузер заново создавал десятки элементов и перезагружал
 * favicon'ы. На тяжёлых сайтах (YouTube, соцсети) состояние приходит постоянно,
 * и UI «залипал». Теперь создаём узел один раз и обновляем только изменения.
 */
const tabNodes = new Map(); // id → { node, icon, title, badge, iconKey }
let lastScrolledActive = null;

function renderTabs() {
  const seen = new Set();
  let prev = null;

  for (const tab of ui.state.tabs) {
    seen.add(tab.id);
    let entry = tabNodes.get(tab.id);
    if (!entry) {
      entry = createTabNode(tab);
      tabNodes.set(tab.id, entry);
    }
    updateTabNode(entry, tab);

    // Порядок вкладок мог измениться — переставляем только при необходимости
    const node = entry.node;
    const anchor = prev ? prev.nextSibling : el.tabs.firstChild;
    if (anchor !== node) el.tabs.insertBefore(node, anchor);
    prev = node;
  }

  for (const [id, entry] of [...tabNodes]) {
    if (seen.has(id)) continue;
    entry.node.remove();
    tabNodes.delete(id);
  }

  // Кнопка «новая вкладка» всегда идёт последней: вкладки вставляются ПЕРЕД
  // ней (см. anchor выше), а если порядок узлов всё же разошёлся — поправляем.
  if (el.tabs.lastElementChild !== el.newTab) el.tabs.appendChild(el.newTab);

  syncActiveTabDrag();
}

/** Создаёт узел вкладки; дальше меняется только его содержимое */
function createTabNode(tab) {
  const id = tab.id;
  const node = document.createElement('div');
  node.className = 'tab';
  node.dataset.id = String(id);

  const icon = document.createElement('span');
  icon.className = 'tab-icon';

  const title = document.createElement('span');
  title.className = 'tab-title';

  const badge = document.createElement('span');
  badge.className = 'tab-blocked';
  badge.hidden = true;

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.type = 'button';
  close.tabIndex = -1;
  close.title = 'Закрыть вкладку (Ctrl+W)';
  close.innerHTML = svgIcon('close');

  // Закрытие вешаем на mousedown, а не только на click.
  // Причина: если мышь чуть сдвинулась между нажатием и отпусканием,
  // браузер начинает перетаскивание и событие click не приходит вообще —
  // именно из-за этого крестик «не работал». mousedown приходит всегда.
  // click оставляем для активации с клавиатуры; повторный вызов для
  // уже закрытой вкладки безвреден (tabs.close вернёт false).
  const closeTab = (e) => {
    if (e.button !== 0 && e.type !== 'click') return;
    e.preventDefault();
    e.stopPropagation();
    api.tabs.close(id);
  };
  close.addEventListener('mousedown', closeTab);
  close.addEventListener('click', closeTab);

  node.appendChild(icon);
  node.appendChild(title);
  node.appendChild(badge);
  node.appendChild(close);

  // Правый клик — нативное контекстное меню вкладки
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.tabs.contextMenu(id);
  });

  node.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      // Средняя кнопка мыши закрывает вкладку
      e.preventDefault();
      api.tabs.close(id);
      return;
    }
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.tab-close')) return;
    api.tabs.activate(id);
    startTabDrag(e, id);
  });

  return { node, icon, title, badge, iconKey: '' };
}

/** Обновляет во вкладке только то, что реально изменилось */
function updateTabNode(entry, tab) {
  const { node, title, badge } = entry;

  node.classList.toggle('active', tab.id === ui.state.activeId);
  node.classList.toggle('pinned', !!tab.pinned);

  const label = tab.title || prettyUrl(tab.url) || 'Новая вкладка';
  if (title.textContent !== label) title.textContent = label;

  const hint = tab.title || tab.url || 'Вкладка';
  if (node.title !== hint) node.title = hint;

  renderTabIcon(entry, tab);

  const blocked = Number(tab.blocked) || 0;
  if (blocked > 0) {
    const text = String(blocked);
    if (badge.textContent !== text) badge.textContent = text;
    badge.hidden = false;
    badge.title = `Заблокировано рекламы: ${blocked}`;
  } else {
    badge.hidden = true;
  }
}

/** Иконка вкладки: спиннер загрузки, favicon или заглушка */
function renderTabIcon(entry, tab) {
  const key = tab.loading ? 'spin' : tab.favicon ? `fav:${tab.favicon}` : 'none';
  if (entry.iconKey === key) return;
  entry.iconKey = key;

  const box = entry.icon;
  box.textContent = '';

  if (tab.loading) {
    const spin = document.createElement('div');
    spin.className = 'tab-spinner';
    box.appendChild(spin);
  } else if (tab.favicon) {
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = tab.favicon;
    img.alt = '';
    img.addEventListener('error', () => {
      const fb = document.createElement('div');
      fb.className = 'tab-favicon-fallback';
      img.replaceWith(fb);
    });
    box.appendChild(img);
  } else {
    const fb = document.createElement('div');
    fb.className = 'tab-favicon-fallback';
    box.appendChild(fb);
  }
}


/* ─────────────────────── Перетаскивание вкладок ───────────────────────
   Используем обычные mouse-события вместо HTML5 drag&drop. У HTML5-версии
   есть неприятный побочный эффект: при малейшем смещении мыши между
   нажатием и отпусканием начинается drag, событие click не приходит и
   элементы внутри вкладки (в первую очередь крестик) перестают работать.
   Свой порог в 6 пикселей полностью убирает эту проблему. */

let tabDrag = null;

/** Узел вкладки по id: DOM перерисовывается, поэтому ищем его каждый раз заново */
function tabNodeById(id) {
  return el.tabs.querySelector(`.tab[data-id="${id}"]`);
}

function startTabDrag(event, id) {
  tabDrag = { id, startX: event.clientX, startY: event.clientY, moved: false };
}

function tabNodeAt(x, y) {
  const node = document.elementFromPoint(x, y);
  return node && node.closest ? node.closest('.tab') : null;
}

function clearDropTargets() {
  for (const node of el.tabs.querySelectorAll('.drop-target')) node.classList.remove('drop-target');
}

function onTabDragMove(event) {
  if (!tabDrag) return;

  if (!tabDrag.moved) {
    const dx = Math.abs(event.clientX - tabDrag.startX);
    const dy = Math.abs(event.clientY - tabDrag.startY);
    if (dx < 6 && dy < 6) return; // ещё не перетаскивание, а обычный клик
    tabDrag.moved = true;
    document.body.classList.add('tab-dragging');
  }

  const dragged = tabNodeById(tabDrag.id);
  if (dragged) dragged.classList.add('dragging');

  clearDropTargets();
  const over = tabNodeAt(event.clientX, event.clientY);
  if (over && over !== dragged) over.classList.add('drop-target');
}

function onTabDragEnd(event) {
  if (!tabDrag) return;
  const drag = tabDrag;
  tabDrag = null;

  const dragged = tabNodeById(drag.id);
  if (dragged) dragged.classList.remove('dragging');
  document.body.classList.remove('tab-dragging');
  clearDropTargets();

  if (!drag.moved) return; // это был обычный клик — вкладка уже активирована

  const over = tabNodeAt(event.clientX, event.clientY);
  if (!over || over === dragged) return;
  const from = ui.state.tabs.findIndex((t) => t.id === drag.id);
  const to = ui.state.tabs.findIndex((t) => t.id === Number(over.dataset.id));
  if (from >= 0 && to >= 0 && from !== to) api.tabs.reorder(from, to);
}

function syncActiveTabDrag() {
  // scrollIntoView на каждое обновление состояния заставлял полосу вкладок
  // дёргаться; прокручиваем только при реальной смене активной вкладки.
  if (lastScrolledActive === ui.state.activeId) return;
  lastScrolledActive = ui.state.activeId;
  const activeNode = el.tabs.querySelector('.tab.active');
  if (activeNode) activeNode.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/* ─────────────────────────── Тулбар и адресная строка ─────────────────────────── */

function renderToolbar() {
  const a = ui.state.active;

  // Вкладок нет (возможно, если отключено автосоздание стартовой страницы) —
  // приводим полосу в нейтральное состояние, чтобы окно не выглядело «зависшим».
  // Адресную строку не трогаем: во время закрытия вкладки состояние на миг
  // бывает «пустым», и затирание адреса выглядело как сбой.
  if (!a) {
    el.back.disabled = true;
    el.forward.disabled = true;
    el.adblockCount.textContent = '0';
    el.star.classList.remove('filled');
    el.zoomBadge.classList.add('hidden');
    el.pipButton.classList.add('hidden');
    return;
  }

  el.back.disabled = !a.canGoBack;
  el.forward.disabled = !a.canGoForward;

  // Адрес обновляем всегда, кроме случая, когда пользователь прямо сейчас
  // набирает текст: тогда затирать ввод нельзя. Раньше здесь дополнительно
  // проверялся document.activeElement, из-за чего адрес «залипал» на первой
  // странице и не менялся при переключении вкладок.
  if (!ui.editingAddress) {
    el.address.value = a.url || '';
  }

  // Индикатор безопасности
  el.security.classList.remove('insecure', 'internal');
  if (a.isInternal) {
    el.security.classList.add('internal');
    el.security.title = 'Внутренняя страница Kitsune';
  } else if (a.isSecure) {
    el.security.title = 'Соединение защищено (HTTPS)';
  } else {
    el.security.classList.add('insecure');
    el.security.title = 'Небезопасное соединение (HTTP)';
  }

  // Счётчик блокировок
  const blocked = a.blocked || 0;
  el.adblockCount.textContent = String(blocked);
  const on = ui.state.adblock.enabled !== false;
  el.adblockBadge.classList.toggle('off', !on);
  el.adblockBadge.title = on
    ? `Заблокировано на этой странице: ${blocked}. Правил в списке: ${ui.state.adblock.rules}`
    : 'Блокировка рекламы выключена';

  renderZoomBadge(a);
  renderPipButton(a);
  renderStar();
}

/**
 * Кнопка «смотреть в окне».
 *
 * Показывается только тогда, когда на странице активной вкладки есть
 * воспроизводимое видео (состояние присылает main-процесс) — как в Firefox,
 * где кнопка появляется в адресной строке на время воспроизведения.
 */
function renderPipButton(active) {
  const pip = ui.state.pip || {};
  const inPip = !!pip.inPip;
  const show = !active.isInternal && (!!pip.playing || inPip);
  el.pipButton.classList.toggle('hidden', !show);
  if (!show) return;
  el.pipButton.title = inPip
    ? 'Вернуть видео на страницу'
    : 'Смотреть видео в отдельном окне (как в Firefox)';
  el.pipButton.classList.toggle('active', inPip);
}

/** Показывает бейдж масштаба, если он отличается от 100 % */
function renderZoomBadge(active) {
  const level = Number(active && active.zoom) || 0;
  if (!level) {
    el.zoomBadge.classList.add('hidden');
    return;
  }
  const percent = Math.round(Math.pow(1.2, level) * 100);
  el.zoomBadge.textContent = `${percent}%`;
  el.zoomBadge.title = `Масштаб страницы ${percent}%. Нажмите, чтобы вернуть 100%`;
  el.zoomBadge.classList.remove('hidden');
}

function renderStar() {
  const url = ui.state.active ? ui.state.active.url : '';
  const filled = !!url && ui.bookmarkUrls.has(url);
  el.star.classList.toggle('filled', filled);
  el.star.title = filled ? 'Убрать из закладок' : 'Добавить в закладки';
}

function renderProgress() {
  const a = ui.state.active;
  const loading = a && a.loading;
  if (loading) {
    clearInterval(ui.progressTimer);
    el.progress.classList.remove('hidden', 'done');
    let p = 8;
    el.progressBar.style.width = p + '%';
    ui.progressTimer = setInterval(() => {
      p = Math.min(p + Math.random() * 14, 92);
      el.progressBar.style.width = p + '%';
    }, 220);
  } else if (!el.progress.classList.contains('hidden')) {
    clearInterval(ui.progressTimer);
    el.progressBar.style.width = '100%';
    el.progress.classList.add('done');
    setTimeout(() => {
      el.progress.classList.add('hidden');
      el.progress.classList.remove('done');
      el.progressBar.style.width = '0';
    }, 280);
  }
}

/** Применяет полное состояние, приходящее из main-процесса */
function applyState(state) {
  if (!state) return;
  const prevActiveId = ui.state.activeId;
  ui.state = state;

  // Переключились на другую вкладку — «черновик» в адресной строке не нужен
  if (state.activeId !== prevActiveId) ui.editingAddress = false;

  renderTabs();
  renderToolbar();
  renderProgress();
  document.title = state.active && state.active.title
    ? `${state.active.title} — ${K.APP_NAME}`
    : K.APP_NAME;
}

/* ─────────────────────────── Подсказки адресной строки ─────────────────────────── */

let suggestToken = 0;
let suggestDebounce = null;

function onAddressInput() {
  ui.editingAddress = true;
  const query = el.address.value.trim();
  clearTimeout(suggestDebounce);

  if (!query) {
    hideSuggestions();
    return;
  }

  suggestDebounce = setTimeout(async () => {
    const token = ++suggestToken;
    let result;
    try {
      result = await api.search.suggest(query);
    } catch {
      // Подсказки — необязательная функция. Ошибка сети/IPC не должна
      // превращать ввод адреса в необработанный rejected Promise.
      result = { local: [], remote: [] };
    }
    if (token !== suggestToken) return;
    renderSuggestions(query, result && result.local || [], result && result.remote || []);
  }, 90);
}

function renderSuggestions(query, local, remote) {
  const items = [];

  // Прямое открытие введённого адреса
  if (looksLikeAddress(query)) {
    items.push({ kind: 'url', title: query, url: query });
  }

  for (const l of local) {
    items.push({ kind: l.type, title: l.title, url: l.url, removable: l.type === 'history' });
  }
  for (const r of remote) {
    // не дублируем прямой поиск введённого текста
    if (r.toLowerCase() === query.toLowerCase()) continue;
    items.push({ kind: 'search', title: r, search: r });
  }

  // Всегда даём возможность просто выполнить поиск по введённому тексту
  if (!looksLikeAddress(query)) {
    items.push({ kind: 'search', title: query, search: query });
  }

  ui.suggestions = items;
  ui.selectedSuggestion = -1;

  if (!items.length) {
    hideSuggestions();
    return;
  }

  el.suggestions.textContent = '';
  items.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.className = 'suggestion';
    btn.dataset.index = String(index);

    const type = document.createElement('span');
    type.className = 's-type';
    type.textContent =
      item.kind === 'bookmark' ? 'закладка'
        : item.kind === 'history' ? 'история'
          : item.kind === 'url' ? 'перейти'
            : 'поиск';
    btn.appendChild(type);

    const text = document.createElement('span');
    text.className = 's-text';
    text.textContent = item.title || item.url;
    btn.appendChild(text);

    if (item.kind === 'search') {
      const hint = document.createElement('span');
      hint.className = 's-hint';
      hint.textContent = 'DuckDuckGo';
      btn.appendChild(hint);
    }

    if (item.removable && item.url) {
      const del = document.createElement('span');
      del.className = 's-del';
      del.textContent = '✕';
      del.title = 'Удалить из истории';
      del.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await api.history.remove(item.url);
        renderSuggestions(query, await api.history.list({ query, limit: 6 }), remote);
      });
      btn.appendChild(del);
    }

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      commitSuggestion(index);
    });

    el.suggestions.appendChild(btn);
  });

  el.suggestions.classList.remove('hidden');
  reserveSuggestions();
}

function hideSuggestions() {
  el.suggestions.classList.add('hidden');
  el.suggestions.textContent = '';
  ui.suggestions = [];
  ui.selectedSuggestion = -1;
  reserveSuggestions();
}

function commitSuggestion(index) {
  const item = ui.suggestions[index];
  if (!item) return;
  ui.editingAddress = false;
  hideSuggestions();
  if (item.search) navigate(item.search);
  else navigate(item.url);
}

function moveSuggestion(delta) {
  if (!ui.suggestions.length) return;
  const next = Math.max(0, Math.min(ui.suggestions.length - 1, ui.selectedSuggestion + delta));
  ui.selectedSuggestion = next;
  [...el.suggestions.children].forEach((child, i) => {
    child.classList.toggle('selected', i === next);
  });
  const selected = el.suggestions.children[next];
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

/* ─────────────────────────── Навигация ─────────────────────────── */

function navigate(input) {
  ui.editingAddress = false;
  api.tabs.navigate(input);
}

function commitAddress() {
  const value = el.address.value.trim();
  hideSuggestions();
  ui.editingAddress = false;
  if (!value) return;
  navigate(value);
  el.address.blur();
}

/** Отменяет черновик в адресной строке и возвращает URL активной вкладки. */
function cancelAddressEdit() {
  const active = ui.state.active;
  hideSuggestions();
  ui.editingAddress = false;
  el.address.value = active && active.url ? active.url : '';
  el.address.blur();
}

/* ─────────────────────────── Автообновление ───────────────────────────
   Полоса обновления и всплывающие уведомления живут в нижней части окна, а
   нативная страница вкладки рисуется поверх HTML-слоя. Поэтому под них
   освобождается место у активной вкладки — footer в TabManager.setInsets. */

const UPDATE_QUIET = ['idle', 'current', 'unsupported'];

/** Высота нижних уведомлений, под которую надо сдвинуть страницу */
function footerInsets() {
  const banner = el.updateBanner.classList.contains('hidden') ? 0 : el.updateBanner.offsetHeight + 26;
  const toast = el.toast.classList.contains('hidden') ? 0 : el.toast.offsetHeight + 26;
  return Math.max(banner, toast);
}

function applyFooterInsets() {
  applyInsets({ footer: footerInsets() });
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

function hideUpdateBanner() {
  el.updateBanner.classList.add('hidden');
  applyFooterInsets();
}

/** Отрисовка состояния, которое присылает main-процесс (updater:status) */
function renderUpdate(state) {
  ui.updateState = state || null;
  if (!state) return;

  // Ошибку автопроверки не показываем: пользователь её не запрашивал
  const quiet = UPDATE_QUIET.includes(state.status) || (state.status === 'error' && !state.manual);

  if (state.status === 'current' && state.manual) {
    showToast('У вас последняя версия Kitsune', 3000);
  }

  if (quiet || ui.updateDismissedFor === state.status) {
    hideUpdateBanner();
    return;
  }

  el.updateText.textContent =
    state.status === 'checking'
      ? 'Проверяем обновления…'
      : state.status === 'available'
        ? `Доступна версия ${state.version} — скачиваем…`
        : state.status === 'downloading'
          ? `Скачиваем обновление ${state.version || ''} · ${state.percent}%` +
            (state.total ? ` (${formatBytes(state.transferred)} из ${formatBytes(state.total)})` : '')
          : state.status === 'ready'
            ? `Версия ${state.version} загружена — перезапустите, чтобы обновиться`
            : state.message || 'Не удалось проверить обновления';

  const busy = state.status === 'downloading' || state.status === 'available' || state.status === 'checking';
  el.updateProgress.classList.toggle('hidden', !busy);
  el.updateBar.style.width = `${busy ? Math.max(state.status === 'checking' ? 8 : 0, state.percent || 0) : 0}%`;

  // Для неподписанных сборок обновление скачивается только вручную.
  const action = state.status === 'ready' ? 'install' :
    ['error', 'available', 'unsupported'].includes(state.status) ? 'releases' : '';
  el.updateAction.dataset.action = action;
  el.updateAction.textContent = action === 'install' ? 'Перезапустить и обновить' : 'Открыть страницу релизов';
  el.updateAction.classList.toggle('hidden', !action);

  el.updateBanner.classList.remove('hidden');
  applyFooterInsets();
}

/* ─────────────────────────── Меню и резерв места под выпадающие элементы ───────────────────────────
   Нативный WebContentsView вкладки рисуется ПОВЕРХ HTML-слоя окна. Поэтому
   всё, что UI рисует ниже 88px «хрома» (меню, подсказки адресной строки,
   боковая панель), оказывается под страницей — его не видно и невозможно
   нажать. Отсюда два решения:
     • меню-«гамбургер» рисует main-процесс нативным Menu.popup();
     • под подсказки и боковую панель main-процесс сдвигает вкладку
       (TabManager.setInsets), освобождая место под HTML-слоем. */

const insets = { overlayBottom: 0, sidebarRight: 0, footer: 0 };
let insetsTimer = null;

/** Просит main-процесс освободить место у активной вкладки */
function applyInsets(patch) {
  const next = {
    overlayBottom: Math.max(0, Math.round(patch.overlayBottom ?? insets.overlayBottom)),
    sidebarRight: Math.max(0, Math.round(patch.sidebarRight ?? insets.sidebarRight)),
    footer: Math.max(0, Math.round(patch.footer ?? insets.footer))
  };
  if (
    next.overlayBottom === insets.overlayBottom &&
    next.sidebarRight === insets.sidebarRight &&
    next.footer === insets.footer
  ) {
    return;
  }
  insets.overlayBottom = next.overlayBottom;
  insets.sidebarRight = next.sidebarRight;
  insets.footer = next.footer;

  // Склейка: при наборе текста список подсказок меняет высоту, а каждое
  // изменение размера заставляет страницу пересчитывать layout.
  clearTimeout(insetsTimer);
  insetsTimer = setTimeout(() => {
    api.ui.setInsets({
      overlayBottom: insets.overlayBottom,
      sidebarRight: insets.sidebarRight,
      footer: insets.footer
    });
  }, 60);
}

/** Освобождает высоту под выпадающий список подсказок */
function reserveSuggestions() {
  if (el.suggestions.classList.contains('hidden')) {
    applyInsets({ overlayBottom: 0 });
    return;
  }
  applyInsets({ overlayBottom: Math.min(el.suggestions.offsetHeight + 8, 348) });
}

function openAppMenu() {
  const rect = el.menuButton.getBoundingClientRect();
  api.ui.appMenu({ x: rect.left, y: rect.bottom + 2 });
}


/* ─────────────────────────── Закрытые вкладки ───────────────────────────
   Стек закрытых вкладок живёт в main-процессе (см. tabs.js): «переоткрыть»
   доступно из нативного меню и по Ctrl+Shift+T и работает одинаково, даже
   если UI-слой перезагрузился. Тост о результате показывает main-процесс
   (событие ui:toast). */

/* ─────────────────────────── Боковая панель ─────────────────────────── */

function openSidebar(mode) {
  ui.sidebarMode = mode || ui.sidebarMode;
  el.sidebar.classList.remove('hidden');
  // Боковая панель — часть окна: отдаём ей место, а не закрываем страницу
  applyInsets({ sidebarRight: 340 });
  el.sbTabHistory.classList.toggle('active', ui.sidebarMode === 'history');
  el.sbTabBookmarks.classList.toggle('active', ui.sidebarMode === 'bookmarks');
  el.sbClear.textContent = ui.sidebarMode === 'history' ? 'Очистить историю' : 'Открыть все закладки';
  el.sbSearch.placeholder = ui.sidebarMode === 'history' ? 'Поиск по истории...' : 'Поиск по закладкам...';
  loadSidebar();
}

function closeSidebar() {
  el.sidebar.classList.add('hidden');
  applyInsets({ sidebarRight: 0 });
}

function openDownloads() {
  api.tabs.navigate('kitsune://downloads');
}

function renderDownloadsButton(items) {
  const active = (items || []).filter((item) => item.status === 'downloading');
  if (!active.length) {
    el.downloadsBadge.classList.add('hidden');
    el.downloadsButton.title = 'Загрузки';
    return;
  }
  const total = active.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const received = active.reduce((sum, item) => sum + (Number(item.received) || 0), 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(received / total * 100))) : null;
  el.downloadsBadge.textContent = percent === null ? String(active.length) : `${percent}%`;
  el.downloadsBadge.classList.remove('hidden');
  el.downloadsButton.title = `${active.length} активн. загрузок${percent === null ? '' : ` · ${percent}%`}`;
}

async function refreshDownloadsButton() {
  try {
    renderDownloadsButton(await api.downloads.list());
  } catch {
    renderDownloadsButton([]);
  }
}

async function loadSidebar() {
  const query = el.sbSearch.value.trim();
  el.sbList.textContent = '';

  const items = ui.sidebarMode === 'history'
    ? await api.history.list({ query, limit: 300 })
    : await api.bookmarks.list();

  const filtered = ui.sidebarMode === 'bookmarks' && query
    ? items.filter((i) => `${i.title} ${i.url}`.toLowerCase().includes(query.toLowerCase()))
    : items;

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = ui.sidebarMode === 'history'
      ? 'История пуста'
      : 'Закладок пока нет — нажмите ★ в адресной строке';
    el.sbList.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    const row = document.createElement('div');
    row.className = 'sb-item';

    const main = document.createElement('div');
    main.className = 'sb-item-main';

    const title = document.createElement('div');
    title.className = 'sb-item-title';
    title.textContent = item.title || item.url;

    const url = document.createElement('div');
    url.className = 'sb-item-url';
    url.textContent = item.url;

    main.appendChild(title);
    main.appendChild(url);
    row.appendChild(main);

    if (item.time) {
      const time = document.createElement('span');
      time.className = 'sb-item-time';
      time.textContent = timeAgo(item.time);
      row.appendChild(time);
    }

    const del = document.createElement('button');
    del.className = 'sb-item-del';
    del.textContent = '✕';
    del.title = ui.sidebarMode === 'history' ? 'Удалить из истории' : 'Удалить закладку';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (ui.sidebarMode === 'history') await api.history.remove(item.url);
      else {
        await api.bookmarks.remove(item.url);
        ui.bookmarkUrls.delete(item.url);
      }
      loadSidebar();
      renderStar();
    });
    row.appendChild(del);

    row.addEventListener('click', () => {
      api.tabs.navigate(item.url);
      closeSidebar();
    });

    el.sbList.appendChild(row);
  }
}

async function refreshBookmarkCache() {
  const list = await api.bookmarks.list();
  ui.bookmarkUrls = new Set(list.map((b) => b.url));
}

/* ─────────────────────────── Поиск на странице ─────────────────────────── */

function openFindBar() {
  el.findbar.classList.remove('hidden');
  el.findInput.focus();
  el.findInput.select();
}

function closeFindBar() {
  el.findbar.classList.add('hidden');
  el.findResult.textContent = '';
  api.find.stop();
}

async function runFind({ forward = true, findNext = false } = {}) {
  const text = el.findInput.value;
  if (!text) {
    el.findResult.textContent = '';
    api.find.stop();
    return;
  }
  const { matches } = await api.find.start(text, { forward, findNext });
  el.findResult.textContent = matches ? `${matches} совп.` : 'нет';
}

/* ─────────────────────────── Привязка событий ─────────────────────────── */

function bindEvents() {
  // ── Вкладки ──
  el.newTab.addEventListener('click', () => api.tabs.create({ url: 'kitsune://home' }));
  el.tabs.addEventListener('dblclick', (e) => {
    if (e.target === el.tabs) api.tabs.create({ url: 'kitsune://home' });
  });

  // Перетаскивание вкладок: слушаем документ, чтобы не терять курсор
  document.addEventListener('mousemove', onTabDragMove);
  document.addEventListener('mouseup', onTabDragEnd);

  // ── Кнопки окна ──
  el.winMin.addEventListener('click', () => api.window.minimize());
  el.winMax.addEventListener('click', () => api.window.maximize());
  el.winClose.addEventListener('click', () => api.window.close());

  // ── Навигация ──
  el.back.addEventListener('click', () => api.tabs.back());
  el.forward.addEventListener('click', () => api.tabs.forward());
  el.reload.addEventListener('click', () => {
    const a = ui.state.active;
    if (a && a.loading) api.tabs.stop();
    else api.tabs.reload();
  });
  el.home.addEventListener('click', () => api.tabs.home());

  // ── Адресная строка ──
  el.address.addEventListener('input', onAddressInput);
  el.address.addEventListener('focus', () => {
    el.address.select();
  });
  el.address.addEventListener('blur', () => {
    setTimeout(() => {
      ui.editingAddress = false;
      hideSuggestions();
      renderToolbar();
    }, 120);
  });
  el.address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (ui.selectedSuggestion >= 0) commitSuggestion(ui.selectedSuggestion);
      else commitAddress();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSuggestion(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSuggestion(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelAddressEdit();
    }
  });

  // ── Счётчик блокировок, закладка и загрузки ──
  el.adblockBadge.addEventListener('click', () => navigate('kitsune://blocked'));
  el.star.addEventListener('click', onToggleBookmark);
  el.zoomBadge.addEventListener('click', () => api.tabs.zoomReset());
  el.downloadsButton.addEventListener('click', openDownloads);

  // ── Боковая панель ──
  el.sbClose.addEventListener('click', closeSidebar);
  el.sbTabHistory.addEventListener('click', () => openSidebar('history'));
  el.sbTabBookmarks.addEventListener('click', () => openSidebar('bookmarks'));
  el.sbSearch.addEventListener('input', loadSidebar);
  el.sbClear.addEventListener('click', async () => {
    if (ui.sidebarMode === 'history') {
      await api.history.clear();
      await loadSidebar();
      showToast('История очищена');
    } else {
      await api.bookmarks.openAll();
    }
  });

  // ── «Смотреть в окне» (picture-in-picture) ──
  // Видео ищет main-процесс на самой странице (executeJavaScript с
  // userGesture — без него Chromium запрещает requestPictureInPicture).
  el.pipButton.addEventListener('click', () => api.pip.toggle());

  // ── Меню (нативное, рисуется main-процессом) ──
  el.menuButton.addEventListener('click', (e) => {
    e.stopPropagation();
    openAppMenu();
  });

  // ── Полоса обновления ──
  el.updateAction.addEventListener('click', async () => {
    if (el.updateAction.dataset.action === 'install') {
      el.updateAction.disabled = true;
      el.updateAction.textContent = 'Перезапускаем…';
      await api.updater.install();
      return;
    }
    api.updater.openReleases();
  });
  el.updateClose.addEventListener('click', () => {
    ui.updateDismissedFor = (ui.updateState && ui.updateState.status) || '';
    hideUpdateBanner();
  });

  document.addEventListener('click', (e) => {
    if (!el.suggestions.classList.contains('hidden') && !el.suggestions.contains(e.target) && e.target !== el.address) {
      hideSuggestions();
    }
  });
}

async function onToggleBookmark() {
  const a = ui.state.active;
  if (!a || !a.url || a.isInternal) {
    showToast('Эту страницу нельзя добавить в закладки');
    return;
  }
  const added = await api.bookmarks.toggle({ url: a.url, title: a.title });
  await refreshBookmarkCache();
  renderStar();
  showToast(added ? 'Добавлено в закладки' : 'Удалено из закладок');
}

/* ─────────────────────────── Горячие клавиши ───────────────────────────
   Все комбинации обрабатываются в main-процессе (см. handleShortcut в
   main.js) через `before-input-event`. Так они работают и когда фокус
   находится внутри веб-страницы, а не в полосе браузера. Здесь остаются
   только действия, которые касаются самого UI: закрыть меню, панель,
   подсказки — то есть реакция на Escape. */

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSidebar();
      hideSuggestions();
      closeFindBar();
      return;
    }
    // Ctrl+Q — единственная комбинация, которую удобнее закрыть именно здесь:
    // она не относится к вкладкам и не должна перехватываться страницей.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      api.window.close();
    }
  });
}

/* ─────────────────────────── Подписки на события main-процесса ─────────────────────────── */

function subscribe() {
  api.on('tabs:state', (state) => {
    applyState(state);
  });

  api.on('app:info', (info) => {
    ui.appInfo = info;
    if (info && info.adblock) {
      ui.state.adblock = { ...ui.state.adblock, ...info.adblock };
    }
    renderToolbar();
  });

  api.on('settings:changed', (settings) => {
    if (ui.appInfo) ui.appInfo.settings = settings;
    const on = settings.adblockEnabled !== false;
    ui.state.adblock.enabled = on;
    renderToolbar();
  });

  api.on('adblock:state', (payload) => {
    ui.state.adblock = { ...ui.state.adblock, ...payload };
    renderToolbar();
  });

  api.on('adblock:count', ({ count, total }) => {
    if (ui.state.active) ui.state.active.blocked = count;
    ui.state.adblock.blockedTotal = total;
    el.adblockCount.textContent = String(count);
    const activeTab = ui.state.tabs.find((t) => t.id === ui.state.activeId);
    if (activeTab) {
      activeTab.blocked = count;
      const node = el.tabs.querySelector(`.tab[data-id="${activeTab.id}"]`);
      if (node) {
        let badge = node.querySelector('.tab-blocked');
        if (count > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tab-blocked';
            node.insertBefore(badge, node.querySelector('.tab-close'));
          }
          badge.textContent = String(count);
        } else if (badge) {
          badge.remove();
        }
      }
    }
  });

  api.on('tab:load-error', ({ description, url }) => {
    showToast(`Не удалось открыть страницу: ${description || 'ошибка'}`, 3600);
    console.warn('[Kitsune] Ошибка загрузки:', url, description);
  });

  api.on('ui:focus-find', () => openFindBar());
  api.on('ui:open-history', () => openSidebar('history'));
  api.on('ui:open-bookmarks', () => openSidebar('bookmarks'));
  api.on('ui:focus-address', () => {
    el.address.focus();
    el.address.select();
  });
  api.on('ui:toggle-bookmark', () => onToggleBookmark());
  api.on('downloads:changed', (items) => renderDownloadsButton(items));
  api.on('ui:toast', ({ text }) => showToast(String(text || '')));

  api.on('window:html-fullscreen', ({ value }) => {
    document.documentElement.classList.toggle('html-fullscreen', !!value);
  });

  api.on('updater:status', (state) => {
    // Новый статус — снимаем «скрыто пользователем»
    if (state && ui.updateState && state.status !== ui.updateState.status) ui.updateDismissedFor = '';
    renderUpdate(state);
  });
}

/* ─────────────────────────── Инициализация ─────────────────────────── */

async function init() {
  bindEvents();
  bindShortcuts();
  subscribe();

  await refreshBookmarkCache();
  await refreshDownloadsButton();

  const info = await api.getAppInfo();
  ui.appInfo = info;
  const state = await api.getState();
  applyState(state);

  // Заполняем placeholder адресной строки названием поисковика
  if (info && info.settings) {
    const engine = (info.searchEngines || []).find((s) => s.id === info.settings.searchEngine);
    el.address.placeholder = `Поиск в ${engine ? engine.name : 'DuckDuckGo'} или адрес сайта`;
  }

  el.address.focus();

  // Состояние автообновления на момент старта (проверка идёт с задержкой)
  try {
    renderUpdate(await api.updater.state());
  } catch {
    /* старые сборки без updater — молча пропускаем */
  }

  console.log(`[Kitsune] UI готов. Версия ${info ? info.version : '?'}, правил блокировки: ${state.adblock.rules}`);
}

window.addEventListener('DOMContentLoaded', init);

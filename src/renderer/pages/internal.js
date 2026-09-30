'use strict';

/**
 * internal.js — логика внутренних страниц Kitsune
 * (kitsune://home, kitsune://settings, kitsune://blocked, kitsune://about).
 *
 * Скрипт общий для всех страниц: каждая инициализируется только если
 * на странице есть её корневой элемент.
 */

const api = window.kitsune;

/** Определяем текущую страницу по наличию характерных элементов */
function currentPage() {
  if (document.getElementById('search-form')) return 'home';
  if (document.getElementById('search-engine')) return 'settings';
  if (document.getElementById('s-blocked')) return 'blocked';
  if (document.getElementById('pw-list')) return 'passwords';
  if (document.getElementById('download-list')) return 'downloads';
  if (document.getElementById('v-app')) return 'about';
  return null;
}

/* ─────────────────────────── Новая вкладка ─────────────────────────── */

async function initHome() {
  const form = document.getElementById('search-form');
  const input = document.getElementById('q');

  // Навешиваем действия до запросов к main-процессу. Если история или
  // статистика временно недоступны, новая вкладка всё равно должна искать и
  // открывать быстрые ссылки.
  const navigateHome = (target) => {
    const value = String(target || '').trim();
    if (!value) return;
    let result;
    try {
      result = api.tabs.navigate(value);
    } catch {
      return;
    }
    Promise.resolve(result).catch(() => {
      // IPC может завершиться ошибкой во время закрытия вкладки — это не
      // должно превращаться в необработанное исключение страницы.
    });
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    navigateHome(q);
  });

  document.getElementById('go-search').addEventListener('click', () => {
    navigateHome(input.value);
  });

  document.getElementById('go-lucky').addEventListener('click', () => {
    const q = input.value.trim();
    if (q) navigateHome(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&kl=wt-wt`);
  });

  try {
    const info = await api.getAppInfo();
    const engine = (info.searchEngines || []).find((s) => s.id === info.settings.searchEngine);
    if (engine) input.placeholder = `Поиск в ${engine.name}`;
  } catch {
    // Оставляем безопасный placeholder из HTML.
  }

  // Статистика блокировщика
  const foot = document.getElementById('stats');
  try {
    const stats = await api.adblock.stats();
    foot.textContent = '';
    if (stats.enabled) {
      foot.append('Блокировщик рекламы активен · правил: ');
      const b1 = document.createElement('b');
      b1.textContent = String(stats.rules);
      foot.appendChild(b1);
      foot.append(' · заблокировано: ');
      const b2 = document.createElement('b');
      b2.textContent = String(stats.blockedTotal);
      foot.appendChild(b2);
    } else {
      foot.append('Блокировщик рекламы выключен · включить можно в настройках');
    }
  } catch {
    // Статистика не является условием работы поиска.
  }

  // Быстрые ссылки: частые сайты из истории
  const hosts = new Map();
  let historyItems = [];
  try {
    historyItems = await api.history.list({ limit: 300 });
  } catch {
    historyItems = [];
  }
  for (const item of historyItems) {
    if (!item.url || item.url.startsWith('kitsune://')) continue;
    let host;
    try {
      host = new URL(item.url).host;
    } catch {
      continue;
    }
    const entry = hosts.get(host) || { host, count: 0, url: item.url };
    entry.count++;
    hosts.set(host, entry);
  }

  const top = [...hosts.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  const box = document.getElementById('shortcuts');
  box.textContent = '';

  for (const site of top) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shortcut';
    btn.title = site.url;

    const fav = document.createElement('span');
    fav.className = 'fav';
    const img = document.createElement('img');
    img.src = `https://icons.duckduckgo.com/ip3/${site.host}.ico`;
    img.alt = '';
    img.onerror = () => {
      fav.textContent = site.host.charAt(0).toUpperCase();
    };
    fav.appendChild(img);

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = site.host.replace(/^www\./, '');

    btn.appendChild(fav);
    btn.appendChild(lbl);
    btn.addEventListener('click', () => navigateHome(site.url));
    box.appendChild(btn);
  }

  input.focus();
}

/* ─────────────────────────── Настройки ─────────────────────────── */

async function initSettings() {
  const info = await api.getAppInfo();
  let settings = info.settings;

  const engineSelect = document.getElementById('search-engine');
  engineSelect.textContent = '';
  for (const engine of info.searchEngines || []) {
    const opt = document.createElement('option');
    opt.value = engine.id;
    opt.textContent = engine.name;
    opt.title = engine.description || '';
    engineSelect.appendChild(opt);
  }

  const refs = {
    engine: engineSelect,
    safe: document.getElementById('safe-search'),
    home: document.getElementById('home-page'),
    adblock: document.getElementById('adblock-enabled'),
    popups: document.getElementById('block-popups'),
    restore: document.getElementById('restore-tabs'),
    closeLast: document.getElementById('close-last-tab'),
    savePasswords: document.getElementById('save-passwords'),
    autofill: document.getElementById('autofill-passwords'),
    autoUpdate: document.getElementById('auto-update')
  };

  const rulesEl = document.getElementById('adblock-rules');
  const totalEl = document.getElementById('blocked-total');
  const pwInfo = document.getElementById('passwords-info');
  const defaultBrowserStatus = document.getElementById('default-browser-status');
  const defaultBrowserButton = document.getElementById('default-browser-button');
  const permissionList = document.getElementById('site-permissions');
  const permissionsEmpty = document.getElementById('permissions-empty');

  async function refreshPermissions() {
    const list = await api.permissions.list();
    permissionList.textContent = '';
    permissionsEmpty.classList.toggle('hidden', list.length > 0);
    for (const item of list) {
      const row = document.createElement('div');
      row.className = 'permission-row';
      const origin = document.createElement('span');
      origin.className = 'permission-origin';
      origin.textContent = item.origin;
      origin.title = item.origin;
      const names = document.createElement('span');
      names.className = 'permission-names';
      names.textContent = item.permissions.map((name) => ({ geolocation: 'геолокация', microphone: 'микрофон', camera: 'вебкамера' }[name] || name)).join(', ');
      const revoke = document.createElement('button');
      revoke.className = 'btn ghost';
      revoke.textContent = 'Отозвать';
      revoke.addEventListener('click', async () => { await api.permissions.revoke(item.origin); await refreshPermissions(); });
      row.append(origin, names, revoke);
      permissionList.appendChild(row);
    }
  }

  async function refreshDefaultBrowser() {
    const state = await api.defaultBrowser.state();
    if (!state || !state.supported) {
      defaultBrowserStatus.textContent = 'Эта функция доступна только в Windows.';
      defaultBrowserButton.disabled = true;
      return;
    }
    defaultBrowserStatus.textContent = state.current
      ? 'Kitsune уже выбран браузером по умолчанию.'
      : 'Kitsune пока не выбран браузером по умолчанию. Windows попросит подтвердить выбор.';
    defaultBrowserButton.textContent = state.current ? 'Изменить в Windows' : 'Сделать браузером по умолчанию';
  }

  function fill(s) {
    refs.engine.value = s.searchEngine;
    refs.safe.value = s.safeSearch;
    refs.home.value = s.homePage;
    refs.adblock.checked = !!s.adblockEnabled;
    refs.popups.checked = !!s.blockPopups;
    refs.restore.checked = !!s.restoreTabs;
    refs.closeLast.checked = s.closeLastTabOpensNewTab !== false;
    refs.savePasswords.checked = s.savePasswords !== false;
    refs.autofill.checked = s.autofillPasswords !== false;
    refs.autoUpdate.checked = s.autoUpdate !== false;
  }

  async function refreshStats() {
    const s = await api.adblock.stats();
    rulesEl.textContent = `Загружено правил: ${s.rules} · скрытие элементов: ${s.cosmeticRules || 0}`;
    totalEl.textContent = String(s.blockedTotal);
  }

  async function refreshPasswords() {
    const info = await api.getAppInfo();
    const data = info.passwords || { count: 0, secure: false };
    pwInfo.textContent = data.count
      ? `Сохранено входов: ${data.count}. ${data.secure ? 'Шифрование системы включено.' : 'Системное шифрование недоступно.'}`
      : 'Хранилище пустое — Kitsune предложит сохранить пароль при входе на сайт.';
  }

  async function save(patch) {
    settings = await api.settings.set(patch);
    fill(settings);
    await refreshStats();
  }

  fill(settings);
  await refreshStats();
  await refreshPasswords();
  await refreshPermissions();
  await refreshDefaultBrowser();

  refs.engine.addEventListener('change', () => save({ searchEngine: refs.engine.value }));
  refs.safe.addEventListener('change', () => save({ safeSearch: refs.safe.value }));
  refs.home.addEventListener('change', () => save({ homePage: refs.home.value.trim() || 'kitsune://home' }));
  refs.adblock.addEventListener('change', () => save({ adblockEnabled: refs.adblock.checked }));
  refs.popups.addEventListener('change', () => save({ blockPopups: refs.popups.checked }));
  refs.restore.addEventListener('change', () => save({ restoreTabs: refs.restore.checked }));
  refs.closeLast.addEventListener('change', () =>
    save({ closeLastTabOpensNewTab: refs.closeLast.checked })
  );
  refs.savePasswords.addEventListener('change', () =>
    save({ savePasswords: refs.savePasswords.checked })
  );
  refs.autofill.addEventListener('change', () =>
    save({ autofillPasswords: refs.autofill.checked })
  );
  document
    .getElementById('open-passwords')
    .addEventListener('click', () => api.tabs.navigate('kitsune://passwords'));
  defaultBrowserButton.addEventListener('click', async () => {
    await api.defaultBrowser.openSettings();
    defaultBrowserStatus.textContent = 'Выберите Kitsune для HTTP, HTTPS и HTML в открывшемся окне Windows.';
  });
  document.getElementById('clear-permissions').addEventListener('click', async () => {
    const ok = await api.confirm('Удалить разрешения', 'Отозвать все постоянные разрешения сайтов?');
    if (ok) { await api.permissions.clear(); await refreshPermissions(); }
  });

  const ruleInput = document.getElementById('custom-rule');
  const addRule = async () => {
    const rule = ruleInput.value.trim();
    if (!rule) return;
    const res = await api.adblock.addRule(rule);
    ruleInput.value = '';
    await refreshStats();
    rulesEl.textContent = res.added
      ? `Правило добавлено · всего правил: ${res.rules}`
      : 'Правило не распознано — проверьте синтаксис';
    rulesEl.style.color = res.added ? '#46c07a' : '#ef5a5a';
    setTimeout(() => {
      rulesEl.style.color = '';
      refreshStats();
    }, 2400);
  };

  document.getElementById('add-rule').addEventListener('click', addRule);
  ruleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addRule();
  });

  document.getElementById('open-blocklist').addEventListener('click', () => api.tabs.navigate('kitsune://blocked'));
  document.getElementById('reset-stats').addEventListener('click', async () => {
    await api.adblock.resetStats();
    await refreshStats();
  });

  document.getElementById('reset-settings').addEventListener('click', async () => {
    const ok = await api.confirm('Сброс настроек', 'Вернуть все настройки Kitsune к значениям по умолчанию?');
    if (!ok) return;
    settings = await api.settings.reset();
    fill(settings);
    await refreshStats();
  });

  /* ── Обновления ── */

  const updateInfo = document.getElementById('update-info');
  const updateNotes = document.getElementById('update-notes');
  const checkButton = document.getElementById('check-updates');

  function renderUpdate(st) {
    if (!st) return;
    const channel = st.channel === 'win32' ? '32-бит (win32)' : '64-бит (latest)';
    updateInfo.textContent =
      `${info.name} ${info.version} · ${st.arch} · канал: ${channel}` +
      (st.supported ? '' : ' · автообновление недоступно');

    checkButton.textContent = st.status === 'ready' ? 'Перезапустить и обновить' : 'Проверить обновления';

    updateNotes.textContent =
      st.status === 'ready'
        ? `Версия ${st.version} загружена — перезапустите браузер, чтобы обновиться.`
        : st.status === 'current'
          ? 'У вас последняя версия.'
          : st.status === 'downloading'
            ? `Скачиваем обновление: ${st.percent}%`
            : st.status === 'available'
              ? `Найдена версия ${st.version} — скачиваем…`
              : st.status === 'checking'
                ? 'Проверяем обновления…'
                : st.status === 'error'
                  ? `Не удалось проверить обновления: ${st.message}`
                  : st.message || 'Проверка ещё не выполнялась.';
  }

  refs.autoUpdate.addEventListener('change', () => save({ autoUpdate: refs.autoUpdate.checked }));
  checkButton.addEventListener('click', async () => {
    const current = await api.updater.state();
    if (current && current.status === 'ready') {
      await api.updater.install();
      return;
    }
    updateNotes.textContent = 'Проверяем обновления…';
    renderUpdate(await api.updater.check());
  });
  document.getElementById('open-releases').addEventListener('click', () => api.updater.openReleases());
  api.on('updater:status', renderUpdate);
  renderUpdate(await api.updater.state());
}

/* ─────────────────────────── Статистика блокировок ─────────────────────────── */

function renderHosts(container, topHosts) {
  container.textContent = '';
  if (!topHosts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Пока ничего не заблокировано. Откройте сайт с рекламой — счётчик оживёт.';
    container.appendChild(empty);
    return;
  }
  const max = topHosts[0].count || 1;
  for (const item of topHosts.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'bar-item';

    const host = document.createElement('span');
    host.className = 'bar-host';
    host.textContent = item.host;
    host.title = item.host;

    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(4, Math.round((item.count / max) * 100))}%`;
    track.appendChild(fill);

    const count = document.createElement('span');
    count.className = 'bar-count';
    count.textContent = String(item.count);

    row.appendChild(host);
    row.appendChild(track);
    row.appendChild(count);
    container.appendChild(row);
  }
}

function renderRecent(container, recent) {
  container.textContent = '';
  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Заблокированных запросов нет.';
    container.appendChild(empty);
    return;
  }
  for (const item of recent.slice(0, 80)) {
    const row = document.createElement('div');
    row.className = 'recent-item';

    const host = document.createElement('span');
    host.className = 'recent-host';
    host.textContent = item.host || '—';

    const url = document.createElement('span');
    url.className = 'recent-url';
    url.textContent = item.url;
    url.title = item.url;

    const type = document.createElement('span');
    type.className = 'recent-url';
    type.style.flex = '0 0 90px';
    type.textContent = item.type || '';

    row.appendChild(host);
    row.appendChild(url);
    row.appendChild(type);
    container.appendChild(row);
  }
}

async function initBlocklist() {
  const hostsEl = document.getElementById('hosts');
  const recentEl = document.getElementById('recent');
  const toggleBtn = document.getElementById('toggle');
  const rulesEl = document.getElementById('user-rules');
  const ruleStatus = document.getElementById('user-rule-status');
  const siteBtn = document.getElementById('toggle-site');
  const siteLabel = document.getElementById('site-label');
  const listsStatus = document.getElementById('lists-status');

  async function refreshSite() {
    const info = await api.adblock.siteState();
    if (!info.host || info.internal) {
      siteLabel.textContent = 'Внутренняя страница браузера';
      siteBtn.disabled = true;
      siteBtn.textContent = 'Недоступно';
      return;
    }
    siteLabel.textContent = `Текущий сайт: ${info.host}`;
    siteBtn.disabled = false;
    siteBtn.textContent = info.disabled ? 'Включить на этом сайте' : 'Отключить на этом сайте';
  }

  async function refreshUserRules() {
    const rules = await api.adblock.userRules();
    rulesEl.textContent = '';
    ruleStatus.textContent = rules.length
      ? `Правил пользователя: ${rules.length}`
      : 'Своих правил пока нет — можно добавить вручную или заблокировать элемент на странице.';

    for (const rule of rules) {
      const row = document.createElement('div');
      row.className = 'rule-row';

      const code = document.createElement('span');
      code.className = 'mono rule-text';
      code.textContent = rule;

      const del = document.createElement('button');
      del.className = 'btn ghost small';
      del.textContent = 'Удалить';
      del.addEventListener('click', async () => {
        await api.adblock.removeRule(rule);
        await refresh();
      });

      row.appendChild(code);
      row.appendChild(del);
      rulesEl.appendChild(row);
    }
  }

  async function refresh() {
    const stats = await api.adblock.stats();
    const state = await api.getState();
    const pageBlocked = state.active ? state.active.blocked || 0 : 0;

    document.getElementById('s-blocked').textContent = String(stats.blockedTotal);
    document.getElementById('s-page').textContent = String(pageBlocked);
    document.getElementById('s-rules').textContent = String(stats.rules);
    document.getElementById('s-cosmetic').textContent = String(stats.cosmeticRules || 0);
    document.getElementById('s-state').textContent = stats.enabled ? 'вкл' : 'выкл';
    document.getElementById('s-state').style.color = stats.enabled ? '#46c07a' : '#ef5a5a';
    toggleBtn.textContent = stats.enabled ? 'Выключить' : 'Включить';

    if (stats.lists && stats.lists.length) {
      listsStatus.textContent = `Загруженные списки: ${stats.lists.join(', ')}. Правил: ${stats.rules}.`;
    }

    renderHosts(hostsEl, stats.topHosts || []);
    renderRecent(recentEl, stats.recent || []);
    await refreshUserRules();
    await refreshSite();
  }

  toggleBtn.addEventListener('click', async () => {
    await api.adblock.toggle();
    await refresh();
  });

  document.getElementById('reload').addEventListener('click', () => api.adblock.reloadPage());
  document.getElementById('reset').addEventListener('click', async () => {
    await api.adblock.resetStats();
    await refresh();
  });
  document.getElementById('settings').addEventListener('click', () =>
    api.tabs.navigate('kitsune://settings')
  );

  // ── Свои правила ──
  const ruleInput = document.getElementById('user-rule');
  const addRule = async () => {
    const rule = ruleInput.value.trim();
    if (!rule) return;
    const res = await api.adblock.addRule(rule);
    ruleInput.value = '';
    ruleStatus.textContent = res.added
      ? `Правило добавлено · всего правил: ${res.rules}`
      : 'Правило не распознано — проверьте синтаксис';
    ruleStatus.style.color = res.added ? '#46c07a' : '#ef5a5a';
    setTimeout(() => {
      ruleStatus.style.color = '';
      refresh();
    }, 1800);
    await refresh();
  };
  document.getElementById('add-user-rule').addEventListener('click', addRule);
  ruleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addRule();
  });

  document.getElementById('pick-element').addEventListener('click', async () => {
    const started = await api.adblock.pickElement();
    ruleStatus.textContent = started
      ? 'Кликните по рекламному блоку на странице (Esc — отмена)'
      : 'Сначала откройте обычный сайт в другой вкладке';
  });

  // ── Сайт и списки ──
  siteBtn.addEventListener('click', async () => {
    await api.adblock.toggleSite();
    await refreshSite();
    await refresh();
  });

  document.getElementById('update-lists').addEventListener('click', async () => {
    listsStatus.textContent = 'Скачиваем списки… это может занять несколько секунд';
    const res = await api.adblock.updateLists();
    const ok = (res.results || []).filter((r) => !r.error);
    const failed = (res.results || []).filter((r) => r.error);
    listsStatus.textContent = ok.length
      ? `Загружено списков: ${ok.length}, правил всего: ${res.rules}` +
        (failed.length ? ` · не удалось: ${failed.map((f) => f.name).join(', ')}` : '')
      : 'Не удалось скачать списки — проверьте подключение к интернету';
    await refresh();
  });

  // Счётчик блокировок приходит очень часто — обновляем интерфейс не чаще
  // раза в секунду, иначе страница статистики начинает тормозить.
  let pending = null;
  const scheduleRefresh = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      refresh();
    }, 1200);
  };

  api.on('adblock:count', scheduleRefresh);
  await refresh();
  setInterval(scheduleRefresh, 8000);
}

/* ─────────────────────────── Пароли ─────────────────────────── */

async function initPasswords() {
  const listEl = document.getElementById('pw-list');
  const emptyEl = document.getElementById('pw-empty');
  const searchEl = document.getElementById('pw-search');
  const countEl = document.getElementById('pw-count');
  const secureEl = document.getElementById('pw-secure');
  const statusEl = document.getElementById('pw-add-status');
  const saveToggle = document.getElementById('pw-save');
  const autofillToggle = document.getElementById('pw-autofill');

  let items = [];

  const settings = await api.settings.get();
  saveToggle.checked = settings.savePasswords !== false;
  autofillToggle.checked = settings.autofillPasswords !== false;

  saveToggle.addEventListener('change', () => api.settings.set({ savePasswords: saveToggle.checked }));
  autofillToggle.addEventListener('change', () =>
    api.settings.set({ autofillPasswords: autofillToggle.checked })
  );

  async function refresh() {
    const data = await api.passwords.list();
    items = data.items || [];
    countEl.textContent = String(items.length);
    secureEl.textContent = data.secure
      ? 'Пароли шифруются средствами операционной системы — файл без вашего профиля не читается.'
      : 'Системное шифрование недоступно: пароли сохранены в кодированном, но не защищённом виде.';
    render();
  }

  function render() {
    const query = searchEl.value.trim().toLowerCase();
    const filtered = query
      ? items.filter((item) => `${item.host} ${item.username}`.toLowerCase().includes(query))
      : items;

    listEl.textContent = '';
    emptyEl.classList.toggle('hidden', filtered.length > 0);

    for (const item of filtered) listEl.appendChild(passwordRow(item));
  }

  /** Строка списка: сайт, логин, маска пароля и действия */
  function passwordRow(item) {
    const row = document.createElement('div');
    row.className = 'pw-row';

    const info = document.createElement('div');
    info.className = 'pw-info';

    const host = document.createElement('div');
    host.className = 'pw-host';
    host.textContent = item.host;
    host.title = item.url;

    const user = document.createElement('div');
    user.className = 'pw-user';
    user.textContent = item.username || '(логин не указан)';

    info.appendChild(host);
    info.appendChild(user);
    row.appendChild(info);

    const secret = document.createElement('div');
    secret.className = 'pw-secret mono';
    secret.textContent = item.masked || '••••••••';
    secret.dataset.visible = '0';
    row.appendChild(secret);

    const actions = document.createElement('div');
    actions.className = 'pw-actions';

    const reveal = document.createElement('button');
    reveal.className = 'btn ghost small';
    reveal.textContent = 'Показать';
    reveal.addEventListener('click', async () => {
      if (secret.dataset.visible === '1') {
        secret.textContent = item.masked || '••••••••';
        secret.dataset.visible = '0';
        reveal.textContent = 'Показать';
        return;
      }
      const data = await api.passwords.reveal(item.id);
      secret.textContent = data && data.password ? data.password : '(не удалось прочитать)';
      secret.dataset.visible = '1';
      reveal.textContent = 'Скрыть';
    });

    const copy = document.createElement('button');
    copy.className = 'btn ghost small';
    copy.textContent = 'Копировать';
    copy.addEventListener('click', async () => {
      const data = await api.passwords.reveal(item.id);
      if (data && data.password) await api.copy(data.password);
      copy.textContent = 'Скопировано';
      setTimeout(() => {
        copy.textContent = 'Копировать';
      }, 1500);
    });

    const fill = document.createElement('button');
    fill.className = 'btn ghost small';
    fill.textContent = 'Заполнить на странице';
    fill.title = 'Подставить логин и пароль в форму входа активной вкладки';
    fill.addEventListener('click', async () => {
      const ok = await api.passwords.fillActive(item.id);
      statusEl.textContent = ok
        ? 'Логин и пароль подставлены в форму активной вкладки'
        : 'Не удалось заполнить: активная вкладка не содержит форму входа';
    });

    const remove = document.createElement('button');
    remove.className = 'btn danger small';
    remove.textContent = 'Удалить';
    remove.addEventListener('click', async () => {
      await api.passwords.remove(item.id);
      await refresh();
    });

    actions.appendChild(reveal);
    actions.appendChild(copy);
    actions.appendChild(fill);
    actions.appendChild(remove);
    row.appendChild(actions);

    return row;
  }

  searchEl.addEventListener('input', render);

  document.getElementById('pw-add').addEventListener('click', async () => {
    const url = document.getElementById('pw-add-url').value.trim();
    const username = document.getElementById('pw-add-user').value.trim();
    const password = document.getElementById('pw-add-pass').value;
    if (!url || !password) {
      statusEl.textContent = 'Нужны адрес сайта и пароль';
      statusEl.style.color = '#ef5a5a';
      return;
    }
    const res = await api.passwords.save({ url, username, password });
    if (!res) {
      statusEl.textContent = 'Не удалось сохранить — проверьте адрес сайта';
      statusEl.style.color = '#ef5a5a';
      return;
    }
    document.getElementById('pw-add-url').value = '';
    document.getElementById('pw-add-user').value = '';
    document.getElementById('pw-add-pass').value = '';
    statusEl.textContent = 'Сохранено';
    statusEl.style.color = '#46c07a';
    setTimeout(() => {
      statusEl.style.color = '';
      statusEl.textContent = 'Пароль сохранится в зашифрованном виде.';
    }, 1800);
    await refresh();
  });

  document.getElementById('pw-clear').addEventListener('click', async () => {
    const ok = await api.confirm('Удаление паролей', 'Удалить все сохранённые пароли? Действие необратимо.');
    if (!ok) return;
    await api.passwords.clear();
    await refresh();
  });

  await refresh();
}

/* ─────────────────────────── О браузере ─────────────────────────── */

async function initAbout() {
  const info = await api.getAppInfo();
  const stats = await api.adblock.stats();

  document.getElementById('ver').textContent = `Версия ${info.version} · ${info.platform}`;
  document.getElementById('v-app').textContent = `${info.name} ${info.version}`;
  document.getElementById('v-electron').textContent = info.electron;
  document.getElementById('v-chrome').textContent = info.chrome;
  document.getElementById('v-node').textContent = info.node;
  document.getElementById('v-platform').textContent = info.platform;
  document.getElementById('v-rules').textContent = `${stats.rules} (${stats.listName || 'Kitsune Base'})`;
  document.getElementById('v-blocked').textContent = String(stats.blockedTotal);
  document.getElementById('v-filters').textContent = info.filtersDir;

  // Разрядность, канал обновлений и способ установки
  const st = await api.updater.state();
  const channel = info.updateChannel === 'win32' ? 'win32 (32-бит)' : 'latest (64-бит)';
  document.getElementById('v-arch').textContent = `${info.arch}${info.packaged ? '' : ' (запуск из исходников)'}`;
  document.getElementById('v-channel').textContent = channel;
  document.getElementById('v-install').textContent = info.portable
    ? 'portable-сборка'
    : info.packaged
      ? 'установщик NSIS'
      : 'исходники (npm start)';

  const updateText = document.getElementById('v-update');
  const describe = (state) => {
    if (!state) return 'Состояние обновлений неизвестно.';
    if (state.status === 'ready') return `Версия ${state.version} загружена — перезапустите браузер.`;
    if (state.status === 'current') return 'Установлена последняя версия.';
    if (state.status === 'downloading') return `Скачиваем обновление: ${state.percent}%`;
    if (state.status === 'checking') return 'Проверяем обновления…';
    if (state.status === 'available') return `Найдена версия ${state.version} — скачиваем…`;
    if (state.status === 'error') return `Ошибка: ${state.message}`;
    return state.message || 'Автообновление включено — проверка идёт в фоне.';
  };
  updateText.textContent = describe(st);
  api.on('updater:status', (state) => {
    updateText.textContent = describe(state);
  });

  document.getElementById('v-check').addEventListener('click', async () => {
    updateText.textContent = 'Проверяем обновления…';
    const current = await api.updater.state();
    if (current && current.status === 'ready') {
      await api.updater.install();
      return;
    }
    updateText.textContent = describe(await api.updater.check());
  });
  document.getElementById('v-releases').addEventListener('click', () => api.updater.openReleases());

  for (const id of ['l-home', 'l-settings', 'l-blocked']) {
    const link = document.getElementById(id);
    const target = link.textContent;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      api.tabs.navigate(target);
    });
  }
}

/* ─────────────────────────── Загрузки ─────────────────────────── */

async function initDownloads() {
  const list = document.getElementById('download-list');
  const empty = document.getElementById('download-empty');
  function formatBytes(value) {
    const n = Number(value) || 0;
    if (!n) return 'размер неизвестен';
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
    return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  }
  function render(items) {
    list.textContent = '';
    empty.classList.toggle('hidden', items.length > 0);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'card';
      const name = document.createElement('div');
      name.className = 'download-name';
      name.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'download-meta';
      meta.textContent = `${item.status === 'completed' ? 'Готово' : item.status === 'downloading' ? 'Скачивается' : 'Прервано'} · ${formatBytes(item.received)}${item.total ? ` из ${formatBytes(item.total)}` : ''}`;
      row.append(name, meta);
      if (item.status === 'downloading') {
        const progress = document.createElement('progress');
        progress.className = 'download-progress';
        progress.max = item.total || 1;
        progress.value = item.received || 0;
        row.appendChild(progress);
      }
      const actions = document.createElement('div');
      actions.className = 'download-actions';
      if (item.status === 'completed') {
        const open = document.createElement('button');
        open.className = 'btn'; open.textContent = 'Открыть';
        open.onclick = () => api.downloads.open(item.id);
        const folder = document.createElement('button');
        folder.className = 'btn ghost'; folder.textContent = 'Показать в папке';
        folder.onclick = () => api.downloads.folder(item.id);
        actions.append(open, folder);
      } else if (item.status === 'downloading') {
        const cancel = document.createElement('button');
        cancel.className = 'btn danger'; cancel.textContent = 'Отменить';
        cancel.onclick = () => api.downloads.cancel(item.id);
        actions.appendChild(cancel);
      }
      row.appendChild(actions);
      list.appendChild(row);
    }
  }
  render(await api.downloads.list());
  api.on('downloads:changed', render);
}

/* ─────────────────────────── Точка входа ─────────────────────────── */

async function main() {
  if (!api) {
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<p style="padding:20px;color:#ef5a5a">API Kitsune недоступен — страница открыта вне браузера.</p>'
    );
    return;
  }

  switch (currentPage()) {
    case 'home':
      await initHome();
      break;
    case 'settings':
      await initSettings();
      break;
    case 'blocked':
      await initBlocklist();
      break;
    case 'passwords':
      await initPasswords();
      break;
    case 'downloads':
      await initDownloads();
      break;
    case 'about':
      await initAbout();
      break;
  }
}

main().catch((err) => {
  console.error('[Kitsune] Ошибка внутренней страницы:', err);
});

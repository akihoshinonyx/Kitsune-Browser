'use strict';

/**
 * smoke-test.js — дымовой тест Kitsune Browser.
 *
 * Запускает настоящее приложение (переиспользуя src/main/main.js),
 * ждёт загрузку UI, проверяет ключевые элементы интерфейса,
 * открывает внутренние страницы и сохраняет скриншоты.
 *
 * Запуск: npm run smoke
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const OUT_DIR = path.join(__dirname, '..', 'build', 'smoke');
fs.mkdirSync(OUT_DIR, { recursive: true });

const { app, BrowserWindow } = require('electron');
const os = require('os');

const localServer = http.createServer((_request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end('<!doctype html><title>Kitsune smoke storage</title><main>storage test</main>');
});
const localServerReady = new Promise((resolve, reject) => {
  localServer.once('error', reject);
  localServer.listen(0, '127.0.0.1', resolve);
});
app.on('before-quit', () => {
  if (localServer.listening) localServer.close();
});
// Отдельный профиль задаётся до импорта main и создания Chromium session.
// Smoke не должен менять пароли, историю и настройки настоящего пользователя.
const smokeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-smoke-'));
app.setPath('userData', smokeProfile);
app.setPath('sessionData', smokeProfile);

// Поднимаем настоящее приложение
require('../src/main/main.js');

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function shot(win, file) {
  try {
    // Снимаем именно активную вкладку: у окна несколько WebContentsView,
    // и «первый попавшийся» — это не то, что видит пользователь.
    const wc = (await activeTabWC(win)) || win.webContents;
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, file), image.toPNG());
  } catch (err) {
    console.log(`  (скриншот ${file} не сделан: ${err.message})`);
  }
}

/** Выполнить JS внутри АКТИВНОЙ вкладки */
async function inTab(win, code) {
  const wc = await activeTabWC(win);
  if (!wc) return null;
  return wc.executeJavaScript(code).catch(() => null);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** WebContents активной вкладки (не окно с UI) */
async function activeTabWC(win) {
  const { webContents } = require('electron');
  const state = await win.webContents.executeJavaScript('window.kitsune.getState()').catch(() => null);
  const id = state && state.active ? state.active.wcId : null;
  if (id !== null && id !== undefined) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) return wc;
  }
  return (
    webContents
      .getAllWebContents()
      .find((wc) => !wc.isDestroyed() && wc.id !== win.webContents.id) || null
  );
}

/** Настоящий клик мышью по элементу UI-слоя */
async function clickTabClose(win, selector) {
  const point = await win.webContents.executeJavaScript(`(function () {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  if (!point) return false;
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return true;
}

/** Нажатие клавиши внутри активной вкладки — проверяем хоткеи без фокуса на полосе браузера */
async function sendKeyToTab(win, keyCode, modifiers = []) {
  const wc = await activeTabWC(win);
  if (!wc) return false;
  wc.focus();
  await wait(150);
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  return true;
}

app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      await localServerReady;
      const localUrl = `http://127.0.0.1:${localServer.address().port}/storage-test`;
      const win = BrowserWindow.getAllWindows()[0];
      check('окно браузера создано', !!win);
      if (!win) return app.exit(1);

      // Собираем ошибки renderer-процесса
      const rendererErrors = [];
      win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) rendererErrors.push(message);
      });

      const probe = await win.webContents.executeJavaScript(`(function () {
        const tabs = [...document.querySelectorAll('.tab')];
        return {
          api: typeof window.kitsune === 'object',
          constants: typeof window.KITSUNE === 'object',
          tabCount: tabs.length,
          activeTabs: document.querySelectorAll('.tab.active').length,
          address: (document.getElementById('address') || {}).value || '',
          blockedBadge: (document.getElementById('adblock-count') || {}).textContent || '',
          hasMenu: !!document.getElementById('menu-button'),
          hasFindBar: !!document.getElementById('findbar'),
          hasSidebar: !!document.getElementById('sidebar'),
          chromeHeight: (document.getElementById('tabstrip') || {}).offsetHeight
            ? document.getElementById('tabstrip').offsetHeight + document.getElementById('toolbar').offsetHeight
            : 0,
          title: document.title
        };
      })()`);

      check('preload-API доступен в renderer', probe.api);
      check('константы KITSUNE загружены в renderer', probe.constants);
      check('есть хотя бы одна вкладка', probe.tabCount >= 1, `вкладок: ${probe.tabCount}`);
      check('активна ровно одна вкладка', probe.activeTabs === 1, `активных: ${probe.activeTabs}`);
      check('адресная строка показывает стартовую страницу', probe.address.startsWith('kitsune://'), probe.address);
      check('высота UI-хрома ровно 88px', probe.chromeHeight === 88, `${probe.chromeHeight}px`);
      check('меню, поиск и боковая панель присутствуют', probe.hasMenu && probe.hasFindBar && probe.hasSidebar);
      await shot(win, '01-home.png');

      // Создаём вторую вкладку и проверяем состояние
      const afterCreate = await win.webContents.executeJavaScript(
        `window.kitsune.tabs.create({ url: 'kitsune://settings' }).then(() => new Promise((r) => setTimeout(() => r({
           tabs: document.querySelectorAll('.tab').length,
           active: document.querySelectorAll('.tab.active').length
         }), 900)))`
      );
      check('новая вкладка создаётся', afterCreate.tabs >= 2, `вкладок: ${afterCreate.tabs}`);
      check('активной становится новая вкладка', afterCreate.active === 1);
      await shot(win, '02-settings-tab.png');

      // Проверяем настройки внутри вкладки: переключение поисковика
      const settingsCheck = await win.webContents.executeJavaScript(
        `window.kitsune.settings.set({ searchEngine: 'lite' }).then((s) => window.kitsune.settings.set({ searchEngine: s.searchEngine === 'lite' ? 'duckduckgo' : 'lite' })).then((s) => s.searchEngine)`
      );
      check('настройки читаются и записываются', typeof settingsCheck === 'string', `searchEngine: ${settingsCheck}`);

      // Статистика блокировщика
      const stats = await win.webContents.executeJavaScript('window.kitsune.adblock.stats()');
      check('статистика блокировщика доступна', stats && stats.rules > 300, `правил: ${stats.rules}`);

      // Подсказки напрямую через IPC (проверяем связку с DuckDuckGo)
      const sug = await win.webContents.executeJavaScript(
        `window.kitsune.search.suggest('duckduckgo')`
      );
      check(
        'канал подсказок DuckDuckGo отвечает без падения main-процесса',
        sug && Array.isArray(sug.local) && Array.isArray(sug.remote),
        `локальных: ${sug && sug.local ? sug.local.length : 0}, удалённых: ${sug && sug.remote ? sug.remote.length : 0}`
      );

      // ── Меню-«гамбургер»: строится в main-процессе и показывается нативно ──
      const menuItems = await win.webContents.executeJavaScript('window.kitsune.ui.appMenuItems()');
      check(
        'нативное меню собирается и содержит «Настройки»',
        Array.isArray(menuItems) && menuItems.includes('Настройки'),
        `пунктов: ${(menuItems || []).length}`
      );
      check(
        'в меню есть пароли и блокировка элемента',
        menuItems.includes('Пароли и автозаполнение') && menuItems.includes('Заблокировать элемент на странице')
      );

      // ── Приватное окно: отдельный renderer, сессия и отсутствие профиля ──
      const windowsBeforePrivate = BrowserWindow.getAllWindows().length;
      const privateOpened = await win.webContents.executeJavaScript('window.kitsune.openPrivateWindow()');
      await wait(1600);
      const privateWin = BrowserWindow.getAllWindows().find((candidate) =>
        candidate !== win && !candidate.isDestroyed()
      );
      const privateState = privateWin
        ? await privateWin.webContents.executeJavaScript('window.kitsune.getState()').catch(() => null)
        : null;
      const privateApi = privateWin
        ? await privateWin.webContents.executeJavaScript(`(async () => ({
            state: await window.kitsune.getState(),
            history: await window.kitsune.history.list(),
            passwords: await window.kitsune.passwords.list(),
            settingsSet: await window.kitsune.settings.set({ homePage: 'https://private.invalid/' }),
            stats: await window.kitsune.adblock.stats()
          }))()`).catch(() => null)
        : null;
      check('создаётся отдельное приватное окно', privateOpened === true && !!privateWin && BrowserWindow.getAllWindows().length === windowsBeforePrivate + 1);
      check('приватное окно имеет собственное состояние вкладок', !!privateState && privateState.tabs.length === 1 && privateState.activeId !== null);
      check('приватное окно не получает историю и пароли', privateApi && privateApi.history === null && privateApi.passwords === null);
      check('приватное окно не может менять постоянные настройки', privateApi && privateApi.settingsSet === null);
      check('приватное окно сохраняет доступ только к безопасной статистике', privateApi && privateApi.stats && typeof privateApi.stats.rules === 'number');
      if (privateWin && !privateWin.isDestroyed()) {
        await privateWin.webContents.executeJavaScript(`window.kitsune.tabs.navigate(${JSON.stringify(localUrl)})`);
        await wait(900);
        const stored = await activeTabWC(privateWin).then((wc) => wc.executeJavaScript(`(async () => {
          document.cookie = 'kitsune_private=present; Max-Age=3600; Path=/';
          localStorage.setItem('kitsune_private', 'present');
          sessionStorage.setItem('kitsune_private', 'present');
          const cache = await caches.open('kitsune-private-cache');
          await cache.put('/cached', new Response('private'));
          return {
            cookie: document.cookie.includes('kitsune_private=present'),
            local: localStorage.getItem('kitsune_private'),
            session: sessionStorage.getItem('kitsune_private'),
            cache: await caches.has('kitsune-private-cache')
          };
        })()`));
        check('приватное окно записывает тестовые web-данные', stored && stored.cookie && stored.local === 'present' && stored.session === 'present' && stored.cache === true);
        privateWin.close();
        await wait(700);
      }
      check('закрытие приватного окна не закрывает основное', !win.isDestroyed() && BrowserWindow.getAllWindows().includes(win));

      const privateAgain = await win.webContents.executeJavaScript('window.kitsune.openPrivateWindow()');
      await wait(1500);
      const privateWinAgain = BrowserWindow.getAllWindows().find((candidate) => candidate !== win && !candidate.isDestroyed());
      const cleared = privateWinAgain
        ? await privateWinAgain.webContents.executeJavaScript(`window.kitsune.tabs.navigate(${JSON.stringify(localUrl)})`).then(() => wait(900)).then(() => activeTabWC(privateWinAgain)).then((wc) => wc.executeJavaScript(`(async () => ({
            cookie: document.cookie.includes('kitsune_private=present'),
            local: localStorage.getItem('kitsune_private'),
            session: sessionStorage.getItem('kitsune_private'),
            cache: await caches.has('kitsune-private-cache')
          }))()`))
        : null;
      check('новое приватное окно не восстанавливает cookie и storage', privateAgain === true && cleared && !cleared.cookie && cleared.local === null && cleared.session === null && cleared.cache === false);
      if (privateWinAgain && !privateWinAgain.isDestroyed()) privateWinAgain.close();

      // ── Подсказки адресной строки: под них освобождается место у вкладки ──
      const sugProbe = await win.webContents.executeJavaScript(`(async () => {
        const input = document.getElementById('address');
        input.focus();
        input.value = 'duckduckgo';
        input.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 1800));
        const state = await window.kitsune.getState();
        return {
          suggest: document.querySelectorAll('.suggestion').length,
          insets: state.insets
        };
      })()`);
      check('подсказки адресной строки работают', sugProbe.suggest >= 1, `подсказок: ${sugProbe.suggest}`);
      check(
        'под выпадающий список освобождено место у вкладки',
        sugProbe.insets.overlayBottom > 0,
        `${sugProbe.insets.overlayBottom}px`
      );
      const shifted = win.contentView.children.some((v) => v.getBounds && v.getBounds().y > 88);
      check('нативная вкладка сдвинута вниз под подсказки', shifted);
      await shot(win, '03-suggestions.png');

      // Escape закрывает список и возвращает вкладку на место
      await win.webContents.executeJavaScript(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`
      );
      await wait(1200);
      const afterEsc = await win.webContents.executeJavaScript('window.kitsune.getState()');
      check('после закрытия списка вкладка возвращается на место', afterEsc.insets.overlayBottom === 0, `${afterEsc.insets.overlayBottom}px`);
      await win.webContents.executeJavaScript(`document.getElementById('address').blur(); true`);

      // Внутренние страницы
      for (const [page, file, probe] of [
        ['kitsune://blocked', '04-blocked.png', 'document.getElementById("s-blocked") ? "ok" : "no-stats"'],
        ['kitsune://about', '05-about.png', 'document.getElementById("v-app") ? document.getElementById("v-app").textContent : "no-about"'],
        ['kitsune://passwords', '08-passwords.png', 'document.getElementById("pw-list") ? "ok" : "no-passwords"'],
        ['kitsune://home', '06-newtab.png', 'document.getElementById("search-form") ? "ok" : "no-home"']
      ]) {
        await win.webContents.executeJavaScript(
          `window.kitsune.tabs.navigate(${JSON.stringify(page)})`
        );
        await new Promise((r) => setTimeout(r, 1600));
        const content = await inTab(win, probe);
        check(`${page} реально отрисовалась`, content === 'ok' || /Kitsune|ok/.test(String(content)), String(content));
        await shot(win, file);
      }

      /* ─────────── Менеджер паролей, белый список и косметика ─────────── */

      const pwSaved = await win.webContents.executeJavaScript(
        `window.kitsune.passwords.save({ url: 'https://example.com/login', username: 'smoke-user', password: 'smoke-pass' })`
      );
      check('пароль сохраняется в менеджере паролей', !!(pwSaved && pwSaved.id), String(pwSaved && pwSaved.id));

      const pwList = await win.webContents.executeJavaScript('window.kitsune.passwords.list()');
      const entry = (pwList.items || []).find((i) => i.host === 'example.com');
      check(
        'список паролей не отдаёт пароль открытым текстом',
        !!entry && !JSON.stringify(entry).includes('smoke-pass')
      );
      check('хранилище сообщает состояние шифрования', typeof pwList.secure === 'boolean', `secure: ${pwList.secure}`);

      const revealed = await win.webContents.executeJavaScript(
        `window.kitsune.passwords.reveal(${JSON.stringify(pwSaved && pwSaved.id)})`
      );
      check('пароль показывается только по явному запросу', !!revealed && revealed.password === 'smoke-pass');

      await win.webContents.executeJavaScript(`window.kitsune.tabs.navigate('kitsune://passwords')`);
      await wait(1400);
      const pwRows = await inTab(win, 'document.querySelectorAll(".pw-row").length');
      check('страница паролей отрисовала сохранённый вход', Number(pwRows) >= 1, `строк: ${pwRows}`);
      await shot(win, '09-passwords-saved.png');

      const cosmetic = await win.webContents.executeJavaScript('window.kitsune.adblock.stats()');
      check('в списке есть правила скрытия элементов', cosmetic.cosmeticRules > 0, `правил скрытия: ${cosmetic.cosmeticRules}`);

      // Обычный сайт: блокировку можно выключить для одного домена
      await win.webContents.executeJavaScript(`window.kitsune.tabs.create({ url: 'https://example.com/' })`);
      await wait(2200);
      const siteState = await win.webContents.executeJavaScript(`(async () => {
        const before = await window.kitsune.adblock.siteState();
        await window.kitsune.adblock.toggleSite();
        const after = await window.kitsune.adblock.siteState();
        await window.kitsune.adblock.toggleSite();
        const back = await window.kitsune.adblock.siteState();
        return { before, after, back };
      })()`);
      check(
        'блокировку можно выключить и включить для сайта',
        siteState.before.disabled === false && siteState.after.disabled === true && siteState.back.disabled === false,
        `сайт: ${siteState.after.host}`
      );

      // Сайт не должен получать полный API браузера
      const isolation = await inTab(win, `({ kitsune: typeof window.kitsune, page: typeof window.kitsunePage })`);
      check('обычный сайт не видит window.kitsune', isolation && isolation.kitsune === 'undefined', JSON.stringify(isolation));
      check('сайту доступен только узкий мост для паролей', isolation && isolation.page === 'object');

      await win.webContents.executeJavaScript(`window.kitsune.passwords.clear()`);

      /* ─────────── Закрытие вкладок и горячие клавиши ─────────── */

      // Кнопка закрытия: настоящий клик мышью по крестику вкладки
      const beforeClose = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.tab').length`
      );
      await clickTabClose(win, '.tab.active .tab-close');
      await wait(700);
      const afterClose = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.tab').length`
      );
      check('клик по крестику закрывает вкладку', afterClose === beforeClose - 1, `${beforeClose} → ${afterClose}`);

      // Ctrl+W должен работать, даже когда фокус внутри страницы
      await win.webContents.executeJavaScript(`window.kitsune.tabs.create({ url: 'https://example.com/' })`);
      await wait(1200);
      const addrBefore = await win.webContents.executeJavaScript(`document.getElementById('address').value`);
      check('адресная строка показывает адрес новой вкладки', /example\.com/.test(addrBefore), addrBefore);

      const countBeforeKeys = await win.webContents.executeJavaScript(`document.querySelectorAll('.tab').length`);
      await sendKeyToTab(win, 'w', ['control']);
      await wait(800);
      const countAfterKeys = await win.webContents.executeJavaScript(`document.querySelectorAll('.tab').length`);
      check('Ctrl+W из страницы закрывает вкладку', countAfterKeys === countBeforeKeys - 1, `${countBeforeKeys} → ${countAfterKeys}`);

      // Ctrl+Shift+T возвращает закрытую вкладку
      await sendKeyToTab(win, 'T', ['control', 'shift']);
      await wait(1200);
      const reopened = await win.webContents.executeJavaScript(
        `({ count: document.querySelectorAll('.tab').length, addr: document.getElementById('address').value })`
      );
      check('Ctrl+Shift+T переоткрывает закрытую вкладку', /example\.com/.test(reopened.addr), reopened.addr);

      // Ctrl+T из страницы создаёт вкладку
      const countBeforeT = reopened.count;
      await sendKeyToTab(win, 't', ['control']);
      await wait(800);
      const countAfterT = await win.webContents.executeJavaScript(`document.querySelectorAll('.tab').length`);
      check('Ctrl+T из страницы создаёт вкладку', countAfterT === countBeforeT + 1, `${countBeforeT} → ${countAfterT}`);

      // Масштаб: Ctrl+= и сброс по бейджу
      await sendKeyToTab(win, '=', ['control']);
      await wait(600);
      const zoomOn = await win.webContents.executeJavaScript(
        `!document.getElementById('zoom-badge').classList.contains('hidden')`
      );
      await win.webContents.executeJavaScript(`document.getElementById('zoom-badge').click(); true`);
      await wait(500);
      const zoomOff = await win.webContents.executeJavaScript(
        `document.getElementById('zoom-badge').classList.contains('hidden')`
      );
      check('Ctrl + «+» меняет масштаб, бейдж сбрасывает', zoomOn && zoomOff);

      // Закрываем ВСЕ вкладки — пустого окна остаться не должно
      for (let i = 0; i < 6; i++) {
        const left = await win.webContents.executeJavaScript(`document.querySelectorAll('.tab').length`);
        if (left === 0) break;
        await clickTabClose(win, '.tab .tab-close');
        await wait(600);
      }
      const emptyCheck = await win.webContents.executeJavaScript(
        `({ tabs: document.querySelectorAll('.tab').length, active: document.querySelectorAll('.tab.active').length,
            addr: document.getElementById('address').value })`
      );
      check('после закрытия последней вкладки окно не пустует', emptyCheck.tabs === 1 && emptyCheck.active === 1, `вкладок: ${emptyCheck.tabs}`);
      check('адресная строка не сбрасывается в пустоту', emptyCheck.addr.startsWith('kitsune://'), emptyCheck.addr);
      await shot(win, '07-after-close-all.png');

      // ── Пользовательский агент: настоящий Chromium без метки Electron ──
      const ua = await inTab(win, 'navigator.userAgent');
      check('UA содержит актуальный Chrome и не содержит Electron',
        /Chrome\/1\d\d\./.test(String(ua)) && !/Electron/.test(String(ua)),
        String(ua).slice(0, 120));

      const versions = await win.webContents.executeJavaScript('window.kitsune.versions');
      check('движок обновлён (Chromium 150+)', Number(String(versions.chrome).split('.')[0]) >= 150, `chrome ${versions.chrome}, electron ${versions.electron}`);


      /* ─────────── Автообновление ─────────── */

      const updateProbe = await win.webContents.executeJavaScript(`(async () => {
        const info = await window.kitsune.getAppInfo();
        const state = await window.kitsune.updater.state();
        const items = await window.kitsune.ui.appMenuItems();
        const banner = document.getElementById('update-banner');
        return {
          version: info.version,
          stateVersion: state && state.currentVersion,
          supported: state && state.supported,
          reason: state && state.reason,
          channel: state && state.channel,
          arch: state && state.arch,
          hasUpdaterApi: typeof window.kitsune.updater.check === 'function',
          menu: items,
          banner: !!banner,
          bannerHidden: banner ? banner.classList.contains('hidden') : false
        };
      })()`);
      check(
        'состояние автообновления доступно интерфейсу',
        updateProbe.hasUpdaterApi && updateProbe.stateVersion === updateProbe.version,
        `${updateProbe.stateVersion} / ${updateProbe.version}`
      );
      check(
        'канал обновлений соответствует разрядности сборки',
        updateProbe.channel === (updateProbe.arch === 'ia32' ? 'win32' : 'latest'),
        `канал ${updateProbe.channel}, разрядность ${updateProbe.arch}`
      );
      check(
        'запуск из исходников не обещает обновлений',
        updateProbe.supported === false && updateProbe.reason === 'dev',
        `supported: ${updateProbe.supported}, reason: ${updateProbe.reason}`
      );
      check(
        'в меню есть пункт проверки обновлений',
        (updateProbe.menu || []).includes('Проверить обновления'),
        (updateProbe.menu || []).slice(-4).join(' | ')
      );
      check('полоса обновления есть в интерфейсе и скрыта', updateProbe.banner && updateProbe.bannerHidden);

      await win.webContents.executeJavaScript(`window.kitsune.tabs.navigate('kitsune://settings')`);
      await wait(1000);
      const settingsUpdates = await inTab(
        win,
        `!!document.getElementById('check-updates') && !!document.getElementById('auto-update') &&
         !document.getElementById('update-notes').classList.contains('hidden') &&
         !!document.getElementById('export-bookmarks') && !!document.getElementById('import-bookmarks') &&
         !!document.getElementById('export-history') && !!document.getElementById('import-history')`
      );
      check('в настройках есть обновления и перенос данных', settingsUpdates === true, String(settingsUpdates));

      await win.webContents.executeJavaScript(`window.kitsune.tabs.navigate('kitsune://about')`);
      await wait(1000);
      const aboutUpdate = await inTab(
        win,
        `({ channel: (document.getElementById('v-channel') || {}).textContent,
            arch: (document.getElementById('v-arch') || {}).textContent })`
      );
      check(
        'страница «О браузере» показывает разрядность и канал обновлений',
        /latest|win32/.test(String(aboutUpdate.channel)) && /x64|ia32/.test(String(aboutUpdate.arch)),
        JSON.stringify(aboutUpdate)
      );

      check('в консоли renderer нет ошибок', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));
      const passed = results.filter((r) => r.ok).length;
      console.log(`\nДымовой тест: ${passed}/${results.length} проверок пройдено`);
      console.log(`Скриншоты: ${OUT_DIR}`);
      await new Promise((resolve) => localServer.close(() => resolve()));
      app.exit(passed === results.length ? 0 : 1);
    } catch (err) {
      console.error('[Kitsune] Ошибка дымового теста:', err);
      localServer.close();
      app.exit(1);
    }
  }, 5000);
});

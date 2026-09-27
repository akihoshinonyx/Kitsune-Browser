'use strict';

/**
 * updater.js — автообновление Kitsune Browser из GitHub Releases.
 *
 * Как это работает
 * ────────────────
 *  1) electron-builder кладёт в ресурсы приложения `app-update.yml` — адрес
 *     репозитория и канал обновлений;
 *  2) при запуске (и раз в несколько часов) модуль спрашивает у GitHub
 *     «последний релиз» и сравнивает его версию с установленной;
 *  3) если версия новее, electron-updater скачивает установщик, сверяет
 *     SHA-512 из `latest.yml` и по команде пользователя запускает его
 *     (`quitAndInstall`) — установщик NSIS ставит новую версию поверх старой.
 *
 * Два канала: 64-битная сборка ищет `latest.yml`, 32-битная — `win32.yml`.
 * Так два разных установщика (x64 на Electron 44 и ia32 на Electron 43) живут
 * в одном релизе и не подменяют друг друга: иначе 32-битная сборка скачала бы
 * 64-битный установщик и он бы просто не запустился.
 *
 * Модуль намеренно ничего не делает в трёх случаях и честно сообщает причину
 * через `getState().reason`:
 *   • приложение запущено из исходников (`npm start`) — обновлять нечего;
 *   • это portable-сборка (`PORTABLE_EXECUTABLE_FILE`) — её меняют вручную;
 *   • electron-updater не установлен.
 */

const { app, shell } = require('electron');
const { isTrustedSender } = require('./ipc-guards');
const { VERSION } = require('../shared/version');

const OWNER = 'akihoshinonyx';
const REPO = 'Kitsune-Browser';
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`;

/** Первая проверка — не раньше, чем браузер закончит стартовать */
const FIRST_CHECK_DELAY = 12 * 1000;
/** Дальше проверяем раз в 6 часов: релизы выходят редко, сеть не дёргаем зря */
const REPEAT_INTERVAL = 6 * 60 * 60 * 1000;

/** Имя файла канала обновлений для текущей разрядности процесса */
function channelForArch(arch = process.arch) {
  return arch === 'ia32' ? 'win32' : 'latest';
}

/** Portable-сборка: её нельзя обновить «поверх», файл запускают откуда угодно */
function isPortableBuild() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

/** Понятное человеку объяснение ошибки обновления вместо стектрейса */
function friendlyError(err) {
  const raw = String((err && err.message) || err || 'Неизвестная ошибка');
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|Cannot find .*\.ya?ml|NO_PUBLISHED_VERSIONS|LATEST_VERSION_NOT_FOUND/i.test(raw)) {
    return 'На GitHub ещё нет релиза с файлом обновления';
  }
  if (/ENOTFOUND|ETIMEDOUT|ENETUNREACH|ECONNRESET|ERR_INTERNET_DISCONNECTED|net::|socket hang up/i.test(raw)) {
    return 'Нет связи с GitHub — проверьте интернет';
  }
  if (/403|rate limit|API rate/i.test(raw)) {
    return 'GitHub ограничил частоту запросов — попробуйте позже';
  }
  if (/404/.test(raw)) {
    return 'Релиз не найден на GitHub';
  }
  return raw.split('\n')[0].slice(0, 180);
}

/**
 * Создаёт движок обновлений.
 *
 * @param {object} ctx
 * @param {(channel: string, payload: any) => void} ctx.send  отправка события в UI
 * @param {object} ctx.settings  SettingsStore (флаг autoUpdate)
 * @param {string} [ctx.arch]  разрядность (по умолчанию — текущий процесс)
 * @returns {object} API движка: registerIpc/start/check/install/getState
 */
function createUpdater({ send, settings, arch = process.arch }) {
  let autoUpdater = null;
  let unsupported = '';

  const state = {
    /** idle | checking | available | downloading | ready | current | error | unsupported */
    status: 'idle',
    supported: false,
    reason: '',
    channel: channelForArch(arch),
    // Версию берём из src/shared/version.js, а не из app.getVersion(): при
    // запуске из исходников (electron .) app.getVersion() отдаёт версию самого
    // Electron, и интерфейс показывал бы «44.4.5» вместо версии браузера.
    currentVersion: VERSION,
    version: '',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    message: '',
    releaseNotes: '',
    checkedAt: 0,
    manual: false
  };

  /** Заметки к релизу бывают строкой или массивом блоков { note } */
  function extractNotes(info) {
    const notes = info && info.releaseNotes;
    if (!notes) return '';
    if (typeof notes === 'string') return notes.slice(0, 4000);
    if (Array.isArray(notes)) {
      return notes
        .map((n) => (typeof n === 'string' ? n : (n && n.note) || ''))
        .join('\n')
        .slice(0, 4000);
    }
    return '';
  }

  /** Обновляет состояние и рассказывает о нём интерфейсу */
  function patch(changes) {
    Object.assign(state, changes);
    state.checkedAt = Date.now();
    send('updater:status', getState());
  }

  function getState() {
    // Инициализация ленивая: состояние должно быть точным ещё до первой
    // проверки — иначе интерфейс не знает, почему обновления недоступны
    // (portable-сборка, запуск из исходников, отсутствие модуля).
    loadModule();
    return {
      ...state,
      reason: unsupported || state.reason,
      releasesPage: RELEASES_PAGE,
      arch,
      portable: isPortableBuild()
    };
  }

  /* ─────────────────────── Загрузка electron-updater ─────────────────────── */

  function loadModule() {
    if (autoUpdater || unsupported) return autoUpdater;
    if (!app.isPackaged) {
      unsupported = 'dev';
      return null;
    }
    if (process.platform !== 'win32') {
      unsupported = 'platform';
      return null;
    }
    if (isPortableBuild()) {
      unsupported = 'portable';
      return null;
    }
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (err) {
      unsupported = 'module';
      console.warn('[Kitsune] electron-updater недоступен:', err.message);
      return null;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    // Канал задаём явно, и это обязательно: electron-builder кладёт в
    // app-update.yml только owner/repo/provider (поля channel там нет),
    // поэтому без этой строки 32-битная сборка искала бы `latest.yml` и
    // скачала бы 64-битный установщик.
    autoUpdater.channel = state.channel;
    // Порядок важен: сеттер channel в electron-updater сам выставляет
    // allowDowngrade = true (чтобы можно было вернуться на старую ветку).
    // Запрет отката ставим ПОСЛЕ канала — иначе браузер предложил бы
    // «обновление» на более старую версию, если такой релиз опубликуют позже.
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: (m) => console.log('[Kitsune] update:', m),
      warn: (m) => console.warn('[Kitsune] update:', m),
      error: (m) => console.error('[Kitsune] update:', m),
      debug: () => {}
    };

    autoUpdater.on('checking-for-update', () => {
      patch({ status: 'checking', message: 'Проверяем обновления…', percent: 0 });
    });
    autoUpdater.on('update-available', (info) => {
      patch({
        status: 'available',
        version: String((info && info.version) || ''),
        message: `Найдена версия ${(info && info.version) || ''} — скачиваем…`,
        releaseNotes: extractNotes(info)
      });
      send('ui:toast', { text: `Доступно обновление ${state.version} — загружаем` });
    });
    autoUpdater.on('update-not-available', () => {
      patch({ status: 'current', version: '', message: 'У вас последняя версия', percent: 0 });
    });
    autoUpdater.on('download-progress', (progress) => {
      patch({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0))),
        transferred: (progress && progress.transferred) || 0,
        total: (progress && progress.total) || 0,
        bytesPerSecond: (progress && progress.bytesPerSecond) || 0,
        message: 'Скачиваем обновление…'
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      patch({
        status: 'ready',
        version: String((info && info.version) || state.version),
        percent: 100,
        message: 'Обновление готово — перезапустите браузер',
        releaseNotes: extractNotes(info) || state.releaseNotes
      });
      send('ui:toast', { text: 'Обновление загружено — перезапустите Kitsune', ms: 6000 });
    });
    autoUpdater.on('error', (err) => {
      const text = friendlyError(err);
      patch({ status: 'error', message: text });
      if (state.manual) send('ui:toast', { text: `Обновление: ${text}`, ms: 5000 });
      else console.warn('[Kitsune] Автопроверка обновлений не удалась:', text);
    });

    state.supported = true;
    return autoUpdater;
  }

  /* ─────────────────────────────── Действия ─────────────────────────────── */

  async function check({ manual = false } = {}) {
    state.manual = !!manual;
    const updater = loadModule();
    if (!updater) {
      const reason =
        unsupported === 'portable'
          ? 'Portable-версия обновляется вручную: скачайте новый файл со страницы релизов'
          : unsupported === 'dev'
            ? 'Это запуск из исходников — обновление доступно только собранной версии'
            : 'Автообновление недоступно в этой сборке';
      patch({ status: 'unsupported', message: reason });
      if (manual) send('ui:toast', { text: reason, ms: 5000 });
      return getState();
    }

    patch({ status: 'checking', message: 'Проверяем обновления…', percent: 0 });
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const text = friendlyError(err);
      patch({ status: 'error', message: text });
      if (manual) send('ui:toast', { text: `Обновление: ${text}`, ms: 5000 });
    }
    return getState();
  }

  /** Перезапуск с установкой скачанного обновления */
  function install() {
    const updater = loadModule();
    if (!updater || state.status !== 'ready') return false;
    // quitAndInstall перезапускает приложение, поэтому вызываем вне стека IPC
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (err) {
        console.error('[Kitsune] Не удалось установить обновление:', err.message);
      }
    });
    return true;
  }

  function openReleasesPage() {
    shell.openExternal(RELEASES_PAGE);
    return true;
  }

  /** Планирует автоматические проверки (только для собранного приложения) */
  function start() {
    if (!app.isPackaged) return false;
    if (settings && settings.get('autoUpdate', true) === false) return false;

    const first = setTimeout(() => check({ manual: false }), FIRST_CHECK_DELAY);
    const repeat = setInterval(() => check({ manual: false }), REPEAT_INTERVAL);
    if (typeof first.unref === 'function') first.unref();
    if (typeof repeat.unref === 'function') repeat.unref();
    return true;
  }

  /** IPC: каналы доступны только внутренним страницам браузера */
  function registerIpc(ipcMain) {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedSender(event)) return null;
        return fn(event, ...args);
      });

    handle('updater:state', () => getState());
    handle('updater:check', () => check({ manual: true }));
    handle('updater:install', () => install());
    handle('updater:open-releases', () => openReleasesPage());
  }

  return { registerIpc, start, check, install, openReleasesPage, getState, loadModule };
}

module.exports = { createUpdater, channelForArch, friendlyError, isPortableBuild, RELEASES_PAGE };





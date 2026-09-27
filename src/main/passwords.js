'use strict';

/**
 * PasswordVault — менеджер паролей: связывает форму входа на сайте,
 * шифрованное хранилище (store.js → PasswordStore) и интерфейс браузера.
 *
 * Как это работает:
 *   • preload обычного сайта слушает отправку формы и присылает сюда
 *     пару логин/пароль (канал password:capture);
 *   • здесь проверяется, что запрос пришёл действительно с этой страницы,
 *     и пользователю показывается нативный диалог «Сохранить пароль?»;
 *   • при загрузке страницы preload запрашивает пару для своего адреса
 *     (password:for-url) и заполняет форму, если автозаполнение включено;
 *   • внутренняя страница kitsune://passwords управляет хранилищем
 *     (список, показ, удаление, ручное добавление).
 *
 * Открытый пароль никогда не отдаётся обычному сайту: preload получает его
 * только для того адреса, с которого пришёл запрос.
 */

const { APP_NAME } = require('../shared/constants');
const { senderHosts, isTrustedSender, sameHost } = require('./ipc-guards');

/* Проверки отправителя (senderHosts / isTrustedSender / sameHost) живут в
   ipc-guards.js — они общие для менеджера паролей и блокировщика. */

function createPasswordVault({ store, settings, send, tabs, dialog, getWindow }) {
  // Сайты, для которых пользователь отказался сохранять пароль в этой сессии
  const dismissed = new Set();
  let asking = false;

  /** Диалог «Сохранить пароль?» — как в Chrome, только нативный */
  async function askToSave({ host, username, password, url }) {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Сохранить', 'Не сейчас'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: APP_NAME,
      message: `Сохранить пароль для ${host}?`,
      detail:
        `Логин: ${username || '(не указан)'}\n` +
        (store.secure
          ? 'Пароль будет зашифрован средствами операционной системы.'
          : 'ВНИМАНИЕ: системное шифрование недоступно — пароль сохранится в кодированном, но не защищённом виде.')
    });
    if (res.response !== 0) {
      dismissed.add(host);
      return false;
    }
    const id = store.save({ url, username, password });
    if (id) {
      send('ui:toast', { text: `Пароль для ${host} сохранён` });
      return true;
    }
    return false;
  }

  const vault = {
    store,

    /** Сохранённая пара для адреса (используется автозаполнением) */
    credentialFor(url) {
      const best = store.bestFor(url);
      if (!best) return { found: false };
      return {
        found: true,
        id: best.id,
        username: best.username,
        password: best.password,
        host: best.host,
        autofill: settings.get('autofillPasswords', true) !== false
      };
    },

    /** Обработка пары, присланной со страницы входа */
    async capture(event, data) {
      const payload = data || {};
      const url = String(payload.url || '');
      const password = String(payload.password || '');
      const username = String(payload.username || '').trim();
      if (!url || !password) return false;
      if (settings.get('savePasswords', true) === false) return false;

      const hosts = senderHosts(event);
      if (!sameHost(hosts, url)) return false; // чужой запрос — игнорируем

      const host = hostnameOf(url);
      if (!host || dismissed.has(host) || asking) return false;

      // Такая пара уже есть — просто обновляем отметку использования
      const existing = store.forUrl(url).find((item) => item.username === username);
      if (existing) {
        store.touch(existing.id);
        return true;
      }

      asking = true;
      try {
        return await askToSave({ host, username, password, url });
      } finally {
        asking = false;
      }
    },

    /** Заполняет форму активной вкладки сохранённой парой */
    fillActive(id) {
      const wc = tabs && tabs.activeWebContents;
      const item = store.find(id);
      if (!wc || wc.isDestroyed() || !item) return false;
      const secret = store.reveal(id);
      store.touch(id);
      wc.send('password:fill-active', {
        username: item.username,
        password: secret ? secret.password : ''
      });
      return true;
    },

    /**
     * Регистрирует IPC-каналы менеджера паролей.
     * @param {import('electron').IpcMain} ipcMain
     */
    registerIpc(ipcMain) {
      const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(event, ...args));

      handle('password:list', (event) => {
        if (!isTrustedSender(event)) return { items: [], secure: store.secure };
        return { items: store.list(), secure: store.secure };
      });

      handle('password:reveal', (event, id) => {
        if (!isTrustedSender(event)) return null;
        return store.reveal(id);
      });

      handle('password:save', (event, entry) => {
        if (!isTrustedSender(event)) return null;
        const id = store.save(entry || {});
        return id ? { id, items: store.list() } : null;
      });

      handle('password:remove', (event, id) => {
        if (!isTrustedSender(event)) return false;
        store.remove(id);
        return store.list();
      });

      handle('password:clear', (event) => {
        if (!isTrustedSender(event)) return false;
        store.clear();
        return true;
      });

      handle('password:fill-active', (event, id) => {
        if (!isTrustedSender(event)) return false;
        return vault.fillActive(id);
      });

      // Запросы со страниц: адрес сверяем с отправителем
      handle('password:for-url', (event, url) => {
        const target = String(url || '');
        if (!target || !sameHost(senderHosts(event), target)) return { found: false };
        return vault.credentialFor(target);
      });

      handle('password:capture', (event, data) => vault.capture(event, data));
    }
  };

  return vault;
}

module.exports = { createPasswordVault, senderHosts, isTrustedSender, sameHost };

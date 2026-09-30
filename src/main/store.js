'use strict';

/**
 * Хранилище настроек/закладок/истории Kitsune Browser.
 * Простой JSON-файл в userData — без внешних зависимостей.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { DEFAULT_SETTINGS } = require('../shared/constants');
const { hostnameOf, endsWithHost } = require('./adblock');

class Store {
  constructor(fileName, defaults = {}) {
    this.filePath = path.join(app.getPath('userData'), fileName);
    this.defaults = defaults;
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...this.defaults, ...parsed };
    } catch (err) {
      // Сохраняем повреждённый JSON, чтобы восстановление defaults не
      // уничтожало единственную копию пользовательских данных.
      if (err && err.name === 'SyntaxError' && fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        } catch {
          /* восстановление defaults всё равно должно продолжиться */
        }
      }
      return { ...this.defaults };
    }
  }

  get(key, fallback) {
    const value = this.data[key];
    if (value === undefined) return fallback !== undefined ? fallback : this.defaults[key];
    return value;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  setMany(obj) {
    Object.assign(this.data, obj);
    this.save();
  }

  all() {
    return { ...this.data };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[Kitsune] Не удалось сохранить настройки:', err.message);
    }
  }

  /**
   * Отложенная запись.
   *
   * История пишется на каждый переход, а файл истории может весить мегабайты —
   * синхронная запись на каждую навигацию подвешивала main-процесс. Изменения
   * склеиваются и попадают на диск один раз.
   */
  saveDebounced(delay = 400) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, delay);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  /** Записывает изменения немедленно (например, при выходе из браузера) */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.save();
  }
}

class SettingsStore extends Store {
  constructor() {
    super('settings.json', { ...DEFAULT_SETTINGS });
  }

  get settings() {
    return this.all();
  }
}

class HistoryStore extends Store {
  constructor() {
    super('history.json', { items: [] });
  }

  add(entry) {
    const items = this.data.items;
    const last = items[items.length - 1];
    if (last && last.url === entry.url && Date.now() - last.time < 1500) {
      last.time = Date.now();
      last.visits = (last.visits || 1) + 1;
      this.saveDebounced();
      return;
    }
    items.push({ ...entry, time: Date.now(), visits: 1 });
    if (items.length > 5000) items.splice(0, items.length - 5000);
    this.saveDebounced();
  }

  search(query, limit = 8) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const seen = new Set();
    const out = [];
    for (let i = this.data.items.length - 1; i >= 0 && out.length < limit * 3; i--) {
      const it = this.data.items[i];
      const text = `${it.title || ''} ${it.url}`.toLowerCase();
      if (!text.includes(q) || seen.has(it.url)) continue;
      seen.add(it.url);
      out.push(it);
    }
    return out.slice(0, limit);
  }

  all() {
    return this.data.items;
  }

  clear() {
    this.data.items = [];
    this.save();
  }

  remove(url) {
    this.data.items = this.data.items.filter((it) => it.url !== url);
    this.save();
  }
}

class BookmarkStore extends Store {
  constructor() {
    super('bookmarks.json', { items: [] });
  }

  list() {
    return this.data.items;
  }

  has(url) {
    return this.data.items.some((b) => b.url === url);
  }

  add({ url, title }) {
    if (!url || this.has(url)) return false;
    this.data.items.unshift({ url, title: title || url, time: Date.now() });
    this.save();
    return true;
  }

  remove(url) {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((b) => b.url !== url);
    this.save();
    return this.data.items.length !== before;
  }

  toggle({ url, title }) {
    if (this.has(url)) {
      this.remove(url);
      return false;
    }
    this.add({ url, title });
    return true;
  }
}

/**
 * Менеджер паролей Kitsune.
 *
 * Пароли шифруются средствами операционной системы (DPAPI в Windows,
 * Keychain в macOS, libsecret в Linux) через `safeStorage`. Если шифрование
 * недоступно, запись сохраняется в base64 с пометкой `raw:` — и UI честно
 * предупреждает об этом, а не делает вид, что всё защищено.
 *
 * Открытый пароль никогда не покидает main-процесс без явного запроса:
 * list() отдаёт только маску, пароль выдаёт reveal()/bestFor().
 */
class PasswordStore extends Store {
  constructor() {
    super('passwords.json', { items: [], secure: false });
  }

  /** Доступно ли шифрование средствами ОС */
  get secure() {
    try {
      return !!(
        safeStorage &&
        typeof safeStorage.isEncryptionAvailable === 'function' &&
        safeStorage.isEncryptionAvailable()
      );
    } catch {
      return false;
    }
  }

  _encrypt(plain) {
    const value = String(plain == null ? '' : plain);
    if (!value) return '';
    if (this.secure) {
      try {
        return 'enc:' + safeStorage.encryptString(value).toString('base64');
      } catch {
        /* падаем в base64 ниже */
      }
    }
    return 'raw:' + Buffer.from(value, 'utf8').toString('base64');
  }

  _decrypt(stored) {
    const value = String(stored || '');
    if (!value) return '';
    try {
      if (value.startsWith('enc:')) {
        if (!this.secure) return '';
        return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      }
      if (value.startsWith('raw:')) {
        return Buffer.from(value.slice(4), 'base64').toString('utf8');
      }
    } catch {
      return '';
    }
    return '';
  }

  /** Список для интерфейса — без паролей в открытом виде */
  list() {
    return this.data.items.map((item) => ({
      id: item.id,
      url: item.url,
      host: item.host,
      username: item.username,
      masked: item.password ? '••••••••' : '',
      time: item.time,
      used: item.used || 0
    }));
  }

  get count() {
    return this.data.items.length;
  }

  find(id) {
    return this.data.items.find((item) => item.id === id) || null;
  }

  /** Пароль в открытом виде — только по явному запросу UI */
  reveal(id) {
    const item = this.find(id);
    if (!item) return null;
    return { id: item.id, password: this._decrypt(item.password) };
  }

  /** Совпадения по хосту: точный хост, затем его поддомены */
  forUrl(url) {
    const host = hostnameOf(url);
    if (!host) return [];
    return this.data.items
      .filter((item) => item.host === host || endsWithHost(host, item.host))
      .sort((a, b) => (b.used || 0) - (a.used || 0));
  }

  /** Лучшая пара для адреса — используется для автозаполнения */
  bestFor(url) {
    const [item] = this.forUrl(url);
    if (!item) return null;
    return {
      id: item.id,
      url: item.url,
      host: item.host,
      username: item.username,
      password: this._decrypt(item.password)
    };
  }

  /** Уже сохранён такой логин для этого сайта? */
  has(url, username = '') {
    const host = hostnameOf(url);
    if (!host) return false;
    return this.data.items.some((item) => item.host === host && item.username === String(username || '').trim());
  }

  /** Сохраняет или обновляет пару. Возвращает id записи. */
  save({ url, username = '', password = '' } = {}) {
    const host = hostnameOf(url);
    const secret = String(password == null ? '' : password);
    if (!host || !secret) return null;

    const user = String(username || '').trim();
    const existing = this.data.items.find((item) => item.host === host && item.username === user);
    if (existing) {
      existing.url = String(url);
      existing.password = this._encrypt(secret);
      existing.time = Date.now();
      this.data.secure = this.secure;
      this.save();
      return existing.id;
    }

    const item = {
      id: `pw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      url: String(url),
      host,
      username: user,
      password: this._encrypt(secret),
      time: Date.now(),
      used: 0
    };
    this.data.items.unshift(item);
    if (this.data.items.length > 1000) this.data.items.length = 1000;
    this.data.secure = this.secure;
    this.save();
    return item.id;
  }

  /** Отмечает использование — влияет на порядок при автозаполнении */
  touch(id) {
    const item = this.find(id);
    if (!item) return false;
    item.used = Date.now();
    this.saveDebounced();
    return true;
  }

  remove(id) {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((item) => item.id !== id);
    if (this.data.items.length === before) return false;
    this.save();
    return true;
  }

  clear() {
    this.data.items = [];
    this.save();
  }
}

module.exports = { Store, SettingsStore, HistoryStore, BookmarkStore, PasswordStore };

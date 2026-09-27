'use strict';

/**
 * ipc-guards.js — проверки отправителя IPC-сообщений.
 *
 * Renderer-процесс может быть скомпрометирован (сайт, XSS), поэтому каналы
 * с приватными данными (пароли, история, закладки, настройки) обязаны
 * проверять, кто именно их вызывает:
 *   • внутренние страницы браузера загружаются через file://;
 *   • запросы обычных сайтов принимаются только для «своего» домена.
 */

const { hostnameOf } = require('./adblock');

/** Хосты отправителя запроса: адрес вкладки и адрес фрейма */
function senderHosts(event) {
  const hosts = [];
  try {
    const url = event.sender.getURL();
    if (url) hosts.push(hostnameOf(url));
  } catch {
    /* webContents уже уничтожен */
  }
  try {
    const frameUrl = event.senderFrame && event.senderFrame.url;
    if (frameUrl) hosts.push(hostnameOf(frameUrl));
  } catch {
    /* фрейм недоступен */
  }
  return hosts.filter(Boolean);
}

/** Запрос пришёл со внутренней страницы браузера (file://)? */
function isTrustedSender(event) {
  const sources = [];
  try {
    sources.push(String(event.sender.getURL() || ''));
  } catch {
    /* игнорируем */
  }
  try {
    if (event.senderFrame) sources.push(String(event.senderFrame.url || ''));
  } catch {
    /* игнорируем */
  }
  return sources.some((url) => url.startsWith('file://'));
}

/** Одинаковый ли сайт у запрошенного адреса и у отправителя */
function sameHost(hosts, url) {
  const target = hostnameOf(url);
  if (!target) return false;
  return hosts.some(
    (host) => host === target || host.endsWith('.' + target) || target.endsWith('.' + host)
  );
}

module.exports = { senderHosts, isTrustedSender, sameHost };

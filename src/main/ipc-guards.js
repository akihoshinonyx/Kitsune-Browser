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
const path = require('path');
const { fileURLToPath } = require('url');
const { INTERNAL_PAGES } = require('../shared/constants');
const rendererDir = path.join(__dirname, '..', 'renderer');
const trustedFiles = new Set(['index.html', ...Object.values(INTERNAL_PAGES).map((file) => path.join('pages', file))]
  .map((file) => path.resolve(rendererDir, file)));

function isTrustedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && !parsed.hostname && trustedFiles.has(path.resolve(fileURLToPath(parsed)));
  } catch { return false; }
}

/** Хосты отправителя запроса: адрес вкладки и адрес фрейма */
function senderHosts(event) {
  const hosts = [];
  try {
    const url = event.senderFrame ? event.senderFrame.url : event.sender.getURL();
    if (url) hosts.push(hostnameOf(url));
  } catch {
    /* webContents уже уничтожен */
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
  return sources.length > 0 && sources.every(isTrustedUrl);
}

/** Одинаковый ли сайт у запрошенного адреса и у отправителя */
function sameHost(hosts, url) {
  const target = hostnameOf(url);
  if (!target) return false;
  return hosts.some(
    (host) => host === target
  );
}

module.exports = { senderHosts, isTrustedSender, sameHost, isTrustedUrl };

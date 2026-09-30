'use strict';

const MAX_IMPORT_ITEMS = 10000;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

function validUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bookmarksToHtml(items) {
  const rows = (Array.isArray(items) ? items : [])
    .map((item) => {
      const url = validUrl(item && item.url);
      if (!url) return '';
      const title = escapeHtml(item.title || url);
      return `    <DT><A HREF="${escapeHtml(url)}">${title}</A>\n`;
    })
    .filter(Boolean)
    .join('');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file. -->\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Kitsune Browser bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${rows}</DL><p>\n`;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&amp;|&#38;|&#x26;/gi, '&')
    .replace(/&lt;|&#60;|&#x3c;/gi, '<')
    .replace(/&gt;|&#62;|&#x3e;/gi, '>')
    .replace(/&#39;|&#x27;/gi, "'");
}

function parseBookmarksHtml(html) {
  const source = String(html || '');
  const isNetscape = /NETSCAPE-Bookmark-file/i.test(source);
  if (!isNetscape && !/<A\b/i.test(source)) {
    throw new Error('Ожидался HTML-файл закладок Netscape');
  }
  const result = [];
  const re = /<A\b[^>]*\bHREF\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/A>/gi;
  let match;
  while ((match = re.exec(source)) && result.length < MAX_IMPORT_ITEMS) {
    const url = validUrl(decodeHtml(match[1]));
    if (!url) continue;
    const title = decodeHtml(match[2].replace(/<[^>]+>/g, '').trim()) || url;
    result.push({ url, title });
  }
  if (!result.length && !isNetscape) throw new Error('В HTML не найдено подходящих закладок');
  return result;
}

function historyToJson(items) {
  return JSON.stringify({ format: 'kitsune-history', version: 1, items: (Array.isArray(items) ? items : []).slice(-5000) }, null, 2) + '\n';
}

function parseHistoryJson(text) {
  let parsed;
  try { parsed = JSON.parse(String(text || '')); } catch {
    throw new Error('История имеет некорректный JSON-формат');
  }
  const source = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.items) ? parsed.items : null;
  if (!source) throw new Error('Ожидался JSON-массив истории');
  const result = source.slice(0, MAX_IMPORT_ITEMS).map((item) => {
    const url = validUrl(item && item.url);
    if (!url) return null;
    return {
      url,
      title: String(item.title || url).slice(0, 500),
      time: Number.isFinite(Number(item.time)) ? Number(item.time) : Date.now(),
      visits: Math.max(1, Math.min(100000, Number(item.visits) || 1))
    };
  }).filter(Boolean);
  if (!result.length && source.length > 0) throw new Error('В JSON не найдено подходящих записей истории');
  return result;
}

module.exports = {
  MAX_IMPORT_ITEMS,
  MAX_IMPORT_BYTES,
  bookmarksToHtml,
  parseBookmarksHtml,
  historyToJson,
  parseHistoryJson
};
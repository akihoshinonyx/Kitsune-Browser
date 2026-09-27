'use strict';

const { AdBlocker } = require('../adblock');
const { KITSUNE_FILTERS } = require('./kitsune-base.txt.js');
const fs = require('fs');
const path = require('path');

/** Списки, которые можно скачать кнопкой «Обновить списки» */
const FILTER_SOURCES = [
  {
    file: 'easylist.txt',
    url: 'https://easylist.to/easylist/easylist.txt',
    name: 'EasyList'
  },
  {
    file: 'easyprivacy.txt',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    name: 'EasyPrivacy'
  },
  {
    file: 'easylist-cookie.txt',
    url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    name: 'EasyList Cookie'
  }
];

/** Файл с правилами, которые добавил сам пользователь */
const USER_FILTER_FILE = 'adblock-user.txt';

/**
 * Загружает в блокировщик все доступные списки:
 *  - встроенный базовый список (kitsune-base)
 *  - пользовательский adblock-user.txt
 *  - любые *.txt в папке filters и в userData (например, easylist.txt)
 *
 * @param {AdBlocker} blocker
 * @param {{filtersDir?: string, userDataDir?: string, log?: boolean}} options
 * @returns {{base: number, lists: string[]}}
 */
function loadFilterLists(blocker, { filtersDir, userDataDir, log = true } = {}) {
  const baseCount = blocker.addFiltersFromText(KITSUNE_FILTERS, 'Kitsune Base');
  const lists = ['Kitsune Base'];

  const dirs = [filtersDir, userDataDir].filter(Boolean);
  for (const dir of dirs) {
    for (const file of listFilterFiles(dir)) {
      try {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const added = blocker.addFiltersFromText(text, file);
        lists.push(file);
        if (log) console.log(`[Kitsune] Список "${file}": загружено ${added} правил`);
      } catch (err) {
        console.warn(`[Kitsune] Не удалось загрузить список "${file}":`, err.message);
      }
    }
  }

  return { base: baseCount, lists };
}

/**
 * Создаёт AdBlocker и наполняет его правилами.
 */
function createAdBlocker({ enabled = true, filtersDir, userDataDir } = {}) {
  const blocker = new AdBlocker({ enabled });
  const { base } = loadFilterLists(blocker, { filtersDir, userDataDir });

  console.log(
    `[Kitsune] Блокировщик готов: ${blocker.rulesCount} правил ` +
    `(база: ${base}), пропущено: ${blocker.skippedCount}`
  );
  return blocker;
}

/**
 * Скачивает внешние списки (EasyList и др.) в userData.
 *
 * Это заметно расширяет покрытие, но и добавляет десятки тысяч правил,
 * поэтому запускается только по кнопке в интерфейсе.
 *
 * @param {string} userDataDir
 * @param {(url:string)=>Promise<string>} fetchText
 * @returns {Promise<{file:string, name:string, rules:number, error?:string}[]>}
 */
async function downloadFilterLists(userDataDir, fetchText) {
  const results = [];
  for (const source of FILTER_SOURCES) {
    try {
      const text = await fetchText(source.url);
      if (!text || text.length < 1000) throw new Error('пустой ответ');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(path.join(userDataDir, source.file), text, 'utf8');
      const rules = text.split(/\r?\n/).filter((line) => {
        const t = line.trim();
        return t && !t.startsWith('!') && !t.startsWith('[');
      }).length;
      results.push({ file: source.file, name: source.name, rules });
    } catch (err) {
      results.push({ file: source.file, name: source.name, rules: 0, error: err.message });
    }
  }
  return results;
}

function listFilterFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => {
        if (!f.endsWith('.txt')) return false;
        if (f === 'extra-example.txt') return false; // пример, а не список
        return true;
      });
  } catch {
    return [];
  }
}

module.exports = {
  createAdBlocker,
  loadFilterLists,
  downloadFilterLists,
  listFilterFiles,
  FILTER_SOURCES,
  USER_FILTER_FILE
};

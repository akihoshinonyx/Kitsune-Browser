'use strict';

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const { isTrustedSender } = require('./ipc-guards');

/** Загрузки существуют независимо от вкладки-источника. История хранится в userData. */
function createDownloads({ send, directory = () => app.getPath('downloads'), dataFile = () => path.join(app.getPath('userData'), 'downloads.json') }) {
  let records = [];
  const live = new Map();
  const reservedPaths = new Set();
  let sequence = 0;
  try {
    records = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    if (!Array.isArray(records)) records = [];
    records = records.filter((r) => r && typeof r.id === 'number').slice(0, 200).map((r) => ({
      ...r, status: r.status === 'downloading' ? 'interrupted' : r.status
    }));
    sequence = Math.max(0, ...records.map((r) => r.id));
  } catch { records = []; }

  function list() { return records.map((r) => ({ ...r })); }
  function notify() { send('downloads:changed', list()); }
  function save() {
    try {
      fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
      fs.writeFileSync(dataFile(), JSON.stringify(records, null, 2));
    } catch (err) { console.warn('[Kitsune] Не удалось сохранить загрузки:', err.message); }
  }
  function uniquePath(folder, name) {
    const safe = path.basename(String(name || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')) || 'download';
    const ext = path.extname(safe);
    const base = safe.slice(0, safe.length - ext.length);
    let candidate = path.join(folder, safe);
    for (let n = 1; fs.existsSync(candidate) || reservedPaths.has(candidate); n++) candidate = path.join(folder, `${base} (${n})${ext}`);
    return candidate;
  }
  function attach(ses) {
    ses.on('will-download', (_event, item) => {
      let target;
      try {
        fs.mkdirSync(directory(), { recursive: true });
        target = uniquePath(directory(), item.getFilename());
        item.setSavePath(target);
        reservedPaths.add(target);
      } catch (err) {
        item.cancel();
        send('ui:toast', { text: `Не удалось начать загрузку: ${err.message}` });
        return;
      }
      const record = {
        id: ++sequence, name: path.basename(target), path: target, url: item.getURL(),
        received: 0, total: item.getTotalBytes(), status: 'downloading', startedAt: Date.now()
      };
      records.unshift(record);
      records = records.slice(0, 200);
      live.set(record.id, item);
      save(); notify();
      item.on('updated', () => {
        record.received = item.getReceivedBytes();
        record.total = item.getTotalBytes();
        notify();
      });
      item.once('done', (_e, state) => {
        live.delete(record.id);
        reservedPaths.delete(target);
        record.received = item.getReceivedBytes();
        record.status = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
        save(); notify();
        if (record.status === 'completed') send('ui:toast', { text: `Скачано: ${record.name}` });
      });
    });
  }
  function cancel(id) {
    const item = live.get(id);
    if (!item) return false;
    item.cancel();
    return true;
  }
  function open(id, folder = false) {
    const record = records.find((r) => r.id === id);
    if (!record || record.status !== 'completed' || !fs.existsSync(record.path)) return false;
    if (folder) shell.showItemInFolder(record.path);
    else shell.openPath(record.path);
    return true;
  }
  function registerIpc(ipcMain, isPrivateSender = () => false) {
    const handle = (name, fn) => ipcMain.handle(name, (event, ...args) =>
      !isPrivateSender(event) && isTrustedSender(event) ? fn(...args) : null);
    handle('downloads:list', list);
    handle('downloads:cancel', cancel);
    handle('downloads:open', (id) => open(id));
    handle('downloads:folder', (id) => open(id, true));
  }
  return { attach, list, cancel, open, registerIpc, uniquePath };
}

module.exports = { createDownloads };

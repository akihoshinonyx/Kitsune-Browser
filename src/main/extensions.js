'use strict';

/** Установка WebExtension-пакетов Firefox/Chromium. Electron 44 не загружает XPI напрямую. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 150 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.xpi', '.zip']);

function safeId(value) {
  return String(value || '').replace(/[^a-z0-9._-]/gi, '_').slice(0, 80) || 'extension';
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('В архиве нет manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('manifest.json имеет неверный формат'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest.json должен быть объектом');
  if (!manifest.name || typeof manifest.name !== 'string') throw new Error('В manifest.json отсутствует имя расширения');
  const version = String(manifest.version || '0');
  if (!/^[\w. +()-]{1,128}$/u.test(version)) throw new Error('Недопустимая версия расширения');
  return { name: manifest.name.slice(0, 200), version, manifestVersion: Number(manifest.manifest_version) || 2 };
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Архив содержит небезопасный путь');
}

function unpackArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const listing = spawnSync('tar.exe', ['-tf', archive], { windowsHide: true, encoding: 'utf8' });
  if (!listing.error && listing.status === 0) {
    for (const entry of String(listing.stdout || '').split(/\r?\n/).filter(Boolean)) {
      const normalized = entry.replace(/\\/g, '/');
      if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Архив содержит небезопасный путь');
    }
  }
  let result = spawnSync('tar.exe', ['-xf', archive, '-C', destination], { windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const a = archive.replace(/'/g, "''");
    const d = destination.replace(/'/g, "''");
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${a}' -DestinationPath '${d}' -Force`], { windowsHide: true, encoding: 'utf8' });
  }
  if (result.error || result.status !== 0) throw new Error('Не удалось распаковать архив расширения');
}

function findManifestRoot(directory) {
  if (fs.existsSync(path.join(directory, 'manifest.json'))) return directory;
  const folders = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (folders.length === 1 && fs.existsSync(path.join(directory, folders[0].name, 'manifest.json'))) return path.join(directory, folders[0].name);
  throw new Error('manifest.json не найден в корне расширения');
}

function validateTree(root) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      assertInside(root, item);
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) throw new Error('Расширения с символическими ссылками не поддерживаются');
      if (stat.isDirectory()) walk(item);
      else { total += stat.size; if (total > MAX_UNPACKED_BYTES) throw new Error('Распакованный пакет слишком большой'); }
    }
  };
  walk(root);
}

module.exports = { readManifest, validateTree, unpackArchive, findManifestRoot, MAX_PACKAGE_BYTES, MAX_UNPACKED_BYTES, safeId };

function createExtensionManager({ app, session, net, dialog, send }) {
  const root = path.join(app.getPath('userData'), 'extensions');
  const metadataFile = path.join(root, 'installed.json');
  const loaded = new Map();
  let metadata = [];
  try { metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); if (!Array.isArray(metadata)) metadata = []; } catch { metadata = []; }
  const save = () => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8'); };
  const list = () => metadata.map((item) => ({ ...item }));

  async function installPackage(filePath, targetSession = session.fromPartition('persist:kitsune')) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('Пакет расширения слишком большой или недоступен');
    if (!new Set(['.xpi', '.zip']).has(path.extname(filePath).toLowerCase())) throw new Error('Поддерживаются только файлы .xpi и .zip');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-extension-'));
    try {
      unpackArchive(filePath, work);
      const source = findManifestRoot(work); validateTree(source); const manifest = readManifest(source);
      const id = crypto.createHash('sha256').update(`${manifest.name}:${manifest.version}`).digest('hex').slice(0, 24);
      const destination = path.join(root, safeId(id)); fs.rmSync(destination, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(source, destination, { recursive: true, dereference: false });
      const details = await targetSession.loadExtension(destination, { allowFileAccess: false });
      const item = { id: details.id || id, name: manifest.name, version: manifest.version, path: destination, installedAt: Date.now() };
      if (metadata.some((entry) => entry.id === item.id)) { try { targetSession.removeExtension(item.id); } catch {} metadata = metadata.filter((entry) => entry.id !== item.id); }
      metadata.push(item); loaded.set(item.id, targetSession); save(); send('extensions:changed', list()); return { ...item };
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  }

  async function installFromFile(targetSession) {
    const result = await dialog.showOpenDialog(null, { title: 'Установить расширение Firefox', properties: ['openFile'], filters: [{ name: 'WebExtension', extensions: ['xpi', 'zip'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, extension: await installPackage(result.filePaths[0], targetSession) };
  }

  async function installFromUrl(url, targetSession) {
    const parsed = new URL(String(url)); if (parsed.protocol !== 'https:') throw new Error('Расширения можно скачивать только по HTTPS');
    const response = await net.fetch(parsed.href, { redirect: 'error' }); if (!response.ok) throw new Error(`Не удалось скачать расширение: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > MAX_PACKAGE_BYTES) throw new Error('Пакет расширения слишком большой');
    const temporary = path.join(os.tmpdir(), `kitsune-extension-${Date.now()}.xpi`); fs.writeFileSync(temporary, buffer, { flag: 'wx' });
    try { return await installPackage(temporary, targetSession); } finally { fs.rmSync(temporary, { force: true }); }
  }

  function remove(id, targetSession = session.fromPartition('persist:kitsune')) {
    const item = metadata.find((entry) => entry.id === id); if (!item) return false;
    try { targetSession.removeExtension(id); } catch {} loaded.delete(id); metadata = metadata.filter((entry) => entry.id !== id);
    fs.rmSync(item.path, { recursive: true, force: true }); save(); send('extensions:changed', list()); return true;
  }

  async function loadInstalled(targetSession = session.fromPartition('persist:kitsune')) {
    const valid = [];
    for (const item of metadata) { try { if (!fs.existsSync(path.join(item.path, 'manifest.json'))) continue; await targetSession.loadExtension(item.path, { allowFileAccess: false }); loaded.set(item.id, targetSession); valid.push(item); } catch (err) { console.warn(`[Kitsune] Не удалось загрузить расширение ${item.name}:`, err.message); } }
    metadata = valid; save(); return list();
  }
  return { list, installPackage, installFromFile, installFromUrl, remove, loadInstalled, root };
}

module.exports.createExtensionManager = createExtensionManager;
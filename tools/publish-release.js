'use strict';

/**
 * publish-release.js — публикация установщиков в GitHub Releases.
 *
 * Запуск:
 *   PowerShell:  $env:GH_TOKEN="ghp_…"; npm run publish:release
 *   CI:          GITHUB_TOKEN выдаётся GitHub Actions автоматически
 *
 * Что делает:
 *   1) берёт версию из package.json и тег `v<версия>` (можно задать --tag=);
 *   2) создаёт релиз или обновляет описание у существующего;
 *   3) загружает установщики, portable-сборки, blockmap-файлы (для
 *      дифференциальных обновлений), файлы каналов (`latest.yml` для x64 и
 *      `win32.yml` для ia32), `SHA256SUMS.txt` и `build-info.json`;
 *   4) если файл с таким именем уже есть в релизе — заменяет его
 *      (скрипт идемпотентный, повторный запуск не ломает релиз).
 *
 * Флаги: `--tag=v1.2.3`, `--notes=путь`, `--draft`, `--dry-run`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const pkg = require(path.join(ROOT, 'package.json'));

const OWNER = 'akihoshinonyx';
const REPO = 'Kitsune-Browser';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const UPLOAD_API = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases`;

/** Значение флага вида `--name=value` */
function argValue(name, fallback = '') {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

const hasFlag = (name) => process.argv.includes(`--${name}`);

function token() {
  const value = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!value) {
    throw new Error(
      'не задан токен GitHub. Нужен GH_TOKEN (или GITHUB_TOKEN) с правом repo/public_repo:\n' +
        '  PowerShell:  $env:GH_TOKEN="ghp_..."; npm run publish:release'
    );
  }
  return value;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Запрос к GitHub API с понятными ошибками */
async function request(url, options = {}) {
  const { allow404 = false, ...init } = options;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kitsune-release-script',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    }
  });

  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Файлы, которые в релиз не попадают.
 *
 * `builder-debug.yml` создаётся electron-builder для отладки, но подходит под
 * маску `*.yml` — из-за этого он однажды уехал в релиз, а повторная загрузка
 * (второй такой файл из другой архитектуры) получила от GitHub 422 и оборвала
 * публикацию. Отсюда и явный список исключений, и проверка в конце.
 */
const IGNORED_ASSETS = new Set(['builder-debug.yml', 'builder-effective-config.yaml']);

/** Файлы релиза: установщики, portable, blockmap, каналы и контрольные суммы */
function collectAssets() {
  const assets = [];
  for (const arch of ['x64', 'ia32']) {
    const dir = path.join(RELEASE, arch);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (IGNORED_ASSETS.has(name)) continue;
      if (/\.(exe|blockmap|yml)$/.test(name)) assets.push({ file: path.join(dir, name), name });
    }
  }
  for (const extra of ['SHA256SUMS.txt', 'build-info.json']) {
    const file = path.join(RELEASE, extra);
    if (fs.existsSync(file)) assets.push({ file, name: extra });
  }
  return assets;
}

/** Описание релиза — текст из docs/RELEASE-NOTES.md */
function releaseNotes(version) {
  const file = argValue('notes', path.join('docs', 'RELEASE-NOTES.md'));
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(full)) return `Kitsune Browser ${version}`;
  return fs
    .readFileSync(full, 'utf8')
    .replace(/\{\{VERSION\}\}/g, version)
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10));
}

/* ─────────────────────────── Работа с релизом ─────────────────────────── */

async function ensureRelease(tag, version, notes, draft) {
  const existing = await request(`${API}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });
  const payload = {
    name: `Kitsune Browser ${version}`,
    body: notes,
    draft,
    prerelease: false
  };

  if (existing) {
    console.log(`Релиз ${tag} уже существует — обновляем описание`);
    return request(`${API}/releases/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  }

  console.log(`Создаём релиз ${tag}`);
  return request(`${API}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, ...payload })
  });
}

async function uploadAssets(release, assets) {
  // Карта имён → ассет: и то, что уже лежит в релизе, и то, что мы загрузили
  // в этом запуске. Повтор имени GitHub не допускает (422), поэтому перед
  // загрузкой старый файл удаляется.
  const byName = new Map((release.assets || []).map((a) => [a.name, a]));

  for (const asset of assets) {
    const existing = byName.get(asset.name);
    if (existing) {
      await request(`${API}/releases/assets/${existing.id}`, { method: 'DELETE' });
      byName.delete(asset.name);
    }
    const size = fs.statSync(asset.file).size;
    process.stdout.write(`  ${existing ? 'перезапись' : 'загрузка'} ${asset.name} (${humanSize(size)}) … `);
    const uploaded = await request(`${UPLOAD_API}/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(asset.file)
    });
    byName.set(uploaded.name, uploaded);
    console.log('готово');
  }
}

/** Убирает из релиза файлы, которых там быть не должно (мусор прошлых запусков) */
async function pruneAssets(release, expected) {
  const names = new Set(expected.map((a) => a.name));
  for (const asset of release.assets || []) {
    if (names.has(asset.name)) continue;
    console.log(`  удаляем лишний файл: ${asset.name}`);
    await request(`${API}/releases/assets/${asset.id}`, { method: 'DELETE' });
  }
}

/**
 * Проверяет, что в релизе действительно лежит всё нужное и что каналы
 * обновления указывают на существующие файлы. Молчаливый «частично
 * опубликованный» релиз хуже упавшей сборки, поэтому проверка обязательна.
 */
async function verifyRelease(tag, expected) {
  const fresh = await request(`${API}/releases/tags/${encodeURIComponent(tag)}`);
  const byName = new Map((fresh.assets || []).map((a) => [a.name, a]));
  const problems = [];

  for (const asset of expected) {
    const uploaded = byName.get(asset.name);
    if (!uploaded) {
      problems.push(`нет файла ${asset.name}`);
      continue;
    }
    const local = fs.statSync(asset.file).size;
    if (uploaded.size !== local) {
      problems.push(`${asset.name}: размер на GitHub ${uploaded.size} вместо ${local}`);
    }
  }

  // Каждый канал должен ссылаться на установщик, который тоже загружен
  for (const channel of ['latest.yml', 'win32.yml']) {
    const asset = expected.find((a) => a.name === channel);
    if (!asset) {
      problems.push(`нет файла канала ${channel}`);
      continue;
    }
    const text = fs.readFileSync(asset.file, 'utf8');
    const target = (text.match(/^path:\s*(.+)$/m) || [])[1];
    if (!target || !byName.has(target.trim())) {
      problems.push(`${channel} ссылается на отсутствующий файл: ${target || '—'}`);
    }
  }

  if (problems.length) throw new Error(`релиз опубликован неполностью: ${problems.join('; ')}`);

  console.log('\nВ релизе:');
  for (const asset of expected) {
    const uploaded = byName.get(asset.name);
    console.log(`  ${uploaded.name.padEnd(52)} ${humanSize(uploaded.size).padStart(9)}`);
  }
  return fresh;
}

/* ─────────────────────────────────── Запуск ─────────────────────────────────── */

async function main() {
  const version = pkg.version;
  const tag = argValue('tag', `v${version}`);
  const notes = releaseNotes(version);
  const assets = collectAssets();
  const dryRun = hasFlag('dry-run');
  const draft = hasFlag('draft');

  console.log(`Публикация Kitsune Browser ${version} в ${OWNER}/${REPO}`);
  console.log(`Тег: ${tag}${draft ? ' (черновик)' : ''}`);
  console.log(`Описание: ${notes.length} символов`);
  console.log(`Файлов: ${assets.length}`);
  for (const asset of assets) {
    console.log(`  ${asset.name} — ${humanSize(fs.statSync(asset.file).size)}`);
  }

  if (!assets.length) throw new Error('нет собранных файлов в release/ — сначала выполните npm run dist');
  if (dryRun) {
    console.log('\n--dry-run: ничего не отправлено');
    return;
  }

  const release = await ensureRelease(tag, version, notes, draft);
  await pruneAssets(release, assets);
  await uploadAssets(release, assets);
  await verifyRelease(tag, assets);

  console.log(`\nГотово: ${release.html_url}`);
  console.log('Установленные копии подхватят обновление в течение 6 часов (или по кнопке «Проверить обновления»).');
}

main().catch((err) => {
  console.error(`\n[ОШИБКА] ${err.message}`);
  process.exit(1);
});


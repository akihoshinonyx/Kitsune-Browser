'use strict';

/**
 * build-installers.js — сборка обоих установщиков Kitsune Browser.
 *
 * Запуск: `npm run dist` (или `node tools/build-installers.js`).
 *
 * Что делает:
 *   1) собирает 64-битный установщик + portable (Electron 44);
 *   2) собирает 32-битный установщик + portable (Electron 43 — последняя
 *      ветка Electron с бинарниками win32-ia32: в 44 их больше нет);
 *   3) переименовывает файл канала обновлений 32-битной сборки из
 *      `latest.yml` в `win32.yml` — иначе обе сборки претендовали бы на один
 *      и тот же файл в релизе и 32-битный браузер скачал бы 64-битный
 *      установщик;
 *   4) проверяет каждый собранный билд, запуская его в режиме
 *      `--kitsune-diagnostics` (окно не открывается, отчёт пишется в JSON);
 *   5) считает SHA-256 установщиков и пишет `release/SHA256SUMS.txt`
 *      и `release/build-info.json`.
 *
 * Флаги: `--only=x64|ia32`, `--no-verify`, `--skip-build`.
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const pkg = require(path.join(ROOT, 'package.json'));

const TARGETS = [
  {
    arch: 'x64',
    electron: '44.4.5',
    config: 'build/electron-builder.x64.json',
    channel: 'latest',
    title: '64-битная сборка (x64, Electron 44)'
  },
  {
    arch: 'ia32',
    electron: '43.7.5',
    config: 'build/electron-builder.ia32.json',
    channel: 'win32',
    title: '32-битная сборка (ia32, Electron 43 — последняя с поддержкой 32 бит)'
  }
];

/* ───────────────────────────── Утилиты ───────────────────────────── */

function log(step, text) {
  console.log(`\n=== [${step}] ${text}`);
}

function run(executable, args) {
  const res = spawnSync(executable, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${path.basename(executable)} ${args.join(' ')} — код выхода ${res.status}`);
}

/** CLI electron-builder: запускаем через сам Node, без cmd/npx-обёрток */
const BUILDER_CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(filter)
    .map((name) => path.join(dir, name))
    .sort();
}

/* ─────────────────────────── Сборка одной платформы ─────────────────────────── */

function buildTarget(target) {
  log(target.arch, `${target.title} — сборка`);

  const outputDir = path.join(RELEASE, target.arch);
  fs.rmSync(outputDir, { recursive: true, force: true });

  if (!fs.existsSync(BUILDER_CLI)) throw new Error(`не найден electron-builder: ${BUILDER_CLI} (запустите npm install)`);

  run(process.execPath, [
    BUILDER_CLI,
    '--config',
    target.config,
    '--win',
    `--${target.arch}`,
    '--publish',
    'never'
  ]);

  // 32-битной сборке нужен свой файл канала, иначе релиз получит два latest.yml
  const channelFile = path.join(outputDir, 'latest.yml');
  if (target.channel !== 'latest' && fs.existsSync(channelFile)) {
    fs.renameSync(channelFile, path.join(outputDir, `${target.channel}.yml`));
  }
  return outputDir;
}

/* ─────────────────────── Проверка собранного приложения ─────────────────────── */

/**
 * Запускает собранный браузер в режиме диагностики и сверяет отчёт с
 * ожиданиями. Это единственный способ убедиться, что установщик содержит
 * рабочий файл: 32-битный Electron запускается на 64-битной Windows через
 * WOW64, поэтому проверить можно прямо здесь.
 */
/**
 * Каталог распакованного приложения внутри release/<arch>/.
 * electron-builder называет его по-разному: для x64 — `win-unpacked`,
 * для ia32 — `win-ia32-unpacked`.
 */
function unpackedDir(outputDir, arch) {
  const candidates = [`win-${arch}-unpacked`, 'win-unpacked'];
  for (const name of candidates) {
    const dir = path.join(outputDir, name);
    if (fs.existsSync(path.join(dir, 'Kitsune Browser.exe'))) return dir;
  }
  const found = fs.existsSync(outputDir)
    ? fs
        .readdirSync(outputDir)
        .find(
          (name) =>
            name.endsWith('-unpacked') && fs.existsSync(path.join(outputDir, name, 'Kitsune Browser.exe'))
        )
    : null;
  return path.join(outputDir, found || candidates[0]);
}

function verifyTarget(target, outputDir) {
  const exe = path.join(unpackedDir(outputDir, target.arch), 'Kitsune Browser.exe');
  if (!fs.existsSync(exe)) throw new Error(`не найден собранный файл: ${exe}`);

  const report = path.join(os.tmpdir(), `kitsune-diagnostics-${target.arch}.json`);
  fs.rmSync(report, { force: true });

  log(target.arch, 'проверка запуска собранного приложения');
  const res = spawnSync(exe, [`--kitsune-diagnostics-out=${report}`], {
    cwd: path.dirname(exe),
    timeout: 120000,
    windowsHide: true
  });

  if (!fs.existsSync(report)) {
    throw new Error(
      `приложение не записало отчёт диагностики (код ${res.status}). stderr: ${String(res.stderr || '')}`
    );
  }

  const info = JSON.parse(fs.readFileSync(report, 'utf8'));
  const problems = [];
  if (info.arch !== target.arch) problems.push(`arch=${info.arch}, ожидалось ${target.arch}`);
  if (info.electron !== target.electron) problems.push(`electron=${info.electron}, ожидалось ${target.electron}`);
  if (!info.packaged) problems.push('приложение считает себя запущенным из исходников');
  if (info.updateChannel !== target.channel) {
    problems.push(`канал обновлений ${info.updateChannel}, ожидался ${target.channel}`);
  }
  if (!(info.filterRules > 100)) problems.push(`правил блокировки загружено: ${info.filterRules}`);
  if (problems.length) throw new Error(`проверка ${target.arch} не прошла: ${problems.join('; ')}`);

  console.log(
    `[${target.arch}] OK: Electron ${info.electron}, Chromium ${info.chrome}, ` +
      `правил ${info.filterRules}, канал ${info.updateChannel}`
  );
  return info;
}

/* ───────────────────── Контрольные суммы и манифест сборки ───────────────────── */

/** Файлы релиза: установщики, portable, blockmap и файлы каналов обновления */
function collectArtifacts() {
  const out = [];
  for (const target of TARGETS) {
    const dir = path.join(RELEASE, target.arch);
    for (const file of listFiles(dir, (name) => /\.(exe|blockmap|yml)$/.test(name))) {
      // builder-debug.yml — отладочный файл electron-builder, в релиз не идёт
      if (path.basename(file) === 'builder-debug.yml') continue;
      out.push({ target, file });
    }
  }
  return out;
}

/**
 * `SHA256SUMS.txt` — контрольные суммы скачиваемых установщиков (проверка:
 * `certutil -hashfile <файл> SHA256`), `build-info.json` — машинный манифест
 * релиза: версии Electron, каналы, размеры и суммы всех файлов.
 */
function writeChecksums() {
  const lines = [];
  const manifest = {
    name: pkg.productName,
    version: pkg.version,
    generatedAt: new Date().toISOString(),
    artifacts: []
  };

  for (const { target, file } of collectArtifacts()) {
    const name = path.basename(file);
    const sum = sha256(file);
    const size = fs.statSync(file).size;
    // В контрольные суммы попадают только исполняемые файлы: их качает
    // пользователь. Файлы каналов проверяются самим updater'ом (SHA-512).
    if (name.endsWith('.exe')) lines.push(`${sum}  ${target.arch}/${name}`);
    manifest.artifacts.push({
      arch: target.arch,
      electron: target.electron,
      channel: target.channel,
      name,
      size,
      sha256: sum
    });
  }

  fs.writeFileSync(path.join(RELEASE, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(RELEASE, 'build-info.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function printSummary(manifest) {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(` Kitsune Browser ${manifest.version} — готово`);
  console.log('──────────────────────────────────────────────────────────────');
  for (const target of TARGETS) {
    const files = manifest.artifacts.filter((a) => a.arch === target.arch);
    if (!files.length) continue;
    console.log(`\n ${target.title}`);
    for (const file of files) {
      console.log(
        `   ${file.name.padEnd(52)} ${humanSize(file.size).padStart(9)}  ${file.sha256.slice(0, 16)}…`
      );
    }
  }
  console.log('\n Суммы:    release/SHA256SUMS.txt');
  console.log(' Манифест: release/build-info.json');
  console.log(' Публикация в GitHub Releases: npm run publish:release\n');
}

/* ─────────────────────────────────── Запуск ─────────────────────────────────── */

function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : '';
  const skipBuild = args.includes('--skip-build');
  const noVerify = args.includes('--no-verify');

  const targets = only ? TARGETS.filter((t) => t.arch === only) : TARGETS;
  if (!targets.length) throw new Error(`неизвестная платформа: ${only} (ожидается x64 или ia32)`);

  fs.mkdirSync(RELEASE, { recursive: true });
  console.log(`Kitsune Browser ${pkg.version} — сборка: ${targets.map((t) => t.arch).join(', ')}`);

  for (const target of targets) {
    const outputDir = skipBuild ? path.join(RELEASE, target.arch) : buildTarget(target);
    if (!noVerify) verifyTarget(target, outputDir);
  }

  printSummary(writeChecksums());
}

try {
  main();
} catch (err) {
  console.error(`\n[ОШИБКА] ${err.message}`);
  process.exit(1);
}


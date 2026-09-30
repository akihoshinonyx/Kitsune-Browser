# Установка, сборка и обновление Kitsune Browser

## 1. Что выбрать

| Система | Файл из релиза |
|---|---|
| Windows 10/11, 64-битная | `Kitsune-Browser-Setup-<версия>-x64.exe` |
| Windows 10, 32-битная | `Kitsune-Browser-Setup-<версия>-ia32.exe` |
| Без установки (флешка) | `Kitsune-Browser-Portable-<версия>-<арх>.exe` |

Разрядность системы: **Параметры → Система → О системе → Тип системы**
(«64-разрядная» или «32-разрядная»). Быстрая проверка в PowerShell:

```powershell
[Environment]::Is64BitOperatingSystem
```

32-битная сборка работает и на 64-битной Windows — наоборот неверно.

---

## 2. Установка установщиком (обычный путь)

1. Запустите `Kitsune-Browser-Setup-<версия>-x64.exe`.
2. Windows SmartScreen предупредит, что издатель неизвестен (установщик не
   подписан сертификатом code signing): **«Подробнее» → «Выполнить в любом случае»**.
3. Выберите каталог (по умолчанию `%LOCALAPPDATA%\Programs\Kitsune Browser`)
   и нажмите «Установить».

Что делает установщик:

* копирует браузер в выбранный каталог;
* создаёт **ярлык на рабочем столе** `Kitsune Browser.lnk`;
* создаёт ярлыки в меню «Пуск» (`Kitsune Browser` и `Удалить Kitsune Browser`);
* регистрирует браузер в системе — Windows 10/11 увидят его в
  «Параметры → Приложения → Приложения по умолчанию», где Kitsune можно
  назначить браузером по умолчанию;
* добавляет запись в «Установка и удаление программ»;
* запускает браузер после установки.

Установка идёт **только для текущего пользователя** — права администратора не
нужны. Тихая установка (для скриптов и развёртывания):

```powershell
.\Kitsune-Browser-Setup-1.4.0-x64.exe /S
```

Удаление — через «Установка и удаление программ» либо ярлык «Удалить Kitsune
Browser» в меню «Пуск». Профиль (`%APPDATA%\Kitsune Browser`) при удалении
сохраняется.

---

## 3. Установка скриптом `tools/install.ps1`

Нужна там, где установщик запустить нельзя: развёртывание из архива, CI,
терминал, автоматизация. Скрипт делает то же самое и умеет удалять.

```powershell
# поставить собранную версию (release\x64\win-unpacked) и запустить
powershell -ExecutionPolicy Bypass -File .\tools\install.ps1 -Run

# поставить 32-битную сборку в свой каталог
powershell -ExecutionPolicy Bypass -File .\tools\install.ps1 `
    -Source .\release\ia32\win-unpacked `
    -InstallDir "$env:LOCALAPPDATA\Programs\Kitsune Browser"

# поставить для всех пользователей (нужны права администратора)
powershell -ExecutionPolicy Bypass -File .\tools\install.ps1 -Machine

# без ярлыка на рабочем столе
powershell -ExecutionPolicy Bypass -File .\tools\install.ps1 -NoDesktopShortcut

# удалить
powershell -ExecutionPolicy Bypass -File .\tools\install.ps1 -Uninstall
```

| Параметр | Значение |
|---|---|
| `-Source` | папка с собранным браузером (`win-unpacked`); по умолчанию определяется автоматически по разрядности системы |
| `-InstallDir` | каталог установки (`%LOCALAPPDATA%\Programs\Kitsune Browser`) |
| `-Machine` | установка в `Program Files` для всех пользователей |
| `-NoDesktopShortcut` / `-NoStartMenu` | не создавать ярлыки |
| `-Run` | запустить браузер после установки |
| `-Uninstall` | удалить браузер, ярлыки и записи в реестре |

Скрипт копирует себя в каталог установки (`kitsune-install.ps1`) и создаёт там
`Uninstall.cmd`, поэтому удаление работает и без исходного репозитория.

> Файлы `.ps1` сохранены в UTF-8 **с BOM** — Windows PowerShell 5.1 иначе
> прочитает русский текст как ANSI и выдаст ошибку разбора.

---

## 4. Portable-версия

`Kitsune-Browser-Portable-<версия>-x64.exe` — один файл, установка не нужна:
при запуске он распаковывается во временный каталог и работает. Профиль всё
равно пишется в `%APPDATA%\Kitsune Browser`. Portable-сборка **не обновляет
себя автоматически** — скачайте новый файл из релизов вручную.


---

## 5. Сборка из исходников

```powershell
npm install          # electron + electron-builder (devDependencies) + electron-updater
npm run icon         # генерирует build/icon.png и build/icon.ico
npm start            # запуск браузера
npm test             # 115 модульных тестов
npm run smoke        # дымовой тест настоящего окна: 50 проверок, скриншоты в build/smoke
```

## 6. Сборка установщиков

```powershell
npm run dist          # обе архитектуры: x64 + ia32, с проверкой каждого билда
npm run dist:win64    # только 64-битная
npm run dist:win32    # только 32-битная
npm run pack          # распакованная сборка без установщика
```

Результат:

```
release/
├── x64/
│   ├── Kitsune-Browser-Setup-1.0.0-x64.exe        ← установщик
│   ├── Kitsune-Browser-Setup-1.0.0-x64.exe.blockmap
│   ├── Kitsune-Browser-Portable-1.0.0-x64.exe
│   ├── latest.yml                                 ← канал обновлений x64
│   └── win-unpacked/                              ← распакованное приложение
├── ia32/
│   ├── Kitsune-Browser-Setup-1.0.0-ia32.exe
│   ├── Kitsune-Browser-Portable-1.0.0-ia32.exe
│   ├── win32.yml                                  ← канал обновлений ia32
│   └── win-unpacked/
├── SHA256SUMS.txt
└── build-info.json
```

Сборщик сам проверяет каждый билд: запускает собранный `.exe` в режиме
`--kitsune-diagnostics` и сверяет версию Electron, разрядность, канал
обновлений и число загруженных правил блокировки.

Полезные флаги: `node tools/build-installers.js --only=x64`, `--no-verify`,
`--skip-build`.

### Почему 32-битная сборка на Electron 43

Electron 44 больше не публикует бинарники `win32-ia32` (в релизах остались
только `win32-x64` и `win32-arm64`), поэтому 32-битная сборка использует
**43.7.5** — последнюю ветку с поддержкой 32-битной Windows. Версия движка
задаётся в `build/electron-builder.ia32.json` (`electronVersion`), код и
функциональность общие.

## 7. Публикация релиза

```powershell
$env:GH_TOKEN = "ghp_..."     # токен с правом repo (или public_repo)
npm run dist                  # собрать
npm run publish:release       # создать релиз и загрузить файлы
```

Скрипт `tools/publish-release.js` создаёт релиз `v<версия из package.json>`,
прикладывает установщики, portable-сборки, `blockmap`, файлы каналов,
`SHA256SUMS.txt` и `build-info.json`, а описание берёт из
`docs/RELEASE-NOTES.md`. Повторный запуск безопасен: файлы с теми же именами
заменяются. Флаги: `--tag=v1.2.3`, `--draft`, `--notes=путь`, `--dry-run`.

Автоматический путь — тег:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions (`.github/workflows/release.yml`) прогонит тесты, соберёт обе
архитектуры и опубликует релиз сам.

## 8. Автообновление

* Проверка: при запуске (через 12 с) и раз в 6 часов; вручную — из меню,
  со страницы `kitsune://settings` или кнопкой на полосе внизу окна.
* Загрузка идёт в фоне, установка — по кнопке «Перезапустить и обновить»
  (либо при выходе из браузера).
* Каналы: `latest.yml` для x64, `win32.yml` для ia32 — 32-битная сборка никогда
  не получит 64-битный установщик.
* Отключить автопроверку: `kitsune://settings` → «Проверять обновления
  автоматически».
* Portable-сборка не обновляется сама — браузер об этом честно скажет.

## 9. Диагностика

Собранный браузер можно проверить без открытия окна:

```powershell
& "$env:LOCALAPPDATA\Programs\Kitsune Browser\Kitsune Browser.exe" `
    --kitsune-diagnostics-out="$env:TEMP\kitsune.json"
Get-Content "$env:TEMP\kitsune.json"
```

В отчёте: версия Kitsune, Electron, Chromium и Node, разрядность, признак
portable, канал обновлений, пути и число загруженных правил блокировки.

## 10. Частые вопросы

**Windows ругается на неизвестного издателя.** Сборки не подписаны: «Подробнее»
→ «Выполнить в любом случае». Проверить, что файл не повреждён:
`certutil -hashfile <файл> SHA256` и сверить с `SHA256SUMS.txt`.

**Где хранятся данные?** `%APPDATA%\Kitsune Browser` — история, закладки,
настройки, пароли (зашифрованы DPAPI), свои правила блокировки и скачанные
фильтры.

**Как выключить блокировку для сайта?** Кнопка щита в адресной строке, меню →
«Отключить блокировку на этом сайте»; список сохраняется в
`adblock-whitelist.json`.

**Сайт сломался после блокировки.** Отключите блокировку для домена или
добавьте исключение `@@||site.com^` в свои правила.

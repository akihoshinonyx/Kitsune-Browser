<#
.SYNOPSIS
    Установка Kitsune Browser из собранной папки — со ярлыком на рабочем столе.

.DESCRIPTION
    Скрипт нужен там, где нельзя (или не хочется) запускать NSIS-установщик:
    на сборках, развёрнутых из архива, в CI, в терминале или в корпоративной
    среде. Он делает то же, что установщик:

      1) копирует собранный браузер в папку установки;
      2) создаёт ярлык на рабочем столе (можно отключить -NoDesktopShortcut);
      3) создаёт ярлыки в меню «Пуск» и ярлык удаления;
      4) регистрирует браузер в системе («Приложения по умолчанию»);
      5) добавляет запись в «Установка и удаление программ»;
      6) умеет всё это убрать: -Uninstall.

    Установка по умолчанию — только для текущего пользователя, без прав
    администратора. С -Machine браузер ставится в Program Files для всех
    пользователей (нужны права администратора).

.PARAMETER Source
    Папка с собранным браузером (win-unpacked) или корень репозитория.
    По умолчанию определяется автоматически: release\x64\win-unpacked
    (или release\ia32\win-unpacked на 32-битной системе).

.PARAMETER InstallDir
    Куда ставить. По умолчанию %LOCALAPPDATA%\Programs\Kitsune Browser
    (или %ProgramFiles%\Kitsune Browser с -Machine).

.PARAMETER Uninstall
    Удалить браузер: ярлыки, записи в реестре и файлы.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\tools\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\tools\install.ps1 -Run

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\tools\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Source,
    [string]$InstallDir,
    [switch]$Machine,
    [switch]$NoDesktopShortcut,
    [switch]$NoStartMenu,
    [switch]$Run,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$AppName = 'Kitsune Browser'
$ExeName = 'Kitsune Browser.exe'
$UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\KitsuneBrowser'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Write-Step($text) { Write-Host "  $text" }
function Write-Head($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }

function Get-Version {
    $package = Join-Path $Root 'package.json'
    if (Test-Path $package) {
        try {
            return (Get-Content $package -Raw | ConvertFrom-Json).version
        } catch { }
    }
    return '1.0.0'
}

function Get-ShortcutFolder {
    if ($Machine) {
        return [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
    }
    return [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
}

function New-Shortcut([string]$linkPath, [string]$target, [string]$arguments, [string]$icon) {
    $dir = Split-Path -Parent $linkPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($linkPath)
    $shortcut.TargetPath = $target
    if ($arguments) { $shortcut.Arguments = $arguments }
    if ($icon) { $shortcut.IconLocation = $icon }
    $shortcut.WorkingDirectory = Split-Path -Parent $target
    $shortcut.Description = "$AppName — быстрый браузер с блокировкой рекламы"
    $shortcut.Save()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

function Stop-Kitsune {
    $running = @(Get-Process -Name 'Kitsune Browser' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Step "Закрываем запущенный браузер ($($running.Count) процессов)…"
        $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
        Start-Sleep -Milliseconds 800
        $running | Where-Object { -not $_.HasExited } | ForEach-Object { $_.Kill() }
        Start-Sleep -Milliseconds 300
    }
}

function Resolve-Source {
    if ($Source) {
        if (-not (Test-Path $Source)) { throw "не найдена папка с браузером: $Source" }
        return (Resolve-Path $Source).Path
    }

    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'ia32' }
    $candidates = @(
        (Join-Path $Root "release\$arch\win-unpacked"),
        (Join-Path $Root "release\x64\win-unpacked"),
        (Join-Path $Root "release\ia32\win-unpacked"),
        $Root
    )
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate $ExeName)) { return $candidate }
    }
    throw "не найдена собранная версия браузера. Сначала соберите её: npm run dist (или укажите -Source)"
}

function Resolve-InstallDir {
    if ($InstallDir) { return $InstallDir }
    if ($Machine) { return (Join-Path $env:ProgramFiles $AppName) }
    return (Join-Path $env:LOCALAPPDATA "Programs\$AppName")
}

function Get-StartMenuFolder {
    if ($Machine) { return (Join-Path ([Environment]::GetFolderPath('CommonStartMenu')) $AppName) }
    return (Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs\$AppName")
}

function Remove-Shortcuts {
    $desktop = Get-ShortcutFolder
    $startMenu = Get-StartMenuFolder
    Remove-Item (Join-Path $desktop "$AppName.lnk") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $startMenu "$AppName.lnk") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $startMenu "Удалить $AppName.lnk") -Force -ErrorAction SilentlyContinue
    Remove-Item $startMenu -Recurse -Force -ErrorAction SilentlyContinue
}

function Remove-Registry {
    $hive = if ($Machine) { 'HKLM:\' } else { 'HKCU:\' }
    Remove-Item ($hive + $UninstallKey) -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item ($hive + 'Software\Kitsune Browser') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item ($hive + 'Software\Classes\KitsuneHTML') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path ($hive + 'Software\RegisteredApplications') -Name $AppName `
        -ErrorAction SilentlyContinue
}

function Install-Kitsune {
    $src = Resolve-Source
    $dest = Resolve-InstallDir

    Write-Head "Установка $AppName"
    Write-Step "Откуда:  $src"
    Write-Step "Куда:    $dest"

    $isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($Machine -and -not $isAdmin) {
        throw 'для -Machine нужны права администратора (запустите PowerShell от имени администратора)'
    }

    Stop-Kitsune

    if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
    # robocopy надёжнее Copy-Item на больших деревьях: он умеет перезапись и
    # не падает на длинных путях. Код возврата < 8 — успех (у robocopy это битовая маска).
    $robocopy = Start-Process -FilePath 'robocopy.exe' -ArgumentList @(
        "`"$src`"", "`"$dest`"", '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'
    ) -Wait -PassThru -NoNewWindow
    if ($robocopy.ExitCode -ge 8) { throw "robocopy завершился с кодом $($robocopy.ExitCode)" }

    $exe = Join-Path $dest $ExeName
    if (-not (Test-Path $exe)) { throw "после копирования не найден $exe" }

    # ── Ярлыки ──
    if (-not $NoDesktopShortcut) {
        $desktop = Get-ShortcutFolder
        New-Shortcut (Join-Path $desktop "$AppName.lnk") $exe '' $exe
        Write-Step "Ярлык на рабочем столе: $(Join-Path $desktop "$AppName.lnk")"
    }

    if (-not $NoStartMenu) {
        $startMenu = Get-StartMenuFolder
        New-Shortcut (Join-Path $startMenu "$AppName.lnk") $exe '' $exe

        # Копию скрипта и .cmd-обёртку кладём рядом с браузером: на них
        # ссылаются ярлык удаления и запись в «Установка и удаление программ».
        Copy-Item (Join-Path $PSScriptRoot 'install.ps1') (Join-Path $dest 'kitsune-install.ps1') -Force
        $cmd = Join-Path $dest 'Uninstall.cmd'
        Set-Content -Path $cmd -Encoding ASCII -Value @(
            '@echo off',
            "powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0kitsune-install.ps1`" -Uninstall"
        )
        New-Shortcut (Join-Path $startMenu "Удалить $AppName.lnk") $cmd '' $exe
        Write-Step "Ярлыки в меню «Пуск»: $startMenu"
    }

    Register-Browser $dest $exe

    Write-Host ""
    Write-Host "$AppName $(Get-Version) установлен." -ForegroundColor Green
    Write-Host "Запуск: $exe" -ForegroundColor Green

    if ($Run) { Start-Process -FilePath $exe }
}

function Register-Browser([string]$dest, [string]$exe) {
    $hive = if ($Machine) { 'HKLM:\' } else { 'HKCU:\' }
    $version = Get-Version
    $size = [math]::Round(((Get-ChildItem $dest -Recurse -File |
        Measure-Object -Property Length -Sum).Sum / 1KB))

    foreach ($key in @(
            'Software\Classes\KitsuneHTML',
            'Software\Classes\KitsuneHTML\shell\open\command',
            'Software\Classes\KitsuneHTML\DefaultIcon',
            'Software\Kitsune Browser\Capabilities',
            'Software\Kitsune Browser\Capabilities\FileAssociations',
            'Software\Kitsune Browser\Capabilities\URLAssociations',
            'Software\RegisteredApplications',
            $UninstallKey)) {
        New-Item -Path ($hive + $key) -Force | Out-Null
    }

    # ProgID: как система запускает браузер при открытии ссылки или файла
    Set-ItemProperty ($hive + 'Software\Classes\KitsuneHTML') -Name '(default)' -Value "$AppName HTML Document"
    Set-ItemProperty ($hive + 'Software\Classes\KitsuneHTML\DefaultIcon') -Name '(default)' -Value "$exe,0"
    Set-ItemProperty ($hive + 'Software\Classes\KitsuneHTML\shell\open\command') -Name '(default)' `
        -Value "`"$exe`" `"%1`""

    # Capabilities: после этого браузер видно в «Параметры → Приложения по умолчанию»
    Set-ItemProperty ($hive + 'Software\Kitsune Browser\Capabilities') -Name 'ApplicationName' -Value $AppName
    Set-ItemProperty ($hive + 'Software\Kitsune Browser\Capabilities') -Name 'ApplicationIcon' -Value "$exe,0"
    Set-ItemProperty ($hive + 'Software\Kitsune Browser\Capabilities') -Name 'ApplicationDescription' `
        -Value 'Быстрый браузер с блокировкой рекламы и приватным поиском DuckDuckGo'
    foreach ($ext in @('.htm', '.html')) {
        Set-ItemProperty ($hive + 'Software\Kitsune Browser\Capabilities\FileAssociations') `
            -Name $ext -Value 'KitsuneHTML'
    }
    foreach ($proto in @('http', 'https')) {
        Set-ItemProperty ($hive + 'Software\Kitsune Browser\Capabilities\URLAssociations') `
            -Name $proto -Value 'KitsuneHTML'
    }
    Set-ItemProperty ($hive + 'Software\RegisteredApplications') -Name $AppName `
        -Value 'Software\Kitsune Browser\Capabilities'

    # Запись в «Установка и удаление программ»
    $cmd = Join-Path $dest 'Uninstall.cmd'
    Set-ItemProperty ($hive + $UninstallKey) -Name 'DisplayName' -Value $AppName
    Set-ItemProperty ($hive + $UninstallKey) -Name 'DisplayVersion' -Value $version
    Set-ItemProperty ($hive + $UninstallKey) -Name 'Publisher' -Value 'Kitsune Project'
    Set-ItemProperty ($hive + $UninstallKey) -Name 'DisplayIcon' -Value "$exe,0"
    Set-ItemProperty ($hive + $UninstallKey) -Name 'InstallLocation' -Value $dest
    Set-ItemProperty ($hive + $UninstallKey) -Name 'EstimatedSize' -Value $size -Type DWord
    Set-ItemProperty ($hive + $UninstallKey) -Name 'NoModify' -Value 1 -Type DWord
    Set-ItemProperty ($hive + $UninstallKey) -Name 'NoRepair' -Value 1 -Type DWord
    if (Test-Path $cmd) {
        Set-ItemProperty ($hive + $UninstallKey) -Name 'UninstallString' -Value "`"$cmd`""
    }

    Write-Step 'Браузер зарегистрирован в системе («Приложения по умолчанию»)'
}

function Uninstall-Kitsune {
    $dest = Resolve-InstallDir
    Write-Head "Удаление $AppName"
    Stop-Kitsune
    Remove-Shortcuts
    Remove-Registry
    if (Test-Path $dest) {
        Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
        Write-Step "Удалена папка: $dest"
    }
    Write-Host ""
    Write-Host "$AppName удалён. Профиль браузера (история, закладки, пароли) остался в %APPDATA%\$AppName." `
        -ForegroundColor Green
}

if ($Uninstall) { Uninstall-Kitsune } else { Install-Kitsune }




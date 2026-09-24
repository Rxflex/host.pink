# Установщик hostpink для Windows: irm host.pink/tui | iex
# Скачивает бинарник под твою архитектуру, сверяет SHA-256, кладёт в %LOCALAPPDATA%\hostpink и запускает.
# Исходники: https://github.com/Rxflex/host.pink/tree/main/tui
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$site = if ($env:HOSTPINK_SITE) { $env:HOSTPINK_SITE } else { 'https://host.pink' }
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { throw "не знаю такую архитектуру: $env:PROCESSOR_ARCHITECTURE" }
}
$name = "hostpink-windows-$arch.exe"
$dir = Join-Path $env:LOCALAPPDATA 'hostpink'
$exe = Join-Path $dir 'hostpink.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "host.pink -> $name" -ForegroundColor Magenta
$tmp = Join-Path $dir 'hostpink.download'
Invoke-WebRequest -UseBasicParsing -Uri "$site/dl/$name" -OutFile $tmp
$sums = (Invoke-WebRequest -UseBasicParsing -Uri "$site/dl/SHA256SUMS").Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$want = ($sums -split "`n" | Where-Object { $_ -match " $([regex]::Escape($name))\s*$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
$got = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
if (-not $want -or $want -ne $got) {
  Remove-Item $tmp -Force
  throw 'контрольная сумма не совпала, ставить не буду'
}
Write-Host "SHA-256 совпал: $got" -ForegroundColor DarkGray

if (Test-Path $exe) { Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue; Rename-Item $exe "$exe.old" -Force }
Move-Item $tmp $exe -Force
Write-Host "установлен в $exe" -ForegroundColor Magenta

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir"), 'User')
  $env:Path += ";$dir"
  Write-Host "Добавил $dir в PATH. В новых окнах команда hostpink будет работать сразу." -ForegroundColor DarkGray
}

if (-not $env:HOSTPINK_NO_RUN) { & $exe }

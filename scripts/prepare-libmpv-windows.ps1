param(
    [Parameter(Mandatory = $false)]
    [string]$Source = "C:\mpv"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$destinationDir = Join-Path $repoRoot "src-tauri\resources\libmpv"
$destination = Join-Path $destinationDir "libmpv-2.dll"

New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null

$candidates = @()
if ($env:BAIA_LIBMPV_DLL) {
    $candidates += $env:BAIA_LIBMPV_DLL
}

if (Test-Path -LiteralPath $Source -PathType Leaf) {
    $candidates += $Source
} elseif (Test-Path -LiteralPath $Source -PathType Container) {
    $candidates += (Join-Path $Source "libmpv-2.dll")
    $candidates += (Join-Path $Source "mpv-2.dll")
}

$selected = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $selected) {
    Write-Host "libmpv-2.dll non trovata in '$Source'." -ForegroundColor Red
    Write-Host "La build normale di mpv contiene mpv.exe ma può non contenere la libreria embedded." -ForegroundColor Yellow
    Write-Host "Scarica un archivio Windows 'mpv-dev-x86_64...' / 'mpv-dev-x86_64-v3...' e indica la cartella estratta:" -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\prepare-libmpv-windows.ps1 -Source C:\percorso\mpv-dev" -ForegroundColor Cyan
    exit 2
}

Copy-Item -LiteralPath $selected -Destination $destination -Force
$size = (Get-Item -LiteralPath $destination).Length
Write-Host "libmpv embedded pronta:" -ForegroundColor Green
Write-Host "  $destination"
Write-Host ("  {0:N1} MiB" -f ($size / 1MB))
Write-Host "Il file è ignorato da Git ma verrà incluso nel bundle NSIS tramite tauri.conf.json." -ForegroundColor Green

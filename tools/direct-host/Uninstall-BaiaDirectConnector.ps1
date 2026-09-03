[CmdletBinding()]
param(
    [switch]$RemoveIdentity
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'Baia Host Connector Direct'
$FirewallName = 'Baia Direct Connector TCP 43127'
$Root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Baia\HostConnector'
$BinDir = Join-Path $Root 'bin'
$InstallInfo = Join-Path $Root 'direct-install-info.json'
$DataDir = Join-Path $Root 'data'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Apri PowerShell come amministratore e rilancia lo script.'
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

Remove-Item -LiteralPath $BinDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $InstallInfo -Force -ErrorAction SilentlyContinue

if ($RemoveIdentity) {
    Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Identita/configurazione Connector rimossa su richiesta.'
}
else {
    Write-Host "Identita Connector preservata in: $DataDir"
}

Write-Host 'DISINSTALLAZIONE CONNECTOR DIRECT: PASS'

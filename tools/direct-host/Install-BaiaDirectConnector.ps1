[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConnectorExe,

    [Parameter(Mandatory = $true)]
    [string]$BindIp,

    [switch]$DoNotMigrateCurrentUserIdentity
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'Baia Host Connector Direct'
$FirewallName = 'Baia Direct Connector TCP 43127'
$ConnectorPort = 43127
$IdentityFileName = 'server-identity-ed25519-v1.pk8'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Apri PowerShell come amministratore e rilancia lo script.'
    }
}

function Get-PrivateIpv4([string]$Value) {
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$parsed)) {
        throw 'BindIp deve essere un IPv4 privato numerico, per esempio 192.168.1.50.'
    }
    if ($parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'BindIp deve essere IPv4.'
    }
    $bytes = $parsed.GetAddressBytes()
    $private = ($bytes[0] -eq 10) -or
        ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
    if (-not $private) {
        throw 'BindIp deve essere un indirizzo LAN RFC1918 (10/8, 172.16/12 o 192.168/16).'
    }
    return $parsed.ToString()
}

function Invoke-Icacls([string[]]$Arguments) {
    & "$env:SystemRoot\System32\icacls.exe" @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "icacls fallito: $($Arguments -join ' ')"
    }
}

Assert-Administrator
$BindIp = Get-PrivateIpv4 $BindIp
$ConnectorExe = (Resolve-Path -LiteralPath $ConnectorExe).Path
if (-not (Test-Path -LiteralPath $ConnectorExe -PathType Leaf)) {
    throw "Eseguibile Host Connector non trovato: $ConnectorExe"
}

$ProgramDataRoot = [Environment]::GetFolderPath('CommonApplicationData')
$Root = Join-Path $ProgramDataRoot 'Baia\HostConnector'
$BinDir = Join-Path $Root 'bin'
$DataDir = Join-Path $Root 'data'
$InstalledExe = Join-Path $BinDir 'baia-host-connector.exe'
$Runner = Join-Path $BinDir 'run-direct-connector.ps1'
$InstallInfo = Join-Path $Root 'direct-install-info.json'
$TargetIdentity = Join-Path $DataDir $IdentityFileName

Write-Host '== Baia Direct: installazione Connector ristretto =='
Write-Host "Bind LAN: $BindIp`:$ConnectorPort"

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $BinDir, $DataDir | Out-Null

# La directory eseguibile e' immutabile per LocalService; solo la directory dati
# consente a LocalService di aggiornare/creare la propria identita persistente.
Invoke-Icacls @($Root, '/inheritance:r')
Invoke-Icacls @($Root, '/grant:r', '*S-1-5-18:(OI)(CI)(F)')
Invoke-Icacls @($Root, '/grant', '*S-1-5-32-544:(OI)(CI)(F)')
Invoke-Icacls @($Root, '/grant', '*S-1-5-19:(OI)(CI)(RX)')

Invoke-Icacls @($BinDir, '/inheritance:r')
Invoke-Icacls @($BinDir, '/grant:r', '*S-1-5-18:(OI)(CI)(F)')
Invoke-Icacls @($BinDir, '/grant', '*S-1-5-32-544:(OI)(CI)(F)')
Invoke-Icacls @($BinDir, '/grant', '*S-1-5-19:(OI)(CI)(RX)')

Invoke-Icacls @($DataDir, '/inheritance:r')
Invoke-Icacls @($DataDir, '/grant:r', '*S-1-5-18:(OI)(CI)(F)')
Invoke-Icacls @($DataDir, '/grant', '*S-1-5-32-544:(OI)(CI)(F)')
Invoke-Icacls @($DataDir, '/grant', '*S-1-5-19:(OI)(CI)(M)')

Copy-Item -LiteralPath $ConnectorExe -Destination $InstalledExe -Force

if (-not $DoNotMigrateCurrentUserIdentity -and -not (Test-Path -LiteralPath $TargetIdentity)) {
    $legacyIdentity = Join-Path $env:LOCALAPPDATA "Baia\HostConnector\$IdentityFileName"
    if (Test-Path -LiteralPath $legacyIdentity -PathType Leaf) {
        Copy-Item -LiteralPath $legacyIdentity -Destination $TargetIdentity
        Write-Host 'Identita Connector esistente migrata nel profilo di servizio.'
    }
}

$oldDataDir = [Environment]::GetEnvironmentVariable('BAIA_CONNECTOR_DATA_DIR', 'Process')
try {
    $env:BAIA_CONNECTOR_DATA_DIR = $DataDir
    $fingerprintLines = @(& $InstalledExe --print-fingerprint)
    if ($LASTEXITCODE -ne 0) {
        throw 'Impossibile inizializzare/verificare l’identita del Connector installato.'
    }
    $Fingerprint = ($fingerprintLines | Select-Object -Last 1).Trim()
    if ($Fingerprint -notmatch '^SHA256:[A-Za-z0-9_-]+$') {
        throw 'Fingerprint Connector inattesa.'
    }
}
finally {
    if ($null -eq $oldDataDir) {
        Remove-Item Env:BAIA_CONNECTOR_DATA_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:BAIA_CONNECTOR_DATA_DIR = $oldDataDir
    }
}

$runnerContent = @"
`$ErrorActionPreference = 'Stop'
`$env:BAIA_CONNECTOR_BIND_IP = '$BindIp'
`$env:BAIA_CONNECTOR_DATA_DIR = '$DataDir'
Remove-Item Env:BAIA_RELAY_ENDPOINT -ErrorAction SilentlyContinue
Remove-Item Env:BAIA_RELAY_CERT_FINGERPRINT -ErrorAction SilentlyContinue
& '$InstalledExe'
exit `$LASTEXITCODE
"@
Set-Content -LiteralPath $Runner -Value $runnerContent -Encoding UTF8

$info = [ordered]@{
    version = 1
    mode = 'direct-internet-tls-v1'
    bindIp = $BindIp
    connectorPort = $ConnectorPort
    publicPort = 443
    fingerprint = $Fingerprint
    installedExe = $InstalledExe
    dataDir = $DataDir
    taskName = $TaskName
    firewallRule = $FirewallName
}
$info | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $InstallInfo -Encoding UTF8

# Ripristina ACL dopo avere scritto/copiato i file.
Invoke-Icacls @($BinDir, '/inheritance:r')
Invoke-Icacls @($BinDir, '/grant:r', '*S-1-5-18:(OI)(CI)(F)')
Invoke-Icacls @($BinDir, '/grant', '*S-1-5-32-544:(OI)(CI)(F)')
Invoke-Icacls @($BinDir, '/grant', '*S-1-5-19:(OI)(CI)(RX)')
Invoke-Icacls @($DataDir, '/inheritance:r')
Invoke-Icacls @($DataDir, '/grant:r', '*S-1-5-18:(OI)(CI)(F)')
Invoke-Icacls @($DataDir, '/grant', '*S-1-5-32-544:(OI)(CI)(F)')
Invoke-Icacls @($DataDir, '/grant', '*S-1-5-19:(OI)(CI)(M)')

New-NetFirewallRule `
    -DisplayName $FirewallName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalAddress $BindIp `
    -LocalPort $ConnectorPort `
    -Program $InstalledExe `
    -Profile Any | Out-Null

$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Action = New-ScheduledTaskAction `
    -Execute $PowerShellExe `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Runner`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal `
    -UserId 'NT AUTHORITY\LOCAL SERVICE' `
    -LogonType ServiceAccount `
    -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $TaskName).State
if ($state -ne 'Running') {
    throw "Il task Connector non e' rimasto in esecuzione (stato: $state). Chiudi eventuali Connector manuali e controlla Event Viewer/Task Scheduler."
}

Write-Host ''
Write-Host 'INSTALLAZIONE CONNECTOR DIRECT: PASS'
Write-Host "Fingerprint server: $Fingerprint"
Write-Host "Regola router da creare SOLO quando iniziano i test reali: TCP WAN 443 -> $BindIp`:$ConnectorPort"
Write-Host 'Node deve rimanere esclusivamente su 127.0.0.1:3000.'

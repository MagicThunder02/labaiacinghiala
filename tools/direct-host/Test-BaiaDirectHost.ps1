[CmdletBinding()]
param(
    [string]$PublicEndpoint
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Baia\HostConnector'
$InfoPath = Join-Path $Root 'direct-install-info.json'
if (-not (Test-Path -LiteralPath $InfoPath -PathType Leaf)) {
    throw 'Baia Direct Connector non risulta installato con lo script di hardening.'
}
$Info = Get-Content -Raw -LiteralPath $InfoPath | ConvertFrom-Json

function Test-Tcp([string]$HostName, [int]$Port, [int]$TimeoutMs = 1500) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    }
    catch { return $false }
    finally { $client.Dispose() }
}

Write-Host '== Baia Direct: diagnostica host pre-test reale =='
$failed = $false

$nodeOk = Test-Tcp '127.0.0.1' 3000
Write-Host ("Node 127.0.0.1:3000              : " + $(if ($nodeOk) {'PASS'} else {'FAIL'}))
if (-not $nodeOk) { $failed = $true }

$connectorOk = Test-Tcp ([string]$Info.bindIp) ([int]$Info.connectorPort)
Write-Host ("Connector LAN {0}:{1}             : {2}" -f $Info.bindIp, $Info.connectorPort, $(if ($connectorOk) {'PASS'} else {'FAIL'}))
if (-not $connectorOk) { $failed = $true }

$task = Get-ScheduledTask -TaskName ([string]$Info.taskName) -ErrorAction SilentlyContinue
$taskOk = $null -ne $task -and $task.State -eq 'Running'
Write-Host ("Task LocalService                    : " + $(if ($taskOk) {'PASS'} else {'FAIL'}))
if (-not $taskOk) { $failed = $true }

$firewall = Get-NetFirewallRule -DisplayName ([string]$Info.firewallRule) -ErrorAction SilentlyContinue
$firewallOk = $null -ne $firewall -and $firewall.Enabled -eq 'True'
Write-Host ("Windows Firewall                    : " + $(if ($firewallOk) {'PASS'} else {'FAIL'}))
if (-not $firewallOk) { $failed = $true }

Write-Host "Fingerprint server                   : $($Info.fingerprint)"

if ($PublicEndpoint) {
    $uri = $null
    if (-not [Uri]::TryCreate($PublicEndpoint, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or
        $uri.Port -ne 443 -or
        $uri.AbsolutePath -ne '/') {
        throw 'PublicEndpoint deve essere una origine https://host:443 senza path.'
    }
    try {
        $addresses = [Net.Dns]::GetHostAddresses($uri.DnsSafeHost)
        if ($addresses.Count -eq 0) { throw 'nessun indirizzo' }
        Write-Host "DNS $($uri.DnsSafeHost)                     : PASS ($($addresses -join ', '))"
    }
    catch {
        Write-Host "DNS $($uri.DnsSafeHost)                     : FAIL"
        $failed = $true
    }
}
else {
    Write-Host 'DDNS/public endpoint                 : SKIP (non fornito)'
}

Write-Host 'Reachability WAN TCP 443             : NON TESTATA QUI (va verificata da rete esterna)'

if ($failed) {
    throw 'DIAGNOSTICA BAIA DIRECT: FAIL'
}
Write-Host 'DIAGNOSTICA BAIA DIRECT LOCALE: PASS'

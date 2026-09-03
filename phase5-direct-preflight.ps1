$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Assert-Exists([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "File richiesto mancante: $Path"
    }
}

function Assert-Contains([string]$Path, [string]$Needle) {
    $text = Get-Content -Raw -LiteralPath $Path
    if (-not $text.Contains($Needle)) {
        throw "Invariante Direct mancante in ${Path}: $Needle"
    }
}

function Assert-NotContains([string]$Path, [string]$Needle) {
    $text = Get-Content -Raw -LiteralPath $Path
    if ($text.Contains($Needle)) {
        throw "Pattern vietato trovato in ${Path}: $Needle"
    }
}

function Run([string]$Label, [scriptblock]$Command) {
    Write-Host ''
    Write-Host "== $Label =="
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label fallito con exit code $LASTEXITCODE"
    }
}

$required = @(
    '.\host-connector\Cargo.toml',
    '.\host-connector\Cargo.lock',
    '.\host-connector\src\access_grant.rs',
    '.\host-connector\src\main.rs',
    '.\host-connector\src\server_identity.rs',
    '.\host-connector\src\tls.rs',
    '.\src-tauri\Cargo.toml',
    '.\src-tauri\Cargo.lock',
    '.\src-tauri\src\connector_tls.rs',
    '.\src-tauri\src\core.rs',
    '.\src-tauri\src\pairing.rs',
    '.\src-tauri\src\transport\mod.rs',
    '.\src\direct-bootstrap.js',
    '.\tools\direct-host\Install-BaiaDirectConnector.ps1',
    '.\tools\direct-host\Test-BaiaDirectHost.ps1',
    '.\tools\direct-host\Uninstall-BaiaDirectConnector.ps1'
)
$required | ForEach-Object { Assert-Exists $_ }

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'cargo non trovato nel PATH.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node non trovato nel PATH.'
}

Write-Host '== Invarianti statiche Direct Internet =='
Assert-Contains '.\host-connector\src\main.rs' 'const UPSTREAM_BASE_URL: &str = "http://127.0.0.1:3000";'
Assert-Contains '.\host-connector\src\main.rs' 'const DEFAULT_BIND_IP: &str = "127.0.0.1";'
Assert-Contains '.\host-connector\src\main.rs' 'const UPSTREAM_UPLOAD_REQUEST_TIMEOUT: Option<Duration> = None;'
Assert-Contains '.\host-connector\src\main.rs' '.timeout(UPSTREAM_UPLOAD_REQUEST_TIMEOUT)'
Assert-Contains '.\host-connector\src\main.rs' 'const MAX_ACTIVE_CONNECTIONS_PER_IP: usize = 16;'
Assert-Contains '.\host-connector\src\main.rs' 'const MAX_CONNECTION_STARTS_PER_WINDOW: usize = 256;'
Assert-Contains '.\host-connector\src\main.rs' 'const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);'
Assert-Contains '.\host-connector\src\main.rs' 'CONNECTOR_TRANSPORT_AUTH_REJECTED'
Assert-Contains '.\host-connector\src\access_grant.rs' 'verify_access_grant'
Assert-Contains '.\host-connector\src\access_grant.rs' 'verify_request_authorization'
Assert-Contains '.\host-connector\src\access_grant.rs' 'verify_media_authorization'
Assert-Contains '.\host-connector\src\server_identity.rs' 'BAIA_CONNECTOR_DATA_DIR'
Assert-Contains '.\host-connector\src\tls.rs' 'rustls::version::TLS13'
Assert-Contains '.\src-tauri\src\connector_tls.rs' 'ConnectorEndpointKind::DirectInternet'
Assert-Contains '.\src-tauri\src\connector_tls.rs' '.timeout(request_timeout)'
Assert-Contains '.\src-tauri\src\connector_tls.rs' 'rustls::version::TLS13'
Assert-Contains '.\src-tauri\src\core.rs' 'direct-internet-tls-v1'
Assert-Contains '.\src-tauri\src\core.rs' 'Direct Internet ha precedenza esplicita sul fallback relay.'
Assert-Contains '.\src-tauri\src\core.rs' 'transport_access_grant'
Assert-Contains '.\src-tauri\src\pairing.rs' 'baia-direct1.'
Assert-Contains '.\src\direct-bootstrap.js' 'PUBLIC_ENDPOINT_ENV'
Assert-Contains '.\.env.example' 'HOST=127.0.0.1'
Assert-NotContains '.\host-connector\src\main.rs' 'error={error:?}'
Assert-NotContains '.\tools\direct-host\Install-BaiaDirectConnector.ps1' 'New-NetFirewallRule -DisplayName *3000'
Write-Host 'Invarianti statiche Direct: PASS'

Write-Host ''
Write-Host '== Sintassi script PowerShell host =='
$psScripts = @(
    '.\tools\direct-host\Install-BaiaDirectConnector.ps1',
    '.\tools\direct-host\Test-BaiaDirectHost.ps1',
    '.\tools\direct-host\Uninstall-BaiaDirectConnector.ps1'
)
foreach ($script in $psScripts) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path -LiteralPath $script).Path,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    if ($errors.Count -ne 0) {
        $messages = ($errors | ForEach-Object { $_.Message }) -join '; '
        throw "Sintassi PowerShell non valida in ${script}: $messages"
    }
    Write-Host "$script : PASS"
}

Run 'Node: contratti Direct + API inviti' {
    node --test `
        .\test\direct-bootstrap.test.js `
        .\test\direct-pairing-ui-contract.test.js `
        .\test\host-connector-contract.test.js `
        .\test\admin-pairing-invites-api.test.js
}

Run 'Host Connector: unit test Direct/hardening' {
    cargo test --locked --manifest-path .\host-connector\Cargo.toml
}

Run 'Core/Tauri: unit test libreria Direct' {
    cargo test --locked --manifest-path .\src-tauri\Cargo.toml --lib
}

Run 'Core/Tauri: compile integrazione completa' {
    cargo check --locked --manifest-path .\src-tauri\Cargo.toml
}

Run 'Host Connector: build release per il test reale' {
    cargo build --locked --release --manifest-path .\host-connector\Cargo.toml
}

Write-Host ''
Write-Host '============================================================'
Write-Host 'PREFLIGHT DIRECT TCP 443 PASS'
Write-Host '============================================================'
Write-Host 'NON aprire ancora la porta del router.'
Write-Host 'Il prossimo passo e'' installare il Connector ristretto con tools\direct-host e poi iniziare i test reali uno alla volta.'

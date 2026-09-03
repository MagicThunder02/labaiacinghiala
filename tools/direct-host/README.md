# Baia Direct — preparazione host Windows prima dei test Internet

> Host Linux: usa `tools/direct-host/linux/` e la guida `tools/direct-host/linux/README.md`.

Questi script sono strumenti di **pre-release** per arrivare al primo test reale senza esporre un Connector eseguito come utente/amministratore.
Non sostituiscono ancora `BaiaServerSetup.exe`, che verra' costruito nella fase packaging.

## Obiettivo di sicurezza

- Host Connector eseguito da Task Scheduler come `NT AUTHORITY\\LOCAL SERVICE` con `RunLevel Limited`.
- Binari/script sotto `C:\\ProgramData\\Baia\\HostConnector\\bin` non modificabili da LocalService.
- Identita persistente sotto `...\\data`, accessibile solo a SYSTEM, Administrators e LocalService.
- Windows Firewall: solo l'eseguibile Connector, TCP 43127, sul solo IPv4 LAN configurato.
- Relay disabilitato esplicitamente nel runner Direct.
- Node resta `127.0.0.1:3000`.

## Preparazione (non apre ancora il router)

1. Compila il Connector release:

```powershell
cargo build --locked --release --manifest-path .\\host-connector\\Cargo.toml
```

2. Apri PowerShell **come amministratore**:

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\direct-host\\Install-BaiaDirectConnector.ps1 `
  -ConnectorExe .\\host-connector\\target\\release\\baia-host-connector.exe `
  -BindIp 192.168.1.50
```

Sostituisci `192.168.1.50` con l'IPv4 LAN riservato del PC host.
Lo script prova a migrare la vecchia identita `%LOCALAPPDATA%\\Baia\\HostConnector` per mantenere la fingerprint gia' conosciuta. Non sovrascrive mai un'identita gia' presente in ProgramData.

3. Avvia Node normalmente e verifica:

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\direct-host\\Test-BaiaDirectHost.ps1
```

Se hai gia' DDNS:

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\direct-host\\Test-BaiaDirectHost.ps1 `
  -PublicEndpoint https://nome-ddns.example:443
```

La raggiungibilita WAN non viene dichiarata dal test locale: verra' verificata dalla rete mobile nel primo test reale.

## Bootstrap Direct Node

Nel `.env` del server Node, solo quando endpoint pubblico/fingerprint sono definitivi:

```text
BAIA_PUBLIC_CONNECTOR_ENDPOINT=https://nome-ddns.example:443
BAIA_CONNECTOR_SERVER_FINGERPRINT=SHA256:...
```

La fingerprint deve essere quella stampata dallo script di installazione.

## Router — NON prima del test reale

Quando inizieranno i test reali, creare **una sola** regola:

```text
WAN TCP 443 -> IP_LAN_PC TCP 43127
```

Non aprire 3000. Non usare DMZ. Non aprire intervalli di porte.

## Kill switch

Per interrompere subito l'accesso Internet a Baia: disabilitare la regola di port forwarding TCP 443. In alternativa fermare il task `Baia Host Connector Direct`.

## Disinstallazione sviluppo

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\direct-host\\Uninstall-BaiaDirectConnector.ps1
```

L'identita viene preservata. Per eliminarla deliberatamente usare `-RemoveIdentity`.

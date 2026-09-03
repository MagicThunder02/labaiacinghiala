# HANDOFF — Baia Cinghiala

**Data:** 31 agosto 2026  
**Scopo:** passaggio del repository al PC Windows che diventerà il vero host Baia e prosecuzione dello sviluppo tramite nuove chat.

## 1. Decisione architetturale definitiva

Il trasporto primario non usa VPS e non richiede VPN ai client.

```text
Android / Windows / futuro macOS-iOS-Linux
                  |
           TCP 443 + TLS 1.3
                  |
               Internet
                  |
              DDNS/IP
                  |
            router host
        WAN 443 -> LAN 43127
                  |
          Host Connector
                  |
         127.0.0.1:3000
                  |
          Node + SQLite
```

Il relay già sviluppato resta nel repository come fallback futuro per scenari CGNAT/no-port-forward, ma non deve guidare lo sviluppo corrente.

## 2. Obiettivo di sicurezza

La priorità non è soltanto proteggere i contenuti: è proteggere il PC Windows e la LAN dell'host.

Il Connector Internet-facing deve:
- accettare soltanto protocollo Baia;
- usare TLS 1.3;
- verificare identità/grant/prova device;
- parlare esclusivamente con `http://127.0.0.1:3000`;
- non accettare host/porte arbitrarie;
- non accedere genericamente a filesystem, shell, SMB, RDP o LAN;
- applicare limiti di connessione, header/frame e timeout pre-auth;
- mantenere buffer bounded;
- non reintrodurre timeout totale su media/upload.

## 3. Stato già verificato

Prima del trasferimento:
- Fase 4B LAN cifrata chiusa;
- Node loopback;
- identità Connector persistente;
- TLS 1.3 + pinning;
- media/artwork/Range/seek verificati;
- upload piccolo e grande verificati;
- revoke e re-pair verificati;
- fix `request_timeout=None` preservato;
- modalità Direct TCP 443 implementata;
- grant firmato e prova chiave device verificati nel Connector prima di Node;
- script Windows Direct presenti in `tools/direct-host/`;
- preflight Direct concluso con PASS.

Ultimo preflight:
- Node Direct: 26/26;
- Host Connector: 27/27;
- Core/Tauri: 38/38;
- build release Connector: PASS.

Fingerprint server nota della baseline:
`SHA256:tFv0VGkaNeUB7khsLolKtsYg076d1eVpkcZEZIdnj4k`

Non rigenerare l'identità server per risolvere problemi di rete.

## 4. Prossimo lavoro reale

Il prossimo lavoro utile avviene sul vero PC host:

1. installare Node 24.x e Rust/Cargo se necessari;
2. `npm ci`;
3. avviare Node e confermare `http://127.0.0.1:3000`;
4. leggere l'IPv4 LAN reale;
5. compilare il Connector release se necessario;
6. installarlo tramite `tools/direct-host/Install-BaiaDirectConnector.ps1`;
7. eseguire `Test-BaiaDirectHost.ps1`;
8. soltanto dopo, configurare DHCP reservation;
9. configurare DDNS se necessario;
10. aprire sul router solo `WAN TCP 443 -> PC:43127`;
11. test da rete mobile, uno scenario per volta.

NON aprire 3000. NON usare DMZ. NON disattivare il firewall.

## 5. Disciplina di sviluppo

- Il repository corrente è source of truth.
- Prima di una patch leggere i file correnti.
- Non riapplicare vecchie patch.
- Fare batch coerenti quando il lavoro è ancora offline/deterministico.
- Fare un preflight consolidato dopo un batch.
- Nei test reali procedere uno scenario alla volta.
- Non ripetere test già passati se il codice relativo non è cambiato, salvo preflight consolidati.
- Artifact scaricabili sempre con nomi univoci/versionati.
- Per modifiche multi-file preferire ZIP overlay con manifest SHA-256.

## 6. Cartelle intenzionalmente assenti

Non presenti nel trasferimento per limiti di dimensione:
- media reale;
- `target/`;
- `src-tauri/gen/android`.

Non interpretare l'assenza di `src-tauri/gen/android` come decisione di rimuovere Android dal progetto.

## 7. Dati deliberatamente conservati

Non è stata effettuata sanitizzazione di:
- `.env`;
- database;
- backup;
- cache;
- configurazioni locali presenti nell'archivio sorgente.

Non cancellarli o azzerarli automaticamente.

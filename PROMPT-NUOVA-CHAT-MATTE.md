# PROMPT DA INCOLLARE NELLA NUOVA CHAT SUL PC DI MATTE

Sto continuando lo sviluppo del progetto **Baia Cinghiala**. Hai accesso alla cartella/repository che ti fornirò insieme a questo prompt.

Prima di proporre o modificare codice devi leggere almeno:

- `README.md`
- `HANDOFF.md`
- `docs/ROADMAP-DIRECT-TCP443.md`
- `host-connector/README.md`
- `tools/direct-host/README.md`
- `package.json`
- i manifest Cargo interessati

## Architettura decisa e NON da ridiscutere salvo mia richiesta esplicita

Il percorso remoto primario è:

```text
Baia Android/Windows
  -> Internet TCP 443 + TLS 1.3
  -> router del PC host
  -> WAN 443 inoltrata a PC host:43127
  -> Baia Host Connector
  -> esclusivamente http://127.0.0.1:3000
  -> Node + SQLite + media
```

Non vogliamo una VPS nel percorso normale e non vogliamo far installare VPN, WireGuard, Tailscale o software aggiuntivo agli amici.

Il crate `relay/` resta solo come fallback futuro e non va cancellato, ma non deve diventare una dipendenza del percorso Direct.

## Priorità di sicurezza

La priorità è proteggere il PC Windows e la LAN dell'host dagli attaccanti Internet.

Quindi:
- Node deve restare SOLO `127.0.0.1:3000`;
- non aprire mai la 3000 sul router;
- il Connector è l'unico servizio Baia Internet-facing;
- TLS 1.3 e pinning dell'identità server sono obbligatori;
- il Connector non deve poter diventare un proxy generico;
- niente host/porte arbitrarie provenienti dal frontend/client;
- niente accesso generico a filesystem, shell, SMB, RDP o LAN;
- API/media/upload devono passare i controlli del Connector prima di Node;
- Node resta comunque autorità finale per account, permessi, nonce e revoche;
- buffer, header, handshake e connessioni devono avere limiti;
- NON reintrodurre un timeout totale di circa 30 secondi su upload o stream;
- niente chiavi private nel JavaScript;
- niente IPC generico che firma byte arbitrari.

## Baseline già verificata prima del trasferimento

L'ultimo preflight Direct sul laptop precedente ha dato:

- contratti Node Direct: 26 PASS;
- Host Connector: 27 PASS;
- Core/Tauri: 38 PASS;
- build release Host Connector: PASS;
- risultato: `PREFLIGHT DIRECT TCP 443 PASS`.

La Fase 4B precedente aveva già verificato:
- API/catalogo;
- artwork;
- tutti i media;
- Range/seek;
- upload piccolo e grande;
- revoke;
- re-pair;
- restart Node/Connector.

La fingerprint server della baseline era:

`SHA256:tFv0VGkaNeUB7khsLolKtsYg076d1eVpkcZEZIdnj4k`

Non rigenerare l'identità per risolvere problemi di rete.

## File assenti intenzionalmente dal trasferimento

Per limiti di dimensione non sono stati trasferiti:
- la cartella media reale;
- le cartelle `target`;
- `src-tauri/gen/android`.

Non trattare `src-tauri/gen/android` come codice deliberatamente rimosso. Se serve lavorare su Android, prima chiedimi di recuperare quella cartella dal laptop sorgente oppure verifica con me se possiamo rigenerarla senza perdere personalizzazioni native.

`.env`, database, backup e cache presenti sono stati trasferiti intenzionalmente: non cancellarli o resettarli automaticamente.

## Metodo di lavoro che devi seguire

1. Usa SEMPRE i file correnti come source of truth.
2. Non riapplicare vecchie patch.
3. Prima di modificare un file, leggine la versione corrente.
4. Se lo stato di un file non è certo, chiedimelo invece di inventarlo.
5. Per lavoro offline/deterministico fai batch coerenti, non una sequenza infinita di micro-patch.
6. Dopo un batch fai un unico preflight consolidato.
7. Quando iniziamo i test reali di rete/sicurezza, procedi UN test/scenario alla volta.
8. Non ripetere test già passati se il codice interessato non è cambiato, salvo preflight consolidati.
9. Gli artifact scaricabili devono avere nomi univoci/versionati; non riusare nomi di vecchie versioni.
10. Per modifiche multi-file preferisci uno ZIP overlay con manifest SHA-256.
11. Non aprire porte del router, modificare firewall o installare servizi senza dirmi esattamente cosa stai per fare e perché.
12. Se una modifica può compromettere la sicurezza del PC host, privilegia sempre il design più ristretto.

## Dove siamo e cosa fare adesso

Questo PC Windows è il vero PC host su cui Baia dovrà girare.

Prima di programmare nuove feature, voglio completare la messa in servizio Direct in modo controllato.

Procedi così:
1. ispeziona il repository e conferma lo stato;
2. verifica prerequisiti Node/Rust sul PC;
3. installa dipendenze con i lockfile correnti;
4. esegui il preflight Direct corrente;
5. avvia Node e conferma che risponda soltanto su `127.0.0.1:3000`;
6. trova l'IPv4 LAN reale del PC;
7. prepara il Connector ristretto usando gli script `tools/direct-host`;
8. verifica localmente tutto;
9. FERMATI prima di aprire la porta sul router e chiedimi conferma;
10. dopo la conferma, guidami nella DHCP reservation, DDNS e singolo port-forward `TCP 443 -> PC:43127`;
11. quindi facciamo test reali da rete mobile uno scenario alla volta.

Non saltare direttamente al router e non cambiare architettura.

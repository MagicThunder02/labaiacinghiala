# ROADMAP TECNICA — DIRECT TCP 443

Questo documento prevale sulle vecchie note relay-first per il percorso remoto primario.

## A. Architettura

```text
Baia client -> TCP 443/TLS 1.3 -> router host -> Connector:43127 -> Node 127.0.0.1:3000
```

- Nessuna VPS nel percorso normale.
- Nessuna VPN richiesta agli amici.
- DDNS se l'IP pubblico cambia.
- Relay conservato soltanto come fallback futuro.

## B. Vincoli invarianti

### Host
- Node solo loopback.
- Connector unico componente Internet-facing.
- Upstream Connector fisso a Node.
- Nessun proxy generico.
- Connector con privilegi Windows minimi.

### Client
- L'utente installa soltanto Baia.
- Networking/chiavi/pinning nel Core nativo.
- Nessuna chiave privata in JS.
- Nessun endpoint arbitrario dal frontend.

### Crittografia
- TLS 1.3.
- Server identity persistente e separata dai device.
- Pinning server.
- Device identity distinta e revocabile.
- Crittografia/protocolli maturi; niente primitive proprietarie.

### Media/upload
- Range e seek preservati.
- Upload nativo.
- Backpressure bounded.
- Nessun timeout totale ~30 s.

## C. Fasi

### D0 — baseline
Conservare il preflight verde e i lockfile correnti.

### D1 — Direct primario
Completare Transport Manager Direct e mantenere relay soltanto fallback.

### D2 — hardening Internet-facing
Pre-auth minimo, limiti per IP/globali, timeout, dimensioni bounded, parser stretto.

### D3 — TLS e pinning
TLS 1.3 only; hostname separato dall'identità; server sbagliato sempre rifiutato.

### D4 — pairing/bootstrap
Invito temporaneo, hostname pubblico 443, pin, device identity, revoca.

### D5 — servizio Windows ristretto
Connector come servizio/task con account privilegi minimi, ACL ProgramData, firewall specifico.

### D6 — DDNS e diagnostica
Health locale, verifica Node/Connector/DDNS/firewall/port-forward separatamente.

### D7 — test Internet reali
Da rete mobile, uno per volta:
1. handshake/pairing;
2. catalogo;
3. artwork;
4. video;
5. Range/seek;
6. media non-video;
7. upload piccolo;
8. upload grande;
9. richieste concorrenti;
10. revoke.

### D8 — resilienza/ostile
Scanner, malformed, oversize, slow client, restart Node/Connector/Windows/router, cambio IP/rete.

### D9 — packaging server
`BaiaServerSetup.exe`, servizi, firewall, wizard librerie, DDNS, istruzioni router, backup identità.

### D10 — packaging client
Android/Windows, poi altre piattaforme.

### D11 — aggiornamenti
Update firmati, rollback, migrazioni e compatibilità protocollo.

## D. Exit criterion finale

- Client fuori casa usa catalogo e media.
- Seek e upload grande funzionano.
- Node non è raggiungibile da Internet/LAN.
- Unico forwarding: TCP 443 -> Connector.
- Device revocato respinto.
- Server identity errata respinta.
- Nessun accesso generico a LAN/filesystem.
- Reboot host recupera automaticamente.
- Cambio IP gestito dal DDNS.
- Amici installano soltanto Baia.

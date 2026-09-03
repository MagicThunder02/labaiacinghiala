# CLEANUP REPORT — 31 agosto 2026

Pulizia effettuata sull'archivio ricevuto prima dell'handoff.

## Rimossi perché rigenerabili/storici/non più necessari

- `node_modules/` — reinstallabile con `npm ci`.
- `.phase5-preflight-lock-backup/` — backup temporaneo lockfile.
- `Baia-Direct-Host-Test-20260823-150117/` — pacchetto di trasferimento generato, duplicato del repository.
- `01-preflight-fase0.ps1` — preflight storico Fase 0.
- `applica-pulizia.js` — script una tantum già eseguito.
- `Build-BaiaDirectHostPackage.ps1` — builder di un pacchetto host non più necessario ora che viene trasferito l'intero repository.
- vecchi documenti/manifest/preflight `PHASE5-*` relay-first.
- vecchi `DIRECT-MANIFEST`, `DIRECT-STATIC-AUDIT`, `DIRECT-PRE-REAL-README` del batch di trasferimento.
- `CHANGELOG.md` storico 0.2, non rappresentativo dello stato corrente.
- `Nota MIA migrazione database.txt` — nota personale una tantum.
- `src-tauri/android-res-backup-20260821-192304/`.
- `src-tauri/icons-backup-20260821-192304/`.
- `relay/PHASE5-RELAY-SERVER.md` — istruzioni di deploy relay non coerenti col percorso primario corrente.

## Conservati deliberatamente

- `.env`.
- `data/`, database, WAL/SHM, cache e backup.
- `src/`, `public/`, `test/`, `scripts/`.
- `host-connector/`.
- `src-tauri/`.
- `relay/` come fallback futuro.
- `tools/direct-host/`.
- lockfile Node e Rust.
- `phase5-direct-preflight.ps1` perché è il preflight Direct corrente.
- script di avvio Windows/Linux.

## Non presenti nell'archivio sorgente e quindi non ricreati

- media reale;
- cartelle `target`;
- `src-tauri/gen/android`.

È stata creata soltanto `media/.gitkeep` per mantenere la struttura.

## Documentazione nuova aggiunta

- `README.md` aggiornato.
- `HANDOFF.md`.
- `docs/ROADMAP-DIRECT-TCP443.md`.
- `PROMPT-NUOVA-CHAT-MATTE.md`.
- `relay/README.md`.
- questo `CLEANUP-REPORT.md`.

Nessun sorgente applicativo è stato modificato durante la pulizia.

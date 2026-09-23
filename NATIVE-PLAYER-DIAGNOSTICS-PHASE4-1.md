# Native Player — Phase 4.1 diagnostics

Questa patch NON cambia la politica di buffering/seek. Serve a identificare con certezza quale percorso client genera ogni richiesta `/baia/v1/media`.

## Nuovi marker

Ogni richiesta media inviata dal client contiene un campo diagnostico `clientKind`:

- `native_media_source`: percorso `baia://` usato da libmpv
- `legacy_media_bridge`: ponte localhost/WebView legacy

Il Connector stampa ora `client_kind` e `request_path` sulle righe `media_source=direct_file`.

La NativeMediaSource e il Media Bridge stampano inoltre `event=http_request` immediatamente prima dell'invio al Connector, includendo `request_id` e `range`.

## Scopo del prossimo test

Se i Range da 8 MiB risultano `client_kind=legacy_media_bridge`, il rumore non proviene dalla NativeMediaSource Phase 4 (che resta limitata a 4 MiB). Se risultano `client_kind=native_media_source`, bisogna investigare il percorso tra `fetch_range()` e serializzazione HTTP perché il server sta ricevendo un Range diverso da quello atteso.

## Deploy

Aggiornare sia Connector Linux sia client Windows, perché il nuovo campo diagnostico fa parte del frame media JSON (resta opzionale lato Connector per compatibilità con client precedenti).

## Raccolta rapida

Dopo 30-60 secondi di playback + alcuni seek:

```bash
sudo journalctl -u baia-connector --since "2 minutes ago" --no-pager \
  | grep 'media_source=direct_file' \
  | tail -80
```

Per contare le origini:

```bash
sudo journalctl -u baia-connector --since "2 minutes ago" --no-pager \
  | grep 'media_source=direct_file' \
  | grep -o 'client_kind=[^ ]*' \
  | sort | uniq -c
```

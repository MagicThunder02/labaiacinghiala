# Baia Relay — fallback futuro

Questo crate è conservato deliberatamente ma **non è il trasporto primario attuale**.

Il percorso primario deciso è Direct Internet:

```text
client -> TCP 443/TLS 1.3 -> router host -> Host Connector -> Node loopback
```

Il relay potrà essere riattivato in futuro per:
- host dietro CGNAT;
- reti dove non è possibile configurare port forwarding;
- modalità fallback.

Non eliminare il crate senza una decisione esplicita, ma non introdurre dipendenze obbligatorie dal relay nel deploy normale.

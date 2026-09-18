# Baia Cinghiala — guida utente

Baia Cinghiala è un server multimediale privato per organizzare e usare una libreria personale di film, serie TV, musica e contenuti di lettura. L'interfaccia è in italiano e può essere usata da browser; il repository contiene anche il frontend predisposto per il packaging desktop Tauri.

Questa guida descrive le funzioni disponibili nella versione corrente del repository.

## 1. Come si accede

### Uso sul PC server

1. Avvia Baia Cinghiala sul PC che contiene la libreria.
2. Apri `http://127.0.0.1:3000` nello stesso PC.
3. Il browser locale viene riconosciuto come accesso amministrativo. Se è una nuova installazione, apri **Profilo** e imposta la password dell'account amministratore: servirà per gli accessi dagli altri dispositivi.

### Uso da un altro dispositivo

Il dispositivo deve essere associato al server prima del primo accesso.

1. L'amministratore apre **Account → Nuovo invito** sul browser locale del server.
2. Imposta la durata dell'invito, da 1 minuto a 24 ore, e seleziona **Crea invito**.
3. Condividi il codice mostrato solo con il proprietario del dispositivo da associare. Il codice è monouso e non viene mostrato nuovamente.
4. Sul nuovo dispositivo apri **Profilo → Associa questo dispositivo**.
5. Inserisci un nome riconoscibile per il dispositivo e l'invito temporaneo, quindi seleziona **Associa**.
6. Dopo l'associazione, torna alla schermata di accesso e usa username e password dell'account Baia.

L'associazione del dispositivo e il login dell'account sono due passaggi distinti. L'invito non concede automaticamente l'accesso ai cataloghi.

Per l'accesso via Internet è necessario che l'amministratore abbia configurato il percorso Direct TCP 443 e il Baia Host Connector. Non esporre mai direttamente la porta 3000.

## 2. Account e permessi

Il menu mostra solo le sezioni autorizzate per l'account corrente.

| Tipo di account | Accesso |
| --- | --- |
| Utente | Solo i cataloghi selezionati dall'amministratore: Film, Serie, Musica, Libri, Fumetti e/o Manga. |
| Amministratore | Tutti i cataloghi, Upload manager, Editor metadati e Gestione account. |

Se l'amministratore richiede il cambio password al primo accesso, l'utente può usare soltanto il **Profilo** finché non salva una nuova password.

### Profilo

Dal pulsante con l'avatar, oppure dalla pagina **Profilo**, puoi:

- visualizzare username, ruolo, sezioni abilitate e stato del dispositivo;
- cambiare la password;
- uscire dall'account;
- vedere identità del dispositivo, associazione, trasporto ed endpoint in uso;
- associare il dispositivo con un invito temporaneo;
- visualizzare o reimpostare l'endpoint del server quando la configurazione tecnica lo richiede;
- aggiornare l'app dalla scheda **Aggiornamenti**.

Il cambio password invalida gli accessi precedenti sugli altri dispositivi collegati all'account. Per un account senza password configurata, il Profilo permette di impostare la prima password.

### Aggiornare l'app

La scheda **Aggiornamenti** compare solo nell'app Baia installata, non nel browser. All'apertura del Profilo l'app controlla da sola se esiste una versione più recente; il pulsante *Controlla aggiornamenti* ripete la verifica quando vuoi.

Se una nuova versione è disponibile vedi numero di versione, data e note, e il pulsante *Scarica e installa*: l'app scarica il pacchetto ufficiale firmato, lo installa e si riavvia da sola. Non serve scaricare nulla a mano e non serve toccare il server, che viene aggiornato separatamente da chi lo gestisce.

Su Android il funzionamento è lo stesso, con un passaggio in più: l'app scarica e controlla il pacchetto, poi lo consegna all'installazione di sistema, che chiede conferma. La prima volta Android chiede anche di autorizzare Baia a installare applicazioni; è una spunta da dare una sola volta nelle impostazioni che compaiono in quel momento.

Se l'app è stata installata da un pacchetto di sistema (`deb` o Flatpak su Linux) oppure da uno store, la scheda lo segnala: in quel caso l'aggiornamento si fa con il gestore pacchetti o con lo store. Su iPhone e iPad l'aggiornamento arriva sempre dallo store.

### Gestione account — solo amministratori

La pagina **Account** contiene tre aree:

- **Account**: ricerca degli account, creazione, modifica di username, ruolo e sezioni visibili, disabilitazione, reimpostazione password, disconnessione dei dispositivi e cancellazione dell'account;
- **Gestione Inviti**: elenco degli inviti con stato *Attivo*, *Usato*, *Scaduto* o *Revocato*, filtro e revoca degli inviti ancora validi. È disponibile dal browser amministrativo locale;
- **Gestione dispositivi**: elenco dei dispositivi associati con nome, data di associazione, ultima attività e fingerprint; un dispositivo può essere revocato. È disponibile dal browser amministrativo locale.

Gli amministratori hanno sempre accesso a tutte le sezioni. Deve rimanere almeno un amministratore attivo.

## 3. Navigazione generale

Il pulsante menu apre la barra laterale. Dal menu puoi raggiungere i cataloghi disponibili e, se sei amministratore, gli strumenti di gestione.

- **Film**
- **Serie**
- **Musica**
- **Libri**
- **Fumetti**
- **Manga**
- **Upload manager** — amministratori
- **Metadati** — amministratori
- **Account** — amministratori

La posizione della pagina e i gruppi aperti vengono ricordati nel browser. Su schermi piccoli la barra laterale è un pannello apribile; il tasto **Indietro** torna dal dettaglio o dal player al catalogo.

## 4. Film

### Home e catalogo

La Home organizza i titoli in:

- **Visti di recente**;
- **Ultimi arrivi**;
- **Consigliati**, calcolati in base alla cronologia di visione, ai generi, agli anni e ai titoli già iniziati.

Usa la ricerca per trovare un film per titolo. Il pulsante **Filtri** permette di filtrare per:

- genere;
- regista;
- anno.

I menu dei filtri includono una ricerca interna. **Rimuovi filtri** torna al catalogo completo; **Mostra altro** carica altri risultati quando l'elenco è lungo.

### Scheda e riproduzione

Seleziona una locandina per aprire la scheda del film. La scheda mostra locandina, titolo, anno, generi e regia, oltre ai film simili quando disponibili.

- **Riproduci** riprende dal punto salvato, se esiste;
- **Ricomincia** parte dall'inizio;
- la barra di avanzamento permette di spostarsi nel film;
- il volume è regolabile e viene ricordato nel browser;
- il player supporta lo schermo intero;
- su dispositivi touch, un tocco nella zona sinistra/destra arretra o avanza di 10 secondi;
- da tastiera, **Spazio** riproduce/mette in pausa, le frecce sinistra/destra saltano di 10 secondi, **Maiusc** attiva lo schermo intero ed **Esc** lo chiude.

La posizione viene salvata automaticamente durante la visione e alla chiusura del player. Un titolo completato non viene proposto come “da riprendere”.

## 5. Serie TV

La sezione **Serie** funziona come Film, con ricerca, filtri per genere e anno, Home con **Viste di recente**, **Ultimi arrivi** e **Consigliate**, più serie simili nella scheda.

Nella scheda di una serie puoi:

- scegliere la stagione;
- vedere l'elenco degli episodi;
- riconoscere episodi già completati o parzialmente visti dalla percentuale;
- usare **Riproduci** per riprendere l'episodio suggerito;
- usare **Ricomincia** per partire dall'inizio;
- passare all'episodio precedente o successivo dal player.

Il player offre barra di avanzamento, volume, schermo intero e salto touch di 10 secondi. La posizione è salvata per singolo episodio e per account.

## 6. Musica

### Catalogazione e ricerca

La Home musicale mostra riepilogo libreria, **Riprodotti di recente**, **Ultimi arrivi** e **Per te**. Le viste disponibili sono:

- **Album**;
- **Artisti**;
- **Generi**;
- **Preferiti**;
- **Riprodotti di recente**;
- **Playlist**.

La ricerca globale trova brani, album, artisti e generi. Dalla scheda di un album puoi aprire l'artista, vedere tutti i brani e aggiungere l'album ai preferiti. Ogni brano può essere:

- riprodotto immediatamente;
- aggiunto alla coda;
- aggiunto o rimosso dai preferiti;
- aggiunto a una playlist.

### Player e coda

Il mini-player resta disponibile mentre navighi nell'app. Puoi aprire il player completo dalla copertina, ridurlo, nasconderlo e ripristinarlo.

I controlli includono:

- riproduzione/pausa;
- brano precedente e successivo;
- posizione nel brano;
- volume e silenziamento;
- modalità **Normale**, **Shuffle**, **Ripeti** e **Ripeti 1**;
- menu per andare all'artista, all'album o alla coda.

La coda mostra i brani in attesa e può essere svuotata. Le playlist personali possono essere create, modificate, eliminate, riprodotte e riordinate; i brani possono essere aggiunti o rimossi anche dalla scheda della playlist.

La cronologia musicale viene aggiornata durante l'ascolto e alimenta le sezioni “Riprodotti di recente” e “Per te”.

## 7. Libri, Fumetti e Manga

Le tre sezioni hanno la stessa logica di catalogo:

- ricerca per titolo;
- filtri per genere, autore e anno;
- Home con **Riprendi lettura**, **Ultimi arrivi** e **Consigliati**;
- scorrimento orizzontale delle raccolte;
- scheda del contenuto e apertura nel lettore.

### Lettore

Il lettore supporta:

- PDF per Libri, Fumetti e Manga;
- EPUB per Libri;
- CBZ per Fumetti e Manga;
- pagina precedente e successiva;
- zoom avanti, indietro e ripristino al 100%;
- segnalibro per salvare la posizione;
- ripresa dalla posizione salvata alla riapertura.

I PDF vengono visualizzati nel lettore PDF integrato. EPUB e CBZ vengono elaborati localmente nel lettore dell'app; le risorse interne al documento vengono mantenute quando il formato è valido.

## 8. Upload manager — solo amministratori

L'**Upload manager** organizza il caricamento per categoria. I file vengono copiati nella libreria, registrati nel catalogo e accompagnati dai metadati necessari.

### Film

Seleziona file video e copertina, poi inserisci:

- titolo;
- anno;
- regista;
- uno o più generi separati da virgola.

La destinazione e il nome finale vengono mostrati prima dell'invio. Il caricamento indica l'avanzamento e può essere annullato prima della conferma.

Formati video supportati: `MP4`, `M4V`, `WebM`, `MOV`, `MKV`, `AVI`, `MPEG`, `MPG`, `OGV`.

### Serie

Puoi creare una nuova serie oppure aggiungere episodi a una serie esistente.

Per una nuova serie inserisci titolo, anno, generi e copertina della serie. Aggiungi uno o più video e verifica per ogni episodio:

- stagione;
- numero episodio;
- titolo episodio.

La stessa coppia stagione/episodio non può essere assegnata due volte nella sessione. Gli episodi possono essere rimossi dalla sessione prima dell'importazione.

### Musica

Puoi selezionare fino a 100 file per sessione. Per ogni brano Baia legge e mostra i tag incorporati, che puoi correggere prima dell'importazione:

- titolo;
- artista del brano;
- album;
- artista album;
- numero e totale tracce;
- numero e totale dischi;
- anno e data;
- generi;
- compositori;
- commento;
- indicatore Compilation.

I campi obbligatori per importare sono titolo, artista, album e numero traccia. **Salva tag nel file** scrive i dati nel file audio; **Importa brano** lo inserisce nella libreria; **Importa i brani pronti** completa in una volta i brani validi.

Formati musicali supportati: `MP3`, `FLAC`, `WAV`. Le copertine integrate nei file vengono utilizzate come fonte primaria per gli album.

### Libri, Fumetti e Manga

Seleziona il documento e una copertina, quindi inserisci titolo, anno, autore e generi. I formati ammessi sono:

| Categoria | Formati |
| --- | --- |
| Libri | PDF, EPUB |
| Fumetti | PDF, CBZ |
| Manga | PDF, CBZ |

La copertina è obbligatoria e non può superare 6 MB. Il limite predefinito per i file multimediali e di lettura è 100 GB per file; l'installazione può configurare un limite diverso entro i valori previsti dal server.

## 9. Editor metadati — solo amministratori

L'editor consente di cercare un contenuto per titolo o nome file e modificarne le informazioni senza doverlo ricaricare.

Le categorie disponibili sono Film, Serie, Musica, Libri, Fumetti e Manga.

- **Film**: titolo, anno, generi, regista e copertina;
- **Serie**: titolo, anno, generi e copertina;
- **Episodi**: stagione, numero episodio e titolo;
- **Libri/Fumetti/Manga**: titolo, anno, autore, generi e copertina;
- **Musica — Brano**: tag incorporati e proprietà tecniche;
- **Musica — Album**: titolo album, artisti album, anno, generi e copertina dell'album.

Per ogni brano musicale l'editor mostra anche formato, durata, copertina, dimensione e le altre proprietà tecniche disponibili nel file.

Per la musica è possibile rimuovere o sostituire la copertina dell'album. La modifica dei tag musicali aggiorna il file audio e il catalogo. Quando si modifica un album, l'editor mostra i brani coinvolti e segnala eventuali valori non uniformi.

Il pulsante **Elimina** rimuove il contenuto dal catalogo e cancella la relativa cartella dalla libreria. Per le serie elimina la serie e tutti gli episodi; gli episodi non possono essere eliminati singolarmente dall'editor. L'operazione è amministrativa e va confermata con attenzione.

## 10. Manutenzione della libreria — nell'Upload manager

La sezione di manutenzione mostra:

- numero totale degli elementi video;
- numero di film ed episodi;
- spazio indicizzato;
- disponibilità dell'archivio multimediale;
- elementi non disponibili;
- formati video supportati.

### Scansione musicale

Dal browser amministrativo locale del PC server puoi selezionare **Scansiona libreria musicale**. La scansione controlla la cartella Musica, aggiorna SQLite e non modifica i file.

Il rapporto mostra file:

- nuovi;
- aggiornati;
- riattivati;
- mancanti;
- invariati;
- ignorati;
- con errori.

Sono inoltre elencati i file ignorati o non leggibili. La scansione non è disponibile da un browser remoto.

La verifica automatica all'avvio controlla che i file già presenti nel catalogo esistano ancora; copiare manualmente nuovi file nelle cartelle non equivale a importarli. Per i nuovi contenuti usa Upload manager oppure la scansione musicale per i file audio.

## 11. Backup, disponibilità e sicurezza

- Il database del catalogo è SQLite e il server crea backup giornalieri e mensili.
- Le copertine memorizzate nelle cache possono essere ricostruite; i file multimediali restano nella libreria configurata.
- Se un file registrato non è raggiungibile, il catalogo può mostrarlo come non disponibile finché non torna accessibile.
- Gli inviti di pairing sono temporanei, monouso e revocabili.
- Le password non vengono mostrate nuovamente nell'interfaccia.
- La porta Node `3000` resta locale al PC server. Per l'accesso remoto si usa il Connector TLS, non un'esposizione diretta di Node.

## 12. Cineforum

La pagina **Cineforum** è presente nel repository ma non è ancora collegata alla navigazione principale. È solo predisposta e mostra una descrizione delle funzioni future: serate, inviti, votazioni e visione sincronizzata non sono ancora operativi nella versione presente.

## 13. Risoluzione dei problemi

### Non vedo una sezione

L'amministratore deve abilitare la sezione nell'account. Per un account appena creato, verifica anche di aver completato il cambio password obbligatorio.

### Il dispositivo non si collega

Controlla che il pairing sia stato eseguito sul dispositivo corretto, che l'invito non sia scaduto o già usato e che l'indirizzo del server sia raggiungibile. Se il dispositivo è stato revocato, serve un nuovo pairing.

### Il catalogo è vuoto dopo aver copiato file

La copia manuale nel filesystem non importa automaticamente i nuovi contenuti. Usa Upload manager; per la musica esegui anche la scansione musicale dal browser locale del server.

### Un contenuto risulta non disponibile

Verifica che il volume della libreria sia montato e che il file non sia stato spostato o rinominato. Riavvia il server o aggiorna la pagina dopo aver ripristinato il percorso.

### Un file viene rifiutato

Controlla estensione e dimensione. Per una copertina verifica anche il limite di 6 MB; per musica e lettura verifica che il formato sia ammesso dalla categoria scelta.

### Ho perso la password

Un amministratore può reimpostare la password di un altro account da **Account**. La reimpostazione disconnette i dispositivi collegati e può imporre un nuovo cambio password al login successivo.

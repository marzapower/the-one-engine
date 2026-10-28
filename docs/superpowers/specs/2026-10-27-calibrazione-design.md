# Calibrazione del negozio di prestigio — design

27 ottobre 2026. Nasce da una sessione di gioco dell'owner sul negozio dei
Fragments di The One Incremental, ma lo strumento è del motore e generico.

## Perché

Il negozio del primo prestigio di The One è sbilanciato e nessuna sonda poteva
accorgersene. Le sonde del ritmo della run (24–26/10) non compravano nulla dal
negozio; quelle che avevano fissato i prezzi del negozio (22–23/10) giravano
con le regole della run precedenti. I bot del motore (`balance/bots/*.json`,
`GreedyBot`) non sanno fare le mosse proprie del gioco (Sharpening, Carry the
One), quindi in un'ora arrivano a 1e10 e non prestigiano mai.

Esempio reale (owner, seconda Fracture): Doubling Down a 2 IF, spinta della run
fino a 1e34 per 3 IF invece di 1, poi Chain of Command a 3 IF. In una sola run
il Carry passa da ×3 a ×6 e il tier più alto raddoppia.

Lo strumento deve rispondere alla domanda dell'owner: **comprando gli upgrade
del prestigio in ordini diversi, quanto velocemente cresce il guadagno di
prestigio (IF/s), e qualche ordine produce una curva di forma diversa dalle
altre?**

## Obiettivi

1. Simulare una partita **con le mosse proprie del gioco** (iniettate dal
   consumer) e con gli acquisti del negozio di prestigio in un **ordine dato**.
2. Esplorare **molti ordini d'acquisto** dello stesso insieme di upgrade, fino
   ad averli comprati tutti; i ripetibili hanno un tetto di livelli in
   configurazione.
3. Per ogni ordine, registrare la **curva del tasso di prestigio** (valuta di
   prestigio al secondo) nel tempo, i tempi ai traguardi e gli intervalli fra
   prestigi.
4. Giudicare l'insieme degli ordini con due misure, separate:
   - **forma** (squilibrio): un ordine la cui curva, in scala logaritmica, ha
     una pendenza che si stacca da quella mediana e il distacco cresce nel
     tempo invece di restare costante. È la definizione dell'owner: "se
     acquistando presto un upgrade la curva risultante è un esponenziale
     significativamente più elevato degli altri, il gioco è sbilanciato";
   - **spostamento** (strategia): quanto prima l'ordine migliore arriva a un
     traguardo rispetto al mediano. È ammesso, entro un tetto.
5. Attribuire la causa: per ogni upgrade, l'effetto di **anticiparlo** o
   **ritardarlo** rispetto all'ordine mediano.
6. Produrre un **report** leggibile nel browser (curve sovrapposte in scala
   log, tabella degli allarmi, sensibilità per upgrade) più il JSON grezzo.
7. Restare **generico**: nessun codice di The One nel motore. Tutto ciò che è
   del gioco (codici, mosse, tetti, traguardi) arriva da configurazione e da
   funzioni iniettate. Lo stesso strumento dovrà poter servire il Builder.

## Non obiettivi

- Non decide i prezzi da solo: misura, l'owner sceglie.
- Non progetta il negozio nuovo di The One (è un lavoro separato, con Astra,
  che userà questo strumento per i numeri).
- Non simula sessioni con pagina chiusa né offline in questa prima versione
  (vedi "Lasciato al builder" per il punto d'aggancio).
- Non sostituisce `runBalanceSim`/`GreedyBot`: li riusa.

## Anti-obiettivi

- Uno strumento che funziona solo per The One (codici del gioco nel motore).
- Soglie presentate come verità: le soglie sono parametri; il default è
  provvisorio e dichiarato tale nel report.
- Un giudizio basato sul bot che compra ogni 5 secondi: il giocatore simulato
  di riferimento è un umano che visita a intervalli e fa pochi gesti.

## Vincoli

- Il motore resta indipendente da React, Redux, Remix, database e contenuti
  del gioco (CLAUDE.md del workspace).
- Numeri grandi con `N`/`NR`/`Decimal`.
- I consumer usano il `dist/` del motore via `link:`: dopo modifiche al motore
  si ricostruisce prima di verificare il gioco.
- Le mosse del gioco (Sharpening, Carry the One) vivono nel gioco
  (`remix/app/models/run-rules.ts`) e restano lì: il motore le riceve come
  funzioni.
- Il report HTML è un file statico autonomo (niente server, niente CDN
  obbligatori): si apre con un doppio clic.

## Cosa è stato deciso

### Dall'owner

- **Cosa si esplora:** combinazioni di ordini d'acquisto degli upgrade del
  prestigio fino al loro acquisto completo, con un tetto ai ripetibili; i
  ripetibili dovrebbero dare curve più o meno lineari.
- **Cosa si guarda:** quanto rapidamente ogni ordine fa crescere gli IF/s.
- **Cosa è squilibrio:** un ordine che produce una curva esponenzialmente più
  ripida (non solo anticipata) delle altre. Gli ordini più veloci per
  strategia sono attesi.
- **Soglia:** non fissata a priori; si tara giocando. È un parametro.
- **Ordine dei lavori:** prima questo strumento, poi i numeri del negozio nuovo.

### Scelte di Claude (da confermare con l'owner leggendo)

- **Dove sta:** nuovo modulo `balance/calibration/` del motore, esportato da
  `the-one-engine/balance`.
- **Default della soglia di spostamento:** ×2 sul tempo al traguardo
  (ordine migliore contro mediano), marcato "provvisorio" nel report.
- **Giocatore simulato di riferimento:** una visita ogni 2 minuti di gioco
  (come le sonde del 26–27/10); a ogni visita fa ciò che è pronto e torna.
- **Ordini esplorati:** non tutti (10 upgrade con tetti fanno milioni di
  ordini), ma una selezione ragionata (sotto).

## Come funziona

### 1. Mosse del gioco (estensione generica dell'harness)

Oggi `BotIntent` conosce solo `buyProducer`, `buyUpgrade`, `prestige`. Si
aggiunge un quarto tipo, `move`, con un registro di mosse fornito dal consumer:

```ts
interface GameMove {
  code: string; // es. "sharpen:e3", "carry"
  ready(state: GameState, engine: Engine): boolean; // la mossa si può fare ora
  apply(state: GameState, engine: Engine): boolean; // la fa; false se non applicata
}
```

L'harness resta l'unico punto di mutazione: applica le mosse come gli altri
intenti e le registra come `SimAction` di tipo `move` (con `tSimMs`), così le
metriche e i report le vedono. The One registrerà Sharpening per tier e Carry
the One (più l'eventuale tocco iniziale: oggi le sonde mettono `one = 10` dopo
Carry e Fracture per simulare ~10 tocchi; nella calibrazione questo diventa una
mossa del gioco o il `clickable` già esistente dell'harness).

### 2. Routine della run (il giocatore simulato)

Una policy generica, configurabile a dati, che a ogni visita:

1. compra dal negozio di prestigio **secondo l'ordine assegnato** (sotto);
2. decide il prestigio con una **regola**: la stessa per tutti gli ordini in
   un confronto. Regole previste: `rate` (prestigia quando il guadagno
   all'ora della run smette di crescere — esiste già come `rateRulePrestige`
   nel gioco, va portata o reimplementata in modo generico) e `target`
   (prestigia al raggiungimento di un guadagno minimo, eventualmente
   funzione del moltiplicatore di guadagno, come la spinta a 1e34);
3. esegue le mosse pronte in ordine di priorità dichiarata;
4. compra producer: buy max dal tier più alto aperto al più basso (come le
   sonde attuali).

Parametri: intervallo fra visite, regola di prestigio, priorità delle mosse,
orizzonte (tempo massimo o traguardo massimo).

### 3. Ordine d'acquisto del negozio

Un ordine è una sequenza di **voci** `(codice, livello)`. Un ripetibile con
tetto 3 contribuisce tre voci, e la voce di livello k+1 viene sempre dopo
quella di livello k. Regola d'acquisto: **rigida**. A ogni visita si compra
la prossima voce della sequenza se la si può pagare, poi la successiva, e così
via; se la prossima non si può pagare si risparmia (non si salta avanti).
Finita la sequenza, il negozio non si tocca più. È ciò che rende l'ordine
significativo.

Configurazione del consumer: codici degli upgrade inclusi, tetto per i
ripetibili, eventuali vincoli (un upgrade che si sblocca solo dopo un altro:
li legge già `engine.isUnlocked`/`upgradePurchaseBlock`; una voce bloccata
conta come non pagabile).

### 4. Selezione degli ordini

1. **Ordine di riferimento**: il più economico prima (costo della prossima
   voce crescente, a parità l'ordine di configurazione). È anche la base per
   la sensibilità.
2. **Anticipa / ritarda**: per ogni upgrade, l'ordine di riferimento con il
   suo primo livello spostato in testa, e con tutti i suoi livelli spostati in
   coda.
3. **Campione casuale**: N ordini casuali validi, con seme fisso (ripetibile).
4. **Ricerca del migliore e del peggiore**: ricerca a fascio (beam search)
   sui prefissi, punteggio = tempo al traguardo principale; larghezza del
   fascio in configurazione.

Il numero di simulazioni va tenuto basso con la **condivisione dei prefissi**:
ordini con lo stesso inizio condividono la simulazione fino al primo acquisto
in cui divergono, clonando lo stato del gioco a quel punto (vedi rischi).

### 5. Misure per ordine

- **Tasso di prestigio** nel tempo: valuta di prestigio guadagnata (inclusi
  gli accrediti passivi come il drip) per secondo, campionata e anche
  calcolata per run (guadagno / durata della run).
- **Tempi ai traguardi** di valuta di prestigio guadagnata (default 10, 100,
  1.000; configurabili).
- **Intervalli fra prestigi** e verifica che calino.
- **Momento d'acquisto** di ogni voce.
- **Pendenza** di log10(tasso) nel tempo, per finestre (default: fra due
  traguardi consecutivi).

### 5b. Definizioni per il giudizio (scelte di Claude dopo la revisione)

- **Serie canonica del tasso**: per ogni run (da un prestigio al successivo)
  il tasso è la valuta di prestigio guadagnata nella run, accrediti passivi
  compresi, divisa per la durata della run; il punto si colloca alla fine
  della run. Il campionamento continuo resta come serie di contorno nel
  report, non entra negli allarmi.
- **Confronto nel tempo**: le serie dei diversi ordini si campionano su una
  griglia comune (default ogni ora di gioco simulato; il tasso in un punto è
  quello dell'ultima run conclusa). In ogni punto si calcola la mediana e, per
  ogni ordine, il distacco `log10(tasso) − log10(mediana)`. Distacco stabile =
  vantaggio di scala (strategia); distacco che cresce = vantaggio strutturale
  (indicazione di Astra, coerente con la definizione dell'owner). Il confronto
  si ripete anche allineando sui traguardi (tempi ai traguardi).
- **Mediano**: calcolato sull'insieme "riferimento + anticipa/ritarda +
  campione casuale". Gli estremi trovati dalla ricerca a fascio sono
  etichettati per origine e non entrano nel mediano.
- **Ordini che non arrivano**: un ordine che non raggiunge un traguardo entro
  l'orizzonte è **censurato** (tempo = "oltre l'orizzonte"), segnalato nel
  report e trattato come più lento di tutti nei confronti ordinali (mediano,
  rapporto di spostamento). Un ordine fermo su una voce mai pagabile è
  censurato allo stesso modo e la voce bloccante è nominata.
- **Traguardi**: lo spostamento si giudica su **tutti** i traguardi, con un
  allarme per traguardo. La ricerca a fascio usa come punteggio il tempo
  all'ultimo traguardo raggiunto dall'ordine di riferimento.
- **Regola di prestigio**: per il giudizio di squilibrio il default è `rate`,
  uguale per tutti gli ordini e cieca agli upgrade comprati: se spingere la
  run conviene, la regola lo fa da sola. `target` resta disponibile come
  variante esplicita, da non mescolare nello stesso confronto.
- **Tocco iniziale e mosse**: il tocco usa il `clickable` già esistente
  dell'harness (nessuna mossa nuova). Le mosse si fanno appena pronte, per
  priorità dichiarata, come nelle sonde attuali (Carry appena pronto).
  Trattenere una mossa è fuori da questa versione.

### 6. Giudizio

- **Forma**: allarme se il distacco di un ordine dalla mediana cresce per
  almeno K punti consecutivi della griglia (default 3) di almeno una soglia
  complessiva (default 0,3 decadi, cioè ×2) e alla fine è positivo. L'allarme
  indica l'ordine e la prima voce in cui quell'ordine anticipa qualcosa
  rispetto al riferimento.
- **Spostamento**: rapporto fra tempo al traguardo del mediano e del migliore.
  Allarme oltre la soglia (default ×2, provvisorio).
- **Sensibilità**: per ogni upgrade, differenza di tempo ai traguardi e di
  pendenza fra "anticipato", "riferimento", "ritardato".
- **Ritmo**: allarme se gli intervalli fra prestigi non calano (l'owner vuole
  ogni prestigio più veloce del precedente).

### 7. Report

- JSON: configurazione usata (con provenienza: commit del motore e del
  gioco se disponibili), ordini, serie, misure, allarmi.
- HTML statico autonomo: grafico delle curve log(tasso) nel tempo, una linea
  per ordine, con riferimento e mediano evidenziati; tabella degli allarmi;
  tabella di sensibilità per upgrade; tempi ai traguardi; parametri e soglie
  in testa, con "provvisorio" dove vale.

### 8. Uso da parte di The One

Il gioco fornisce, in un file di configurazione del suo repo più un modulo TS
che registra le mosse:

- codice del prestigio e della sua valuta (`fragmentation`, `if`);
- upgrade inclusi e tetti dei ripetibili;
- mosse: Sharpening per tier, Carry the One, tocco iniziale;
- regola di prestigio e orizzonte (proposta: fino all'acquisto completo o a
  40 h di gioco simulato);
- traguardi.

Un comando nel repo del gioco lancia la calibrazione e scrive il report in una
cartella ignorata da git.

## Rischi noti

- **Clonazione dello stato**: la condivisione dei prefissi richiede di clonare
  lo stato a metà partita. Il motore tiene dello stato fuori da `GameState`
  (ad esempio `prestigeRuns` per la regola per tasso, MANUAL del gioco §4) e
  la policy tiene stato interno. Se clonare tutto non è affidabile, si
  rinuncia alla condivisione e si rigioca ogni ordine da zero (più lento,
  stesso risultato).
- **Tempi di calcolo**: oggi 40 h simulate con tick di 1 s richiedono decine
  di secondi per ordine. Con ~100 ordini servono parallelismo (processi o
  worker) o la condivisione dei prefissi.
- **Mosse che usano il singleton del gioco**: `run-rules.ts` importa l'istanza
  `engine` del gioco (per `isUnlocked`). Le mosse registrate devono funzionare
  con l'engine della simulazione: o si passano l'engine ricevuto, o si
  verifica che la parte usata dipenda solo dallo stato.

## Lasciato al builder

- Nomi interni, struttura dei file nel modulo, formato esatto del JSON.
- Libreria o SVG a mano per i grafici del report (purché il file resti
  autonomo).
- Parallelismo: worker, processi o condivisione dei prefissi, purché i
  risultati siano identici a quelli senza.
- Come portare in modo generico la regola di prestigio "per tasso".
- Punto d'aggancio per profili futuri (sessioni con pause, pagina chiusa,
  offline), senza implementarli ora.

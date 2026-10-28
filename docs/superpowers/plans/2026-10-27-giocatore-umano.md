# Calibrazione con un giocatore umano — piano

Evolutiva del 27/10/2026, dopo i criteri del negozio approvati dall'owner
(artifact «Criteri del negozio»). Il calibratore oggi simula un bot sempre
presente che agisce ogni 2 minuti; le misure hanno mostrato che la run è
limitata dai gesti (visita ogni 15 min → 4 IF in 60 h contro 31). Per prezzare
automazioni e acceleratori serve il giocatore dell'owner.

## Decisioni dell'owner (27/10/2026)

- Una settimana di gioco = 35 ore di gioco attivo.
- Giornata: **due sessioni da 2,5 h**, il resto a pagina chiusa.
- Sessione **mista**: all'inizio gioco attivo (ogni 1–2 min), poi scheda aperta
  con un controllo ogni 10–15 min.
- Le automazioni lavorano **solo a pagina aperta**: a pagina chiusa la partita
  produce soltanto (recupero F07, assenze < 24 h).

## Scelte mie (dichiarate)

- Sessioni alle 0 h e alle 12 h di ogni giorno simulato (pause di 9,5 h).
- Sessione: 30 minuti con una visita ogni 2 minuti, poi una visita ogni
  15 minuti fino alla fine (il caso peggiore dei 10–15 dell'owner).
- Le automazioni agiscono ogni minuto simulato a pagina aperta (granularità del
  campionamento; nel gioco agirebbero a ogni tick): limite dichiarato.
- Il tap (One quando si è fermi) solo nei minuti di visita: a pagina chiusa o
  fra due controlli nessuno clicca.
- Shop, Fracture e mosse non automatizzate solo nelle visite.
- Orizzonte del profilo umano: 10 giorni (240 h di calendario, 50 h attive).
- Traguardi IF: 10, 100, 300 (300 è il criterio della prima settimana).
- Le automazioni oggi non esistono nel negozio: il gioco le accende da
  `CALIB_AUTO` (`buy`, `sharpen`, `carry`) come ipotesi da misurare. Quando il
  negozio le venderà, il predicato leggerà gli upgrade posseduti.

## Contratti

### Motore — `packages/engine/src/balance/calibration/presence.ts` (nuovo)

```ts
/** Consecutive visit rhythms inside a session; the last one lasts until the session ends. */
export interface VisitPhase {
  forMs: number;
  everyMs: number;
}
export interface PresenceSession {
  startMs: number;
  durationMs: number;
  visits: VisitPhase[];
}
/** When the page is open, repeating every `periodMs` from t = 0. */
export interface PresenceProfile {
  periodMs: number;
  sessions: PresenceSession[];
}

/** Throws (English message naming the field) unless: every duration is a positive multiple of 60 000 ms (startMs ≥ 0 multiple of 60 000); sessions sorted, not overlapping, inside the period; at least one visit phase each. */
export function validatePresence(profile: PresenceProfile): void;
/** The page is open at tMs: some session s with s.startMs ≤ (tMs mod periodMs) < s.startMs + s.durationMs. */
export function isOpen(profile: PresenceProfile, tMs: number): boolean;
/** A visit falls exactly on tMs: open, and tMs = session start + phase start + k·everyMs with phase start ≤ offset < next phase start (the last phase runs to the session end). The session start is always a visit. */
export function isVisit(profile: PresenceProfile, tMs: number): boolean;
/** Total open time in [0, tMs). */
export function openMsUntil(profile: PresenceProfile, tMs: number): number;
```

### Motore — `run-policy.ts`

```ts
export interface RunAutomation {
  /** Moves the game performs by itself while the page is open. */
  moves?: (state: GameState) => ReadonlySet<string>;
  /** Producers (in `producerCurrency`) the game buys at max by itself while the page is open. */
  producers?: (state: GameState) => ReadonlySet<string>;
}
export interface RunPolicyOptions {
  // ... existing fields unchanged
  /** The player's presence; absent = a visit every `visitMs`, as before. */
  presence?: PresenceProfile;
  automation?: RunAutomation;
}
```

`decide` at time t:

- without `presence`: unchanged (the harness calls it every `visitMs`).
- with `presence`: closed → `[]`; visit → the current four steps, unchanged;
  open but no visit → only automation: the ready moves of `movePriority`
  contained in `automation.moves(state)` (if any, end of the decision as
  today), otherwise the producers of `automation.producers(state)` at buy max,
  highest first. No shop, no prestige.
- The second round of `redecideAfterMoves` at the same t has the same
  visit/automation nature (pure function of t).

### Motore — `harness.ts`

`RunBalanceSimOptions.canTap?: (tSimMs: number) => boolean` — when given and
false for the chunk ending at `tSimMs`, no taps in that chunk (the tap clock is
left untouched). Default: always.

### Motore — `simulate.ts`

- With `policy.presence`: `validatePresence`, decision interval 60 000 ms,
  `canTap: (t) => isVisit(presence, t)`. Without: unchanged (`visitMs`).
- `OrderResult` unchanged.

### Motore — `analyze.ts`

```ts
/** First purchase of level 1 of each shop code: best over all orders, median over the median origins (never = +∞). */
firstPurchase: Record<string, { best: number | null; median: number | null }>;
```

### Motore — `report-html.ts`

`CalibrationReportMeta.presence?: PresenceProfile`. When present: a line
describing it (sessions per period, open hours per period); every time in
the milestone, first purchase and phase tables also shows the open time
("38 h, 8 h attive") through `openMsUntil` — run phases are durations, so
only calendar there. New "Primo acquisto" table (code, best, median).

### Gioco — `remix/app/balance/calibration/the-one.ts`

```ts
export const THE_ONE_PRESENCE: PresenceProfile; // as decided above
export type TheOneAutomation = "buy" | "sharpen" | "carry";
export interface TheOnePlayer { human: boolean; auto: TheOneAutomation[] }
/** From CALIB_PLAYER ("human" default | "bot") and CALIB_AUTO (comma list; unknown names throw). */
export const playerFromEnv: (env?: NodeJS.ProcessEnv) => TheOnePlayer;
/** The policy and horizon for a player: bot = today's (2 min, 60 h); human = THE_ONE_PRESENCE, 240 h, automation from `auto`. */
export const theOneSetup: (player: TheOnePlayer) => { policy: RunPolicyOptions; horizonMs: number };
```

`THE_ONE_CALIBRATION.milestones` → `[10, 100, 300]`. `theOneSimInput()` reads
`playerFromEnv()`. `calibrate.run.ts`: provenance says the player and the
automations, `presence` passed to the report meta. `shard.run.ts` unchanged
(inherits the environment).

## Test

- `presence.test.ts`: isOpen/isVisit/openMsUntil over two days of the The One
  shape; validation errors (overlap, not a multiple of a minute, outside the
  period, no phases).
- `harness.test.ts`: `canTap` false → zero clicks, true → as today.
- `simulate.test.ts`: with a presence of short sessions every action falls
  in an open minute, shop purchases and prestiges only on visits; with
  automation of producers, producer purchases also between visits; without
  automation, none between visits.
- `analyze.test.ts`: firstPurchase best/median with a censored order.
- `report-html.test.ts`: active hours shown with `presence`, absent without.
- Game `the-one.test.ts`: `playerFromEnv` (default, bot, auto list, unknown
  throws); one simulated day of the human player: no action outside the two
  sessions.

## Fuori dallo scopo

- Nessun upgrade, prezzo o meccanica del gioco toccati; MANUAL invariato.
- Nessuna rottura dei salvataggi; nessun commit.
- Builder non toccato.
- Le automazioni nel gioco vero (UI, offline) sono lavoro successivo.

## Correzioni del critico (APPROVATO CON CORREZIONI), recepite

Prevalgono su quanto scritto sopra.

1. **Tap dopo la visita.** `canTap(t) = isVisit(t) || isVisit(t − 60 000)`:
   l'harness tappa prima di decidere (advance → tap → sample → decide), quindi
   dopo un Carry fatto in visita il giocatore clicca nel minuto seguente. Un
   Carry _automatico_ fra due controlli lascia invece One a 0 fino alla visita
   dopo: è un risultato da misurare (la ripartenza dopo il Carry chiede il
   giocatore), non un difetto, e il report di gioco lo dichiara.
2. **Carry automatico e Fracture.** In The One il predicato
   `automation.moves` esclude `carry` quando la Fracture paga già almeno un IF
   (`engine.prestigeGain(state, fragmentation) ≥ 1`): il 7° Carry ha la stessa
   soglia 1e30 della Fracture e la distruggerebbe. Test dedicato.
3. **Tempo aperto.** Con un profilo, l'analisi lavora in tempo a pagina
   aperta, non di calendario. Nuova funzione pura in `presence.ts`:
   ```ts
   /** The same result with every instant mapped to open time (openMsUntil): runs (ratePerHour recomputed on open time), marks (open time from the run start), purchases, milestones, endedAtMs, horizonMs, openRun. */
   export function toOpenTime(result: OrderResult, profile: PresenceProfile): OrderResult;
   ```
   `CalibrationPlan.presence?: PresenceProfile`: `runCalibration` converte i
   risultati con `toOpenTime` prima di `analyzeCalibration`, che resta
   invariata. Allarmi di ritmo, grafico, traguardi e fasi sono quindi in ore
   di gioco attivo. `CalibrationReportMeta.openTime?: boolean` cambia solo le
   etichette («ore di gioco attivo») e aggiunge una nota in testata. Niente
   doppie colonne calendario/attive.
4. **Validazione.** `startMs ≥ 0`, `durationMs`, `forMs`, `everyMs` positivi e
   multipli di 60 000; la somma dei `forMs` delle fasi non ultime è minore di
   `durationMs`; le visite stanno in `[start, start + durationMs)`; sessioni
   ordinate, non sovrapposte, dentro il periodo. Con `presence` il campo
   `visitMs` è ignorato (non validato, non usato). La prima decisione
   dell'harness è a t = 60 000: la visita a t = 0 non avviene, dichiarato (a
   t = 0 non c'è nulla da fare).
5. **Test senza ambiente.** `theOneSimInput(player?: TheOnePlayer)` e
   `theOneSetup(player)`: i test passano sempre un giocatore esplicito;
   `playerFromEnv` lo usano solo `shard.run.ts` e `calibrate.run.ts`. Test
   aggiunti: produzione a pagina chiusa (One cresce fra le sessioni senza
   azioni), guardia Carry/Fracture, tap nel minuto dopo la visita,
   validazione delle fasi.

Facoltativi accolti: `CALIB_DAYS` (default 10) per l'orizzonte del profilo
umano; `firstPurchase` elenca il livello 1 di ogni codice che compare negli
ordini, anche se nessuno lo compra («mai»).

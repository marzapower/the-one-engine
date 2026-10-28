# Calibrazione del negozio di prestigio — piano di costruzione

> **Per chi esegue:** il processo è quello dell'owner (skill `evolutiva`): agenti in parallelo su
> file disgiunti, critica, review indipendente, gate. I passi usano le checkbox (`- [ ]`).
> **Nessun commit né push** senza il consenso esplicito dell'owner (CLAUDE.md del workspace): il
> passo "Commit" di ogni task è sostituito da "lasciare le modifiche nel working tree".

**Obiettivo:** uno strumento del motore che simula molti ordini d'acquisto del negozio di
prestigio, misura la crescita del tasso di prestigio nel tempo e segnala squilibri; The One lo usa
con le sue mosse (Sharpening, Carry the One).

**Architettura:** nuovo modulo `the-one-engine/packages/engine/src/balance/calibration/`,
esportato da `the-one-engine/balance`. L'harness esistente (`runBalanceSim`) guadagna le mosse
iniettate (`GameMove`) e una condizione di arresto. Una policy generica gioca la run e compra il
negozio in ordine rigido; un orchestratore asincrono genera gli ordini, li fa simulare da un
esecutore fornito dal consumer (The One: processi `vite-node` in parallelo), analizza e produce
JSON + HTML autonomo.

**Tecnologie:** TypeScript, vitest, `N`/`NR`/`Decimal` del motore; nel gioco `vite-node`
(`./node_modules/.bin/vite-node -c vitest.config.mts <file>` risolve l'alias `~`, verificato) e
`node:child_process`.

**Spec:** `the-one-engine/docs/superpowers/specs/2026-10-27-calibrazione-design.md`.

## Vincoli globali

- Il motore non conosce codici di The One (`if-*`, `e1`, `one`, `fragmentation`): arrivano da
  configurazione o funzioni iniettate.
- Il motore resta senza React/Redux/Remix/DB. Il report HTML è una stringa autonoma (SVG inline,
  nessuna risorsa esterna).
- Soglie: parametri con default, il report li stampa; lo spostamento ×2 è marcato "provvisorio".
- Determinismo: stesso input e stesso seme → stesso output, a prescindere dal parallelismo.
- Dopo modifiche al motore: `pnpm build` nel motore prima di verificare il gioco (consumer via
  `link:` su `dist/`).
- Gate motore (da `the-one-engine/`): `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm test`.
  Gate gioco: come CLAUDE.md del gioco (vitest dalla radice; in `remix/` tsc, eslint, prettier
  sui file toccati).

## Punti di attenzione per la review

1. **Voce mai pagabile o bloccata da `unlock`:** l'ordine si ferma lì; il risultato porta
   `blockedAt` e tempi ai traguardi `null`, non va in loop né lancia. → test nel Task 3.
2. **Nessun prestigio entro l'orizzonte:** `runs` vuoto, traguardi `null`, l'analisi non divide
   per zero né produce `NaN` nell'HTML. → test nei Task 4 e 6.
3. **Mediana con ordini censurati:** i `null` contano come "oltre l'orizzonte" (più lenti di
   tutti), mai come 0. → test nel Task 4.
4. **Seme e parallelismo:** stessi ordini e stessi risultati con 1 o N processi. → test nel Task 5
   (esecutore finto) e prova nel Task 8.
5. **Stato condiviso fra simulazioni:** ogni ordine parte da uno stato e un engine nuovi; nessuna
   mutazione trapela fra ordini dello stesso processo. → test nel Task 3.

---

### Task 1: mosse del gioco e arresto nell'harness

**File:**

- Modifica: `packages/engine/src/balance/types.ts`, `packages/engine/src/balance/harness.ts`
- Test: `packages/engine/src/balance/harness.test.ts` (in coda)

**Interfacce prodotte:**

```ts
// types.ts
export interface GameMove {
  code: string;
  ready(state: GameState, engine: Engine): boolean;
  apply(state: GameState, engine: Engine): boolean;
}
// BotIntent += { kind: "move"; code: string }
// SimAction += { kind: "move"; code: string; tSimMs: number }
// harness.ts — RunBalanceSimOptions +=
moves?: GameMove[];                                        // registro delle mosse
shouldStop?: (state: GameState, tSimMs: number) => boolean; // valutata dopo ogni punto di decisione
```

- [ ] Test: `move intents apply registered moves and are recorded` — una mossa `double` che
      raddoppia `primary` quando `ready` (amount ≥ 10): l'azione compare in `report.actions` con
      `kind: "move"`; una mossa non registrata o non pronta conta in `droppedIntents`.
- [ ] Test: `shouldStop ends the run early` — `shouldStop` vero a 30 s con durata 120 s: l'ultimo
      campione ha `tSimMs` ≤ 30 s + `sampleIntervalMs`.
- [ ] Verifica che falliscano (`pnpm vitest run packages/engine/src/balance/harness.test.ts`).
- [ ] Implementa: `applyIntent` gestisce `move` (cerca nel registro, `ready` poi `apply`);
      `shouldStop` interrompe il ciclo dopo la decisione. Senza le opzioni nuove nulla cambia
      (i test esistenti restano verdi).
- [ ] Verifica che passino.

### Task 2: tipi della calibrazione e generazione degli ordini

**File:**

- Crea: `packages/engine/src/balance/calibration/types.ts`, `.../calibration/orders.ts`
- Test: `.../calibration/orders.test.ts`

**Interfacce prodotte (`types.ts`):**

```ts
export interface ShopEntry { code: string; maxLevel: number }      // tetto per i ripetibili
export interface OrderItem { code: string; level: number }         // level da 1
export type ShopOrder = OrderItem[];
export type OrderOrigin = "reference" | "anticipate" | "delay" | "random" | "beam-best" | "beam-worst";
export interface OrderJob { id: string; origin: OrderOrigin; subject?: string; order: ShopOrder }
export interface RunRecord { index: number; startMs: number; endMs: number; gain: number; ratePerHour: number }
export interface OrderResult extends OrderJob {
  purchases: { code: string; level: number; tSimMs: number }[];
  runs: RunRecord[];                               // gain = earned della valuta di prestigio nella run, passivi inclusi
  milestoneTimes: Record<string, number | null>;   // chiave = traguardo (es. "10"); null = non raggiunto
  blockedAt?: OrderItem;                           // voce su cui l'ordine si è fermato
  horizonMs: number;
}
export interface CalibrationThresholds {
  gridMs: number;            // default 3_600_000
  shapeSteps: number;        // default 3
  shapeGapGrowth: number;    // default 0.3 (decadi)
  shiftRatio: number;        // default 2 (provvisorio)
  paceRegression: number;    // default 0.1 (+10% per 3 run consecutive)
}
export const DEFAULT_THRESHOLDS: CalibrationThresholds;
```

**Interfacce prodotte (`orders.ts`):**

```ts
export function expandItems(shop: ShopEntry[]): OrderItem[]; // tutte le voci, livelli in ordine
export function isValidOrder(order: ShopOrder): boolean; // livello k+1 dopo k, ogni voce una volta
export function referenceOrder(shop: ShopEntry[], costOf: (item: OrderItem) => number): ShopOrder;
export function anticipate(order: ShopOrder, code: string): ShopOrder; // primo livello di `code` in testa
export function delay(order: ShopOrder, code: string): ShopOrder; // tutti i livelli di `code` in coda, ordine interno invariato
export function randomOrders(shop: ShopEntry[], count: number, seed: number): ShopOrder[]; // validi, distinti, PRNG con seme (mulberry32);
// al massimo min(count, ordini validi distinti), con un tetto ai tentativi (mai un loop)
```

`referenceOrder`: costo crescente, a parità l'ordine di `shop`; `costOf` lo fornisce il consumer
(The One: `engine.costToBuyNext` su un upgrade clonato con `bought = level − 1`).

- [ ] Test con `shop = [{code:"a",maxLevel:2},{code:"b",maxLevel:1},{code:"c",maxLevel:3}]`:
      `expandItems` dà 6 voci; `referenceOrder` con costi a1=1,a2=10,b1=3,c1=2,c2=4,c3=20 →
      `a1 c1 b1 c2 a2 c3`; `anticipate(ref,"b")` → `b1 a1 c1 c2 a2 c3`; `delay(ref,"a")` →
      `c1 b1 c2 c3 a1 a2`; `randomOrders(shop, 20, 42)` → 20 ordini validi e distinti, identici a
      una seconda chiamata con seme 42, diversi con seme 43; `isValidOrder` falso per `a2 a1 …`; shop `[{code:"x",maxLevel:1},{code:"y",maxLevel:1}]`
      con `count` 10 → al massimo 2 ordini, senza bloccarsi.
- [ ] Verifica che falliscano, implementa, verifica che passino.

### Task 3: policy della run e simulazione di un ordine

**File:**

- Crea: `.../calibration/run-policy.ts`, `.../calibration/simulate.ts`
- Test: `.../calibration/simulate.test.ts`

**Consuma:** Task 1 (`GameMove`, `moves`, `shouldStop`), Task 2 (tipi). Motore: `rateRulePrestige`
(`core/prestige-run.ts`), `upgradePurchaseBlock`, `isUnlocked`, `maxBuyableAmount`.

**Interfacce prodotte:**

```ts
export type CalibrationPrestigeRule = { kind: "rate"; minRunMs?: number; drop?: number } | { kind: "target"; minGain: number };
export interface RunPolicyOptions {
  visitMs: number; // default dichiarato dal consumer (The One: 120_000)
  prestigeCode: string;
  prestigeRule: CalibrationPrestigeRule;
  movePriority: string[]; // codici delle mosse, nell'ordine in cui si tentano
  producerCurrency: string; // i producer pagati in questa valuta si comprano a buy max, dal più alto aperto
}
export function createRunPolicy(opts: RunPolicyOptions, order: ShopOrder, moves: GameMove[]): BotPolicy;

export interface SimulateOrderInput {
  makeSim: () => { state: GameState; engine: Engine }; // stato ed engine NUOVI a ogni chiamata
  moves: (engine: Engine) => GameMove[];
  policy: RunPolicyOptions;
  job: OrderJob;
  horizonMs: number;
  milestones: number[];
  tickLengthMs: number;
  clickable?: ResolvedClickable;
}
export function simulateOrder(input: SimulateOrderInput): OrderResult;
```

Visita della policy, nell'ordine: (1) compra le voci dell'ordine finché la prossima non è
bloccata (`upgradePurchaseBlock` ≠ null → si ferma e risparmia); (2) prestigio se la regola lo
dice (`rate` = `rateRulePrestige`); in quel caso restituisce solo acquisti + prestigio; (3) mosse
pronte in `movePriority`; (4) buy max dei producer di `producerCurrency`, dal più alto aperto
(`isUnlocked`). Parametri dell'harness in `simulateOrder`: `decisionIntervalMs = policy.visitMs`,
`sampleIntervalMs = 60_000`; `visitMs` deve essere multiplo di 60 000 (altrimenti errore). Il
collector esteso non aggiunge lavoro per campione oltre alla lettura di `earned`.
`simulateOrder` ferma la simulazione (`shouldStop`) quando l'ordine è completo
e l'ultimo traguardo è raggiunto, o all'orizzonte. `blockedAt` = prossima voce non comprata a
fine simulazione se l'ordine non è completo. `gain` di una run = `earned` della valuta di
prestigio subito dopo il prestigio meno lo stesso valore al prestigio precedente (0 all'inizio);
lo si legge estendendo `MetricsCollector.onAction`. Traguardi: primo istante in cui `earned` ≥
valore (campioni + prestigi).

- [ ] Test su un gioco minuscolo (stile `tinyState` di `harness.test.ts`: un producer, un
      prestigio con valuta `prestige` che dichiara `gainMult: NR(1)` (canale del guadagno, come
      `content.ts:313` del gioco), due upgrade `u-mult` ×2 produzione e `u-gain` ×2 guadagno su
      `gainMult`):
      `simulateOrder` produce `runs` con `endMs` crescenti e `ratePerHour` > 0; i due ordini
      `u-mult,u-gain` e `u-gain,u-mult` danno `purchases` nell'ordine dato.
- [ ] Test `blocked`: una voce con costo irraggiungibile → `blockedAt` su quella voce, traguardi
      successivi `null`, nessuna eccezione.
- [ ] Test `isolation`: due `simulateOrder` di fila con lo stesso `makeSim` danno risultati
      identici (nessuno stato condiviso).
- [ ] Test `integer gain`: senza drip, ogni `RunRecord.gain` è intero e uguale al delta di
      `earned` (la regola `rate` legge il guadagno continuo, la consegna lo tronca: limite noto,
      dichiarato nel report del Task 6).
- [ ] Test `moves`: una mossa registrata e in `movePriority` viene eseguita quando pronta
      (compare in `report.actions`, verificabile tramite effetto sullo stato).
- [ ] Verifica che falliscano, implementa, verifica che passino.

### Task 4: analisi

**File:**

- Crea: `.../calibration/analyze.ts`
- Test: `.../calibration/analyze.test.ts`

**Consuma:** Task 2 (tipi).

**Interfacce prodotte:**

```ts
export interface Alarm {
  kind: "shape" | "shift" | "pace";
  orderId: string;
  milestone?: string; // per "shift"
  firstDivergence?: OrderItem; // per "shape": prima voce anticipata rispetto al riferimento
  detail: string; // frase in italiano con i numeri
}
export interface Sensitivity {
  code: string;
  milestoneDelta: Record<string, { anticipate: number | null; delay: number | null }>;
} // ms rispetto al riferimento
export interface CalibrationAnalysis {
  thresholds: CalibrationThresholds;
  results: OrderResult[];
  grid: number[]; // istanti della griglia
  median: (number | null)[]; // log10 tasso mediano per punto (solo origini reference/anticipate/delay/random)
  gaps: Record<string, (number | null)[]>; // per ordine: log10 tasso − mediana
  milestoneSummary: Record<string, { best: number | null; median: number | null; ratio: number | null }>;
  sensitivity: Sensitivity[];
  alarms: Alarm[];
}
export function analyzeCalibration(results: OrderResult[], milestones: number[], thresholds?: Partial<CalibrationThresholds>): CalibrationAnalysis;
```

Il riferimento è il risultato con `origin === "reference"`; se manca, `analyzeCalibration` lancia
un errore chiaro (test). Tasso in un punto della griglia = `ratePerHour` dell'ultima run conclusa entro quel punto
(`null` prima della prima run). Mediana per punto sui soli valori non `null`. `null` nei tempi ai
traguardi = +∞ per mediana e minimo; `ratio` = mediana/migliore, `null` se il migliore è `null`.
Allarmi come da spec (§5b e §6): forma, spostamento per traguardo, ritmo (durata di run che sale
oltre `paceRegression` per 3 run consecutive).

- [ ] Test con risultati sintetici (griglia 1 h, 6 h): tre ordini con tasso ×1, ×1,05, ×0,95
      costanti → nessun allarme di forma; un quarto il cui tasso raddoppia ogni ora rispetto agli
      altri → un allarme `shape` su di lui, con `firstDivergence` = sua prima voce diversa dal
      riferimento.
- [ ] Test spostamento: traguardo 10 a 2 h (migliore) contro mediana 5 h → `ratio` 2,5 e allarme
      con soglia 2; con mediana 3 h nessun allarme.
- [ ] Test censura: un ordine con tutti i traguardi `null` non abbassa la mediana; un ordine senza
      run → `gaps` tutto `null`, nessun `NaN` nell'oggetto.
- [ ] Test ritmo: durate di run 2, 2,3, 2,6, 3 h → allarme `pace`; 3, 2,5, 2, 1,8 h → nessuno.
- [ ] Verifica che falliscano, implementa, verifica che passino.

### Task 5: orchestratore e ricerca a fascio

**File:**

- Crea: `.../calibration/run-calibration.ts`
- Test: `.../calibration/run-calibration.test.ts`

**Consuma:** Task 2 (`orders.ts`, tipi), Task 4 (`analyzeCalibration`).

**Interfacce prodotte:**

```ts
export type OrderExecutor = (jobs: OrderJob[]) => Promise<OrderResult[]>;
export interface CalibrationPlan {
  shop: ShopEntry[];
  reference: ShopOrder; // calcolato dal consumer con referenceOrder
  milestones: number[];
  randomCount: number; // default 24
  seed: number;
  beamWidth: number; // 0 = niente ricerca a fascio; default 2
  maxJobs: number; // tetto complessivo ai job simulati (default 400), dichiarato nel report
  thresholds?: Partial<CalibrationThresholds>;
}
export async function runCalibration(plan: CalibrationPlan, execute: OrderExecutor): Promise<CalibrationAnalysis>;
```

Lotto 1: riferimento + anticipa/ritarda per ogni codice dello shop + casuali (id stabili:
`ref`, `ant:<code>`, `del:<code>`, `rnd:<n>`; duplicati dello stesso ordine simulati una volta).
Ricerca a fascio (se `beamWidth` > 0): prefissi di lunghezza crescente; ogni prefisso si
completa con le voci rimanenti nell'ordine del riferimento; punteggio = tempo all'ultimo
traguardo raggiunto dal riferimento (`null` = peggiore); si tengono i `beamWidth` migliori e,
separatamente, i peggiori; un lotto per livello; alla fine `beam-best` e `beam-worst`.

- [ ] Test con esecutore finto deterministico a costo additivo (tempo al traguardo =
      Σ posizione·peso del codice; con questa funzione anche un fascio di larghezza 1 trova
      l'ottimo): il lotto 1 contiene `ref`, `ant:*`, `del:*`, `rnd:*` con ordini validi; `beam-best` è
      l'ordine ottimo noto del finto, `beam-worst` il pessimo; due esecuzioni con lo stesso seme →
      `CalibrationAnalysis` identiche (`toEqual`); un esecutore che divide i lotti in 4 pezzi e li
      risolve in ordine sparso dà lo stesso risultato.
- [ ] Verifica che falliscano, implementa, verifica che passino.

### Task 6: report HTML

**File:**

- Crea: `.../calibration/report-html.ts`
- Test: `.../calibration/report-html.test.ts`

**Consuma:** Task 4 (`CalibrationAnalysis`).

**Interfacce prodotte:**

```ts
export function renderCalibrationHtml(analysis: CalibrationAnalysis, meta: { title: string; generatedAt: string; provenance?: Record<string, string> }): string;
```

Pagina autonoma in italiano: in testa soglie, parametri, `maxJobs` e il limite noto della regola
`rate` (decide sul guadagno continuo, la consegna è intera), ("provvisorio" accanto a `shiftRatio`) e
provenienza; grafico SVG log10(tasso) nel tempo, una polilinea per ordine, riferimento e mediana
evidenziati, legenda per origine; tabella allarmi; tabella tempi ai traguardi (migliore, mediano,
rapporto, censurati come "oltre l'orizzonte"); tabella di sensibilità per upgrade. Colori con
contrasto adeguato in tema chiaro; nessuna risorsa esterna.

- [ ] Test: con l'analisi del Task 4 (allarme di forma) l'HTML contiene `<svg`, il nome
      dell'ordine in allarme, "provvisorio", nessun `NaN`, nessun `http`; con un'analisi senza run
      l'HTML si genera e dice che nessun ordine ha prestigiato.
- [ ] Verifica che falliscano, implementa, verifica che passino.

### Task 7: esportazione, build e documentazione del motore

**File:**

- Crea: `.../calibration/index.ts`
- Modifica: `packages/engine/src/balance/index.ts` (`export * from "./calibration"`), `README.md`
  del motore (sezione breve "Calibrazione del negozio di prestigio" con l'esempio d'uso)

- [ ] `pnpm build` nel motore; `dist/balance/index.d.ts` espone `runCalibration`,
      `simulateOrder`, `renderCalibrationHtml`, `GameMove`.
- [ ] Gate del motore verdi (typecheck, lint, format, test).

### Task 8: uso da parte di The One

**File (repo del gioco):**

- Crea: `remix/app/balance/calibration/the-one.ts` — `THE_ONE_SHOP`, `theOneMoves(engine)`,
  `makeTheOneSim()`, `theOneCostOf`, `THE_ONE_CALIBRATION` (traguardi `[10, 100, 1000]`,
  orizzonte 60 h, visita 120 s, regola `rate`, tick 1000 ms, clickable `one` +1 ogni 1000 ms)
- Crea: `remix/app/balance/calibration/shard.run.ts` — eseguito da `vite-node`: legge i job da un
  file JSON, li simula con `simulateOrder`, scrive i risultati in un file JSON
- Crea: `remix/app/balance/calibration/calibrate.run.ts` — comando: costruisce il piano, esegue
  `runCalibration` con un esecutore che divide ogni lotto in N processi
  `vite-node -c vitest.config.mts shard.run.ts` (N = `CALIB_PROCS`, default core − 2), scrive
  `balance/reports/calibration/<data-ora>/{report.html,analysis.json}`
- Crea: `remix/app/balance/calibration/the-one.test.ts` (test veloce: orizzonte 2 h, un ordine)
- Modifica: `package.json` radice del gioco (script `calibrate`), `.gitignore`
  (`balance/reports/calibration/`)

`THE_ONE_SHOP` (scelta di Claude, modificabile): `if-headstart` 3, `if-gain` 3, `if-chain` 3,
`if-hairline` 5, `if-seep` 2 = 16 voci (Wall Memory e Cooler Heads esclusi: si sbloccano con i Decimal
Digits, dopo la Compression). Mosse: `sharpen:<eX>` per ogni eraser (via `sharpenPreview` /
`sharpen` di `run-rules.ts`) e `carry` (`carryPreview(...).ready` / `carryTheOne`), con priorità
Carry, poi Sharpening dal tier più alto. `run-rules.ts` usa il singleton `engine` solo per
`isUnlocked`, che dipende solo dallo stato (`engine.ts:387-389`): le mosse possono chiamare
`run-rules.ts` così com'è.

- [ ] Test `the-one.test.ts`: con orizzonte 2 h e l'ordine di riferimento, `simulateOrder` fa
      almeno un Carry (mossa in `report.actions` o `carries` > 0) e nessun prestigio.
- [ ] Prova reale: `pnpm calibrate` con i prezzi in working tree (Doubling Down 5, Chain of
      Command 6) e poi con quelli di `master` (2 e 3); report HTML aperto e controllato.
- [ ] Gate del gioco verdi.

## Esecuzione

Ordine e parallelismo: Task 1, 2, 4 in parallelo (file disgiunti) → Task 3 e 6 in parallelo →
Task 5 → Task 7 → Task 8. Critica del piano prima dell'implementazione, review indipendente alla
fine, gate dell'orchestratore dopo ogni fix.

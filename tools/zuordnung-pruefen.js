/* Zeigt, wie die Regeln den Ereignis-Log tatsaechlich einsortieren — pro Projekt, pro Regel,
 * mit Begruendung fuer jede Zeile.
 *
 * Wozu: eine falsche Zuordnung faellt im Panel nur auf, wenn man sie zufaellig sieht. Am
 * 2026-08-21 hing an Thorsten eine Woche Arbeit, die ihn nichts anging — die Regel
 * "Space AIPC" hatte 53 fremde Seiten eingesammelt. Hier steht so etwas in einer Zeile:
 * eine Regel mit auffallend vielen Treffern ist verdaechtig.
 *
 * Aufruf:
 *   node tools/zuordnung-pruefen.js                 Uebersicht: Projekte, Regeln, Ratequote
 *   node tools/zuordnung-pruefen.js fahrzeugfotos   alle Zeilen eines Projekts mit Grund
 *   node tools/zuordnung-pruefen.js --geraten       nur die geratenen Zeilen, neueste zuerst
 *   node tools/zuordnung-pruefen.js --tage 7        Zeitraum eingrenzen wie im Panel
 *
 * Liest nur. Aendert nichts.
 */
const P = require('../src/projects');
const { readEvents } = require('../src/store');

const argv = process.argv.slice(2);
const nurGeraten = argv.includes('--geraten');
const tageIdx = argv.indexOf('--tage');
const tage = tageIdx >= 0 ? Number(argv[tageIdx + 1]) : 0;
const ziel = argv.find((a) => !a.startsWith('--') && a !== String(tage)) || '';

const cfg = P.loadConfig();
const ov = P.loadOverrides();
const baum = P.loadBaum();
if (!cfg.ok) console.log('! ' + cfg.message);
if (!ov.ok) console.log('! ' + ov.message);
if (!baum.ok) console.log('! ' + baum.message);

let von = null;
if (tage > 0) {
  von = new Date();
  von.setHours(0, 0, 0, 0);
  von.setDate(von.getDate() - (tage - 1));
}

// Ohne Batch-Faltung: geprueft wird die Regel, und die greift pro Datei. Eine gefaltete
// Zeile "17 Dateien" wuerde 16 Zuordnungen verstecken.
const events = readEvents({ roh: true })
  .filter((e) => !von || new Date(e.ts) >= von);

const kurz = (s, n) => String(s == null ? '' : s).slice(0, n);
const zeit = (ts) => String(ts).slice(0, 16).replace('T', ' ');

function zeileZeigen(e, mitProjekt) {
  const marke = e.geraten ? '?' : ' ';
  const projekt = mitProjekt ? `${kurz(e.project, 18).padEnd(18)} ` : '';
  console.log(`  ${marke} ${zeit(e.ts)} ${projekt}${kurz(e.source, 10).padEnd(10)} `
    + `${kurz(e.grund, 42).padEnd(42)} ${kurz(e.title, 48)}`);
}

if (nurGeraten) {
  const g = events.filter((e) => e.geraten);
  console.log(`${g.length} von ${events.length} Zuordnungen sind geraten `
    + `(nur ein Wort im Titel oder der Space hat gepasst).`);
  console.log('Falsche davon im Panel auf das richtige Projekt ziehen, oder die Regel in '
    + 'data/projects.json schaerfen.\n');
  for (const e of g) zeileZeigen(e, true);
} else if (ziel) {
  const treffer = events.filter((e) => e.project === ziel);
  console.log(`${treffer.length} Zuordnungen zu "${ziel}"`
    + (von ? ` seit ${von.toISOString().slice(0, 10)}` : '') + ':\n');
  for (const e of treffer) zeileZeigen(e);
  const nachRegel = new Map();
  for (const e of treffer) nachRegel.set(e.grund, (nachRegel.get(e.grund) || 0) + 1);
  console.log('\n  Regeln, absteigend:');
  for (const [g, n] of [...nachRegel].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${g}`);
  }
} else {
  const proProjekt = new Map();
  for (const e of events) {
    if (!proProjekt.has(e.project)) proProjekt.set(e.project, { n: 0, geraten: 0, regeln: new Map() });
    const z = proProjekt.get(e.project);
    z.n += 1;
    if (e.geraten) z.geraten += 1;
    z.regeln.set(e.grund, (z.regeln.get(e.grund) || 0) + 1);
  }
  console.log(`${events.length} Ereignisse`
    + (von ? ` seit ${von.toISOString().slice(0, 10)}` : ' (ganzer Log)')
    + `, ${ov.count || 0} Handzuordnungen, ${baum.count || 0} Confluence-Seiten mit Ahnenkette.\n`);
  for (const [id, z] of [...proProjekt].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(z.n).padStart(5)}  ${id}`
      + (z.geraten ? `   davon ${z.geraten} geraten` : ''));
    for (const [g, n] of [...z.regeln].sort((a, b) => b[1] - a[1])) {
      console.log(`         ${String(n).padStart(4)}  ${g}`);
    }
  }
  console.log('\nEine Regel mit auffallend vielen Treffern lohnt einen Blick:');
  console.log('  node tools/zuordnung-pruefen.js <projekt-id>');
}

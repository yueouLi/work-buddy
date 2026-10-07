const fs = require('fs');
const path = require('path');
const { projectInfo, sachKey } = require('./projects');

const DATA_FILE = path.join(__dirname, '..', 'data', 'events.jsonl');

// teams bleibt in der Liste, obwohl der Kollektor nicht mehr laeuft: die alten Ereignisse
// stehen im Log und sollen in der Zaehlung nicht verschwinden. Siehe collectors/index.js.
const SOURCES = ['obsidian', 'confluence', 'github', 'outlook', 'arbeit', 'html', 'teams'];

/* roh = ohne Batch-Faltung. Der Bestand braucht das: eine gefaltete Zeile "17 Dateien"
   ist ein Ereignis, kein Ding. Wer daraus Bestand baut, bekommt einen Eintrag namens
   "17 Dateien" und verliert die 17 echten. */
function readEvents(opts = {}) {
  if (!fs.existsSync(DATA_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(DATA_FILE, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (e && e.ts && e.source) out.push(normalize(e));
    } catch {
      // beschaedigte Zeile ueberspringen, nicht den ganzen Log verlieren
    }
  }
  out.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return opts.roh ? out : collapseBatches(out);
}

// Sieben Dateien im Vault heissen README.md, dazu _MOC und index. Ein Verlauf mit
// mehreren Zeilen "README" ist unlesbar, also Ordnername davor. Passiert beim Lesen,
// damit auch die vom Seed-Lauf geschriebenen Events davon profitieren.
const GENERIC_TITLES = new Set(['readme', '_moc', 'index', 'moc']);

const VAULT_DIR = path.join(
  require('os').homedir(), 'OneDrive - Allianz', 'Dokumente', 'Obsidian Vault',
);

// Der Seed-Lauf hat obsidian://open?vault=…&file=… mit URLSearchParams gebaut. Das
// kodiert Leerzeichen als "+", Obsidian liest das woertlich und meldet
// "Vault not found". Beim Lesen auf die Pfad-Form umschreiben, damit die Alt-Events
// klickbar bleiben, ohne die Log-Datei umzuschreiben.
function repairUrl(e) {
  if (e.source !== 'obsidian') return e.url;
  if (!e.url || !e.url.includes('vault=')) return e.url;
  const q = new URLSearchParams(e.url.slice(e.url.indexOf('?') + 1));
  const file = q.get('file');
  if (!file) return e.url;
  return 'obsidian://open?path=' + encodeURIComponent(path.join(VAULT_DIR, file + '.md'));
}

function normalize(e) {
  const out = { ...e, url: repairUrl(e) };
  if (out.source === 'obsidian' && GENERIC_TITLES.has(String(out.title).toLowerCase())) {
    const seg = String(out.detail || '').split('/').filter(Boolean).pop();
    if (seg) out.title = `${seg} / ${out.title}`;
  }
  /* Projekt wird beim Lesen bestimmt, nicht beim Schreiben: dann wirkt eine geaenderte
     Regel sofort auf den ganzen Bestand, ohne den Log anzufassen. Nach der Titel-Reparatur,
     damit Schlagworte auch den vorangestellten Ordnernamen sehen.

     Ein Aufruf, drei Werte: Projekt, Begruendung und ob geraten wurde. Vorher liefen hier
     projectOf() und isFixed() getrennt, beide mit eigener Regelpruefung — jetzt kann die
     Begruendung nicht von der Zuordnung abweichen, die sie erklaert. */
  const info = projectInfo(out);
  out.project = info.id;
  out.grund = info.text;
  // Geraten heisst: es hat nur ein Wort im Titel oder der Space gepasst. Das Panel markiert
  // solche Zeilen, denn nur eine sichtbare Vermutung ist eine korrigierbare Vermutung.
  out.geraten = info.geraten;
  // Wiederverwendbares Material innerhalb eines Projekts (z.B. die Baukasten-Vorlagen
  // unter "Confluence Report") — bleibt im Projekt, bekommt nur ein Etikett. Anders als
  // geraten: hier ist die Zuordnung sicher, nur die Art der Arbeit ist eine andere.
  out.infra = Boolean(info.infra);
  // Von Hand zugeordnet: im Verlauf sichtbar machen, damit erkennbar ist, was Regel und
  // was Entscheidung ist.
  if (info.regel === 'hand') out.fixed = true;
  /* Der Schluessel des Dings, an dem dieses Ereignis passiert ist. Er kommt aus derselben
     Funktion wie Handzuordnung und Bestand und wird hier einmal berechnet, statt im
     Renderer ein zweites Mal. Vorher gab es dort ein eigenes fileKeyOf() mit anderen
     Praefixen ("o|", "c|") — zwei Begriffe von "dieselbe Datei", die stillschweigend
     auseinanderlaufen konnten. Jetzt kann eine Zeile im Verlauf und dieselbe Zeile im
     Bestand nicht mehr verschiedene Sterne haben. */
  out.sache = sachKey(out);
  return out;
}

// Massen-Importe (Skripte, Sync-Laeufe) erzeugen dutzende Events in derselben Sekunde
// und wuerden die Skala und die Tageszahlen dominieren. Sie werden zu einem Eintrag gebuendelt.
const BATCH_WINDOW_MS = 90 * 1000;
const BATCH_MIN = 5;

function collapseBatches(events) {
  const groups = new Map();
  for (const e of events) {
    // Projekt gehoert in den Schluessel: sonst buendelt ein Massen-Import Dateien aus
    // zwei Projekten in eine Zeile, und die Zeile faellt beim Projektfilter aus dem Raster.
    const key = `${e.source}|${e.action}|${e.detail || ''}|${e.project || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = [];
  for (const items of groups.values()) {
    items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (run.length < BATCH_MIN) {
        out.push(...run);
      } else {
        const first = run[0];
        out.push({
          ...first,
          title: `${run.length} Dateien`,
          batch: run.length,
          fixed: run.every((x) => x.fixed),
          // Wie bei fixed: die gefaltete Zeile darf nur behaupten, was fuer alle Zeilen
          // darin gilt. Sonst traegt ein Buendel aus 17 sicheren und einer geratenen Datei
          // entweder eine falsche Warnung oder verschweigt eine.
          geraten: run.every((x) => x.geraten),
          infra: run.every((x) => x.infra),
          batchTitles: run.slice(0, 8).map((x) => x.title),
        });
      }
      run = [];
    };
    for (const e of items) {
      if (!run.length) { run = [e]; continue; }
      const gap = new Date(run[run.length - 1].ts) - new Date(e.ts);
      if (gap <= BATCH_WINDOW_MS) run.push(e);
      else { flush(); run = [e]; }
    }
    flush();
  }

  out.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return out;
}

function appendEvent(evt) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.appendFileSync(DATA_FILE, JSON.stringify(evt) + '\n', 'utf8');
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function summarize(events) {
  const bySource = {};
  for (const s of SOURCES) bySource[s] = 0;
  const byDay = {};
  const byHour = new Array(24).fill(0);
  const today = dayKey(Date.now());
  let todayCount = 0;

  for (const e of events) {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    const k = dayKey(e.ts);
    if (!byDay[k]) byDay[k] = { total: 0 };
    byDay[k].total += 1;
    byDay[k][e.source] = (byDay[k][e.source] || 0) + 1;
    byHour[new Date(e.ts).getHours()] += 1;
    if (k === today) todayCount += 1;
  }

  const days = Object.keys(byDay).sort();

  // Streak zaehlt zusammenhaengende aktive Tage rueckwaerts. Ist heute noch nichts
  // passiert (z.B. kurz nach Mitternacht), beginnt die Zaehlung bei gestern —
  // sonst faellt die Serie jede Nacht auf 0.
  let streak = 0;
  const cur = new Date();
  if (!byDay[dayKey(cur)]) cur.setDate(cur.getDate() - 1);
  while (byDay[dayKey(cur)]) {
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }

  const peakHour = byHour.indexOf(Math.max(...byHour));

  return {
    total: events.length,
    today: todayCount,
    bySource,
    byDay,
    byHour,
    days,
    streak,
    peakHour: events.length ? peakHour : null,
    latest: events.length ? events[0].ts : null,
  };
}

module.exports = { DATA_FILE, SOURCES, readEvents, appendEvent, summarize, dayKey, collapseBatches };

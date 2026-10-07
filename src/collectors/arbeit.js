const fs = require('fs');
const os = require('os');
const path = require('path');
const { emit } = require('./emit');
const { DATA_FILE } = require('../store');

/* ── Arbeitsordner ──
   Die sechste Quelle schliesst die groesste Luecke im Panel: die eigentliche Arbeit.
   Obsidian zeigt Notizen, Confluence Seiten, Outlook Post, HTML einzelne Artefakte. Was
   dazwischen entsteht — Analysen, Skripte, Decks, Berichte in einem Projektordner unter
   `Dokumente\Claude` — war unsichtbar. Genau deshalb war baukasten-slide-confluence im
   Panel nicht zu finden: der Ordner enthaelt keine einzige HTML-Datei, sondern Markdown,
   PowerPoint, SVG und Python. Der HTML-Kollektor konnte ihn nie sehen.

   Warum diese Wurzel: `Dokumente\Claude` ist laut CLAUDE.md der Ablageort fuer alles, was
   hier gebaut wird. Ein Ordner mehr heisst eine Zeile mehr in ROOTS, nicht ein neuer
   Kollektor.

   Abgrenzung zu den anderen Quellen — jede Datei gehoert genau einer:
   - HTML bleibt beim HTML-Kollektor. Sonst haette dasselbe Deck zwei Zeilen mit zwei
     Bewertungen, und die Ablage waere nicht mehr die eine Adresse fuer "wo liegt das HTML".
   - Der Obsidian-Vault liegt daneben, nicht darunter, und hat seinen eigenen Kollektor. */

const HOME = os.homedir();

const ROOTS = [
  { label: 'Claude', dir: path.join(HOME, 'OneDrive - Allianz', 'Dokumente', 'Claude') },
];

/* ── Was zaehlt als Arbeit ──
   Weisse Liste, keine schwarze. baukasten-slide-confluence besteht aus 159 Dateien, davon
   sind 138 aus Folien extrahierte Bilder (svg, png, emf, wmf, jpeg). Die sind Bestandteil
   eines Artefakts, nicht selbst eines: 138 Zeilen "eine Grafik wurde geschrieben" sagen
   nichts, verdecken aber die 10 Analysen daneben. Gezaehlt wird, was man oeffnet, um darin
   zu lesen oder es auszufuehren.

   .json fehlt bewusst: der Zustand dieses Panels selbst liegt in JSON und aendert sich bei
   jedem Poll — das waere eine Quelle, die sich selbst beobachtet. */
const EXT = [
  '.md', '.txt', '.pptx', '.docx', '.xlsx', '.pdf', '.csv',
  '.py', '.js', '.ps1', '.sh', '.bat', '.ipynb', '.zip',
];

/* Ordner, die keine Arbeit enthalten. `data` steht hier aus einem harten Grund: dort liegt
   events.jsonl. Ohne die Zeile wuerde jedes geschriebene Ereignis ein neues Ereignis
   erzeugen — eine Rueckkopplung, die den Log in Minuten flutet. */
const SKIP_DIR = new Set([
  'node_modules', '.git', '__pycache__', 'site-packages', '.venv', 'venv',
  'dist', 'build', 'coverage', '.next', 'data', 'attachments', '_Papierkorb',
  // 27992 Dateien Spiegel eines fremden Datensatzes, keine eigene Arbeit.
  'second-brain',
  /* Mail-Archiv des outlook-context Skills: pro Kontakt raw/ und knowledge/, 169 Dateien
     allein im 30-Tage-Fenster, zwei Massen-Exporte am 30.07. und 18.08. Inhaltlich ist das
     Post — und Post hat seit heute eine eigene Quelle, die sie am Original liest. Zwei
     Zeilen fuer dieselbe Mail waeren einmal zu viel. */
  'outlook-to-context',
]);

function skipDir(name) {
  if (SKIP_DIR.has(name)) return true;
  if (name.startsWith('_') || name.startsWith('.')) return true;
  if (/-(main|master)$/.test(name)) return true;
  return false;
}

// Sicherungskopien sind Absicht, aber nicht Arbeit — dieselbe Begruendung wie im
// HTML-Kollektor: zwei Zeilen nebeneinander stellen jedes Mal die Frage, welche gilt.
const BACKUP = /\.BACKUP-\d{4}-\d{2}-\d{2}/i;

function tracked(name) {
  if (BACKUP.test(name)) return false;
  return EXT.includes(path.extname(name).toLowerCase());
}

/* Fenster: kuerzer als bei HTML (90 Tage). Diese Quelle beantwortet "woran wurde
   gearbeitet", nicht "wo liegt etwas" — dafuer ist ein Monat die brauchbare Spanne. Wer
   ein altes Artefakt sucht, sucht es in der Ablage, und die scannt ohne Fenster. */
const SCAN_DAYS = 30;
const SCAN_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const COOLDOWN_MS = 5 * 60 * 1000;
// Wie in obsidian.js und html.js: OneDrive loest fs.watch auch beim reinen Anfassen aus,
// die mtime bleibt dann alt. Dokumente\Claude liegt in OneDrive.
const STALE_MS = 10 * 60 * 1000;

const PATHS_FILE = path.join(path.dirname(DATA_FILE), 'arbeit-paths.json');

const timers = new Map();
const lastEmit = new Map();

let known = new Set();
let knownLoaded = false;

function loadPaths() {
  try {
    known = new Set(JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8')));
    knownLoaded = true;
  } catch {
    known = new Set();
    knownLoaded = false;
  }
}

let saveTimer = null;
function savePaths() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(PATHS_FILE), { recursive: true });
    fs.writeFileSync(PATHS_FILE, JSON.stringify([...known]), 'utf8');
  }, 1500);
}

function keyOfPath(abs) {
  return abs.replace(/\\/g, '/').toLowerCase();
}

// birthtime ist unter Windows unbrauchbar, also entscheidet "war dieser Pfad schon mal da"
// ueber created vs. updated. Erster Lauf inventarisiert nur.
function actionFor(abs) {
  const k = keyOfPath(abs);
  const fresh = knownLoaded && !known.has(k);
  if (!known.has(k)) { known.add(k); savePaths(); }
  return fresh ? 'created' : 'updated';
}

/* ── Projektordner ──
   Die erste Ebene unter der Wurzel ist die Einheit, in der hier gedacht wird: ein Auftrag,
   ein Ordner. Alles darunter rollt darauf hoch, damit "baukasten-slide-confluence" die
   Zeile beschriftet und nicht "analyse". Dateien direkt in der Wurzel haben keinen
   Projektordner — sie bekommen den Ort statt eines erfundenen Namens. */
function projektVon(root, abs) {
  const rel = path.relative(root.dir, abs).replace(/\\/g, '/');
  const teile = rel.split('/');
  if (teile.length < 2) return { name: `${root.label} (direkt)`, dir: root.dir, unter: '' };
  return {
    name: teile[0],
    dir: path.join(root.dir, teile[0]),
    unter: teile.slice(1, -1).join('/'),
  };
}

function build(abs, st, action, root, extra = {}) {
  const p = projektVon(root, abs);
  return {
    ts: new Date(st.mtimeMs).toISOString(),
    source: 'arbeit',
    action,
    // Mit Endung: README.md und README.py sind zwei Dinge, und die Endung sagt hier mehr
    // ueber die Datei als bei einer Vault-Notiz, wo alles .md ist.
    title: path.basename(abs),
    detail: p.unter ? `${p.name} / ${p.unter}` : p.name,
    // Kein url-Feld: eine lokale Datei ist kein Link. Der Pfad steht in meta.path, das
    // Panel oeffnet ihn ueber open:file — dieselbe Entscheidung wie im HTML-Kollektor.
    url: '',
    meta: {
      kb: Math.round((st.size / 1024) * 10) / 10,
      path: abs,
      projekt: p.name,
      // Fuer die Handzuordnung "ganzer Ordner": der Projektordner, nicht das
      // Unterverzeichnis. Wer eine Analyse auf ein Projekt zieht, meint den Auftrag.
      projektPfad: keyOfPath(p.dir),
      dedupe: `arbeit|${keyOfPath(abs)}|${Math.floor(st.mtimeMs / 1000)}`,
      ...extra,
    },
  };
}

/* ── Live-Zweig ── */
function handleChange(abs, root) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return;
  }
  if (!st.isFile()) return;

  const now = Date.now();
  if (now - st.mtimeMs > STALE_MS) {
    const k = keyOfPath(abs);
    if (!known.has(k)) { known.add(k); savePaths(); }
    return;
  }

  const prev = lastEmit.get(abs);
  if (prev && now - prev < COOLDOWN_MS) return;
  lastEmit.set(abs, now);

  emit(build(abs, st, actionFor(abs), root, { live: true }));
}

/* ── Nachlauf-Scan ── */
function scan(log) {
  const cut = Date.now() - SCAN_DAYS * 86400_000;
  const first = !knownLoaded;
  let neu = 0;
  let gesehen = 0;
  let alt = 0;
  let uebergangen = 0;

  const walk = (dir, root) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!skipDir(ent.name)) walk(abs, root);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!tracked(ent.name)) { uebergangen += 1; continue; }
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      // Inventar deckt alles ab, Events nur das Fenster — sonst gilt eine alte Datei
      // beim naechsten Anfassen faelschlich als neu angelegt.
      const action = actionFor(abs);
      if (st.mtimeMs < cut) { alt += 1; continue; }
      gesehen += 1;
      if (emit(build(abs, st, action, root, { scan: true }))) neu += 1;
    }
  };

  for (const root of ROOTS) {
    if (fs.existsSync(root.dir)) walk(root.dir, root);
  }

  if (first) knownLoaded = true;
  log(`arbeit: Scan ${gesehen} Dateien der letzten ${SCAN_DAYS} Tage, ${neu} neu`
    + ` (${uebergangen} nicht mitgezaehlt: Bilder, JSON, HTML, Sicherungen; ${alt} aelter als das Fenster)`
    + (first ? ` — Erstlauf, ${known.size} Pfade inventarisiert` : ''));
}

function start(log) {
  loadPaths();
  scan(log);

  const watchers = [];
  for (const root of ROOTS) {
    if (!fs.existsSync(root.dir)) {
      // Bewusst nicht "nicht gefunden": index.js stuft Logzeilen mit diesem Wortlaut als
      // Fehler ein. Ein fehlender Ordner ist hier kein Defekt.
      log(`arbeit: ${root.label} existiert nicht — uebersprungen`);
      continue;
    }
    try {
      const w = fs.watch(root.dir, { recursive: true }, (_ev, rel) => {
        if (!rel || !tracked(rel)) return;
        if (rel.split(/[\\/]/).slice(0, -1).some(skipDir)) return;
        const abs = path.join(root.dir, rel);
        clearTimeout(timers.get(abs));
        timers.set(abs, setTimeout(() => {
          timers.delete(abs);
          handleChange(abs, root);
        }, DEBOUNCE_MS));
      });
      w.on('error', (e) => log(`arbeit watch error (${root.label}): ${e.message}`));
      watchers.push(w);
    } catch (e) {
      log(`arbeit: ${root.label} nicht beobachtbar — ${e.message}`);
    }
  }

  const t = setInterval(() => {
    try { scan(log); } catch (e) { log('arbeit scan failed: ' + e.message); }
  }, SCAN_MS);

  log(`arbeit: live watch auf ${watchers.length} Ort(en) + Scan alle 10 min`);
  return () => { watchers.forEach((w) => w.close()); clearInterval(t); };
}

module.exports = { start, scan, ROOTS, EXT, tracked, skipDir, projektVon, PATHS_FILE };

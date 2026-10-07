const fs = require('fs');
const os = require('os');
const path = require('path');
const { emit } = require('./emit');
const { DATA_FILE } = require('../store');

/* ── HTML-Artefakte ──
   Die vierte Quelle beantwortet eine andere Frage als die anderen drei. Obsidian,
   Confluence und GitHub zeigen Taetigkeit. Hier geht es um Auffindbarkeit: Decks,
   Anleitungen, Prototypen und Berichte entstehen als einzelne HTML-Dateien und landen
   dort, wo sie gerade gebraucht wurden — Desktop, Projektordner, C:\tmp. Danach sind sie
   weg, weil niemand weiss, wie der Ordner hiess.

   Der Unterschied zu den anderen Kollektoren: ein Extension-Filter reicht nicht.
   Von 461 rohen Treffern (mit entpackten Repos) sind rund 90 Artefakte. Der Rest ist Werkzeugmuell —
   Such-Dumps (`s_bing_*`, `pg_*`), Messhilfen (`crop.html`, `dim.html`), Mutationstests,
   entpackte Repos und App-Quelltext. Ohne Klassifikation waere der Verlauf unlesbar und
   die Zahl auf der Karte gelogen. Was aussortiert wird, steht im Log — nicht stillschweigend. */

const HOME = os.homedir();

/* ── Welche Orte (Stand 2026-08-20, nachgemessen) ──
   Vier Roots waren zu wenig. Ein Vollscan ueber das Benutzerprofil und C:\tmp findet 206
   HTML-Dateien, davon lagen 158 ausserhalb der vier Orte — darunter genau die, die von Hand
   geoeffnet werden: die Block- und Vorlagengalerien des allianz-ppt Skills und die
   Design-Handoffs unter ~/dev.

   Warum eine Liste und nicht "alles unter ~": das Profil enthaelt drei fremde Programmbaeume
   mit HTML, die nie gesucht werden — VisualEditor/demos (28 Dateien), pixel-agents (4),
   repos/helloworld (1) — dazu Fremdmaterial, das per Regel schon draussen bleibt:
   NOTICE.html je VS-Code-Extension (3), .claude/plugins (5), .claude/backups (16, Kopien
   des Skills) und markitdown-main/tests (3, faellt unter die -main-Regel). Eine Whitelist
   sagt, was gemeint ist; eine Blacklist muesste jedes neu installierte Werkzeug nachtragen.

   fluechtig = Ort, an dem eine Datei verloren geht. Das ist der eigentliche Hinweis, den
   die Quelle liefert: nicht "es gibt diese Datei", sondern "sie liegt am falschen Platz". */
const ROOTS = [
  { label: 'Desktop', dir: path.join(HOME, 'OneDrive - Allianz', 'Desktop') },
  { label: 'Dokumente', dir: path.join(HOME, 'OneDrive - Allianz', 'Dokumente') },
  { label: 'Downloads', dir: path.join(HOME, 'Downloads'), fluechtig: true },
  // Literal statt path.join: path.join('C:', 'tmp') ergibt den laufwerksrelativen Pfad
  // "C:tmp", der auf das aktuelle Verzeichnis von C: zeigt — nicht auf die Wurzel.
  { label: 'C:\\tmp', dir: 'C:\\tmp', fluechtig: true },
  // Eigene Skills: Galerien und Beispiel-Decks von allianz-ppt. Kein Programmcode, sondern
  // Anschauungsmaterial, das genau dann gebraucht wird, wenn ein Deck entsteht.
  { label: 'Skills', dir: path.join(HOME, '.claude', 'skills') },
  // Fremde Vorlagenbibliothek (html-ppt, ~60 Dateien vom April). Eigener Root und eigenes
  // Etikett, damit sie eine eigene Schublade bildet und die anderen nicht zuschuettet.
  // Soll sie ganz raus, ist es diese eine Zeile.
  { label: 'Skill-Vorlagen', dir: path.join(HOME, '.agents', 'skills') },
  { label: 'dev', dir: path.join(HOME, 'dev') },
  // Die lokalen Zwillinge der OneDrive-Ordner. Aktuell ohne HTML, aber genau dort landet
  // eine Datei, wenn OneDrive einmal nicht mitspielt.
  { label: 'Desktop (lokal)', dir: path.join(HOME, 'Desktop') },
  { label: 'Dokumente (lokal)', dir: path.join(HOME, 'Documents') },
];

// .xhtml gehoert dazu: Confluence-Exporte kommen so heraus (Marwin_Anforderungen.xhtml).
// Der Bestand in library.js liest diese Liste, damit Kachelzahl und Ablage dieselbe Menge
// zaehlen — zwei Endungslisten waeren zwei Wahrheiten.
const EXT = ['.html', '.htm', '.xhtml'];

/* Ordner, die nie ein Artefakt enthalten:
   - Abhaengigkeiten und Build-Ausgaben (node_modules, dist, build, site-packages)
   - Quelltext laufender Anwendungen (src) — work-buddy/src/index.html ist Programm, nicht Ergebnis
   - eingebundene Fremdmaterialien: GitHub-ZIPs entpacken nach <repo>-main/<repo>-master.
     Allein die vier LDS-Kopien in C:\tmp machen 216 Dateien aus.
   - Ordner mit _ am Anfang sind in diesem Setup durchweg Wegwerf (_mutationstest, _test) */
const SKIP_DIR = new Set([
  'node_modules', '.git', '.obsidian', '.smart-env', '.trash', '__pycache__',
  'site-packages', '.venv', 'venv', 'dist', 'build', 'src', 'assets', 'static',
  '.next', 'coverage', '_Papierkorb',
]);

function skipDir(name) {
  if (SKIP_DIR.has(name)) return true;
  if (name.startsWith('_') || name.startsWith('.')) return true;
  if (/-(main|master)$/.test(name)) return true;
  if (/\.dist-info$/.test(name)) return true;
  return false;
}

/* Dateinamen, die Werkzeugausgabe verraten. Praefixe stammen aus eigenen Skripten:
   s_ = Suchergebnisseite, pg_ = geladene Seite, re_ = Recherche-Treffer. */
const NOISE_PREFIX = ['s_', 'pg_', 're_', 'measure', 'crop', 'mutation_', 'bericht_perfekt', 'bericht_realistisch'];
const NOISE_EXACT = new Set(['dim', 'hist', 'page', 'test', 'tmp', 'out', 'temp', 'x', 'a']);
// Ein Buchstabe plus hoechstens zwei Ziffern: m2, m3, m4, s1 — Wegwerfnamen beim Probieren.
const NOISE_SHORT = /^[a-z]\d{0,2}$/i;
// Reine Hex-Namen sind Cache- oder Hash-Ausgaben, nie von Hand benannt.
const NOISE_HASH = /^[0-9a-f]{8,}$/i;

/* Eigene Sicherungskopien: block-catalog.BACKUP-2026-06-03.html, index.BACKUP-…html.
   Die Sicherung ist Absicht (harte Regel im Vault), aber sie ist nicht das Artefakt. Beide
   Zeilen nebeneinander im Bestand hiessen jedes Mal die Frage "welche ist die aktuelle". */
const NOISE_BACKUP = /\.BACKUP-\d{4}-\d{2}-\d{2}/i;

function noise(stem) {
  const s = stem.toLowerCase();
  if (NOISE_BACKUP.test(stem)) return true;
  if (NOISE_EXACT.has(s) || NOISE_SHORT.test(s) || NOISE_HASH.test(s)) return true;
  return NOISE_PREFIX.some((p) => s.startsWith(p));
}

function tracked(name) {
  if (!EXT.includes(path.extname(name).toLowerCase())) return false;
  return !noise(path.basename(name, path.extname(name)));
}

/* ── Fenster ──
   Weiter zurueck als bei Obsidian (14 Tage). Vault-Notizen sind Taetigkeit, die alt werden
   darf; ein Deck von vor zwei Monaten ist dagegen genau das, was gesucht wird. 90 Tage
   machen aus dem Verlauf ein brauchbares Verzeichnis, ohne ihn zu fluten. */
const SCAN_DAYS = 90;
const SCAN_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const COOLDOWN_MS = 5 * 60 * 1000;
// Gleiche Begruendung wie in obsidian.js: OneDrive loest fs.watch auch beim reinen
// Anfassen aus, die mtime bleibt dann alt. Desktop und Dokumente liegen in OneDrive.
const STALE_MS = 10 * 60 * 1000;

const PATHS_FILE = path.join(path.dirname(DATA_FILE), 'html-paths.json');

const timers = new Map();
const lastEmit = new Map();

/* ── Pfad-Gedaechtnis ──
   Wie bei Obsidian: birthtime ist unter Windows unbrauchbar, also entscheidet die Frage
   "war dieser Pfad schon mal da" ueber created vs. updated. Erster Lauf inventarisiert
   nur, sonst waere jede vorhandene Datei ploetzlich "neu". */
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

// Schluessel kleingeschrieben: Windows-Pfade sind case-insensitiv, dieselbe Datei darf
// nicht zweimal als "neu" gelten, nur weil ein Aufruf C:\TMP statt C:\tmp geliefert hat.
function keyOfPath(abs) {
  return abs.replace(/\\/g, '/').toLowerCase();
}

function actionFor(abs) {
  const k = keyOfPath(abs);
  const fresh = knownLoaded && !known.has(k);
  if (!known.has(k)) { known.add(k); savePaths(); }
  return fresh ? 'created' : 'updated';
}

/* ── Anzeige ──
   index.html gibt es dutzendfach. Der Ordner ist hier der eigentliche Name des Artefakts:
   "confluence-deck-erklaert" sagt etwas, "index" nicht. */
const GENERIC = new Set([
  'index', 'index-cn', 'index-de', 'main', 'start', 'home',
  'viewer', 'toc', 'search', 'longread', 'report', 'bericht', 'default',
]);

function titleFor(abs) {
  const stem = path.basename(abs, path.extname(abs));
  if (!GENERIC.has(stem.toLowerCase())) return stem;
  const parent = path.basename(path.dirname(abs));
  return parent ? `${parent} / ${stem}` : stem;
}

function rootOf(abs) {
  // Laengster Treffer gewinnt: C:\tmp und Dokumente ueberschneiden sich nicht, aber
  // sobald ein Root unter einem anderen liegt, waere die Reihenfolge sonst Zufall.
  let best = null;
  for (const r of ROOTS) {
    const rel = path.relative(r.dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!best || r.dir.length > best.dir.length) best = r;
  }
  return best;
}

function build(abs, st, action, root, extra = {}) {
  const relDir = path.relative(root.dir, path.dirname(abs)).replace(/\\/g, '/');
  return {
    ts: new Date(st.mtimeMs).toISOString(),
    source: 'html',
    action,
    title: titleFor(abs),
    detail: relDir ? `${root.label} / ${relDir}` : root.label,
    // Kein url-Feld: eine lokale Datei ist kein Link. Der Pfad steht in meta.path, das
    // Panel oeffnet ihn ueber open:file. Der URL-Kanal bleibt damit auf https/obsidian
    // beschraenkt und muss nicht fuer file:// aufgeweicht werden.
    url: '',
    meta: {
      kb: Math.round((st.size / 1024) * 10) / 10,
      path: abs,
      ort: root.label,
      // Der eigentliche Mehrwert dieser Quelle: markieren, was an einem Ort liegt, an dem
      // es nicht bleiben sollte. C:\tmp und Downloads werden aufgeraeumt oder vergessen.
      ...(root.fluechtig ? { fluechtig: true } : {}),
      dedupe: `html|${keyOfPath(abs)}|${Math.floor(st.mtimeMs / 1000)}`,
      ...extra,
    },
  };
}

/* ── Live-Zweig ── */
function handleChange(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return;
  }
  if (!st.isFile()) return;

  const root = rootOf(abs);
  if (!root) return;

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
  let aussortiert = 0;

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
      if (!EXT.includes(path.extname(ent.name).toLowerCase())) continue;
      if (noise(path.basename(ent.name, path.extname(ent.name)))) { aussortiert += 1; continue; }
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
  log(`html: Scan ${gesehen} Artefakte der letzten ${SCAN_DAYS} Tage, ${neu} neu`
    + ` (${aussortiert} als Werkzeugausgabe aussortiert, ${alt} aelter als das Fenster)`
    + (first ? ` — Erstlauf, ${known.size} Pfade inventarisiert` : ''));
}

function start(log) {
  loadPaths();
  scan(log);

  const watchers = [];
  for (const root of ROOTS) {
    if (!fs.existsSync(root.dir)) {
      // Bewusst nicht "nicht gefunden": index.js stuft Logzeilen mit diesem Wortlaut als
      // Fehler ein. Ein fehlender Ordner ist hier aber normal, kein Defekt.
      log(`html: ${root.label} existiert nicht — uebersprungen`);
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
          handleChange(abs);
        }, DEBOUNCE_MS));
      });
      w.on('error', (e) => log(`html watch error (${root.label}): ${e.message}`));
      watchers.push(w);
    } catch (e) {
      log(`html: ${root.label} nicht beobachtbar — ${e.message}`);
    }
  }

  const t = setInterval(() => {
    try { scan(log); } catch (e) { log('html scan failed: ' + e.message); }
  }, SCAN_MS);

  log(`html: live watch auf ${watchers.length} Orten + Scan alle 10 min`);
  return () => { watchers.forEach((w) => w.close()); clearInterval(t); };
}

module.exports = { start, scan, ROOTS, EXT, titleFor, noise, skipDir, PATHS_FILE };

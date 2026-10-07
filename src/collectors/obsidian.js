const fs = require('fs');
const os = require('os');
const path = require('path');
const { emit } = require('./emit');
const { DATA_FILE } = require('../store');
const bus = require('./bus');

const VAULT = path.join(os.homedir(), 'OneDrive - Allianz', 'Dokumente', 'Obsidian Vault');
const SKIP = ['.git', '.obsidian', '.trash', 'node_modules', '.smart-env', '.space'];
const EXT = ['.md', '.canvas', '.base'];

// Speichern loest mehrere fs-Events aus (Editor, OneDrive-Sync). Erst nach Ruhe schreiben.
const DEBOUNCE_MS = 2500;
// Innerhalb dieses Fensters gilt weiteres Tippen an derselben Datei als dieselbe Sitzung.
const COOLDOWN_MS = 5 * 60 * 1000;
// Nachlauf: fs.watch verliert unter OneDrive gelegentlich Benachrichtigungen, und was
// passiert waehrend das Panel zu ist, sieht der Watcher nie. Der Scan holt das nach.
const SCAN_MS = 10 * 60 * 1000;
const SCAN_DAYS = 14;
// OneDrive loest fs.watch auch aus, wenn es eine Datei nur anfasst (Hydrierung,
// Attribut-Aenderung) — die mtime bleibt dabei wochenalt. Ein echtes Speichern setzt sie
// immer auf jetzt. Ohne diese Pruefung sammelt der Watcher Altbestand ein: 107 Events mit
// Zeitstempeln aus Juli, die niemand ausgeloest hat. Der Scan bleibt zustaendig fuer
// Aenderungen aus der Zeit, in der das Panel zu war — der ist auf 14 Tage begrenzt.
const STALE_MS = 10 * 60 * 1000;

const PATHS_FILE = path.join(path.dirname(DATA_FILE), 'obsidian-paths.json');

const timers = new Map();
const lastEmit = new Map();

/* ── Pfad-Gedaechtnis ──
   birthtime ist unter Windows und OneDrive unbrauchbar: Editoren schreiben ueber
   Temp-Datei plus Rename, dabei wird die Erstellungszeit zurueckgesetzt und jedes
   Bearbeiten sah aus wie ein Neuanlegen. Stattdessen wird gemerkt, welche Pfade schon
   einmal gesehen wurden. Neu heisst: Pfad war vorher nicht da. */
let known = new Set();
let knownLoaded = false;

function loadPaths() {
  try {
    known = new Set(JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8')));
    knownLoaded = true;
  } catch {
    known = new Set();
    knownLoaded = false; // erster Lauf: nichts als "neu" melden, nur inventarisieren
  }
}

let savePathsTimer = null;
function savePaths() {
  clearTimeout(savePathsTimer);
  savePathsTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(PATHS_FILE), { recursive: true });
    fs.writeFileSync(PATHS_FILE, JSON.stringify([...known]), 'utf8');
  }, 1500);
}

function actionFor(posix) {
  const fresh = knownLoaded && !known.has(posix);
  if (!known.has(posix)) { known.add(posix); savePaths(); }
  return fresh ? 'created' : 'updated';
}

/* ── Hilfen ── */
function skipped(rel) {
  return rel.split(/[\\/]/).some((seg) => SKIP.includes(seg));
}

function tracked(rel) {
  return EXT.includes(path.extname(rel).toLowerCase());
}

// Sieben Dateien im Vault heissen README.md, dazu _MOC und index. Der reine Dateiname
// ist im Verlauf nicht unterscheidbar — deshalb Ordnername davor.
const GENERIC = new Set(['readme', '_moc', 'index', 'moc']);
function titleFor(rel) {
  const stem = path.basename(rel, path.extname(rel));
  if (!GENERIC.has(stem.toLowerCase())) return stem;
  const parent = path.basename(path.dirname(rel));
  return parent && parent !== '.' ? `${parent} / ${stem}` : stem;
}

// URLSearchParams kodiert Leerzeichen als "+". Obsidian liest das woertlich und sucht
// dann einen Vault namens "Obsidian+Vault" — Fehlermeldung "Vault not found".
// Deshalb encodeURIComponent, und der absolute Pfad statt vault+file: damit ist kein
// Vault-Name noetig und die Zuordnung ist eindeutig.
function obsidianUrl(abs) {
  return 'obsidian://open?path=' + encodeURIComponent(abs);
}

function build(rel, st, action, extra = {}) {
  const posix = rel.replace(/\\/g, '/');
  const folder = path.dirname(rel).replace(/\\/g, '/');
  const note = posix.replace(/\.(md|canvas|base)$/i, '');
  return {
    ts: new Date(st.mtimeMs).toISOString(),
    source: 'obsidian',
    action,
    title: titleFor(rel),
    detail: folder === '.' ? '.' : folder,
    url: obsidianUrl(path.join(VAULT, rel)),
    meta: {
      kb: Math.round((st.size / 1024) * 10) / 10,
      // Pfad + Sekunde ist der stabile Schluessel. Ohne Endung, weil die Alt-Events aus
      // dem Seed-Lauf nur Ordner + Dateiname ohne Endung hergeben — sonst gilt jede
      // alte Datei beim ersten Scan erneut als neu.
      dedupe: `obsidian|${note}|${Math.floor(st.mtimeMs / 1000)}`,
      ...extra,
    },
  };
}

/* ── Live-Zweig ── */
function handleChange(rel) {
  let st;
  try {
    st = fs.statSync(path.join(VAULT, rel));
  } catch {
    return; // geloescht oder wegbenannt — kein Event
  }
  if (!st.isFile()) return;

  const now = Date.now();
  const posix = rel.replace(/\\/g, '/');

  // Beruehrt statt bearbeitet: Pfad merken, damit er spaeter nicht als "neu" gilt,
  // aber kein Event schreiben.
  if (now - st.mtimeMs > STALE_MS) {
    if (!known.has(posix)) { known.add(posix); savePaths(); }
    return;
  }

  const prev = lastEmit.get(rel);
  if (prev && now - prev < COOLDOWN_MS) return;
  lastEmit.set(rel, now);

  // Wurde kurz zuvor eine Teams-Nachricht kopiert, ist diese Datei sehr wahrscheinlich
  // das Ziel. Korrelation, keine Messung — deshalb als Zusatz markiert und nicht als
  // Tatsache in den Titel geschrieben.
  const copy = bus.pendingTeamsCopy();
  emit(build(rel, st, actionFor(posix), {
    live: true,
    ...(copy ? { fromTeams: copy.from || true } : {}),
  }));
}

/* ── Nachlauf-Scan ── */
function scan(log) {
  const cut = Date.now() - SCAN_DAYS * 86400_000;
  const first = !knownLoaded;
  let neu = 0;
  let gesehen = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP.includes(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.isFile() || !tracked(ent.name)) continue;
      const rel = path.relative(VAULT, abs);
      const posix = rel.replace(/\\/g, '/');
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      // Pfad-Inventar deckt den ganzen Vault ab, Events nur die letzten 14 Tage.
      const action = actionFor(posix);
      if (st.mtimeMs < cut) continue;
      gesehen += 1;
      if (emit(build(rel, st, action, { scan: true }))) neu += 1;
    }
  };

  walk(VAULT);
  if (first) knownLoaded = true;
  log(`obsidian: Scan ${gesehen} Dateien der letzten ${SCAN_DAYS} Tage, ${neu} neu`
    + (first ? ` (Erstlauf, ${known.size} Pfade inventarisiert)` : ''));
}

function start(log) {
  if (!fs.existsSync(VAULT)) {
    log('obsidian: Vault nicht gefunden — ' + VAULT);
    return () => {};
  }
  loadPaths();

  // Erst nachholen, dann live weiterhoeren.
  scan(log);

  const w = fs.watch(VAULT, { recursive: true }, (fsEvent, rel) => {
    if (!rel || !tracked(rel) || skipped(rel)) return;
    clearTimeout(timers.get(rel));
    timers.set(rel, setTimeout(() => {
      timers.delete(rel);
      handleChange(rel);
    }, DEBOUNCE_MS));
  });
  w.on('error', (e) => log('obsidian watch error: ' + e.message));

  const t = setInterval(() => {
    try { scan(log); } catch (e) { log('obsidian scan failed: ' + e.message); }
  }, SCAN_MS);

  log('obsidian: live watch + Scan alle 10 min');
  return () => { w.close(); clearInterval(t); };
}

module.exports = { start, scan, VAULT, titleFor, obsidianUrl, PATHS_FILE };

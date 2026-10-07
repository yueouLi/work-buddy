const fs = require('fs');
const path = require('path');
const { DATA_FILE, readEvents } = require('./store');
const { ROOTS, EXT, noise, skipDir } = require('./collectors/html');
const { sachKey, projectInfo } = require('./projects');

/* ── HTML-Ablage: die eine Datei wiederfinden ──
   Vorlage ist Leonies eigene html-overview.html, und ihr Zweck ist genau einer, in ihren
   Worten: "wenn ich ploetzlich ein bestimmtes HTML brauche, es schnell finden — andere
   Dateitypen sind nicht gemeint."

   Damit ist der Umfang dieser Datei festgelegt: HTML, sonst nichts. Ein Zwischenstand hat
   Dinge aus allen fuenf Quellen aufgenommen — Confluence-Seiten, Obsidian-Notizen, Repos —
   und damit aus einem Finder ein zweites Inventar gemacht. Das hat den Zweck verfehlt und
   nebenbei die Anzeige zugeschuettet: 55 Schubladen, in denen die gesuchten 15 HTML-Ordner
   untergingen. Wer eine Notiz sucht, sucht sie in Obsidian; wer eine Seite sucht, in
   Confluence. Nur die verstreuten HTML-Artefakte haben kein Zuhause — deshalb dieses hier.

   Der Verlauf beantwortet weiter "was ist passiert" und bleibt bei allen fuenf Quellen.
   Diese Datei beantwortet "wo liegt das HTML".

   Zwei Zutaten, weil keine allein reicht:

   1. Vollscan der HTML-Orte (dieselben wie im Kollektor, aber ohne 90-Tage-Fenster).
      Ein Deck von Maerz steht in keinem Ereignis mehr und ist genau das, was gesucht wird.
   2. Das Ereignis-Log, aber nur die html-Ereignisse: sie liefern den Zaehler "wie oft
      angefasst" und fangen die Datei auf, die der Watcher gerade gemeldet hat und die im
      letzten Scan noch nicht stand. */

const INDEX_FILE = path.join(path.dirname(DATA_FILE), 'library-index.json');
const META_FILE = path.join(path.dirname(DATA_FILE), 'library-meta.json');

const KOPF_BYTES = 8192;

/* Sicherheitsnetz, kein Taktgeber. Normalerweise loest ein HTML-Ereignis den Scan aus (siehe
   laden()). Der Watcher meldet aber nur, was entsteht und sich aendert — eine geloeschte oder
   verschobene Datei erzeugt kein Ereignis und wuerde sonst bis zum naechsten Neustart im
   Bestand stehen. Deshalb spaetestens alle 10 Minuten trotzdem lesen. Dieselbe Zahl wie
   SCAN_MS im HTML-Kollektor: zwei verschiedene Perioden fuer denselben Ordner waeren nur
   schwerer zu erklaeren, nicht besser. */
const SPAETESTENS_MS = 10 * 60 * 1000;

/* ── Beschreibung aus der Datei selbst ──
   Nur der Kopf wird gelesen. <title> steht dort immer, und eine 450-kB-Datei komplett
   einzulesen, um 60 Zeichen zu bekommen, waere bei 130 Dateien pro Scan Verschwendung. */
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
};

function entities(s) {
  return s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] || m);
}

function saubern(s) {
  return entities(String(s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function kopfLesen(abs) {
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(KOPF_BYTES);
    const n = fs.readSync(fd, buf, 0, KOPF_BYTES, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* egal */ }
  }
}

function beschreibung(abs) {
  const kopf = kopfLesen(abs);
  if (!kopf) return '';
  const t = kopf.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titel = t ? saubern(t[1]) : '';
  // Generische Titel sagen nichts. Dann lieber die erste Ueberschrift, die im Kopf steht.
  if (titel && !/^(document|untitled|html|index|seite|page|test)$/i.test(titel)) return titel;
  const h = kopf.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h ? saubern(h[1]) : '';
  return h1 || titel;
}

/* ── Schubladen ──
   Genau das Schema der alten Uebersicht: Wurzelordner plus erste Ebene darunter.
   "Desktop / UC3_Erstellung PPTs" ist eine brauchbare Schublade, "Desktop / UC3_… / assets
   / img" waere Kleinkram. Tiefer liegende Dateien rollen hoch, der vollstaendige Ordner
   steht in der Zeile. */
function kategorieVon(root, abs) {
  const rel = path.relative(root.dir, path.dirname(abs)).replace(/\\/g, '/');
  if (!rel || rel === '.') return `${root.label} (direkt)`;
  return `${root.label} / ${rel.split('/')[0]}`;
}

// Wo eine html-Datei aus dem Log einsortiert wird, solange der Scan sie noch nicht kennt.
// Dieselbe Regel wie kategorieVon(), nur ohne root-Objekt: der Kollektor hat den
// Ordnerpfad schon in detail gelegt.
function kategorieVonEvent(e) {
  const ordner = String((e.detail || '')).replace(/\\/g, '/');
  if (!ordner) return 'HTML (unbekannter Ort)';
  const teile = ordner.split(' / ');
  if (teile.length === 1) return `${teile[0]} (direkt)`;
  return `${teile[0]} / ${teile[1].split('/')[0]}`;
}

// Muss zeichengleich zu keysOf() in projects.js sein, sonst haengen Bewertung und
// Handzuordnung an zwei verschiedenen Schluesseln fuer dieselbe Datei.
function htmlKey(abs) {
  return `datei|${abs.replace(/\\/g, '/').toLowerCase()}`;
}

function htmlScan() {
  const dateien = [];

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
      const ext = path.extname(ent.name).toLowerCase();
      if (!EXT.includes(ext)) continue;
      // Dieselbe Klassifikation wie im Kollektor. Waeren es zwei Filter, wuerde die
      // Kachel "HTML 54" eine andere Menge zaehlen als der Bestand zeigt.
      if (noise(path.basename(ent.name, ext))) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const relDir = path.relative(root.dir, path.dirname(abs)).replace(/\\/g, '/');
      const ordner = relDir && relDir !== '.' ? `${root.label} / ${relDir}` : root.label;
      dateien.push({
        key: htmlKey(abs),
        source: 'html',
        name: ent.name,
        ordner,
        kategorie: kategorieVon(root, abs),
        beschreibung: beschreibung(abs),
        pfad: abs,
        url: '',
        kb: Math.round((st.size / 1024) * 10) / 10,
        mtime: new Date(st.mtimeMs).toISOString(),
        ...(root.fluechtig ? { fluechtig: true } : {}),
      });
    }
  };

  for (const root of ROOTS) {
    if (fs.existsSync(root.dir)) walk(root.dir, root);
  }

  const stand = { gescannt: new Date().toISOString(), dateien };
  try {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(stand), 'utf8');
  } catch { /* Der Cache ist Bequemlichkeit, kein Zustand. Scheitert er, wird neu gescannt. */ }
  return stand;
}

function indexLesen() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    // Der Cache aus der HTML-only-Fassung hatte kein source-Feld. Lieber neu scannen
    // als eine halbe Struktur weiterreichen.
    if (Array.isArray(raw.dateien) && raw.dateien.every((d) => d.source)) return raw;
  } catch { /* kein Cache */ }
  return null;
}

/* Projekt und Handzuordnung stehen absichtlich NICHT im Cache. Der Cache beschreibt, was auf
   der Platte liegt — Name, Pfad, Groesse, Titel. Was das Ding bedeutet, ist eine Regel bzw.
   eine Entscheidung und kann sich jede Sekunde aendern: wer eine Datei auf ein Projekt zieht,
   will die Zeile sofort umgehaengt sehen, nicht nach dem naechsten Scan. Dieselbe Trennung
   wie in store.js, wo das Projekt beim Lesen des Logs bestimmt wird und nicht beim Schreiben. */
function urteil(d) {
  const wie = {
    source: 'html', title: d.name, detail: d.ordner, meta: { path: d.pfad },
  };
  // Dieselbe Funktion wie im Verlauf, also auch dieselbe Begruendung. Eine Datei darf in der
  // Ablage nicht aus einem anderen Grund bei einem Projekt liegen als im Verlauf.
  const info = projectInfo(wie);
  return {
    project: info.id,
    grund: info.text,
    geraten: info.geraten,
    infra: Boolean(info.infra),
    ...(info.regel === 'hand' ? { fix: true } : {}),
  };
}

/* Eine html-Datei, die der Watcher gerade gemeldet hat und die im letzten Scan noch nicht
   stand. Beschreibung und Groesse werden sofort von der Platte gelesen, damit die Zeile nicht
   bis zum naechsten Scan nackt dasteht. */
function dingAusEvent(e, key) {
  const pfad = (e.meta && e.meta.path) || '';
  const ding = {
    key,
    source: 'html',
    name: e.title || '(ohne Titel)',
    ordner: e.detail || '',
    kategorie: kategorieVonEvent(e),
    beschreibung: '',
    pfad,
    url: e.url || '',
    kb: (e.meta && e.meta.kb) || 0,
    mtime: e.ts,
    project: e.project,
    grund: e.grund || '',
    geraten: Boolean(e.geraten),
    // e.fixed setzt store.js beim Lesen. Hier heisst das Feld fix, weil die Zeile dasselbe
    // Merkmal wie im Verlauf zeigt — dieselbe Zeile, dasselbe Etikett.
    ...(e.fixed ? { fix: true } : {}),
    ...(e.meta && e.meta.fluechtig ? { fluechtig: true } : {}),
  };
  if (pfad) {
    try {
      const st = fs.statSync(pfad);
      ding.beschreibung = beschreibung(pfad);
      ding.kb = Math.round((st.size / 1024) * 10) / 10;
    } catch { /* schon wieder weg — dann bleibt die Zeile ohne Beschreibung */ }
  }
  return ding;
}

/* ── Bewertung und Notiz ──
   Eigene Datei, Schluessel ist der Sach-Schluessel aus projects.js. Der Scan darf das
   Inventar jederzeit komplett ueberschreiben, diese Datei nie.

   Bis 2026-08-20 stand hier der kleingeschriebene Pfad. Der Umstieg auf den Sach-Schluessel
   war moeglich, weil die Datei zu dem Zeitpunkt leer war — spaeter waere es eine Migration
   gewesen. Alte Eintraege gehen nicht verloren, sie erscheinen als verwaist. */
function metaLesen() {
  try {
    const raw = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function metaSchreiben(meta) {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 1), 'utf8');
}

function setzen(key, patch) {
  if (typeof key !== 'string' || !key) return { ok: false, message: 'Kein Schluessel' };
  const meta = metaLesen();
  const eintrag = meta[key] || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'stern')) {
    const n = Math.max(0, Math.min(5, Math.round(Number(patch.stern) || 0)));
    eintrag.stern = n;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notiz')) {
    eintrag.notiz = String(patch.notiz || '').slice(0, 400);
  }
  eintrag.updated = new Date().toISOString();
  // Ein Eintrag ohne Sterne und ohne Notiz ist kein Eintrag. Aufraeumen statt anhaeufen —
  // sonst zaehlt die Ansicht spaeter Nullbewertungen als "verwaist".
  if (!eintrag.stern && !eintrag.notiz) delete meta[key];
  else meta[key] = eintrag;
  try {
    metaSchreiben(meta);
  } catch (err) {
    return { ok: false, message: 'Bewertung nicht gespeichert: ' + err.message };
  }
  return { ok: true, meta };
}

let cache = null;

/* force === true  → immer scannen (Knopf "Neu einlesen")
   force === 'nie'  → nie scannen, nur den Index von der Platte nehmen.

   'nie' ist fuer den MCP-Server (mcp/server.js). Der laeuft als eigener Prozess neben
   Electron, und htmlScan() schreibt library-index.json. Zwei Prozesse, die dieselbe
   JSON-Datei schreiben, koennen sie halb geschrieben hinterlassen — der Lesepfad hier
   faengt das per try/catch ab, aber ein Server, der nur lesen soll, hat auf der Platte
   nichts zu suchen. Der Rueckgabewert enthaelt `gescannt`, damit der Aufrufer sagen kann,
   wie alt der Stand ist, statt ihn stillschweigend fuer aktuell zu halten. */
function laden(force) {
  // Das Log zuerst, dann die Entscheidung ueber den Plattenscan: nur wer die Ereignisse
  // kennt, kann wissen, ob der Scan veraltet ist.
  const ereignisse = readEvents({ roh: true });

  /* ── Wann wird die Platte neu gelesen ──
     Bis 2026-08-20 stand hier eine Uhr: "Scan ist 60 Sekunden gueltig". Das war falsch
     herum gedacht. Der HTML-Kollektor hat einen echten fs.watch — er weiss auf die Sekunde,
     wann eine Datei angelegt wurde, und schreibt es ins Log. Der Bestand hat auf diese
     Nachricht 60 Sekunden lang nicht reagiert und danach auch dann neu gescannt, wenn sich
     gar nichts geaendert hatte.

     Jetzt entscheidet das Log: ist ein HTML-Ereignis neuer als der letzte Scan, wird neu
     gescannt, sonst nicht. Damit haengt der Bestand an derselben Kette wie der Verlauf
     (Watcher → Log → events:changed → laden()) und nicht an einem Timer daneben.

     Der Scan bleibt trotzdem noetig: er findet Dateien, die vor dem 90-Tage-Fenster des
     Kollektors entstanden sind und in keinem Ereignis stehen — genau die Decks von Maerz. */
  const alt = cache || indexLesen();
  let neuScannen = force === true || (!alt && force !== 'nie');
  if (alt && !neuScannen && force !== 'nie') {
    const seitScan = Date.parse(alt.gescannt);
    neuScannen = Date.now() - seitScan > SPAETESTENS_MS
      || ereignisse.some((e) => e.source === 'html' && Date.parse(e.ts) > seitScan);
  }
  // Ohne Index und ohne Scan-Erlaubnis: leerer Stand. Der Bestand kommt dann allein aus den
  // html-Ereignissen unten — weniger, aber nicht falsch.
  cache = neuScannen ? htmlScan() : (alt || { gescannt: null, dateien: [] });

  const dinge = new Map();
  // HTML zuerst: die reichsten Datensaetze (Beschreibung, Groesse, echter Pfad). Projekt und
  // "fix" kommen frisch dazu, weil sie nicht in den Cache gehoeren — siehe urteil().
  for (const d of cache.dateien) dinge.set(d.key, { ...d, ...urteil(d), treffer: 0 });

  /* Danach das Log — aber nur die html-Ereignisse. Es zaehlt, wie oft eine Datei angefasst
     wurde, und ergaenzt die, die zwischen zwei Scans entstanden ist. Alles andere im Log
     (Confluence, Obsidian, GitHub, Teams) wird hier absichtlich uebersprungen: es gehoert in
     den Verlauf, nicht in die Ablage. roh: true, weil eine gefaltete Zeile "17 Dateien"
     keine Datei ist. */
  for (const e of ereignisse) {
    if (e.source !== 'html') continue;
    const k = sachKey(e);
    const da = dinge.get(k);
    if (!da) {
      dinge.set(k, { ...dingAusEvent(e, k), treffer: 1 });
      continue;
    }
    da.treffer += 1;
    // Der Scan kennt die mtime der Datei, das Log die Zeit der Bearbeitung. Die jeweils
    // spaetere gewinnt, damit "zuletzt zuerst" ueberall dasselbe bedeutet.
    if (new Date(e.ts) > new Date(da.mtime)) da.mtime = e.ts;
    if (!da.url && e.url) da.url = e.url;
  }

  const meta = metaLesen();
  const dateien = [...dinge.values()].sort((a, b) => a.kategorie.localeCompare(b.kategorie, 'de')
    || new Date(b.mtime) - new Date(a.mtime));

  const vorhanden = new Set(dateien.map((d) => d.key));
  // Bewertete Dinge, die es nicht mehr gibt: verschoben, umbenannt, geloescht oder unter
  // einem alten Schluessel gespeichert. Sichtbar machen, nicht wegwerfen.
  const verwaist = Object.keys(meta)
    .filter((k) => !vorhanden.has(k))
    .map((k) => ({ key: k, ...meta[k] }));

  const katMap = new Map();
  for (const d of dateien) {
    const c = katMap.get(d.kategorie)
      || { name: d.kategorie, source: 'html', anzahl: 0, bewertet: 0 };
    c.anzahl += 1;
    if (meta[d.key] && meta[d.key].stern) c.bewertet += 1;
    katMap.set(d.kategorie, c);
  }
  const kategorien = [...katMap.values()].sort((a, b) => b.anzahl - a.anzahl
    || a.name.localeCompare(b.name, 'de'));

  return {
    gescannt: cache.gescannt,
    dateien,
    kategorien,
    meta,
    verwaist,
    orte: ROOTS.map((r) => ({ label: r.label, dir: r.dir, fehlt: !fs.existsSync(r.dir) })),
  };
}

module.exports = { laden, scan: htmlScan, setzen, INDEX_FILE, META_FILE };

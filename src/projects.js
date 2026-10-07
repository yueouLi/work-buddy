const fs = require('fs');
const path = require('path');

// Regeln koennen ohne Code-Aenderung ueberschrieben werden. Fehlt die Datei oder ist sie
// kaputt, gelten die Defaults unten — ein Tippfehler in JSON darf das Panel nicht leer machen.
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'projects.json');

/* ── Zwei Stufen: Struktur schlaegt Wort ──
   Ein Ordner, ein Repo, ein Platz im Confluence-Baum ist eine Tatsache ueber die Datei.
   Ein Wort im Titel ist ein Indiz. Vorher waren beide gleich stark und die Reihenfolge
   dieser Liste entschied — mit nachweisbarem Schaden am 2026-08-21:

   - Das Schlagwort "screenshot" bei Nico hat sich Foto2Text-Dateien geholt, weil Nicos
     Projekt in der Liste ueber Thorstens steht. Ordnerregel verloren gegen Wortregel.
   - "obsidian" und "vault" trafen jede HTML-Datei im Vault, weil das Schlagwort auch gegen
     `detail` geprueft wurde und `detail` bei HTML und Arbeit der Pfad ist. Der Pfad enthaelt
     immer "Obsidian Vault". 19 Treffer, fast alle falsch.

   Deshalb laeuft die Zuordnung jetzt in zwei Durchgaengen ueber alle Projekte: erst die
   starken Regeln, dann die schwachen. Und Schlagworte sehen nur noch den Titel.

   Starke Regeln (Struktur, gilt als sicher):
     folders      Vault-Ordner, Praefix        — Quelle obsidian
     pfade        Pfadfragment, kleingeschrieben — Quellen html und arbeit
     repos        genauer Repo-Name            — Quelle github
     elternseiten Titel eines Vorfahren im Confluence-Baum — Quelle confluence
     mails        Adresse der Gegenseite       — Quelle outlook

   Schwache Regeln (Indiz, wird als "geraten" markiert):
     spaces       Confluence-Space
     keywords     Wort im Titel

   Farben absichtlich ausserhalb der Quellen-Palette (Lila/Blau/Dunkelgrau) — sonst ist im
   Verlauf nicht zu unterscheiden, ob ein Farbstreifen die Quelle oder das Projekt meint. */
const DEFAULT_PROJECTS = [
  {
    id: 'celonis',
    auftraggeber: 'Nico',
    label: 'Celonis Datenextraktion',
    color: '#0B7285',
    hint: 'Kennzahlen aus Celonis-Screenshots nach Excel',
    vaultDir: 'Claude Code/Enablement/Use Cases/06 Celonis Auswertungen',
    folders: [
      'Claude Code/Enablement/Use Cases/06 Celonis Auswertungen',
      'Claude Code/Enablement/Use Cases/07 Celonis Direkt-Anbindung',
      'GenAI@Schaden/Celonis-Hintergrund',
    ],
    pfade: ['celonis-screenshot-to-excel', 'celonis-datenextraktion-nico'],
    elternseiten: [],
    mails: [],
    spaces: [],
    repos: [],
    // "screenshot" ist raus: das Wort steht auch in Foto2Text-Pfaden und -Titeln.
    keywords: ['celonis', 'hockeystick'],
  },
  {
    id: 'confluence-report',
    auftraggeber: 'Marwin',
    label: 'Confluence als Report-Medium',
    color: '#E05C2E',
    hint: 'Baukasten Confluence→Deck und Statusabfrage GenAI',
    vaultDir: 'GenAI Team/02 Organize by actionability',
    folders: [
      'GenAI Team/01 Capture/Marwin Müller',
      'GenAI Team/02 Organize by actionability/Marwin Müller',
    ],
    // Die HTML-Prototypen dazu. Sie hingen vorher am Wort im Dateinamen — eine Vermutung,
    // die zufaellig stimmte. Der Ordner ist die Tatsache.
    pfade: ['baukasten-slide-confluence', 'confluence-deck-erklaert', 'gantt-roadmap'],
    // Der Zweig im Confluence-Baum, nicht der Space: hier haengen Baukasten, MVP1/MVP2
    // und die Vorlagenseiten.
    elternseiten: ['Confluence Report', '03_Präsentation mit Allianz-Design'],
    // Die Seite "Baukasten" ist die Wurzel der Vorlagenbibliothek innerhalb dieses Zweigs.
    // Alles darunter (Card Grid, Callout, Vorlagen zum Kopieren) ist wiederverwendbares
    // Material fuer jedes Deck, nicht nur fuer Marwins Lieferung — bleibt trotzdem hier
    // zugeordnet, nur mit dem Infra-Kennzeichen.
    infraZweige: ['Baukasten'],
    mails: [],
    spaces: [],
    repos: ['yueou-li/allianz-ppt-skill'],
    keywords: [
      'baukasten',
      'confluence-deck',
      'statusabfrage',
      'status-abfrage',
      'statusupdate',
      'etappenreview',
      'roadmap manager',
      'gantt',
    ],
  },
  {
    id: 'obsidian-tutorium',
    auftraggeber: 'Kevin',
    label: 'Obsidian Tutorium',
    color: '#5F3DC4',
    hint: 'Obsidian dem Team beibringen: Vorstellung, Skills, Vault-Aufbau',
    vaultDir: 'Claude Code',
    folders: [],
    pfade: ['obsidian-lernen'],
    elternseiten: ['02_Second Brain'],
    mails: [],
    spaces: [],
    repos: ['yueou-li/obsidian-lernen'],
    // "vault" ist raus: Vault-Struktur und Vault-Audit sind Hausarbeit am eigenen Vault,
    // nicht Kevins Tutorium.
    keywords: ['obsidian', 'tutorium', 'zettelkasten'],
  },
  {
    id: 'fahrzeugfotos',
    auftraggeber: 'Thorsten',
    label: 'Fahrzeugfotos Machbarkeit',
    color: '#A9761A',
    hint: 'Machbarkeitsanalyse Fotoauswertung, Confluence-Zweig Use Case Foto2Text',
    vaultDir: 'Foto2Text',
    folders: ['Foto2Text'],
    pfade: ['foto2text-pdf'],
    elternseiten: ['Use Case Foto2Text (Machbarkeitsstudie)', 'Foto2Text'],
    mails: [],
    // spaces ist absichtlich leer. AIPC war bis 2026-04 gleichbedeutend mit Foto2Text und
    // ist es seit dem Umbau des Baums nicht mehr: unter "GenAI@Schaden Home" haengt dort
    // die komplette Team-Dokumentation. Die Regel hat 53 fremde Seiten zu Thorsten gezogen.
    spaces: [],
    repos: [],
    keywords: ['foto2text', 'foto to text', 'fahrzeugfoto', 'machbarkeitsstudie'],
  },
];


// Auffangprojekt. Es steht nicht in der Liste oben, damit es nie einen Treffer "gewinnt",
// sondern nur uebrig bleibt.
const REST = {
  id: 'sonstiges',
  vaultDir: null,
  label: 'Sonstiges',
  color: '#8AA0BE',
  hint: 'Alles ausserhalb der vier Projekte: Tagebuch, Lernen, Archiv, Stakeholder-Post',
};

let projects = DEFAULT_PROJECTS;

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.projects;
    if (Array.isArray(list) && list.length) {
      projects = list.filter((p) => p && p.id && p.label);
      return { ok: true, count: projects.length };
    }
    return { ok: false, message: 'projects.json enthaelt keine Projektliste' };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, count: projects.length, defaults: true };
    return { ok: false, message: 'projects.json unlesbar: ' + e.message };
  }
}

// Confluence-Events aus dem Seed-Lauf haben kein meta.space, aber das Detail traegt es
// als Text ("v3 · Space AIPC"). Ohne diesen Rueckfall waeren alte Seiten unzugeordnet.
function spaceOf(e) {
  if (e.meta && e.meta.space) return e.meta.space;
  const m = /Space\s+(\S+)/.exec(e.detail || '');
  return m ? m[1] : null;
}

function folderOf(e) {
  const d = (e.detail || '').replace(/\\/g, '/');
  return d === '.' ? '' : d;
}

/* ── Der Confluence-Baum ──
   Der Space taugt nicht als Projektmerkmal: AIPC enthaelt Foto2Text, die komplette
   Claude-Code-Dokumentation und den Baukasten. Der Platz im Seitenbaum taugt, denn genau
   dort hat Leonie ihre Struktur hingelegt.

   Die Ahnenkette steht nicht im Ereignis, sondern in einer eigenen Datei: sie ist eine
   Eigenschaft der Seite, nicht der Aenderung, und sie aendert sich, wenn eine Seite
   umgehaengt wird. Im Log waere sie damit eine Momentaufnahme, die veraltet. Der Kollektor
   holt sie ohnehin mit (expand=ancestors, keine zusaetzliche Abfrage) und schreibt sie
   hierhin; die Zuordnung liest sie beim Klassifizieren. */
const BAUM_FILE = path.join(__dirname, '..', 'data', 'confluence-baum.json');

let baum = {};

function loadBaum() {
  try {
    const raw = JSON.parse(fs.readFileSync(BAUM_FILE, 'utf8'));
    baum = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return { ok: true, count: Object.keys(baum).length };
  } catch (e) {
    if (e.code === 'ENOENT') { baum = {}; return { ok: true, count: 0 }; }
    return { ok: false, message: 'confluence-baum.json unlesbar: ' + e.message };
  }
}

function ahnenVon(e) {
  const id = e.meta && e.meta.pageId;
  const a = id ? baum[String(id)] : null;
  return Array.isArray(a) ? a : [];
}

// Absoluter Pfad, kleingeschrieben und mit Schraegstrichen. Fuer html und arbeit ist das
// die verlaessliche Aussage; der Dateiname ist es nicht (index.html, README.md).
function pfadOf(e) {
  return String((e.meta && e.meta.path) || '').replace(/\\/g, '/').toLowerCase();
}

/* Starke Regel: eine Struktur-Aussage. Trifft sie, ist die Zuordnung eine Tatsache und
   wird nicht als geraten markiert. Rueckgabe ist der Grund, damit die Zeile im Panel
   sagen kann, warum sie dort haengt. */
function stark(p, e) {
  if (e.source === 'obsidian' && (p.folders || []).length) {
    const folder = folderOf(e);
    const hit = p.folders.find((f) => folder === f || folder.startsWith(f + '/'));
    if (hit) return { regel: 'ordner', wert: hit };
  }
  if ((e.source === 'html' || e.source === 'arbeit') && (p.pfade || []).length) {
    const pfad = pfadOf(e);
    const hit = pfad && p.pfade.find((f) => f && pfad.includes(String(f).toLowerCase()));
    if (hit) return { regel: 'pfad', wert: hit };
  }
  if (e.source === 'confluence' && (p.elternseiten || []).length) {
    // Der eigene Titel gehoert dazu: die Wurzel eines Zweigs hat sich nicht selbst als
    // Vorfahren, ist aber genauso Struktur wie alles darunter. Ohne sie waere die Seite
    // "Use Case Foto2Text (Machbarkeitsstudie)" das einzige Blatt ihres eigenen Zweigs,
    // das nur geraten waere.
    const kette = [...ahnenVon(e), e.title].map((t) => String(t || '').toLowerCase());
    const hit = p.elternseiten.find((t) => t && kette.includes(String(t).toLowerCase()));
    if (hit) return { regel: 'elternseite', wert: hit };
  }
  if (e.source === 'github' && (p.repos || []).length) {
    const repo = ((e.meta && e.meta.repo) || '').toLowerCase();
    const hit = repo && p.repos.find((r) => repo === String(r).toLowerCase());
    if (hit) return { regel: 'repo', wert: hit };
  }
  if (e.source === 'outlook' && (p.mails || []).length) {
    const wer = String((e.meta && e.meta.vonMail) || '').toLowerCase();
    const hit = wer && p.mails.find((m) => wer === String(m).toLowerCase());
    if (hit) return { regel: 'mail', wert: hit };
  }
  return null;
}

/* ── Infrastruktur innerhalb eines Projekts ──
   "Confluence Report" haengt an einer Stelle, wo zwei verschiedene Dinge im selben Zweig
   liegen: Marwins tatsaechliche Lieferungen (MVP1, MVP2, Zielarchitektur) und die
   Baukasten-Vorlagenbibliothek (Card Grid, Callout Warning, Vorlagen zum Kopieren) — die
   Leonie fuer jedes Deck wiederverwendet, nicht nur fuer dieses Projekt. Beide haengen
   strukturell unter "Confluence Report", also trifft dieselbe elternseiten-Regel beide.
   Am 2026-08-27 hat Leonie das selbst benannt: "viele sind Source-Dateien, die ich
   [ueberall] benutze". Sie bleiben im Projekt — nur ein Fahnenwort, kein zweites
   Projekt —, denn ein zweites Projekt hätte die Frage "was gehört wohin" nur verschoben.
   Der Baum liefert dieselbe Tatsache wie fuer elternseiten: die Seite "Baukasten" ist die
   Wurzel der Vorlagenbibliothek, alles darunter ist Infrastruktur. */
function istInfra(p, e) {
  if (e.source !== 'confluence' || !(p.infraZweige || []).length) return false;
  const kette = [...ahnenVon(e), e.title].map((t) => String(t || '').toLowerCase());
  return p.infraZweige.some((t) => t && kette.includes(String(t).toLowerCase()));
}

/* Schwache Regel: ein Indiz. Schlagworte sehen nur den Titel — nicht `detail`, denn das
   ist bei html und arbeit der Pfad und bei Confluence die Versionszeile.

   Und sie sehen ihn nur dort, wo der Titel wirklich ein Titel ist. Bei html und arbeit ist
   er ein Dateiname, und ein Dateiname ist ein Stueck Pfad: `obsidian.js` — eine Quelldatei
   dieses Panels — landete deshalb bei Kevins Tutorium. Fuer diese beiden Quellen gibt es
   `pfade`, die absichtlich gesetzte Regel. */
const TITEL_QUELLEN = ['obsidian', 'confluence', 'outlook', 'github', 'teams'];

function schwach(p, e) {
  if (TITEL_QUELLEN.includes(e.source)) {
    const titel = String(e.title || '').toLowerCase();
    const hit = (p.keywords || []).find((k) => k && titel.includes(String(k).toLowerCase()));
    if (hit) return { regel: 'wort', wert: hit };
  }
  if (e.source === 'confluence' && (p.spaces || []).length) {
    const space = spaceOf(e);
    if (space && p.spaces.includes(space)) return { regel: 'space', wert: space };
  }
  return null;
}

/* ── Handzuordnung ──
   Regeln treffen nicht alles: ein Dateiname sagt oft nicht, zu welchem Thema die Datei
   gehoert. Deshalb kann jede Zeile per Drag&Drop auf ein Projekt gelegt werden. Die
   Handentscheidung schlaegt die Regel und liegt in einer eigenen Datei — der Ereignis-Log
   bleibt unberuehrt, und eine geloeschte Zuordnung faellt auf die Regel zurueck.

   Zwei Ebenen, weil die Praxis beides braucht: eine einzelne Datei umhaengen, oder einen
   ganzen Ordner/Space auf einmal. Die Datei gewinnt gegen den Ordner. */
const OVERRIDE_FILE = path.join(__dirname, '..', 'data', 'zuordnung.json');

let overrides = {};

function loadOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
    overrides = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return { ok: true, count: Object.keys(overrides).length };
  } catch (e) {
    if (e.code === 'ENOENT') { overrides = {}; return { ok: true, count: 0 }; }
    return { ok: false, message: 'zuordnung.json unlesbar: ' + e.message };
  }
}

// Schluessel bezeichnen die Sache, nicht das Ereignis: eine Datei zehnmal bearbeitet
// bleibt eine Zuordnung. Sonst muesste jede Speicherung neu einsortiert werden.
function keysOf(e) {
  const out = [];
  if (e.source === 'obsidian') {
    const folder = folderOf(e);
    out.push(`datei|${folder}/${e.title || ''}`);
    if (folder) out.push(`ordner|${folder}`);
  } else if (e.source === 'confluence') {
    out.push(`seite|${(e.meta && e.meta.pageId) || e.title || ''}`);
    const space = spaceOf(e);
    if (space) out.push(`space|${space}`);
  } else if (e.source === 'github') {
    out.push(`repo|${(e.meta && e.meta.repo) || e.title || ''}`);
  } else if (e.source === 'html') {
    // Der Dateiname taugt nicht als Schluessel: index.html gibt es dutzendfach. Der Pfad
    // ist eindeutig, und der Ordner darueber ist die sinnvolle Einheit fuer "ganzer
    // Ordner" — ein Artefakt besteht meist aus mehreren Dateien im selben Verzeichnis.
    const p = String((e.meta && e.meta.path) || '').replace(/\\/g, '/').toLowerCase();
    out.push(`datei|${p || `${e.detail || ''}/${e.title || ''}`}`);
    if (p) out.push(`ordner|${p.slice(0, p.lastIndexOf('/'))}`);
    else if (e.detail) out.push(`ordner|${e.detail}`);
  } else if (e.source === 'arbeit') {
    /* Wie bei HTML entscheidet der Pfad, nicht der Name: README.md gibt es in jedem
       Projektordner. Die zweite Ebene ist aber nicht das Verzeichnis der Datei, sondern der
       Projektordner selbst — wer eine Analyse aus baukasten-slide-confluence/analyse auf ein
       Projekt zieht, meint den Auftrag und nicht den Unterordner. */
    const p = String((e.meta && e.meta.path) || '').replace(/\\/g, '/').toLowerCase();
    out.push(`datei|${p || `${e.detail || ''}/${e.title || ''}`}`);
    const projekt = (e.meta && e.meta.projektPfad) || '';
    if (projekt) out.push(`ordner|${projekt}`);
    else if (p) out.push(`ordner|${p.slice(0, p.lastIndexOf('/'))}`);
  } else if (e.source === 'outlook') {
    /* Die Sache ist der Thread, nicht die einzelne Mail. Der Kollektor hat "AW:"/"WG:"
       schon abgeschnitten, also fallen alle Antworten auf denselben Schluessel — eine
       Zuordnung fuer den ganzen Verlauf, eine Bewertung, eine Notiz.

       Zweiter Schluessel ist die Gegenseite, nicht ein Ordner: bei Mail ist "alles von
       dieser Person" die Einheit, die "ganzer Ordner" bei Dateien entspricht. Damit
       laesst sich eine Mail von Marwin einmal auf ein Projekt ziehen und seine kuenftige
       Post landet dort. Die Adresse, nicht der Anzeigename — der wechselt zwischen
       "Mueller, Marwin (Allianz Services SE)" und "Marwin Mueller". */
    out.push(`thema|${String(e.title || '').toLowerCase()}`);
    // Nur bei erhaltener Post. Bei gesendeter waere die Gegenseite Leonie selbst, und
    // "alles von Leonie" ist keine Einheit — dann bleibt der Thread der einzige
    // Schluessel, und "ganzer Ordner" faellt auf ihn zurueck.
    const erhalten = !e.meta || e.meta.richtung !== 'gesendet';
    const wer = erhalten
      ? String((e.meta && e.meta.vonMail) || (e.meta && e.meta.von) || '').toLowerCase()
      : '';
    if (wer) out.push(`person|${wer}`);
  } else {
    out.push(`${e.source}|${e.title || ''}`);
  }
  return out;
}

/* ── Der Bestandsschluessel ist derselbe Schluessel ──
   Ein Ding ist dasselbe Ding, egal ob es angeklickt, umgehaengt, bewertet oder in den
   Loeschkorb gelegt wird. Deshalb ist der Schluessel des Bestands genau keysOf()[0] und
   keine zweite, aehnliche Berechnung. Zwei Begriffe von "dieselbe Datei" laufen
   auseinander, sobald sich einer davon aendert — dann haengt die Bewertung an einem
   anderen Ding als die Handzuordnung, und niemand sieht es. */
function sachKey(e) {
  return keysOf(e)[0];
}

function known(id) {
  return id === REST.id || projects.some((p) => p.id === id);
}

function overrideFor(e) {
  for (const k of keysOf(e)) {
    const id = overrides[k];
    if (id && known(id)) return { id, key: k };
  }
  return null;
}

// scope 'datei' haengt genau diese Datei um, 'ordner' den ganzen Ordner bzw. Space.
function setOverride(e, projectId, scope) {
  if (!known(projectId)) return { ok: false, message: 'Unbekanntes Projekt' };
  const keys = keysOf(e);
  const key = scope === 'ordner' ? (keys[1] || keys[0]) : keys[0];
  loadOverrides();
  overrides[key] = projectId;
  fs.mkdirSync(path.dirname(OVERRIDE_FILE), { recursive: true });
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(overrides, null, 2), 'utf8');
  return { ok: true, key, project: projectId, count: Object.keys(overrides).length };
}

function clearOverride(e) {
  loadOverrides();
  const hit = overrideFor(e);
  if (!hit) return { ok: false, message: 'Keine Handzuordnung vorhanden' };
  delete overrides[hit.key];
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(overrides, null, 2), 'utf8');
  return { ok: true, key: hit.key, count: Object.keys(overrides).length };
}

/* ── Warum haengt diese Zeile hier? ──
   Die Zuordnung gibt nicht nur ein Projekt zurueck, sondern die Regel, die gegriffen hat,
   und ob sie sicher war. Das ist der eigentliche Punkt: eine falsche Zuordnung ist nur
   korrigierbar, wenn sie auffindbar ist. Ein Farbstreifen ohne Begruendung sieht wie ein
   Ergebnis aus, auch wenn er eine Vermutung ist. */
const GRUND_TEXT = {
  hand: (w) => 'Von Hand zugeordnet',
  ordner: (w) => `Vault-Ordner „${w}"`,
  pfad: (w) => `Pfad enthält „${w}"`,
  elternseite: (w) => `Confluence-Zweig „${w}"`,
  repo: (w) => `Repo ${w}`,
  mail: (w) => `Post von ${w}`,
  wort: (w) => `geraten: Wort „${w}" im Titel`,
  space: (w) => `geraten: Confluence-Space ${w}`,
  rest: () => 'keine Regel trifft',
};

function beschreibe(regel, wert) {
  return (GRUND_TEXT[regel] || GRUND_TEXT.rest)(wert);
}

function projectInfo(e) {
  const fixed = overrideFor(e);
  if (fixed) {
    return {
      id: fixed.id, regel: 'hand', wert: fixed.key, geraten: false, infra: false,
      text: beschreibe('hand'),
    };
  }
  // Erster Durchgang: Struktur. Ueber alle Projekte, bevor irgendein Schlagwort zaehlt.
  for (const p of projects) {
    const t = stark(p, e);
    if (t) {
      return {
        id: p.id, ...t, geraten: false, infra: istInfra(p, e), text: beschreibe(t.regel, t.wert),
      };
    }
  }
  // Zweiter Durchgang: Indizien.
  for (const p of projects) {
    const t = schwach(p, e);
    if (t) {
      return {
        id: p.id, ...t, geraten: true, infra: istInfra(p, e), text: beschreibe(t.regel, t.wert),
      };
    }
  }
  return { id: REST.id, regel: 'rest', wert: '', geraten: false, infra: false, text: beschreibe('rest') };
}

function projectOf(e) {
  return projectInfo(e).id;
}

function isFixed(e) {
  return Boolean(overrideFor(e));
}

// Nur die Anzeige-Felder nach vorne geben. Die Regeln bleiben im Hauptprozess — der
// Renderer soll klassifizieren nicht wiederholen koennen, sonst laufen zwei Wahrheiten.
function listProjects() {
  return [...projects, REST].map((p) => ({
    id: p.id,
    // Auffangprojekt kennzeichnen: die Schiene haelt es unten, egal wie gross es ist.
    rest: p.id === REST.id,
    label: p.label,
    color: p.color || REST.color,
    hint: p.hint || '',
    auftraggeber: p.auftraggeber || '',
    // Zielordner im Vault fuer den Kontext-Export. null heisst: kein Export vorgesehen.
    vaultDir: p.vaultDir || null,
  }));
}

module.exports = {
  projectOf, projectInfo, isFixed, listProjects, loadConfig, CONFIG_FILE, REST,
  loadOverrides, setOverride, clearOverride, OVERRIDE_FILE,
  loadBaum, BAUM_FILE,
  // Fuer den Bestand (library.js). Bewusst dieselben Funktionen, nicht nachgebaute:
  // Kategorie und Schluessel muessen dort dasselbe bedeuten wie hier.
  sachKey, spaceOf, folderOf,
};

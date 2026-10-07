const fs = require('fs');
const path = require('path');
const { DATA_FILE, appendEvent } = require('../store');

const STATE_FILE = path.join(path.dirname(DATA_FILE), 'state.json');
const MAX_KEYS = 8000;

// Generischer Dedupe-Schluessel. Der Zeitstempel kommt bei allen Pull-Quellen von der
// Quelle selbst (Confluence lastUpdated, GitHub created_at, Datei-mtime) und ist damit
// ueber Neustarts hinweg stabil. Teams hat keinen Quell-Zeitstempel und liefert einen
// eigenen Schluessel in meta.dedupe.
//
// Zwei Fallen, die hier absichtlich abgefangen werden:
//  - Zeitstempel werden auf Sekunden und auf Epoch reduziert. Sonst gelten
//    "2026-08-20T09:16:46+02:00" (Seed-Skript) und "2026-08-20T07:16:46.000Z"
//    (Kollektor) als zwei verschiedene Ereignisse fuer dieselbe Dateiaenderung.
//  - Bei Obsidian wird der Dateipfad rekonstruiert, nicht der Titel benutzt. Der Titel
//    bekommt bei README/_MOC den Ordner vorangestellt, der Pfad bleibt stabil.
function keyOf(e) {
  if (e.meta && e.meta.dedupe) return e.meta.dedupe;
  const sec = Math.floor(Date.parse(e.ts) / 1000);
  if (e.source === 'obsidian') {
    const folder = e.detail && e.detail !== '.' ? e.detail + '/' : '';
    const t = String(e.title);
    const stem = t.includes(' / ') ? t.split(' / ').pop() : t;
    return `obsidian|${folder}${stem}|${sec}`;
  }
  return `${e.source}|${sec}|${e.title}`;
}

const seen = new Set();
let order = [];

function loadState() {
  // Bereits vorhandene Events als gesehen markieren, sonst schreibt der erste
  // Kollektor-Lauf die komplette Historie ein zweites Mal.
  if (fs.existsSync(DATA_FILE)) {
    for (const line of fs.readFileSync(DATA_FILE, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const k = keyOf(JSON.parse(s));
        if (!seen.has(k)) { seen.add(k); order.push(k); }
      } catch { /* kaputte Zeile ignorieren */ }
    }
  }
  // state.json haelt zusaetzlich Schluessel, die zu keinem Event fuehrten
  // (z.B. Clipboard-Inhalte in der Cooldown-Phase).
  try {
    for (const k of JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).keys || []) {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    }
  } catch { /* noch kein State */ }
  trim();
}

function trim() {
  while (order.length > MAX_KEYS) seen.delete(order.shift());
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ keys: order.slice(-MAX_KEYS) }), 'utf8');
  }, 1000);
}

// Gibt true zurueck, wenn das Event neu war und geschrieben wurde.
function emit(evt) {
  const k = keyOf(evt);
  if (seen.has(k)) return false;
  seen.add(k);
  order.push(k);
  trim();
  appendEvent(evt);
  saveState();
  return true;
}

// Reserviert einen Schluessel ohne Event zu schreiben (Cooldown-Faelle).
function mark(k) {
  if (seen.has(k)) return false;
  seen.add(k);
  order.push(k);
  trim();
  saveState();
  return true;
}

module.exports = { emit, mark, loadState, keyOf, STATE_FILE };

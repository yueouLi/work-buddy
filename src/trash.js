const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ── Löschkorb ──
   Die Zone in der Schiene sammelt, was weg soll. Aufgeraeumt wird auf Knopfdruck, und es
   gibt zwei Wege — weil "weg" zwei verschiedene Dinge heisst:

   1. clean()   → verschieben nach _Papierkorb/<Datum>/ im Vault. Die Datei ist aus dem
                  Arbeitsordner raus, liegt aber noch da. Fuer "erstmal aus dem Weg".
   2. recycle() → Windows-Papierkorb. Damit ist die Datei wirklich vom Rechner weg: nicht
                  mehr im Vault, nicht mehr in OneDrive. Zurueckholen macht Windows, nicht
                  dieses Panel. Deshalb fragt der Hauptprozess vorher nach.
   Dazu emptyBin() — schiebt den angesammelten Vault-Papierkorb in den Windows-Papierkorb,
   sonst waechst er still weiter und OneDrive synchronisiert ihn mit.

   Geloescht wird nie per unlink. Der Umweg ueber den Windows-Papierkorb kostet nichts und
   macht jeden Fehlgriff umkehrbar.

   Zwei Sorten Eintraege:
   - Dateien mit aufloesbarem Pfad (Obsidian, lokale Dateien) — koennen verschoben werden.
   - Alles andere (Confluence-Seiten, Teams-Kopien, Repos) — bleibt Notiz. Was auf einem
     Server liegt, wird nicht aus diesem Panel geloescht; das gehoert in die Oberflaeche,
     der es gehoert. */

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIST_FILE = path.join(DATA_DIR, 'loeschliste.json');
const VAULT = path.join(os.homedir(), 'OneDrive - Allianz', 'Dokumente', 'Obsidian Vault');
const BIN = path.join(VAULT, '_Papierkorb');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
    return { entries: Array.isArray(raw.entries) ? raw.entries : [], updated: raw.updated || null };
  } catch {
    return { entries: [], updated: null };
  }
}

function write(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = { updated: new Date().toISOString(), entries };
  fs.writeFileSync(LIST_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Aus einem Verlaufs-Ereignis den Dateipfad gewinnen. Bei Obsidian steckt er in der
// obsidian://open?path=…-URL; im Ereignis selbst steht nur der Dateiname ohne Endung.
function pathOf(evt) {
  // HTML-Artefakte haben keine URL, sondern den Pfad direkt im Event. Verschoben werden
  // sie trotzdem nicht: clean() fasst nichts ausserhalb des Vaults an, die Zeile wird
  // nur mit dem richtigen Pfad und dem Vermerk "ausserhalb" gelistet.
  if (evt.meta && evt.meta.path) return path.normalize(String(evt.meta.path));
  const url = String(evt.url || '');
  if (url.includes('path=')) {
    try {
      return path.normalize(decodeURIComponent(url.split('path=')[1]));
    } catch {
      return null;
    }
  }
  if (/^file:\/\//i.test(url)) {
    try {
      return path.normalize(decodeURIComponent(url.replace(/^file:\/+/i, '')));
    } catch {
      return null;
    }
  }
  return null;
}

function inVault(p) {
  const rel = path.relative(VAULT, p);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function idFor(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

function addEntries(items) {
  const d = read();
  const seen = new Set(d.entries.map((e) => e.id));
  let added = 0;
  let skipped = 0;

  for (const evt of items) {
    if (!evt || typeof evt !== 'object') { skipped += 1; continue; }
    // Gebuendelte Zeile steht fuer viele Dateien und hat keinen eindeutigen Pfad. Sie
    // wandert nicht in den Korb — sonst loescht ein Ziehen versehentlich einen Ordner.
    if (evt.batch) { skipped += 1; continue; }
    const file = pathOf(evt);
    const ref = file || evt.url || `${evt.source}|${evt.title}`;
    const id = idFor(ref);
    if (seen.has(id)) { skipped += 1; continue; }
    seen.add(id);
    d.entries.push({
      id,
      title: evt.title || path.basename(ref),
      source: evt.source || '',
      folder: evt.detail || '',
      // file bleibt gesetzt, auch ausserhalb des Vaults: recycle() darf jede aufloesbare
      // Datei in den Windows-Papierkorb schicken, nur clean() bleibt auf den Vault
      // beschraenkt. Vorher stand hier "file: file && inVault(file) ? file : null" — das
      // hat "endgueltig loeschen" fuer jede Datei ausserhalb des Vaults dauerhaft
      // ausgegraut, obwohl recycle() gar keinen Vault-Bezug braucht.
      file: file || null,
      ausserhalb: Boolean(file) && !inVault(file),
      url: evt.url || '',
      added: new Date().toISOString(),
    });
    added += 1;
  }

  write(d.entries);
  return { added, skipped, entries: d.entries };
}

function removeEntry(id) {
  const d = read();
  const entries = d.entries.filter((e) => e.id !== id);
  write(entries);
  return { ok: true, entries };
}

function uniqueTarget(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 100; i += 1) {
    const cand = `${base} (${i})${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
  return `${base} (${Date.now()})${ext}`;
}

/* Ein Protokoll fuer beide Wege. Es liegt im Vault (nicht in data/), weil es die Frage
   "wo ist die Datei hin?" beantworten muss — und die stellt sich in Obsidian, nicht hier. */
function logRows(rows) {
  if (!rows.length) return;
  const log = path.join(BIN, 'protokoll.md');
  let head = '';
  if (!fs.existsSync(log)) {
    head = ['---', 'tags: [papierkorb]', '---', '', '# Papierkorb — Protokoll', '',
      'Verschoben aus Work Buddy. "Windows-Papierkorb" heisst: vom Rechner weg, Rueckholen',
      'ueber den Windows-Papierkorb. Alles andere liegt im Datumsordner daneben und kann von',
      'dort an seinen alten Platz kopiert werden.', '',
      '| Datum | Titel | Von | Nach |', '|---|---|---|---|', ''].join('\n');
  }
  fs.mkdirSync(BIN, { recursive: true });
  const lines = rows.map((r) => `| ${today()} | ${r.titel} | \`${r.von}\` | ${r.nach} |`);
  fs.appendFileSync(log, head + lines.join('\n') + '\n', 'utf8');
}

/* Aufraeumen: verschieben, nicht loeschen. Ziel ist _Papierkorb/<Datum>/<Pfad im Vault>,
   damit erkennbar bleibt, wo die Datei herkam, und ein Zurueckschieben eine Kopieraktion
   ist statt Detektivarbeit. */
function clean() {
  const d = read();
  const moved = [];
  const failed = [];
  const bleibt = [];

  for (const e of d.entries) {
    if (!e.file) { bleibt.push(e); continue; }
    if (!inVault(e.file)) {
      failed.push({ ...e, grund: 'liegt ausserhalb des Vaults — nicht angetastet' });
      bleibt.push(e);
      continue;
    }
    if (!fs.existsSync(e.file)) {
      // Schon von Hand weg: aus der Liste nehmen, aber als Ergebnis melden.
      moved.push({ ...e, ziel: null, grund: 'war schon nicht mehr da' });
      continue;
    }
    const rel = path.relative(VAULT, e.file);
    const target = uniqueTarget(path.join(BIN, today(), rel));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(e.file, target);
      moved.push({ ...e, ziel: target });
    } catch (err) {
      failed.push({ ...e, grund: err.message });
      bleibt.push(e);
    }
  }

  logRows(moved.map((m) => ({
    titel: m.title,
    von: path.relative(VAULT, m.file),
    nach: m.ziel ? '`' + path.relative(VAULT, m.ziel) + '`' : m.grund,
  })));

  write(bleibt);
  return {
    ok: true,
    moved: moved.length,
    failed,
    bleibt: bleibt.length,
    ziel: path.join('_Papierkorb', today()),
    entries: bleibt,
  };
}

/* Wirklich weg: in den Windows-Papierkorb. Die Loeschfunktion kommt von aussen herein
   (shell.trashItem lebt in electron) — so bleibt dieses Modul ohne Electron-Abhaengigkeit
   und im Test mit einer Attrappe pruefbar. */
async function recycle(toOsTrash) {
  const d = read();
  const weg = [];
  const failed = [];
  const bleibt = [];

  for (const e of d.entries) {
    // Anders als clean(): der Windows-Papierkorb kennt keinen Vault. Eine Datei unter
    // Dokumente\Claude ist genauso loeschbar wie eine im Vault — die Vault-Schranke war
    // hier copy-paste aus clean() und hat "endgueltig loeschen" fuer alles ausserhalb
    // des Vaults blockiert, ohne dass das shell.trashItem darunter einen Grund dafuer hat.
    if (!e.file) { bleibt.push(e); continue; }
    if (!fs.existsSync(e.file)) {
      weg.push({ ...e, grund: 'war schon nicht mehr da' });
      continue;
    }
    try {
      await toOsTrash(e.file);
      weg.push({ ...e });
    } catch (err) {
      failed.push({ ...e, grund: err.message });
      bleibt.push(e);
    }
  }

  logRows(weg.map((w) => ({
    titel: w.title,
    von: path.relative(VAULT, w.file),
    nach: w.grund || 'Windows-Papierkorb',
  })));

  write(bleibt);
  return { ok: true, weg: weg.length, failed, bleibt: bleibt.length, entries: bleibt };
}

// Was liegt im Vault-Papierkorb? Das Protokoll zaehlt nicht mit — es bleibt beim Leeren da.
function binStat() {
  let dateien = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (dir === BIN && ent.name === 'protokoll.md') continue;
      dateien += 1;
      try { bytes += fs.statSync(p).size; } catch { /* gerade weggeraeumt */ }
    }
  };
  try {
    walk(BIN);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { dateien, bytes };
}

// Den ganzen Vault-Papierkorb in den Windows-Papierkorb schieben. Datumsordner wandern als
// Ganzes — ein Eintrag im Windows-Papierkorb pro Tag statt hunderter Einzeldateien.
async function emptyBin(toOsTrash) {
  let entries;
  try {
    entries = fs.readdirSync(BIN, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, weg: 0, failed: [] };
    throw e;
  }

  const weg = [];
  const failed = [];
  for (const ent of entries) {
    if (ent.name === 'protokoll.md') continue;
    const p = path.join(BIN, ent.name);
    try {
      await toOsTrash(p);
      weg.push(ent.name);
    } catch (err) {
      failed.push({ name: ent.name, grund: err.message });
    }
  }

  logRows(weg.map((name) => ({
    titel: 'Papierkorb geleert',
    von: path.join('_Papierkorb', name),
    nach: 'Windows-Papierkorb',
  })));

  return { ok: true, weg: weg.length, failed };
}

module.exports = {
  read, addEntries, removeEntry, clean, recycle, binStat, emptyBin,
  LIST_FILE, BIN, VAULT,
};

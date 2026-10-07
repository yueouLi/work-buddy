const fs = require('fs');
const os = require('os');
const path = require('path');

/* ── Prioritäten ──
   Quelle der Wahrheit sind die Projektnotizen in Vault 2 (wiki/projects/<Name>/<Name>.md),
   genau die, die der Slash-Command /todo pflegt. Das Panel liest den Abschnitt "## Tasks"
   und schreibt nur eines zurück: den Haken (- [ ] <-> - [x]) plus updated:. Alles andere
   in der Notiz bleibt, wie es ist.

   Was keine Notiz hergibt, liegt in data/prioritaeten.json: die Reihenfolge, die Einstufung
   (harter Termin, Details gehen verloren, ...) und der Grund dazu. Das sind Leonies
   Urteile, keine Eigenschaften des Projekts, deshalb nicht in die Notiz. */

const DATA_FILE = path.join(__dirname, '..', 'data', 'prioritaeten.json');
const VAULT2 = path.join(os.homedir(), 'OneDrive - Allianz', 'Dokumente', 'Obsidian Vault 2');
const PROJECTS_DIR = path.join(VAULT2, 'wiki', 'projects');

const TYPES = {
  hard: 'Harter Termin',
  loss: 'Details gehen verloren',
  soft: 'Weicher Termin',
  move: 'Verschiebbar',
  none: 'Nicht eingestuft',
};

function readJson() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      order: Array.isArray(j.order) ? j.order.map(String) : [],
      meta: j.meta && typeof j.meta === 'object' ? j.meta : {},
    };
  } catch {
    return { order: [], meta: {} };
  }
}

function writeJson(state) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function frontmatterValue(text, key) {
  const m = text.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

// Pfad zur Notiz eines Projekts; der Name kommt aus dem Renderer und darf nie aus dem Ordner führen.
function noteFile(id) {
  if (!id || /[\\/]|\.\./.test(id)) return null;
  const f = path.join(PROJECTS_DIR, id, id + '.md');
  return fs.existsSync(f) ? f : null;
}

// Zeilen des Abschnitts "## Tasks" als { index, done, text } — index ist die Zeile in der Datei.
function parseTasks(lines) {
  const out = [];
  let inTasks = false;
  lines.forEach((line, index) => {
    if (/^##\s/.test(line)) inTasks = /^##\s+Tasks\s*$/.test(line.replace(/\r$/, ''));
    if (!inTasks) return;
    const m = line.match(/^(\s*)- \[([ xX])\]\s+(.*?)\r?$/);
    if (m) out.push({ index, done: m[2] !== ' ', text: m[3] });
  });
  return out;
}

function load() {
  const state = readJson();
  let names = [];
  try {
    names = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    return { ok: false, message: 'Projektordner nicht lesbar: ' + err.message, items: [], types: TYPES };
  }
  const items = [];
  for (const id of names) {
    const file = noteFile(id);
    if (!file) continue;
    const text = fs.readFileSync(file, 'utf8');
    const tasks = parseTasks(text.split('\n'));
    // Projekte ohne Tasks (reine Wissensnotiz) und abgeschlossene bleiben draußen.
    if (!tasks.length) continue;
    if (/^done$/i.test(frontmatterValue(text, 'status'))) continue;
    const meta = state.meta[id] || {};
    items.push({
      id,
      title: frontmatterValue(text, 'title') || id,
      deadline: frontmatterValue(text, 'deadline'),
      type: TYPES[meta.type] ? meta.type : 'none',
      why: typeof meta.why === 'string' ? meta.why : '',
      tasks: tasks.map((t) => ({ text: t.text, done: t.done })),
    });
  }
  // Gespeicherte Reihenfolge zuerst; neue Projekte hängen hinten an, bis sie gezogen werden.
  const pos = new Map(state.order.map((id, i) => [id, i]));
  items.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e6) - (pos.has(b.id) ? pos.get(b.id) : 1e6));
  return { ok: true, items, types: TYPES };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* Haken setzen. Gefunden wird die Zeile über ihren Text, nicht über eine Nummer: Leonie
   bearbeitet die Notiz parallel in Obsidian, und eine Zeilennummer von vor einer Minute
   kann inzwischen auf eine andere Aufgabe zeigen. Datei wird direkt vor dem Schreiben neu
   gelesen. */
function toggle(id, taskText, done) {
  const file = noteFile(String(id || ''));
  if (!file) return { ok: false, message: 'Unbekanntes Projekt' };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const hit = parseTasks(lines).find((t) => t.text === taskText);
  if (!hit) return { ok: false, message: 'Aufgabe steht nicht mehr in der Notiz — Ansicht neu geladen' };
  lines[hit.index] = lines[hit.index].replace(/- \[[ xX]\]/, done ? '- [x]' : '- [ ]');
  let next = lines.join('\n');
  next = next.replace(/^updated:.*$/m, 'updated: ' + today());
  fs.writeFileSync(file, next, 'utf8');
  return { ok: true };
}

function setOrder(order) {
  const state = readJson();
  state.order = (Array.isArray(order) ? order : []).map(String);
  writeJson(state);
  return { ok: true };
}

function setMeta(id, patch) {
  if (!noteFile(String(id || ''))) return { ok: false, message: 'Unbekanntes Projekt' };
  const state = readJson();
  const cur = state.meta[id] || {};
  if (patch && TYPES[patch.type]) cur.type = patch.type;
  if (patch && typeof patch.why === 'string') cur.why = patch.why;
  state.meta[id] = cur;
  writeJson(state);
  return { ok: true };
}

module.exports = { load, toggle, setOrder, setMeta, PROJECTS_DIR, TYPES };

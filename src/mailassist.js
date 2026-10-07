/* ── Mail-Assistent ──
   Drei Eingaben (Kontext, deutscher Entwurf, eigentliche Absicht auf Chinesisch/frei),
   ein Modellaufruf, eine finale deutsche Version. Absichtlich ein Aufruf statt drei:
   die drei Felder haengen inhaltlich zusammen, drei getrennte Antworten wuerden sich
   widersprechen koennen. Das Modell liefert direkt mit, was es korrigiert hat — das
   speist dasselbe fehler_log.json, das der Claude-Code-Hook (fehler-log.py) auch
   fuellt, damit ein Fehlertagebuch entsteht statt zwei getrennten. */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const FEHLER_LOG_PATH = 'C:\\Users\\wfxndvg\\OneDrive - Allianz\\Dokumente\\Obsidian Vault\\AI Learning\\Fehlertagebuch\\fehler_log.json';
const REBUILD_SCRIPT = 'C:\\Users\\wfxndvg\\.claude\\hooks\\fehler-log.py';

function buildPrompt(context, draft, intent) {
  return [
    'Du bist Leonies persoenlicher Schreibassistent fuer deutsche E-Mails und Teams-Nachrichten.',
    'Leonie ist Chinesin, schreibt fluessig Deutsch, macht aber gelegentlich Fehler durch',
    'chinesische Satzlogik (Wortstellung, Kasus, Genus, Rechtschreibung).',
    '',
    'Kontext/Hintergrund (nur zum Verstaendnis, im Ergebnis nicht wiederholen):',
    context || '(kein Kontext angegeben)',
    '',
    "Leonies deutscher Entwurf:",
    draft || '(kein Entwurf vorhanden — bitte direkt aus der Absicht unten formulieren)',
    '',
    'Was Leonie eigentlich meint, falls sie es auf Deutsch nicht ausdruecken konnte (ggf. Chinesisch):',
    intent || '(keine zusaetzliche Absicht angegeben)',
    '',
    'Aufgabe:',
    '1. Schreibe eine finale, natuerliche deutsche Version. Korrigiere den Entwurf und/oder',
    '   baue die zusaetzliche Absicht ein. Ton: direkt, kein Filler, keine Uebertreibungen,',
    '   keine Floskeln wie "Es ist wichtig zu beachten".',
    '2. Liste danach jede sprachliche Korrektur auf, die du am Entwurf vorgenommen hast.',
    '   Wenn kein Entwurf vorhanden war (nur Absicht/Kontext), gib corrections als leeres Array zurueck.',
    '',
    'Gib NUR reines JSON zurueck, ohne Codeblock, ohne Erklaerung davor oder danach:',
    '{"final": "die finale deutsche Version", "corrections": [{"type": "Kasus|Wortstellung|Verbwahl|Genus|Rechtschreibung|Sonstige", "wrong": "falsche Formulierung", "right": "korrigierte Formulierung", "note": "kurzer Grund auf Deutsch"}]}',
  ].join('\n');
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt],
      { maxBuffer: 10 * 1024 * 1024, timeout: 120000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      },
    );
  });
}

function parseModelJson(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```json?/i, '').replace(/```$/, '').trim();
  }
  return JSON.parse(text);
}

// Haengt additiv an — dieselbe Datei, dieselbe Form wie fehler-log.py schreibt, damit
// beide Quellen im selben Dashboard landen.
function appendCorrections(corrections) {
  if (!Array.isArray(corrections) || !corrections.length) return;
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(FEHLER_LOG_PATH, 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const c of corrections) {
    if (!c || typeof c !== 'object') continue;
    entries.push({
      date: today,
      type: c.type || 'Sonstige',
      wrong: c.wrong || '',
      right: c.right || '',
      note: c.note || '',
    });
  }
  fs.mkdirSync(path.dirname(FEHLER_LOG_PATH), { recursive: true });
  fs.writeFileSync(FEHLER_LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

// dashboard.html neu bauen, aber ohne den ganzen Transcript-Analyse-Weg von fehler-log.py
// noch einmal zu durchlaufen — nur die HTML-Ausgabe soll frisch sein.
function rebuildDashboard() {
  execFile('python', [REBUILD_SCRIPT, '--rebuild'], () => {});
}

async function generate({ context, draft, intent }) {
  const hasInput = (draft && draft.trim()) || (intent && intent.trim());
  if (!hasInput) {
    return { ok: false, message: 'Entwurf oder Absicht angeben — sonst weiss ich nicht, worum es geht.' };
  }
  try {
    const prompt = buildPrompt(context, draft, intent);
    const raw = await runClaude(prompt);
    const parsed = parseModelJson(raw);
    if (!parsed || typeof parsed.final !== 'string') {
      throw new Error('Antwort ohne "final"-Feld: ' + raw.slice(0, 200));
    }
    appendCorrections(parsed.corrections);
    rebuildDashboard();
    return { ok: true, final: parsed.final, corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [] };
  } catch (err) {
    return { ok: false, message: 'Generierung fehlgeschlagen: ' + err.message };
  }
}

module.exports = { generate };

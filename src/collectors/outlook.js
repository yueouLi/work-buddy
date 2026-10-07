const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { emit } = require('./emit');

const POLL_MS = 5 * 60 * 1000;

// Beim ersten Lauf weiter zurueckgreifen als beim laufenden Betrieb: sonst ist die
// Zeitleiste nach einem Neustart leer, obwohl die Woche voll war.
const FENSTER_START_H = 168;
const FENSTER_LAUF_H = 12;

/* ── Warum ein Python-Skript und nicht COM aus Node ──
   Outlook ist nur ueber COM erreichbar, und der funktionierende Verbindungsaufbau auf
   diesem Rechner (gencache.EnsureDispatch, dann DispatchEx, dann Dispatch) steht schon
   im outlook-context Skill. Ihn hier ein zweites Mal in JavaScript nachzubauen hiesse:
   zwei Implementierungen, die beim naechsten Outlook-Update beide brechen, aber nur eine
   wird repariert.

   Deshalb ist das Panel hier Verbraucher, nicht Besitzer. Die Wahrheit liegt in
   ~/.claude/skills/outlook-context/tools/outlook_activity.py — dasselbe Werkzeug, das
   Claude benutzt, wenn Leonie fragt "was kam heute rein". Ein Ergebnis, eine Zaehlweise. */
const SKILL_TOOLS = path.join(os.homedir(), '.claude', 'skills', 'outlook-context', 'tools');
const TOOL = path.join(SKILL_TOOLS, 'outlook_activity.py');

// Electron erbt PATH nicht zuverlaessig von der Shell, aus der es gestartet wurde
// (Desktop-Verknuepfung, Autostart). Deshalb erst feste Orte, dann PATH als letzte Chance.
const PYTHON_KANDIDATEN = [
  'C:\\Python314\\python.exe',
  'C:\\Python313\\python.exe',
  'C:\\Python312\\python.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'python.exe'),
  'python',
];

function python() {
  for (const p of PYTHON_KANDIDATEN) {
    if (p === 'python' || fs.existsSync(p)) return p;
  }
  return 'python';
}

function lauf(args) {
  return new Promise((resolve, reject) => {
    execFile(python(), [TOOL, ...args], {
      // Der COM-Aufruf kann haengen, wenn Outlook gerade einen Dialog offen hat.
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      // Das Werkzeug schreibt selbst UTF-8 auf stdout. 'buffer' statt 'utf8', weil Node
      // sonst nach der Standard-Codepage decodiert und aus "Übergabe" Mojibake macht.
      encoding: 'buffer',
    }, (err, stdout) => {
      const text = Buffer.from(stdout || '').toString('utf8').trim();
      // Exitcode 3 (Outlook zu) ist kein Absturz, sondern eine Auskunft — das JSON gilt.
      if (err && !text.startsWith('{')) return reject(err);
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(e.message + ' | ' + text.slice(0, 200))); }
    });
  });
}

/* Die Betreffzeile ist die Zeile, die Leonie liest. Praefixe wie "AW:" oder "WG:" stehen
   im Weg: bei drei Antworten auf denselben Thread saehe die Liste dreimal fast gleich aus,
   ohne dass die Praefixe etwas beitragen — die Richtung sagt schon, wer geantwortet hat. */
function betreff(m) {
  return String(m.betreff || '(ohne Betreff)')
    .replace(/^((AW|WG|RE|FW|FWD|AUTOMATISCHE ANTWORT|ANTWORT)\s*:\s*)+/i, '')
    .trim() || '(ohne Betreff)';
}

// Was in der Zeile rechts steht. Ein Wort zur Art, dann die Gegenseite, dann Anhaenge.
function detail(m) {
  const teile = [];
  if (m.art === 'einladung') teile.push('Termineinladung');
  else if (m.art === 'absage') teile.push('Termin abgesagt');
  else if (m.art === 'antwort') teile.push('Terminantwort');
  const gegen = m.richtung === 'sent' ? m.an : (m.von || m.von_mail);
  if (gegen) teile.push((m.richtung === 'sent' ? 'an ' : 'von ') + kurzeNamen(gegen));
  // Namen statt Zahl, wenn es einer ist: "Etappenreview.pptx" sagt mehr als "1 Anhang".
  if (m.anhaenge === 1 && (m.anhang_namen || [])[0]) teile.push(m.anhang_namen[0]);
  else if (m.anhaenge) teile.push(m.anhaenge + ' Anhänge');
  return teile.join(' · ');
}

/* Allianz-Adressbuchnamen sind lang: "Mueller, Marwin (Allianz Services SE)". Bei drei
   Empfaengern sprengt das die Zeile. Also Nachname, Vorname behalten, den Firmenzusatz
   weg, und ab dem dritten Namen zaehlen statt aufzaehlen. */
function kurzeNamen(roh) {
  const namen = String(roh).split(';').map((n) => n.replace(/\s*\([^)]*\)\s*/g, '').trim()).filter(Boolean);
  if (!namen.length) return '';
  if (namen.length <= 2) return namen.join(', ');
  return `${namen[0]} +${namen.length - 1}`;
}

async function poll(log, ersterLauf) {
  if (!fs.existsSync(TOOL)) {
    log('outlook: keine Konfiguration — ' + TOOL + ' nicht gefunden');
    return;
  }
  const stunden = ersterLauf ? FENSTER_START_H : FENSTER_LAUF_H;
  const d = await lauf(['--since-hours', String(stunden), '--limit', '400']);

  if (!d.ok) {
    // "Outlook laeuft nicht" ist der Normalfall am Feierabend und darf nicht wie ein
    // Defekt aussehen. Der Statuspunkt im Panel wird rot, wenn "failed" oder "error" in
    // der Zeile steht — deshalb steht hier keins von beiden.
    const roh = d.fehler || 'nicht gelesen';
    /* Nur der Teil vor dem Gedankenstrich. Die TEXTE-Saetze enden mit einer Handlung ("dann
       noch mal klicken"), und die stimmt nur, wenn Leonie gerade wirklich geklickt hat. Im
       Poll hat niemand geklickt — der Kollektor hat von selbst geschaut. */
    const kurz = (TEXTE[roh] || roh).split(' — ')[0];
    log('outlook: ' + kurz + ' — Panel wartet');
    return;
  }

  let neu = 0;
  for (const m of d.mails || []) {
    if (!m.ts) continue;
    const richtung = m.richtung === 'sent' ? 'gesendet' : 'erhalten';
    if (emit({
      ts: m.ts,
      source: 'outlook',
      action: m.richtung === 'sent' ? 'sent' : 'received',
      title: betreff(m),
      detail: detail(m),
      /* Kein url-Feld. Eine Mail hat keine Adresse, die shell.openExternal versteht;
         geoeffnet wird sie ueber die EntryID im Hauptprozess (ipc 'outlook:open').
         Ein url-Feld zu erfinden hiesse, dem Renderer einen Knopf anzubieten, der
         nichts tut. */
      meta: {
        entryId: m.id,
        art: m.art,
        richtung,
        von: m.von || '',
        vonMail: m.von_mail || '',
        an: m.an || '',
        ordner: m.ordner || '',
        anhaenge: m.anhaenge || 0,
        anhangNamen: m.anhang_namen || [],
        ungelesen: !!m.ungelesen,
        // EntryID waere naheliegend, aendert sich aber, sobald eine Mail in einen
        // anderen Ordner wandert — dann waere dieselbe Mail zweimal im Log. Sekunde
        // plus Richtung plus Betreff bleibt stabil, egal wo sie liegt.
        dedupe: `outlook|${Math.floor(Date.parse(m.ts) / 1000)}|${m.richtung}|${m.betreff}`,
      },
    })) neu += 1;
  }
  const ord = Object.entries(d.ordner || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  log(`outlook: ${(d.mails || []).length} Elemente (${ord}), ${neu} neu`);
}

/* Das Werkzeug schreibt reines ASCII, weil es auch in einer Konsole mit Codepage 850
   laeuft. Seine Fehlertexte landen aber seit dem Klick-Umbau in der Oberflaeche, und dort
   gehoeren Umlaute hin. Also hier uebersetzen statt das Werkzeug umzustellen — und
   gleich mit dem naechsten Schritt dabei, denn "laeuft nicht" allein sagt nicht, was
   Leonie tun soll. */
const TEXTE = {
  'Outlook laeuft nicht': 'Outlook läuft nicht — erst öffnen, dann noch mal klicken',
  'pywin32 fehlt': 'pywin32 fehlt — ohne das Modul kommt das Panel nicht an Outlook',
  'Outlook nicht erreichbar': 'Outlook antwortet nicht (COM) — steht dort ein Dialog offen?',
};

// Eine Mail in Outlook anzeigen. Dasselbe Werkzeug, anderer Schalter.
async function oeffnen(entryId) {
  if (!entryId) return { ok: false, message: 'Keine EntryID' };
  try {
    const d = await lauf(['--open', String(entryId)]);
    if (!d.ok) {
      const roh = d.fehler || 'nicht gefunden';
      return { ok: false, message: TEXTE[roh] || roh };
    }
    // Das Fenster ist offen. Ob es auch vorn liegt, entscheidet Windows und nicht das
    // Werkzeug — deshalb wird die Antwort durchgereicht statt geschluckt. Fehlt das Feld,
    // laeuft eine aeltere Fassung des Werkzeugs: dann nicht meckern.
    return { ok: true, vordergrund: d.vordergrund !== false };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function start(log) {
  let erster = true;
  const run = () => poll(log, erster)
    .then(() => { erster = false; })
    .catch((e) => log('outlook failed: ' + e.message));
  run();
  const t = setInterval(run, POLL_MS);
  return () => clearInterval(t);
}

module.exports = { start, poll, oeffnen, POLL_MS, betreff, kurzeNamen, TOOL };

const { loadState } = require('./emit');

/* ── Teams ist raus, Outlook ist drin (2026-08-20) ──
   Der Teams-Kollektor konnte nie sehen, was in Teams passiert — der Nachrichtenspeicher
   ist eine gesperrte IndexedDB. Er konnte nur merken, wenn Leonie eine Teams-Nachricht
   kopiert. Das ist kein Ereignisstrom, das ist ein Nebeneffekt ihrer eigenen Handbewegung.
   Outlook dagegen laesst sich vollstaendig lesen.

   collectors/teams.js bleibt liegen und wird nicht geloescht: die alten Teams-Ereignisse
   stehen weiter in events.jsonl, die Zeitleiste zeigt sie, und der Renderer traegt das
   "aus Teams"-Kennzeichen weiter. Nur gestartet wird der Kollektor nicht mehr. */
const MODULES = {
  obsidian: { mod: require('./obsidian'), mode: 'live' },
  confluence: { mod: require('./confluence'), mode: 'poll' },
  github: { mod: require('./github'), mode: 'poll' },
  outlook: { mod: require('./outlook'), mode: 'poll' },
  // Arbeitsordner unter Dokumente\Claude. Kam am 20.08.2026 dazu, weil Projektordner ohne
  // HTML — baukasten-slide-confluence — im Panel gar nicht vorkamen.
  arbeit: { mod: require('./arbeit'), mode: 'live' },
  html: { mod: require('./html'), mode: 'live' },
};

const status = {};
const logLines = [];

function pushLog(line) {
  // Lokale Zeit, nicht UTC — sonst passt das Log nicht zu den Zeiten im Panel.
  const stamped = new Date().toLocaleTimeString('de-DE', { hour12: false }) + '  ' + line;
  logLines.push(stamped);
  if (logLines.length > 200) logLines.shift();
  console.log('[collector] ' + stamped);
}

function startAll() {
  loadState();
  const stops = [];
  for (const [name, { mod, mode }] of Object.entries(MODULES)) {
    status[name] = { mode, state: 'start', last: null, message: null };
    const log = (msg) => {
      const failed = /failed|error|nicht gefunden|keine Konfiguration/i.test(msg);
      status[name] = {
        mode,
        state: failed ? 'error' : 'ok',
        last: new Date().toISOString(),
        message: msg,
      };
      pushLog(msg);
    };
    try {
      stops.push(mod.start(log));
    } catch (e) {
      status[name] = { mode, state: 'error', last: new Date().toISOString(), message: e.message };
      pushLog(name + ' start failed: ' + e.message);
    }
  }
  return () => stops.forEach((s) => { try { s(); } catch { /* egal */ } });
}

function getStatus() {
  return { collectors: status, log: logLines.slice(-40) };
}

module.exports = { startAll, getStatus };

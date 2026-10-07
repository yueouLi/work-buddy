#!/usr/bin/env node
/* ── Work Buddy als MCP-Server (Variante C: „Ziehen") ──
   Gegenstueck zu src/auftrag.js. Das dort ist Schieben: das Panel drueckt einen Kontext
   nach data/auftrag.md und legt einen Einfuege-Satz in die Ablage. Hier ist Ziehen: die
   laufende Claude-Sitzung fragt selbst nach, ohne dass Leonie vorher wusste, welche Zeile
   die richtige ist.

   Beides zusammen, aus demselben Grund wie beim Kollektor (Watcher + periodischer Scan):
   Schieben kann nur weitergeben, was man schon gefunden hat. Ziehen kann suchen, weiss
   aber nicht, was gerade wichtig war.

   Drei Entscheidungen, die den Rest erklaeren:

   1. NUR LESEN. Kein Werkzeug hier veraendert etwas — nicht die Mappe, nicht die Sterne,
      nicht den Loeschkorb. Das Panel ist ein Beobachter, und der Server, der es ausliest,
      erst recht. Wer die Mappe aendern will, klickt im Panel; dort steht sichtbar, was
      passiert.
   2. KEINE ABHAENGIGKEIT. Der stdio-Teil von MCP ist zeilenweises JSON-RPC 2.0. Das sind
      hundert Zeilen. Ein `npm install` in diesem Netz ist eine Wette, und ein Server, der
      sich nach jedem Rechnerwechsel erst Pakete holen muss, ist unbenutzbar.
   3. DIESELBEN MODULE WIE DAS PANEL. store, projects, library und dossier werden
      requiriert, nicht nachgebaut. Ein zweiter Begriff von „dieselbe Datei" oder
      „welches Projekt" waere genau der Fehler, den src/auftrag.js schon vermeidet.

   stdout gehoert ausschliesslich dem Protokoll. Jede Diagnose geht nach stderr, sonst
   liest der Client ein halbes JSON-RPC-Paket und bricht die Verbindung ab. */

const fs = require('fs');
const path = require('path');

const WURZEL = path.join(__dirname, '..');
const { readEvents, summarize } = require(path.join(WURZEL, 'src', 'store'));
const projects = require(path.join(WURZEL, 'src', 'projects'));
const library = require(path.join(WURZEL, 'src', 'library'));
const dossier = require(path.join(WURZEL, 'src', 'dossier'));
const auftrag = require(path.join(WURZEL, 'src', 'auftrag'));

const NAME = 'work-buddy';
const VERSION = '0.1.0';
// Wird durch die Version des Clients ersetzt, falls er eine nennt. MCP verhandelt hier,
// und wer stur seine eigene Version zurueckgibt, faellt bei einem neueren Client aus.
const PROTOKOLL_STANDARD = '2025-06-18';

const log = (...a) => process.stderr.write('[work-buddy-mcp] ' + a.join(' ') + '\n');

/* ── Formatierung ──
   Ausgegeben wird Markdown, nicht JSON. Grund: das liest sich im Transcript, und es ist
   dasselbe Format wie data/auftrag.md — eine Antwort aus dem Ziehen und eine aus dem
   Schieben sehen dann nicht wie zwei verschiedene Werkzeuge aus. */

const QUELLE = {
  obsidian: 'Obsidian', confluence: 'Confluence', github: 'GitHub',
  outlook: 'Outlook', arbeit: 'Dateien', html: 'HTML', teams: 'Teams',
};

function zeitDe(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || '—');
  const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getDate())}.${z(d.getMonth() + 1)}.${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

// Pipes in Zellen zerlegen die Tabelle, Zeilenumbrueche erst recht.
function zelle(s) {
  const t = String(s === 0 ? '0' : (s === null || s === undefined || s === '' ? '—' : s));
  return t.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ');
}

function tabelle(kopf, zeilen) {
  if (!zeilen.length) return '';
  return [
    '| ' + kopf.join(' | ') + ' |',
    '|' + kopf.map(() => '---').join('|') + '|',
    ...zeilen.map((z) => '| ' + z.map(zelle).join(' | ') + ' |'),
  ].join('\n');
}

function sterne(n) {
  return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '—';
}

/* ── Zeitraeume ──
   Dieselben Namen wie die Reiter im Panel. Wenn Leonie „diese Woche" sagt, soll die
   Antwort hier dieselbe Menge sein wie die, die sie auf dem Schirm sieht. */
const ZEITRAUM_MS = {
  heute: null, // Sonderfall: ab Mitternacht, nicht 24 Stunden zurueck
  '3tage': 3 * 864e5,
  woche: 7 * 864e5,
  monat: 30 * 864e5,
  alles: Infinity,
};

function abZeitpunkt(zeitraum) {
  if (zeitraum === 'heute') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const ms = ZEITRAUM_MS[zeitraum];
  if (ms === Infinity) return -Infinity;
  return Date.now() - (ms || 7 * 864e5);
}

function projektLabel(id) {
  const p = projects.listProjects().find((x) => x.id === id);
  return p ? p.label : (id || '—');
}

function passtSuche(text, suche) {
  if (!suche) return true;
  return String(text || '').toLowerCase().includes(String(suche).toLowerCase());
}

/* ── Werkzeug 1: Verlauf ── */
function werkzeugVerlauf(a = {}) {
  const zeitraum = a.zeitraum || 'woche';
  const ab = abZeitpunkt(zeitraum);
  const max = Math.min(Math.max(Number(a.max) || 40, 1), 300);

  // roh: true nur, wenn ausdruecklich gewuenscht. Sonst gefaltet wie im Panel — sonst
  // fuellt ein einzelner Sync-Lauf die ganze Antwort mit derselben Minute.
  let ev = readEvents({ roh: a.roh === true });
  ev = ev.filter((e) => Date.parse(e.ts) >= ab);
  if (a.quelle) ev = ev.filter((e) => e.source === a.quelle);
  if (a.projekt) ev = ev.filter((e) => e.project === a.projekt);
  if (a.suche) {
    ev = ev.filter((e) => passtSuche(e.title, a.suche) || passtSuche(e.detail, a.suche)
      || passtSuche(e.meta && e.meta.path, a.suche));
  }

  const gesamt = ev.length;
  const zeilen = ev.slice(0, max).map((e) => [
    zeitDe(e.ts),
    QUELLE[e.source] || e.source,
    e.title,
    e.detail,
    projektLabel(e.project) + (e.fixed ? ' (Hand)' : ''),
  ]);

  const kopf = [`# Verlauf — ${zeitraum}`, ''];
  const filter = [
    a.quelle ? `Quelle ${a.quelle}` : null,
    a.projekt ? `Projekt ${projektLabel(a.projekt)}` : null,
    a.suche ? `Suche „${a.suche}"` : null,
    a.roh === true ? 'ungefaltet' : null,
  ].filter(Boolean);
  if (filter.length) kopf.push('Filter: ' + filter.join(' · '), '');

  if (!gesamt) {
    kopf.push('Keine Treffer. Der Zeitraum ist der wahrscheinlichste Grund — `alles` probieren.');
    return kopf.join('\n');
  }
  // Die Kappung wird genannt, nicht verschwiegen. Eine stille Kuerzung liest sich wie
  // Vollstaendigkeit.
  kopf.push(gesamt > max
    ? `${gesamt} Treffer, die ${max} neuesten stehen hier.`
    : `${gesamt} Treffer.`);
  kopf.push('');
  kopf.push(tabelle(['Zeit', 'Quelle', 'Was', 'Wo', 'Projekt'], zeilen));
  return kopf.join('\n');
}

/* ── Werkzeug 2: Bestand (HTML-Ablage) ──
   Das ist der Teil, den Leonie ausdruecklich gebaut hat, um ein HTML wiederzufinden, das
   irgendwo liegt. Genau die Frage, die man nicht schieben kann — man weiss ja noch nicht,
   welche Datei es ist. */
function werkzeugBestand(a = {}) {
  // 'nie': dieser Prozess scannt die Platte nicht, siehe Kommentar in library.js.
  const b = library.laden('nie');
  let d = b.dateien;
  if (a.kategorie) d = d.filter((x) => passtSuche(x.kategorie, a.kategorie));
  if (a.minSterne) {
    const min = Number(a.minSterne);
    d = d.filter((x) => ((b.meta[x.key] && b.meta[x.key].stern) || 0) >= min);
  }
  if (a.suche) {
    d = d.filter((x) => passtSuche(x.titel, a.suche) || passtSuche(x.kategorie, a.suche)
      || passtSuche(x.pfad, a.suche) || passtSuche(x.beschreibung, a.suche)
      || passtSuche(b.meta[x.key] && b.meta[x.key].notiz, a.suche));
  }
  const max = Math.min(Math.max(Number(a.max) || 30, 1), 200);
  const gesamt = d.length;

  const zeilen = d.slice(0, max).map((x) => [
    x.titel,
    x.kategorie,
    sterne(b.meta[x.key] && b.meta[x.key].stern),
    zeitDe(x.mtime),
    '`' + (x.pfad || '') + '`',
    (b.meta[x.key] && b.meta[x.key].notiz) || '',
  ]);

  const out = ['# Bestand — HTML-Ablage', ''];
  out.push(b.gescannt
    ? `Stand des Plattenscans: ${zeitDe(b.gescannt)}. Dieser Server scannt nicht selbst — `
      + 'wer einen frischeren Stand braucht, drückt im Panel „Neu einlesen".'
    : 'Kein Plattenscan-Index vorhanden. Was hier steht, kommt allein aus den HTML-Ereignissen '
      + 'im Log — unvollständig. Im Panel einmal „Neu einlesen" drücken.');
  out.push('');
  if (!gesamt) {
    out.push('Keine Treffer.');
    return out.join('\n');
  }
  out.push(gesamt > max ? `${gesamt} Treffer, die ${max} zuletzt geänderten stehen hier.` : `${gesamt} Treffer.`);
  out.push('');
  out.push(tabelle(['Titel', 'Schublade', 'Sterne', 'Geändert', 'Pfad', 'Notiz'], zeilen));

  if (!a.suche && !a.kategorie && b.kategorien.length) {
    out.push('', '## Schubladen', '');
    out.push(tabelle(['Schublade', 'Dateien', 'davon bewertet'],
      b.kategorien.map((k) => [k.name, k.anzahl, k.bewertet])));
  }
  return out.join('\n');
}

/* ── Werkzeug 3: Kontext-Mappe ── */
function werkzeugMappe(a = {}) {
  const ids = a.projekt ? [a.projekt] : projects.listProjects().map((p) => p.id);
  const out = [];
  let irgendwas = false;

  for (const id of ids) {
    const d = dossier.read(id);
    if (!d.entries.length) continue;
    irgendwas = true;
    out.push(`## ${projektLabel(id)} (\`${id}\`) — ${d.entries.length} Einträge`);
    out.push(d.updated ? `Zuletzt geändert: ${zeitDe(d.updated)}` : '');
    out.push('');
    // Ohne Zweck nach vorn: das sind die Stellen, an denen nachgefragt werden muss.
    const sortiert = [...d.entries].sort((x, y) => (x.zweck ? 1 : 0) - (y.zweck ? 1 : 0));
    out.push(tabelle(['Rolle', 'Was', 'Wofür', 'Stand', 'Verweis'], sortiert.map((e) => [
      e.rolle,
      e.title,
      e.zweck,
      e.stand,
      e.kind === 'vault' ? '`' + path.join(dossier.VAULT, e.ref) + '`'
        : (e.kind === 'file' ? '`' + path.normalize(e.ref) + '`' : (e.url || e.ref)),
    ])));
    const ohne = d.entries.filter((e) => !e.zweck).length;
    if (ohne) {
      out.push('', `> [!warning] ${ohne} von ${d.entries.length} Einträgen haben keinen Zweck`,
        '> Wofür sie in der Mappe liegen, ist nicht hinterlegt. Nicht raten — nachfragen oder',
        '> aus dem Inhalt begründen und die Begründung kennzeichnen.');
    }
    out.push('');
  }

  if (!irgendwas) {
    return ['# Kontext-Mappen', '',
      a.projekt ? `Die Mappe von „${projektLabel(a.projekt)}" ist leer.` : 'Alle Mappen sind leer.',
      '', 'Gefüllt wird sie im Panel: Dateien in die Fläche ziehen oder einen Link einfügen.',
    ].join('\n');
  }
  return ['# Kontext-Mappen', '', ...out].join('\n');
}

/* ── Werkzeug 4: Projekte ── */
function werkzeugProjekte() {
  const ev = readEvents();
  const zahl = {};
  for (const e of ev) zahl[e.project] = (zahl[e.project] || 0) + 1;

  const s = summarize(ev);
  const out = ['# Projekte', ''];
  out.push(tabelle(['id', 'Projekt', 'Auftraggeber', 'Ereignisse', 'Mappe', 'Vault-Ordner'],
    projects.listProjects().map((p) => [
      '`' + p.id + '`',
      p.label + (p.rest ? ' (Auffangbecken)' : ''),
      p.auftraggeber,
      zahl[p.id] || 0,
      dossier.read(p.id).entries.length,
      p.vaultDir,
    ])));
  out.push('', '## Gesamt', '');
  out.push(tabelle(['Kennzahl', 'Wert'], [
    ['Ereignisse insgesamt', ev.length],
    ['Heute', s.today],
    ['Quellen', Object.entries(s.bySource).filter(([, n]) => n > 0)
      .map(([k, n]) => `${QUELLE[k] || k} ${n}`).join(', ')],
  ]));
  return out.join('\n');
}

/* ── Werkzeug 5: die uebergebene Datei ──
   Verbindet Ziehen und Schieben. Wenn Leonie den Einfuege-Satz benutzt hat, steht die Marke
   darin, und ich kann hier pruefen, ob die Datei noch dieselbe ist. */
function werkzeugAuftrag() {
  if (!fs.existsSync(auftrag.AUFTRAG_FILE)) {
    return 'Es liegt keine Übergabe vor. Sie entsteht erst, wenn im Panel „→C" an einer Zeile '
      + 'oder „An Claude übergeben" an der Kontext-Mappe gedrückt wird.';
  }
  const text = fs.readFileSync(auftrag.AUFTRAG_FILE, 'utf8');
  const m = text.match(/^marke:\s*(\w+)/m);
  const kopf = `> Datei: \`${auftrag.AUFTRAG_FILE}\`\n> Marke: ${m ? m[1] : 'unbekannt'} — `
    + 'mit der Marke im eingefügten Satz vergleichen; stimmen sie nicht überein, ist diese '
    + 'Datei neuer als der Auftrag.\n\n';
  return kopf + text;
}

/* ── Werkzeugliste ──
   Die Beschreibungen sind das eigentliche Interface: danach entscheidet ein Modell, ob es
   ein Werkzeug ueberhaupt anfasst. Deshalb steht in jeder nicht nur was sie tut, sondern
   wofuer man sie nimmt. */
const WERKZEUGE = [
  {
    name: 'wb_verlauf',
    description: 'Was Leonie wann getan hat, über alle Quellen (Obsidian, Confluence, GitHub, '
      + 'Outlook, Dateien in Dokumente\\Claude, verstreute HTML-Dateien). Nimm das für Fragen '
      + 'wie „woran habe ich gestern gearbeitet", „was ist um die Zeit sonst passiert", '
      + '„welche Datei habe ich zu dem Thema angefasst". Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        zeitraum: {
          type: 'string', enum: ['heute', '3tage', 'woche', 'monat', 'alles'],
          description: 'Standard: woche. Dieselben Stufen wie die Reiter im Panel.',
        },
        quelle: {
          type: 'string',
          enum: ['obsidian', 'confluence', 'github', 'outlook', 'arbeit', 'html', 'teams'],
          description: 'Nur eine Quelle. arbeit = Dateien in Dokumente\\Claude. '
            + 'teams ist seit 20.08.2026 stillgelegt, alte Ereignisse sind noch da.',
        },
        projekt: { type: 'string', description: 'Projekt-id, siehe wb_projekte.' },
        suche: { type: 'string', description: 'Freitext in Titel, Ordner und Pfad.' },
        max: { type: 'number', description: 'Standard 40, höchstens 300.' },
        roh: {
          type: 'boolean',
          description: 'true = ohne Bündelung von Massenläufen. Standard false, weil sonst ein '
            + 'einzelner Sync-Lauf die Antwort füllt.',
        },
      },
    },
  },
  {
    name: 'wb_bestand',
    description: 'Die HTML-Ablage: alle auf diesem Rechner verstreuten HTML-Artefakte (Decks, '
      + 'Übersichten, Auswertungen) mit Schublade, Sternen, eigener Notiz und absolutem Pfad. '
      + 'Nimm das, wenn eine bestimmte HTML-Datei gesucht wird und der Pfad unbekannt ist. '
      + 'Read-only, dieser Server scannt die Platte nicht.',
    inputSchema: {
      type: 'object',
      properties: {
        suche: { type: 'string', description: 'Freitext in Titel, Schublade, Pfad, Beschreibung, Notiz.' },
        kategorie: { type: 'string', description: 'Schublade (Ordnername).' },
        minSterne: { type: 'number', description: 'Nur ab dieser Bewertung (1–5).' },
        max: { type: 'number', description: 'Standard 30, höchstens 200.' },
      },
    },
  },
  {
    name: 'wb_mappe',
    description: 'Die Kontext-Mappe eines Projekts: was Leonie selbst als zugehörig markiert '
      + 'hat, mit Rolle, Zweck und Stand. Das ist ihre Auswahl, nicht meine Ableitung — nimm '
      + 'sie, bevor du selbst zusammensuchst, was zu einem Projekt gehört. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        projekt: { type: 'string', description: 'Projekt-id. Ohne Angabe alle nicht-leeren Mappen.' },
      },
    },
  },
  {
    name: 'wb_projekte',
    description: 'Alle Projekte mit id, Auftraggeber, Zahl der Ereignisse, Größe der Mappe und '
      + 'Vault-Zielordner, dazu Gesamtzahlen. Zuerst aufrufen, wenn eine Projekt-id für die '
      + 'anderen Werkzeuge gebraucht wird. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wb_auftrag',
    description: 'Liest die zuletzt aus dem Panel übergebene Datei (data/auftrag.md) samt Marke. '
      + 'Nimm das, wenn Leonie einen Satz eingefügt hat, der auf „Marke ..." verweist, oder '
      + 'wenn sie sagt, sie habe etwas übergeben. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const AUSFUEHREN = {
  wb_verlauf: werkzeugVerlauf,
  wb_bestand: werkzeugBestand,
  wb_mappe: werkzeugMappe,
  wb_projekte: werkzeugProjekte,
  wb_auftrag: werkzeugAuftrag,
};

/* ── JSON-RPC 2.0 ueber stdio ── */

let protokoll = PROTOKOLL_STANDARD;

function senden(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function antwort(id, result) {
  // Eine Notification hat keine id und darf keine Antwort bekommen.
  if (id === undefined || id === null) return;
  senden({ jsonrpc: '2.0', id, result });
}

function fehler(id, code, message) {
  if (id === undefined || id === null) return;
  senden({ jsonrpc: '2.0', id, error: { code, message } });
}

function behandeln(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    // Die Version des Clients uebernehmen, wenn er eine nennt.
    const v = params && params.protocolVersion;
    if (typeof v === 'string' && v) protokoll = v;
    log('initialize von', (params && params.clientInfo && params.clientInfo.name) || 'unbekannt',
      '· Protokoll', protokoll);
    antwort(id, {
      protocolVersion: protokoll,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
      instructions: 'Work Buddy liest Leonies Aktivität auf diesem Rechner zusammen. Alle '
        + 'Werkzeuge sind read-only: sie ändern weder Mappe noch Bewertungen noch Dateien. '
        + 'Pfade in den Antworten sind absolut und lokal gültig.',
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { antwort(id, {}); return; }

  if (method === 'tools/list') { antwort(id, { tools: WERKZEUGE }); return; }

  if (method === 'tools/call') {
    const name = params && params.name;
    const fn = AUSFUEHREN[name];
    if (!fn) { fehler(id, -32602, 'Unbekanntes Werkzeug: ' + name); return; }
    try {
      const text = fn((params && params.arguments) || {});
      antwort(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      /* Als Ergebnis mit isError, nicht als JSON-RPC-Fehler: dann sieht das Modell den Text
         und kann es anders versuchen, statt nur „tool failed" zu bekommen. */
      log('Werkzeug', name, 'gescheitert:', err.stack || err.message);
      antwort(id, {
        content: [{ type: 'text', text: `${name} ist gescheitert: ${err.message}` }],
        isError: true,
      });
    }
    return;
  }

  // Prompts und Resources gibt es hier nicht. Die Methoden werden trotzdem hoeflich
  // beantwortet, weil manche Clients sie beim Verbinden blind aufrufen.
  if (method === 'prompts/list') { antwort(id, { prompts: [] }); return; }
  if (method === 'resources/list') { antwort(id, { resources: [] }); return; }

  fehler(id, -32601, 'Methode nicht unterstützt: ' + method);
}

let puffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  puffer += d;
  /* Zeilenweise. Die letzte Teilzeile bleibt im Puffer stehen — ein Paket kann in zwei
     data-Ereignissen ankommen, und wer das nicht puffert, verliert genau die langen. */
  let i;
  while ((i = puffer.indexOf('\n')) >= 0) {
    const zeile = puffer.slice(0, i).trim();
    puffer = puffer.slice(i + 1);
    if (!zeile) continue;
    let msg;
    try {
      msg = JSON.parse(zeile);
    } catch (err) {
      log('unlesbare Zeile verworfen:', err.message);
      continue;
    }
    try {
      behandeln(msg);
    } catch (err) {
      log('Fehler in behandeln:', err.stack || err.message);
      fehler(msg && msg.id, -32603, err.message);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
log('bereit ·', WERKZEUGE.length, 'Werkzeuge · nur lesend · Wurzel', WURZEL);

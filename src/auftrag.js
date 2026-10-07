/* ── Übergabe an Claude ──
   Warum eine Datei und keine eingebaute Chatbox: das Panel ist ein Beobachter. Es liest,
   es zeigt, und es fasst nichts an ausser dem Löschkorb — der fragt zweimal und schiebt in
   den Windows-Papierkorb. Eine Chatbox mit einem Agenten dahinter würde daraus einen
   Ausführenden machen, mit eigener Rechteverwaltung, eigener Rückfrage-Logik und eigenem
   Prüfpfad. Das ist ein zweites Werkzeug, nicht ein Knopf.

   Was hier stattdessen passiert: das Panel schreibt den Kontext, den es sowieso schon hat,
   in eine Datei, und legt einen Satz in die Ablage, der auf diese Datei zeigt. Leonie fügt
   den Satz in ihre laufende Claude-Sitzung ein und tippt dahinter, was sie will. Der Teil,
   der bisher fehlte, war nie das Eingabefeld — es war das Erklären, um welches Ding es geht.

   Die Datei wird bei jedem Klick überschrieben. Damit ein alter Einfüge-Satz nicht auf
   neuen Inhalt zeigt, steht in beiden dieselbe Marke: vier Hexzeichen aus dem Inhalt.
   Passt sie nicht, ist die Datei neuer als der Auftrag — und Claude sagt das, statt am
   falschen Ding zu arbeiten. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readEvents } = require('./store');
const dossier = require('./dossier');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Liegt in data/, und data/ steht in SKIP_DIR des arbeit-Kollektors. Ohne das würde jeder
// Klick auf "Claude" ein Ereignis erzeugen, das im Panel als eigene Zeile auftaucht.
const AUFTRAG_FILE = path.join(DATA_DIR, 'auftrag.md');

// Wie weit um das Ereignis herum geschaut wird. Eine halbe Stunde ist die Spanne, in der
// Dinge zusammengehören: dieselbe Sitzung, dasselbe Thema. Länger, und es kommt Rauschen
// aus dem nächsten Thema mit.
const NACHBAR_MIN = 30;
const NACHBAR_MAX = 12;

const QUELLE = {
  obsidian: 'Obsidian', confluence: 'Confluence', github: 'GitHub',
  outlook: 'Outlook', arbeit: 'Dateien', html: 'HTML', teams: 'Teams',
};

function zeitDe(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || '');
  const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getDate())}.${z(d.getMonth() + 1)}.${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

function iso() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const vz = off >= 0 ? '+' : '-';
  const oh = z(Math.floor(Math.abs(off) / 60));
  const om = z(Math.abs(off) % 60);
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T`
    + `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}${vz}${oh}:${om}`;
}

function zelle(s) {
  return String(s === 0 ? '0' : (s || '—')).replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ');
}

function tabelle(paare) {
  const zeilen = ['| Feld | Wert |', '|---|---|'];
  for (const [k, v] of paare) {
    if (v === '' || v === null || v === undefined) continue;
    zeilen.push(`| ${zelle(k)} | ${zelle(v)} |`);
  }
  return zeilen.join('\n');
}

/* Welchen Weg das Panel beim Klick nimmt. Steht mit drin, weil es die häufigste Rückfrage
   beantwortet, bevor sie kommt: womit soll das geöffnet werden. Die Reihenfolge ist
   dieselbe wie im Renderer (Protokoll vor Pfad) — siehe Abschnitt 23 der Doku. */
function oeffnenWeg(k) {
  if (k.url && /^obsidian:/i.test(k.url)) return `Obsidian — \`${k.url}\``;
  if (k.pfad) return `Standardprogramm — \`${k.pfad}\``;
  if (k.url) return `Browser — ${k.url}`;
  if (k.entryId) return 'Outlook, über die EntryID (nur auf diesem Rechner auffindbar)';
  return '';
}

/* ── Nachbarschaft ──
   Das ist der Teil, den ein Eingabefeld im Panel nicht besser könnte: was in denselben
   Minuten sonst passiert ist. Genau daran hängt meistens die Frage — die Notiz, die
   gleichzeitig entstand, die Mail, die es ausgelöst hat. */
function nachbarn(ts, selbstKey) {
  const mitte = Date.parse(ts);
  if (Number.isNaN(mitte)) return [];
  const spanne = NACHBAR_MIN * 60 * 1000;
  const treffer = readEvents({ roh: true }).filter((e) => {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t) || Math.abs(t - mitte) > spanne) return false;
    return `${e.source}|${e.ts}|${e.title}` !== selbstKey;
  });
  /* Gekappt wird nach Naehe, nicht nach Neuheit. readEvents liefert absteigend sortiert;
     ein einfaches slice() haette die 12 juengsten genommen und damit an einem geschaeftigen
     Nachmittag alles verworfen, was VOR dem Ereignis lag — also genau die Haelfte, in der
     die Ursache steht. Danach wieder chronologisch, weil sich das so liest. */
  return treffer
    .sort((a, b) => Math.abs(Date.parse(a.ts) - mitte) - Math.abs(Date.parse(b.ts) - mitte))
    .slice(0, NACHBAR_MAX)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .map((e) => `| ${zelle(zeitDe(e.ts))} | ${zelle(QUELLE[e.source] || e.source)} | `
      + `${zelle(e.title)} | ${zelle(e.detail)} |`);
}

const KOPF = [
  '> [!info] Woher diese Datei kommt',
  '> Work Buddy hat sie beim Klick auf „Claude" geschrieben. Sie wird bei **jedem** Klick',
  '> überschrieben. Vergleich die Marke unten mit der Marke in Leonies eingefügtem Satz:',
  '> stimmen sie nicht überein, ist diese Datei neuer als der Auftrag — dann sag das,',
  '> statt am falschen Ding zu arbeiten.',
  '> Alle Pfade sind absolut und auf diesem Rechner gültig. Verweise, keine Kopien.',
].join('\n');

function bauZeile(k) {
  const teile = [];
  teile.push(`# Übergabe aus Work Buddy — ${k.titel || 'ohne Titel'}`);
  teile.push('');
  teile.push(KOPF);
  teile.push('');
  teile.push('## Um dieses Ding geht es');
  teile.push('');
  teile.push(tabelle([
    ['Quelle', `${QUELLE[k.source] || k.source}${k.action ? ' · ' + k.action : ''}`],
    // Der Zeitstempel gewinnt gegen den Tooltip-Text der Zeile. Der Tooltip ist ein
    // Locale-String („21.8.2026, 14:19:35") und stand damit in anderem Format da als die
    // Nachbarschaftstabelle unten — zwei Schreibweisen fuer dieselbe Minute im selben
    // Dokument. Der Tooltip bleibt Rueckfall, falls eine Quelle keinen ts mitgibt.
    ['Wann', Number.isNaN(Date.parse(k.ts)) ? (k.zeit || '') : zeitDe(k.ts)],
    ['Titel', k.titel],
    ['Ordner', k.ordner],
    ['Datei', k.pfad ? '`' + k.pfad + '`' : ''],
    ['Öffnen', oeffnenWeg(k)],
    ['Projekt', k.projekt ? `${k.projekt}${k.fix ? ' (von Hand zugeordnet)' : ' (nach Regel)'}` : ''],
    ['Bewertung', k.stern ? '★'.repeat(k.stern) + '☆'.repeat(5 - k.stern) : ''],
  ]));
  teile.push('');

  if (k.notiz) {
    teile.push('## Was Leonie selbst dazu notiert hat');
    teile.push('');
    // Wörtlich. Das ist ihr Text, nicht meiner — nichts glätten, nichts kürzen.
    teile.push(k.notiz);
    teile.push('');
  }

  const nb = nachbarn(k.ts, `${k.source}|${k.ts}|${k.titel}`);
  if (nb.length) {
    teile.push(`## Was in denselben ±${NACHBAR_MIN} Minuten sonst passiert ist`);
    teile.push('');
    teile.push('Korrelation, keine Kausalität — es steht hier, weil es zeitlich zusammenfällt.');
    teile.push('');
    teile.push('| Zeit | Quelle | Was | Wo |');
    teile.push('|---|---|---|---|');
    teile.push(...nb);
    teile.push('');
  }
  return teile.join('\n');
}

// Vault-Verweise sind vault-relativ gespeichert. Claude braucht den absoluten Pfad, sonst
// muss es raten, wo der Vault liegt.
function absRef(e) {
  if (e.kind === 'vault') return path.join(dossier.VAULT, e.ref);
  if (e.kind === 'file') return path.normalize(e.ref);
  return '';
}

function bauMappe(projekt, entries) {
  const teile = [];
  teile.push(`# Übergabe aus Work Buddy — Kontext-Mappe ${projekt.label}`);
  teile.push('');
  teile.push(KOPF);
  teile.push('');
  teile.push(tabelle([
    ['Projekt', projekt.label],
    ['Auftraggeber', projekt.auftraggeber],
    ['Einträge', entries.length],
    ['Vault-Ordner', projekt.vaultDir],
  ]));
  teile.push('');

  const ohne = entries.filter((e) => !e.zweck);
  if (ohne.length) {
    // Zuerst, nicht als Fussnote: ein Eintrag ohne Zweck ist die Stelle, an der Claude
    // nachfragen muss, statt sich einen Zweck auszudenken.
    teile.push(`> [!warning] ${ohne.length} von ${entries.length} Einträgen haben keinen Zweck`);
    teile.push('> Bei denen ist nicht hinterlegt, wofür sie in der Mappe liegen. Nicht raten —');
    teile.push('> nachfragen oder aus dem Inhalt begründen und die Begründung kennzeichnen.');
    teile.push('');
  }

  teile.push('## Die Mappe');
  teile.push('');
  teile.push('| Rolle | Was | Wofür | Stand | Verweis |');
  teile.push('|---|---|---|---|---|');
  const sortiert = [...entries].sort((a, b) => (a.zweck ? 1 : 0) - (b.zweck ? 1 : 0));
  for (const e of sortiert) {
    const abs = absRef(e);
    const verweis = abs ? '`' + abs + '`' : (e.url || e.ref);
    teile.push(`| ${zelle(e.rolle)} | **${zelle(e.title)}** | ${zelle(e.zweck)} `
      + `| ${zelle(e.stand)} | ${zelle(verweis)} |`);
  }
  teile.push('');
  return teile.join('\n');
}

/* Schreibt die Datei und gibt den Satz zurück, der in die Ablage geht. Der Satz endet
   absichtlich mit „Mein Auftrag: " — nach dem Einfügen steht der Cursor genau dort, wo
   Leonie weiterschreibt. Ein Knopf, der ihr das Tippen der Anweisung abnimmt, wäre
   geraten; die Anweisung ist der eine Teil, den nur sie kennt. */
function schreibe(art, titel, koerper) {
  const marke = crypto.createHash('sha1').update(koerper).digest('hex').slice(0, 4);
  const text = [
    '---',
    `erzeugt: ${iso()}`,
    `marke: ${marke}`,
    `art: ${art}`,
    'quelle: Work Buddy',
    '---',
    '',
    koerper,
  ].join('\n');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUFTRAG_FILE, text, 'utf8');

  const zeile = `Lies zuerst ${AUFTRAG_FILE} (Marke ${marke}) — dort steht der Kontext, `
    + `den Work Buddy übergibt: „${titel}". Mein Auftrag: `;
  return { ok: true, file: AUFTRAG_FILE, marke, zeile, titel };
}

function ausZeile(karte) {
  if (!karte || typeof karte !== 'object') return { ok: false, message: 'Keine Zeile übergeben' };
  const titel = karte.titel || 'ohne Titel';
  return schreibe('zeile', titel, bauZeile(karte));
}

function ausMappe(projekt) {
  if (!projekt) return { ok: false, message: 'Unbekanntes Projekt' };
  const d = dossier.read(projekt.id);
  if (!d.entries.length) {
    return { ok: false, message: 'Mappe ist leer — erst Einträge hineinlegen, dann übergeben.' };
  }
  return schreibe('mappe', `Kontext-Mappe ${projekt.label}`, bauMappe(projekt, d.entries));
}

module.exports = { ausZeile, ausMappe, AUFTRAG_FILE, NACHBAR_MIN };

const SOURCES = {
  obsidian: { label: 'Obsidian', color: 'var(--obsidian-color)' },
  confluence: { label: 'Confluence', color: 'var(--confluence-color)' },
  github: { label: 'GitHub', color: 'var(--github-color)' },
  outlook: { label: 'Outlook', color: 'var(--outlook-color)' },
  // Kurzes Etikett mit Absicht: "Arbeitsordner" ist 13 Zeichen und schiebt den
  // Status-Marker (live) aus der 152px breiten Kachel heraus — nachgemessen, 23px standen
  // ueber dem Rand. Was die Quelle genau umfasst, sagt der Tooltip der Kachel und die
  // Ordnerspalte jeder Zeile.
  arbeit: { label: 'Dateien', color: 'var(--arbeit-color)' },
  html: { label: 'HTML', color: 'var(--html-color)' },
  // Teams wird nicht mehr gesammelt, die Kachel bleibt aber: ohne sie waeren die alten
  // Teams-Ereignisse im Log nicht mehr ein- und ausschaltbar. Siehe collectors/index.js.
  teams: { label: 'Teams', color: 'var(--teams-color)' },
};

/* Quellen, die es einmal gab. Der Kollektor laeuft nicht mehr, die Ereignisse bleiben.
   Steht hier und nicht in collectors/index.js, weil es eine Aussage ueber die Anzeige ist:
   die Kachel muss erklaeren, warum die Zahl nicht mehr waechst. */
const STILLGELEGT = {
  teams: 'Nicht mehr erfasst. Der Teams-Nachrichtenspeicher ist nicht lesbar, erfasst wurde '
    + 'nur das Kopieren einer Nachricht. Seit 20.08.2026 ist Outlook an der Stelle.',
};

const ACTIONS = {
  created: 'neu',
  updated: 'bearbeitet',
  push: 'Push',
  create: 'angelegt',
  pullrequest: 'PR',
  copied: 'kopiert',
  received: 'erhalten',
  sent: 'gesendet',
};

const RANGE_DAYS = { today: 1, '3days': 3, week: 7, month: 30, all: null };

let allEvents = [];
let summary = null;
let status = { collectors: {}, log: [] };
let range = 'week';
let query = '';
const hidden = new Set();

// Projektfilter. null heisst "alle" — bewusst kein Eintrag "Alle" in der Liste, der
// Zurueck-Weg ist ein zweiter Klick auf das aktive Projekt oder der Reset im Kopf.
let projects = [];
let projectsNote = '';
let projectsFile = '';
let project = null;
/* ── Eine Liste, drei Gruppierungen ──
   'zeit'      = Verlauf: eine Zeile pro Ereignis, nach Tag, alle fuenf Quellen.
                 "Was ist passiert."
   'kategorie' = HTML-Ablage: eine Zeile pro HTML-Datei, nach Ordner. "Wo liegt das HTML."
   'stern'     = HTML-Ablage, nach eigener Bewertung.

   Das war bis 2026-08-20 ein eigener Reiter "Bibliothek" mit eigenen Zeilen, eigener Suche
   und eigenen Sternen. Genau daran hat sich der Bruch gezeigt: eine Datei hatte im Verlauf
   keine Sterne und in der Bibliothek fuenf. Es ist dieselbe Datei. Also dieselbe Zeile,
   dieselben Knoepfe, nur eine andere Reihenfolge.

   Die zweite Korrektur am selben Tag betrifft den Umfang: die Ablage ist ausschliesslich
   fuer HTML. Ihr Zweck ist "wenn ich ploetzlich ein bestimmtes HTML brauche, es schnell
   finden" — kein zweites Inventar fuer Confluence-Seiten und Vault-Notizen. Die haben ihr
   eigenes Zuhause; verstreute HTML-Artefakte haben keins. */
let groupBy = 'zeit';

// Ablage-Modus = alles ausser 'zeit'. Steht an einer Stelle, weil sonst drei Stellen die
// Frage "ist das der Verlauf?" jede fuer sich beantworten.
const istAblage = () => groupBy !== 'zeit';

// Bestand aus dem Hauptprozess: Dinge, Kategorien und die Bewertungen dazu. Wird in load()
// mitgeladen, nicht erst beim Hinsehen — sonst haette der halbe Bildschirm einen anderen
// Aktualitaetsstand als der andere.
let lib = { gescannt: '', dateien: [], kategorien: [], meta: {}, verwaist: [], orte: [] };
let libByKey = new Map();
let libFilter = 'alle';
let libCat = null;
/* Schubladenleiste zugeklappt: als die Ablage noch alle Quellen aufgenommen hat, waren es 55
   Kategorien — acht Zeilen Chips, und die Liste stand darunter ausserhalb des Bildes. HTML
   allein sind deutlich weniger, die Deckelung bleibt trotzdem: zwei Zeilen sind die
   Navigation, alles darunter ist die Liste. Die Liste ist der Inhalt, die Schublade nur der
   Weg dorthin. */
let katsAuf = false;
// Ausgeklappte Vorschau bzw. offenes Notizfeld, beides ueber den Sach-Schluessel. Vorher
// stand hier der Dateipfad — damit war die Vorschau an HTML gebunden.
const offen = new Set();
const notizOffen = new Set();
// Anzahl der Handzuordnungen und die Rueckmeldung der letzten — beide stehen im Fuss der
// Schiene, weil die Aktion dort endet.
let fixedCount = 0;
let assignNote = '';

function projectCfg(id) {
  return projects.find((p) => p.id === id) || { id, label: id || '—', color: 'var(--text-muted)', hint: '' };
}

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rangeStart() {
  const days = RANGE_DAYS[range];
  if (!days) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

// opts.ignoreProject: fuer die Zaehler in der Schiene — dort muss jedes Projekt seine
// eigene Zahl im aktuellen Zeitraum zeigen, auch wenn gerade ein anderes gefiltert ist.
function visibleEvents(opts = {}) {
  const from = rangeStart();
  const q = query.trim().toLowerCase();
  return allEvents.filter((e) => {
    if (hidden.has(e.source)) return false;
    if (!opts.ignoreProject && project && e.project !== project) return false;
    if (from && new Date(e.ts) < from) return false;
    if (q && !(`${e.title} ${e.detail || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - new Date(ts)) / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `vor ${h} h`;
  const d = Math.round(h / 24);
  return `vor ${d} Tag${d === 1 ? '' : 'en'}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayLabel(key) {
  const today = dayKey(Date.now());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === today) return 'Heute';
  if (key === dayKey(y)) return 'Gestern';
  return new Date(key + 'T12:00:00').toLocaleDateString('de-DE', {
    weekday: 'long', day: '2-digit', month: '2-digit',
  });
}

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/* ── Projektschiene ── */
function renderProjects() {
  const scope = visibleEvents({ ignoreProject: true });
  const counts = new Map();
  for (const e of scope) {
    const n = counts.get(e.project) || 0;
    counts.set(e.project, n + (e.batch || 1));
  }

  // Reihenfolge: aktive Projekte im Zeitraum zuerst, absteigend nach Menge. Leere
  // Projekte rutschen nach unten, bleiben aber sichtbar. "Sonstiges" steht immer unten,
  // auch wenn es die groesste Zahl hat — die Schiene zeigt Projekte, nicht Restmengen.
  const sorted = [...projects].sort((a, b) => (a.rest ? 1 : 0) - (b.rest ? 1 : 0)
    || (counts.get(b.id) || 0) - (counts.get(a.id) || 0));

  $('projectRail').innerHTML = sorted.map((p) => {
    const n = counts.get(p.id) || 0;
    const last = allEvents.find((e) => e.project === p.id);
    const cls = ['rail-item'];
    if (p.id === project) cls.push('active');
    if (!n) cls.push('empty');
    const tip = [
      p.label,
      p.auftraggeber ? `Auftrag von ${p.auftraggeber}` : '',
      p.hint,
      n ? `${n} Aktionen im Zeitraum` : 'keine Aktion im Zeitraum',
    ].filter(Boolean).join('\n');
    return `
      <div class="${cls.join(' ')}" style="--proj:${p.color}" data-proj="${esc(p.id)}"
           title="${esc(tip)}">
        <span class="ri-dot"></span>
        <span class="ri-label">${esc(p.label)}</span>
        <span class="ri-count">${n || '–'}</span>
        <span class="ri-sub">
          ${p.auftraggeber ? `<span class="ri-person">${esc(p.auftraggeber)}</span>` : ''}
          <span class="ri-last">${last ? timeAgo(last.ts) : 'noch nichts'}</span>
        </span>
      </div>`;
  }).join('');

  $('projectRail').querySelectorAll('.rail-item').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.proj;
      project = project === id ? null : id;
      await loadMappe();
      renderAll();
    };

    // Ziel fuer die Handzuordnung. dragover muss preventDefault rufen, sonst lehnt der
    // Browser den Drop ab.
    el.ondragover = (ev) => {
      if (!dragged) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      el.classList.add('drop');
    };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = async (ev) => {
      if (!dragged) return;
      ev.preventDefault();
      el.classList.remove('drop');
      const e = dragged;
      dragged = null;
      // Gebuendelte Zeile steht fuer viele Dateien — die haengen nur als Ordner sinnvoll um.
      // Shift beim Fallenlassen macht das auch bei einer einzelnen Zeile.
      const scope = e.batch || ev.shiftKey ? 'ordner' : 'datei';
      const res = await window.buddy.assign(dragPayload(e), el.dataset.proj, scope);
      if (res && res.ok) {
        assignNote = `${e.batch ? 'Ordner' : e.title} → ${projectCfg(el.dataset.proj).label}`
          + (scope === 'ordner' ? ' (ganzer Ordner)' : '');
        await load();
      } else if (res) {
        assignNote = res.message || 'Zuordnung fehlgeschlagen';
        renderProjects();
      }
    };
  });

  $('projectReset').hidden = !project;

  const foot = $('projectFoot');
  foot.classList.toggle('err', Boolean(projectsNote));
  /* Wie viele Zeilen im aktuellen Zeitraum nur geraten sind. Dieselbe Menge, die die Schienen
     zaehlen (ignoreProject, sonst haengt die Zahl am gerade gewaehlten Projekt). Die Zahl steht
     hier, weil eine hohe Ratequote das Signal ist, eine Regel zu schaerfen — im August 2026
     waren 53 Seiten allein wegen "Space AIPC" bei Thorsten gelandet. */
  const sichtbar = visibleEvents({ ignoreProject: true });
  const geraten = sichtbar.filter((e) => e.geraten).length;
  foot.innerHTML = (projectsNote ? `${esc(projectsNote)}<br>` : '')
    + (assignNote ? `<span class="foot-ok">${esc(assignNote)}</span><br>` : '')
    + 'Zuordnung nach Struktur: Vault-Ordner, Pfad, Confluence-Baum, Repo, Absender.<br>'
    + 'Bleibt nur ein Wort im Titel oder der Space, steht ein <span class="fr-geraten">?</span> '
    + 'in der Zeile. Grund im Tooltip des Farbstreifens.<br>'
    + 'Wiederverwendbares Material innerhalb eines Projekts (z.B. Baukasten-Vorlagen) trägt '
    + '<span class="fr-infra">infra</span> — Zuordnung bleibt sicher, ist nur keine Lieferung.<br>'
    + (geraten ? `${geraten} von ${sichtbar.length} Zeilen im Zeitraum sind geraten.<br>` : '')
    + 'Falsch einsortiert? Zeile aus dem Verlauf hierher ziehen. Mit Shift den ganzen Ordner.<br>'
    + (fixedCount ? `${fixedCount} Zuordnung(en) von Hand.<br>` : '')
    + '<button class="foot-link" id="projectEdit" type="button">Projekte bearbeiten</button>';
  const edit = $('projectEdit');
  if (edit) {
    edit.onclick = () => {
      if (projectsFile) window.buddy.openFile(projectsFile);
    };
    edit.title = projectsFile || '';
  }
}

/* ── Quellen-Kacheln ── */
function renderSources() {
  const evs = visibleEvents();
  const from = rangeStart();
  // Der Projektfilter wirkt auch auf die Quellen-Zahlen: sonst zeigt die Kachel 40
  // Obsidian-Events, waehrend im Verlauf 3 stehen.
  const inScope = allEvents.filter((e) => !project || e.project === project);
  const inRange = inScope.filter((e) => !from || new Date(e.ts) >= from);

  $('sourceRow').innerHTML = Object.entries(SOURCES).map(([key, cfg]) => {
    const mine = inRange.filter((e) => e.source === key);
    const last = inScope.find((e) => e.source === key);
    const st = status.collectors[key];

    // "geplant" heisst jetzt wirklich: kein Kollektor da. Eine angebundene Quelle ohne
    // Events zeigt 0 und einen Live-Marker — sonst ist "keine Aktivität" von
    // "nicht angeschlossen" nicht zu unterscheiden.
    // Stillgelegt ist nicht dasselbe wie geplant. "Geplant" heisst: kommt noch. Bei Teams
    // ist es umgekehrt — es war da und ist weg. Die Kachel bleibt trotzdem bedienbar,
    // sonst waeren die alten Teams-Zeilen im Log nicht mehr ausblendbar.
    const still = !st ? STILLGELEGT[key] : null;
    const pending = !st && !still;
    const broken = st && st.state === 'error';
    const cls = ['source-card'];
    if (hidden.has(key)) cls.push('off');
    if (pending) cls.push('pending');
    if (still) cls.push('still');
    if (broken) cls.push('broken');

    let tag = '';
    if (still) tag = '<span class="sc-tag">Archiv</span>';
    else if (pending) tag = '<span class="sc-tag">geplant</span>';
    else if (broken) tag = '<span class="sc-tag err">Fehler</span>';
    else if (st.mode === 'live') tag = '<span class="sc-tag live">live</span>';
    else tag = '<span class="sc-tag poll">5 min</span>';

    const tip = still ? `${still}\nKlicken zum Aus-/Einblenden`
      : pending ? 'Kollektor noch nicht angebunden'
        : broken ? (st.message || 'Kollektor-Fehler')
          : `${st.mode === 'live' ? 'Live-Überwachung' : 'Abfrage alle 5 Minuten'}\n${st.message || ''}\nKlicken zum Aus-/Einblenden`;

    return `
      <div class="${cls.join(' ')}" style="--src:${cfg.color}" data-src="${key}"
           title="${esc(tip)}">
        <div class="sc-top">
          <span class="sc-dot"></span>
          <span class="sc-name">${cfg.label}</span>
          ${tag}
        </div>
        <div class="sc-count">${pending ? '—' : mine.length}</div>
        <div class="sc-last">${last ? timeAgo(last.ts) : 'noch nichts erfasst'}</div>
      </div>`;
  }).join('');

  $('sourceRow').querySelectorAll('.source-card:not(.pending)').forEach((el) => {
    el.onclick = () => {
      const s = el.dataset.src;
      if (hidden.has(s)) hidden.delete(s); else hidden.add(s);
      renderAll();
    };
  });

  void evs;
}

/* ── Balken pro Tag ── */
function renderBars() {
  const evs = visibleEvents();

  // Spanne bestimmen: bei fester Range die Tageszahl, bei "Alles" bis zum aeltesten Event.
  let days = RANGE_DAYS[range];
  if (!days) {
    const oldest = allEvents.length ? new Date(allEvents[allEvents.length - 1].ts) : new Date();
    oldest.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    days = Math.max(1, Math.round((today - oldest) / 86400000) + 1);
  }

  // Bei langen Spannen auf Wochen buendeln, damit die Balken lesbar bleiben.
  const weekly = days > 31;
  const step = weekly ? 7 : 1;
  const slots = Math.ceil(days / step);

  const buckets = [];
  for (let i = slots - 1; i >= 0; i--) {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - i * step);
    const start = new Date(end);
    start.setDate(start.getDate() - (step - 1));
    buckets.push({ start, end, bySource: {}, total: 0 });
  }

  const first = buckets[0].start;
  for (const e of evs) {
    const t = new Date(e.ts);
    if (t < first) continue;
    const idx = Math.min(buckets.length - 1,
      Math.floor((new Date(t).setHours(0, 0, 0, 0) - first) / 86400000 / step));
    if (idx < 0) continue;
    const b = buckets[idx];
    b.bySource[e.source] = (b.bySource[e.source] || 0) + 1;
    b.total += 1;
  }

  const max = Math.max(1, ...buckets.map((b) => b.total));

  $('barChart').innerHTML = buckets.map((b) => {
    const segs = Object.entries(SOURCES)
      .filter(([k]) => b.bySource[k])
      .map(([k, cfg]) => `<div class="bar-seg" style="--seg:${cfg.color};height:${(b.bySource[k] / max) * 100}%"></div>`)
      .join('');
    const label = weekly
      ? 'KW' + isoWeek(b.start)
      : (slots > 14
        ? b.end.toLocaleDateString('de-DE', { day: '2-digit' })
        : b.end.toLocaleDateString('de-DE', { weekday: 'short' }));
    const tip = weekly
      ? `${b.start.toLocaleDateString('de-DE')} – ${b.end.toLocaleDateString('de-DE')}: ${b.total}`
      : `${dayLabel(dayKey(b.end))}: ${b.total}`;
    return `
      <div class="bar-col" title="${tip}">
        <span class="bar-val">${b.total || ''}</span>
        <div class="bar-stack" style="height:${(b.total / max) * 100}%">${segs}</div>
        <span class="bar-label">${label}</span>
      </div>`;
  }).join('');

  const total = buckets.reduce((s, b) => s + b.total, 0);
  const active = buckets.filter((b) => b.total).length;
  const unit = weekly ? 'Wochen' : 'Tage';
  $('trendSub').textContent = `${total} Aktionen · ${active}/${buckets.length} ${unit} aktiv`;
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - start) / 86400000 + 1) / 7);
}

/* ── Stundenraster ── */
function renderHours() {
  const evs = visibleEvents();
  const byHour = new Array(24).fill(0);
  for (const e of evs) byHour[new Date(e.ts).getHours()] += 1;
  const max = Math.max(1, ...byHour);

  $('hourChart').innerHTML = byHour.map((n, h) => {
    const ratio = n / max;
    const alpha = n ? 0.14 + 0.86 * ratio : 0.06;
    const fg = ratio > 0.5 ? '#fff' : 'var(--text-secondary)';
    return `<div class="hour-cell" style="background:rgba(0,55,129,${alpha.toFixed(3)});color:${fg}"
              title="${String(h).padStart(2, '0')}:00 — ${n} Aktionen">${h}</div>`;
  }).join('');

  const peak = byHour.indexOf(max);
  $('clockSub').textContent = evs.length ? `Peak ${String(peak).padStart(2, '0')}:00 Uhr` : '';
}

/* ── Die Liste ──

   Zwei Zutaten, eine Zeilenform:
     Ereignisse aus dem Log  → "was ist passiert" (nach Zeit)
     Dinge aus dem Bestand   → "was habe ich"     (nach Kategorie, nach Bewertung)

   Beide werden auf dasselbe Zeilenobjekt gebracht. Deshalb hat jede Zeile Sterne, Notiz,
   Vorschau, Ordner-Sprung und Loeschkorb — egal aus welcher Haelfte sie kommt und egal aus
   welcher der fuenf Quellen.

   Der Schluessel ist e.sache bzw. d.key, beides kommt aus sachKey() im Hauptprozess. Es gab
   hier vorher ein eigenes fileKeyOf() mit anderen Praefixen; damit konnten Bewertung und
   Handzuordnung stillschweigend an zwei verschiedenen Schluesseln fuer dieselbe Datei
   haengen. Die Berechnung passiert jetzt genau einmal, in projects.js. */

function stern(key) {
  const m = lib.meta[key];
  return (m && m.stern) || 0;
}

function notiz(key) {
  const m = lib.meta[key];
  return (m && m.notiz) || '';
}

/* ── Rueckmeldung beim Oeffnen ──
   Alle Oeffnen-Kanaele antworten mit { ok, message }. Ein fehlgeschlagener Klick war
   bisher nicht zu sehen: der Kanal gab true zurueck, egal was Windows meldete. Ein Klick,
   der nichts tut und nichts sagt, ist der schlimmste Fall — er sieht aus wie ein Defekt
   im Panel, obwohl die Datei nur verschoben wurde.

   Zweiter Fall, gleiche Zeile: Outlook oeffnet die Mail, aber Windows laesst das Fenster
   nicht nach vorn. Dann ist ok true und vordergrund false — offen, aber unsichtbar. Auch
   das gehoert gesagt, sonst klickt man ein zweites Mal ins Leere.

   Es ist eine Meldung fuer alles, was ein Klick in der Zeile ausloest, nicht nur fuers
   Oeffnen: die Uebergabe an Claude braucht denselben Platz, und sie hat auch einen
   Erfolgsfall, der gesagt werden muss ("liegt in der Ablage"). Zwei Variablen fuer eine
   Zeile wuerden sich gegenseitig ueberschreiben, ohne dass man sieht, welche gewann. */
let feedMeldung = { text: '', warn: false };

function meldungAus(res) {
  if (!res) return { text: '', warn: false };
  if (res.ok === false) return { text: res.message || 'Fehlgeschlagen', warn: true };
  if (res.vordergrund === false) {
    return { text: 'Mail ist offen, liegt aber hinter dem Panel — Alt+Tab zu Outlook', warn: true };
  }
  return { text: '', warn: false };
}

// ziel: welche Notizzeile. Die Mappe hat ihre eigene, sonst stuende die Meldung zum Klick
// in einem Panel, das gerade nicht zu sehen ist.
function melden(res, ziel) {
  const m = res && res.meldung ? res.meldung : meldungAus(res);
  if (ziel && ziel !== 'feedNote') {
    const el = $(ziel);
    if (el && m.text) { el.textContent = m.text; el.classList.toggle('warn', m.warn); }
    return;
  }
  const vorher = feedMeldung.text;
  feedMeldung = m;

  if (m.text) {
    const el = $('feedNote');
    if (el) { el.textContent = m.text; el.classList.toggle('warn', m.warn); }
  } else if (vorher) {
    // Nur neu zeichnen, wenn vorher wirklich etwas stand — sonst wuerde jeder geglueckte
    // Klick die offenen Notizfelder und Vorschauen zuklappen.
    renderFeed();
  }
}

/* ── An Claude uebergeben ──
   Der Renderer schickt eine fertige Karte, keine rohe Zeile. Grund: Sterne, eigene Notiz
   und Projektname sind abgeleitete Werte, die hier schon berechnet vorliegen. Der
   Hauptprozess muesste sie sonst ein zweites Mal aus library-meta.json und den Regeln
   herleiten — zwei Herleitungen, die auseinanderlaufen koennen.

   Die Meldung nennt die Marke. Sie steht auch in der Datei und im Einfuege-Satz, und
   genau daran erkennt Claude spaeter, ob beide zusammengehoeren. */
async function anClaude(r) {
  const proj = projectCfg(r.project);
  const res = await window.buddy.auftragZeile({
    source: r.source,
    action: r.payload && r.payload.action,
    ts: r.payload && r.payload.ts,
    zeit: r.zeitTip,
    titel: r.titel,
    ordner: r.ordner,
    pfad: r.pfad,
    url: r.url,
    entryId: r.entryId,
    projekt: proj.label,
    fix: Boolean(r.fix),
    stern: stern(r.key),
    notiz: notiz(r.key),
  });
  melden(res.ok
    ? { ok: true, meldung: { text: `In der Ablage (Marke ${res.marke}) — in Claude einfügen, dann den Auftrag dahinter tippen`, warn: false } }
    : res);
}

// Lokaler Pfad einer Zeile. Bei Obsidian steht im Event nur der Dateiname, der absolute
// Pfad steckt in der obsidian://-URL.
function pfadVon(e) {
  if (e.meta && e.meta.path) return e.meta.path;
  if (e.source === 'obsidian' && e.url && e.url.includes('path=')) {
    try {
      return decodeURIComponent(e.url.split('path=')[1]);
    } catch {
      return '';
    }
  }
  return '';
}

// Im Bestand ist die Uhrzeit von vor drei Monaten uninteressant, das Datum nicht.
function kurzDatum(ts) {
  if (dayKey(ts) === dayKey(Date.now())) return hhmm(ts);
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.`;
}

/* ── Zuordnung von Hand ──
   Die Regeln liegen daneben, wenn ein Dateiname nichts ueber das Thema sagt. Jede Zeile
   ist deshalb ziehbar: fallen lassen auf ein Projekt in der Schiene setzt die Zuordnung.
   Die gezogene Zeile wird ueber ihren Index in dieser Liste wiedergefunden — dataTransfer
   nimmt nur Text, und das Ereignis soll unverkuerzt an den Hauptprozess gehen. */
let feedRefs = [];
let dragged = null;

// Nur die Felder, aus denen der Hauptprozess den Schluessel bildet. Der Rest (Titel-Liste
// eines Batches, Zeitstempel) wuerde nur Rauschen ueber die Bruecke schicken.
function dragPayload(e) {
  return {
    source: e.source, title: e.title, detail: e.detail || '',
    meta: e.meta || null, batch: e.batch || 0,
    // Der Loeschkorb liest den Dateipfad aus der obsidian://-URL.
    url: e.url || '',
  };
}

/* ── Ereignis und Ding auf dieselbe Zeile bringen ──
   Nur hier steht, welches Feld woher kommt. Alles danach kennt bloss noch die Zeile. */

function zeileAusEreignis(e) {
  const d = libByKey.get(e.sache) || null;
  const ordner = e.detail === '.' ? 'Vault-Wurzel' : (e.detail || '');
  return {
    key: e.sache,
    source: e.source,
    titel: e.title,
    ordner: e.batch
      ? `${ordner} · ${e.batchTitles.slice(0, 3).join(', ')}${e.batch > 3 ? ' …' : ''}`
      : ordner,
    // Die eigene Notiz schlaegt die Beschreibung aus dem Dokument: wer etwas dazuschreibt,
    // hat einen Grund.
    text: notiz(e.sache) || (d ? d.beschreibung : ''),
    // Eine gebuendelte Zeile steht fuer viele Dateien. Sie hat keinen einzelnen Pfad, keine
    // Bewertung und keine Vorschau — sie ist ein Ereignis, kein Ding.
    pfad: e.batch ? '' : (pfadVon(e) || (d ? d.pfad : '')),
    url: e.batch ? '' : (e.url || (d ? d.url : '')),
    zeit: hhmm(e.ts),
    zeitTip: new Date(e.ts).toLocaleString('de-DE'),
    ts: e.ts,
    rechts: e.batch ? 'Batch' : (ACTIONS[e.action] || e.action),
    rechtsArt: 'action',
    project: e.project,
    fix: Boolean(e.fixed),
    // Begruendung und Rate-Marke kommen aus store.js, wo die Zuordnung entstanden ist. Sie
    // hier neu herzuleiten waere eine zweite Meinung ueber dieselbe Zeile.
    grund: e.grund || '',
    geraten: Boolean(e.geraten),
    infra: Boolean(e.infra),
    batch: e.batch || 0,
    fluechtig: Boolean(e.meta && e.meta.fluechtig),
    ort: (e.meta && e.meta.ort) || '',
    teams: e.meta && e.meta.fromTeams,
    // Der Rueckweg in Outlook. Nur Mail-Ereignisse haben das, alle anderen bleiben leer.
    entryId: (e.meta && e.meta.entryId) || '',
    ungelesen: Boolean(e.meta && e.meta.ungelesen),
    ding: !e.batch,
    payload: dragPayload(e),
  };
}

function zeileAusDing(d) {
  return {
    key: d.key,
    source: d.source,
    titel: d.name,
    ordner: d.ordner,
    text: notiz(d.key) || d.beschreibung,
    pfad: d.pfad || '',
    url: d.url || '',
    zeit: kurzDatum(d.mtime),
    zeitTip: `zuletzt ${new Date(d.mtime).toLocaleString('de-DE')}`,
    ts: d.mtime,
    // Wie oft im Log angefasst. Ohne Treffer ist es eine Datei, die nur auf der Platte
    // liegt — dann sagt die Groesse mehr als eine 0.
    rechts: d.treffer > 1 ? `${d.treffer}×` : (d.kb ? `${d.kb} KB` : ''),
    rechtsArt: d.treffer > 1 ? 'times' : 'action',
    project: d.project,
    fix: Boolean(d.fix),
    grund: d.grund || '',
    geraten: Boolean(d.geraten),
    infra: Boolean(d.infra),
    batch: 0,
    fluechtig: Boolean(d.fluechtig),
    ort: d.kategorie,
    ding: true,
    payload: dingAlsEintrag(d),
  };
}

/* Eine Bestandszeile in der Form, die Loeschkorb und Projektzuordnung erwarten — dieselben
   Felder, aus denen der Hauptprozess den Schluessel bildet. Damit braucht keine der beiden
   Stellen eine Sonderbehandlung fuer den Bestand. */
function dingAlsEintrag(d) {
  return {
    source: d.source,
    title: d.name,
    detail: d.ordner,
    url: d.url || '',
    batch: 0,
    meta: {
      ...(d.pfad ? { path: d.pfad } : {}),
      ort: d.kategorie,
      kb: d.kb,
      ...(d.fluechtig ? { fluechtig: true } : {}),
    },
  };
}

// Vorschau nur, wo ein Rahmen etwas zeigen kann. Eine .md-Datei im iframe waere Rohtext,
// eine Confluence-Seite gar nichts — dort ist "oeffnen" die richtige Geste.
const VORSCHAU = /\.html?$/i;

function zeile(r) {
  const cfg = SOURCES[r.source] || { label: r.source, color: 'var(--text-muted)' };
  const proj = projectCfg(r.project);
  const idx = feedRefs.push(r) - 1;
  const s = stern(r.key);
  const eigen = notiz(r.key);

  const sterne = r.ding
    ? [1, 2, 3, 4, 5].map((n) => `<button class="fr-star${n <= s ? ' on' : ''}" data-val="${n}"
         type="button" title="${n} von 5 — nochmal auf denselben Stern setzt zurück">★</button>`).join('')
    : '';

  const kannVorschau = Boolean(r.pfad) && VORSCHAU.test(r.pfad);
  const knoepfe = r.ding ? [
    kannVorschau
      ? `<button class="fr-btn${offen.has(r.key) ? ' on' : ''}" data-act="preview" type="button"
           title="Vorschau im Panel">👁</button>` : '',
    (r.pfad || r.url)
      ? '<button class="fr-btn" data-act="open" type="button" title="Öffnen">↗</button>'
      : (r.entryId
        ? '<button class="fr-btn" data-act="open" type="button" title="Mail in Outlook öffnen">✉</button>' : ''),
    r.pfad
      ? '<button class="fr-btn" data-act="folder" type="button" title="Ordner im Explorer zeigen">🗀</button>' : '',
    `<button class="fr-btn${eigen ? ' on' : ''}" data-act="note" type="button"
       title="Eigene Notiz — wofür war das?">✎</button>`,
    /* An Claude übergeben. Kein Ausführen: der Knopf schreibt data/auftrag.md und legt
       einen Einfüge-Satz in die Ablage — begründet in auftrag.js. */
    `<button class="fr-btn" data-act="claude" type="button"
       title="An Claude übergeben — schreibt den Kontext in data/auftrag.md und legt den Einfüge-Satz in die Ablage">→C</button>`,
    '<button class="fr-btn weg" data-act="trash" type="button" title="In den Löschkorb">⌫</button>',
  ].join('') : '';

  const teamsTag = r.teams
    ? `<span class="fr-tag" title="Kurz zuvor wurde eine Teams-Nachricht kopiert — vermutlich hier eingefügt">aus Teams${typeof r.teams === 'string' ? ' · ' + esc(r.teams) : ''}</span>`
    : '';
  // Warnhinweis statt Info: eine Datei in C:\tmp oder Downloads ist beim nächsten
  // Aufräumen weg. Genau das soll die Zeile sagen — nicht nur, dass sie existiert.
  const tempTag = r.fluechtig
    ? `<span class="fr-temp" title="Liegt an einem Wegwerf-Ort (${esc(r.ort)}). Wenn das Artefakt bleiben soll, gehört es in einen Projektordner.">flüchtig</span>`
    : '';
  // Ungelesen heisst: liegt noch da. Das ist der einzige Mail-Zustand, der eine Handlung
  // nach sich zieht, also der einzige, der in die Zeile gehoert.
  const mailTag = r.ungelesen
    ? '<span class="fr-tag ungelesen" title="Noch nicht gelesen">ungelesen</span>'
    : '';
  /* Der Farbstreifen sagt bisher nur, WO die Zeile hängt. Warum sie dort hängt, war nicht
     ablesbar — und eine Vermutung sah aus wie ein Ergebnis. Am 2026-08-21 lag deshalb eine
     Woche fremder Arbeit unter Thorsten, ohne dass es auffiel. Jetzt steht der Grund im
     Tooltip, und eine geratene Zuordnung trägt ein sichtbares Fragezeichen. */
  const projTip = [
    proj.label,
    r.grund || '',
    r.fix ? '' : 'Zeile auf ein Projekt links ziehen, um sie umzuhängen.',
  ].filter(Boolean).join('\n');
  const fixTag = r.fix
    ? '<span class="fr-fix" title="Von Hand zugeordnet. Klicken, um wieder die Regel greifen zu lassen.">fix</span>'
    : '';
  const ratTag = r.geraten
    ? `<span class="fr-geraten" title="${esc(r.grund)}\nNur ein Indiz, keine Struktur. Falls falsch: Zeile auf das richtige Projekt ziehen.">?</span>`
    : '';
  // Infra heisst: die Zuordnung steht fest, aber es ist wiederverwendbares Material
  // (z.B. die Baukasten-Vorlagen), nicht die eigentliche Lieferung fuer dieses Projekt.
  // Deshalb keine Warnfarbe wie beim Fragezeichen — nur eine Einordnung der Arbeit.
  const infraTag = r.infra
    ? '<span class="fr-infra" title="Wiederverwendbares Material (Baukasten-Vorlage), nicht die projektspezifische Lieferung.">infra</span>'
    : '';
  const textTeil = r.text
    ? `<span class="fr-desc${eigen ? ' eigen' : ''}">${esc(r.text)}</span>`
    : '';

  return `
    <div class="feed-row${r.batch ? ' batch' : ''}" style="--src:${cfg.color};--proj:${proj.color}"
         data-i="${idx}" draggable="true">
      <span class="fr-time" title="${esc(r.zeitTip)}">${esc(r.zeit)}</span>
      <span class="fr-proj" title="${esc(projTip)}"></span>
      <span class="fr-src">${esc(cfg.label)}</span>
      <div class="fr-stars">${sterne}</div>
      <div class="fr-main">
        <div class="fr-title">${esc(r.titel)}</div>
        <div class="fr-detail">${fixTag}${ratTag}${infraTag}<span class="fr-ordner" title="${esc(r.pfad || r.ordner)}">${esc(r.ordner)}</span>${textTeil}${mailTag}${teamsTag}${tempTag}</div>
      </div>
      <span class="fr-${r.rechtsArt}">${esc(r.rechts)}</span>
      <div class="fr-acts">${knoepfe}</div>
      ${notizOffen.has(r.key)
    ? `<textarea class="fr-note" rows="2" placeholder="Wofür war das? Wird in library-meta.json gespeichert, nicht im Ereignis-Log.">${esc(eigen)}</textarea>`
    : ''}
      <div class="fr-frame-box${offen.has(r.key) ? ' show' : ''}"></div>
    </div>`;
}

/* ── Filter der Ablage ──
   Schubladen und Bewertungsfilter gelten nur dort. Im Verlauf haben sie nichts zu suchen:
   "unbewertet" wuerde jede Confluence-Seite und jede Notiz treffen, weil es fuer die gar
   keine Sterne gibt, und eine HTML-Schublade wuerde den halben Tag ausblenden. Deshalb
   verschwinden die beiden Bedienelemente im Verlauf ganz statt still zu wirken. */
function passtFilter(key, fluechtig) {
  if (libFilter === 'bewertet') return stern(key) > 0;
  if (libFilter === 'unbewertet') return stern(key) === 0;
  if (libFilter === 'fluechtig') return Boolean(fluechtig);
  return true;
}

function verlaufZeilen() {
  return visibleEvents().map(zeileAusEreignis);
}

function bestandZeilen() {
  const q = query.trim().toLowerCase();
  // Kein Zeitraumfilter: das Deck von Maerz ist genau das, was hier gesucht wird.
  // "Woche" wuerde es verstecken, und niemand wuerde merken, dass es da ist.
  // Die Quellen-Kacheln oben wirken hier nicht: in der Ablage gibt es nur eine Quelle, und
  // ein versehentlich abgeschaltetes "HTML" haette die ganze Liste geleert.
  return lib.dateien
    .filter((d) => {
      if (project && d.project !== project) return false;
      if (libCat && d.kategorie !== libCat) return false;
      if (!passtFilter(d.key, d.fluechtig)) return false;
      if (!q) return true;
      // Der ganze Pfad ist mitdurchsuchbar, nicht nur Name und Schublade. Wer noch weiss
      // "das lag irgendwo unter UC3", findet es damit, ohne die Schublade zu treffen.
      return `${d.name} ${d.beschreibung} ${d.ordner} ${d.pfad} ${notiz(d.key)}`
        .toLowerCase().includes(q);
    })
    .map(zeileAusDing);
}

const MAX_ZEILEN = 400;
const STERN_LABEL = ['unbewertet', '★', '★★', '★★★', '★★★★', '★★★★★'];

function gruppieren(rows) {
  const groups = [];
  const idx = new Map();
  const push = (key, label, r) => {
    let g = idx.get(key);
    if (!g) {
      g = { label, items: [] };
      idx.set(key, g);
      groups.push(g);
    }
    g.items.push(r);
  };

  if (groupBy === 'zeit') {
    for (const r of rows) push(dayKey(r.ts), dayLabel(dayKey(r.ts)), r);
  } else if (groupBy === 'stern') {
    // Absteigend: die bewerteten Dinge sind der Grund, warum man ueberhaupt bewertet.
    const sortiert = rows.slice().sort((a, b) => stern(b.key) - stern(a.key)
      || new Date(b.ts) - new Date(a.ts));
    for (const r of sortiert) {
      const s = stern(r.key);
      push('s' + s, STERN_LABEL[s], r);
    }
  } else {
    /* Ordner nach Aktualitaet, nicht nach Alphabet. Wer "schnell das eine HTML finden" will,
       sucht meistens etwas von gestern — und "C:\tmp (direkt)" oben zu haben, nur weil C vor
       D kommt, kostet jedes Mal einen Scroll. Sortiert wird nach der neuesten Datei im
       Ordner; innerhalb des Ordners ebenfalls neueste zuerst. */
    const sortiert = rows.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
    for (const r of sortiert) {
      const d = libByKey.get(r.key);
      const kat = d ? d.kategorie : r.source;
      push(kat, kat, r);
    }
  }
  return groups;
}

function renderFeed() {
  feedRefs = [];
  const bestand = istAblage();
  const alle = bestand ? bestandZeilen() : verlaufZeilen();

  // Der Kopf sagt, welche Frage die Liste gerade beantwortet. Ein fester Titel "Arbeit &
  // Bestand" hat in beiden Modi halb gelogen.
  $('feedTitle').textContent = bestand ? 'HTML-Ablage' : 'Arbeit';
  $('feedCount').textContent = bestand
    ? `${alle.length}${alle.length === lib.dateien.length ? '' : ' / ' + lib.dateien.length}`
    : alle.length;

  // Die Ablage-Bedienung erscheint nur in der Ablage. Sichtbare Schalter, die im Verlauf
  // nichts tun, waeren schlimmer als keine. Die Zeile selbst bleibt stehen: der Hinweis
  // rechts darin (etwa die 400er-Deckelung) gilt in beiden Modi.
  ['libFilters', 'libCats', 'libCatsToggle', 'libPreviewAll', 'libRescan']
    .forEach((id) => { $(id).hidden = !bestand; });

  const bewertet = Object.values(lib.meta).filter((m) => m.stern).length;
  const notes = [];
  if (!bestand && hidden.size) notes.push(`${hidden.size} Quelle(n) ausgeblendet`);
  if (project) notes.push(projectCfg(project).label);
  if (bestand) {
    if (libCat) notes.push(libCat);
    if (bewertet) notes.push(`${bewertet} bewertet`);
    if (lib.verwaist && lib.verwaist.length) {
      notes.push(`${lib.verwaist.length} Bewertung(en) ohne Datei`);
    }
    const fehlt = (lib.orte || []).filter((o) => o.fehlt).map((o) => o.label);
    if (fehlt.length) notes.push(`${fehlt.join(', ')} nicht vorhanden`);
    if (lib.gescannt) notes.push(`gelesen ${hhmm(lib.gescannt)}`);
  }
  if (lib.message) notes.push(lib.message);
  // Steht hinten, damit die Meldung zum letzten Klick nicht zwischen Zaehlwerten untergeht.
  if (feedMeldung.text) notes.push(feedMeldung.text);
  // warn nur, wenn wirklich etwas schiefging. Eine geglueckte Uebergabe steht in derselben
  // Zeile, soll aber nicht rot aussehen.
  $('feedNote').classList.toggle('warn', Boolean(lib.message || feedMeldung.warn));
  $('feedNote').textContent = notes.join(' · ');

  const hinweise = [];
  if (bestand) {
    hinweise.push(query.trim()
      ? `Suche „${query.trim()}" über alle HTML-Dateien — Zeitraum gilt hier nicht`
      : 'Alle HTML-Dateien, unabhängig vom Zeitraum. Suchfeld oben filtert mit.');
  }
  if (alle.length > MAX_ZEILEN) {
    hinweise.push(`${alle.length - MAX_ZEILEN} weitere nicht angezeigt — Filter enger stellen`);
  }
  $('feedHint').textContent = hinweise.join(' · ');

  /* Schubladen als Filter, nicht als Sprungmarke: Filtern ist nuetzlicher als Scrollen.
     Zaehler zeigen die Gesamtmenge der Schublade, nicht die gefilterte — sonst springen die
     Zahlen beim Tippen.

     Die gewaehlte Schublade steht vorne. In der zugeklappten Leiste sind nur zwei Zeilen
     sichtbar; eine aktive Auswahl, die man wegscrollen muss, um sie wieder loszuwerden,
     waere eine Falle. */
  const kats = [...lib.kategorien].sort((a, b) => (b.name === libCat) - (a.name === libCat));
  $('libCats').classList.toggle('auf', katsAuf);
  $('libCats').innerHTML = kats.map((k) => `
    <button class="lib-chip${libCat === k.name ? ' on' : ''}" data-cat="${esc(k.name)}" type="button"
            title="${k.bewertet} davon bewertet">
      <span class="lc-name">${esc(k.name)}</span>
      <span class="lc-count">${k.anzahl}</span>
    </button>`).join('');
  $('libCats').querySelectorAll('.lib-chip').forEach((el) => {
    el.onclick = () => {
      libCat = libCat === el.dataset.cat ? null : el.dataset.cat;
      renderFeed();
    };
  });
  $('libCatsToggle').textContent = katsAuf
    ? 'Schubladen zu'
    : `Schubladen ${lib.kategorien.length}`;

  if (!alle.length) {
    $('feed').innerHTML = `<div class="empty">${bestand
      ? 'Keine HTML-Datei passt zu Suche und Filter.'
      : 'Keine Aktivität im gewählten Zeitraum.'}</div>`;
    return;
  }

  $('feed').innerHTML = gruppieren(alle.slice(0, MAX_ZEILEN)).map((g) => `
    <div class="feed-day">${esc(g.label)} · ${g.items.length}</div>
    ${g.items.map(zeile).join('')}`).join('');

  $('feed').querySelectorAll('.feed-row').forEach((el) => {
    const r = feedRefs[Number(el.dataset.i)];
    if (!r) return;

    /* ── Womit wird geoeffnet ──
       Die Reihenfolge ist der ganze Punkt. Vorher stand der Dateipfad vorn, und damit
       landete eine Vault-Notiz im falschen Programm: Windows haengt `.md` an den
       registrierten Editor — hier VS Code — und Obsidian sah den Klick nie. Der Pfad war
       sogar doppelt falsch, denn er wird bei Obsidian erst aus der `obsidian://`-URL
       herausgeschnitten (siehe pfadVon), die direkt daneben liegt und in die richtige
       Anwendung fuehrt.

       Also: App-URL zuerst. Nur wenn es keine gibt, ist der Dateipfad die Antwort —
       genau der Fall HTML, PPTX, Excel, wo es kein Protokoll gibt und das
       Standardprogramm stimmt. */
    const APP_URL = /^obsidian:/i;
    const oeffnen = async () => {
      let res = null;
      if (r.url && APP_URL.test(r.url)) res = await window.buddy.open(r.url);
      else if (r.pfad) res = await window.buddy.openFile(r.pfad);
      else if (r.url) res = await window.buddy.open(r.url);
      // Eine Mail hat weder Pfad noch URL. Sie wird ueber ihre EntryID in Outlook
      // aufgeschlagen — dieselbe Mail, nicht eine Kopie.
      else if (r.entryId) res = await window.buddy.openMail(r.entryId);
      else return;
      melden(res);
    };
    if (r.pfad || r.url || r.entryId) el.onclick = oeffnen;

    el.querySelectorAll('.fr-star').forEach((s) => {
      s.onclick = async (ev) => {
        ev.stopPropagation();
        const val = Number(s.dataset.val);
        // Gleicher Stern nochmal = zurueck auf unbewertet. Genau wie in der alten Uebersicht.
        const res = await window.buddy.libSet(r.key, { stern: stern(r.key) === val ? 0 : val });
        if (res && res.ok) { lib.meta = res.meta; renderFeed(); }
      };
    });

    if (offen.has(r.key)) rahmen(el, r.pfad);

    const feld = el.querySelector('.fr-note');
    if (feld) {
      feld.onclick = (ev) => ev.stopPropagation();
      feld.focus();
      feld.onblur = async () => {
        const res = await window.buddy.libSet(r.key, { notiz: feld.value });
        if (res && res.ok) {
          lib.meta = res.meta;
          notizOffen.delete(r.key);
          renderFeed();
        }
      };
    }

    el.querySelectorAll('.fr-btn').forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const act = b.dataset.act;
        if (act === 'open') await oeffnen();
        else if (act === 'folder') melden(await window.buddy.openFolder(r.pfad));
        else if (act === 'preview') {
          if (offen.has(r.key)) offen.delete(r.key); else offen.add(r.key);
          renderFeed();
        } else if (act === 'note') {
          if (notizOffen.has(r.key)) notizOffen.delete(r.key); else notizOffen.add(r.key);
          renderFeed();
        } else if (act === 'claude') {
          await anClaude(r);
        } else if (act === 'trash') {
          await addToTrash([r.payload]);
        }
      };
    });

    el.ondragstart = (ev) => {
      dragged = r.payload;
      el.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      // Irgendein Nutzdatum muss gesetzt sein, sonst startet Chromium das Ziehen nicht.
      ev.dataTransfer.setData('text/plain', String(r.titel || ''));
    };
    el.ondragend = () => {
      dragged = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.rail-item.drop').forEach((x) => x.classList.remove('drop'));
    };

    const fix = el.querySelector('.fr-fix');
    if (fix) {
      fix.onclick = async (ev) => {
        ev.stopPropagation(); // sonst oeffnet der Klick zusaetzlich die Datei
        const res = await window.buddy.unassign(r.payload);
        if (res && res.ok) await load();
      };
    }
  });
}

/* Vorschau im Rahmen. Kein sandbox-Attribut, und das ist eine Entscheidung: mit sandbox
   bekaeme der Rahmen einen fremden Ursprung, und Chromium laedt dann keine
   file://-Unterressourcen mehr — jedes Deck waere ohne CSS und ohne Bilder. Der Preload
   laeuft nicht in Unterrahmen (nodeIntegrationInSubFrames ist aus), window.buddy ist
   drinnen also nicht erreichbar. */
function rahmen(row, pfad) {
  const box = row.querySelector('.fr-frame-box');
  if (!box || !pfad || box.querySelector('iframe')) return;
  const url = 'file:///' + pfad.replace(/\\/g, '/').replace(/^\/+/, '');
  box.innerHTML = `<iframe class="fr-frame" src="${esc(encodeURI(url))}"></iframe>`;
}

/* ── Kontext-Mappe ── */
const ROLLEN = ['Auftrag', 'Quelle', 'Prototyp', 'Vorlage', 'Doku', 'Referenz'];
const STAENDE = ['ungeprüft', 'aktuell', 'veraltet'];
const KIND_LABEL = {
  vault: 'Vault', file: 'Datei', confluence: 'Confluence', jira: 'Jira', github: 'GitHub', url: 'Link',
  mail: 'Mail',
};

let view = 'activity';
let mappe = { project: null, entries: [] };

async function loadMappe() {
  if (!project) { mappe = { project: null, entries: [] }; return; }
  mappe = await window.buddy.dossierLoad(project);
}

function selectOpts(values, cur) {
  return ['<option value=""></option>']
    .concat(values.map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`))
    .join('');
}

function renderMappe() {
  const proj = project ? projectCfg(project) : null;
  $('viewMappeCount').textContent = mappe.entries.length ? `· ${mappe.entries.length}` : '';

  if (!project) {
    $('mappeCount').textContent = '';
    $('mappeNote').textContent = '';
    $('mappeList').innerHTML =
      '<div class="empty">Links ein Projekt wählen — jede Mappe gehört zu genau einem Projekt.</div>';
    $('mappeDrop').classList.add('off');
    return;
  }

  $('mappeDrop').classList.remove('off');
  const offen = mappe.entries.filter((e) => !e.zweck).length;
  $('mappeCount').textContent = `${mappe.entries.length} in ${proj.label}`;
  $('mappeNote').textContent = offen
    ? `${offen} ohne Zweck — die frage ich dich durch`
    : (mappe.entries.length ? 'alle Einträge beschrieben' : '');
  $('mappeNote').classList.toggle('warn', Boolean(offen));

  if (!mappe.entries.length) {
    $('mappeList').innerHTML =
      '<div class="empty">Noch nichts drin. Dateien hereinziehen, Link einfügen oder Kandidaten übernehmen.</div>';
    return;
  }

  // Ohne Zweck zuerst: das ist die Arbeitsliste.
  const sorted = [...mappe.entries].sort((a, b) => (a.zweck ? 1 : 0) - (b.zweck ? 1 : 0));

  $('mappeList').innerHTML = sorted.map((e) => `
    <div class="mp-item${e.zweck ? '' : ' open'}" style="--proj:${proj.color}" data-id="${esc(e.id)}">
      <div class="mp-head">
        <span class="mp-kind">${esc(KIND_LABEL[e.kind] || e.kind)}</span>
        <span class="mp-title" data-open="1" title="${esc(e.ref)}">${esc(e.title)}</span>
        <select class="mp-sel" data-field="rolle" title="Rolle im Projekt">${selectOpts(ROLLEN, e.rolle)}</select>
        <select class="mp-sel" data-field="stand" title="Aktualität">${selectOpts(STAENDE, e.stand)}</select>
        <button class="mp-del" type="button" title="Aus der Mappe entfernen (Datei bleibt)">×</button>
      </div>
      <input class="mp-zweck" data-field="zweck" value="${esc(e.zweck)}"
        placeholder="Wofür ist das? — ein Satz genügt">
      <div class="mp-ref">${esc(e.ref)}</div>
    </div>`).join('');

  $('mappeList').querySelectorAll('.mp-item').forEach((el) => {
    const id = el.dataset.id;
    const entry = mappe.entries.find((x) => x.id === id);

    el.querySelectorAll('[data-field]').forEach((f) => {
      const save = async () => {
        const patch = {};
        patch[f.dataset.field] = f.value;
        const res = await window.buddy.dossierUpdate(project, id, patch);
        mappe.entries = res.entries;
        renderMappe();
      };
      if (f.tagName === 'SELECT') f.onchange = save;
      else f.onchange = save; // Enter oder Fokuswechsel — nicht bei jedem Tastendruck speichern
    });

    el.querySelector('.mp-del').onclick = async () => {
      const res = await window.buddy.dossierRemove(project, id);
      mappe.entries = res.entries;
      renderMappe();
    };

    el.querySelector('[data-open]').onclick = async () => {
      if (!entry) return;
      // Eine Vault-Notiz kommt hier als kind 'vault' mit obsidian://-URL an und faellt
      // damit in den url-Zweig — anders als im Verlauf, wo der Pfad vorn stand.
      if (entry.kind === 'file') melden(await window.buddy.openFile(entry.ref));
      // outlook:<EntryID> — der Teil hinter dem Doppelpunkt ist die ID.
      else if (entry.kind === 'mail') melden(await window.buddy.openMail(entry.ref.slice('outlook:'.length)));
      else if (entry.url) melden(await window.buddy.open(entry.url));
    };
  });
}

async function addToMappe(items, source) {
  if (!project || !items.length) return;
  const res = await window.buddy.dossierAdd(project, items.map((i) =>
    (typeof i === 'string' ? { ref: i, from: source } : { ...i, from: source })));
  mappe.entries = res.entries;
  renderMappe();
  const note = `${res.added} neu${res.skipped ? `, ${res.skipped} schon drin` : ''}`;
  $('mappeNote').textContent = note;
}

/* ── Löschkorb ──
   Sammelt, was weg soll. Zwei Knoepfe, weil "weg" zwei Stufen hat: der graue verschiebt in
   _Papierkorb im Vault (harmlos, deshalb ohne Rueckfrage), der rote schiebt in den
   Windows-Papierkorb — der fragt vorher, den Dialog stellt der Hauptprozess.
   Zeilen ohne Dateipfad (Confluence, Teams, GitHub) bleiben Merkposten. */
let trash = { entries: [] };

async function loadTrash() {
  trash = await window.buddy.trashLoad();
  renderTrash();
}

function renderTrash() {
  const n = trash.entries.length;
  const dateien = trash.entries.filter((e) => e.file).length;
  // clean() ("erstmal in Vault-Papierkorb") ruehrt nur Dateien im Vault an, recycle()
  // ("endgueltig loeschen") jede aufloesbare Datei — der Windows-Papierkorb kennt keinen
  // Vault. Ein Knopf, der wegen des jeweils anderen Knopfes ausgegraut bleibt, sieht wie
  // ein defekter Loeschkorb aus, war aber nur eine zu strenge Voraussetzung.
  const imVault = trash.entries.filter((e) => e.file && !e.ausserhalb).length;
  $('trashCount').textContent = n;
  $('trashZone').classList.toggle('has', n > 0);
  $('viewTrashCount').textContent = n ? `· ${n}` : '';
  $('trashBadge').textContent = n ? `${n} vorgemerkt` : '';
  $('trashClean').disabled = !imVault;
  $('trashRecycle').disabled = !dateien;
  $('trashNote').textContent = n
    ? `${dateien} Datei(en) loeschbar (davon ${imVault} im Vault) · ${n - dateien} nur Merkposten`
    : '';

  if (!n) {
    $('trashList').innerHTML =
      '<div class="empty">Leer. Zeilen aus dem Verlauf auf den Löschkorb links ziehen.</div>';
    return;
  }

  $('trashList').innerHTML = trash.entries.map((e) => `
    <div class="mp-item${e.file ? '' : ' open'}" style="--proj:#C5221F" data-id="${esc(e.id)}">
      <div class="mp-head">
        <span class="mp-kind">${esc(e.file ? 'Datei' : (SOURCES[e.source] ? SOURCES[e.source].label : e.source))}</span>
        <span class="mp-title" title="${esc(e.file || e.url || '')}">${esc(e.title)}</span>
        <button class="mp-del" type="button" title="Aus dem Löschkorb nehmen">×</button>
      </div>
      <div class="mp-ref">${esc(e.file
    ? e.file
    : (e.ausserhalb ? 'ausserhalb des Vaults — wird nicht angetastet'
      : 'kein lokaler Pfad — hier nur vermerkt, löschen in der jeweiligen Oberfläche'))}</div>
    </div>`).join('');

  $('trashList').querySelectorAll('.mp-item').forEach((el) => {
    el.querySelector('.mp-del').onclick = async () => {
      trash = await window.buddy.trashRemove(el.dataset.id);
      renderTrash();
    };
  });
}

// Der Vault-Papierkorb sammelt sich an und wird von OneDrive mitsynchronisiert. Der Stand
// steht deshalb sichtbar unter der Liste, statt still zu wachsen. Nur beim Blick in die
// Ansicht abgefragt — der Minutentakt braucht keinen Ordnerdurchlauf.
async function loadBinStat() {
  const bin = await window.buddy.trashBinStat();
  const mb = bin.bytes >= 1024 * 1024
    ? `${(bin.bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bin.bytes / 1024))} KB`;
  $('binNote').textContent = bin.dateien
    ? `Vault-Papierkorb: ${bin.dateien} Datei(en), ${mb}`
    : 'Vault-Papierkorb ist leer';
  $('binEmpty').disabled = !bin.dateien;
}

async function addToTrash(items) {
  const res = await window.buddy.trashAdd(items);
  trash = { entries: res.entries };
  renderTrash();
  assignNote = res.added
    ? `${res.added} in den Löschkorb${res.skipped ? ` · ${res.skipped} übersprungen` : ''}`
    : 'nichts Neues (Batch-Zeilen und Doppelte gehen nicht in den Korb)';
  renderProjects();
}

/* Bestand nachladen. force = Plattenscan erzwingen; ohne force entscheidet library.js
   anhand der Ereignisse, ob der letzte Scan noch gilt. */
async function loadLib(force) {
  lib = await window.buddy.libLoad(force === true);
  libByKey = new Map(lib.dateien.map((d) => [d.key, d]));
}

function setView(v) {
  view = v;
  $('viewActivity').hidden = view !== 'activity';
  $('viewTodo').hidden = view !== 'todo';
  $('viewMappe').hidden = view !== 'mappe';
  $('viewTrash').hidden = view !== 'trash';
  $('viewMailAssist').hidden = view !== 'mailassist';
  $('viewTabs').querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'todo') loadTodos();
  if (view === 'mappe') renderMappe();
  if (view === 'trash') { renderTrash(); loadBinStat(); }
}

// Kopfzeile ist immer global (alle Quellen, alle Zeit) und unabhaengig von Range und Filter.
// "Heute" wird hier gerechnet, nicht aus der Server-Summary — sonst bleibt der Wert
// nach Mitternacht auf dem Vortag stehen, solange das Fenster offen ist.
function renderHeader() {
  if (!summary) return;
  const today = dayKey(Date.now());
  $('hToday').textContent = allEvents.filter((e) => dayKey(e.ts) === today).length;
  $('hStreak').textContent = summary.streak + (summary.streak === 1 ? ' Tag' : ' Tage');
  $('hPeak').textContent = summary.peakHour == null
    ? '--' : `${String(summary.peakHour).padStart(2, '0')}:00`;
  $('hTotal').textContent = summary.total;
}

function renderAll() {
  renderHeader();
  renderProjects();
  renderSources();
  renderBars();
  renderHours();
  renderFeed();
  renderMappe();
}

/* Verweis eines Ereignisses fuer die Mappe. Lokaler Pfad wenn es einen gibt (normalizeRef
   in dossier.js macht daraus kind 'file'), sonst der Weblink. */
function eventRef(e) {
  if (e.batch) return null; // gebuendelte Zeile hat keinen eindeutigen Verweis
  const p = pfadVon(e);
  if (p) return p;
  if (e.url && /^https?:/i.test(e.url)) return e.url;
  /* Eine Mail hat keinen Pfad und keine URL, gehoert aber genau so in eine Kontext-Mappe
     wie eine Confluence-Seite — "was Marwin dazu geschrieben hat" ist oft der Kern des
     Auftrags. Eigenes Schema, damit die Mappe weiss, dass sie den Verweis nicht wie eine
     Datei behandeln darf. Der Volltext wird bewusst nicht mitgezogen: das waere ein
     ungefragter Schreibvorgang in den Vault. */
  if (e.meta && e.meta.entryId) return 'outlook:' + e.meta.entryId;
  return null;
}

/* Ein Ladevorgang fuer beide Haelften. Vorher wurde der Bestand erst beim Oeffnen des
   Reiters geholt und danach nie wieder — dieselbe Liste haette dann links Zahlen von jetzt
   und rechts von vor einer Stunde gezeigt. Jetzt haengt er an derselben Kette wie der
   Verlauf: Datei-Watcher → events:changed → load(). */
async function load() {
  const res = await window.buddy.load();
  allEvents = res.events;
  summary = res.summary;
  status = res.status || { collectors: {}, log: [] };
  projects = res.projects || [];
  projectsNote = res.projectsNote || '';
  projectsFile = res.projectsFile || '';
  fixedCount = res.fixedCount || 0;
  // Verschwindet ein Projekt aus der Konfiguration, darf der Filter nicht auf einer
  // leeren Auswahl haengen bleiben.
  if (project && !projects.some((p) => p.id === project)) project = null;
  await loadLib();
  // Eine Kategorie kann verschwinden (Ordner umbenannt, Datei weg). Dann muss der Filter
  // fallen, sonst steht die Liste ohne erkennbaren Grund leer da.
  if (libCat && !lib.kategorien.some((k) => k.name === libCat)) libCat = null;
  await loadMappe();
  renderAll();
  await loadTrash();
}

$('rangeTabs').onclick = (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  range = btn.dataset.range;
  $('rangeTabs').querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  renderAll();
};

$('groupTabs').onclick = (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  groupBy = btn.dataset.group;
  $('groupTabs').querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  renderFeed();
};

$('projectReset').onclick = async () => {
  project = null;
  await loadMappe();
  renderAll();
};

$('viewTabs').onclick = (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  setView(btn.dataset.view);
};

/* ── Hineinwerfen ── */
const dz = $('mappeDrop');
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (ev) => {
  ev.preventDefault();
  if (project) dz.classList.add('hot');
}));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('hot')));

dz.addEventListener('drop', (ev) => {
  ev.preventDefault();
  if (!project) return;
  const refs = [];
  for (const f of ev.dataTransfer.files) {
    const p = window.buddy.pathFor(f);
    if (p) refs.push(p);
  }
  // Aus dem Browser oder aus Confluence gezogen: dann kommt statt einer Datei ein Link.
  if (!refs.length) {
    const url = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text/plain');
    if (url && /^https?:/i.test(url.trim())) refs.push(url.trim());
  }
  addToMappe(refs, 'drop');
});

/* Das Feld nimmt nur Links. Ohne diese Pruefung wurde jeder Text zu einem Eintrag: dossier.js
   erkennt kein Protokoll, faellt auf "vault" zurueck und baut daraus ein obsidian://open?path=
   auf eine Datei, die es nie gab. Aufgefallen ist es am Einfuege-Satz der Claude-Uebergabe —
   der liegt nach dem Klick in der Ablage, und ein Feld, in das man etwas einfuegt, ist genau
   die Stelle, an der man ihn versehentlich loslaesst. Das Drop-Feld darunter prueft schon
   seit immer auf ^https?: — hier fehlte es. */
const MAPPE_LINK = /^(https?|obsidian):/i;

$('mappeUrlAdd').onclick = () => {
  const v = $('mappeUrl').value.trim();
  if (!v) return;
  if (!MAPPE_LINK.test(v)) {
    $('mappeNote').classList.add('warn');
    $('mappeNote').textContent = 'Das ist kein Link — hier gehört eine Adresse mit http(s):// '
      + 'oder obsidian:// hinein. Dateien kommen per Ziehen in die Fläche darunter.';
    return;
  }
  $('mappeUrl').value = '';
  $('mappeNote').classList.remove('warn');
  addToMappe([v], 'link');
};

$('mappeUrl').onkeydown = (ev) => {
  if (ev.key === 'Enter') $('mappeUrlAdd').click();
};

$('mappeTakeAuto').onclick = () => {
  // Alles aus dem aktuell gefilterten Verlauf, was einen eindeutigen Verweis hat.
  const refs = [];
  const seen = new Set();
  let ohne = 0;
  for (const e of visibleEvents()) {
    const r = eventRef(e);
    if (!r) { ohne += 1; continue; }
    if (seen.has(r)) continue;
    seen.add(r);
    refs.push({ ref: r, title: e.title });
  }
  addToMappe(refs, 'auto').then(() => {
    if (ohne) $('mappeNote').textContent += ` · ${ohne} Zeilen ohne eindeutigen Verweis übersprungen (gebündelte Zeilen, alte Teams-Einträge)`;
  });
};

$('mappeClaude').onclick = async () => {
  if (!project) {
    $('mappeNote').classList.add('warn');
    $('mappeNote').textContent = 'Erst links ein Projekt wählen — übergeben wird immer eine Mappe.';
    return;
  }
  const res = await window.buddy.auftragMappe(project);
  $('mappeNote').classList.toggle('warn', !res.ok);
  $('mappeNote').textContent = res.ok
    ? `In der Ablage (Marke ${res.marke}) — in Claude einfügen, dann den Auftrag dahinter tippen`
    : res.message;
};

$('mappeExport').onclick = async () => {
  if (!project) return;
  const res = await window.buddy.dossierExport(project);
  $('mappeNote').classList.toggle('warn', !res.ok);
  $('mappeNote').textContent = res.ok
    ? `exportiert: ${res.file.split(/[\\/]/).pop()} (${res.count} Einträge)`
    : res.message;
};

/* ── Löschkorb: Ziehziel und Aufräumen ── */
const tz = $('trashZone');
tz.ondragover = (ev) => {
  if (!dragged) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  tz.classList.add('drop');
};
tz.ondragleave = () => tz.classList.remove('drop');
tz.ondrop = async (ev) => {
  if (!dragged) return;
  ev.preventDefault();
  tz.classList.remove('drop');
  const e = dragged;
  dragged = null;
  await addToTrash([dragPayload(e)]);
};
tz.onclick = () => setView('trash');

const tdz = $('trashDrop');
['dragenter', 'dragover'].forEach((t) => tdz.addEventListener(t, (ev) => {
  if (!dragged) return;
  ev.preventDefault();
  tdz.classList.add('hot');
}));
['dragleave', 'drop'].forEach((t) => tdz.addEventListener(t, () => tdz.classList.remove('hot')));
tdz.addEventListener('drop', async (ev) => {
  if (!dragged) return;
  ev.preventDefault();
  const e = dragged;
  dragged = null;
  await addToTrash([dragPayload(e)]);
});

$('trashClean').onclick = async () => {
  const res = await window.buddy.trashClean();
  if (!res.ok) {
    $('trashNote').textContent = res.message || 'Aufräumen fehlgeschlagen';
    $('trashNote').classList.add('warn');
    return;
  }
  trash = { entries: res.entries };
  renderTrash();
  $('trashNote').classList.toggle('warn', res.failed.length > 0);
  $('trashNote').textContent = `${res.moved} verschoben nach ${res.ziel}`
    + (res.failed.length ? ` · ${res.failed.length} nicht: ${res.failed.map((f) => f.grund).join(', ')}` : '')
    + (res.bleibt ? ` · ${res.bleibt} bleiben als Merkposten` : '');
  // Der Verlauf zeigt sonst Zeilen zu Dateien, die jetzt im Papierkorb liegen.
  await loadBinStat();
  await load();
  if (lib.dateien.length) await loadLib(true);
};

/* Endgueltig loeschen. Die Rueckfrage stellt der Hauptprozess als echter Dialog — hier
   nur das Ergebnis anzeigen. res.abgebrochen heisst: nichts passiert, Anzeige unveraendert. */
$('trashRecycle').onclick = async () => {
  const res = await window.buddy.trashRecycle();
  if (!res.ok) {
    $('trashNote').textContent = res.message || 'Löschen fehlgeschlagen';
    $('trashNote').classList.add('warn');
    return;
  }
  if (res.abgebrochen) return;
  trash = { entries: res.entries };
  renderTrash();
  $('trashNote').classList.toggle('warn', res.failed.length > 0);
  $('trashNote').textContent = `${res.weg} im Windows-Papierkorb`
    + (res.failed.length ? ` · ${res.failed.length} nicht: ${res.failed.map((f) => f.grund).join(', ')}` : '')
    + (res.bleibt ? ` · ${res.bleibt} bleiben als Merkposten` : '');
  await load();
  if (lib.dateien.length) await loadLib(true);
};

$('binEmpty').onclick = async () => {
  const res = await window.buddy.trashEmptyBin();
  if (!res.ok) {
    $('binNote').textContent = res.message || 'Leeren fehlgeschlagen';
    return;
  }
  if (res.abgebrochen) return;
  $('binNote').textContent = `${res.weg} Ordner in den Windows-Papierkorb`
    + (res.failed.length ? ` · ${res.failed.length} nicht` : '');
  await loadBinStat();
  await load();
};

/* ── Bewertungsfilter und Bestand: Bedienung ── */
$('libFilters').onclick = (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  libFilter = btn.dataset.lib;
  $('libFilters').querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  renderFeed();
};

$('libCatsToggle').onclick = () => {
  katsAuf = !katsAuf;
  renderFeed();
};

$('libRescan').onclick = async () => {
  $('libRescan').disabled = true;
  $('feedHint').textContent = 'lese die Platte neu ein…';
  await loadLib(true);
  renderFeed();
  $('libRescan').disabled = false;
};

/* Alle Vorschauen gleichzeitig — der Knopf aus der alten Uebersicht, und der schnellste Weg
   zum "ich erkenne es, wenn ich es sehe". Bewusst auf die aktuelle Filtermenge begrenzt: 130
   Rahmen gleichzeitig laedt niemand, und wer alles sehen will, filtert oder sucht vorher.
   Die Grenze steht sichtbar im Hinweis, statt still zu kappen. */
const RAHMEN_MAX = 25;
$('libPreviewAll').onclick = () => {
  if (offen.size) {
    offen.clear();
    $('libPreviewAll').textContent = 'Alle Vorschauen';
    renderFeed();
    return;
  }
  const sichtbar = bestandZeilen().filter((r) => r.pfad && VORSCHAU.test(r.pfad));
  const nehmen = sichtbar.slice(0, RAHMEN_MAX);
  nehmen.forEach((r) => offen.add(r.key));
  $('libPreviewAll').textContent = 'Vorschauen zu';
  renderFeed();
  if (!sichtbar.length) $('feedHint').textContent = 'Keine Datei im Filter, die sich zeigen lässt';
  else if (sichtbar.length > nehmen.length) {
    $('feedHint').textContent += ` · Vorschau auf ${RAHMEN_MAX} begrenzt`
      + ` (${sichtbar.length - nehmen.length} nicht geladen)`;
  }
};

let searchTimer = null;
$('searchInput').oninput = (ev) => {
  clearTimeout(searchTimer);
  const v = ev.target.value;
  searchTimer = setTimeout(() => {
    query = v;
    renderAll();
  }, 150);
};

/* ── Mail-Assistent ──
   Ein Klick, ein IPC-Aufruf, der Hauptprozess macht den Rest (Modell, Fehlertagebuch,
   Dashboard-Rebuild). Der Modellaufruf selbst dauert meist 60-120s — ohne sichtbaren
   Sekundenzaehler wirkt das wie ein Haenger, obwohl er nur lange braucht. */
$('maGenerate').onclick = async () => {
  const btn = $('maGenerate');
  const status = $('maStatus');
  btn.disabled = true;
  $('maResult').hidden = true;
  let seconds = 0;
  status.textContent = 'Generiere… (kann 1-2 Minuten dauern) 0s';
  const ticker = setInterval(() => {
    seconds += 1;
    status.textContent = `Generiere… (kann 1-2 Minuten dauern) ${seconds}s`;
  }, 1000);
  try {
    const res = await window.buddy.mailassistGenerate({
      context: $('maContext').value,
      draft: $('maDraft').value,
      intent: $('maIntent').value,
    });
    if (!res.ok) {
      status.textContent = res.message || 'Fehlgeschlagen';
      return;
    }
    status.textContent = res.corrections.length
      ? `Fertig — ${res.corrections.length} Korrektur(en) ins Fehlertagebuch übernommen`
      : 'Fertig';
    $('maFinalText').textContent = res.final;
    $('maCorrections').innerHTML = res.corrections.length
      ? res.corrections.map((c) => `
        <div class="ma-corr-row">
          <span class="ma-corr-tag">${esc(c.type || 'Sonstige')}</span>
          <span class="ma-corr-wrong">${esc(c.wrong || '')}</span>
          <span class="ma-corr-arrow">→</span>
          <span class="ma-corr-right">${esc(c.right || '')}</span>
          <span class="ma-corr-note">${esc(c.note || '')}</span>
        </div>`).join('')
      : '<div class="ma-corr-empty">Keine Korrekturen — der Entwurf war schon in Ordnung.</div>';
    $('maResult').hidden = false;
  } catch (err) {
    status.textContent = 'Fehler: ' + err.message;
  } finally {
    clearInterval(ticker);
    btn.disabled = false;
  }
};

$('maCopy').onclick = () => {
  const text = $('maFinalText').textContent || '';
  if (text) window.buddy.copyText(text);
};

/* ── Prioritäten ──
   Karten zum Ziehen, Aufgaben zum Abhaken. Die Aufgaben stammen aus den Projektnotizen in
   Vault 2; ein Haken wird dort gesetzt (todos.js), nicht im Panel gemerkt. Die Reihenfolge
   gehört dem Panel (data/prioritaeten.json). */
const TODO_COLORS = {
  hard: '#C0392B', loss: '#B9770E', soft: '#2E7D32', move: '#6B7280', none: '#8AA0BE',
};
const TODO_CYCLE = ['hard', 'loss', 'soft', 'move', 'none'];
let todoData = { ok: true, items: [], types: {} };
let todoDrag = null;
let todoFromGrip = false;
document.addEventListener('mouseup', () => { todoFromGrip = false; });

async function loadTodos() {
  // Mitten im Ziehen nicht neu zeichnen: die Karte unter dem Zeiger waere weg.
  if (todoDrag) return;
  todoData = await window.buddy.todosLoad();
  renderTodos();
}

function renderTodos() {
  const list = $('todoList');
  list.innerHTML = '';
  const items = todoData.items || [];
  const open = items.reduce((n, it) => n + it.tasks.filter((t) => !t.done).length, 0);
  const total = items.reduce((n, it) => n + it.tasks.length, 0);
  $('viewTodoCount').textContent = open ? `(${open})` : '';
  $('todoBadge').textContent = total ? `${total - open} von ${total} erledigt` : '';
  if (!todoData.ok) {
    list.innerHTML = `<li class="empty">${esc(todoData.message || 'Prioritäten nicht lesbar')}</li>`;
    return;
  }
  if (!items.length) {
    list.innerHTML = '<li class="empty">Keine Projektnotiz mit Aufgaben in Vault 2 (wiki/projects).</li>';
    return;
  }
  items.forEach((it, idx) => list.append(todoCard(it, idx)));
}

function todoCard(it, idx) {
  const types = todoData.types || {};
  const done = it.tasks.filter((t) => t.done).length;
  const li = document.createElement('li');
  li.className = 'td-card' + (done === it.tasks.length ? ' all-done' : '');
  li.dataset.id = it.id;
  li.style.setProperty('--c', TODO_COLORS[it.type] || TODO_COLORS.none);
  li.innerHTML = `
    <div class="td-grip" title="Ziehen">⋮⋮</div>
    <div class="td-rank">${idx + 1}</div>
    <div class="td-body">
      <div class="td-head">
        <h3 class="td-title">${esc(it.title)}</h3>
        <button class="td-badge" type="button" title="Klick wechselt die Einstufung">${esc(types[it.type] || it.type)}</button>
        <span class="td-count">${done}/${it.tasks.length}</span>
      </div>
      ${it.deadline ? `<div class="td-when">${esc(it.deadline)}</div>` : ''}
      ${it.why ? `<div class="td-why">${esc(it.why)}</div>` : ''}
    </div>
    <ul class="td-tasks"></ul>`;
  li.querySelector('.td-badge').onclick = async () => {
    const next = TODO_CYCLE[(TODO_CYCLE.indexOf(it.type) + 1) % TODO_CYCLE.length];
    await window.buddy.todosMeta(it.id, { type: next });
    loadTodos();
  };
  const ul = li.querySelector('.td-tasks');
  it.tasks.forEach((t) => {
    const row = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.onchange = async () => {
      const res = await window.buddy.todosToggle(it.id, t.text, cb.checked);
      if (!res.ok) $('todoNote').textContent = res.message;
      loadTodos();
    };
    const span = document.createElement('span');
    span.textContent = t.text;
    label.append(cb, span);
    row.append(label);
    ul.append(row);
  });
  attachTodoDrag(li);
  return li;
}

/* Gezogen wird nur am Griff. Die Karte selbst ist draggable, damit der Browser ein
   Ziehbild bauen kann; ohne Griff-Flag wuerde jeder Klick auf Text oder Haken ein Ziehen
   starten. */
function attachTodoDrag(li) {
  const list = $('todoList');
  li.draggable = true;
  li.querySelector('.td-grip').addEventListener('mousedown', () => { todoFromGrip = true; });
  li.addEventListener('dragstart', (e) => {
    if (!todoFromGrip) { e.preventDefault(); return; }
    todoDrag = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });
  li.addEventListener('dragend', async () => {
    todoFromGrip = false;
    li.classList.remove('dragging');
    list.querySelectorAll('.over-top,.over-bottom').forEach((c) => c.classList.remove('over-top', 'over-bottom'));
    if (!todoDrag) return;
    todoDrag = null;
    await window.buddy.todosOrder([...list.children].map((c) => c.dataset.id));
    loadTodos();
  });
  li.addEventListener('dragover', (e) => {
    if (!todoDrag || todoDrag === li) return;
    e.preventDefault();
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    list.querySelectorAll('.over-top,.over-bottom').forEach((c) => c.classList.remove('over-top', 'over-bottom'));
    li.classList.add(after ? 'over-bottom' : 'over-top');
    list.insertBefore(todoDrag, after ? li.nextSibling : li);
  });
}

$('todoCopy').onclick = async () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const lines = [`## Prioritäten ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, ''];
  (todoData.items || []).forEach((it, i) => {
    lines.push(`${i + 1}. **${it.title}**${it.deadline ? ` (${it.deadline})` : ''}`);
    it.tasks.forEach((t) => lines.push(`   - [${t.done ? 'x' : ' '}] ${t.text}`));
  });
  await window.buddy.copyText(lines.join('\n') + '\n');
  $('todoNote').textContent = 'Markdown in der Ablage';
};

window.buddy.onTodosChanged(loadTodos);

$('reloadBtn').onclick = load;
window.buddy.onChanged(load);
// Neue Events kommen per Datei-Watcher. Der Minutentakt ist fuer das, was sich ohne
// neue Events aendert: "vor x min", der Kollektor-Zustand und der Tageswechsel.
setInterval(load, 60_000);
load();
loadTodos();

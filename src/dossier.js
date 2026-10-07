const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ── Kontext-Mappe ──
   Die Mappe ist kuratiert, nicht abgeleitet: hier landet, was Leonie selbst hineinlegt,
   plus je Eintrag ein Satz "wofuer ist das". Zweck ist eine vollstaendige Kontextliste,
   die eine neue Claude-Sitzung als erstes liest — nicht ein zweiter Speicherort fuer
   Inhalte. Deshalb nur Verweise (Pfad/URL) und Notizen, niemals kopierter Text:
   Confluence bleibt fuehrendes Medium, eine Kopie hier waere ab morgen falsch. */

const DATA_DIR = path.join(__dirname, '..', 'data');
const VAULT = path.join(os.homedir(), 'OneDrive - Allianz', 'Dokumente', 'Obsidian Vault');

const ROLLEN = ['Auftrag', 'Quelle', 'Prototyp', 'Vorlage', 'Doku', 'Referenz'];
const STAENDE = ['ungeprüft', 'aktuell', 'veraltet'];

function fileFor(projectId) {
  return path.join(DATA_DIR, `dossier-${projectId}.json`);
}

function read(projectId) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(projectId), 'utf8'));
    return {
      project: projectId,
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      updated: raw.updated || null,
    };
  } catch {
    return { project: projectId, entries: [], updated: null };
  }
}

function write(projectId, entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = { project: projectId, updated: new Date().toISOString(), entries };
  fs.writeFileSync(fileFor(projectId), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/* ── Verweis normalisieren ──
   Derselbe Vault-Pfad darf nicht zweimal in der Mappe stehen, egal ob er per Drag&Drop
   (absoluter Windows-Pfad) oder aus dem Verlauf (Vault-relativ, Slashes) kommt. */
function normalizeRef(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) {
    return { kind: kindForUrl(s), ref: s, url: s };
  }
  // Ein relativer Pfad bedeutet in dieser App immer vault-relativ — so kommen die
  // Verweise aus dem Verlauf. Gegen das Arbeitsverzeichnis aufzuloesen ergaebe Pfade,
  // die es nicht gibt, und derselbe Eintrag laege zweimal in der Mappe.
  const abs = path.isAbsolute(s) ? path.resolve(s) : path.join(VAULT, s);
  const rel = path.relative(VAULT, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const posix = rel.replace(/\\/g, '/');
    return { kind: 'vault', ref: posix, url: 'obsidian://open?path=' + encodeURIComponent(abs) };
  }
  return { kind: 'file', ref: abs.replace(/\\/g, '/'), url: 'file:///' + abs.replace(/\\/g, '/') };
}

function kindForUrl(url) {
  const u = url.toLowerCase();
  if (u.includes('cmp.allianz.net')) return 'confluence';
  if (u.includes('jmp.allianz.net')) return 'jira';
  if (u.includes('github.developer.allianz.io') || u.includes('github.com')) return 'github';
  if (u.startsWith('obsidian:')) return 'vault';
  // Eigenes Schema aus dem Panel: outlook:<EntryID>. Kein echtes URL-Schema, sondern der
  // Weg, eine Mail ueberhaupt in die Mappe legen zu koennen — sie hat keinen Pfad.
  if (u.startsWith('outlook:')) return 'mail';
  return 'url';
}

function titleFromRef(kind, ref) {
  if (kind === 'vault' || kind === 'file') {
    return path.basename(ref).replace(/\.(md|canvas|base)$/i, '');
  }
  // Die EntryID ist 140 Zeichen Hex und sagt nichts. Der Titel kommt aus dem Panel mit;
  // das hier ist nur der Notnagel, wenn er fehlt.
  if (kind === 'mail') return 'Mail';
  try {
    const u = new URL(ref);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || u.hostname).replace(/\+/g, ' ');
  } catch {
    return ref;
  }
}

function idFor(ref) {
  return crypto.createHash('sha1').update(ref).digest('hex').slice(0, 10);
}

/* Ordner werden aufgeklappt: "alles zu dem Thema" heisst in der Praxis meist ein Ordner,
   und einzeln hineinziehen waere Handarbeit. Nicht rekursiv unbegrenzt — zwei Ebenen
   reichen fuer Vault-Ordner und halten die Mappe lesbar. */
const DOSSIER_EXT = ['.md', '.canvas', '.base', '.html', '.pdf', '.pptx', '.xlsx', '.docx', '.py', '.js'];

function expand(refInput, depth = 2) {
  const out = [];
  const s = String(refInput || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return [refInput]; // URL
  const abs = path.isAbsolute(s) ? path.resolve(s) : path.join(VAULT, s);
  let st = null;
  try { st = fs.statSync(abs); } catch { /* URL oder verschwunden */ }
  if (!st || !st.isDirectory()) return [refInput];

  const walk = (dir, level) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (level > 0) walk(p, level - 1);
      } else if (DOSSIER_EXT.includes(path.extname(ent.name).toLowerCase())) {
        out.push(p);
      }
    }
  };
  walk(abs, depth - 1);
  return out;
}

function addEntries(projectId, items) {
  const d = read(projectId);
  const byId = new Map(d.entries.map((e) => [e.id, e]));
  let added = 0;
  let skipped = 0;

  for (const item of items) {
    const raw = typeof item === 'string' ? { ref: item } : (item || {});
    const many = expand(raw.ref);
    if (!many.length) skipped += 1; // leerer Ordner: nicht stillschweigend verschlucken
    for (const one of many) {
      const norm = normalizeRef(one);
      if (!norm) { skipped += 1; continue; }
      const id = idFor(norm.ref);
      if (byId.has(id)) {
        // Schon drin: nur fehlende Felder auffuellen, nie eine vorhandene Zweck-Zeile
        // ueberschreiben.
        const cur = byId.get(id);
        if (!cur.zweck && raw.zweck) cur.zweck = raw.zweck;
        if (!cur.rolle && raw.rolle) cur.rolle = raw.rolle;
        skipped += 1;
        continue;
      }
      const entry = {
        id,
        kind: norm.kind,
        ref: norm.ref,
        url: norm.url,
        title: raw.title || titleFromRef(norm.kind, norm.ref),
        rolle: raw.rolle || '',
        zweck: raw.zweck || '',
        stand: raw.stand || 'ungeprüft',
        from: raw.from || 'manuell',
        added: new Date().toISOString(),
      };
      byId.set(id, entry);
      d.entries.push(entry);
      added += 1;
    }
  }

  write(projectId, d.entries);
  return { added, skipped, entries: d.entries };
}

const PATCHABLE = ['title', 'rolle', 'zweck', 'stand'];

function updateEntry(projectId, id, patch) {
  const d = read(projectId);
  const e = d.entries.find((x) => x.id === id);
  if (!e) return { ok: false, entries: d.entries };
  for (const k of PATCHABLE) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) e[k] = patch[k];
  }
  write(projectId, d.entries);
  return { ok: true, entries: d.entries };
}

function removeEntry(projectId, id) {
  const d = read(projectId);
  const entries = d.entries.filter((x) => x.id !== id);
  write(projectId, entries);
  return { ok: true, entries };
}

/* ── Export in den Vault ──
   Die JSON ist die Wahrheit, die Notiz ist der Spiegel: in Obsidian durchsuchbar, auf dem
   Handy lesbar, und der Einstiegspunkt fuer eine neue Claude-Sitzung. Zwischen den Markern
   wird ersetzt, alles davor und danach bleibt unangetastet — dort kann von Hand geschrieben
   werden, ohne dass der naechste Export es frisst. */
const START = '<!-- kontext:start — automatisch erzeugt, hier nichts von Hand eintragen -->';
const END = '<!-- kontext:end -->';

function mdEscape(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function refCell(e) {
  if (e.kind === 'vault') {
    const note = e.ref.replace(/\.(md|canvas|base)$/i, '');
    return `[[${note.split('/').pop()}]] <small>${mdEscape(e.ref)}</small>`;
  }
  if (e.kind === 'file') return `\`${mdEscape(e.ref)}\``;
  /* Eine EntryID ist kein Link, den man in Obsidian anklicken kann — sie gilt nur
     innerhalb dieses Outlook-Profils. Also ehrlich benennen statt einen Link vorspiegeln,
     der ins Nichts fuehrt. Wer den Volltext im Vault braucht, holt ihn mit
     outlook_export.py; dann steht die exportierte Notiz als eigener vault-Eintrag hier. */
  if (e.kind === 'mail') return 'Mail in Outlook <small>nur lokal auffindbar</small>';
  return `[Link](${e.url})`;
}

function buildBlock(project, entries) {
  const today = new Date().toISOString().slice(0, 10);
  const offen = entries.filter((e) => !e.zweck);
  const lines = [];
  lines.push(START);
  lines.push('');
  lines.push(`> [!info] Kontext-Mappe ${project.label}`);
  if (project.auftraggeber) lines.push(`> Auftrag von ${project.auftraggeber}`);
  lines.push(`> ${entries.length} Einträge · Stand ${today} · Quelle: Work Buddy`);
  lines.push('> Verweise, keine Kopien — Confluence bleibt führendes Medium.');
  lines.push('');

  const byRolle = new Map();
  for (const e of entries) {
    const k = e.rolle || 'ohne Rolle';
    if (!byRolle.has(k)) byRolle.set(k, []);
    byRolle.get(k).push(e);
  }
  const order = [...ROLLEN, 'ohne Rolle'].filter((r) => byRolle.has(r));

  for (const rolle of order) {
    lines.push(`### ${rolle}`);
    lines.push('');
    lines.push('| Was | Wofür | Stand |');
    lines.push('|---|---|---|');
    for (const e of byRolle.get(rolle)) {
      lines.push(`| **${mdEscape(e.title)}**<br>${refCell(e)} | ${mdEscape(e.zweck) || '—'} | ${mdEscape(e.stand)} |`);
    }
    lines.push('');
  }

  if (offen.length) {
    lines.push(`> [!warning] ${offen.length} Einträge ohne Zweck`);
    lines.push('> ' + offen.map((e) => mdEscape(e.title)).join(', '));
    lines.push('');
  }

  lines.push(END);
  return lines.join('\n');
}

function exportToVault(project, targetDir) {
  const d = read(project.id);
  if (!d.entries.length) return { ok: false, message: 'Mappe ist leer — nichts zu exportieren.' };
  if (!targetDir) return { ok: false, message: `Für ${project.label} ist kein Vault-Ziel gesetzt (vaultDir).` };

  const dir = path.join(VAULT, targetDir);
  if (!fs.existsSync(dir)) return { ok: false, message: 'Zielordner fehlt im Vault: ' + targetDir };

  const file = path.join(dir, `kontext-${project.id}.md`);
  const block = buildBlock(project, d.entries);
  let out;

  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    // Vor jedem Ueberschreiben eine Sicherung, aber nur die erste des Tages — sonst
    // ueberschreibt der zweite Export das Backup des ersten.
    const bak = file.replace(/\.md$/, `.BACKUP-${new Date().toISOString().slice(0, 10)}.md`);
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, cur, 'utf8');

    const a = cur.indexOf(START);
    const b = cur.indexOf(END);
    if (a !== -1 && b !== -1 && b > a) {
      out = cur.slice(0, a) + block + cur.slice(b + END.length);
    } else {
      // Marker fehlen (von Hand angelegte Notiz): Block anhaengen, bestehenden Text lassen.
      out = cur.replace(/\s*$/, '\n\n') + block + '\n';
    }
  } else {
    out = [
      '---',
      'tags: [kontext, projekt]',
      `created: ${new Date().toISOString().slice(0, 10)}`,
      `projekt: ${project.id}`,
      `auftraggeber: ${project.auftraggeber || ''}`,
      'status: laufend',
      '---',
      '',
      `# Kontext-Mappe — ${project.label}`,
      '',
      block,
      '',
      '## Eigene Notizen',
      '',
      '<!-- Alles ausserhalb der kontext-Marker bleibt beim Export erhalten. -->',
      '',
    ].join('\n');
  }

  fs.writeFileSync(file, out, 'utf8');
  return { ok: true, file, count: d.entries.length };
}

module.exports = {
  read, addEntries, updateEntry, removeEntry, exportToVault,
  ROLLEN, STAENDE, VAULT, fileFor,
};

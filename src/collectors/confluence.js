const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { emit } = require('./emit');

const POLL_MS = 5 * 60 * 1000;

// Kein hartcodiertes Token. Der PAT steht schon in der MCP-Konfiguration, die wird gelesen.
function readConfig() {
  const p = path.join(os.homedir(), '.mcp.json');
  const args = JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers?.confluence?.args || [];
  const val = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return {
    base: val('--confluence-url'),
    token: val('--confluence-personal-token'),
    insecure: args.includes('--no-confluence-ssl-verify'),
  };
}

function getJson(url, token, insecure) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      rejectUnauthorized: !insecure, // Allianz-Zertifikatskette, gleiche Ausnahme wie beim MCP
      timeout: 60_000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 200)));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* ── Anhaenge sind keine Seiten ──
   Ohne "type = page" liefert die Suche auch Attachments: jedes eingefuegte Bild, dazu die
   ~*.tmp-Dateien, die draw.io beim Speichern anlegt. Im Verlauf war das nur Rauschen, im
   Bestand ist es eine Luege — "Unbenanntes Diagramm-1785834832379.png" ist kein Ding, das
   Leonie hat, sondern ein Nebenprodukt davon, dass sie ein Diagramm gespeichert hat.

   Der Titel ist die einzige Handhabe fuer Ereignisse, die schon im Log stehen: dort wurde
   kein type mitgeschrieben. Deshalb exportiert, statt im Bestand nachgebaut zu werden. */
const ANHANG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|tmp|pdf|drawio|xlsx?|docx?|pptx?|csv|zip|mp4|msg)$/i;

function anhangartig(title) {
  return ANHANG_EXT.test(String(title || '').trim());
}

/* ── Die Ahnenkette mitschreiben ──
   Der Space sagt nichts darueber, zu welchem Auftrag eine Seite gehoert: AIPC enthaelt die
   Foto2Text-Studie, die Claude-Code-Dokumentation und den Deck-Baukasten gleichzeitig. Der
   Platz im Seitenbaum sagt es. `expand=ancestors` liefert ihn in derselben Abfrage, also
   kostet er keine Anfrage extra.

   Er landet nicht im Ereignis, sondern in data/confluence-baum.json: die Kette gehoert zur
   Seite, nicht zur Aenderung, und sie aendert sich beim Umhaengen. Im Log stuende sie sonst
   als Momentaufnahme, die nie wieder korrigiert wird. Geschrieben wird nur bei echter
   Aenderung — sonst weckt jeder Poll-Zyklus die Dateiueberwachung im Hauptprozess. */
function baumSchreiben(seiten, log) {
  const datei = path.join(__dirname, '..', '..', 'data', 'confluence-baum.json');
  let alt = {};
  try {
    alt = JSON.parse(fs.readFileSync(datei, 'utf8'));
    if (!alt || typeof alt !== 'object' || Array.isArray(alt)) alt = {};
  } catch {
    // Erster Lauf oder kaputte Datei: neu aufbauen ist billiger als reparieren.
  }
  const neu = { ...alt };
  let geaendert = 0;
  for (const p of seiten) {
    if (!p.id || !Array.isArray(p.ancestors)) continue;
    const kette = p.ancestors.map((a) => a.title).filter(Boolean);
    if (JSON.stringify(alt[p.id]) === JSON.stringify(kette)) continue;
    neu[p.id] = kette;
    geaendert += 1;
  }
  if (!geaendert) return 0;
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  fs.writeFileSync(datei, JSON.stringify(neu, null, 2), 'utf8');
  if (log) log(`confluence: Baum aktualisiert, ${geaendert} Seite(n)`);
  return geaendert;
}

async function poll(log) {
  const { base, token, insecure } = readConfig();
  if (!base || !token) { log('confluence: keine Konfiguration in ~/.mcp.json'); return; }

  // Webhooks sind fuer einen normalen Nutzer nicht erreichbar (403 auf /rest/api/webhooks,
  // 404 auf /rest/webhooks/1.0/webhook), und eine lokale App hat kein Ziel fuer einen
  // Callback. Deshalb Polling. Die Sortierung heisst kleingeschrieben "lastmodified".
  const url = base + '/rest/api/content/search?' + new URLSearchParams({
    cql: 'type = page and contributor = currentUser() order by lastmodified desc',
    limit: '50',
    expand: 'version,space,history.lastUpdated,ancestors',
  });

  const d = await getJson(url, token, insecure);
  // Vor der Anhang-Filterung: die Kette einer Seite ist auch dann brauchbar, wenn dieses
  // Ereignis uebersprungen wird.
  baumSchreiben(d.results || [], log);
  let neu = 0;
  let anhang = 0;
  for (const p of d.results || []) {
    // Doppelt gesichert: falls diese Confluence-Version das CQL-Praedikat anders auslegt,
    // faengt der type aus der Antwort es noch ab.
    if ((p.type && p.type !== 'page') || anhangartig(p.title)) { anhang += 1; continue; }
    const when = p.history?.lastUpdated?.when;
    if (!when) continue;
    const v = p.version?.number || 1;
    const space = p.space?.key || '?';
    if (emit({
      ts: when,
      source: 'confluence',
      action: v === 1 ? 'created' : 'updated',
      title: p.title,
      detail: 'v' + v + ' · Space ' + space,
      url: base + '/pages/viewpage.action?pageId=' + p.id,
      meta: { version: v, space, pageId: p.id, type: p.type || 'page' },
    })) neu += 1;
  }
  log(`confluence: ${d.results?.length || 0} Treffer, ${neu} neu`
    + (anhang ? `, ${anhang} Anhaenge uebersprungen` : ''));
}

function start(log) {
  const run = () => poll(log).catch((e) => log('confluence failed: ' + e.message));
  run();
  const t = setInterval(run, POLL_MS);
  return () => clearInterval(t);
}

// readConfig/getJson/baumSchreiben sind mitexportiert, damit das Nachfuell-Werkzeug in
// tools/ dieselbe Konfiguration und dieselbe Schreiblogik benutzt statt einer zweiten Kopie.
module.exports = {
  start, poll, POLL_MS, anhangartig, readConfig, getJson, baumSchreiben,
};

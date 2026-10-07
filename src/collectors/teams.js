const crypto = require('crypto');
const { clipboard } = require('electron');
const { emit } = require('./emit');
const bus = require('./bus');

const POLL_MS = 1500;
// Dieselbe Nachricht darf innerhalb einer Stunde nur einmal zaehlen. Zweimal kopieren
// nach zwei Stunden ist eine echte zweite Handlung und wird wieder gezaehlt.
const REPEAT_MS = 60 * 60 * 1000;

// Teams haengt an kopierte Nachrichten Schema-Marker. Nur daran wird die Herkunft
// erkannt — die IndexedDB von Teams liegt als gesperrte .ldb-Dateien vor und wird
// bewusst nicht angefasst.
const MSG_MARKER = /itemtype=["']https?:\/\/schema\.skype\.com\/Message["']/i;
const ANY_SKYPE = /schema\.skype\.com/i;

function stripTags(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function senderOf(html) {
  // Person-Blocks tragen den Anzeigenamen, je nach Teams-Version an unterschiedlicher Stelle.
  const m =
    html.match(/itemtype=["']https?:\/\/schema\.skype\.com\/Person["'][^>]*itemid=["']([^"']+)["']/i) ||
    html.match(/itemprop=["']userDisplayName["'][^>]*>([^<]+)</i) ||
    html.match(/aria-label=["']([^"']{2,60}?)\s+(?:sagte|said)/i);
  if (!m) return null;
  return m[1].replace(/^8:orgid:/, '').trim() || null;
}

let lastHash = null;

function tick(log) {
  let html;
  try {
    html = clipboard.readHTML();
  } catch (e) {
    return;
  }
  if (!html || !ANY_SKYPE.test(html) || !MSG_MARKER.test(html)) return;

  const text = stripTags(html);
  if (!text) return;

  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
  if (hash === lastHash) return; // unveraenderte Zwischenablage, nicht jede Sekunde neu pruefen
  lastHash = hash;

  const from = senderOf(html);
  const snippet = text.length > 90 ? text.slice(0, 90) + ' …' : text;
  const bucket = Math.floor(Date.now() / REPEAT_MS);

  const wrote = emit({
    ts: new Date().toISOString(),
    source: 'teams',
    action: 'copied',
    title: snippet,
    detail: from ? 'von ' + from : 'Teams-Nachricht',
    url: '',
    meta: { dedupe: `teams|${hash}|${bucket}`, hash, from, chars: text.length },
  });

  if (wrote) {
    // Merken, damit eine kurz darauf geaenderte Vault-Datei als Ziel markiert werden kann.
    bus.noteTeamsCopy({ from, snippet });
    log(`teams: Nachricht kopiert${from ? ' von ' + from : ''} (${text.length} Zeichen)`);
  }
}

function start(log) {
  const t = setInterval(() => {
    try { tick(log); } catch (e) { log('teams failed: ' + e.message); }
  }, POLL_MS);
  log('teams: Clipboard-Erkennung aktiv (' + POLL_MS + 'ms)');
  return () => clearInterval(t);
}

module.exports = { start, POLL_MS, stripTags, senderOf, MSG_MARKER };

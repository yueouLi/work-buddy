/* Fuellt data/confluence-baum.json fuer Seiten nach, die schon im Ereignis-Log stehen.
 *
 * Wozu: die Zuordnung benutzt den Platz einer Seite im Confluence-Baum statt des Spaces
 * (Begruendung steht in src/projects.js). Der Kollektor schreibt die Ahnenkette ab jetzt bei
 * jedem Poll mit — fuer die 55 Confluence-Ereignisse, die vorher entstanden sind, fehlt sie.
 * Ohne Nachfuellen faellt die halbe Vergangenheit auf "Sonstiges".
 *
 * Eine CQL-Abfrage deckt sie ab, weil der Kollektor genau dieselbe benutzt
 * (contributor = currentUser()) — es sind dieselben Seiten, nur weiter zurueck. Der Lauf
 * blaettert bis 400 Seiten und meldet am Ende, welche pageIds im Log trotzdem unbekannt
 * bleiben; das sind geloeschte oder fremde Seiten.
 *
 * Aufruf:  node tools/confluence-baum-fuellen.js
 * Schreibt nur data/confluence-baum.json. Der Ereignis-Log wird nicht angefasst.
 */
const fs = require('fs');
const { readConfig, getJson, baumSchreiben } = require('../src/collectors/confluence');
const { readEvents } = require('../src/store');
const { loadBaum, BAUM_FILE } = require('../src/projects');

const SEITEN_MAX = 400;
const PRO_ABFRAGE = 50;

async function main() {
  const { base, token, insecure } = readConfig();
  if (!base || !token) {
    console.log('Keine Confluence-Konfiguration in ~/.mcp.json gefunden.');
    process.exit(1);
  }

  const alle = [];
  for (let start = 0; start < SEITEN_MAX; start += PRO_ABFRAGE) {
    const url = base + '/rest/api/content/search?' + new URLSearchParams({
      cql: 'type = page and contributor = currentUser() order by lastmodified desc',
      limit: String(PRO_ABFRAGE),
      start: String(start),
      expand: 'space,ancestors',
    });
    const d = await getJson(url, token, insecure);
    const treffer = d.results || [];
    alle.push(...treffer);
    console.log(`  ab ${start}: ${treffer.length} Seiten`);
    if (treffer.length < PRO_ABFRAGE) break;
  }

  const geschrieben = baumSchreiben(alle, null);
  console.log(`${alle.length} Seiten geholt, ${geschrieben} Ketten neu oder geaendert.`);
  console.log('Datei: ' + BAUM_FILE);

  // Gegenprobe: welche Seiten im Log haben danach noch keine Kette?
  loadBaum();
  const baum = JSON.parse(fs.readFileSync(BAUM_FILE, 'utf8'));
  const offen = new Map();
  for (const e of readEvents({ roh: true })) {
    if (e.source !== 'confluence') continue;
    const id = e.meta && e.meta.pageId;
    if (!id || baum[String(id)]) continue;
    if (!offen.has(String(id))) offen.set(String(id), e.title);
  }
  if (!offen.size) {
    console.log('Jede Confluence-Seite im Log hat jetzt eine Ahnenkette.');
    return;
  }
  console.log(`\n${offen.size} Seite(n) im Log ohne Kette — sie bleiben bei "Sonstiges",`);
  console.log('bis sie erneut bearbeitet werden oder von Hand zugeordnet sind:');
  for (const [id, titel] of offen) console.log(`  ${id}  ${titel}`);
}

main().catch((e) => {
  console.log('Abgebrochen: ' + e.message);
  process.exit(1);
});

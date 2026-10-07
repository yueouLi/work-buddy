const {
  app, BrowserWindow, ipcMain, shell, dialog, clipboard,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { DATA_FILE, readEvents, summarize } = require('./store');
const {
  listProjects, loadConfig, CONFIG_FILE,
  loadOverrides, setOverride, clearOverride, OVERRIDE_FILE,
  loadBaum, BAUM_FILE,
} = require('./projects');
const dossier = require('./dossier');
const auftrag = require('./auftrag');
const trash = require('./trash');
const library = require('./library');
const collectors = require('./collectors');
const mailassist = require('./mailassist');
const todos = require('./todos');

let win = null;
let stopCollectors = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Work Buddy',
    backgroundColor: '#F0F4FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenuBarVisibility(false);
}

function watchData() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  let timer = null;
  fs.watch(path.dirname(DATA_FILE), (_e, file) => {
    // Auch auf projects.json, zuordnung.json und confluence-baum.json hoeren: eine
    // geaenderte Regel, eine Handzuordnung oder eine neu bekannte Ahnenkette soll ohne
    // Neustart greifen.
    const watched = [DATA_FILE, CONFIG_FILE, OVERRIDE_FILE, BAUM_FILE].map((f) => path.basename(f));
    if (!watched.includes(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('events:changed');
    }, 300);
  });

  // Die Projektnotizen in Vault 2 aendern sich auch ausserhalb des Panels (/todo, Obsidian).
  // Eigener Kanal, damit dafuer nicht der ganze Verlauf neu geladen wird.
  try {
    let tTimer = null;
    fs.watch(todos.PROJECTS_DIR, { recursive: true }, () => {
      clearTimeout(tTimer);
      tTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('todos:changed');
      }, 300);
    });
  } catch {
    // Vault nicht da: Ansicht laedt dann beim Oeffnen und meldet es selbst.
  }
}

ipcMain.handle('events:load', () => {
  // Regeln vor dem Lesen laden: readEvents klassifiziert jedes Event, also muss die
  // Konfiguration vorher stehen.
  const cfg = loadConfig();
  const ov = loadOverrides();
  const baum = loadBaum();
  const events = readEvents();
  return {
    events,
    summary: summarize(events),
    status: collectors.getStatus(),
    projects: listProjects(),
    projectsNote: [cfg.ok ? '' : cfg.message, ov.ok ? '' : ov.message,
      baum.ok ? '' : baum.message].filter(Boolean).join(' · '),
    projectsFile: CONFIG_FILE,
    fixedCount: ov.count || 0,
  };
});

/* ── Zuordnung von Hand ──
   Der Renderer schickt das Ereignis und das Zielprojekt, die Schluesselbildung bleibt hier.
   Sonst muesste der Renderer wissen, wie ein Ereignis identifiziert wird — und zwei Stellen
   koennten sich unterscheiden. */
ipcMain.handle('project:assign', (_e, evt, projectId, scope) => {
  if (!evt || typeof evt !== 'object') return { ok: false, message: 'Kein Ereignis' };
  return setOverride(evt, String(projectId || ''), scope === 'ordner' ? 'ordner' : 'datei');
});

ipcMain.handle('project:unassign', (_e, evt) => {
  if (!evt || typeof evt !== 'object') return { ok: false, message: 'Kein Ereignis' };
  return clearOverride(evt);
});

/* ── Kontext-Mappe ──
   Die Mappe wird im Hauptprozess geschrieben; der Renderer schickt nur Absichten. Jede
   Aenderung gibt die vollstaendige Liste zurueck, damit die Anzeige nie raten muss. */
function projectById(id) {
  return listProjects().find((p) => p.id === id) || null;
}

ipcMain.handle('dossier:load', (_e, projectId) => dossier.read(String(projectId || '')));

ipcMain.handle('dossier:add', (_e, projectId, items) => {
  if (!projectById(projectId)) return { added: 0, skipped: 0, entries: [] };
  return dossier.addEntries(projectId, Array.isArray(items) ? items : [items]);
});

ipcMain.handle('dossier:update', (_e, projectId, id, patch) =>
  dossier.updateEntry(String(projectId || ''), String(id || ''), patch || {}));

ipcMain.handle('dossier:remove', (_e, projectId, id) =>
  dossier.removeEntry(String(projectId || ''), String(id || '')));

ipcMain.handle('dossier:export', (_e, projectId) => {
  const p = projectById(projectId);
  if (!p) return { ok: false, message: 'Unbekanntes Projekt' };
  try {
    return dossier.exportToVault(p, p.vaultDir);
  } catch (err) {
    return { ok: false, message: 'Export fehlgeschlagen: ' + err.message };
  }
});

/* ── Übergabe an Claude ──
   Zwei Kanäle, ein Muster: Datei schreiben, Einfüge-Satz in die Ablage legen, beides
   melden. Die Ablage wird hier gesetzt und nicht im Renderer — `navigator.clipboard`
   braucht Fokus und scheitert still, wenn das Fenster gerade keinen hat. Electrons
   clipboard im Hauptprozess ist davon unabhängig.

   Geschrieben wird ausschliesslich data/auftrag.md. Kein Vault, kein Projektordner,
   nichts, was Leonie danach aufräumen müsste. */
ipcMain.handle('auftrag:zeile', (_e, karte) => {
  try {
    const res = auftrag.ausZeile(karte);
    if (res.ok) clipboard.writeText(res.zeile);
    return res;
  } catch (err) {
    return { ok: false, message: 'Übergabe fehlgeschlagen: ' + err.message };
  }
});

ipcMain.handle('auftrag:mappe', (_e, projectId) => {
  try {
    const res = auftrag.ausMappe(projectById(projectId));
    if (res.ok) clipboard.writeText(res.zeile);
    return res;
  } catch (err) {
    return { ok: false, message: 'Übergabe fehlgeschlagen: ' + err.message };
  }
});

/* ── Löschkorb ──
   Auch hier entscheidet der Hauptprozess, was passiert: der Renderer schickt Zeilen und
   den Wunsch "aufraeumen". Verschoben wird in den Vault-Papierkorb, nie geloescht. */
ipcMain.handle('trash:load', () => trash.read());

ipcMain.handle('trash:add', (_e, items) =>
  trash.addEntries(Array.isArray(items) ? items : [items]));

ipcMain.handle('trash:remove', (_e, id) => trash.removeEntry(String(id || '')));

ipcMain.handle('trash:clean', () => {
  try {
    return trash.clean();
  } catch (err) {
    return { ok: false, message: 'Aufräumen fehlgeschlagen: ' + err.message };
  }
});

ipcMain.handle('trash:binstat', () => {
  try {
    return trash.binStat();
  } catch (err) {
    return { dateien: 0, bytes: 0, message: err.message };
  }
});

/* Der echte Loeschweg. Zwei Dinge macht der Hauptprozess hier bewusst selbst:
   - fragen. Ein Ziehen in die Zone ist schnell passiert, das Loeschen soll es nicht sein.
     Der Abbrechen-Knopf ist der Standard, damit Enter nichts wegwirft.
   - shell.trashItem statt fs.unlink. Kostet nichts und macht den Fehlgriff umkehrbar. */
async function frage(nachricht, detail, knopf) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Abbrechen', knopf],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: nachricht,
    detail,
  });
  return response === 1;
}

ipcMain.handle('trash:recycle', async () => {
  try {
    const offen = trash.read().entries.filter((e) => e.file).length;
    if (!offen) return { ok: false, message: 'Keine Datei mit lokalem Pfad im Korb' };
    const ok = await frage(
      `${offen} Datei(en) in den Windows-Papierkorb?`,
      'Danach sind sie nicht mehr im Vault und nicht mehr in OneDrive. Zurückholen geht über '
      + 'den Windows-Papierkorb, solange er nicht geleert ist. Merkposten ohne Datei bleiben '
      + 'in der Liste.',
      `${offen} löschen`,
    );
    if (!ok) return { ok: true, abgebrochen: true, entries: trash.read().entries };
    return await trash.recycle((p) => shell.trashItem(p));
  } catch (err) {
    return { ok: false, message: 'Löschen fehlgeschlagen: ' + err.message };
  }
});

ipcMain.handle('trash:emptybin', async () => {
  try {
    const stat = trash.binStat();
    if (!stat.dateien) return { ok: false, message: 'Vault-Papierkorb ist leer' };
    const ok = await frage(
      `Vault-Papierkorb leeren (${stat.dateien} Datei(en))?`,
      'Der komplette Inhalt von _Papierkorb geht in den Windows-Papierkorb. Das Protokoll '
      + 'bleibt erhalten, damit nachvollziehbar bleibt, was wann wegging.',
      'Leeren',
    );
    if (!ok) return { ok: true, abgebrochen: true };
    return await trash.emptyBin((p) => shell.trashItem(p));
  } catch (err) {
    return { ok: false, message: 'Leeren fehlgeschlagen: ' + err.message };
  }
});

/* ── Bestand ──
   Der Scan laeuft im Hauptprozess, weil er das Dateisystem anfasst. Der Renderer bekommt
   Inventar und Bewertung in einem Rutsch — sonst muesste er zwei Zustaende zusammenfuehren
   und koennte sie auseinanderlaufen lassen. */
ipcMain.handle('library:load', (_e, force) => {
  try {
    return library.laden(force === true);
  } catch (err) {
    // Vollstaendige Form, auch im Fehlerfall: der Renderer liest jedes Feld ohne Pruefung.
    return {
      gescannt: new Date().toISOString(),
      dateien: [], kategorien: [], meta: {}, verwaist: [], orte: [],
      message: 'Scan fehlgeschlagen: ' + err.message,
    };
  }
});

// Der Schluessel ist der Sach-Schluessel aus projects.js, nicht der Dateipfad. Bewertet
// werden auch Confluence-Seiten und Repos, die keinen Pfad haben.
ipcMain.handle('library:set', (_e, key, patch) =>
  library.setzen(String(key || ''), patch && typeof patch === 'object' ? patch : {}));

// Ordner der Datei im Explorer zeigen. Bei "wo liegt das Ding eigentlich" ist der Ordner
// die Antwort, nicht die geoeffnete Datei — deshalb ein eigener Kanal.
ipcMain.handle('open:folder', (_e, p) => {
  if (typeof p !== 'string' || !p) return { ok: false, message: 'Kein Pfad' };
  const ziel = path.normalize(p);
  // showItemInFolder gibt nichts zurueck und meldet auch nichts, wenn die Datei weg ist —
  // der Explorer geht dann einfach nicht auf. Also vorher selbst nachsehen.
  if (!fs.existsSync(ziel)) return { ok: false, message: 'Liegt nicht mehr dort: ' + ziel };
  shell.showItemInFolder(ziel);
  return { ok: true };
});

/* Eine Mail aufschlagen, nicht kopieren. Der Weg geht durch dasselbe Python-Werkzeug im
   outlook-context Skill, das auch die Ereignisse liest — Outlook wird also nur an einer
   Stelle im Panel angefasst. Nichts wird gesendet, nichts geaendert: --open ruft
   Item.Display(), das oeffnet das Fenster und wartet auf Leonie. */
ipcMain.handle('outlook:open', (_e, id) => {
  if (typeof id !== 'string' || !id) return { ok: false, message: 'Keine EntryID' };
  return require('./collectors/outlook').oeffnen(id);
});

/* Alle drei Oeffnen-Kanaele geben dieselbe Form zurueck: { ok, message }. Vorher stand
   hier ein nacktes true, das auch dann kam, wenn Windows nichts geoeffnet hat — ein Klick,
   der nichts tut und nichts sagt, sieht wie ein Fehler im Panel aus. */
ipcMain.handle('open:external', async (_e, url) => {
  if (typeof url !== 'string' || !url) return { ok: false, message: 'Keine URL' };
  if (!/^(https?|obsidian):/i.test(url)) {
    return { ok: false, message: 'Schema nicht erlaubt: ' + url.split(':')[0] };
  }
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

// Lokale Dateien aus der Mappe (HTML-Prototypen, PPTX, Excel) mit dem Standardprogramm
// oeffnen. Getrennt vom URL-Kanal, damit der dortige Filter streng bleiben kann.
ipcMain.handle('open:file', async (_e, p) => {
  if (typeof p !== 'string' || !p) return { ok: false, message: 'Kein Pfad' };
  const ziel = path.normalize(p);
  if (!fs.existsSync(ziel)) return { ok: false, message: 'Liegt nicht mehr dort: ' + ziel };
  // shell.openPath meldet den Fehler als Rueckgabewert, nicht als Ausnahme: leerer String
  // heisst geoeffnet, alles andere ist die Windows-Meldung ("keine Anwendung verknuepft").
  const fehler = await shell.openPath(ziel);
  return fehler ? { ok: false, message: fehler } : { ok: true };
});

/* ── Mail-Assistent ──
   Ein IPC-Kanal, ein Modellaufruf im Hauptprozess (spawnt die schon vorhandene claude-CLI,
   dieselbe Bedrock-Authentifizierung wie Claude Code selbst — kein zweiter Auth-Weg).
   Die Korrekturen fliessen direkt ins selbe fehler_log.json, das der Claude-Code-Hook auch
   fuellt. */
ipcMain.handle('mailassist:generate', (_e, payload) => mailassist.generate(payload || {}));

/* ── Prioritäten ──
   Liest und schreibt die Projektnotizen in Vault 2 (siehe todos.js). Der Renderer schickt
   nur Absichten: Haken setzen, Reihenfolge, Einstufung. */
ipcMain.handle('todos:load', () => {
  try {
    return todos.load();
  } catch (err) {
    return { ok: false, message: 'Prioritäten nicht lesbar: ' + err.message, items: [], types: todos.TYPES };
  }
});

ipcMain.handle('todos:toggle', (_e, id, text, done) => {
  try {
    return todos.toggle(id, String(text || ''), done === true);
  } catch (err) {
    return { ok: false, message: 'Haken nicht gespeichert: ' + err.message };
  }
});

ipcMain.handle('todos:order', (_e, order) => todos.setOrder(order));
ipcMain.handle('todos:meta', (_e, id, patch) => todos.setMeta(id, patch));

// navigator.clipboard braucht Fokus und scheitert still ohne ihn (siehe Kommentar bei
// auftrag:zeile oben) — deshalb auch hier ueber das Hauptprozess-Clipboard, nicht im Renderer.
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

/* ── Nur eine Instanz ──
   Jeder Prozess fuehrt seine eigenen Kollektoren mit eigenem Dedupe-Set. Zwei laufende
   Panels schreiben deshalb dieselbe Dateiaenderung zweimal in events.jsonl. Seit es einen
   Starter auf dem Desktop gibt, ist der zweite Doppelklick der wahrscheinlichste Fall —
   also holt er das vorhandene Fenster nach vorn statt ein neues zu oeffnen. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  watchData();
  // Kollektoren erst nach dem Fenster starten — der Teams-Kollektor braucht das
  // Electron-clipboard-Modul, und die erste Confluence-Abfrage soll das Rendern
  // des Fensters nicht verzoegern.
  stopCollectors = collectors.startAll();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (stopCollectors) stopCollectors();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

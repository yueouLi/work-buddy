const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  load: () => ipcRenderer.invoke('events:load'),
  open: (url) => ipcRenderer.invoke('open:external', url),
  openFile: (p) => ipcRenderer.invoke('open:file', p),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  // Mail in Outlook aufschlagen. Eigener Kanal, weil eine EntryID keine URL ist und der
  // URL-Kanal streng bei https/obsidian bleiben soll.
  openMail: (id) => ipcRenderer.invoke('outlook:open', id),
  onChanged: (cb) => ipcRenderer.on('events:changed', () => cb()),

  // Zuordnung von Hand (Drag&Drop auf die Projektschiene)
  assign: (evt, project, scope) => ipcRenderer.invoke('project:assign', evt, project, scope),
  unassign: (evt) => ipcRenderer.invoke('project:unassign', evt),

  // Löschkorb
  trashLoad: () => ipcRenderer.invoke('trash:load'),
  trashAdd: (items) => ipcRenderer.invoke('trash:add', items),
  trashRemove: (id) => ipcRenderer.invoke('trash:remove', id),
  trashClean: () => ipcRenderer.invoke('trash:clean'),
  trashRecycle: () => ipcRenderer.invoke('trash:recycle'),
  trashBinStat: () => ipcRenderer.invoke('trash:binstat'),
  trashEmptyBin: () => ipcRenderer.invoke('trash:emptybin'),

  // Bestand: Inventar aller fuenf Quellen plus eigene Bewertung und Notiz.
  // libSet nimmt den Sach-Schluessel, nicht den Pfad — bewertet wird auch, was keine
  // Datei auf der Platte ist (Confluence-Seite, Repo, Teams-Nachricht).
  libLoad: (force) => ipcRenderer.invoke('library:load', force),
  libSet: (key, patch) => ipcRenderer.invoke('library:set', key, patch),

  // Kontext-Mappe
  dossierLoad: (project) => ipcRenderer.invoke('dossier:load', project),
  dossierAdd: (project, items) => ipcRenderer.invoke('dossier:add', project, items),
  dossierUpdate: (project, id, patch) => ipcRenderer.invoke('dossier:update', project, id, patch),
  dossierRemove: (project, id) => ipcRenderer.invoke('dossier:remove', project, id),
  dossierExport: (project) => ipcRenderer.invoke('dossier:export', project),

  // Übergabe an Claude: schreibt data/auftrag.md und legt den Einfüge-Satz in die Ablage.
  // Das Panel führt nichts aus — es reicht den Kontext weiter (siehe auftrag.js).
  auftragZeile: (karte) => ipcRenderer.invoke('auftrag:zeile', karte),
  auftragMappe: (project) => ipcRenderer.invoke('auftrag:mappe', project),

  // Mail-Assistent: Kontext + Entwurf + Absicht rein, eine finale deutsche Version raus.
  // Die Korrekturen fliessen serverseitig ins Fehlertagebuch, der Renderer bekommt sie nur
  // zur Anzeige zurueck.
  mailassistGenerate: (payload) => ipcRenderer.invoke('mailassist:generate', payload),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  // Prioritäten: Projektnotizen aus Vault 2 (Haken wandern zurück in die Notiz),
  // Reihenfolge und Einstufung in data/prioritaeten.json.
  todosLoad: () => ipcRenderer.invoke('todos:load'),
  todosToggle: (id, text, done) => ipcRenderer.invoke('todos:toggle', id, text, done),
  todosOrder: (order) => ipcRenderer.invoke('todos:order', order),
  todosMeta: (id, patch) => ipcRenderer.invoke('todos:meta', id, patch),
  onTodosChanged: (cb) => ipcRenderer.on('todos:changed', () => cb()),

  // Seit Electron 32 gibt File.path nichts mehr her; der Pfad einer fallengelassenen
  // Datei ist nur noch ueber webUtils im Preload zu bekommen.
  pathFor: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});

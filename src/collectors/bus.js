// Winziger gemeinsamer Zustand zwischen Kollektoren. Aktuell nur fuer die Frage
// "wurde die zuletzt kopierte Teams-Nachricht irgendwo eingefuegt".
const LINK_WINDOW_MS = 3 * 60 * 1000;

let lastTeamsCopy = null; // { ts, from, snippet }

function noteTeamsCopy(info) {
  lastTeamsCopy = { ...info, ts: Date.now() };
}

// Gibt die Kopie zurueck, wenn sie zeitlich zum jetzigen Ereignis passt.
function pendingTeamsCopy() {
  if (!lastTeamsCopy) return null;
  if (Date.now() - lastTeamsCopy.ts > LINK_WINDOW_MS) return null;
  return lastTeamsCopy;
}

module.exports = { noteTeamsCopy, pendingTeamsCopy, LINK_WINDOW_MS };

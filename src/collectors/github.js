const { execFile } = require('child_process');
const { emit } = require('./emit');

const POLL_MS = 5 * 60 * 1000;
const HOST = 'github.developer.allianz.io';
const USER = 'yueou-li';

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
      env: { ...process.env, GH_HOST: HOST },
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: true, // gh liegt unter Windows als .cmd vor
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 200)));
      resolve(stdout);
    });
  });
}

function describe(type, pl) {
  if (type === 'Push') {
    const n = pl.size || 0;
    const msg = ((pl.commits || [{}]).at(-1)?.message || '').split('\n')[0];
    return `${n} Commit${n === 1 ? '' : 's'} · ${msg}`.slice(0, 90);
  }
  if (type === 'Create') return `${pl.ref_type || ''} ${pl.ref || ''}`.trim();
  if (type === 'PullRequest') return `${pl.action || ''} PR #${pl.number ?? ''}`.trim();
  return type;
}

async function poll(log) {
  // Die Events-API liefert Push, Create und PR fertig aufbereitet — kein eigenes Diffing.
  const raw = await gh(['api', 'users/' + USER + '/events?per_page=100']);
  const list = JSON.parse(raw);
  let neu = 0;
  for (const e of list) {
    const type = e.type.replace('Event', '');
    if (emit({
      ts: e.created_at,
      source: 'github',
      action: type.toLowerCase(),
      title: e.repo.name.split('/').pop(),
      detail: describe(type, e.payload || {}),
      url: 'https://' + HOST + '/' + e.repo.name,
      meta: { repo: e.repo.name, eventId: e.id },
    })) neu += 1;
  }
  log(`github: ${list.length} Events geprueft, ${neu} neu`);
}

function start(log) {
  const run = () => poll(log).catch((e) => log('github failed: ' + e.message));
  run();
  const t = setInterval(run, POLL_MS);
  return () => clearInterval(t);
}

module.exports = { start, poll, POLL_MS };

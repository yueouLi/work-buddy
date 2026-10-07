"""Einmaliger Seed-Lauf: sammelt echte Aktivitaet aus Confluence, GitHub und dem
Obsidian-Vault und schreibt sie als normalisierte Events nach data/events.jsonl."""
import json, os, ssl, subprocess, urllib.request, urllib.parse, datetime, pathlib

OUT = pathlib.Path("data/events.jsonl")
BASE = "https://cmp.allianz.net"
HOME = pathlib.Path(os.path.expanduser("~"))


def confluence_token():
    """Token aus ~/.mcp.json lesen. Es stand hier fest im Quelltext — in einem Ordner,
    der ueber OneDrive synchronisiert wird. Der Kollektor macht es genauso."""
    cfg = json.loads((HOME / ".mcp.json").read_text(encoding="utf-8"))
    for srv in cfg.get("mcpServers", {}).values():
        argv = srv.get("args") or []
        for i, a in enumerate(argv):
            if a == "--confluence-personal-token" and i + 1 < len(argv):
                return argv[i + 1]
            if a.startswith("--confluence-personal-token="):
                return a.split("=", 1)[1]
    raise RuntimeError("kein --confluence-personal-token in ~/.mcp.json")


TOK = confluence_token()
VAULT = HOME / "OneDrive - Allianz" / "Dokumente" / "Obsidian Vault"
SEP = chr(92)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
events = []


def iso(dt):
    return dt.astimezone().isoformat(timespec="seconds")


# --- Confluence ---
try:
    url = BASE + "/rest/api/content/search?" + urllib.parse.urlencode({
        "cql": "contributor = currentUser() order by lastmodified desc",
        "limit": 50,
        "expand": "version,space,history.lastUpdated",
    })
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + TOK, "Accept": "application/json"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        d = json.load(r)
    for p in d["results"]:
        when = p.get("history", {}).get("lastUpdated", {}).get("when")
        if not when:
            continue
        v = p.get("version", {}).get("number", 1)
        space = p.get("space", {}).get("key", "?")
        events.append({
            "ts": when,
            "source": "confluence",
            "action": "created" if v == 1 else "updated",
            "title": p["title"],
            "detail": "v" + str(v) + " · Space " + space,
            "url": BASE + "/pages/viewpage.action?pageId=" + p["id"],
            "meta": {"version": v, "space": space},
        })
    print("confluence:", len(d["results"]))
except Exception as ex:
    print("confluence failed:", ex)

# --- GitHub ---
try:
    env = dict(os.environ, GH_HOST="github.developer.allianz.io")
    raw = subprocess.run(["gh", "api", "users/yueou-li/events?per_page=100"],
                         capture_output=True, text=True, env=env, timeout=90).stdout
    gh = json.loads(raw)
    for e in gh:
        t = e["type"].replace("Event", "")
        pl = e.get("payload", {})
        if t == "Push":
            n = pl.get("size", 0)
            commits = pl.get("commits") or [{}]
            msg = (commits[-1].get("message") or "").split("\n")[0]
            detail = str(n) + (" Commits · " if n != 1 else " Commit · ") + msg[:70]
        elif t == "Create":
            detail = (pl.get("ref_type") or "") + " " + (pl.get("ref") or "")
        elif t == "PullRequest":
            detail = (pl.get("action") or "") + " PR #" + str(pl.get("number", ""))
        else:
            detail = t
        events.append({
            "ts": e["created_at"],
            "source": "github",
            "action": t.lower(),
            "title": e["repo"]["name"].split("/")[-1],
            "detail": detail.strip(),
            "url": "https://github.developer.allianz.io/" + e["repo"]["name"],
            "meta": {"repo": e["repo"]["name"]},
        })
    print("github:", len(gh))
except Exception as ex:
    print("github failed:", ex)

# --- Obsidian ---
try:
    cut = datetime.datetime.now() - datetime.timedelta(days=14)
    n = 0
    SKIP = {".git", ".obsidian", ".trash", "node_modules", ".smart-env", ".space"}
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [x for x in dirs if x not in SKIP]
        for f in files:
            if not f.endswith(".md"):
                continue
            fp = pathlib.Path(root) / f
            try:
                st = fp.stat()
            except OSError:
                continue
            m = datetime.datetime.fromtimestamp(st.st_mtime)
            if m < cut:
                continue
            rel = fp.relative_to(VAULT)
            created = datetime.datetime.fromtimestamp(st.st_ctime)
            folder = str(rel.parent).replace(SEP, "/")
            note = str(rel.with_suffix("")).replace(SEP, "/")
            events.append({
                "ts": iso(m),
                "source": "obsidian",
                "action": "created" if (m - created).total_seconds() < 120 else "updated",
                "title": fp.stem,
                "detail": folder,
                "url": "obsidian://open?" + urllib.parse.urlencode({"vault": VAULT.name, "file": note}),
                "meta": {"kb": round(st.st_size / 1024, 1)},
            })
            n += 1
    print("obsidian:", n)
except Exception as ex:
    print("obsidian failed:", ex)

events.sort(key=lambda e: e["ts"], reverse=True)
OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("w", encoding="utf-8") as fh:
    for e in events:
        fh.write(json.dumps(e, ensure_ascii=False) + "\n")
print("TOTAL", len(events), "->", OUT)

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Daytona } from '@daytonaio/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_KEY = process.env.DAYTONA_API_KEY || '';
const API_URL = process.env.DAYTONA_API_URL || 'https://app.daytona.io/api';
const SNAPSHOT = process.env.DAYTONA_SNAPSHOT || 'daytonaio/sandbox:0.8.0';
const TOTAL = Number(process.env.MZ_TOTAL || 1000);
const PORT = Number(process.env.PORT || 8899);

if (!API_KEY) {
  console.error('[matryoshka] DAYTONA_API_KEY missing — put it in .env');
  process.exit(1);
}

const daytona = new Daytona({ apiKey: API_KEY, apiUrl: API_URL });

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
/** @type {{id:string,total:number,startedAt:number,status:string,nodes:any[],realDepth:number,note:string}|null} */
let run = null;
let abort = false;

const clients = new Set();
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of clients) { if (ws.readyState === 1) ws.send(raw); }
}
function log(line, level = 'info') {
  console.log(`[matryoshka] ${line}`);
  broadcast({ t: 'log', line, level, ts: Date.now() });
}
function pushNode(node) {
  if (!run) return;
  run.nodes[node.i] = node;
  broadcast({ t: 'node', node });
}

// ---------------------------------------------------------------------------
// the payload every sandbox runs: "create the next sandbox, from in here"
// ---------------------------------------------------------------------------
function childScript(runId, depth) {
  return `import json, os, sys, urllib.request, urllib.error
KEY = os.environ.get("DT_KEY", "")
API = ${JSON.stringify(API_URL)} + "/sandbox"
body = {
  "snapshot": ${JSON.stringify(SNAPSHOT)},
  "env": {"DT_KEY": KEY, "MZ_DEPTH": "${depth}", "MZ_RUN": "${runId}"},
  "labels": {"app": "matryoshka", "run": "${runId}", "depth": "${depth}"},
  "autoStopInterval": 5,
  "autoDeleteInterval": 15,
}
req = urllib.request.Request(
  API, data=json.dumps(body).encode(),
  headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
  method="POST")
try:
    r = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
    print("MZ_CHILD " + json.dumps({"id": r["id"], "target": r.get("target"), "state": r.get("state")}))
except urllib.error.HTTPError as e:
    print("MZ_ERR " + str(e.code) + " " + e.read().decode()[:400])
except Exception as e:
    print("MZ_ERR 0 " + str(e)[:400])
`;
}

function spawnCommand(runId, depth) {
  const b64 = Buffer.from(childScript(runId, depth), 'utf8').toString('base64');
  return `printf '%s' '${b64}' | base64 -d > /tmp/mz.py && (python3 -u /tmp/mz.py || python -u /tmp/mz.py)`;
}

// ---------------------------------------------------------------------------
// the dive
// ---------------------------------------------------------------------------
async function dive({ realDepth, total }) {
  const runId = 'mz' + Date.now().toString(36);
  abort = false;
  run = {
    id: runId, total, realDepth, startedAt: Date.now(), status: 'diving',
    note: '', nodes: new Array(total).fill(null),
  };
  broadcast({ t: 'run', run: { id: runId, total, realDepth, status: 'diving', startedAt: run.startedAt } });
  log(`run ${runId} — target ${total} layers, ${realDepth} of them real Daytona sandboxes`);

  let parent = null;
  let reached = 0;

  try {
    for (let d = 0; d < realDepth && !abort; d++) {
      const t0 = Date.now();
      pushNode({ i: d, kind: 'real', state: 'booting', id: null, label: `layer ${d}`, ms: 0 });

      if (d === 0) {
        log('layer 0 — host creating the outermost sandbox…');
        const sb = await daytona.create({
          snapshot: SNAPSHOT,
          envVars: { DT_KEY: API_KEY, MZ_DEPTH: '0', MZ_RUN: runId },
          labels: { app: 'matryoshka', run: runId, depth: '0' },
          autoStopInterval: 5,
          autoDeleteInterval: 15,
        }, { timeout: 180 });
        parent = sb;
        reached = 1;
        pushNode({ i: 0, kind: 'real', state: 'live', id: sb.id, label: sb.id.slice(0, 8), ms: Date.now() - t0, region: sb.target || 'eu' });
        log(`layer 0 live · ${sb.id} · ${Date.now() - t0}ms`, 'ok');
        continue;
      }

      log(`layer ${d} — asking layer ${d - 1} to create a sandbox from inside itself…`);
      const res = await parent.process.executeCommand(spawnCommand(runId, d), undefined, undefined, 180);
      const out = String(res?.result ?? res?.artifacts?.stdout ?? '');

      const m = out.match(/MZ_CHILD\s+(\{.*\})/);
      if (!m) {
        const err = (out.match(/MZ_ERR[^\n]*/) || [out.slice(0, 300)])[0];
        pushNode({ i: d, kind: 'real', state: 'capped', id: null, label: 'capped', ms: Date.now() - t0, error: err });
        run.note = err.includes('402') || /quota|limit/i.test(err)
          ? 'real nesting stopped at the account quota — deeper layers are projected'
          : 'real nesting stopped — deeper layers are projected';
        log(`layer ${d} refused: ${err}`, 'warn');
        break;
      }

      const child = JSON.parse(m[1]);
      const sb = await daytona.get(child.id);
      await sb.waitUntilStarted(180).catch(() => {});
      parent = sb;
      reached = d + 1;
      pushNode({ i: d, kind: 'real', state: 'live', id: child.id, label: child.id.slice(0, 8), ms: Date.now() - t0, region: child.target || 'eu' });
      log(`layer ${d} live · ${child.id} · born inside ${d - 1} · ${Date.now() - t0}ms`, 'ok');
    }
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    log(`real nesting halted: ${msg}`, 'warn');
    run.note = 'real nesting halted — deeper layers are projected';
    pushNode({ i: reached, kind: 'real', state: 'capped', id: null, label: 'capped', ms: 0, error: msg });
  }

  if (abort) { run.status = 'aborted'; broadcast({ t: 'status', status: 'aborted' }); return; }

  log(`${reached} real nested sandboxes. Projecting layers ${reached}…${total - 1}.`);
  broadcast({ t: 'realdone', reached });

  // The remaining layers are projected: same recursion, modelled rather than billed.
  await new Promise((resolve) => {
    let i = Math.max(reached, 1);
    const timer = setInterval(() => {
      if (abort || i >= total) { clearInterval(timer); resolve(); return; }
      const batch = Math.min(24, total - i);
      for (let k = 0; k < batch; k++, i++) {
        if (run.nodes[i]) continue;   // never paper over the layer the quota refused
        pushNode({ i, kind: 'projected', state: 'live', id: `proj-${i.toString(36)}`, label: `L${i}`, ms: 0 });
      }
      broadcast({ t: 'progress', allocated: i });
    }, 40);
  });

  run.status = abort ? 'aborted' : 'done';
  broadcast({ t: 'status', status: run.status, reached, total });
  log(run.status === 'done' ? `core reached — ${total} layers deep. Pong is live.` : 'aborted', 'ok');
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor', express.static(path.join(ROOT, 'node_modules/three/build')));

app.get('/api/state', (_req, res) => {
  res.json({ run: run ? { ...run, nodes: run.nodes.filter(Boolean) } : null, total: TOTAL });
});

app.post('/api/dive', async (req, res) => {
  if (run && run.status === 'diving') return res.status(409).json({ error: 'already diving' });
  const realDepth = Math.max(1, Math.min(64, Number(req.body?.realDepth ?? process.env.MZ_REAL_DEPTH ?? 6)));
  const total = Math.max(2, Math.min(5000, Number(req.body?.total ?? TOTAL)));
  res.json({ ok: true, realDepth, total });
  dive({ realDepth, total }).catch((e) => log('dive crashed: ' + e.message, 'err'));
});

app.post('/api/abort', (_req, res) => { abort = true; res.json({ ok: true }); });

app.post('/api/cleanup', async (_req, res) => {
  let killed = 0;
  try {
    for await (const sb of daytona.list({ labels: { app: 'matryoshka' } })) {
      await daytona.delete(sb).catch(() => {});
      killed++;
    }
  } catch (e) { log('cleanup: ' + e.message, 'warn'); }
  log(`cleanup destroyed ${killed} sandbox(es)`, 'ok');
  res.json({ ok: true, killed });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({
    t: 'hello',
    total: TOTAL,
    run: run ? { id: run.id, total: run.total, realDepth: run.realDepth, status: run.status, startedAt: run.startedAt, note: run.note } : null,
    nodes: run ? run.nodes.filter(Boolean) : [],
  }));
});

server.listen(PORT, () => {
  console.log(`\n  MATRYOSHKA  →  http://localhost:${PORT}\n`);
});

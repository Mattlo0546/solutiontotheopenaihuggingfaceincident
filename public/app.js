import * as THREE from '/vendor/three.module.js';
import { step as pongStep, state as pong, snapshot as pongSnapshot, setTarget as pongSetTarget } from '/pong.js';

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------
let TOTAL = 1000;
const nodes = new Map();           // layer index -> node from the server
let allocated = 0, realCount = 0, projCount = 0, deepest = 0;
let zoom = 0, target = 0, manualUntil = 0, spin = 0;

const R = 0.87, BASE = 2.6, OFF_MIN = -5, OFF_MAX = 46, POOL = OFF_MAX - OFF_MIN + 1;
const OVER = 6;   // how far past the last layer you may fly, so Pong fills the frame
const COL = {
  ghost: 0x27455e, boot: 0xffb020, real: 0x00ffa3,
  proj: 0x6ea8ff, capped: 0xff3b6b, core: 0xffffff,
};

function colorOf(n) {
  if (!n) return COL.ghost;
  if (n.state === 'booting') return COL.boot;
  if (n.state === 'capped') return COL.capped;
  return n.kind === 'real' ? COL.real : COL.proj;
}

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04070c);
const camera = new THREE.PerspectiveCamera(62, 1, 0.0008, 4000);
camera.position.set(0, 0, 4.4);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// starfield — pure depth cue
{
  const N = 1500, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 30 + Math.random() * 90, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(p) * Math.cos(t);
    pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    pos[i * 3 + 2] = r * Math.cos(p);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x2a4a63, size: 0.22, sizeAttenuation: true, transparent: true, opacity: 0.7,
  })));
}

// the nested boxes: a recycled pool, so 1000 layers cost the same as 64
const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const slots = [];
for (let j = 0; j < POOL; j++) {
  const mat = new THREE.LineBasicMaterial({ color: COL.ghost, transparent: true, opacity: 0.5 });
  const mesh = new THREE.LineSegments(edges, mat);
  scene.add(mesh);
  slots.push({ mesh, mat, layer: -1 });
}

// labels for the layers nearest the camera
const labels = [];
for (let j = 0; j < 14; j++) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.visible = false; scene.add(spr);
  labels.push({ cv, ctx: cv.getContext('2d'), tex, spr, text: '' });
}
function paintLabel(L, text, hex) {
  if (L.text === text + hex) return;
  L.text = text + hex;
  const c = L.ctx;
  c.clearRect(0, 0, 512, 64);
  c.font = '600 34px ui-monospace,Menlo,monospace';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = '#' + hex.toString(16).padStart(6, '0');
  c.fillText(text, 256, 34);
  L.tex.needsUpdate = true;
}

// pong at the core
const pongTex = new THREE.CanvasTexture(document.getElementById('pong'));
pongTex.minFilter = THREE.LinearFilter;
const pongPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 0.625),
  new THREE.MeshBasicMaterial({ map: pongTex, transparent: true, toneMapped: false }),
);
pongPlane.visible = false;
scene.add(pongPlane);

const coreDot = new THREE.Sprite(new THREE.SpriteMaterial({
  color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false,
}));
scene.add(coreDot);

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  spin += dt * 0.09;

  if (now > manualUntil) {
    const autoTarget = allocated >= TOTAL ? TOTAL + OVER : Math.max(0, allocated - 1);
    target += (autoTarget - target) * (1 - Math.exp(-3.0 * dt));
  }
  zoom += (target - zoom) * (1 - Math.exp(-2.6 * dt));
  if (Math.abs(target - zoom) > 0.5) zoom += Math.sign(target - zoom) * Math.min(28 * dt, Math.abs(target - zoom));
  zoom = Math.max(0, Math.min(TOTAL + OVER, zoom));

  const zi = Math.floor(zoom);
  let lbl = 0;

  for (let j = 0; j < POOL; j++) {
    const s = slots[j];
    const layer = zi + OFF_MIN + j;
    const off = layer - zoom;
    if (layer < 0 || layer >= TOTAL || off > OFF_MAX) { s.mesh.visible = false; continue; }

    const sc = BASE * Math.pow(R, off);
    const n = nodes.get(layer);
    const col = colorOf(n);

    let op = 0.62;
    if (off < OFF_MIN + 2.5) op *= Math.max(0, (off - OFF_MIN + 1) / 3.5);
    if (off > OFF_MAX - 10) op *= Math.max(0, (OFF_MAX - off) / 10);
    if (n && n.state === 'booting') op *= 0.55 + 0.45 * Math.sin(now / 110);
    if (n && n.kind === 'real') op = Math.min(1, op * 1.9);

    s.mesh.visible = op > 0.008;
    s.mesh.scale.setScalar(sc);
    s.mesh.rotation.set(layer * 0.087 + spin * 0.3, layer * 0.131 + spin, layer * 0.041);
    s.mat.color.setHex(col);
    s.mat.opacity = op;

    // label the handful of layers right in front of the camera
    if (n && off > 0.4 && off < 13 && lbl < labels.length) {
      const L = labels[lbl++];
      paintLabel(L, `${layer.toString().padStart(3, '0')} · ${n.label ?? ''}`.toUpperCase(), col);
      L.spr.visible = op > 0.05;
      L.spr.position.set(0, sc * 0.575, 0);
      L.spr.scale.set(sc * 0.95, sc * 0.119, 1);
      L.spr.material.opacity = Math.min(1, op * 1.6);
    }
  }
  for (let k = lbl; k < labels.length; k++) labels[k].spr.visible = false;

  // the core
  const coreOff = TOTAL - zoom;
  const coreScale = BASE * Math.pow(R, coreOff);
  if (coreOff <= OFF_MAX && coreOff > -OVER - 3) {
    pongPlane.visible = true;
    pongPlane.scale.setScalar(Math.max(coreScale * 0.72, 0.0001));
    pongPlane.material.opacity = Math.min(1, Math.max(0, (OFF_MAX - coreOff) / 14));
    coreDot.visible = coreOff > 22;
  } else {
    pongPlane.visible = false;
    coreDot.visible = coreOff > 0;
  }
  const dotS = Math.max(0.012, Math.min(0.09, BASE * Math.pow(R, Math.max(coreOff, 26)) * 6));
  coreDot.scale.set(dotS, dotS, 1);
  coreDot.material.opacity = 0.35 + 0.35 * Math.sin(now / 300);

  pongStep(dt);
  pongTex.needsUpdate = true;

  camera.rotation.z = Math.sin(now / 5200) * 0.05;
  renderer.render(scene, camera);

  dnum.textContent = Math.min(TOTAL, Math.round(zoom));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// hud
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dnum = $('dnum'), rz = $('r-zoom'), logl = $('logl');

function setManual(v) {
  target = Math.max(0, Math.min(TOTAL + OVER, v));
  manualUntil = performance.now() + 6000;
  rz.value = String(Math.round(target));
}
addEventListener('wheel', (e) => {
  const near = Math.max(1, Math.round(Math.abs(e.deltaY) * 0.09));
  setManual(target + Math.sign(e.deltaY) * near * (e.shiftKey ? 8 : 1));
}, { passive: true });
rz.addEventListener('input', () => setManual(Number(rz.value)));

function stats() {
  $('s-real').textContent = realCount;
  $('s-proj').textContent = projCount;
  $('s-deep').textContent = deepest;
  $('s-alloc').textContent = `${allocated} / ${TOTAL}`;
  $('s-bar').style.width = (100 * allocated / TOTAL).toFixed(1) + '%';
}
function recount() {
  realCount = 0; projCount = 0; deepest = 0; allocated = 0;
  for (const [i, n] of nodes) {
    allocated = Math.max(allocated, i + 1);
    if (n.state === 'capped') continue;
    deepest = Math.max(deepest, i);
    if (n.kind === 'real') realCount++; else projCount++;
  }
  stats();
}
function addLog(line, level) {
  const li = document.createElement('li');
  li.className = level || 'info'; li.textContent = line;
  logl.prepend(li);
  while (logl.children.length > 60) logl.lastChild.remove();
}

let ws;
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello') {
      TOTAL = m.total || 1000; rz.max = String(TOTAL);
      nodes.clear();
      for (const n of m.nodes || []) nodes.set(n.i, n);
      if (m.run) {
        $('s-st').textContent = m.run.status;
        if (m.run.note) { const el = $('s-note'); el.textContent = m.run.note; el.style.display = 'block'; }
      }
      recount();
    } else if (m.t === 'run') {
      TOTAL = m.run.total; rz.max = String(TOTAL);
      nodes.clear(); recount(); logl.innerHTML = '';
      zoom = 0; target = 0; manualUntil = 0;
      $('s-st').textContent = 'diving'; $('s-note').style.display = 'none';
      $('b-dive').disabled = true;
    } else if (m.t === 'node') {
      nodes.set(m.node.i, m.node); recount();
    } else if (m.t === 'progress') {
      allocated = m.allocated; stats();
    } else if (m.t === 'realdone') {
      addLog(`${m.reached} real nested sandboxes — projecting the rest`, 'ok');
    } else if (m.t === 'status') {
      $('s-st').textContent = m.status;
      $('b-dive').disabled = false;
      if (m.status === 'done') addLog('CORE REACHED — PONG IS LIVE', 'ok');
    } else if (m.t === 'log') {
      addLog(m.line, m.level);
      if (/quota|capped|halted|refused/i.test(m.line)) {
        const el = $('s-note'); el.textContent = m.line; el.style.display = 'block';
      }
    }
  };
  ws.onclose = () => setTimeout(connect, 1200);
}
connect();

const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
$('b-dive').onclick = () => post('/api/dive', {
  realDepth: Number($('i-real').value), total: Number($('i-total').value),
});
$('b-warp').onclick = () => setManual(TOTAL + OVER);
$('b-top').onclick = () => setManual(0);
$('b-abort').onclick = () => post('/api/abort');
$('b-clean').onclick = () => post('/api/cleanup');

setInterval(() => { $('pmeta').textContent = `YOU ${pong.you} — ${pong.cpu} CPU`; }, 250);

// --- the opponent lives on an NVIDIA H100 on the Nosana network ---------------
let nosanaBusy = false;
async function askOpponent() {
  if (nosanaBusy) return;
  nosanaBusy = true;
  try {
    const r = await fetch('/api/opponent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pongSnapshot()),
    });
    const j = await r.json();
    if (j.y != null) {
      pongSetTarget(j.y, 'nosana');
      $('nos').textContent = `NOSANA H100 · ${(j.model || 'model').split('/').pop()} · ${j.latencyMs}ms`;
      $('nos').className = 'on';
    } else {
      pongSetTarget(null, 'heuristic');
      $('nos').textContent = `H100 ${j.note || 'offline'} · heuristic opponent`;
      $('nos').className = '';
    }
  } catch {
    pongSetTarget(null, 'heuristic');
  } finally { nosanaBusy = false; }
}
askOpponent();
setInterval(askOpponent, 500);

// debug / stage hook: __mz.jump(950) drops you straight to a depth
window.__mz = {
  jump(v) { zoom = target = Math.max(0, Math.min(TOTAL + OVER, v)); manualUntil = performance.now() + 8000; },
  get zoom() { return zoom; },
};

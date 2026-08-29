// Pong, rendered to one canvas that is BOTH the HUD widget and the texture on
// the plane sitting at the centre of 1000 nested sandboxes.
const cv = document.getElementById('pong');
const ctx = cv.getContext('2d');
const W = cv.width, H = cv.height;

const PW = 7, PH = 54, SPD = 340;
export const state = {
  py: H / 2 - PH / 2, ay: H / 2 - PH / 2,
  bx: W / 2, by: H / 2, vx: 250, vy: 140,
  you: 0, cpu: 0, up: false, down: false, rally: 0, flash: 0,
};

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') { state.up = true; e.preventDefault(); }
  if (k === 's' || k === 'arrowdown') { state.down = true; e.preventDefault(); }
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') state.up = false;
  if (k === 's' || k === 'arrowdown') state.down = false;
});

function serve(dir) {
  state.bx = W / 2; state.by = H / 2;
  state.vx = 250 * dir; state.vy = (Math.random() * 220 - 110);
  state.rally = 0;
}

export function step(dt) {
  const s = state;
  if (s.up) s.py -= SPD * dt;
  if (s.down) s.py += SPD * dt;
  s.py = Math.max(0, Math.min(H - PH, s.py));

  // CPU: tracks the ball, but deliberately imperfect so rallies happen.
  const want = s.by - PH / 2 + Math.sin(performance.now() / 420) * 16;
  s.ay += Math.max(-250 * dt, Math.min(250 * dt, (want - s.ay) * 0.14));
  s.ay = Math.max(0, Math.min(H - PH, s.ay));

  s.bx += s.vx * dt; s.by += s.vy * dt;
  if (s.by < 4) { s.by = 4; s.vy = Math.abs(s.vy); }
  if (s.by > H - 4) { s.by = H - 4; s.vy = -Math.abs(s.vy); }

  if (s.bx < 20 + PW && s.bx > 16 && s.vx < 0 && s.by > s.py - 4 && s.by < s.py + PH + 4) {
    s.vx = Math.abs(s.vx) * 1.045; s.vy += ((s.by - (s.py + PH / 2)) / PH) * 260;
    s.rally++; s.flash = 1;
  }
  if (s.bx > W - 20 - PW && s.bx < W - 16 && s.vx > 0 && s.by > s.ay - 4 && s.by < s.ay + PH + 4) {
    s.vx = -Math.abs(s.vx) * 1.045; s.vy += ((s.by - (s.ay + PH / 2)) / PH) * 260;
    s.rally++; s.flash = 1;
  }
  if (s.bx < -8) { s.cpu++; serve(1); }
  if (s.bx > W + 8) { s.you++; serve(-1); }
  s.vy = Math.max(-380, Math.min(380, s.vy));
  s.flash *= 0.9;
  draw();
}

function draw() {
  const s = state;
  ctx.fillStyle = '#04070c'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,255,163,.18)'; ctx.lineWidth = 2;
  ctx.setLineDash([7, 11]); ctx.beginPath();
  ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeRect(1, 1, W - 2, H - 2);

  ctx.fillStyle = '#0d1a25';
  ctx.font = '700 62px ui-monospace,monospace'; ctx.textAlign = 'center';
  ctx.fillText(s.you, W / 2 - 60, 66); ctx.fillText(s.cpu, W / 2 + 60, 66);

  ctx.shadowBlur = 16; ctx.shadowColor = '#00ffa3'; ctx.fillStyle = '#00ffa3';
  ctx.fillRect(16, s.py, PW, PH);
  ctx.shadowColor = '#6ea8ff'; ctx.fillStyle = '#6ea8ff';
  ctx.fillRect(W - 16 - PW, s.ay, PW, PH);
  ctx.shadowColor = '#ffffff'; ctx.fillStyle = '#fff';
  ctx.fillRect(s.bx - 4, s.by - 4, 8, 8);
  ctx.shadowBlur = 0;

  ctx.fillStyle = 'rgba(93,117,144,.75)';
  ctx.font = '600 11px ui-monospace,monospace';
  ctx.fillText('RALLY ' + s.rally + '  ·  DEPTH 1000  ·  W/S', W / 2, H - 10);
}
draw();

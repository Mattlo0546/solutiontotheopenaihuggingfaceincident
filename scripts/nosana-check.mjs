#!/usr/bin/env node
// End-to-end check of the Nosana H100 adversary: is the tunnel routing, is a model
// served, and can it actually answer a Pong position? Prints exactly what it sees.
import 'dotenv/config';

const URL_ = (process.env.NOSANA_BASE_URL || process.argv[2] || '').replace(/\/+$/, '');
if (!URL_) { console.error('usage: node scripts/nosana-check.mjs <base-url>   (or set NOSANA_BASE_URL)'); process.exit(2); }

const t = (ms) => AbortSignal.timeout(ms);
console.log(`\n  node: ${URL_}\n`);

let r;
try { r = await fetch(URL_ + '/v1/models', { signal: t(15000) }); }
catch (e) { console.error(`  x unreachable: ${e.message}\n`); process.exit(1); }

const frp = r.headers.get('x-frp-service-state');
console.log(`  GET /v1/models  ->  HTTP ${r.status}${frp ? `  x-frp-service-state: ${frp}` : ''}`);

if (r.status === 503 || frp) {
  console.error(`\n  x The Nosana tunnel is up but no service is bound behind it.`);
  console.error(`    Either the container is still pulling, or the port your server`);
  console.error(`    listens on does not match the port the Nosana job exposes.\n`);
  process.exit(1);
}

const body = await r.text();
let models;
try { models = JSON.parse(body); }
catch { console.error(`\n  x /v1/models did not return JSON:\n${body.slice(0, 300)}\n`); process.exit(1); }

const model = models?.data?.[0]?.id;
console.log(`  models served   ->  ${models?.data?.map((m) => m.id).join(', ') || '(none)'}`);
if (!model) { console.error('\n  x no model served\n'); process.exit(1); }

const t0 = Date.now();
const c = await fetch(URL_ + '/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: t(30000),
  body: JSON.stringify({
    model, temperature: 0, max_tokens: 6,
    messages: [
      { role: 'system', content: 'You are the opponent paddle in a game of Pong. Reply with ONE integer from 0 to 100: the height, as a percentage of court height, where your paddle should be. 0 is the top. Intercept the ball. Reply with the number and nothing else.' },
      { role: 'user', content: 'court 100x100. ball at x=50 y=30 moving dx=25 dy=14. you are the paddle at x=100. your centre is at y=50. where should you be?' },
    ],
  }),
});
const j = await c.json();
const raw = j?.choices?.[0]?.message?.content;
const n = String(raw ?? '').match(/-?\d+(\.\d+)?/);

console.log(`  chat completion ->  HTTP ${c.status}  ${Date.now() - t0}ms`);
console.log(`  model replied   ->  ${JSON.stringify(raw)}`);
if (!n) { console.error(`\n  x unparseable paddle position\n`); process.exit(1); }
console.log(`  paddle target   ->  ${Math.max(0, Math.min(100, Number(n[0])))}% down the court\n`);
console.log(`  = adversary is live on ${model}\n`);

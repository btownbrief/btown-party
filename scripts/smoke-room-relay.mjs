// ROOM RELAY — Playwright multi-phone smoke, in the style of
// scripts/smoke-party.mjs: a real browser night against the local shim
// (scripts/party-shim.mjs), no Supabase needed.
//
//   node scripts/smoke-room-relay.mjs
//
// The full porous loop: a host event, three phones join and check in, a
// phrase→doodle relay runs its start round (GATE 1: the host approves
// every fragment before it travels), the routing plan hands each phrase
// to a DIFFERENT phone (never its author), phones draw on the thumb
// canvas, the host approves the assembled chains (GATE 2) and paces the
// reveal beat by beat on the big screen, names riding with the work. A
// fourth phone joins mid-continue-round and gets a fragment immediately.
//
// The host console's round-setup card still only offers the first mode in
// the manifest (the shell grows a mode picker when a sibling lands), so
// this smoke opens the relay rounds through the same RPCs the console
// calls — everything else (moderation, close, reveal pacing) is driven
// through the real host UI.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShim } from './party-shim.mjs';
import { buildStartConfig, buildContinuePlan } from '../modes/room-relay/logic.js';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('smoke: playwright not found. npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function startStatic() {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = join(ROOT, path === '' ? 'index.html' : path);
      if (!file.startsWith(ROOT)) throw new Error('nope');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

let failures = 0;
const ok = (label) => console.log(`✓ ${label}`);
const fail = (label, extra) => {
  failures += 1;
  console.error(`✗ ${label}${extra ? ` — ${extra}` : ''}`);
};
async function must(promise, label) {
  try {
    await promise;
    ok(label);
  } catch (e) {
    fail(label, String(e).split('\n')[0]);
  }
}

const { server: shimServer, url: shimUrl } = await startShim();
const { server: staticServer, url: baseUrl } = await startStatic();
const api = `?api=${encodeURIComponent(shimUrl)}`;

async function rpc(fn, args) {
  const res = await fetch(`${shimUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${fn}: ${body.message}`);
  return body;
}

const HK = 'smoke-host-key-0001';
const Q = [{ id: 'rk-001', text: 'Your creemee order:', options: ['Maple', 'Twist'] }];
const deck = JSON.parse(readFileSync(new URL('../content/room-relay-prompts.json', import.meta.url)));

const browser = await chromium.launch();
const pageErrors = [];
async function newFace(path, { width, height }, initLocalStorage) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  if (initLocalStorage) {
    await ctx.addInitScript((kv) => {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    }, initLocalStorage);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message}`));
  await page.goto(`${baseUrl}/${path}`);
  return page;
}
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1440, height: 900 };
const T = { timeout: 20000 };

// RELAY_SHOTS=/some/dir saves labeled screenshots at the key moments —
// handy for PR evidence; off by default so CI stays byte-identical.
const SHOTS = process.env.RELAY_SHOTS;
const shot = async (page, name) => {
  if (!SHOTS) return;
  try { await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } catch { /* evidence only */ }
};

try {
  /* ---- event via RPC, host console attaches to it -------------------- */
  const made = await rpc('party_create_event', { p_host_key: HK, p_questions: Q, p_title: 'Relay Smoke' });
  const code = made.code;
  ok(`event ${code} created`);
  const host = await newFace(`host.html${api}`, PHONE, {
    'btown-party-host-key': HK,
    'btown-party-host-event': JSON.stringify({ eventId: made.eventId, code }),
  });
  await host.waitForSelector('#runPanel:not(.hidden)', T);
  ok('host console attached to the event');

  /* ---- three phones join + check in ---------------------------------- */
  const names = ['Ada', 'Ben', 'Cleo'];
  const phones = [];
  for (const name of names) {
    const p = await newFace(`index.html${api}&join=${code}`, PHONE);
    await p.fill('#joinName', name);
    await p.click('#joinGo');
    await p.waitForSelector('#checkinPanel:not(.hidden)', T);
    await p.waitForSelector('#checkinOpt0', T);
    await p.click(`#checkinOpt${names.indexOf(name) % 2}`);
    await p.waitForSelector('#idlePanel:not(.hidden)', T);
    phones.push(p);
  }
  ok('three phones joined and checked in');

  const screen = await newFace(`screen.html${api}&code=${code}`, LAPTOP);
  await screen.waitForSelector('#stage:not(.hidden)', T);

  /* ---- START ROUND: phrases in --------------------------------------- */
  const startCfg = buildStartConfig({
    chainType: 'phrase-then-doodle', totalSteps: 2, deck, checkinQs: Q, seed: 42,
  });
  await rpc('party_open_round', { p_event: made.eventId, p_host_key: HK, p_mode: 'room-relay', p_config: startCfg });
  ok('relay start round opened (phrase → doodle)');

  await must(screen.waitForFunction(
    () => document.getElementById('stageInner').textContent.includes('Room Relay'), null, T),
  'screen: relay marquee is up while fragments collect');

  const phrases = ['smoke-phrase-ada', 'smoke-phrase-ben', 'smoke-phrase-cleo'];
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    await p.waitForSelector('#collectPanel:not(.hidden)', T);
    await p.waitForSelector('#mode-room-relay-text', T);
    const promptShown = await p.textContent('.collect-question');
    if (!promptShown?.trim()) fail(`${names[i]}: prompt shown on the phone`);
    if (i === 0) await shot(p, '1-phone-writes-fragment');
    await p.fill('#mode-room-relay-text', phrases[i]);
    await p.click('#mode-room-relay-send');
    await p.waitForSelector('#lockedPanel:not(.hidden)', T);
  }
  ok('three phones wrote phrases and locked in');

  /* ---- GATE 1 -------------------------------------------------------- */
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row').length >= 3, null, T);
  const queueText = await host.textContent('#modQueue');
  await shot(host, '2-host-gate1-moderation');
  if (queueText.includes('smoke-phrase-ada')) ok('host moderation queue shows each fragment for review');
  else fail('host moderation queue shows each fragment for review', queueText.slice(0, 80));
  const preLeak = await screen.evaluate(() => document.body.textContent.includes('smoke-phrase'));
  if (preLeak) fail('GATE 1: screen never shows a fragment before approval');
  else ok('GATE 1: screen never shows a fragment before approval');

  await host.click('#closeRoundBtn');
  await host.waitForSelector('#revealBtn:not(.hidden)', T);
  await host.click('#approveAllBtn');
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.approved').length >= 3, null, T);
  ok('host approved the fragments (gate 1)');
  await host.click('#revealBtn');
  await host.waitForSelector('#narrated:not(.hidden)', T);
  await must(screen.waitForFunction(
    () => document.getElementById('stageInner').textContent.includes('shuffled to new hands'), null, T),
  'screen: teaser beat — fragments are in, no content shown');
  await host.click('#narratedNext'); // teaser is one beat → Wrap the round
  await must(screen.waitForFunction(
    () => document.getElementById('stageInner').textContent.includes('Scan in'), null, T),
  'screen: back to the lobby between legs');

  /* ---- CONTINUE ROUND: routed to other hands -------------------------- */
  const snap = await rpc('party_host_get', { p_event: made.eventId, p_host_key: HK });
  const prior = snap.doneResults.filter((d) => d.results?.rr).pop()?.results;
  if (!prior || prior.chains.length !== 3) fail('teaser stored 3 approved chains', JSON.stringify(prior?.chains?.length));
  else ok('teaser stored 3 approved chains for routing');
  const plan = buildContinuePlan({ prior, players: snap.players, seed: 43 });
  plan.openedAtS = Math.floor(Date.now() / 1000);
  await rpc('party_open_round', { p_event: made.eventId, p_host_key: HK, p_mode: 'room-relay', p_config: plan });
  ok('continue round opened with the routing plan');

  // Who wrote what, by playerId — to prove nobody gets their own back.
  const wrote = {};
  prior.chains.forEach((c) => { wrote[c.steps[0].authorId] = c.steps[0].frag.s; });

  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    await p.waitForSelector('#collectPanel:not(.hidden)', T);
    await p.waitForSelector(`#mode-room-relay-canvas`, T);
    const bodyText = await p.evaluate(() => document.getElementById('collectPanel').textContent);
    const pid = snap.players.find((x) => x.name === names[i]).id;
    if (bodyText.includes(wrote[pid])) fail(`${names[i]} was routed their OWN phrase`);
    const gotSomeone = phrases.some((ph) => ph !== wrote[pid] && bodyText.includes(ph));
    if (gotSomeone) ok(`${names[i]} was routed somebody else's phrase, fragment only`);
    else fail(`${names[i]} was routed somebody else's phrase`, bodyText.slice(0, 120));
    // draw a proud little zigzag on the thumb canvas
    const box = await p.locator('#mode-room-relay-canvas').boundingBox();
    await p.mouse.move(box.x + 40, box.y + 60);
    await p.mouse.down();
    for (let s = 1; s <= 6; s++) await p.mouse.move(box.x + 40 + s * 35, box.y + 60 + (s % 2) * 90, { steps: 4 });
    await p.mouse.up();
    await p.click('#mode-room-relay-undo'); // exercise undo…
    await p.mouse.move(box.x + 30, box.y + 200);
    await p.mouse.down();
    for (let s = 1; s <= 6; s++) await p.mouse.move(box.x + 30 + s * 40, box.y + 200 - (s % 3) * 50, { steps: 4 });
    await p.mouse.up();
    if (i === 0) await shot(p, '3-phone-draws-routed-phrase');
    await p.click('#mode-room-relay-send');
    await p.waitForSelector('#lockedPanel:not(.hidden)', T);
  }
  ok('three phones drew on the canvas (with an undo) and locked in');

  /* ---- late joiner mid-round gets a fragment immediately -------------- */
  const late = await newFace(`index.html${api}&join=${code}`, PHONE);
  await late.fill('#joinName', 'Dot');
  await late.click('#joinGo');
  await late.waitForSelector('#checkinPanel:not(.hidden)', T);
  await late.click('#checkinSkip');
  await late.waitForSelector('#collectPanel:not(.hidden)', T);
  await must(late.waitForSelector('#mode-room-relay-canvas', T),
    'late joiner: got a fragment and a canvas immediately, mid-round');

  /* ---- GATE 2 + the real reveal --------------------------------------- */
  const midLeak = await screen.evaluate(() => document.body.textContent.includes('smoke-phrase'));
  if (midLeak) fail('GATE 2: screen shows nothing while chains collect');
  else ok('GATE 2: screen shows nothing while chains collect');

  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row').length >= 3, null, T);
  const q2 = await host.textContent('#modQueue');
  if (q2.includes('→') && q2.includes('doodle')) ok('gate 2 queue shows fragment → answer pairs');
  else fail('gate 2 queue shows fragment → answer pairs', q2.slice(0, 100));
  await host.click('#closeRoundBtn');
  await host.waitForSelector('#revealBtn:not(.hidden)', T);
  await host.click('#approveAllBtn');
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.approved').length >= 3, null, T);
  await host.click('#revealBtn');
  await host.waitForSelector('#narrated:not(.hidden)', T);
  ok('host approved the assembled chains (gate 2) and fired the reveal');

  await must(screen.waitForFunction(() => {
    const el = document.getElementById('mode-room-relay-beat');
    return el && el.dataset.step === '0' && el.textContent.includes('made');
  }, null, T), 'screen: reveal opens on the relay title card');

  let sawSvg = false;
  let sawName = false;
  let sawPhrase = false;
  for (let step = 1; step <= 60; step++) {
    const label = await host.textContent('#narratedNext');
    if (label.includes('Wrap')) break;
    await host.click('#narratedNext');
    await screen.waitForFunction((s) => {
      const el = document.getElementById('mode-room-relay-beat');
      return el && el.dataset.step === String(s);
    }, step, T);
    const state = await screen.evaluate(() => ({
      svg: !!document.querySelector('#mode-room-relay-beat svg'),
      text: document.getElementById('stageInner').textContent,
    }));
    if (!sawSvg && state.svg) await shot(screen, '4-screen-reveal-doodle-beat');
    sawSvg = sawSvg || state.svg;
    sawName = sawName || names.some((n) => state.text.includes(`— ${n}`));
    sawPhrase = sawPhrase || phrases.some((ph) => state.text.includes(ph));
  }
  if (sawPhrase) ok('reveal: approved phrases land on the big screen');
  else fail('reveal: approved phrases land on the big screen');
  if (sawSvg) ok('reveal: doodles render as vector art on the big screen');
  else fail('reveal: doodles render as vector art on the big screen');
  if (sawName) ok('reveal: contributor first names ride with the work');
  else fail('reveal: contributor first names ride with the work');

  const narratedText = await host.textContent('#narratedLines');
  if (narratedText.trim().length > 0) ok('host: narrated lines are readable aloud');
  else fail('host: narrated lines are readable aloud');

  await host.click('#narratedNext'); // Wrap the round
  await must(screen.waitForFunction(
    () => document.getElementById('stageInner').textContent.includes('Scan in'), null, T),
  'screen: back to the lobby after the relay');
  await must(phones[0].waitForSelector('#idlePanel:not(.hidden)', T),
    'phones: pocketed again after the relay');
} catch (e) {
  fail('smoke run', String(e).split('\n')[0]);
}

for (const e of pageErrors) fail('zero page errors', e);
if (!pageErrors.length) ok('zero page errors across every face');

await browser.close();
shimServer.close();
staticServer.close();

if (failures > 0) {
  console.error(`\n${failures} relay smoke check(s) FAILED`);
  process.exit(1);
}
console.log('\nRelay smoke: a full two-step chain played clean through both gates.');

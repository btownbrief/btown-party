// FLATLANDER — Playwright multi-phone smoke, in the style of
// scripts/smoke-party.mjs: four real phone contexts join tonight's event,
// self-assemble a pod at the table (one table phone + three joiners), and
// play two full rounds — one where the Flatlander is caught, one where they
// slip away — then the table phone submits the pod scoreboard and the
// screen face lands every reveal beat.
//
// The host side is SCRIPTED via direct RPCs against scripts/party-shim.mjs
// (the local HTTP stand-in for the SQL backend): the shell's host console
// currently hard-picks Object.values(MODES)[0] ("only one mode tonight" —
// its mode picker is a shell follow-up), so this smoke opens the Flatlander
// round the way the SQL would, not through host.html.
//
//   node scripts/smoke-flatlander.mjs
//
// Playwright is DEV-ONLY. If the import fails: `npm install --no-save
// playwright && npx playwright install chromium` in the repo root.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShim } from './party-shim.mjs';
import * as flatlander from '../modes/flatlander/mode.js';

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

const { server: shimServer, url: shimUrl } = await startShim();
const { server: staticServer, url: baseUrl } = await startStatic();
const api = `?api=${encodeURIComponent(shimUrl)}`;

async function rpc(fn, args) {
  const res = await fetch(`${shimUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${fn}: ${body.message}`);
  return body;
}

const browser = await chromium.launch();
const pageErrors = [];
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1440, height: 900 };
const T = { timeout: 15000 };

async function newFace(path) {
  const ctx = await browser.newContext({ viewport: PHONE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message}`));
  await page.goto(`${baseUrl}/${path}`);
  return page;
}

const HOST_KEY = 'smoke-host-key-000001';
const NAMES = ['Ada', 'Ben', 'Cleo', 'Dot']; // seat order: Ada runs the table

try {
  /* ---- scripted host: create the event, open a 2-round Flatlander round -- */
  const ev = await rpc('party_create_event', {
    p_host_key: HOST_KEY, p_title: 'Pod Smoke Night',
    p_questions: [{ id: 'q-1', text: 'Warm-up', options: ['A', 'B'] }],
  });
  ok(`scripted host created event ${ev.code}`);

  /* ---- four phones join ------------------------------------------------- */
  const phones = [];
  for (const name of NAMES) {
    const p = await newFace(`index.html${api}&join=${ev.code}`);
    await p.waitForSelector('#joinPanel:not(.hidden)', T);
    await p.fill('#joinName', name);
    await p.click('#joinGo');
    await p.waitForSelector('#checkinPanel:not(.hidden)', T);
    await p.click('#checkinSkip');
    await p.waitForSelector('#idlePanel:not(.hidden)', T);
    phones.push(p);
  }
  ok('four phones joined the event');

  await rpc('party_open_round', {
    p_event: ev.eventId, p_host_key: HOST_KEY,
    p_mode: 'flatlander', p_config: { salt: 'smoke-night', rounds: 2 },
  });
  ok('scripted host opened a 2-round Flatlander round');

  /* ---- the pod assembles at the table ----------------------------------- */
  const [ada, ...joiners] = phones;
  await ada.waitForSelector('#collectPanel:not(.hidden)', T);
  await ada.click('#mode-flatlander-create');
  await ada.click('#mode-flatlander-size-4');
  await ada.waitForSelector('#mode-flatlander-code', T);
  const podCode = (await ada.textContent('#mode-flatlander-code')).trim();
  if (!/^[A-HJKMNP-Z2-9]{4}4$/.test(podCode)) fail('pod code is 4 safe chars + the size', podCode);
  else ok(`table phone minted pod ${podCode}`);
  for (let i = 0; i < 4; i++) await ada.fill(`#mode-flatlander-name-${i + 1}`, NAMES[i]);
  await ada.click('#mode-flatlander-start');
  await ada.waitForSelector('#mode-flatlander-go', T);

  for (let j = 0; j < joiners.length; j++) {
    const p = joiners[j];
    await p.waitForSelector('#collectPanel:not(.hidden)', T);
    await p.click('#mode-flatlander-join');
    await p.fill('#mode-flatlander-join-code', podCode);
    await p.click('#mode-flatlander-join-go');
    await p.click(`#mode-flatlander-seat-${j + 1}`); // Ben seat 2, Cleo 3, Dot 4
    await p.waitForSelector('#mode-flatlander-peek', T);
  }
  ok('three joiners typed the code and took seats 2–4');

  /* ---- the deal must never cross the wire ------------------------------- */
  const playerGet = await ada.evaluate(async ([apiUrl, eventId]) => {
    const token = localStorage.getItem('btown-party-token');
    const res = await fetch(`${apiUrl}/rest/v1/rpc/party_player_get`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_event: eventId, p_token: token }),
    });
    return res.text();
  }, [shimUrl, ev.eventId]);
  if (/flatlander|flseq|task|seat/i.test(playerGet.replace(/"mode":"flatlander"/, ''))) {
    fail('the attendee poll carries no role, seat, or task data', playerGet.slice(0, 120));
  } else ok('the attendee poll carries no role, seat, or task data (roles derive locally)');

  /* ---- helper: peek every phone, find the Flatlander -------------------- */
  async function dealAndPeek(roundLabel) {
    const secrets = [];
    for (const p of phones) {
      await p.waitForSelector('#mode-flatlander-peek', T);
      await p.click('#mode-flatlander-peek');
      await p.waitForSelector('#mode-flatlander-peek-body:not(.hidden)', T);
      secrets.push(await p.textContent('#mode-flatlander-peek-body'));
      await p.click('#mode-flatlander-peek'); // hide it again
    }
    const flSeats = secrets.flatMap((s, i) => (s.includes('the Flatlander') ? [i] : []));
    if (flSeats.length !== 1) {
      fail(`${roundLabel}: exactly one Flatlander`, `got seats [${flSeats}]`);
      throw new Error('deal broken');
    }
    const fl = flSeats[0];
    const tasks = secrets.filter((_, i) => i !== fl);
    const sameTask = tasks.every((t) => t === tasks[0]);
    if (!sameTask) fail(`${roundLabel}: everyone else sees the same task`);
    else ok(`${roundLabel}: exactly one Flatlander (seat ${fl + 1}); the rest share one task`);
    const taskLine = (await phones[(fl + 1) % 4].evaluate(() =>
      document.querySelector('#mode-flatlander-peek-body h2')?.textContent)) ?? '';
    if (taskLine && secrets[fl].includes(taskLine)) {
      fail(`${roundLabel}: the Flatlander's phone must not hold the task text`);
    } else ok(`${roundLabel}: the Flatlander's phone shows no task — only "blend in"`);
    return fl;
  }

  /** Drive one full round. votePlan maps seat → target seat. */
  async function playRound({ label, fl, votePlan, expectCaught }) {
    // The table counts down, then sends everyone to vote.
    await ada.click('#mode-flatlander-go');
    await ada.waitForSelector('#mode-flatlander-to-vote', { timeout: 20000 });
    await ada.click('#mode-flatlander-to-vote');
    for (const p of joiners) await p.click('#mode-flatlander-to-vote');
    // Everyone votes on their own phone, then flips.
    for (let seat = 0; seat < 4; seat++) {
      const p = phones[seat];
      await p.click(`#mode-flatlander-vote-${votePlan[seat]}`);
      await p.click('#mode-flatlander-flip');
    }
    ok(`${label}: all four voted on their own phones and flipped together`);
    // Joiners check their fate; the table phone transcribes the flipped votes.
    await ada.click('#mode-flatlander-enter-votes');
    for (let voter = 1; voter < 4; voter++) {
      await ada.click(`#mode-flatlander-tr-${voter}-${votePlan[voter]}`);
    }
    await ada.click('#mode-flatlander-tr-done');
    await ada.click('#mode-flatlander-reveal-next'); // tally → the name
    const verdict = await ada.textContent('[data-mode="flatlander"]');
    const caught = verdict.includes('CAUGHT');
    if (caught === expectCaught) ok(`${label}: table phone verdict says ${expectCaught ? 'CAUGHT' : 'SLIPPED AWAY'}`);
    else fail(`${label}: expected ${expectCaught ? 'CAUGHT' : 'SLIPPED AWAY'}`, verdict.slice(0, 120));
    if (!verdict.includes(NAMES[fl])) fail(`${label}: the verdict names the Flatlander`);
    await ada.click('#mode-flatlander-reveal-next'); // → scores
    await ada.waitForSelector('#mode-flatlander-board', T);
    for (const p of joiners) {
      await p.click('#mode-flatlander-truth');
      await p.click('#mode-flatlander-next');
    }
    await ada.click('#mode-flatlander-reveal-next'); // → next round / final
  }

  /* ---- round 1: the pod nails it ---------------------------------------- */
  const fl1 = await dealAndPeek('round 1');
  const scapegoat1 = (fl1 + 1) % 4;
  await playRound({
    label: 'round 1', fl: fl1, expectCaught: true,
    votePlan: NAMES.map((_, seat) => (seat === fl1 ? scapegoat1 : fl1)),
  });

  /* ---- round 2: everyone misses, the Flatlander walks -------------------- */
  const fl2 = await dealAndPeek('round 2');
  if (fl2 === fl1) fail('rotation: never the same Flatlander twice in a row', `seat ${fl2 + 1} twice`);
  else ok('rotation: round 2 dealt a different Flatlander');
  const scapegoat2 = [0, 1, 2, 3].find((s) => s !== fl2);
  await playRound({
    label: 'round 2', fl: fl2, expectCaught: false,
    // Everyone piles onto an innocent seat; the innocent votes elsewhere.
    votePlan: NAMES.map((_, seat) => (seat === scapegoat2
      ? [0, 1, 2, 3].find((t) => t !== seat)
      : scapegoat2)),
  });

  /* ---- the wrap: one pod scoreboard through the moderation gate ---------- */
  await ada.waitForSelector('#mode-flatlander-send', T);
  const finalBoard = await ada.textContent('#mode-flatlander-board');
  // The escapee's total: +100 as a round-1 spotter, +200 for the round-2 escape.
  if (finalBoard.includes(`${NAMES[fl2]}300`)) {
    ok('final pod board pays the escape double (round-1 spot 100 + escape 200 = 300)');
  } else fail('final pod board pays the escape double', finalBoard.slice(0, 120));
  await ada.click('#mode-flatlander-send');
  await ada.waitForSelector('#lockedPanel:not(.hidden)', T);
  ok('table phone sent the pod scoreboard and the shell pocketed it');

  for (const p of joiners) {
    const done = await p.textContent('[data-mode="flatlander"]');
    if (!done.includes('the game')) fail('joiner phones reach the game-over screen', done.slice(0, 80));
  }
  ok('joiner phones reached the game-over screen (no submission of their own)');

  /* ---- hostSetup renders (unreachable via host.html until the shell's
          mode picker lands, so exercise it directly) ----------------------- */
  const hostSurface = await ada.evaluate(async () => {
    const m = await import('/modes/flatlander/mode.js');
    const mountEl = document.createElement('div');
    let opened = null;
    m.hostSetup({ event: { questions: [] }, openRound: (cfg) => { opened = cfg; } }, mountEl);
    mountEl.querySelector('#mode-flatlander-open').click();
    return { saltType: typeof opened?.salt, rounds: opened?.rounds };
  });
  if (hostSurface.saltType === 'string' && hostSurface.rounds === 5) {
    ok('hostSetup renders and opens a salted 5-round config');
  } else fail('hostSetup renders and opens a salted 5-round config', JSON.stringify(hostSurface));

  /* ---- scripted host: moderate, reveal, and land the beats --------------- */
  const snap = await rpc('party_host_get', { p_event: ev.eventId, p_host_key: HOST_KEY });
  if (snap.round.submissions.length !== 1) {
    fail('exactly one submission per pod (the table phone\'s)', `${snap.round.submissions.length}`);
  } else ok('exactly one submission per pod (the table phone\'s)');
  const sub = snap.round.submissions[0];
  if (sub.payload?.pod !== podCode.slice(0, 4)) fail('the payload names the pod', JSON.stringify(sub.payload).slice(0, 80));
  const line = flatlander.describeSubmission(sub.payload);
  if (line.startsWith(`Pod ${podCode.slice(0, 4)}`)) ok(`moderation line reads: "${line}"`);
  else fail('moderation line is host-readable', line);

  await rpc('party_close_round', { p_event: ev.eventId, p_host_key: HOST_KEY });
  await rpc('party_moderate_all', {
    p_event: ev.eventId, p_host_key: HOST_KEY, p_round: snap.round.id, p_status: 'approved',
  });
  const fresh = await rpc('party_host_get', { p_event: ev.eventId, p_host_key: HOST_KEY });
  const approved = fresh.round.submissions
    .filter((s) => s.status === 'approved')
    .map((s) => ({ name: s.name, payload: s.payload }));
  const results = flatlander.computeResults({ config: fresh.round.config, approved });
  await rpc('party_start_reveal', {
    p_event: ev.eventId, p_host_key: HOST_KEY, p_round: snap.round.id, p_results: results,
  });
  ok('scripted host approved the pod and fired the reveal');

  const screenCtx = await browser.newContext({ viewport: LAPTOP });
  const screen = await screenCtx.newPage();
  screen.on('pageerror', (e) => pageErrors.push(`screen: ${e.message}`));
  await screen.goto(`${baseUrl}/screen.html${api}&code=${ev.code}`);
  for (let step = 0; step < flatlander.beatCount(); step++) {
    if (step > 0) {
      await rpc('party_reveal_step', {
        p_event: ev.eventId, p_host_key: HOST_KEY, p_round: snap.round.id, p_step: step,
      });
    }
    await screen.waitForFunction((s) =>
      document.getElementById('mode-flatlander-beat')?.dataset.step === String(s), step, T);
    const beat = flatlander.narrated(step, results, []);
    if (typeof beat.title !== 'string' || !beat.lines.length) fail(`beat ${step} narrates`);
  }
  ok('screen landed all five beats; narrated lines exist for each');
  const podium = await screen.textContent('#stageInner');
  if (podium.includes('Ada')) ok('the podium names the pod\'s players (approved content only)');
  else fail('the podium names the pod\'s players', podium.slice(0, 100));
  await rpc('party_end_round', { p_event: ev.eventId, p_host_key: HOST_KEY });
  await screenCtx.close();
} catch (e) {
  fail('smoke run', String(e).split('\n')[0]);
}

for (const e of pageErrors) fail('zero page errors', e);
if (!pageErrors.length) ok('zero page errors across every phone');

await browser.close();
shimServer.close();
staticServer.close();

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) FAILED`);
  process.exit(1);
}
console.log('\nSmoke: a full pod night played clean at the table.');

// TWO HEADS — Playwright multi-phone smoke, in the style of
// scripts/smoke-party.mjs: a real browser night against the local shim.
// A host creates the event; four phones form two teams (captain writes,
// partner types the team code); a fifth phone just watches; the host
// moderates and paces the write reveal; then the bracket final runs as a
// one-tap vote round where ALL FIVE phones — including the spectator —
// vote, and the champion lands on the screen by team name.
//
//   node scripts/smoke-two-heads.mjs
//
// The shell's mode picker landed, so this smoke drives it like a real
// night: the host taps the Two Heads tab, then opens the round. (The old
// host-only manifest reroute is gone.)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShim } from './party-shim.mjs';

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

const browser = await chromium.launch();
const pageErrors = [];
async function newFace(path, { width, height }) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message}`));
  await page.goto(`${baseUrl}/${path}`);
  return page;
}
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1440, height: 900 };
const T = { timeout: 15000 };

try {
  /* ---- host creates tonight's event ----------------------------------- */
  const host = await newFace(`host.html${api}`, PHONE);
  await host.waitForSelector('#setupPanel:not(.hidden)', T);
  await host.fill('#eventTitle', 'Two Heads Smoke');
  await host.click('#hostCreate');
  await host.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('hostCode').textContent), null, T);
  const code = await host.textContent('#hostCode');
  ok(`host created event ${code}`);

  /* ---- five phones join: four will pair up, one just watches ---------- */
  const names = ['Ada', 'Ben', 'Cleo', 'Dot', 'Eve'];
  const phones = {};
  for (const name of names) {
    const p = await newFace(`index.html${api}&join=${code}`, PHONE);
    await p.waitForSelector('#joinPanel:not(.hidden)', T);
    await p.fill('#joinName', name);
    await p.click('#joinGo');
    await p.waitForSelector('#checkinPanel:not(.hidden)', T);
    await p.click('#checkinSkip');
    await p.waitForSelector('#idlePanel:not(.hidden)', T);
    phones[name] = p;
  }
  ok('five phones joined (check-in skipped — porous)');

  const screen = await newFace(`screen.html${api}&code=${code}`, LAPTOP);
  await screen.waitForSelector('#stage:not(.hidden)', T);
  ok('screen is up');

  /* ---- host picks Two Heads on the mode tabs, opens a write round ------ */
  await host.waitForSelector('#mode-tab-two-heads', T);
  await host.click('#mode-tab-two-heads');
  ok('host picked Two Heads on the shell mode picker');
  await host.waitForSelector(`#mode-two-heads-prompt-th-001`, T);
  await host.click('#mode-two-heads-prompt-th-001');
  await host.waitForSelector('#roundLive:not(.hidden)', T);
  ok('host opened the write round from the Two Heads prompt deck');
  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('Church Street'), null, T),
    'screen: the prompt is up while teams write');

  /* ---- team one: Ada captains, Ben joins with her code ----------------- */
  const ada = phones.Ada;
  await ada.waitForSelector('#collectPanel:not(.hidden)', T);
  await ada.click('#mode-two-heads-start');
  await ada.waitForSelector('#mode-two-heads-code', T);
  const teamCode1 = (await ada.textContent('#mode-two-heads-code')).trim();
  if (!/^[A-Z2-9]{4}$/.test(teamCode1)) fail('captain phone shows a 4-letter team code', teamCode1);
  else ok(`captain phone shows a team code (${teamCode1})`);
  await ada.fill('#mode-two-heads-team-name', 'Maple Mayhem');
  await ada.fill('#mode-two-heads-answer', 'FREE SAMPLES (of winter)');
  await ada.click('#mode-two-heads-send');
  await ada.waitForSelector('#lockedPanel:not(.hidden)', T);
  ok('team one co-wrote and locked in ONE answer on the captain phone');

  const ben = phones.Ben;
  await ben.waitForSelector('#collectPanel:not(.hidden)', T);
  await ben.click('#mode-two-heads-join');
  await ben.fill('#mode-two-heads-join-code', teamCode1);
  await ben.click('#mode-two-heads-join-go');
  await ben.waitForSelector('#lockedPanel:not(.hidden)', T);
  ok('the partner entered the team code by hand — consent is the mechanic');

  /* ---- team two: Cleo captains, Dot joins ------------------------------ */
  const cleo = phones.Cleo;
  await cleo.waitForSelector('#collectPanel:not(.hidden)', T);
  await cleo.click('#mode-two-heads-start');
  await cleo.waitForSelector('#mode-two-heads-code', T);
  const teamCode2 = (await cleo.textContent('#mode-two-heads-code')).trim();
  await cleo.fill('#mode-two-heads-team-name', 'Stick Season');
  await cleo.fill('#mode-two-heads-answer', 'Sorry about the smell, that is just the lake');
  await cleo.click('#mode-two-heads-send');
  await cleo.waitForSelector('#lockedPanel:not(.hidden)', T);
  const dot = phones.Dot;
  await dot.waitForSelector('#collectPanel:not(.hidden)', T);
  await dot.click('#mode-two-heads-join');
  await dot.fill('#mode-two-heads-join-code', teamCode2);
  await dot.click('#mode-two-heads-join-go');
  await dot.waitForSelector('#lockedPanel:not(.hidden)', T);
  ok('team two formed the same way');

  /* ---- Eve opts to watch — nobody comments ----------------------------- */
  const eve = phones.Eve;
  await eve.waitForSelector('#collectPanel:not(.hidden)', T);
  await eve.click('#mode-two-heads-watch');
  await must(eve.waitForFunction(() => document.body.textContent.includes('Spectating'), null, T),
    'the spectator path is one tap and judgment-free');

  /* ---- moderation gate -------------------------------------------------- */
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row').length >= 4, null, T);
  const leak = await screen.evaluate(() => document.getElementById('stageInner').textContent.includes('SAMPLES'));
  if (leak) fail('screen never shows a raw answer before the reveal');
  else ok('screen never shows a raw answer before the reveal');
  await host.click('#closeRoundBtn');
  await host.waitForSelector('#revealBtn:not(.hidden)', T);
  await host.click('#approveAllBtn');
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.approved').length >= 4, null, T);
  ok('host approved the queue (answers and join markers)');

  /* ---- the write reveal: prompt → contenders → bracket ------------------ */
  await host.click('#revealBtn');
  await host.waitForSelector('#narrated:not(.hidden)', T);
  const expectStep = (step, check, label) =>
    must(screen.waitForFunction(([s, c]) => {
      const el = document.getElementById('mode-two-heads-beat');
      return el && el.dataset.step === String(s)
        && (!c || document.getElementById('stageInner').textContent.includes(c));
    }, [step, check], T), label);
  await expectStep(0, 'Church Street', 'screen: beat 0 — the prompt lands');
  await host.click('#narratedNext');
  await expectStep(1, 'Maple Mayhem', 'screen: beat 1 — contenders parade credits TEAM names');
  await host.click('#narratedNext');
  await expectStep(2, 'vs', 'screen: beat 2 — the bracket');
  await host.click('#narratedNext'); // wrap
  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('Scan in'), null, T),
    'screen: back to the lobby after the write reveal');

  /* ---- THE FINAL: one tap on the host console --------------------------- */
  await host.waitForSelector('#mode-two-heads-continue', T);
  ok('host console offers the face-off with one tap');
  await host.click('#mode-two-heads-continue');
  await host.waitForSelector('#roundLive:not(.hidden)', T);
  await must(screen.waitForFunction(() => {
    const t = document.getElementById('stageInner').textContent;
    return t.includes('SAMPLES') && t.includes('lake');
  }, null, T), 'screen: both approved answers face off in big type');

  /* ---- everyone votes — the spectator too ------------------------------- */
  // Bracket sides are a seeded shuffle, so find which button is which
  // instead of assuming: four phones back Maple Mayhem, one backs the rip.
  await phones.Ada.waitForSelector('#collectPanel:not(.hidden)', T);
  await phones.Ada.waitForSelector('#mode-two-heads-pick-0', T);
  const side0 = await phones.Ada.textContent('#mode-two-heads-pick-0');
  const maple = side0.includes('Maple Mayhem') ? 0 : 1;
  const votes = { Ada: maple, Ben: maple, Cleo: 1 - maple, Dot: maple, Eve: maple };
  for (const [name, pick] of Object.entries(votes)) {
    const p = phones[name];
    await p.waitForSelector('#collectPanel:not(.hidden)', T);
    await p.waitForSelector(`#mode-two-heads-pick-${pick}`, T);
    await p.click(`#mode-two-heads-pick-${pick}`);
    await p.waitForSelector('#lockedPanel:not(.hidden)', T);
  }
  ok('all five phones voted — players and the spectator alike');

  await host.click('#closeRoundBtn');
  await host.waitForSelector('#revealBtn:not(.hidden)', T);
  await host.click('#approveAllBtn');
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.approved').length >= 5, null, T);
  await host.click('#revealBtn');
  await host.waitForSelector('#narrated:not(.hidden)', T);

  /* ---- the staged winner reveal ----------------------------------------- */
  await expectStep(0, 'versus', 'screen: beat 0 — the matchup');
  await host.click('#narratedNext');
  await expectStep(1, 'ballot', 'screen: beat 1 — drumroll with the ballot count');
  await host.click('#narratedNext');
  await expectStep(2, 'Maple Mayhem', 'screen: beat 2 — the 4–1 winner, credited by team name');
  await host.click('#narratedNext');
  await expectStep(3, 'CHAMPIONS', 'screen: beat 3 — champions crowned');
  const champText = await screen.evaluate(() => document.getElementById('stageInner').textContent);
  if (champText.includes('Maple Mayhem')) ok('champions are credited by TEAM name only');
  else fail('champions are credited by TEAM name only', champText.slice(0, 80));
  if (/Ada|Ben|Cleo|Dot|Eve/.test(champText)) {
    fail('no individual is ever named on the reveal', champText.slice(0, 120));
  } else ok('no individual is ever named on the reveal');
  await host.click('#narratedNext'); // wrap
  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('Scan in'), null, T),
    'screen: back to the lobby after the champion');
  await must(phones.Ada.waitForSelector('#idlePanel:not(.hidden)', T),
    'phones: pocketed again after the night\'s pulse');
  await host.waitForSelector('#mode-two-heads-prompt-th-002', T);
  ok('host console is back to fresh prompts (bracket finished, th-001 spent)');
} catch (e) {
  fail('smoke run', String(e).split('\n')[0]);
}

for (const e of pageErrors) fail('zero page errors', e);
if (!pageErrors.length) ok('zero page errors across every face');

await browser.close();
shimServer.close();
staticServer.close();

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) FAILED`);
  process.exit(1);
}
console.log('\nSmoke: a full Two Heads night — huddle, bracket, champion — played clean.');

// BTOWN PARTY — Playwright multi-phone smoke, modeled on the rooms-layer
// smokes: a real browser night. A host context creates the event, three
// phone contexts join / check in / guess, a fourth joins late and only
// watches, the host approves and paces the reveal, and a screen context
// lands every beat. Runs against scripts/party-shim.mjs (the local HTTP
// stand-in for the SQL backend) plus a throwaway static server — no
// Supabase needed. Finishes with a one-context ?demo=1 pass across all
// three faces.
//
//   node scripts/smoke-party.mjs
//
// Playwright is DEV-ONLY (the shipped site has no dependencies). If the
// import fails: `npm install --no-save playwright && npx playwright
// install chromium` in the repo root, or set NODE_PATH to a node_modules
// that has it.

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
  /* ---- host creates tonight's event ---------------------------------- */
  const host = await newFace(`host.html${api}`, PHONE);
  await host.waitForSelector('#setupPanel:not(.hidden)', T);
  await host.fill('#eventTitle', 'Smoke Test Mixer');
  await host.click('#hostCreate');
  await host.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('hostCode').textContent), null, T);
  const code = await host.textContent('#hostCode');
  ok(`host created event ${code}`);

  /* ---- three phones join via the deep link and check in --------------- */
  const names = ['Ada', 'Ben', 'Cleo'];
  const phones = [];
  for (const name of names) {
    const p = await newFace(`index.html${api}&join=${code}`, PHONE);
    await p.waitForSelector('#joinPanel:not(.hidden)', T);
    if (await p.inputValue('#joinCode') !== code) fail(`${name}: ?join link prefills the code`);
    await p.fill('#joinName', name);
    await p.click('#joinGo');
    await p.waitForSelector('#checkinPanel:not(.hidden)', T);
    for (let q = 0; q < 3; q++) {
      await p.waitForSelector('#checkinOpt0', T);
      await p.click(`#checkinOpt${names.indexOf(name) % 2}`);
      await p.waitForTimeout(250);
    }
    await p.waitForSelector('#idlePanel:not(.hidden)', T);
    phones.push(p);
  }
  ok('three phones joined and checked in (deep link prefilled the code)');

  /* ---- screen face shows the lobby + QR ------------------------------- */
  const screen = await newFace(`screen.html${api}&code=${code}`, LAPTOP);
  await screen.waitForSelector('#stage:not(.hidden)', T);
  await screen.waitForFunction(() => document.getElementById('joinCorner')?.querySelector('svg'), null, T);
  await must(
    screen.waitForFunction((n) => (document.getElementById('screenCount')?.textContent ?? '').includes(`${n} in the room`), names.length, T),
    'screen: lobby shows the live head count and the join QR',
  );

  /* ---- host opens a Room Knows round ---------------------------------- */
  console.log('… host: waiting for round setup');
  await host.waitForSelector('#roundSetupMount .question-pick', T);
  console.log('… host: picking the question');
  await host.click('#mode-room-knows-pick-rk-001');
  await host.waitForSelector('#roundLive:not(.hidden)', T);
  ok('host opened a round');

  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('Phones out'), null, T),
    'screen: collect phase is up');

  /* ---- phones wake and guess; one late phone only watches ------------- */
  const guesses = [[0, 60], [0, 45], [1, 30]];
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    await p.waitForSelector('#collectPanel:not(.hidden)', T);
    await p.click(`#mode-room-knows-opt-${guesses[i][0]}`);
    await p.fill('#mode-room-knows-pct', String(guesses[i][1]));
    await p.click('#mode-room-knows-send');
    await p.waitForSelector('#lockedPanel:not(.hidden)', T);
  }
  ok('three phones guessed and locked in');

  const late = await newFace(`index.html${api}&join=${code}`, PHONE);
  await late.fill('#joinName', 'Dot');
  await late.click('#joinGo');
  await late.waitForSelector('#checkinPanel:not(.hidden)', T);
  await late.click('#checkinSkip');
  await late.waitForSelector('#collectPanel:not(.hidden), #idlePanel:not(.hidden)', T);
  ok('a latecomer joined mid-round, skipped check-in, and broke nothing');

  /* ---- moderation gate on the host ------------------------------------ */
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row').length >= 3, null, T);
  const screenLeak = await screen.evaluate(() => document.body.textContent.includes('60%'));
  if (screenLeak) fail('screen never shows raw guesses before the reveal');
  else ok('screen never shows raw guesses before the reveal');

  await host.click('#closeRoundBtn');
  await host.waitForSelector('#revealBtn:not(.hidden)', T);
  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('Eyes up'), null, T),
    'screen: eyes-up interstitial after close');
  await host.click('#approveAllBtn');
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.approved').length >= 3, null, T);
  ok('host approved the queue');

  /* ---- the staged reveal, beat by beat -------------------------------- */
  await host.click('#revealBtn');
  await host.waitForSelector('#narrated:not(.hidden)', T);
  ok('host: narrated reveal is up');

  const expectStep = (step, check, label) =>
    must(screen.waitForFunction(([s, c]) => {
      const el = document.getElementById('mode-room-knows-beat');
      return el && el.dataset.step === String(s)
        && (!c || document.getElementById('stageInner').textContent.includes(c));
    }, [step, check], T), label);

  await expectStep(0, 'creemee', 'screen: beat 0 — the question lands');
  for (let s = 1; s <= 5; s++) {
    await host.click('#narratedNext');
    await expectStep(s, null, `screen: beat ${s} follows the host's tap`);
  }
  const bars = await screen.evaluate(() => document.querySelectorAll('.bar-fill').length);
  // beat 5 is the scoreboard; bars were beat 3 — just assert the reveal
  // reached the scoreboard with named readers on it:
  const boardText = await screen.evaluate(() => document.getElementById('stageInner').textContent);
  if (boardText.includes('Ada')) ok('screen: scoreboard names the readers (approved content only)');
  else fail('screen: scoreboard names the readers', boardText.slice(0, 80));
  void bars;

  const narratedText = await host.textContent('#narratedLines');
  if (narratedText.trim().length > 0) ok('host: narrated lines are readable aloud');
  else fail('host: narrated lines are readable aloud');

  await host.click('#narratedNext'); // "Wrap the round"
  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('Scan in'), null, T),
    'screen: back to the lobby after the wrap');
  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('reads the room best'), null, T),
    'screen: lobby scoreboard teaser is up');
  await must(phones[0].waitForSelector('#idlePanel:not(.hidden)', T),
    'phones: back to "watch the room" after the round');

  /* ---- ?demo=1: all three faces in one context, no backend ------------ */
  const demoCtx = await browser.newContext({ viewport: LAPTOP });
  const demoHost = await demoCtx.newPage();
  demoHost.on('pageerror', (e) => pageErrors.push(`demo host: ${e.message}`));
  await demoHost.goto(`${baseUrl}/host.html?demo=1`);
  await demoHost.waitForFunction(() => document.getElementById('hostCode').textContent === 'BTWN', null, T);
  await demoHost.waitForFunction(() => document.querySelectorAll('#hostRoster .who').length >= 12, null, T);
  ok('demo: host console sees the fake crowd of 12');
  const demoScreen = await demoCtx.newPage();
  demoScreen.on('pageerror', (e) => pageErrors.push(`demo screen: ${e.message}`));
  await demoScreen.goto(`${baseUrl}/screen.html?demo=1`);
  await demoScreen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('in the room'), null, T);
  ok('demo: screen face runs on the same fake event');
  await demoHost.click('.question-pick');
  await demoHost.waitForSelector('#roundLive:not(.hidden)', T);
  await demoHost.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row').length >= 3, null, { timeout: 25000 });
  ok('demo: the fake crowd drifts in submissions after the round opens');
  const demoPhone = await demoCtx.newPage();
  demoPhone.on('pageerror', (e) => pageErrors.push(`demo phone: ${e.message}`));
  await demoPhone.goto(`${baseUrl}/index.html?demo=1&join=BTWN`);
  await demoPhone.fill('#joinName', 'You');
  await demoPhone.click('#joinGo');
  await demoPhone.waitForSelector('#checkinPanel:not(.hidden), #collectPanel:not(.hidden), #idlePanel:not(.hidden)', T);
  ok('demo: an attendee phone joins the fake event');
  await demoCtx.close();
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
console.log('\nSmoke: a full multi-phone night played clean.');

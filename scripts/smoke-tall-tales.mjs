// TALL TALES — Playwright smoke, modeled on scripts/smoke-party.mjs: a real
// browser night through BOTH rounds of one fact. A host context creates the
// event, three phones join and write lies, the host REJECTS one lie (the
// moderation gate), approves the rest, bridges into the vote round, phones
// vote (one phone is refused its own lie), and the staged reveal lands beat
// by beat on the screen — including THE SOURCE beat, which is not optional.
// Finishes with a direct hostSetup pass (the needsReview curation gate in a
// real DOM) and a pod-play pass on one phone.
//
// The shell's host console currently hardcodes Object.values(MODES)[0]
// (room-knows) for ROUND SETUP — a mode picker is a shell change outside
// this mode's fence — so the two round-open taps are driven here as direct
// RPCs (exactly the calls hostSetup makes), and hostSetup's own UI is
// exercised separately against the same live snapshot. Every other host
// surface (moderation queue, close/approve/reveal, narrated view) is the
// real shell UI, which dispatches on the round's mode.
//
//   node scripts/smoke-tall-tales.mjs
//
// Playwright is DEV-ONLY. If the import fails: `npm install --no-save
// playwright && npx playwright install chromium` in the repo root.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShim } from './party-shim.mjs';
import { buildBallot, seedFrom, factById } from '../modes/tall-tales/logic.js';

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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${fn}: ${body.message}`);
  return body;
}

const deck = JSON.parse(await readFile(join(ROOT, 'modes/tall-tales/content/talltales-facts.json'), 'utf8'));
const FACT = factById(deck, 'tt-001'); // Bernie's ten-vote margin

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
  await host.fill('#eventTitle', 'Tall Tales Smoke');
  await host.click('#hostCreate');
  await host.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('hostCode').textContent), null, T);
  const code = await host.textContent('#hostCode');
  const hostKey = await host.evaluate(() => localStorage.getItem('btown-party-host-key'));
  const eventId = await host.evaluate(() => JSON.parse(localStorage.getItem('btown-party-host-event')).eventId);
  ok(`host created event ${code}`);

  /* ---- three phones join, one skips check-in --------------------------- */
  const names = ['Ada', 'Ben', 'Cleo'];
  const phones = [];
  for (const name of names) {
    const p = await newFace(`index.html${api}&join=${code}`, PHONE);
    await p.waitForSelector('#joinPanel:not(.hidden)', T);
    await p.fill('#joinName', name);
    await p.click('#joinGo');
    await p.waitForSelector('#checkinPanel:not(.hidden)', T);
    await p.click('#checkinSkip'); // porous: Tall Tales needs no check-in data
    await p.waitForSelector('#idlePanel:not(.hidden)', T);
    phones.push(p);
  }
  const [ada, ben, cleo] = phones;
  ok('three phones joined (check-in skipped — Tall Tales needs none)');

  const screen = await newFace(`screen.html${api}&code=${code}`, LAPTOP);
  await screen.waitForSelector('#stage:not(.hidden)', T);
  await must(
    screen.waitForFunction((n) => (document.getElementById('screenCount')?.textContent ?? '').includes(`${n} in the room`), names.length, T),
    'screen: lobby shows the live head count',
  );

  /* ---- ROUND A: the lies ------------------------------------------------ */
  // Opened by direct RPC — the exact call hostSetup's fact button makes.
  // Note the config carries NO answer and NO source: phones must not hold
  // the truth while the room is inventing lies.
  await rpc('party_open_round', {
    p_event: eventId, p_host_key: hostKey, p_mode: 'tall-tales',
    p_config: { phase: 'lies', fact: { id: FACT.id, setup: FACT.setup, category: FACT.category } },
  });
  ok('lies round opened (config: setup only — no answer, no source)');

  const LIES = {
    Ada: 'a flock of escaped emus',
    Ben: 'one very confused zamboni',
    Cleo: 'a mile of maple taps', // this one the host will REJECT
  };
  for (const [i, name] of names.entries()) {
    const p = phones[i];
    await p.waitForSelector('#collectPanel:not(.hidden)', T);
    await p.waitForSelector('[data-mode="tall-tales"] #mode-tall-tales-lie', T);
    await p.fill('#mode-tall-tales-lie', LIES[name]);
    await p.click('#mode-tall-tales-send');
    await p.waitForSelector('#lockedPanel:not(.hidden)', T);
  }
  ok('three phones wrote lies and locked in');

  const leakEarly = await screen.evaluate(() => document.body.textContent.includes('emus'));
  if (leakEarly) fail('screen never shows a lie before the host approves and reveals');
  else ok('screen never shows a lie before the host approves and reveals');

  /* ---- moderation: the host holds the gate ----------------------------- */
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row').length >= 3, null, T);
  const queueText = await host.textContent('#modQueue');
  if (queueText.includes(LIES.Ada) && queueText.includes(LIES.Cleo)) {
    ok('host: moderation queue shows each lie verbatim (describeSubmission)');
  } else fail('host: moderation queue shows each lie verbatim', queueText.slice(0, 120));

  // Reject Cleo's lie — it must never reach the ballot, the phones, or the screen.
  await host.evaluate((lieText) => {
    const row = [...document.querySelectorAll('#modQueue .mod-row')]
      .find((r) => r.textContent.includes(lieText));
    row.querySelector('.b-no').click();
  }, LIES.Cleo);
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.rejected').length === 1, null, T);
  ok('host rejected one lie');

  await host.click('#closeRoundBtn');
  await host.waitForSelector('#revealBtn:not(.hidden)', T);
  await host.click('#approveAllBtn');
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.approved').length === 2, null, T);
  ok('host approved the remaining two lies');

  /* ---- round A reveal: the one-beat bridge ------------------------------ */
  await host.click('#revealBtn');
  await host.waitForSelector('#narrated:not(.hidden)', T);
  await must(
    screen.waitForFunction(() => {
      const el = document.getElementById('mode-tall-tales-beat');
      return el && document.getElementById('stageInner').textContent.includes('tales are in');
    }, null, T),
    'screen: bridge beat — "the tall tales are in"',
  );
  await host.waitForFunction(() => document.getElementById('narratedNext').textContent.includes('Wrap'), null, T);
  await host.click('#narratedNext'); // wrap round A
  ok('host wrapped the lies round');

  /* ---- ROUND B: the vote ------------------------------------------------ */
  // Build the ballot exactly as hostSetup's "open the vote" button does:
  // from the wrapped round's STORED results (approved lies only).
  const snap = await rpc('party_host_get', { p_event: eventId, p_host_key: hostKey });
  const liesResults = snap.doneResults.filter((d) => d.mode === 'tall-tales').pop().results;
  if (liesResults.lies.length === 2 && !JSON.stringify(liesResults).includes(LIES.Cleo)) {
    ok('stored lies round holds ONLY the two approved lies — the rejected one died unseen');
  } else fail('stored lies round holds only approved lies', JSON.stringify(liesResults.lies));

  const ballot = buildBallot({
    fact: FACT,
    lies: liesResults.lies,
    seed: seedFrom(`${FACT.id}|${liesResults.lies.map((l) => l.text).join('|')}`),
  });
  await rpc('party_open_round', {
    p_event: eventId, p_host_key: hostKey, p_mode: 'tall-tales',
    p_config: {
      phase: 'vote',
      fact: {
        id: FACT.id, setup: FACT.setup, answer: FACT.answer,
        source: { url: FACT.sourceUrl, title: FACT.sourceTitle, quote: FACT.sourceQuote },
      },
      ballot,
    },
  });
  ok('vote round opened with the seeded ballot');

  /* ---- phones vote; own lies are refused -------------------------------- */
  for (const p of phones) {
    await p.waitForSelector('[data-mode="tall-tales"] [id^="mode-tall-tales-vote-"]', T);
  }
  const adaOwn = await ada.evaluate((lieText) =>
    [...document.querySelectorAll('[id^="mode-tall-tales-vote-"]')]
      .find((b) => b.textContent.includes(lieText))?.disabled, LIES.Ada);
  if (adaOwn === true) ok('own-vote rejection: Ada’s phone refuses her own lie');
  else fail('own-vote rejection: Ada’s phone refuses her own lie', String(adaOwn));

  const cleoBallot = await cleo.textContent('#collectPanel');
  if (!cleoBallot.includes(LIES.Cleo)) ok('the rejected lie is not on the ballot any phone sees');
  else fail('the rejected lie is not on the ballot any phone sees');

  const voteFor = async (page, text) => {
    await page.evaluate((t) => {
      [...document.querySelectorAll('[id^="mode-tall-tales-vote-"]')]
        .find((b) => b.textContent.includes(t) && !b.disabled).click();
    }, text);
    await page.click('#mode-tall-tales-send');
    await page.waitForSelector('#lockedPanel:not(.hidden)', T);
  };
  await voteFor(ada, FACT.answer);   // Ada finds the truth
  await voteFor(ben, LIES.Ada);      // Ben falls for the emus
  await voteFor(cleo, FACT.answer);  // Cleo finds the truth
  ok('phones voted: two found the truth, one was fooled');

  /* ---- host approves the votes and paces the full reveal ---------------- */
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row').length >= 3, null, T);
  const voteQueue = await host.textContent('#modQueue');
  if (voteQueue.includes('voted:')) ok('host: vote queue reads as one human line per vote');
  else fail('host: vote queue reads as one human line per vote', voteQueue.slice(0, 120));
  await host.click('#closeRoundBtn');
  await host.waitForSelector('#revealBtn:not(.hidden)', T);
  await host.click('#approveAllBtn');
  await host.waitForFunction(() => document.querySelectorAll('#modQueue .mod-row.approved').length >= 3, null, T);
  await host.click('#revealBtn');
  await host.waitForSelector('#narrated:not(.hidden)', T);
  const stepLine = await host.textContent('#narratedStep');
  const beatTotal = Number(stepLine.match(/of (\d+)/)[1]);
  ok(`host: narrated reveal is up — ${beatTotal} beats`);

  const beatTexts = [];
  for (let s = 0; s < beatTotal; s++) {
    if (s > 0) {
      await host.click('#narratedNext');
      await screen.waitForFunction((step) => {
        const el = document.getElementById('mode-tall-tales-beat');
        return el && el.dataset.step === String(step);
      }, s, T);
    } else {
      await screen.waitForFunction(() => document.getElementById('mode-tall-tales-beat'), null, T);
    }
    beatTexts.push(await screen.evaluate(() => document.getElementById('stageInner').textContent));
  }
  const findBeat = (needle) => beatTexts.find((t) => t.includes(needle));

  const lieBeat = findBeat('This one fooled 1');
  if (lieBeat && lieBeat.includes('Ada') && lieBeat.includes(LIES.Ada)) {
    ok('screen: a lie beat lands with its vote count and its author’s first name');
  } else fail('screen: a lie beat lands with count + author', (lieBeat ?? '').slice(0, 120));

  const truthBeat = findBeat('The truth');
  if (truthBeat && truthBeat.includes(FACT.answer) && truthBeat.includes('Ada') && truthBeat.includes('Cleo')) {
    ok('screen: the truth beat names the answer and the finders');
  } else fail('screen: the truth beat names the answer and the finders', (truthBeat ?? '').slice(0, 140));

  const sourceBeat = findBeat('The source');
  if (sourceBeat && sourceBeat.includes(FACT.sourceTitle) && sourceBeat.includes(FACT.sourceUrl)) {
    ok('screen: THE SOURCE BEAT lands — citation title and link on the brand’s screen');
  } else fail('screen: the source beat lands with the citation', (sourceBeat ?? '').slice(0, 140));

  const boardBeat = beatTexts[beatTexts.length - 1];
  if (boardBeat.includes('Silver tongues') && boardBeat.includes('Ada')) {
    ok('screen: the silver-tongue board closes the reveal');
  } else fail('screen: the silver-tongue board closes the reveal', boardBeat.slice(0, 120));

  const narratedText = await host.textContent('#narratedLines');
  if (narratedText.trim().length > 0) ok('host: narrated lines are readable aloud at every beat');
  else fail('host: narrated lines are readable aloud');

  await host.click('#narratedNext'); // wrap
  await must(screen.waitForFunction(() => document.getElementById('stageInner').textContent.includes('Scan in'), null, T),
    'screen: back to the lobby after the wrap');
  await must(ada.waitForSelector('#idlePanel:not(.hidden)', T),
    'phones: back to "watch the room" after the round');

  /* ---- hostSetup, direct: the curation gate in a real DOM ---------------- */
  const setupPage = await newFace(`index.html${api}`, PHONE);
  const gate = await setupPage.evaluate(async () => {
    const mode = await import('/modes/tall-tales/mode.js');
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const opened = [];
    const ctx = { event: { doneResults: [] }, playedQuestionIds: [], openRound: async (cfg) => { opened.push(cfg); } };
    mode.hostSetup(ctx, mount);
    await new Promise((r) => setTimeout(r, 400)); // deck fetch
    const before = mount.querySelectorAll('[id^="mode-tall-tales-pick-"]').length;
    const hint = mount.textContent;
    mount.querySelector('#mode-tall-tales-show-unreviewed').click();
    const after = mount.querySelectorAll('[id^="mode-tall-tales-pick-"]').length;
    const metaText = mount.querySelector('[id^="mode-tall-tales-pick-"] .qp-meta').textContent;
    mount.querySelector('#mode-tall-tales-pick-tt-001').click();
    await new Promise((r) => setTimeout(r, 50));
    return { before, hint, after, metaText, opened };
  });
  if (gate.before === 0 && gate.hint.includes('No facts have passed review yet')) {
    ok('hostSetup: with 0 reviewed facts the default picker is EMPTY — the curation gate holds');
  } else fail('hostSetup: default picker hides unreviewed facts', `showed ${gate.before}`);
  if (gate.after === deck.facts.length && gate.metaText.includes('UNVERIFIED')) {
    ok('hostSetup: the testing toggle shows all facts, each branded UNVERIFIED');
  } else fail('hostSetup: testing toggle brands unreviewed facts', gate.metaText);
  const cfg = gate.opened[0];
  if (cfg?.phase === 'lies' && cfg.fact?.id === 'tt-001' && !('answer' in cfg.fact) && !('source' in cfg.fact)) {
    ok('hostSetup: a fact tap opens a lies round whose config carries NO answer and NO source');
  } else fail('hostSetup: lies config leaks nothing', JSON.stringify(cfg ?? null));

  const voteOffer = await setupPage.evaluate(async (liesResults) => {
    const mode = await import('/modes/tall-tales/mode.js');
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const opened = [];
    const ctx = {
      event: { doneResults: [{ id: 'rnd-x', mode: 'tall-tales', results: liesResults }] },
      playedQuestionIds: [],
      openRound: async (cfg) => { opened.push(cfg); },
    };
    mode.hostSetup(ctx, mount);
    await new Promise((r) => setTimeout(r, 400));
    mount.querySelector('#mode-tall-tales-open-vote').click();
    await new Promise((r) => setTimeout(r, 50));
    return opened[0] ?? null;
  }, liesResults);
  if (voteOffer?.phase === 'vote' && voteOffer.ballot?.entries?.length === 3
      && voteOffer.fact?.answer === FACT.answer && voteOffer.fact?.source?.url === FACT.sourceUrl) {
    ok('hostSetup: after a lies round it offers the vote, ballot = approved lies + the truth');
  } else fail('hostSetup: vote offer builds the ballot', JSON.stringify(voteOffer)?.slice(0, 140));

  /* ---- pod play: one phone, a table of three ----------------------------- */
  const pod = await newFace('modes/tall-tales/pod.html?unreviewed=1', PHONE);
  await pod.waitForSelector('#mode-tall-tales-pod-start', T);
  const banner = await pod.textContent('#podRoot');
  if (banner.includes('UNVERIFIED TEST DECK')) ok('pod: the unreviewed test deck is bannered loudly');
  else fail('pod: unreviewed banner', banner.slice(0, 100));
  for (const [i, name] of ['Maple', 'Birch', 'Cedar'].entries()) {
    await pod.fill(`#mode-tall-tales-pod-name-${i}`, name);
  }
  await pod.click('#mode-tall-tales-pod-start');
  const podLies = ['pod lie one', 'pod lie two', 'pod lie three'];
  for (const lieText of podLies) {
    await pod.waitForSelector('#mode-tall-tales-pod-pass', T);
    await pod.click('#mode-tall-tales-pod-pass');
    await pod.waitForSelector('#mode-tall-tales-pod-lie', T);
    await pod.fill('#mode-tall-tales-pod-lie', lieText);
    await pod.click('#mode-tall-tales-pod-lie-done');
  }
  ok('pod: three chairs wrote lies pass-and-play');
  await pod.waitForSelector('#mode-tall-tales-pod-ballot-go', T);
  await pod.click('#mode-tall-tales-pod-strike-2'); // the table strikes one lie
  await pod.click('#mode-tall-tales-pod-ballot-go');
  for (let i = 0; i < 3; i++) {
    await pod.waitForSelector('#mode-tall-tales-pod-pass', T);
    await pod.click('#mode-tall-tales-pod-pass');
    await pod.waitForSelector('[id^="mode-tall-tales-pod-vote-"]', T);
    if (i === 0) {
      const own = await pod.evaluate((t) =>
        [...document.querySelectorAll('[id^="mode-tall-tales-pod-vote-"]')]
          .find((b) => b.textContent.includes(t))?.disabled, podLies[0]);
      if (own === true) ok('pod: the phone refuses your own lie at the table too');
      else fail('pod: own-lie refusal at the table', String(own));
      const struck = await pod.evaluate(() => document.body.textContent.includes('pod lie three'));
      if (!struck) ok('pod: a struck lie never reaches the ballot');
      else fail('pod: a struck lie never reaches the ballot');
    }
    await pod.evaluate(() => {
      [...document.querySelectorAll('[id^="mode-tall-tales-pod-vote-"]')].find((b) => !b.disabled).click();
    });
  }
  let podSource = null;
  for (let s = 0; s < 20 && podSource == null; s++) {
    await pod.waitForSelector('#mode-tall-tales-pod-next', T);
    const text = await pod.textContent('#podRoot');
    if (text.includes('The source')) podSource = text;
    else if (/beat \d+ of \d+/.test(text) && !/beat (\d+) of \1\b/.test(text.match(/beat \d+ of \d+/)[0])) {
      await pod.click('#mode-tall-tales-pod-next');
    } else break;
  }
  if (podSource) ok('pod: the staged reveal reaches THE SOURCE beat on the table’s screen');
  else fail('pod: the staged reveal reaches the source beat');
  await pod.close();
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
console.log('\nSmoke: a full two-round Tall Tales night played clean.');

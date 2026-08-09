// Tests for modes/room-relay/logic.js — plain Node, no framework:
//   node scripts/test-room-relay.mjs
// Covers: the doodle codec, fragment validation, start-round assembly with
// check-in seeding, the routing plan (no self-assignment, no double
// assignment, expiry reroute, late joiners, byte budget), partial-chain
// assembly, BOTH moderation gates driven through the real party-core state
// machine, and determinism over a fixed event list.
import { readFileSync } from 'node:fs';
import {
  SLUG, RELAY, SEQS, det,
  encodeDoodle, decodeDoodle, cleanText, cleanFrag,
  cleanStartPayload, cleanContinuePayload,
  buildStartConfig, promptFor, seedChains, computeStartResults,
  buildContinuePlan, epochAt, assignmentsAt, assignmentFor,
  computeContinueResults, beatList, beatCount, narratedBeat,
  replay, validateDeck,
} from '../modes/room-relay/logic.js';
import {
  createDb, create_event, join, checkin, open_round, submit, close_round,
  moderate, start_reveal, end_round, host_get,
} from '../js/party-core.js';

let failures = 0;
function is(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
const truthy = (v, label) => is(!!v, true, label);

/* ---- the shipped prompt deck ------------------------------------------ */
const deck = JSON.parse(readFileSync(new URL('../content/room-relay-prompts.json', import.meta.url)));
is(validateDeck(deck), [], 'the shipped prompt deck is valid');
is(validateDeck({}).length > 0, true, 'a malformed deck is called out');

/* ---- doodle codec ------------------------------------------------------ */
const strokes = [{ c: 1, w: 1, pts: [[1, 1], [5, 5], [9, 2]] }, { c: 4, w: 0, pts: [[60, 60], [63, 0]] }];
const enc = encodeDoodle(strokes);
is(decodeDoodle(enc), strokes, 'doodle codec round-trips');
is(decodeDoodle('!!bad!!'), null, 'garbage characters are rejected');
is(decodeDoodle('AB'), null, 'a stroke needs at least two points');
is(decodeDoodle('x'.repeat(RELAY.doodleChars + 1)), null, 'an over-budget doodle is rejected');
is(decodeDoodle(''), null, 'an empty doodle is rejected');

/* ---- fragments --------------------------------------------------------- */
is(cleanFrag({ t: 'text', s: '  a  fine   line ' }, 'title'), { t: 'text', s: 'a fine line' }, 'text fragments are tidied');
is(cleanFrag({ t: 'text', s: '   ' }, 'title'), null, 'blank text is rejected');
is(cleanFrag({ t: 'text', s: 'x'.repeat(300) }, 'title').s.length, RELAY.textLen, 'long text is clamped');
is(cleanFrag({ t: 'doodle', d: enc }, 'doodle'), { t: 'doodle', d: enc }, 'a valid doodle passes');
is(cleanFrag({ t: 'text', s: 'words' }, 'doodle'), null, 'text where a doodle is due is rejected');
is(cleanFrag({ t: 'doodle', d: enc }, 'title'), null, 'a doodle where text is due is rejected');

/* ---- start round ------------------------------------------------------- */
const startCfg = buildStartConfig({
  chainType: 'headline-then-next-line',
  totalSteps: 2,
  deck,
  checkinQs: [{ id: 'rk-001', text: 'Your creemee order:', options: ['Maple', 'Twist'] }],
  seed: 99,
});
truthy(startCfg.prompts.length >= 5, 'start config carries prompts');
is(JSON.stringify(startCfg).length <= 8192, true, 'start config fits the 8 KB cap');
is(startCfg.question.text.includes('Room Relay'), true, 'screen marquee line is host-authored');
truthy(promptFor(startCfg, 'ply-1') < startCfg.prompts.length, 'promptFor lands in range');
is(promptFor(startCfg, 'ply-1'), promptFor(startCfg, 'ply-1'), 'promptFor is stable per person');

const frag = (s) => ({ t: 'text', s });
const startPayload = (author, s) => ({ rr: 1, author, prompt: 0, frag: frag(s) });
is(cleanStartPayload(startPayload('ply-1', 'BREAKING: geese unionize'), startCfg).frag.s,
  'BREAKING: geese unionize', 'a good start payload passes');
is(cleanStartPayload({ note: 'demo' }, startCfg), null, 'the demo crowd\'s junk payload is rejected');
is(cleanStartPayload({ rr: 1, author: 'ply-1', prompt: 999, frag: frag('x') }, startCfg).prompt,
  null, 'an out-of-range prompt index degrades to freestyle');

const tallies = [{ questionId: 'rk-001', counts: [6, 3], total: 9 }];
const startRes = computeStartResults({
  config: startCfg,
  approved: [
    { name: 'Ada', payload: startPayload('ply-1', 'BREAKING: geese unionize') },
    { name: 'Ben', payload: startPayload('ply-2', 'Church Street declared a lake') },
    { name: 'Ben again', payload: startPayload('ply-2', 'duplicate author entry') },
    { name: 'Junk', payload: { note: 'demo' } },
  ],
  checkinTallies: tallies,
});
is(startRes.stage, 'collected', 'start results are a collected stage');
is(startRes.fragTotal, 2, 'malformed and duplicate-author entries sit out');
is(startRes.seeded, 1, 'below minChains, check-in seeds top the room up');
is(startRes.chains.length, 3, 'chains = fragments + seeds');
truthy(startRes.chains[2].steps[0].frag.s.includes('Maple'), 'seed headline is written from the tally leader');
is(startRes.chains[2].steps[0].authorId, null, 'seed chains have no author to exclude');

const emptyRes = computeStartResults({ config: startCfg, approved: [], checkinTallies: [] });
is(emptyRes.chains.length, 0, 'zero submissions + empty room degrades to zero chains, no throw');
is(beatCount(emptyRes), 1, 'a collected stage always reveals as one teaser beat');

const seededOnly = computeStartResults({ config: startCfg, approved: [], checkinTallies: tallies });
truthy(seededOnly.chains.length >= 1 && seededOnly.chains.length <= RELAY.minChains,
  'an empty round with check-ins still yields seed material for the first pulse');

/* ---- routing: hand-built plan for exact assertions --------------------- */
const P = ['ply-1', 'ply-2', 'ply-3', 'ply-4'];
const mkChain = (i, authorId, by) => ({
  id: `ch-${i}`, kind: 'nextline', seq: ['headline', 'nextline'],
  prompt: 'p', hist: [{ by, authorId, frag: frag(`headline ${i}`) }], slot: i,
});
const plan = {
  rr: 1, phase: 'continue', leg: 1, chainType: 'headline-then-next-line',
  totalSteps: 2, seed: 1, expiryS: 150, openedAtS: 1000,
  roster: P, chains: [mkChain(0, 'ply-1', 'Ada'), mkChain(1, 'ply-2', 'Ben'), mkChain(2, 'ply-3', 'Cleo')],
  parked: [], dropped: 0, question: { text: 'relay' },
};

for (let epoch = 0; epoch <= 12; epoch++) {
  const { byChain, byPlayer } = assignmentsAt(plan, epoch);
  for (const c of plan.chains) {
    if (byChain[c.id] === c.hist[0].authorId) { failures += 1; console.error(`✗ self-assignment at epoch ${epoch}`); }
  }
  const holders = Object.values(byChain).filter(Boolean);
  if (new Set(holders).size !== holders.length) { failures += 1; console.error(`✗ double-assignment (one player, two chains) at epoch ${epoch}`); }
  const held = Object.values(byPlayer);
  if (new Set(held).size !== held.length) { failures += 1; console.error(`✗ double-assignment (one chain, two players) at epoch ${epoch}`); }
}
console.log('✓ epochs 0–12: never your own fragment, never a double assignment');

const e0 = assignmentsAt(plan, 0).byChain;
const e1 = assignmentsAt(plan, 1).byChain;
is(e0['ch-0'] === e1['ch-0'], false, 'an unclaimed assignment reroutes when the epoch expires');
is(epochAt(plan, 1000 + 149), 0, 'epoch holds inside the expiry window');
is(epochAt(plan, 1000 + 150), 1, 'epoch advances at the expiry boundary');
is(epochAt({ ...plan, openedAtS: null }, 5000), 0, 'an unstamped config stays at epoch 0');

is(assignmentFor(plan, 'ply-2', 0)?.id, 'ch-0', 'a planned player is offered somebody else\'s chain');
{
  let ownOffered = false;
  let idleSeen = false;
  for (let e = 0; e <= 12; e++) {
    for (const pid of P) {
      const a = assignmentFor(plan, pid, e);
      if (a == null) idleSeen = true; // fewer chains than people — someone rests
      else if (a.hist.some((h) => h.authorId === pid)) ownOffered = true;
    }
  }
  is(ownOffered, false, 'across every epoch, no planned player is ever offered their own chain');
  is(idleSeen, true, 'with more people than chains, resting is a valid state (waiting card, not an error)');
}
const late = assignmentFor(plan, 'ply-late-99', 0);
truthy(late, 'a late joiner gets a fragment immediately');
is(late.hist[0].authorId === 'ply-late-99', false, 'a late joiner never gets their own fragment');
is(assignmentFor(plan, null, 0), null, 'an unidentified phone gets a graceful null, not a throw');

const solo = { ...plan, roster: ['ply-1'], chains: [mkChain(0, 'ply-1', 'Ada')] };
is(assignmentFor(solo, 'ply-1', 3), null, 'a one-person room never gets its own chain back — waits instead');

/* ---- continue plan from real start results ----------------------------- */
const bigDoodle = encodeDoodle(Array.from({ length: 20 }, (_, i) => ({
  c: i % RELAY.colors, w: 1, pts: Array.from({ length: 15 }, (_, j) => [(i * 3) % 64, (j * 4) % 64]),
})));
truthy(bigDoodle.length > 600 && bigDoodle.length <= RELAY.doodleChars, 'test doodle is near the budget');
const doodleCfg = buildStartConfig({ chainType: 'doodle-then-title', totalSteps: 2, deck, checkinQs: [], seed: 7 });
const manyApproved = Array.from({ length: 14 }, (_, i) => ({
  name: `N${i}`, payload: { rr: 1, author: `ply-${i}`, prompt: 0, frag: { t: 'doodle', d: bigDoodle } },
}));
const doodleRes = computeStartResults({ config: doodleCfg, approved: manyApproved, checkinTallies: [] });
is(doodleRes.chains.length, 14, 'fourteen doodle fragments all become chains');
const players14 = Array.from({ length: 14 }, (_, i) => ({ id: `ply-${i}`, name: `N${i}`, away: false }));
const bigPlan = buildContinuePlan({ prior: doodleRes, players: players14, seed: 5 });
truthy(bigPlan, 'a plan builds from a doodle-heavy round');
is(JSON.stringify(bigPlan).length <= 8192, true, 'the routing plan respects the 8 KB config cap');
is(bigPlan.chains.length + bigPlan.parked.length + bigPlan.dropped, 14,
  'every fragment is planned, parked, or counted as dropped — none vanish silently');
is(new Set(bigPlan.chains.map((c) => c.slot)).size, bigPlan.chains.length, 'rotation slots are distinct');
truthy(bigPlan.chains.length >= 4, 'a healthy number of doodle chains still fit the budget');

const nearMax = (() => {
  let best = '';
  for (let ns = 1; ns <= RELAY.doodleStrokes; ns++) {
    const d = encodeDoodle(Array.from({ length: ns }, (_, i) => ({
      c: i % RELAY.colors, w: i % 2, pts: Array.from({ length: 13 }, (_, j) => [j * 4 % 64, (i + j) % 64]),
    })));
    if (d.length <= RELAY.doodleChars && d.length > best.length) best = d;
  }
  return best;
})();
const hugeRoom = computeStartResults({
  config: doodleCfg,
  approved: Array.from({ length: 40 }, (_, i) => ({
    name: `LongishName${i}`, payload: { rr: 1, author: `ply-big-${i}`, prompt: 0, frag: { t: 'doodle', d: nearMax } },
  })),
  checkinTallies: [],
});
is(JSON.stringify(hugeRoom).length <= 32768, true,
  'a 40-doodle room stays under the backend\'s 32 KB results cap');
truthy(hugeRoom.dropped > 0 && hugeRoom.chains.length + hugeRoom.dropped === 40,
  'over-budget fragments are counted as dropped, never silently lost');
is(decodeDoodle(encodeDoodle([{ c: 0, w: 1, pts: [[5, 5], [5, 5]] }])).length, 1,
  'a tap-dot stroke (duplicated point) survives the codec');

is(buildContinuePlan({ prior: doodleRes, players: [], seed: 5 }), null, 'no plan without players');
is(buildContinuePlan({ prior: { ...startRes, stage: 'done' }, players: players14, seed: 5 }), null, 'a finished relay does not re-plan');

/* ---- assembly, partial chains, beats ----------------------------------- */
const contPayload = (author, chainId, s) => ({ rr: 1, author, chain: chainId, frag: frag(s) });
is(cleanContinuePayload(contPayload('ply-2', 'ch-0', 'and then it rained'), plan).chainId, 'ch-0', 'a good continue payload passes');
is(cleanContinuePayload(contPayload('ply-2', 'ch-nope', 'x'), plan), null, 'an unknown chain id is rejected');
is(cleanContinuePayload({ note: 'demo' }, plan), null, 'junk continue payloads are rejected');

const contRes = computeContinueResults({
  config: { ...plan, parked: [{ id: 'ch-parked', seq: ['headline', 'nextline'], prompt: 'p', hist: [{ by: 'Dot', authorId: 'ply-4', frag: frag('parked headline') }] }] },
  approved: [
    { name: 'Ben', payload: contPayload('ply-2', 'ch-0', 'and then it rained') },
    { name: 'Cleo', payload: contPayload('ply-3', 'ch-0', 'a second answer, too late') },
  ],
});
is(contRes.stage, 'done', 'the final leg assembles to done');
is(contRes.chains[0].done, true, 'an answered chain is finished');
is(contRes.chains[0].steps[1].by, 'Ben', 'the FIRST approved answer per chain wins');
is(contRes.chains[1].done, false, 'an unanswered chain stays gracefully unfinished');
is(contRes.chains[3].done, false, 'a parked chain rides along as unfinished');
is(contRes.finished, 1, 'finished count is right');

const bl = beatList(contRes);
is(bl[0].k, 'intro', 'reveal opens on the title card');
is(bl[bl.length - 1].k, 'outro', 'reveal closes on the outro');
truthy(bl.some((b) => b.k === 'flop'), 'unfinished chains earn their own punchline beat');
truthy(beatCount(contRes) <= 41, 'beats stay inside party-core\'s reveal-step cap');
for (let s = 0; s < beatCount(contRes); s++) {
  const n = narratedBeat(s, contRes);
  if (!n.title || !n.lines.length || n.lines.some((l) => typeof l !== 'string' || !l)) {
    failures += 1; console.error(`✗ narrated beat ${s} is not speakable`);
  }
}
console.log('✓ every beat narrates with a title and speakable lines');
truthy(JSON.stringify(narratedBeat(0, startRes)).includes('shuffled'), 'teaser beat narrates the shuffle');

const midPlan = { ...plan, leg: 1, totalSteps: 3 };
is(computeContinueResults({ config: midPlan, approved: [] }).stage, 'mid', 'a 3-step relay pauses at mid after leg 1');

/* ---- BOTH GATES, through the real party-core state machine -------------- */
const Q = [{ id: 'rk-001', text: 'Your creemee order:', options: ['Maple', 'Twist'] }];
let db = createDb(7);
let r = create_event(db, { hostKey: 'host-key-12345', questions: Q, title: 'Gate test' }, 1000);
db = r.db;
const evt = r.result.eventId;
const code = r.result.code;
const pids = {};
for (const [tok, name] of [['tok-ada-0001', 'Ada'], ['tok-ben-0001', 'Ben'], ['tok-cleo-001', 'Cleo'], ['tok-dot-0001', 'Dot']]) {
  r = join(db, { code, name, token: tok }, 1001);
  db = r.db;
  pids[name] = r.result.playerId;
  db = checkin(db, { eventId: evt, token: tok, answers: { 'rk-001': name === 'Ben' ? 1 : 0 } }, 1002).db;
}
r = open_round(db, { eventId: evt, hostKey: 'host-key-12345', mode: SLUG, config: startCfg }, 1010);
db = r.db;
const roundA = r.result.roundId;
const subA = (tok, author, s, t) => {
  const x = submit(db, { eventId: evt, token: tok, roundId: roundA, payload: startPayload(author, s) }, t);
  db = x.db;
};
subA('tok-ada-0001', pids.Ada, 'BREAKING: geese unionize', 1011);
subA('tok-ben-0001', pids.Ben, 'Church Street declared a lake', 1012);
subA('tok-cleo-001', pids.Cleo, 'REJECTED-LINE: never route me', 1013);
subA('tok-dot-0001', pids.Dot, 'PENDING-LINE: never route me either', 1014);
db = close_round(db, { eventId: evt, hostKey: 'host-key-12345' }, 1020).db;
let snap = host_get(db, { eventId: evt, hostKey: 'host-key-12345' }, 1021).result;
const sid = (name) => snap.round.submissions.find((s) => s.name === name).id;
db = moderate(db, { eventId: evt, hostKey: 'host-key-12345', submissionId: sid('Ada'), status: 'approved' }, 1022).db;
db = moderate(db, { eventId: evt, hostKey: 'host-key-12345', submissionId: sid('Ben'), status: 'approved' }, 1023).db;
db = moderate(db, { eventId: evt, hostKey: 'host-key-12345', submissionId: sid('Cleo'), status: 'rejected' }, 1024).db;
// Dot's stays pending — the reveal must slam that door itself.
snap = host_get(db, { eventId: evt, hostKey: 'host-key-12345' }, 1025).result;
const approvedA = snap.round.submissions.filter((s) => s.status === 'approved')
  .map((s) => ({ name: s.name, payload: s.payload }));
const resultsA = computeStartResults({ config: snap.round.config, approved: approvedA, checkinTallies: snap.checkinTallies });
db = start_reveal(db, { eventId: evt, hostKey: 'host-key-12345', roundId: roundA, results: resultsA }, 1030).db;
snap = host_get(db, { eventId: evt, hostKey: 'host-key-12345' }, 1031).result;
is(snap.round.submissions.find((s) => s.name === 'Dot').status, 'rejected',
  'GATE 1: party-core auto-rejects still-pending fragments the moment the teaser fires');
const resultsJson = JSON.stringify(resultsA);
is(resultsJson.includes('REJECTED-LINE') || resultsJson.includes('PENDING-LINE'), false,
  'GATE 1: unapproved fragments never become chains');
db = end_round(db, { eventId: evt, hostKey: 'host-key-12345' }, 1032).db;

snap = host_get(db, { eventId: evt, hostKey: 'host-key-12345' }, 1033).result;
const prior = snap.doneResults.find((d) => d.results?.rr)?.results;
truthy(prior, 'the teaser reveal parks approved fragments in doneResults for the next leg');
const planB = buildContinuePlan({ prior, players: snap.players, seed: 11 });
planB.openedAtS = 2000;
is(JSON.stringify(planB).includes('REJECTED-LINE'), false, 'GATE 1: the routing plan carries approved fragments only');
for (const p of snap.players) {
  const a = assignmentFor(planB, p.id, 0);
  if (a && a.hist.some((h) => h.authorId === p.id)) {
    failures += 1; console.error(`✗ ${p.name} was routed their own fragment`);
  }
}
console.log('✓ live roster routing: nobody is handed their own fragment');
r = open_round(db, { eventId: evt, hostKey: 'host-key-12345', mode: SLUG, config: planB }, 2000);
db = r.db;
const roundB = r.result.roundId;
const adaChain = assignmentFor(planB, pids.Ada, 0);
db = submit(db, {
  eventId: evt, token: 'tok-ada-0001', roundId: roundB,
  payload: contPayload(pids.Ada, adaChain.id, 'and the lake said no'),
}, 2010).db;
db = submit(db, {
  eventId: evt, token: 'tok-ben-0001', roundId: roundB,
  payload: contPayload(pids.Ben, assignmentFor(planB, pids.Ben, 0)?.id ?? planB.chains[0].id, 'UNAPPROVED-ANSWER: hold me'),
}, 2011).db;
db = close_round(db, { eventId: evt, hostKey: 'host-key-12345' }, 2020).db;
snap = host_get(db, { eventId: evt, hostKey: 'host-key-12345' }, 2021).result;
db = moderate(db, {
  eventId: evt, hostKey: 'host-key-12345',
  submissionId: snap.round.submissions.find((s) => s.name === 'Ada').id, status: 'approved',
}, 2022).db;
snap = host_get(db, { eventId: evt, hostKey: 'host-key-12345' }, 2023).result;
const approvedB = snap.round.submissions.filter((s) => s.status === 'approved')
  .map((s) => ({ name: s.name, payload: s.payload }));
const resultsB = computeContinueResults({ config: snap.round.config, approved: approvedB });
db = start_reveal(db, { eventId: evt, hostKey: 'host-key-12345', roundId: roundB, results: resultsB }, 2030).db;
is(JSON.stringify(resultsB).includes('UNAPPROVED-ANSWER'), false,
  'GATE 2: an unapproved chain step can never reach the reveal');
truthy(resultsB.chains.find((c) => c.id === adaChain.id)?.done, 'the approved chain assembled and finished');
is(resultsB.stage, 'done', 'two-step relay completes in two rounds');

/* ---- determinism over a fixed event list -------------------------------- */
const script = [
  { t: 'tick', nowS: 1010 },
  { t: 'submit', playerId: 'ply-2', name: 'Ben', payload: contPayload('ply-2', 'ch-0', 'first answer') },
  { t: 'tick', nowS: 1200 }, // over the expiry boundary → epoch 1
  { t: 'join', playerId: 'ply-late-7' },
  { t: 'submit', playerId: 'ply-3', name: 'Cleo', payload: contPayload('ply-3', 'ch-1', 'late answer') },
  { t: 'approve', playerId: 'ply-2' },
  { t: 'reject', playerId: 'ply-3' },
];
const run1 = replay(plan, script);
const run2 = replay(plan, script);
is(JSON.stringify(run1.results), JSON.stringify(run2.results), 'same event list → identical results, every time');
is(JSON.stringify(run1.assignments), JSON.stringify(run2.assignments), 'same event list → identical assignments');
is(run1.epoch, 1, 'ticks in the event list drive the routing epoch');
truthy(run1.assignmentFor('ply-late-7'), 'a joined-late player has an assignment in the replay too');
is(JSON.stringify(run1.results).includes('late answer'), false, 'rejected events stay out of results in the replay');
is(JSON.stringify(run1.results).includes('first answer'), true, 'approved events land in results in the replay');

/* ---- odds and ends ------------------------------------------------------ */
is(det('stable', 10), det('stable', 10), 'hash is stable');
is(cleanText('a\u0000b\u001fc'), 'a b c', 'control characters are stripped');
is(SEQS['doodle-then-title'][0], 'doodle', 'doodle-first sequence starts with a doodle');
truthy(seedChains(startCfg, tallies, 2).length <= 2, 'seedChains honors its count');

if (failures > 0) {
  console.error(`\n${failures} room-relay test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Room Relay tests passed.');

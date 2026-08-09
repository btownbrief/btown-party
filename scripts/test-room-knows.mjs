// Tests for modes/room-knows/logic.js — plain Node, no framework:
//   node scripts/test-room-knows.mjs
// Aggregation math, scoring (including every tie), the closest-reader
// call-out, the empty-room round, scoreboard accumulation, and the shipped
// question deck's schema + voice constraints.
import { readFileSync } from 'node:fs';
import {
  SLUG, SCORING, cleanGuess, computeResults, scoreboard,
  BEATS, beatCount, narratedBeat, validateDeck,
} from '../modes/room-knows/logic.js';

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

const Q = { id: 'rk-001', text: 'Your creemee order:', options: ['Maple', 'Twist', 'Black raspberry'] };
const config = { question: Q };
const guess = (name, pick, pct) => ({ name, payload: { pick, pct } });

// ---- cleanGuess --------------------------------------------------------
is(cleanGuess({ pick: 1, pct: 55 }, 3), { pick: 1, pct: 55 }, 'a clean guess passes through');
is(cleanGuess({ pick: 1, pct: 155 }, 3), { pick: 1, pct: 100 }, 'percent clamps to 100');
is(cleanGuess({ pick: 1, pct: -5 }, 3), { pick: 1, pct: 0 }, 'percent clamps to 0');
is(cleanGuess({ pick: 1, pct: 54.6 }, 3), { pick: 1, pct: 55 }, 'percent rounds to a whole number');
is(cleanGuess({ pick: 3, pct: 50 }, 3), null, 'an out-of-range pick is dropped');
is(cleanGuess({ pick: 'a', pct: 50 }, 3), null, 'a non-integer pick is dropped');
is(cleanGuess({ pick: 0, pct: NaN }, 3), null, 'a NaN percent is dropped');
is(cleanGuess(null, 3), null, 'a null payload is dropped');

// ---- the aggregation ---------------------------------------------------
// Room of 10: Maple 6, Twist 3, Black raspberry 1 → 60% / 30% / 10%.
const tally10 = { counts: [6, 3, 1], total: 10 };
const r1 = computeResults({
  config, tally: tally10,
  approved: [
    guess('Sam', 0, 60),   // right option, exact percent → 100 + 100
    guess('Lena', 0, 45),  // right option, 15 off → 100 + 85
    guess('Ray', 1, 30),   // wrong option, exact on ITS percent → 0 + 100
    guess('June', 2, 90),  // wrong option, 80 off → 0 + 20
  ],
});
is(r1.mode, SLUG, 'results carry the mode slug');
is(r1.percents, [60, 30, 10], 'tally percents are right');
is(r1.winners, [0], 'the top option wins');
is(r1.emptyRoom, false, 'a room of 10 is not empty');
is(r1.guesses.map((g) => g.score), [200, 185, 100, 20],
  'scores: winner pick is worth 100, closeness up to 100 more — even on a losing pick');
is(r1.guesses.map((g) => g.pickedWinner), [true, true, false, false], 'winner picks are flagged');
is(r1.closest, ['Sam', 'Ray'], 'closest reader: an exact call on ANY option ties at zero error');

// ---- percentage-closeness tie on the winning option --------------------
const r2 = computeResults({
  config, tally: tally10,
  approved: [guess('A', 0, 55), guess('B', 0, 65), guess('C', 1, 10)],
});
is(r2.guesses.map((g) => g.score), [195, 195, 80], 'symmetric misses score the same');
is(r2.closest, ['A', 'B'], 'a closeness tie calls out both readers');

// ---- cross-option closeness tie (the float trap) -----------------------
// Room of 3 splits 1/2: option 0 is really 33.33…%, option 1 is 66.66…%.
// A 40% guess on option 0 and a 60% guess on option 1 are BOTH exactly
// 6⅔ points off — float division would break this tie by a rounding hair,
// so errors are compared in integer space (|pct·total − count·100|).
const rCross = computeResults({
  config, tally: { counts: [1, 2, 0], total: 3 },
  approved: [guess('Lo', 0, 40), guess('Hi', 1, 60)],
});
is(rCross.closest, ['Lo', 'Hi'], 'equal misses on different options tie for closest reader');
is(rCross.guesses[0].score + 100, rCross.guesses[1].score,
  'the winner pick is still worth exactly the 100-point bonus');

// ---- winning-option tie ------------------------------------------------
const rTie = computeResults({
  config, tally: { counts: [5, 5, 0], total: 10 },
  approved: [guess('A', 0, 50), guess('B', 1, 50), guess('C', 2, 0)],
});
is(rTie.winners, [0, 1], 'a dead-heat tally has two winning options');
is(rTie.guesses.map((g) => g.score), [200, 200, 100],
  'picking either tied winner earns the winner points');

// ---- the empty room (nobody answered this question at check-in) --------
const rEmpty = computeResults({
  config, tally: { counts: [0, 0, 0], total: 0 },
  approved: [guess('A', 0, 50)],
});
is(rEmpty.emptyRoom, true, 'zero check-ins → empty-room round');
is(rEmpty.winners, [], 'an empty room crowns no option');
is(rEmpty.guesses[0].score, 0, 'an empty room hands out no points');
is(rEmpty.closest, [], 'an empty room calls out nobody');
is(narratedBeat(3, rEmpty, []).lines[0].includes('free round'), true,
  'the narrated view has a graceful line for the empty room');

// ---- no approved guesses (everyone watched — still a fine round) -------
const rQuiet = computeResults({ config, tally: tally10, approved: [] });
is(rQuiet.guesses, [], 'a round with zero guesses computes cleanly');
is(rQuiet.closest, [], 'nobody is called out when nobody guessed');
is(rQuiet.winners, [0], 'the room\'s answer still gets revealed');

// ---- malformed approved payloads sit out, not crash --------------------
const rBad = computeResults({
  config, tally: tally10,
  approved: [guess('OK', 0, 50), { name: 'Broken', payload: { pick: 99, pct: 50 } }, { name: 'Null', payload: null }],
});
is(rBad.guesses.length, 1, 'malformed payloads are dropped, the round goes on');

// ---- moderation is upstream, but verify the contract shape -------------
// computeResults takes ONLY what it is given; the shell hands it approved
// submissions and the backend rejects pendings at reveal. Nothing here can
// resurrect an unapproved entry:
is(JSON.stringify(r1).includes('pending'), false, 'results never mention unapproved entries');

// ---- rounding stays honest at awkward splits ---------------------------
const rThirds = computeResults({
  config, tally: { counts: [1, 1, 1], total: 3 },
  approved: [guess('A', 0, 33)],
});
is(rThirds.percents, [33, 33, 33], 'thirds display as 33 / 33 / 33');
is(rThirds.guesses[0].score > 195, true, 'a 33 guess on a third is within a point (scored on exact math)');

// ---- scoreboard accumulation across rounds -----------------------------
const board = scoreboard([r1, r2, { mode: 'other-mode', guesses: [{ name: 'X', score: 999 }] }]);
is(board.find((b) => b.name === 'A').points, 195, 'the board sums per name');
is(board.find((b) => b.name === 'Sam').points, 200, 'one-round players stay on the board');
is(board.find((b) => b.name === 'X'), undefined, 'other modes\' results are ignored');
is(board[0].points >= board[board.length - 1].points, true, 'the board sorts best reader first');
{
  const twice = scoreboard([r1, r1]);
  is(twice.find((b) => b.name === 'Sam').points, 400, 'points accumulate round over round');
  is(twice.find((b) => b.name === 'Sam').rounds, 2, 'round counts accumulate too');
}
is(scoreboard([]), [], 'an empty night is an empty board');

// ---- skipped rounds: a name absent from a round just misses points -----
const rSkip = computeResults({ config, tally: tally10, approved: [guess('Sam', 0, 60)] });
const skipBoard = scoreboard([r1, rSkip]);
is(skipBoard.find((b) => b.name === 'Lena').rounds, 1, 'skipping a round costs nothing but that round');

// ---- the beats ---------------------------------------------------------
is(BEATS, ['question', 'options', 'drumroll', 'bars', 'readers', 'scoreboard'],
  'the reveal is six beats, in order');
is(beatCount(), 6, 'beatCount matches');
for (let i = 0; i < beatCount(); i++) {
  const b = narratedBeat(i, r1, board);
  if (typeof b.title !== 'string' || !Array.isArray(b.lines) || !b.lines.length) {
    failures += 1;
    console.error(`✗ narrated beat ${i} is not readable aloud: ${JSON.stringify(b)}`);
  }
}
console.log('✓ every beat produces narratable lines');
is(narratedBeat(99, r1, board).kind, 'scoreboard', 'an over-long step clamps to the last beat');
is(narratedBeat(4, r1, board).lines[0], 'Sam and Ray', 'the readers beat names the closest readers');

// ---- the shipped deck --------------------------------------------------
const deck = JSON.parse(readFileSync(new URL('../content/roomknows-questions.json', import.meta.url), 'utf8'));
is(validateDeck(deck), [], 'the shipped deck passes schema validation');
is(deck.questions.length >= 12, true, 'the starter deck has at least 12 questions');
{
  // voice constraints that are checkable: no stage-direction barks, no
  // truth-policing adverbs (QUESTIONS.md rules 3 and 4)
  const barks = /\b(be honest|admit it|defend it|prove it|go\.|honestly|genuinely)\b/i;
  const offenders = deck.questions.filter((q) => barks.test(q.text));
  is(offenders.map((q) => q.id), [], 'no question barks at the player');
}
is(validateDeck({ version: 1, questions: [{ id: 'bad', text: 'x', options: ['a'], tags: [] }] }).length > 0,
  true, 'a malformed deck is called out');

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Room Knows tests passed.');

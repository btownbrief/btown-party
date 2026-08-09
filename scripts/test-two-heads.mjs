// Tests for modes/two-heads/logic.js — plain Node, no framework:
//   node scripts/test-two-heads.mjs
// Team formation (consensual only — the pool pairs nobody who didn't opt
// in), one-submission-per-team, bracket seeding at awkward counts (byes),
// tie-break determinism under a fixed seed, ballot counting including
// spectators, moderation gating via the real party-core pipeline, empty
// and walkover rounds, narrated beats, and the shipped prompt deck.
import { readFileSync } from 'node:fs';
import {
  SLUG, RULES, TEAM_CODE_ALPHABET, TEAM_CODE_LEN,
  makeTeamCode, cleanAnswer, cleanTeamCode, cleanTeamName, wordCount,
  initFormation, formationAct, parseAnswer, parseBallot, entriesFrom,
  seedBracket, deriveBracket, applyMatch, matchLabel, firstRoundLines,
  writeConfig, voteRoundConfig, computeResults, hostNext,
  beatKinds, beatCount, narratedBeat, validateDeck,
} from '../modes/two-heads/logic.js';
import { createDb, OPS } from '../js/party-core.js';

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
function throwsCode(fn, code, label) {
  try {
    fn();
    failures += 1;
    console.error(`✗ ${label} — expected throw ${code}, nothing thrown`);
  } catch (e) {
    is(e.code ?? e.message, code, label);
  }
}

/* ---- team codes --------------------------------------------------------- */
is(makeTeamCode(42), makeTeamCode(42), 'team codes are deterministic per seed');
is(makeTeamCode(42).length, TEAM_CODE_LEN, 'team codes are 4 characters');
is([...makeTeamCode(7)].every((c) => TEAM_CODE_ALPHABET.includes(c)), true,
  'team codes use the no-lookalikes alphabet');
is(makeTeamCode(1) === makeTeamCode(2), false, 'different seeds make different codes');
is(cleanTeamCode(' kj3m '), 'KJ3M', 'code entry is case- and space-forgiving');
is(cleanTeamCode('KJ3'), null, 'a short code is rejected');
is(cleanTeamCode('KJ10'), null, 'lookalike characters are rejected');

/* ---- answers ------------------------------------------------------------ */
const fifteen = Array.from({ length: 15 }, (_, i) => `w${i}`).join(' ');
is(cleanAnswer(fifteen), fifteen, 'fifteen words is exactly legal');
is(cleanAnswer(`${fifteen} extra`), null, 'sixteen words is rejected');
is(cleanAnswer('  a   moose   ate\nthe wifi '), 'a moose ate the wifi', 'whitespace collapses');
is(cleanAnswer(''), null, 'an empty answer is rejected');
is(cleanAnswer('x'.repeat(RULES.answerChars + 1)), null, 'an over-long answer is rejected');
is(wordCount(' one  two three '), 3, 'word counting survives messy spacing');
is(cleanTeamName('  The  Sap  Tappers  ', 'AAAA'), 'The Sap Tappers', 'team names collapse whitespace');
is(cleanTeamName('', 'KJ3M'), 'TEAM KJ3M', 'a blank team name falls back to the code');

/* ---- formation: every pairing is consensual ----------------------------- */
{
  let f = initFormation();
  const r1 = formationAct(f, { type: 'start', player: 'ada', seed: 1 });
  f = r1.state;
  is(f.teams[r1.code].captain, 'ada', 'starting a team makes you captain');
  f = formationAct(f, { type: 'join', player: 'ben', code: r1.code }).state;
  is(f.teams[r1.code].members, ['ada', 'ben'], 'a partner joins by typing the code');
  throwsCode(() => formationAct(f, { type: 'start', player: 'ada', seed: 9 }),
    'already_teamed', 'you cannot start a second team');
  throwsCode(() => formationAct(f, { type: 'enterPool', player: 'ben' }),
    'already_teamed', 'a teamed player cannot enter the pool');

  // The opt-in pool NEVER pairs anyone who didn't enter it.
  f = formationAct(f, { type: 'enterPool', player: 'cleo' }).state;
  is(f.pool, ['cleo'], 'entering the pool is an explicit action');
  throwsCode(() => formationAct(f, { type: 'pairUp', a: 'cleo', b: 'dot', seed: 5 }),
    'not_in_pool', 'the pool never pairs someone who did not enter it');
  throwsCode(() => formationAct(f, { type: 'pairUp', a: 'dot', b: 'eve', seed: 5 }),
    'not_in_pool', 'two non-entrants cannot be paired either');
  throwsCode(() => formationAct(f, { type: 'pairUp', a: 'cleo', b: 'cleo', seed: 5 }),
    'not_in_pool', 'nobody pairs with themselves');
  f = formationAct(f, { type: 'enterPool', player: 'dot' }).state;
  const paired = formationAct(f, { type: 'pairUp', a: 'cleo', b: 'dot', seed: 5 });
  is(paired.state.teams[paired.code].members, ['cleo', 'dot'],
    'two mutual entrants pair into one team');
  is(paired.state.pool, [], 'pairing empties both out of the pool');
  f = formationAct(initFormation(), { type: 'enterPool', player: 'gus' }).state;
  f = formationAct(f, { type: 'leavePool', player: 'gus' }).state;
  is(f.pool, [], 'leaving the pool is one action');
  const solo = formationAct(f, { type: 'start', player: 'gus', seed: 3 });
  is(solo.state.teams[solo.code].members, ['gus'], 'a team of one is a team, no comment made');
}

/* ---- one submission per team -------------------------------------------- */
const ans = (code, name, answer) => ({ name: 'x', payload: { kind: 'answer', team: { code, name }, answer } });
{
  const entries = entriesFrom([
    ans('AAAA', 'First In', 'the early answer'),
    ans('aaaa', 'Second Try', 'the sneaky duplicate'),
    ans('BBBB', 'Other Team', 'a different answer'),
    { name: 'x', payload: { kind: 'join', team: { code: 'AAAA' } } },
    { name: 'x', payload: { note: 'demo' } },
    { name: 'x', payload: null },
  ]);
  is(entries.length, 2, 'one submission per team: duplicates and junk are dropped');
  is(entries[0].answer, 'the early answer', 'the first approved answer for a team stands');
  is(parseBallot({ kind: 'vote', pick: 1 }), 1, 'a ballot parses');
  is(parseBallot({ kind: 'vote', pick: 2 }), null, 'an out-of-range ballot sits out');
  is(parseAnswer({ kind: 'answer', team: { code: 'AAAA' }, answer: `${fifteen} extra` }), null,
    'an over-limit answer sits the round out');
}

/* ---- bracket seeding at awkward counts ----------------------------------- */
const team = (i) => ({ code: `T${String(i).padStart(3, '0')}`, name: `Team ${i}`, answer: `answer ${i}` });
function playItOut(n, seed) {
  const b0 = seedBracket(Array.from({ length: n }, (_, i) => team(i)), seed);
  let b = b0;
  let guard = 0;
  while (deriveBracket(b).pending && guard++ < 20) {
    b = applyMatch(b, 1, 0).bracket; // side A always wins on votes
  }
  return { b0, b, status: deriveBracket(b) };
}
for (const [n, size, byes, r1matches] of [[3, 4, 1, 1], [5, 8, 3, 1], [7, 8, 1, 3]]) {
  const { b0, b, status } = playItOut(n, 99);
  is(b0.size, size, `${n} teams → bracket of ${size}`);
  is(b0.slots.filter((s) => s == null).length, byes, `${n} teams → ${byes} bye(s)`);
  const nullPair = b0.slots.some((_, i) => i % 2 === 0 && b0.slots[i] == null && b0.slots[i + 1] == null);
  is(nullPair, false, `${n} teams → no bye ever meets a bye`);
  is([...b0.slots.filter((s) => s != null)].sort((a, c) => a - c),
    Array.from({ length: n }, (_, i) => i), `${n} teams → everyone is in the field exactly once`);
  is(b.played.filter((m) => m.roundSize === size).length, r1matches,
    `${n} teams → round one has ${r1matches} real face-off(s)`);
  is(b.played.length, n - 1, `${n} teams → ${n - 1} face-offs decide it`);
  is(status.champion != null, true, `${n} teams → a champion emerges`);
}
{
  const b3 = seedBracket([team(0), team(1), team(2)], 7);
  const { pending } = deriveBracket(b3);
  is(pending.matchesInRound, 1, '3 teams: one real match in round one');
  is(matchLabel(pending), 'Semifinals', '3 teams: round one of a 4-bracket is the semifinals');
  is(firstRoundLines(b3).some((l) => l.includes('skips straight')), true,
    'the bye is announced, not hidden');
}

/* ---- determinism under a fixed seed --------------------------------------- */
{
  const a = seedBracket(Array.from({ length: 7 }, (_, i) => team(i)), 1234);
  const b = seedBracket(Array.from({ length: 7 }, (_, i) => team(i)), 1234);
  is(a, b, 'the same seed builds the identical bracket');
  const flip1 = applyMatch(a, 3, 3);
  const flip2 = applyMatch(b, 3, 3);
  is(flip1.played.tiebreak, true, 'a dead heat is flagged as a coin flip');
  is(flip1.played.winner, flip2.played.winner, 'the seeded coin flips the same way every time');
  const zero = applyMatch(a, 0, 0);
  is(zero.played.tiebreak, true, 'a zero-ballot face-off falls to the coin too');
  is(zero.played.winner, flip1.played.winner, 'the flip depends on seed and pairing, not votes');
}

/* ---- vote rounds: counting, spectators, malformed ballots ------------------ */
{
  const entries = [team(0), team(1), team(2)];
  const bracket = seedBracket(entries, 55);
  const cfg = voteRoundConfig(bracket, { id: 'th-001', text: 'A rejected slogan: ___' });
  is(cfg.match.a.code === cfg.match.b.code, false, 'the config carries both sides of the face-off');
  is(cfg.question.text.includes(cfg.match.a.answer) && cfg.question.text.includes(cfg.match.b.answer),
    true, 'the screen line quotes both (already-approved) answers');
  const ballot = (pick) => ({ name: 'x', payload: { kind: 'vote', pick } });
  const r = computeResults({
    config: cfg,
    approved: [ballot(0), ballot(0), ballot(1), ballot(0),
      { name: 'x', payload: { note: 'demo' } }, { name: 'x', payload: { kind: 'vote', pick: 9 } }],
  });
  is([r.votesA, r.votesB], [3, 1], 'ballots count; malformed ballots sit out');
  is(r.votes, 4, 'total ballots are reported');
  is(r.votePercents, [75, 25], 'bar percents are computed in logic, not the UI');
  is(r.winner.code, cfg.match.a.code, 'more votes wins the face-off');
  is(r.tiebreak, false, 'a clear result is not a coin flip');
  is(r.bracket.played.length, 1, 'the advanced bracket rides in the results');
  is(beatKinds(r), ['matchup', 'drumroll', 'winner', 'next'], 'a non-final face-off ends on the next matchup');

  // Play the second semifinal-into-final path via hostNext, like the host console does.
  const step2 = hostNext([{ mode: SLUG, results: r }]);
  is(step2.kind, 'continue', 'hostNext offers the next face-off while the bracket is live');
  const cfg2 = voteRoundConfig(step2.bracket, step2.prompt);
  const r2 = computeResults({ config: cfg2, approved: [ballot(1)] });
  is(r2.champion != null || r2.next != null, true, 'the bracket keeps advancing');
  let done = [{ mode: SLUG, results: r }, { mode: SLUG, results: r2 }];
  let nxt = hostNext(done);
  let guard = 0;
  while (nxt.kind === 'continue' && guard++ < 10) {
    const c = voteRoundConfig(nxt.bracket, nxt.prompt);
    const rr = computeResults({ config: c, approved: [ballot(0)] });
    done = [...done, { mode: SLUG, results: rr }];
    nxt = hostNext(done);
  }
  const finalR = done[done.length - 1].results;
  is(finalR.champion != null, true, 'the final crowns a champion');
  is(beatKinds(finalR).at(-1), 'champion', 'the final round ends on the champion beat');
  is(nxt.kind, 'new', 'after the champion, hostNext goes back to fresh prompts');
  is(nxt.usedPromptIds, ['th-001'], 'played prompts are remembered');
}

/* ---- write rounds: empty, walkover, cap ------------------------------------ */
{
  const prompt = { id: 'th-002', text: 'The least popular flavor: ___' };
  const cfg = writeConfig(prompt);
  is(cfg.question.text, prompt.text, 'the screen shows the prompt while teams write');

  const empty = computeResults({ config: cfg, approved: [] });
  is(empty.entries, [], 'zero approved answers computes cleanly');
  is(empty.bracket, null, 'an empty round seeds no bracket');
  is(beatKinds(empty), ['prompt', 'nobody'], 'the empty round has a graceful reveal');
  is(hostNext([{ mode: SLUG, results: empty }]).kind, 'new', 'an empty round leaves no bracket to continue');

  const one = computeResults({ config: cfg, approved: [ans('AAAA', 'Solo Act', 'just me here')] });
  is(one.walkover.name, 'Solo Act', 'a single team wins by walkover');
  is(beatKinds(one), ['prompt', 'parade', 'walkover'], 'the walkover gets its own beat');

  const four = computeResults({
    config: cfg,
    approved: [ans('AAAA', 'A', 'aa'), ans('BBBB', 'B', 'bb'), ans('CCCC', 'C', 'cc'), ans('DDDD', 'D', 'dd')],
  });
  is(four.bracket.teams.length, 4, 'four teams all enter the bracket');
  is(computeResults({ config: cfg, approved: [ans('AAAA', 'A', 'aa'), ans('BBBB', 'B', 'bb'), ans('CCCC', 'C', 'cc'), ans('DDDD', 'D', 'dd')] }),
    four, 'recomputing the same reveal seeds the same bracket (derived seed)');

  const nine = computeResults({
    config: cfg,
    approved: Array.from({ length: 9 }, (_, i) => ans(`${'ABCDEFGHJ'[i]}ZZZ`, `T${i}`, `a${i}`)),
  });
  is(nine.entries.length, 9, 'every approved team makes the contenders parade');
  is(nine.bracket.teams.length, RULES.bracketCap, 'a big field is cut to the bracket cap by blind draw');
  is(nine.cut, 1, 'the cut is announced in the results');

  // A pathological room (everyone solo, max-length everything) must never
  // overflow the backend's 32 KB results cap and kill the reveal.
  const codes = [];
  for (const a of 'ABCDEFGHJKMN') for (const b of 'ABCDEFGHJKMN') codes.push(`${a}${b}ZZ`);
  const huge = computeResults({
    config: cfg,
    approved: codes.slice(0, 140).map((c, i) => ans(c, 'N'.repeat(RULES.teamNameChars), `${'word '.repeat(14)}${'x'.repeat(60)}${i}`)),
  });
  is(huge.entries.length, RULES.paradeCap, 'the parade caps rather than crash the reveal');
  is(huge.overflow, 40, 'the overflow is announced, not silent');
  is(JSON.stringify(huge).length < 32768, true, 'worst-case results stay under the 32 KB backend cap');
}

/* ---- narrated beats are all readable aloud --------------------------------- */
{
  const cfg = writeConfig({ id: 'th-003', text: 'The real reason: ___' });
  const shapes = [
    computeResults({ config: cfg, approved: [] }),
    computeResults({ config: cfg, approved: [ans('AAAA', 'Solo', 'one liner')] }),
    computeResults({ config: cfg, approved: [ans('AAAA', 'A', 'aa'), ans('BBBB', 'B', 'bb'), ans('CCCC', 'C', 'cc')] }),
  ];
  const withBracket = shapes[2];
  const vc = voteRoundConfig(withBracket.bracket, withBracket.prompt);
  shapes.push(computeResults({ config: vc, approved: [{ name: 'x', payload: { kind: 'vote', pick: 0 } }] }));
  for (const r of shapes) {
    for (let i = 0; i < beatCount(r); i++) {
      const b = narratedBeat(i, r);
      if (typeof b.title !== 'string' || !Array.isArray(b.lines) || !b.lines.length
          || b.lines.some((l) => typeof l !== 'string' || !l.length)) {
        failures += 1;
        console.error(`✗ narrated beat ${i} of a ${r.phase} round is not readable aloud: ${JSON.stringify(b)}`);
      }
    }
  }
  console.log('✓ every beat of every round shape produces narratable lines');
  is(narratedBeat(99, shapes[3]).kind, beatKinds(shapes[3]).at(-1), 'an over-long step clamps to the last beat');
}

/* ---- moderation gating through the real party-core pipeline ---------------- */
// Drive the same state machine the shell and the SQL mirror: only APPROVED
// submissions reach computeResults, pendings are auto-rejected at reveal,
// and a spectator (never on any team) gets a counted ballot.
{
  let db = createDb(1);
  const t = 1000;
  const H = 'host-key-000001';
  const q = [{ id: 'q-1', text: 'warmup', options: ['a', 'b'] }];
  let r = OPS.party_create_event(db, { p_host_key: H, p_questions: q, p_title: 'Test Night' }, t);
  db = r.db;
  const evt = r.result.eventId;
  const code = r.result.code;
  const tok = (n) => `token-${n}-00000000`;
  for (const n of ['ada', 'ben', 'cleo', 'dot', 'eve']) {
    db = OPS.party_join(db, { p_code: code, p_name: n, p_token: tok(n) }, t).db;
  }

  // WRITE ROUND: two teams write, partners send join markers, and one
  // troll answer gets left pending (→ auto-rejected at reveal).
  const wc = writeConfig({ id: 'th-010', text: 'The weirdest curb find: ___' });
  r = OPS.party_open_round(db, { p_event: evt, p_host_key: H, p_mode: SLUG, p_config: wc }, t);
  db = r.db;
  const round1 = r.result.roundId;
  db = OPS.party_submit(db, { p_event: evt, p_token: tok('ada'), p_round: round1,
    p_payload: { kind: 'answer', team: { code: 'AAAA', name: 'Maple Mayhem' }, answer: 'a full canoe' } }, t).db;
  db = OPS.party_submit(db, { p_event: evt, p_token: tok('ben'), p_round: round1,
    p_payload: { kind: 'join', team: { code: 'AAAA' } } }, t).db;
  db = OPS.party_submit(db, { p_event: evt, p_token: tok('cleo'), p_round: round1,
    p_payload: { kind: 'answer', team: { code: 'BBBB', name: 'Stick Season' }, answer: 'the fourth couch this week' } }, t).db;
  db = OPS.party_submit(db, { p_event: evt, p_token: tok('dot'), p_round: round1,
    p_payload: { kind: 'answer', team: { code: 'CCCC', name: 'Trouble' }, answer: 'something unprintable' } }, t).db;
  db = OPS.party_close_round(db, { p_event: evt, p_host_key: H }, t).db;
  let snap = OPS.party_host_get(db, { p_event: evt, p_host_key: H }, t).result;
  for (const s of snap.round.submissions) {
    if (s.name !== 'dot') { // the host approves everything except the troll
      db = OPS.party_moderate(db, { p_event: evt, p_host_key: H, p_submission: s.id, p_status: 'approved' }, t).db;
    }
  }
  snap = OPS.party_host_get(db, { p_event: evt, p_host_key: H }, t).result;
  const approved1 = snap.round.submissions.filter((s) => s.status === 'approved')
    .map((s) => ({ name: s.name, payload: s.payload }));
  const writeResults = computeResults({ config: snap.round.config, approved: approved1 });
  is(writeResults.entries.map((e) => e.name), ['Maple Mayhem', 'Stick Season'],
    'moderation gate: the unapproved answer never reaches the results');
  is(JSON.stringify(writeResults).includes('unprintable'), false,
    'the rejected text appears nowhere in the reveal');
  db = OPS.party_start_reveal(db, { p_event: evt, p_host_key: H, p_round: round1, p_results: writeResults }, t).db;
  snap = OPS.party_host_get(db, { p_event: evt, p_host_key: H }, t).result;
  is(snap.round.submissions.find((s) => s.name === 'dot').status, 'rejected',
    'the backend auto-rejects pendings the moment the reveal starts');
  db = OPS.party_end_round(db, { p_event: evt, p_host_key: H }, t).db;

  // VOTE ROUND (the final, 2 teams): everyone votes — including eve, who
  // never joined a team. Spectator ballots count like anyone else's.
  snap = OPS.party_host_get(db, { p_event: evt, p_host_key: H }, t).result;
  const nxt = hostNext(snap.doneResults);
  is(nxt.kind, 'continue', 'after the write reveal the host console offers the face-off');
  const vc = voteRoundConfig(nxt.bracket, nxt.prompt);
  r = OPS.party_open_round(db, { p_event: evt, p_host_key: H, p_mode: SLUG, p_config: vc }, t);
  db = r.db;
  const round2 = r.result.roundId;
  const votes = { ada: 0, ben: 0, cleo: 1, dot: 1, eve: 0 };
  for (const [n, pick] of Object.entries(votes)) {
    db = OPS.party_submit(db, { p_event: evt, p_token: tok(n), p_round: round2,
      p_payload: { kind: 'vote', pick } }, t).db;
  }
  db = OPS.party_close_round(db, { p_event: evt, p_host_key: H }, t).db;
  db = OPS.party_moderate_all(db, { p_event: evt, p_host_key: H, p_round: round2, p_status: 'approved' }, t).db;
  snap = OPS.party_host_get(db, { p_event: evt, p_host_key: H }, t).result;
  const approved2 = snap.round.submissions.filter((s) => s.status === 'approved')
    .map((s) => ({ name: s.name, payload: s.payload }));
  is(approved2.length, 5, 'all five ballots (including the spectator) clear moderation');
  const voteResults = computeResults({ config: snap.round.config, approved: approved2 });
  is(voteResults.votesA + voteResults.votesB, 5, 'the spectator ballot is counted with the rest');
  is(voteResults.votesA, 3, 'the tally is 3–2');
  is(voteResults.champion != null, true, 'a two-team bracket crowns its champion in one face-off');
  is(voteResults.champion.name, voteResults.winner.name, 'the face-off winner is the champion');
}

/* ---- the shipped deck -------------------------------------------------------- */
const deck = JSON.parse(readFileSync(new URL('../modes/two-heads/content/twoheads-prompts.json', import.meta.url), 'utf8'));
is(validateDeck(deck), [], 'the shipped prompt deck passes schema validation');
is(deck.prompts.length >= 8, true, 'the deck has at least 8 prompts');
is(validateDeck({ version: 1, prompts: [{ id: 'bad', prompt: 'no blank', tags: [] }] }).length > 0,
  true, 'a malformed deck is called out');

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Two Heads tests passed.');

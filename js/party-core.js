// BTOWN PARTY — the pure event state machine.
//
// This module is the party's rulebook: events, check-in, rounds, submissions,
// approve-to-reveal moderation, and the host-paced reveal, all as pure
// functions over one plain JSON-serializable `db` object. No DOM, no network,
// no clocks, no randomness of its own — `now` (unix seconds) comes in as an
// argument and code letters come from a tiny seeded generator stored inside
// the db, so every run is replayable.
//
// Three consumers drive it:
//   - js/demo.js          (?demo=1 — a fake event in localStorage)
//   - scripts/party-shim.mjs (local HTTP stand-in for the Supabase backend)
//   - scripts/test-party.mjs (plain Node tests)
//
// In live mode the real referee is supabase/party-SETUP.sql — this file
// mirrors those RPCs one-for-one (same names, same error codes). If the
// lifecycle changes, change the SQL AND this file AND the tests together.
//
// THE DOCTRINE RULE THAT LIVES HERE: nothing an attendee typed ever reaches
// the screen face until the host approves it. Submissions are born
// 'pending'; `screen_get` and reveal results only ever see 'approved'.

export const LIMITS = {
  nameLen: 24,
  questionTextLen: 200,
  optionLen: 60,
  optionsMin: 2,
  optionsMax: 6,
  questionsMax: 8,
  payloadBytes: 2048,      // one phone submission
  resultsBytes: 32768,     // one round's computed reveal
  playersPerEvent: 200,
  roundsPerEvent: 50,
  eventsTotal: 500,        // global budget, same spirit as the rooms cap
  eventTtlS: 24 * 3600,    // events self-expire within a day
};

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const ROUND_STATUSES = ['collecting', 'moderating', 'revealing', 'done'];
export const SUBMISSION_STATUSES = ['pending', 'approved', 'rejected', 'held'];

export class PartyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PartyError';
    this.code = code;
    this.detail = detail;
  }
}
const fail = (code, detail) => { throw new PartyError(code, detail); };

export function createDb(seed = 1) {
  return { events: {}, seq: 0, seed: seed >>> 0 };
}

/* ------------------------------------------------------------- utilities */

// The db is treated as immutable: every op returns { db, result } with fresh
// objects along the changed path. structuredClone keeps that honest without
// hand-written spreads on a nested shape this size.
const clone = (db) => structuredClone(db);

const jsonBytes = (v) => JSON.stringify(v).length;

export function cleanName(name) {
    const v = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
    .slice(0, LIMITS.nameLen);
  return v;
}

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

export function isValidCode(code) {
  const c = normalizeCode(code);
  return c.length === 4 && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

// Park–Miller LCG over db.seed — deterministic codes for tests, seeded from
// the clock at the demo/shim edges.
function nextRand(db) {
  const seed = (db.seed * 48271) % 2147483647 || 1;
  return { seed, value: seed / 2147483647 };
}

function makeCode(db) {
  let d = db;
  let code = '';
  for (let i = 0; i < 4; i++) {
    const { seed, value } = nextRand(d);
    d = { ...d, seed };
    code += CODE_ALPHABET[Math.floor(value * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return { db: d, code };
}

export function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > LIMITS.questionsMax) {
    fail('bad_questions');
  }
  const seen = new Set();
  for (const q of questions) {
    if (!q || typeof q !== 'object') fail('bad_questions');
    const id = String(q.id ?? '');
    const text = String(q.text ?? '').trim();
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) fail('bad_questions');
    seen.add(id);
    if (!text || text.length > LIMITS.questionTextLen) fail('bad_questions');
    if (!Array.isArray(q.options) || q.options.length < LIMITS.optionsMin
        || q.options.length > LIMITS.optionsMax) fail('bad_questions');
    for (const o of q.options) {
      const t = String(o ?? '').trim();
      if (!t || t.length > LIMITS.optionLen) fail('bad_questions');
    }
  }
}

const findByCode = (db, code) =>
  Object.values(db.events).find((e) => e.code === normalizeCode(code));

function getEvent(db, eventId) {
  const e = db.events[eventId];
  if (!e) fail('not_found');
  return e;
}

function requireHost(e, hostKey) {
  // The pure core stores the key verbatim; the SQL stores only a sha256 hash.
  if (!hostKey || e.hostKey !== hostKey) fail('not_host');
}

function requirePlayer(e, token) {
  const p = Object.values(e.players).find((x) => x.token === token);
  if (!p) fail('not_joined');
  return p;
}

const currentRound = (e) =>
  e.rounds.length && e.rounds[e.rounds.length - 1].status !== 'done'
    ? e.rounds[e.rounds.length - 1] : null;

/** Anonymous per-option counts for one check-in question. Only aggregates
 *  ever leave this function — no answer is attributable to a name. */
export function checkinTally(event, questionId) {
  const q = event.questions.find((x) => x.id === questionId);
  if (!q) return null;
  const counts = q.options.map(() => 0);
  let total = 0;
  for (const p of Object.values(event.players)) {
    const a = p.checkin?.[questionId];
    if (Number.isInteger(a) && a >= 0 && a < counts.length) {
      counts[a] += 1;
      total += 1;
    }
  }
  return { questionId, counts, total };
}

/* ------------------------------------------------------------------- ops */
// Every op: (db, args, now) → { db, result }. Throws PartyError on refusal.

function sweep(db, now) {
  const d = { ...db, events: { ...db.events } };
  for (const [id, e] of Object.entries(d.events)) {
    if (now - e.createdAt > LIMITS.eventTtlS) delete d.events[id];
  }
  return d;
}

export function create_event(db, { hostKey, questions, title }, now) {
  if (typeof hostKey !== 'string' || hostKey.length < 8 || hostKey.length > 64) {
    fail('bad_identity');
  }
  validateQuestions(questions);
  if (jsonBytes(questions) > 8192) fail('questions_too_big');
  let d = sweep(clone(db), now);
  if (Object.keys(d.events).length >= LIMITS.eventsTotal) fail('party_over_capacity');
  // One live event per host key: opening tonight's event closes last week's.
  for (const e of Object.values(d.events)) {
    if (e.hostKey === hostKey && e.status === 'open') e.status = 'closed';
  }
  const made = makeCode(d);
  d = made.db;
  if (findByCode(d, made.code)) fail('no_codes_left'); // vanishing odds; SQL retries
  const id = `evt-${++d.seq}`;
  d.events[id] = {
    id,
    code: made.code,
    hostKey,
    title: String(title ?? '').trim().slice(0, 80),
    questions: structuredClone(questions),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    players: {},
    rounds: [],
  };
  return { db: d, result: { eventId: id, code: made.code } };
}

export function join(db, { code, name, token }, now) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 64) {
    fail('bad_identity');
  }
  if (!isValidCode(code)) fail('bad_code');
  let d = sweep(clone(db), now);
  const e = findByCode(d, code);
  if (!e) fail('not_found');
  if (e.status !== 'open') fail('event_closed');
  const existing = Object.values(e.players).find((p) => p.token === token);
  if (existing) {
    // Rejoining (page refresh, new name attempt) never burns a second chair.
    const newName = cleanName(name);
    if (newName) existing.name = newName;
    existing.lastSeen = now;
    return { db: d, result: joinResult(e, existing) };
  }
  const clean = cleanName(name);
  if (!clean) fail('bad_name');
  if (Object.keys(e.players).length >= LIMITS.playersPerEvent) fail('event_full');
  const id = `ply-${++d.seq}`;
  e.players[id] = { id, name: clean, token, checkin: {}, joinedAt: now, lastSeen: now };
  e.updatedAt = now;
  return { db: d, result: joinResult(e, e.players[id]) };
}

const joinResult = (e, p) => ({
  eventId: e.id,
  playerId: p.id,
  name: p.name,
  title: e.title,
  questions: structuredClone(e.questions),
  checkinDone: Object.keys(p.checkin).length > 0,
});

export function checkin(db, { eventId, token, answers }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  if (e.status !== 'open') fail('event_closed');
  const p = requirePlayer(e, token);
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) fail('bad_answers');
  const cleaned = {};
  for (const [qid, v] of Object.entries(answers)) {
    const q = e.questions.find((x) => x.id === qid);
    if (!q) continue; // unknown question ids are dropped, not fatal
    if (!Number.isInteger(v) || v < 0 || v >= q.options.length) fail('bad_answers');
    cleaned[qid] = v;
  }
  // Check-in is porous: answering none, some, or all of the questions is fine.
  p.checkin = { ...p.checkin, ...cleaned };
  p.lastSeen = now;
  e.updatedAt = now;
  return { db: d, result: { ok: true, answered: Object.keys(p.checkin).length } };
}

/** The attendee poll. Deliberately small and deliberately blind: no roster,
 *  no other players' inputs, no results — the reveal belongs to the room. */
export function player_get(db, { eventId, token }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  const p = requirePlayer(e, token);
  if (now - p.lastSeen > 15) p.lastSeen = now;
  const r = currentRound(e);
  return {
    db: d,
    result: {
      status: e.status,
      title: e.title,
      name: p.name,
      checkinDone: Object.keys(p.checkin).length > 0,
      round: r ? {
        id: r.id,
        mode: r.mode,
        status: r.status,
        config: r.status === 'collecting' ? structuredClone(r.config) : null,
        submitted: !!r.submissions[p.id],
      } : null,
    },
  };
}

export function open_round(db, { eventId, hostKey, mode, config }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  if (e.status !== 'open') fail('event_closed');
  if (currentRound(e)) fail('round_in_progress');
  if (e.rounds.length >= LIMITS.roundsPerEvent) fail('too_many_rounds');
  if (!/^[a-z0-9-]{1,40}$/.test(String(mode ?? ''))) fail('bad_mode');
  if (config != null && jsonBytes(config) > 8192) fail('config_too_big');
  const id = `rnd-${++d.seq}`;
  e.rounds.push({
    id, mode, config: structuredClone(config ?? {}),
    status: 'collecting', revealStep: -1, results: null,
    submissions: {}, votes: {}, openedAt: now,
  });
  e.updatedAt = now;
  return { db: d, result: { roundId: id } };
}

export function submit(db, { eventId, token, roundId, payload }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  const p = requirePlayer(e, token);
  const r = currentRound(e);
  if (!r || r.id !== roundId) fail('round_closed');
  if (r.status !== 'collecting') fail('round_closed');
  if (payload == null || jsonBytes(payload) > LIMITS.payloadBytes) fail('bad_payload');
  // Re-submitting replaces your own entry — and goes back to 'pending':
  // edits never sneak past moderation on the back of an earlier approval.
  r.submissions[p.id] = {
    id: r.submissions[p.id]?.id ?? `sub-${++d.seq}`,
    playerId: p.id,
    name: p.name,
    payload: structuredClone(payload),
    status: 'pending',
    at: now,
  };
  p.lastSeen = now;
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

/** Generic per-round vote (future modes; Room Knows doesn't use it). */
export function vote(db, { eventId, token, roundId, target, value }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  const p = requirePlayer(e, token);
  const r = currentRound(e);
  if (!r || r.id !== roundId) fail('round_closed');
  if (!['collecting', 'moderating', 'revealing'].includes(r.status)) fail('round_closed');
  const t = String(target ?? '').slice(0, 64);
  if (!t) fail('bad_vote');
  if (!Number.isInteger(value) || Math.abs(value) > 10) fail('bad_vote');
  r.votes[`${p.id}:${t}`] = { playerId: p.id, target: t, value, at: now };
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

export function close_round(db, { eventId, hostKey }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  const r = currentRound(e);
  if (!r || r.status !== 'collecting') fail('bad_phase');
  r.status = 'moderating';
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

export function moderate(db, { eventId, hostKey, submissionId, status }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  if (!SUBMISSION_STATUSES.includes(status) || status === 'pending') fail('bad_status');
  const r = currentRound(e);
  if (!r || !['collecting', 'moderating'].includes(r.status)) fail('bad_phase');
  const sub = Object.values(r.submissions).find((s) => s.id === submissionId);
  if (!sub) fail('not_found');
  sub.status = status;
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

/** Bulk verdict for everything still pending — the host's one-tap
 *  "approve the rest" (or "reject the rest") before a reveal. */
export function moderate_all(db, { eventId, hostKey, roundId, status }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  if (!['approved', 'rejected', 'held'].includes(status)) fail('bad_status');
  const r = currentRound(e);
  if (!r || r.id !== roundId) fail('bad_phase');
  if (!['collecting', 'moderating'].includes(r.status)) fail('bad_phase');
  let n = 0;
  for (const s of Object.values(r.submissions)) {
    if (s.status === 'pending') { s.status = status; n += 1; }
  }
  e.updatedAt = now;
  return { db: d, result: { changed: n } };
}

/**
 * The host console computes the round's results with the mode's pure logic
 * (over APPROVED submissions only) and stores them here; the screen and
 * narrated views just render what was stored. The gate is enforced, not
 * trusted: any pending submissions left when the reveal starts are rejected
 * on the spot, so an unmoderated entry can never ride into a reveal.
 */
export function start_reveal(db, { eventId, hostKey, roundId, results }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  const r = currentRound(e);
  if (!r || r.id !== roundId) fail('bad_phase');
  if (!['collecting', 'moderating'].includes(r.status)) fail('bad_phase');
  if (results == null || jsonBytes(results) > LIMITS.resultsBytes) fail('bad_results');
  for (const s of Object.values(r.submissions)) {
    if (s.status === 'pending') s.status = 'rejected';
  }
  r.results = structuredClone(results);
  r.status = 'revealing';
  r.revealStep = 0;
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

export function reveal_step(db, { eventId, hostKey, roundId, step }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  const r = currentRound(e);
  if (!r || r.id !== roundId || r.status !== 'revealing') fail('bad_phase');
  if (!Number.isInteger(step) || step < 0 || step > 40) fail('bad_step');
  r.revealStep = step;
  e.updatedAt = now;
  return { db: d, result: { step } };
}

export function end_round(db, { eventId, hostKey }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  const r = currentRound(e);
  if (!r) fail('bad_phase');
  // Ending an unrevealed round scraps it: its submissions die unseen.
  r.status = 'done';
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

export function remove_player(db, { eventId, hostKey, playerId }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  if (!e.players[playerId]) fail('not_found');
  delete e.players[playerId];
  for (const r of e.rounds) delete r.submissions[playerId];
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

export function close_event(db, { eventId, hostKey }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  e.status = 'closed';
  const r = currentRound(e);
  if (r) r.status = 'done';
  e.updatedAt = now;
  return { db: d, result: { ok: true } };
}

/** The host poll: the whole picture, host's eyes only. */
export function host_get(db, { eventId, hostKey }, now) {
  const d = clone(db);
  const e = getEvent(d, eventId);
  requireHost(e, hostKey);
  const r = currentRound(e);
  return {
    db: d,
    result: {
      id: e.id,
      code: e.code,
      title: e.title,
      status: e.status,
      questions: structuredClone(e.questions),
      players: Object.values(e.players)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id, name: p.name,
          checkinDone: Object.keys(p.checkin).length > 0,
          away: now - p.lastSeen > 60,
        })),
      checkinTallies: e.questions.map((q) => checkinTally(e, q.id)),
      round: r ? {
        id: r.id, mode: r.mode, status: r.status,
        config: structuredClone(r.config),
        revealStep: r.revealStep,
        results: structuredClone(r.results),
        submissions: Object.values(r.submissions)
          .sort((a, b) => a.at - b.at)
          .map((s) => ({
            id: s.id, name: s.name, payload: structuredClone(s.payload),
            status: s.status,
          })),
        votes: Object.values(r.votes).map((v) => ({ ...v })),
      } : null,
      roundsPlayed: e.rounds.filter((x) => x.status === 'done').length,
      doneResults: e.rounds
        .filter((x) => x.status === 'done' && x.results)
        .map((x) => ({ id: x.id, mode: x.mode, results: structuredClone(x.results) })),
    },
  };
}

/**
 * The big-screen poll — unauthenticated on purpose (it's a projector), so
 * it may contain ONLY host-authored content (the questions he picked) and
 * host-approved results. Raw submissions never appear here.
 */
export function screen_get(db, { code }, now) {
  const d = clone(db);
  const e = findByCode(d, code);
  if (!e) fail('not_found');
  const r = currentRound(e);
  return {
    db: d,
    result: {
      code: e.code,
      title: e.title,
      status: e.status,
      playerCount: Object.keys(e.players).length,
      round: r ? {
        mode: r.mode,
        status: r.status,
        config: structuredClone(r.config),
        revealStep: r.revealStep,
        results: r.status === 'revealing' ? structuredClone(r.results) : null,
        submissionCount: Object.keys(r.submissions).length,
      } : null,
      doneResults: e.rounds
        .filter((x) => x.status === 'done' && x.results)
        .map((x) => ({ mode: x.mode, results: structuredClone(x.results) })),
    },
  };
}

/* ------------------------------------------------- RPC-shaped dispatcher */
// The shim and the demo speak the wire protocol; tests may too. Argument
// names match the SQL RPCs exactly.

export const OPS = {
  party_create_event: (db, a, now) =>
    create_event(db, { hostKey: a.p_host_key, questions: a.p_questions, title: a.p_title }, now),
  party_join: (db, a, now) =>
    join(db, { code: a.p_code, name: a.p_name, token: a.p_token }, now),
  party_checkin: (db, a, now) =>
    checkin(db, { eventId: a.p_event, token: a.p_token, answers: a.p_answers }, now),
  party_player_get: (db, a, now) =>
    player_get(db, { eventId: a.p_event, token: a.p_token }, now),
  party_submit: (db, a, now) =>
    submit(db, { eventId: a.p_event, token: a.p_token, roundId: a.p_round, payload: a.p_payload }, now),
  party_vote: (db, a, now) =>
    vote(db, { eventId: a.p_event, token: a.p_token, roundId: a.p_round, target: a.p_target, value: a.p_value }, now),
  party_open_round: (db, a, now) =>
    open_round(db, { eventId: a.p_event, hostKey: a.p_host_key, mode: a.p_mode, config: a.p_config }, now),
  party_close_round: (db, a, now) =>
    close_round(db, { eventId: a.p_event, hostKey: a.p_host_key }, now),
  party_moderate: (db, a, now) =>
    moderate(db, { eventId: a.p_event, hostKey: a.p_host_key, submissionId: a.p_submission, status: a.p_status }, now),
  party_moderate_all: (db, a, now) =>
    moderate_all(db, { eventId: a.p_event, hostKey: a.p_host_key, roundId: a.p_round, status: a.p_status }, now),
  party_start_reveal: (db, a, now) =>
    start_reveal(db, { eventId: a.p_event, hostKey: a.p_host_key, roundId: a.p_round, results: a.p_results }, now),
  party_reveal_step: (db, a, now) =>
    reveal_step(db, { eventId: a.p_event, hostKey: a.p_host_key, roundId: a.p_round, step: a.p_step }, now),
  party_end_round: (db, a, now) =>
    end_round(db, { eventId: a.p_event, hostKey: a.p_host_key }, now),
  party_remove_player: (db, a, now) =>
    remove_player(db, { eventId: a.p_event, hostKey: a.p_host_key, playerId: a.p_player }, now),
  party_close_event: (db, a, now) =>
    close_event(db, { eventId: a.p_event, hostKey: a.p_host_key }, now),
  party_host_get: (db, a, now) =>
    host_get(db, { eventId: a.p_event, hostKey: a.p_host_key }, now),
  party_screen_get: (db, a, now) =>
    screen_get(db, { code: a.p_code }, now),
};

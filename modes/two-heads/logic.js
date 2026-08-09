// TWO HEADS — pure round math. No DOM, no network, no clock, no
// Math.random: plain JSON in, plain JSON out, so scripts/test-two-heads.mjs
// can drive every edge in Node. All rendering lives in mode.js; if a number
// matters, it is computed here and nowhere else.
//
// The loop: a prompt goes to every team. Two strangers huddle over ONE
// phone and co-write ONE answer (the huddle is the point — shared task,
// shared credit, shared blame). The host moderates, then the approved
// answers face off in a single-elimination bracket, one head-to-head per
// quick round: the pair lands on the big screen, EVERYONE in the room —
// players and spectators alike — votes on their phones, and the winner is
// revealed by team name. Credit is by TEAM NAME only, never by person.
//
// TEAMING IS ALWAYS CONSENSUAL. The app never assigns partners (house
// doctrine: the app governs the game, never the relationship). One phone
// shows a short team code, the partner types it in — a handshake between
// two people who already chose each other. The "looking for a partner"
// pool is a mutual signal (a beacon screen shown only on phones that opted
// in); the ONLY pairing operation in this module, `pairUp`, refuses anyone
// who didn't enter the pool. Solo teams of one are fine, no comment made.
//
// Two round shapes share this module, told apart by config.phase:
//   'write' — teams form and co-write; results seed the bracket.
//   'vote'  — one face-off; ballots advance the bracket carried in config.

export const SLUG = 'two-heads';

export const RULES = {
  answerWords: 15,   // one answer per team, fifteen words max
  answerChars: 140,
  teamNameChars: 24,
  bracketCap: 8,     // a bigger field is cut to 8 by seeded draw (announced)
  paradeCap: 100,    // keeps a pathological room under the 32 KB results cap
};

export const TEAM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TEAM_CODE_LEN = 4;

/* ------------------------------------------------------- seeded randomness */
// Everything "random" flows from a caller-supplied seed, so replays are
// exact: same seed → same bracket, same coin flips. UI entropy (a fresh
// team code) comes from the caller; this module never rolls its own dice.

export function hashSeed(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (const ch of String(str)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0; // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeTeamCode(seed) {
  const rand = rng(seed >>> 0);
  let code = '';
  for (let i = 0; i < TEAM_CODE_LEN; i++) {
    code += TEAM_CODE_ALPHABET[Math.floor(rand() * TEAM_CODE_ALPHABET.length) % TEAM_CODE_ALPHABET.length];
  }
  return code;
}

/* ------------------------------------------------------------- input hygiene */

// Strip control characters but keep tab/newline/CR — those are whitespace
// and collapse to single spaces downstream.
const stripControl = (s) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

export function wordCount(text) {
  const t = stripControl(text).trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Collapse and bound an answer, or null if empty / over the limits. */
export function cleanAnswer(text) {
  const t = stripControl(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length > RULES.answerChars) return null;
  if (t.split(' ').length > RULES.answerWords) return null;
  return t;
}

export function cleanTeamCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (c.length !== TEAM_CODE_LEN || [...c].some((ch) => !TEAM_CODE_ALPHABET.includes(ch))) {
    return null;
  }
  return c;
}

export function cleanTeamName(name, code) {
  const n = stripControl(name).replace(/\s+/g, ' ').trim().slice(0, RULES.teamNameChars);
  return n || `TEAM ${code}`;
}

/* --------------------------------------------------------- team formation */
// The pairing-state reducer. Live, each phone runs its own slice of this
// (it can only see itself — the shipped backend gives modes no cross-phone
// channel, and doctrine wants it that way); the tests run a whole room
// through it to prove the invariants. Every action is a person's own
// choice; nothing here ever puts two people together unasked.

export function initFormation() {
  return { teams: {}, pool: [], roles: {} }; // roles[player] = team code | 'pool'
}

const formErr = (code) => {
  const e = new Error(code);
  e.code = code;
  return e;
};

/**
 * Apply one formation action, immutably. Returns { state, code? }.
 * Actions:
 *   { type:'start',     player, seed, }        — open a team, become captain
 *   { type:'join',      player, code }          — enter a partner's code
 *   { type:'enterPool', player }                — opt into "looking for a partner"
 *   { type:'leavePool', player }                — opt back out
 *   { type:'pairUp',    a, b, seed }            — THE only pairing op: both
 *                                                 must already be in the pool.
 */
export function formationAct(state, action) {
  const s = structuredClone(state);
  const teamed = (p) => s.roles[p] != null && s.roles[p] !== 'pool';
  const dropFromPool = (p) => {
    s.pool = s.pool.filter((x) => x !== p);
    if (s.roles[p] === 'pool') delete s.roles[p];
  };
  const newCode = (seed) => {
    for (let i = 0; ; i++) {
      const code = makeTeamCode((seed >>> 0) + i);
      if (!s.teams[code]) return code;
    }
  };
  switch (action.type) {
    case 'start': {
      if (teamed(action.player)) throw formErr('already_teamed');
      dropFromPool(action.player);
      const code = newCode(action.seed);
      s.teams[code] = { code, members: [action.player], captain: action.player };
      s.roles[action.player] = code;
      return { state: s, code };
    }
    case 'join': {
      if (teamed(action.player)) throw formErr('already_teamed');
      const code = cleanTeamCode(action.code);
      if (!code) throw formErr('bad_code');
      dropFromPool(action.player);
      // A phone can't see other phones' teams, so joining an unknown code
      // records it optimistically — the two humans are standing together;
      // the code is their handshake, not a lock.
      if (!s.teams[code]) s.teams[code] = { code, members: [], captain: null };
      if (!s.teams[code].members.includes(action.player)) {
        s.teams[code].members.push(action.player);
      }
      s.roles[action.player] = code;
      return { state: s, code };
    }
    case 'enterPool': {
      if (teamed(action.player)) throw formErr('already_teamed');
      if (!s.pool.includes(action.player)) s.pool.push(action.player);
      s.roles[action.player] = 'pool';
      return { state: s };
    }
    case 'leavePool': {
      dropFromPool(action.player);
      return { state: s };
    }
    case 'pairUp': {
      // Only people who BOTH opted into the pool can be paired — ever.
      if (action.a === action.b
          || !s.pool.includes(action.a) || !s.pool.includes(action.b)) {
        throw formErr('not_in_pool');
      }
      dropFromPool(action.a);
      dropFromPool(action.b);
      const code = newCode(action.seed);
      s.teams[code] = { code, members: [action.a, action.b], captain: action.a };
      s.roles[action.a] = code;
      s.roles[action.b] = code;
      return { state: s, code };
    }
    default:
      throw formErr('bad_action');
  }
}

/* -------------------------------------------------------------- payloads */
// Phone payloads, all ≤ 2 KB by construction:
//   { kind:'answer', team:{ code, name }, answer }   — the captain's phone
//   { kind:'join',   team:{ code } }                 — the partner's phone
//   { kind:'vote',   pick: 0|1 }                     — a face-off ballot

export function parseAnswer(payload) {
  if (!payload || typeof payload !== 'object' || payload.kind !== 'answer') return null;
  const code = cleanTeamCode(payload.team?.code);
  const answer = cleanAnswer(payload.answer);
  if (!code || !answer) return null;
  return { code, name: cleanTeamName(payload.team?.name, code), answer };
}

export function parseBallot(payload) {
  if (!payload || typeof payload !== 'object' || payload.kind !== 'vote') return null;
  return payload.pick === 0 || payload.pick === 1 ? payload.pick : null;
}

/**
 * Approved 'answer' submissions → one entry per team. ONE SUBMISSION PER
 * TEAM is enforced here: if two approved payloads carry the same team code,
 * the first one the host approved stands and the rest are dropped.
 * Malformed payloads just sit the round out — porous, never punishing.
 */
export function entriesFrom(approved) {
  const seen = new Set();
  const entries = [];
  for (const s of approved ?? []) {
    const e = parseAnswer(s?.payload);
    if (!e || seen.has(e.code)) continue;
    seen.add(e.code);
    entries.push(e);
  }
  return entries;
}

/* --------------------------------------------------------------- bracket */
// Single elimination with byes. slots is the round-one field laid out in
// standard seed order (seeds are a seeded shuffle — nobody earned a rank
// yet), so byes spread out and never meet each other. `played` accumulates
// finished face-offs; everything else is derived, so the whole bracket is
// one small JSON blob that rides inside the vote rounds' host-authored
// config.

function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2 + 1;
    const next = [];
    for (const s of order) next.push(s, m - s);
    order = next;
  }
  return order;
}

export function seedBracket(entries, seed) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('too_few_teams');
  const rand = rng(seed >>> 0);
  const idx = entries.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const teams = idx.slice(0, Math.min(entries.length, RULES.bracketCap))
    .map((i) => ({ code: entries[i].code, name: entries[i].name, answer: entries[i].answer }));
  let size = 2;
  while (size < teams.length) size *= 2;
  const slots = seedOrder(size).map((s) => (s <= teams.length ? s - 1 : null));
  return { seed: seed >>> 0, teams, size, slots, played: [] };
}

/**
 * Walk the bracket: byes auto-advance, played matches advance their
 * winners, and the FIRST unresolved pairing is the next face-off.
 * Returns { champion: teamIdx|null, pending: {a, b, roundSize, matchNum,
 * matchesInRound}|null }.
 */
export function deriveBracket(bracket) {
  const key = (a, b) => `${a}:${b}`;
  const won = new Map((bracket.played ?? []).map((m) => [key(m.a, m.b), m.winner]));
  let row = bracket.slots;
  while (row.length > 1) {
    const next = [];
    for (let i = 0; i < row.length; i += 2) {
      const a = row[i];
      const b = row[i + 1];
      if (a == null && b == null) { next.push(null); continue; }
      if (a == null) { next.push(b); continue; }
      if (b == null) { next.push(a); continue; }
      const w = won.get(key(a, b));
      if (w == null) {
        const real = [];
        for (let j = 0; j < row.length; j += 2) {
          if (row[j] != null && row[j + 1] != null) real.push(j);
        }
        return {
          champion: null,
          pending: {
            a, b,
            roundSize: row.length,
            matchNum: real.indexOf(i) + 1,
            matchesInRound: real.length,
          },
        };
      }
      next.push(w);
    }
    row = next;
  }
  return { champion: row[0] ?? null, pending: null };
}

export function roundName(roundSize) {
  if (roundSize === 2) return 'The Final';
  if (roundSize === 4) return 'Semifinals';
  if (roundSize === 8) return 'Quarterfinals';
  return `Round of ${roundSize}`;
}

export function matchLabel(pending) {
  const base = roundName(pending.roundSize);
  return pending.matchesInRound > 1
    ? `${base} — face-off ${pending.matchNum} of ${pending.matchesInRound}`
    : base;
}

/**
 * Record one face-off. Ties (including a zero-vote face-off) break by a
 * coin flip seeded from the bracket seed and the pairing, so a replay of
 * the same round lands the same way every time.
 */
export function applyMatch(bracket, votesA, votesB) {
  const { pending } = deriveBracket(bracket);
  if (!pending) throw new Error('bracket_done');
  let winner;
  let tiebreak = false;
  if (votesA > votesB) winner = pending.a;
  else if (votesB > votesA) winner = pending.b;
  else {
    tiebreak = true;
    winner = rng(hashSeed(`${bracket.seed}:flip:${pending.a}:${pending.b}`))() < 0.5
      ? pending.a : pending.b;
  }
  const played = {
    a: pending.a, b: pending.b, roundSize: pending.roundSize,
    votesA, votesB, winner, tiebreak,
  };
  return {
    bracket: { ...bracket, played: [...(bracket.played ?? []), played] },
    played,
  };
}

/** Round-one lines for the reveal: real pairings plus who sits one out. */
export function firstRoundLines(bracket) {
  const team = (i) => bracket.teams[i].name;
  const lines = [];
  for (let i = 0; i < bracket.slots.length; i += 2) {
    const a = bracket.slots[i];
    const b = bracket.slots[i + 1];
    if (a != null && b != null) lines.push(`${team(a)} vs ${team(b)}`);
    else if (a != null || b != null) lines.push(`${team(a ?? b)} skips straight to round two`);
  }
  return lines;
}

/* --------------------------------------------------------- round configs */
// Round config is HOST-AUTHORED content — the only thing the screen may
// show before a reveal. The vote config quotes answers that already
// cleared moderation in the write round, so putting them on the screen
// during voting stays inside approve-to-reveal. config.question.text is
// what the shell's screen face prints while a round collects.

export function writeConfig(prompt) {
  return {
    phase: 'write',
    prompt: { id: prompt.id, text: prompt.text },
    question: { id: prompt.id, text: prompt.text },
  };
}

export function voteRoundConfig(bracket, prompt) {
  const { pending } = deriveBracket(bracket);
  if (!pending) throw new Error('bracket_done');
  const a = bracket.teams[pending.a];
  const b = bracket.teams[pending.b];
  const label = matchLabel(pending);
  return {
    phase: 'vote',
    prompt: { id: prompt.id, text: prompt.text },
    label,
    bracket: structuredClone(bracket),
    match: { a: structuredClone(a), b: structuredClone(b) },
    question: {
      text: `🏆 ${label}: “${a.answer}” (${a.name}) —vs— “${b.answer}” (${b.name}) — pick your winner on your phone!`,
    },
  };
}

/* -------------------------------------------------------------- the math */

/**
 * The one aggregation, split by round shape. Receives ONLY host-approved
 * submissions [{name, payload}] — the shell and the backend both enforce
 * that; nothing here can resurrect an unapproved entry.
 */
export function computeResults({ config, approved }) {
  if (config?.phase === 'vote') return computeVoteResults({ config, approved });
  return computeWriteResults({ config, approved });
}

export function computeWriteResults({ config, approved }) {
  const prompt = config?.prompt;
  if (!prompt || typeof prompt.text !== 'string') throw new Error('bad_config');
  const all = entriesFrom(approved);
  // A 200-phone room of max-length solo answers could overflow the
  // backend's 32 KB results cap and kill the reveal — cap the parade and
  // say so rather than crash the pulse.
  const entries = all.slice(0, RULES.paradeCap);
  const overflow = all.length - entries.length;
  // The seed is derived from the prompt and the field, so the same reveal
  // recomputed twice (host retap, test replay) seeds the same bracket.
  const seed = hashSeed(`${prompt.id}|${entries.map((e) => e.code).join(',')}`);
  const bracket = entries.length >= 2 ? seedBracket(entries, seed) : null;
  return {
    mode: SLUG,
    phase: 'write',
    prompt: { id: prompt.id, text: prompt.text },
    entries,
    bracket,
    walkover: entries.length === 1 ? entries[0] : null,
    cut: entries.length > RULES.bracketCap ? entries.length - RULES.bracketCap : 0,
    overflow,
  };
}

export function computeVoteResults({ config, approved }) {
  const bracket = config?.bracket;
  const prompt = config?.prompt;
  if (!bracket || !Array.isArray(bracket.teams) || !Array.isArray(bracket.slots)
      || !prompt) throw new Error('bad_config');
  const before = deriveBracket(bracket);
  if (!before.pending) throw new Error('bracket_done');

  let votesA = 0;
  let votesB = 0;
  for (const s of approved ?? []) {
    const pick = parseBallot(s?.payload); // malformed ballots sit out
    if (pick === 0) votesA += 1;
    else if (pick === 1) votesB += 1;
  }
  const total = votesA + votesB;
  const { bracket: after, played } = applyMatch(bracket, votesA, votesB);
  const status = deriveBracket(after);
  const team = (i) => structuredClone(bracket.teams[i]);
  return {
    mode: SLUG,
    phase: 'vote',
    prompt: { id: prompt.id, text: prompt.text },
    label: config.label ?? matchLabel(before.pending),
    a: team(played.a),
    b: team(played.b),
    votesA,
    votesB,
    votes: total,
    // Display percents (bar widths) are computed here, not in the UI.
    votePercents: total
      ? [Math.round((votesA * 100) / total), Math.round((votesB * 100) / total)]
      : [50, 50],
    winnerSide: played.winner === played.a ? 'a' : 'b',
    winner: team(played.winner),
    tiebreak: played.tiebreak,
    bracket: after,
    champion: status.champion != null ? team(status.champion) : null,
    next: status.pending ? {
      a: team(status.pending.a),
      b: team(status.pending.b),
      label: matchLabel(status.pending),
    } : null,
  };
}

/* ------------------------------------------------------------- host flow */

/**
 * What the host console should offer next, from tonight's finished
 * two-heads rounds (already filtered to this mode by the caller or not —
 * both item shapes {mode, results} are handled). If the LATEST finished
 * round left a live bracket, the next face-off is one tap; otherwise it's
 * time for a fresh prompt.
 */
export function hostNext(doneResults) {
  const mine = (doneResults ?? [])
    .filter((d) => d && d.mode === SLUG && d.results)
    .map((d) => d.results);
  const usedPromptIds = [...new Set(mine.map((r) => r.prompt?.id).filter(Boolean))];
  const last = mine[mine.length - 1];
  if (last?.bracket) {
    const { champion, pending } = deriveBracket(last.bracket);
    if (champion == null && pending) {
      return {
        kind: 'continue',
        prompt: last.prompt,
        bracket: last.bracket,
        pending,
        usedPromptIds,
      };
    }
  }
  return { kind: 'new', usedPromptIds };
}

/* ----------------------------------------------------------------- beats */
// The staged reveal: the shell stores an integer step; screen and narrated
// views render beat[step]. Few and fat — each beat is a moment Stephen
// narrates, not a slide.

export function beatKinds(results) {
  if (results.phase === 'write') {
    if (!results.entries.length) return ['prompt', 'nobody'];
    if (results.walkover) return ['prompt', 'parade', 'walkover'];
    return ['prompt', 'parade', 'bracket'];
  }
  return ['matchup', 'drumroll', 'winner', results.champion ? 'champion' : 'next'];
}

export function beatCount(results) {
  return beatKinds(results).length;
}

export function beatKind(results, step) {
  const kinds = beatKinds(results);
  return kinds[Math.max(0, Math.min(step, kinds.length - 1))];
}

const quote = (t) => `“${t}”`;

/** Everything the narrated view needs: what the host reads aloud per beat. */
export function narratedBeat(step, results) {
  const kind = beatKind(results, step);
  const r = results;
  switch (kind) {
    case 'prompt':
      return { kind, title: 'TWO HEADS — the prompt was', lines: [r.prompt.text] };
    case 'nobody':
      return {
        kind, title: 'The contenders',
        lines: ['No answers this round — the prompt goes back in the deck.', 'Free round!'],
      };
    case 'parade': {
      const lines = r.entries.map((e) => `${e.name}: ${quote(e.answer)}`);
      if (r.overflow) lines.push(`…and ${r.overflow} more — what a room.`);
      if (r.cut) lines.push(`${r.entries.length + (r.overflow ?? 0)} teams wrote — ${RULES.bracketCap} advance by blind draw.`);
      return { kind, title: 'The contenders', lines };
    }
    case 'bracket':
      return {
        kind, title: 'The bracket',
        lines: [...firstRoundLines(r.bracket), 'Phones ready — the first face-off is next.'],
      };
    case 'walkover':
      return {
        kind, title: 'Champions by walkover',
        lines: [r.walkover.name, quote(r.walkover.answer), 'The only heads in the game.'],
      };
    case 'matchup':
      return {
        kind, title: r.label,
        lines: [`${quote(r.a.answer)} — ${r.a.name}`, 'versus', `${quote(r.b.answer)} — ${r.b.name}`],
      };
    case 'drumroll':
      return {
        kind, title: 'The room has voted',
        lines: [`${r.votes} ballot${r.votes === 1 ? '' : 's'} in.`, 'Drumroll…'],
      };
    case 'winner': {
      const w = r.winnerSide === 'a' ? [r.votesA, r.votesB] : [r.votesB, r.votesA];
      return {
        kind, title: 'The room picks…',
        lines: [
          `${quote(r.winner.answer)} — ${r.winner.name}`,
          r.tiebreak
            ? `Dead heat at ${r.votesA}–${r.votesB} — the coin decided.`
            : `${w[0]} votes to ${w[1]}.`,
        ],
      };
    }
    case 'champion':
      return {
        kind, title: 'TWO HEADS champions',
        lines: [r.champion.name, quote(r.champion.answer), 'Written by two heads. Take a bow.'],
      };
    case 'next':
      return {
        kind, title: 'Still alive',
        lines: [`${r.next.label}: ${r.next.a.name} vs ${r.next.b.name}`, 'Next face-off when the host fires it.'],
      };
    default:
      return { kind: 'prompt', title: '', lines: [] };
  }
}

/* --------------------------------------------------------------- the deck */

/** Sanity-check content/twoheads-prompts.json (also run by the tests). */
export function validateDeck(deck) {
  const problems = [];
  if (!deck || typeof deck !== 'object') return ['deck is not an object'];
  if (!Number.isInteger(deck.version)) problems.push('missing integer version');
  if (!Array.isArray(deck.prompts) || deck.prompts.length < 8) {
    problems.push('needs at least 8 prompts');
    return problems;
  }
  const ids = new Set();
  deck.prompts.forEach((p, i) => {
    const at = `prompts[${i}]`;
    if (!/^th-[0-9]{3,}$/.test(p?.id ?? '')) problems.push(`${at}: bad id`);
    if (ids.has(p?.id)) problems.push(`${at}: duplicate id ${p.id}`);
    ids.add(p?.id);
    if (typeof p?.prompt !== 'string' || !p.prompt.trim() || p.prompt.length > 160) {
      problems.push(`${at}: bad prompt text`);
    } else if (!p.prompt.includes('___')) {
      problems.push(`${at}: prompt needs a ___ blank`);
    }
    if (!Array.isArray(p?.tags) || p.tags.some((t) => typeof t !== 'string')) {
      problems.push(`${at}: bad tags`);
    }
  });
  return problems;
}

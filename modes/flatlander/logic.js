// FLATLANDER — pure pod math. No DOM, no network, no clock, no Math.random:
// plain JSON in, plain JSON out, so scripts/test-flatlander.mjs can drive
// every edge in Node. All rendering lives in mode.js; if a number matters,
// it is computed here and nowhere else.
//
// The shape of the game: pods of 4–6 self-assemble at a table. The backend
// gives attendee phones no way to read each other's data (the player poll is
// deliberately blind), so everything a pod must agree on — who the
// Flatlander is each round, which task is up — derives deterministically
// from one shared seed: hash(host's round salt + the pod code). Every phone
// in the pod computes the same plan; nothing secret ever crosses the wire.
// Votes travel across the table physically (phones flip face-up together)
// and the table phone transcribes them, so scoring truth lives on the one
// phone that already holds the pod scoreboard.

export const SLUG = 'flatlander';

export const LIMITS = {
  podMin: 4,
  podMax: 6,
  roundsDefault: 5,
  roundsMax: 10,
  nameLen: 24, // matches the shell's player-name cap
};

export const SCORING = {
  spot: 100,    // voted for the actual Flatlander (insight pays even if the pod misses)
  escape: 200,  // the Flatlander survives the vote — double the spotters' rate
};

// Same ambiguity-free alphabet as the shell's event codes (no I/O/L/0/1).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* --------------------------------------------------------- seeded random */

/** FNV-1a over the parts, NUL-separated so ('ab','c') ≠ ('a','bc'). */
export function hash32(...parts) {
  let h = 2166136261;
  for (const part of parts) {
    for (const ch of `${part}\u0000`) {
      h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    }
  }
  return h >>> 0;
}

/** mulberry32 — tiny, well-mixed, deterministic. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------- pod codes */

/** Mint a 4-char pod code from an integer seed (the UI feeds it entropy). */
export function makePodCode(seedInt) {
  const rng = mulberry32(seedInt);
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return code;
}

/** What the table says out loud: code + pod size as one 5-char string. */
export function formatPodCode(code, size) {
  return `${code}${size}`;
}

/** Parse what a joiner typed. Returns { code, size } or null. */
export function parsePodCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-HJKMNP-Z2-9]{4})([4-6])$/);
  if (!m) return null;
  return { code: m[1], size: Number(m[2]) };
}

export function cleanName(name, fallback) {
  const v = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
    .slice(0, LIMITS.nameLen);
  return v || fallback;
}

function assertSize(size) {
  if (!Number.isInteger(size)) throw new Error('bad_pod_size');
  if (size < LIMITS.podMin) throw new Error('pod_too_small');
  if (size > LIMITS.podMax) throw new Error('pod_too_big');
}

function cleanRounds(rounds) {
  return Number.isInteger(rounds) && rounds >= 1 && rounds <= LIMITS.roundsMax
    ? rounds : LIMITS.roundsDefault;
}

/* ------------------------------------------------- role + task sequences */

/**
 * Which seat is the Flatlander, round by round. Seeded fairness: each round
 * picks uniformly among the least-used seats, excluding last round's
 * Flatlander — so nobody goes twice in a row and the counts never drift
 * more than one apart.
 */
export function flatlanderSequence(seed, size, rounds) {
  assertSize(size);
  const rng = mulberry32(seed);
  const counts = new Array(size).fill(0);
  const seq = [];
  let prev = -1;
  for (let r = 0; r < rounds; r++) {
    let min = Infinity;
    for (let i = 0; i < size; i++) {
      if (i !== prev && counts[i] < min) min = counts[i];
    }
    const candidates = [];
    for (let i = 0; i < size; i++) {
      if (i !== prev && counts[i] === min) candidates.push(i);
    }
    const pick = candidates[Math.floor(rng() * candidates.length) % candidates.length];
    seq.push(pick);
    counts[pick] += 1;
    prev = pick;
  }
  return seq;
}

/** Which task each round gets: a seeded no-repeat draw from the deck. */
export function taskSequence(seed, deckLength, rounds) {
  if (!Number.isInteger(deckLength) || deckLength < 1) throw new Error('bad_deck');
  const rng = mulberry32(hash32(String(seed), 'tasks'));
  const idx = Array.from({ length: deckLength }, (_, i) => i);
  const n = Math.min(rounds, deckLength);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (deckLength - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const seq = [];
  for (let r = 0; r < rounds; r++) seq.push(idx[r % n]);
  return seq;
}

/**
 * The whole pod plan, derivable identically on every phone in the pod from
 * public inputs (the host's round salt is in the round config; the pod code
 * is said out loud at the table). A phone only ever DISPLAYS its own seat's
 * view of this plan.
 */
export function podPlan({ salt, code, size, rounds, deckLength }) {
  assertSize(size);
  const r = cleanRounds(rounds);
  const seed = hash32(String(salt ?? ''), String(code ?? '').toUpperCase());
  return {
    seed,
    rounds: r,
    flSeq: flatlanderSequence(seed, size, r),
    taskSeq: taskSequence(seed, deckLength, r),
  };
}

/**
 * What one seat's phone shows for one round. THE rule of the mode: the
 * Flatlander gets task: null — their phone never holds the task text.
 */
export function roundView(plan, roundIx, seat, deck) {
  if (!Number.isInteger(roundIx) || roundIx < 0 || roundIx >= plan.rounds) {
    throw new Error('bad_round');
  }
  const isFlatlander = plan.flSeq[roundIx] === seat;
  if (isFlatlander) return { isFlatlander: true, task: null };
  const task = deck?.tasks?.[plan.taskSeq[roundIx]] ?? null;
  return {
    isFlatlander: false,
    task: task ? { id: task.id, type: task.type, instruction: task.instruction } : null,
  };
}

/* ------------------------------------------------------------- the votes */

/** Legal votes only: seats in range, no self-votes, one vote per seat
 *  (last entry wins, like an upsert). */
export function cleanVotes(votes, size) {
  const bySeat = new Map();
  for (const v of Array.isArray(votes) ? votes : []) {
    if (!v || typeof v !== 'object') continue;
    const { seat, target } = v;
    if (!Number.isInteger(seat) || seat < 0 || seat >= size) continue;
    if (!Number.isInteger(target) || target < 0 || target >= size) continue;
    if (seat === target) continue;
    bySeat.set(seat, target);
  }
  return [...bySeat.entries()].map(([seat, target]) => ({ seat, target }))
    .sort((a, b) => a.seat - b.seat);
}

/**
 * The vote resolution.
 *   caught   — the Flatlander alone tops the tally. A tie at the top (even
 *              one that includes them) is chaos, and chaos favors the
 *              Flatlander: they slip away.
 *   points   — spotters (non-Flatlanders who voted the Flatlander) earn
 *              SCORING.spot whether or not the pod as a whole caught them;
 *              a surviving Flatlander earns SCORING.escape. Everyone else 0.
 * The Flatlander votes too (to blend — and their vote sways the tally),
 * but their vote can never earn points.
 */
export function resolveVotes({ votes, flSeat, size }) {
  assertSize(size);
  if (!Number.isInteger(flSeat) || flSeat < 0 || flSeat >= size) throw new Error('bad_flatlander');
  const clean = cleanVotes(votes, size);
  const tally = new Array(size).fill(0);
  for (const v of clean) tally[v.target] += 1;
  const top = Math.max(...tally);
  const topSeats = top > 0 ? tally.flatMap((c, i) => (c === top ? [i] : [])) : [];
  const caught = topSeats.length === 1 && topSeats[0] === flSeat;
  const spotters = clean.filter((v) => v.seat !== flSeat && v.target === flSeat)
    .map((v) => v.seat);
  const points = new Array(size).fill(0);
  for (const s of spotters) points[s] = SCORING.spot;
  if (!caught) points[flSeat] = SCORING.escape;
  return { votes: clean, tally, topSeats, caught, spotters, points };
}

/* --------------------------------------------------------- the pod game */

/** The table phone's full game state. JSON-serializable, immutable ops. */
export function newGame({ salt, code, size, names, rounds, deckLength }) {
  assertSize(size);
  const c = String(code ?? '').toUpperCase();
  if (!/^[A-HJKMNP-Z2-9]{4}$/.test(c)) throw new Error('bad_code');
  const list = Array.isArray(names) ? names : [];
  if (list.length !== size) throw new Error('bad_names');
  const plan = podPlan({ salt, code: c, size, rounds, deckLength });
  return {
    mode: SLUG,
    code: c,
    size,
    names: list.map((n, i) => cleanName(n, `Seat ${i + 1}`)),
    rounds: plan.rounds,
    plan,
    roundIx: 0,
    scores: new Array(size).fill(0),
    flCounts: new Array(size).fill(0),
    escapes: new Array(size).fill(0),
    spots: new Array(size).fill(0),
    caught: 0,
    escaped: 0,
  };
}

export function gameOver(game) {
  return game.roundIx >= game.rounds;
}

/** Resolve one round's votes and advance. Returns the next state plus the
 *  outcome the table phone stages its reveal from. */
export function applyRound(game, votes) {
  if (gameOver(game)) throw new Error('game_over');
  const flSeat = game.plan.flSeq[game.roundIx];
  const res = resolveVotes({ votes, flSeat, size: game.size });
  const next = structuredClone(game);
  for (let i = 0; i < next.size; i++) next.scores[i] += res.points[i];
  next.flCounts[flSeat] += 1;
  if (res.caught) next.caught += 1;
  else { next.escaped += 1; next.escapes[flSeat] += 1; }
  for (const s of res.spotters) next.spots[s] += 1;
  next.roundIx += 1;
  return { game: next, outcome: { round: game.roundIx + 1, flSeat, ...res } };
}

/** The one submission the table phone sends the host when the pod wraps. */
export function podSummary(game) {
  return {
    v: 1,
    pod: game.code,
    size: game.size,
    rounds: game.roundIx,
    caught: game.caught,
    escaped: game.escaped,
    players: game.names.map((name, i) => ({
      name,
      score: game.scores[i],
      fl: game.flCounts[i],
      esc: game.escapes[i],
      spot: game.spots[i],
    })),
  };
}

/* --------------------------------------------- room-wide reveal (approved) */

/** Clamp one approved pod submission into a legal result, or null. */
export function cleanPodResult(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const pod = String(payload.pod ?? '').toUpperCase();
  if (!/^[A-HJKMNP-Z2-9]{4}$/.test(pod)) return null;
  const size = payload.size;
  if (!Number.isInteger(size) || size < LIMITS.podMin || size > LIMITS.podMax) return null;
  const rounds = Number.isInteger(payload.rounds)
    ? Math.max(0, Math.min(LIMITS.roundsMax, payload.rounds)) : 0;
  if (!Array.isArray(payload.players) || payload.players.length < 1
      || payload.players.length > size) return null;
  const maxScore = rounds * SCORING.escape;
  const int = (v, hi) => (Number.isInteger(v) ? Math.max(0, Math.min(hi, v)) : 0);
  const players = payload.players.map((p, i) => {
    const fl = int(p?.fl, rounds);
    return {
      name: cleanName(p?.name, `Seat ${i + 1}`),
      score: int(p?.score, maxScore),
      fl,
      esc: Math.min(int(p?.esc, rounds), fl),
      spot: int(p?.spot, rounds),
    };
  });
  const escaped = Math.min(int(payload.escaped, rounds), rounds);
  return {
    pod, size, rounds, players,
    escaped,
    caught: Math.min(int(payload.caught, rounds), rounds - escaped),
  };
}

/**
 * Shell → mode: approved pod submissions in, the stored reveal object out.
 * One result per pod code (first approved wins — a duplicate code is either
 * a re-send or a spoof, and either way the host approved the first one).
 * Handles zero submissions gracefully: the reveal still lands.
 */
export function computeResults({ approved }) {
  const pods = [];
  const seen = new Set();
  for (const s of approved ?? []) {
    const p = cleanPodResult(s?.payload);
    if (!p || seen.has(p.pod)) continue;
    seen.add(p.pod);
    pods.push(p);
  }
  const players = pods.flatMap((p) =>
    p.players.map((pl) => ({ ...pl, pod: p.pod })));
  const byMax = (key) => {
    const max = Math.max(0, ...players.map((p) => p[key]));
    return max > 0
      ? players.filter((p) => p[key] === max)
        .map((p) => ({ name: p.name, pod: p.pod, n: max }))
        .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  };
  return {
    mode: SLUG,
    emptyNight: pods.length === 0,
    totals: {
      pods: pods.length,
      players: players.length,
      caught: pods.reduce((a, p) => a + p.caught, 0),
      escaped: pods.reduce((a, p) => a + p.escaped, 0),
    },
    pods: pods.map((p) => ({
      pod: p.pod, size: p.size, rounds: p.rounds, caught: p.caught, escaped: p.escaped,
    })),
    slickest: byMax('esc'),   // most escapes as the Flatlander
    sharpest: byMax('spot'),  // most correct call-outs
    board: players
      .map((p) => ({ name: p.name, pod: p.pod, score: p.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}

/** Running board across every revealed Flatlander round tonight. */
export function scoreboard(resultsList) {
  const rows = new Map();
  for (const r of resultsList ?? []) {
    if (!r || r.mode !== SLUG) continue;
    for (const p of r.board ?? []) {
      const row = rows.get(p.name) ?? { name: p.name, points: 0, rounds: 0 };
      row.points += p.score;
      row.rounds += 1;
      rows.set(p.name, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.points - a.points || a.rounds - b.rounds || a.name.localeCompare(b.name),
  );
}

/* -------------------------------------------------------------- the beats */

export const BEATS = ['intro', 'catches', 'slickest', 'sharpest', 'podium'];

export function beatCount() {
  return BEATS.length;
}

const nameList = (rows) => rows.map((r) => r.name).join(' and ');

/** What the host reads aloud per beat — this surface IS the reveal at a
 *  no-TV venue, so every line must land spoken. */
export function narratedBeat(step, results, board) {
  const r = results;
  const kind = BEATS[Math.max(0, Math.min(step, BEATS.length - 1))];
  if (r.emptyNight) {
    // Every beat stays graceful when no pod sent scores in.
    if (kind === 'intro') {
      return { kind, title: 'Flatlander', lines: ['The pods kept their secrets tonight.', 'No scoreboards made it in — the tables know who they are.'] };
    }
    return { kind, title: 'Flatlander', lines: ['Nothing on the books for this one.'] };
  }
  switch (kind) {
    case 'intro':
      return {
        kind, title: 'Flatlander',
        lines: [
          `${r.totals.pods} pod${r.totals.pods === 1 ? '' : 's'} played — ${r.totals.players} of you around the tables.`,
          'Every round, one of you had no idea what anyone was doing.',
        ],
      };
    case 'catches': {
      const { caught, escaped } = r.totals;
      return {
        kind, title: 'The damage',
        lines: [
          `The tables caught ${caught} Flatlander${caught === 1 ? '' : 's'}.`,
          escaped > 0 ? `${escaped} slipped away clean.` : 'Not one slipped away. Terrifying room.',
        ],
      };
    }
    case 'slickest':
      return r.slickest.length
        ? {
          kind, title: 'Smoothest Flatlander',
          lines: [nameList(r.slickest), `Blended in and walked away ${r.slickest[0].n} time${r.slickest[0].n === 1 ? '' : 's'}.`],
        }
        : { kind, title: 'Smoothest Flatlander', lines: ['Nobody escaped tonight — every faker got the finger.'] };
    case 'sharpest':
      return r.sharpest.length
        ? {
          kind, title: 'Sharpest eyes',
          lines: [nameList(r.sharpest), `Called out the Flatlander ${r.sharpest[0].n} time${r.sharpest[0].n === 1 ? '' : 's'}.`],
        }
        : { kind, title: 'Sharpest eyes', lines: ['No correct call-outs. The Flatlanders walk among you.'] };
    default: {
      const rows = (board ?? []).slice(0, 5);
      return {
        kind, title: 'Blends in best',
        lines: rows.length
          ? rows.map((row, i) => `${i + 1}. ${row.name} — ${row.points}`)
          : ['First pod on the board next time!'],
      };
    }
  }
}

/* ---------------------------------------------------------------- the deck */

/** Sanity-check content/flatlander-tasks.json (also run by the tests).
 *  The type allowlist IS the content doctrine: every task is a physical,
 *  observable act — nothing that self-reports anything sensitive. */
export const TASK_TYPES = ['raise-hand', 'point', 'fingers', 'pose'];

export function validateDeck(deck) {
  const problems = [];
  if (!deck || typeof deck !== 'object') return ['deck is not an object'];
  if (!Number.isInteger(deck.version)) problems.push('missing integer version');
  if (!Array.isArray(deck.tasks) || deck.tasks.length < 10) {
    problems.push('needs at least 10 tasks');
    return problems;
  }
  const ids = new Set();
  deck.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!/^fl-[0-9]{3,}$/.test(t?.id ?? '')) problems.push(`${at}: bad id`);
    if (ids.has(t?.id)) problems.push(`${at}: duplicate id ${t.id}`);
    ids.add(t?.id);
    if (!TASK_TYPES.includes(t?.type)) problems.push(`${at}: type must be one of ${TASK_TYPES.join('/')}`);
    if (typeof t?.instruction !== 'string' || !t.instruction.trim() || t.instruction.length > 160) {
      problems.push(`${at}: bad instruction`);
    }
    if (typeof t?.fakerTrap !== 'string' || !t.fakerTrap.trim() || t.fakerTrap.length > 200) {
      problems.push(`${at}: bad fakerTrap`);
    }
  });
  return problems;
}

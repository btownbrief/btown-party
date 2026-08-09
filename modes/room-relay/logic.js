// ROOM RELAY — pure routing + chain assembly. No DOM, no network, no clock
// reads, no Math.random: time and randomness arrive as data (openedAtS,
// nowS, seed), so scripts/test-room-relay.mjs can replay every party in
// plain Node and get the same answer twice.
//
// The game: everyone contributes a tiny fragment (a doodle, a phrase, a
// fake local headline). The app routes each APPROVED fragment to a
// different attendee, who sees ONLY the fragment — never its prompt or
// history — and adds the next step. At reveal time the host fires each
// chain beat by beat: prompt, step one, step two, contributor first names
// with the finished artifact.
//
// One relay = two shell rounds (three if the host toggles 3-step chains):
//   round A  phase 'start'    — collect fragments. Moderation here is
//            GATE 1: only approved fragments ever route onward. Its
//            "reveal" is a single teaser beat; storing results is what
//            hands the approved fragments to the next round.
//   round B  phase 'continue' — config carries the approved fragments plus
//            a routing plan; each phone gets its own assignment. Moderation
//            here is GATE 2: the host re-approves every assembled chain
//            before the real reveal fires.
//
// ROUTING, the porous part: the round config is the only channel to the
// phones and it is frozen at open time, so assignment must be a pure
// function of (config, playerId, elapsed time). Time is sliced into epochs
// of expiryS seconds; each epoch the preference rotation advances by one,
// so a fragment whose assignee is mid-conversation or in the bathroom
// silently drifts to the next available person. Phones lock an assignment
// the moment its holder starts working (UI concern), submissions carry the
// chain id, and assembly takes the first approved answer per chain — so a
// rotation that double-covers a chain wastes nothing and blocks nobody.

export const SLUG = 'room-relay';

export const CHAIN_TYPES = ['doodle-then-title', 'phrase-then-doodle', 'headline-then-next-line'];

/** What each step of a chain asks for, per chain type (first N used). */
export const SEQS = {
  'doodle-then-title': ['doodle', 'title', 'doodle'],
  'phrase-then-doodle': ['phrase', 'doodle', 'title'],
  'headline-then-next-line': ['headline', 'nextline', 'nextline'],
};

/** Seed chains are text headlines built from check-in tallies, so their
 *  follow-up steps come from a text-first sequence. */
export const SEED_SEQS = {
  'doodle-then-title': ['headline', 'doodle', 'title'],
  'phrase-then-doodle': ['headline', 'doodle', 'title'],
  'headline-then-next-line': ['headline', 'nextline', 'nextline'],
};

export const KIND_LABEL = {
  doodle: 'Draw it',
  title: 'Title it',
  phrase: 'Write it',
  headline: 'Write the headline',
  nextline: 'Write what happens next',
};

export const RELAY = {
  textLen: 100,        // any written fragment
  doodleChars: 700,    // encoded stroke data budget per doodle
  doodleStrokes: 24,
  grid: 64,            // doodle coordinate space (0..63 per axis)
  colors: 5,
  widths: 2,
  minChains: 3,        // below this, seed chains from check-in tallies
  startChainsMax: 40,  // fragments kept from a start round
  expiryS: 150,        // one routing epoch — "a few minutes", roughly
  configBudget: 7400,  // stay under party-core's 8192-byte config cap
  parkedMax: 2,        // over-budget fragments still revealed as unfinished
  promptsMax: 16,
};

/** Beats cap: party-core rejects reveal steps past 40, so plans keep
 *  intro + chains·(1+steps[+flop]) + outro inside that. */
export const BEAT_LIMIT = 38;

/* --------------------------------------------------- deterministic helpers */

/** FNV-ish string hash → [0, mod). Same spirit as js/demo.js. */
export function det(str, mod) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h) % Math.max(1, mod);
}

/** Park–Miller LCG, same generator party-core uses for codes. */
function lcg(seed) {
  const s = (Math.imul(seed, 48271) >>> 0) % 2147483647 || 1;
  return { seed: s, value: s / 2147483647 };
}

function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = (seed >>> 0) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    const r = lcg(s);
    s = r.seed;
    const j = Math.floor(r.value * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const jsonBytes = (v) => JSON.stringify(v).length;

/* ------------------------------------------------------------ doodle codec */
// A doodle is vector strokes on a 64×64 grid. One stroke encodes as
// <color char><width char><xy pairs…>, one base-64-alphabet char per
// coordinate; strokes join with '.'. ~30-point stroke ≈ 62 chars, so a
// whole doodle stays a few hundred bytes — small enough that a routing
// plan full of doodles fits the 8 KB round config.

export const A64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeDoodle(strokes) {
  return (strokes ?? []).map((st) =>
    A64[st.c] + A64[st.w] + st.pts.map(([x, y]) => A64[x] + A64[y]).join('')).join('.');
}

/** Encoded string → [{c, w, pts:[[x,y]…]}], or null if malformed. */
export function decodeDoodle(d) {
  if (typeof d !== 'string' || !d || d.length > RELAY.doodleChars) return null;
  const strokes = [];
  for (const raw of d.split('.')) {
    if (raw.length < 6 || raw.length % 2 !== 0) return null; // ≥ 2 points
    const idx = [...raw].map((ch) => A64.indexOf(ch));
    if (idx.some((i) => i < 0)) return null;
    const [c, w, ...coords] = idx;
    if (c >= RELAY.colors || w >= RELAY.widths) return null;
    const pts = [];
    for (let i = 0; i < coords.length; i += 2) pts.push([coords[i], coords[i + 1]]);
    strokes.push({ c, w, pts });
    if (strokes.length > RELAY.doodleStrokes) return null;
  }
  return strokes;
}

/* ------------------------------------------------------ fragment validation */

export function cleanText(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RELAY.textLen);
}

/** Clamp a raw fragment into a legal one for `kind`, or null if hopeless. */
export function cleanFrag(frag, kind) {
  if (!frag || typeof frag !== 'object') return null;
  if (kind === 'doodle') {
    if (frag.t !== 'doodle' || !decodeDoodle(frag.d)) return null;
    return { t: 'doodle', d: frag.d };
  }
  if (frag.t !== 'text') return null;
  const s = cleanText(frag.s);
  if (!s) return null;
  return { t: 'text', s };
}

const cleanId = (v) => (typeof v === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(v) ? v : null);

/** Start-round phone payload → {author, prompt, frag} or null. */
export function cleanStartPayload(payload, config) {
  if (!payload || typeof payload !== 'object' || payload.rr !== 1) return null;
  const kind = SEQS[config?.chainType]?.[0];
  if (!kind) return null;
  const frag = cleanFrag(payload.frag, kind);
  if (!frag) return null;
  const n = config.prompts?.length ?? 0;
  const prompt = Number.isInteger(payload.prompt) && payload.prompt >= 0 && payload.prompt < n
    ? payload.prompt : null;
  return { author: cleanId(payload.author), prompt, frag };
}

/** Continue-round phone payload → {author, chainId, frag} or null. */
export function cleanContinuePayload(payload, config) {
  if (!payload || typeof payload !== 'object' || payload.rr !== 1) return null;
  const chainId = cleanId(payload.chain);
  const chain = (config?.chains ?? []).find((c) => c.id === chainId);
  if (!chain) return null;
  const frag = cleanFrag(payload.frag, chain.kind);
  if (!frag) return null;
  return { author: cleanId(payload.author), chainId, frag };
}

/* ------------------------------------------------------------ start round */

/**
 * Round-A config. deck = content/room-relay-prompts.json (fetched by the
 * UI), checkinQs = tonight's questions verbatim (id, text, options) so
 * seed headlines can be written from anonymous tallies later, seed = an
 * integer the UI mints once (the only randomness, carried as data).
 */
export function buildStartConfig({ chainType, totalSteps, deck, checkinQs, seed }) {
  if (!SEQS[chainType]) throw new Error('bad_chain_type');
  const steps = totalSteps === 3 ? 3 : 2;
  const kind0 = SEQS[chainType][0];
  const pool = deck?.[kind0 === 'doodle' ? 'doodle' : kind0] ?? [];
  const prompts = seededShuffle(pool.map(cleanText).filter(Boolean), seed)
    .slice(0, RELAY.promptsMax);
  if (!prompts.length) throw new Error('empty_deck');
  return {
    rr: 1,
    phase: 'start',
    chainType,
    totalSteps: steps,
    seed: (seed >>> 0) || 1,
    prompts,
    seedLines: (deck?.seedHeadlines ?? []).map(cleanText).filter(Boolean).slice(0, 6),
    checkinQs: (checkinQs ?? []).slice(0, 8).map((q) => ({
      id: q.id, text: cleanText(q.text), options: (q.options ?? []).map(cleanText),
    })),
    // The unauthenticated screen face renders config.question.text while a
    // round collects — this line is that marquee (host-authored, no
    // attendee content).
    question: { text: '🌀 Room Relay — fragments incoming. Grab your phone when you have 20 seconds.' },
  };
}

/** Which prompt this phone works from — spread across the room, stable per
 *  person, no server round-trip. */
export function promptFor(config, playerId) {
  return det(`${config.seed}:${playerId ?? 'anon'}`, config.prompts.length);
}

/** Seed chains from anonymous check-in tallies: host-authored templates ×
 *  aggregate counts, so the very first relay has material even if nobody
 *  submits a fragment. */
export function seedChains(config, checkinTallies, count) {
  const out = [];
  const qs = config.checkinQs ?? [];
  const lines = config.seedLines ?? [];
  if (!lines.length) return out;
  const tallies = (checkinTallies ?? []).filter((t) => t && t.total > 0);
  for (let i = 0; i < count && i < tallies.length; i++) {
    const t = tallies[i % tallies.length];
    const q = qs.find((x) => x.id === t.questionId);
    if (!q) continue;
    const top = t.counts.indexOf(Math.max(...t.counts));
    const line = lines[det(`${config.seed}:seed:${i}`, lines.length)]
      .replace('{pct}', String(Math.round((t.counts[top] / t.total) * 100)))
      .replace('{top}', q.options[top] ?? '?')
      .replace('{q}', q.text);
    out.push({
      id: `seed-${i}`,
      seq: SEED_SEQS[config.chainType].slice(0, config.totalSteps),
      prompt: 'straight from the check-in desk',
      steps: [{ by: 'the check-in desk', authorId: null, frag: { t: 'text', s: cleanText(line) } }],
    });
  }
  return out;
}

/**
 * Round-A results: one embryonic chain per approved fragment. `approved`
 * is [{name, payload}] — the shell hands over host-approved submissions
 * only, and party-core auto-rejects anything still pending when the
 * teaser reveal fires. That is GATE 1: an unapproved fragment never
 * becomes a chain, so it can never route to another phone.
 */
export function computeStartResults({ config, approved, checkinTallies }) {
  const seq = SEQS[config.chainType].slice(0, config.totalSteps);
  const seenAuthors = new Set();
  const chains = [];
  for (const { name, payload } of approved ?? []) {
    const p = cleanStartPayload(payload, config);
    if (!p) continue; // malformed entries sit the relay out, silently
    const authorKey = p.author ?? `anon-${chains.length}`;
    if (seenAuthors.has(authorKey)) continue;
    seenAuthors.add(authorKey);
    chains.push({
      id: `ch-${chains.length}-${det(authorKey, 46656).toString(36)}`,
      seq,
      prompt: p.prompt != null ? config.prompts[p.prompt] : '(freestyle)',
      steps: [{ by: name, authorId: p.author, frag: p.frag }],
    });
    if (chains.length >= RELAY.startChainsMax) break;
  }
  const seeded = chains.length < RELAY.minChains
    ? seedChains(config, checkinTallies, RELAY.minChains - chains.length)
    : [];
  return {
    mode: SLUG,
    rr: 1,
    stage: 'collected',
    chainType: config.chainType,
    totalSteps: config.totalSteps,
    fragTotal: chains.length,
    seeded: seeded.length,
    chains: [...chains, ...seeded],
  };
}

/* --------------------------------------------------------- continue round */

/**
 * Build the routing plan for the next leg from the previous leg's results
 * plus the live roster ([{id, name, away}] from the host snapshot).
 * Deterministic given its inputs. Returns null when there is nothing to
 * route or nobody to route to.
 *
 * Every chain gets a distinct rotation slot; assignmentsAt() turns
 * (slots, epoch) into a matching. Byte budget: the plan must carry each
 * fragment to its next author inside the 8 KB config cap, so over-budget
 * chains fall off (up to parkedMax of them still ride along, fragment-
 * only, to be revealed as "the room never finished this one").
 */
export function buildContinuePlan({ prior, players, seed }) {
  if (!prior?.rr || prior.stage === 'done') return null;
  const roster = (players ?? []).map((p) => p.id);
  if (!roster.length) return null;
  const eligible = (prior.chains ?? []).filter((c) => c.steps.length < prior.totalSteps);
  if (!eligible.length) return null;

  const leg = (prior.stage === 'collected' ? 0 : prior.leg ?? 1) + 1; // 1-based continue leg
  const perChainBeats = 1 + prior.totalSteps + 1; // prompt + steps + worst-case flop
  const maxChains = Math.min(
    roster.length,
    Math.floor(BEAT_LIMIT / perChainBeats),
  );

  const ordered = seededShuffle(eligible, seed);
  const base = {
    rr: 1,
    phase: 'continue',
    leg,
    chainType: prior.chainType,
    totalSteps: prior.totalSteps,
    seed: (seed >>> 0) || 1,
    expiryS: RELAY.expiryS,
    openedAtS: null, // the UI stamps wall time here just before opening
    roster,
    chains: [],
    parked: [],
    dropped: 0,
    question: { text: '🔀 Room Relay — fragments are traveling to new hands. Check your phone.' },
  };

  const usedSlots = new Set();
  const slotFor = (chain) => {
    const authorId = chain.steps[0]?.authorId;
    let s = authorId != null && roster.includes(authorId)
      ? roster.indexOf(authorId) : det(chain.id, roster.length);
    while (usedSlots.has(s)) s = (s + 1) % Math.max(roster.length, eligible.length);
    usedSlots.add(s);
    return s;
  };

  for (const chain of ordered) {
    const entry = {
      id: chain.id,
      kind: chain.seq[chain.steps.length],
      seq: chain.seq,
      prompt: chain.prompt,
      hist: chain.steps,
      slot: 0,
    };
    if (base.chains.length < maxChains) {
      entry.slot = slotFor(chain);
      base.chains.push(entry);
      if (jsonBytes(base) > RELAY.configBudget) {
        base.chains.pop();
        usedSlots.delete(entry.slot);
        if (base.parked.length < RELAY.parkedMax) {
          base.parked.push({ id: chain.id, seq: chain.seq, prompt: chain.prompt, hist: chain.steps });
          if (jsonBytes(base) > RELAY.configBudget) { base.parked.pop(); base.dropped += 1; }
        } else base.dropped += 1;
      }
    } else if (base.parked.length < RELAY.parkedMax) {
      base.parked.push({ id: chain.id, seq: chain.seq, prompt: chain.prompt, hist: chain.steps });
      if (jsonBytes(base) > RELAY.configBudget) { base.parked.pop(); base.dropped += 1; }
    } else base.dropped += 1;
  }
  if (!base.chains.length) return null;
  return base;
}

/** Prior contributors of a chain — never re-assigned their own chain. */
const excludedFor = (chain) =>
  new Set((chain.hist ?? []).map((s) => s.authorId).filter((id) => id != null));

/** Routing epoch at wall time nowS. Epoch 0 until the config is stamped. */
export function epochAt(config, nowS) {
  if (!config?.openedAtS || !Number.isFinite(nowS)) return 0;
  return Math.max(0, Math.floor((nowS - config.openedAtS) / (config.expiryS || RELAY.expiryS)));
}

/**
 * The assignment matching for one epoch: each chain walks the roster from
 * (slot + 1 + epoch), skipping its own past contributors and anyone
 * already taken this epoch. Properties the tests pin down: nobody is ever
 * offered their own chain, no player holds two chains at once, no chain
 * is offered to two players at once, and advancing the epoch moves an
 * unclaimed chain to somebody else.
 */
export function assignmentsAt(config, epoch) {
  const roster = config?.roster ?? [];
  const byChain = {};
  const byPlayer = {};
  const n = roster.length;
  for (const chain of config?.chains ?? []) {
    byChain[chain.id] = null;
    if (!n) continue;
    const excluded = excludedFor(chain);
    for (let k = 0; k < n; k++) {
      const pid = roster[(chain.slot + 1 + epoch + k) % n];
      if (excluded.has(pid) || byPlayer[pid] !== undefined) continue;
      byChain[chain.id] = pid;
      byPlayer[pid] = chain.id;
      break;
    }
  }
  return { byChain, byPlayer };
}

/**
 * What this phone should work on right now, or null (spectating is fine).
 * Planned players read the matching; a player the plan has never heard of
 * (late joiner) is pointed at an unclaimed chain when one exists, else at
 * a deterministic pick — double coverage there is harmless because
 * assembly takes the first approved answer per chain.
 */
export function assignmentFor(config, playerId, epoch) {
  const chains = config?.chains ?? [];
  if (!chains.length || playerId == null) return null;
  const { byChain, byPlayer } = assignmentsAt(config, epoch);
  if ((config.roster ?? []).includes(playerId)) {
    const id = byPlayer[playerId];
    return id ? chains.find((c) => c.id === id) : null;
  }
  const mine = chains.filter((c) => !excludedFor(c).has(playerId));
  if (!mine.length) return null;
  const open = mine.filter((c) => byChain[c.id] == null);
  const pool = open.length ? open : mine;
  return pool[det(String(playerId), pool.length)];
}

/**
 * Round-B (or C) results: append each chain's first approved answer.
 * `approved` again passed through the shell's moderation filter — GATE 2:
 * the host has read every line and seen every doodle before any of it can
 * reach the reveal. Unanswered and parked chains stay short; the reveal
 * plays them as their own joke, never as an error.
 */
export function computeContinueResults({ config, approved }) {
  const answers = new Map(); // chainId → first approved {name, payload}
  for (const { name, payload } of approved ?? []) {
    const p = cleanContinuePayload(payload, config);
    if (!p || answers.has(p.chainId)) continue;
    answers.set(p.chainId, { by: name, authorId: p.author, frag: p.frag });
  }
  const assemble = (c) => {
    const next = answers.get(c.id);
    const steps = next ? [...c.hist, next] : [...c.hist];
    return { id: c.id, seq: c.seq, prompt: c.prompt, steps, done: steps.length >= config.totalSteps };
  };
  const chains = [
    ...(config.chains ?? []).map(assemble),
    ...(config.parked ?? []).map((c) => ({
      id: c.id, seq: c.seq, prompt: c.prompt, steps: [...c.hist], done: false,
    })),
  ];
  const stage = config.leg >= config.totalSteps - 1 ? 'done' : 'mid';
  return {
    mode: SLUG,
    rr: 1,
    stage,
    leg: config.leg,
    chainType: config.chainType,
    totalSteps: config.totalSteps,
    finished: chains.filter((c) => c.done).length,
    dropped: config.dropped ?? 0,
    chains,
  };
}

/* ----------------------------------------------------------------- reveal */

/**
 * The flat beat list for a finished relay: title card, then each chain as
 * prompt → step one → step two (an unfinished chain earns a punchline
 * beat instead of its missing step), then a closer.
 */
export function beatList(results) {
  if (!results || results.stage !== 'done') return [{ k: 'teaser' }];
  const beats = [{ k: 'intro' }];
  results.chains.forEach((c, ci) => {
    beats.push({ k: 'prompt', ci });
    c.steps.forEach((_, si) => beats.push({ k: 'step', ci, si }));
    if (!c.done) beats.push({ k: 'flop', ci });
  });
  beats.push({ k: 'outro' });
  return beats;
}

export function beatCount(results) {
  return beatList(results).length;
}

/** What the host reads aloud at beat `step` (the no-TV reveal surface —
 *  text only, so a doodle is narrated by its stats, not shown). */
export function narratedBeat(step, results) {
  const beats = beatList(results);
  const b = beats[Math.max(0, Math.min(step, beats.length - 1))];
  const chain = b.ci != null ? results.chains[b.ci] : null;
  const nth = b.ci != null ? `Chain ${b.ci + 1} of ${results.chains.length}` : '';
  switch (b.k) {
    case 'teaser': {
      const n = results?.chains?.length ?? 0;
      return {
        title: 'Room Relay',
        lines: [
          `${n} fragment${n === 1 ? '' : 's'} are in.`,
          'They\'re being shuffled to new hands — keep your phone nearby.',
        ],
      };
    }
    case 'intro':
      return {
        title: 'Room Relay — the reveal',
        lines: [`This room made ${results.chains.length} things together.`, 'Nobody saw the whole of any of them. Until now.'],
      };
    case 'prompt':
      return { title: `${nth} — it started with`, lines: [`“${chain.prompt}”`] };
    case 'step': {
      const s = chain.steps[b.si];
      const what = s.frag.t === 'doodle'
        ? `${s.by} drew it — ${decodeDoodle(s.frag.d)?.length ?? 0} strokes of pure confidence. It's on the screen.`
        : `“${s.frag.s}”`;
      return {
        title: b.si === 0 ? `${nth} — the fragment` : `${nth} — then ${s.by} got it`,
        lines: s.frag.t === 'doodle' ? [what] : [what, `— ${s.by}`],
      };
    }
    case 'flop':
      return { title: nth, lines: ['…and that\'s where it ends.', 'The room never finished this one. It\'s perfect as is.'] };
    default: {
      const flops = results.chains.length - results.finished;
      return {
        title: 'That\'s the relay',
        lines: [
          `${results.finished} finished chain${results.finished === 1 ? '' : 's'}${flops ? `, ${flops} beautiful loose end${flops === 1 ? '' : 's'}` : ''}.`,
          'Go find out who titled yours.',
        ],
      };
    }
  }
}

/* -------------------------------------------- event-list replay (testing) */

/**
 * The canonical semantics in one place: fold an event list over a continue
 * config and read out assignments and results. Events:
 *   {t:'tick',  nowS}                     — wall time arrives as data
 *   {t:'join',  playerId}                 — a late joiner appears
 *   {t:'submit',playerId, name, payload}  — a phone submits (resubmit replaces)
 *   {t:'approve', playerId} / {t:'reject', playerId} — the host's verdict
 * Pure and deterministic: same config + same events → same state, always.
 * The live shell reaches the same answers through party-core; tests use
 * this to replay routing/expiry/moderation scenarios without a browser.
 */
export function replay(config, events) {
  const state = { nowS: config.openedAtS ?? 0, joined: new Set(config.roster ?? []), subs: new Map() };
  for (const ev of events ?? []) {
    if (ev.t === 'tick') state.nowS = ev.nowS;
    else if (ev.t === 'join') state.joined.add(ev.playerId);
    else if (ev.t === 'submit') {
      state.subs.set(ev.playerId, { name: ev.name, payload: ev.payload, status: 'pending', order: state.subs.size });
    } else if (ev.t === 'approve' || ev.t === 'reject') {
      const s = state.subs.get(ev.playerId);
      if (s) s.status = ev.t === 'approve' ? 'approved' : 'rejected';
    }
  }
  const epoch = epochAt(config, state.nowS);
  const approved = [...state.subs.values()]
    .filter((s) => s.status === 'approved')
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ name: s.name, payload: s.payload }));
  return {
    epoch,
    assignments: assignmentsAt(config, epoch),
    assignmentFor: (pid) => assignmentFor(config, pid, epoch),
    results: computeContinueResults({ config, approved }),
  };
}

/* ------------------------------------------------------------ deck checks */

/** Sanity-check content/room-relay-prompts.json (run by the tests). */
export function validateDeck(deck) {
  const problems = [];
  if (!deck || typeof deck !== 'object') return ['deck is not an object'];
  if (!Number.isInteger(deck.version)) problems.push('missing integer version');
  for (const key of ['doodle', 'phrase', 'headline', 'seedHeadlines']) {
    const list = deck[key];
    if (!Array.isArray(list) || list.length < 5) { problems.push(`${key}: needs 5+ entries`); continue; }
    list.forEach((p, i) => {
      if (typeof p !== 'string' || !p.trim() || p.length > RELAY.textLen) problems.push(`${key}[${i}]: bad prompt`);
    });
  }
  (deck.seedHeadlines ?? []).forEach((t, i) => {
    if (typeof t === 'string' && !t.includes('{top}')) problems.push(`seedHeadlines[${i}]: missing {top}`);
  });
  return problems;
}

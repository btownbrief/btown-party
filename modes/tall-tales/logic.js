// TALL TALES — pure round math. No DOM, no network, no clock, no
// Math.random: plain JSON in, plain JSON out, so scripts/test-tall-tales.mjs
// can drive every edge in Node. All rendering lives in mode.js; if a number
// matters, it is computed here and nowhere else.
//
// The loop runs as TWO shell rounds per fact, because the shell gives a
// mode exactly one phone surface (the collect phase) per round:
//   Round A (phase 'lies')  — phones fill the blank with one plausible lie;
//     the host moderates; the stored results carry the approved lies.
//   Round B (phase 'vote')  — the host console builds a seeded-shuffled
//     ballot (approved lies + the truth) into the round CONFIG (host-
//     authored, so it may reach phones), phones vote for the truth, and the
//     reveal pays out: find the truth, get points; fool a voter, get points.
//
// The truth, authors, and source ride in the vote round's config because
// computeResults sees nothing else — a determined phone could read them in
// devtools, but every fact here is a googleable public story, so the source
// link is a bigger "cheat" than the config. The social contract holds it.

export const SLUG = 'tall-tales';

export const SCORING = {
  truthPoints: 100,  // for voting for the truth (or having WRITTEN it)
  fooledPoints: 50,  // per voter your lie took in
};

export const LIE_MAX_LEN = 80;
export const MAX_LIE_BEATS = 8; // solo beats; lower-vote lies group into one

/* ------------------------------------------------------- tiny primitives */

/** Case/space-insensitive form used for duplicate + truth matching. */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
}

/** FNV-1a over a string → a positive 32-bit seed. Deterministic. */
export function seedFrom(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 2147483646) + 1;
}

/** Seeded Fisher–Yates (Park–Miller LCG, same family as party-core's).
 *  Same array + same seed → same order, every runtime. */
export function seededShuffle(arr, seed) {
  const out = [...arr];
  // Scramble the seed first (Wang-style integer hash): a raw LCG keeps
  // adjacent seeds correlated for several draws, which on a 3-entry
  // ballot means seed 7 and seed 8 could deal the same order.
  let m = seed >>> 0;
  m = Math.imul(m ^ (m >>> 16), 0x45d9f3b) >>> 0;
  m = Math.imul(m ^ (m >>> 16), 0x45d9f3b) >>> 0;
  m ^= m >>> 16;
  let s = (m >>> 0) % 2147483647 || 1;
  const next = () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* --------------------------------------------------------- input hygiene */

/** Clamp a raw phone payload into a legal lie, or null if hopeless. */
export function cleanLie(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const text = String(payload.text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIE_MAX_LEN)
    .trim();
  return text ? { text } : null;
}

/** Clamp a raw phone payload into a legal vote against this ballot. */
export function cleanVote(payload, ballot) {
  if (!payload || typeof payload !== 'object') return null;
  const key = payload.key;
  if (typeof key !== 'string') return null;
  const entry = (ballot?.entries ?? []).find((e) => e.key === key);
  return entry ? { key } : null;
}

/* ------------------------------------------------------------ the ballot */

/**
 * Approved lies + the truth → one shuffled, keyed ballot. Host console
 * builds this at vote-open time and stores it in the round config.
 *   fact: { id, setup, answer }   lies: [{ name, text }]  (APPROVED only —
 *   the shell's moderation queue is the gate; nothing else ever gets here)
 *
 * Duplicate lies merge into one entry crediting every author. A lie that
 * IS the truth (normalized match) never becomes a ballot entry — its
 * authors are recorded as truthMatchers and paid truth points at scoring,
 * which is also the safety net under the host's hold-the-near-truths pass.
 */
export function buildBallot({ fact, lies, seed }) {
  const answer = String(fact?.answer ?? '');
  if (!fact?.id || !answer) throw new Error('bad_fact');
  const truthNorm = normalizeText(answer);

  const truthMatchers = [];
  const byText = new Map(); // normalized text → { text, authors }
  for (const l of lies ?? []) {
    const clean = cleanLie(l?.payload ? l.payload : { text: l?.text });
    const name = String(l?.name ?? '').trim();
    if (!clean || !name) continue;
    const norm = normalizeText(clean.text);
    if (norm === truthNorm) {
      if (!truthMatchers.includes(name)) truthMatchers.push(name);
      continue;
    }
    const slot = byText.get(norm) ?? { text: clean.text, authors: [] };
    if (!slot.authors.includes(name)) slot.authors.push(name);
    byText.set(norm, slot);
  }

  const raw = [
    ...[...byText.values()].map((e) => ({ text: e.text, authors: e.authors, truth: false })),
    { text: answer, authors: [], truth: true },
  ];
  const order = seededShuffle(raw, seed ?? seedFrom(`${fact.id}|${raw.length}`));
  const entries = order.map((e, i) => ({ key: `e${i}`, ...e }));
  return {
    entries,
    truthKey: entries.find((e) => e.truth).key,
    truthMatchers,
  };
}

/* --------------------------------------------------------- round results */

/** Round A: approved lies → the stored bridge results (and the lie list
 *  the host console will build the ballot from, via doneResults). */
export function computeLiesResults({ config, approved }) {
  const fact = config?.fact;
  if (!fact?.id || !fact?.setup) throw new Error('bad_config');
  const lies = (approved ?? []).flatMap((s) => {
    const clean = cleanLie(s.payload);
    const name = String(s?.name ?? '').trim();
    return clean && name ? [{ name, text: clean.text }] : [];
  });
  return {
    mode: SLUG,
    phase: 'lies',
    fact: { id: fact.id, setup: fact.setup },
    lies,
    count: lies.length,
    beatPlan: [{ kind: 'bridge' }],
  };
}

/**
 * Round B: approved votes + the config's ballot → the full reveal.
 * Self-votes (a vote for an entry you authored) are discarded — you cannot
 * vote for your own lie. Two people who joined under the same first name
 * share that fate; a mixer survives it.
 */
export function computeVoteResults({ config, approved }) {
  const fact = config?.fact;
  const ballot = config?.ballot;
  if (!fact?.id || !fact?.answer || !Array.isArray(ballot?.entries) || !ballot.truthKey) {
    throw new Error('bad_config');
  }

  const matcherSet = new Set(ballot.truthMatchers ?? []);
  const votesByKey = new Map(ballot.entries.map((e) => [e.key, []]));
  for (const s of approved ?? []) {
    const v = cleanVote(s.payload, ballot);
    const name = String(s?.name ?? '').trim();
    if (!v || !name) continue; // malformed votes sit the round out
    const entry = ballot.entries.find((e) => e.key === v.key);
    if (entry.authors.includes(name)) continue; // own-lie vote: discarded
    // A truth-WRITER voting for the truth is voting for their own entry in
    // spirit: discard it too, or they would collect the truth award twice
    // (once as finder, once as matcher).
    if (entry.truth && matcherSet.has(name)) continue;
    votesByKey.get(v.key).push(name);
  }

  const entries = ballot.entries.map((e) => ({
    key: e.key,
    text: e.text,
    authors: [...e.authors],
    truth: !!e.truth,
    voters: votesByKey.get(e.key),
    votes: votesByKey.get(e.key).length,
  }));
  const truthEntry = entries.find((e) => e.key === ballot.truthKey);
  const truthFinders = [...truthEntry.voters];
  const truthMatchers = [...(ballot.truthMatchers ?? [])];

  // Scores: truth found (or written), plus per-voter-fooled lie pay.
  const points = new Map();
  const add = (name, pts) => points.set(name, (points.get(name) ?? 0) + pts);
  for (const name of truthFinders) add(name, SCORING.truthPoints);
  for (const name of truthMatchers) add(name, SCORING.truthPoints);
  const liars = [];
  for (const e of entries) {
    if (e.truth) continue;
    for (const author of e.authors) {
      add(author, SCORING.fooledPoints * e.votes);
      const row = liars.find((l) => l.name === author) ?? (liars[liars.push({ name: author, fooled: 0 }) - 1]);
      row.fooled += e.votes;
    }
  }
  const scores = [...points.entries()]
    .map(([name, pts]) => ({ name, points: pts }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  const topFooled = liars.length ? Math.max(...liars.map((l) => l.fooled)) : 0;
  const bestLiars = topFooled > 0
    ? liars.filter((l) => l.fooled === topFooled).map((l) => l.name).sort()
    : [];

  return {
    mode: SLUG,
    phase: 'vote',
    fact: {
      id: fact.id,
      setup: fact.setup,
      answer: fact.answer,
      source: fact.source ? { ...fact.source } : null,
    },
    entries,
    truthKey: ballot.truthKey,
    truthFinders,
    truthMatchers,
    liars,
    bestLiars,
    scores,
    beatPlan: voteBeatPlan(entries),
  };
}

/**
 * The staged reveal, planned at compute time so beatCount and both reveal
 * surfaces derive from stored results alone. Lies land ascending by vote
 * count (suspense), zero-vote lies grouped into one merciful beat, and
 * with more than MAX_LIE_BEATS voted lies the low end groups too — the
 * plan stays comfortably under the backend's 40-step reveal cap. The
 * SOURCE beat is always in the plan: the citation is part of the game.
 */
export function voteBeatPlan(entries) {
  const lies = entries.filter((e) => !e.truth);
  const duds = lies.filter((e) => e.votes === 0);
  const voted = lies.filter((e) => e.votes > 0)
    .sort((a, b) => a.votes - b.votes || a.key.localeCompare(b.key, 'en', { numeric: true }));
  const grouped = voted.length > MAX_LIE_BEATS ? voted.slice(0, voted.length - MAX_LIE_BEATS) : [];
  const solo = voted.slice(grouped.length);
  return [
    { kind: 'setup' },
    { kind: 'ballot' },
    ...(duds.length ? [{ kind: 'duds', keys: duds.map((e) => e.key) }] : []),
    ...(grouped.length ? [{ kind: 'liesGroup', keys: grouped.map((e) => e.key) }] : []),
    ...solo.map((e) => ({ kind: 'lie', keys: [e.key] })),
    { kind: 'liar' },
    { kind: 'truth' },
    { kind: 'source' },
    { kind: 'board' },
  ];
}

/* ----------------------------------------------------- vote-round config */

/** UTF-8 byte size of a JSON value — the backend's config limit counts
 *  bytes, and JSON.stringify().length counts UTF-16 code units, which
 *  undercounts every emoji and accent a room full of phones will type. */
export function configBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export const MAX_CONFIG_BYTES = 7500; // headroom under the backend's 8192

/**
 * The whole vote-round config, built pure and guaranteed to fit the
 * backend's byte budget: if a packed room's ballot would blow the limit,
 * the LONGEST lies are dropped (later submissions first on a length tie)
 * until it fits — the round stays playable and the host is told exactly
 * whose lies were left off, instead of the vote dead-ending after the
 * lies round has already been moderated and wrapped.
 * Returns { config, dropped } — dropped is [{ name, text }].
 */
export function buildVoteConfig({ fact, lies, liesRound, seed, maxBytes = MAX_CONFIG_BYTES }) {
  const kept = [...(lies ?? [])];
  const dropped = [];
  for (;;) {
    const ballot = buildBallot({ fact, lies: kept, seed });
    const config = {
      phase: 'vote',
      fact: {
        id: fact.id,
        setup: fact.setup,
        answer: fact.answer,
        source: fact.source
          ? { ...fact.source }
          : { url: fact.sourceUrl, title: fact.sourceTitle, quote: fact.sourceQuote },
      },
      ...(liesRound ? { liesRound } : {}),
      ballot,
    };
    if (configBytes(config) <= maxBytes || !kept.length) {
      return { config, dropped };
    }
    let worst = 0;
    for (let i = 1; i < kept.length; i++) {
      if (String(kept[i]?.text ?? '').length >= String(kept[worst]?.text ?? '').length) worst = i;
    }
    dropped.push(kept.splice(worst, 1)[0]);
  }
}

/** Shell → mode dispatch: one entry point for both round shapes. */
export function computeResults({ config, approved }) {
  return config?.phase === 'vote'
    ? computeVoteResults({ config, approved })
    : computeLiesResults({ config, approved });
}

export function beatCount(results) {
  return results?.beatPlan?.length || 1;
}

/* ------------------------------------------------------------ the boards */

/**
 * The running "silver tongue" board across every revealed vote round —
 * truth-finding and fooling both feed it. Keyed by first name as entered.
 */
export function scoreboard(resultsList) {
  const rows = new Map();
  for (const r of resultsList ?? []) {
    if (!r || r.mode !== SLUG || r.phase !== 'vote') continue;
    for (const s of r.scores ?? []) {
      const row = rows.get(s.name) ?? { name: s.name, points: 0, rounds: 0 };
      row.points += s.points;
      row.rounds += 1;
      rows.set(s.name, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.points - a.points || a.rounds - b.rounds || a.name.localeCompare(b.name),
  );
}

/* -------------------------------------------------------- narrated beats */

const names = (list, sep = ' and ') => list.join(sep);
const q = (text) => `“${text}”`;

/** Everything the narrated view needs: what the host reads aloud per beat.
 *  This surface equals the screen in polish — no-TV venues live on it. */
export function narratedBeat(step, results, board) {
  const r = results;
  const plan = r?.beatPlan?.length ? r.beatPlan : [{ kind: 'bridge' }];
  const beat = plan[Math.max(0, Math.min(step, plan.length - 1))];
  const byKey = (k) => r.entries.find((e) => e.key === k);
  switch (beat.kind) {
    case 'bridge':
      return {
        kind: 'bridge', title: 'The tall tales are in',
        lines: r.count
          ? [`${r.count} ${r.count === 1 ? 'lie' : 'lies'} about: ${r.fact.setup}`, 'Phones out — the vote is next.']
          : ['Nobody lied this time — the truth stands alone.', 'Phones out — the vote is next.'],
      };
    case 'setup':
      return { kind: 'setup', title: 'One of these is true', lines: [r.fact.setup] };
    case 'ballot':
      return { kind: 'ballot', title: 'The ballot', lines: r.entries.map((e) => e.text) };
    case 'duds': {
      const rows = beat.keys.map(byKey).map((e) => `${q(e.text)} — ${names(e.authors, ' & ')}, fooled nobody`);
      return { kind: 'duds', title: 'Fooled nobody', lines: rows };
    }
    case 'liesGroup': {
      const rows = beat.keys.map(byKey).map((e) => `${q(e.text)} — ${names(e.authors, ' & ')}, fooled ${e.votes}`);
      return { kind: 'liesGroup', title: 'The lies start falling', lines: rows };
    }
    case 'lie': {
      const e = byKey(beat.keys[0]);
      return {
        kind: 'lie', title: `This one fooled ${e.votes}`,
        lines: [q(e.text), `That was ${names(e.authors, ' & ')} — it took in ${names(e.voters, ', ')}.`],
      };
    }
    case 'liar':
      return r.bestLiars.length
        ? {
          kind: 'liar', title: 'Silver tongue of the round',
          lines: [names(r.bestLiars), `Fooled ${r.liars.find((l) => l.name === r.bestLiars[0]).fooled} vote${r.liars.find((l) => l.name === r.bestLiars[0]).fooled === 1 ? '' : 's'}. Round of applause.`],
        }
        : { kind: 'liar', title: 'Silver tongue of the round', lines: ['Nobody fooled anybody — this room reads clean.'] };
    case 'truth': {
      const lines = [r.fact.answer];
      lines.push(r.truthFinders.length
        ? `Found by ${names(r.truthFinders, ', ')}.`
        : 'Nobody found it.');
      if (r.truthMatchers.length) {
        lines.push(`${names(r.truthMatchers)} WROTE the truth — full points.`);
      }
      return { kind: 'truth', title: 'The truth', lines };
    }
    case 'source': {
      const s = r.fact.source;
      return {
        kind: 'source', title: 'The source',
        lines: s
          ? [s.title, ...(s.quote ? [q(s.quote)] : []), s.url]
          : ['Verified from the Btown Brief’s files.'],
      };
    }
    default: {
      const rows = (board ?? []).slice(0, 5);
      return {
        kind: 'board', title: 'Silver tongues tonight',
        lines: rows.length
          ? rows.map((row, i) => `${i + 1}. ${row.name} — ${row.points}`)
          : ['First tales go on the board next time!'],
      };
    }
  }
}

/* --------------------------------------------------------- the fact deck */

/** Sanity-check content/talltales-facts.json (also run by the tests). */
export function validateFacts(deck) {
  const problems = [];
  if (!deck || typeof deck !== 'object') return ['deck is not an object'];
  if (!Number.isInteger(deck.version)) problems.push('missing integer version');
  if (!Array.isArray(deck.facts) || !deck.facts.length) {
    problems.push('missing facts array');
    return problems;
  }
  const ids = new Set();
  deck.facts.forEach((f, i) => {
    const at = `facts[${i}]`;
    if (!/^tt-[0-9]{3,}$/.test(f?.id ?? '')) problems.push(`${at}: bad id`);
    if (ids.has(f?.id)) problems.push(`${at}: duplicate id ${f.id}`);
    ids.add(f?.id);
    if (typeof f?.setup !== 'string' || f.setup.trim().length < 10 || f.setup.length > 220) {
      problems.push(`${at}: bad setup`);
    } else if (!f.setup.includes('___')) {
      problems.push(`${at}: setup has no ___ blank`);
    }
    if (typeof f?.answer !== 'string' || !f.answer.trim() || f.answer.length > 140) {
      problems.push(`${at}: bad answer`);
    }
    if (typeof f?.category !== 'string' || !f.category.trim()) problems.push(`${at}: bad category`);
    if (typeof f?.sourceUrl !== 'string' || !/^https?:\/\//.test(f.sourceUrl)) {
      problems.push(`${at}: bad sourceUrl`);
    }
    if (typeof f?.sourceTitle !== 'string' || !f.sourceTitle.trim() || f.sourceTitle.length > 160) {
      problems.push(`${at}: bad sourceTitle`);
    }
    if (typeof f?.sourceQuote !== 'string' || !f.sourceQuote.trim() || f.sourceQuote.length > 400) {
      problems.push(`${at}: bad sourceQuote`);
    }
    if (typeof f?.needsReview !== 'boolean') problems.push(`${at}: needsReview must be boolean`);
  });
  return problems;
}

/**
 * THE CURATION GATE. Only facts Stephen has explicitly flipped to
 * needsReview:false are pickable by default — a missing or truthy flag
 * means NOT verified, never the other way around. showUnreviewed exists
 * for his couch testing only; live rooms never see an unverified fact.
 */
export function pickableFacts(deck, { showUnreviewed = false } = {}) {
  const facts = deck?.facts ?? [];
  return showUnreviewed ? [...facts] : facts.filter((f) => f?.needsReview === false);
}

export function factById(deck, id) {
  return (deck?.facts ?? []).find((f) => f.id === id) ?? null;
}

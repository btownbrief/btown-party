// THE ROOM KNOWS — pure round math. No DOM, no network, no clock: plain
// JSON in, plain JSON out, so scripts/test-room-knows.mjs can drive every
// edge in Node. All rendering lives in mode.js; if a number matters, it is
// computed here and nowhere else.
//
// The loop: at check-in the room privately answered tonight's questions.
// A round points at one of them; every phone guesses which option the room
// picked AND what percent of the room picked it. computeResults() turns the
// approved guesses + the anonymous check-in tally into one results object
// that the host console stores on the round; the screen and narrated views
// only ever render that stored object.

export const SLUG = 'room-knows';

export const SCORING = {
  winnerPickPoints: 100, // for picking the option the room actually chose
  closenessMax: 100,     // slides to 0 as the percent guess drifts 100 points off
};

/** Clamp a raw phone payload into a legal guess, or null if hopeless. */
export function cleanGuess(payload, optionCount) {
  if (!payload || typeof payload !== 'object') return null;
  const pick = payload.pick;
  const pct = payload.pct;
  if (!Number.isInteger(pick) || pick < 0 || pick >= optionCount) return null;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return { pick, pct: Math.min(100, Math.max(0, Math.round(pct))) };
}

/**
 * The one aggregation.
 *   config:   { question: {id, text, options} }  (host-picked at round open)
 *   tally:    { counts: [int per option], total }  (anonymous check-in counts)
 *   approved: [{ name, payload }]  — APPROVED submissions only; the caller
 *             (host console via the shell) enforces the moderation gate,
 *             and the backend re-enforces it at start_reveal.
 */
export function computeResults({ config, tally, approved }) {
  const question = config?.question;
  const options = question?.options ?? [];
  if (!question || options.length < 2) throw new Error('bad_config');

  const counts = options.map((_, i) => Math.max(0, tally?.counts?.[i] ?? 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const emptyRoom = total === 0;

  // Exact percents drive the scoring; rounded ones drive the display.
  const exact = counts.map((c) => (emptyRoom ? 0 : (c * 100) / total));
  const percents = exact.map((p) => Math.round(p));

  const top = Math.max(...counts);
  const winners = emptyRoom ? [] : counts.flatMap((c, i) => (c === top ? [i] : []));

  const guesses = (approved ?? []).flatMap((s) => {
    const g = cleanGuess(s.payload, options.length);
    if (!g) return []; // a malformed payload just sits the round out
    const pickedWinner = winners.includes(g.pick);
    // Your percent guess is judged against the option YOU picked, so a
    // wrong pick can still earn accuracy points — porous, never punishing.
    const error = emptyRoom ? null : Math.abs(g.pct - exact[g.pick]);
    const score = emptyRoom ? 0
      : (pickedWinner ? SCORING.winnerPickPoints : 0)
        + Math.max(0, Math.round(SCORING.closenessMax - error));
    return [{ name: s.name, pick: g.pick, pct: g.pct, pickedWinner, error, score }];
  });

  // "Closest reader of the room": smallest percent error, ties all called out.
  let closest = [];
  if (!emptyRoom && guesses.length) {
    const best = Math.min(...guesses.map((g) => g.error));
    closest = guesses.filter((g) => g.error === best).map((g) => g.name);
  }

  return {
    mode: SLUG,
    question: { id: question.id, text: question.text, options: [...options] },
    counts,
    total,
    percents,
    winners,
    emptyRoom,
    guesses,
    closest,
  };
}

/**
 * Running "reads the room best" board across every revealed round.
 * Keyed by first name as entered — two people who both joined as "Sam"
 * share a line, which a mixer survives; the host can ask for a last initial.
 */
export function scoreboard(resultsList) {
  const rows = new Map();
  for (const r of resultsList ?? []) {
    if (!r || r.mode !== SLUG) continue;
    for (const g of r.guesses ?? []) {
      const row = rows.get(g.name) ?? { name: g.name, points: 0, rounds: 0 };
      row.points += g.score;
      row.rounds += 1;
      rows.set(g.name, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.points - a.points || a.rounds - b.rounds || a.name.localeCompare(b.name),
  );
}

/**
 * The staged reveal, beat by beat. The shell stores only an integer step;
 * both the screen and the narrated view render beat[step]. Keep the beats
 * few and fat — each one is a moment Stephen narrates, not a slide deck.
 */
export const BEATS = ['question', 'options', 'drumroll', 'bars', 'readers', 'scoreboard'];

export function beatCount() {
  return BEATS.length;
}

/** Everything the narrated view needs: what Stephen reads aloud per beat. */
export function narratedBeat(step, results, board) {
  const r = results;
  const kind = BEATS[Math.max(0, Math.min(step, BEATS.length - 1))];
  const pct = (i) => `${r.percents[i]}%`;
  switch (kind) {
    case 'question':
      return { kind, title: 'The question', lines: [r.question.text] };
    case 'options':
      return { kind, title: 'The choices were', lines: r.question.options };
    case 'drumroll':
      return {
        kind, title: 'Drumroll',
        lines: [`${r.total} of you answered at check-in.`, 'What did this room say?'],
      };
    case 'bars': {
      if (r.emptyRoom) {
        return { kind, title: 'The answer', lines: ['Nobody answered this one at check-in — free round!'] };
      }
      const order = r.counts.map((_, i) => i).sort((a, b) => r.counts[b] - r.counts[a]);
      return {
        kind, title: 'The room says…',
        lines: order.map((i) => `${r.question.options[i]} — ${pct(i)}`),
      };
    }
    case 'readers': {
      if (r.emptyRoom || !r.closest.length) {
        return { kind, title: 'Closest reader', lines: ['No guesses this round — the room stays mysterious.'] };
      }
      const best = Math.round(Math.min(...r.guesses.map((g) => g.error)));
      return {
        kind, title: 'Closest reader of the room',
        lines: [r.closest.join(' and '), `Called it within ${best} point${best === 1 ? '' : 's'} of the real number.`],
      };
    }
    case 'scoreboard': {
      const rows = (board ?? []).slice(0, 5);
      return {
        kind, title: 'Reads the room best',
        lines: rows.length ? rows.map((row, i) => `${i + 1}. ${row.name} — ${row.points}`) : ['First round on the board next time!'],
      };
    }
    default:
      return { kind: 'question', title: '', lines: [] };
  }
}

/** Sanity-check content/roomknows-questions.json (also run by the tests). */
export function validateDeck(deck) {
  const problems = [];
  if (!deck || typeof deck !== 'object') return ['deck is not an object'];
  if (!Number.isInteger(deck.version)) problems.push('missing integer version');
  if (!Array.isArray(deck.questions) || !deck.questions.length) {
    problems.push('missing questions array');
    return problems;
  }
  const ids = new Set();
  deck.questions.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (!/^rk-[0-9]{3,}$/.test(q?.id ?? '')) problems.push(`${at}: bad id`);
    if (ids.has(q?.id)) problems.push(`${at}: duplicate id ${q.id}`);
    ids.add(q?.id);
    if (typeof q?.text !== 'string' || !q.text.trim() || q.text.length > 200) {
      problems.push(`${at}: bad text`);
    }
    if (!Array.isArray(q?.options) || q.options.length < 2 || q.options.length > 4) {
      problems.push(`${at}: needs 2-4 options`);
    } else if (q.options.some((o) => typeof o !== 'string' || !o.trim() || o.length > 60)) {
      problems.push(`${at}: bad option`);
    }
    if (!Array.isArray(q?.tags) || q.tags.some((t) => typeof t !== 'string')) {
      problems.push(`${at}: bad tags`);
    }
  });
  return problems;
}

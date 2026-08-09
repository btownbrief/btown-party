// TALL TALES — mode module (UI + wiring). All math lives in logic.js; this
// file only renders and dispatches, per the fleet rule. It implements the
// mode contract in MODE-INTEGRATION.md, shaped on modes/room-knows/mode.js.
//
// One fact plays as TWO shell rounds (see logic.js header): a 'lies' round
// (phones write one plausible lie each) and a 'vote' round (phones pick the
// truth from the host-approved ballot). hostSetup drives both: after a lies
// round wraps, it offers "open the vote" built from that round's stored
// results; otherwise it shows the fact picker — REVIEWED FACTS ONLY by
// default. The unreviewed toggle is for Stephen's couch testing, never for
// a live room, and every unreviewed fact is branded UNVERIFIED.

import {
  SLUG, LIE_MAX_LEN, normalizeText, buildVoteConfig, seedFrom,
  computeResults as compute, scoreboard, beatCount as beats,
  narratedBeat, pickableFacts, factById,
} from './logic.js';

export const slug = SLUG;
export const title = 'Tall Tales';
export const tagline = 'One Burlington fact, a room full of lies — find the truth.';

/* ------------------------------------------------------------- the deck */

let deckPromise = null;
function loadDeck() {
  deckPromise ??= fetch(new URL('./content/talltales-facts.json', import.meta.url))
    .then((res) => res.json())
    .catch(() => ({ version: 0, facts: [] }));
  return deckPromise;
}

/* ------------------------------------------------------------ host setup */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** My finished rounds tonight, oldest first. */
const myDone = (event) => (event.doneResults ?? []).filter((d) => d.mode === slug);

export function hostSetup(ctx, mount) {
  mount.innerHTML = '';
  const wrap = el('div');
  wrap.dataset.mode = slug;
  wrap.appendChild(el('p', 'host-hint dim', 'Loading the fact deck…'));
  mount.appendChild(wrap);
  loadDeck().then((deck) => renderHostSetup(ctx, wrap, deck));
}

function renderHostSetup(ctx, wrap, deck) {
  wrap.innerHTML = '';
  const done = myDone(ctx.event);
  const last = done[done.length - 1];

  // A wrapped lies round with no vote yet → the vote is the next move.
  if (last?.results?.phase === 'lies') {
    renderVoteOffer(ctx, wrap, deck, last);
    wrap.appendChild(el('p', 'host-hint dim', '…or shelve that fact and start a fresh one:'));
  }
  renderFactPicker(ctx, wrap, deck, done);

  const pod = el('p', 'host-hint small dim');
  const podLink = el('a', null, 'Pod play — a table of 3–6 runs itself through three facts on one phone.');
  podLink.id = `mode-${slug}-pod-link`;
  podLink.href = new URL('./pod.html', import.meta.url);
  podLink.target = '_blank';
  pod.appendChild(podLink);
  wrap.appendChild(pod);
}

function renderVoteOffer(ctx, wrap, deck, liesEntry) {
  const liesResults = liesEntry.results;
  const fact = factById(deck, liesResults.fact.id);
  wrap.appendChild(el('p', 'host-hint',
    `The lies are in for: “${liesResults.fact.setup}”`));
  if (!fact) {
    wrap.appendChild(el('p', 'error-line', 'That fact is missing from the deck — pick a fresh one below.'));
    return;
  }
  const n = liesResults.lies.length;
  const btn = el('button', 'big-btn',
    `Open the vote — ${n} ${n === 1 ? 'lie' : 'lies'} + the truth`);
  btn.id = `mode-${slug}-open-vote`;
  btn.addEventListener('click', async () => {
    // buildVoteConfig guarantees the config fits the backend's byte budget;
    // in a packed room the longest lies are dropped rather than the vote
    // dead-ending after the lies round has already wrapped.
    const { config, dropped } = buildVoteConfig({
      fact,
      lies: liesResults.lies,
      liesRound: liesEntry.id,
      seed: seedFrom(`${fact.id}|${liesResults.lies.map((l) => l.text).join('|')}`),
    });
    if (dropped.length) {
      btn.insertAdjacentElement('afterend', el('p', 'error-line',
        `The ballot was over the wire limit — the longest ${dropped.length === 1 ? 'lie' : `${dropped.length} lies`} (${dropped.map((d) => d.name).join(', ')}) had to sit out.`));
    }
    btn.disabled = true;
    try {
      await ctx.openRound(config);
    } finally {
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
}

function renderFactPicker(ctx, wrap, deck, done) {
  const playedIds = new Set(done.map((d) => d.results?.fact?.id).filter(Boolean));
  const list = el('div');
  wrap.appendChild(list);
  let showUnreviewed = false;

  const paint = () => {
    list.innerHTML = '';
    const facts = pickableFacts(deck, { showUnreviewed });
    if (!facts.length) {
      list.appendChild(el('p', 'host-hint',
        'No facts have passed review yet. Flip needsReview to false in the deck once a source checks out — unverified facts never reach a live room.'));
    } else {
      list.appendChild(el('p', 'host-hint',
        'Pick tonight’s fact — everyone fills the blank with a lie, then the room hunts the truth.'));
    }
    facts.forEach((f) => {
      const unverified = f.needsReview !== false;
      const btn = el('button', 'question-pick');
      btn.id = `mode-${slug}-pick-${f.id}`;
      const text = el('span', 'qp-text', f.setup);
      const meta = el('span', 'qp-meta',
        `${unverified ? 'UNVERIFIED · ' : ''}${f.category}${playedIds.has(f.id) ? ' · already played' : ''}`);
      if (playedIds.has(f.id)) btn.classList.add('played');
      btn.append(text, meta);
      btn.addEventListener('click', () => ctx.openRound({
        // Lies-round config deliberately omits the answer and source: config
        // reaches every phone while the room is still inventing lies.
        phase: 'lies',
        fact: { id: f.id, setup: f.setup, category: f.category },
      }));
      list.appendChild(btn);
    });
  };
  paint();

  // The unreviewed toggle exists ONLY on demo pages (?demo=1 couch
  // rehearsal). A live host console never offers a way to put an
  // unverified fact in front of a room.
  if (new URLSearchParams(globalThis.location?.search ?? '').get('demo') === '1') {
    const toggleWrap = el('label', 'host-hint small dim');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = `mode-${slug}-show-unreviewed`;
    toggle.addEventListener('change', () => {
      showUnreviewed = toggle.checked;
      paint();
    });
    toggleWrap.append(toggle, ' Show unreviewed facts — couch testing only, never for a live room.');
    wrap.appendChild(toggleWrap);
  }
}

/* ------------------------------------------------------------ moderation */

/** One line per entry in the shell's moderation list. */
export function describeSubmission(payload, config) {
  if (config?.phase === 'vote') {
    const entry = (config.ballot?.entries ?? []).find((e) => e.key === payload?.key);
    if (!entry) return '(not a vote)';
    const snip = entry.text.length > 44 ? `${entry.text.slice(0, 43)}…` : entry.text;
    return `voted: “${snip}”`;
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  return text ? `“${text}”` : '(not a lie)';
}

/* ----------------------------------------------------------- phone input */

// The phone remembers its own lie per LIES ROUND (not per fact — a replayed
// fact must never let a stale lie disable a fresh legal vote) so the vote
// round can refuse a self-vote client-side too (logic.js discards them
// again at scoring). The vote config carries the lies round's id.
const ownLieKey = (roundId) => `btown-tt-own-lie-${roundId}`;
const stash = (roundId, text) => {
  try { sessionStorage.setItem(ownLieKey(roundId), normalizeText(text)); } catch { /* private mode */ }
};
const stashed = (roundId) => {
  if (!roundId) return '';
  try { return sessionStorage.getItem(ownLieKey(roundId)) ?? ''; } catch { return ''; }
};

export function phoneCollect(ctx, mount) {
  const config = ctx.round.config ?? {};
  mount.innerHTML = '';
  const wrap = el('div');
  wrap.dataset.mode = slug;
  mount.appendChild(wrap);
  if (config.phase === 'lies' && config.fact?.setup) renderLieInput(ctx, wrap, config);
  else if (config.phase === 'vote' && config.ballot?.entries?.length) renderVote(ctx, wrap, config);
  else wrap.appendChild(el('p', 'dim', 'This round is happening in the room — eyes up.'));
}

function renderLieInput(ctx, wrap, config) {
  wrap.appendChild(el('p', 'collect-ask', 'Fill the blank with a LIE'));
  wrap.appendChild(el('h2', 'collect-question', config.fact.setup));
  wrap.appendChild(el('p', 'dim small',
    'Plausible beats funny — you score for every vote your lie fools.'));

  const input = document.createElement('input');
  input.type = 'text';
  input.id = `mode-${slug}-lie`;
  input.maxLength = LIE_MAX_LEN;
  input.placeholder = 'your convincing lie…';
  input.autocomplete = 'off';
  wrap.appendChild(input);

  const send = el('button', 'big-btn', 'Lock in the lie');
  send.id = `mode-${slug}-send`;
  send.disabled = true;
  input.addEventListener('input', () => { send.disabled = !input.value.trim(); });
  send.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      stash(ctx.round.id, text);
      await ctx.submit({ kind: 'lie', text });
    } catch {
      send.disabled = false;
      send.textContent = 'Try again';
    }
  });
  wrap.appendChild(send);
}

function renderVote(ctx, wrap, config) {
  wrap.appendChild(el('p', 'collect-ask', 'One of these is TRUE'));
  wrap.appendChild(el('h2', 'collect-question', config.fact?.setup ?? ''));

  const own = stashed(config.liesRound);
  let picked = null;
  const buttons = config.ballot.entries.map((entry) => {
    const b = el('button', 'collect-opt', entry.text);
    b.id = `mode-${slug}-vote-${entry.key}`;
    if (own && normalizeText(entry.text) === own) {
      b.disabled = true;
      b.appendChild(el('span', 'dim small', ' — your tall tale'));
    }
    b.addEventListener('click', () => {
      picked = entry.key;
      buttons.forEach((x) => x.classList.toggle('sel', x === b));
      send.disabled = false;
    });
    wrap.appendChild(b);
    return b;
  });

  const send = el('button', 'big-btn', 'Lock it in');
  send.id = `mode-${slug}-send`;
  send.disabled = true;
  send.addEventListener('click', async () => {
    if (picked == null) return;
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await ctx.submit({ kind: 'vote', key: picked });
    } catch {
      send.disabled = false;
      send.textContent = 'Try again';
    }
  });
  wrap.appendChild(send);
}

/* -------------------------------------------------------------- the math */

/** Shell → mode: turn approved inputs into the stored results object. */
export function computeResults({ config, approved }) {
  return compute({ config, approved });
}

export function beatCount(results) {
  return beats(results);
}

/** Big lines the host reads aloud — the narrated-reveal view renders this. */
export function narrated(step, results, doneResults) {
  return narratedBeat(step, results, boardFrom(doneResults, results));
}

function boardFrom(doneResults, current) {
  const all = (doneResults ?? []).filter((d) => d.mode === slug).map((d) => d.results);
  if (current && !all.includes(current)) all.push(current);
  return scoreboard(all);
}

/* ------------------------------------------------------------ the screen */

/** One beat on the big screen, driven by results.beatPlan (computed in
 *  logic.js). Big enough to read across a café; .land animates entrances. */
export function renderBeat(mount, step, results, doneResults) {
  const r = results;
  mount.innerHTML = '';
  const root = el('div');
  root.dataset.mode = slug;
  root.id = `mode-${slug}-beat`;
  root.dataset.step = String(step);
  mount.appendChild(root);
  const h = (cls, text, tag = 'div') => root.appendChild(el(tag, cls, text));
  const plan = r?.beatPlan?.length ? r.beatPlan : [{ kind: 'bridge' }];
  const beat = plan[Math.max(0, Math.min(step, plan.length - 1))];
  const byKey = (k) => r.entries.find((e) => e.key === k);
  const rows = (keys, showVotes) => {
    const list = el('div', 'beat-options');
    keys.map(byKey).forEach((e, i) => {
      const row = el('div', 'beat-option land',
        `“${e.text}” — ${e.authors.join(' & ')}${showVotes ? `, fooled ${e.votes}` : ', fooled nobody'}`);
      row.style.animationDelay = `${i * 0.35}s`;
      list.appendChild(row);
    });
    root.appendChild(list);
  };

  switch (beat.kind) {
    case 'bridge':
      h('beat-kicker land', 'Tall Tales');
      h('beat-question small', r.fact.setup, 'h2');
      h('beat-drumroll land', r.count
        ? `${r.count} tall ${r.count === 1 ? 'tale is' : 'tales are'} in.`
        : 'No tall tales this time — the truth stands alone.');
      h('beat-sub land', 'Phones out — the vote is next.');
      break;
    case 'setup':
      h('beat-kicker land', 'One of these is true…');
      h('beat-question land', r.fact.setup, 'h2');
      break;
    case 'ballot': {
      h('beat-question small', r.fact.setup, 'h2');
      const list = el('div', 'beat-options');
      r.entries.forEach((e, i) => {
        const o = el('div', 'beat-option land', e.text);
        o.style.animationDelay = `${i * 0.3}s`;
        list.appendChild(o);
      });
      root.appendChild(list);
      break;
    }
    case 'duds':
      h('beat-kicker land', 'Fooled nobody');
      rows(beat.keys, false);
      break;
    case 'liesGroup':
      h('beat-kicker land', 'The lies start falling');
      rows(beat.keys, true);
      break;
    case 'lie': {
      const e = byKey(beat.keys[0]);
      h('beat-kicker land', `This one fooled ${e.votes}`);
      h('beat-question land', `“${e.text}”`, 'h2');
      h('beat-winner land', e.authors.join(' & '), 'h2');
      h('beat-sub land', `took in ${e.voters.join(', ')}`);
      break;
    }
    case 'liar':
      h('beat-kicker land', 'Silver tongue of the round');
      if (r.bestLiars.length) {
        const fooled = r.liars.find((l) => l.name === r.bestLiars[0]).fooled;
        h('beat-winner land', r.bestLiars.join(' & '), 'h2');
        h('beat-sub land', `fooled ${fooled} vote${fooled === 1 ? '' : 's'} — round of applause`);
      } else {
        h('beat-question land', 'Nobody fooled anybody — this room reads clean.', 'h2');
      }
      break;
    case 'truth':
      h('beat-kicker land', 'The truth');
      h('beat-question land', r.fact.answer, 'h2');
      h('beat-sub land', r.truthFinders.length
        ? `found by ${r.truthFinders.join(', ')}`
        : 'nobody found it');
      if (r.truthMatchers.length) {
        h('beat-sub land', `${r.truthMatchers.join(' & ')} WROTE the truth — full points`);
      }
      break;
    case 'source': {
      const s = r.fact.source;
      h('beat-kicker land', 'The source — verified for the Btown Brief');
      if (s) {
        h('beat-question small land', s.title, 'h2');
        if (s.quote) h('beat-sub land', `“${s.quote}”`);
        h('beat-sub land', s.url);
      } else {
        h('beat-question land', 'From the Btown Brief’s files.', 'h2');
      }
      break;
    }
    default: {
      h('beat-kicker land', 'Silver tongues tonight');
      const board = boardFrom(doneResults, r).slice(0, 5);
      if (!board.length) {
        h('beat-sub land', 'First tales go on the board next time!');
        break;
      }
      const list = el('ol', 'beat-board');
      board.forEach((row, i) => {
        const li = el('li', 'land');
        li.style.animationDelay = `${i * 0.3}s`;
        li.append(el('span', null, row.name), el('strong', null, String(row.points)));
        list.appendChild(li);
      });
      root.appendChild(list);
    }
  }
}

/** Scoreboard rows for the lobby between rounds (approved content only). */
export function lobbyBoard(doneResults) {
  return scoreboard((doneResults ?? []).filter((d) => d.mode === slug).map((d) => d.results))
    .map(({ name, points }) => ({ name, points }));
}

// TALL TALES — pod play. A table of 3–6 runs itself through three facts
// with ONE phone: pass it around to write lies, lay it flat as the table's
// screen for the ballot and the staged reveal (the same narrated beats the
// host console reads aloud — logic.js narratedBeat is the single source).
//
// Entirely local: no backend, no event, nothing leaves this phone. All
// math comes from logic.js; this file renders and dispatches only. The
// clock seeds the shuffle at this edge (same license as demo.js/the shim).
//
// Moderation in pod play: there is no host, so each fact gets a DEALER —
// rotating through the seats — who privately reviews the lie list and
// strikes near-truths and doubles before anything reaches the table's
// shared screen (approve-to-reveal, pod-sized). The dealer saw the lie
// list, which would let them spot the truth by elimination, so the dealer
// sits out that fact's vote; their own lie still plays and still scores.
// Nothing here ever reaches the room screen or other phones.
//
// The curation gate still holds: reviewed facts only, unless ?unreviewed=1
// (couch testing — the page banners it loudly).

import {
  LIE_MAX_LEN, normalizeText, seedFrom, seededShuffle, buildBallot,
  computeVoteResults, scoreboard, narratedBeat, pickableFacts,
} from './logic.js';

const POD_FACTS = 3;
const root = document.getElementById('podRoot');
const unreviewed = new URLSearchParams(location.search).get('unreviewed') === '1';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const clear = () => { root.innerHTML = ''; };

/* ------------------------------------------------------------ the night */

const state = {
  players: [],      // first names, table order
  facts: [],        // tonight's picks
  results: [],      // computeVoteResults output per finished fact
  factIndex: 0,
};

const deck = await fetch(new URL('./content/talltales-facts.json', import.meta.url))
  .then((r) => r.json())
  .catch(() => ({ version: 0, facts: [] }));

renderNames();

/* --------------------------------------------------------------- lobby */

function renderNames() {
  clear();
  const pickable = pickableFacts(deck, { showUnreviewed: unreviewed });
  root.appendChild(el('h1', null, 'Tall Tales — pod play'));
  if (unreviewed) {
    root.appendChild(el('p', 'error-line',
      'UNVERIFIED TEST DECK — these facts have not passed review. Couch testing only.'));
  }
  if (!pickable.length) {
    root.appendChild(el('p', 'host-hint',
      'No facts have passed review yet — this table game unlocks once the deck is verified.'));
    return;
  }
  root.appendChild(el('p', 'dim',
    `Three Burlington facts. Everyone lies, everyone hunts the truth. First names, in seating order (3–6):`));

  const namesBox = el('div', 'pod-names');
  root.appendChild(namesBox);
  const inputs = [];
  const addInput = () => {
    if (inputs.length >= 6) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 24;
    input.placeholder = `Player ${inputs.length + 1}`;
    input.autocomplete = 'off';
    input.id = `mode-tall-tales-pod-name-${inputs.length}`;
    inputs.push(input);
    namesBox.appendChild(input);
  };
  for (let i = 0; i < 3; i++) addInput();

  const more = el('button', 'chip-btn', '+ add a chair');
  more.id = 'mode-tall-tales-pod-add';
  more.addEventListener('click', addInput);
  root.appendChild(more);

  const err = el('p', 'error-line', '');
  root.appendChild(err);
  const start = el('button', 'big-btn', 'Deal the first fact');
  start.id = 'mode-tall-tales-pod-start';
  start.addEventListener('click', () => {
    const names = [];
    for (const i of inputs) {
      const v = i.value.trim().slice(0, 24);
      if (!v) continue;
      if (names.some((n) => normalizeText(n) === normalizeText(v))) {
        err.textContent = 'Two chairs share a name — add a last initial.';
        return;
      }
      names.push(v);
    }
    if (names.length < 3) { err.textContent = 'Pod play wants at least 3 at the table.'; return; }
    state.players = names;
    const seed = seedFrom(`pod|${Date.now()}|${names.join('|')}`);
    state.facts = seededShuffle(pickable, seed).slice(0, Math.min(POD_FACTS, pickable.length));
    state.results = [];
    state.factIndex = 0;
    playFact();
  });
  root.appendChild(start);
}

/* ------------------------------------------------------ one fact's arc */

function playFact() {
  const fact = state.facts[state.factIndex];
  collectLies(fact, [], 0);
}

/** Pass-and-play lie writing: an interstitial guards each secret turn. */
function collectLies(fact, lies, at) {
  if (at >= state.players.length) { tableCheck(fact, lies); return; }
  const name = state.players[at];
  clear();
  root.appendChild(el('p', 'collect-ask', `Fact ${state.factIndex + 1} of ${state.facts.length}`));
  root.appendChild(el('h1', null, `Pass the phone to ${name}`));
  root.appendChild(el('p', 'dim', 'Nobody else peeks — the lie is yours alone.'));
  const go = el('button', 'big-btn', `I'm ${name} — show me`);
  go.id = 'mode-tall-tales-pod-pass';
  go.addEventListener('click', () => {
    clear();
    root.appendChild(el('p', 'collect-ask', `${name} — fill the blank with a LIE`));
    root.appendChild(el('h2', 'collect-question', fact.setup));
    root.appendChild(el('p', 'dim small', 'Plausible beats funny. Ten seconds, then pass it on.'));
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = LIE_MAX_LEN;
    input.placeholder = 'your convincing lie…';
    input.autocomplete = 'off';
    input.id = 'mode-tall-tales-pod-lie';
    root.appendChild(input);
    const done = el('button', 'big-btn', 'Done — pass it on');
    done.id = 'mode-tall-tales-pod-lie-done';
    done.disabled = true;
    input.addEventListener('input', () => { done.disabled = !input.value.trim(); });
    done.addEventListener('click', () => {
      collectLies(fact, [...lies, { name, text: input.value.trim() }], at + 1);
    });
    root.appendChild(done);
  });
  root.appendChild(go);
}

/** This fact's dealer: rotates through the seats, fact by fact. */
const dealerFor = (factIndex) => state.players[factIndex % state.players.length];

/**
 * The pod's moderation gate: the DEALER — and only the dealer — reviews
 * the lie list before anything hits the table's shared screen. If the
 * whole table saw this list, the vote would be broken anyway: the one
 * ballot entry nobody had seen would have to be the truth.
 */
function tableCheck(fact, lies) {
  const dealer = dealerFor(state.factIndex);
  clear();
  root.appendChild(el('p', 'collect-ask', 'Dealer’s check'));
  root.appendChild(el('h1', null, `Pass the phone to ${dealer}`));
  root.appendChild(el('p', 'dim',
    `Only ${dealer} looks: strike anything that IS the truth, or a double. Dealing means sitting out this vote — your lie still plays.`));
  const go = el('button', 'big-btn', `I'm ${dealer} — show me the lies`);
  go.id = 'mode-tall-tales-pod-pass';
  go.addEventListener('click', () => {
    clear();
    root.appendChild(el('p', 'collect-ask', `${dealer} — the dealer’s check`));
    root.appendChild(el('h2', 'collect-question', fact.setup));
    root.appendChild(el('p', 'dim small',
      'Strike anything that IS the truth, or a double. Then lay the phone flat.'));
    const struck = new Set();
    lies.forEach((l, i) => {
      const row = el('div', 'pod-row');
      const text = el('div', 'collect-opt', l.text);
      const strike = el('button', 'chip-btn', '✕');
      strike.id = `mode-tall-tales-pod-strike-${i}`;
      strike.setAttribute('aria-label', `strike lie ${i + 1}`);
      strike.addEventListener('click', () => {
        if (struck.has(i)) struck.delete(i); else struck.add(i);
        text.classList.toggle('pod-strike', struck.has(i));
      });
      row.append(text, strike);
      root.appendChild(row);
    });
    const done = el('button', 'big-btn', 'Ballot is set — start the vote');
    done.id = 'mode-tall-tales-pod-ballot-go';
    done.addEventListener('click', () => {
      const kept = lies.filter((_, i) => !struck.has(i));
      const ballot = buildBallot({
        fact,
        lies: kept,
        seed: seedFrom(`${fact.id}|${kept.map((l) => l.text).join('|')}`),
      });
      collectVotes(fact, ballot, kept, [], 0);
    });
    root.appendChild(done);
  });
  root.appendChild(go);
}

/** Pass-and-play voting: own lie is disabled — you cannot vote for it —
 *  and the dealer sits this one out (they saw the whole lie list). */
function collectVotes(fact, ballot, lies, votes, at) {
  if (at >= state.players.length) { reveal(fact, ballot, votes); return; }
  const name = state.players[at];
  if (name === dealerFor(state.factIndex)) {
    collectVotes(fact, ballot, lies, votes, at + 1);
    return;
  }
  clear();
  root.appendChild(el('h1', null, `Pass the phone to ${name}`));
  const go = el('button', 'big-btn', `I'm ${name} — show the ballot`);
  go.id = 'mode-tall-tales-pod-pass';
  go.addEventListener('click', () => {
    clear();
    root.appendChild(el('p', 'collect-ask', `${name} — one of these is TRUE`));
    root.appendChild(el('h2', 'collect-question', fact.setup));
    ballot.entries.forEach((entry) => {
      const b = el('button', 'collect-opt', entry.text);
      b.id = `mode-tall-tales-pod-vote-${entry.key}`;
      if (entry.authors.some((a) => normalizeText(a) === normalizeText(name))) {
        b.disabled = true;
        b.appendChild(el('span', 'dim small', ' — your tall tale'));
      }
      b.addEventListener('click', () => {
        collectVotes(fact, ballot, lies, [...votes, { name, payload: { kind: 'vote', key: entry.key } }], at + 1);
      });
      root.appendChild(b);
    });
  });
  root.appendChild(go);
}

/* ----------------------------------------------------------- the reveal */

/** The narrated-reveal slot, reused: logic.js narratedBeat renders the
 *  same staged beats the host console would read aloud, phone laid flat. */
function reveal(fact, ballot, votes) {
  const results = computeVoteResults({
    config: { phase: 'vote', fact: podFactConfig(fact), ballot },
    approved: votes,
  });
  state.results.push(results);
  const board = scoreboard(state.results);
  const total = results.beatPlan.length;
  const paint = (step) => {
    clear();
    const beat = narratedBeat(step, results, board);
    root.appendChild(el('div', 'pod-reveal-title', beat.title));
    beat.lines.forEach((line, i) => {
      root.appendChild(el('div', `pod-line land${i > 0 && i === beat.lines.length - 1 ? ' secondary' : ''}`, line));
    });
    root.appendChild(el('p', 'dim small', `beat ${step + 1} of ${total} — read it out loud`));
    const last = step >= total - 1;
    const next = el('button', 'big-btn', last ? afterLabel() : 'Next beat →');
    next.id = 'mode-tall-tales-pod-next';
    next.addEventListener('click', () => {
      if (!last) { paint(step + 1); return; }
      state.factIndex += 1;
      if (state.factIndex < state.facts.length) playFact();
      else finale(board);
    });
    root.appendChild(next);
  };
  paint(0);
}

const afterLabel = () =>
  (state.factIndex + 1 < state.facts.length ? 'Deal the next fact →' : 'The final board →');

const podFactConfig = (fact) => ({
  id: fact.id,
  setup: fact.setup,
  answer: fact.answer,
  source: { url: fact.sourceUrl, title: fact.sourceTitle, quote: fact.sourceQuote },
});

function finale(board) {
  clear();
  root.appendChild(el('p', 'collect-ask', 'That’s the pod'));
  root.appendChild(el('h1', null, 'Silver tongues of the table'));
  const list = el('ol', 'beat-board');
  board.forEach((row) => {
    const li = el('li', null);
    li.append(el('span', null, row.name), el('strong', null, String(row.points)));
    list.appendChild(li);
  });
  root.appendChild(list);
  root.appendChild(el('p', 'dim small', 'Now argue about which lie deserved better. That argument is the product.'));
  const again = el('button', 'big-btn', 'Run it back');
  again.id = 'mode-tall-tales-pod-again';
  again.addEventListener('click', renderNames);
  root.appendChild(again);
}

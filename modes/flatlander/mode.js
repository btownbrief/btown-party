// FLATLANDER — mode module (UI + wiring). All math lives in logic.js; this
// file only renders and dispatches, per the fleet rule. It implements the
// mode contract in MODE-INTEGRATION.md.
//
// The one mode where phones deal secrets and then disappear — the game is
// played on faces at a table of 4–6, no big screen required. The backend
// gives attendee phones no way to read each other (the player poll is
// deliberately blind), so the pod runs on a shared deterministic seed:
// every phone derives the same role/task plan from the host's round salt +
// the pod code, votes are cast privately on each phone and revealed by
// flipping the phones together, and the face-up TABLE PHONE (the pod
// creator's) transcribes the flipped votes and keeps the official
// scoreboard. When the pod wraps, the table phone submits ONE pod
// scoreboard through the shell's normal approve-to-reveal gate.

import {
  SLUG, LIMITS, SCORING,
  makePodCode, formatPodCode, parsePodCode, cleanName,
  podPlan, roundView, newGame, gameOver, applyRound, podSummary,
  cleanPodResult, computeResults as compute, scoreboard,
  beatCount as beats, narratedBeat,
} from './logic.js';
import { getName } from '../../js/party-client.js';

export const slug = SLUG;
export const title = 'Flatlander';
export const tagline = 'Pods of 4–6. One of you is from away. Blend in.';

/* --------------------------------------------------------------- helpers */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function btn(id, cls, text, onClick) {
  const b = el('button', cls, text);
  b.id = id;
  b.addEventListener('click', onClick);
  return b;
}

const seatLabel = (i) => `Seat ${i + 1}`;

/** Mode-scoped styles, injected once on the attendee face only. */
function injectStyle() {
  if (document.getElementById('flatlander-style')) return;
  const s = el('style');
  s.id = 'flatlander-style';
  s.textContent = `
    [data-mode="flatlander"] .fl-code { font-size: 42px; font-weight: 800; letter-spacing: 0.14em; text-align: center; margin: 10px 0; }
    [data-mode="flatlander"] .fl-big { font-size: 46px; font-weight: 900; text-align: center; line-height: 1.1; margin: 14px 0; }
    [data-mode="flatlander"] .fl-count { font-size: 110px; font-weight: 900; text-align: center; margin: 30px 0; }
    [data-mode="flatlander"] .fl-secret { border: 2px solid var(--amber); border-radius: 14px; padding: 16px; margin: 10px 0; }
    [data-mode="flatlander"] .fl-round { font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.75; }
    [data-mode="flatlander"] .fl-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
    [data-mode="flatlander"] .fl-row .who-label { min-width: 84px; font-weight: 650; }
    [data-mode="flatlander"] .fl-mini { padding: 8px 10px; font-size: 14px; }
    [data-mode="flatlander"] .fl-board { list-style: none; padding: 0; margin: 10px 0; }
    [data-mode="flatlander"] .fl-board li { display: flex; justify-content: space-between; padding: 6px 2px; border-bottom: 1px solid rgba(255,255,255,0.12); font-size: 17px; }
    [data-mode="flatlander"] input.fl-name { width: 100%; margin: 4px 0; font-size: 16px; padding: 10px; }
  `;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------- the deck */

let deckPromise = null;
function loadDeck() {
  if (!deckPromise) {
    deckPromise = fetch(new URL('./content/flatlander-tasks.json', import.meta.url))
      .then((r) => r.json())
      .catch(() => { deckPromise = null; throw new Error('deck_unavailable'); });
  }
  return deckPromise;
}

/* ------------------------------------------------------------ host setup */

/**
 * Round setup on the host console. Flatlander needs no per-round choice —
 * the host opens the round, the tables do the rest. The salt makes tonight's
 * role sequences unlike any other night's.
 */
export function hostSetup(ctx, mount) {
  mount.innerHTML = '';
  const wrap = el('div');
  wrap.dataset.mode = slug;
  wrap.appendChild(el('p', 'host-hint',
    'Flatlander runs at the tables: pods of 4–6 self-assemble, phones deal secret tasks, '
    + 'and one player per round fakes it. No big screen needed.'));
  wrap.appendChild(el('p', 'host-hint',
    'Leave the round open while the tables play (a game is ~10 minutes). Each pod\'s '
    + 'table phone sends in ONE scoreboard when it wraps — close the round only after '
    + 'the scoreboards you\'re waiting on have arrived.'));
  const salt = [...crypto.getRandomValues(new Uint32Array(2))]
    .map((n) => n.toString(36)).join('');
  wrap.appendChild(btn(`mode-${slug}-open`, 'big-btn', 'Open the Flatlander round',
    () => ctx.openRound({ salt, rounds: LIMITS.roundsDefault })));
  mount.appendChild(wrap);
}

/** One line per pod scoreboard in the shell's moderation list. It names
 *  EVERY player: the pod's names were typed at the table, and this line is
 *  where the host vets them before they can reach the screen. */
export function describeSubmission(payload) {
  const p = cleanPodResult(payload);
  if (!p) return '(not a pod scoreboard)';
  const board = [...p.players].sort((a, b) => b.score - a.score)
    .map((pl) => `${pl.name} ${pl.score}`).join(', ');
  return `Pod ${p.pod} · ${p.rounds} rounds · caught ${p.caught}, escaped ${p.escaped} · ${board}`;
}

/* ----------------------------------------------------------- phone input */

/**
 * The whole pod game lives inside the collect surface. Each interaction is
 * a few seconds — peek, act, vote, flip — and between them the phone lies
 * face down; the table, not the screen, is the game. Only the table phone
 * ever calls ctx.submit, once, when the pod wraps.
 */
export function phoneCollect(ctx, mount) {
  injectStyle();
  const KEY = `btown-party-flatlander-${ctx.round.id}`;
  const config = ctx.round.config ?? {};
  const salt = String(config.salt ?? '');
  const rounds = config.rounds;

  let state = null;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && saved.roundId === ctx.round.id) state = saved;
  } catch { /* fresh start */ }
  if (!state) state = { roundId: ctx.round.id, phase: 'entry' };

  const save = () => {
    try {
      // One saved pod per phone: stale keys from earlier rounds go.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('btown-party-flatlander-') && k !== KEY) localStorage.removeItem(k);
      }
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch { /* private mode: the game still runs, it just won't survive a refresh */ }
  };
  const go = (patch) => { Object.assign(state, patch); save(); render(); };

  let deck = null;
  const planFor = () => podPlan({
    salt, code: state.code, size: state.size, rounds, deckLength: deck.tasks.length,
  });

  /* ---- shared widgets ---- */

  function podHeader(wrap, roundIx, totalRounds) {
    const h = el('div', 'fl-round',
      `Pod ${state.code} · Round ${roundIx + 1} of ${totalRounds}`);
    wrap.appendChild(h);
  }

  /** Tap-to-peek secret. Auto-hides after 8s so a face-up phone goes dark. */
  function peekWidget(wrap, view) {
    const peek = btn(`mode-${slug}-peek`, 'big-btn', '🫣 Peek at my secret', () => {
      const open = !body.classList.contains('hidden');
      body.classList.toggle('hidden', open);
      peek.textContent = open ? '🫣 Peek at my secret' : 'Hide it';
      clearTimeout(peek._t);
      if (!open) peek._t = setTimeout(() => {
        body.classList.add('hidden');
        peek.textContent = '🫣 Peek at my secret';
      }, 8000);
    });
    const body = el('div', 'fl-secret hidden');
    body.id = `mode-${slug}-peek-body`;
    if (view.isFlatlander) {
      body.appendChild(el('div', 'fl-big', 'You\'re the Flatlander.'));
      body.appendChild(el('p', null, 'Everyone else got a task. You didn\'t. When the count ends, do SOMETHING — watch fast, commit big.'));
      body.appendChild(el('p', 'dim small', 'Survive the vote and you score double.'));
    } else {
      body.appendChild(el('p', 'collect-ask', 'Your task — don\'t say it, just do it:'));
      body.appendChild(el('h2', 'collect-question', view.task?.instruction ?? '…'));
      body.appendChild(el('p', 'dim small', 'One of the pod has no idea what this says. Act on the count, then watch the faces.'));
    }
    wrap.append(peek, body);
  }

  function voteButtons(wrap, mySeat, names, onPick) {
    wrap.appendChild(el('p', 'collect-ask', 'Who\'s the Flatlander?'));
    for (let i = 0; i < state.size; i++) {
      if (i === mySeat) continue;
      const label = names ? names[i] : `${seatLabel(i)}${i === 0 ? ' (table phone)' : ''}`;
      wrap.appendChild(btn(`mode-${slug}-vote-${i}`, 'collect-opt', label, () => onPick(i)));
    }
    if (!names) {
      wrap.appendChild(el('p', 'dim small', 'Seats go clockwise from the table phone.'));
    }
  }

  function facedownFlip(wrap, accusedLabel, nextId, nextLabel, onNext) {
    wrap.appendChild(el('div', 'fl-big', 'Vote\'s in.'));
    wrap.appendChild(el('p', null, 'Phone face down in the middle. On the table\'s three-count, everyone flips together.'));
    const flip = btn(`mode-${slug}-flip`, 'big-btn', 'FLIP', () => {
      wrap.innerHTML = '';
      wrap.appendChild(el('p', 'collect-ask', `${state.myName ?? 'I'} say${state.myName ? 's' : ''}…`));
      wrap.appendChild(el('div', 'fl-big', accusedLabel));
      wrap.appendChild(btn(nextId, 'big-btn', nextLabel, onNext));
    });
    wrap.appendChild(flip);
  }

  /* ---- render, phase by phase ---- */

  function render() {
    mount.innerHTML = '';
    const wrap = el('div');
    wrap.dataset.mode = slug;
    mount.appendChild(wrap);

    if (!deck) {
      wrap.appendChild(el('p', 'dim', 'Fetching the task deck…'));
      loadDeck().then((d) => { deck = d; render(); }).catch(() => {
        wrap.innerHTML = '';
        wrap.appendChild(el('p', null, 'Couldn\'t load the task deck — check your signal.'));
        wrap.appendChild(btn(`mode-${slug}-retry`, 'big-btn', 'Try again', render));
      });
      return;
    }

    switch (state.phase) {
      /* ------------------------------------------------ pick a side */
      case 'entry': {
        wrap.appendChild(el('p', 'collect-ask', 'Flatlander'));
        wrap.appendChild(el('h2', 'collect-question', 'Grab 3–5 neighbors. One phone runs the table.'));
        wrap.appendChild(el('p', 'dim small',
          'Each round every phone but one gets the same secret task. The odd one out fakes it. Catch them — or be them and get away with it.'));
        wrap.appendChild(btn(`mode-${slug}-create`, 'big-btn', 'Start a pod (this phone runs the table)',
          () => go({ phase: 'create-size' })));
        wrap.appendChild(btn(`mode-${slug}-join`, 'big-btn', 'Join a pod',
          () => go({ phase: 'join-code' })));
        break;
      }

      /* ------------------------------------------------ table phone: setup */
      case 'create-size': {
        wrap.appendChild(el('p', 'collect-ask', 'How many of you, counting yourself?'));
        for (const n of [4, 5, 6]) {
          wrap.appendChild(btn(`mode-${slug}-size-${n}`, 'collect-opt', `${n} players`, () => {
            const code = makePodCode(crypto.getRandomValues(new Uint32Array(1))[0]);
            go({ phase: 'create-names', size: n, code });
          }));
        }
        break;
      }
      case 'create-names': {
        wrap.appendChild(el('p', 'collect-ask', 'Tell the table to join with'));
        const codeEl = el('div', 'fl-code', formatPodCode(state.code, state.size));
        codeEl.id = `mode-${slug}-code`;
        wrap.appendChild(codeEl);
        wrap.appendChild(el('p', null,
          'You\'re Seat 1 — seats go clockwise from this phone. First names, going around:'));
        const inputs = [];
        for (let i = 0; i < state.size; i++) {
          const inp = el('input', 'fl-name');
          inp.id = `mode-${slug}-name-${i + 1}`;
          inp.placeholder = seatLabel(i);
          inp.maxLength = LIMITS.nameLen;
          if (i === 0) inp.value = getName();
          inputs.push(inp);
          wrap.appendChild(inp);
        }
        wrap.appendChild(btn(`mode-${slug}-start`, 'big-btn', 'Everyone\'s in — start round 1', () => {
          const names = inputs.map((inp, i) => cleanName(inp.value, seatLabel(i)));
          const game = newGame({
            salt, code: state.code, size: state.size, names, rounds,
            deckLength: deck.tasks.length,
          });
          go({ phase: 'brief', role: 'timer', seat: 0, myName: names[0], game });
        }));
        break;
      }

      /* ------------------------------------------------ joiner: setup */
      case 'join-code': {
        wrap.appendChild(el('p', 'collect-ask', 'Type the pod code off the table phone'));
        const inp = el('input', 'fl-name');
        inp.id = `mode-${slug}-join-code`;
        inp.placeholder = 'e.g. MQ2F5';
        inp.autocapitalize = 'characters';
        wrap.appendChild(inp);
        const err = el('p', 'dim small', '');
        err.id = `mode-${slug}-join-error`;
        wrap.appendChild(btn(`mode-${slug}-join-go`, 'big-btn', 'Next', () => {
          const parsed = parsePodCode(inp.value);
          if (!parsed) { err.textContent = 'That\'s 4 letters and a size — it\'s on the table phone.'; return; }
          go({ phase: 'join-seat', code: parsed.code, size: parsed.size });
        }));
        wrap.appendChild(err);
        break;
      }
      case 'join-seat': {
        wrap.appendChild(el('p', 'collect-ask', `Pod ${state.code} — which seat are you?`));
        wrap.appendChild(el('p', 'dim small', 'The table phone is Seat 1; seats go clockwise from it.'));
        for (let i = 1; i < state.size; i++) {
          wrap.appendChild(btn(`mode-${slug}-seat-${i}`, 'collect-opt', seatLabel(i), () => {
            go({ phase: 'brief', role: 'seat', seat: i, myName: cleanName(getName(), seatLabel(i)), roundIx: 0 });
          }));
        }
        break;
      }

      /* ------------------------------------------------ the round: brief + peek */
      case 'brief': {
        const roundIx = state.role === 'timer' ? state.game.roundIx : state.roundIx;
        const plan = state.role === 'timer' ? state.game.plan : planFor();
        podHeader(wrap, roundIx, plan.rounds);
        const view = roundView(plan, roundIx, state.seat, deck);
        wrap.appendChild(el('h2', 'collect-question',
          state.role === 'timer'
            ? 'Pass this phone around — everyone peeks, then it lies face up.'
            : 'Peek, memorize, phone face down.'));
        peekWidget(wrap, view);
        if (state.role === 'timer') {
          wrap.appendChild(btn(`mode-${slug}-go`, 'big-btn', 'Everyone\'s peeked — 3·2·1·GO',
            () => runCountdown(wrap)));
          if (state.game.roundIx > 0) {
            wrap.appendChild(btn(`mode-${slug}-wrap-early`, 'collect-opt fl-mini',
              'Wrap the pod early & send scores', () => go({ phase: 'final' })));
          }
        } else {
          wrap.appendChild(el('p', 'dim small', 'Act on the table phone\'s count. Interrogate. Then:'));
          wrap.appendChild(btn(`mode-${slug}-to-vote`, 'big-btn', 'Time to vote →', () => go({ phase: 'vote' })));
        }
        break;
      }

      /* ------------------------------------------------ table phone: after the count */
      case 'act': {
        podHeader(wrap, state.game.roundIx, state.game.rounds);
        wrap.appendChild(el('div', 'fl-big', 'EYES UP.'));
        wrap.appendChild(el('p', null, 'Watch who moved late. Ask questions nobody from away could survive.'));
        wrap.appendChild(btn(`mode-${slug}-to-vote`, 'big-btn', 'Time to vote — everyone, phones', () => go({ phase: 'vote' })));
        break;
      }

      /* ------------------------------------------------ vote (every phone) */
      case 'vote': {
        const isTimer = state.role === 'timer';
        podHeader(wrap, isTimer ? state.game.roundIx : state.roundIx,
          isTimer ? state.game.rounds : planFor().rounds);
        voteButtons(wrap, state.seat, isTimer ? state.game.names : null, (target) => {
          go({ phase: 'flip', myVote: target });
        });
        wrap.appendChild(el('p', 'dim small', 'Keep it to yourself — the flip is the reveal.'));
        break;
      }

      /* ------------------------------------------------ flip together */
      case 'flip': {
        const isTimer = state.role === 'timer';
        const names = isTimer ? state.game.names : null;
        const accused = names ? names[state.myVote] : seatLabel(state.myVote);
        if (isTimer) {
          facedownFlip(wrap, accused, `mode-${slug}-enter-votes`, 'All flipped? Enter the pod\'s votes',
            () => go({ phase: 'transcribe' }));
        } else {
          facedownFlip(wrap, accused, `mode-${slug}-truth`, 'And the truth…',
            () => go({ phase: 'fate' }));
        }
        break;
      }

      /* ------------------------------------------------ table phone: transcribe */
      case 'transcribe': {
        podHeader(wrap, state.game.roundIx, state.game.rounds);
        wrap.appendChild(el('p', 'collect-ask', 'Read the flipped phones — who did each seat accuse?'));
        const picks = { [state.seat]: state.myVote };
        const rows = [];
        for (let voter = 0; voter < state.size; voter++) {
          const row = el('div', 'fl-row');
          row.appendChild(el('span', 'who-label', state.game.names[voter]));
          const rowBtns = [];
          for (let target = 0; target < state.size; target++) {
            if (target === voter) continue;
            const b = btn(`mode-${slug}-tr-${voter}-${target}`, 'collect-opt fl-mini',
              state.game.names[target], () => {
                picks[voter] = target;
                rowBtns.forEach((x) => x.classList.toggle('sel', x === b));
              });
            rowBtns.push(b);
            row.appendChild(b);
          }
          const none = btn(`mode-${slug}-tr-${voter}-none`, 'collect-opt fl-mini', '—', () => {
            delete picks[voter];
            rowBtns.forEach((x) => x.classList.remove('sel'));
            none.classList.add('sel');
          });
          rowBtns.push(none);
          row.appendChild(none);
          if (voter === state.seat && Number.isInteger(state.myVote)) {
            rowBtns.find((x) => x.id === `mode-${slug}-tr-${voter}-${state.myVote}`)
              ?.classList.add('sel');
          }
          rows.push(row);
          wrap.appendChild(row);
        }
        wrap.appendChild(btn(`mode-${slug}-tr-done`, 'big-btn', 'That\'s the vote — verdict', () => {
          const votes = Object.entries(picks)
            .map(([seat, target]) => ({ seat: Number(seat), target }));
          const { game, outcome } = applyRound(state.game, votes);
          go({ phase: 'reveal', game, outcome, revealStep: 0 });
        }));
        break;
      }

      /* ------------------------------------------------ table phone: staged verdict */
      case 'reveal': {
        const o = state.outcome;
        const g = state.game; // already advanced past this round
        podHeader(wrap, o.round - 1, g.rounds);
        const step = state.revealStep ?? 0;
        if (step === 0) {
          wrap.appendChild(el('p', 'collect-ask', 'The votes are in.'));
          o.tally.forEach((c, i) => {
            if (c > 0) wrap.appendChild(el('div', null, `${g.names[i]} — ${c} vote${c === 1 ? '' : 's'}`));
          });
          if (!o.votes.length) wrap.appendChild(el('p', 'dim', 'Not one vote. Bold table.'));
          wrap.appendChild(btn(`mode-${slug}-reveal-next`, 'big-btn', 'And the Flatlander was…',
            () => go({ revealStep: 1 })));
        } else if (step === 1) {
          wrap.appendChild(el('div', 'fl-big', g.names[o.flSeat]));
          wrap.appendChild(el('h2', 'collect-question',
            o.caught ? 'CAUGHT. The table wins the round.' : 'SLIPPED AWAY. +200, and no shame.'));
          wrap.appendChild(btn(`mode-${slug}-reveal-next`, 'big-btn', 'Scores →',
            () => go({ revealStep: 2 })));
        } else {
          wrap.appendChild(el('p', 'collect-ask',
            o.caught ? `Spotters +${SCORING.spot} each` : `The Flatlander +${SCORING.escape}${o.spotters.length ? ` · lone spotters +${SCORING.spot}` : ''}`));
          const board = el('ol', 'fl-board');
          board.id = `mode-${slug}-board`;
          g.names.map((name, i) => ({ name, score: g.scores[i] }))
            .sort((a, b) => b.score - a.score)
            .forEach((r) => {
              const li = el('li');
              li.append(el('span', null, r.name), el('strong', null, String(r.score)));
              board.appendChild(li);
            });
          wrap.appendChild(board);
          const done = gameOver(g);
          wrap.appendChild(btn(`mode-${slug}-reveal-next`, 'big-btn',
            done ? 'Final scores →' : `Round ${g.roundIx + 1} →`,
            () => go(done ? { phase: 'final' } : { phase: 'brief' })));
        }
        break;
      }

      /* ------------------------------------------------ joiner: own fate */
      case 'fate': {
        const plan = planFor();
        const flSeat = plan.flSeq[state.roundIx];
        wrap.appendChild(el('p', 'collect-ask', 'The Flatlander was'));
        wrap.appendChild(el('div', 'fl-big', seatLabel(flSeat)));
        if (flSeat === state.seat) {
          wrap.appendChild(el('h2', 'collect-question', 'That was you. The verdict lands on the table phone.'));
        } else if (state.myVote === flSeat) {
          wrap.appendChild(el('h2', 'collect-question', `You called it. +${SCORING.spot} on the table board.`));
        } else {
          wrap.appendChild(el('h2', 'collect-question', 'You pointed at an honest neighbor.'));
        }
        const nextIx = state.roundIx + 1;
        wrap.appendChild(btn(`mode-${slug}-next`, 'big-btn',
          nextIx >= plan.rounds ? 'That\'s the game' : `Round ${nextIx + 1} →`,
          () => go(nextIx >= plan.rounds
            ? { phase: 'done' }
            : { phase: 'brief', roundIx: nextIx, myVote: null })));
        break;
      }
      case 'done': {
        wrap.appendChild(el('div', 'fl-big', 'That\'s the game.'));
        wrap.appendChild(el('p', null, 'The table phone has the scoreboard and sends it to the host. Eyes up — argue about round 3.'));
        break;
      }

      /* ------------------------------------------------ table phone: wrap + submit */
      case 'final': {
        const g = state.game;
        wrap.appendChild(el('p', 'collect-ask', `Pod ${g.code} — final scores`));
        const board = el('ol', 'fl-board');
        board.id = `mode-${slug}-board`;
        g.names.map((name, i) => ({ name, score: g.scores[i] }))
          .sort((a, b) => b.score - a.score)
          .forEach((r, i) => {
            const li = el('li');
            li.append(el('span', null, `${i + 1}. ${r.name}`), el('strong', null, String(r.score)));
            board.appendChild(li);
          });
        wrap.appendChild(board);
        wrap.appendChild(el('p', 'dim small',
          `Caught ${g.caught} · escaped ${g.escaped} over ${g.roundIx} round${g.roundIx === 1 ? '' : 's'}.`));
        const err = el('p', 'dim small', '');
        const send = btn(`mode-${slug}-send`, 'big-btn', 'Send the scoreboard to the host', async () => {
          send.disabled = true;
          send.textContent = 'Sending…';
          try {
            await ctx.submit(podSummary(g));
            localStorage.removeItem(KEY);
          } catch {
            send.disabled = false;
            send.textContent = 'Try again';
            err.textContent = 'Couldn\'t send — if the host already closed the round, flag them down.';
          }
        });
        wrap.append(send, err);
        break;
      }

      default:
        go({ phase: 'entry' });
    }
  }

  /** The table-phone 3·2·1·GO, big enough to read across the table. */
  function runCountdown(wrap) {
    let n = 3;
    const paint = () => {
      wrap.innerHTML = '';
      wrap.appendChild(el('div', 'fl-count', n > 0 ? String(n) : 'GO'));
      if (n > 0) wrap.appendChild(el('p', 'dim small', 'Phones down. Eyes on each other.'));
    };
    paint();
    const timer = setInterval(() => {
      n -= 1;
      if (n < 0) { clearInterval(timer); go({ phase: 'act' }); return; }
      paint();
    }, 800);
  }

  render();
}

/* -------------------------------------------------------------- the math */

/** Shell → mode: approved pod scoreboards in, the stored reveal object out. */
export function computeResults({ approved }) {
  return compute({ approved });
}

export function beatCount() {
  return beats();
}

function boardFrom(doneResults, current) {
  const all = (doneResults ?? []).filter((d) => d.mode === slug).map((d) => d.results);
  if (current && !all.includes(current)) all.push(current);
  return scoreboard(all);
}

/** Big lines the host reads aloud — the no-TV surface equals the screen. */
export function narrated(step, results, doneResults) {
  return narratedBeat(step, results, boardFrom(doneResults, results));
}

/* ------------------------------------------------------------ the screen */

/**
 * The room-wide wrap-up on the big screen (when there is one): 0 intro ·
 * 1 catches · 2 smoothest Flatlander · 3 sharpest eyes · 4 podium. Only
 * host-approved pod scoreboards ever reach this surface.
 */
export function renderBeat(mount, step, results, doneResults) {
  const r = results;
  mount.innerHTML = '';
  const root = el('div');
  root.dataset.mode = slug;
  root.id = `mode-${slug}-beat`;
  root.dataset.step = String(step);
  mount.appendChild(root);
  const h = (cls, text, tag = 'div') => {
    const n = el(tag, cls, text);
    root.appendChild(n);
    return n;
  };
  if (r.emptyNight) {
    h('beat-kicker land', 'Flatlander');
    h('beat-question land', 'The pods kept their secrets tonight.', 'h2');
    return;
  }
  switch (step) {
    case 0:
      h('beat-kicker land', 'Flatlander');
      h('beat-question land',
        `${r.totals.pods} pod${r.totals.pods === 1 ? '' : 's'} · ${r.totals.players} players · one faker per table, per round`, 'h2');
      break;
    case 1:
      h('beat-kicker land', 'The damage');
      h('beat-winner land', `${r.totals.caught} caught`, 'h2');
      h('beat-sub land', r.totals.escaped > 0
        ? `${r.totals.escaped} slipped away clean`
        : 'not one slipped away — terrifying room');
      break;
    case 2:
      h('beat-kicker land', 'Smoothest Flatlander');
      if (r.slickest.length) {
        h('beat-winner land', r.slickest.map((p) => p.name).join(' & '), 'h2');
        h('beat-sub land', `escaped ${r.slickest[0].n} time${r.slickest[0].n === 1 ? '' : 's'}`);
      } else {
        h('beat-question land', 'Nobody escaped. Every faker got the finger.', 'h2');
      }
      break;
    case 3:
      h('beat-kicker land', 'Sharpest eyes');
      if (r.sharpest.length) {
        h('beat-winner land', r.sharpest.map((p) => p.name).join(' & '), 'h2');
        h('beat-sub land', `called out the Flatlander ${r.sharpest[0].n} time${r.sharpest[0].n === 1 ? '' : 's'}`);
      } else {
        h('beat-question land', 'No correct call-outs. They walk among you.', 'h2');
      }
      break;
    default: {
      h('beat-kicker land', 'Blends in best');
      const rows = boardFrom(doneResults, r).slice(0, 5);
      if (!rows.length) {
        h('beat-sub land', 'First pod on the board next time!');
        break;
      }
      const list = el('ol', 'beat-board');
      rows.forEach((row, i) => {
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
  return scoreboard((doneResults ?? []).filter((d) => d.mode === slug).map((d) => d.results));
}

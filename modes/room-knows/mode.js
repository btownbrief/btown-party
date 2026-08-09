// THE ROOM KNOWS — mode module (UI + wiring). All math lives in logic.js;
// this file only renders and dispatches, per the fleet rule. It implements
// the mode contract in MODE-INTEGRATION.md — sibling modes copy this shape.

import {
  SLUG, computeResults as compute, scoreboard, beatCount as beats, narratedBeat,
} from './logic.js';

export const slug = SLUG;
export const title = 'The Room Knows';
export const tagline = 'Guess what this room said at check-in.';

/* ------------------------------------------------------------ host setup */

/**
 * Round setup controls inside the host console. ctx:
 *   ctx.event          — host_get snapshot (questions, checkinTallies, …)
 *   ctx.openRound(cfg) — open the round with this mode + config
 */
export function hostSetup(ctx, mount) {
  mount.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.dataset.mode = slug;
  const label = document.createElement('p');
  label.className = 'host-hint';
  label.textContent = 'Pick tonight’s question — the room already answered it at check-in.';
  wrap.appendChild(label);
  ctx.event.questions.forEach((q, i) => {
    const tally = ctx.event.checkinTallies?.[i];
    const played = ctx.playedQuestionIds?.includes(q.id);
    const btn = document.createElement('button');
    btn.id = `mode-${slug}-pick-${q.id}`;
    btn.className = 'question-pick';
    btn.innerHTML = `<span class="qp-text"></span><span class="qp-meta"></span>`;
    btn.querySelector('.qp-text').textContent = q.text;
    btn.querySelector('.qp-meta').textContent =
      `${tally?.total ?? 0} answered${played ? ' · already played' : ''}`;
    if (played) btn.classList.add('played');
    btn.addEventListener('click', () => ctx.openRound({ question: q }));
    wrap.appendChild(btn);
  });
  mount.appendChild(wrap);
}

/** One line per entry in the shell's moderation list. */
export function describeSubmission(payload, config) {
  const opts = config?.question?.options ?? [];
  const pick = Number.isInteger(payload?.pick) ? opts[payload.pick] : null;
  if (pick == null) return '(not a guess)';
  return `${pick} · ${Math.round(payload.pct)}%`;
}

/* ----------------------------------------------------------- phone input */

/**
 * The ten-second phone interaction: tap an option, slide a percent, send.
 * ctx.submit(payload) resolves when the backend has it.
 */
export function phoneCollect(ctx, mount) {
  const q = ctx.round.config?.question;
  mount.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.dataset.mode = slug;
  if (!q) {
    wrap.textContent = 'This round needs no input — eyes up.';
    mount.appendChild(wrap);
    return;
  }
  const ask = document.createElement('p');
  ask.className = 'collect-ask';
  ask.textContent = 'What did THIS room say?';
  const qt = document.createElement('h2');
  qt.className = 'collect-question';
  qt.textContent = q.text;
  wrap.append(ask, qt);

  let pick = null;
  const optBtns = q.options.map((opt, i) => {
    const b = document.createElement('button');
    b.id = `mode-${slug}-opt-${i}`;
    b.className = 'collect-opt';
    b.textContent = opt;
    b.addEventListener('click', () => {
      pick = i;
      optBtns.forEach((x, xi) => x.classList.toggle('sel', xi === i));
      pctWrap.classList.remove('hidden');
      send.disabled = false;
    });
    wrap.appendChild(b);
    return b;
  });

  const pctWrap = document.createElement('div');
  pctWrap.className = 'pct-wrap hidden';
  const pctLabel = document.createElement('label');
  pctLabel.htmlFor = `mode-${slug}-pct`;
  const pctOut = document.createElement('strong');
  pctOut.id = `mode-${slug}-pct-out`;
  pctOut.textContent = '50%';
  pctLabel.append('And what percent of the room picked it? ', pctOut);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.id = `mode-${slug}-pct`;
  slider.addEventListener('input', () => { pctOut.textContent = `${slider.value}%`; });
  pctWrap.append(pctLabel, slider);
  wrap.appendChild(pctWrap);

  const send = document.createElement('button');
  send.id = `mode-${slug}-send`;
  send.className = 'big-btn';
  send.disabled = true;
  send.textContent = 'Lock it in';
  send.addEventListener('click', async () => {
    if (pick == null) return;
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await ctx.submit({ pick, pct: Number(slider.value) });
    } catch {
      send.disabled = false;
      send.textContent = 'Try again';
    }
  });
  wrap.appendChild(send);
  mount.appendChild(wrap);
}

/* -------------------------------------------------------------- the math */

/** Shell → mode: turn approved inputs into the stored results object. */
export function computeResults({ config, approved, checkinTallies }) {
  const qid = config?.question?.id;
  const tally = (checkinTallies ?? []).find((t) => t && t.questionId === qid)
    ?? { counts: [], total: 0 };
  return compute({ config, tally, approved });
}

export function beatCount() {
  return beats();
}

/** Big lines the host reads aloud — the narrated-reveal view renders this. */
export function narrated(step, results, doneResults) {
  return narratedBeat(step, results, boardFrom(doneResults, results));
}

function boardFrom(doneResults, current) {
  const all = (doneResults ?? []).map((d) => d.results);
  if (current && !all.includes(current)) all.push(current);
  return scoreboard(all);
}

/* ------------------------------------------------------------ the screen */

/**
 * One beat on the big screen. Renders into mount (cleared each step).
 * Steps: 0 question · 1 options · 2 drumroll · 3 bars · 4 readers ·
 * 5 scoreboard. CSS animates whatever gets the .land class.
 */
export function renderBeat(mount, step, results, doneResults) {
  const r = results;
  mount.innerHTML = '';
  const el = document.createElement('div');
  el.dataset.mode = slug;
  el.id = `mode-${slug}-beat`;
  el.dataset.step = String(step);
  const h = (cls, text, tag = 'div') => {
    const n = document.createElement(tag);
    n.className = cls;
    n.textContent = text;
    el.appendChild(n);
    return n;
  };
  switch (step) {
    case 0:
      h('beat-kicker land', 'The room was asked…');
      h('beat-question land', r.question.text, 'h2');
      break;
    case 1: {
      h('beat-question small', r.question.text, 'h2');
      const list = document.createElement('div');
      list.className = 'beat-options';
      r.question.options.forEach((opt, i) => {
        const o = document.createElement('div');
        o.className = 'beat-option land';
        o.style.animationDelay = `${i * 0.35}s`;
        o.textContent = opt;
        list.appendChild(o);
      });
      el.appendChild(list);
      break;
    }
    case 2:
      h('beat-question small', r.question.text, 'h2');
      h('beat-drumroll land', 'What did the room say?');
      h('beat-sub land', `${r.total} answers at check-in`);
      break;
    case 3: {
      h('beat-question small', r.question.text, 'h2');
      if (r.emptyRoom) {
        h('beat-drumroll land', 'Nobody answered this one — free round!');
        break;
      }
      const bars = document.createElement('div');
      bars.className = 'beat-bars';
      r.question.options.forEach((opt, i) => {
        const row = document.createElement('div');
        row.className = 'bar-row' + (r.winners.includes(i) ? ' winner' : '');
        const name = document.createElement('div');
        name.className = 'bar-label';
        name.textContent = opt;
        const track = document.createElement('div');
        track.className = 'bar-track';
        const fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.setProperty('--w', `${Math.max(2, r.percents[i])}%`);
        fill.style.animationDelay = `${0.3 + i * 0.5}s`;
        const pct = document.createElement('div');
        pct.className = 'bar-pct';
        pct.textContent = `${r.percents[i]}%`;
        pct.style.animationDelay = `${0.9 + i * 0.5}s`;
        track.appendChild(fill);
        row.append(name, track, pct);
        bars.appendChild(row);
      });
      el.appendChild(bars);
      break;
    }
    case 4: {
      if (r.emptyRoom || !r.closest.length) {
        h('beat-kicker land', 'Closest reader of the room');
        h('beat-question land', 'No guesses this round — the room stays mysterious.', 'h2');
        break;
      }
      h('beat-kicker land', 'Closest reader of the room');
      h('beat-winner land', r.closest.join(' & '), 'h2');
      const best = Math.round(Math.min(...r.guesses.map((g) => g.error)));
      h('beat-sub land', `within ${best} point${best === 1 ? '' : 's'} of the real number`);
      break;
    }
    default: {
      h('beat-kicker land', 'Reads the room best');
      const board = boardFrom(doneResults, r).slice(0, 5);
      if (!board.length) {
        h('beat-sub land', 'First round goes on the board next time!');
        break;
      }
      const list = document.createElement('ol');
      list.className = 'beat-board';
      board.forEach((row, i) => {
        const li = document.createElement('li');
        li.className = 'land';
        li.style.animationDelay = `${i * 0.3}s`;
        const nm = document.createElement('span');
        nm.textContent = row.name;
        const pts = document.createElement('strong');
        pts.textContent = String(row.points);
        li.append(nm, pts);
        list.appendChild(li);
      });
      el.appendChild(list);
    }
  }
  mount.appendChild(el);
}

/** Scoreboard rows for the lobby between rounds (approved content only). */
export function lobbyBoard(doneResults) {
  return scoreboard((doneResults ?? []).filter((d) => d.mode === slug).map((d) => d.results));
}

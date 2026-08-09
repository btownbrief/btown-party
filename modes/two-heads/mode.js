// TWO HEADS — mode module (UI + wiring). All math lives in logic.js; this
// file only renders and dispatches, per the fleet rule. It implements the
// mode contract in MODE-INTEGRATION.md.
//
// Two round shapes (config.phase):
//   'write' — the huddle: pairs form CONSENSUALLY (one phone shows a team
//             code, the partner types it; a "looking for a partner" beacon
//             is opt-in and only ever signals — the app never assigns a
//             partner to anyone). The pair co-writes ONE answer on one
//             phone. This is deliberately the long, social phase of the
//             night: the huddle is the point, and the host paces it.
//   'vote'  — one bracket face-off: two approved answers on the screen,
//             every phone in the room (players and spectators alike) taps
//             a winner. Ten seconds, then pocketed.

import {
  SLUG, RULES, initFormation, formationAct, cleanAnswer, cleanTeamName,
  wordCount, computeResults as compute, beatCount as beats, beatKind,
  narratedBeat, hostNext, voteRoundConfig, writeConfig, firstRoundLines,
  matchLabel,
} from './logic.js';

export const slug = SLUG;
export const title = 'Two Heads';
export const tagline = 'Grab a partner, co-write one answer, survive the bracket.';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ------------------------------------------------------------ host setup */

const PAGE = 6; // prompts shown at a time on the host console

async function loadDeck() {
  try {
    const res = await fetch(new URL('./content/twoheads-prompts.json', import.meta.url));
    const deck = await res.json();
    return deck.prompts ?? [];
  } catch {
    return [];
  }
}

/**
 * Round setup on the host console. If the last Two Heads round left a live
 * bracket, the next face-off is one tap; otherwise pick a fresh prompt.
 */
export function hostSetup(ctx, mount) {
  mount.innerHTML = '';
  const wrap = el('div');
  wrap.dataset.mode = slug;
  mount.appendChild(wrap);

  const nxt = hostNext(ctx.event.doneResults ?? []);

  if (nxt.kind === 'continue') {
    const a = nxt.bracket.teams[nxt.pending.a];
    const b = nxt.bracket.teams[nxt.pending.b];
    wrap.appendChild(el('p', 'host-hint', 'The bracket is live — fire the next face-off:'));
    const btn = el('button', 'question-pick');
    btn.id = `mode-${slug}-continue`;
    btn.append(
      el('span', 'qp-text', `▶ ${matchLabel(nxt.pending)}: ${a.name} vs ${b.name}`),
      el('span', 'qp-meta', `“${a.answer}” —vs— “${b.answer}”`),
    );
    btn.addEventListener('click', () => ctx.openRound(voteRoundConfig(nxt.bracket, nxt.prompt)));
    wrap.appendChild(btn);
    wrap.appendChild(el('p', 'dim small', 'Or scrap the bracket and start a fresh prompt below.'));
  } else {
    wrap.appendChild(el('p', 'host-hint',
      'Pick tonight’s prompt — pairs huddle over one phone and co-write one answer.'));
  }

  const list = el('div');
  wrap.appendChild(list);
  loadDeck().then((prompts) => {
    const fresh = prompts.filter((p) => !nxt.usedPromptIds.includes(p.id));
    if (!fresh.length) {
      list.appendChild(el('p', 'dim small',
        prompts.length ? 'Every prompt in the deck has been played tonight.' : 'Couldn’t load the prompt deck — refresh?'));
      return;
    }
    let offset = 0;
    const paint = () => {
      list.innerHTML = '';
      fresh.slice(offset, offset + PAGE).forEach((p) => {
        const btn = el('button', 'question-pick');
        btn.id = `mode-${slug}-prompt-${p.id}`;
        btn.append(el('span', 'qp-text', p.prompt), el('span', 'qp-meta', (p.tags ?? []).join(' · ')));
        btn.addEventListener('click', () => ctx.openRound(writeConfig({ id: p.id, text: p.prompt })));
        list.appendChild(btn);
      });
      if (fresh.length > PAGE) {
        const more = el('button', 'chip-btn', '🔁 Show me different prompts');
        more.id = `mode-${slug}-more`;
        more.addEventListener('click', () => { offset = (offset + PAGE) % fresh.length; paint(); });
        list.appendChild(more);
      }
    };
    paint();
  });
}

/** One short human line per submission for the shell's moderation list. */
export function describeSubmission(payload, config) {
  if (payload?.kind === 'join') return '🤝 joined a team — nothing to review';
  if (payload?.kind === 'answer') {
    const name = cleanTeamName(payload.team?.name, payload.team?.code ?? '????');
    const ans = cleanAnswer(payload.answer);
    return ans ? `${name} · “${ans}”` : '(not a valid answer)';
  }
  if (payload?.kind === 'vote') {
    const side = payload.pick === 0 ? config?.match?.a : payload.pick === 1 ? config?.match?.b : null;
    return side ? `voted ${side.name}` : '(not a ballot)';
  }
  return '(not a Two Heads entry)';
}

/* ----------------------------------------------------------- phone input */

export function phoneCollect(ctx, mount) {
  mount.innerHTML = '';
  const wrap = el('div');
  wrap.dataset.mode = slug;
  mount.appendChild(wrap);
  if (ctx.round.config?.phase === 'vote') collectVote(ctx, wrap);
  else if (ctx.round.config?.phase === 'write') collectWrite(ctx, wrap);
  else wrap.appendChild(el('p', 'dim', 'This round is happening in the room — eyes up.'));
}

/** The face-off ballot: one tap, then pocketed. Open to EVERYONE in the
 *  room — players and spectators alike; nobody is asked which they are. */
function collectVote(ctx, wrap) {
  const m = ctx.round.config.match;
  wrap.appendChild(el('p', 'collect-ask', ctx.round.config.label ?? 'Face-off'));
  wrap.appendChild(el('h2', 'collect-question', ctx.round.config.prompt?.text ?? ''));
  let sent = false;
  [m.a, m.b].forEach((side, i) => {
    const b = el('button', 'collect-opt');
    b.id = `mode-${slug}-pick-${i}`;
    b.append(el('strong', null, `“${side.answer}”`), document.createElement('br'), el('span', 'dim small', side.name));
    b.addEventListener('click', async () => {
      if (sent) return;
      sent = true;
      b.classList.add('sel');
      wrap.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try {
        await ctx.submit({ kind: 'vote', pick: i });
      } catch {
        sent = false;
        wrap.querySelectorAll('button').forEach((x) => { x.disabled = false; });
        b.classList.remove('sel');
      }
    });
    wrap.appendChild(b);
  });
}

/** The huddle. All pairing is consensual: start a team and hand your code
 *  to the partner YOU grabbed, join with a code you were handed, opt into
 *  the "looking for a partner" beacon, or just watch. The app never pairs
 *  anyone — see logic.js. */
function collectWrite(ctx, wrap) {
  const promptText = ctx.round.config.prompt?.text ?? '';
  let form = initFormation();
  const ME = 'me';

  const paintChoose = () => {
    // Backing out to the menu is a fresh slate — nothing was submitted, so
    // the local formation slice resets (a failed send followed by a
    // different choice must not trip the reducer's already-teamed guard).
    form = initFormation();
    wrap.innerHTML = '';
    wrap.appendChild(el('p', 'collect-ask', 'TWO HEADS — one answer per team'));
    wrap.appendChild(el('h2', 'collect-question', promptText));
    const mk = (id, label, sub, fn) => {
      const b = el('button', 'collect-opt');
      b.id = `mode-${slug}-${id}`;
      b.append(el('strong', null, label), document.createElement('br'), el('span', 'dim small', sub));
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    };
    mk('start', 'Start a team', 'this phone does the writing — grab a partner, or go solo', paintCaptain);
    mk('join', 'Join a team', 'your partner’s phone shows a 4-letter code', paintJoiner);
    mk('pool', '🔎 Looking for a partner', 'hold your phone up so other lookers can find you', paintPool);
    mk('watch', 'Just watching this one', 'you still get to vote in the face-offs', paintWatch);
  };

  const paintCaptain = () => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const started = formationAct(form, { type: 'start', player: ME, seed });
    form = started.state;
    const code = started.code;
    wrap.innerHTML = '';
    wrap.appendChild(el('p', 'collect-ask', 'Your team code'));
    const codeEl = el('h2', 'collect-question', code);
    codeEl.id = `mode-${slug}-code`;
    codeEl.style.letterSpacing = '0.3em';
    wrap.appendChild(codeEl);
    wrap.appendChild(el('p', 'dim small',
      'Playing with a partner? Have them tap “Join a team” and type this code. Flying solo is fine too.'));

    const nameIn = document.createElement('input');
    nameIn.id = `mode-${slug}-team-name`;
    nameIn.type = 'text';
    nameIn.maxLength = RULES.teamNameChars;
    nameIn.placeholder = 'Name your team';
    nameIn.autocomplete = 'off';
    wrap.appendChild(nameIn);

    const ans = document.createElement('textarea');
    ans.id = `mode-${slug}-answer`;
    ans.rows = 3;
    ans.maxLength = RULES.answerChars;
    ans.placeholder = 'Your answer — co-write it out loud';
    ans.style.width = '100%';
    ans.style.marginTop = '10px';
    wrap.appendChild(ans);

    const counter = el('p', 'dim small', `0 / ${RULES.answerWords} words`);
    counter.id = `mode-${slug}-words`;
    wrap.appendChild(counter);

    const send = el('button', 'big-btn', 'Lock in our answer');
    send.id = `mode-${slug}-send`;
    send.disabled = true;
    wrap.appendChild(send);

    ans.addEventListener('input', () => {
      const words = wordCount(ans.value);
      const over = words > RULES.answerWords;
      counter.textContent = over
        ? `${words} / ${RULES.answerWords} words — trim it down`
        : `${words} / ${RULES.answerWords} words`;
      counter.classList.toggle('error-line', over);
      send.disabled = cleanAnswer(ans.value) == null;
    });
    send.addEventListener('click', async () => {
      const answer = cleanAnswer(ans.value);
      if (!answer) return;
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        await ctx.submit({
          kind: 'answer',
          team: { code, name: cleanTeamName(nameIn.value, code) },
          answer,
        });
      } catch {
        send.disabled = false;
        send.textContent = 'Try again';
      }
    });
  };

  const paintJoiner = () => {
    wrap.innerHTML = '';
    wrap.appendChild(el('p', 'collect-ask', 'Join a team'));
    wrap.appendChild(el('h2', 'collect-question', 'Type your partner’s team code'));
    const codeIn = document.createElement('input');
    codeIn.id = `mode-${slug}-join-code`;
    codeIn.type = 'text';
    codeIn.className = 'code-input';
    codeIn.maxLength = 4;
    codeIn.placeholder = 'CODE';
    codeIn.autocomplete = 'off';
    codeIn.setAttribute('autocapitalize', 'characters');
    codeIn.addEventListener('input', () => {
      codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
    });
    wrap.appendChild(codeIn);
    const err = el('p', 'error-line', '');
    wrap.appendChild(err);
    const go = el('button', 'big-btn', 'Huddle up');
    go.id = `mode-${slug}-join-go`;
    go.addEventListener('click', async () => {
      err.textContent = '';
      let code;
      try {
        const joined = formationAct(form, { type: 'join', player: ME, code: codeIn.value });
        form = joined.state;
        code = joined.code;
      } catch {
        err.textContent = 'The code is 4 letters — it’s on your partner’s phone.';
        return;
      }
      go.disabled = true;
      go.textContent = 'Sending…';
      try {
        await ctx.submit({ kind: 'join', team: { code } });
      } catch {
        go.disabled = false;
        go.textContent = 'Try again';
      }
    });
    wrap.appendChild(go);
    backLink(wrap, paintChoose);
  };

  const paintPool = () => {
    form = formationAct(form, { type: 'enterPool', player: ME }).state;
    wrap.innerHTML = '';
    const hero = el('div', 'idle-hero');
    hero.appendChild(el('span', 'lantern', '✋'));
    const h = el('h1', null, 'LOOKING FOR A PARTNER');
    h.id = `mode-${slug}-beacon`;
    hero.appendChild(h);
    hero.appendChild(el('p', 'dim',
      'Hold your phone up — find another phone showing this screen. Two yeses make a team.'));
    wrap.appendChild(hero);
    const leavePool = () => { form = formationAct(form, { type: 'leavePool', player: ME }).state; };
    const mk = (id, label, fn) => {
      const b = el('button', 'collect-opt', label);
      b.id = `mode-${slug}-${id}`;
      b.addEventListener('click', () => { leavePool(); fn(); });
      wrap.appendChild(b);
    };
    mk('pool-start', 'We found each other — this phone writes', paintCaptain);
    mk('pool-join', 'We found each other — they’ll write, I’ll join', paintJoiner);
    mk('pool-leave', 'Never mind', paintChoose);
  };

  const paintWatch = () => {
    wrap.innerHTML = '';
    const hero = el('div', 'idle-hero');
    hero.appendChild(el('span', 'lantern', '👀'));
    hero.appendChild(el('h1', null, 'Spectating this one'));
    hero.appendChild(el('p', 'dim', 'Enjoy the huddles — you still vote when the face-offs start.'));
    wrap.appendChild(hero);
    backLink(wrap, paintChoose, 'Changed my mind');
  };

  const backLink = (parent, fn, label = '← Back') => {
    const b = el('button', 'chip-btn', label);
    b.id = `mode-${slug}-back`;
    b.style.marginTop = '12px';
    b.addEventListener('click', fn);
    parent.appendChild(b);
  };

  paintChoose();
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
export function narrated(step, results) {
  return narratedBeat(step, results);
}

/* ------------------------------------------------------------ the screen */

/** One beat on the big screen. Only host-approved content ever lands here:
 *  every answer shown cleared moderation in the write round. */
export function renderBeat(mount, step, results) {
  mount.innerHTML = '';
  const root = el('div');
  root.dataset.mode = slug;
  root.id = `mode-${slug}-beat`;
  root.dataset.step = String(step);
  const kind = beatKind(results, step);
  const r = results;
  const add = (n) => root.appendChild(n);

  switch (kind) {
    case 'prompt':
      add(el('div', 'beat-kicker land', 'TWO HEADS — the prompt was'));
      add(el('h2', 'beat-question land', r.prompt.text));
      break;
    case 'nobody':
      add(el('div', 'beat-kicker land', 'The contenders'));
      add(el('div', 'beat-drumroll land', 'No answers this round — free round!'));
      break;
    case 'parade': {
      add(el('h2', 'beat-question small', r.prompt.text));
      const list = el('div', 'beat-options');
      r.entries.forEach((e, i) => {
        const o = el('div', 'beat-option land');
        o.style.animationDelay = `${i * 0.35}s`;
        o.append(el('strong', null, e.name), document.createTextNode(` — “${e.answer}”`));
        list.appendChild(o);
      });
      add(list);
      if (r.overflow) add(el('div', 'beat-sub land', `…and ${r.overflow} more — what a room.`));
      if (r.cut) add(el('div', 'beat-sub land', `${r.entries.length + (r.overflow ?? 0)} teams wrote — ${RULES.bracketCap} advance by blind draw.`));
      break;
    }
    case 'bracket': {
      add(el('div', 'beat-kicker land', 'The bracket'));
      const list = el('div', 'beat-options');
      firstRoundLines(r.bracket).forEach((line, i) => {
        const o = el('div', 'beat-option land', line);
        o.style.animationDelay = `${i * 0.35}s`;
        list.appendChild(o);
      });
      add(list);
      add(el('div', 'beat-sub land', 'Phones ready — the first face-off is next.'));
      break;
    }
    case 'walkover':
      add(el('div', 'beat-kicker land', 'Champions by walkover'));
      add(el('h2', 'beat-winner land', r.walkover.name));
      add(el('div', 'beat-sub land', `“${r.walkover.answer}”`));
      break;
    case 'matchup': {
      add(el('div', 'beat-kicker land', r.label));
      const list = el('div', 'beat-options');
      const side = (s, i) => {
        const o = el('div', 'beat-option land');
        o.style.animationDelay = `${i * 0.5}s`;
        o.append(el('strong', null, `“${s.answer}”`), document.createTextNode(` — ${s.name}`));
        list.appendChild(o);
      };
      side(r.a, 0);
      const vs = el('div', 'beat-sub land', '— versus —');
      vs.style.animationDelay = '0.35s';
      list.appendChild(vs);
      side(r.b, 2);
      add(list);
      add(el('div', 'beat-sub land', 'Vote on your phone — spectators too.'));
      break;
    }
    case 'drumroll':
      add(el('div', 'beat-kicker land', r.label));
      add(el('div', 'beat-drumroll land', 'The room has voted.'));
      add(el('div', 'beat-sub land', `${r.votes} ballot${r.votes === 1 ? '' : 's'} in`));
      break;
    case 'winner': {
      add(el('div', 'beat-kicker land', 'The room picks…'));
      add(el('h2', 'beat-winner land', r.winner.name));
      add(el('div', 'beat-sub land', `“${r.winner.answer}”`));
      const bars = el('div', 'beat-bars');
      [['a', r.votesA, r.votePercents[0]], ['b', r.votesB, r.votePercents[1]]].forEach(([sideKey, votes, pct], i) => {
        const teamSide = sideKey === 'a' ? r.a : r.b;
        const row = el('div', 'bar-row' + (r.winnerSide === sideKey ? ' winner' : ''));
        const track = el('div', 'bar-track');
        const fill = el('div', 'bar-fill');
        fill.style.setProperty('--w', `${Math.max(2, pct)}%`);
        fill.style.animationDelay = `${0.3 + i * 0.5}s`;
        track.appendChild(fill);
        const count = el('div', 'bar-pct', String(votes));
        count.style.animationDelay = `${0.9 + i * 0.5}s`;
        row.append(el('div', 'bar-label', teamSide.name), track, count);
        bars.appendChild(row);
      });
      add(bars);
      if (r.tiebreak) add(el('div', 'beat-sub land', `Dead heat at ${r.votesA}–${r.votesB} — the coin decided.`));
      break;
    }
    case 'champion':
      add(el('div', 'beat-kicker land', 'TWO HEADS CHAMPIONS'));
      add(el('h2', 'beat-winner land', r.champion.name));
      add(el('div', 'beat-question small land', `“${r.champion.answer}”`));
      add(el('div', 'beat-sub land', 'Written by two heads. Take a bow.'));
      break;
    default: // 'next'
      add(el('div', 'beat-kicker land', 'Still alive'));
      add(el('h2', 'beat-question land', `${r.next.a.name} vs ${r.next.b.name}`));
      add(el('div', 'beat-sub land', `${r.next.label} — when the host fires it.`));
  }
  mount.appendChild(root);
}

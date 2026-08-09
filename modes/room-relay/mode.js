// ROOM RELAY — mode module (UI + wiring). All routing, assembly, and beat
// math lives in logic.js; this file renders and dispatches, per the fleet
// rule. Implements the contract in MODE-INTEGRATION.md.
//
// One extra wire the contract doesn't hand us: routing needs to know WHICH
// attendee this phone is, and phoneCollect's ctx carries no player id. We
// use the same escape hatch the contract blesses for party_vote — a second
// backend call from the mode — here an idempotent party_join (rejoining
// never burns a second chair) whose result includes our playerId.

import {
  SLUG, CHAIN_TYPES, SEQS, KIND_LABEL, RELAY,
  encodeDoodle, decodeDoodle, cleanStartPayload, cleanContinuePayload,
  buildStartConfig, buildContinuePlan, promptFor,
  computeStartResults, computeContinueResults,
  epochAt, assignmentFor, beatList, beatCount as beats, narratedBeat,
} from './logic.js';
import {
  getBackend, attendeeToken, getName, savedAttendeeSession,
} from '../../js/party-client.js';

export const slug = SLUG;
export const title = 'Room Relay';
export const tagline = 'Draw a bit, pass it blind, see what the room made.';

const TYPE_LABEL = {
  'doodle-then-title': { name: 'Doodle → title', hint: 'everyone draws; strangers name the drawings' },
  'phrase-then-doodle': { name: 'Phrase → doodle', hint: 'everyone writes a line; strangers draw it' },
  'headline-then-next-line': { name: 'Headline → next line', hint: 'fake local news, finished by someone else' },
};

/** Doodle ink — indices match logic.js RELAY.colors. */
const PALETTE = ['#f5ead1', '#e8a13c', '#7fb069', '#6ab0c9', '#d16a5f'];
const WIDTHS = [1.6, 3.2]; // grid units; fat is the default thumb brush
const PAPER = '#221d14';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ------------------------------------------------------------ deck cache */

let deckPromise = null;
function loadDeck() {
  if (!deckPromise) {
    deckPromise = fetch('content/room-relay-prompts.json')
      .then((r) => r.json())
      .catch(() => ({ doodle: ['something Vermont'], phrase: ['Write a line'], headline: ['BREAKING: …'], seedHeadlines: [] }));
  }
  return deckPromise;
}

/* --------------------------------------------------------- who is this? */

/** This phone's playerId, learned via an idempotent rejoin and cached per
 *  event. Falls back to null (the phone still gets a deterministic pick). */
async function myPlayerId() {
  const sess = savedAttendeeSession();
  if (!sess) return null;
  try {
    const cached = JSON.parse(localStorage.getItem('btown-party-relay-pid'));
    if (cached && cached.eventId === sess.eventId) return cached.playerId;
  } catch { /* recover below */ }
  try {
    const backend = await getBackend();
    const j = await backend.rpc('party_join', {
      p_code: sess.code, p_name: getName(), p_token: attendeeToken(),
    });
    localStorage.setItem('btown-party-relay-pid',
      JSON.stringify({ eventId: j.eventId, playerId: j.playerId }));
    return j.playerId;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ host setup */

export function hostSetup(ctx, mount) {
  mount.innerHTML = '';
  const wrap = el('div');
  wrap.dataset.mode = slug;
  mount.appendChild(wrap);

  // A relay mid-flight? The last relay results that still need a leg.
  const relayDone = (ctx.event.doneResults ?? []).filter((d) => d.results?.rr);
  const prior = relayDone.length ? relayDone[relayDone.length - 1].results : null;
  const pending = prior && prior.stage !== 'done' ? prior : null;

  if (pending) {
    const travelers = pending.chains.filter((c) => c.steps.length < pending.totalSteps).length;
    const card = el('div');
    const hint = el('p', 'host-hint',
      `Relay in flight: ${travelers} fragment${travelers === 1 ? '' : 's'} ready to travel to new hands (leg ${(pending.leg ?? 0) + 2} of ${pending.totalSteps}).`);
    const go = el('button', 'big-btn', '🔀 Route the fragments');
    go.id = `mode-${slug}-continue`;
    const err = el('p', 'dim small', '');
    go.addEventListener('click', () => {
      const plan = buildContinuePlan({
        prior: pending,
        players: ctx.event.players ?? [],
        seed: Date.now() & 0x7fffffff,
      });
      if (!plan) {
        err.textContent = 'Nobody available to carry these right now — wait for a phone or two, or start fresh below.';
        return;
      }
      plan.openedAtS = Math.floor(Date.now() / 1000);
      ctx.openRound(plan);
    });
    card.append(hint, go, err);
    wrap.appendChild(card);
    wrap.appendChild(el('p', 'host-hint', 'Or start a fresh relay instead (the one in flight keeps until you route it):'));
  } else {
    wrap.appendChild(el('p', 'host-hint',
      'Room Relay: everyone contributes a tiny piece, the app hands each piece to a different person, and the reveal shows what the room made. Pick tonight\'s flavor:'));
  }

  let steps3 = false;
  const toggle = el('button', 'question-pick', '');
  toggle.id = `mode-${slug}-steps`;
  const paintToggle = () => {
    toggle.textContent = steps3
      ? '3-step chains — longer, weirder (about 15 min all-in)'
      : '2-step chains — quick and tight (about 8 min all-in)';
    toggle.classList.toggle('sel', steps3);
  };
  paintToggle();
  toggle.addEventListener('click', () => { steps3 = !steps3; paintToggle(); });
  wrap.appendChild(toggle);

  CHAIN_TYPES.forEach((type) => {
    const btn = el('button', 'question-pick');
    btn.id = `mode-${slug}-start-${type}`;
    btn.append(el('span', 'qp-text', TYPE_LABEL[type].name), el('span', 'qp-meta', TYPE_LABEL[type].hint));
    btn.addEventListener('click', async () => {
      const deck = await loadDeck();
      const config = buildStartConfig({
        chainType: type,
        totalSteps: steps3 ? 3 : 2,
        deck,
        checkinQs: ctx.event.questions ?? [],
        seed: Date.now() & 0x7fffffff,
      });
      ctx.openRound(config);
    });
    wrap.appendChild(btn);
  });
}

/* ------------------------------------------------------------ moderation */

const fragLine = (frag) => (frag.t === 'doodle'
  ? `[doodle · ${decodeDoodle(frag.d)?.length ?? 0} strokes]`
  : `“${frag.s}”`);

/** One human line per submission for the shell's moderation queue — this
 *  list IS the gate: on a start round it clears fragments to travel, on a
 *  continue round it clears each assembled chain to be revealed. */
export function describeSubmission(payload, config) {
  if (config?.phase === 'start') {
    const p = cleanStartPayload(payload, config);
    if (!p) return '(not a relay entry — reject)';
    const prompt = p.prompt != null ? config.prompts[p.prompt] : 'freestyle';
    return `${fragLine(p.frag)} · from “${prompt}”`;
  }
  if (config?.phase === 'continue') {
    const p = cleanContinuePayload(payload, config);
    if (!p) return '(not a relay entry — reject)';
    const i = config.chains.findIndex((c) => c.id === p.chainId);
    const chain = config.chains[i];
    const got = chain.hist[chain.hist.length - 1]?.frag;
    return `chain ${i + 1}: ${fragLine(got)} → ${fragLine(p.frag)}`;
  }
  return '(not a relay entry — reject)';
}

/* ------------------------------------------------------- doodle rendering */

function doodleSvg(d, sizeCss) {
  const strokes = decodeDoodle(d) ?? [];
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${RELAY.grid} ${RELAY.grid}`);
  svg.setAttribute('width', sizeCss);
  svg.setAttribute('height', sizeCss);
  svg.style.background = PAPER;
  svg.style.borderRadius = '12px';
  svg.style.maxWidth = '100%';
  for (const st of strokes) {
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', st.pts.map(([x, y]) => `${x},${y}`).join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', PALETTE[st.c] ?? PALETTE[0]);
    line.setAttribute('stroke-width', String(WIDTHS[st.w] ?? WIDTHS[1]));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);
  }
  return svg;
}

/** The thumb canvas: fat brush, five inks, undo, strokes kept as compact
 *  vector data. Returns { root, getEncoded(), onInk }. */
function doodlePad(onFirstInk) {
  const root = el('div');
  root.style.textAlign = 'center';
  const canvas = document.createElement('canvas');
  canvas.id = `mode-${slug}-canvas`;
  canvas.style.width = 'min(78vw, 320px)';
  canvas.style.height = 'min(78vw, 320px)';
  canvas.style.borderRadius = '12px';
  canvas.style.touchAction = 'none';
  canvas.style.background = PAPER;
  canvas.style.border = '1px solid rgba(245,234,209,0.2)';

  const strokes = [];
  let live = null;   // stroke being drawn
  let color = 1;     // amber
  let inked = false;

  const ctx2d = canvas.getContext('2d');
  function fit() {
    const cssW = canvas.clientWidth || 320;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssW * dpr;
    redraw();
  }
  function redraw() {
    const s = canvas.width / RELAY.grid;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    for (const st of [...strokes, ...(live ? [live] : [])]) {
      ctx2d.strokeStyle = PALETTE[st.c];
      ctx2d.lineWidth = WIDTHS[st.w] * s;
      ctx2d.lineCap = 'round';
      ctx2d.lineJoin = 'round';
      ctx2d.beginPath();
      st.pts.forEach(([x, y], i) => {
        if (i === 0) ctx2d.moveTo((x + 0.5) * s, (y + 0.5) * s);
        else ctx2d.lineTo((x + 0.5) * s, (y + 0.5) * s);
      });
      if (st.pts.length === 1) ctx2d.lineTo((st.pts[0][0] + 0.5) * s + 0.1, (st.pts[0][1] + 0.5) * s);
      ctx2d.stroke();
    }
  }
  const gridPoint = (ev) => {
    const r = canvas.getBoundingClientRect();
    const g = RELAY.grid;
    const x = Math.max(0, Math.min(g - 1, Math.floor(((ev.clientX - r.left) / r.width) * g)));
    const y = Math.max(0, Math.min(g - 1, Math.floor(((ev.clientY - r.top) / r.height) * g)));
    return [x, y];
  };

  const note = el('p', 'dim small', '');
  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (!inked) { inked = true; onFirstInk?.(); }
    live = { c: color, w: 1, pts: [gridPoint(ev)] };
    redraw();
  });
  // Move/up live on window so a finger sliding off the canvas still ends
  // the stroke (the fleet's lost-pointerup lesson).
  window.addEventListener('pointermove', (ev) => {
    if (!live || !canvas.isConnected) { live = canvas.isConnected ? live : null; return; }
    const [x, y] = gridPoint(ev);
    const [lx, ly] = live.pts[live.pts.length - 1];
    if (Math.abs(x - lx) + Math.abs(y - ly) >= 2) {
      live.pts.push([x, y]);
      redraw();
    }
  });
  window.addEventListener('pointerup', () => {
    if (!live) return;
    strokes.push(live);
    live = null;
    if (strokes.length > RELAY.doodleStrokes
        || encodeDoodle(strokes).length > RELAY.doodleChars) {
      strokes.pop();
      note.textContent = 'Ink\'s out — that\'s plenty of masterpiece.';
    }
    redraw();
  });

  const tools = el('div');
  tools.style.cssText = 'display:flex;gap:8px;justify-content:center;align-items:center;margin:10px 0;flex-wrap:wrap;';
  PALETTE.forEach((hex, i) => {
    const b = el('button');
    b.id = `mode-${slug}-color-${i}`;
    b.setAttribute('aria-label', `ink ${i + 1}`);
    b.style.cssText = `width:34px;height:34px;border-radius:50%;border:3px solid ${i === color ? '#fff' : 'transparent'};background:${hex};padding:0;`;
    b.addEventListener('click', () => {
      color = i;
      [...tools.querySelectorAll('button')].forEach((x, xi) => {
        if (xi < PALETTE.length) x.style.borderColor = xi === i ? '#fff' : 'transparent';
      });
    });
    tools.appendChild(b);
  });
  const undo = el('button', 'opt-btn', '↩ undo');
  undo.id = `mode-${slug}-undo`;
  undo.style.cssText = 'width:auto;padding:6px 14px;margin:0;';
  undo.addEventListener('click', () => { strokes.pop(); note.textContent = ''; redraw(); });
  tools.appendChild(undo);

  root.append(canvas, tools, note);
  requestAnimationFrame(fit);
  return { root, getEncoded: () => encodeDoodle(strokes), hasInk: () => strokes.length > 0 };
}

/* ----------------------------------------------------------- phone input */

const KIND_HINT = {
  doodle: 'Fat brush, fifteen seconds, no artistic pressure.',
  title: 'Short and confident — like it hangs in a gallery.',
  phrase: 'One line. Someone you haven\'t met will deal with it.',
  headline: 'Finish it like the paper would never dare.',
  nextline: 'One sentence. Make it worse (better).',
};

/** Shared input block: returns { root, focus } and wires ctx.submit. */
function inputBlock(kind, buildPayload, ctxSubmit, onFirstTouch) {
  const root = el('div');
  let pad = null;
  let text = null;
  const send = el('button', 'big-btn', 'Send it on');
  send.id = `mode-${slug}-send`;
  send.disabled = true;

  if (kind === 'doodle') {
    pad = doodlePad(() => { onFirstTouch?.(); send.disabled = false; });
    root.appendChild(pad.root);
  } else {
    text = document.createElement('input');
    text.type = 'text';
    text.id = `mode-${slug}-text`;
    text.maxLength = RELAY.textLen;
    text.placeholder = KIND_LABEL[kind] + '…';
    text.autocomplete = 'off';
    text.style.cssText = 'width:100%;font-size:18px;padding:12px;border-radius:10px;border:1px solid rgba(245,234,209,0.3);background:rgba(0,0,0,0.25);color:inherit;';
    text.addEventListener('input', () => {
      onFirstTouch?.();
      send.disabled = !text.value.trim();
    });
    root.appendChild(text);
  }
  root.appendChild(el('p', 'dim small', KIND_HINT[kind] ?? ''));

  send.addEventListener('click', async () => {
    const frag = kind === 'doodle'
      ? (pad.hasInk() ? { t: 'doodle', d: pad.getEncoded() } : null)
      : (text.value.trim() ? { t: 'text', s: text.value.trim() } : null);
    if (!frag) return;
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await ctxSubmit(buildPayload(frag));
    } catch {
      send.disabled = false;
      send.textContent = 'Try again';
    }
  });
  root.appendChild(send);
  return root;
}

/**
 * The collect surface. Start rounds: your prompt + a doodle pad or a text
 * line. Continue rounds: the routed fragment (ONLY the fragment — no
 * prompt, no history) + the next-step input. Assignments are evaluated
 * locally every few seconds so an expired one silently drifts to whoever
 * is actually looking; the first touch locks yours in place.
 */
export function phoneCollect(ctx, mount) {
  mount.innerHTML = '';
  const wrap = el('div');
  wrap.dataset.mode = slug;
  mount.appendChild(wrap);
  const config = ctx.round.config;
  if (!config?.rr) {
    wrap.appendChild(el('p', 'dim', 'This round is happening in the room — eyes up.'));
    return;
  }

  if (config.phase === 'start') {
    wrap.appendChild(el('p', 'collect-ask', 'Room Relay — your fragment'));
    const kind = SEQS[config.chainType][0];
    (async () => {
      const pid = await myPlayerId();
      const pi = promptFor(config, pid ?? attendeeToken());
      wrap.appendChild(el('h2', 'collect-question', config.prompts[pi]));
      wrap.appendChild(inputBlock(kind,
        (frag) => ({ rr: 1, author: pid, prompt: pi, frag }), ctx.submit));
    })();
    return;
  }

  // continue round: find (and keep finding) this phone's assignment
  wrap.appendChild(el('p', 'collect-ask', 'Room Relay — something\'s been passed to you'));
  const body = el('div');
  wrap.appendChild(body);
  let renderedChainId = null;
  let locked = false;
  let timer = 0;

  const paintWaiting = () => {
    renderedChainId = null;
    body.innerHTML = '';
    body.appendChild(el('h2', 'collect-question', 'The relay is weaving through the room…'));
    body.appendChild(el('p', 'dim', 'Nothing for you right this second. Eyes up — this screen will wake when a fragment lands.'));
  };

  const paintAssignment = (chain, pid) => {
    renderedChainId = chain.id;
    body.innerHTML = '';
    const got = chain.hist[chain.hist.length - 1].frag;
    if (got.t === 'doodle') {
      const holder = el('div');
      holder.style.textAlign = 'center';
      holder.appendChild(doodleSvg(got.d, 'min(60vw, 240px)'));
      body.appendChild(holder);
    } else {
      body.appendChild(el('h2', 'collect-question', `“${got.s}”`));
    }
    body.appendChild(el('p', 'collect-ask', KIND_LABEL[chain.kind]));
    body.appendChild(inputBlock(chain.kind,
      (frag) => ({ rr: 1, author: pid, chain: chain.id, frag }),
      async (payload) => { clearInterval(timer); await ctx.submit(payload); },
      () => { locked = true; }));
  };

  (async () => {
    const pid = await myPlayerId();
    const tick = () => {
      if (!mount.isConnected) { clearInterval(timer); return; }
      if (locked) return;
      const epoch = epochAt(config, Math.floor(Date.now() / 1000));
      const chain = assignmentFor(config, pid, epoch);
      if (!chain) {
        if (renderedChainId !== null || !body.childElementCount) paintWaiting();
        return;
      }
      if (chain.id !== renderedChainId) paintAssignment(chain, pid);
    };
    tick();
    timer = setInterval(tick, 5000);
  })();
}

/* -------------------------------------------------------------- the math */

/** Shell → mode: approved inputs → the stored results object. Both gates
 *  live upstream of this call: `approved` is host-approved content only. */
export function computeResults({ config, approved, checkinTallies }) {
  if (config?.phase === 'start') {
    return computeStartResults({ config, approved, checkinTallies });
  }
  return computeContinueResults({ config, approved });
}

export function beatCount(results) {
  return beats(results);
}

export function narrated(step, results) {
  return narratedBeat(step, results);
}

/* ------------------------------------------------------------ the screen */

/** One beat on the big screen. Chains land cumulatively: earlier steps
 *  shrink upward as the new one arrives, names ride with their work. */
export function renderBeat(mount, step, results) {
  mount.innerHTML = '';
  const root = el('div');
  root.dataset.mode = slug;
  root.id = `mode-${slug}-beat`;
  root.dataset.step = String(step);
  mount.appendChild(root);

  const beatsAll = beatList(results);
  const b = beatsAll[Math.max(0, Math.min(step, beatsAll.length - 1))];
  const chain = b.ci != null ? results.chains[b.ci] : null;

  const stepEl = (s, big) => {
    const holder = el('div', big ? 'land' : '');
    holder.style.margin = big ? '2.5vmin 0' : '1.2vmin 0';
    if (s.frag.t === 'doodle') {
      holder.style.textAlign = 'center';
      holder.appendChild(doodleSvg(s.frag.d, big ? 'min(44vmin, 420px)' : 'min(16vmin, 150px)'));
    } else {
      const q = el('div', big ? 'beat-question' : 'beat-question small', `“${s.frag.s}”`);
      holder.appendChild(q);
    }
    holder.appendChild(el('div', big ? 'beat-sub' : 'dim small', `— ${s.by}`));
    return holder;
  };

  switch (b.k) {
    case 'teaser': {
      const n = results?.chains?.length ?? 0;
      root.appendChild(el('div', 'beat-kicker land', 'Room Relay'));
      root.appendChild(el('h2', 'beat-question land', `${n} fragment${n === 1 ? '' : 's'} are in.`));
      root.appendChild(el('div', 'beat-sub land', 'They\'re being shuffled to new hands — keep your phone nearby.'));
      break;
    }
    case 'intro':
      root.appendChild(el('div', 'beat-kicker land', 'Room Relay — the reveal'));
      root.appendChild(el('h2', 'beat-question land', `This room made ${results.chains.length} things together.`));
      root.appendChild(el('div', 'beat-sub land', 'Nobody saw the whole of any of them. Until now.'));
      break;
    case 'prompt':
      root.appendChild(el('div', 'beat-kicker land', `Chain ${b.ci + 1} of ${results.chains.length} — it started with`));
      root.appendChild(el('h2', 'beat-question land', `“${chain.prompt}”`));
      break;
    case 'step': {
      root.appendChild(el('div', 'beat-kicker', `Chain ${b.ci + 1} of ${results.chains.length} — “${chain.prompt}”`));
      for (let i = 0; i < b.si; i++) root.appendChild(stepEl(chain.steps[i], false));
      root.appendChild(stepEl(chain.steps[b.si], true));
      break;
    }
    case 'flop': {
      root.appendChild(el('div', 'beat-kicker', `Chain ${b.ci + 1} of ${results.chains.length} — “${chain.prompt}”`));
      chain.steps.forEach((s) => root.appendChild(stepEl(s, false)));
      root.appendChild(el('h2', 'beat-drumroll land', '…the room never finished this one.'));
      root.appendChild(el('div', 'beat-sub land', 'Honestly? Perfect as is.'));
      break;
    }
    default: {
      const flops = results.chains.length - results.finished;
      root.appendChild(el('div', 'beat-kicker land', 'That\'s the relay'));
      root.appendChild(el('h2', 'beat-question land',
        `${results.finished} finished chain${results.finished === 1 ? '' : 's'}${flops ? ` · ${flops} beautiful loose end${flops === 1 ? '' : 's'}` : ''}`));
      root.appendChild(el('div', 'beat-sub land', 'Go find out who titled yours.'));
    }
  }
}

// BTOWN PARTY — the host console. Stephen's AV rig: create the event, watch
// the roster, open rounds, approve every submission, and pace the reveal
// beat by beat (the narrated view doubles as the no-TV reveal — he reads it
// aloud). UI only; every decision the backend can enforce, it enforces.

import {
  getBackend, isDemo, hostKey,
  savedHostEvent, saveHostEvent, clearHostEvent,
  startPolling, PartyError,
} from './party-client.js';
import { MODES } from '../modes/manifest.js';

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

let backend = null;
let session = null;       // { eventId, code }
let snap = null;          // last host_get
let poller = null;
let roundSig = '';        // re-render the round card only when this changes
let narratedSig = '';
let armed = {};           // two-tap confirmations, keyed by action

/* -------------------------------------------------------------- create */

async function loadDeck() {
  try {
    const res = await fetch('content/roomknows-questions.json');
    return (await res.json()).questions;
  } catch {
    return [];
  }
}

async function renderSetup() {
  const deck = await loadDeck();
  const picker = $('questionPicker');
  picker.innerHTML = '';
  const picked = new Set([0, 1, 2].slice(0, Math.min(3, deck.length)));
  deck.forEach((q, i) => {
    const btn = document.createElement('button');
    btn.className = 'question-pick' + (picked.has(i) ? ' sel' : '');
    btn.id = `setupQ${i}`;
    btn.innerHTML = '<span class="qp-text"></span><span class="qp-meta"></span>';
    btn.querySelector('.qp-text').textContent = q.text;
    btn.querySelector('.qp-meta').textContent = q.options.join(' · ');
    if (picked.has(i)) btn.style.borderColor = 'var(--amber)';
    btn.addEventListener('click', () => {
      if (picked.has(i)) picked.delete(i);
      else if (picked.size < 3) picked.add(i);
      btn.style.borderColor = picked.has(i) ? 'var(--amber)' : '';
      btn.classList.toggle('sel', picked.has(i));
    });
    picker.appendChild(btn);
  });
  $('hostCreate').onclick = async () => {
    const err = $('setupError');
    err.textContent = '';
    if (picked.size !== 3) { err.textContent = 'Pick exactly 3 questions.'; return; }
    const questions = [...picked].sort((a, b) => a - b)
      .map((i) => ({ id: deck[i].id, text: deck[i].text, options: deck[i].options }));
    $('hostCreate').disabled = true;
    try {
      const r = await backend.rpc('party_create_event', {
        p_host_key: hostKey(), p_questions: questions,
        p_title: $('eventTitle').value.trim(),
      });
      session = { eventId: r.eventId, code: r.code };
      saveHostEvent(session);
      startRunning();
    } catch (e) {
      err.textContent = e.code === 'not_ready'
        ? 'Party mode isn\'t switched on yet — see PARTY-SETUP.md.'
        : `Couldn't start the event (${e.code ?? e.message}).`;
    } finally {
      $('hostCreate').disabled = false;
    }
  };
  show('setupPanel', true);
}

/* -------------------------------------------------------------- running */

function startRunning() {
  show('setupPanel', false);
  show('runPanel', true);
  $('hostCode').textContent = session.code;
  $('screenHint').textContent = `${location.origin}${location.pathname.replace(/host\.html$/, '')}screen.html`;
  poller?.stop();
  poller = startPolling(tick, { onError: onPollError });
}

async function tick() {
  snap = await backend.rpc('party_host_get', { p_event: session.eventId, p_host_key: hostKey() });
  renderRoster();
  renderRound();
  renderNarrated();
}

function renderRoster() {
  $('hostCount').textContent = `${snap.players.length} in the room`;
  const roster = $('hostRoster');
  roster.innerHTML = '';
  snap.players.forEach((p) => {
    const chip = document.createElement('button');
    chip.className = 'who' + (p.away ? ' away' : '');
    chip.textContent = p.name + (p.checkinDone ? '' : ' ○');
    chip.title = p.checkinDone ? '' : 'hasn\'t checked in';
    chip.addEventListener('click', () => twoTap(`kick-${p.id}`, chip, `remove ${p.name}?`, async () => {
      await backend.rpc('party_remove_player', {
        p_event: session.eventId, p_host_key: hostKey(), p_player: p.id,
      });
      poller.poke();
    }));
    roster.appendChild(chip);
  });
  if (!snap.players.length) {
    roster.innerHTML = '<span class="dim small">Nobody yet — the QR is on the screen page.</span>';
  }
}

/** Fleet-style two-tap confirm: first tap arms and relabels, second fires. */
function twoTap(key, btn, armLabel, fn) {
  if (armed[key]) {
    delete armed[key];
    fn().catch(() => {});
    return;
  }
  const original = btn.textContent;
  armed[key] = true;
  btn.textContent = armLabel;
  setTimeout(() => {
    if (armed[key]) {
      delete armed[key];
      btn.textContent = original;
    }
  }, 2500);
}

/* ---------------------------------------------------------- round card */

function renderRound() {
  const r = snap.round;
  const sig = r
    ? `${r.id}:${r.status}:${r.submissions.map((s) => s.id + s.status).join(',')}`
    : `idle:${snap.roundsPlayed}:${(snap.checkinTallies ?? []).map((t) => t?.total).join(',')}`;
  if (sig === roundSig) return;
  roundSig = sig;

  if (!r) {
    show('roundLive', false);
    show('roundSetupMount', true);
    const playedQuestionIds = snap.doneResults
      .map((d) => d.results?.question?.id)
      .filter(Boolean);
    // Only one mode tonight; a mode picker appears when a sibling lands.
    const mode = Object.values(MODES)[0];
    mode.hostSetup({
      event: snap,
      playedQuestionIds,
      openRound: async (config) => {
        await backend.rpc('party_open_round', {
          p_event: session.eventId, p_host_key: hostKey(),
          p_mode: mode.slug, p_config: config,
        });
        poller.poke();
      },
    }, $('roundSetupMount'));
    return;
  }

  show('roundSetupMount', false);
  show('roundLive', true);
  const mode = MODES[r.mode];
  const pending = r.submissions.filter((s) => s.status === 'pending').length;
  const approvedCount = r.submissions.filter((s) => s.status === 'approved').length;
  $('roundStatus').textContent = r.status === 'collecting'
    ? `Collecting — ${r.submissions.length} in (${approvedCount} approved, ${pending} to review)`
    : `Closed — ${approvedCount} approved, ${pending} to review. Approve, then fire the reveal.`;

  const queue = $('modQueue');
  queue.innerHTML = '';
  r.submissions.forEach((s) => {
    const row = document.createElement('div');
    row.className = `mod-row ${s.status}`;
    row.dataset.submission = s.id;
    const who = document.createElement('span');
    who.className = 'mod-who';
    who.textContent = s.name;
    const what = document.createElement('span');
    what.className = 'mod-what';
    what.textContent = mode?.describeSubmission?.(s.payload, r.config) ?? JSON.stringify(s.payload);
    const btns = document.createElement('span');
    btns.className = 'mod-btns';
    for (const [cls, glyph, status, label] of [
      ['b-ok', '✓', 'approved', 'approve'],
      ['b-hold', '⏸', 'held', 'hold'],
      ['b-no', '✕', 'rejected', 'reject'],
    ]) {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = glyph;
      b.setAttribute('aria-label', `${label} ${s.name}'s entry`);
      b.addEventListener('click', async () => {
        await backend.rpc('party_moderate', {
          p_event: session.eventId, p_host_key: hostKey(),
          p_submission: s.id, p_status: status,
        });
        poller.poke();
      });
      btns.appendChild(b);
    }
    row.append(who, what, btns);
    queue.appendChild(row);
  });
  if (!r.submissions.length) {
    queue.innerHTML = '<p class="dim small">Nothing in yet — give the room a beat.</p>';
  }

  show('closeRoundBtn', r.status === 'collecting');
  show('revealBtn', r.status === 'moderating');
  show('approveAllBtn', pending > 0);
}

function wireRoundButtons() {
  $('approveAllBtn').addEventListener('click', async () => {
    if (!snap?.round) return;
    await backend.rpc('party_moderate_all', {
      p_event: session.eventId, p_host_key: hostKey(),
      p_round: snap.round.id, p_status: 'approved',
    });
    poller.poke();
  });
  $('closeRoundBtn').addEventListener('click', async () => {
    await backend.rpc('party_close_round', { p_event: session.eventId, p_host_key: hostKey() });
    poller.poke();
  });
  $('revealBtn').addEventListener('click', async () => {
    const btn = $('revealBtn');
    btn.disabled = true;
    try {
      // Compute from a FRESH snapshot, not the last poll — an approve tap
      // a second ago must be in the reveal, and the backend is the truth.
      const fresh = await backend.rpc('party_host_get', {
        p_event: session.eventId, p_host_key: hostKey(),
      });
      const r = fresh.round;
      if (!r || r.status !== 'moderating') return;
      const mode = MODES[r.mode];
      const approved = r.submissions
        .filter((s) => s.status === 'approved')
        .map((s) => ({ name: s.name, payload: s.payload }));
      const results = mode.computeResults({
        config: r.config, approved, checkinTallies: fresh.checkinTallies,
      });
      await backend.rpc('party_start_reveal', {
        p_event: session.eventId, p_host_key: hostKey(),
        p_round: r.id, p_results: results,
      });
      poller.poke();
    } finally {
      btn.disabled = false;
    }
  });
  $('scrapRoundBtn').addEventListener('click', function () {
    twoTap('scrap', this, 'really scrap it?', async () => {
      await backend.rpc('party_end_round', { p_event: session.eventId, p_host_key: hostKey() });
      poller.poke();
    });
  });
  $('endEventBtn').addEventListener('click', function () {
    twoTap('end-event', this, 'really end the night?', async () => {
      await backend.rpc('party_close_event', { p_event: session.eventId, p_host_key: hostKey() });
      clearHostEvent();
      poller.stop();
      location.reload();
    });
  });
  $('shareBtn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname.replace(/host\.html$/, '')}?join=${session.code}${isDemo() ? '&demo=1' : ''}`;
    if (navigator.share) {
      navigator.share({ title: 'Btown Party', text: 'Join the room', url }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
      const b = $('shareBtn');
      b.textContent = '✓ link copied';
      setTimeout(() => { b.textContent = '📲 invite link'; }, 1500);
    }
  });
}

/* ------------------------------------------------------ narrated reveal */

function renderNarrated() {
  const r = snap.round;
  const revealing = r && r.status === 'revealing';
  const sig = revealing ? `${r.id}:${r.revealStep}` : '';
  show('narrated', revealing);
  if (!revealing || sig === narratedSig) { narratedSig = sig; return; }
  narratedSig = sig;

  const mode = MODES[r.mode];
  const beats = mode.beatCount(r.results);
  const beat = mode.narrated(r.revealStep, r.results, snap.doneResults);
  $('narratedTitle').textContent = beat.title;
  const lines = $('narratedLines');
  lines.innerHTML = '';
  beat.lines.forEach((line, i) => {
    const n = document.createElement('div');
    n.className = 'n-line' + (i > 0 && beat.lines.length > 1 && i === beat.lines.length - 1 ? ' secondary' : '');
    n.textContent = line;
    lines.appendChild(n);
  });
  $('narratedStep').textContent = `beat ${r.revealStep + 1} of ${beats} — read it out, then tap`;
  const last = r.revealStep >= beats - 1;
  $('narratedNext').textContent = last ? 'Wrap the round' : 'Next beat →';
  $('narratedNext').onclick = async () => {
    if (last) {
      await backend.rpc('party_end_round', { p_event: session.eventId, p_host_key: hostKey() });
    } else {
      await backend.rpc('party_reveal_step', {
        p_event: session.eventId, p_host_key: hostKey(),
        p_round: r.id, p_step: r.revealStep + 1,
      });
    }
    poller.poke();
  };
}

/* ----------------------------------------------------------------- boot */

function onPollError(e) {
  if (e instanceof PartyError && e.code === 'not_ready') {
    poller.stop();
    show('runPanel', false);
    show('offlinePanel', true);
  } else if (e instanceof PartyError && ['not_found', 'not_host'].includes(e.code)) {
    poller.stop();
    clearHostEvent();
    show('runPanel', false);
    renderSetup();
  }
}

(async function boot() {
  backend = await getBackend();
  if (isDemo()) $('demoBanner').classList.remove('hidden');
  wireRoundButtons();

  if (backend.demo) {
    session = backend.session();
    saveHostEvent(session);
    startRunning();
    return;
  }
  const saved = savedHostEvent();
  if (saved) {
    session = saved;
    try {
      await backend.rpc('party_host_get', { p_event: session.eventId, p_host_key: hostKey() });
      startRunning();
      return;
    } catch (e) {
      if (e.code === 'not_ready') { show('offlinePanel', true); return; }
      clearHostEvent();
    }
  }
  renderSetup();
})();

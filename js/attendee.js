// BTOWN PARTY — the attendee phone. UI only: joins, checks in, naps, wakes
// for a round, submits, goes back to watching the room. All state truth
// comes from the backend poll; all round input UI comes from the mode.

import {
  getBackend, isDemo, attendeeToken, getName, setName,
  savedAttendeeSession, saveAttendeeSession, clearAttendeeSession,
  startPolling, PartyError,
} from './party-client.js';
import { MODES } from '../modes/manifest.js';

const $ = (id) => document.getElementById(id);
const PANELS = ['joinPanel', 'checkinPanel', 'idlePanel', 'collectPanel', 'lockedPanel', 'overPanel', 'offlinePanel'];
function show(panel) {
  for (const p of PANELS) $(p).classList.toggle('hidden', p !== panel);
}

let backend = null;
let session = null;        // { eventId, code }
let joined = null;         // last join result (questions live here)
let poller = null;
let renderedRoundId = null;
let localSubmitted = false; // bridges the gap until the poll confirms

/* ------------------------------------------------------------------ join */

function prefillFromLink() {
  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (code) {
    $('joinCode').value = code.toUpperCase().slice(0, 4);
    // Scrub the code so a refresh doesn't look like a fresh scan.
    params.delete('join');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
  }
  $('joinName').value = getName();
}

async function join() {
  const name = $('joinName').value.trim();
  const code = $('joinCode').value.trim().toUpperCase();
  const err = $('joinError');
  err.textContent = '';
  if (!name) { err.textContent = 'A first name is all we need.'; return; }
  if (code.length !== 4) { err.textContent = 'The room code is 4 letters — it\'s on the screen.'; return; }
  $('joinGo').disabled = true;
  try {
    joined = await backend.rpc('party_join', { p_code: code, p_name: name, p_token: attendeeToken() });
    setName(joined.name);
    session = { eventId: joined.eventId, code };
    saveAttendeeSession(session);
    if (joined.checkinDone) startNight();
    else startCheckin();
  } catch (e) {
    err.textContent = joinErrorLine(e);
  } finally {
    $('joinGo').disabled = false;
  }
}

function joinErrorLine(e) {
  switch (e.code) {
    case 'not_found': return 'No room with that code right now — double-check the screen.';
    case 'bad_code': return 'The room code is 4 letters — it\'s on the screen.';
    case 'event_closed': return 'That event has wrapped up.';
    case 'event_full': return 'The room is packed — flag down the host.';
    case 'not_ready': return 'Party mode isn\'t switched on yet.';
    case 'offline': return 'No connection — check your signal and try again.';
    default: return 'Something hiccuped — try again.';
  }
}

/* --------------------------------------------------------------- check-in */

function startCheckin() {
  const questions = joined.questions ?? [];
  if (!questions.length) { startNight(); return; }
  $('checkinHello').textContent = `Hey ${joined.name} — quick check-in`;
  const answers = {};
  let at = 0;
  const dots = $('checkinDots');
  dots.innerHTML = questions.map(() => '<i></i>').join('');

  const paint = () => {
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i <= at));
    const q = questions[at];
    const body = $('checkinBody');
    body.innerHTML = '';
    const h = document.createElement('h2');
    h.className = 'checkin-q';
    h.textContent = q.text;
    body.appendChild(h);
    q.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'opt-btn';
      b.id = `checkinOpt${i}`;
      b.textContent = opt;
      b.addEventListener('click', async () => {
        answers[q.id] = i;
        b.classList.add('sel');
        await new Promise((r) => setTimeout(r, 180)); // let the tap land visually
        if (at < questions.length - 1) { at += 1; paint(); } else { finish(); }
      });
      body.appendChild(b);
    });
  };
  const finish = async () => {
    try {
      await backend.rpc('party_checkin', { p_event: session.eventId, p_token: attendeeToken(), p_answers: answers });
    } catch { /* check-in is porous — a lost write is not worth an error screen */ }
    startNight();
  };
  $('checkinSkip').onclick = () => startNight();
  show('checkinPanel');
  paint();
}

/* ------------------------------------------------------------- the night */

function startNight() {
  show('idlePanel');
  $('idleTitle').textContent = `You're in, ${joined?.name ?? getName() ?? ''}.`.replace(', .', '.');
  poller?.stop();
  poller = startPolling(tick, { onError: onPollError });
}

async function tick() {
  const s = await backend.rpc('party_player_get', { p_event: session.eventId, p_token: attendeeToken() });
  if (s.status === 'closed') {
    poller.stop();
    clearAttendeeSession();
    show('overPanel');
    return;
  }
  const r = s.round;
  if (!r || ['revealing', 'moderating'].includes(r.status)) {
    // Rounds being revealed belong to the room; the phone stays dark.
    renderedRoundId = r?.id ?? null;
    if (!$('idlePanel').classList.contains('hidden')) return;
    show('idlePanel');
    return;
  }
  if (r.status === 'collecting') {
    if (r.submitted || (localSubmitted && renderedRoundId === r.id)) {
      show('lockedPanel');
      return;
    }
    if (renderedRoundId !== r.id || $('collectPanel').classList.contains('hidden')) {
      renderedRoundId = r.id;
      localSubmitted = false;
      renderCollect(r);
    }
  }
}

function renderCollect(round) {
  const mode = MODES[round.mode];
  const mount = $('collectMount');
  if (!mode) {
    mount.innerHTML = '<p class="dim">This round is happening in the room — eyes up.</p>';
    show('collectPanel');
    return;
  }
  mode.phoneCollect({
    round,
    event: { questions: joined?.questions ?? [] },
    submit: async (payload) => {
      await backend.rpc('party_submit', {
        p_event: session.eventId, p_token: attendeeToken(),
        p_round: round.id, p_payload: payload,
      });
      localSubmitted = true;
      show('lockedPanel');
      if (navigator.vibrate) navigator.vibrate(30);
    },
  }, mount);
  show('collectPanel');
}

function onPollError(e) {
  if (!(e instanceof PartyError)) return;
  if (e.code === 'not_ready') {
    poller.stop();
    show('offlinePanel');
  } else if (['not_found', 'not_joined'].includes(e.code)) {
    // The event was swept or we were removed — back to the door.
    poller.stop();
    clearAttendeeSession();
    show('joinPanel');
    $('joinError').textContent = 'That event has wrapped up.';
  }
  // transient offline: keep polling, the loop already survives it
}

/* ----------------------------------------------------------------- boot */

(async function boot() {
  backend = await getBackend();
  if (isDemo()) $('demoBanner').classList.remove('hidden');
  prefillFromLink();
  $('joinGo').addEventListener('click', join);
  $('joinCode').addEventListener('input', () => {
    $('joinCode').value = $('joinCode').value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  });

  // Wandered back mid-event? Rejoin silently with the saved seat.
  const saved = savedAttendeeSession();
  if (saved) {
    try {
      joined = await backend.rpc('party_join', {
        p_code: saved.code, p_name: getName(), p_token: attendeeToken(),
      });
      session = { eventId: joined.eventId, code: saved.code };
      startNight();
      return;
    } catch {
      clearAttendeeSession();
    }
  }
  show('joinPanel');
})();

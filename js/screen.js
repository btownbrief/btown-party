// BTOWN PARTY — the big screen (laptop into a TV or projector). Read-only
// and unauthenticated: the backend physically cannot hand this page
// anything the host didn't approve. Huge type, join QR always in the
// corner, reveal beats animated as the host taps through them.

import { getBackend, isDemo, startPolling, PartyError } from './party-client.js';
import { MODES } from '../modes/manifest.js';
import { qrSvg } from './qr.js';

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

let backend = null;
let code = null;
let poller = null;
let stageSig = '';

function joinUrl() {
  const base = `${location.origin}${location.pathname.replace(/screen\.html$/, '')}`;
  return `${base}?join=${code}${isDemo() ? '&demo=1' : ''}`;
}

function mountCorner() {
  $('qrMount').innerHTML = qrSvg(joinUrl());
  $('cornerCode').textContent = code;
  show('joinCorner', true);
}

/* ----------------------------------------------------------- the stage */

function paint(html) {
  $('stageInner').innerHTML = html;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
));

function renderLobby(s) {
  const board = Object.values(MODES)
    .flatMap((m) => (m.lobbyBoard ? m.lobbyBoard(s.doneResults).slice(0, 3) : []));
  paint(`
    <div class="screen-kicker land">${esc(s.title || 'Btown Party')}</div>
    <div class="screen-title land">Scan in.<br>Say hi to somebody.</div>
    <div class="screen-sub land">First name only — takes half a minute.</div>
    <div class="screen-count land" id="screenCount">${s.playerCount} in the room</div>
    ${board.length ? `<div class="lobby-board land">reads the room best so far: ${
      board.map((b) => `<strong>${esc(b.name)}</strong> ${b.points}`).join(' · ')
    }</div>` : ''}
  `);
}

function renderCollecting(s) {
  const q = s.round.config?.question;
  paint(`
    <div class="screen-kicker land">Phones out — one quick question</div>
    <div class="screen-title land">${esc(q?.text ?? 'What did this room say?')}</div>
    <div class="screen-sub land">What did THIS room say? Lock in your read.</div>
    <div class="screen-count land" id="screenCount">${s.round.submissionCount} of ${s.playerCount} locked in</div>
  `);
}

function renderModerating() {
  paint(`
    <div class="screen-kicker land">Round closed</div>
    <div class="screen-title land">Eyes up front.</div>
    <div class="screen-sub land">The room is about to find out about itself.</div>
  `);
}

function renderReveal(s) {
  const mode = MODES[s.round.mode];
  if (!mode || !s.round.results) { renderModerating(); return; }
  const mount = $('stageInner');
  mount.innerHTML = '';
  mode.renderBeat(mount, s.round.revealStep, s.round.results, s.doneResults);
}

function renderClosed(s) {
  paint(`
    <div class="screen-kicker land">${esc(s.title || 'Btown Party')}</div>
    <div class="screen-title land">That's the night.</div>
    <div class="screen-sub land">Read the BTown Brief → btownbrief.com</div>
  `);
  show('joinCorner', false);
}

async function tick() {
  const s = await backend.rpc('party_screen_get', { p_code: code });
  show('stage', true);
  show('codePanel', false);
  const r = s.round;
  const sig = s.status !== 'open' ? 'closed'
    : !r ? `lobby:${s.playerCount}:${s.doneResults.length}`
    : `${r.status}:${r.revealStep}:${r.submissionCount}:${s.playerCount}`;
  if (sig === stageSig) return;
  stageSig = sig;
  if (s.status !== 'open') { renderClosed(s); poller.stop(); return; }
  if (!r) renderLobby(s);
  else if (r.status === 'collecting') renderCollecting(s);
  else if (r.status === 'moderating') renderModerating();
  else if (r.status === 'revealing') renderReveal(s);
  else renderLobby(s);
}

function start() {
  localStorage.setItem('btown-party-screen-code', code);
  mountCorner();
  poller?.stop();
  poller = startPolling(tick, {
    onError: (e) => {
      if (!(e instanceof PartyError)) return;
      if (e.code === 'not_ready') {
        poller.stop();
        show('stage', false);
        show('joinCorner', false);
        show('offlineScreen', true);
      } else if (e.code === 'not_found') {
        poller.stop();
        show('stage', false);
        show('joinCorner', false);
        show('codePanel', true);
        $('screenError').textContent = 'No event with that code right now.';
        localStorage.removeItem('btown-party-screen-code');
      }
    },
  });
}

/* ----------------------------------------------------------------- boot */

(async function boot() {
  backend = await getBackend();
  const params = new URLSearchParams(location.search);
  code = (backend.demo && backend.code)
    || params.get('code')?.toUpperCase()
    || localStorage.getItem('btown-party-screen-code');
  if (code) { start(); return; }

  show('codePanel', true);
  $('screenCodeInput').addEventListener('input', () => {
    const el = $('screenCodeInput');
    el.value = el.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  });
  $('screenGo').addEventListener('click', () => {
    const v = $('screenCodeInput').value.trim();
    if (v.length !== 4) { $('screenError').textContent = 'The code is 4 letters.'; return; }
    code = v;
    show('codePanel', false);
    start();
  });
})();

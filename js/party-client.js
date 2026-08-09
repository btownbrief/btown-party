// BTOWN PARTY — backend client for all three faces (phone, host, screen).
//
// Same Supabase project + anon key as the fleet's leaderboard and rooms
// layer; the party_* RPCs are brand-new (supabase/party-SETUP.sql). Until
// Stephen pastes that file, every call fails with code 'not_ready' and the
// UI says party mode isn't switched on yet.
//
// Two transports behind one function:
//   getBackend() → { rpc(fn, args) }   — network (default) or, with
//   ?demo=1 in the URL, the fully local fake event from js/demo.js.
// Tests point the network transport at scripts/party-shim.mjs with
// ?api=http://localhost:PORT (or globalThis.BTOWN_PARTY_URL).

const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';

export const POLL_MS = 2000;
export const POLL_HIDDEN_MS = 10000;

export class PartyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PartyError';
    this.code = code;
    this.detail = detail;
  }
}

const urlParams = () => new URLSearchParams(globalThis.location?.search ?? '');

export function isDemo() {
  return urlParams().get('demo') === '1';
}

function apiBase() {
  const override = urlParams().get('api') || globalThis.BTOWN_PARTY_URL;
  return String(override || SUPABASE_URL).replace(/\/+$/, '');
}

async function networkRpc(fn, args) {
  let res;
  try {
    res = await fetch(`${apiBase()}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new PartyError('offline');
  }
  if (res.status === 404) throw new PartyError('not_ready');
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    throw new PartyError((body && body.message) || `http_${res.status}`);
  }
  return body;
}

let backendPromise = null;

/** The one entry point. UI code never knows which transport it got. */
export function getBackend() {
  if (!backendPromise) {
    backendPromise = isDemo()
      ? import('./demo.js').then((demo) => demo.demoBackend())
      : Promise.resolve({ rpc: networkRpc, demo: false });
  }
  return backendPromise;
}

/* --------------------------------------------------- identity + sessions */
// Same per-origin identity spirit as the game fleet (js/rooms.js), with
// party-specific keys so nothing collides with the games.

export function attendeeToken() {
  let t = localStorage.getItem('btown-party-token');
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem('btown-party-token', t);
  }
  return t;
}

/** The host's secret. Lives only in this phone's localStorage; the backend
 *  stores a hash. Losing the phone mid-event means starting a new event —
 *  acceptable for a weekly mixer, and there is nothing to leak. */
export function hostKey() {
  let k = localStorage.getItem('btown-party-host-key');
  if (!k) {
    k = crypto.randomUUID();
    localStorage.setItem('btown-party-host-key', k);
  }
  return k;
}

export function getName() {
  return localStorage.getItem('btown-player-name') || '';
}
export function setName(name) {
  localStorage.setItem('btown-player-name', String(name).trim().slice(0, 24));
}

// ?demo=1 keeps its own session slots so a demo never hijacks a real event.
const sess = (key) => (isDemo() ? `${key}-demo` : key);

export function savedAttendeeSession() {
  try {
    const s = JSON.parse(localStorage.getItem(sess('btown-party-session')));
    return s && s.eventId && s.code ? s : null;
  } catch { return null; }
}
export function saveAttendeeSession(s) {
  localStorage.setItem(sess('btown-party-session'), JSON.stringify(s));
}
export function clearAttendeeSession() {
  localStorage.removeItem(sess('btown-party-session'));
}

export function savedHostEvent() {
  try {
    const s = JSON.parse(localStorage.getItem(sess('btown-party-host-event')));
    return s && s.eventId && s.code ? s : null;
  } catch { return null; }
}
export function saveHostEvent(s) {
  localStorage.setItem(sess('btown-party-host-event'), JSON.stringify(s));
}
export function clearHostEvent() {
  localStorage.removeItem(sess('btown-party-host-event'));
}

/* ------------------------------------------------------------ poll loop */

/**
 * The fleet's visibility-aware single-timer poll loop (same discipline as
 * rooms.js): exactly one pending timer, slower when the tab is hidden,
 * instant catch-up when it comes back. `tick` is an async function; its
 * rejections go to onError rather than killing the loop.
 */
export function startPolling(tick, { onError, ms = POLL_MS } = {}) {
  let stopped = false;
  let timer = 0;
  let inFlight = false;
  const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  const run = async () => {
    if (stopped) return;
    clearTimeout(timer);
    if (inFlight) { schedule(50); return; }
    inFlight = true;
    try {
      await tick();
    } catch (err) {
      if (!stopped && onError) onError(err);
    } finally {
      inFlight = false;
    }
    if (!stopped) schedule(document.hidden ? POLL_HIDDEN_MS : ms);
  };
  const onVis = () => { if (!document.hidden && !stopped) run(); };
  document.addEventListener('visibilitychange', onVis);
  run();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
    poke: run,
  };
}

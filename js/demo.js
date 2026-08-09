// BTOWN PARTY — ?demo=1: a fully local fake event, zero backend.
//
// The same pure state machine that mirrors the real backend (party-core.js)
// runs here against localStorage, pre-loaded with a dozen fake attendees
// who checked in with canned answers and who drift in submissions a few
// seconds after the host opens a round. All three faces work: open
// host.html?demo=1, screen.html?demo=1, and index.html?demo=1 in three
// tabs of one browser and run a whole night without Supabase.
//
// Honest limits: tabs share state through localStorage, so the demo is
// one-device only, and two simultaneous writes can race (last write wins).
// That's fine for a rehearsal; the real backend referees the real night.

import { createDb, checkinTally, OPS, PartyError } from './party-core.js';

const STORE_KEY = 'btown-party-demo-db-v1';
const DEMO_HOST_KEY = 'demo-host-key-0001';
export const DEMO_CODE = 'BTWN';

const CROWD = [
  'Mara', 'Theo', 'Junie', 'Cal', 'Priya', 'Walt',
  'Dot', 'Reg', 'Sana', 'Bix', 'Ellie', 'Gus',
];
const crowdToken = (i) => `demo-crowd-token-${String(i).padStart(2, '0')}`;

const FALLBACK_QUESTIONS = [
  { id: 'rk-001', text: 'Your creemee order:', options: ['Maple', 'Chocolate-vanilla twist', 'Black raspberry'] },
  { id: 'rk-002', text: 'Which one is worse?', options: ['Mud season', 'Stick season'] },
  { id: 'rk-005', text: 'First real snowfall of the year:', options: ['Out in it by nine', 'Watching it from the window with something warm'] },
];

const nowS = () => Math.floor(Date.now() / 1000);

// Small deterministic hash → the fake crowd behaves the same every run.
function det(str, mod) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  return Math.abs(h) % mod;
}

async function tonightsQuestions() {
  try {
    const res = await fetch(new URL('../content/roomknows-questions.json', import.meta.url));
    const deck = await res.json();
    return deck.questions.slice(0, 3).map((q) => ({ id: q.id, text: q.text, options: q.options }));
  } catch {
    return FALLBACK_QUESTIONS;
  }
}

function buildStore(questions) {
  let db = createDb(nowS() % 100000);
  const t = nowS();
  let r = OPS.party_create_event(db, {
    p_host_key: DEMO_HOST_KEY, p_questions: questions, p_title: 'Demo Mixer',
  }, t);
  db = r.db;
  const eventId = r.result.eventId;
  // A memorable fixed code so every face and every doc can say "BTWN".
  db.events[eventId].code = DEMO_CODE;
  CROWD.forEach((name, i) => {
    r = OPS.party_join(db, { p_code: DEMO_CODE, p_name: name, p_token: crowdToken(i) }, t + i);
    db = r.db;
    // Canned check-ins with real spread: each question gets a leader,
    // a runner-up, and a straggler or two.
    const answers = {};
    questions.forEach((q, qi) => {
      answers[q.id] = det(`${name}:${q.id}`, 10) < 6 - qi
        ? det(`lead:${q.id}`, q.options.length)
        : det(`${name}:${q.id}:alt`, q.options.length);
    });
    r = OPS.party_checkin(db, { p_event: eventId, p_token: crowdToken(i), p_answers: answers }, t + i);
    db = r.db;
  });
  return { db, eventId };
}

/** Fake attendees submit a few seconds after a round opens — so the host
 *  console fills up in front of Stephen the way a real room would. */
function advanceCrowd(store) {
  const e = store.db.events[store.eventId];
  if (!e || e.status !== 'open') return;
  const round = e.rounds[e.rounds.length - 1];
  if (!round || round.status !== 'collecting') return;
  const t = nowS();
  const question = round.config?.question;
  CROWD.forEach((name, i) => {
    if (t < round.openedAt + 2 + i * 0.8) return;
    const player = Object.values(e.players).find((p) => p.name === name);
    if (!player || round.submissions[player.id]) return;
    let payload;
    if (question) {
      // Guess near the truth, with personality: most back the leader,
      // a few contrarians pick elsewhere, percents wobble ±18.
      const tally = checkinTally(e, question.id);
      const winner = tally.counts.indexOf(Math.max(...tally.counts));
      const contrarian = det(`${name}:${round.id}:c`, 10) < 3;
      const pick = contrarian
        ? det(`${name}:${round.id}:p`, question.options.length)
        : winner;
      const actual = tally.total ? Math.round((tally.counts[pick] / tally.total) * 100) : 50;
      const wobble = det(`${name}:${round.id}:w`, 37) - 18;
      payload = { pick, pct: Math.max(0, Math.min(100, actual + wobble)) };
    } else {
      payload = { note: 'demo' };
    }
    try {
      const r = OPS.party_submit(store.db, {
        p_event: store.eventId, p_token: crowdToken(i),
        p_round: round.id, p_payload: payload,
      }, t);
      store.db = r.db;
    } catch { /* round may have just closed — a real crowd misses too */ }
  });
}

export async function demoBackend() {
  const load = () => {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.db && s.eventId && s.db.events[s.eventId]) return s;
    } catch { /* corrupted store rebuilds below */ }
    return null;
  };

  if (new URLSearchParams(location.search).get('reset') === '1' || !load()) {
    localStorage.setItem(STORE_KEY, JSON.stringify(buildStore(await tonightsQuestions())));
  }

  return {
    demo: true,
    code: DEMO_CODE,
    /** The demo event's ids — the host console resumes this instead of
     *  creating a fresh event (which would orphan the fake crowd). */
    session: () => ({ eventId: load()?.eventId, code: DEMO_CODE }),
    async rpc(fn, args) {
      if (!OPS[fn]) throw new PartyError('not_ready');
      const store = load();
      if (!store) throw new PartyError('not_found');
      advanceCrowd(store);
      // In the demo, any phone may drive the host console.
      const a = 'p_host_key' in (args ?? {}) ? { ...args, p_host_key: DEMO_HOST_KEY } : args;
      const { db, result } = OPS[fn](store.db, a ?? {}, nowS());
      store.db = db;
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      return result;
    },
  };
}

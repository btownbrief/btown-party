# Plugging a game mode into Btown Party

This file is the CONTRACT. Sibling agents build modes in parallel against
it without talking to each other — follow it to the letter, and read
`modes/room-knows/` first: it is the reference implementation of every
line below.

## Where a mode lives

Everything in `modes/<slug>/` (slug: lowercase letters, digits, hyphens,
max 40 chars). Two files minimum:

- `modes/<slug>/logic.js` — ALL math and round rules. Pure: no DOM, no
  network, no clock, no randomness; JSON-serializable values in and out.
  Plain Node must be able to test it (`scripts/test-<slug>.mjs`, in the
  style of `scripts/test-room-knows.mjs`).
- `modes/<slug>/mode.js` — rendering + wiring only. If a number matters,
  it is computed in logic.js and nowhere else.

Content files (question decks etc.) go in `content/` as JSON.

## Registering

ONE import line + ONE entry line in `modes/manifest.js`:

```js
import * as myMode from './my-mode/mode.js';
export const MODES = {
  [roomKnows.slug]: roomKnows,
  [myMode.slug]: myMode,        // ← yours
};
```

Nothing else in the shell changes. Do not touch the shell files
(js/attendee.js, js/host.js, js/screen.js, js/party-core.js,
js/party-client.js), the SQL, or another mode's directory.

## What a mode module must export

```js
export const slug = 'my-mode';       // matches the directory name
export const title = 'My Mode';      // shown on the host console
export const tagline = 'One line.';  // shown on the host console

// HOST: round setup UI. Render into `mount`. When the host has chosen,
// call ctx.openRound(config) — config is your round's JSON (≤ 8 KB), and
// it is HOST-AUTHORED content, the only thing the screen may show before
// a reveal. ctx.event is the party_host_get snapshot (questions, players,
// checkinTallies, doneResults); ctx.playedQuestionIds helps avoid repeats.
export function hostSetup(ctx, mount) {}

// HOST: one short human line per submission for the shell's moderation
// list — the host reads this to approve/reject. Never return raw JSON.
export function describeSubmission(payload, config) {}

// PHONE: the collect-phase input. TEN SECONDS OR LESS of interaction,
// then the phone is done (the shell shows "eyes up" after ctx.submit
// resolves). ctx = { round: {id, mode, config}, event: {questions},
// submit(payload) } — payload is your JSON, ≤ 2 KB.
export function phoneCollect(ctx, mount) {}

// PURE (thin wrapper over logic.js): approved inputs → the results object
// that gets stored on the round and rendered by every reveal surface.
// Receives ONLY host-approved submissions [{name, payload}] — the shell
// and the backend both enforce that; never reach around them.
export function computeResults({ config, approved, checkinTallies }) {}

// The staged reveal is N beats; the host taps through them one by one.
export function beatCount(results) {}

// SCREEN: render beat `step` into `mount` (cleared for you), big enough
// to read across a café. CSS class `land` gets the house entrance
// animation; stagger with animation-delay.
export function renderBeat(mount, step, results, doneResults) {}

// NARRATED (no-TV venues — this surface EQUALS the screen in polish):
// what the host reads aloud at beat `step`.
// Return { title: string, lines: string[] } — short, speakable lines.
export function narrated(step, results, doneResults) {}

// OPTIONAL — rows for the between-rounds lobby scoreboard:
// return [{ name, points }] from your mode's doneResults only.
export function lobbyBoard(doneResults) {}
```

`doneResults` is `[{ mode, results }]` for every finished-and-revealed
round tonight (all modes — filter by yours).

## Element ids (the smoke test drives these)

- Your root element in every render: `data-mode="<slug>"`.
- Every interactive element: `id="mode-<slug>-<name>"` — stable, kebab-case.
- The shell's own ids (joinName, joinCode, joinGo, hostCreate, modQueue,
  approveAllBtn, closeRoundBtn, revealBtn, narratedNext, stageInner …)
  are load-bearing for `scripts/smoke-party.mjs`; never reuse or shadow
  them.

## Votes (if your mode needs a second phase)

`party_vote` exists as a generic per-round upsert:
`{ p_event, p_token, p_round, p_target (string ≤ 64), p_value (int,
|v| ≤ 10) }`, readable by the host in `round.votes`. Call it from
phoneCollect via a second backend call if your mode votes on revealed,
already-approved content. There is no shell UI for votes — your mode
renders its own inside its collect surface.

## The doctrine (violating it is a bug, not a style choice)

1. Phone interactions are ≤ 10 seconds, then pocketed.
2. The app governs the GAME, never the RELATIONSHIP: no pairing people,
   no "go talk to X", no tracking who met whom, no auditing sociability.
3. Reveals are staged and host-paced. You define beats; Stephen lands them.
4. Porous participation: late joiners, skippers, and pure spectators must
   never break a round or get called out for absence. computeResults must
   handle zero approved submissions and an empty tally gracefully (see
   room-knows' emptyRoom).
5. NOTHING an attendee typed or drew reaches renderBeat, narrated, or
   lobbyBoard except through host-approved submissions. The backend
   enforces this; your mode must not try to be cleverer than it.

## Before you finish

- `node scripts/test-<slug>.mjs` passes (aggregation, scoring incl. ties,
  empty-room, zero-submission, malformed-payload cases).
- `node scripts/test-party.mjs` and `node scripts/test-room-knows.mjs`
  still pass untouched.
- `node --check` every file you added.
- Walk your mode at a phone viewport (collect) and a laptop viewport
  (screen beats + narrated view), or say plainly that you could not and
  what you inspected instead.

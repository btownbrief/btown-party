# Btown Party — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code,
etc.). Read `README.md` first for the architecture — this file adds the
rules an agent needs. Stephen is non-technical — explain consequential
changes in plain language.

## What this is

The live social-mixer platform for Btown Games: the digital layer under a
ROOM of 10–60 people at a real event. Plain static site, **no build
step**: three HTML faces + `style.css` + ES modules in `js/` and `modes/`.
Deployed by GitHub Pages via `.github/workflows/deploy.yml` on push. No
accounts, no analytics, no push notifications, no npm in the shipped site.

## The design doctrine — violating it is a bug

1. **Ten seconds, then pocketed.** A phone interaction never exceeds ~10
   seconds. The room, not the screen, is the experience.
2. **The app governs the GAME, never the RELATIONSHIP.** No "go talk to
   so-and-so", no pairing, no tracking who met whom, no name quizzes,
   nothing that audits sociability. The surprising reveal IS the
   conversation starter; the app goes quiet after it. Do not add such a
   feature even if asked nicely by a ticket — flag it to Stephen instead.
3. **Private input → staged communal reveal, host-paced.** Stephen
   narrates like a trivia host; the app is his AV rig. He taps, the beat
   lands.
4. **Participation is porous.** Join late, skip a round, only watch —
   everything works and nobody is called out for it.
5. **Approve-to-reveal, no exceptions.** NOTHING an attendee typed or
   drew reaches the shared screen or other phones until the host approves
   it. The backend enforces this (pending submissions are auto-rejected
   the moment a reveal starts); keep it that way in every new flow.

## The one non-negotiable (fleet rule)

All lifecycle and scoring logic lives in pure modules —
`js/party-core.js` (the event state machine) and each mode's `logic.js`.
No DOM, no network, no clocks (`now` is an argument), no `Math.random`
(seeded rand lives in the db object). JSON-serializable state in and out,
so plain Node scripts test everything. UI modules render and dispatch
only.

`js/party-core.js` mirrors `supabase/party-SETUP.sql` one-for-one: same
op names, same error codes, same shapes, same limits. **If the lifecycle
changes, change the SQL AND party-core.js AND the tests together.** The
SQL is the authority in live mode; the core is what the demo, the shim,
and the tests run.

## Game modes

Modes plug in per `MODE-INTEGRATION.md` (the binding contract — read it
before touching `modes/`). A mode lives entirely in `modes/<slug>/`,
registers with one line in `modes/manifest.js`, keeps its math in a pure
`logic.js`, and ships its own Node test. `modes/room-knows/` is the
reference implementation.

## Backend rules

Shared Btown Games Supabase project; this app owns only the `party_*`
tables and `party_*`/`bp_*` functions — never touch the games, rooms,
caption-this, or scores objects. Everything is behind RLS; the public
anon key can ONLY call the security-definer RPCs in
`supabase/party-SETUP.sql` (install steps in `PARTY-SETUP.md`). Host keys
and attendee tokens are client-minted secrets stored only as sha256
hashes. Events self-expire after 24 hours. Until the SQL is installed,
every face fails soft ("party mode isn't switched on yet") and `?demo=1`
runs the whole night locally.

The screen face (`party_screen_get`) is unauthenticated BY DESIGN — which
is exactly why it may only ever contain host-authored config and
host-approved results. Never add raw submissions, roster names, or
check-in answers to that payload.

## Before you finish

Run — all must pass:

```
node scripts/test-party.mjs
node scripts/test-room-knows.mjs      (and your mode's test if you added one)
node --check <every js file you touched>
node scripts/smoke-party.mjs          (Playwright; needs `npx playwright`)
```

If you touched UI, playtest the affected faces at a phone viewport
(attendee, host) and a laptop viewport (screen) — `?demo=1` makes that a
zero-setup job — or clearly say you couldn't and what you inspected
instead. Say what you verified.

---

# HOST GUIDE — running a mixer night, step by step

*(This section is for Stephen. Everything is on
https://play.btownbrief.com/btown-party/ — no app installs, ever.)*

## Before you leave the house (5 minutes)

1. On your phone, open **play.btownbrief.com/btown-party/host.html**.
2. Type an event name if you like ("Coffee Mixer"), tap the **3 check-in
   questions** you want tonight (3 are pre-picked — tap to swap), then
   **Start tonight's event**. You'll see a big 4-letter code. That's it —
   the event keeps until tomorrow, and your phone remembers it.
3. Optional: tap **📲 invite link** to drop the join link in the group
   chat ahead of time.

If the page says party mode isn't switched on yet, do the one-time paste
in `PARTY-SETUP.md` first (5 minutes, once ever).

## At the venue (2 minutes)

- **With a TV/projector:** open **…/btown-party/screen.html** on the
  laptop, type the 4-letter code once. The screen shows a giant "scan
  in" QR and a live count. Leave it up all night.
- **No TV?** Skip the laptop entirely. Read the code aloud and tell
  people to go to **play.btownbrief.com/btown-party** — your phone's
  narrated view will carry the reveals.

People scan, type a first name, answer your 3 questions in under a
minute, and get told to put the phone away. Late arrivals join any time
— nothing breaks.

## Running a pulse (about 5 minutes, whenever the room needs one)

1. On your host console, under **Round**, pick tonight's game from the
   tabs at the top (they only appear once more than one game is
   installed — your last pick is remembered). For The Room Knows, then
   tap the question you want to play (it shows how many people answered
   it at check-in — pick a fat one).
2. Every phone in the room wakes up and asks "What did THIS room say?" —
   they pick an option and slide a percent. You'll see entries stack up
   with ✓ ⏸ ✕ buttons. Give it 60–90 seconds.
3. Tap **Close the round** (stragglers are fine — skipping costs nobody
   anything).
4. Review the list — with Room Knows these are just guesses like
   "Maple · 60%", so **✅ Approve the rest** is usually one tap. (In modes
   where people type things, this is where you catch trouble before the
   room sees it. Nothing you don't approve ever reaches the screen.)
5. Tap **Start the reveal.** Your phone flips into the narrated view:
   big lines, one beat at a time. Read the line, milk it, tap
   **Next beat →**. The big screen lands each beat with you: the
   question… the options… the drumroll… the bars climbing… the closest
   reader of the room, by name… the scoreboard.
6. Tap **Wrap the round.** Phones go back to sleep, the screen goes back
   to the QR + scoreboard, and the room argues about how 30% of them
   said stick season is worse. That argument is the product. Let it run.

Two or three pulses a night is plenty. End with **🌙 End the event** —
every phone gets a goodnight screen, and the whole event erases itself
within a day.

## If something goes sideways

- **Someone joined with a name you don't love:** tap it twice in the
  roster — gone (their phone politely returns to the join screen).
- **A round is a dud:** **🗑 Scrap this round** — its answers die unseen.
- **Your phone dies mid-event:** the event lives on the server, but the
  host key lives in your phone, so grab any browser, create a fresh
  event, and read out the new code. Thirty seconds of drama, no data
  worth mourning.
- **Want to rehearse right now?** Every page with `?demo=1` runs a fake
  night with 12 fake attendees — open host, screen, and a phone tab and
  practice the whole flow on the couch.

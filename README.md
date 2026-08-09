# BTOWN PARTY

The digital layer under a live Btown mixer. Not a phone game: a ROOM of
10–60 people at a real event scans a QR, joins with a first name, answers
a few tiny private questions — and the payoff lands on a shared screen (or
in the host's voice) as a staged communal reveal. The phone goes back in
the pocket; the room does the rest.

**Live at:** https://play.btownbrief.com/btown-party/

## The three faces

| Page | Who | What |
|---|---|---|
| `index.html` | attendees' phones | join via QR / 4-letter code, 3-question check-in, then an idle screen that wakes when the host opens a round |
| `host.html` | Stephen's phone | create tonight's event, watch the roster, open/close rounds, approve every submission, pace the reveal beat by beat — including a full-screen NARRATED view for venues with no TV |
| `screen.html` | a laptop into a TV/projector | read-only, café-sized type, join QR always in the corner, animated staged reveals |

Try the whole thing with zero backend: open all three pages with `?demo=1`
in one browser — a fake crowd of 12 is already checked in.

## First game mode: THE ROOM KNOWS

At check-in the room privately answers tonight's questions ("Your creemee
order:"). A round points back at one of them: every phone guesses which
option won AND what percent of the room picked it. Then the host fires the
reveal — options, drumroll, the real bars climbing, and the closest reader
of the room called out by first name. Five minutes, then the app goes
quiet and the "there's no way 30% of you said that" conversations start
themselves.

## Architecture (fleet rules apply)

Plain static site, **no build step**, no frameworks, no npm in the shipped
site. ES modules in `js/` and `modes/`.

- `js/party-core.js` — the PURE event state machine (events, check-in,
  rounds, moderation, reveal pacing). No DOM/network/clock; mirrors the
  SQL backend one-for-one. Tests: `scripts/test-party.mjs`.
- `modes/room-knows/logic.js` — PURE round math (tally, scoring, beats).
  Tests: `scripts/test-room-knows.mjs`.
- `js/party-client.js` — backend client + poll loop (Supabase RPCs, ~2s,
  free-tier friendly). Fails soft with "party mode isn't switched on yet"
  until the SQL is installed.
- `js/demo.js` — `?demo=1`, the fake event in localStorage.
- `js/qr.js` — dependency-free QR encoder for the join link.
- `js/attendee.js` / `js/host.js` / `js/screen.js` — UI only.
- `modes/` — game modes plug in per `MODE-INTEGRATION.md`;
  `modes/manifest.js` is the registry.
- `supabase/party-SETUP.sql` — the real backend: security-definer RPCs,
  RLS locked down, hashed keys, size caps, 24-hour self-expiry. One-time
  install: `PARTY-SETUP.md`.

The design doctrine (10-second interactions, approve-to-reveal
moderation, the app never governs the relationship) lives in `AGENTS.md`
— read it before changing anything.

## Tests

```
node scripts/test-party.mjs        # state machine
node scripts/test-room-knows.mjs   # mode math
node scripts/smoke-party.mjs       # Playwright: host + 3 phones + screen
```

The smoke drives a real multi-context browser night against
`scripts/party-shim.mjs` (a local HTTP stand-in that serves the same pure
core the SQL mirrors). Playwright is dev-only; the shipped site has no
dependencies.

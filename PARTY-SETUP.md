# Switching on Btown Party (one paste, one time)

Btown Party runs mixers on phones: attendees scan a QR, join with a first
name, and send tiny private answers; you approve everything from your phone
and fire the big reveal. All of that needs one backend — the SQL file in
`supabase/party-SETUP.sql`.

Until you run that file, the site still works: every page just says party
mode isn't switched on yet, and `?demo=1` (a fake event with fake
attendees) works with no backend at all.

## What to do

1. Open the Supabase dashboard → the **btown-games** project (the same one
   the leaderboard and the game rooms use).
2. Left sidebar → **SQL Editor** → **New query**.
3. Paste the whole contents of `supabase/party-SETUP.sql` and click
   **Run**.
4. That's it. Open `host.html`, create tonight's event, and the QR code on
   the screen view is live.

Safe to re-run any time; running it twice changes nothing.

## What it creates, in plain language

- Five new `party_*` tables (events, players, rounds, submissions, votes).
  Nothing touches the games, the leaderboard, or the rooms layer.
- An event is a 4-letter code. Your phone keeps a secret host key (made
  the first time you open the host console); the database stores only a
  fingerprint of it, so nobody who peeks at the data can run your event.
- Attendees' phones keep a similar secret so a page refresh never loses
  their seat.
- The functions the pages call are the ONLY doors in: Row Level Security
  keeps the public key out of the tables themselves, same as every other
  Btown game backend.
- **The house rule is enforced by the database**: anything an attendee
  typed sits in a review queue until you approve it. The big screen's
  feed physically contains only what you approved — and if a reveal
  starts while something is still unreviewed, the database rejects that
  entry rather than show it.
- Events clean themselves up after 24 hours, players and all. No cron,
  no maintenance, and the free tier never fills up.

## Honest limits (fine for a room of friends)

- Phones poll every couple of seconds rather than using push — that's
  why the whole thing fits in the free tier. A reveal lands on the big
  screen within a beat or two of your tap, which is exactly the pace you
  narrate at anyway.
- One live event per host phone: creating tonight's event automatically
  closes last week's.
- Someone determined could join with a fake name from home if they have
  the code. They'd still never reach the screen without your approval —
  and you can remove anyone from the roster with a tap.

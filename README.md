# SquabbleUP — live multiplayer snake drafts with scoring

## Deploy (Render + Neon)
1. Push folder to GitHub, create a Render Web Service from the repo.
2. Env vars:
   - DATABASE_URL  = Neon connection string (tables auto-create)
   - SCORING_DAYS  = 7      (scoring window after a draft finishes)
   - SCORE_POLL_MIN = 5     (how often live stats refresh)
3. Deploy. Done.

## Scoring (fairness by design)
- One shared data source: ESPN box scores, polled server-side every SCORE_POLL_MIN.
- Fixed public rules per sport (see scoring.js RULES): half-PPR football, standard
  fantasy NBA/NHL/MLB, golf placement points at tournament completion, tennis 10/match win.
- Scores are stored per player per day (player_scores table); a draft's total is the sum
  of its players' points between draft completion and scoring window end. Everyone in a
  draft reads identical numbers — no client-side math.
- Day-one task: ESPN's box score format is unofficial. After deploying, run one live
  slate and check the logs — the parsers are label-driven and defensive, but verify a
  few player lines against ESPN.com before money is ever on the line.

## Tabs
Lobby (create/join/invites/pass&play) · Drafts (in progress) · Live (scoring window)
· Results (final + close-to-archive) · Profile (avatar, friend code, crew)

## Pass & play
Local one-phone drafts (no account needed for friends, bots optional). Stored on-device;
no live scoring (no server record).

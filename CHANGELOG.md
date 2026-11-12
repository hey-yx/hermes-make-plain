# Changelog

## 0.3.3 (2026-11-11)

- The rewrite re-lays-out the draft as a request: one goal sentence, then one numbered requirement per line; mixed topics become separate items instead of staying one rambling paragraph.
- Filler removal stays: opening interjections and 就是/然后/反正-style noise are dropped, and every fact, decision and constraint is kept in its original order.

## 0.3.1 (2026-11-07)

- The rewrite no longer explains or interprets the draft: wording cleanup only, with questions, guesses and hedges kept as written.

## 0.3.0 (2026-11-06)

- The rewrite now optimizes for readability only: the prompt is stripped down to meaning-preserving rules, so the output no longer forces a goal line and per-item list.
- Tooltip copy follows: the button offers a clearer rewrite, not an AI-ready request.

## 0.2.0 (2026-11-06)

- Renamed to hermes-make-plain; display name Hermes MakePlain.
- Rewrite target is AI-readable: one goal line, then one request per line.
- The button shows a working spinner and rejects an empty box before any work starts.
- A draft edited while the rewrite is in flight is never overwritten.
- Output cap raised to 8192 tokens.

## 0.1.0 (2026-11-06)

- First version: one-button composer rewrite on the composer actions slot.

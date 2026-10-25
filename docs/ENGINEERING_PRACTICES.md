# Engineering practices: proposals for discussion

Proposed for the next team meeting, not agreed. Most of what keeps ContentCollab running is already in [PRACTICES.md](PRACTICES.md). These are additions, each tied to the existing IDs it builds on. Whatever the team agrees moves into PRACTICES.md.

1. **Small commits every week, from everyone.** A few small commits a week rather than one large push before a deadline. The history then shows how the system was built (PRC-2), and a deployment problem such as a broken manifest or a failing probe shows up in the week it is introduced, not at the 15 November checkpoint.

2. **Core first, extensions after.** Get the demo path (sign in, upload, share, comment) working on the cluster before starting real-time, backups or notifications. The extensions stay planned in [PLAN.md](PLAN.md) but are not built in parallel with the core (DES-3).

3. **One JSON contract, checked on both sides.** Every request, response and Socket.IO event in `docs/API.md` gets a Zod schema in one shared module used by `api`, `web` and `worker`. The API validates input with it and the frontend gets the same TypeScript types, so a field renamed on one side fails typecheck on the other (API-3, API-10).

4. **Logic in plain functions, routes kept thin.** Role checks, share-link expiry and version numbering live in functions that take values and return values, with no Express or database inside. Their unit tests then run offline, need no server and give the same result every time (DES-4, TST-1).

5. **Structured logs from the first commit.** One logger module shared by `api` and `worker`. Each request gets an ID that is carried into the Socket.IO events and BullMQ jobs it triggers, so one upload can be followed from the browser to the thumbnail (OBS-1).

6. **Edge cases tested on purpose.** Route tests cover the bad cases as well as the happy path: missing or malformed fields, an empty file, an expired share link, Postgres or Redis not answering, a worker job that fails halfway (TST-2, API-9).

7. **Decisions written down the day they are made, with the reason.** A new D-number in [ARCHITECTURE.md](ARCHITECTURE.md) or a line in that day's meeting notes, so the proposal and the final report quote the reason instead of reconstructing it (DES-1).

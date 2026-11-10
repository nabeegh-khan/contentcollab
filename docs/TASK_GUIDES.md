# Task guides

Step-by-step starts for the open issues, written 8 November 2026. Each guide names the branch, the files, the order of work and the tests that close the issue. The contract is `docs/API.md`; when a guide and the contract disagree, the contract wins and the guide gets fixed. Questions go on the issue, not in chat, so the answer stays with the work.

The 14 November checkpoint needs these open as pull requests by Wednesday 11 November (three-day review): #37 schema (merged by Monday 9 November), #39 auth, #40 documents and versions, #41 shares, #42 comments, #47 web skeleton, #48 sign-in and document list, #49 document view.

Every API guide uses what is already in `api/`: TypeScript, Express 5, ES modules, the shared `pg` pool in `api/src/lib/db.ts`, and Jest with Supertest (`npm test` in `api/`; `api/src/routes/health.test.ts` is the pattern to copy). Every route mounts under `/api/v1` in `api/src/server.ts`, before the 404 handler.

## Shared pieces (first PR to merge after #37 wins; others rebase on it)

These are used by every API slice. Whoever reaches them first builds them in their own PR; the others import them.

- `api/src/lib/validate.ts`: `validate(schema)` middleware with zod (`npm install zod`). On failure it answers `400 { error, code: "VALIDATION", details: [{ field, message }] }`. Use `.strict()` on object schemas so unknown fields are rejected.
- `api/src/lib/httpError.ts`: `class HttpError extends Error { status; code }`. Handlers throw it; `api/src/middleware/errorHandler.ts` turns it into the error shape in `docs/API.md` and turns anything else into `500 INTERNAL`.
- `api/src/middleware/requireAuth.ts` (built in #39): reads `Authorization: Bearer <token>`, verifies it with `JWT_SECRET`, sets `req.user = { id, email, displayName }`, else `401 UNAUTHORIZED`.
- `api/src/middleware/requireRole.ts` (built in #39): `requireRole("commenter")` loads the caller's share row for `req.params.documentId`; no row is `404 NOT_FOUND`, a lower role is `403 FORBIDDEN`. Rank: owner 4, editor 3, commenter 2, viewer 1. Sets `req.share`.
- `api/src/lib/realtime.ts` (built in #45, stubbed earlier): `emitToVersion(versionId, event, payload)`. Until #45 merges, the stub does nothing, so #42 can call it today.

## #37 Schema and first migration (Eyrika, Jyotiraditya), merged by Monday 9 November

Yes to the plan in the 7 November comment: node-pg-migrate, then one migration with the checklist.

1. `cd api`, `npm install node-pg-migrate`. Add `"migrate": "node-pg-migrate -m migrations"` to `package.json` scripts; it reads `DATABASE_URL`, so add `DATABASE_URL=postgres://<user>:<password>@localhost:5432/<db>` to your `.env` (and to `.env.example` with placeholders).
2. `npx node-pg-migrate create init -m migrations` and write the tables from the issue checklist in that one file: `users`, `documents`, `versions`, `shares`, `comments`, `tags`, `document_tags`, with the foreign keys, unique constraints and indexes the checklist names. `up` and `down` both.
3. `docker compose up db -d`, `npm run migrate up`, then `npm run migrate down` and `up` again: both directions must run clean.
4. Commit as `feat(db): schema and first migration (#37)`, push, open the pull request, request review from Nabeegh.

## #39 Auth: register, login, me, role middleware (Eyrika)

1. Branch `feature/39-auth` from `main` after #37 merges (start the code now on top of the #37 branch if it has not).
2. `npm install bcrypt jsonwebtoken zod` and `npm install -D @types/bcrypt @types/jsonwebtoken`. `JWT_SECRET` is already in the app Secret keys (#53); add it to your local `.env`.
3. `api/src/routes/auth.ts`: `POST /register` (zod: email, password min 8, displayName; bcrypt cost 12; `201 User` without the hash; unique-violation `23505` becomes `409 CONFLICT`), `POST /login` (`200 { token, user }`, token `expiresIn: "24h"`; wrong email or password is the same `401`), `GET /me` behind `requireAuth`.
4. The two middlewares from "Shared pieces", plus `validate.ts` and `httpError.ts` if nobody has merged them yet.
5. Mount: `app.use("/api/v1/auth", authRoutes)` in `server.ts`.
6. Tests in `api/src/routes/auth.test.ts`: register 201, duplicate 409, short password 400 with `details`, login 200 and 401, `me` 200 with a token and 401 without. `api/src/middleware/requireRole.test.ts`: no share 404, viewer on an owner route 403, owner 200.
7. Commit `feat(api): auth routes and role middleware (#39)`, open the pull request.

## #40 Documents and versions (Eyrika: routes and rows; Jyotiraditya: storage module)

Split so both can start today:

Jyotiraditya, `api/src/lib/storage.ts`:
1. `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage`. Spaces is S3-compatible: client with `endpoint: process.env.SPACES_ENDPOINT`, `region: process.env.SPACES_REGION`, keys `SPACES_KEY` and `SPACES_SECRET`, bucket `SPACES_BUCKET` (names as in #53).
2. Export `putStream(key, stream, contentType)` (an `Upload` from lib-storage, so the file is never held whole in memory), `getStream(key)`, `copy(fromKey, toKey)`, `remove(key)`.
3. Unit test with the client mocked (`jest.unstable_mockModule`), no network in CI.

Eyrika, `api/src/routes/documents.ts` and `versions.ts`:
1. `npm install busboy` (`-D @types/busboy`). Parse the multipart body as a stream with `limits: { fileSize: 50 * 1024 * 1024 }`; over the limit is `413 TOO_LARGE`; a type outside the list in `docs/API.md` is `400`.
2. Hash with `crypto.createHash("sha256")` while piping into `storage.putStream`. Object key `documents/<documentId>/<versionId>`.
3. After the object is stored, one transaction: insert the version row, set `documents.current_version_id`, and for a new document insert the owner share row. Same checksum on the same document is `409 CONFLICT` (delete the just-stored object).
4. List and read routes behind `requireAuth` and `requireRole("viewer")`; upload a version and revert behind `requireRole("editor")`; delete behind `requireRole("owner")`.
5. Download: `res.setHeader("Content-Disposition", 'attachment; filename="<filename>"')` and pipe `storage.getStream`.
6. Revert: `storage.copy` the old object to a new key, new version row; `409` if it is already current.
7. Tests with `storage` mocked: upload 201, too large 413, wrong type 400, duplicate 409, viewer upload 403, download headers, revert 201 and 409.

## #41 Shares by user and by link (Eyrika)

1. Branch `feature/41-shares` after #39 (it needs `requireRole`).
2. `api/src/routes/shares.ts` mounted at `/api/v1/documents/:documentId/shares` (use `Router({ mergeParams: true })`), every route behind `requireAuth` and `requireRole("owner")`.
3. `POST`: `{ email, role }` looks the user up (`404` if none, `409` if a share exists) or `{ link: true, role, expiresAt? }` creates `link_token = crypto.randomBytes(32).toString("base64url")`. Owner role cannot be granted through a share.
4. `PATCH` and `DELETE` per the table; the owner's own row cannot be deleted.
5. `GET /api/v1/links/:linkToken`: valid and `expires_at` null or in the future is `200 { document, version }`, anything else `404`.
6. Tests: share by email 201, unknown email 404, duplicate 409, non-owner 403, expired link 404, valid link 200.

## #42 Comments: threads, anchors, mentions (Jyotiraditya)

1. Branch `feature/42-comments` after #39.
2. `api/src/routes/comments.ts`: list behind `requireRole("viewer")` (oldest first, `?resolved=`), create behind `requireRole("commenter")`, edit and delete for the author or the owner (`403` otherwise).
3. zod: `body` 1 to 5000 characters, `anchor` `{ page: int >= 1, x, y }` with x and y between 0 and 1, `parentId` must be a comment on the same version (`400` otherwise).
4. Mentions: `/@([\w.-]+)/g` on the body, matched against `display_name` of users with a share on this document; unknown names are plain text.
5. After the insert commits, call `emitToVersion(versionId, "comment:created", comment)` (and `comment:updated`, `comment:deleted`, `mention`); the stub in `lib/realtime.ts` is fine until #45.
6. Tests: create 201, viewer create 403, bad anchor 400, reply to a comment on another version 400, edit by someone else 403, mention resolved only for a shared user.

## #45 Socket.IO server with the Redis adapter (Jyotiraditya)

1. Branch `feature/45-socketio`. `npm install socket.io @socket.io/redis-adapter` in `api/`.
2. In `server.ts`, create the HTTP server explicitly (`http.createServer(app)`), attach `new Server(server, { path: "/socket.io", transports: ["websocket"] })`, and use the adapter with two Redis clients (`pubClient` from `lib/redis.ts` and `pubClient.duplicate()`).
3. `io.use`: verify `socket.handshake.auth.token` with `JWT_SECRET`, reject otherwise.
4. `join { versionId }`: look up the version's document and the caller's share; acknowledge `{ ok: true }` and `socket.join("version:" + versionId)`, or `{ ok: false, code: "NOT_FOUND" }`.
5. Replace the stub in `lib/realtime.ts` with `io.to("version:" + id).emit(event, payload)`.
6. Test with `socket.io-client` against a server on an ephemeral port: bad token rejected, join without a share refused, an emitted `comment:created` reaches a joined client.

## #10 API contract review (Milton)

1. Read `docs/API.md` top to bottom against `docs/ARCHITECTURE.md` D2 to D5 and D10.
2. Settle the three open points at the end of the file. The drafts are reasonable defaults: tags replace, `resolved` on any comment, cursor as base64 of `createdAt,id`.
3. One pull request that edits only `docs/API.md`: remove the "Open points" section, write the three decisions into the matching tables, and change "First draft" to "Reviewed by Milton, <date>".
4. Tick the last box on #10. From then on, review every API pull request against this file and ask for the file to change in the same pull request when an endpoint changes.

## #48 Sign-in and document list pages (Milton), after #47

1. Branch `feature/48-signin-list` from `main` after #47 merges.
2. `npm install react-router-dom`. Routes: `/login`, `/register`, `/documents`.
3. `web/src/api.js`: one `request(path, options)` that prefixes `/api/v1`, adds `Authorization: Bearer <token>` when signed in, and throws the `{ error, code }` body on a non-2xx. Keep the token in a React context (memory only, per the issue).
4. Forms call `POST /auth/register` and `POST /auth/login`; on success store the token and go to `/documents`.
5. `/documents` calls `GET /documents` and lists title, the caller's `role` and `updatedAt`; an upload button sends `POST /documents` as `FormData` with `file` and `title`.
6. Until #39 and #40 merge, return placeholder data from `api.js` behind a flag so the pages can be built and reviewed now.
7. Test with Vitest and React Testing Library: the list renders the items it is given, and a 401 sends the user to `/login`.

## #49 Document view (Milton), after #48

Three small pull requests rather than one large one:

1. Viewer: route `/documents/:id`, `GET /documents/:id` and its versions; `pdfjs-dist` for PDFs, `<img>` for PNG and JPEG, a download link (`.../versions/:versionId/content`) for the rest.
2. Comments and pins: list from `GET .../versions/:versionId/comments`; a click on the page computes `x` and `y` as fractions of the page box and `POST`s a comment with `{ page, x, y }`; pins render at those fractions.
3. Share dialog and version list: `POST .../shares` by email or link, the version list with a revert button (`POST .../revert`). Live updates arrive later from the hook in #46; leave one place where the comment list is replaced, so the hook can call it.

## Later stage (9 to 20 November, after the checkpoint)

#43 tags, search and export (Eyrika), #44 email (Eyrika), #46 client hook (Jyotiraditya), #24 review decisions (Jyotiraditya), #50 nightly backup (Milton): guides are added here when the checkpoint work is merged.

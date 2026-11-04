# API contract

First draft, 31 October 2026, from `ARCHITECTURE.md` D2 to D5 and D10. Owned by the API and data slice after review (Issue #10). The frontend, the real-time layer and the additive slices build against this table; a change to a path, a body or a status code is a change here first, with the team told on the Issue.

Base path `/api/v1`. JSON in and out, `Content-Type: application/json`, except file upload (`multipart/form-data`) and file download (the stored content type). Timestamps are ISO 8601 UTC. Ids are UUIDs.

## Rules stated once

**Authentication.** `POST /auth/login` returns a JWT; every other route except `/auth/*`, `/health`, `/metrics` and link-token reads sends it as `Authorization: Bearer <token>`. Missing or invalid token: `401`.

**Roles.** Per document, from the `shares` table: `owner`, `editor`, `commenter`, `viewer`. One middleware loads the caller's share row for `:documentId` before any handler runs. No row: `404` (not `403`, so the existence of a document is not leaked). Wrong role: `403`.

| Action | owner | editor | commenter | viewer |
|---|---|---|---|---|
| read document, versions, comments, download | yes | yes | yes | yes |
| comment, reply, pin, resolve own thread | yes | yes | yes | |
| upload a version, revert, edit metadata, tags | yes | yes | | |
| share, change roles, delete document | yes | | | |

**Error shape.** Every non-2xx response is `{ "error": "<short message>", "code": "<UPPER_SNAKE>", "details": [...] }`. `details` is present only on `400` validation errors: `[{ "field": "title", "message": "required" }]`. Codes used: `VALIDATION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TOO_LARGE`, `RATE_LIMITED`, `INTERNAL`.

**Validation.** Bodies are validated in middleware (zod) before a handler sees them; unknown fields are rejected with `400`. Request bodies are capped at 1 MB; uploads at 50 MB (`413 TOO_LARGE`).

**Pagination.** Every list takes `?limit=` (default 20, max 100) and `?cursor=` (opaque, from the previous page) and returns `{ "items": [...], "nextCursor": "<string or null>" }`. Lists are ordered newest first unless stated.

**Rate limit.** Writes are limited per user (default 60 a minute); over the limit `429 RATE_LIMITED` with `Retry-After`.

**Status codes.** `200` read or update, `201` created (body is the created object), `204` deleted (no body), `400`, `401`, `403`, `404`, `409` (duplicate email, revert to the current version), `413`, `429`, `500`, `503` (health only).

## Objects

```
User       { id, email, displayName, createdAt }
Document   { id, title, ownerId, currentVersionId, role, tags: [string], createdAt, updatedAt }
Version    { id, documentId, number, filename, contentType, size, checksum, uploadedBy, createdAt }
Share      { id, documentId, userId | null, linkToken | null, role, expiresAt | null, createdAt }
Comment    { id, versionId, authorId, parentId | null, body, anchor | null, resolved, createdAt, updatedAt }
Anchor     { page: number, x: number, y: number }      (0 to 1, relative to the page; null for a general comment)
Tag        { name, count }
```

`role` on a Document is the caller's role, so the client can hide controls it cannot use.

## Endpoints

### Auth

| Method | Path | Body | Responses |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password, displayName }` | `201 User`; `409` email taken |
| POST | `/auth/login` | `{ email, password }` | `200 { token, user }`; `401` |
| GET | `/auth/me` | | `200 User` |

Passwords: bcrypt, minimum 8 characters. Tokens expire after 24 hours; no refresh in scope.

### Documents

| Method | Path | Body | Responses |
|---|---|---|---|
| GET | `/documents` | `?q=` title search, `?tag=` filter | `200` page of `Document` the caller can read |
| POST | `/documents` | multipart: `file`, `title` (defaults to filename) | `201 Document` with version 1; `413`; `400` type not allowed |
| GET | `/documents/:documentId` | | `200 Document` |
| PATCH | `/documents/:documentId` | `{ title?, tags? }` | `200 Document` |
| DELETE | `/documents/:documentId` | | `204`; owner only |

Allowed upload types: PDF, PNG, JPEG, plus docx, xlsx, pptx, txt, md (stored and downloadable, not rendered).

### Versions

| Method | Path | Body | Responses |
|---|---|---|---|
| GET | `/documents/:documentId/versions` | | `200` page of `Version`, oldest first |
| POST | `/documents/:documentId/versions` | multipart: `file` | `201 Version`, becomes current |
| GET | `/documents/:documentId/versions/:versionId` | | `200 Version` |
| GET | `/documents/:documentId/versions/:versionId/content` | | `200` file stream, `Content-Disposition: attachment` |
| POST | `/documents/:documentId/versions/:versionId/revert` | | `201 Version` (a new version with the old content); `409` already current |

Upload streams to Spaces; the row is written only after the object is stored. The same checksum on the same document is `409`.

### Shares

| Method | Path | Body | Responses |
|---|---|---|---|
| GET | `/documents/:documentId/shares` | | `200` page of `Share`; owner only |
| POST | `/documents/:documentId/shares` | `{ email, role }` or `{ link: true, role, expiresAt? }` | `201 Share`; `404` no such user; `409` already shared |
| PATCH | `/documents/:documentId/shares/:shareId` | `{ role?, expiresAt? }` | `200 Share` |
| DELETE | `/documents/:documentId/shares/:shareId` | | `204` |
| GET | `/links/:linkToken` | | `200 { document, version }` for a valid, unexpired link; `404` otherwise |

A link share grants its role to anyone with the token until `expiresAt`. Writes through a link (comments) still require sign-in, so every comment has an author.

### Comments

| Method | Path | Body | Responses |
|---|---|---|---|
| GET | `/documents/:documentId/versions/:versionId/comments` | `?resolved=` | `200` page of `Comment`, oldest first, threads flattened with `parentId` |
| POST | `/documents/:documentId/versions/:versionId/comments` | `{ body, anchor?, parentId? }` | `201 Comment` |
| PATCH | `/documents/:documentId/comments/:commentId` | `{ body?, resolved? }` | `200 Comment`; author or owner |
| DELETE | `/documents/:documentId/comments/:commentId` | | `204`; author or owner |

`@displayName` in a body is a mention; the API resolves it to users who have a share on the document and emits a notification event.

### Tags, search and export

| Method | Path | Body | Responses |
|---|---|---|---|
| GET | `/tags` | | `200 [Tag]` across documents the caller can read |
| GET | `/documents` | `?q=&tag=` | see Documents |
| GET | `/export?format=json\|csv` | | `200` metadata of the caller's documents and versions, `Content-Disposition: attachment` |

### Operations

| Method | Path | Responses |
|---|---|---|
| GET | `/health` (no `/api/v1` prefix) | `200 { status: "ok", postgres, redis }`; `503` degraded |
| GET | `/metrics` (no prefix) | `200` Prometheus text; cluster-internal only |

## Real-time events (Socket.IO)

Namespace `/`, path `/socket.io`, WebSocket transport only (D12). Handshake sends the JWT in `auth.token`. The client joins a room per version: `join { versionId }`; the server checks the share and acknowledges `{ ok: true }` or `{ ok: false, code }`.

Server to client, in the version room:

| Event | Payload |
|---|---|
| `comment:created` | `Comment` |
| `comment:updated` | `Comment` |
| `comment:deleted` | `{ id }` |
| `version:created` | `Version` (sent to all rooms of the document) |
| `mention` | `{ commentId, documentId, from }` (to the mentioned user only) |

Every event is emitted after the database write commits, through the Redis adapter, so every API replica delivers it.

## Open points for the API and data slice

- Whether `PATCH /documents/:id` with `tags` replaces or merges the tag list (draft: replaces).
- Whether `resolved` moves to the thread root only (draft: any comment, the client shows the root's value).
- Cursor encoding (draft: base64 of `createdAt,id`).

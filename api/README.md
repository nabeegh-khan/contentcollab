# api

The JSON API: Node.js, Express, Socket.IO. Owner: Milton (routes, data, auth); Nabeegh (realtime, metrics, health).

Planned layout, mirroring the Assignment 2 starter so everyone already knows it:

```
api/
  src/
    server.ts        app setup, middleware order, listen only when run directly
    routes/          one file per resource: auth, documents, versions, shares, comments, tags, search, export
    middleware/      validation, auth and role checks, request logging, error handler
    services/        the work behind a route: storage client (Spaces), realtime (Socket.IO), queue (BullMQ)
    db/              Prisma schema or SQL, migrations, one shared client
    types.ts         raw input types and validated types, kept apart
  tests/             Jest and Supertest, one file per resource, run serially against a reset test database
  Dockerfile
  package.json
```

Rules that apply here are in `docs/PRACTICES.md` (API-*, DB-*, SEC-*, TST-*).

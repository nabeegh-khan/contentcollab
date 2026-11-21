import { describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";
import { errorHandler } from "./errorHandler.js";
import { opsAdminIds, requireOpsAdmin } from "./requireOpsAdmin.js";

// Who may open the operations panel (D31): a user whose id is in OPS_ADMIN_USER_IDS. Unset means nobody.
const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OK = 200;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

function appFor(userId: string | undefined, env: Record<string, string | undefined>) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.userId = userId;
    next();
  });
  app.get("/", requireOpsAdmin(env), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("opsAdminIds", () => {
  it("reads a comma-separated list of ids, trimmed, in any case", () => {
    const ids = opsAdminIds({ OPS_ADMIN_USER_IDS: ` ${ADMIN.toUpperCase()} , ${OTHER} ` });
    expect([...ids].sort()).toEqual([ADMIN, OTHER]);
  });

  it("skips an entry that is not an id, and is empty when the setting is unset or empty", () => {
    expect([...opsAdminIds({ OPS_ADMIN_USER_IDS: `nope,${ADMIN}` })]).toEqual([ADMIN]);
    expect(opsAdminIds({}).size).toBe(0);
    expect(opsAdminIds({ OPS_ADMIN_USER_IDS: "" }).size).toBe(0);
  });
});

describe("requireOpsAdmin", () => {
  it("lets a listed user through", async () => {
    const res = await request(appFor(ADMIN, { OPS_ADMIN_USER_IDS: ADMIN })).get("/");
    expect(res.status).toBe(OK);
  });

  it("refuses a signed-in user who is not listed with 403", async () => {
    const res = await request(appFor(OTHER, { OPS_ADMIN_USER_IDS: ADMIN })).get("/");
    expect(res.status).toBe(FORBIDDEN);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("refuses everyone when nobody is listed (fail closed)", async () => {
    const res = await request(appFor(ADMIN, {})).get("/");
    expect(res.status).toBe(FORBIDDEN);
  });

  it("answers 401 when no user was identified, and never reaches the handler", async () => {
    const res = await request(appFor(undefined, { OPS_ADMIN_USER_IDS: ADMIN })).get("/");
    expect(res.status).toBe(UNAUTHORIZED);
  });
});

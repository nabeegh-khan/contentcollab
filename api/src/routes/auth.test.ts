import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import bcrypt from "bcrypt";
import request from "supertest";
import app from "../server.js";
import { pool } from "../lib/db.js";
import { requireDatabase } from "../lib/dbReady.js";
import { requireServices } from "../lib/reachable.js";

const base = "/api/v1/auth";
const testSecret = "auth-test-secret-that-is-not-used-outside-tests";
const previousSecret = process.env.JWT_SECRET;
const createdUserIds: string[] = [];

function email(): string {
  return `auth-${crypto.randomUUID()}@example.com`;
}

async function createUser(password = "password123") {
  const userEmail = email();
  const hash = await bcrypt.hash(password, 4);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [userEmail, hash, "Test User"],
  );
  const id = result.rows[0]!.id;
  createdUserIds.push(id);
  return { id, email: userEmail, password };
}

beforeAll(async () => {
  process.env.JWT_SECRET = testSecret;
  await requireServices(
    [
      {
        name: "PostgreSQL",
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
      },
    ],
    1000,
  );
  await requireDatabase(pool, 1000);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]);
  }
  await pool.end();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

describe("POST /api/v1/auth/register", () => {
  it("returns 400 when registration contains an unknown field", async () => {
    const res = await request(app).post(`${base}/register`).send({
      email: email(),
      password: "password123",
      displayName: "Test User",
      isAdmin: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "body" })]),
    );
  });

  it("creates a user with 201 and never returns the password hash", async () => {
    const userEmail = email();
    const res = await request(app).post(`${base}/register`).send({
      email: userEmail,
      password: "password123",
      displayName: "Test User",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      email: userEmail,
      displayName: "Test User",
      createdAt: expect.any(String),
    });
    expect(res.body).not.toHaveProperty("password_hash");
    createdUserIds.push(res.body.id);

    const stored = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [res.body.id],
    );
    expect(stored.rows[0]!.password_hash).not.toBe("password123");
    expect(await bcrypt.compare("password123", stored.rows[0]!.password_hash)).toBe(true);
  });

  it("returns 409 for a duplicate email", async () => {
    const user = await createUser();
    const res = await request(app).post(`${base}/register`).send({
      email: user.email,
      password: "password123",
      displayName: "Another User",
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("returns 400 with password details for a short password", async () => {
    const res = await request(app).post(`${base}/register`).send({
      email: email(),
      password: "short",
      displayName: "Test User",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "password" })]),
    );
  });
});

describe("POST /api/v1/auth/login and GET /api/v1/auth/me", () => {
  it("returns 400 for an invalid login email", async () => {
    const res = await request(app).post(`${base}/login`).send({
      email: "not-an-email",
      password: "password123",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "email" })]),
    );
  });

  it("returns 400 when login contains an unknown field", async () => {
    const res = await request(app).post(`${base}/login`).send({
      email: email(),
      password: "password123",
      unexpected: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "body" })]),
    );
  });

  it("returns 401 for an invalid or expired token", async () => {
    const user = await createUser();
    const expiredToken = jwt.sign({}, testSecret, {
      subject: user.id,
      expiresIn: -1,
    });

    for (const token of ["not-a-jwt", expiredToken]) {
      const res = await request(app)
        .get(`${base}/me`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
  });
  
  it("returns a token and public user for valid credentials", async () => {
    const user = await createUser();
    const res = await request(app).post(`${base}/login`).send({
      email: user.email,
      password: user.password,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual(expect.objectContaining({ id: user.id, email: user.email }));
    expect(res.body.user).not.toHaveProperty("password_hash");
  });

  it("returns the same 401 for an unknown email and a wrong password", async () => {
    const user = await createUser();
    const wrongPassword = await request(app).post(`${base}/login`).send({
      email: user.email,
      password: "wrong-password",
    });
    const unknownEmail = await request(app).post(`${base}/login`).send({
      email: email(),
      password: user.password,
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("returns the current user with a valid login token", async () => {
    const user = await createUser();
    const login = await request(app).post(`${base}/login`).send({
      email: user.email,
      password: user.password,
    });
    expect(login.status).toBe(200);

    const res = await request(app)
      .get(`${base}/me`)
      .set("Authorization", `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: user.id, email: user.email }));
    expect(res.body).not.toHaveProperty("password_hash");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get(`${base}/me`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});

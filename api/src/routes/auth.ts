import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { jwtSecret, requireAuth } from "../middleware/requireAuth.js";

const router = Router();

const registerSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(8),
  displayName: z.string().trim().min(1),
});

const loginSchema = z.strictObject({
  email: z.email(),
  password: z.string(),
});

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
  password_hash: string;
};

function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

function validationError(error: z.ZodError) {
  return {
    error: "Invalid Request",
    code: "VALIDATION",
    details: error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: "required",
    })),
  };
}

// POST /api/v1/auth/register
router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationError(parsed.error));
    return;
  }

  const { email, password, displayName } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, created_at`,
      [email.toLowerCase(), passwordHash, displayName],
    );

    res.status(201).json(publicUser(result.rows[0]!));
  } catch (error) {
    // PostgreSQL unique_violation, for example an email UNIQUE constraint.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      res.status(409).json({
        error: "Email Already Registered",
        code: "CONFLICT",
      });
      return;
    }

    throw error;
  }
});

// POST /api/v1/auth/login
router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationError(parsed.error));
    return;
  }

  const { email, password } = parsed.data;
  const result = await pool.query<UserRow>(
    `SELECT id, email, password_hash, display_name, created_at
     FROM users
     WHERE email = $1`,
    [email.toLowerCase()],
  );

  const user = result.rows[0];
  const passwordMatches = user
    ? await bcrypt.compare(password, user.password_hash)
    : false;

  if (!user || !passwordMatches) {
    res.status(401).json({
      error: "Invalid Email or Password",
      code: "UNAUTHORIZED",
    });
    return;
  }

  const token = jwt.sign({}, jwtSecret(), {
    subject: user.id,
    expiresIn: "24h",
  });

  res.status(200).json({ token, user: publicUser(user) });
});

// GET /api/v1/auth/me
router.get("/me", requireAuth, async (_req, res) => {
  const result = await pool.query<UserRow>(
    `SELECT id, email, display_name, created_at
     FROM users
     WHERE id = $1`,
    [res.locals.userId],
  );

  const user = result.rows[0];
  if (!user) {
    res.status(401).json({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });
    return;
  }

  res.status(200).json(publicUser(user));
});

export default router;
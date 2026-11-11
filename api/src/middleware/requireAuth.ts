import type { RequestHandler } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return secret;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const authorization = req.header("Authorization");
  const match = /^Bearer (.+)$/i.exec(authorization ?? "");
  const token = match?.[1];

  if (!token) {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret()) as JwtPayload;

    if (typeof payload.sub !== "string") {
      res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
      return;
    }

    res.locals.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  }
};

import type { RequestHandler } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { HttpError } from "../lib/httpError.js";

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
    throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
  }

  const secret = jwtSecret();
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    }) as JwtPayload;

    if (typeof payload.sub !== "string") {
      throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
    }

    res.locals.userId = payload.sub;
    next();
  } catch {
    throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
  }
};

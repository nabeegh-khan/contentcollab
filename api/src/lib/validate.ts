import type { RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "./httpError.js";

export function validate(schema: z.ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      throw new HttpError(
        400,
        "VALIDATION",
        "Invalid Request",
        result.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      );
    }

    req.body = result.data;
    next();
  };
}

import type { NextFunction, Request, Response } from "express";
import { STATUS_CODES } from "node:http";
import { HttpError } from "../lib/httpError.js";

// Last middleware in the chain. The client gets a fixed shape and no detail;
// the detail goes to the log. Express only treats a 4-argument function as an
// error handler, so `next` stays even though it is unused.
function statusCodeName(status: number): string {
  const name = STATUS_CODES[status];
  return name
    ? name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
    : "ERROR";
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  void next;

  if (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    err.type === "entity.too.large"
  ) {
    res.status(413).json({
      error: "Request Body Too Large",
      code: "TOO_LARGE",
    });
    return;
  }

  if (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    err.type === "entity.parse.failed"
  ) {
    res.status(400).json({ error: "Malformed JSON", code: "VALIDATION" });
    return;
  }

  if (err instanceof HttpError && err.status >= 500) {
    console.error(`${req.method} ${req.originalUrl}`, err);
    res.status(err.status).json({
      error: "Internal Server Error",
      code: "INTERNAL",
    });
    return;
  }

  if (err instanceof HttpError) {
    const code = err.code || statusCodeName(err.status);
    const body: {
      error: string;
      code: string;
      details?: { field: string; message: string }[];
    } = { error: err.message, code };

    // details only show up when the status is 400
    if (err.status === 400 && code === "VALIDATION" && err.details) {
      body.details = err.details;
    }

    res.status(err.status).json(body);
    return;
  }

  console.error(`${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    error: "Internal Server Error",
    code: "INTERNAL",
  });
}

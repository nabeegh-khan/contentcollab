import type { Response } from "express";

// Responses that failed after their headers were sent. The error handler
// marks them and closes the connection; the request logger and the metrics
// then record a server error on "close" instead of an aborted request, since
// the client did not go away: the server broke the response.
const failed = new WeakSet<Response>();

export function markFailedMidResponse(res: Response): void {
  failed.add(res);
}

export function failedMidResponse(res: Response): boolean {
  return failed.has(res);
}

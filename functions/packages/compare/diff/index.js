// The compare/diff function (#180, ARCHITECTURE D39): the line diff of two texts, called by the API.
// Secure web function: the platform checks the X-Require-Whisk-Auth header (webSecure in project.yml)
// before this code runs. Errors carry a fixed message and never the texts.
const { lineDiff, DiffTooLargeError } = require("./diff.js");

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_LARGE = 413;
// The platform's response limit is 1 MB; stay under it so a large diff is refused, not cut off
const MAX_RESPONSE_BYTES = 900_000;

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body,
});

async function main(args) {
  const { before, after } = args ?? {};
  if (typeof before !== "string" || typeof after !== "string") {
    return reply(HTTP_BAD_REQUEST, { error: "before and after must both be strings" });
  }
  const started = performance.now();
  let diff;
  try {
    diff = lineDiff(before, after);
  } catch (error) {
    if (error instanceof DiffTooLargeError) {
      return reply(HTTP_TOO_LARGE, { error: "the versions are too large to compare" });
    }
    throw error;
  }
  const body = { ...diff, computeMs: Math.round((performance.now() - started) * 10) / 10 };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_RESPONSE_BYTES) {
    return reply(HTTP_TOO_LARGE, { error: "the response would be too large" });
  }
  return reply(HTTP_OK, body);
}

module.exports = { main, MAX_RESPONSE_BYTES };

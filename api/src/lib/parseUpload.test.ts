import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Request } from "express";
import { describe, expect, it } from "@jest/globals";
import { parseUpload } from "./parseUpload.js";

describe("parseUpload malformed multipart", () => {
  it("aborts the upload, waits for it to finish, then rejects with 400 VALIDATION", async () => {
    const boundary = `test-${randomUUID()}`;
    const body = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="broken.txt"\r\n' +
        "Content-Type: text/plain\r\n\r\n" +
        "incomplete file without a closing boundary",
    );
    const req = Object.assign(Readable.from([body]), {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }) as unknown as Request;

    let releaseUpload!: () => void;
    const uploadFinished = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });

    let sawAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      sawAbort = resolve;
    });

    let settled = false;
    const result = parseUpload(req, async (file, _info, signal) => {
      file.resume();
      if (signal.aborted) sawAbort();
      else signal.addEventListener("abort", sawAbort, { once: true });
      await uploadFinished;
    });
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await abortObserved;
    expect(settled).toBe(false);

    releaseUpload();
    await expect(result).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION",
    });
  });
});

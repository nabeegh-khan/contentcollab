// The upload runner: one request per file, its own state, a refused file does not stop the others (D40).
import { describe, expect, it, vi } from "vitest";
import { runUploads } from "./runUploads.js";

const pdf = (name) => new File(["%PDF"], name, { type: "application/pdf" });
const reasonOf = (error) => `failed: ${error.message}`;

// A send that holds each call until released, and counts how many are in flight
function gatedSend() {
  const started = [];
  const gates = [];
  let active = 0;
  let maxActive = 0;
  const send = (file) => {
    started.push(file.name);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve) => {
      gates.push(() => {
        active -= 1;
        resolve(`done ${file.name}`);
      });
    });
  };
  return { send, started, gates, max: () => maxActive };
}

describe("runUploads", () => {
  it("sends one request per file and reports each file's own result", async () => {
    const send = vi.fn(async (file) => `ok ${file.name}`);
    const items = await runUploads({
      files: [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")],
      send,
      reasonOf,
      concurrency: 3,
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(items.map((i) => [i.name, i.status, i.message])).toEqual([
      ["a.pdf", "done", "ok a.pdf"],
      ["b.pdf", "done", "ok b.pdf"],
      ["c.pdf", "done", "ok c.pdf"],
    ]);
  });

  it("never sends a refused file, gives it its message, and still sends the others", async () => {
    const send = vi.fn(async (file) => `ok ${file.name}`);
    const items = await runUploads({
      files: [
        pdf("a.pdf"),
        new File(["x"], "bad.exe", { type: "application/octet-stream" }),
        pdf("c.pdf"),
      ],
      send,
      reasonOf,
      concurrency: 3,
    });
    expect(send.mock.calls.map(([f]) => f.name)).toEqual(["a.pdf", "c.pdf"]);
    expect(items[1].status).toBe("failed");
    expect(items[1].message).toMatch(/not allowed/i);
    expect(items[0].status).toBe("done");
    expect(items[2].status).toBe("done");
  });

  it("keeps going when a request fails, with the caller's reason for that file only", async () => {
    const send = vi.fn(async (file) => {
      if (file.name === "b.pdf") throw new Error("boom");
      return "ok";
    });
    const items = await runUploads({
      files: [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")],
      send,
      reasonOf,
      concurrency: 1,
    });
    expect(items.map((i) => i.status)).toEqual(["done", "failed", "done"]);
    expect(items[1].message).toBe("failed: boom");
  });

  it("with a concurrency of 1 starts the next file only after the last one finished, in order", async () => {
    const gated = gatedSend();
    const run = runUploads({
      files: [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")],
      send: gated.send,
      reasonOf,
      concurrency: 1,
    });
    await vi.waitFor(() => expect(gated.started).toEqual(["a.pdf"]));
    gated.gates[0]();
    await vi.waitFor(() => expect(gated.started).toEqual(["a.pdf", "b.pdf"]));
    gated.gates[1]();
    await vi.waitFor(() => expect(gated.started).toEqual(["a.pdf", "b.pdf", "c.pdf"]));
    gated.gates[2]();
    await run;
    expect(gated.max()).toBe(1);
  });

  it("never has more requests in flight than the concurrency", async () => {
    const gated = gatedSend();
    const names = ["a", "b", "c", "d", "e"].map((n) => pdf(`${n}.pdf`));
    const run = runUploads({ files: names, send: gated.send, reasonOf, concurrency: 3 });
    await vi.waitFor(() => expect(gated.started.length).toBe(3));
    gated.gates[0]();
    await vi.waitFor(() => expect(gated.started.length).toBe(4));
    gated.gates[1]();
    gated.gates[2]();
    await vi.waitFor(() => expect(gated.started.length).toBe(5));
    gated.gates[3]();
    gated.gates[4]();
    await run;
    expect(gated.max()).toBe(3);
  });

  it("reports waiting, then uploading, then done to the caller as it goes", async () => {
    const gated = gatedSend();
    const seen = [];
    const run = runUploads({
      files: [pdf("a.pdf"), pdf("b.pdf")],
      send: gated.send,
      reasonOf,
      concurrency: 1,
      onUpdate: (items) => seen.push(items.map((i) => i.status).join(",")),
    });
    await vi.waitFor(() => expect(gated.started.length).toBe(1));
    expect(seen.at(-1)).toBe("uploading,waiting");
    gated.gates[0]();
    await vi.waitFor(() => expect(gated.started.length).toBe(2));
    expect(seen.at(-1)).toBe("done,uploading");
    gated.gates[1]();
    expect((await run).map((i) => i.status)).toEqual(["done", "done"]);
    expect(seen.at(-1)).toBe("done,done");
  });

  it("starts nothing for an empty list", async () => {
    const send = vi.fn();
    expect(await runUploads({ files: [], send, reasonOf, concurrency: 3 })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

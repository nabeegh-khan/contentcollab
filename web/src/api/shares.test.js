// Tests for the share call: POST /documents/:id/shares with an email and a role, and the token.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client.js";
import { createShare } from "./shares.js";

const DOC = "11111111-1111-4111-8111-111111111111";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createShare", () => {
  it("posts the email and role to the document's shares with the token", async () => {
    const share = { id: "s1", documentId: DOC, userId: "u2", role: "commenter" };
    const fetchMock = vi.fn().mockResolvedValue(json(201, share));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createShare("t0k", DOC, { email: "bo@x.co", role: "commenter" });

    expect(result).toEqual(share);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/documents/${DOC}/shares`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "bo@x.co", role: "commenter" });
    expect(init.headers.Authorization).toBe("Bearer t0k");
  });

  it("throws the API error with its real status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(409, { error: "User Already Shared", code: "CONFLICT" })),
    );

    const error = await createShare("t0k", DOC, { email: "bo@x.co", role: "viewer" }).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
  });
});

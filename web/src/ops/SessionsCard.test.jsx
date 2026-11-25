// Render tests for the Active sessions card (D38): the total over all API replicas, the split per replica,
// a partial answer said in words, and its own 5-second refresh.
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionsCard from "./SessionsCard.jsx";

const counts = (over = {}) => ({
  total: 5,
  partial: false,
  replicas: [
    { replica: "api-7d9-aaaaa", sessions: 3 },
    { replica: "api-7d9-bbbbb", sessions: 2 },
  ],
  ...over,
});

const respond = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SessionsCard", () => {
  it("asks /api/v1/ops/sessions with the token and shows the total and one row per replica", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { sessions: counts() }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionsCard token="t0k" />);
    await flush();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/ops/sessions");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
    expect(screen.getByRole("heading", { name: "Active sessions" })).toBeTruthy();
    expect(screen.getByText("5 sessions open across 2 API replicas")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Sessions per API replica" });
    const rows = within(table)
      .getAllByRole("row")
      .map((row) => [...row.children].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["Replica", "Sessions"],
      ["api-7d9-aaaaa", "3"],
      ["api-7d9-bbbbb", "2"],
    ]);
  });

  it("says one replica and one session in the singular", async () => {
    const one = counts({ total: 1, replicas: [{ replica: "api-a", sessions: 1 }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { sessions: one })));
    render(<SessionsCard token="t" />);
    await flush();
    expect(screen.getByText("1 session open across 1 API replica")).toBeTruthy();
  });

  it("says it counts connections, not people", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { sessions: counts() })));
    render(<SessionsCard token="t" />);
    await flush();
    expect(screen.getByText(/one person with two tabs counts twice/i)).toBeTruthy();
  });

  it("updates the numbers on the next refresh, 5 s after the last answer", async () => {
    const later = counts({
      total: 4,
      replicas: [
        { replica: "api-7d9-aaaaa", sessions: 1 },
        { replica: "api-7d9-bbbbb", sessions: 3 },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { sessions: counts() }))
      .mockResolvedValue(respond(200, { sessions: later }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionsCard token="t" />);
    await flush();
    expect(screen.getByText("5 sessions open across 2 API replicas")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("4 sessions open across 2 API replicas")).toBeTruthy();
    expect(screen.queryByText("5 sessions open across 2 API replicas")).toBeNull();
  });

  it("says in words when a replica did not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(200, { sessions: counts({ partial: true }) })),
    );
    render(<SessionsCard token="t" />);
    await flush();
    expect(screen.getByText(/at least one replica did not answer in time/i)).toBeTruthy();
  });

  it("does not show the partial line for a complete answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { sessions: counts() })));
    render(<SessionsCard token="t" />);
    await flush();
    expect(screen.queryByText(/did not answer/i)).toBeNull();
  });

  it("says the count is not available, with the reason, when the API gives none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(200, { sessions: null, error: "unavailable" })),
    );
    render(<SessionsCard token="t" />);
    await flush();
    expect(screen.getByText(/Not available: unavailable/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps the last numbers and says so when a refresh fails, and survives a body that is not the count", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { sessions: counts() }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(respond(200, { generatedAt: "not the count" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionsCard token="t" />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText("5 sessions open across 2 API replicas")).toBeTruthy();
    expect(screen.getByText(/Last update failed/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText(/Last update failed/)).toBeTruthy();
  });

  it("stops asking after a 401 or 403", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(respond(403, { error: "Forbidden", code: "FORBIDDEN" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionsCard token="t" />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders a replica name as text, not markup", async () => {
    const hostile = counts({
      total: 1,
      replicas: [{ replica: "<img src=x onerror=alert(1)>", sessions: 1 }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { sessions: hostile })));
    const { container } = render(<SessionsCard token="t" />);
    await flush();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});

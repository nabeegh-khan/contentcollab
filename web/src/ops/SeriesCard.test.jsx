// Render tests for the per-pod charts (D31 follow-up): lines, legend with values, not colour alone, own refresh.
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SeriesCard from "./SeriesCard.jsx";

const series = {
  windowSeconds: 900,
  stepSeconds: 15,
  cpu: [
    {
      pod: "api-a",
      points: [
        { t: 1, v: 100 },
        { t: 2, v: 250 },
      ],
    },
    {
      pod: "api-b",
      points: [
        { t: 1, v: 50 },
        { t: 2, v: 75 },
      ],
    },
  ],
  memory: [
    {
      pod: "api-a",
      points: [
        { t: 1, v: 100 },
        { t: 2, v: 120 },
      ],
    },
  ],
};

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

describe("SeriesCard", () => {
  it("asks /api/v1/ops/series with the token and draws one line per pod in each chart", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { series }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SeriesCard token="t0k" />);
    await flush();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/ops/series");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
    const cpu = screen.getByRole("img", { name: "CPU per pod, millicores, last 15 minutes" });
    expect(cpu.querySelectorAll("polyline")).toHaveLength(2);
    const memory = screen.getByRole("img", { name: "Memory per pod, MiB, last 15 minutes" });
    expect(memory.querySelectorAll("polyline")).toHaveLength(1);
  });

  it("lists each pod with its latest value, so a reader never depends on the line colour", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { series })));
    render(<SeriesCard token="t" />);
    await flush();

    const legend = screen.getByRole("list", { name: "CPU per pod now" });
    const items = within(legend).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("api-a: 250 m"),
      expect.stringContaining("api-b: 75 m"),
    ]);
    const dashes = [
      ...screen.getByRole("img", { name: /^CPU per pod/ }).querySelectorAll("polyline"),
    ].map((l) => l.getAttribute("stroke-dasharray"));
    expect(new Set(dashes).size).toBe(2);
  });

  it("asks again 5 s after the last answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { series }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SeriesCard token="t" />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says the charts are not available, with the reason, when the API gives none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(200, { series: null, error: "unavailable" })),
    );
    render(<SeriesCard token="t" />);
    await flush();
    expect(screen.getByText(/Not available: unavailable/)).toBeTruthy();
  });

  it("keeps the last charts and says so when a refresh fails, and survives a body that is not the series", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { series }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(respond(200, { generatedAt: "not the series" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SeriesCard token="t" />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("img", { name: /^CPU per pod/ })).toBeTruthy();
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
    render(<SeriesCard token="t" />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives each chart a title line with its unit, and the x axis a label", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { series })));
    render(<SeriesCard token="t" />);
    await flush();

    const cpu = screen.getByRole("figure", { name: "CPU, millicores" });
    const memory = screen.getByRole("figure", { name: "Memory, MiB" });
    expect(within(cpu).getByText("last 15 minutes", { selector: "text" })).toBeTruthy();
    expect(within(memory).getByText("last 15 minutes", { selector: "text" })).toBeTruthy();
  });

  it("labels the y axis with its minimum (0) and its maximum, in the chart's unit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { series })));
    render(<SeriesCard token="t" />);
    await flush();

    const cpu = screen.getByRole("figure", { name: "CPU, millicores" });
    expect(within(cpu).getByText("250", { selector: "text" })).toBeTruthy();
    expect(within(cpu).getByText("0", { selector: "text" })).toBeTruthy();
    const memory = screen.getByRole("figure", { name: "Memory, MiB" });
    expect(within(memory).getByText("120", { selector: "text" })).toBeTruthy();
  });

  it("ties each line style to its pod in the legend with a swatch that uses the same dash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { series })));
    render(<SeriesCard token="t" />);
    await flush();

    const cpu = screen.getByRole("figure", { name: "CPU, millicores" });
    const lines = [...cpu.querySelectorAll("svg[role='img'] polyline")];
    const items = within(cpu).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    items.forEach((item, index) => {
      const swatch = item.querySelector("svg line");
      expect(swatch).not.toBeNull();
      expect(swatch.getAttribute("stroke-dasharray")).toBe(
        lines[index].getAttribute("stroke-dasharray"),
      );
    });
    expect(items[0].textContent).toContain("api-a");
    expect(items[1].textContent).toContain("api-b");
  });

  it("keeps the pod legend out of an inner scroll box, so the wheel scrolls the page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { series })));
    render(<SeriesCard token="t" />);
    await flush();
    const legend = screen.getByRole("list", { name: "CPU per pod now" });
    expect(legend.className).toContain("ops-legend");
  });
});

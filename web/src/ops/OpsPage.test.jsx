// Render tests for the operations page (D31): cards, plain words, polling, and each way the API can say no.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpsPage from "./OpsPage.jsx";

const NOW = Date.parse("2026-11-21T19:40:00Z");

const snapshot = (over = {}) => ({
  generatedAt: "2026-11-21T19:40:00.000Z",
  cachedForSeconds: 5,
  namespace: "contentcollab",
  errors: {},
  containers: [
    {
      component: "api",
      pod: "api-a",
      status: "Running",
      ready: true,
      node: "n1",
      restarts: 0,
      startedAt: "2026-11-21T19:23:20Z",
      ageSeconds: 1000,
      servingThisRequest: true,
    },
    {
      component: "api",
      pod: "api-b",
      status: "Starting",
      ready: false,
      node: "n2",
      restarts: 2,
      startedAt: "2026-11-21T19:39:00Z",
      ageSeconds: 60,
      servingThisRequest: false,
    },
    {
      component: "postgres",
      pod: "postgres-0",
      status: "Running",
      ready: true,
      node: "n2",
      restarts: 0,
      startedAt: "2026-11-21T10:00:00Z",
      ageSeconds: 34800,
      servingThisRequest: false,
    },
  ],
  hpa: {
    name: "api",
    currentReplicas: 2,
    desiredReplicas: 2,
    minReplicas: 2,
    maxReplicas: 5,
    cpuPercent: 12,
    cpuTargetPercent: 70,
    lastScaleTime: null,
    limitedBy: "TooFewReplicas",
  },
  nodes: [
    {
      name: "n1",
      cpuPercent: 13,
      memoryPercent: 54,
      cpuMillicores: 253,
      cpuAllocatableMillicores: 1900,
      memoryMiB: 1626,
      memoryAllocatableMiB: 3003,
      sampledAt: "2026-11-21T19:39:50Z",
      windowSeconds: 10,
    },
  ],
  traffic: {
    windowSeconds: 60,
    requestsPerSecond: 0.4,
    p50Seconds: 0.006,
    p95Seconds: 0.012,
    errorPercent: 0,
    noTraffic: false,
  },
  storage: {
    claim: {
      name: "data-postgres-0",
      phase: "Bound",
      capacity: "5Gi",
      storageClass: "do-block-storage",
    },
    documents: 12,
    versions: 19,
  },
  events: [
    {
      at: "2026-11-21T19:39:30Z",
      type: "Normal",
      reason: "Started",
      object: "Pod/api-b",
      text: "Started container api",
      source: "kubernetes",
    },
    {
      at: "2026-11-21T19:09:30Z",
      type: "Normal",
      reason: "SuccessfulRescale",
      object: "HorizontalPodAutoscaler/api",
      text: "New size: 3; reason: cpu resource utilization (percentage of request) above target",
      count: 1,
      source: "kubernetes",
    },
  ],
  logs: {
    lines: [
      {
        at: "2026-11-21T19:39:59.000Z",
        pod: "api-a",
        level: "info",
        msg: "request",
        method: "POST",
        route: "/api/v1/documents",
        status: 201,
        durationMs: 30.9,
      },
    ],
    hidden: 3,
  },
  drills: { nextAllowedAt: null },
  links: { grafana: null },
  ...over,
});

function respond(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const opsCalls = (fetchMock) =>
  fetchMock.mock.calls.filter(([url]) => url === "/api/v1/ops").length;

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("OpsPage cards", () => {
  it("asks for /api/v1/ops with the token and shows every container with word, shape, node and age", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpsPage token="t0k" />);
    await flush();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/ops");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t0k");
    const tables = screen.getAllByRole("table", { name: /^Pods on / });
    expect(tables.map((t) => t.getAttribute("aria-label"))).toEqual(["Pods on n1", "Pods on n2"]);
    const rows = [
      ...within(tables[0]).getAllByRole("row"),
      ...within(tables[1]).getAllByRole("row"),
    ];
    expect(rows).toHaveLength(5);
    expect(within(rows[1]).getByText("Running")).toBeTruthy();
    expect(within(rows[1]).getByText("●")).toBeTruthy();
    expect(within(rows[1]).getByText("api-a")).toBeTruthy();
    expect(within(rows[1]).getByText(/answering this page/i)).toBeTruthy();
    expect(within(rows[3]).getByText("Starting")).toBeTruthy();
    expect(within(rows[3]).getByText("◐")).toBeTruthy();
    expect(within(rows[3]).getByText("2")).toBeTruthy();
    expect(within(rows[4]).getByText("9 h 40 min")).toBeTruthy();
  });

  it("shows the autoscaler in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();

    const card = screen.getByRole("region", { name: "Autoscaler" });
    expect(within(card).getByText("API copies: 2 of 2")).toBeTruthy();
    expect(
      within(card).getByText("autoscaler range 2 to 5, scales out above 70% CPU"),
    ).toBeTruthy();
    expect(within(card).getByText("CPU now: 12%")).toBeTruthy();
  });

  it("shows node CPU and memory as labelled meters with their numbers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();

    const card = screen.getByRole("region", { name: "Nodes" });
    expect(within(card).getByText("n1")).toBeTruthy();
    expect(
      within(card).getByRole("meter", { name: "n1 memory" }).getAttribute("aria-valuenow"),
    ).toBe("54");
    expect(within(card).getByText("Memory 54%")).toBeTruthy();
    expect(within(card).getByText("CPU 13%")).toBeTruthy();
  });

  it("shows the database disk and the stored counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();

    const card = screen.getByRole("region", { name: "Storage" });
    expect(within(card).getByText("Database disk: 5Gi, Bound (attached)")).toBeTruthy();
    expect(within(card).getByText("Documents stored: 12")).toBeTruthy();
    expect(within(card).getByText("Versions stored: 19")).toBeTruthy();
  });

  it("shows traffic in words, and says so when nothing was requested", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<OpsPage token="t" />);
    await flush();
    const card = screen.getByRole("region", { name: "Traffic" });
    expect(within(card).getByText("Requests per second: 0.4")).toBeTruthy();
    expect(within(card).getByText("Slowest 5% took under 12 ms")).toBeTruthy();
    expect(within(card).getByText("Errors in the last minute: 0%")).toBeTruthy();
    unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond(
          200,
          snapshot({
            traffic: {
              windowSeconds: 60,
              requestsPerSecond: 0,
              p50Seconds: null,
              p95Seconds: null,
              errorPercent: null,
              noTraffic: true,
            },
          }),
        ),
      ),
    );
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.getByText("No requests in the last minute")).toBeTruthy();
  });

  it("lists recent events as sentences, newest first", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();

    const list = screen.getByRole("list", { name: "Recent events" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Kubernetes started a new pod (api-b)");
    expect(items[1].textContent).toContain("The autoscaler changed the API to 3 pods");
  });

  it("shows request lines and how many lines were not shown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();

    const card = screen.getByRole("region", { name: "Latest requests" });
    expect(within(card).getByText(/POST \/api\/v1\/documents 201/)).toBeTruthy();
    expect(within(card).getByText("3 other log lines are not shown")).toBeTruthy();
  });

  it("renders a body as text, never as HTML", async () => {
    const bad = snapshot();
    bad.events[0].text = "<img src=x onerror=alert(1)>";
    bad.events[0].reason = "BackOff";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, bad)));
    render(<OpsPage token="t" />);
    await flush();

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });

  it("says a card is not available, with its reason, when the API reports a failed source", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          respond(200, snapshot({ traffic: null, errors: { traffic: "unavailable" } })),
        ),
    );
    render(<OpsPage token="t" />);
    await flush();

    const card = screen.getByRole("region", { name: "Traffic" });
    expect(within(card).getByText(/Not available: unavailable/)).toBeTruthy();
  });

  it("links Grafana only when the API gives a link", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(respond(200, snapshot({ links: { grafana: "https://g.example" } }))),
    );
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.getByRole("link", { name: /Grafana/ }).getAttribute("href")).toBe(
      "https://g.example",
    );
  });
});

describe("OpsPage access", () => {
  it("says the page is for operators on a 403, and stops asking", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(respond(403, { error: "Forbidden", code: "FORBIDDEN" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpsPage token="t" />);
    await flush();

    expect(screen.getByText("This page is for operators")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(opsCalls(fetchMock)).toBe(1);
  });

  it("asks to sign in again on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(401, { error: "Unauthorized", code: "UNAUTHORIZED" })),
    );
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.getByText("Your session has ended. Sign out and sign in again.")).toBeTruthy();
  });
});

describe("OpsPage refresh", () => {
  it("asks again 5 s after the last answer, never two at once", async () => {
    let release;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, snapshot()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(respond(200, snapshot()));
          }),
      )
      .mockResolvedValue(respond(200, snapshot()));
    // the charts card asks /api/v1/ops/series on its own; only the ops calls are in the sequence
    vi.stubGlobal("fetch", (url, init) =>
      url === "/api/v1/ops/series"
        ? Promise.resolve(respond(200, { series: null, error: "unavailable" }))
        : fetchMock(url, init),
    );
    render(<OpsPage token="t" />);
    await flush();
    expect(opsCalls(fetchMock)).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(opsCalls(fetchMock)).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(opsCalls(fetchMock)).toBe(2);

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(opsCalls(fetchMock)).toBe(3);
  });

  it("shows how old the data is, and a banner when it is over 15 s old, keeping the last cards", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, snapshot()))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.getByText("Updated just now")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/older than 15 seconds/i);
    expect(screen.getByRole("table", { name: "Pods on n1" })).toBeTruthy();
  });

  it("stops asking while the tab is hidden, and asks again when it is shown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpsPage token="t" />);
    await flush();

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(opsCalls(fetchMock)).toBe(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(opsCalls(fetchMock)).toBe(2);
  });
});

describe("OpsPage failures and safety", () => {
  it("treats a 200 that is not the snapshot (an HTML page from a proxy) as a failure, not as fresh data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>spa</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );
    render(<OpsPage token="t" />);
    await flush();

    expect(screen.getByRole("alert").textContent).toMatch(/not answering/i);
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  it("gives up on a request that never answers after 4 s and asks again", async () => {
    const fetchMock = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<OpsPage token="t" />);
    await flush();
    expect(opsCalls(fetchMock)).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000 + 5000);
    });
    expect(opsCalls(fetchMock)).toBe(2);
  });

  it("recovers: a good answer after a failure clears the banner", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(respond(200, snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("table", { name: "Pods on n1" })).toBeTruthy();
  });

  it("does not link a Grafana address that is not http or https", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(respond(200, snapshot({ links: { grafana: "javascript:alert(1)" } }))),
    );
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.queryByRole("link", { name: /Grafana/ })).toBeNull();
  });

  it("shows two events with the same second, pod and reason without a duplicate-key warning", async () => {
    const twin = {
      at: "2026-11-21T19:39:30Z",
      type: "Normal",
      reason: "Started",
      object: "Pod/api-b",
      text: "Started container api",
      source: "kubernetes",
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(200, snapshot({ events: [twin, { ...twin }] }))),
    );
    render(<OpsPage token="t" />);
    await flush();
    expect(
      within(screen.getByRole("list", { name: "Recent events" })).getAllByRole("listitem"),
    ).toHaveLength(2);
    expect(spy.mock.calls.flat().join(" ")).not.toMatch(/same key/i);
    spy.mockRestore();
  });

  it("shows a card whose source failed with the server's reason, storage included", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond(
          200,
          snapshot({
            containers: null,
            hpa: null,
            nodes: null,
            storage: { claim: null, documents: null, versions: null },
            errors: {
              containers: "not configured",
              hpa: "unavailable",
              nodes: "no answer within 1000 ms",
              claim: "not configured",
              counts: "unavailable",
            },
          }),
        ),
      ),
    );
    render(<OpsPage token="t" />);
    await flush();
    expect(
      within(screen.getByRole("region", { name: "Containers" })).getByText(/not configured/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Autoscaler" })).getByText(/unavailable/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Nodes" })).getByText(/no answer within 1000 ms/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Storage" })).getByText(/not configured/),
    ).toBeTruthy();
  });
});

describe("OpsPage job queue (#30)", () => {
  it("shows the jobs waiting in the worker's queue", async () => {
    const snap = snapshot();
    snap.queue = { depth: 3 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snap)));
    render(<OpsPage token="t" />);
    await flush();
    expect(
      within(screen.getByRole("region", { name: "Job queue" })).getByText("Jobs waiting: 3"),
    ).toBeTruthy();
  });

  it("shows 0 jobs waiting as a number, not as missing", async () => {
    const snap = snapshot();
    snap.queue = { depth: 0 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snap)));
    render(<OpsPage token="t" />);
    await flush();
    const card = within(screen.getByRole("region", { name: "Job queue" }));
    expect(card.getByText("Jobs waiting: 0")).toBeTruthy();
    expect(card.queryByText(/Not available/)).toBeNull();
  });

  it("says there is no data when the reply has no queue field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();
    expect(
      within(screen.getByRole("region", { name: "Job queue" })).getByText(/Not available: no data/),
    ).toBeTruthy();
  });

  it("says why the queue cannot be shown when its source failed", async () => {
    const snap = snapshot({ queue: { depth: null }, errors: { queue: "unavailable" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snap)));
    render(<OpsPage token="t" />);
    await flush();
    expect(
      within(screen.getByRole("region", { name: "Job queue" })).getByText(/unavailable/),
    ).toBeTruthy();
  });
});

describe("OpsPage drill and comment count", () => {
  it("shows the restart card with its buttons, and the comment count in storage", async () => {
    const snap = snapshot();
    snap.storage.comments = 7;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snap)));
    render(<OpsPage token="t" />);
    await flush();

    expect(screen.getByRole("button", { name: "Restart an API pod" })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Storage" })).getByText("Comments stored: 7"),
    ).toBeTruthy();
  });

  it("says the comment count is not available when the API does not give one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.getByText("Comments stored: not available")).toBeTruthy();
  });
});

describe("OpsPage demo layout (24 Nov)", () => {
  const withGrafana = () =>
    snapshot({
      links: { grafana: "https://g.example" },
      logs: { lines: [], hidden: 0 },
    });

  it("puts the restart buttons and the Grafana link in one bar directly under the heading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, withGrafana())));
    render(<OpsPage token="t" />);
    await flush();

    const heading = screen.getByRole("heading", { name: "Operations" });
    const bar = screen.getByRole("group", { name: "Operations actions" });
    expect(within(bar).getByRole("button", { name: "Restart the database pod" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Restart an API pod" })).toBeTruthy();
    expect(within(bar).getByRole("link", { name: "Open Grafana for the details" })).toBeTruthy();
    // The bar follows the heading, and comes before every card
    expect(heading.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const firstCard = screen.getByRole("region", { name: "Containers" });
    expect(bar.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no separate Restart card and no duplicate buttons or Grafana link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, withGrafana())));
    render(<OpsPage token="t" />);
    await flush();

    expect(screen.queryByRole("heading", { name: "Restart a pod" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Restart the database pod" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Restart an API pod" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /Grafana/ })).toHaveLength(1);
  });

  it("keeps the confirm question inside the bar's group, next to the buttons", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, withGrafana())));
    render(<OpsPage token="t" />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Restart the database pod" }));
    const bar = screen.getByRole("group", { name: "Operations actions" });
    expect(within(bar).getByRole("dialog")).toBeTruthy();
    expect(within(bar).getByText("Restart the database pod?")).toBeTruthy();
  });

  it("shows Recent events straight after Containers, before the autoscaler, so the restart shows without scrolling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, withGrafana())));
    render(<OpsPage token="t" />);
    await flush();

    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
    const order = (id) => regions.indexOf(id);
    expect(order("ops-containers")).toBeGreaterThanOrEqual(0);
    expect(order("ops-recent-events")).toBe(order("ops-containers") + 1);
    expect(order("ops-recent-events")).toBeLessThan(order("ops-autoscaler"));
  });

  it("shows the newest 8 events and says how many older ones are not shown", async () => {
    const events = Array.from({ length: 11 }, (_, i) => ({
      at: `2026-11-21T19:${String(59 - i).padStart(2, "0")}:00Z`,
      type: "Normal",
      reason: "Started",
      object: `Pod/api-${i}`,
      text: "Started container api",
      source: "kubernetes",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot({ events }))));
    render(<OpsPage token="t" />);
    await flush();

    const list = screen.getByRole("list", { name: "Recent events" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText("3 older events are not shown")).toBeTruthy();
  });

  it("hides the Latest requests card when it has no rows, and shows it when it has", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, withGrafana())));
    const { unmount } = render(<OpsPage token="t" />);
    await flush();
    expect(screen.queryByRole("region", { name: "Latest requests" })).toBeNull();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();
    expect(screen.getByRole("region", { name: "Latest requests" })).toBeTruthy();
  });

  it("still shows the Latest requests card, with its reason, when the log source failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond(
          200,
          snapshot({
            logs: { lines: [], hidden: 0 },
            errors: { logs: "no answer within 1000 ms" },
          }),
        ),
      ),
    );
    render(<OpsPage token="t" />);
    await flush();
    const card = screen.getByRole("region", { name: "Latest requests" });
    expect(within(card).getByText(/no answer within 1000 ms/)).toBeTruthy();
  });

  it("writes the traffic headline on one line, in the same size class as the autoscaler's", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, snapshot())));
    render(<OpsPage token="t" />);
    await flush();
    const traffic = screen.getByText("Requests per second: 0.4");
    const hpa = screen.getByText("API copies: 2 of 2");
    expect(traffic.className).toContain("ops-big");
    expect(hpa.className).toBe(traffic.className);
  });
});

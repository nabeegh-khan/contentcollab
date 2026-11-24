// Render tests for the restart drill card (D31): two buttons, a confirm dialog, the request, and each refusal.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DrillCard from "./DrillCard.jsx";

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

function open(name) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

describe("DrillCard", () => {
  it("offers a restart of an API pod and of the database pod", () => {
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    // One action bar, not a card of its own: no heading, and its children sit beside the buttons
    expect(screen.queryByRole("heading", { name: "Restart a pod" })).toBeNull();
    expect(screen.getByRole("group", { name: "Operations actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart an API pod" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart the database pod" })).toBeTruthy();
  });

  it("asks first: the dialog says what will happen, Cancel has the focus, and nothing is sent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);

    const dialog = open("Restart an API pod");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText(/Kubernetes will start a new one/)).toBeTruthy();
    expect(within(dialog).getByText(/Users are not affected/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns that the app pauses for the database drill, and that the data stays", () => {
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    const dialog = open("Restart the database pod");
    expect(within(dialog).getByText(/pauses for about 30 seconds/)).toBeTruthy();
    expect(within(dialog).getByText(/Data stays on its volume/)).toBeTruthy();
  });

  it("Cancel and Escape close the dialog without a request", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);

    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open("Restart an API pod");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirming sends POST /api/v1/ops/drills with the target and the token, then says what Kubernetes is doing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      respond(200, {
        target: "api",
        pod: "api-old",
        startedAt: "2026-11-21T19:40:00.000Z",
        nextAllowedAt: "2026-11-21T19:41:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const started = vi.fn();
    render(<DrillCard token="t0k" nextAllowedAt={null} onStarted={started} />);

    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));

    expect(await screen.findByText(/Kubernetes is stopping pod api-old/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/ops/drills");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ target: "api" });
    expect(init.headers.Authorization).toBe("Bearer t0k");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("sends target postgres for the database pod", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      respond(200, {
        target: "postgres",
        pod: "postgres-0",
        startedAt: "t",
        nextAllowedAt: "t2",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    fireEvent.click(
      within(open("Restart the database pod")).getByRole("button", { name: "Restart" }),
    );
    await screen.findByText(/stopping pod postgres-0/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ target: "postgres" });
  });

  it.each([
    [429, "One drill a minute: try again shortly", /One drill a minute/],
    [409, "A drill needs two ready API pods", /needs two ready API pods/],
    [403, "Drills are switched off in this cluster", /switched off/],
    [502, "Kubernetes did not accept the drill", /did not accept/],
  ])(
    "shows the refusal for a %s in the server's words, and keeps the page",
    async (status, error, pattern) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(status, { error, code: "X" })));
      const started = vi.fn();
      render(<DrillCard token="t" nextAllowedAt={null} onStarted={started} />);
      fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(pattern);
      expect(started).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Restart an API pod" })).toBeTruthy();
    },
  );

  it("shows a plain message when the request cannot be sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Something went wrong/);
  });

  it("disables both buttons and counts down while the next drill is not allowed yet", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.parse("2026-11-21T19:40:00Z"));
    render(<DrillCard token="t" nextAllowedAt="2026-11-21T19:40:42.000Z" onStarted={() => {}} />);
    expect(screen.getByRole("button", { name: "Restart an API pod" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Restart the database pod" }).disabled).toBe(true);
    expect(screen.getByText("Next drill allowed in 42 s")).toBeTruthy();
  });

  it("does not send twice when Restart is pressed twice", async () => {
    let release;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(respond(200, { target: "api", pod: "p", startedAt: "t", nextAllowedAt: "t2" }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    const confirm = within(open("Restart an API pod")).getByRole("button", { name: "Restart" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape closes the dialog even when focus has left it", () => {
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    open("Restart an API pod");
    screen.getByRole("button", { name: "Restart the database pod" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the open dialog, from Restart to Cancel and back", () => {
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    const dialog = open("Restart an API pod");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const restart = within(dialog).getByRole("button", { name: "Restart" });
    restart.focus();
    fireEvent.keyDown(restart, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(restart);
  });

  it("puts the focus back on the button that opened the dialog after Cancel", () => {
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    const opener = screen.getByRole("button", { name: "Restart the database pod" });
    fireEvent.click(opener);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
  });

  it("moves the focus to the result message after a drill, since the buttons are then disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond(200, {
          target: "api",
          pod: "api-old",
          startedAt: "2026-11-21T19:40:00.000Z",
          nextAllowedAt: "2026-11-21T19:41:00.000Z",
        }),
      ),
    );
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));
    const status = await screen.findByRole("status");
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("asks to sign in again on a 401, and gives a plain sentence for a proxy's HTML error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(401, { error: "Unauthorized", code: "UNAUTHORIZED" })),
    );
    const { unmount } = render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your session has ended. Sign out and sign in again.",
    );
    unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);
    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The server did not answer. Try again.",
    );
  });

  it("a drill that started is not reported as refused when the refresh callback throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond(200, {
          target: "api",
          pod: "api-old",
          startedAt: "2026-11-21T19:40:00.000Z",
          nextAllowedAt: "2026-11-21T19:41:00.000Z",
        }),
      ),
    );
    render(
      <DrillCard
        token="t"
        nextAllowedAt={null}
        onStarted={() => {
          throw new Error("boom");
        }}
      />,
    );
    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));
    expect(await screen.findByText(/stopping pod api-old/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a next-drill time it cannot read, keeping the one the snapshot gave", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.parse("2026-11-21T19:40:00Z"));
    const { rerender } = render(
      <DrillCard token="t" nextAllowedAt="garbage" onStarted={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Restart an API pod" }).disabled).toBe(false);
    rerender(<DrillCard token="t" nextAllowedAt="2026-11-21T19:40:30.000Z" onStarted={() => {}} />);
    expect(screen.getByText("Next drill allowed in 30 s")).toBeTruthy();
  });

  it("is enabled for a time already past, and enables again when the countdown reaches zero", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.parse("2026-11-21T19:40:00Z"));
    render(<DrillCard token="t" nextAllowedAt="2026-11-21T19:00:00.000Z" onStarted={() => {}} />);
    expect(screen.getByRole("button", { name: "Restart an API pod" }).disabled).toBe(false);

    render(<DrillCard token="t" nextAllowedAt="2026-11-21T19:40:03.000Z" onStarted={() => {}} />);
    const disabled = screen.getAllByRole("button", { name: "Restart an API pod" })[1];
    expect(disabled.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(disabled.disabled).toBe(false);
    expect(screen.queryByText(/Next drill allowed/)).toBeNull();
  });

  it("a Cancel during a request that then fails does not steal the focus from a later success's message", async () => {
    let rejectFirst;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = () => reject(new TypeError("Failed to fetch"));
          }),
      )
      .mockResolvedValue(
        respond(200, {
          target: "api",
          pod: "api-old",
          startedAt: "2026-11-21T19:40:00.000Z",
          nextAllowedAt: "2026-11-21T19:40:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<DrillCard token="t" nextAllowedAt={null} onStarted={() => {}} />);

    const dialog = open("Restart an API pod");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await act(async () => {
      rejectFirst();
    });
    await screen.findByRole("alert");

    fireEvent.click(within(open("Restart an API pod")).getByRole("button", { name: "Restart" }));
    const status = await screen.findByRole("status");
    await waitFor(() => expect(document.activeElement).toBe(status));
  });
});

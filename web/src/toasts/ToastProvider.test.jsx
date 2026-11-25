// The toast list: at most three, auto-dismiss, one polite live region, same text renews (D40, #192).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToasts } from "./ToastProvider.jsx";

let api;
function Grab() {
  api = useToasts();
  return null;
}

function mount() {
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );
}

const region = () => screen.getByRole("region", { name: "Notifications" });
const notify = (toast) => act(() => api.notify(toast));
const tick = (ms) => act(() => vi.advanceTimersByTime(ms));
const texts = () =>
  within(region())
    .queryAllByRole("listitem")
    .map((li) => li.textContent);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ToastProvider", () => {
  it("has a polite live region from the start, so a first toast is announced", () => {
    mount();
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(texts()).toEqual([]);
  });

  it("shows a toast with its text and a Dismiss button", () => {
    mount();
    notify({ kind: "success", text: "report.pdf uploaded." });
    expect(texts()[0]).toContain("report.pdf uploaded.");
    expect(within(region()).getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("marks the kind, so an error looks and reads different from a success", () => {
    mount();
    notify({ kind: "error", text: "Upload failed." });
    expect(within(region()).getByText("Upload failed.").closest("li").dataset.kind).toBe("error");
  });

  it("shows at most three and drops the oldest when a fourth arrives", () => {
    mount();
    for (const text of ["one", "two", "three", "four"]) notify({ kind: "info", text });
    expect(texts().map((t) => t.replace(/Dismiss.*/, ""))).toEqual(["two", "three", "four"]);
  });

  it("goes away by itself after 5 seconds, 8 for an error", () => {
    mount();
    notify({ kind: "success", text: "fine" });
    notify({ kind: "error", text: "broken" });

    tick(4999);
    expect(texts().length).toBe(2);
    tick(1);
    expect(texts().length).toBe(1);
    tick(2999);
    expect(texts().length).toBe(1);
    tick(1);
    expect(texts().length).toBe(0);
  });

  it("does not stack the same text: it stays one toast and its timer starts again", () => {
    mount();
    notify({ kind: "info", text: "Live updates lost." });
    tick(4000);
    notify({ kind: "info", text: "Live updates lost." });
    expect(texts().length).toBe(1);

    tick(4000);
    expect(texts().length).toBe(1);
    tick(1000);
    expect(texts().length).toBe(0);
  });

  it("removes a toast when Dismiss is pressed, and only that one", () => {
    mount();
    notify({ kind: "info", text: "first" });
    notify({ kind: "info", text: "second" });

    const first = within(region()).getByText("first").closest("li");
    fireEvent.click(within(first).getByRole("button", { name: /dismiss/i }));

    expect(within(region()).queryByText("first")).toBeNull();
    expect(within(region()).getByText("second")).toBeTruthy();
  });

  it("does nothing, and does not throw, where no provider is mounted", () => {
    function Alone() {
      const { notify: send } = useToasts();
      send({ kind: "info", text: "nobody hears this" });
      return <p>ok</p>;
    }
    render(<Alone />);
    expect(screen.getByText("ok")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("keeps the same notify function between renders, so effects that use it do not rerun", () => {
    mount();
    const first = api.notify;
    notify({ kind: "info", text: "a" });
    expect(api.notify).toBe(first);
  });

  it("clears its timers when it unmounts", () => {
    const view = render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    notify({ kind: "info", text: "bye" });
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

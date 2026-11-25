// The serverless function card of the Operations page (D39): last invocations, each outcome a word as well as a shape.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import FunctionCard from "./FunctionCard.jsx";

const call = (over = {}) => ({
  at: "2026-11-25T15:04:05.000Z",
  outcome: "function",
  ms: 118,
  computeMs: 3.5,
  inputBytes: 2048,
  reason: null,
  ...over,
});

const region = () => within(screen.getByRole("region", { name: "Serverless function" }));

describe("FunctionCard", () => {
  it("lists the invocations with outcome, times and size", () => {
    const data = { functions: { configured: true, invocations: [call()] } };
    render(<FunctionCard data={data} />);
    const row = region().getByRole("row", { name: /15:04:05/ });
    expect(within(row).getByText("function")).toBeTruthy();
    expect(within(row).getByText("118 ms")).toBeTruthy();
    expect(within(row).getByText("3.5 ms")).toBeTruthy();
    expect(within(row).getByText("2.0 KB")).toBeTruthy();
  });

  it("names the reason of a fallback, in words", () => {
    const data = {
      functions: {
        configured: true,
        invocations: [call({ outcome: "fallback", computeMs: null, reason: "timeout" })],
      },
    };
    render(<FunctionCard data={data} />);
    expect(region().getByText("fallback")).toBeTruthy();
    expect(region().getByText("timeout")).toBeTruthy();
  });

  it("summarises how many of the last calls the function answered", () => {
    const data = {
      functions: {
        configured: true,
        invocations: [call(), call(), call({ outcome: "fallback", reason: "status 502" })],
      },
    };
    render(<FunctionCard data={data} />);
    expect(
      region().getByText("Last 3 comparisons: 2 by the function, 1 by the fallback"),
    ).toBeTruthy();
  });

  it("says so when no comparison has called the function yet", () => {
    render(<FunctionCard data={{ functions: { configured: true, invocations: [] } }} />);
    expect(region().getByText(/No comparison has called the function yet/)).toBeTruthy();
  });

  it("says no function is configured where there is none", () => {
    render(<FunctionCard data={{ functions: { configured: false, invocations: [] } }} />);
    expect(region().getByText(/No function is configured/)).toBeTruthy();
  });

  it("says why when the list could not be read", () => {
    render(<FunctionCard data={{ functions: null, errors: { functions: "unavailable" } }} />);
    expect(region().getByText(/Not available: unavailable/)).toBeTruthy();
  });

  it("says no data when the source is left out", () => {
    render(<FunctionCard data={{ functions: null, errors: {} }} />);
    expect(region().getByText(/Not available: no data/)).toBeTruthy();
  });

  it("renders a reason as text, never as markup", () => {
    const data = {
      functions: {
        configured: true,
        invocations: [call({ outcome: "fallback", reason: "<img src=x onerror=alert(1)>" })],
      },
    };
    const { container } = render(<FunctionCard data={data} />);
    expect(container.querySelector("img")).toBeNull();
  });
});

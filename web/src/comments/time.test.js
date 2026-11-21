// Tests for the time of a comment: the clock to the minute ("4:52 PM, 21 Nov") and the relative time ("2 min ago").
import { describe, expect, it } from "vitest";
import { formatClock, relativeTime } from "./time.js";

describe("formatClock", () => {
  it("shows the time to the minute and the day, like 4:52 PM, 21 Nov", () => {
    expect(formatClock("2026-11-21T21:52:00.000Z", "America/Toronto")).toBe("4:52 PM, 21 Nov");
    expect(formatClock("2026-11-21T21:52:00.000Z", "UTC")).toBe("9:52 PM, 21 Nov");
  });

  it("uses 12 AM and 12 PM at midnight and noon, and no leading zero on the hour", () => {
    expect(formatClock("2026-11-21T00:05:00.000Z", "UTC")).toBe("12:05 AM, 21 Nov");
    expect(formatClock("2026-11-21T12:00:00.000Z", "UTC")).toBe("12:00 PM, 21 Nov");
    expect(formatClock("2026-11-21T09:07:00.000Z", "UTC")).toBe("9:07 AM, 21 Nov");
  });

  it("gives each comment its own time: two minutes apart show two different clocks", () => {
    expect(formatClock("2026-11-21T21:52:10.000Z", "UTC")).not.toBe(
      formatClock("2026-11-21T21:54:10.000Z", "UTC"),
    );
  });

  it("returns an empty string for a value that is not a time", () => {
    expect(formatClock("not a date", "UTC")).toBe("");
    expect(formatClock(undefined, "UTC")).toBe("");
  });
});

describe("relativeTime", () => {
  const at = (iso) => new Date(iso);
  const now = at("2026-11-21T22:00:00.000Z");

  it("says just now under a minute, including a time slightly in the future (clock skew)", () => {
    expect(relativeTime("2026-11-21T21:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-11-21T22:00:05.000Z", now)).toBe("just now");
  });

  it("counts minutes up to 59, hours up to 23, then days", () => {
    expect(relativeTime("2026-11-21T21:59:00.000Z", now)).toBe("1 min ago");
    expect(relativeTime("2026-11-21T21:58:00.000Z", now)).toBe("2 min ago");
    expect(relativeTime("2026-11-21T21:01:00.000Z", now)).toBe("59 min ago");
    expect(relativeTime("2026-11-21T21:00:00.000Z", now)).toBe("1 h ago");
    expect(relativeTime("2026-11-20T23:00:00.000Z", now)).toBe("23 h ago");
    expect(relativeTime("2026-11-20T22:00:00.000Z", now)).toBe("1 d ago");
    expect(relativeTime("2026-11-18T22:00:00.000Z", now)).toBe("3 d ago");
  });

  it("returns an empty string for a value that is not a time", () => {
    expect(relativeTime("nope", now)).toBe("");
  });
});

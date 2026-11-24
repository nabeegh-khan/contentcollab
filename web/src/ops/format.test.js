// Tests for the words and shapes of the operations page (D31): every state is a word plus a shape.
import { describe, expect, it } from "vitest";
import {
  agoText,
  ageText,
  cpuLine,
  cpuNowLine,
  eventSentence,
  latencyText,
  rangeLine,
  statusView,
} from "./format.js";

describe("statusView", () => {
  it("pairs each state with a word and a different shape, so colour is never the only signal", () => {
    const states = ["Running", "Starting", "Stopping", "Restarting", "Failed", "Unknown"];
    const views = states.map((s) => statusView(s));
    expect(views.map((v) => v.label)).toEqual(states);
    expect(new Set(views.map((v) => v.shape)).size).toBeGreaterThanOrEqual(4);
    expect(statusView("Running").shape).toBe("●");
    expect(statusView("Starting").shape).toBe("◐");
    expect(statusView("Stopping").shape).toBe("↻");
    expect(statusView("Failed").shape).toBe("✖");
  });

  it("treats a state it does not know as unknown, with its own word", () => {
    expect(statusView("Weird")).toEqual({ label: "Unknown", shape: "?" });
  });
});

describe("ageText", () => {
  it("writes seconds, minutes and hours in plain words", () => {
    expect(ageText(45)).toBe("45 s");
    expect(ageText(1000)).toBe("16 min");
    expect(ageText(7500)).toBe("2 h 5 min");
    expect(ageText(null)).toBe("unknown");
  });
});

describe("agoText", () => {
  it("says how long ago, in seconds, then minutes", () => {
    expect(agoText(3000)).toBe("3 s ago");
    expect(agoText(0)).toBe("just now");
    expect(agoText(125000)).toBe("2 min ago");
  });
});

describe("cpuLine", () => {
  const hpa = { cpuPercent: 12, cpuTargetPercent: 70 };
  it("states the CPU and where the autoscaler starts", () => {
    expect(cpuLine(hpa)).toBe("CPU 12% (scales out above 70%)");
  });
  it("warns in words when CPU is above the target", () => {
    expect(cpuLine({ cpuPercent: 79, cpuTargetPercent: 70 })).toBe(
      "CPU 79%: above the 70% target, the autoscaler is adding copies",
    );
  });
  it("leaves the target out when the HPA gives none, never printing null", () => {
    expect(cpuLine({ cpuPercent: 12, cpuTargetPercent: null })).toBe("CPU 12%");
  });
  it("says the reading is not there yet instead of a number", () => {
    expect(cpuLine({ cpuPercent: null, cpuTargetPercent: 70 })).toBe("CPU not read yet");
  });
});

describe("latencyText", () => {
  it("writes the slowest 5% in milliseconds, or seconds when long", () => {
    expect(latencyText(0.012)).toBe("Slowest 5% took under 12 ms");
    expect(latencyText(1.5)).toBe("Slowest 5% took under 1.5 s");
    expect(latencyText(null)).toBe("no requests in the last minute");
  });
  it("says over 5 s when Prometheus can only give the top bucket's bound", () => {
    expect(latencyText(5)).toBe("Slowest 5% took over 5 s");
  });
});

describe("eventSentence", () => {
  const event = (reason, extra = {}) => ({
    reason,
    object: "Pod/api-a",
    text: "New size: 3; reason: cpu resource utilization (percentage of request) above target",
    ...extra,
  });
  it("turns Kubernetes reasons into sentences an audience can read", () => {
    expect(eventSentence(event("Started"))).toBe("Kubernetes started a new pod (api-a)");
    expect(eventSentence(event("Killing"))).toBe("Kubernetes stopped a pod (api-a)");
    expect(eventSentence(event("Scheduled"))).toBe("Kubernetes placed a pod on a node (api-a)");
    expect(
      eventSentence(event("SuccessfulRescale", { object: "HorizontalPodAutoscaler/api" })),
    ).toBe("The autoscaler changed the API to 3 pods");
  });
  it("falls back to the object and the note for a reason it has no sentence for", () => {
    expect(eventSentence(event("BackOff", { text: "Back-off restarting" }))).toBe(
      "Pod/api-a: Back-off restarting",
    );
  });
});

describe("rangeLine", () => {
  it("gives the autoscaler's range and its CPU trigger as one sub-line", () => {
    expect(rangeLine({ minReplicas: 2, maxReplicas: 5, cpuTargetPercent: 70 })).toBe(
      "autoscaler range 2 to 5, scales out above 70% CPU",
    );
  });
  it("leaves the trigger out when the HPA gives none, never printing null", () => {
    expect(rangeLine({ minReplicas: 2, maxReplicas: 5, cpuTargetPercent: null })).toBe(
      "autoscaler range 2 to 5",
    );
  });
});

describe("cpuNowLine", () => {
  it("states the CPU now", () => {
    expect(cpuNowLine({ cpuPercent: 12, cpuTargetPercent: 70 })).toBe("CPU now: 12%");
  });
  it("warns in words when CPU is above the target", () => {
    expect(cpuNowLine({ cpuPercent: 79, cpuTargetPercent: 70 })).toBe(
      "CPU 79%: above the 70% target, the autoscaler is adding copies",
    );
  });
  it("says the reading is not there yet instead of a number", () => {
    expect(cpuNowLine({ cpuPercent: null, cpuTargetPercent: 70 })).toBe("CPU not read yet");
  });
});

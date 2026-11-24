// Checks on app.css for the demo polish of 24 Nov: jsdom does not apply a stylesheet, so the rules are read as text.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.css"), "utf8");

// The declarations of the last rule whose selector list contains `selector`
function declarationsOf(selector) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, list]) =>
    list
      .split(",")
      .map((s) => s.trim())
      .includes(selector),
  );
  expect(rules.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return Object.fromEntries(
    rules
      .flatMap(([, , body]) => body.split(";"))
      .map((d) => d.split(/:(.*)/s).map((x) => x?.trim()))
      .filter(([name, value]) => name && value),
  );
}

describe("app.css", () => {
  it("styles a select like the text inputs: one shared rule, same height, border, padding, font and width", () => {
    const input = declarationsOf(".field input");
    const select = declarationsOf(".field select");
    for (const name of [
      "width",
      "min-height",
      "padding",
      "border",
      "border-radius",
      "font-size",
      "background",
      "color",
    ]) {
      expect(select[name], name).toBe(input[name]);
    }
  });

  it("keeps the headline numbers at one card-heading size, not 48 px", () => {
    const size = Number.parseInt(declarationsOf(".ops-big")["font-size"], 10);
    expect(size).toBeGreaterThanOrEqual(24);
    expect(size).toBeLessThanOrEqual(32);
    expect(css).not.toMatch(/\.ops-big[^}]*font-size:\s*48px/);
  });

  it("does not put a scroll box on every list of an operations card", () => {
    expect(() => declarationsOf(".ops-card ul")).toThrow(/no rule/);
  });

  it("shows a success message as a visible status line, not small grey text", () => {
    const success = declarationsOf(".success");
    expect(success["border"] ?? success["border-left"]).toBeTruthy();
    expect(success["font-weight"]).toBe("600");
    expect(success["font-size"] ?? "1rem").not.toMatch(/0\.[0-8]/);
  });
});

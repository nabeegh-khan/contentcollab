// The dashboard theme for the demo: a light grey page, white cards, one blue accent, and type sized for a lecture room (D28).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name) => readFileSync(join(import.meta.dirname, name), "utf8");
const indexCss = read("index.css");
const appCss = read("app.css");

// The declaration block of the rule whose selector is exactly `selector`; it must follow the end of a rule or a comment,
// so the last line of a grouped selector does not match
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\}|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : null;
}

// A length such as 1.8rem or 1200px, in px at the 20px root
const toPx = (value) => (value.endsWith("rem") ? parseFloat(value) * 20 : parseFloat(value));
const remOf = (css, selector, property) =>
  parseFloat(new RegExp(`${property}:\\s*([\\d.]+)rem`).exec(rule(css, selector) ?? "")?.[1]);

describe("type and layout for a lecture room", () => {
  it("sets the root type to 20px", () => {
    expect(indexCss).toMatch(/font:\s*20px\//);
  });

  it("does not shrink the root type for any screen wider than a phone", () => {
    const queries = [
      ...indexCss.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{\s*font-size:\s*(\d+)px/g),
    ];
    for (const [, width, size] of queries) {
      expect(Number(width)).toBeLessThanOrEqual(700);
      expect(Number(size)).toBeGreaterThanOrEqual(16);
    }
  });

  it("sizes page titles at 36px, card titles at 28px", () => {
    expect(remOf(appCss, ".card h1", "font-size")).toBeCloseTo(1.8, 5);
    expect(remOf(appCss, ".card h2", "font-size")).toBeCloseTo(1.8, 5);
    expect(remOf(appCss, ".card h3", "font-size")).toBeCloseTo(1.4, 5);
  });

  it("makes inputs and buttons 52px tall (2.6rem)", () => {
    expect(remOf(appCss, ".field input,\n.field textarea", "min-height")).toBeGreaterThanOrEqual(
      2.6,
    );
    expect(remOf(appCss, "button", "min-height")).toBeGreaterThanOrEqual(2.6);
  });

  it("sets the comment body at 22px (1.1rem)", () => {
    expect(remOf(appCss, ".comment-body", "font-size")).toBeCloseTo(1.1, 5);
  });

  it("sizes no text in app.css with a fixed pixel value below the root", () => {
    const sizes = [...appCss.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(20);
  });

  it("centres the content in a column of at most 1200px", () => {
    const main = rule(appCss, "main");
    expect(toPx(/max-width:\s*([\d.]+(?:rem|px))/.exec(main)[1])).toBe(1200);
    expect(main).toMatch(/margin:\s*0 auto/);
  });

  it("gives the sign-in card 40% of the width, centred, between 28rem and 48rem", () => {
    const auth = rule(appCss, ".card.auth");
    expect(auth).toMatch(/width:\s*40vw/);
    expect(auth).toMatch(/min-width:\s*28rem/);
    expect(auth).toMatch(/max-width:\s*48rem/);
    expect(auth).toMatch(/margin:\s*[^;]*auto/);
  });

  it("lets the document and comment cards use the whole column", () => {
    const wide = rule(appCss, ".card.comments,\n.card.wide");
    expect(wide).toMatch(/max-width:\s*none|max-width:\s*100%/);
  });
});

// ---- the palette (WCAG 2.x contrast ratios)
const variable = (name) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(indexCss)?.[1];
const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("the dashboard palette", () => {
  it("uses the specified colours", () => {
    expect(variable("bg").toLowerCase()).toBe("#f4f5f7");
    expect(variable("card").toLowerCase()).toBe("#ffffff");
    expect(variable("border").toLowerCase()).toBe("#d0d5dd");
    expect(variable("text-h").toLowerCase()).toBe("#111827");
    expect(variable("text").toLowerCase()).toBe("#111827");
    expect(variable("text-2").toLowerCase()).toBe("#374151");
    expect(variable("primary").toLowerCase()).toBe("#1d4ed8");
  });

  it("is light only: no dark rule, no toggle, a light colour scheme", () => {
    expect(indexCss).not.toMatch(/prefers-color-scheme:\s*dark|data-theme/);
    expect(appCss).not.toMatch(/prefers-color-scheme|data-theme|dark/i);
    expect(indexCss).toMatch(/color-scheme:\s*light\b(?!\s+dark)/);
  });

  it("paints the page grey and the cards white with a 1px border and a soft shadow", () => {
    expect(rule(indexCss, "body")).toMatch(/background:\s*var\(--bg\)/);
    const card = rule(appCss, ".card");
    expect(card).toMatch(/background:\s*var\(--card\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(card).toMatch(/box-shadow:/);
  });

  it("keeps every text colour at 7:1 or better on the page grey and on the white card", () => {
    for (const text of ["text-h", "text", "text-2"]) {
      expect(contrast(variable(text), variable("bg"))).toBeGreaterThanOrEqual(7);
      expect(contrast(variable(text), variable("card"))).toBeGreaterThanOrEqual(7);
    }
  });

  it("makes the primary button solid blue with white text, at least 4.5:1 (AA)", () => {
    const rules = rule(appCss, 'button[type="submit"],\nbutton.primary');
    expect(rules).toMatch(/background:\s*var\(--primary\)/);
    expect(rules).toMatch(/color:\s*#fff/);
    expect(contrast("#ffffff", variable("primary"))).toBeGreaterThanOrEqual(4.5);
  });

  it("uses no text colour outside the palette, and never a lighter grey for secondary text", () => {
    const colours = [...appCss.matchAll(/(?<![-\w])color:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const colour of colours) {
      expect(colour).toMatch(/^(var\(--(?:text-h|text|text-2|primary|danger)\)|#fff|inherit)$/);
    }
    expect(rule(appCss, ".comment-meta")).toMatch(/color:\s*var\(--text-2\)/);
  });

  it("draws a 3px focus ring at least 3:1 against both the page and the card", () => {
    expect(rule(appCss, ":focus-visible")).toMatch(/outline:\s*3px solid var\(--focus\)/);
    expect(contrast(variable("focus"), variable("bg"))).toBeGreaterThanOrEqual(3);
    expect(contrast(variable("focus"), variable("card"))).toBeGreaterThanOrEqual(3);
  });

  it("keeps field edges visible: the input border against the card is at least 3:1", () => {
    expect(rule(appCss, ".field input,\n.field textarea")).toMatch(
      /border:\s*2px solid var\(--text-2\)/,
    );
    expect(contrast(variable("text-2"), variable("card"))).toBeGreaterThanOrEqual(3);
  });

  it("keeps disabled controls at full contrast and links in the accent", () => {
    expect(rule(appCss, "button:disabled")).not.toMatch(/opacity/);
    expect(rule(appCss, "a")).toMatch(/color:\s*var\(--primary\)/);
  });
});

// The base type is sized for a lecture room at Chrome's 100% zoom, and the layout is wide enough to use it (D28).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name) => readFileSync(join(import.meta.dirname, name), "utf8");
const indexCss = read("index.css");
const appCss = read("app.css");

// The declaration block of the first rule whose selector is exactly `selector`
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Preceded by the end of the previous rule (or a comment), so the last line of a grouped selector does not match
  const match = new RegExp(`(?:^|\\}|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : null;
}

// A length such as 40rem or 640px, in px at a 20px root
const toPx = (value) => (value.endsWith("rem") ? parseFloat(value) * 20 : parseFloat(value));

describe("presentation size", () => {
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
    expect(indexCss).not.toMatch(/max-width:\s*1024px\)\s*\{\s*font-size/);
  });

  it("sizes no text in app.css below the root with a fixed pixel value", () => {
    const sizes = [...appCss.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(20);
  });

  it("scales labels, inputs and buttons with the root (rem, not px)", () => {
    expect(rule(appCss, ".field")).not.toMatch(/font-size:\s*\d+px/);
    expect(rule(appCss, ".field input,\n.field textarea")).toMatch(/font-size:\s*1rem/);
    expect(rule(appCss, "button")).toMatch(/font:\s*inherit/);
  });

  it("keeps the comment text at the root size or larger", () => {
    const body = rule(appCss, ".comment-body");
    expect(body === null || !/font-size:\s*0\./.test(body)).toBe(true);
    const meta = rule(appCss, ".comment-meta");
    expect(meta).toMatch(/font-size:\s*0\.9\d*(?:em|rem)/); // 18px, a caption beside 20px text
  });

  it("widens the page: cards for sign-in are 30rem or more, document and comment cards 60rem or more", () => {
    const card = rule(appCss, ".card");
    expect(toPx(/max-width:\s*([\d.]+(?:rem|px))/.exec(card)[1])).toBeGreaterThanOrEqual(30 * 20);
    const wide = rule(appCss, ".card.comments,\n.card.wide");
    expect(toPx(/max-width:\s*([\d.]+(?:rem|px))/.exec(wide)[1])).toBeGreaterThanOrEqual(60 * 20);
  });

  it("lets the wide card fit a 1366px screen at 20px type (the main column is at least 64rem)", () => {
    const main = rule(appCss, "main");
    expect(toPx(/max-width:\s*([\d.]+(?:rem|px))/.exec(main)[1])).toBeGreaterThanOrEqual(64 * 20);
  });

  it("centres the sign-in card at 40% of the screen width, never narrower than 28rem or wider than 48rem", () => {
    const auth = rule(appCss, ".card.auth");
    expect(auth).toMatch(/width:\s*40vw/);
    expect(auth).toMatch(/min-width:\s*28rem/);
    expect(auth).toMatch(/max-width:\s*48rem/);
    expect(auth).toMatch(/margin:\s*[^;]*auto/);
  });
});

// ---- the light, high-contrast theme for a projector (WCAG 2.x contrast ratios)
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

describe("light high-contrast theme", () => {
  it("is light only: no dark-mode block and a light colour scheme", () => {
    expect(indexCss).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(indexCss).toMatch(/color-scheme:\s*light\b(?!\s+dark)/);
  });

  it("uses a white background and #111111 text, with no grey text colour", () => {
    expect(variable("bg").toLowerCase()).toBe("#ffffff");
    expect(variable("text-h").toLowerCase()).toBe("#111111");
    expect(variable("text").toLowerCase()).toBe("#111111");
    // no rule gives text a grey colour: every `color:` is a variable for the text, the accent or white, or the error red
    const colours = [...appCss.matchAll(/(?<![-\w])color:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const colour of colours) {
      expect(colour).toMatch(/^(var\(--(?:text-h|text|primary|danger)\)|#fff|inherit)$/);
    }
  });

  it("makes headings 32px or larger (1.6rem at the 20px root)", () => {
    const sizes = (selector) =>
      parseFloat(/font-size:\s*([\d.]+)rem/.exec(rule(appCss, selector))?.[1]);
    expect(sizes(".card h1")).toBeGreaterThanOrEqual(1.6);
    expect(sizes(".card h2")).toBeGreaterThanOrEqual(1.6);
    expect(sizes(".card h3")).toBeGreaterThanOrEqual(1.6);
    expect(indexCss).toMatch(/h2\s*\{[^}]*font-size:\s*2rem/);
  });

  it("makes inputs and buttons 48px tall (2.4rem at the 20px root)", () => {
    const min = (css, selector) =>
      parseFloat(/min-height:\s*([\d.]+)rem/.exec(rule(css, selector))?.[1]);
    expect(min(appCss, ".field input,\n.field textarea")).toBeGreaterThanOrEqual(2.4);
    expect(min(appCss, "button")).toBeGreaterThanOrEqual(2.4);
  });

  it("keeps disabled controls and links at full contrast: no opacity, links in the accent", () => {
    expect(rule(appCss, "button:disabled")).not.toMatch(/opacity/);
    expect(rule(appCss, "a")).toMatch(/color:\s*var\(--primary\)/);
  });

  it("has no theme toggle and no dark-mode rule anywhere in the styles", () => {
    expect(appCss).not.toMatch(/prefers-color-scheme|data-theme|dark/i);
    expect(indexCss).not.toMatch(/data-theme|dark(?!er)/i);
  });

  it("gives labels and body text at least 7:1 (AAA), more than AA asks", () => {
    expect(contrast(variable("text-h"), variable("bg"))).toBeGreaterThanOrEqual(7);
    expect(contrast(variable("text"), variable("bg"))).toBeGreaterThanOrEqual(7);
  });

  it("makes the primary button a solid saturated colour with white text, 7:1 or better", () => {
    const rules = rule(appCss, 'button[type="submit"],\nbutton.primary');
    expect(rules).toMatch(/background:\s*var\(--primary\)/);
    expect(rules).toMatch(/color:\s*#fff/);
    expect(contrast("#ffffff", variable("primary"))).toBeGreaterThanOrEqual(7);
  });

  it("draws a focus ring of 3px in a colour at least 3:1 against the background", () => {
    const focus = rule(appCss, ":focus-visible");
    expect(focus).toMatch(/outline:\s*3px solid var\(--focus\)/);
    expect(contrast(variable("focus"), variable("bg"))).toBeGreaterThanOrEqual(3);
  });

  it("keeps field borders visible (3:1 against the background)", () => {
    expect(contrast(variable("border"), variable("bg"))).toBeGreaterThanOrEqual(3);
  });
});

// The Grafana dashboard inside the Operations page (D37): an iframe with a title for screen readers and a fixed height.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import GrafanaEmbed from "./GrafanaEmbed.jsx";

const LINK = "https://contentcollab.app/grafana/";
const SRC =
  "https://contentcollab.app/grafana/d/contentcollab/contentcollab?kiosk&theme=light&refresh=15s";

describe("GrafanaEmbed", () => {
  it("renders the dashboard in an iframe with the right address and a title", () => {
    render(<GrafanaEmbed link={LINK} />);
    const frame = screen.getByTitle(
      "ContentCollab Grafana dashboard: request rate, errors, latency and replicas",
    );
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(SRC);
  });

  it("gives the frame a fixed height and loads it only when it scrolls into view", () => {
    render(<GrafanaEmbed link={LINK} />);
    const frame = screen.getByTitle(/ContentCollab Grafana dashboard/);
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.getAttribute("height")).toBe("640");
  });

  it("sits in a region named for the dashboard, with a heading", () => {
    render(<GrafanaEmbed link={LINK} />);
    expect(screen.getByRole("region", { name: "Grafana dashboard" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Grafana dashboard" })).toBeTruthy();
  });

  it("says what the frame shows if Grafana asks for a sign-in", () => {
    render(<GrafanaEmbed link={LINK} />);
    expect(screen.getByText(/sign-in page/i)).toBeTruthy();
  });

  it.each([null, undefined, "", "javascript:alert(1)"])(
    "renders nothing for the link %s",
    (link) => {
      const { container } = render(<GrafanaEmbed link={link} />);
      expect(container.firstChild).toBeNull();
    },
  );
});

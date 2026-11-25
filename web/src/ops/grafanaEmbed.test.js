// The embedded Grafana address is built from the link the API already gives (GRAFANA_URL), so there is one place to change it (D37).
import { describe, expect, it } from "vitest";
import { DASHBOARD_PATH, grafanaEmbedUrl } from "./grafanaEmbed.js";

describe("grafanaEmbedUrl", () => {
  it("opens the ContentCollab dashboard in kiosk mode, light theme, refreshing every 15 seconds", () => {
    expect(grafanaEmbedUrl("https://contentcollab.app/grafana/")).toBe(
      "https://contentcollab.app/grafana/d/contentcollab/contentcollab?kiosk&theme=light&refresh=15s",
    );
  });

  it("keeps the /grafana prefix when the link has no trailing slash", () => {
    expect(grafanaEmbedUrl("https://contentcollab.app/grafana")).toBe(
      "https://contentcollab.app/grafana/d/contentcollab/contentcollab?kiosk&theme=light&refresh=15s",
    );
  });

  it("uses the dashboard uid of k8s/observability/grafana/dashboards/contentcollab.json", () => {
    expect(DASHBOARD_PATH).toBe("d/contentcollab/contentcollab");
  });

  it.each([
    null,
    undefined,
    "",
    "javascript:alert(1)",
    "data:text/html,x",
    "/grafana/",
    "not a url",
  ])("gives no address for %s", (link) => {
    expect(grafanaEmbedUrl(link)).toBeNull();
  });
});

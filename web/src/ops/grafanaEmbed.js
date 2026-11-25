// Where the embedded Grafana dashboard lives, built from the link the API already gives (GRAFANA_URL, D31).
// The uid is the one in k8s/observability/grafana/dashboards/contentcollab.json; the slug after it is cosmetic.
export const DASHBOARD_PATH = "d/contentcollab/contentcollab";

// kiosk hides Grafana's menus, light matches the page, refresh repeats the dashboard's own 15 seconds
const DASHBOARD_QUERY = "?kiosk&theme=light&refresh=15s";

const isWebAddress = (value) => /^https?:\/\//i.test(String(value ?? ""));

// The address of the dashboard for a Grafana link, or null when the link is not a web address
export function grafanaEmbedUrl(link) {
  if (!isWebAddress(link)) return null;
  let base;
  try {
    base = new URL(link);
  } catch {
    return null;
  }
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return `${base.origin}${prefix}${DASHBOARD_PATH}${DASHBOARD_QUERY}`;
}

// The Grafana dashboard inside the Operations page (D37), so the demo never leaves the app.
// Grafana keeps its login: without a session the frame shows Grafana's sign-in page, and the
// "Open Grafana" link in the action bar stays as the way out.
import { grafanaEmbedUrl } from "./grafanaEmbed.js";

const FRAME_TITLE = "ContentCollab Grafana dashboard: request rate, errors, latency and replicas";
const FRAME_HEIGHT = 640;

export default function GrafanaEmbed({ link }) {
  const src = grafanaEmbedUrl(link);
  if (src === null) return null;
  return (
    <section className="ops-card ops-embed" aria-labelledby="ops-grafana-dashboard">
      <h2 id="ops-grafana-dashboard">Grafana dashboard</h2>
      <p className="ops-embed-note">
        Live from Grafana. If this shows Grafana&apos;s sign-in page, sign in once, or use Open
        Grafana above.
      </p>
      <iframe
        className="ops-embed-frame"
        title={FRAME_TITLE}
        src={src}
        height={FRAME_HEIGHT}
        loading="lazy"
      />
    </section>
  );
}

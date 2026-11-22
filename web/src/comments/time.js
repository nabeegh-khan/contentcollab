// The time of a comment: the clock to the minute ("4:52 PM, 21 Nov") and the relative time ("2 min ago").
// `timeZone` is for tests; in the browser it is left out and the viewer's own time zone is used.
export function formatClock(iso, timeZone) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    day: "numeric",
    month: "short",
    timeZone,
  }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type)?.value;
  return `${part("hour")}:${part("minute")} ${part("dayPeriod")}, ${part("day")} ${part("month")}`;
}

export function relativeTime(iso, now = new Date()) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "just now"; // also a time slightly in the future (clock skew)
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

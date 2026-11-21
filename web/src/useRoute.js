// Follows location.hash: the current route (see route.js), updated when the address changes.
import { useEffect, useState } from "react";
import { parseHash } from "./route.js";

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

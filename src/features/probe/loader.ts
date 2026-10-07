import { createServerFn } from "@tanstack/react-start";

export const getProbe = createServerFn({ method: "GET" }).handler(async () => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("cache-control", "no-store");
  const { loadProbeHydration } = await import("../../server/probe/hydration.server");
  return loadProbeHydration();
});

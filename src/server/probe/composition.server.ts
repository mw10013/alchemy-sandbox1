import "@tanstack/react-start/server-only";
import { Effect } from "effect";
import { ProbeService } from "./service.server";

export const ProbeApplication = ProbeService.layer;
export const directRead = ProbeService.use((service) => service.read()).pipe(
  Effect.provide(ProbeApplication),
);
export const readProbeExit = () => Effect.runPromiseExit(directRead);

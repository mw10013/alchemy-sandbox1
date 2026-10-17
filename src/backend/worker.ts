import * as Cloudflare from "alchemy/Cloudflare";
import { backendProps, makeBackend } from "./backend.ts";

/**
 * The private Effect Worker. It has no public URL: the browser reaches it only through the
 * Website, which calls it over the `BACKEND` service binding (browser → Website → Backend).
 * The binding ignores the request's host, so a caller may use any absolute URL. What it serves
 * is {@link makeBackend}'s.
 */
export default class Backend extends Cloudflare.Worker<Backend>()(
  "Backend",
  { ...backendProps, main: import.meta.filename },
  makeBackend(),
) {}

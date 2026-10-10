import * as cf from "cloudflare:workers";
import type { WebsiteEnv } from "../alchemy.run.ts";

// Top-level `import { env } from "cloudflare:workers"` breaks in TanStack Start
// dev, so read through a proxy at call time.
export const env = new Proxy({} as WebsiteEnv, {
  get(_, prop) {
    return cf.env[prop as keyof typeof cf.env];
  },
});

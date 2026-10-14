import type { AnyRouter } from "@tanstack/react-router";
import type { Role } from "../../contract/auth.ts";

/** Each role has its own side of the site. */
export const homeFor = (role: Role) => (role === "admin" ? "/admin" : "/app");

/**
 * Ends the Better Auth session through the Website's auth proxy, then reruns the current
 * route's guards and loaders, which ask the Backend again and now find no session.
 */
export const signOut = async (router: Pick<AnyRouter, "invalidate">): Promise<void> => {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Sign-out failed with status ${response.status}`);
  await router.invalidate();
};

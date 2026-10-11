import { redirect } from "@tanstack/react-router";
import * as Option from "effect/Option";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schema from "effect/Schema";
import { ReturnPath, type Role } from "../api/backend.ts";
import { currentMember } from "../session.ts";

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/** Each role has its own side of the site. */
export const homeFor = (role: Role) => (role === "admin" ? "/admin" : "/app");

/**
 * A `beforeLoad` guard: signed out goes to `/sign-in` and back afterwards; the other role goes
 * to its own {@link homeFor}. The Backend checks every procedure again; this only decides what
 * the Website renders.
 */
export const requireRole =
  (role: Role) =>
  async ({
    context,
    location,
  }: {
    context: { registry: AtomRegistry.AtomRegistry };
    location: { href: string };
  }) => {
    const me = await currentMember(context.registry);
    if (Option.isNone(me))
      throw redirect({
        to: "/sign-in",
        search: { redirect: Option.getOrUndefined(decodeReturnPath(location.href)) },
      });
    if (me.value.role !== role) throw redirect({ to: homeFor(me.value.role) });
    return { me: me.value };
  };

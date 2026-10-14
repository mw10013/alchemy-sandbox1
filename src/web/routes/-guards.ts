import { redirect } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ReturnPath, type Role } from "../../contract/auth.ts";
import { homeFor } from "../client/session.ts";
import { getMe } from "../server/session.ts";

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/**
 * A `beforeLoad` guard: signed out goes to `/sign-in` and back afterwards; the other role goes
 * to its own {@link homeFor}. It asks the Backend on every navigation. The Backend checks the
 * session again in every method; this only decides what the Website renders.
 */
export const requireRole =
  (role: Role) =>
  async ({ location }: { location: { href: string } }) => {
    const me = await getMe();
    if (me === null)
      throw redirect({
        to: "/sign-in",
        search: { redirect: Option.getOrUndefined(decodeReturnPath(location.href)) },
      });
    if (me.role !== role) throw redirect({ to: homeFor(me.role) });
    return { me };
  };

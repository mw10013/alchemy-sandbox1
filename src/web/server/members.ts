import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Forbidden, ReturnPath, Unauthorized } from "../../contract/auth.ts";
import { homeFor } from "../client/session.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

/** The only page that lists members, so where sign-in returns to. */
const MEMBERS_PATH = Option.getOrUndefined(
  Schema.decodeUnknownOption(ReturnPath)("/admin/members"),
);

/**
 * Every shop's members, for an operator. Signed out goes to sign-in and back here afterwards;
 * anyone else, who can only be a `user`, goes to their own home.
 */
export const listMembers = createServerFn({ method: "GET" }).handler(() =>
  backend()
    .listMembers(requestInfo())
    .catch(
      rescue(Schema.Union([Unauthorized, Forbidden]), (failure) =>
        Match.valueTags(failure, {
          Unauthorized: () => {
            throw redirect({ to: "/sign-in", search: { redirect: MEMBERS_PATH } });
          },
          Forbidden: () => {
            throw redirect({ to: homeFor("user") });
          },
        }),
      ),
    ),
);

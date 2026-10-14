import { createServerFn } from "@tanstack/react-start";
import { Unauthorized } from "../../contract/auth.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

/** The signed-in user, or null when signed out. */
export const getMe = createServerFn({ method: "GET" }).handler(() =>
  backend()
    .me(requestInfo())
    .catch(rescue(Unauthorized, () => null)),
);

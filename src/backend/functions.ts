import { createServerFn } from "@tanstack/react-start";
import { toRpcAsync } from "alchemy/Cloudflare/Bridge";
import { env } from "../env.ts";
import type Backend from "./worker.ts";
import type { InvalidInput } from "./worker.ts";

const backend = () => toRpcAsync<Backend>(env.BACKEND);

export const getHello = createServerFn({ method: "GET" }).handler(() => backend().hello());

export const shout = createServerFn({ method: "POST" })
  .validator((data: { input: string }) => data)
  .handler(async ({ data }) => {
    try {
      return { ok: true as const, ...(await backend().shout(data.input)) };
    } catch (error) {
      // Tagged failures cross the binding as plain objects that keep `_tag`.
      if (isInvalidInput(error)) return { ok: false as const, message: error.message };
      throw error;
    }
  });

const isInvalidInput = (error: unknown): error is Pick<InvalidInput, "_tag" | "message"> =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "InvalidInput";

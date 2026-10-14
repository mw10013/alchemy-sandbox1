import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { ShoutInput } from "../../contract/playground.ts";
import { backend, requestInfo } from "./backend.ts";

export const getHello = createServerFn({ method: "GET" }).handler(() =>
  backend().hello(requestInfo()),
);

export const shout = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(ShoutInput))
  .handler(({ data }) => backend().shout(requestInfo(), data));

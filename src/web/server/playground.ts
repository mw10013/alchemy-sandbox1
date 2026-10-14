import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { ShoutText } from "../../contract/playground.ts";
import { backend, requestInfo } from "./backend.ts";

export const getHello = createServerFn({ method: "GET" }).handler(() =>
  backend().hello(requestInfo()),
);

export const shout = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ input: ShoutText })))
  .handler(({ data }) => backend().shout(requestInfo(), data));

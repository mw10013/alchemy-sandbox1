import * as Effect from "effect/Effect";

export interface Health {
  status: "ok";
  message: string;
  timestamp: string;
}

export const getHealth = Effect.sync((): Health => ({
  status: "ok",
  message: "Hello from the Effect backend!",
  timestamp: new Date().toISOString(),
}));

export async function healthResponse() {
  return Response.json(await Effect.runPromise(getHealth), {
    headers: { "Cache-Control": "no-store" },
  });
}

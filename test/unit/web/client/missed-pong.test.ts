import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { closeOutcome, retryPolicy } from "../../../../src/web/client/actor-connection.ts";

/**
 * The shop socket keeps itself alive with no keepalive of Baton's own: Effect's RPC client pings
 * every five seconds and drops a connection that misses a pong, and the browser's retry policy
 * reconnects it. Driven here over an in-memory socket whose first connection never answers, on
 * the test clock.
 *
 * @see refs/effect/packages/effect/src/rpc/RpcClient.ts (`makePinger`, `makeProtocolSocket`)
 */
describe("the shop socket's missed pong", () => {
  it.effect("a socket that stops answering pings is dropped as lost and reconnected", () =>
    Effect.gen(function* () {
      const connects: Array<number> = [];
      const written: Array<string> = [];
      const outcomes: Array<string> = [];
      /** Every connection reads nothing, ever: no pong, no frame. */
      const silent = Socket.make({
        reader: Effect.sync(() => {
          connects.push(connects.length + 1);
          return { pull: Effect.never, upgrade: () => Effect.void };
        }),
        writer: Effect.succeed({
          write: (chunk) =>
            Effect.sync(() => {
              if (typeof chunk === "string") written.push(chunk);
            }),
          writeAll: (chunks) =>
            Effect.sync(() => {
              for (const chunk of chunks) if (typeof chunk === "string") written.push(chunk);
            }),
        }),
      });
      yield* Layer.build(
        Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryPolicy: retryPolicy((error) =>
              Effect.sync(() => {
                outcomes.push(closeOutcome(error, true));
              }),
            ),
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(Layer.succeed(Socket.Socket, silent), RpcSerialization.layerJson),
          ),
        ),
      );
      yield* Effect.yieldNow;
      assert.deepStrictEqual(connects, [1]);

      // The first ping goes out at 5 s; with no pong by the next tick, at 10 s, the read fails.
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(written.some((frame) => frame.includes("Ping")));
      assert.deepStrictEqual(connects, [1]);
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(outcomes, ["lost"]);

      // The retry policy's first delay is 250 ms.
      yield* TestClock.adjust("250 millis");
      assert.deepStrictEqual(connects, [1, 2]);
    }).pipe(Effect.scoped),
  );
});

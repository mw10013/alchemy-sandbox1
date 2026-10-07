import { describe, expect, it, vi } from "vite-plus/test";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { AsyncResult, AtomRegistry, Hydration } from "effect/reactivity";
import { RpcClient, RpcGroup, RpcSerialization } from "effect/rpc";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HydrationBoundary, RegistryContext, useAtomValue } from "@effect/atom-react";
import { readAtom } from "../../features/probe/atoms";
import {
  InvalidProbeInput,
  PROBE_MESSAGE,
  ProbeRpcs,
  ProbeSnapshot,
  ProbeTransform,
  TransformPayload,
} from "../../features/probe/contracts";
import { directRead } from "./composition.server";
import { dehydrateProbe, loadProbeHydration } from "./hydration.server";
import { handleProbeRpc, makeRpcEffect } from "./rpc.server";
import { ProbeService } from "./service.server";

const fixture: ProbeSnapshot = { message: PROBE_MESSAGE, observedAt: "2026-10-07T00:00:00.000Z" };
const transform = (input: string) =>
  ProbeService.use((service) => service.transform({ input })).pipe(
    Effect.provide(ProbeService.layer),
  );

describe("stateless probe", () => {
  it("round trips snapshots, transforms and tagged errors", () => {
    expect(
      Schema.decodeUnknownSync(ProbeSnapshot)(Schema.encodeSync(ProbeSnapshot)(fixture)),
    ).toEqual(fixture);
    const result = { input: " hello ", output: "HELLO" };
    expect(
      Schema.decodeUnknownSync(ProbeTransform)(Schema.encodeSync(ProbeTransform)(result)),
    ).toEqual(result);
    const error = new InvalidProbeInput({ message: "Friendly validation" });
    expect(
      Schema.decodeUnknownSync(InvalidProbeInput)(Schema.encodeSync(InvalidProbeInput)(error)),
    ).toEqual(error);
    expect(() => Schema.decodeUnknownSync(TransformPayload)({ input: 42 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProbeSnapshot)({ ...fixture, observedAt: "bad" }),
    ).toThrow();
  });
  it("uses the Effect clock and never mutates the fixture", async () => {
    const millis = Date.parse(fixture.observedAt);
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
      currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => 0n,
      monotonicTimeNanos: Effect.succeed(0n),
      sleep: () => Effect.void,
    };
    expect(
      await Effect.runPromise(directRead.pipe(Effect.provideService(Clock.Clock, clock))),
    ).toEqual(fixture);
    expect(await Effect.runPromise(transform(" hello "))).toEqual({
      input: " hello ",
      output: "HELLO",
    });
    expect(
      await Effect.runPromise(directRead.pipe(Effect.provideService(Clock.Clock, clock))),
    ).toEqual(fixture);
  });
  it.each(["", "   ", "x".repeat(81)])(
    "returns a typed domain error for invalid input %j",
    async (input) => {
      const result = await Effect.runPromise(transform(input).pipe(Effect.flip));
      expect(result).toBeInstanceOf(InvalidProbeInput);
    },
  );
  it("limits trimmed input, not surrounding whitespace", async () => {
    expect((await Effect.runPromise(transform(`  ${"x".repeat(80)}  `))).output).toHaveLength(80);
  });
  it("direct loader returns only completed JSON hydration without HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const state = await loadProbeHydration();
      expect(state).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("hydrates success and typed failure in independent registries", () => {
    for (const exit of [
      Exit.succeed(fixture),
      Exit.fail(new InvalidProbeInput({ message: "Seeded failure" })),
    ]) {
      const state = dehydrateProbe(exit);
      expect(state).toHaveLength(1);
      const first = AtomRegistry.make();
      const second = AtomRegistry.make();
      try {
        Hydration.hydrate(first, state);
        Hydration.hydrate(second, state);
        expect(first.get(readAtom)._tag).toBe(exit._tag === "Success" ? "Success" : "Failure");
        expect(second.get(readAtom)).toEqual(first.get(readAtom));
        first.dispose();
        expect(second.get(readAtom).waiting).toBe(false);
      } finally {
        first.dispose();
        second.dispose();
      }
    }
  });
  it("renders seeded atoms without executing transport", () => {
    const registry = AtomRegistry.make();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    function Snapshot() {
      const result = useAtomValue(readAtom);
      return createElement(
        "p",
        null,
        AsyncResult.isSuccess(result) ? result.value.observedAt : "not seeded",
      );
    }
    try {
      const html = renderToString(
        createElement(
          RegistryContext.Provider,
          { value: registry },
          createElement(
            HydrationBoundary,
            { state: dehydrateProbe(Exit.succeed(fixture)) },
            createElement(Snapshot),
          ),
        ),
      );
      expect(html).toContain(fixture.observedAt);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
      fetchSpy.mockRestore();
    }
  });
});

function withClient<A, E>(
  run: (
    client: RpcClient.RpcClient.Flat<
      RpcGroup.Rpcs<typeof ProbeRpcs>,
      import("effect/rpc/RpcClientError").RpcClientError
    >,
  ) => Effect.Effect<A, E>,
  handler: (request: Request) => Promise<Response> = handleProbeRpc,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(ProbeRpcs, { flatten: true });
      return yield* run(client);
    }).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({ url: "http://probe.test/api/rpc" }).pipe(
          Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
        const request = new Request(input, init);
        // Native Fetch rejects on abort even if an application handler has not returned yet.
        return new Promise<Response>((resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (request.signal.aborted) {
            abort();
            return;
          }
          request.signal.addEventListener("abort", abort, { once: true });
          handler(request)
            .then(resolve, reject)
            .finally(() => request.signal.removeEventListener("abort", abort));
        });
      }),
    ),
  );
}

describe("real NDJSON RPC client and web adapter (Node)", () => {
  it("cancels an in-flight real client request and finalizes its server scope", async () => {
    const started = Deferred.makeUnsafe<void>();
    const finalized = Deferred.makeUnsafe<void>();
    const application = Layer.succeed(
      ProbeService,
      ProbeService.of({
        read: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        transform: (payload) => transform(payload.input),
      }),
    );
    const handler = HttpEffect.toWebHandler(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(finalized, undefined));
        return yield* makeRpcEffect(application);
      }),
    );
    await Effect.runPromise(
      withClient(
        (client) =>
          Effect.gen(function* () {
            const fiber = yield* client("probe_read", undefined).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            yield* Deferred.await(finalized);
          }),
        handler,
      ),
    );
  });
  it("reads, transforms and transports typed failures across sequential and concurrent requests", async () => {
    const result = await Effect.runPromise(
      withClient((client) =>
        Effect.gen(function* () {
          const read = yield* client("probe_read", undefined);
          const action = yield* client("probe_transform", { input: " hi " });
          const error = yield* client("probe_transform", { input: " " }).pipe(Effect.flip);
          const repeated = yield* Effect.all(
            Array.from({ length: 5 }, () => client("probe_read", undefined)),
            { concurrency: "unbounded" },
          );
          return { read, action, error, repeated };
        }),
      ),
    );
    expect(result.read.message).toBe(PROBE_MESSAGE);
    expect(result.action.output).toBe("HI");
    expect(result.error).toBeInstanceOf(InvalidProbeInput);
    expect(result.repeated.every((read) => read.message === PROBE_MESSAGE)).toBe(true);
  });
  it("rejects malformed wire payload rather than treating it as domain success", async () => {
    const response = await handleProbeRpc(
      new Request("http://probe.test/api/rpc", {
        method: "POST",
        body:
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "probe_transform",
            payload: { input: 42 },
            headers: [],
          }) + "\n",
      }),
    );
    const body = await response.text();
    expect(body).not.toContain('"output"');
    expect(body).not.toContain('"_tag":"InvalidProbeInput"');
    expect(body).toMatch(/Failure|Defect|error/i);
  });
  it.each(["completion", "cancellation"])("finalizes request scope after body %s", async (mode) => {
    const finalized = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<ProbeSnapshot>();
    const finalizer = vi.fn();
    const read = vi
      .fn<() => Effect.Effect<ProbeSnapshot>>()
      .mockImplementationOnce(() => Effect.succeed(fixture))
      .mockImplementation(() => Deferred.await(gate));
    const application = Layer.succeed(
      ProbeService,
      ProbeService.of({ read, transform: (payload) => transform(payload.input) }),
    );
    const handler = HttpEffect.toWebHandler(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(finalizer).pipe(Effect.andThen(Deferred.succeed(finalized, undefined))),
        );
        return yield* makeRpcEffect(application);
      }),
    );
    const body =
      ["1", "2"]
        .map((id) =>
          JSON.stringify({ _tag: "Request", id, tag: "probe_read", payload: null, headers: [] }),
        )
        .join("\n") + "\n";
    const response = await handler(
      new Request("http://probe.test/api/rpc", { method: "POST", body }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(finalizer).not.toHaveBeenCalled();
    if (mode === "completion") {
      Effect.runSync(Deferred.succeed(gate, fixture));
      await response.text();
    } else {
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
    }
    await Effect.runPromise(Deferred.await(finalized));
    expect(finalizer).toHaveBeenCalledTimes(1);
  });
});

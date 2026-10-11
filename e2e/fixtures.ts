import { test as base, expect } from "playwright/test";
import type { Page } from "playwright/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from "effect/rpc";
import { TestControlRpcs } from "../src/api/test-control.ts";
import { e2eToken } from "../playwright.config.ts";

type Run = <A, E>(effect: Effect.Effect<A, E, RpcClient.Protocol>) => Promise<A>;

/** The test-control client, through the Website's proxy route, as the browser would reach the Backend. */
const protocol = (baseURL: string) =>
  RpcClient.layerProtocolHttp({ url: `${baseURL}/api/test-control` }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(FetchHttpClient.layer),
  );

/**
 * Waits for the marker `RootDocument` sets once React has attached its handlers. Needed after
 * every full page load before an interaction; {@link test}'s `goto` does it for navigations.
 */
export const awaitHydration = async (page: Page) => {
  await page.locator("body[data-hydrated]").waitFor();
};

/**
 * `backend` runs an Effect against the test-control procedures and resolves with its value or
 * rejects with the pretty cause; it is the only place the specs touch Effect. It is
 * worker-scoped, so it reads `baseURL` from the project: a worker fixture cannot depend on the
 * test-scoped `baseURL` option.
 */
export const test = base.extend<{ goto: (path: string) => Promise<void> }, { backend: Run }>({
  backend: [
    // Playwright reads a fixture's dependencies from this pattern, so it must be `{}`, not `_`.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (baseURL === undefined) throw new Error("use.baseURL is not set");
      const runtime = ManagedRuntime.make(protocol(baseURL));
      const run: Run = (effect) =>
        runtime.runPromiseExit(effect).then((exit) => {
          if (exit._tag === "Success") return exit.value;
          throw new Error(Cause.pretty(exit.cause));
        });
      await use(run);
      await runtime.dispose();
    },
    { scope: "worker" },
  ],
  /** Navigates and waits for hydration; a click before the marker is lost. */
  goto: async ({ page }, use) => {
    await use(async (path) => {
      await page.goto(path);
      await awaitHydration(page);
    });
  },
});
export { expect };

/** One call against the test-control group with the token header. */
export const control = <A, E>(
  f: (
    client: RpcClient.RpcClient<
      RpcGroup.Rpcs<typeof TestControlRpcs>,
      RpcClientError.RpcClientError
    >,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(TestControlRpcs);
    return yield* f(client).pipe(RpcClient.withHeaders({ "x-e2e-token": e2eToken }));
  }).pipe(Effect.scoped);

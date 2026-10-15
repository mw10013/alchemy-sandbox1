import { test as base, expect } from "playwright/test";
import type { Browser, Page, WebSocket } from "playwright/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EmailFromInput } from "../../src/contract/auth.ts";
import { SANDBOX_SHOP, type ShopKey } from "../../src/contract/shop.ts";
import { E2eEmail, TestControlRpcs } from "../../src/contract/test-control.ts";
import { e2eToken } from "../../playwright.config.ts";

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
 *
 * `signIn` signs a seeded or `@e2e.test` user in on the test's `request` context, without a
 * browser: a link from `IssueMagicLink`, fetched with redirects off so the verify response's
 * session cookie lands in the context.
 */
export const test = base.extend<
  { goto: (path: string) => Promise<void>; signIn: (email: string) => Promise<void> },
  { backend: Run }
>({
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
  signIn: async ({ backend, request }, use) => {
    await use(async (address) => {
      const email = Schema.decodeUnknownSync(EmailFromInput)(address);
      const { link } = await backend(control((c) => c.IssueMagicLink({ email })));
      const verify = await request.get(link, { maxRedirects: 0 });
      expect(verify.status()).toBe(302);
    });
  },
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

/**
 * A member of its own: an `@e2e.test` address added to the sandbox shop through test control
 * and signed in, in a fresh browser context. A test that signs out, is removed or opens several
 * windows uses one, so it never touches the shared member's session or sockets.
 */
export const ownMember = async (browser: Browser, backend: Run, name: string) => {
  const email = Schema.decodeUnknownSync(E2eEmail)(`${name}@e2e.test`);
  await backend(control((c) => c.AddMember({ shop: SANDBOX_SHOP, email }).pipe(Effect.ignore)));
  const { link } = await backend(control((c) => c.IssueMagicLink({ email })));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await awaitHydration(page);
  await page.waitForURL(/\/shop$/);
  return { email, context, page };
};

/** Opens a shop's merchant page with a Shopify session token minted through test control. */
export const merchant = async (page: Page, backend: Run, shop: ShopKey) => {
  const { token } = await backend(control((c) => c.IssueMerchantSessionToken({ shop })));
  await page.goto(`/merchant/${shop}?token=${encodeURIComponent(token)}`);
  await awaitHydration(page);
};

/**
 * Resolves once the next actor socket the page opens has answered a call successfully. The
 * page refetches the count on every connect, and the actor names a socket when it accepts it,
 * so that answer means the actor holds the socket (revocable, displaceable, counted). Start it
 * before the navigation or click that opens the socket, and await it after.
 */
export const nextOpenSocket = (page: Page) =>
  new Promise<void>((resolve) => {
    const onSocket = (socket: WebSocket) => {
      if (!new URL(socket.url()).pathname.startsWith("/api/actor/")) return;
      page.off("websocket", onSocket);
      const onFrame = ({ payload }: { payload: string | Buffer }) => {
        if (typeof payload !== "string" || !payload.includes('"_tag":"Success"')) return;
        socket.off("framereceived", onFrame);
        resolve();
      };
      socket.on("framereceived", onFrame);
    };
    page.on("websocket", onSocket);
  });

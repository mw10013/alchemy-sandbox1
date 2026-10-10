# Plan: Effect RPC between the Website and the Backend, with SSR atoms

Date: 2026-10-10  
Status: ready to implement.  
Background: [research (revision 3)](./start-to-effect-worker-ipc-research.md), decisions D1–D16 and corrections C1–C12. Vocabulary: [glossary](./glossary.md).  
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `@effect/atom-react` `4.0.1`, `@tanstack/react-start` `1.168.60`. Do not bump dependencies.

## Goal

Replace the current server-function + `toRpcAsync` path with Effect RPC over the service binding, one `AtomRpc` client used both during SSR and in the browser, and a router-owned `AtomRegistry` that is dehydrated into the HTML and hydrated in the browser. The visible page stays the same: a "Loader data" section showing the Backend's `Hello` result and a "Mutation" section that calls `Shout`.

## Ground rules for the implementer

- Work directly on `main` (AGENTS.md). **Do not commit and do not push.** The reviewer commits after checking. Pushing `main` deploys staging.
- Verify every API against the installed source in `node_modules/effect/src`, `node_modules/@effect/atom-react/src`, `node_modules/alchemy/src`, and the pinned TanStack sources in `refs/tan-router` and `refs/tan-start`. Every API below was checked there; line references are given where it helps. If something does not match, follow the source and record it in [Deviations and issues](#deviations-and-issues).
- Astryx rules from AGENTS.md apply to `HomePage.tsx`: no raw `<div>`/`<span>` layout, components only, tokens for any style. Run `pnpm exec astryx component <Name>` before using a component you have not seen in the file.
- Imports: Effect modules are imported by subpath (`effect/reactivity/AtomRpc`, `effect/rpc`, `effect/http/FetchHttpClient`, `effect/Context`, `effect/Layer`). The repo's `verbatimModuleSyntax` and `allowImportingTsExtensions` are on; local imports keep the `.ts`/`.tsx` extension where the existing code does.
- Record every deviation from this plan, every workaround, and every unverified check in [Deviations and issues](#deviations-and-issues) at the bottom. Be specific: file, what the plan said, what you did, why.

## Current state (before)

```
alchemy.run.ts            Website (Website.Vite, env: { BACKEND: Backend }) + Backend import
src/env.ts                Proxy over cloudflare:workers env
src/backend/worker.ts     Cloudflare.Worker with Effect RPC methods hello/shout + InvalidInput
src/backend/functions.ts  createServerFn wrappers calling toRpcAsync(env.BACKEND)
src/router.tsx            createRouter({ routeTree, context: {} })
src/routes/__root.tsx     createRootRoute, Astryx shell
src/routes/index.tsx      loader: getHello(); component: HomePage
src/components/HomePage.tsx  useState + useServerFn(shout)
```

A dev server is **already running** on port 3000 (`pnpm dev`, logs in `logs/dev/current`). Reuse it. It reloads on file changes. Only if it has died, start it again with `pnpm dev` in the background and tail `logs/dev/current`.

## Target state (after)

```
alchemy.run.ts            unchanged except nothing (Backend import path is the same)
src/env.server.ts         renamed from src/env.ts (C8)
src/api/backend.ts        API definition: schemas, InvalidInput, BackendRpcs, CurrentUser + CurrentUserMiddleware (declared, not attached)
src/backend/worker.ts     Cloudflare.RpcWorker serving BackendRpcs over ndjson (C7)
src/backend/handlers.ts   BackendRpcs.toLayer({ Hello, Shout })
src/backend-client.ts     BackendClient (AtomRpc.Service) + isomorphic transport + helloAtom + shoutAtom
src/router.tsx            per-request AtomRegistry; context, Wrap, dehydrate, hydrate, dispose on cleanup
src/routes/__root.tsx     createRootRouteWithContext<{ registry }>()
src/routes/index.tsx      loader primes helloAtom via AtomRegistry.getResult
src/routes/api.rpc.ts     POST proxy to env.BACKEND.fetch
src/components/HomePage.tsx  useAtomValue(helloAtom), useAtom(shoutAtom)
(deleted) src/backend/functions.ts
```

## Steps

Do them in order. Typecheck (`pnpm typecheck`) after steps 2, 4, 6, and 8. Lint and format with `pnpm check` at the end (fix what it reports).

### Step 1. `src/api/backend.ts`: the API definition

Schemas only. No Effect runtime code, no imports from `src/backend/` or Alchemy.

```ts
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {}

export const Hello = Schema.Struct({ message: Schema.String, servedAt: Schema.String });
export const Shouted = Schema.Struct({ input: Schema.String, output: Schema.String });

// Auth is deferred (D14). These are declared so the API definition is ready for it.
// CurrentUserMiddleware is NOT attached to the group yet: an attached middleware
// needs a server implementation layer (research C9).
export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "CurrentUser",
) {}
export class CurrentUserMiddleware extends RpcMiddleware.Service<
  CurrentUserMiddleware,
  { provides: CurrentUser }
>()("CurrentUserMiddleware") {}

export const BackendRpcs = RpcGroup.make(
  Rpc.make("Hello", { success: Hello }),
  Rpc.make("Shout", {
    payload: { input: Schema.String },
    success: Shouted,
    error: InvalidInput,
  }),
);
```

Notes:

- `Rpc.make` accepts struct fields for `payload` (`Rpc.ts:941-990`). `Hello` has no payload, so its payload schema is `Schema.Void` and callers pass `undefined` (C6).
- `RpcMiddleware.Service` signature: `RpcMiddleware.ts:278-330`.
- Move `InvalidInput` here and delete it from `src/backend/worker.ts`.

### Step 2. Backend: `src/backend/handlers.ts` and `src/backend/worker.ts`

`src/backend/handlers.ts`:

```ts
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { BackendRpcs, InvalidInput } from "../api/backend.ts";

export const BackendHandlers = BackendRpcs.toLayer({
  Hello: () =>
    Effect.gen(function* () {
      yield* Effect.log("Backend.Hello"); // used to count calls in the dev log
      const now = yield* DateTime.now;
      return { message: "Hello from the backend Worker.", servedAt: DateTime.formatIso(now) };
    }),
  Shout: ({ input }) =>
    Effect.gen(function* () {
      yield* Effect.log("Backend.Shout");
      const trimmed = input.trim();
      if (trimmed.length < 1 || trimmed.length > 80) {
        return yield* new InvalidInput({
          message: "Enter between 1 and 80 characters after trimming.",
        });
      }
      return { input: trimmed, output: trimmed.toUpperCase() };
    }),
});
```

Handler signature: `(payload, { client, requestId, headers, rpc }) => Effect` (`Rpc.ts:661-669`). `toLayer` accepts a plain record or an Effect of one (`RpcGroup.ts:97, 335`).

`src/backend/worker.ts`:

```ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { BackendRpcs } from "../api/backend.ts";
import { BackendHandlers } from "./handlers.ts";

// Private Effect Worker. The Website reaches it only through the `BACKEND`
// service binding, as Effect RPC over HTTP (ndjson).
export default class Backend extends Cloudflare.RpcWorker<Backend>()(
  "Backend",
  {
    main: import.meta.filename,
    schema: BackendRpcs,
    workersDev: false,
    compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    return RpcServer.toHttpEffect(BackendRpcs).pipe(
      Effect.provide(Layer.mergeAll(BackendHandlers, RpcSerialization.layerNdjson)),
    );
  }),
) {}
```

Notes:

- `Cloudflare.RpcWorker` class form and props: `node_modules/alchemy/src/Cloudflare/Workers/RpcWorker.ts` (docs at lines 280–330, types at 76–120). The init Effect returns the un-run `RpcServer.toHttpEffect(...)` Effect; Alchemy boxes it as `fetch` and handles the scope.
- `RpcServer.toHttpEffect` ignores method and path. It reads the body, so the proxy's URL does not matter.
- Keep `workersDev: false`.
- `alchemy.run.ts` needs no change: `env: { BACKEND: Backend }` still binds the Worker, and `InferEnv` gives `env.BACKEND` a `fetch`.
- If `Effect.log` output does not appear in `logs/dev/current` for the Backend, record it and use `console.log` instead.

### Step 3. Rename `src/env.ts` to `src/env.server.ts`

`git mv src/env.ts src/env.server.ts`. Update the import in every file that uses it (after this plan: only `src/backend-client.ts` and `src/routes/api.rpc.ts`). Start's import protection denies `*.server.*` files in the client build and fails the build if the import survives tree-shaking (`refs/tan-router/docs/start/framework/react/guide/import-protection.md`, lines 439–443). A dev-time warning that does not appear in `pnpm build` is acceptable; record it if you see one.

### Step 4. `src/backend-client.ts`: one client, two transports

```ts
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { BackendRpcs } from "./api/backend.ts";
import { env } from "./env.server.ts";

// Browser: same-origin proxy route. SSR: any absolute URL; the service binding ignores the host.
const rpcUrl = createIsomorphicFn()
  .client(() => `${window.location.origin}/api/rpc`)
  .server(() => "https://backend/rpc");

// SSR goes through the service binding in-process and forwards the visitor's cookie (Q4).
const serverFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  const cookie = getRequestHeader("cookie");
  if (cookie) headers.set("cookie", cookie);
  return env.BACKEND.fetch(input, { ...init, headers });
};

const transport = createIsomorphicFn()
  .client(() => FetchHttpClient.layer)
  .server(() =>
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(serverFetch))),
  );

export class BackendClient extends AtomRpc.Service<BackendClient>()("BackendClient", {
  group: BackendRpcs,
  protocol: RpcClient.layerProtocolHttp({ url: rpcUrl() }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(transport()),
  ),
}) {}

// Query atom. reactivityKeys lets Shout invalidate it (and causes one refetch after
// hydration, research C2; measured in Verify). timeToLive keeps the primed value alive
// between the loader and dehydrate (C12). serializationKey makes it dehydratable.
export const helloAtom = BackendClient.query("Hello", undefined, {
  reactivityKeys: ["hello"],
  serializationKey: "hello",
  timeToLive: "1 minute",
});

export const shoutAtom = BackendClient.mutation("Shout");
```

Notes:

- `AtomRpc.Service` options: `AtomRpc.ts:135-160`. `query` options: `AtomRpc.ts:82-92`. `mutation` write argument is `{ payload, reactivityKeys?, headers? }` (`AtomRpc.ts:58-80`).
- `Layer.succeed` is curried in Effect 4 (`Layer.ts:1010`), and `FetchHttpClient.Fetch` is a `Context.Reference` (`FetchHttpClient.ts:32`). `FetchHttpClient` calls `fetch(url, { method, headers, body, signal, ... })` with a string URL.
- `env.BACKEND.fetch(input, init)` accepts the same arguments as `fetch`. If the type of `env.BACKEND` rejects a `RequestInfo`, wrap it: `new Request(input, init)`.
- If the browser bundle fails to build because `@tanstack/react-start/server` or `env.server.ts` survived into the client, the compiler did not prune the `.server()` body. Record it, then move `serverFetch` and `rpcUrl`'s server branch into a `src/backend-transport.server.ts` and import that **only** inside the `.server()` callbacks via `createServerOnlyFn`. Record which variant ended up in the code.

### Step 5. `src/router.tsx`: registry per request, owned by the router

```tsx
import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { createRouter } from "@tanstack/react-router";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Hydration from "effect/reactivity/Hydration";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // One registry per router. getRouter() runs once per request on the server and once in the browser.
  const registry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { registry },
    Wrap: ({ children }) => (
      <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
    ),
    dehydrate: () => ({ atoms: Hydration.dehydrate(registry) }),
    hydrate: ({ atoms }) => {
      Hydration.hydrate(registry, atoms);
    },
  });

  // Best effort (research C11, Q3): dispose the server registry when the SSR request finishes.
  // This is the hook @tanstack/router-ssr-query-core uses. Skip it if the field is not in the types.
  router.serverSsrLifecycle = {
    ...router.serverSsrLifecycle,
    onServerSsrAttach: [
      ...(router.serverSsrLifecycle?.onServerSsrAttach ?? []),
      (serverSsr) => serverSsr.onCleanup(() => registry.dispose()),
    ],
  };

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
```

Notes:

- `Wrap` option: `refs/tan-router/packages/react-router/src/router.ts:58`. `dehydrate`/`hydrate`: `router-core/src/router.ts:376-385`. `serverSsrLifecycle` and `onCleanup`: `router-core/src/router.ts:867, 885, 2743`.
- The browser calls `options.hydrate` before `matchRoutes` (`router-core/src/load-client.ts:2226, 2240`), so loaders and components see the hydrated values.
- `scheduleTask` from `@effect/atom-react` uses React's `scheduler`. The module-level default registry in `RegistryContext.ts` already uses it on the server, so it should work in workerd. If SSR throws from the scheduler, omit `scheduleTask` on the server (make the options isomorphic) and record it.
- If TypeScript rejects the `dehydrate` return type (TanStack validates serializability structurally), cast: `atoms: Hydration.dehydrate(registry) as unknown as Array<Record<string, unknown>>` and mirror the cast in `hydrate`. Record it.
- Never create a registry at module level on the server. `RegistryContext`'s default value is one, which is why `Wrap` is required.

### Step 6. Routes

`src/routes/__root.tsx`: switch to `createRootRouteWithContext<{ registry: AtomRegistry.AtomRegistry }>()({ ...same options... })`. Everything else in the file stays.

`src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import HomePage from "../components/HomePage";
import { helloAtom } from "../backend-client.ts";

export const Route = createFileRoute("/")({
  // Prime the query atom so SSR renders with data and dehydrate captures it.
  // Returns nothing: the value travels in the dehydrated registry, not in loaderData.
  loader: async ({ context }) => {
    await Effect.runPromise(
      AtomRegistry.getResult(context.registry, helloAtom, { suspendOnWaiting: true }),
    );
  },
  component: HomePage,
});
```

`AtomRegistry.getResult`: `AtomRegistry.ts:341-402`. It subscribes until the result leaves `Initial`, then unsubscribes; `timeToLive` keeps the node alive afterwards.

`src/routes/api.rpc.ts` (new; the proxy route, path `/api/rpc`):

```ts
import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";

// Browser → Website → Backend. The binding ignores the host; RpcServer ignores the path.
export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: ({ request }) => env.BACKEND.fetch(request),
    },
  },
});
```

Server routes: `refs/tan-router/docs/start/framework/react/guide/server-routes.md`. The route tree file regenerates when the dev server or build runs. If the generated `routeTree.gen.ts` does not pick up the new route, restart the dev server once and record it.

### Step 7. `src/components/HomePage.tsx`

Replace the server-function code with atoms. Keep the Astryx shell, headings, and copy exactly as they are. Changes:

- Remove `useServerFn`, the `shout` import, `ShoutResult`, and the `result`/`pending`/`transportError` state. Keep `useState` for the text field (a local control is fine, D5).
- Remove the `hello` prop; the component reads `useAtomValue(helloAtom)` from `@effect/atom-react`.
- `const [shoutResult, shout] = useAtom(shoutAtom);` and the button calls `shout({ payload: { input }, reactivityKeys: ["hello"] })`. `isLoading` is `shoutResult.waiting`.
- Render `hello` by `_tag`: `Initial` → a `Text` saying "Loading…"; `Success` → `message — servedAt`, with " (refreshing…)" appended while `hello.waiting` is true so the post-hydration refetch is visible; `Failure` → a `Text role="alert"` with the error's `_tag`.
- Render `shoutResult`: `Success` → `input → output`; `Failure` → inspect the `Cause`. If the failure is an `InvalidInput` show `InvalidInput: message` (role alert). If it is an `RpcClientError` show "Transport error: the request failed. Try again." Otherwise (a defect) show "Defect: " plus a short rendering of the cause. Use `Cause` helpers from `effect/Cause` (for example `Cause.squash` or matching on `cause.reasons`). Check `AsyncResult.ts` and `Cause.ts` for the exact helper names; `AsyncResult.isSuccess/isFailure/isInitial` exist (`AsyncResult.ts:216, 262, 303`).
- Keep everything as Astryx components (`VStack`, `Text`, `Heading`, `Button`, `TextInput`). No `<div>`.

### Step 8. Delete `src/backend/functions.ts` and clean up

- `git rm src/backend/functions.ts`.
- Remove any remaining import of `alchemy/Cloudflare/Bridge` and `toRpcAsync`.
- Update the header comment in `src/components/HomePage.tsx` copy if it mentions server functions; the two sentences under the H1 are still accurate and stay.
- `pnpm typecheck`, `pnpm check`, `pnpm build`. All three must pass. Paste any residual warnings into Deviations.

## Verify

Do all of these and record the results (numbers, not adjectives) in [Deviations and issues](#deviations-and-issues).

1. **SSR renders with data.** `curl -s http://localhost:3000/ | grep -o 'Hello from the backend Worker[^<]*'` prints the message with a timestamp. Also confirm the dehydrated registry is in the HTML: `curl -s http://localhost:3000/ | grep -c 'AtomRpc:Hello:hello'` is at least 1.
2. **Backend calls per SSR load.** Note the current line count of `logs/dev/current`, curl the page once, then count new `Backend.Hello` log lines. Expected: 1 for the curl (no browser, so no hydration refetch).
3. **Hydration refetch (research C2).** Load `http://localhost:3000/` in a browser (use the T3 preview tools if available: `preview_open`, `preview_snapshot`; otherwise skip and say so). Count new `Backend.Hello` lines after the page is interactive. Expected with `reactivityKeys`: 2 per page load (SSR + refetch). Record the actual number.
4. **No hydration warning** in the browser console (preview tools), or record "not checked".
5. **Typed failure.** Submit an empty input. The page shows `InvalidInput: Enter between 1 and 80 characters after trimming.` and the dev log shows `Backend.Shout`.
6. **Success and invalidation.** Submit `hello`. The page shows `hello → HELLO`, and a new `Backend.Hello` line appears (the mutation's `reactivityKeys` refetched the query). The timestamp in "Loader data" changes.
7. **Defect round-trips.** Temporarily add `if (input === "boom") throw new Error("boom");` at the top of the `Shout` handler, submit `boom`, confirm the UI shows the defect text rather than a transport error, then **remove the line**.
8. **Proxy route directly.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/rpc -H 'content-type: application/ndjson' --data ''` returns a non-404 status (the Backend answers even for an empty body; a 4xx from Effect is fine, a 404 from Start means the route is not registered).
9. **Client-only import leak.** `pnpm build` succeeds. `grep -rl "cloudflare:workers" dist/client` (or the client output directory Start uses; find it) prints nothing.

## Out of scope

Auth, D1, the Workers Route browser path, tab limiting, version skew, moving the backend into Start's catch-all route (D6, D10, D12, D13, D14). Do not add `@tanstack/react-query` usage.

## Deviations and issues

The implementer records here. One bullet per item. Format: **file or step** — what the plan said — what was done instead or what happened — why. Include the Verify results as a numbered list matching the Verify section.

### Deviations

- **Step 6, `src/routes/index.tsx`** — plan: `await Effect.runPromise(AtomRegistry.getResult(...))`. Done: wrapped in `Effect.exit(...)`. Why: `getResult` fails with the query's error (`AtomRegistry.ts:384-399`, `Result.toExit`), so a Backend failure or `RpcClientError` would reject the loader and render the route error boundary instead of the `Failure` branch Step 7 asks HomePage to render. The failed result still sits in the registry and is dehydrated (C3).
- **Step 7, `src/components/HomePage.tsx`** — plan: "use `Cause` helpers, e.g. `Cause.squash` or matching on `cause.reasons`". Done: `Cause.findErrorOption(cause)` (`Cause.ts:962`) with `Option.match`; `Some` → InvalidInput or transport error by `_tag`, `None` → `Defect: ` plus the first line of `Cause.pretty(cause)` (`Cause.ts:1237`). Hello failures render the error `_tag`, or `Defect` when the cause has no typed error. Error types are imported as `import type { InvalidInput } from "../api/backend.ts"` and `import type { RpcClientError } from "effect/rpc"`.
- **Step 4, `src/backend-client.ts`** — plan note says `FetchHttpClient` calls `fetch` "with a string URL". Source (`effect/src/http/FetchHttpClient.ts:56-75`) passes a `URL` object and `headers` as a plain record. Both work with `new Headers(init?.headers)` and `env.BACKEND.fetch(input, init)`; no `new Request(...)` wrap was needed. Code is the plan's first variant (`createIsomorphicFn` in `backend-client.ts`); the `backend-transport.server.ts` fallback was not needed.
- **Step 2, `src/backend/worker.ts`**: the plan's init was `Effect.gen(function* () { return RpcServer.toHttpEffect(...)... })`. I used `Effect.sync(() => RpcServer.toHttpEffect(BackendRpcs).pipe(...))` instead. `vp check` warned "generator without yield" (`require-yield`) on the plan's version. The resulting type is the same, `Effect<Effect<HttpEffect>>`, which matches `RpcWorker.ts` `impl`.
- **Step 5, `src/router.tsx`** — code as planned. No cast was needed on `dehydrate`/`hydrate`; `serverSsrLifecycle` is in the types, so the cleanup hook is in. Comment trimmed ("Skip it if the field is not in the types" removed).
- **Step 6, `src/routes/__root.tsx`** — `AtomRegistry` imported as `import type * as AtomRegistry from "effect/reactivity/AtomRegistry"` (only the type is used).
- **`pnpm check` and docs** — `vp check` failed only on formatting in the four untracked docs (`docs/glossary.md`, this plan, `docs/start-to-effect-worker-ipc-research.md`, `docs/t3-code-worktrees-research.md`); source files passed as written. Ran `pnpm exec vp check --fix` to format them (whitespace and table alignment only).

### Issues and unverified checks

- **Dev server, dependency optimization.** The first SSR and browser loads after adding the new imports triggered Vite "optimized dependencies changed. reloading" (for `@effect/atom-react`, `effect/reactivity/Hydration`, `effect/Cause`, `effect/Option`). During one of these, at 01:14:25, SSR logged `TypeError: Cannot read properties of null (reading 'useContext')` in `HeadContent`/`useRouter` (status 500). It did not recur after the optimizer settled. Every later request returned 200. No dev server restart was needed; `routeTree.gen.ts` picked up `/api/rpc` without one.
- **Verify 3/4 browser tooling.** The T3 preview tools opened the page once (`preview_open`), then `preview_snapshot`/`preview_evaluate` timed out and `preview_status` reported "No preview automation host is available". Verify 3–7 were run instead with headless Google Chrome driven over CDP by a scratch script (`/tmp/cdp-verify/drive.mjs`, Node 24 global `WebSocket`, no new deps). It captured console messages and exceptions, typed with `Input.insertText`, and clicked the button.
- **"(refreshing…)" indicator not observed.** The post-hydration refetch finished about 100 ms after SSR (log 01:16:57.699 SSR → 01:16:57.801 refetch). That is before the first sample at 1.5 s, so the `waiting` text was never caught on screen. The refetch itself is confirmed: the page shows the refetched `servedAt` (…57.801Z), not the SSR one.
- **Registry disposal on SSR cleanup** (`serverSsr.onCleanup(() => registry.dispose())`). It typechecks and no errors are logged, but I did not confirm that it runs (no instrumentation added).
- **Defect does not invalidate.** On the `boom` defect, `Reactivity.mutation` did not refetch Hello (0 new `Backend.Hello`). Invalidation runs only on success. This is expected, not a bug.
- **Empty-body proxy call returns 500, not 4xx.** `POST /api/rpc` with an empty body returns 500 with an empty body. The Backend logs `HTTP handler failed` / `Error: {"_tag":"Done"}` (the ndjson stream ended with no request). The route is registered (not 404), and a real ndjson request through the same route returns `{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success",...}}`. `GET /api/rpc` returns 200: Start falls through to the app render because there is no GET handler. Not changed.
- **`Effect.log` output** appears in `logs/dev/current` as `[Backend] Backend.Hello` / `[Backend] Backend.Shout`, so the `console.log` fallback was not needed.
- **Build warning.** `pnpm build` prints Rolldown's "Some chunks are larger than 500 kB after minification". Client `dist/client/assets/index-*.js` is 657.58 kB (gzip 210.16 kB); server `router-*.js` is 1,092.38 kB. I did not compare against a pre-change baseline. No import-protection warnings appeared in dev or build.
- **Research C10 is out of date for this Start version.** The old dev log (before this change) showed `createServerFn().inputValidator() is deprecated. Use createServerFn().validator() instead.` C10 says the opposite. Moot here because the server functions are deleted.

### Verify results

1. Pass. SSR HTML contains `role="status">Hello from the backend Worker.<!-- --> — <!-- -->2026-10-10T05:18:16.886Z`. React's `<!-- -->` text separators mean the plan's `grep -o 'Hello from the backend Worker[^<]*'` prints only `Hello from the backend Worker.`; the timestamp follows the separators. `grep -c 'AtomRpc:Hello:hello'` = 1 (dehydrated `{key:"AtomRpc:Hello:hello",value:{_tag:"Success",...,waiting:!1}}` under `dehydratedData.atoms`).
2. Pass. 1 new `Backend.Hello` line for one curl (measured twice: before and after the `Effect.exit` change).
3. 2 `Backend.Hello` lines per browser page load (SSR + one post-hydration refetch, about 100 ms apart), matching C2. Measured on two separate headless Chrome loads (01:15:44.308/.474 and 01:16:57.699/.801). The displayed timestamp is the refetched one.
4. No hydration warning. Console on load contained only `[vite] connecting...`, `[vite] connected.`, and the React DevTools info message; 0 exceptions, 0 errors (headless Chrome via CDP).
5. Pass. Empty input → `alert: InvalidInput: Enter between 1 and 80 characters after trimming.`; 1 new `Backend.Shout` line, 0 new `Backend.Hello`.
6. Pass. Input `hello` → `status: hello → HELLO`; 1 new `Backend.Shout` and 1 new `Backend.Hello`; "Loader data" timestamp changed from `2026-10-10T05:16:57.801Z` to `2026-10-10T05:17:06.295Z`.
7. Pass. With the temporary `if (input === "boom") throw new Error("boom");` (first line of the Shout generator), submitting `boom` showed `alert: Defect: Error: boom` (not the transport error). The line was removed afterwards (`grep -c boom src/backend/handlers.ts` = 0).
8. Pass (non-404). `POST /api/rpc` with an empty body → `500` (from the Backend, see Issues). A valid ndjson `Hello` request through the proxy returned a `Success` Exit.
9. Pass. `pnpm build` exit 0. The client output dir is `dist/client`; `grep -rl "cloudflare:workers" dist/client` printed nothing (exit 1). `grep -rl "getRequestHeader|https://backend/rpc|env.server" dist/client` also printed nothing.

## Review (2026-10-10)

Reviewed the diff against the plan and re-ran the gates and SSR checks independently. All seven deviations are accepted; none change the architecture.

| Item                                                                           | Resolution                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Effect.exit` in the loader                                                    | **Reverted after discussion.** A failed `Hello` now rejects the loader and the route error boundary shows it, as the plan said. Swallowing a loader failure to render it in place is a per-page choice, not a default. HomePage keeps its `Failure` branch for refetch failures in the browser.                                                                                  |
| `Cause.findErrorOption` for failure rendering                                  | Accepted.                                                                                                                                                                                                                                                                                                                                                                        |
| `Effect.sync` instead of `Effect.gen` in the Backend init                      | Accepted; it satisfies the `require-yield` lint rule.                                                                                                                                                                                                                                                                                                                            |
| Research C10                                                                   | The implementer was right: `.validator` is current and `.inputValidator` is deprecated (`createServerFn.ts:513`). Research corrected.                                                                                                                                                                                                                                            |
| Registry disposal (Q3)                                                         | Confirmed to fire (a temporary `console.log` appeared once per SSR request), then **removed after discussion**: workerd tears the request context down anyway, and an undocumented router field is not worth it for housekeeping.                                                                                                                                                |
| Post-hydration refetch (Q1)                                                    | Measured at two Backend calls per page load with the `reactivityKeys` option. **Changed:** `helloAtom` is now a plain serializable query piped through `Atom.withReactivity(["hello"])`. Re-measured with headless Chrome: 1 `Backend.Hello` per page load, 1 refetch after a successful `Shout`, `InvalidInput` still renders, console clean. Research C1/C2 corrected (rev 4). |
| Client bundle size                                                             | Baseline built from the previous commit in a temporary worktree: `index-*.js` went from 475.20 kB (gzip 151.05 kB) to 657.58 kB (gzip 210.16 kB), so the Effect RPC client, atoms, and `Cause`/`Option` add about 59 kB gzipped. Acceptable for the spike; watch it.                                                                                                             |
| Empty-body `POST /api/rpc` → 500 and `GET /api/rpc` falling through to the app | Left as is. Only our client calls the route. Optional follow-up: add a `GET` handler returning 405.                                                                                                                                                                                                                                                                              |
| Transient `useContext` null error during Vite dependency re-optimization       | Not reproducible after the optimizer settled; no action.                                                                                                                                                                                                                                                                                                                         |
| Formatter touched the untracked docs                                           | Whitespace only; accepted.                                                                                                                                                                                                                                                                                                                                                       |

Nothing has been committed. The `/tmp/cdp-verify` scratch directory from the implementer's browser check can be deleted.

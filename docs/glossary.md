# Glossary

The architectural vocabulary for this repo. Use these words in code, docs, and conversation. Where Effect, Cloudflare, or TanStack has a term, we use theirs.

**This is not the product's domain language.** That will come from real features, and there isn't any yet (`hello` and `shout` are placeholders). When domain nouns appear, they get their own section here and their own `src/domain/` module.

Background: [IPC research](./start-to-effect-worker-ipc-research.md), decision D16.

## Source layout

Effect's reference app (`refs/effect/ai-docs/src/51_http-server/fixtures`) splits `domain/` (entities), `api/` (the API definition), and `server/` (implementations). We follow that, with one change: implementations live in `src/backend/`, because in a Start app "server" already means Start's server side.

| Path                    | Holds                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/`              | The Backend's **API definition**: `RpcGroup`s, procedures, middleware declarations, and errors. Schemas only. Imported by both Workers.              |
| `src/domain/`           | Entities, branded IDs, and domain errors, as pure Schema. **Created with the first real entity**; until then placeholder schemas live in `src/api/`. |
| `src/backend/`          | The Backend Worker (`worker.ts`) and the handlers that implement `src/api/`.                                                                         |
| `src/backend-client.ts` | The Website's `BackendClient` and its transport.                                                                                                     |
| `src/routes/api.rpc.ts` | The proxy route.                                                                                                                                     |

## Terms

| Term                    | Meaning                                                                                                                                                                | Avoid                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Website**             | The TanStack Start Worker (Alchemy `Website.Vite`). It serves SSR pages, static assets, and the proxy route. Plain TypeScript, with no Alchemy-managed Effect runtime. | "frontend" (the browser is the front end), "foreground" |
| **Backend**             | The private Effect Worker (Alchemy `Cloudflare.Worker`, `workersDev: false`).                                                                                          | "background task", "server", "API Worker"               |
| **Binding**             | The service binding `env.BACKEND` from Website to Backend.                                                                                                             |                                                         |
| **API definition**      | `src/api/`: what the Backend serves and clients call.                                                                                                                  | "contract", "schema" (too broad)                        |
| **Procedure**           | One `Rpc.make(...)` in a group. A caller sends a **payload** and gets back a **success** or a **failure**.                                                             | "endpoint" (an HttpApi term), "method"                  |
| **Group**               | An `RpcGroup` of related procedures, e.g. `BackendRpcs`.                                                                                                               |                                                         |
| **Handler**             | The Backend's implementation of a procedure.                                                                                                                           |                                                         |
| **Client**              | `BackendClient`, the Website's `AtomRpc` service that calls procedures.                                                                                                |                                                         |
| **Transport**           | What carries a call: the binding during SSR, or `fetch` to the proxy route in the browser.                                                                             |                                                         |
| **Proxy route**         | `/api/rpc` in the Website, which forwards to the binding.                                                                                                              |                                                         |
| **Boundary**            | Any point where data enters a process (browser ↔ Website, Website ↔ Backend). Data is **decoded** with Schema there.                                                   | "IPC" (it's RPC over HTTP over a binding)               |
| **Failure**             | An expected, typed error: a `Schema.TaggedError` declared on the procedure.                                                                                            | "exception"                                             |
| **Defect**              | An unexpected error (a bug). It still round-trips over RPC.                                                                                                            | "crash"                                                 |
| **Registry**            | The per-request `AtomRegistry` owned by the router.                                                                                                                    | "store", "cache"                                        |
| **Query atom**          | `BackendClient.query(...)`: reads a procedure's result.                                                                                                                |                                                         |
| **Mutation atom**       | `BackendClient.mutation(...)`: calls a procedure that changes something.                                                                                               |                                                         |
| **Reactivity key**      | A label that a mutation invalidates and that queries refetch on.                                                                                                       | "cache tag"                                             |
| **Prime**               | A loader filling the registry before render.                                                                                                                           | "prefetch" (TanStack uses that for intent preloading)   |
| **Dehydrate / hydrate** | Serialize the registry on the server / restore it in the browser.                                                                                                      |                                                         |
| **Server function**     | Reserved for TanStack `createServerFn`.                                                                                                                                | Using it for Backend procedures                         |

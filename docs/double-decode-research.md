# The second decode on the Backend binding

Date: 2026-10-14. Status: decided and applied; see section 6.

Split out of `docs/simplification-research.md`, which claimed that each Backend method decodes
arguments its server function already validated and that this was a trim. This document shows the
chain step by step with the actual code, says what each decode guards against, and what would happen
if it were removed. The conclusion is that there is no problem to fix.

## 1. The chain for `requestMagicLink`

### Step 1: the browser's input, decoded in the server function

`src/web/server/sign-in.ts`:

```ts
export const requestMagicLink = createServerFn({ method: "POST" })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ email: Email, returnTo: Schema.optional(ReturnPath) }),
    ),
  )
  .handler(({ data }): Promise<MagicLinkResult> =>
    backend()
      .requestMagicLink(requestInfo(), data)
```

This is decode 1. It runs on the Website Worker on whatever the browser posted. After it, `data` is
`{ email: Email; returnTo?: ReturnPath }` with the brands applied.

### Step 2: the request fields, built by the Website

`src/web/server/backend.ts`:

```ts
export const backend = () => toRpcAsync<Backend>(env.BACKEND);

export const requestInfo = (): RequestInfo => ({
  cookie: getRequestHeader("cookie"),
  ip: getRequestHeader("cf-connecting-ip"),
});
```

`requestInfo()` is never decoded on the Website. It is two header reads, each `string | undefined`,
which is exactly the `RequestInfo` type. Nothing to validate.

### Step 3: the binding

`toRpcAsync` in Alchemy (`refs/alchemy/packages/alchemy/src/Cloudflare/Workers/RpcAsync.ts`) is a
`Proxy` over the Cloudflare service binding. A method call becomes a native JSRPC call: arguments
travel by structured clone, not JSON. On the Backend side Alchemy's Worker bridge runs the method's
Effect; a failure comes back as an envelope `{ _tag: "~alchemy/rpc/error", error }` where `error` is
the tagged error flattened to a plain object by `encodeRpcError`. `toRpcAsync` rethrows that plain
object. That is why `rescue` exists on the Website: the class identity is gone, only `_tag` and the
fields remain.

The binding is typed at compile time by `toRpcAsync<Backend>`, which infers the method signatures
from the Worker class. At runtime it carries whatever the caller passed. The type is a promise the
Website keeps, not a check the Backend performs.

### Step 4: the Backend method decodes what arrived

`src/backend/api.ts`:

```ts
const decodeRequest = Schema.decodeUnknownEffect(RequestInfo);
const decodeMagicLinkInput = Schema.decodeUnknownEffect(
  Schema.Struct({ email: Email, returnTo: Schema.optional(ReturnPath) }),
);

const requestMagicLink = Effect.fn("BackendApi.requestMagicLink")(function* (
  request: RequestInfo,
  payload: { readonly email: Email; readonly returnTo?: ReturnPath | undefined },
) {
  const { ip } = yield* decodeRequest(request).pipe(Effect.orDie);
  const { email, returnTo } = yield* decodeMagicLinkInput(payload).pipe(Effect.orDie);
```

These are decodes 2a and 2b. Decode 2b runs the same schema as decode 1, on the same value, one
Worker later. Decode 2a runs `RequestInfo` on the object `requestInfo()` built. Both are `orDie`: a
value that does not decode is a defect, because the only caller is our own server function and it
has already decoded.

The JSDoc on these constants says so:

> The arguments of each method, decoded again on arrival: the binding carries plain data, and a
> server function that already validated it is the only caller, so a value that does not decode is a
> defect.

### Step 5: the result, encoded for the binding and decoded back

`api.ts` returns `encodeMagicLinkRequested({ link })` because `MagicLinkRequested` holds an
`Option`, which structured clone does not carry as an Effect `Option`. `sign-in.ts` runs
`decodeRequested(answer)` to get the `Option` back. This is decode 3. It is a transform, not a
check; it exists only because the wire type and the domain type differ.

## 2. The same shape elsewhere

| Method             | Decode 1 (server function)        | Decode 2 (Backend)                      | Decode 3 (result)    |
| ------------------ | --------------------------------- | --------------------------------------- | -------------------- |
| `hello`            | none (no input)                   | none                                    | none                 |
| `shout`            | `{ input: ShoutText }`            | `decodeShout`: `{ input: ShoutText }`   | none                 |
| `requestMagicLink` | `{ email, returnTo? }`            | `decodeRequest`, `decodeMagicLinkInput` | `MagicLinkRequested` |
| `me`               | none                              | `decodeRequest` (inside `session`)      | none                 |
| `listMembers`      | none                              | `decodeRequest` (inside `session`)      | none                 |
| `shopSnapshot`     | `{ key: ShopKey, sessionToken? }` | `decodeRequest`, `decodeSnapshotInput`  | none                 |

Three methods decode a payload twice. Five decode `RequestInfo`, which was never decoded once.

## 3. What each decode guards against

**Decode 1** is the browser boundary. Untrusted input, typed failures shown as form errors. Not in
question.

**Decode 2** is the binding boundary. The Backend is private (`workersDev: false`, reachable only
through the `BACKEND` binding), and today the Website's server functions are its only callers. Decode
2 guards against:

- A future caller that is not a server function. The glossary says data is decoded at every
  boundary; a method that trusts its arguments because of who calls it today is a method that is
  wrong the day a second caller appears (a cron, a queue consumer, another Worker).
- Drift between the server function's schema and the method's expectation. Today the two schemas are
  written twice by hand and happen to match. If they diverge, decode 2 fails loudly as a defect
  rather than letting a value through that the method's types say cannot exist.
- The brands. `Email` and `ShopKey` are branded types. Structured clone carries the string, not the
  brand. Decode 2 is what re-establishes, at runtime, that the string on the Backend side is an
  `Email` by the Backend's own definition.

Removing decode 2 would save about five lines per method and would mean the Backend's methods take
their arguments on trust from a transport that does not check them. That is a weaker rule than the
one the codebase states, for a saving of fifteen lines.

**Decode 2a on `RequestInfo`** is the odd one. The object was built by our own code from two header
reads and has never been through a schema. Decoding it on arrival is the only place it is ever
checked, so calling it a "second" decode was wrong; it is the first and only. It also means the
method's `cookie` and `ip` are known to be `string | undefined` by schema rather than by trust.

**Decode 3** is a transform the binding forces (no `Option` over structured clone) and is not a
duplicate of anything.

## 4. What is duplicated

The schema literal `Schema.Struct({ email: Email, returnTo: Schema.optional(ReturnPath) })` appears
in `sign-in.ts` and in `api.ts`. The schema `{ key: ShopKey, sessionToken?: String }` appears in
`shop.ts` and in `api.ts`. The schema `{ input: ShoutText }` appears in `playground.ts` and in
`api.ts`. Each pair is a hand-written copy that must stay in sync.

That duplication, not the decode, is the only thing worth a change: define each method's input
schema once in `src/contract/` and import it on both sides. The server function's validator and the
Backend's decode then read the same constant. This is about ten lines moved, and it makes the
"drift" risk in section 3 impossible rather than merely caught.

## 5. Conclusion

The second decode is the boundary rule applied to the binding. It is correct, it is cheap, and the
JSDoc already explains it. The earlier claim that it was a simplification target was wrong, and the
"four `orDie` sites into one helper" trim is not worth doing. The one real improvement is sharing the
input schemas through the contract folder so the two sides cannot drift.

## 6. Decision (2026-10-14)

Accepted in review: keep the decodes and share the input schemas. Done the same day. `ShoutInput`,
`MagicLinkInput` and `ShopSnapshotInput` now live in `src/contract/`, and each server function's
validator and each Backend method's decode read the same constant. `vp check` and the unit tests
pass. Not committed.

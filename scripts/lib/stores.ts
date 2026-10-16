/**
 * A checkout's Shopify dev stores, checked and given the dev fixture's store half through Shopify
 * CLI. Every call closes
 * stdin and passes `--no-input`, so nothing can wait on a prompt or open a browser, and decodes
 * the result with Schema ({@link shopifyJson}).
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { fixture, skuOf } from "../../fixture.ts";
import type { Product, StoreOrder } from "../../src/contract/fixture.ts";
import { runCommand } from "./command.ts";
import { StoreOf, storeNameOf, type StoreEnvironment } from "./worktree.ts";

export class StoresError extends Schema.TaggedError<StoresError>()("StoresError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** The id of the `mw10013` organization, which owns the dev stores; `store create` needs it when it cannot prompt. */
export const ORGANIZATION_ID = "130059740";

/** The Admin API version of the store fixture's operations; `api_version` in `shopify.app.toml`. */
const API_VERSION = "2026-10";

/** The `myshopify.com` domain of a store named `name`. */
export const domainOf = (name: string) => `${name}.myshopify.com`;

/**
 * The text of the result in a `--json` output. The CLI prints progress events, one JSON object per
 * line, then the result as one pretty-printed object over several lines: the result is the last
 * object, which is the last line only when the result is a single line.
 */
export const resultText = (stdout: string): string => {
  const lines = stdout.split("\n").filter((line) => line !== "");
  const last = lines.at(-1) ?? "";
  if (last !== "}" && last !== "]") return last;
  const start = lines.lastIndexOf(last === "}" ? "{" : "[");
  return lines.slice(Math.max(start, 0)).join("\n");
};

/** The result in a `--json` output, decoded with `schema`; see {@link resultText}. */
export const CliResult = <S extends Schema.Constraint>(schema: S) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({ decode: resultText, encode: (text) => text }),
    ),
    Schema.decodeTo(Schema.fromJsonString(schema)),
  );

/** Runs `shopify <args> --json --no-input` with stdin closed and decodes its result with `schema`. */
export const shopifyJson = Effect.fn("shopifyJson")(function* <S extends Schema.Constraint>(
  args: readonly string[],
  schema: S,
) {
  const stdout = yield* runCommand("shopify", [...args, "--json", "--no-input"], "").pipe(
    Effect.mapError((error) => new StoresError({ message: error.message, cause: error })),
  );
  return yield* Schema.decodeUnknownEffect(CliResult(schema))(stdout).pipe(
    Effect.mapError(
      (error) =>
        new StoresError({
          message: `shopify ${args.slice(0, 2).join(" ")} printed a result that is not the expected shape: ${error.message}`,
          cause: error,
        }),
    ),
  );
});

/** `value` as a store of `environment`, or a failure that says what the variable should hold. */
export const requireStore = (environment: StoreEnvironment, variable: string, value: string) =>
  Schema.decodeUnknownEffect(StoreOf(environment))(value).pipe(
    Effect.mapError(
      () =>
        new StoresError({
          message: `${variable}=${value} is not ${environment === "e2e" ? "an" : "a"} ${environment} store of the scheme mw10013-${environment}-shop-NN (NN the worktree index); fix it in .env`,
        }),
    ),
  );

/**
 * `store` as a store `vp run fixture` may write: a dev store. The e2e, staging and production
 * stores never get the store half, and neither does a store outside the scheme, such as
 * `sandbox-shop-NN`.
 */
export const requireFixtureStore = (store: string) =>
  Schema.decodeUnknownEffect(StoreOf("dev"))(store).pipe(
    Effect.mapError(
      (error) =>
        new StoresError({
          message: `${store} is not a dev store of the scheme mw10013-dev-shop-NN: the fixture writes only those`,
          cause: error,
        }),
    ),
  );

const StoreList = Schema.Struct({
  stores: Schema.Array(
    Schema.Struct({
      store: Schema.String,
      type: Schema.String,
      plan: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const listStores = shopifyJson(["store", "list", "--type", "dev"], StoreList).pipe(
  Effect.map(({ stores }) => stores),
);

/** The command a person runs to create store `name`; {@link checkStores} never creates one. */
const createCommand = (name: string) =>
  `shopify store create dev --name ${name} --plan basic --organization-id ${ORGANIZATION_ID}`;

/**
 * Checks that this checkout's dev and e2e stores exist as dev stores on `basic` with exactly their
 * domains, and prints one line per store. It only reads: the stores are claimed ahead of time, so a
 * missing one means a wrong `.env`, a deleted store or the CLI signed in to another account, and
 * creating one would hide that and spend a name that never comes back. A missing store fails with
 * the command a person runs to create it. Each value must be a store of the matching environment
 * ({@link StoreOf}); the `variable` names go in the failure message.
 */
export const checkStores = Effect.fn("checkStores")(function* (stores: {
  readonly dev: string;
  readonly e2e: string;
}) {
  const wanted = [
    yield* requireStore("dev", "SHOPIFY_DEV_STORE", stores.dev),
    yield* requireStore("e2e", "SHOPIFY_E2E_STORE", stores.e2e),
  ].map(({ environment, index }) => storeNameOf(environment, index));
  const existing = yield* listStores;
  for (const name of wanted) {
    const found = existing.find(({ store }) => store === domainOf(name));
    if (found === undefined)
      return yield* new StoresError({
        message: `${name} does not exist in the organization the CLI is signed in to. Check .env and \`shopify store list\`; if the store is new, create it by hand: ${createCommand(name)}`,
      });
    if (found.type !== "dev" || found.plan !== "basic")
      return yield* new StoresError({
        message: `${name} is type ${found.type}, plan ${found.plan ?? "(none)"}; expected a dev store on basic`,
      });
    yield* Console.log(`ok    ${name} exists`);
  }
});

const FIXTURE_RESOURCES = ["products", "orders", "draft_orders"] as const;

/** The scopes the store fixture needs: read and write of each of {@link FIXTURE_RESOURCES}. */
export const FIXTURE_SCOPES = FIXTURE_RESOURCES.flatMap((resource) => [
  `read_${resource}`,
  `write_${resource}`,
]);

/**
 * The scopes of {@link FIXTURE_SCOPES} that `granted` lacks. Shopify's `write_X` includes `read_X`,
 * and the CLI lists only the scopes it was asked for, so a session with `write_products` has
 * `read_products` too.
 */
export const missingScopes = (granted: readonly string[]): string[] =>
  FIXTURE_RESOURCES.flatMap((resource) =>
    granted.includes(`write_${resource}`)
      ? []
      : [`read_${resource}`, `write_${resource}`].filter((scope) => !granted.includes(scope)),
  );

const AuthList = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({ store: Schema.String, scopes: Schema.Array(Schema.String) }),
  ),
});

/**
 * Fails, with the exact command to run, unless the CLI has a store auth session for `domain` with
 * every scope the store fixture needs. Authorizing opens a browser page that a person approves, once per
 * store (a session renews itself), so no script does it.
 */
const requireStoreAuth = Effect.fn("requireStoreAuth")(function* (domain: string) {
  const { sessions } = yield* shopifyJson(["store", "auth", "list"], AuthList);
  const session = sessions.find(({ store }) => store === domain);
  if (session !== undefined && missingScopes(session.scopes).length === 0) return;
  return yield* new StoresError({
    message: `${domain} has no store auth with the scopes the fixture needs. Run: shopify store auth --store ${domain} --scopes ${FIXTURE_SCOPES.join(",")}\nIt opens a browser page that a person approves once per store.`,
  });
});

const Money = Schema.String;
const StoredProduct = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  title: Schema.String,
  status: Schema.String,
  tags: Schema.Array(Schema.String),
  options: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      optionValues: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  ),
  variants: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sku: Schema.NullOr(Schema.String),
        price: Money,
        selectedOptions: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
      }),
    ),
  }),
});
type StoredProduct = typeof StoredProduct.Type;

const StoredOrder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tags: Schema.Array(Schema.String),
  cancelledAt: Schema.NullOr(Schema.String),
});
type StoredOrder = typeof StoredOrder.Type;

const UserErrors = Schema.Array(Schema.Struct({ message: Schema.String }));

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((entry) => b.includes(entry));

/** True when the store's product already says what the table says; a price compares as a number, since the store writes `68.0` for `68.00`. */
export const productMatches = (stored: StoredProduct, wanted: Product): boolean => {
  const [option] = stored.options;
  return (
    stored.title === wanted.title &&
    stored.status === "ACTIVE" &&
    sameSet(stored.tags, wanted.tags) &&
    stored.options.length === 1 &&
    option?.name === wanted.option &&
    sameSet(
      option.optionValues.map(({ name }) => name),
      wanted.variants.map(({ value }) => value),
    ) &&
    stored.variants.nodes.length === wanted.variants.length &&
    wanted.variants.every((variant) =>
      stored.variants.nodes.some(
        (node) =>
          node.selectedOptions.some(
            ({ name, value }) => name === wanted.option && value === variant.value,
          ) &&
          (node.sku ?? null) === skuOf(wanted, variant.value) &&
          Number(node.price) === Number(variant.price),
      ),
    )
  );
};

/** The `productSet` input for a table row. */
const productSetInput = (wanted: Product) => ({
  title: wanted.title,
  handle: wanted.handle,
  status: "ACTIVE",
  tags: wanted.tags,
  productOptions: [
    { name: wanted.option, values: wanted.variants.map(({ value }) => ({ name: value })) },
  ],
  variants: wanted.variants.map(({ value, price }) => {
    const sku = skuOf(wanted, value);
    return {
      optionValues: [{ optionName: wanted.option, name: value }],
      price,
      ...(sku === null ? {} : { sku }),
    };
  }),
});

/** The table's orders that have no open order carrying their tag. */
export const missingOrders = (orders: readonly StoredOrder[]): readonly StoreOrder[] =>
  fixture.storeOrders.filter(
    (wanted) =>
      !orders.some((order) => order.cancelledAt === null && order.tags.includes(wanted.tag)),
  );

/**
 * Marks every open order the store fixture created, beside the order's own tag. It reads "seed"
 * because the dev stores already hold orders tagged so, and a new marker would cancel them.
 */
const FIXTURE_ORDER_TAG = "seed";

const PRODUCTS_QUERY = /* GraphQL */ `
  query FixtureProducts {
    products(first: 100) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        handle
        title
        status
        tags
        options {
          name
          optionValues {
            name
          }
        }
        variants(first: 50) {
          nodes {
            id
            sku
            price
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

const ORDERS_QUERY = /* GraphQL */ `
  query FixtureOrders {
    orders(first: 100) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        name
        tags
        cancelledAt
      }
    }
  }
`;

const PRODUCT_SET = /* GraphQL */ `
  mutation FixtureProductSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(input: $input, identifier: $identifier, synchronous: true) {
      product {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const PRODUCT_ARCHIVE = /* GraphQL */ `
  mutation FixtureProductArchive($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const ORDER_CANCEL = /* GraphQL */ `
  mutation FixtureOrderCancel($orderId: ID!) {
    orderCancel(
      orderId: $orderId
      reason: OTHER
      restock: false
      notifyCustomer: false
      staffNote: "Closed by vp run fixture"
    ) {
      orderCancelUserErrors {
        message
      }
    }
  }
`;

const DRAFT_ORDER_CREATE = /* GraphQL */ `
  mutation FixtureDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const DRAFT_ORDER_COMPLETE = /* GraphQL */ `
  mutation FixtureDraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        order {
          id
          name
        }
      }
      userErrors {
        message
      }
    }
  }
`;

/**
 * Runs one operation through `shopify store execute` on the CLI's own store auth and decodes what
 * it prints, which is the operation's `data`. A mutation needs `--allow-mutations`.
 */
const execute = <S extends Schema.Constraint>(
  domain: string,
  schema: S,
  document: string,
  options: { readonly variables?: Record<string, unknown>; readonly mutation?: boolean } = {},
) =>
  shopifyJson(
    [
      "store",
      "execute",
      "--store",
      domain,
      "--version",
      API_VERSION,
      "--query",
      document,
      ...(options.variables === undefined
        ? []
        : ["--variables", JSON.stringify(options.variables)]),
      ...(options.mutation === true ? ["--allow-mutations"] : []),
    ],
    schema,
  );

const failOnErrors = (what: string, errors: typeof UserErrors.Type) =>
  errors.length === 0
    ? Effect.void
    : Effect.fail(
        new StoresError({
          message: `${what}: ${errors.map(({ message }) => message).join("; ")}`,
        }),
      );

const Page = <S extends Schema.Constraint>(node: S) =>
  Schema.Struct({
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
    nodes: Schema.Array(node),
  });

const readProducts = Effect.fn("readProducts")(function* (domain: string) {
  const { products } = yield* execute(
    domain,
    Schema.Struct({ products: Page(StoredProduct) }),
    PRODUCTS_QUERY,
  );
  if (products.pageInfo.hasNextPage)
    return yield* new StoresError({
      message: "the store has more than 100 products; archive them first",
    });
  return products.nodes;
});

const readOrders = Effect.fn("readOrders")(function* (domain: string) {
  const { orders } = yield* execute(
    domain,
    Schema.Struct({ orders: Page(StoredOrder) }),
    ORDERS_QUERY,
  );
  if (orders.pageInfo.hasNextPage)
    return yield* new StoresError({ message: "the store has more than 100 orders" });
  return orders.nodes;
});

/**
 * Reads the orders until none of the table's orders is missing from the list. The list lags a
 * completed draft order by more than ten seconds, and a rerun that read it too soon would create
 * the orders again. Fails after about two minutes.
 */
const waitForOrders = Effect.fn("waitForOrders")(function* (domain: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (missingOrders(yield* readOrders(domain)).length === 0) return;
    yield* Effect.sleep("3 seconds");
  }
  return yield* new StoresError({
    message: "the store's order list did not show the created orders after two minutes",
  });
});

/**
 * Brings dev store `store` to the dev fixture's store half (`products` and `storeOrders` in
 * `fixture.ts`), printing one line per product and order. Every step reads before it writes, so a second run changes nothing. The
 * store must be one {@link requireFixtureStore} accepts and must have store auth with the needed scopes
 * ({@link requireStoreAuth}); both are checked before any mutation.
 *
 * 1. `productSet` each product that is missing or differs, by handle. No images.
 * 2. Archive every product the table does not name; archived, not deleted.
 * 3. Cancel every open order without the `seed` tag ({@link FIXTURE_ORDER_TAG}), with no refund,
 *    restock or notice: the fixture's orders are the store's only open orders. Matched by tag,
 *    never by order number, since a new store numbers its first such order #1001.
 * 4. Create each of the table's orders that has no open order with its tag, paid, with no customer or
 *    notice. Through a draft order that is completed, not `orderCreate`: that needs an offline
 *    token, and the CLI's store auth is an online one.
 */
export const applyStoreFixture = Effect.fn("applyStoreFixture")(function* (store: string) {
  const { environment, index } = yield* requireFixtureStore(store);
  const domain = domainOf(storeNameOf(environment, index));
  yield* requireStoreAuth(domain);

  const stored = yield* readProducts(domain);
  const named = new Set(fixture.products.map(({ handle }) => handle));
  for (const wanted of fixture.products) {
    const existing = stored.find(({ handle }) => handle === wanted.handle);
    if (existing !== undefined && productMatches(existing, wanted)) {
      yield* Console.log(`ok    product ${wanted.handle}: already as the table says`);
      continue;
    }
    const result = yield* execute(
      domain,
      Schema.Struct({ productSet: Schema.Struct({ userErrors: UserErrors }) }),
      PRODUCT_SET,
      {
        variables: {
          input: productSetInput(wanted),
          identifier: existing === undefined ? null : { id: existing.id },
        },
        mutation: true,
      },
    );
    yield* failOnErrors(`productSet ${wanted.handle}`, result.productSet.userErrors);
    yield* Console.log(
      `ok    product ${wanted.handle}: ${existing === undefined ? "created" : "updated"}`,
    );
  }

  for (const other of stored.filter(
    ({ handle, status }) => !named.has(handle) && status !== "ARCHIVED",
  )) {
    const result = yield* execute(
      domain,
      Schema.Struct({ productUpdate: Schema.Struct({ userErrors: UserErrors }) }),
      PRODUCT_ARCHIVE,
      { variables: { product: { id: other.id, status: "ARCHIVED" } }, mutation: true },
    );
    yield* failOnErrors(`archive ${other.handle}`, result.productUpdate.userErrors);
    yield* Console.log(`ok    product ${other.handle}: archived`);
  }

  const orders = yield* readOrders(domain);
  const leftovers = orders.filter(
    ({ tags, cancelledAt }) => cancelledAt === null && !tags.includes(FIXTURE_ORDER_TAG),
  );
  if (leftovers.length === 0) yield* Console.log("ok    orders: no open order outside the table");
  for (const leftover of leftovers) {
    const result = yield* execute(
      domain,
      Schema.Struct({
        orderCancel: Schema.Struct({ orderCancelUserErrors: UserErrors }),
      }),
      ORDER_CANCEL,
      { variables: { orderId: leftover.id }, mutation: true },
    );
    yield* failOnErrors(`cancel ${leftover.name}`, result.orderCancel.orderCancelUserErrors);
    yield* Console.log(`ok    order ${leftover.name}: cancelled, no refund, no restock, no notice`);
  }

  const missing = missingOrders(orders);
  for (const wanted of fixture.storeOrders)
    if (!missing.includes(wanted)) yield* Console.log(`ok    order ${wanted.tag}: already open`);
  if (missing.length === 0) return;

  // Read again: the variant ids exist only after the products are written.
  const products = yield* readProducts(domain);
  const variantId = (handle: string, value: string): Effect.Effect<string, StoresError> => {
    const id = products
      .find((product) => product.handle === handle)
      ?.variants.nodes.find((node) =>
        node.selectedOptions.some((option) => option.value === value),
      )?.id;
    return id === undefined
      ? Effect.fail(new StoresError({ message: `no variant ${value} on product ${handle}` }))
      : Effect.succeed(id);
  };
  for (const wanted of missing) {
    const lineItems = yield* Effect.forEach(wanted.lines, (line) =>
      variantId(line.handle, line.value).pipe(
        Effect.map((id) => ({
          variantId: id,
          quantity: line.quantity,
          customAttributes: Object.entries(line.properties).map(([key, value]) => ({
            key,
            value,
          })),
        })),
      ),
    );
    const draft = yield* execute(
      domain,
      Schema.Struct({
        draftOrderCreate: Schema.Struct({
          draftOrder: Schema.NullOr(Schema.Struct({ id: Schema.String })),
          userErrors: UserErrors,
        }),
      }),
      DRAFT_ORDER_CREATE,
      {
        variables: { input: { lineItems, tags: [FIXTURE_ORDER_TAG, wanted.tag] } },
        mutation: true,
      },
    );
    yield* failOnErrors(`draftOrderCreate ${wanted.tag}`, draft.draftOrderCreate.userErrors);
    const draftId = draft.draftOrderCreate.draftOrder?.id;
    if (draftId === undefined)
      return yield* new StoresError({ message: `draftOrderCreate ${wanted.tag}: no draft order` });
    const completed = yield* execute(
      domain,
      Schema.Struct({
        draftOrderComplete: Schema.Struct({
          draftOrder: Schema.NullOr(
            Schema.Struct({
              order: Schema.NullOr(Schema.Struct({ name: Schema.String })),
            }),
          ),
          userErrors: UserErrors,
        }),
      }),
      DRAFT_ORDER_COMPLETE,
      { variables: { id: draftId }, mutation: true },
    );
    yield* failOnErrors(
      `draftOrderComplete ${wanted.tag}`,
      completed.draftOrderComplete.userErrors,
    );
    yield* Console.log(
      `ok    order ${wanted.tag}: created as ${completed.draftOrderComplete.draftOrder?.order?.name ?? "?"}`,
    );
  }
  yield* waitForOrders(domain);
  yield* Console.log("ok    orders: listed by the store");
});

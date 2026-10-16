/**
 * The fake shops of `seed/test.sql`, which the integration and e2e tests run against. They are
 * placeholders, not real stores, and exist only on the `test` and `e2e` environments.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { ShopKey } from "../src/contract/shop.ts";

/** `m1@m.com` and `m2@m.com` are its members, and team `ops` holds `m1@m.com`. */
export const SEED_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)("seed-shop.myshopify.com");

/** `m1@m.com` is its one member. */
export const OTHER_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");

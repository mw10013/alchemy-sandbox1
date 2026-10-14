import * as Schema from "effect/Schema";
import { Email } from "./auth.ts";
import { ShopKey } from "./shop.ts";

/**
 * Baton's `Member` row: one email's membership of one shop. Who may sign in at all is whoever
 * has a row in some shop. `createdAt` is epoch ms.
 */
export const Member = Schema.Struct({
  id: Schema.String,
  shop: ShopKey,
  email: Email,
  createdAt: Schema.Number,
});
export type Member = typeof Member.Type;

/** The email is already a member of the shop: Baton's unique (shop, email). */
export class MemberExists extends Schema.TaggedError<MemberExists>()("MemberExists", {}) {}

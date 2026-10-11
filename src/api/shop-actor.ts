import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

/**
 * Names one shop's actor. A shop is identified by its domain in the product this grows into;
 * until shops exist the key is any lowercase slug. The route param and the Backend path decode
 * through this, so an unknown shape never reaches `getByName`.
 */
export const ShopKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)).pipe(
  Schema.brand("ShopKey"),
);
export type ShopKey = typeof ShopKey.Type;

/** The one shop the sandbox has. The member navigation links to it. */
export const SANDBOX_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)("alchemy-sandbox1");

export const Count = Schema.Struct({ value: Schema.Int });
export type Count = typeof Count.Type;

/**
 * A dev aid: an id minted once per activation of the actor. The same id across calls means the
 * same activation; a new id after an idle period shows the object hibernated and was rebuilt.
 */
export const Activation = Schema.Struct({ id: Schema.String });

/**
 * What the actor pushes to every connected socket after a write: the reactivity keys whose
 * queries are stale. Never the data; a tab refetches what it renders. Carried on the RPC
 * socket as its own frame, outside the RPC protocol; see `ShopActorClient`.
 */
export const Notice = Schema.Struct({
  _tag: Schema.Literal("ShopActorNotice"),
  invalidated: Schema.Array(Schema.String),
});
export type Notice = typeof Notice.Type;

/** A {@link Notice} as the JSON text frame it travels in. */
export const NoticeFrame = Schema.fromJsonString(Notice);

/** The `count` reactivity key. */
export const COUNT_KEY = "count";

export const ShopActorRpcs = RpcGroup.make(
  Rpc.make("GetCount", { success: Count }),
  Rpc.make("Increment", { success: Count }),
  Rpc.make("Activation", { success: Activation }),
);

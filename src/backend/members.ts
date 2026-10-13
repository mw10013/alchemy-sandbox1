import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Email, Member, MemberExists } from "../api/backend.ts";
import { ShopKey } from "../api/shop.ts";
import { AuthDb } from "./resources.ts";

/** Rows of the `Member` table. A row that does not decode is a broken invariant, so it dies. */
const decodeMembers = Schema.decodeUnknownEffect(Schema.Array(Member));
const decodeShops = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ shop: ShopKey })));
const decodeTeamIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ teamId: Schema.String })),
);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));

const make = Effect.gen(function* () {
  const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
  const sql = yield* SQL.D1(d1);

  const listShopsOf = Effect.fn("Members.listShopsOf")(function* (email: Email) {
    const rows = yield* decodeShops(
      yield* sql`SELECT shop FROM Member WHERE email = ${email} ORDER BY shop`,
    );
    return rows.map((row) => row.shop);
  }, Effect.orDie);

  const find = Effect.fn("Members.find")(function* (shop: ShopKey, email: Email) {
    const [row] = yield* decodeMembers(
      yield* sql`SELECT id, shop, email, createdAt FROM Member WHERE shop = ${shop} AND email = ${email}`,
    );
    return Option.fromUndefinedOr(row);
  }, Effect.orDie);

  const teamIdsOf = Effect.fn("Members.teamIdsOf")(function* (memberId: string) {
    const rows = yield* decodeTeamIds(
      yield* sql`SELECT teamId FROM TeamMember WHERE memberId = ${memberId} ORDER BY teamId`,
    );
    return rows.map((row) => row.teamId);
  }, Effect.orDie);

  const list = Effect.fn("Members.list")(function* () {
    return yield* decodeMembers(
      yield* sql`SELECT id, shop, email, createdAt FROM Member ORDER BY shop, email`,
    );
  }, Effect.orDie);

  const add = Effect.fn("Members.add")(
    function* (shop: ShopKey, email: Email) {
      const member: Member = { id: crypto.randomUUID(), shop, email, createdAt: Date.now() };
      // The unique (shop, email) index answers "already a member" without a read first.
      const [inserted] = yield* decodeIds(
        yield* sql`INSERT INTO Member (id, shop, email, createdAt)
        VALUES (${member.id}, ${shop}, ${email}, ${member.createdAt})
        ON CONFLICT (shop, email) DO NOTHING RETURNING id`,
      ).pipe(Effect.orDie);
      if (inserted === undefined) return yield* new MemberExists();
      return member;
    },
    Effect.catchTag("SqlError", Effect.die),
  );

  const remove = Effect.fn("Members.remove")(function* (shop: ShopKey, email: Email) {
    const [row] = yield* decodeIds(
      yield* sql`DELETE FROM Member WHERE shop = ${shop} AND email = ${email} RETURNING id`,
    );
    return Option.map(Option.fromUndefinedOr(row), (row) => row.id);
  }, Effect.orDie);

  return { listShopsOf, find, teamIdsOf, list, add, remove };
});

/**
 * Baton's `Member` table: who belongs to which shop. The layer is built once at Worker init;
 * `SQL.D1` defers the actual client to the first query of each request and tears it down with
 * the request.
 *
 * Baton's rule: a membership edit is followed by a revoke on that shop's actor, so a socket
 * opened under the old membership does not outlive it. `Members` holds no stub; whoever edits
 * calls `ShopActors.revoke` after the write.
 */
export class Members extends Context.Service<Members, Effect.Success<typeof make>>()(
  "app/Members",
) {
  static readonly layer = Layer.effect(Members, make);

  /**
   * `Member` rows in memory, for tests, with `teamIds` as `TeamMember` edges by member id.
   * `add` and `remove` edit the layer's own copy.
   */
  static readonly layerTest = (
    seed: ReadonlyArray<Member>,
    teamIds: Readonly<Record<string, ReadonlyArray<string>>> = {},
  ) =>
    Layer.sync(Members, () => {
      let members = [...seed];
      const find = (shop: ShopKey, email: Email) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            members.find((member) => member.shop === shop && member.email === email),
          ),
        );
      return {
        listShopsOf: (email: Email) =>
          Effect.succeed(
            members
              .filter((member) => member.email === email)
              .map((member) => member.shop)
              .sort(),
          ),
        find,
        teamIdsOf: (memberId: string) => Effect.succeed([...(teamIds[memberId] ?? [])]),
        list: () =>
          Effect.succeed(
            [...members].sort(
              (a, b) => a.shop.localeCompare(b.shop) || a.email.localeCompare(b.email),
            ),
          ),
        add: (shop: ShopKey, email: Email) =>
          Effect.gen(function* () {
            if (Option.isSome(yield* find(shop, email))) return yield* new MemberExists();
            const member: Member = { id: crypto.randomUUID(), shop, email, createdAt: Date.now() };
            members = [...members, member];
            return member;
          }),
        remove: (shop: ShopKey, email: Email) =>
          Effect.sync(() => {
            const removed = members.find(
              (member) => member.shop === shop && member.email === email,
            );
            members = members.filter((member) => member !== removed);
            return Option.map(Option.fromUndefinedOr(removed), (member) => member.id);
          }),
      };
    });
}

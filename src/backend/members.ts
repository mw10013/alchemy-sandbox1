import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Email } from "../contract/auth.ts";
import { Member, MemberExists } from "../contract/members.ts";
import { ShopKey } from "../contract/shop.ts";
import { AuthDb } from "./resources.ts";

/** Rows of the `Member` table. A row that does not decode is a broken invariant, so it dies. */
const decodeMembers = Schema.decodeUnknownEffect(Schema.Array(Member));
const decodeShops = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ shop: ShopKey })));
const decodeTeamIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ teamId: Schema.String })),
);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));
const decodeEmails = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ email: Email })));
const decodeNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String })),
);
const decodeCount = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ n: Schema.Number })]).pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform({ decode: ([{ n }]) => n, encode: (n) => [{ n }] as const }),
    ),
  ),
);

/**
 * One shop's identity rows, as a fixture replaces them: its members, its teams and who is on
 * which, by the ids the caller minted.
 */
export interface ShopIdentity {
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly email: Email;
    readonly createdAt: number;
  }>;
  readonly teams: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly createdAt: number;
  }>;
  readonly teamMembers: ReadonlyArray<{
    readonly teamId: string;
    readonly memberId: string;
    readonly createdAt: number;
  }>;
}

/** One shop's member emails and team names, each unique in the shop. */
export interface ShopIdentityNames {
  readonly emails: ReadonlyArray<Email>;
  readonly teams: ReadonlyArray<string>;
}

/** The shop's `Member` and `Team` rows after a write. */
export interface ShopIdentityCounts {
  readonly members: number;
  readonly teams: number;
}

/** What `replaceShop` answers: the member ids it replaced, and the shop's rows after it. */
export interface ShopIdentityReplaced {
  readonly priorMemberIds: ReadonlyArray<string>;
  readonly members: number;
  readonly teams: number;
}

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

  /**
   * Replaces one shop's `Member`, `Team` and `TeamMember` rows with `rows`, in one D1 batch, which
   * is atomic: D1 has no transaction (`withTransaction` dies on it). Deleting the shop's members
   * and teams removes their `TeamMember` edges by cascade. Every insert is its own statement,
   * because a D1 statement binds at most 100 parameters. The batch reads the prior member ids
   * first and counts the shop's rows last, so the answer is what D1 holds, not the input.
   */
  const replaceShop = Effect.fn("Members.replaceShop")(function* (
    shop: ShopKey,
    rows: ShopIdentity,
  ) {
    const results = yield* sql.batch([
      sql`SELECT id FROM Member WHERE shop = ${shop}`,
      sql`DELETE FROM Team WHERE shop = ${shop}`,
      sql`DELETE FROM Member WHERE shop = ${shop}`,
      ...rows.members.map(
        (member) =>
          sql`INSERT INTO Member (id, shop, email, createdAt) VALUES (${member.id}, ${shop}, ${member.email}, ${member.createdAt})`,
      ),
      ...rows.teams.map(
        (team) =>
          sql`INSERT INTO Team (id, shop, name, createdAt) VALUES (${team.id}, ${shop}, ${team.name}, ${team.createdAt})`,
      ),
      ...rows.teamMembers.map(
        (edge) =>
          sql`INSERT INTO TeamMember (teamId, memberId, createdAt) VALUES (${edge.teamId}, ${edge.memberId}, ${edge.createdAt})`,
      ),
      sql`SELECT count(*) AS n FROM Member WHERE shop = ${shop}`,
      sql`SELECT count(*) AS n FROM Team WHERE shop = ${shop}`,
    ]);
    const replaced: ShopIdentityReplaced = {
      priorMemberIds: (yield* decodeIds(results[0])).map((row) => row.id),
      members: yield* decodeCount(results.at(-2)),
      teams: yield* decodeCount(results.at(-1)),
    };
    return replaced;
  }, Effect.orDie);

  const identityNames = Effect.fn("Members.identityNames")(function* (shop: ShopKey) {
    const [emails, teams] = yield* sql.batch([
      sql`SELECT email FROM Member WHERE shop = ${shop}`,
      sql`SELECT name FROM Team WHERE shop = ${shop}`,
    ]);
    const names: ShopIdentityNames = {
      emails: (yield* decodeEmails(emails)).map((row) => row.email),
      teams: (yield* decodeNames(teams)).map((row) => row.name),
    };
    return names;
  }, Effect.orDie);

  /**
   * Adds `rows` to one shop's `Member`, `Team` and `TeamMember` rows beside what is there: the
   * insert half of {@link replaceShop}, in one batch, counting the shop's rows last. The unique
   * (shop, email) and (shop, name) indexes fail the whole batch on a clash, so a caller reads
   * {@link identityNames} first and treats a clash here as a defect.
   */
  const addToShop = Effect.fn("Members.addToShop")(function* (shop: ShopKey, rows: ShopIdentity) {
    const results = yield* sql.batch([
      ...rows.members.map(
        (member) =>
          sql`INSERT INTO Member (id, shop, email, createdAt) VALUES (${member.id}, ${shop}, ${member.email}, ${member.createdAt})`,
      ),
      ...rows.teams.map(
        (team) =>
          sql`INSERT INTO Team (id, shop, name, createdAt) VALUES (${team.id}, ${shop}, ${team.name}, ${team.createdAt})`,
      ),
      ...rows.teamMembers.map(
        (edge) =>
          sql`INSERT INTO TeamMember (teamId, memberId, createdAt) VALUES (${edge.teamId}, ${edge.memberId}, ${edge.createdAt})`,
      ),
      sql`SELECT count(*) AS n FROM Member WHERE shop = ${shop}`,
      sql`SELECT count(*) AS n FROM Team WHERE shop = ${shop}`,
    ]);
    const counts: ShopIdentityCounts = {
      members: yield* decodeCount(results.at(-2)),
      teams: yield* decodeCount(results.at(-1)),
    };
    return counts;
  }, Effect.orDie);

  return {
    listShopsOf,
    find,
    teamIdsOf,
    list,
    add,
    remove,
    replaceShop,
    identityNames,
    addToShop,
  };
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
   * `add`, `remove`, `replaceShop` and `addToShop` edit the layer's own copy; teams are kept as
   * names by shop (for `identityNames` and the counts) and as edges, which `teamIdsOf` answers.
   */
  static readonly layerTest = (
    seed: ReadonlyArray<Member>,
    teamIds: Readonly<Record<string, ReadonlyArray<string>>> = {},
  ) =>
    Layer.sync(Members, () => {
      let members = [...seed];
      let teams: Array<{ readonly shop: ShopKey; readonly name: string }> = [];
      const edges: Record<string, ReadonlyArray<string>> = { ...teamIds };
      const countsOf = (shop: ShopKey): ShopIdentityCounts => ({
        members: members.filter((member) => member.shop === shop).length,
        teams: teams.filter((team) => team.shop === shop).length,
      });
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
        teamIdsOf: (memberId: string) => Effect.succeed([...(edges[memberId] ?? [])]),
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
        replaceShop: (shop: ShopKey, rows: ShopIdentity) =>
          Effect.sync((): ShopIdentityReplaced => {
            const prior = members.filter((member) => member.shop === shop);
            for (const member of prior) delete edges[member.id];
            members = [
              ...members.filter((member) => member.shop !== shop),
              ...rows.members.map((member) => ({ ...member, shop })),
            ];
            teams = [
              ...teams.filter((team) => team.shop !== shop),
              ...rows.teams.map((team) => ({ shop, name: team.name })),
            ];
            for (const edge of rows.teamMembers)
              edges[edge.memberId] = [...(edges[edge.memberId] ?? []), edge.teamId];
            return { priorMemberIds: prior.map((member) => member.id), ...countsOf(shop) };
          }),
        identityNames: (shop: ShopKey) =>
          Effect.succeed<ShopIdentityNames>({
            emails: members.filter((member) => member.shop === shop).map((member) => member.email),
            teams: teams.filter((team) => team.shop === shop).map((team) => team.name),
          }),
        addToShop: (shop: ShopKey, rows: ShopIdentity) =>
          Effect.sync((): ShopIdentityCounts => {
            members = [...members, ...rows.members.map((member) => ({ ...member, shop }))];
            teams = [...teams, ...rows.teams.map((team) => ({ shop, name: team.name }))];
            for (const edge of rows.teamMembers)
              edges[edge.memberId] = [...(edges[edge.memberId] ?? []), edge.teamId];
            return countsOf(shop);
          }),
      };
    });
}

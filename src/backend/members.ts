import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Email, Role, type Member } from "../api/backend.ts";
import { AuthDb } from "./resources.ts";

/** A row of the `member` table. A row that does not decode is a broken invariant, so it dies. */
export const MemberRow = Schema.Struct({
  email: Email,
  role: Role,
  created_at: Schema.Number,
});
export type MemberRow = typeof MemberRow.Type;

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(MemberRow));

const toMember = (row: MemberRow): Member => ({
  email: row.email,
  role: row.role,
  createdAt: row.created_at,
});

const make = Effect.gen(function* () {
  const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
  const sql = yield* SQL.D1(d1);

  const findByEmail = Effect.fn("Members.findByEmail")(function* (email: Email) {
    const rows = yield* sql`SELECT email, role, created_at FROM member WHERE email = ${email}`;
    const [row] = yield* decodeRows(rows);
    return Option.fromUndefinedOr(row).pipe(Option.map(toMember));
  }, Effect.orDie);

  const list = Effect.fn("Members.list")(function* () {
    const rows = yield* sql`SELECT email, role, created_at FROM member ORDER BY created_at, email`;
    return (yield* decodeRows(rows)).map(toMember);
  }, Effect.orDie);

  const create = Effect.fn("Members.create")(function* (email: Email, role: Role) {
    yield* sql`INSERT INTO member (email, role) VALUES (${email}, ${role})`;
    // The row was just inserted; a None here is a broken invariant, so it dies with the rest.
    return yield* Effect.fromOption(yield* findByEmail(email));
  }, Effect.orDie);

  return { findByEmail, list, create };
});

/**
 * Member queries for RPC handlers. The layer is built once at Worker init; `SQL.D1` defers the
 * actual client to the first query of each request and tears it down with the request.
 */
export class Members extends Context.Service<Members, Effect.Success<typeof make>>()(
  "app/Members",
) {
  static readonly layer = Layer.effect(Members, make);

  /** An invite list in memory, for tests. `create` appends to the layer's own copy. */
  static readonly layerTest = (seed: ReadonlyArray<Member>) =>
    Layer.sync(Members, () => {
      const members = [...seed];
      const findByEmail = (email: Email) =>
        Effect.succeed(Option.fromUndefinedOr(members.find((member) => member.email === email)));
      return {
        findByEmail,
        list: () =>
          Effect.succeed(
            [...members].sort(
              (a, b) => a.createdAt - b.createdAt || a.email.localeCompare(b.email),
            ),
          ),
        create: (email: Email, role: Role) =>
          Effect.sync(() => {
            const member: Member = { email, role, createdAt: Math.floor(Date.now() / 1000) };
            members.push(member);
            return member;
          }),
      };
    });
}

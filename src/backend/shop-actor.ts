import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { COUNT_KEY, Count, NoticeFrame, ShopActorRpcs } from "../api/shop-actor.ts";

/** A row of the `count` table. A row that does not decode is a broken invariant, so it dies. */
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Count));
const encodeNotice = Schema.encodeSync(NoticeFrame);

/** The schema of one actor's storage, applied on every activation; see {@link ShopActor}. */
const migrations = SqliteMigrator.fromRecord({
  "0001_count": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE count (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    yield* sql`INSERT INTO count (id, value) VALUES (1, 0)`;
  }),
});

/**
 * One shop's actor: a `count` in private SQLite, read and written over Effect RPC on HTTP or a
 * hibernating WebSocket (both provided by `RpcDurableObject`). After a write it pushes a
 * `Notice` to every socket so each tab refetches; it never pushes the value.
 *
 * Everything below `state` runs once per activation, including after a hibernation wake, so
 * the SQL client is rebuilt and the migrator re-checks its table each time. Migrations run
 * inside the `blockConcurrencyWhile` Alchemy wraps construction in, so no request sees a
 * half-migrated store. The client is built on the ambient scope, as Alchemy's
 * `Drizzle.DurableObject` does: it wraps the object's local storage, so nothing behind it needs
 * releasing. A single-statement write needs no transaction; a multi-statement one will need
 * `withTransaction` and Alchemy's `MixedScheduler("sync")` workaround from its
 * `Drizzle.DurableObject`.
 */
export default class ShopActor extends Cloudflare.RpcDurableObject<ShopActor>()(
  "ShopActor",
  { schema: ShopActorRpcs },
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const sql = yield* Layer.build(SqliteClient.layer({ storage: state.raw.storage })).pipe(
        Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
      );
      yield* SqliteMigrator.run({ loader: migrations }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orDie,
      );
      const activationId = yield* Effect.sync(() => crypto.randomUUID());

      const readCount = Effect.fn("ShopActor.readCount")(function* () {
        const [row] = yield* decodeRows(yield* sql`SELECT value FROM count WHERE id = 1`);
        return yield* Effect.fromNullishOr(row);
      }, Effect.orDie);

      const increment = Effect.fn("ShopActor.increment")(function* () {
        const [row] = yield* decodeRows(
          yield* sql`UPDATE count SET value = value + 1 WHERE id = 1 RETURNING value`,
        );
        return yield* Effect.fromNullishOr(row);
      }, Effect.orDie);

      const notify = Effect.fn("ShopActor.notify")(function* (invalidated: ReadonlyArray<string>) {
        const frame = encodeNotice({ _tag: "ShopActorNotice", invalidated });
        for (const socket of yield* state.getWebSockets())
          // A socket mid-close throws on send, which `send` surfaces as a defect; the next
          // notice or the client's reconnect covers that tab.
          yield* socket.send(frame).pipe(Effect.catchDefect(() => Effect.void));
      });

      return ShopActorRpcs.toLayer({
        GetCount: () => readCount(),
        Increment: () => increment().pipe(Effect.tap(() => notify([COUNT_KEY]))),
        Activation: () => Effect.succeed({ id: activationId }),
      });
    });
  }),
) {}

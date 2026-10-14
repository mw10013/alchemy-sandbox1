import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { AuthDb, seedsFor } from "./resources.ts";

/**
 * Seeds Better Auth's tables, which the stage's `seed/<stage>-auth.sql` fills with the operator
 * (a `user` row with the role `admin`). `importFiles` on {@link AuthDb} cannot: it runs inside
 * the D1 resource, before `BetterAuthMigrate` creates `user` on a fresh database. An Action
 * runs after whatever its input depends on; {@link seedAuth} puts the Backend's URL there, and
 * the Backend already waits for the migration. Register it only through {@link seedAuth}.
 *
 * The runner executes the SQL it is given, so the file's text and the database id are part of
 * the input: an edited file runs again, and a recreated database is seeded again. The rows must
 * be idempotent (`INSERT OR IGNORE`) and shaped as Better Auth stores them: ISO text dates,
 * 0/1 booleans.
 *
 * It lives apart from `AuthDb` because `QueryDatabaseLocal` pulls the `workerd` binary resolver
 * into whatever imports it; the Backend bundle imports `AuthDb` and must not carry that.
 */
export const AuthSeed = Alchemy.Action(
  "AuthSeed",
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
    return Effect.fn("AuthSeed")(function* (input: {
      readonly databaseId: string;
      readonly backendUrl: string;
      readonly sql: string;
    }) {
      yield* d1.exec(input.sql);
    });
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
);

/**
 * Registers {@link AuthSeed} for the current stage, after the Backend: both stacks call it with
 * the Backend they yielded. A stage with no auth seed registers nothing.
 */
export const seedAuth = Effect.fn("seedAuth")(function* (backend: {
  readonly url: Alchemy.Output<string | undefined>;
}) {
  const stage = yield* Alchemy.Stage;
  const file = seedsFor(stage).auth;
  if (Option.isNone(file)) return;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* fs.readFileString(file.value).pipe(Effect.orDie);
  const database = yield* AuthDb;
  yield* AuthSeed({ databaseId: database.databaseId, backendUrl: backend.url.as<string>(), sql });
});

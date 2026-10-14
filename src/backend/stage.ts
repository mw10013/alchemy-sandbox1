/**
 * An environment is a role (`dev`, `test`, `e2e`, `staging`); a stage is one copy of the stack in
 * an environment. Never shortened to `env`, which already means `.env`, `process.env` and a
 * Worker's bindings.
 *
 * Imports only `effect`, so any bundle may carry it.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const Environment = Schema.Literals(["dev", "test", "e2e", "staging"]);
export type Environment = typeof Environment.Type;

/** The environments with one stage per developer and checkout; `staging` is shared. */
export const PerDeveloper = Schema.Literals(["dev", "test", "e2e"]);
export type PerDeveloper = typeof PerDeveloper.Type;

/** Lowercase letters and digits, so a user never contains the `-` between a stage's parts. */
const User = Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/u));

/**
 * A linked worktree's branch, folder and stage part, `wt-01` for index 1, as a codec: decode the
 * name to its index (1 to 99, so `wt-00` is not a worktree), encode an index to the name.
 */
export const Checkout = Schema.String.check(Schema.isPattern(/^wt-\d{2}$/u)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
    SchemaTransformation.transform({
      decode: (name) => Number(name.slice("wt-".length)),
      encode: (index) => `wt-${String(index).padStart(2, "0")}`,
    }),
  ),
);

const PerDeveloperStageParts = Schema.Union([
  Schema.TemplateLiteralParser([PerDeveloper, "-", User]),
  Schema.TemplateLiteralParser([PerDeveloper, "-", User, "-", Checkout]),
]);

/**
 * A per-developer stage, `<environment>-<user>[-<checkout>]`: `dev-mw` in the main checkout,
 * `dev-mw-wt-01` in worktree `wt-01`. Dashes, because Alchemy turns every other separator into
 * `-` in physical names, so the stage reads the same in the CLI, state, logs and Cloudflare.
 */
export const PerDeveloperStage = PerDeveloperStageParts.pipe(
  Schema.decodeTo(
    Schema.Struct({
      environment: PerDeveloper,
      user: Schema.String,
      checkout: Schema.Option(Schema.Int),
    }),
    SchemaTransformation.transform({
      decode: (parts) => ({
        environment: parts[0],
        user: parts[2],
        checkout: parts.length === 5 ? Option.some(parts[4]) : Option.none(),
      }),
      encode: ({ environment, user, checkout }) =>
        Option.match(checkout, {
          onNone: () => [environment, "-", user] as const,
          onSome: (index) => [environment, "-", user, "-", index] as const,
        }),
    }),
  ),
);
export type PerDeveloperStage = typeof PerDeveloperStage.Type;

export class UnknownStage extends Schema.TaggedError<UnknownStage>()("UnknownStage", {
  stage: Schema.String,
}) {
  override get message() {
    return `stage "${this.stage}" belongs to no known environment`;
  }
}

const decodePerDeveloper = Schema.decodeUnknownOption(PerDeveloperStage);

/**
 * The environment a stage belongs to: `staging` is its own, a per-developer stage's is its first
 * part. Any other stage fails rather than falling back: an environment not listed in
 * {@link Environment} is one nobody has thought through (its seed, its state store, its policy).
 * `live` and `production` are added when they are designed.
 */
export const environmentOf = (stage: string): Effect.Effect<Environment, UnknownStage> =>
  stage === "staging"
    ? Effect.succeed("staging")
    : Option.match(decodePerDeveloper(stage), {
        onNone: () => Effect.fail(new UnknownStage({ stage })),
        onSome: ({ environment }) => Effect.succeed(environment),
      });

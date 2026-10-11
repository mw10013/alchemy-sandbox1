import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

/**
 * The text Shout accepts: trimmed, 1 to 80 characters. A payload field's checks run on the
 * client, which constructs the payload with the schema, and on the server, so a value of this
 * type has already passed them. Decode raw input with {@link ShoutTextFromInput} first.
 */
export const ShoutText = Schema.Trimmed.check(
  Schema.isBetweenLength(1, 80, { message: "Enter 1 to 80 characters." }),
).pipe(Schema.brand("ShoutText"));
export type ShoutText = typeof ShoutText.Type;

/**
 * Raw textbox value to {@link ShoutText}. Trim is a decode step, so the length check sees the
 * trimmed text.
 */
export const ShoutTextFromInput = Schema.Trim.pipe(Schema.decodeTo(ShoutText));

export const Hello = Schema.Struct({ message: Schema.String, servedAt: Schema.String });
export const Shouted = Schema.Struct({ input: ShoutText, output: Schema.String });

/**
 * An email address as stored and compared: trimmed, lowercased. Decode raw input with
 * {@link EmailFromInput} first.
 */
export const Email = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, { message: "Enter an email address." }),
  Schema.isMaxLength(320, { message: "Enter an email address." }),
  Schema.isLowercased(),
).pipe(Schema.brand("Email"));
export type Email = typeof Email.Type;

/**
 * Raw textbox value to {@link Email}. Trimming and lowercasing are decode steps, so the checks
 * see the normalized address.
 */
export const EmailFromInput = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim()),
  Schema.decode(SchemaTransformation.toLowerCase()),
  Schema.decodeTo(Email),
);

/** A same-origin path to land on after sign-in, such as `/admin/members`. Never `//host`. */
export const ReturnPath = Schema.String.check(Schema.isPattern(/^\/(?![/\\])\S*$/u)).pipe(
  Schema.brand("ReturnPath"),
);
export type ReturnPath = typeof ReturnPath.Type;

export const Role = Schema.Literals(["admin", "user"]);
export type Role = typeof Role.Type;

export const Me = Schema.Struct({ id: Schema.String, email: Email, role: Role });
export type Me = typeof Me.Type;
/** A row of the invite list: who may sign in, and as what. Email is the key. */
export const Member = Schema.Struct({
  email: Email,
  role: Role,
  createdAt: Schema.Number,
});
export type Member = typeof Member.Type;

/** `link` is Some only under inline delivery; see `Auth` in the Backend. */
export const MagicLinkRequested = Schema.Struct({ link: Schema.Option(Schema.String) });

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()("TooManyRequests", {}) {}

/** The signed-in member, provided by {@link CurrentUserMiddleware}. */
export class CurrentUser extends Context.Service<CurrentUser, Me>()("CurrentUser") {}
export class CurrentUserMiddleware extends RpcMiddleware.Service<
  CurrentUserMiddleware,
  { provides: CurrentUser }
>()("CurrentUserMiddleware", { error: Unauthorized }) {}
export class RequireAdmin extends RpcMiddleware.Service<RequireAdmin, { requires: CurrentUser }>()(
  "RequireAdmin",
  { error: Forbidden },
) {}

const PublicRpcs = RpcGroup.make(
  Rpc.make("Hello", { success: Hello }),
  Rpc.make("Shout", { payload: { input: ShoutText }, success: Shouted }),
  Rpc.make("RequestMagicLink", {
    payload: { email: Email, returnTo: Schema.optional(ReturnPath) },
    success: MagicLinkRequested,
    error: TooManyRequests,
  }),
);

const MemberRpcs = RpcGroup.make(Rpc.make("Me", { success: Me })).middleware(CurrentUserMiddleware);

/**
 * The first middleware added runs innermost: {@link RequireAdmin} reads the
 * {@link CurrentUser} that the outer {@link CurrentUserMiddleware} provides.
 */
const AdminRpcs = RpcGroup.make(Rpc.make("ListMembers", { success: Schema.Array(Member) }))
  .middleware(RequireAdmin)
  .middleware(CurrentUserMiddleware);

export const BackendRpcs = PublicRpcs.merge(MemberRpcs, AdminRpcs);

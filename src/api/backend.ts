import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ShopKey } from "./shop.ts";

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

/** Better Auth's `user.role`: `admin` is an operator, anyone else is `user`. */
export const Role = Schema.Literals(["admin", "user"]);
export type Role = typeof Role.Type;

export const Me = Schema.Struct({ id: Schema.String, email: Email, role: Role });
export type Me = typeof Me.Type;

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

/**
 * `link` is Some only under inline delivery; see `MagicLinkDelivery` in the Backend. It crosses
 * the binding encoded, as `string | null`.
 */
export const MagicLinkRequested = Schema.Struct({ link: Schema.OptionFromNullOr(Schema.String) });

/**
 * The caller is signed in, or holds a valid Shopify token, but may not open this shop: an
 * operator, someone with no `Member` row for it, or a token for another shop.
 */
export class NotAShopMember extends Schema.TaggedError<NotAShopMember>()("NotAShopMember", {}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()("TooManyRequests", {}) {}

/**
 * What a server function forwards from the browser's request to the Backend; nothing else
 * crosses. Each Backend method that needs the visitor resolves the session from `cookie`
 * itself; `ip` keys the sign-in rate limit.
 */
export const RequestInfo = Schema.Struct({
  cookie: Schema.UndefinedOr(Schema.String),
  ip: Schema.UndefinedOr(Schema.String),
});
export type RequestInfo = typeof RequestInfo.Type;

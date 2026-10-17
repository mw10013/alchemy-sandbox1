import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What Shopify puts on the App Home's URL, read from the raw search string. The router parses each
 * search value as JSON (`embedded=1` becomes the number `1`) and rewrites the URL when
 * `validateSearch` returns anything else, so the `/app` routes keep the router's search as it is
 * and read the text Shopify sent. Shopify also sends `locale`, `session`, `timestamp` and
 * `hmac`; every redirect and link under `/app` is built from the raw string, so they survive the
 * round trip.
 */
const AppSearch = Schema.Struct({
  shop: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  embedded: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
});
const decodeSearch = Schema.decodeUnknownOption(AppSearch);

/** {@link AppSearch} from a location's `searchStr`; anything that does not decode is empty. */
export const appSearch = (searchStr: string): typeof AppSearch.Type =>
  Option.getOrElse(decodeSearch(Object.fromEntries(new URLSearchParams(searchStr))), () => ({}));

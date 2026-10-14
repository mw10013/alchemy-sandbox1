import { createServerFn } from "@tanstack/react-start";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MagicLinkInput, MagicLinkRequested, TooManyRequests } from "../../contract/auth.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

const decodeRequested = Schema.decodeUnknownSync(MagicLinkRequested);

/**
 * What the sign-in page renders: `Sent`, with the link only under inline delivery, or
 * `TooManyRequests`. The answer is the same whether or not the address may sign in.
 */
export type MagicLinkResult =
  | { readonly _tag: "Sent"; readonly link: string | undefined }
  | { readonly _tag: "TooManyRequests" };

export const requestMagicLink = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MagicLinkInput))
  .handler(({ data }): Promise<MagicLinkResult> =>
    backend()
      .requestMagicLink(requestInfo(), data)
      .then((answer): MagicLinkResult => ({
        _tag: "Sent",
        link: Option.getOrUndefined(decodeRequested(answer).link),
      }))
      .catch(rescue(TooManyRequests, (): MagicLinkResult => ({ _tag: "TooManyRequests" }))),
  );

import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { AuthEmail } from "./resources.ts";

/** A transactional sender on the Email Service sending domain; no mailbox is behind it. */
const FROM = "noreply@mail.mw10013.com";

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** The mail {@link Mailer.layerTest} has sent, in order. */
export class SentMail extends Context.Service<SentMail, Ref.Ref<ReadonlyArray<Mail>>>()(
  "app/SentMail",
) {
  static readonly layer = Layer.effect(SentMail, Ref.make<ReadonlyArray<Mail>>([]));
}

/**
 * Sends transactional mail from {@link FROM}. The live layer yields the `AuthEmail` binding,
 * which attaches it to the Worker, so the layer is built in the Worker's init. A send failure
 * is a defect: the caller cannot do anything about it and must not tell the visitor.
 */
export class Mailer extends Context.Service<
  Mailer,
  { readonly send: (mail: Mail) => Effect.Effect<void> }
>()("app/Mailer") {
  static readonly layer = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const email = yield* Cloudflare.Email.Send(AuthEmail);
      return Mailer.of({
        send: (mail) =>
          email
            .send({ from: FROM, ...mail })
            .pipe(Effect.orDie, Effect.provide(RuntimeContext.phantom)),
      });
    }),
  );

  /** Records mail in {@link SentMail} instead of sending it. */
  static readonly layerTest = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const sent = yield* SentMail;
      return Mailer.of({ send: (mail) => Ref.update(sent, (mails) => [...mails, mail]) });
    }),
  ).pipe(Layer.provideMerge(SentMail.layer));
}

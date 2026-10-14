import type { Hello, Shouted, ShoutText } from "../../contract/playground.ts";
import type { Me } from "../../contract/auth.ts";
import { useNavigateOnClick } from "./navigate.ts";
import { homeFor } from "../client/session.ts";
import Playground from "./Playground";
import { Inline } from "./screen/Inline.tsx";
import { Things } from "./screen/Things.tsx";
import SignOutButton from "./SignOutButton.tsx";

/**
 * The public landing page. Its page actions follow the session: a signed-out visitor is
 * offered sign-in, a member their {@link homeFor} dashboard and sign-out.
 */
export default function HomePage({
  me,
  hello,
  shout,
}: {
  me: Me | undefined;
  hello: typeof Hello.Type;
  shout: (input: ShoutText) => Promise<typeof Shouted.Type>;
}) {
  const navigate = useNavigateOnClick();
  const dashboard = me && homeFor(me.role);

  return (
    <s-page heading="Alchemy-sandbox1" inlineSize="small">
      {dashboard ? (
        <>
          <s-button slot="secondary-actions" variant="secondary" {...navigate(dashboard)}>
            Dashboard
          </s-button>
          <SignOutButton variant="secondary" slot="secondary-actions" />
        </>
      ) : (
        <s-button slot="secondary-actions" variant="secondary" {...navigate("/sign-in")}>
          Sign in
        </s-button>
      )}
      <s-section heading="Build on the edge with Effect">
        <Things>
          <s-paragraph color="subdued">
            TanStack Start, Effect and Polaris on Cloudflare Workers.
          </s-paragraph>
          <Inline>
            {dashboard ? (
              <s-button variant="primary" {...navigate(dashboard)}>
                Open dashboard
              </s-button>
            ) : (
              <s-button variant="primary" {...navigate("/sign-in")}>
                Get started
              </s-button>
            )}
          </Inline>
        </Things>
      </s-section>
      <Playground hello={hello} shout={shout} />
    </s-page>
  );
}

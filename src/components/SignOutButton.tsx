import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { signOut } from "../session.ts";

/**
 * Sign out, from wherever the session shows. `leave` is set on a guarded side: signing out on
 * it would redirect to sign-in and then on to `/`, so the button goes to `/` first. `slot`
 * places it in an `s-page` action slot, whose `secondary-actions` take only secondary buttons.
 */
export default function SignOutButton({
  variant,
  slot,
  leave = false,
}: {
  readonly variant: "secondary" | "tertiary";
  readonly slot?: "secondary-actions";
  readonly leave?: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const onSignOut = async () => {
    setPending(true);
    try {
      if (leave) await navigate({ to: "/" });
      await signOut(router);
    } finally {
      setPending(false);
    }
  };
  return (
    <s-button
      variant={variant}
      {...(slot === undefined ? {} : { slot })}
      {...(pending ? { loading: true } : {})}
      onClick={() => void onSignOut()}
    >
      Sign out
    </s-button>
  );
}

import { TopBar } from "./screen/TopBar.tsx";
import SignOutButton from "./SignOutButton.tsx";

/**
 * The member area's one piece of chrome, above `s-page` on every `/shop` screen: the site's name
 * as the way home, who is signed in, and Sign out. The email lives here rather than under a
 * heading, so every member screen answers "whose session is this" at the cost of one line on
 * none of them.
 */
export default function MemberBar({ email }: { readonly email: string }) {
  return (
    <TopBar
      title="Alchemy-sandbox1"
      to="/shop"
      end={
        <>
          <s-text color="subdued">{email}</s-text>
          <SignOutButton variant="tertiary" leave />
        </>
      }
    />
  );
}

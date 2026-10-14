import { createFileRoute } from "@tanstack/react-router";
import { Things } from "../components/screen/Things.tsx";
import SignOutButton from "../components/SignOutButton.tsx";
import { useNavigateOnClick } from "../navigate.ts";

export const Route = createFileRoute("/admin/")({
  component: function AdminHome() {
    const { me } = Route.useRouteContext();
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Admin">
        <SignOutButton variant="secondary" slot="secondary-actions" leave />
        <s-section accessibilityLabel="Signed in">
          <s-paragraph color="subdued">Signed in as {me.email}</s-paragraph>
        </s-section>
        <s-section heading="Members">
          <Things>
            <s-paragraph>Every shop's members, with the date each was added.</s-paragraph>
            <s-link {...navigate("/admin/members")}>Members</s-link>
          </Things>
        </s-section>
      </s-page>
    );
  },
});

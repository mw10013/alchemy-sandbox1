import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { testRegistry } from "../../test/browser/backend.ts";
import { renderInApp } from "../../test/browser/render.tsx";
import { TooManyRequests } from "../api/backend.ts";
import SignInPage from "./SignInPage.tsx";

const requestLink = async (screen: Awaited<ReturnType<typeof renderInApp>>, email: string) => {
  await screen.getByLabelText("Email").fill(email);
  await screen.getByRole("button", { name: "Send link" }).click();
};

describe("SignInPage", () => {
  it("shows the inline link after a request, with the email decoded", async () => {
    const requested: Array<string> = [];
    const registry = testRegistry({
      RequestMagicLink: ({ email }) =>
        Effect.sync(() => {
          requested.push(email);
          return { link: Option.some("http://test.local/verify") };
        }),
    });
    const screen = await renderInApp(
      <SignInPage returnTo={undefined} error={undefined} />,
      registry,
    );

    await requestLink(screen, " M1@m.com ");

    await expect.element(screen.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open link" }))
      .toHaveAttribute("href", "http://test.local/verify");
    expect(requested).toEqual(["m1@m.com"]);
  });

  it("says when the rate limit is hit", async () => {
    const registry = testRegistry({ RequestMagicLink: () => Effect.fail(new TooManyRequests()) });
    const screen = await renderInApp(
      <SignInPage returnTo={undefined} error={undefined} />,
      registry,
    );

    await requestLink(screen, "m1@m.com");

    await expect
      .element(screen.getByText("Too many attempts. Try again in a minute."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Send link" })).toBeVisible();
  });
});

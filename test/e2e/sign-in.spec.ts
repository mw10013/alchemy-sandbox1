import { expect, test } from "./fixtures.ts";
import { requestMagicLink, signIn } from "./screens.ts";

// Inline delivery shows the link on the page; a deployed stage mails it instead.
test("a member signs in with the link the page shows", async ({ goto, page }) => {
  await goto("/sign-in");
  await requestMagicLink(page, "m1@m.com");
  await signIn(page).openLink.click();
  await page.waitForURL(/\/shop$/);
  await expect(page.getByRole("heading", { name: "Member area" })).toBeVisible();
});

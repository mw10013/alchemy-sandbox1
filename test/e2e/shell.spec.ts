import * as Schema from "effect/Schema";
import { EmailFromInput } from "../../src/contract/auth.ts";
import { control, expect, test } from "./fixtures.ts";
import { followMagicLink, shell } from "./screens.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";

test.describe("as a member", () => {
  test.use({ storageState: "playwright/.auth/member.json" });

  test("the admin side sends a member home", async ({ goto, page }) => {
    await goto("/admin");
    await expect(page).toHaveURL(/\/shop$/);
  });

  test("the member home lists the member's shops and opens one", async ({ goto, page }) => {
    await goto("/shop");
    // Polaris renders the link text in a shadow root, so the links are found by accessible name.
    await expect(page.getByRole("link", { name: /\.myshopify\.com$/ })).toHaveCount(2);
    await expect(page.getByRole("link", { name: OTHER_SHOP })).toBeVisible();
    await page.getByRole("link", { name: SEED_SHOP }).click();
    await expect(page).toHaveURL(new RegExp(`/shop/${SEED_SHOP}$`));
  });
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the member side sends to sign-in and back", async ({ goto, page }) => {
    await goto("/shop");
    await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fshop$/);
  });
});

test.describe("as an admin", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Signing out deletes the session, so this test signs in its own instead of ending the one in
  // the shared admin storage state that other specs run on in parallel.
  test("sign out ends the session", async ({ backend, page }) => {
    const { link } = await backend(
      control((c) =>
        c.IssueMagicLink({ email: Schema.decodeUnknownSync(EmailFromInput)("a@a.com") }),
      ),
    );
    await followMagicLink(page, link);
    await page.waitForURL(/\/admin$/);
    await shell(page).signOut.click();
    await page.waitForURL(/\/$/);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(await page.context().cookies()).toEqual([]);
  });
});
